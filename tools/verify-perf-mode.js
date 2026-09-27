'use strict'
/* ============================================================
   性能模式校验 (tools/verify-perf-mode.js)
   ------------------------------------------------------------
   逐条核对 space-mode.js / space-globe.js 关于性能模式的承诺。
   为什么必须做浏览器侧验证：档位判定、导航按钮的插入位置、提示条文案、
   localStorage 落盘，全都只有在真实 DOM 与真实 GL 上下文里才成立 ——
   源码里"看起来接通了"和"真的接通了"是两件事（本项目已经有过
   "开关没接线但截图照样出图"的先例，所以那类改动都用 diff 复核）。

   用法:
     node tools/verify-perf-mode.js
   前置：node tools/serve-public.js
   退出码非 0 表示有断言失败。
   ============================================================ */

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = process.env.PORT || '8099'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0, fail = 0
const failures = []
function check (name, ok, detail) {
  if (ok) { pass++; console.log('  \u2705 ' + name + (detail ? '  ' + detail : '')) } else {
    fail++; failures.push(name); console.log('  \u274c ' + name + (detail ? '  ' + detail : ''))
  }
}

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('CDP 超时: ' + method)) } }, t || 60000)
    })
  }
}

async function session (dbgPort, profile, url, settleMs) {
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + dbgPort,
    '--force-device-scale-factor=1', '--window-size=1600,900', 'about:blank'
  ], { stdio: 'ignore' })
  let ver = null
  for (let i = 0; i < 100 && !ver; i++) {
    try { ver = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/version')).json() } catch (e) { await sleep(200) }
  }
  const ws = new WebSocket(ver.webSocketDebuggerUrl)
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
  const logs = []
  cdp.on((m) => {
    if (m.method === 'Runtime.consoleAPICalled') {
      const t = m.params.type + ': ' + m.params.args.map((a) => (a.value !== undefined ? a.value : a.description || '')).join(' ')
      /* 只收 [space 与 [space-mode 两类：整个页面的日志量很大（shiki 等），
         全收会把关键行冲掉。异常也一并收 —— 排查"模块静默退出"时它就是唯一线索。 */
      if (t.indexOf('log: [space') >= 0) logs.push(t)
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails
      logs.push('EXC: ' + ((d.exception && d.exception.description) || d.text))
    }
  })
  let fire = null
  const loaded = new Promise((r) => { fire = r; cdp.on((m) => { if (m.method === 'Page.loadEventFired') fire() }) })
  await cdp.send('Page.navigate', { url: url })
  await Promise.race([loaded, sleep(30000)])
  const ev = async (expr) => {
    const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }
  await sleep(settleMs)
  return { child, ws, cdp, profile, ev, logs }
}

async function close (s) {
  try { if (s.ws) s.ws.close() } catch (e) {}
  s.child.kill()
  await sleep(250)
  try { fs.rmSync(s.profile, { recursive: true, force: true }) } catch (e) {}
}

async function main () {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome: ' + CHROME); process.exit(1) }
  const base = 'http://127.0.0.1:' + PORT + '/index.html'

  /* ---- 1) ?perf=low：档位、画质参数、按钮、提示（URL 档位不弹提示）---- */
  console.log('=== 1. ?perf=low ===')
  {
    const s = await session(9701, path.join(os.tmpdir(), 'dsh-pm1-' + Date.now()),
      base + '?perf=low&perftest=quiet&perfsamples=4', 7000)
    try {
      const ready = await s.ev('!!(window.__spaceGlobe && window.__spaceGlobe.frameReady)')
      check('场景就绪（否则后面的读数无意义）', ready === true)
      const pm = JSON.parse(await s.ev('JSON.stringify(window.__spaceGlobe.perfMode())'))
      check('perfMode() 结构完整',
        pm && pm.mode && pm.quality && typeof pm.samples === 'number' && 'hasTimerQuery' in pm,
        JSON.stringify({ mode: pm.mode, samples: pm.samples, by: pm.detectedBy }))
      check('模式 = low', pm.mode === 'low', String(pm.mode))
      check('detectedBy = url', pm.detectedBy === 'url', String(pm.detectedBy))
      check('后处理关闭（nopost=1）', pm.quality.nopost === 1, 'nopost=' + pm.quality.nopost)
      check('bloom 关闭', pm.quality.bloom && pm.quality.bloom.on === false, JSON.stringify(pm.quality.bloom))
      check('MSAA 降到 2', pm.quality.msaa <= 2, 'msaa=' + pm.quality.msaa)
      check('各向异性降到 2', pm.quality.aniso <= 2, 'aniso=' + pm.quality.aniso)
      check('贴图用小档', String(pm.quality.jupiterMap).indexOf('lo') === 0, String(pm.quality.jupiterMap))
      /* [这两条是有来历的，别删]
         ① 曝光：低配走**直渲**路径，曝光由每个着色器自己乘（正常档由合成 pass
            统一做），所以低配必须是 1.1 而不是 3.3。曾经 setPerfMode 漏改曝光，
            切到低配后画面明显过亮（实测 quality().exposure 停在 3.3）。
         ② 各向异性 / 贴图档：这两项是**加载期**贴在纹理对象上的。曾经渲染器
            只从 URL 解析档位、不读 localStorage，而点按钮后是重载、URL 里没有
            ?perf= ⇒ 低配的 aniso 与贴图小档**从来没生效过**（实测 aniso=16、
            贴图 hi(3072)），表现为"低配了但没完全低配"。 */
      check('低配曝光 = 1.1（直渲量纲，不是 3.3）', pm.quality.exposure === 1.1,
        'exposure=' + pm.quality.exposure)
      check('低配各向异性已降到 2（加载期生效）', pm.quality.aniso === 2,
        'aniso=' + pm.quality.aniso)
      const ui = JSON.parse(await s.ev(`JSON.stringify({
        hasItem: !!document.querySelector('.space-mode-item'),
        label: (document.querySelector('.space-mode-label')||{}).textContent || '',
        afterAbout: (function(){
          var items = document.querySelectorAll('#nav .menus_items .menus_item')
          for (var i = 0; i < items.length; i++) {
            var a = items[i].querySelector('a')
            if (a && /^\\/about\\/?/.test(a.getAttribute('href')||'')) {
              return items[i+1] ? items[i+1].className : null
            }
          }
          return 'no-about'
        })(),
        toastHidden: !document.querySelector('#space-mode-toast.show')
      })`))
      check('导航里插入了模式按钮', ui.hasItem === true)
      check('按钮紧跟在"关于"之后', /space-mode-item/.test(String(ui.afterAbout)), String(ui.afterAbout))
      check('按钮文案 = 低配模式', ui.label === '低配模式', ui.label)
      /* [字号必须和邻居一致] 用户两次反馈"按钮太大"。实测邻居 14.196px、
         本项曾因继承链问题拿到 18.2px（= 14×1.3，一个 rem/em 基准差）。
         这条断言把"与邻居同字号/同行高/同图标宽"固化下来，
         免得以后主题或 CSS 顺序一变又漂回去。 */
      const fonts = JSON.parse(await s.ev(`JSON.stringify((function(){
        function m(el){ var cs=getComputedStyle(el); var i=el.querySelector('i');
          return { font: cs.fontSize, h: Math.round(el.getBoundingClientRect().height),
                   iconW: i?Math.round(i.getBoundingClientRect().width):null } }
        var items = document.querySelectorAll('#nav .menus_items .menus_item')
        var mine = document.querySelector('.space-mode-item > a')
        var about = null
        for (var k=0;k<items.length;k++){ var a=items[k].querySelector('a');
          if (a && /^\\/about\\/?/.test(a.getAttribute('href')||'')) about=a }
        return { mine: mine?m(mine):null, about: about?m(about):null }
      })())`))
      check('字号与「关于」一致', fonts.mine && fonts.about && fonts.mine.font === fonts.about.font,
        'mine=' + (fonts.mine && fonts.mine.font) + ' about=' + (fonts.about && fonts.about.font))
      check('行高与「关于」一致', fonts.mine && fonts.about && fonts.mine.h === fonts.about.h,
        'mine=' + (fonts.mine && fonts.mine.h) + ' about=' + (fonts.about && fonts.about.h))
      check('图标宽度与「关于」一致', fonts.mine && fonts.about && fonts.mine.iconW === fonts.about.iconW,
        'mine=' + (fonts.mine && fonts.mine.iconW) + ' about=' + (fonts.about && fonts.about.iconW))
      check('URL 指定档位时不弹提示（排障入口不打扰）', ui.toastHidden === true)
      /* [画面亮度为什么不在这里量] 低配档曾被写成"场景画进 HDR 离屏缓冲、
         但合成 pass 因 postActive() 为假而不执行"，结果是木星整块变黑。
         这个 bug 值得永久守住，但**必须用截图来量**：
         页内 gl.readPixels 在本机环境恒返回 0（合成器取走这一帧后绘制缓冲即失效，
         见 shoot-scene.js 文件头的记录），拿它做断言只会得到假失败（实测过）。
         所以亮度断言放在截图侧，见本文件末尾的"低配档画面非黑"一步。 */
      check('（画面亮度改由截图侧断言，见结尾）', true, '见 screenshots 段落')
    } finally { await close(s) }
  }

  /* ---- 2) 无参数：自动检测 + 提示条 ---- */
  console.log('\n=== 2. 自动检测（无参数）===')
  {
    const s = await session(9702, path.join(os.tmpdir(), 'dsh-pm2-' + Date.now()),
      base + '?perfsamples=6&toastms=60000', 9000)
    try {
      const pm = JSON.parse(await s.ev('JSON.stringify(window.__spaceGlobe.perfMode())'))
      check('自动判定出了档位', pm.mode === 'high' || pm.mode === 'low', pm.mode + ' by ' + pm.detectedBy)
      check('判据来源标出来了', ['gpu-timer', 'raf', 'heuristic'].indexOf(pm.detectedBy) >= 0, pm.detectedBy)
      check('GPU 计时扩展可用（本机应可用）', pm.hasTimerQuery === true,
        'hasTimerQuery=' + pm.hasTimerQuery + ' canSample=' + pm.canSample + ' reduced=' + pm.reducedMotion)
      check('采样数 > 0', pm.samples > 0, pm.samples + '/' + pm.targetSamples)
      const toast = JSON.parse(await s.ev(`JSON.stringify({
        shown: !!(document.querySelector('#space-mode-toast')||{}).className,
        text: (document.querySelector('#space-mode-toast')||{}).textContent || '',
        stored: localStorage.getItem('leafmytop:space-perf-mode')
      })`))
      check('弹出了提示条', toast.shown === true, toast.text.slice(0, 40))
      check('提示里说明了 GPU 时间', /GPU 中位|帧间隔中位/.test(toast.text), toast.text.slice(0, 60))
      check('提示里给了切换指引', /性能模式/.test(toast.text))
      check('档位已落盘', toast.stored === pm.mode, String(toast.stored))
      console.log('        日志: ' + (s.logs.length ? s.logs.join(' | ') : '(无)'))
    } finally { await close(s) }
  }

  /* ---- 3) 二次访问：套用存储、不重复弹提示 ----
     [为什么在同一个浏览器进程里用 reload 模拟"二次访问"，而不是复用 profile 重开]
     跨进程复用 --user-data-dir 时，DOM Storage 的落盘与下一次读取之间有竞态：
     实测同一个 profile 第二次启动会读到 stored=null，于是走了自动检测 ——
     那测的是"Chrome 有没有把 localStorage 写盘"，不是被测代码。
     用 location.reload() 才是"用户第二次打开这个页面"的忠实模型。
     [?toastms= 把提示条展示时长拉长] 默认 9 秒对真人够用，但检测要等若干帧、
     加上页面加载，9 秒窗口会让"提示条有没有弹"变成和计时器赛跑（实测踩到：
     同一段逻辑两次运行一次判定弹出、一次判定没弹）。验证时显式拉长。 */
  console.log('\n=== 3. 二次访问（同进程 reload）===')
  {
    const s = await session(9706, path.join(os.tmpdir(), 'dsh-pm5-' + Date.now()),
      base + '?perfsamples=6&toastms=60000', 9000)
    try {
      const first = JSON.parse(await s.ev(`JSON.stringify({
        mode: window.__spaceGlobe.perfMode().mode,
        by: window.__spaceGlobe.perfMode().detectedBy,
        stored: localStorage.getItem('leafmytop:space-perf-mode'),
        toast: (document.querySelector('#space-mode-toast')||{}).className || '',
        seen: localStorage.getItem('leafmytop:space-perf-toast')
      })`))
      check('第一次访问完成检测并落盘', (first.stored === 'high' || first.stored === 'low'), String(first.stored))
      check('第一次访问弹了提示', first.toast === 'show', 'class="' + first.toast + '"')
      /* 清掉"已提示"记录，好验证"存储命中时不重复弹"这条逻辑本身
         （否则它可能只是因为 seen 记录而没弹，测不到重点）。 */
      await s.ev("localStorage.removeItem('leafmytop:space-perf-toast')")
      await s.cdp.send('Page.reload')
      await sleep(8000)
      const second = JSON.parse(await s.ev(`JSON.stringify({
        by: window.__spaceGlobe.perfMode().detectedBy,
        mode: window.__spaceGlobe.perfMode().mode,
        samples: window.__spaceGlobe.perfMode().samples,
        toast: (document.querySelector('#space-mode-toast')||{}).className || '',
        item: !!document.querySelector('.space-mode-item')
      })`))
      check('第二次访问走 stored 分支（命中存储、不再检测）', second.by === 'stored', second.by)
      check('第二次不再重复弹提示', second.toast !== 'show', 'class="' + second.toast + '"')
      check('第二次导航按钮仍在', second.item === true)
      console.log('        第一次: ' + JSON.stringify(first))
      console.log('        第二次: ' + JSON.stringify(second))
    } finally { await close(s) }
  }

  /* ---- 4) 点按钮切换 + ?perftest 日志 ---- */
  console.log('\n=== 4. 点击按钮切换 ===')
  {
    const s = await session(9705, path.join(os.tmpdir(), 'dsh-pm4-' + Date.now()),
      base + '?perf=high&perftest=1&perfsamples=4', 7000)
    try {
      const before = JSON.parse(await s.ev('JSON.stringify(window.__spaceGlobe.perfMode())'))
      check('起始为 high', before.mode === 'high', before.mode)
      await s.ev("document.querySelector('.space-mode-item > a').click()")
      await sleep(3500)
      const after = JSON.parse(await s.ev('JSON.stringify(window.__spaceGlobe.perfMode())'))
      check('点击后切到 low', after.mode === 'low', after.mode)
      check('后处理随之关闭', after.quality.nopost === 1, 'nopost=' + after.quality.nopost)
      const st = await s.ev("localStorage.getItem('leafmytop:space-perf-mode')")
      check('切换结果落盘', st === 'low', String(st))
      check('perftest 打出了检测日志', s.logs.length > 0, s.logs[0] ? s.logs[0].slice(0, 80) : '(无)')
    } finally { await close(s) }
  }

  /* ---- 5) 截图侧：低配档画面必须真的画出来（防"整块变黑"回归） ---- */
  console.log('\n=== 5. 低配档画面非黑（截图侧）===')
  {
    const { spawnSync } = require('child_process')
    const { decodeImage } = require('./planet-resize.js')
    const lum = (d, o) => 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]
    const shots = {}
    for (const mode of ['low', 'high']) {
      const out = path.join(ROOT, '.perf', 'shots', 'PERFCHECK-' + mode + '.png')
      fs.rmSync(out, { force: true })
      spawnSync(process.execPath, [path.join(ROOT, 'tools', 'shoot-scene.js'),
        '--w=1600', '--h=900', '--out=PERFCHECK-' + mode + '.png',
        '--q=pin=1600x900,perf=' + mode], { encoding: 'utf8', timeout: 240000 })
      if (!fs.existsSync(out)) { shots[mode] = null; continue }
      const img = decodeImage(out)
      /* 只量球面区域（避开标题文字与左下角卡片）：pin=1600x900 时球心 (1184,567)、
         半径 387，取中心偏左上的一块，确保整块都在球面上。 */
      let sum = 0, n = 0, detail = 0, dn = 0
      for (let y = 400; y < 820; y += 2) {
        for (let x = 980; x < 1540; x += 2) {
          const o = (y * img.w + x) * img.ch
          const c = lum(img.data, o)
          sum += c; n++
          /* 3x3 高通：两档的差别在这里最明显（bloom 关闭 + 贴图降档 + MSAA 降级
             都会压低高频），而平均亮度**故意**被对齐了，拿亮度当判据会失效。 */
          if (x > 980 && y > 400) {
            let s = 0
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue
                s += lum(img.data, ((y + dy) * img.w + (x + dx)) * img.ch)
              }
            }
            detail += Math.abs(c - s / 8); dn++
          }
        }
      }
      shots[mode] = { mean: sum / n, detail: detail / dn, bytes: fs.statSync(out).size }
    }
    check('低配档截图成功产出', !!shots.low, shots.low ? Math.round(shots.low.bytes / 1024) + ' KB' : '缺文件')
    check('正常档截图成功产出', !!shots.high, shots.high ? Math.round(shots.high.bytes / 1024) + ' KB' : '缺文件')
    if (shots.low && shots.high) {
      /* 阈值 40：黑屏时该区域实测只有 7.2（那次"整块变黑"的回归）；
         对齐后两档都在 95 上下，所以 40 是"明显不是黑屏"的下限，
         不用它卡画质（画质由 verify-globe-render 管）。 */
      check('低配档球面区域不是黑屏（平均亮度 > 40）', shots.low.mean > 40,
        'low=' + shots.low.mean.toFixed(1) + '  high=' + shots.high.mean.toFixed(1))
      /* 判据用**细节能量**而不是亮度：亮度被刻意对齐了（低配走直渲，
         曝光是另一个量纲，见 MAIN_EXPOSURE 的注释），用亮度会误判成"两档没差别"。
         实测 detail high≈4.32 / low≈2.03，所以 high 至少要高出 30%。 */
      check('正常档细节明显高于低配档（两档确有差异）',
        shots.high.detail > shots.low.detail * 1.3,
        'detail high=' + shots.high.detail.toFixed(2) + ' low=' + shots.low.detail.toFixed(2))
    }
  }

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('  失败项: ' + failures.join(' | ')); process.exit(1) }
  console.log('  ALL CHECKS PASSED')
}

main().catch((e) => { console.error('失败: ' + (e && e.message ? e.message : e)); process.exit(1) })
