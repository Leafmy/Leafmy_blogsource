'use strict'
/* ============================================================
   图片预览 (tools/preview-image.js)
   ------------------------------------------------------------
   把一张（可能是超长的）等距圆柱投影贴图渲染成 PNG，用于肉眼检查。
   为什么需要：tools/shoot-scene.js 的 CDP 通道已经很重，看一张贴图
   不值得起整个站点；而仓库既有的"无头 Chrome 截图"通道本来就能直接
   光栅化 HTML —— 这里就用它。

   用法: node tools/preview-image.js <图片> <输出png> [宽] [高]
        默认按 2:1 自动取尺寸
   ============================================================ */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const ROOT = path.join(__dirname, '..')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const SRC = path.resolve(positional[0])
const DST = path.resolve(positional[1] || path.join(ROOT, '.perf', 'shots', 'preview.png'))
const W = Number(positional[2] || 1440)
const H = Number(positional[3] || Math.round(W / 2))

if (!fs.existsSync(SRC)) { console.error('找不到 ' + SRC); process.exit(1) }

const fileUrl = (p) => 'file:///' + p.replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#111;overflow:hidden}
  img{display:block;width:${W}px;height:${H}px;image-rendering:auto}
</style></head><body><img src="${fileUrl(SRC)}"></body></html>`

const tmpDir = path.join(ROOT, '.perf', 'preview')
fs.mkdirSync(tmpDir, { recursive: true })
const htmlPath = path.join(tmpDir, 'v.html')
fs.writeFileSync(htmlPath, html)
fs.mkdirSync(path.dirname(DST), { recursive: true })
fs.rmSync(DST, { force: true })

execFileSync(CHROME, [
  '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
  '--disable-extensions', '--disable-gpu',
  '--user-data-dir=' + path.join(tmpDir, 'prof'),
  '--force-device-scale-factor=1',
  '--window-size=' + W + ',' + H,
  '--virtual-time-budget=8000',
  '--screenshot=' + DST,
  fileUrl(htmlPath)
], { stdio: 'ignore', timeout: 120000 })

if (!fs.existsSync(DST)) { console.error('截图失败'); process.exit(1) }
console.log('写入 ' + path.relative(ROOT, DST) + '  ' + W + 'x' + H + '  (' +
  (fs.statSync(DST).size / 1024).toFixed(0) + ' KB)')
