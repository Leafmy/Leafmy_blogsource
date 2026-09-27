'use strict'
/* ============================================================
   远景天体报告 (tools/report-bodies.js)
   ------------------------------------------------------------
   打印每颗远景行星/伽利略卫星在画布上的**实际圆盘像素、屏幕坐标、
   表面亮度与相位角**，用来判断"哪颗看着突兀"到底出在哪个量上。

   为什么需要：裁切坐标我估错过好几次（拿到的总是黑天空），而
   "太亮/太小/位置不对"这类判断如果只在图上量，会同时混进
   "我裁错了"这个误差。数值直接从页面拿就没有这个问题。

   运行前先起服务器：node tools/serve-public.js
   用法: node tools/report-bodies.js [--w=1600 --h=900]
   ============================================================ */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function arg (n, d) {
  const h = process.argv.find((a) => a.startsWith('--' + n + '='))
  return h ? h.slice(n.length + 3) : d
}
const W = Number(arg('w', '1600'))
const H = Number(arg('h', '900'))
const PORT = arg('port', '8099')
/* --elev=2 直接透传给页面（见 space-globe.js 的 ?elev=）：用来试验
   "卫星能否凌木"这类取决于相机仰角的几何问题。
   --t=37320 把模拟时钟定在给定秒数（凌木时刻是从轨道相位反解出来的）。 */
const ELEV = arg('elev', null)
const TSIM = arg('t', '120')
/* --q=fake=1 之类的附加查询串（与 shoot-scene.js 同名同义）。
   注意 `&` 过不了 pwsh→cmd 两层引号，所以这里只接受**一段**不含 `&` 的串。 */
const Q = arg('q', null)

class CDP {
  constructor (ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null; this.listeners = []
    ws.addEventListener('message', (ev) => {
      let m
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()) } catch (e) { return }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result)
        return
      }
      for (const fn of this.listeners) fn(m)
    })
  }
  on (fn) { this.listeners.push(fn) }
  send (method, params, t) {
    const id = ++this.id
    const p = { id, method, params: params || {} }
    if (this.sessionId) p.sessionId = this.sessionId
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej })
      this.ws.send(JSON.stringify(p))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)) } }, t || 120000)
    })
  }
}

async function main () {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome: ' + CHROME); process.exit(1) }
  const profile = path.join(os.tmpdir(), 'dsh-rep-' + Date.now())
  const dbgPort = 9700 + Math.floor(Math.random() * 200)
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + dbgPort,
    '--force-device-scale-factor=1', '--window-size=' + W + ',' + H, 'about:blank'
  ], { stdio: 'ignore' })
  let ws, code = 0
  try {
    let ver = null
    for (let i = 0; i < 100 && !ver; i++) {
      try { ver = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/version')).json() } catch (e) { await sleep(200) }
    }
    ws = new WebSocket(ver.webSocketDebuggerUrl)
    await new Promise((r, j) => {
      ws.addEventListener('open', r, { once: true })
      ws.addEventListener('error', () => j(new Error('WS 失败')), { once: true })
    })
    const cdp = new CDP(ws)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    cdp.sessionId = sessionId
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    let fire = null
    const loaded = new Promise((r) => { fire = r; cdp.on((m) => { if (m.method === 'Page.loadEventFired') fire() }) })
    const q = ['freeze=' + TSIM]
    if (ELEV != null) q.push('elev=' + ELEV)
    if (Q) q.push(Q)
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html?' + q.join('&') })
    await Promise.race([loaded, sleep(30000)])
    const ev = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }
    let ready = false
    for (let i = 0; i < 100; i++) {
      ready = await ev('!!(window.__spaceGlobe && window.__spaceGlobe.frameReady)')
      if (ready) break
      await sleep(300)
    }
    if (!ready) { console.error('场景未就绪'); process.exit(1) }
    /* [坐标基准 —— 曾经错了很久] 之前直接把 bodyReport() 的**画布坐标**当截图像素
       用，裁出来的总是黑天空。实测根因：画布后备存储是 clientWidth × dpr
       （1600×900 的窗口下 canvas 是 1584×749 ⇒ dpr ≈ 1.2，而不是 --force-device-scale-factor=1
       写的那样），于是画布坐标 → 截图像素在 y 上差了 1.2 倍。
       修法不用估比例：拿 getBoundingClientRect()（CSS 像素）与实际显示尺寸算出
       严格缩放，再把页面里的 CSS 变量（--globe-*）重算一遍木星圆面 —— 所有数字
       都从浏览器里读，不靠算。 */
    const view = await ev(`JSON.stringify((function(){
      var c = document.querySelector('.space-scene-canvas')
      var r = c.getBoundingClientRect()
      /* 探针必须挂在 .space-bg 里：--globe / --globe-cx 是在 .space-bg 上声明的，
         挂在 body 上继承不到，getBoundingClientRect 会返回 0（踩过）。 */
      var host = document.querySelector('.space-bg')
      var probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;visibility:hidden'
      probe.style.width = 'var(--globe)'
      probe.style.height = 'var(--globe)'
      host.appendChild(probe)
      var g = probe.getBoundingClientRect()
      probe.style.width = 'var(--globe-cx)'; probe.style.height = 'var(--globe-cy)'
      var gc = probe.getBoundingClientRect()
      probe.remove()
      return {
        vp: [window.innerWidth, window.innerHeight],
        dpr: window.devicePixelRatio,
        cw: c.width, ch: c.height,
        clientW: c.clientWidth, clientH: c.clientHeight,
        scaleX: c.width / r.width, scaleY: c.height / r.height,
        globe: { d: g.width, cx: gc.width, cy: gc.height }
      }
    })())`)
    const v = JSON.parse(view)
    const toShot = (cx, cy) => [Math.round(cx / v.scaleX), Math.round(cy / v.scaleY)]
    /* 画布坐标 → 截图像素。两轴缩放实测相等（同一个 dpr），所以只打印一个。 */
    console.log('视口 ' + v.vp.join('x') + '   画布 ' + v.cw + 'x' + v.ch +
      '   clientSize ' + v.clientW + 'x' + v.clientH + '   dpr ' + v.dpr)
    console.log('画布→截图缩放 ' + v.scaleX.toFixed(3) + '（两轴一致才对：' +
      (Math.abs(v.scaleX - v.scaleY) < 0.01 ? '是' : '否，见 scaleY=' + v.scaleY.toFixed(3)) + '）')
    /* 木星几何由 CSS 决定，这里从浏览器读回来，作为"天体不该进哪里"的判据。 */
    const globeCenter = [v.globe.cx, v.globe.cy]
    const globeR = v.globe.d / 2
    console.log('木星圆面 直径 ' + Math.round(v.globe.d) + 'px  圆心 (' +
      Math.round(globeCenter[0]) + ',' + Math.round(globeCenter[1]) + ')  左缘 x=' +
      Math.round(globeCenter[0] - globeR) + '\n')

    const rows = await ev('JSON.stringify(window.__spaceGlobe.bodyReport())')
    const list = JSON.parse(rows)
    console.log(['天体', '类型', '画布坐标', '截图坐标', '绘制直径', '目标直径', '表面亮度', '反照率', '真实角径″', '相位°'].join('\t'))
    for (const b of list) {
      const shot = b.canvas ? toShot(b.canvas[0], b.canvas[1]) : null
      console.log([
        String(b.name).padEnd(9),
        String(b.kind).padEnd(9),
        b.canvas ? (b.canvas[0] + ',' + b.canvas[1]) : '—',
        shot ? (shot[0] + ',' + shot[1]) : '—',
        String(b.drawnPx == null ? '—' : b.drawnPx).padStart(7),
        String(b.targetPx == null ? '—' : b.targetPx).padStart(7),
        String(b.surfBright == null ? '—' : b.surfBright).padStart(8),
        String(b.albedo == null ? '—' : b.albedo).padStart(6),
        String(b.realArcsec == null ? '—' : b.realArcsec).padStart(9),
        String(b.phaseDeg == null ? '—' : b.phaseDeg).padStart(6)
      ].join('\t'))
    }
    /* 卫星/合成卫星：是否落在木星盘面前方 —— 这是"看着像贴纸"还是
       "真的在前面"的判据（diskR < 1 表示视觉上落在盘内）。 */
    const moons = list.filter((b) => b.kind === 'moon' || b.kind === 'fake-moon')
    if (moons.length) {
      console.log('\n卫星与盘面的关系（diskR = 到盘心距离 / 盘半径，<1 即在盘面内）：')
      for (const m of moons) {
        console.log('  ' + String(m.name).padEnd(9) + 'diskR=' + String(m.diskR).padStart(6) +
          '  z=' + String(m.zRj).padStart(6) + ' R_J   离木星心 ' + String(m.distRj).padStart(6) + ' R_J   ' +
          (m.kind === 'fake-moon' ? '[合成] ' : '') +
          (m.diskR < 1 && m.zRj > 0 ? '✅ 在盘面前方' : (m.zRj > 0 ? '在盘外（近侧）' : '在远侧')))
      }
    }
    /* 亮度一致性检查：远景天体的表面亮度应当随真实辐照度衰减，
       而且**相邻两颗之间的比值不应过于接近 1** —— 全都一样亮是"贴纸感"
       最直接的来源。这里把比值打出来。 */
    const pl = list.filter((b) => b.kind === 'planet').sort((a, b) => b.surfBright - a.surfBright)
    console.log('\n按表面亮度排序（最亮 → 最暗）：')
    for (let i = 0; i < pl.length; i++) {
      const r = i > 0 ? (pl[i - 1].surfBright / pl[i].surfBright) : 1
      console.log('  ' + pl[i].name.padEnd(9) + String(pl[i].surfBright).padStart(8) +
        (i > 0 ? '   是上一颗的 ' + r.toFixed(2) + ' 倍' : ''))
    }
    /* 按绘制直径排序：相对大小次序必须与真实角直径次序一致（这是 SIZE_EXP
       幂次压缩唯一的承诺，排布怎么改都不能破坏它）。 */
    console.log('\n按绘制直径排序（大 → 小）：')
    const byPx = list.filter((b) => b.drawnPx != null).sort((a, b) => b.drawnPx - a.drawnPx)
    console.log('  ' + byPx.map((b) => b.name + ' ' + b.drawnPx).join('  |  '))

    /* ---- 排布断言：重叠 / 出界 / 越界 ----
       这些是"排布改完到底成不成立"的硬判据，只要有一条红就说明构图里有
       两颗糊在一起、或有天体跑到画布外/压到木星上。 */
    let fails = 0
    const bad = (msg) => { fails++; console.log('  ✗ ' + msg) }
    console.log('\n排布断言：')
    const planets = list.filter((b) => b.kind === 'planet' && b.canvas && b.drawnPx != null)
    for (let i = 0; i < planets.length; i++) {
      for (let j = i + 1; j < planets.length; j++) {
        const A = planets[i], B = planets[j]
        const dx = A.canvas[0] - B.canvas[0], dy = A.canvas[1] - B.canvas[1]
        const d = Math.sqrt(dx * dx + dy * dy)
        /* 土星环把可见外沿撑到 2.32 倍半径，必须算进去 */
        const ra = A.name === 'saturn' ? A.drawnPx : A.drawnPx / 2
        const rb = B.name === 'saturn' ? B.drawnPx : B.drawnPx / 2
        const need = Math.max(ra, rb) * 1.35 + 6
        if (d < need) bad(A.name + ' 与 ' + B.name + ' 中心距 ' + d.toFixed(1) + 'px < 需要 ' + need.toFixed(1) + 'px')
      }
    }
    for (const b of list) {
      if (!b.canvas) {
        /* 卫星：位置由真实轨道决定，画面里出不出得来是【时刻】的问题，
           不是排布问题 —— 所以只报告，不算失败。（实测这个取景下 4 颗
           伽利略卫星几乎总是落在画布外：1 R_J ≈ 638px，木卫一 5.9 R_J ⇒
           半长轴 ≈ 3764px，只有正好接近轨道椭圆两端时才进画面。） */
        if (b.kind === 'moon') { console.log('  ℹ ' + b.name + ' 当前时刻不投影在画布上（真实轨道，非排布问题）'); continue }
        bad(b.name + ' 没有画布坐标（投影失败）'); continue
      }
      const s = toShot(b.canvas[0], b.canvas[1])
      if (b.kind === 'moon') {
        const vis = s[0] >= 0 && s[1] >= 0 && s[0] <= W && s[1] <= H
        console.log('  ℹ ' + b.name + ' 真实轨道位置 ' + s.join(',') + (vis ? '（在视口内）' : '（在视口外）'))
        continue
      }
      /* 合成卫星是刻意放在盘面上的，所以不参与"压到球面"那条断言
         （它的位置由 ?fake= 参数决定，不是排布问题）。 */
      if (b.kind === 'fake-moon') continue
      if (s[0] < 4 || s[1] < 4 || s[0] > W - 4 || s[1] > H - 4) bad(b.name + ' 出界：截图坐标 ' + s.join(','))
      /* 木星可见圆面：天体应当留在它左侧（否则会被球体挡住/糊在球缘上）。
         half 已经是"从中心到最外沿"的半径（土星 = 环展宽），所以判据是
         dist < 球半径 + 天体半径 —— 也就是"两者圆面开始重叠"。 */
      const half = (b.name === 'saturn' ? b.drawnPx : b.drawnPx / 2)
      const dx = b.canvas[0] - globeCenter[0], dy = b.canvas[1] - globeCenter[1]
      const dist = Math.sqrt(dx * dx + dy * dy)
      if (dist < globeR + half) {
        bad(b.name + ' 压到木星盘面：到球心 ' + dist.toFixed(1) + 'px，球半径 ' + globeR.toFixed(1) + 'px')
      }
    }
    console.log(fails === 0 ? '  ✓ 全部通过（无重叠 / 无出界 / 无压球）' : '  ' + fails + ' 条失败')
    if (fails > 0) code = 1
  } catch (e) {
    console.error('失败: ' + (e && e.message ? e.message : e))
    code = 1
  } finally {
    try { if (ws) ws.close() } catch (e) {}
    child.kill()
    await sleep(200)
    fs.rmSync(profile, { recursive: true, force: true })
  }
  process.exit(code)
}
main()
