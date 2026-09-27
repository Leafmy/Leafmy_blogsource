'use strict'
/* ============================================================
   在截图里定位小天体并测亮度 (tools/find-disks.js)
   ------------------------------------------------------------
   为什么不能直接用 report-bodies.js 的坐标去裁：
     页面自报的画布坐标系与 chrome --screenshot 输出的图像坐标系**不一致**
     （实测画布 1584x749，截图 1600x900，y 方向差 1.2 倍，且还带一点平移）。
     拿页面坐标当图像坐标去裁，裁到的永远是空天空 —— 这个坑在本项目里
     已经踩过至少五次（见 shoot-scene.js / report-bodies.js 的注释）。
     唯一可靠的做法是**在图像里找**：小天体是暗背景上的局部亮斑，
     用连通域 + 质心就能定位，再按局部背景量它的真实亮度。

   算法：阈值 = 局部背景 + 绝对增量（默认 6），8 连通域标记，
   丢弃面积 < minPx 或 > maxPx 的连通域（前者是星点、后者是木星/银河）。

   用法:
     node tools/find-disks.js <shot.png> --x= --y= --w= --h= [--min=12] [--max=4000] [--tl=6]
   ============================================================ */

const path = require('path')
const { decodeImage } = require('./planet-resize.js')

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? Number(h.split('=')[1]) : d
}
const img = decodeImage(path.resolve(positional[0]))
const X0 = Math.max(0, arg('x', 0)), Y0 = Math.max(0, arg('y', 0))
const W = Math.min(img.w - X0, arg('w', img.w - X0))
const H = Math.min(img.h - Y0, arg('h', img.h - Y0))
const MIN = arg('min', 12), MAX = arg('max', 4000), TL = arg('tl', 6)

const lum = new Float32Array(W * H)
const rgb = new Uint8Array(W * H * 3)
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const o = ((Y0 + y) * img.w + (X0 + x)) * img.ch
    lum[y * W + x] = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
    rgb[(y * W + x) * 3] = img.data[o]
    rgb[(y * W + x) * 3 + 1] = img.data[o + 1]
    rgb[(y * W + x) * 3 + 2] = img.data[o + 2]
  }
}

/* 局部背景：把整块按 32px 网格取中位数，作为该格的背景基准。
   比"全块一个阈值"稳 —— 页头的压暗渐变会让左亮右暗，全局阈值会漏掉右半边。 */
const G = 32
const bg = new Float32Array(W * H)
for (let gy = 0; gy < H; gy += G) {
  for (let gx = 0; gx < W; gx += G) {
    const vals = []
    for (let y = gy; y < Math.min(H, gy + G); y += 2) {
      for (let x = gx; x < Math.min(W, gx + G); x += 2) vals.push(lum[y * W + x])
    }
    vals.sort((a, b) => a - b)
    const med = vals[Math.floor(vals.length / 2)]
    for (let y = gy; y < Math.min(H, gy + G); y++) {
      for (let x = gx; x < Math.min(W, gx + G); x++) bg[y * W + x] = med
    }
  }
}

const seen = new Uint8Array(W * H)
const out = []
for (let sy = 0; sy < H; sy++) {
  for (let sx = 0; sx < W; sx++) {
    const i0 = sy * W + sx
    if (seen[i0] || lum[i0] <= bg[i0] + TL) continue
    const stack = [i0]
    seen[i0] = 1
    const px = []
    while (stack.length) {
      const i = stack.pop()
      px.push(i)
      const x = i % W, y = (i - x) / W
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
          const j = ny * W + nx
          if (seen[j] || lum[j] <= bg[j] + TL) continue
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    if (px.length < MIN || px.length > MAX) continue
    let sx2 = 0, sy2 = 0, smax = 0, ssum = 0
    let r = 0, g = 0, b = 0
    for (const i of px) {
      const x = i % W, y = (i - x) / W
      sx2 += x; sy2 += y
      if (lum[i] > smax) smax = lum[i]
      ssum += lum[i]
      r += rgb[i * 3]; g += rgb[i * 3 + 1]; b += rgb[i * 3 + 2]
    }
    const cx = sx2 / px.length, cy = sy2 / px.length
    /* 背景基准取该连通域外接框周围的局部背景中位数 */
    let bgv = 0
    for (let k = 0; k < px.length; k++) bgv += bg[px[k]]
    bgv /= px.length
    out.push({
      x: +(cx + X0).toFixed(1), y: +(cy + Y0).toFixed(1),
      px: px.length,
      mean: ssum / px.length, max: smax, bg: bgv,
      rgb: [r / px.length, g / px.length, b / px.length],
      /* 等效直径（按圆面积折算，便于和 drawnPx 对照） */
      dia: +(2 * Math.sqrt(px.length / Math.PI)).toFixed(1)
    })
  }
}
out.sort((a, b) => b.px - a.px)
console.log('搜索区 x=' + X0 + '..' + (X0 + W) + ' y=' + Y0 + '..' + (Y0 + H) +
  '  阈值 背景+' + TL + '  面积 ' + MIN + '~' + MAX + '  命中 ' + out.length + ' 个')
console.log(['图像坐标', '像素数', '等效直径', '均值luma', '峰值luma', '背景luma', '平均RGB'].join('\t'))
for (const o of out) {
  console.log([
    (o.x + ',' + o.y).padEnd(12),
    String(o.px).padStart(6),
    String(o.dia).padStart(8),
    o.mean.toFixed(1).padStart(8),
    o.max.toFixed(1).padStart(8),
    o.bg.toFixed(1).padStart(8),
    ('[' + o.rgb.map((v) => v.toFixed(0)).join(',') + ']').padStart(13)
  ].join('\t'))
}
