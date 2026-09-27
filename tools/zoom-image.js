'use strict'
/* ============================================================
   区域放大 (tools/zoom-image.js)
   ------------------------------------------------------------
   从整页截图里裁一块并做**整数倍最近邻放大**，用来逐像素看小目标
   （12~17px 的远景行星、土星环的环缝、卫星圆面）。

   为什么要单独一个工具：预览图会把 1600x900 缩到 1066x600 显示，
   12px 的行星在预览里只剩 8px，根本看不出"是不是糊成一团"；
   而把原图直接放大又看不清周围环境。裁切 + 整数倍放大才是
   "既看得清、又知道它在画面哪儿"的唯一组合。

   用法:
     node tools/zoom-image.js <src.png> <dst.png> --x= --y= --w= --h= [--z=4]
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage, encodePng } = require('./planet-resize.js')

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (n, d) => {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? Number(h.split('=')[1]) : d
}
const [src, dst] = positional
if (!src || !dst) {
  console.error('用法: node tools/zoom-image.js <src.png> <dst.png> --x= --y= --w= --h= [--z=4]')
  process.exit(1)
}

const img = decodeImage(path.resolve(src))
const x0 = Math.max(0, Math.min(img.w - 1, arg('x', 0)))
const y0 = Math.max(0, Math.min(img.h - 1, arg('y', 0)))
const w = Math.max(1, Math.min(img.w - x0, arg('w', 200)))
const h = Math.max(1, Math.min(img.h - y0, arg('h', 120)))
const z = Math.max(1, Math.round(arg('z', 4)))

const out = Buffer.alloc(w * z * h * z * 3)
for (let y = 0; y < h * z; y++) {
  const sy = y0 + Math.floor(y / z)
  for (let x = 0; x < w * z; x++) {
    const sx = x0 + Math.floor(x / z)
    const sp = (sy * img.w + sx) * img.ch
    const dp = (y * w * z + x) * 3
    out[dp] = img.data[sp]
    out[dp + 1] = img.data[sp + 1]
    out[dp + 2] = img.data[sp + 2]
  }
}
fs.writeFileSync(path.resolve(dst), encodePng(w * z, h * z, 3, out))
console.log('放大 ' + w + 'x' + h + ' @' + x0 + ',' + y0 + ' ×' + z + ' → ' + dst + ' (' + w * z + 'x' + h * z + ')')
