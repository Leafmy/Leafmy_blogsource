'use strict'
/* ============================================================
   球面渲染校验 (tools/verify-globe-render.js)
   ------------------------------------------------------------
   为什么需要它（而不是只用 verify-space-render.js）：
   verify-space-render.js 验的是**贴图** —— 它把贴图按经纬度重采样后与真实
   照片比，所以能抓"贴图本身偏灰/偏紫/糊"。但它对**渲染器**的变化完全免疫：
   色调映射（Reinhard → ACES）、bloom、体积雾霾、临边模型全都作用在着色器
   里，贴图一点没变，那个工具照样全绿。
   而"看起来像不像照片"最终取决于渲染结果。所以这一层单独把关：
   把**已渲染的画布**里的木星圆面抠出来，与同一张真实照片比同几个量。

   对照条件必须公平：截图的球面像素直径要与参考照片的圆面直径同量级
   （否则"细节对比度"这种按像素测的量根本不可比）。
   参考照片圆面半径 485~515px → 用 --w/--h 反算出对应视口，
   工具会打印实际直径并做断言。

   运行:
     node tools/verify-globe-render.js [渲染图] [参考照片]
     默认 .perf/shots/globe-1600x900.png 与 .perf/jupiter-src/heic2404b-large.jpg
   前置：node tools/serve-public.js（截图那一步需要）
   退出码非 0 表示有断言失败。

   [截图必须带 ?pin —— 否则这个工具会给出错的数]
     无头模式下页面自报视口与截图尺寸不一致（1584x749 vs 1600x900），
     不钉死的话"统一尺寸裁剪"那一步会报"截图与画布尺寸一致"失败，
     饱和度的读数也跟着失真（实测同一组渲染参数：不 pin 时 1.680、pin 后 1.479）。
     正确用例：
       node tools/shoot-scene.js --w=1600 --h=900 --out=globe-1600x900.png "--q=pin=1600x900"
       node tools/verify-globe-render.js
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage } = require('./planet-resize.js')
const { detectDisk } = require('./verify-space-render.js')

const ROOT = path.join(__dirname, '..')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SHOT = path.resolve(positional[0] || path.join(ROOT, '.perf', 'shots', 'globe-1600x900.png'))
const REF = path.resolve(positional[1] || path.join(ROOT, '.perf', 'jupiter-src', 'heic2404b-large.jpg'))

let pass = 0
let fail = 0
const failures = []
function check (name, ok, detail) {
  if (ok) { pass++; console.log('  \u2705 ' + name + (detail ? '  ' + detail : '')) } else {
    fail++; failures.push(name); console.log('  \u274c ' + name + (detail ? '  ' + detail : ''))
  }
}
const f = (v, n) => Number(v).toFixed(n == null ? 3 : n)

const SRGB_TO_LIN = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
function sat (r, g, b) {
  const m = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  return (m + mn) > 1e-9 ? (m - mn) / (m + mn) : 0
}

/* 在一个圆面区域（椭圆，扁率由磁盘检测给出）内统计：
   饱和度 / 亮度 / 紫偏 / 高频细节对比度。
   只取 ~85% 半径以内：外圈是临边 + 抗锯齿 + JPEG 块噪声的混合区。 */
function diskStats (img, disk, inner) {
  const rx = disk.rFromRows, ry = disk.rFromCols
  const step = Math.max(2, Math.round((2 * ry) / 200))
  const gW = Math.ceil((2 * rx) / step) + 2
  const gH = Math.ceil((2 * ry) / step) + 2
  const grid = new Float64Array(gW * gH).fill(-1)
  const lim = (inner == null ? 0.85 : inner) ** 2
  let n = 0, sSum = 0, lSum = 0, vSum = 0
  for (let gy = 0; gy < gH; gy++) {
    for (let gx = 0; gx < gW; gx++) {
      const x = Math.round(disk.cx - rx + gx * step)
      const y = Math.round(disk.cy - ry + gy * step)
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue
      const xE = ((x - disk.cx) / ry) * (rx / ry)
      const yL = (y - disk.cy) / ry
      const rho2 = xE * xE + yL * yL
      if (rho2 > lim) continue
      const o = (y * img.w + x) * img.ch
      const R = SRGB_TO_LIN[img.data[o]], G = SRGB_TO_LIN[img.data[o + 1]], B = SRGB_TO_LIN[img.data[o + 2]]
      sSum += sat(R, G, B)
      const L = luma(R, G, B)
      lSum += L
      vSum += (R + B) / 2 - G
      grid[gy * gW + gx] = L
      n++
    }
  }
  if (n < 50) return null
  let hf = 0, hc = 0
  for (let gy = 1; gy < gH - 1; gy++) {
    for (let gx = 1; gx < gW - 1; gx++) {
      const v = grid[gy * gW + gx]
      if (v < 0) continue
      const a = grid[gy * gW + gx + 1], b = grid[(gy + 1) * gW + gx]
      if (a < 0 || b < 0) continue
      hf += (v - a) ** 2 + (v - b) ** 2
      hc += 2
    }
  }
  /* 受光侧亮度：取圆面内较亮的那 20% 像素的平均亮度。
     为什么不用全圆面平均：我们的取景里木星是被侧光照亮的（阳光来自画面
     左侧），右半边本来就暗；而参考照片几乎整面受光。直接比全盘平均会把
     "相位不同"算成"曝光不足"（实测这项曾是 0.274，全是这个原因）。
     取亮部子集之后就与相位无关，只反映"受光面亮不亮"。 */
  const lums = []
  for (let i = 0; i < grid.length; i++) if (grid[i] >= 0) lums.push(grid[i])
  lums.sort((x, y) => y - x)
  const topN = Math.max(1, Math.round(lums.length * 0.2))
  let litSum = 0
  for (let i = 0; i < topN; i++) litSum += lums[i]
  return {
    n,
    sat: sSum / n,
    lum: lSum / n,
    lit: litSum / topN,
    vio: vSum / n,
    hf: hc ? Math.sqrt(hf / hc) * 1000 : 0
  }
}

/* ---------- 圆面定位（穷举 + 受光面积判据）----------
   前三版启发式都失败了，过程值得留档：
     1) "亮度阈值取最大包围盒" → 被页面下方的亮卡片拖到页面底部；
     2) "块内亮像素占比 > 60% 的最大连通域" → 选中博客头像
        （头像亮底、木星暗底带相位，密度判据天然偏向小而亮的块）；
     3) "盘内平均亮度最高" → 选中**标题文字**那一行（白字饱和度极高，
        即使只有几个采样点落在字上，平均值也压过带相位的木星）。

   教训：木星在这个页面上是"**大**且受光"的一块，而页面里的干扰物
   要么小（头像、卡片）要么细（文字）。所以判据应该是
   "盘内**受光点的数量**最多"，而不是平均亮度 ——
   文字细成一条线，装不满任何像样的圆盘；木星则能装满。
   阈值取图像亮度的 25%（木星受光面远高于此，暗面低于此）。 */
function locateDisk (img, threshFrac) {
  const { w, h, ch, data } = img
  const lum = new Uint8Array(w * h)
  let maxL = 0
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    lum[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
    if (lum[i] > maxL) maxL = lum[i]
  }
  const thr = maxL * (threshFrac == null ? 0.25 : threshFrac)
  const rMin = Math.max(24, Math.round(Math.min(w, h) * 0.14))
  const rMax = Math.round(Math.min(w, h) * 0.48)
  const rStep = Math.max(4, Math.round((rMax - rMin) / 12))
  const xStep = Math.max(8, Math.round(w / 44))
  const yStep = Math.max(8, Math.round(h / 44))
  let best = null
  const NR = 16, NA = 28
  for (let ry = rMin; ry <= rMax; ry += rStep) {
    const rx = ry * 1.06   // 木星扁率 ~0.94：横半轴略大于纵半轴
    for (let cy = ry; cy <= h - ry; cy += yStep) {
      for (let cx = rx; cx <= w - rx; cx += xStep) {
        let lit = 0, n = 0
        for (let ri = 1; ri <= NR; ri++) {
          const t = ri / NR
          for (let a = 0; a < NA; a++) {
            const ang = a / NA * Math.PI * 2
            const px = Math.round(cx + Math.cos(ang) * rx * t)
            const py = Math.round(cy + Math.sin(ang) * ry * t)
            if (px < 0 || py < 0 || px >= w || py >= h) continue
            if (lum[py * w + px] > thr) lit++
            n++
          }
        }
        if (!best || lit > best.lit) {
          best = { cx, cy, rFromRows: rx, rFromCols: ry, r: ry, lit, samples: n, thr, maxL }
        }
      }
    }
  }
  return best
}

/* 把图像按给定椭圆区域裁成 Rx2 的方图，球面居中、按需缩放。
   统一尺寸之后所有按像素测的量（细节对比度）才可比。 */
function cropToDisk (img, disk, outW) {
  const R = outW || 1024
  const out = Buffer.alloc(R * R * 3)
  const rx = disk.rFromRows, ry = disk.rFromCols
  for (let oy = 0; oy < R; oy++) {
    for (let ox = 0; ox < R; ox++) {
      const dx = (ox - R / 2) / (R / 2)
      const dy = (oy - R / 2) / (R / 2)
      const sx = Math.round(disk.cx + dx * rx)
      const sy = Math.round(disk.cy + dy * ry)
      const o = (oy * R + ox) * 3
      if (sx < 0 || sy < 0 || sx >= img.w || sy >= img.h) continue
      const p = (sy * img.w + sx) * img.ch
      out[o] = img.data[p]; out[o + 1] = img.data[p + 1]; out[o + 2] = img.data[p + 2]
    }
  }
  return { w: R, h: R, ch: 3, data: out, disk: { cx: R / 2, cy: R / 2, rFromRows: R / 2, rFromCols: R / 2 } }
}

function main () {
  console.log('\n=== 球面渲染 vs 真实 Hubble 照片 ===')
  if (!fs.existsSync(SHOT)) {
    console.error('  找不到渲染图 ' + SHOT)
    console.error('  先跑： node tools/serve-public.js  然后 node tools/shoot-scene.js --out=' +
      path.basename(SHOT))
    process.exit(1)
  }
  const shot = decodeImage(SHOT)
  const ref = decodeImage(REF)
  const dRef = detectDisk(ref)
  /* 球面几何：优先读截图工具写下的 .json 元数据（由页面自己计算，
     完全确定）；没有元数据才退回图像定位（不保证可靠，见 locateDisk 注释）。 */
  const metaPath = SHOT.replace(/\.png$/, '.json')
  let dShot = null
  let sx = 1, sy = 1
  if (fs.existsSync(metaPath)) {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
    const g = meta.globeRect
    /* 截图的像素尺寸可能与画布不同（无头模式下窗口尺寸与页面视口尺寸
       不一致时：实测页面自报画布 1584x749，而截图是 1200x675，
       y 方向比例 1.288）。所以这里按比例换算，并把偏离 1.0 太多当成
       需要告警的情况 —— 那种时候整页截图与页面布局本来就不一致，
       裁剪坐标不再可信。 */
    sx = shot.w / Math.max(1, meta.canvas.w)
    sy = shot.h / Math.max(1, meta.canvas.h)
    dShot = {
      cx: g.cx * sx, cy: g.cy * sy,
      rFromRows: g.rx * sx, rFromCols: g.ry * sy, r: g.ry * sy,
      from: 'meta'
    }
    console.log('  球面几何来自元数据（页面自报），缩放 ' +
      sx.toFixed(3) + 'x / ' + sy.toFixed(3) + 'y')
  } else {
    dShot = locateDisk(shot)
    console.log('  警告：没有 .json 元数据，改用图像定位（可能不准）')
  }
  if (!dShot) {
    console.error('  在渲染图里找不到球面（可能整屏是黑的）')
    process.exit(1)
  }
  console.log('  渲染 ' + path.basename(SHOT) + '  ' + shot.w + 'x' + shot.h +
    '   球面 圆心=(' + f(dShot.cx, 0) + ',' + f(dShot.cy, 0) + ')' +
    ' 半轴 ' + f(dShot.rFromRows, 1) + 'x' + f(dShot.rFromCols, 1) + '  [' + dShot.from + ']')
  console.log('  参考 ' + path.basename(REF) + '  ' + ref.w + 'x' + ref.h +
    '   圆面 半径 ' + f(dRef.rFromRows, 1) + ' px')

  /* 统一尺寸：两边都裁成 1024x1024 的球面图，细节对比度才可比 */
  const N = 1024
  const A = cropToDisk(shot, dShot, N)
  const B = cropToDisk(ref, dRef, N)
  const scaleRatio = Math.max(sx, sy) / Math.min(sx, sy)
  check('截图与画布尺寸一致（否则裁剪坐标会被拉伸）', scaleRatio < 1.05,
    'x' + f(sx, 3) + ' / y' + f(sy, 3))
  const a = diskStats(A, A.disk, 0.86)
  const b = diskStats(B, B.disk, 0.86)
  if (!a || !b) { console.error('  圆面内样本不足'); process.exit(1) }
  check('两边都裁成了统一尺寸的球面图（可比）', A.w === B.w && A.h === B.h, N + 'x' + N)
  /* --dump：把裁出来的两边各写一张 PNG。定位错了的时候，
     看这一对图比看数字快得多（数字只会说"亮度不对"，
     图会直接告诉你"裁到的是黑天空"）。 */
  if (process.argv.includes('--dump')) {
    const { encodePng } = require('./planet-resize.js')
    const d = path.join(ROOT, '.perf', 'shots')
    fs.writeFileSync(path.join(d, 'crop-render.png'), encodePng(N, N, 3, A.data))
    fs.writeFileSync(path.join(d, 'crop-reference.png'), encodePng(N, N, 3, B.data))
    console.log('  已写出 crop-render.png / crop-reference.png')
  }

  console.log('\n  ' + ['指标', '渲染', '参考', '比值/差'].join('\t'))
  console.log('  饱和度均值\t' + f(a.sat, 4) + '\t' + f(b.sat, 4) + '\t' + f(a.sat / b.sat, 3))
  console.log('  受光侧亮度\t' + f(a.lit, 4) + '\t' + f(b.lit, 4) + '\t' + f(a.lit / b.lit, 3))
  console.log('  全盘亮度\t' + f(a.lum, 4) + '\t' + f(b.lum, 4) + '\t' + f(a.lum / b.lum, 3) + '（含夜面，仅供参考）')
  console.log('  细节对比度\t' + f(a.hf, 2) + '\t' + f(b.hf, 2) + '\t' + f(a.hf / b.hf, 3))
  console.log('  紫偏\t\t' + f(a.vio, 4) + '\t' + f(b.vio, 4) + '\t' + f(a.vio - b.vio, 4))

  console.log('')
  /* 阈值说明：渲染结果**应当**比贴图更接近照片（着色器会补上临边昏暗、
     大气边缘散射、相位明暗），但不可能完全一致——参考是单次观测，
     而且相位角/晨昏线位置与我们的取景不同（我们的阳光从画面左侧来）。
     所以这几项卡的是"量级正确"，不是"逐像素相同"：
       饱和度 0.6~1.5 ：低了说明又被色调映射洗灰，高了说明调过头
       受光侧亮度 0.5~1.6：**这是曝光的主判据**（全盘平均含夜面，不可比）
       细节  ≥ 0.6    ：低于 0.6 说明被 bloom/雾霾糊掉了
       紫偏  |Δ|≤0.03 ：贴图已消除紫罩，渲染不应重新引入 */
  check('渲染饱和度在合理区间（0.6~1.5 倍）',
    a.sat / b.sat >= 0.6 && a.sat / b.sat <= 1.5, f(a.sat / b.sat, 3))
  check('受光侧亮度在合理区间（0.5~1.6 倍）',
    a.lit / b.lit >= 0.5 && a.lit / b.lit <= 1.6, f(a.lit / b.lit, 3))
  check('云带细节没有被后处理糊掉（≥ 0.6 倍）', a.hf / b.hf >= 0.6, f(a.hf / b.hf, 3))
  check('渲染未重新引入紫偏（|Δ| ≤ 0.03）', Math.abs(a.vio - b.vio) <= 0.03, f(a.vio - b.vio, 4))

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('  失败项: ' + failures.join(' | ')); process.exit(1) }
  console.log('  ALL CHECKS PASSED')
}

if (require.main === module) main()
module.exports = { diskStats }
