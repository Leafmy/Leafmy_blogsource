'use strict'
/* ============================================================
   细节能量 (tools/detail-energy.js)
   ------------------------------------------------------------
   把一个矩形区域的"高频能量"量成一个数，用来判断画面**糊不糊**。

   定义：对区域内每个像素，取它与 8 邻域均值的差的绝对值，全区域取平均
   （BT.709 luma 域）。这就是一个 3x3 的高通；雾/辉光/低通滤波都会把这个
   数压低，而真实纹理起伏会把它抬高。

   [它证明什么、不证明什么 —— 这条边界必须写下来]
   它擅长的：**同一台渲染器、同一处几何、只改一个参数**的 A/B 对比。
   本项目的实测结论就是这样得到的：
     · 木星贴图 2048 → 3072：detail 3.051 → 3.392（+11.2%，球心附近 +17.7%）
     · bloom 关掉：detail 3.051 → 3.041（几乎无影响）
     · haze 0.07 → 0：detail 3.051 → 3.201（+5%，但平均亮度掉 18%）
   它**不能**用来跨来源比较"谁更清晰"：把参考照片 heic2404b-large.jpg 与
   渲染图按同尺寸同区域量，渲染的 detail 是照片的 3.4 倍 —— 但这显然不表示
   渲染比哈勃照片更清晰（原因是 JPEG 压缩、光照方向、区域内容都不同）。
   所以数值只在**同一场景内的相对比较**里有效，不要拿它给不同来源的图排名。

   输出四项：
     luma         区域平均亮度（判断"变亮导致的假清晰"）
     detail       高通能量绝对值
     p95/p05      亮度分位的比值 —— 与整体亮度无关的对比度指标
     detail/luma  归一化细节

   [为什么必须有 p95/p05 这一项]
   detail 会随画面整体变亮而变大，detail/luma 又会在画面整体变暗时虚高 ——
   而"加一层半透明暖雾"恰好同时做这两件事：抬黑位、压白位、缩小动态范围。
   只有"亮部分位 / 暗部分位"这个比值不受整体明暗影响。
   [但它也有陷阱] 区域里若含大片接近纯黑的深空，p05 会被背景钉住，
   此时该比值对渲染参数不敏感 —— 用它时区域要选在"整块都在球面上"。

   用法:
     node tools/detail-energy.js <img.png> --x= --y= --w= --h=
     node tools/detail-energy.js <a.png> <b.png> --x= --y= --w= --h=   # 同时给相对变化
   ============================================================ */

const path = require('path')
const { decodeImage } = require('./planet-resize.js')

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? Number(h.split('=')[1]) : d
}
if (!positional.length) {
  console.error('用法: node tools/detail-energy.js <img.png> [img2.png] --x= --y= --w= --h=')
  process.exit(1)
}

const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]

function measure (img, x0, y0, w, h) {
  let sum = 0, n = 0, detail = 0, dn = 0, mx = 0
  const vals = []
  for (let y = y0; y < y0 + h; y++) {
    if (y < 1 || y >= img.h - 1) continue
    for (let x = x0; x < x0 + w; x++) {
      if (x < 1 || x >= img.w - 1) continue
      const o = (y * img.w + x) * img.ch
      const c = lum(img.data, o)
      let s = 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          s += lum(img.data, ((y + dy) * img.w + (x + dx)) * img.ch)
        }
      }
      detail += Math.abs(c - s / 8)
      dn++
      sum += c; n++
      vals.push(c)
      if (c > mx) mx = c
    }
  }
  vals.sort((a, b) => a - b)
  const pct = (p) => vals.length ? vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p)))] : 0
  const luma = n ? sum / n : 0
  const det = dn ? detail / dn : 0
  const p95 = pct(0.95), p05 = pct(0.05)
  return {
    luma, detail: det, norm: luma > 1e-6 ? det / luma : 0, max: mx, n,
    p05, p95, p50: pct(0.5), range: p05 > 0.5 ? p95 / p05 : 0
  }
}

const imgs = positional.map((p) => decodeImage(path.resolve(p)))
const x0 = arg('x', 0), y0 = arg('y', 0)
const w = arg('w', imgs[0].w - x0), h = arg('h', imgs[0].h - y0)
console.log('区域 x=' + x0 + ' y=' + y0 + ' w=' + w + ' h=' + h + '   (' + positional.join('  vs  ') + ')')
console.log(['图像', '平均luma', '峰值', 'p05', 'p50', 'p95', 'p95/p05', 'detail', 'detail/luma'].join('\t'))
const res = imgs.map((img, i) => {
  const r = measure(img, x0, y0, w, h)
  console.log([
    path.basename(positional[i]).padEnd(20),
    r.luma.toFixed(1).padStart(8),
    r.max.toFixed(0).padStart(6),
    r.p05.toFixed(0).padStart(5),
    r.p50.toFixed(0).padStart(5),
    r.p95.toFixed(0).padStart(5),
    r.range.toFixed(2).padStart(8),
    r.detail.toFixed(3).padStart(9),
    r.norm.toFixed(4).padStart(12)
  ].join('\t'))
  return r
})
if (res.length === 2) {
  const a = res[0], b = res[1]
  const rel = (x, y) => (x > 1e-9 ? ((y / x - 1) * 100).toFixed(1) + '%' : '—')
  console.log('\nB 相对 A：')
  console.log('  detail           ' + rel(a.detail, b.detail) + '   （绝对高频能量）')
  console.log('  detail/luma      ' + rel(a.norm, b.norm) + '   （注意：变暗时会虚高）')
  console.log('  p95/p05 对比度   ' + rel(a.range, b.range) + '   ← 与整体明暗无关，最可信')
  console.log('  平均luma         ' + rel(a.luma, b.luma))
  console.log('  p05 黑位 ' + a.p05.toFixed(0) + ' → ' + b.p05.toFixed(0) +
    '   p95 白位 ' + a.p95.toFixed(0) + ' → ' + b.p95.toFixed(0))
}
