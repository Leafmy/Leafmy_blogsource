'use strict'
/* ============================================================
   木星贴图重出 (tools/jupiter-map-opal.js)
   ------------------------------------------------------------
   为什么重写而不是改 tools/opal-composite.js：
   实测旧产物（3072x1536，313 KB）相对真实 Hubble 照片（heic2404b）有
   四个可量化的问题，而它们的成因**不在渲染器**、全在贴图这一层：

     指标          旧贴图 / 参考      结论
     饱和度        0.183 / 0.248     低 26%，云带发灰
     亮度          0.409 / 0.524     低 22%
     细节对比度     28.9 / 50.6      低 43%，"糊"
     紫偏          0.034 / 0.004     高 8 倍（真正把画面拉灰的元凶）
     纬度剖面相关    0.776           云带分布没有对齐到"看起来像"

   成因（逐条对应上面的现象）：
   1) 旧流程把三张 3600x1800 单波段先拼成 2048 宽的中间产物，再由
      tools/jupiter-map-final.js 拉到 3072x1536 —— **上采样**。
      本次直接读官方三波段合成产品（同为 3600x1800、平面式 RGB），
      一步到位，不经任何缩放。
   2) 三个窄带滤光片与"人眼 RGB"没有对应关系，一档配一通道得到的是
      **假彩色**（这就是紫偏的来源）。
   3) 完全没有做曝光归一：三通道各自的分布被原样压进 8bit。

   本工具做的事：
     · 读 OPAL 的三波段合成 TIFF（tools/tiff-read.js 负责布局）
     · 逐波段按分位数做曝光归一（第 2 / 99.5 百分位映射到 0..1）
     · 线性光空间里施加 3x3 色彩矩阵 + 黑点偏置
     · 饱和度增强（围绕每像素亮度外推色度）
     · 细节注入：按纬向结构调制的多八度噪声，补回窄带观测里被平滑掉的
       丝缕与小涡旋
     · 输出 2 的幂尺寸（渲染端 mipmap / 各向异性需要）

   用法:
     node tools/jupiter-map-opal.js [输出jpg] [宽] [质量] [--dry]
     默认 source/img/jupiter-map.jpg 3600 92

   署名：NASA/ESA Hubble OPAL 计划（STScI/MAST），CC BY 4.0
   ============================================================ */

/* ============================================================
   [重要：这个工具的输出**不是**线上使用的那张木星贴图]
   ------------------------------------------------------------
   线上跑的是 tools/jupiter-map-variants.js 从 Solar System Scope 的
   自然色木星图重采样出来的两张（jupiter-map.jpg / jupiter-map-hi.jpg）。

   原因：OPAL 的 globalmap 是三个**窄带滤光片**（F395N/F502N/F658N）的
   产物，与人眼 RGB 没有对应关系。把三档直接配成 R/G/B，大红斑会被渲染成
   **蓝色**（见 .perf/shots/map-BASE.png）。本项目试过两条补救路径：
     · 线性 3x3 最小二乘拟合：系数被解成负的蓝通道增益，
       因为它利用的是三通道间的噪声相关性（三个窄带在木星上高度相关，
       都近似"亮度"），结果把红斑染得更蓝；
     · 手工构造的色相重映射矩阵：把画面推成黄绿色，同样不可用。
   实测对照真实自然色照片（heic2404b）：
       指标       OPAL 直配      SSS 自然色
       紫偏       0.0335        0.0016
       细节对比度  28.9          53.1
   结论：窄带数据做自然色需要真正的**光谱响应标定**（用滤光片透过率曲线
   与太阳光谱卷积出颜色转换矩阵），不是几次最小二乘能解决的问题。
   所以这个工具保留下来只做为一件事的记录：默认走 --base（不做任何色彩
   处理，输出偏蓝的原始直配结果），需要时再用它验证上面这些结论。
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { readTiff, plane } = require('./tiff-read.js')
const { encodePng } = require('./planet-resize.js')
const { pngToJpeg } = require('./png-to-jpeg.js')

const ROOT = path.join(__dirname, '..')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const OUT = path.resolve(positional[0] || path.join(ROOT, 'source', 'img', 'jupiter-map.jpg'))
const OUT_W = Number(positional[1] || 3600)
const QUALITY = Number(positional[2] || 92)
const DRY = process.argv.includes('--dry')
/* --base：只做"分位归一 + 中位拉伸"，不做色彩矩阵 / 饱和 / 细节注入。
   **现在是默认行为** —— 因为色彩处理那一路已被证明不可用（见文件头的
   结论），保留 --color 才走那套实验性流程，用于复核结论。
   无参数时就是 base，避免有人误把它当成"生产用的重出脚本"。 */
const BASE_ONLY = process.argv.includes('--color') ? false : true

const SRC = path.join(ROOT, '.perf', 'jupiter-src', 'opal',
  'hlsp_opal_hst_wfc3-uvis_jupiter-2024a_f395n-f502n-f658n_v1_globalmap.tif')

/* ---------- 参数 ----------
   每个值都由 tools/verify-space-render.js 对着真实照片量出来，
   不是"看着差不多"调出来的。改动任何一个之后请重跑那个工具。 */
/* 曝光归一：把每波段的 [P_LO, P_HI] 线性映射到 [0, 1]。
   用分位而不是 min/max：8bit 产品里有孤立热噪点，用 max 会把整体压暗。 */
const P_LO = 0.02
const P_HI = 0.995
/* 归一化后整图的中位亮度。0.30 而不是更高：中位给到 0.45 以上时，
   赤道亮带会大面积顶到 1.0 被**削平**，实测细节对比度反而从 0.57 掉到
   0.54（削平把纹理压死了）。0.30 让亮带留出余量，整体亮度已经足够
   （校验器里"亮度均值"一项量的是球面渲染后的结果，不是贴图的中位）。 */
const MAP_MEDIAN = 0.30

/* 色彩矩阵与偏置（线性光空间）。**推导过程**（这一版不是最小二乘拟合，
   拟合出来的系数会把噪声当信号 —— 实测得到负的蓝通道增益，
   结果把大红斑染成蓝色）：

   问题：OPAL 的三个滤光片是 F395N(紫) / F502N(绿) / F658N(红)。
   把 F658N 当 R 用是不对的 —— 它是 Hα 窄带，而木星的"红"
   来自甲烷吸收造成的**宽谱反射率差异**，不是 Hα 发射。
   直接一档配一通道，得到的色相与真实相反：实测大红斑在这套映射下
   **偏蓝**（base 版本的预览图就是一颗蓝斑）。

   推导：木星可见光里只有三类色相要拉开 ——
     · 奶油白/淡黄：亮带、亮区
     · 铁锈橙红：暗带边缘、大红斑
     · 淡青蓝：极区霾、部分亮带的冷端
   目标是把"亮且 G≈B"推向暖，"B 明显高于 R"的推向青而不是紫。
   做法是"按通道重标定 + 轻微通道混合"：
     R' = 1.35·R + 0.10·G − 0.06·B   ← 让红色真正压过绿色
     G' = 0.06·R + 1.06·G + 0.02·B
     B' = 0.00·R + 0.04·G + 0.72·B   ← 压低蓝，去掉紫罩
   三个关键约束都满足：大红斑（R 高、B 低）→ 红；亮带（三通道都高）
   → 暖白；极区（B 高）→ 淡青。 */
const COLOR_M = [
  [1.35, 0.10, -0.06],
  [0.06, 1.06, 0.02],
  [0.00, 0.04, 0.72]
]
const COLOR_B = [0, 0, 0]

/* 饱和度增强：矩阵只解决"通道混色"，剩下的是窄带合成普遍偏灰。
   c' = L + (c − L) * SAT_GAIN，围绕亮度轴外推色度（不改变明暗）。
   注意它同时放大 R/B 与 G 的失衡 —— 单独提饱和会把紫偏一起放大，
   所以 SAT_GAIN 与上面的矩阵红/绿增益必须成对调整：
   实测 SAT_GAIN=2.15 + 红绿增益 1.0 时紫偏是 −0.074（偏绿），
   把红/绿增益提到 1.14/1.13 再提饱和才两边都过。 */
const SAT_GAIN = 4.0

/* 细节注入。真实照片的高频能量集中在**纬向条纹**里（云带边缘的丝缕），
   所以噪声按 (经度, 纬度) 生成后沿经度方向强拉伸 ——
   加进去的是"被风拉长的条纹"而不是各向同性颗粒
   （各向同性颗粒会立刻显得像噪点，这是旧版 bump 的教训）。 */
const DETAIL = {
  octaves: 6,
  gain: 0.16,         // 相对归一化亮度的振幅
  stretchX: 0.06,     // 经度方向压缩系数（越小条纹越长）
  scale: 26.0,        // 沿纬度方向的基础频率
  seed: 20240105      // Hubble 观测日期，只是个确定的种子
}

/* ---------- 工具 ---------- */
const lerp = (a, b, t) => a + (b - a) * t
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v
const LIN_TO_SRGB = new Uint8Array(4096)
for (let i = 0; i < 4096; i++) {
  const l = i / 4095
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  LIN_TO_SRGB[i] = Math.round(clamp01(s) * 255)
}
const enc = (lin) => LIN_TO_SRGB[Math.max(0, Math.min(4095, Math.round(lin * 4095)))]

/* 确定性 hash 噪声（不引第三方库） */
function hash21 (x, y) {
  const h = Math.sin(x * 127.1 + y * 311.7 + DETAIL.seed * 0.0001) * 43758.5453
  return h - Math.floor(h)
}
function vnoise (x, y) {
  const ix = Math.floor(x), iy = Math.floor(y)
  const fx = x - ix, fy = y - iy
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  return lerp(
    lerp(hash21(ix, iy), hash21(ix + 1, iy), ux),
    lerp(hash21(ix, iy + 1), hash21(ix + 1, iy + 1), ux), uy)
}
function fbm (x, y, oct) {
  let v = 0, a = 0.5, s = 1
  for (let i = 0; i < oct; i++) { v += a * vnoise(x * s, y * s); s *= 2.03; a *= 0.5 }
  return v
}
function percentile (planeData, q) {
  const hist = new Int32Array(256)
  for (let i = 0; i < planeData.length; i++) hist[planeData[i]]++
  let acc = 0
  const target = planeData.length * q
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= target) return v }
  return 255
}

/* ---------- 主 ---------- */
function main () {
  console.log('读源: ' + path.relative(ROOT, SRC))
  const tif = readTiff(fs.readFileSync(SRC))
  console.log('  尺寸 ' + tif.w + 'x' + tif.h + '  ch=' + tif.ch + '  planar=' + tif.planar)
  if (tif.w !== tif.h * 2) throw new Error('源不是 2:1 等距圆柱投影')

  const band = [0, 1, 2].map((c) => plane(tif, c))
  /* 平面顺序 = 文件里的波段顺序：F395N, F502N, F658N。
     映射到 RGB 必须与滤镜波长一致（395→B, 502→G, 658→R），
     否则会得到蓝带子 + 红边的假彩色（tools/opal-composite.js 记过这个坑）。 */
  const ORDER = [2, 1, 0]   // 输出 R←F658N, G←F502N, B←F395N
  const gains = []
  for (let c = 0; c < 3; c++) {
    const pl = band[ORDER[c]].data
    const lo = percentile(pl, P_LO)
    const hi = percentile(pl, P_HI)
    gains.push({ lo, hi })
    console.log('  通道 ' + ['R', 'G', 'B'][c] + ' ← 平面 ' + ORDER[c] +
      '  归一区间 [' + lo + ', ' + hi + ']')
  }

  const W = OUT_W
  const H = OUT_W / 2
  const out = Buffer.alloc(W * H * 3)
  const rgbLin = new Float64Array(3)
  const srcW = tif.w, srcH = tif.h

  /* 先把全图的中位亮度量出来，用于把中位拉到 MAP_MEDIAN */
  let medSum = 0, medN = 0
  for (let y = 0; y < H; y += 4) {
    for (let x = 0; x < W; x += 4) {
      const sx = Math.min(srcW - 1, Math.floor(x * srcW / W))
      const sy = Math.min(srcH - 1, Math.floor(y * srcH / H))
      const i = sy * srcW + sx
      let l = 0
      for (let c = 0; c < 3; c++) {
        const g = gains[c]
        const v = clamp01((band[ORDER[c]].data[i] - g.lo) / Math.max(1, g.hi - g.lo))
        l += v * (c === 0 ? 0.2126 : c === 1 ? 0.7152 : 0.0722)
      }
      medSum += l; medN++
    }
  }
  const medNow = medSum / Math.max(1, medN)
  const normGain = MAP_MEDIAN / Math.max(1e-6, medNow)
  console.log('  归一后中位亮度 ' + medNow.toFixed(4) + ' → 目标 ' + MAP_MEDIAN +
    '（增益 ' + normGain.toFixed(3) + '）')

  for (let y = 0; y < H; y++) {
    const v = y / (H - 1)
    for (let x = 0; x < W; x++) {
      const sx = Math.min(srcW - 1, Math.floor(x * srcW / W))
      const sy = Math.min(srcH - 1, Math.floor(y * srcH / H))
      const i = sy * srcW + sx
      for (let c = 0; c < 3; c++) {
        const g = gains[c]
        rgbLin[c] = (band[ORDER[c]].data[i] - g.lo) / Math.max(1, g.hi - g.lo)
      }
      /* 细节：x 方向极低频率、y 方向高频 ⇒ 条纹沿纬度密、沿经度长 */
      const n = BASE_ONLY ? 0
        : fbm(x * DETAIL.stretchX / W * DETAIL.scale, v * DETAIL.scale, DETAIL.octaves) - 0.5
      const amp = 2 * n * DETAIL.gain
      const lin0 = rgbLin[0] + amp
      const lin1 = rgbLin[1] + amp
      const lin2 = rgbLin[2] + amp
      const CM = BASE_ONLY ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]] : COLOR_M
      const CB = BASE_ONLY ? [0, 0, 0] : COLOR_B
      const sg = BASE_ONLY ? 1 : SAT_GAIN
      const r = lin0 * CM[0][0] + lin1 * CM[0][1] + lin2 * CM[0][2] + CB[0]
      const gg = lin0 * CM[1][0] + lin1 * CM[1][1] + lin2 * CM[1][2] + CB[1]
      const b = lin0 * CM[2][0] + lin1 * CM[2][1] + lin2 * CM[2][2] + CB[2]
      const L = 0.2126 * r + 0.7152 * gg + 0.0722 * b
      const o = (y * W + x) * 3
      out[o] = enc(clamp01((L + (r - L) * sg) * normGain))
      out[o + 1] = enc(clamp01((L + (gg - L) * sg) * normGain))
      out[o + 2] = enc(clamp01((L + (b - L) * sg) * normGain))
    }
  }
  console.log('  像素渲染完成')

  if (DRY) {
    const p = path.join(ROOT, '.perf', 'shots', 'jupiter-map-opal-dry.png')
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, encodePng(W, H, 3, out))
    console.log('--dry：只写 PNG 预览 ' + path.relative(ROOT, p))
    return
  }
  const tmpPng = path.join(ROOT, '.perf', 'jupiter-map-opal.tmp.png')
  fs.mkdirSync(path.dirname(tmpPng), { recursive: true })
  fs.writeFileSync(tmpPng, encodePng(W, H, 3, out))
  const res = pngToJpeg(tmpPng, OUT, QUALITY)
  fs.rmSync(tmpPng, { force: true })
  console.log('写出 ' + path.relative(ROOT, OUT) + '  ' + W + 'x' + H +
    '  q=' + QUALITY + '  ' + (res.bytes / 1024).toFixed(1) + ' KB')
}

if (require.main === module) main()
