'use strict'
/* ============================================================
   本地静态服务器 (tools/serve-public.js)
   ------------------------------------------------------------
   为什么需要它：太空场景依赖 http:// 源才能工作 ——
     · 贴图与星表用 <img> / XMLHttpRequest 加载，file:// 下会被当成
       跨源（浏览器直接拒绝，画面退化成 .space-gl-off 的海报层）；
     · 无头 Chrome 的 --screenshot 通道需要稳定 URL 才能复现截图。
   所以"改完看一眼"的正确姿势是：
     node tools/serve-public.js            # 一个终端挂着
     node tools/shoot-scene.js             # 另一个终端截图
   （不要用 hexo server：它每次都要跑一遍整站渲染，迭代时太慢。）

   用法:
     node tools/serve-public.js [root] [port]
     root 默认 public/，port 默认 8099
   ============================================================ */

const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'))
const PORT = Number(process.argv[3] || 8099)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bin': 'application/octet-stream',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
}

if (!fs.existsSync(ROOT)) {
  console.error('根目录不存在: ' + ROOT)
  console.error('先跑一次 npx hexo generate 生成 public/。')
  process.exit(1)
}

const server = http.createServer(function (req, res) {
  let rel
  try { rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]) } catch (e) { rel = '/' }
  if (rel.endsWith('/')) rel += 'index.html'
  let file = path.join(ROOT, rel)
  // 目录穿越防护：解析后的路径必须仍在 ROOT 之内
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return }
  fs.stat(file, function (err, st) {
    if (!err && st.isDirectory()) { file = path.join(file, 'index.html'); err = null }
    fs.readFile(file, function (err2, body) {
      if (err2) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('404 ' + rel)
        return
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'   // 迭代期绝不缓存，避免"改了没变化"的假象
      })
      res.end(body)
    })
  })
})

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用 —— 可能已经有一个 serve-public.js 在跑。')
    process.exit(1)
  }
  throw e
})

server.listen(PORT, '127.0.0.1', function () {
  console.log('serving ' + ROOT)
  console.log('  http://127.0.0.1:' + PORT + '/')
  console.log('  http://127.0.0.1:' + PORT + '/?spaceGL=v1   # 旧管线')
  console.log('  http://127.0.0.1:' + PORT + '/?freeze=1&t=120   # 冻结在 t=120s')
})
