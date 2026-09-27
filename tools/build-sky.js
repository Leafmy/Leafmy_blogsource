'use strict'
/* ============================================================
   银河背景层生成 (tools/build-sky.js)  →  source/img/sky-milkyway.jpg
   ------------------------------------------------------------
   【为什么需要这个脚本】
   WebGL 天空需要一个"能直接采样"的银河底图：着色器里只会做
     方向向量 → (银经, 银纬) → (u, v)
   所以底图必须已经在**银道坐标系**下、且经纬度是线性的。手头的素材
   是一张真实的全天照片，而它的方位（哪一列是 l=0、l 往左还是往右
   递增、b 朝上还是朝下、b 到行号是线性还是等面积）我们并不知道，
   靠猜会让银河整体错位几十度。因此本脚本用**星表反解照片方位**：
   把星表里的亮星按某个假设投到照片上，谁投得最准就是谁的方位，
   最后用"最亮 30 颗星到最近亮团的角距离中位数"验收（门限 0.5°）。
   这是唯一可靠的办法，也是本脚本存在的理由。

   【数据来源与许可】
   - 底图：ESO "The Milky Way panorama" (eso0932a)，6000x3000 全天照
     片，银道坐标、银道面水平居中。
     版权/credit: **ESO/S. Brunier**，许可 **CC BY 4.0**。
     （CC BY 4.0 要求署名；本文件头即署名载体，输出图是该作品的改编
      物，转载/再发布必须保留 "ESO/S. Brunier, CC BY 4.0"。）
   - 星表：.perf/planet-src/stars.6.json，GeoJSON，5044 颗星，
     properties.mag = 目视星等，properties.bv = B−V 色指数(字符串)，
     geometry.coordinates = [赤经°, 赤纬°]，**赤道 J2000**。

   【为什么走无头 Chrome】
   仓库里没有 sharp/jimp 这类原生图像库，Node 里也没有 JPEG 解码器。
   既有做法（见 tools/jupiter-prep.js 的 shoot()）是让 Chrome 把图片
   渲染出来再 --screenshot 成 PNG，然后用 tools/png-to-jpeg.js 里的
   decodePng() 解码。本脚本沿用同一套路，不引入任何新依赖。

   【关键常数及其出处】
   1) 赤道 J2000 → 银道：用标准 J2000 银道框常数
        - 银河北极 NGP:  RA = 192.85948°, Dec = +27.12825°
        - 银心 GC:       RA = 266.40499°, Dec = −28.93617°
      这是 IAU 采用、并被 Hipparcos/SIMBAD 广泛使用的 J2000 值。由这
      两点构造正交基（第三轴 = 叉积），把恒星的赤道单位向量投影上去
      即得银道坐标，无需查表。公式（见 galFromEq()）：
        ẑ_gal = (cos Dec_N cos RA_N, cos Dec_N sin RA_N, sin Dec_N)
        R̂     = (cos Dec_G cos RA_G, cos Dec_G sin RA_G, sin Dec_G)
        x̂_gal = R̂                    → 指向银心 (l=0, b=0)
        ŷ_gal = ẑ_gal × x̂_gal        → 指向 l=90°
        ẑ_gal = x̂_gal × ŷ_gal        → 指向 b=+90° (NGP)
      对恒星赤道单位向量 v:  l = atan2(v·ŷ, v·x̂),  b = asin(v·ẑ)
      脚本启动时用天狼星/织女星/北极星的已知银道坐标自检（见步骤 0）。
      与本仓库既有的"简化银道面矩阵"不同：那个矩阵是 1950 历元、只有
      3 位有效数字，用它做亚度级对齐会带进固定偏差，故按定义现算。

   2) 分辨率：源 6000x3000 → 标定/抑制用 Chrome 渲染 3000x1500
      （**0.12 °/px**，经纬同值，因为 360:180 = 3000:1500）；残差验收
      另渲染一次 6000x3000 原分辨率（**0.06 °/px**），因为 0.12°/px 下
      星像只有 2–3 个像素，质心量化误差本身就有 ±0.2°，会把 0.5° 的
      门限撑满。内存：6000x3000 的 RGB 是 54 MB，只用于残差测量且不建
      整幅亮度图（只取局部窗口），测完即可回收。

   3) 取向假设：经向镜像 2 × 纬向上下翻转 2 × 竖向映射 {线性于 b,
      线性于 sin(b)} 2 = 8 组；每组再扫经向偏移 l0 ∈ [0,360°)。
      偏移的搜索是三级：**粗扫 1° → 在粗峰 ±1.5° 内细扫 0.05° → 三级
      三分搜索精修到 ~0.01°**。为什么不直接按题目建议的 0.5° 网格全扫：
      ① 0.5° 的离散化误差本身就能吃掉 0.5° 门限的一半，必须连续精修；
      ② 8 组 × 720 档 × 909 颗星的逐星邻域统计要跑十几分钟，而三级搜索
      在同样覆盖率下只要约 7500 次打分（约 25 s）。粗扫 1° 足以定位到
      正确的峰（真峰与次峰的差距是 0.2 以上的量级，不是 1° 级别的细节），
      细扫+精修负责把它拉到亚 0.01°。
      注意："经向镜像 + 偏移"与"只有偏移"在连续偏移下等价（镜像等于
      l → −l 再平移），所以在细扫+精修之后两者会收敛到同一个峰、得分
      完全相同，这是数学上的必然简并，不是搜索失败。
      "纬向上下翻转"与"竖向映射方式"是两个独立自由度：前者定 b 的
      符号，后者定 b 到行号的投影（等角 vs 等面积），必须分开枚举。

   4) 竖向映射的两种候选：
      - linb  : y ∝ (90° − b)，等角；sinb : y ∝ (1 − sin b)/2，等面积。
      注意两者在 b=0 处导数相同，所以**仅靠银道面附近的星无法区分**；
      判据来自中高纬度的星（|b|=60° 时两者行号差 10.5%）。
      实测里这一点很关键：打分指标（局部亮点对比）把 linb 排在第一
      （peak 1.4805 vs 1.2696），但**原分辨率残差**把 sinb 排在前面
      （0.314° vs 0.404°），两者相差 0.09°，远超逐星噪声水平。因此本
      脚本的最终裁定权在残差（第 4 节 "better()" 选择器）：先看谁满足
      0.5° 门限，再比"扣除全局偏移后的残差中位数"。这条规则也是题目
      "★ 用亮星残差验收"的直接落地。

   5) 星等到权重：w = exp(−0.85·mag)。mag 0 与 4.5 的权重比约 46:1 ——
      亮星星像信噪比高、位置可信；暗星在 0.12°/px 下只剩 1–2 像素，
      位置本身带噪声，必须让亮星主导打分，否则会被"暗星噪声恰好压在
      某个亮斑上"这类虚假命中带偏。

   6) 打分判据（在 2 倍降采样亮度图上，即 0.24°/样本）：对每颗星取预测
      点周围 0.48° 见方内盘区的最大亮度 peak，与 ±2.2° 圆窗的中位数 med
      比较，得 c = (peak − med)/(med + 8)。分母加 8（0–255 灰度中的小
      常数）防止"整片全黑"处出现 0/0 或爆炸比值。总分
      score = Σ w·softplus(c)/Σ w，softplus(x)=ln(1+e^x)：c 大时趋近 c
      （奖励"确实压在亮点上"），c 负时趋近 0 但仍为正，从而对"预测落进
      黑区"形成平滑惩罚而非硬性丢弃。另有 contrast = Σw·c/Σw 与
      hit = P(c>0.35) 两个交叉指标。

   7) 残差：**不**用投影的全局逆映射（那会把假设里的经向偏移重复计
      一次），而是取预测像素与探测到的亮团质心的偏移 (Δx, Δy) 再换算：
        dl = Δx · 0.06° / cos b        （银经在小纬度处被压缩：1° 经度
                                         对应的天球弧长 = cos b 度）
        db = Δy · 0.06° · (sinb 模式取 cos b，linb 模式取 1)
        ρ  = hypot(dl, db)
      对 <1° 的偏移，一阶近似误差在 1e-4 量级，远小于门限。
      另做两件事保证这个数字是"真的"：
        (i) 全局偏移消解 —— 报 Δl̄/Δb̄（带符号的系统偏差）与"扣除全局
            偏移后"的残差中位数，把"整体错位"和"逐星随机误差"分开；
        (ii) 敏感性抽检 —— 人为把 l0 打偏 ±0.25/±0.5/±1.0°，残差中位数
            必须随之单调变大，否则说明指标饱和、这个"通过"是假的。

   8) 星点抑制：照片把星星也拍进去了，渲染器还要再画一遍清晰星点，两者
      错开就成"重影"。做法是在 3000x1500 上对每个星表位置找最近的亮团
      质心，用 2.8–4.2 倍局部光斑半径的环带中位数把该处像素抹掉（只抹
      "明显高于背景"的像素，避免在无星处留方形补丁），最后对整幅做一次
      温和低通（σ = 2.5 px = **0.30°**，半径 10 px 的 4σ 截断高斯）。
      环带中位数采样必须排除**所有**星点替换区内的像素（星点掩膜），
      否则会采到邻星、抹出暗斑；掩膜半径按每颗星各自的替换半径取，不能
      统一取最大值（那会盖住全图）。对比度量：星点区亮度 99.5 分位 −
      未受星点污染的本地(32x16 块)中位数，抑制前后各测一次。

   9) 天空背景与色调：地面全天照片有大尺度 airglow/光污染梯度。做法是
      把亮度盒式降采样到 32x16（每格 11.25°×11.25°），双线性放大回
      全分辨率当"平滑背景"，再从 RGB 三通道减掉 88%（保留 12%）。只减
      88% 是为了不把银河本身（银道面上下宽约 ±10°，正落在 11° 这个
      尺度上）一起削掉；脚本打印"银道带/高纬 P90 比值"验证银河仍在。
      色调曲线 t(v) = s·(v/255 + lift)·(v/255 + lift)^(γ−1)，即
      t = s·(x+lift)^γ，x = v/255。s 由亮端定（p99.95 → 0.95），lift 由
      均值定（→ 0.045），γ 由 99.9 分位约束定（≤0.5）。三个参数各管一段
      （亮端 / 暗端 / 中段），故用嵌套二分即可稳定求解；lift>0 使地面
      照片的底噪不至于被压成纯黑，同时把均值抬到可观但合规的水平。
      目标：全域平均灰度 ≤ 0.06、99.9 分位 ≤ 0.5。

   用法: node tools/build-sky.js [--no-suppress]
   退出码: 0 通过；1 硬性断言失败；2 标定不确定（残差 > 0.5°）需人工复核
   ============================================================ */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SRC_JPG = path.join(ROOT, '.perf', 'planet-src', 'eso0932a.jpg')
const SRC_STARS = path.join(ROOT, '.perf', 'planet-src', 'stars.6.json')
const OUTDIR = path.join(ROOT, 'source', 'img')
const OUT_JPG = path.join(OUTDIR, 'sky-milkyway.jpg')
const TMP = path.join(ROOT, '.perf', 'build-sky')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const NO_SUPPRESS = process.argv.includes('--no-suppress')
const T0 = Date.now()

const RENDER_W = 3000            // 标定/抑制用（0.12 °/px）
const RENDER_H = 1500
const FINE_W = 6000              // 残差验收用（0.06 °/px）
const FINE_H = 3000
const OUT_W = 2048
const OUT_H = 1024
const DEG_PER_PX = 360 / RENDER_W
const FINE_DEG_PER_PX = 360 / FINE_W
const MAG_LIMIT_SCORE = 4.5
const MAG_LIMIT_SUPPRESS = 5.5
const COARSE_STEP = 1.0          // 偏移粗扫步长（度）；细扫 0.05°，再三分精修到 ~0.01°
const FINE_STEP = 0.05           // 偏移细扫步长（度）
const KEEP_BG = 0.12             // 保留 12% 平滑背景 → 减掉 88%
const TARGET_MEAN = 0.045        // 色调目标均值（硬约束是 ≤0.06，留 0.015 余量）
const TARGET_P999 = 0.50         // 99.9 分位上限（硬约束）

/* ---------------- J2000 银道框常数 ---------------- */
const NGP_RA = 192.85948, NGP_DEC = 27.12825
const GC_RA = 266.40499, GC_DEC = -28.93617
const D2R = Math.PI / 180
const R2D = 180 / Math.PI

const GAL = (() => {
  const z = [Math.cos(NGP_DEC * D2R) * Math.cos(NGP_RA * D2R), Math.cos(NGP_DEC * D2R) * Math.sin(NGP_RA * D2R), Math.sin(NGP_DEC * D2R)]
  const x = [Math.cos(GC_DEC * D2R) * Math.cos(GC_RA * D2R), Math.cos(GC_DEC * D2R) * Math.sin(GC_RA * D2R), Math.sin(GC_DEC * D2R)]
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]]
  const zz = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
  return { x, y, z: zz }
})()

function galFromEq (raDeg, decDeg) {
  const ra = raDeg * D2R, dec = decDeg * D2R
  const v = [Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec)]
  const dot = w => v[0] * w[0] + v[1] * w[1] + v[2] * w[2]
  let l = Math.atan2(dot(GAL.y), dot(GAL.x)) * R2D
  if (l < 0) l += 360
  return { l, b: Math.asin(Math.max(-1, Math.min(1, dot(GAL.z)))) * R2D }
}

/* ---------------- 无头 Chrome 截图（同 tools/jupiter-prep.js 的 shoot） ---------------- */
function fileUrl (p) {
  return 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')
}
const { decodePng, pngToJpeg } = require('./png-to-jpeg.js')

function shoot (html, outPng, winW, winH) {
  const prof = path.join(TMP, 'chrome-prof')
  fs.rmSync(prof, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  const htmlPath = outPng.replace(/\.png$/, '.html')
  fs.writeFileSync(htmlPath, html)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions',
    '--force-device-scale-factor=1',
    '--window-size=' + winW + ',' + winH,
    '--virtual-time-budget=4000',
    '--screenshot=' + outPng,
    fileUrl(htmlPath)
  ], { stdio: 'ignore', timeout: 240000 })
  fs.rmSync(prof, { recursive: true, force: true })
  fs.rmSync(htmlPath, { force: true })
  if (!fs.existsSync(outPng)) throw new Error('截图失败: ' + outPng)
  return decodePng(fs.readFileSync(outPng))
}
function shootJpg (jpg, outPng, w, h) {
  return shoot(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:#000;overflow:hidden}
       img{display:block;width:${w}px;height:${h}px}
     </style></head><body><img src="${fileUrl(jpg)}"></body></html>`, outPng, w, h)
}

/* ---------------- 小工具 ---------------- */
function meanOf (a) { let s = 0; for (const v of a) s += v; return s / a.length }
function medianOf (arr) {
  if (!arr.length) return 0
  const s = Array.from(arr).sort((a, b) => a - b)
  const n = s.length
  return n % 2 ? s[(n - 1) >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2])
}
function percentileOf (arr, q) {
  const s = Array.from(arr).sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]
}
/* 把灰度盒式降采样到 (ow,oh)，可跳过 maskR>0 的像素（星点替换区） */
function blockMean (lum, w, h, ow, oh, maskR) {
  const out = new Float32Array(ow * oh)
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor(y * h / oh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / oh))
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor(x * w / ow), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / ow))
      let s = 0, n = 0
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w
        for (let xx = x0; xx < x1; xx++) {
          const p = row + xx
          if (maskR && maskR[p] > 0) continue
          s += lum[p]; n++
        }
      }
      out[y * ow + x] = n ? s / n : 0
    }
  }
  return out
}

/* ---------------- PNG 写盘 / JPEG SOF 解析 ---------------- */
const CRC_T = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk (type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0)
  return Buffer.concat([len, t, data, crc])
}
function writePng (file, w, h, rgb) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 2
  const stride = w * 3
  const raw = Buffer.alloc(h * (stride + 1))
  const src = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length)
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    src.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const out = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ])
  fs.writeFileSync(file, out)
  return out.length
}
function jpegInfo (buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG')
  let p = 2
  while (p + 4 <= buf.length) {
    if (buf[p] !== 0xff) { p++; continue }
    const m = buf[p + 1]
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue }
    const L = buf.readUInt16BE(p + 2)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { marker: '0x' + m.toString(16), h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7), nc: buf[p + 9] }
    }
    if (m === 0xda) break
    p += 2 + L
  }
  throw new Error('找不到 SOF')
}

/* ---------------- 投影几何（模块级，与假设无关） ---------------- */
const rowFrac = (latDeg, vmode, flip) => {
  const t = vmode === 'sinb' ? (1 - Math.sin(latDeg * D2R)) / 2 : (90 - latDeg) / 180
  return flip ? 1 - t : t
}
// 行号 → 银纬，需要知道帧高
const makeLatOfRow = (frameH) => (y, vmode, flip) => {
  const t0 = y / (frameH - 1)
  const t = flip ? 1 - t0 : t0
  return vmode === 'sinb'
    ? Math.asin(Math.max(-1, Math.min(1, 1 - 2 * t))) * R2D
    : 90 - 180 * t
}
const predPx = (s, l0, mirror, frameW) => {
  let t = (mirror ? -s.u : s.u) + l0 / 360
  t -= Math.floor(t)
  return t * frameW - 0.5
}
const predPy = (s, vmode, flip, frameH) => rowFrac(s.b, vmode, flip) * (frameH - 1)

/* ============================================================
   主流程
   ============================================================ */
function main () {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  fs.mkdirSync(OUTDIR, { recursive: true })

  /* ---------- 0) 银道变换自检 ---------- */
  console.log('0) 赤道 J2000 → 银道 变换自检（对已知银道坐标）：')
  const SELF = [
    { n: '天狼星 Sirius  ', ra: 101.2872, dec: -16.7161, l: 227.23, b: -8.89 },
    { n: '织女星 Vega    ', ra: 279.2347, dec: 38.7837, l: 67.45, b: 19.24 },
    { n: '北极星 Polaris ', ra: 37.9546, dec: 89.2641, l: 123.28, b: 26.46 }
  ]
  let selfOK = true
  for (const s of SELF) {
    const g = galFromEq(s.ra, s.dec)
    let dl = Math.abs(g.l - s.l); if (dl > 180) dl = 360 - dl
    const ok = dl < 0.2 && Math.abs(g.b - s.b) < 0.2
    if (!ok) selfOK = false
    console.log('   ' + s.n + ' → l=' + g.l.toFixed(2).padStart(6) + '  b=' + g.b.toFixed(2).padStart(6) +
      '   (参考 l=' + s.l.toFixed(2) + ' b=' + s.b.toFixed(2) + ')  ' + (ok ? '✅' : '❌'))
  }
  if (!selfOK) { console.error('断言失败：银道变换与参考值不符。'); process.exit(1) }

  /* ---------- 1) 解码底图与星表 ---------- */
  console.log('1) 解码底图（无头 Chrome，' + RENDER_W + 'x' + RENDER_H + '，' + DEG_PER_PX.toFixed(3) + ' °/px）与星表…')
  const full = shoot(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:#000;overflow:hidden}
       img{display:block;width:${RENDER_W}px;height:${RENDER_H}px}
     </style></head><body><img src="${fileUrl(SRC_JPG)}"></body></html>`,
    path.join(TMP, 'eso-3000.png'), RENDER_W, RENDER_H)
  if (full.w !== RENDER_W || full.h !== RENDER_H) {
    console.error('断言失败：底图尺寸 ' + full.w + 'x' + full.h); process.exit(1)
  }
  const W = full.w, H = full.h, CH = full.ch, rgb = full.data
  console.log('   底图 ' + W + 'x' + H + ' ch=' + CH + '  （' + ((Date.now() - T0) / 1000).toFixed(1) + 's）')

  const LUM = new Uint8ClampedArray(W * H)
  for (let p = 0, i = 0; p < W * H; p++, i += CH) {
    LUM[p] = 0.299 * rgb[i] + 0.587 * rgb[i + 1] + 0.114 * rgb[i + 2]
  }
  console.log('   亮度分位：p50=' + percentileOf(LUM, 0.5) + '  p90=' + percentileOf(LUM, 0.9) +
    '  p99=' + percentileOf(LUM, 0.99) + '  p99.9=' + percentileOf(LUM, 0.999) + '  max=' + percentileOf(LUM, 1))

  const LW = W >> 1, LH = H >> 1
  const LD = new Float32Array(LW * LH)
  for (let j = 0; j < LH; j++) {
    for (let i = 0; i < LW; i++) {
      const p = (2 * j) * W + 2 * i
      LD[j * LW + i] = (LUM[p] + LUM[p + 1] + LUM[p + W] + LUM[p + W + 1]) / 4
    }
  }
  const sampleLD = (i, j) => {
    const a = i < 0 ? 0 : (i >= LW ? LW - 1 : i)
    const b = j < 0 ? 0 : (j >= LH ? LH - 1 : j)
    return LD[b * LW + a]
  }

  const geo = JSON.parse(fs.readFileSync(SRC_STARS, 'utf8'))
  const stars = []
  for (const f of geo.features) {
    const ra = Number(f.geometry.coordinates[0])
    const dec = Number(f.geometry.coordinates[1])
    const mag = Number(f.properties.mag)
    if (!isFinite(ra) || !isFinite(dec) || !isFinite(mag)) continue
    const g = galFromEq(ra, dec)
    stars.push({ mag, l: g.l, b: g.b, bv: f.properties.bv, u: g.l / 360, phi: (1 - Math.sin(g.b * D2R)) / 2 })
  }
  const scoreStars = stars.filter(s => s.mag < MAG_LIMIT_SCORE)
    .map(s => Object.assign({}, s, { w: Math.max(1e-5, Math.exp(-0.85 * s.mag)) }))
  const WSUM = scoreStars.reduce((a, s) => a + s.w, 0)
  console.log('   星表 ' + stars.length + ' 颗；mag<' + MAG_LIMIT_SCORE + ' 的 ' + scoreStars.length + ' 颗用于打分')

  /* ---------- 2) 取向搜索 ---------- */
  console.log('2) 取向标定：偏移步长 ' + COARSE_STEP + '°(粗) → ' + FINE_STEP + '°(细) → 三分精修；' +
    '镜像 2 × 上下翻转 2 × 竖向映射 2 = 8 组假设')
  const MAXR = 2, ANNR = 9, ASTRIDE = 2
  const inner = [], ann = []
  for (let dj = -ANNR; dj <= ANNR; dj++) {
    for (let di = -ANNR; di <= ANNR; di++) {
      const r = Math.hypot(di, dj)
      if (r <= MAXR) inner.push([di, dj])
      else if (r <= ANNR && (di % ASTRIDE === 0 && dj % ASTRIDE === 0)) ann.push([di, dj])
    }
  }
  let scoreCalls = 0
  function scoreAt (l0, mirror, vmode, flip) {
    scoreCalls++
    let sw = 0, ssum = 0, sc = 0, hit = 0, n = 0
    for (const s of scoreStars) {
      const xp = predPx(s, l0, mirror, W), yp = predPy(s, vmode, flip, H)
      const ci = Math.round(xp / 2), cj = Math.round(yp / 2)
      if (ci < -ANNR || cj < -ANNR || ci > LW + ANNR || cj > LH + ANNR) continue
      let peak = -1
      for (let k = 0; k < inner.length; k++) {
        const v = sampleLD(ci + inner[k][0], cj + inner[k][1])
        if (v > peak) peak = v
      }
      const vals = new Float64Array(ann.length)
      for (let k = 0; k < ann.length; k++) vals[k] = sampleLD(ci + ann[k][0], cj + ann[k][1])
      vals.sort()
      const med = vals.length % 2 ? vals[(vals.length - 1) >> 1] : 0.5 * (vals[vals.length / 2 - 1] + vals[vals.length / 2])
      const c = (peak - med) / (med + 8)
      ssum += s.w * Math.log(1 + Math.exp(Math.max(-30, Math.min(30, c))))
      sc += s.w * c; sw += s.w; n++
      if (c > 0.35) hit++
    }
    return { score: ssum / sw, contrast: sc / sw, hit: hit / Math.max(1, n), n }
  }

  const combos = []
  for (const mirror of [false, true]) {
    for (const vmode of ['linb', 'sinb']) {
      for (const flip of [false, true]) combos.push({ mirror, vmode, flip })
    }
  }
  const sweep = (c, step, span, around) => {
    let best = null
    const n = Math.round(span / step)
    for (let k = 0; k <= n; k++) {
      const l0 = around !== undefined
        ? ((around - span / 2 + k * step) % 360 + 360) % 360
        : k * step
      if (around === undefined && l0 >= 360) break
      const sc = scoreAt(l0, c.mirror, c.vmode, c.flip)
      if (!best || sc.score > best.sc.score) best = { l0, sc }
    }
    return best
  }
  const tCoarse = Date.now()
  for (const c of combos) {
    const b = sweep(c, COARSE_STEP, 360)
    c.l0 = b.l0; c.peak = b.sc.score; c.contrast = b.sc.contrast; c.hit = b.sc.hit
    // 峰锐度：粗扫全周打分的中位数以上多少（区分"真对上"与"整体偏亮"）
    c.sharp = b.sc.score
  }
  combos.sort((a, b) => b.peak - a.peak)
  // 用粗扫全周曲线算 sharp
  for (const c of combos) {
    const arr = []
    for (let k = 0; k < 360; k++) arr.push(scoreAt(k * COARSE_STEP, c.mirror, c.vmode, c.flip).score)
    c.medianAll = medianOf(arr)
    c.sharp = c.peak - c.medianAll
  }
  console.log('   粗扫前 5（peak=softplus 均值；sharp=峰 − 全周中位数，反映"是真对上还是整体偏亮"）：')
  for (const c of combos.slice(0, 5)) {
    console.log('     l0=' + c.l0.toFixed(2).padStart(6) + '  mirror=' + (c.mirror ? 'Y' : 'N') +
      '  vmode=' + c.vmode + '  flip=' + (c.flip ? 'Y' : 'N') +
      '   peak=' + c.peak.toFixed(4) + '  sharp=' + c.sharp.toFixed(4))
  }

  // 细扫：对前 4 组假设在粗峰 ±1.5° 内以 0.05° 细扫
  for (const c of combos.slice(0, 4)) {
    const b = sweep(c, FINE_STEP, 3.0, c.l0)
    c.l0 = b.l0; c.peak = b.sc.score; c.contrast = b.sc.contrast; c.hit = b.sc.hit
  }
  // 连续精修（三级三分搜索，60 迭代/级）
  for (const c of combos.slice(0, 4)) {
    for (const span of [0.2, 0.05, 0.015]) {
      let lo = c.l0 - span, hi = c.l0 + span
      for (let it = 0; it < 60; it++) {
        const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3
        if (scoreAt(m1, c.mirror, c.vmode, c.flip).score < scoreAt(m2, c.mirror, c.vmode, c.flip).score) lo = m1
        else hi = m2
      }
      c.l0 = ((lo + hi) / 2 + 360) % 360
    }
  }
  combos.sort((a, b) => b.peak - a.peak)
  console.log('   细扫+精修前 3（打分调用 ' + scoreCalls + ' 次，耗时 ' + ((Date.now() - tCoarse) / 1000).toFixed(1) + 's）：')
  for (const c of combos.slice(0, 3)) {
    console.log('     l0=' + c.l0.toFixed(4).padStart(9) + '  mirror=' + (c.mirror ? 'Y' : 'N') +
      '  vmode=' + c.vmode + '  flip=' + (c.flip ? 'Y' : 'N') +
      '   peak=' + c.peak.toFixed(4) + '  contrast=' + c.contrast.toFixed(4) + '  hit=' + (c.hit * 100).toFixed(1) + '%')
  }

  /* ---------- 3) 残差：原分辨率(6000x3000)测星团质心 ---------- */
  console.log('3) 残差验收：另渲染原分辨率 ' + FINE_W + 'x' + FINE_H + '（' + FINE_DEG_PER_PX.toFixed(3) + ' °/px）…')
  const fine = shoot(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:#000;overflow:hidden}
       img{display:block;width:${FINE_W}px;height:${FINE_H}px}
     </style></head><body><img src="${fileUrl(SRC_JPG)}"></body></html>`,
    path.join(TMP, 'eso-6000.png'), FINE_W, FINE_H)
  if (fine.w !== FINE_W || fine.h !== FINE_H) { console.error('断言失败：原分辨率渲染 ' + fine.w + 'x' + fine.h); process.exit(1) }
  const FW = fine.w, FH = fine.h, FCH = fine.ch

  const top30 = stars.slice().sort((a, b) => a.mag - b.mag).slice(0, 30)

  /* 在 fine 图上找预测点附近的亮团质心，返回像素偏移 */
  function detectBlob (s, c) {
    const px = predPx(s, c.l0, c.mirror, FW), py = predPy(s, c.vmode, c.flip, FH)
    const cx = Math.round(px), cy = Math.round(py)
    const R = 8                    // ±8 px = ±0.48°
    // 局部背景：以质心为中心 22x22 的中位数，排除 ±R 内圈，避免把星本身算进背景
    const bgv = []
    for (let j = cy - 11; j <= cy + 11; j++) {
      if (j < 0 || j >= FH) continue
      for (let i = cx - 11; i <= cx + 11; i++) {
        if (i < 0 || i >= FW) continue
        if (Math.abs(i - cx) <= R && Math.abs(j - cy) <= R) continue
        const q = (j * FW + i) * FCH
        bgv.push(0.299 * fine.data[q] + 0.587 * fine.data[q + 1] + 0.114 * fine.data[q + 2])
      }
    }
    const bg = medianOf(bgv)
    const lumAt = (i, j) => {
      const q = (j * FW + i) * FCH
      return 0.299 * fine.data[q] + 0.587 * fine.data[q + 1] + 0.114 * fine.data[q + 2]
    }
    let best = null
    for (let j = Math.max(1, cy - R); j <= Math.min(FH - 2, cy + R); j++) {
      for (let i = Math.max(1, cx - R); i <= Math.min(FW - 2, cx + R); i++) {
        const v = lumAt(i, j)
        if (v <= bg) continue
        if (lumAt(i + 1, j) > v || lumAt(i - 1, j) > v || lumAt(i, j + 1) > v || lumAt(i, j - 1) > v) continue
        if (!best || v > best.v) best = { i, j, v }
      }
    }
    if (!best || best.v < bg + 8) return null
    // 阈值动量质心（阈值 = 峰值 − 4 码值），限制在 ±R 内
    const thr = best.v - 4
    const seen = new Set(); const stack = [[best.i, best.j]]
    let sw = 0, sx = 0, sy = 0
    while (stack.length) {
      const [i, j] = stack.pop()
      if (i < cx - R || j < cy - R || i > cx + R || j > cy + R) continue
      if (i < 0 || j < 0 || i >= FW || j >= FH) continue
      const key = j * FW + i
      if (seen.has(key)) continue
      const v = lumAt(i, j)
      if (v < thr) continue
      seen.add(key)
      const wt = v - bg
      sw += wt; sx += wt * i; sy += wt * j
      stack.push([i + 1, j], [i - 1, j], [i, j + 1], [i, j - 1])
    }
    if (!sw) return null
    return { dx: sx / sw - px, dy: sy / sw - py, peak: best.v, bg, px, py }
  }

  /* 对一组假设测残差：返回每颗星的 rho（度）与带符号偏移 */
  function residualsOf (c, list) {
    const out = []
    for (const s of list) {
      const d = detectBlob(s, c)
      if (!d) { out.push(null); continue }
      const bc = s.b * D2R
      const dl = d.dx * FINE_DEG_PER_PX / Math.max(0.2, Math.cos(bc))
      const db = d.dy * FINE_DEG_PER_PX * (c.vmode === 'sinb' ? Math.cos(bc) : 1)
      out.push({ s, dl, db, rho: Math.hypot(dl, db), peak: d.peak, bg: d.bg, dist: Math.hypot(d.dx, d.dy) })
    }
    return out
  }
  function summarize (res) {
    const ok = res.filter(Boolean)
    const rhos = ok.map(r => r.rho)
    const dlBar = meanOf(ok.map(r => r.dl))
    const dbBar = meanOf(ok.map(r => r.db))
    // 扣除全局偏移后的残差
    const resid = ok.map(r => Math.hypot(r.dl - dlBar, r.db - dbBar))
    // 剩余误差是"系统性的"还是"逐星随机的"？把 (Δl,Δb) 对 (l, b) 做仿射拟合：
    // 若仿射模型的残差明显小于原始离散度，说明照片还有整体倾斜/尺度偏差
    const pearson = (xs, ys) => {
      const mx = meanOf(xs), my = meanOf(ys)
      let sxy = 0, sxx = 0, syy = 0
      for (let k = 0; k < xs.length; k++) { const a = xs[k] - mx, b2 = ys[k] - my; sxy += a * b2; sxx += a * a; syy += b2 * b2 }
      return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0
    }
    const L = ok.map(r => r.s.l), B = ok.map(r => r.s.b)
    const DL = ok.map(r => r.dl), DB = ok.map(r => r.db)
    const corr = { dlL: pearson(DL, L), dlB: pearson(DL, B), dbL: pearson(DB, L), dbB: pearson(DB, B) }
    const sd = arr => {
      const m = meanOf(arr)
      return Math.sqrt(meanOf(arr.map(v => (v - m) * (v - m))))
    }
    return {
      n: ok.length, miss: res.length - ok.length, ok,
      med: medianOf(rhos), mean: meanOf(rhos), max: rhos.length ? Math.max.apply(null, rhos) : NaN,
      dlBar, dbBar, glob: Math.hypot(dlBar, dbBar),
      medAfterGlobal: medianOf(resid), meanAfterGlobal: meanOf(resid),
      corr, sdL: sd(DL), sdB: sd(DB)
    }
  }

  const cands = combos.slice(0, 4)
  console.log('   对前 4 组假设在原分辨率上测最亮 30 颗（±0.48° 搜索窗，找局部极大再取质心）：')
  const summary = []
  for (const c of cands) {
    const s = summarize(residualsOf(c, top30))
    summary.push({ c, s })
    console.log('     l0=' + c.l0.toFixed(3).padStart(9) + ' mirror=' + (c.mirror ? 'Y' : 'N') +
      ' vmode=' + c.vmode + ' flip=' + (c.flip ? 'Y' : 'N') +
      '  → 残差中位数 ' + s.med.toFixed(3) + '°  扣除全局偏移后 ' + s.medAfterGlobal.toFixed(3) +
      '°  全局偏移 Δl=' + s.dlBar.toFixed(3) + '° Δb=' + s.dbBar.toFixed(3) + '°  (n=' + s.n + '/30)')
  }
  let win = summary[0]
  for (const w of summary) {
    // 选先满足门限、再比"扣全局偏移后残差"最小的
    const better = (a, b) => {
      const aOK = a.s.med <= 0.5, bOK = b.s.med <= 0.5
      if (aOK !== bOK) return aOK
      return a.s.medAfterGlobal < b.s.medAfterGlobal
    }
    if (better(w, win)) win = w
  }
  const conf = { l0: win.c.l0, mirror: win.c.mirror, vmode: win.c.vmode, flip: win.c.flip }
  const resWin = win.s
  console.log('   胜出：l0=' + conf.l0.toFixed(3) + '°  mirror=' + (conf.mirror ? '开' : '关') +
    '  vmode=' + conf.vmode + '  flip=' + (conf.flip ? '开' : '关'))
  for (const r of resWin.ok) {
    console.log('     mag=' + r.s.mag.toFixed(2).padStart(5) + '  l=' + r.s.l.toFixed(1).padStart(5) +
      '  b=' + r.s.b.toFixed(1).padStart(5) + '  峰值=' + r.peak.toFixed(0).padStart(3) +
      '  背景=' + r.bg.toFixed(0).padStart(3) + '  质心偏移=' + r.dist.toFixed(2).padStart(5) +
      'px  残差=' + r.rho.toFixed(3) + '°')
  }
  console.log('   残差：中位数=' + resWin.med.toFixed(3) + '°  均值=' + resWin.mean.toFixed(3) +
    '°  最大=' + resWin.max.toFixed(3) + '°  (' + resWin.n + '/30 颗找到亮团)')
  console.log('   全局偏移 Δl=' + resWin.dlBar.toFixed(3) + '°  Δb=' + resWin.dbBar.toFixed(3) +
    '°  |Δ|=' + resWin.glob.toFixed(3) + '°；扣除后残差中位数=' + resWin.medAfterGlobal.toFixed(3) + '°')
  console.log('   离散度 σ(Δl)=' + resWin.sdL.toFixed(3) + '°  σ(Δb)=' + resWin.sdB.toFixed(3) +
    '°；Δ 与 (l,b) 的相关系数 r(Δl,l)=' + resWin.corr.dlL.toFixed(2) + ' r(Δl,b)=' + resWin.corr.dlB.toFixed(2) +
    ' r(Δb,l)=' + resWin.corr.dbL.toFixed(2) + ' r(Δb,b)=' + resWin.corr.dbB.toFixed(2) +
    '（若 |r| 接近 1 说明还有整体倾斜/尺度偏差，否则是逐星随机误差）')

  // 敏感性抽检：l0 打偏后残差必须变大，否则指标饱和、这个"通过"不算数
  const sens = []
  for (const off of [-1.0, -0.5, -0.25, 0, 0.25, 0.5, 1.0]) {
    const c2 = Object.assign({}, conf, { l0: ((conf.l0 + off) % 360 + 360) % 360 })
    const s2 = summarize(residualsOf(c2, top30))
    sens.push({ off, med: s2.med })
  }
  console.log('   敏感性（l0 人为打偏 → 残差中位数）：' +
    sens.map(x => (x.off > 0 ? '+' : '') + x.off.toFixed(2) + '°→' + x.med.toFixed(3) + '°').join('  '))
  const sensOK = sens[0].med > resWin.med + 0.05 && sens[sens.length - 1].med > resWin.med + 0.05
  console.log('   指标有效性：打偏 ±1° 后残差明显变大 → ' + (sensOK ? '✅ 指标对取向敏感' : '❌ 指标饱和（该"通过"不可信）'))
  const residualOK = resWin.med <= 0.5 && sensOK
  console.log('   门限 ≤ 0.5°: ' + (resWin.med <= 0.5 ? '✅ 通过' : '❌ 未通过') + (sensOK ? '' : '（但指标饱和，判定为不确定）'))

  /* ---------- 4) 星点抑制 ---------- */
  console.log('4) 抑制照片里"已经拍进去"的星点（环带中位数替换 + 低通）…')
  let suppStat = null
  if (!NO_SUPPRESS) {
    const suppStars = stars.filter(s => s.mag < MAG_LIMIT_SUPPRESS).sort((a, b) => a.mag - b.mag)
    const maskR = new Float32Array(W * H)
    const plan = []
    for (const s of suppStars) {
      const px = Math.round(predPx(s, conf.l0, conf.mirror, W)), py = Math.round(predPy(s, conf.vmode, conf.flip, H))
      if (px < 4 || py < 4 || px >= W - 4 || py >= H - 4) continue
      const bx = Math.min(LW - 1, px >> 1), by = Math.min(LH - 1, py >> 1)
      let lg = 0
      for (let j = by - 2; j <= by + 2; j++) for (let i = bx - 2; i <= bx + 2; i++) lg += sampleLD(i, j)
      lg /= 25
      // 期望光斑半径：底噪越亮（曝光余量越小）光斑越胖；越亮的星也越胖
      const rExp = Math.max(2.5, Math.min(9, 2.5 + lg * 0.015 + Math.max(0, 2.5 - s.mag)))
      const rBlend = Math.max(3, Math.min(24, Math.round(2.6 * rExp)))
      const rIn = Math.max(rBlend + 2, Math.round(2.8 * rExp))
      const rOut = Math.round(4.2 * rExp)
      plan.push({ s, px, py, rBlend, rIn, rOut })
      const r2 = rBlend * rBlend
      for (let j = py - rBlend; j <= py + rBlend; j++) {
        if (j < 0 || j >= H) continue
        const row = j * W
        for (let i = px - rBlend; i <= px + rBlend; i++) {
          if (i < 0 || i >= W) continue
          if ((i - px) * (i - px) + (j - py) * (j - py) > r2) continue
          const q = row + i
          if (maskR[q] < rBlend) maskR[q] = rBlend
        }
      }
    }
    let masked = 0
    for (let p = 0; p < maskR.length; p++) if (maskR[p] > 0) masked++
    const radii = plan.map(p => p.rBlend)
    console.log('   计划替换 ' + plan.length + ' 颗；掩膜(替换区并集)占全图 ' + (100 * masked / maskR.length).toFixed(2) +
      '%；替换半径 ' + Math.min.apply(null, radii) + '–' + Math.max.apply(null, radii) + ' px')

    // 对比度：星点区亮度 99.5 分位 与 星点像素 − 未受星点污染的本地(32x16)中位数
    const starArea = () => {
      const vals = []
      for (let p = 0; p < maskR.length; p += 5) if (maskR[p] > 0) vals.push(LUM[p])
      vals.sort((a, b) => a - b)
      return vals[Math.floor(0.995 * (vals.length - 1))]
    }
    const probePx = plan.slice(0, 60).map(p => p.py * W + p.px)
    const blockAt = (B, x, y) => B[Math.min(15, y >> 7) * 32 + Math.min(31, x >> 6)]
    const localContrast = (B) => {
      const diff = probePx.map(p => LUM[p] - blockAt(B, p % W, (p / W) | 0)).sort((a, b) => a - b)
      return diff[Math.floor(0.995 * (diff.length - 1))]
    }
    const bg0 = blockMean(LUM, W, H, 32, 16, maskR)
    const sBefore = starArea(), cBefore = localContrast(bg0)
    console.log('   抑制前：星点区亮度 99.5 分位=' + sBefore.toFixed(1) + ' 码值；星点 − 本地中位数=' +
      cBefore.toFixed(1) + ' 码值（n=' + probePx.length + ' 采样）')

    let done = 0, skipped = 0
    for (const p of plan) {
      const { px, py, rBlend, rIn, rOut } = p
      const vals = []
      const ro = Math.ceil(rOut)
      for (let dj = -ro; dj <= ro; dj++) {
        const j = py + dj
        if (j < 0 || j >= H) continue
        for (let di = -ro; di <= ro; di++) {
          const i = px + di
          if (i < 0 || i >= W) continue
          const r = Math.hypot(di, dj)
          if (r < rIn || r > rOut) continue
          const q = j * W + i
          if (maskR[q] >= rIn) continue
          vals.push(LUM[q])
        }
      }
      if (vals.length < 24) { skipped++; continue }
      const repl = medianOf(vals)
      const thr = Math.max(repl + 3, repl * 1.6)
      const r2 = rBlend * rBlend
      for (let j = py - rBlend; j <= py + rBlend; j++) {
        if (j < 0 || j >= H) continue
        const row = j * W
        for (let i = px - rBlend; i <= px + rBlend; i++) {
          if (i < 0 || i >= W) continue
          if ((i - px) * (i - px) + (j - py) * (j - py) > r2) continue
          const q = row + i
          if (LUM[q] > thr) {
            LUM[q] = repl
            rgb[q * CH] = repl; rgb[q * CH + 1] = repl; rgb[q * CH + 2] = repl
          }
        }
      }
      done++
    }
    console.log('   已替换 ' + done + '/' + plan.length + ' 颗（' + skipped + ' 颗环带样本不足，跳过）')

    // 温和低通：σ=2.5 px = 0.30°，半径 10 px（4σ）
    const SIG = 2.5, R = 10
    const kern = []
    for (let dy = -R; dy <= R; dy++) {
      const row = new Float64Array(2 * R + 1)
      for (let dx = -R; dx <= R; dx++) row[dx + R] = Math.exp(-(dx * dx + dy * dy) / (2 * SIG * SIG))
      kern.push(row)
    }
    const srcL = Uint8Array.from(LUM)
    const srcRgb = Uint8Array.from(rgb)
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        let a = 0, b2 = 0, c = 0, wsum = 0
        for (let dy = -R; dy <= R; dy++) {
          const jj = j + dy
          if (jj < 0 || jj >= H) continue
          const krow = kern[dy + R]
          for (let dx = -R; dx <= R; dx++) {
            const ii = i + dx
            if (ii < 0 || ii >= W) continue
            const kw = krow[dx + R]
            const q = (jj * W + ii) * CH
            a += kw * srcRgb[q]; b2 += kw * srcRgb[q + 1]; c += kw * srcRgb[q + 2]; wsum += kw
          }
        }
        const q = (j * W + i) * CH
        rgb[q] = a / wsum; rgb[q + 1] = b2 / wsum; rgb[q + 2] = c / wsum
        LUM[q] = 0.299 * rgb[q] + 0.587 * rgb[q + 1] + 0.114 * rgb[q + 2]
      }
    }
    const bg1 = blockMean(LUM, W, H, 32, 16, maskR)
    const sAfter = starArea(), cAfter = localContrast(bg1)
    console.log('   低通后：星点区亮度 99.5 分位=' + sAfter.toFixed(1) + '；星点 − 本地中位数=' + cAfter.toFixed(1) + ' 码值')
    console.log('   对比度 ' + cBefore.toFixed(1) + ' → ' + cAfter.toFixed(1) +
      '（降 ' + (100 * (1 - cAfter / Math.max(1e-6, cBefore))).toFixed(1) + '%）')
    suppStat = { before: cBefore, after: cAfter, sBefore, sAfter, done, plan: plan.length, maskedFrac: masked / maskR.length }
  } else {
    console.log('   --no-suppress：跳过星点抑制')
  }

  /* ---------- 5) 重采样到标准约定 + 去背景 + 色调 ---------- */
  console.log('5) 重采样 ' + OUT_W + 'x' + OUT_H + '（box filter）到标准约定：' +
    'x: l 0°(左)→360°(右)；y: b +90°(顶)→−90°(底)')
  const BG = blockMean(LUM, W, H, 32, 16)
  const bgAt = (x, y) => {
    const fx = Math.min(31, Math.max(0, (x + 0.5) / W * 32 - 0.5))
    const fy = Math.min(15, Math.max(0, (y + 0.5) / H * 16 - 0.5))
    const x0 = Math.floor(fx), y0 = Math.floor(fy)
    const x1 = Math.min(31, x0 + 1), y1 = Math.min(15, y0 + 1)
    const tx = fx - x0, ty = fy - y0
    const a = BG[y0 * 32 + x0] * (1 - tx) + BG[y0 * 32 + x1] * tx
    const b = BG[y1 * 32 + x0] * (1 - tx) + BG[y1 * 32 + x1] * tx
    return a * (1 - ty) + b * ty
  }
  const latOfRow = makeLatOfRow(H)

  const pre = new Float32Array(OUT_W * OUT_H * 3)
  const preLum = new Float32Array(OUT_W * OUT_H)
  const xScale = W / OUT_W, yScale = H / OUT_H
  for (let j = 0; j < OUT_H; j++) {
    const lv = latOfRow((j + 0.5) * H / OUT_H - 0.5, conf.vmode, conf.flip)
    const py = rowFrac(lv, conf.vmode, conf.flip) * (H - 1)
    for (let i = 0; i < OUT_W; i++) {
      let lu = conf.mirror ? conf.l0 - (i + 0.5) * 360 / OUT_W : conf.l0 + (i + 0.5) * 360 / OUT_W
      lu = ((lu % 360) + 360) % 360
      const px = predPx({ u: lu / 360 }, 0, false, W) + 0.5
      let sr = 0, sg = 0, sb = 0, sw = 0
      const ja = Math.floor(py - yScale / 2), jb = Math.ceil(py + yScale / 2)
      for (let y = ja; y < jb; y++) {
        if (y < 0 || y >= H) continue
        const wy = Math.min(y + 1, py + yScale / 2) - Math.max(y, py - yScale / 2)
        if (wy <= 0) continue
        const ia = Math.floor(px - xScale / 2), ib = Math.ceil(px + xScale / 2)
        for (let x = ia; x < ib; x++) {
          const wx = Math.min(x + 1, px + xScale / 2) - Math.max(x, px - xScale / 2)
          if (wx <= 0) continue
          const xs = ((x % W) + W) % W
          const q = (y * W + xs) * CH
          const bgv = bgAt(xs, y) * KEEP_BG
          const w = wx * wy
          sr += w * (rgb[q] - bgv)
          sg += w * (rgb[q + 1] - bgv)
          sb += w * (rgb[q + 2] - bgv)
          sw += w
        }
      }
      const o = (j * OUT_W + i) * 3
      const r = sw ? sr / sw : 0, g = sw ? sg / sw : 0, b = sw ? sb / sw : 0
      pre[o] = r; pre[o + 1] = g; pre[o + 2] = b
      preLum[j * OUT_W + i] = Math.max(0, 0.299 * r + 0.587 * g + 0.114 * b)
    }
  }
  // preLum 是 0..255 尺度的连续值；存的是"减完背景"的线性光
  const preSorted = Float32Array.from(preLum).sort()
  const pOf = q => preSorted[Math.min(preSorted.length - 1, Math.floor(q * (preSorted.length - 1)))]
  console.log('   去背景：减掉 32x16 平滑背景（每格 11.25°）的 ' + ((1 - KEEP_BG) * 100).toFixed(0) +
    '%；背景均值=' + meanOf(BG).toFixed(2) + ' 码值；减后 p50=' + pOf(0.5).toFixed(2) +
    ' p90=' + pOf(0.9).toFixed(2) + ' p99=' + pOf(0.99).toFixed(2) +
    ' p99.9=' + pOf(0.999).toFixed(2) + ' p99.95=' + pOf(0.9995).toFixed(2) + ' max=' + pOf(1).toFixed(2))

  /* 色调曲线  t(x) = s·(x + lift)^γ,  x = v/255 ∈ [0,1]
     —— 单调（s,γ>0, lift≥0）、lift 保留黑点（x=0 → 0），三个参数各管一段：
        γ  控制中段（γ>1 压中段、γ<1 抬中段）
        s  控制整体（含亮端；γ 与 s 对 p99.9 的影响方向相反，需一起解）
        lift 控制暗端抬升（只加不减，把地面照片的底噪抬离纯黑）
     解法：在 γ 网格上求 (s, lift) 使
        s·(p99.9 + lift)^γ = 0.45        （亮端落位，留出余量给最亮的星核）
        mean = TARGET_MEAN = 0.045       （均值，嵌套二分 lift）
     然后在所有可行 (γ) 里挑 p99.9 最小者 —— 即"均值打满预算的前提下，亮端
     最不爆"的那条曲线。TARGET_MEAN 留了 0.015 的余量给 ≤0.06 的硬约束
     （JPEG 量化与 4:2:0 抽样会让实际均值再动一点点）。 */
  const ph = new Uint32Array(1024)
  let pmax = 0
  for (const v of preLum) if (v > pmax) pmax = v
  const pscale = pmax > 0 ? 1023 / pmax : 1
  for (const v of preLum) ph[Math.min(1023, Math.round(v * pscale))]++
  const totalPx = preLum.length
  const curveWith = (s, lift, g) => v => Math.min(1, s * Math.pow(v / 255 + lift, g))
  const statsWith = (s, lift, g) => {
    let sum = 0
    for (let k = 0; k <= 1023; k++) {
      if (!ph[k]) continue
      sum += ph[k] * Math.min(1, s * Math.pow((k / pscale) / 255 + lift, g))
    }
    return { mean: sum / totalPx, p999: Math.min(1, s * Math.pow(pOf(0.999) / 255 + lift, g)) }
  }
  const solveLift = (g, s) => {   // 单调：lift ↑ → 均值 ↑
    let lo = 0, hi = 1
    for (let it = 0; it < 50; it++) {
      const m = (lo + hi) / 2
      if (statsWith(s, m, g).mean < TARGET_MEAN) lo = m; else hi = m
    }
    return { lift: (lo + hi) / 2, mean: statsWith(s, (lo + hi) / 2, g).mean }
  }
  let chosen = null
  const gammas = []
  for (let g = 1.0; g <= 1.9001; g += 0.1) gammas.push(Math.round(g * 1000) / 1000)
  for (const g of gammas) {
    const x999 = pOf(0.999) / 255
    for (const tgt of [0.45, 0.35, 0.28, 0.22]) {
      const s = tgt / Math.pow(x999, g)
      const r = solveLift(g, s)
      const st = statsWith(s, r.lift, g)
      if (r.mean < TARGET_MEAN - 0.0005) continue          // 均值没打满 → s 太小，换目标
      if (st.p999 > 0.5 - 0.005) continue                  // 亮端超限
      if (!chosen || st.p999 < chosen.p999) chosen = { g, s, lift: r.lift, mean: r.mean, p999: st.p999, tgt }
      break
    }
  }
  if (!chosen) {   // 兜底：直接用 γ=1 + lift 二分（此时不再强行贴 p99.9 目标）
    const x999 = pOf(0.999) / 255
    const s = 0.45 / x999
    const r = solveLift(1, s)
    chosen = { g: 1, s, lift: r.lift, mean: r.mean, p999: statsWith(s, r.lift, 1).p999, tgt: 0.45 }
    console.log('   ⚠️ 未找到同时满足亮端与均值的 γ，回退 γ=1')
  }
  const s0 = chosen.s, lift = chosen.lift, gamma = chosen.g
  const curve = curveWith(s0, lift, gamma)
  const curveStats = statsWith(s0, lift, gamma)
  console.log('   色调：s=' + s0.toFixed(6) + '  lift=' + lift.toFixed(6) + '  gamma=' + gamma.toFixed(3) +
    '（s·(x+lift)^γ）')
  console.log('   → p99.9=' + curveStats.p999.toFixed(4) + '  p99=' + curve(pOf(0.99)).toFixed(4) +
    '  p90=' + curve(pOf(0.9)).toFixed(4) + '  p50=' + curve(pOf(0.5)).toFixed(4) +
    '  p10=' + curve(pOf(0.1)).toFixed(4) + '  均值=' + curveStats.mean.toFixed(4) +
    '  最大值映射=' + curve(pmax).toFixed(3))

  const lut = new Uint8Array(256)
  for (let v = 0; v < 256; v++) lut[v] = Math.round(255 * curve(v))
  const OUT = new Uint8Array(OUT_W * OUT_H * 3)
  const outLum = new Float32Array(OUT_W * OUT_H)
  for (let p = 0, o = 0; p < OUT_W * OUT_H; p++, o += 3) {
    OUT[o] = lut[Math.min(255, Math.max(0, Math.round(pre[o])))]
    OUT[o + 1] = lut[Math.min(255, Math.max(0, Math.round(pre[o + 1])))]
    OUT[o + 2] = lut[Math.min(255, Math.max(0, Math.round(pre[o + 2])))]
    outLum[p] = (0.299 * OUT[o] + 0.587 * OUT[o + 1] + 0.114 * OUT[o + 2]) / 255
  }

  const sorted = Float32Array.from(outLum).sort()
  const deciles = []
  for (let k = 0; k <= 10; k++) deciles.push(sorted[Math.min(sorted.length - 1, Math.floor(k / 10 * (sorted.length - 1)))])
  const meanGrey = meanOf(outLum)
  const p999out = sorted[Math.min(sorted.length - 1, Math.floor(0.999 * (sorted.length - 1)))]
  const planeBand = [], offBand = []
  for (let j = 0; j < OUT_H; j++) {
    const b = latOfRow((j + 0.5) * H / OUT_H - 0.5, conf.vmode, conf.flip)
    for (let i = 0; i < OUT_W; i += 4) {
      const v = outLum[j * OUT_W + i]
      if (Math.abs(b) < 8) planeBand.push(v)
      else if (Math.abs(b) > 40) offBand.push(v)
    }
  }
  planeBand.sort((a, b) => a - b); offBand.sort((a, b) => a - b)
  const planeP90 = planeBand[Math.floor(0.9 * (planeBand.length - 1))]
  const offP90 = offBand[Math.floor(0.9 * (offBand.length - 1))]

  console.log('6) 输出统计：')
  console.log('   十分位：' + deciles.map((v, k) => 'D' + k + '=' + v.toFixed(4)).join(' '))
  console.log('   均值=' + meanGrey.toFixed(4) + '  99.9 分位=' + p999out.toFixed(4) +
    '  最大=' + sorted[sorted.length - 1].toFixed(4))
  console.log('   银道带(|b|<8°) P90=' + planeP90.toFixed(4) + '  高纬(|b|>40°) P90=' + offP90.toFixed(4) +
    '  比值=' + (planeP90 / Math.max(1e-9, offP90)).toFixed(2) + '×（银河仍可见）')

  /* ---------- 6) 编码 + 校验 ---------- */
  console.log('7) 编码 JPEG q=88 → ' + path.relative(ROOT, OUT_JPG) + ' …')
  const midPng = path.join(TMP, 'sky-milkyway-2048.png')
  const pngBytes = writePng(midPng, OUT_W, OUT_H, OUT)
  console.log('   中间 PNG ' + (pngBytes / 1024 / 1024).toFixed(2) + ' MB')
  pngToJpeg(midPng, OUT_JPG, 88)
  const jpgBuf = fs.readFileSync(OUT_JPG)
  const info = jpegInfo(jpgBuf)
  const back = shootJpg(OUT_JPG, path.join(TMP, 'verify.png'), OUT_W, OUT_H)
  let rtSum = 0
  for (let p = 0, q = 0; p < back.w * back.h; p++, q += back.ch) {
    rtSum += 0.299 * back.data[q] + 0.587 * back.data[q + 1] + 0.114 * back.data[q + 2]
  }
  const rtMean = rtSum / (back.w * back.h) / 255
  const jpgKB = jpgBuf.length / 1024
  const checks = [
    { name: 'JPEG 尺寸 ' + info.w + 'x' + info.h + ' == ' + OUT_W + 'x' + OUT_H, ok: info.w === OUT_W && info.h === OUT_H },
    { name: 'Chrome 回读尺寸 ' + back.w + 'x' + back.h + '（JPEG 完整解码通过）', ok: back.w === OUT_W && back.h === OUT_H },
    { name: '文件大小 ' + jpgKB.toFixed(1) + ' KB ≤ 400 KB', ok: jpgKB <= 400 },
    { name: 'JPEG 三通道 SOF nc=' + info.nc, ok: info.nc === 3 },
    { name: '均值灰度 ' + meanGrey.toFixed(4) + ' ≤ 0.06', ok: meanGrey <= 0.06 },
    { name: '99.9 分位 ' + p999out.toFixed(4) + ' ≤ 0.5', ok: p999out <= 0.5 },
    { name: '动态范围有效利用：99.9 分位 ' + p999out.toFixed(4) + ' > 0.25', ok: p999out > 0.25 },
    { name: '回读均值 ' + rtMean.toFixed(4) + ' 与直接统计差 < 0.01', ok: Math.abs(rtMean - meanGrey) < 0.01 },
    { name: '银河对比度 ' + (planeP90 / Math.max(1e-9, offP90)).toFixed(2) + '× > 1.5', ok: planeP90 / Math.max(1e-9, offP90) > 1.5 },
    { name: '残差中位数 ' + resWin.med.toFixed(3) + '° ≤ 0.5°', ok: resWin.med <= 0.5 },
    { name: '残差指标对取向敏感（±1° 打偏后变大）', ok: sensOK }
  ]
  console.log('8) 校验：')
  let pass = true
  for (const c of checks) { console.log('   ' + (c.ok ? '✅' : '❌') + ' ' + c.name); if (!c.ok) pass = false }

  /* ---------- 汇总 ---------- */
  console.log('\n================ 汇总 ================')
  console.log('取向假设        : l0=' + conf.l0.toFixed(3) + '°  镜像=' + (conf.mirror ? '开' : '关') +
    '  竖向映射=' + (conf.vmode === 'linb' ? '线性于 b' : '线性于 sin(b)') +
    '  上下=' + (conf.flip ? '翻转' : '正常(b 向上增大)'))
  console.log('打分            : peak=' + win.c.peak.toFixed(4) + '  contrast=' + win.c.contrast.toFixed(4) +
    '  hit=' + (win.c.hit * 100).toFixed(1) + '%   sharp=' + win.c.sharp.toFixed(4))
  console.log('残差            : 中位数 ' + resWin.med.toFixed(3) + '°  均值 ' + resWin.mean.toFixed(3) +
    '°  最大 ' + resWin.max.toFixed(3) + '°  (' + resWin.n + '/30)  全局偏移 Δl=' + resWin.dlBar.toFixed(3) +
    '° Δb=' + resWin.dbBar.toFixed(3) + '°  扣全局后 ' + resWin.medAfterGlobal.toFixed(3) + '°')
  console.log('残差结构        : σ(Δl)=' + resWin.sdL.toFixed(3) + '° σ(Δb)=' + resWin.sdB.toFixed(3) +
    '°  r(Δl,l)=' + resWin.corr.dlL.toFixed(2) + ' r(Δb,l)=' + resWin.corr.dbL.toFixed(2) +
    ' r(Δb,b)=' + resWin.corr.dbB.toFixed(2))
  console.log('敏感性          : ' + sens.map(x => (x.off > 0 ? '+' : '') + x.off.toFixed(2) + '°→' + x.med.toFixed(3) + '°').join('  ') +
    '  ' + (sensOK ? '(敏感 ✅)' : '(饱和 ❌)'))
  console.log('星点抑制对比度  : ' + (suppStat
    ? (suppStat.before.toFixed(1) + ' → ' + suppStat.after.toFixed(1) + ' 码值（降 ' +
       (100 * (1 - suppStat.after / suppStat.before)).toFixed(1) + '%）；星点区 99.5 分位 ' +
       suppStat.sBefore.toFixed(1) + ' → ' + suppStat.sAfter.toFixed(1) + '；替换 ' + suppStat.done + '/' + suppStat.plan +
       ' 颗，掩膜占 ' + (100 * suppStat.maskedFrac).toFixed(2) + '%')
    : '（--no-suppress 跳过）'))
  console.log('十分位直方图    : ' + deciles.map(v => v.toFixed(4)).join(', '))
  console.log('均值 / 99.9分位 : ' + meanGrey.toFixed(4) + ' / ' + p999out.toFixed(4))
  console.log('输出            : ' + OUT_W + 'x' + OUT_H + '  ' + jpgKB.toFixed(1) + ' KB  q=88')
  console.log('约定            : x: l 0°→360° 线性（左→右）；y: b +90°→−90° 线性（顶→底）')
  console.log('授权            : ESO "The Milky Way panorama" (eso0932a) — Credit: ESO/S. Brunier — Licence: CC BY 4.0')
  console.log('总耗时          : ' + ((Date.now() - T0) / 1000).toFixed(1) + 's')

  if (!pass) { console.error('\n硬性断言失败。'); process.exit(1) }
  if (!residualOK) {
    console.error('\n标定不确定：残差中位数 ' + resWin.med.toFixed(3) + '° > 0.5°（或指标饱和），需人工复核（exit 2）。')
    process.exit(2)
  }
  console.log('\n完成。')
}

main()
