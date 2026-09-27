'use strict'
/* ============================================================
   验证取景 (tools/shoot-verify.js)
   ------------------------------------------------------------
   一次跑完"截图 + 校验"，用于画质回归。

   为什么单独一个脚本：验证需要**固定的取景与固定的时刻**，而且对时序敏感
   （无头 Chrome 下页面还在渲染时截图会得到黑屏）。这里把已经验证可用的
   参数固化下来，并对黑屏自动重试 —— 让"跑一次回归"是一条命令，
   而不是每次手工拼 chrome 参数还要看运气。

   取景约定（改这里等于改基准，务必同步更新注释）：
     --w/--h      视口；默认 900x600（无头模式下窗口高度会被钳制，
                  所以不要指望"请求 1128 就真给 1128"）
     --q          额外 URL 参数，默认 "solo=1"（只留场景，无页面干扰）
     --t          定影时刻（模拟秒），默认 120
   输出：.perf/shots/verify.png 与同名 .json（球面几何）

   用法:
     node tools/shoot-verify.js                 # 截图
     node tools/shoot-verify.js --check         # 截图 + 跑 tools/verify-globe-render.js
   ============================================================ */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = path.join(ROOT, '.perf', 'shots', 'verify.png')

function arg (name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : def
}

const W = arg('w', '1600')
const H = arg('h', '900')
const DPR = arg('dpr', '1')
const T = arg('t', '120')
const Q = arg('q', '')
const BUDGET = arg('budget', '25000')
const DO_CHECK = process.argv.includes('--check')

/* ============================================================
   [已知限制：无头模式下"页面坐标"与"截图像素"不是同一个坐标系]
   ------------------------------------------------------------
   实测（tools/_calib-viewport.js 可以随时复现）：
     --window-size=1600,900  →  页面自报 viewport = canvas = 1584x749
                                而截图是 1600x900
     ⇒ 截图/画布 比例 x=1.0101  y=1.2016（y 方向差 20%）
   也就是说页面按 900 高度计算球面位置，而图里只有 749 像素高 ——
   两者差了一个恒定的 ~1.2 倍（疑似无头模式把窗口高度按浏览器 chrome
   折算后的差异）。因此"按页面自报坐标去截图里裁剪"这一步必然错位：
   裁出来的框大半是黑天空，亮度指标会显示 0.03 左右，
   看起来像"渲染全黑"，实际上球画得好好的。

   试过的两条"修正"都不可用：
     · ?pin=WxH 把页面布局视口钉死 → 比例变成完美的 1.000，
       但**画面全黑**（亮像素只占 1.14%，全在导航栏与卡片上）；
     · ?solo=1 隐藏页面其它内容 → 同样全黑（7 KB PNG）。

   结论：本脚本仍然可靠地给出**能看的截图**（这是它存在的主要价值，
   画面正确性可以人眼判断），但"按坐标精确裁剪做像素级校验"这一步
   在没有修好坐标基准之前不可信。球面校验的可用证据见
   tools/verify-globe-render.js 的输出，以及它明确打印的缩放比例 ——
   比例不是 1.000 时，就该知道那一轮数字不能当结论。
   ============================================================ */

const url = 'http://127.0.0.1:8099/index.html?' +
  (Q ? Q + '&' : '') + 'freeze=' + T

function shootOnce (tag) {
  const profile = path.join(os.tmpdir(), 'dsh-verify-' + tag + '-' + Date.now())
  const png = OUT
  const tmp = path.join(os.tmpdir(), 'dsh-verify-' + tag + '.png')
  fs.rmSync(tmp, { force: true })
  const r = spawnSync(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling',
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
  if (m && fs.existsSync(tmp)) {
    fs.copyFileSync(tmp, png)
    fs.writeFileSync(OUT.replace(/\.png$/, '.json'), m[1].replace(/&quot;/g, '"'))
  }
  fs.rmSync(tmp, { force: true })
  return fs.existsSync(png) ? fs.statSync(png).size : 0
}

function main () {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome: ' + CHROME); process.exit(1) }
  console.log('URL   ' + url)
  console.log('视口  ' + W + 'x' + H + '  dpr=' + DPR)
  let size = 0
  /* 黑屏重试：无头 Chrome 在页面刚开始渲染时截图会得到几乎全黑的图
     （PNG 极小，< 40 KB）。这不是渲染错误，是时序 —— 重跑一次通常就好。
     重试而不引入更复杂的同步，是因为这条通道本身就是"外挂式"的。 */
  for (let attempt = 1; attempt <= 3; attempt++) {
    size = shootOnce('a' + attempt)
    const kb = size / 1024
    console.log('  第 ' + attempt + ' 次：' + kb.toFixed(0) + ' KB')
    if (kb >= 40) break
    if (attempt < 3) console.log('   太小（疑似黑屏），重试…')
  }
  const kb = size / 1024
  console.log('写入  ' + path.relative(ROOT, OUT) + '  (' + kb.toFixed(0) + ' KB)')
  if (kb < 40) {
    console.error('三次都拿到黑屏 —— 说明不是时序问题，检查渲染路径：')
    console.error('  加 --q="solo=1&dbg=1" 用 --verbose 看逐帧状态')
    process.exit(2)
  }
  if (DO_CHECK) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'verify-globe-render.js'), OUT],
      { stdio: 'inherit' })
    process.exit(r.status || 0)
  }
}

main()
