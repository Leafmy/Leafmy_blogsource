'use strict'
/* 贴图细粒度剖面：在指定 u 附近逐列打印亮度，定位接缝的具体列与幅度。
   用法: node tools/map-fine-profile.js <map.jpg> <uCenter> [rowPercent]
   例:  node tools/map-fine-profile.js source/img/jupiter-map.jpg 0.5 50 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { decodePng } = require('./png-to-jpeg.js')

const SRC = process.argv[2]
const uC = Number(process.argv[3] || 0.5)
const rowPct = Number(process.argv[4] || 50)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const TMP = path.join(__dirname, '..', '.perf', 'map-fine')
const W = 2048
const H = 1024

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const url = 'file:///' + path.resolve(SRC).replace(/\\/g, '/').replace(/ /g, '%20')
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#000;overflow:hidden}
  img{display:block;width:${W}px;height:${H}px}
</style></head><body><img src="${url}"></body></html>`
fs.writeFileSync(path.join(TMP, 'm.html'), html)
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--user-data-dir=' + path.join(TMP, 'p'), '--window-size=' + W + ',' + H,
  '--virtual-time-budget=3000', '--screenshot=' + path.join(TMP, 'm.png'),
  'file:///' + path.resolve(TMP, 'm.html').replace(/\\/g, '/')
], { stdio: 'ignore', timeout: 120000 })

const img = decodePng(fs.readFileSync(path.join(TMP, 'm.png')))
const lum = (x, y) => {
  const i = (y * img.w + x) * img.ch
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
}
const xc = Math.round(img.w * uC)
const y = Math.round(img.h * rowPct / 100)
console.log(`贴图 ${img.w}x${img.h}   纬度行 y=${y}   目标 u=${uC} → x=${xc}`)

console.log('\n逐列亮度（目标列前后各 120px）:')
for (let x = xc - 120; x <= xc + 120; x += 6) {
  console.log('  x=' + String(x).padStart(4) + ' (u=' + (x / img.w).toFixed(4) + ')  ' + lum(x, y).toFixed(1))
}

let mx = 0; let mxp = 0
for (let x = xc - 200; x < xc + 200; x++) {
  const d = Math.abs(lum(x + 1, y) - lum(x, y))
  if (d > mx) { mx = d; mxp = x }
}
console.log(`\n该区间最大相邻列跳变: ${mx.toFixed(1)} @ x=${mxp} (u=${(mxp / img.w).toFixed(4)})`)
