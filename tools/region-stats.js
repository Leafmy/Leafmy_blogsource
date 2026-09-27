'use strict'
/* ============================================================
   区域亮度 / 对照 (tools/region-stats.js)
   ------------------------------------------------------------
   "这块看起来太暗/挡住了" 这类判断必须能量出来才有资格下结论。
   本工具把一个长方区域切成网格，输出每格的**平均亮度**与**亮像素占比**；
   给两张图时同时输出差值网格（B − A）。

   为什么需要它：首页构图里星野上方叠着 #page-header 的方向性压暗渐变
   （theme-glass.css），左右/上下不同位置的压暗量差 3 倍以上 ——
   "天体放在哪块天区"直接决定它最后还剩多少亮度。靠眼睛在整图上估计
   会被木星的高亮带骗，量格子才看得出真实梯度。

   亮度定义：0.2126R + 0.7152G + 0.0722B（BT.709），与渲染器的 luma 一致。

   用法:
     node tools/region-stats.js <img> --x= --y= --w= --h= [--gx=8] [--gy=4]
     node tools/region-stats.js <a> <b> --x= --y= --w= --h= [--gx=] [--gy=]
   ============================================================ */

const path = require('path')
const { decodeImage } = require('./planet-resize.js')

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? Number(h.split('=')[1]) : d
}
if (!positional.length) {
  console.error('用法: node tools/region-stats.js <img> [imgB] --x= --y= --w= --h= [--gx=8] [--gy=4]')
  process.exit(1)
}

const imgs = positional.map((p) => decodeImage(path.resolve(p)))
const A = imgs[0]
const x0 = arg('x', 0)
const y0 = arg('y', 0)
const w = Math.min(arg('w', A.w - x0), A.w - x0)
const h = Math.min(arg('h', A.h - y0), A.h - y0)
const gx = Math.max(1, arg('gx', 8))
const gy = Math.max(1, arg('gy', 4))

function grid (img) {
  const cells = []
  for (let cy = 0; cy < gy; cy++) {
    const row = []
    for (let cx = 0; cx < gx; cx++) {
      const px0 = Math.round(x0 + (cx * w) / gx)
      const px1 = Math.round(x0 + ((cx + 1) * w) / gx)
      const py0 = Math.round(y0 + (cy * h) / gy)
      const py1 = Math.round(y0 + ((cy + 1) * h) / gy)
      let sum = 0, n = 0, lit = 0, mx = 0
      for (let y = py0; y < py1 && y < img.h; y++) {
        for (let x = px0; x < px1 && x < img.w; x++) {
          if (x < 0 || y < 0) continue
          const o = (y * img.w + x) * img.ch
          const l = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
          sum += l; n++
          if (l > 30) lit++
          if (l > mx) mx = l
        }
      }
      row.push({ mean: n ? sum / n : 0, lit: n ? lit / n : 0, max: mx })
    }
    cells.push(row)
  }
  return cells
}

const ga = grid(A)
const gb = imgs[1] ? grid(imgs[1]) : null
const pad = (v, n = 7) => v.toFixed(n === 7 ? 2 : n).padStart(7)

console.log('区域 x=' + x0 + ' y=' + y0 + ' w=' + w + ' h=' + h + '  网格 ' + gx + 'x' + gy)
console.log('\n平均亮度（每格中心亮度）:')
for (let cy = 0; cy < gy; cy++) {
  console.log('  ' + ga[cy].map((c) => pad(c.mean)).join(''))
}
if (gb) {
  console.log('\nB − A（正 = B 更亮）:')
  for (let cy = 0; cy < gy; cy++) {
    console.log('  ' + ga[cy].map((c, cx) => {
      const d = gb[cy][cx].mean - c.mean
      return (d >= 0 ? '+' : '') + d.toFixed(2).padStart(6)
    }).join(''))
  }
}
console.log('\n亮像素占比 >30：')
for (let cy = 0; cy < gy; cy++) {
  console.log('  ' + ga[cy].map((c) => (c.lit * 100).toFixed(1).padStart(6) + '%').join(''))
}
const allA = ga.flat()
console.log('\n整块：均值 ' + (allA.reduce((s, c) => s + c.mean, 0) / allA.length).toFixed(2) +
  '   峰值 ' + Math.max(...allA.map((c) => c.max)).toFixed(0) +
  '   亮像素 ' + ((allA.reduce((s, c) => s + c.lit, 0) / allA.length) * 100).toFixed(1) + '%')
