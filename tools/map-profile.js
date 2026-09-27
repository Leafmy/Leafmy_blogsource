'use strict'
/* ============================================================
   贴图经度剖面 (tools/map-profile.js)
   ------------------------------------------------------------
   把等距圆柱贴图在指定纬度上沿经度取样，打印亮度剖面与相邻列的
   最大跳变 —— 用来定位"贴到球上出现一道竖缝"这类问题的具体列位置。
   若跳变只出现在少数列且幅度很大，就是接缝；若整体平滑，说明竖纹来自
   光照/几何而非贴图。

   用法: node tools/map-profile.js <map.jpg> [rowsPercent...]
        例: node tools/map-profile.js source/img/jupiter-map.jpg 50 62
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const { decodePng } = require('./png-to-jpeg.js')

const SRC = process.argv[2]
const rows = (process.argv.slice(3).length ? process.argv.slice(3) : ['50']).map(Number)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const TMP = path.join(__dirname, '..', '.perf', 'map-profile')

if (!SRC || !fs.existsSync(SRC)) {
  console.error('用法: node tools/map-profile.js <map.jpg> [rowsPercent...]')
  process.exit(1)
}

function render (src, outPng, w, h) {
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#000;overflow:hidden}
    img{display:block;width:${w}px;height:${h}px}
  </style></head><body><img src="file:///${path.resolve(src).replace(/\\/g, '/').replace(/ /g, '%20')}"></body></html>`
  const hp = outPng.replace(/\.png$/, '.html')
  fs.writeFileSync(hp, html)
  const prof = path.join(TMP, 'chrome')
  fs.rmSync(prof, { recursive: true, force: true })
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions',
    '--window-size=' + w + ',' + h, '--virtual-time-budget=3000',
    '--screenshot=' + outPng,
    'file:///' + path.resolve(hp).replace(/\\/g, '/').replace(/ /g, '%20')
  ], { stdio: 'ignore', timeout: 120000 })
  fs.rmSync(prof, { recursive: true, force: true })
  fs.rmSync(hp, { force: true })
  return decodePng(fs.readFileSync(outPng))
}

const W = 2048
const H = 1024
const img = render(SRC, path.join(TMP, 'map.png'), W, H)
console.log('贴图 ' + img.w + 'x' + img.h)

const lum = (x, y) => {
  const i = (y * img.w + x) * img.ch
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
}

for (const pct of rows) {
  const y = Math.min(img.h - 1, Math.round(img.h * pct / 100))
  console.log(`\n=== 纬度行 y=${y} (${pct}% 自上而下) ===`)
  // 相邻列跳变
  const jumps = []
  let prev = lum(0, y)
  for (let x = 1; x < img.w; x++) {
    const v = lum(x, y)
    jumps.push({ x, d: v - prev })
    prev = v
  }
  jumps.sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  console.log('最大相邻列跳变（前 8）:')
  for (const j of jumps.slice(0, 8)) console.log('  x=' + j.x + '  Δ=' + j.d.toFixed(1))

  // 每 1/32 经度取一个样，看整体形状
  const ticks = []
  for (let k = 0; k <= 32; k++) {
    const x = Math.min(img.w - 1, Math.round(img.w * k / 32))
    ticks.push((k * 100 / 32).toFixed(0) + '%:' + lum(x, y).toFixed(0))
  }
  console.log('经度剖面: ' + ticks.join('  '))
}
