'use strict'
/* ============================================================
   场景截图 (tools/shoot-scene.js)
   ------------------------------------------------------------
   把"改完看一眼"变成一条命令。

   === 为什么是"页面侧定影 + chrome 自己截图" ===
   走过两条弯路，都记在这里，免得下次再踩：

   1) chrome --headless=new --screenshot --virtual-time-budget
      对静态 HTML 很好用，但本场景依赖 XHR（stars.bin）与 14 张贴图：
      虚拟时间走够了、贴图 onload 齐了，stars.bin 的回调却可能还没到。

   2) 改用 CDP（Target.attachToTarget + Page.captureScreenshot）之后发现
      它拿到的画面**不含 WebGL 画布**（球体整块发黑，而同一时刻
      chrome 自己的 --screenshot 是正常的）。
      再试 canvas.toDataURL() / gl.readPixels(默认帧缓冲) /
      preserveDrawingBuffer —— **全部读回纯黑**（三个缓冲都读回来是 0）。
      原因是合成器取走这一帧之后绘制缓冲就被清空了，
      而 CDP 的整页截图在本机这个 headless 实现里不含 GPU 图层。

   最终可用的组合：
     · 页面自己定影（?freeze=<秒>，见 space-globe.js 的 tryFreeze）——
       由页面在最合适的时刻（贴图 + 星表都就绪）把时钟钉住；
     · 然后让 **chrome 自己** 截图（它拍的是合成结果，有画布）。
   代价：拿到的是整页截图而不是纯画布（页面 UI 也在图里）。
   对"看效果/做对照"这件事反而更好 —— 能同时看到构图与背景。

   前置：另开一个终端跑 node tools/serve-public.js

   用法:
     node tools/shoot-scene.js                        # 1600x900，定影 t=120
     node tools/shoot-scene.js --t=0                  # 换模拟时刻
     node tools/shoot-scene.js --w=390 --h=844        # 移动端
     node tools/shoot-scene.js --q="nopost=1"         # 关后处理做对照
     node tools/shoot-scene.js --q="spaceGL=off"      # 强制海报退路
     node tools/shoot-scene.js --dpr=2                # 2x 像素密度
     node tools/shoot-scene.js --out=name.png         # 指定输出名
     node tools/shoot-scene.js --path=/about/         # 其它页面

   输出到 .perf/shots/。
   ============================================================ */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.perf', 'shots')

function arg (name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : def
}
const has = (name) => process.argv.includes('--' + name)

const PORT = arg('port', '8099')
const W = Number(arg('w', 1600))
const H = Number(arg('h', 900))
const DPR = Number(arg('dpr', 1))
const PAGE = arg('path', '/index.html')
const QUERY = arg('q', '')
const T_SIM = arg('t', '120')
const OUT = arg('out', null)
const BUDGET = Number(arg('budget', 25000))
const VERBOSE = has('verbose')

if (!fs.existsSync(CHROME)) {
  console.error('找不到 Chrome: ' + CHROME + '（可用 CHROME_PATH 指定）')
  process.exit(1)
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
const tag = [PAGE.replace(/^\/|index\.html$|\/$/g, '') || 'home', W + 'x' + H, 'dpr' + DPR,
  't' + T_SIM, QUERY ? slug(QUERY) : ''].filter(Boolean).join('_')
const outName = OUT || tag + '.png'
const outPath = path.join(OUT_DIR, outName)

/* 定影参数由这里注入，用户给的 --q 里若已有 freeze 就不重复加。

   [为什么用逗号而不用 & 分隔多个查询参数]
   `&` 在 Windows 上过不了 pwsh → cmd 这两层引号：即使在 pwsh 里用单引号
   包住、或者拼成一个变量再传，实测仍然被当成命令分隔符
   （报错 "'bloom' is not recognized as an internal or external command"）。
   本项目的测量矩阵需要"同一条件下只改一个参数各截一张"，于是约定：
   逗号分隔的片段一律转成 `&`。所以写成
     --q=pin=1920x1080,bloom=0,contrast=1.22
   等价于 ?pin=1920x1080&bloom=0&contrast=1.22。 */
const splitQuery = (s) => s.split(',').map((x) => x.trim()).filter(Boolean)
const qParts = []
if (QUERY) qParts.push(...splitQuery(QUERY))
if (!/(^|&)freeze=/.test(QUERY)) qParts.push('freeze=' + T_SIM)
/* --band=ax,ay,mx,my,bx,by：直接覆盖排布路径的三个点（见 space-globe.js 的 readLayout）。
   排布是主观判断，需要把几套候选形状在同一条件下各截一张图对比。 */
const BAND = arg('band', null)
if (BAND) qParts.push('band=' + BAND)
const url = 'http://127.0.0.1:' + PORT + (PAGE.startsWith('/') ? PAGE : '/' + PAGE) +
  (qParts.length ? '?' + qParts.join('&') : '')
if (VERBOSE) console.log('QUERY ' + url)

fs.mkdirSync(OUT_DIR, { recursive: true })
const profile = path.join(os.tmpdir(), 'dsh-shoot-' + Date.now())
fs.rmSync(outPath, { force: true })

console.log('URL   ' + url)
console.log('视口  ' + W + 'x' + H + '  dpr=' + DPR)

/* 判定一张截图是否"真的画出来了"。
   不能只看文件大小：实测黑屏图也可能是 130~200 KB（页面 UI 与卡片都在，
   只是画布没内容），按大小判断会放过这些。所以直接量亮像素占比 ——
   场景在图里应当有 3~15% 的像素明显亮于背景。 */
function meaningful (pngPath) {
  try {
    const { decodeImage } = require('./planet-resize.js')
    const img = decodeImage(pngPath)
    let lit = 0, n = 0, mx = 0
    for (let y = 0; y < img.h; y += 3) {
      for (let x = 0; x < img.w; x += 3) {
        const o = (y * img.w + x) * img.ch
        const l = (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3
        if (l > 30) lit++
        if (l > mx) mx = l
        n++
      }
    }
    const frac = lit / Math.max(1, n)
    return { frac: frac, peak: mx, ok: frac > 0.06 && mx > 150 }
  } catch (e) { return { frac: 0, peak: 0, ok: false } }
}

function runOnce (attempt) {
  const profile = path.join(os.tmpdir(), 'dsh-shoot-' + attempt + '-' + Date.now())
  const tmp = path.join(os.tmpdir(), 'dsh-shot-' + attempt + '.png')
  fs.rmSync(tmp, { force: true })
  const r = spawnSync(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--user-data-dir=' + profile,
    '--force-device-scale-factor=' + DPR,
    '--window-size=' + W + ',' + H,
    '--virtual-time-budget=' + BUDGET,
    '--screenshot=' + tmp,
    '--dump-dom',
    url
  ], { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024 })
  fs.rmSync(profile, { recursive: true, force: true })
  const dom = r.stdout || ''
  const m = /GLODERECT:(\{[^<]*\})/.exec(dom)
  if (!fs.existsSync(tmp)) return { ok: false, lit: 0, geo: null }
  fs.copyFileSync(tmp, outPath)
  fs.rmSync(tmp, { force: true })
  if (m) fs.writeFileSync(outPath.replace(/\.png$/, '.json'), m[1].replace(/&quot;/g, '"'))
  return { ok: true, lit: meaningful(outPath), geo: m ? m[1].length : 0 }
}

/* 定影时序在无头模式下不稳定：同一组参数会随机拿到全黑/半黑的帧
   （实测 7 KB / 130 KB / 200 KB 都出现过，且都是"页面 UI 正常、画布空"）。
   所以同时按"亮像素占比"与"峰值亮度"判定并重试 —— 只看文件大小会放过
   那些 UI 齐全、画布空白的半黑帧（曾经有一张 194 KB / 亮像素 3.1% 的图
   混进了对照结果）。 */
let attempt = 0
let res = null
while (attempt < 5) {
  attempt++
  res = runOnce(attempt)
  console.log('  第 ' + attempt + ' 次：亮像素 ' + (res.lit.frac * 100).toFixed(1) +
    '%  峰值 ' + res.lit.peak)
  if (res.ok && res.lit.ok) break
  if (attempt < 5) console.log('   画面不完整（疑似黑帧），重试…')
}
if (!res || !res.ok) {
  console.error('截图失败。检查静态服务器：node tools/serve-public.js')
  process.exit(1)
}
if (res.geo) {
  const g = JSON.parse(fs.readFileSync(outPath.replace(/\.png$/, '.json'), 'utf8'))
  console.log('球面几何  cx=' + g.globeRect.cx.toFixed(0) + ' cy=' + g.globeRect.cy.toFixed(0) +
    ' rx=' + g.globeRect.rx.toFixed(0) + ' ry=' + g.globeRect.ry.toFixed(0) +
    '  画布 ' + g.canvas.w + 'x' + g.canvas.h)
}
const kb = fs.statSync(outPath).size / 1024
console.log('写入  ' + path.relative(ROOT, outPath) + '  (' + kb.toFixed(0) + ' KB, 亮像素 ' +
  (res.lit.frac * 100).toFixed(1) + '%, 峰值 ' + res.lit.peak + ')')
if (!res.lit.ok) {
  console.error('多次都拿到不完整的画面（不是时序问题），检查渲染路径（加 --q="dbg=1"）。')
  process.exit(2)
}
