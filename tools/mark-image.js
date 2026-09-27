'use strict'
/* ============================================================
   在截图上标记坐标 (tools/mark-image.js)
   ------------------------------------------------------------
   用来结束"我说的坐标到底对不对"这类拉扯：把一串坐标画成十字标记
   直接叠在截图上，看一眼就知道是坐标错了还是渲染错了。

   本项目里页面自报的画布坐标系与 chrome --screenshot 的图像坐标系
   不一致（见 report-bodies.js 顶部注释），靠嘴算容易来回错好几轮。

   用法:
     node tools/mark-image.js <src.png> <dst.png> --pts="name:x,y:r;name2:x,y:r" [--z=2]
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage, encodePng } = require('./planet-resize.js')

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? h.slice(n.length + 3) : d
}
const [src, dst] = positional
const img = decodeImage(path.resolve(src))
const z = Math.max(1, Math.round(Number(arg('z', 2))))
const pts = arg('pts', '').split(';').filter(Boolean).map((s) => {
  const m = /^([^:]+):(-?[\d.]+),(-?[\d.]+)(?::(-?[\d.]+))?$/.exec(s.trim())
  return m ? { name: m[1], x: +m[2], y: +m[3], r: m[4] ? +m[4] : 30 } : null
}).filter(Boolean)

const out = Buffer.from(img.data)
const ch = img.ch
const put = (x, y, cr, cg, cb) => {
  x = Math.round(x); y = Math.round(y)
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return
  const o = (y * img.w + x) * ch
  out[o] = cr; out[o + 1] = cg; out[o + 2] = cb
}
for (const p of pts) {
  const R = Math.max(6, p.r)
  for (let a = 0; a < 720; a++) {
    const t = a / 720 * Math.PI * 2
    put(p.x + Math.cos(t) * R, p.y + Math.sin(t) * R, 255, 40, 40)
    // 十字
  }
  for (let d = -R - 6; d <= R + 6; d++) {
    put(p.x + d, p.y, 255, 40, 40)
    put(p.x, p.y + d, 255, 40, 40)
  }
}
/* 放大输出便于看清 */
const W = img.w * z, H = img.h * z
const big = Buffer.alloc(W * H * 3)
for (let y = 0; y < H; y++) {
  const sy = Math.floor(y / z)
  for (let x = 0; x < W; x++) {
    const sx = Math.floor(x / z)
    const sp = (sy * img.w + sx) * ch
    const dp = (y * W + x) * 3
    big[dp] = out[sp]; big[dp + 1] = out[sp + 1]; big[dp + 2] = out[sp + 2]
  }
}
fs.writeFileSync(path.resolve(dst), encodePng(W, H, 3, big))
console.log('标记 ' + pts.length + ' 个点 ×' + z + ' → ' + dst)
for (const p of pts) console.log('  ' + p.name + ' @' + p.x + ',' + p.y + ' r=' + p.r)
