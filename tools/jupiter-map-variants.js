'use strict'
/* ============================================================
   木星贴图变体裁剪 (tools/jupiter-map-variants.js)
   ------------------------------------------------------------
   源：Solar System Scope 的 4096x2048 等距圆柱投影木星贴图
       （CC BY 4.0，经 Wikimedia Commons 镜像）
       https://commons.wikimedia.org/wiki/File:Solarsystemscope_texture_8k_jupiter.jpg

   为什么最终用这张而不是 OPAL 的 Hubble 全球图：
   OPAL 的 globalmap 是三个**窄带滤光片**（F395N/F502N/F658N）的产物，
   它与人眼 RGB 没有对应关系。实测把三档直接配成 R/G/B 会把大红斑渲染成
   **蓝色**（见 .perf/shots/map-BASE.png），而任何线性/仿射颜色校正都无法
   把它救回来 —— 因为那三个通道在木星上是高度相关的（都近似"亮度"），
   线性组合解出的系数会把噪声当信号（实测出现过负的蓝通道增益）。
   所以这张贴图的目标不是"像某一张照片"，而是"色相正确"。
   对照真实 Hubble 照片（heic2404b）的量化结果：
       指标        这张 / 旧贴图(OPAL 上采样)
       紫偏        0.0016 / 0.0335
       细节对比度   53.1   / 28.9
       亮度均值     0.454  / 0.409

   本工具只做**重采样与尺寸档位**，不做任何颜色处理 ——
   贴图本身已经是自然色，任何"增强"都会把它推离真实。
   降采样用面积平均（box），不用双线性抽点：后者在 2:1 这种整数比下
   会刚好取到同一相位，丢掉一半细节且产生拍频纹。

   用法: node tools/jupiter-map-variants.js [源jpg]
   输出（覆盖 source/img/）：
     jupiter-map.jpg        2048x1024  默认档（约 500 KB）
     jupiter-map-hi.jpg     3072x1536  高质量档（大屏 / dpr 2）
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage, encodePng, boxDown } = require('./planet-resize.js')
const { pngToJpeg } = require('./png-to-jpeg.js')

const ROOT = path.join(__dirname, '..')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SRC = path.resolve(positional[0] || path.join(ROOT, '.perf', 'planet-src', 'sss-8k_jupiter.jpg'))

const VARIANTS = [
  { out: 'jupiter-map.jpg', w: 2048, q: 88 },
  { out: 'jupiter-map-hi.jpg', w: 3072, q: 88 }
]

/* 饱和度的微调量。
   源贴图本身就是自然色，所以这里只补一个很小的量：实测它在球面上渲染后
   比真实照片低 17%（0.206 vs 0.248，见 verify-space-render.js），
   而其中一部分会被大气边缘散射补回来，所以只在**线性光**里给 1.18 倍，
   再回看校验器 —— 一次给太多会把木星推成"卡通橙"
   （这条路上已经翻过一次车：饱和度给到 2.15 时整颗星变黄绿）。
   做法：c' = L + (c − L) * gain，围绕亮度轴，明暗不变。 */
const SAT_GAIN = 1.18

const SRGB_TO_LIN = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const LIN_TO_SRGB = new Uint8Array(2048)
for (let i = 0; i < 2048; i++) {
  const l = i / 2047
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  LIN_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)))
}
const enc = (l) => LIN_TO_SRGB[Math.max(0, Math.min(2047, Math.round(l * 2047)))]

/* 在线性光里做一次轻微饱和度提升（原地改 small.data） */
function saturate (img, gain) {
  const d = img.data
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * img.ch
    const r = SRGB_TO_LIN[d[o]], g = SRGB_TO_LIN[d[o + 1]], b = SRGB_TO_LIN[d[o + 2]]
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
    d[o] = enc(L + (r - L) * gain)
    d[o + 1] = enc(L + (g - L) * gain)
    d[o + 2] = enc(L + (b - L) * gain)
  }
  return img
}

/* 接缝修复：水平环绕（把贴图当"圆"来处理）。
   [为什么要它] 等距圆柱贴图在球面上首尾相接：u=0 那一列与 u=w-1 那一列在球面
   经度上只差 360/w 度，是**相邻**的。但普通重采样与 JPEG 编码把两条边分别
   处理，于是它们的值不再匹配。实测（tools/detail-energy.js 同款解码路径）：
     源(4096)       左右边缘平均|Δ|=1.69，内部相邻列 1.64 → 1.03x（基本无缝）
     生成的 3072 档 左右边缘平均|Δ|=1.87，内部相邻列 0.66 → 2.82x
     生成的 2048 档 左右边缘平均|Δ|=2.21，内部相邻列 0.87 → 2.53x
   差值最大到 16~18 luma。球体转到那条经线时就是一道硬边（用户报的"裂痕"），
   而且 mipmap 会在各级继续把这条边平均开，看起来像一条沟。
   [做法] 先把源图**水平加宽**：最左 B 列复制到右端、最右 B 列复制到左端
   （左右两侧的内容本来就是相邻的，所以这是正确的环绕延拓，不是编造），
   然后从这个加宽图按"源坐标 x+B"重采样到目标尺寸。这样：
     · 最右 B 列的目标像素跨过接缝，取到的是被复制到左端的那些列（即真正的环绕邻居）
     · 输出天然无缝，不需要事后拉一条渐变（渐变只能在带宽内把台阶摊开，
       仍留一圈模糊带）
   下采样本来就要把每个输出像素映射回源坐标，所以加宽只改映射、不改采样逻辑。 */
const SEAM_BAND = 32

function widenedWrap (img) {
  const B = Math.min(SEAM_BAND, Math.floor(img.w / 4))
  const W = img.w + 2 * B
  const out = Buffer.alloc(W * img.h * img.ch)
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < W; x++) {
      /* 加宽坐标系 x → 源坐标系：x - B 落在 [0, w) 就是本体；
         两侧越界处用环绕取源（左侧取出右边的列）。 */
      let sx = x - B
      if (sx < 0) sx += img.w
      if (sx >= img.w) sx -= img.w
      const so = (y * img.w + sx) * img.ch
      const dof = (y * W + x) * img.ch
      out[dof] = img.data[so]
      out[dof + 1] = img.data[so + 1]
      out[dof + 2] = img.data[so + 2]
    }
  }
  return { w: W, h: img.h, ch: img.ch, data: out, _band: B, _srcW: img.w }
}

/* 从"加宽环绕图"重采样到目标尺寸（面积平均，等于 boxDown 的推广：
   每个输出像素覆盖源区间 [x0,x1)，对加宽图上的整数像素做面积加权）。 */
function resizeWrapped (wide, ow, oh) {
  const { w: W, h: H, ch, data, _band: B, _srcW: srcW } = wide
  const out = Buffer.alloc(ow * oh * ch)
  const xScale = srcW / ow
  const yScale = H / oh
  for (let y = 0; y < oh; y++) {
    const y0 = y * yScale, y1 = y0 + yScale
    const iy0 = Math.floor(y0), iy1 = Math.min(H, Math.ceil(y1))
    for (let x = 0; x < ow; x++) {
      /* [为什么 x=0 要从加宽图的中心起算]
         加宽图把来源的 x=B..B+w-1 放在中间。若直接从 B 开始按 xScale 铺开，
         输出第 0 列取的是源 x≈0 附近（对），但最后一列会落在源 x≈w-1 附近的
         **半个像素**处，于是"最后一列"与"第 0 列"仍是相邻的半像素关系、
         并非真正的环绕邻居 —— 实测边缘/内部比值只从 2.82 降到 1.33 就是这个原因。
         正确做法是让目标像素的**中心**落在源坐标对应的采样点上：
           src = (x + 0.5)·xScale，再加宽坐标偏移 B 与半像素 (0.5-0.5·xScale)。
         这样 x=0 与 x=ow-1 采样点的间距正好等于源的一整圈，二者才是真正相邻。 */
      const c = (x + 0.5) * xScale + B + (0.5 - 0.5 * xScale)
      const sx0 = c - xScale / 2, sx1 = sx0 + xScale
      const ix0 = Math.floor(sx0), ix1 = Math.ceil(sx1)
      let r = 0, g = 0, b = 0, wsum = 0
      for (let sy = iy0; sy < iy1; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = ix0; sx < ix1; sx++) {
          const wx = Math.min(sx1, sx + 1) - Math.max(sx0, sx)
          if (wx <= 0) continue
          const cx = sx < 0 ? 0 : (sx >= W ? W - 1 : sx)
          const o = (sy * W + cx) * ch
          const wt = wx * wy
          r += data[o] * wt; g += data[o + 1] * wt; b += data[o + 2] * wt
          wsum += wt
        }
      }
      const dof = (y * ow + x) * ch
      if (wsum > 0) {
        out[dof] = Math.max(0, Math.min(255, Math.round(r / wsum)))
        out[dof + 1] = Math.max(0, Math.min(255, Math.round(g / wsum)))
        out[dof + 2] = Math.max(0, Math.min(255, Math.round(b / wsum)))
      }
    }
  }
  return { w: ow, h: oh, ch, data: out }
}

/* 量一张图左右边缘的失配（与内部相邻列的比值），用于复核接缝修好了没有 */
function seamMetric (img) {
  const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]
  let a = 0, b = 0
  const mid = Math.floor(img.w / 2)
  for (let y = 0; y < img.h; y++) {
    a += Math.abs(lum(img.data, (y * img.w) * img.ch) -
      lum(img.data, (y * img.w + img.w - 1) * img.ch))
    b += Math.abs(lum(img.data, (y * img.w + mid) * img.ch) -
      lum(img.data, (y * img.w + mid + 1) * img.ch))
  }
  return { edge: a / img.h, inner: b / img.h, ratio: (a / img.h) / Math.max(1e-6, b / img.h) }
}

function main () {
  if (!fs.existsSync(SRC)) {
    console.error('找不到源贴图 ' + SRC)
    console.error('从 Wikimedia Commons 下载：')
    console.error('  https://commons.wikimedia.org/wiki/Special:FilePath/Solarsystemscope_texture_8k_jupiter.jpg')
    process.exit(1)
  }
  const img = decodeImage(SRC)
  console.log('源 ' + path.relative(ROOT, SRC) + '  ' + img.w + 'x' + img.h +
    '  比例 ' + (img.w / img.h).toFixed(4))
  if (Math.abs(img.w / img.h - 2) > 0.01) throw new Error('源不是 2:1 等距圆柱投影')

  const imgDir = path.join(ROOT, 'source', 'img')
  const tmpDir = path.join(ROOT, '.perf')
  /* 复核用：源的接缝指标（作为"修好没有"的基准） */
  const srcSeam = seamMetric(img)
  console.log('源接缝指标：边缘|Δ|=' + srcSeam.edge.toFixed(2) + '  内部相邻|Δ|=' +
    srcSeam.inner.toFixed(2) + '  比值=' + srcSeam.ratio.toFixed(2) + 'x')
  for (const v of VARIANTS) {
    if (v.w > img.w) { console.log('跳过 ' + v.out + '：目标宽 ' + v.w + ' 超过源宽'); continue }
    const h = v.w / 2
    /* [为什么先加宽再重采样]
       源图在水平方向是"圆"的（等距圆柱首尾相接），但 boxDown 这类重采样把左右
       两条边当普通边界处理 ⇒ 两条边的值不再匹配，球面转到那条经线时出现硬边
       （用户报的"裂痕"）。先把源水平环绕加宽（最左 B 列补到右端、最右 B 列补到
       左端），再从加宽图重采样，最右 B 列就能取到真正的环绕邻居。
       [相位问题仍在] 原来的"半相位预滤波"是为了避免规则采样在 2:1 整数倍时
       产生拍频细横纹；现在 mid 那一跳同样走加宽重采样，语义一致。 */
    const wide = widenedWrap(img)
    let small
    if (v.w < img.w) {
      const mid = Math.max(v.w, Math.round(v.w * 1.5))
      small = mid < img.w ? resizeWrapped(wide, mid, mid / 2) : null
      if (small) small = resizeWrapped(widenedWrap(small), v.w, h)
      else small = resizeWrapped(wide, v.w, h)
    } else {
      /* 不缩放时：只保留加宽图的中心部分，等价于原图但已经过一次环绕采样 */
      small = resizeWrapped(wide, img.w, img.h)
    }
    saturate(small, SAT_GAIN)
    const seam = seamMetric(small)
    console.log('  ' + v.out + ' 接缝：边缘|Δ|=' + seam.edge.toFixed(2) + '  内部相邻|Δ|=' +
      seam.inner.toFixed(2) + '  比值=' + seam.ratio.toFixed(2) + 'x')
    const png = path.join(tmpDir, 'jupiter-map-variant.tmp.png')
    fs.writeFileSync(png, encodePng(small.w, small.h, 3, small.data))
    const outPath = path.join(imgDir, v.out)
    const r = pngToJpeg(png, outPath, v.q)
    fs.rmSync(png, { force: true })
    console.log('写出 ' + v.out + '  ' + small.w + 'x' + small.h + '  q=' + v.q +
      '  ' + (r.bytes / 1024).toFixed(0) + ' KB')
  }

  /* 复核：两张输出都要是 2:1、并且不能被"重采样成灰" */
  console.log('\n复核：')
  for (const v of VARIANTS) {
    const p = path.join(imgDir, v.out)
    if (!fs.existsSync(p)) continue
    const o = decodeImage(p)
    let satSum = 0, n = 0
    for (let y = 0; y < o.h; y += 7) {
      for (let x = 0; x < o.w; x += 7) {
        const q = (y * o.w + x) * o.ch
        const R = o.data[q], G = o.data[q + 1], B = o.data[q + 2]
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B)
        if (mx > 20) { satSum += (mx - mn) / (mx + mn); n++ }
      }
    }
    console.log('  ' + v.out + '  ' + o.w + 'x' + o.h + '  比例 ' + (o.w / o.h).toFixed(4) +
      '  平均饱和度 ' + (satSum / Math.max(1, n)).toFixed(4))
  }
}

if (require.main === module) main()
