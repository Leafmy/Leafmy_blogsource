'use strict'
/* 裁切工具（临时）：从比对图里裁出指定区域，便于逐行看清。 */
const fs = require('fs')
const path = require('path')
const { decodeImage, encodePng } = require('./planet-resize.js')

const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const arg = (n, d) => { const h = process.argv.find((a) => a.startsWith('--' + n + '=')); return h ? Number(h.split('=')[1]) : d }
const [src, dst] = positional
const x0 = arg('x', 0), y0 = arg('y', 0)
const img = decodeImage(path.resolve(src))
const w = arg('w', img.w - x0), h = arg('h', img.h - y0)
const out = Buffer.alloc(w * h * 3)
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    const sp = ((y0 + y) * img.w + (x0 + x)) * img.ch
    const dp = (y * w + x) * 3
    out[dp] = img.data[sp]; out[dp + 1] = img.data[sp + 1]; out[dp + 2] = img.data[sp + 2]
  }
}
fs.writeFileSync(path.resolve(dst), encodePng(w, h, 3, out))
console.log('裁切 ' + w + 'x' + h + ' → ' + dst)
