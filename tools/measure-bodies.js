'use strict'
/* ============================================================
   天体像素测量 (tools/measure-bodies.js)
   ------------------------------------------------------------
   在**截图**上按 report-bodies.js 给出的坐标，量出每颗远景行星圆面的
   真实像素亮度（中位/最大 luma、R:G:B），并打印背景环的亮度作对照。

   为什么需要：
     "这颗是不是被压暗了" 只看整图均值会被星野和木星骗；
     "surfBright 改了 11:1" 也不等于"画面上暗了 11 倍" —— 中间还有
     页头压暗渐变（theme-glass.css 的 #page-header.full-page::before）
     和 ACES 曲线两道非线性。必须在**成品像素**上量才算数。

   圆面像素 ≤ 背景环 + 8 的判为背景（星野/渐变），不计入统计 ——
   否则 12px 的圆面会被周围的暗天空稀释。

   用法:
     node tools/measure-bodies.js --shot=.perf/shots/x.png --coords="name:x,y;name:x,y"
     node tools/measure-bodies.js --shot=... --json=.perf/shots/x.bodies.json
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage } = require('./planet-resize.js')

const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? h.slice(n.length + 3) : d
}
const luma = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]

/* 圆环统计：内圈（r ≤ 0.75R）去掉背景，外圈（1.4R ≤ r ≤ 2.0R）当背景 */
function ring (img, cx, cy, R) {
  const inner = [], outer = []
  const x0 = Math.max(0, Math.floor(cx - 2.2 * R)), x1 = Math.min(img.w - 1, Math.ceil(cx + 2.2 * R))
  const y0 = Math.max(0, Math.floor(cy - 2.2 * R)), y1 = Math.min(img.h - 1, Math.ceil(cy + 2.2 * R))
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = Math.hypot(x - cx, y - cy)
      const o = (y * img.w + x) * img.ch
      const v = luma(img.data, o)
      if (d <= 0.75 * R) inner.push({ v, r: img.data[o], g: img.data[o + 1], b: img.data[o + 2] })
      else if (d >= 1.4 * R && d <= 2.0 * R) outer.push(v)
    }
  }
  if (!inner.length) return null
  outer.sort((a, b) => a - b)
  const bgMed = outer.length ? outer[Math.floor(outer.length / 2)] : 0
  const bgMax = outer.length ? outer[outer.length - 1] : 0
  const body = inner.filter((p) => p.v > bgMax + 8)
  const vals = body.map((p) => p.v).sort((a, b) => a - b)
  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)
  return {
    n: body.length, frac: body.length / inner.length,
    med: vals.length ? vals[Math.floor(vals.length / 2)] : 0,
    max: vals.length ? vals[vals.length - 1] : 0,
    mean: mean(vals),
    rgb: body.length ? [mean(body.map((p) => p.r)), mean(body.map((p) => p.g)), mean(body.map((p) => p.b))] : [0, 0, 0],
    bgMed, bgMax
  }
}

const shot = arg('shot')
if (!shot) { console.error('用法: node tools/measure-bodies.js --shot=<png> --coords="name:x,y;..." | --json=<path>'); process.exit(1) }
const img = decodeImage(path.resolve(shot))
let coords = []
const jsonPath = arg('json')
if (jsonPath) {
  const j = JSON.parse(fs.readFileSync(path.resolve(jsonPath), 'utf8'))
  coords = j.map((b) => ({ name: b.name, x: b.canvas[0], y: b.canvas[1], r: Math.max(3, b.drawnPx / 2) }))
} else {
  coords = (arg('coords', '')).split(';').filter(Boolean).map((s) => {
    const m = /^([a-z]+):(-?\d+),(-?\d+)(?::([\d.]+))?$/.exec(s.trim())
    return m ? { name: m[1], x: +m[2], y: +m[3], r: m[4] ? +m[4] : 8 } : null
  }).filter(Boolean)
}

console.log('截图 ' + shot + '  ' + img.w + 'x' + img.h)
console.log(['天体', '圆面px', '有效像素', '中位luma', '最大luma', '均值luma', '平均RGB', '背景中位', '背景最大'].join('\t'))
for (const c of coords) {
  const r = ring(img, c.x, c.y, c.r)
  if (!r) { console.log(c.name + '  取样区在画布外'); continue }
  console.log([
    c.name.padEnd(9),
    (c.r * 2).toFixed(1).padStart(6),
    String(r.n).padStart(6),
    r.med.toFixed(1).padStart(8),
    r.max.toFixed(1).padStart(8),
    r.mean.toFixed(1).padStart(8),
    ('[' + r.rgb.map((v) => v.toFixed(0)).join(',') + ']').padStart(13),
    r.bgMed.toFixed(1).padStart(8),
    r.bgMax.toFixed(1).padStart(8)
  ].join('\t'))
}
