'use strict'
/* 一次性工具：把图按块打印成字符图，用来定位天体、判断亮度分布。
   作用：裁切参数我总是估偏（一张 800x600 的预览要按 1.33 换算回原图），
   与其反复猜坐标，不如先把图变成字符图看一眼整体布局。 */
const path = require('path')
const { decodeImage } = require('./planet-resize.js')
const img = decodeImage(path.resolve(process.argv[2]))
const B = Number(process.argv[3] || 40)
const bw = Math.ceil(img.w / B), bh = Math.ceil(img.h / B)
const lum = new Float64Array(img.w * img.h)
let mx = 0
for (let y = 0; y < img.h; y++) {
  for (let x = 0; x < img.w; x++) {
    const o = (y * img.w + x) * img.ch
    const l = 0.2126 * img.data[o] + 0.7152 * img.data[o + 1] + 0.0722 * img.data[o + 2]
    lum[y * img.w + x] = l
    if (l > mx) mx = l
  }
}
console.log(path.basename(process.argv[2]) + '  ' + img.w + 'x' + img.h +
  '  峰值 ' + mx.toFixed(0) + '  块 ' + B + 'px')
const legend = [' ', '.', ':', '+', '*', '#', '@']
console.log('       ' + Array.from({ length: bw }, (_, i) => (i % 10 === 0 ? String((i * B / 100) | 0).slice(-1) : ' ')).join(''))
for (let by = 0; by < bh; by++) {
  let row = ''
  for (let bx = 0; bx < bw; bx++) {
    let s = 0, n = 0
    for (let y = by * B; y < Math.min(img.h, (by + 1) * B); y += 2) {
      for (let x = bx * B; x < Math.min(img.w, (bx + 1) * B); x += 2) { s += lum[y * img.w + x]; n++ }
    }
    const t = (s / Math.max(1, n)) / Math.max(1, mx)
    row += legend[Math.min(legend.length - 1, Math.floor(t * legend.length))]
  }
  console.log('y=' + String(by * B).padStart(4) + ' ' + row)
}
