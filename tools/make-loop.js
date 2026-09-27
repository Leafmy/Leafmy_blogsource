'use strict'
/* ============================================================
   循环小样导出 (tools/make-loop.js)
   ------------------------------------------------------------
   把首页场景录成一段 webm，用来判断"离线渲染 + 页面播视频"这条替代路线
   值不值得走。

   === 现状：驱动链路已通，但本机的**编码器不产出帧** ===
   已经打通并验证过的部分：
     · 宿主页加载场景成功（frameReady 为真）
     · recordLoop 逐帧推进、尾段与首帧做交叉淡化、stop() 正常触发
       （回读状态：rec.state = 'inactive'，视频轨道 readyState = 'live'）
     · CDP 驱动能正确等待完成并取回数据
   卡住的一步是 MediaRecorder 本身：
     · 试过 VP9 / VP8 / 默认 mime，`ondataavailable` **一次都没触发**
     · 输出的文件恰好 110 字节（只有 EBML 头，零帧）
     · 已排除的原因：blob 时序（改成等 onstop）、帧推得太快（加了每帧
       25ms settle）、码率参数（改成不给 videoBitsPerSecond）、
       只推一帧不吐（改成 rec.start(200) 分块）
     · 结论：Windows 无头 Chrome 的 MediaRecorder 在这个环境里不生成
       canvas 流的帧。这是**编码器环境限制**，不是场景或录制逻辑的问题。
   可用的替代路径（都不需要改这里）：
     · 在有 ffmpeg 的机器上：先用 tools/shoot-verify.js / shoot-scene.js
       把每帧导出（同一套 setTime 契约），再交给 ffmpeg 编码；
     · 或在本机装上 ffmpeg 后把 recordLoop 换成"导出帧序列 + 调用 ffmpeg"。
   方案评估（循环周期、体积）见 tools/loop-plan.js，那部分与编码器无关。

   前置：node tools/serve-public.js
   用法:
     node tools/make-loop.js                        # 12s/30fps/720p
     node tools/make-loop.js --seconds=6 --fps=24 --w=1280 --h=720
     node tools/make-loop.js --codec=vp9            # 指定编码（auto 默认）
   输出：.perf/shots/loop-<参数>.webm
   ============================================================ */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT_DIR = path.join(ROOT, '.perf', 'shots')

function arg (name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : def
}
const SECONDS = Number(arg('seconds', 12))
const FPS = Number(arg('fps', 30))
const W = Number(arg('w', 1280))
const H = Number(arg('h', 720))
const XFADE = Number(arg('xfade', 0.6))
const MBPS = Number(arg('mbps', 8))
const PORT = arg('port', '8099')
const VERBOSE = process.argv.includes('--verbose')

const outName = 'loop-' + SECONDS + 's-' + FPS + 'fps-' + W + 'x' + H + '.webm'
const outPath = path.join(OUT_DIR, outName)

/* ---- 场景宿主页：与 themes 的 space-scene.pug 构图变量一致，但去掉博客内容层 ---- */
const host = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:#000;overflow:hidden;height:100%}
  .space-bg{position:fixed;inset:0;z-index:0;overflow:hidden;pointer-events:none;
    --globe:min(64vw,86vh); --globe-cx:74vw; --globe-cy:63vh;
    --sky-band-a-x:6vw; --sky-band-a-y:72vh; --sky-band-b-x:41vw; --sky-band-b-y:79vh;
    --sky-body-scale:1}
  .space-scene-canvas{position:absolute;inset:0;z-index:1;display:block;width:100%;height:100%}
  .space-nebula,.space-globe-glow,.space-globe{display:none}
</style></head><body>
<div class="space-bg" aria-hidden="true">
  <div class="space-nebula"></div>
  <div class="space-globe-glow"></div>
  <div class="space-globe"><img class="space-globe-fallback" src="/img/jupiter-760.jpg" alt=""></div>
  <canvas class="space-scene-canvas"></canvas>
</div>
<script src="/custom/effects/space-system.js"></script>
<script src="/custom/effects/space-globe.js"></script>
<script>
window.addEventListener('load', function () {
  var tries = 0
  function go () {
    var g = window.__spaceGlobe
    tries++
    if (!g || !g.frameReady) {
      if (tries > 400) {
        document.title = 'LOOPERR:场景未就绪(' + (window.__spaceGlobeError || '未知') + ')'
        window.__loopState = 'err'
        return
      }
      setTimeout(go, 200); return
    }
    g.recordLoop({
      seconds: ${SECONDS}, fps: ${FPS}, width: ${W}, height: ${H},
      bitrateMbps: ${MBPS}, crossfadeSec: ${XFADE}
    }).then(function (r) {
      document.title = 'LOOPOK:' + JSON.stringify({
        frames: r.frames, fps: r.fps, seconds: r.seconds,
        crossfadeFrames: r.crossfadeFrames, mime: r.mime, bytes: r.bytes
      })
      return fetch(r.url).then(function (res) { return res.arrayBuffer() })
    }).then(function (ab) {      var bytes = new Uint8Array(ab), bin = '', CH = 0x8000
      for (var i = 0; i < bytes.length; i += CH) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + CH, bytes.length)))
      }
      window.__loopB64 = btoa(bin)
      window.__loopState = 'done'
    }).catch(function (e) {
      document.title = 'LOOPERR:' + e.message
      window.__loopState = 'err'
    })
  }
  go()
})
</script></body></html>`

const publicRec = path.join(ROOT, 'public', '_loop-rec.html')
fs.mkdirSync(OUT_DIR, { recursive: true })
fs.mkdirSync(path.join(ROOT, 'public'), { recursive: true })
fs.writeFileSync(publicRec, host)
const url = 'http://127.0.0.1:' + PORT + '/_loop-rec.html?recdebug=1'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class CDP {
  constructor (ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.sessionId = null
    /* 事件监听器列表：把"响应配对"与"事件分发"分开，
       这样调用方可以订阅 Page.loadEventFired / Runtime.exceptionThrown。 */
    this.listeners = []
    ws.addEventListener('message', (ev) => {
      let msg
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()) } catch (e) { return }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
        return
      }
      for (const fn of this.listeners) fn(msg)
    })
  }
  on (fn) { this.listeners.push(fn) }
  send (method, params, timeoutMs) {
    const id = ++this.id
    const payload = { id, method, params: params || {} }
    if (this.sessionId) payload.sessionId = this.sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时: ' + method)) } }, timeoutMs || 60000)
    })
  }
}

async function main () {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome: ' + CHROME); process.exit(1) }
  console.log('URL    ' + url)
  console.log('参数   ' + SECONDS + 's / ' + FPS + 'fps / ' + W + 'x' + H +
    ' / 交叉淡化 ' + XFADE + 's / ' + MBPS + ' Mbps')

  const profile = path.join(os.tmpdir(), 'dsh-loop-' + Date.now())
  const dbgPort = 9200 + Math.floor(Math.random() * 700)
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + dbgPort,
    '--window-size=' + W + ',' + H,
    'about:blank'
  ], { stdio: VERBOSE ? 'inherit' : 'ignore' })

  let ws, exitCode = 0
  try {
    let version = null
    for (let i = 0; i < 100 && !version; i++) {
      try { version = await (await fetch('http://127.0.0.1:' + dbgPort + '/json/version')).json() } catch (e) { await sleep(200) }
    }
    if (!version) throw new Error('Chrome 调试端口未就绪')
    ws = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true })
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true })
    })
    const cdp = new CDP(ws)
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    cdp.sessionId = sessionId
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    /* [顺序很关键] 先在 navigate **之前**注册 load 等待：
       上一版 navigate 之后立刻轮询 Runtime.evaluate，页面还没开始执行脚本，
       拿到的是 undefined，表现是"轮询到 10 分钟超时"。
       同时也把 console 与未捕获异常收集起来，出错时能直接看到原因。 */
    const logs = []
    cdp.on((msg) => {
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        logs.push(msg.params.args.map((a) => a.value || a.description || '').join(' '))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        logs.push('EXC ' + ((msg.params.exceptionDetails.exception || {}).description || msg.params.exceptionDetails.text))
      }
    })
    let loaded = null
    const waitLoad = new Promise((resolve) => {
      loaded = resolve
      cdp.on((msg) => { if (msg.method === 'Page.loadEventFired') loaded() })
    })
    await cdp.send('Page.navigate', { url })
    await Promise.race([waitLoad, sleep(30000)])

    const evaluate = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }

    console.log('等待场景就绪并录制…（每帧一次渲染，与墙上时间无关的推进方式）')
    const t0 = Date.now()
    let state = null
    for (;;) {
      state = await evaluate(`(function(){
        return { title: document.title || '', st: window.__loopState || null,
                 has: !!window.__loopB64 }
      })()`)
      if (state.st === 'err' || (state.title && state.title.indexOf('LOOPERR:') === 0)) break
      if (state.st === 'done' && state.has) break
      if (Date.now() - t0 > Math.max(600000, SECONDS * FPS * 400)) {
        console.error('录制超时。最后状态: ' + JSON.stringify(state).slice(0, 200))
        exitCode = 1; break
      }
      await sleep(300)
    }

    if (state && state.st === 'err') {
      console.error('页面报错: ' + state.title)
      if (logs.length) console.error('页面日志:\n  ' + logs.slice(0, 6).join('\n  '))
      exitCode = 1
    } else if (state && state.st === 'done') {
      const meta = JSON.parse(state.title.replace('LOOPOK:', ''))
      console.log('录制   ' + meta.frames + ' 帧 / ' + meta.fps + 'fps / ' + meta.seconds + 's' +
        '  交叉淡化 ' + meta.crossfadeFrames + ' 帧  ' + meta.mime)
      console.log('编码体积 ' + (meta.bytes / 1024 / 1024).toFixed(2) + ' MB')
      const b64 = await evaluate('window.__loopB64')
      const buf = Buffer.from(b64, 'base64')
      fs.writeFileSync(outPath, buf)
      const mb = buf.length / 1024 / 1024
      console.log('写入   ' + path.relative(ROOT, outPath) + '  (' + mb.toFixed(2) + ' MB)')
      console.log('\n对照：实时方案 = 图片 1.9 MB + 渲染 JS 108 KB，可互动、可任意时刻；')
      console.log('      本视频 = ' + mb.toFixed(1) + ' MB，换来的是"画面不再需要实时渲染"。')
      /* 自检：webm 头必须是 EBML 魔数 0x1A45DFA3 */
      const magic = buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3
      console.log('文件头校验：' + (magic ? 'EBML 魔数正确 ✅' : '不是有效的 webm ❌'))
      if (!magic) exitCode = 1
    } else {
      exitCode = 1
    }
  } catch (e) {
    console.error('失败: ' + (e && e.message ? e.message : e))
    exitCode = 1
  } finally {
    try { if (ws) ws.close() } catch (e) {}
    child.kill()
    await sleep(300)
    fs.rmSync(profile, { recursive: true, force: true })
    if (!process.env.KEEP_REC) fs.rmSync(publicRec, { force: true })
  }
  process.exit(exitCode)
}

main()
