'use strict'
/* 像素差异对比：用于判断"某个后处理开关到底有没有生效"。
   黑屏/无效果这类问题看这一个数就够：平均 |Δ| 接近 0 说明开关没起作用。 */
const path = require('path')
const { decodeImage } = require('./planet-resize.js')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const A = decodeImage(path.resolve(positional[0]))
const B = decodeImage(path.resolve(positional[1]))
if (A.w !== B.w || A.h !== B.h) {
  console.log('尺寸不同（' + A.w + 'x' + A.h + ' vs ' + B.w + 'x' + B.h + '）——只比公共区域')
}
const w = Math.min(A.w, B.w), h = Math.min(A.h, B.h)
let sum = 0, mx = 0, n = 0, over = 0
for (let y = 0; y < h; y++) {
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(A.data[(y * A.w + x) * A.ch + c] - B.data[(y * B.w + x) * B.ch + c])
      sum += d; n++
      if (d > mx) mx = d
      if (d > 8) over++
    }
  }
}
console.log('A=' + path.basename(positional[0]) + '  B=' + path.basename(positional[1]))
console.log('平均 |Δ| = ' + (sum / n).toFixed(4) + '   最大 Δ = ' + mx +
  '   差异 >8 的分量占比 ' + (over / n * 100).toFixed(3) + '%')
if (sum / n < 0.5) console.log('=> 两者几乎一样：这个开关没有产生可见效果')
else console.log('=> 两者有可见差异：开关生效')
