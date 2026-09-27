'use strict'
/* ============================================================
   站名排版校验 (tools/verify-site-title.js)
   ------------------------------------------------------------
   把"站名「启明」的排版"这件事从主观变成可断言的三条：
     ① 字形：hero 与导航里的站名都解析到**衬线族**（不是 PingFangMedium）
     ② 尺寸：hero 站名在 1600x900 下是 128px（clamp 的上界 8rem）
     ③ 不压木星：站名的实际文字右缘 < 木星可见左缘
   第 ③ 条是最容易悄悄失效的 —— 它是"构图边界"，而构图会随
   --globe / SKY_GAIN / 视口尺寸变化。实测（1600x900）木星可见左缘在
   y=320→560 之间从 x≈876 移到 x≈771，所以判据取"该行木星左缘 - 安全余量"。

   [为什么文字右缘要在页面里量而不是靠 CSS 推算]
   字号、letter-spacing、字体回退都会影响实际宽度（换台机器字体不同就不同），
   用 Range 量出**最后一个字的实际右缘**才是真的。

   用法:
     node tools/verify-site-title.js
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

async function main () {
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome: ' + CHROME); process.exit(1) }
  const profile = path.join(os.tmpdir(), 'dsh-title-' + Date.now())
  const dbgPort = 9961
  const child = spawn(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + dbgPort,
    '--force-device-scale-factor=1', '--window-size=1600,900', 'about:blank'
  ], { stdio: 'ignore' })
  let ws
  let code = 0
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
    let id = 0; const pend = new Map()
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data.toString())
      if (m.id && pend.has(m.id)) {
        const p = pend.get(m.id); pend.delete(m.id)
        m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result)
      }
    })
    const send = (method, params, sid) => new Promise((res, rej) => {
      const i = ++id; pend.set(i, { resolve: res, reject: rej })
      const p = { id: i, method, params: params || {} }
      if (sid) p.sessionId = sid
      ws.send(JSON.stringify(p))
    })
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
    await send('Page.enable', {}, sessionId)
    await send('Runtime.enable', {}, sessionId)
    await send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html?pin=1600x900' }, sessionId)
    await sleep(9000)
    const ev = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sessionId)
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
      return r.result.value
    }
    const ready = await ev('!!(window.__spaceGlobe && window.__spaceGlobe.frameReady)')
    check('场景就绪（否则"木星左缘"无从谈起）', ready === true)

    const m = JSON.parse(await ev(`JSON.stringify((function(){
      var t = document.querySelector('#site-title')
      var nt = document.querySelector('#nav .nav-site-title')
      var cs = getComputedStyle(t)
      /* [站名现在是 SVG，不是文字 —— 量法要跟着变]
         入场动画是"逐笔描出轮廓"，所以 hero 站名被 split-title.js 换成了内联
         SVG（每条字形轮廓一个 <path>）。于是：
           · textContent 为空、字体的 font-size/family 不再决定字形
             （字形来自 title-paths.js 烘焙的路径，尺寸由 svg 的 em 比例给）
           · 文字右缘不能再靠 Range 量，改成量最后一个 svg 的右缘
         仍保留对**导航站名**的字体检查：它还是文字，用的是衬线栈。 */
      var svgs = t.querySelectorAll('svg.qm')
      var textFromGlyphs = (window.__titleGlyphs || []).map(function (g) { return g.ch }).join('')
      /* 字距：SVG 盒子 = 字形墨迹包围盒（没有字体自带的边距），而且 Chrome
         **不会**在相邻的 inline-block 之间产生 letter-spacing 间距（受控实测：
         letter-spacing 22px、两盒间隙仍是 0px）。所以间隙只能来自显式
         margin-left（--qm-gap），这里量出来才有意义 —— 换字体/换规则、
         或者哪天有人删了那条 margin，立刻能看见。 */
      var gapPx = null, fsPx = null
      if (svgs.length === 2) {
        var r0 = svgs[0].getBoundingClientRect(), r1 = svgs[1].getBoundingClientRect()
        gapPx = +(r1.left - r0.right).toFixed(1)
        fsPx = parseFloat(getComputedStyle(t).fontSize)
      }
      var lastRight = null
      if (svgs.length) {
        lastRight = Math.round(svgs[svgs.length - 1].getBoundingClientRect().right)
      } else {
        var node = t.firstChild
        if (node && node.nodeType === 3 && node.textContent.length) {
          var rg = document.createRange()
          rg.setStart(node, node.textContent.length - 1)
          rg.setEnd(node, node.textContent.length)
          lastRight = Math.round(rg.getBoundingClientRect().right)
        }
      }
      var rect = t.getBoundingClientRect()
      var pathCount = t.querySelectorAll('path').length

      /* ---- 描边动画的两条不变量（这两条曾经破过，破法都很隐蔽）----
         [一] 烘焙长度必须等于浏览器实测路径长度。
              dasharray/dashoffset 用的是 title-paths.js 里的 lengths[]。
              一旦它比 getTotalLength() 短，动画两头同时露馅：
              开场（dashoffset=全长）会把尾段露在外面、收尾（dashoffset=0）
              尾段永远差一截画不到。旧实现差到 1.85 倍（横向笔画）。
         [二] 子路径不能有 180° 折返（零宽毛刺）。
              旧实现把矩形画成"对角+底+左+顶+回描"：看着还是闭合的、面积
              比对也过得去，但顶边被正反走了一遍 —— 采样相邻切线点积 ≈ -1
              是它唯一算得出来的特征。哪怕把 evenodd 换成 nonzero 也只会被填实，
              描边动画里那两根毛刺照样在。
         两条都在这里用页面里的真路径量，不依赖生成器自报。 */
      var lenBad = 0, lenMax = 0, spikes = 0, sampled = 0
      var gl = window.__titleGlyphs || []
      var paths = t.querySelectorAll('svg.qm path')
      for (var pi = 0; pi < paths.length; pi++) {
        var pe = paths[pi], real = pe.getTotalLength()
        var baked = (gl[Math.min(pi, gl.length - 1)] || {}).lengths
        /* 逐 path 找它属于哪个字：按 sbv 顺序累计 */
        var acc = 0, glyph = null
        for (var gi = 0; gi < gl.length; gi++) {
          if (pi < acc + gl[gi].lengths.length) { glyph = gl[gi]; break }
          acc += gl[gi].lengths.length
        }
        var want = glyph ? glyph.lengths[pi - acc] : null
        if (want != null) {
          var dLen = Math.abs(real - want)
          if (dLen > lenMax) lenMax = dLen
          if (dLen > 1) lenBad++
        }
        /* 折返检测：按 2 单位步长采样切线，相邻切线点积 < -0.98 即折返 */
        var n = Math.max(24, Math.min(1200, Math.ceil(real / 2)))
        var prev = null
        for (var k = 0; k <= n; k++) {
          var pt = pe.getPointAtLength(real * k / n)
          if (prev) {
            var dx = pt.x - prev.x, dy = pt.y - prev.y
            var L = Math.hypot(dx, dy)
            if (L > 0.6) {
              var ux = dx / L, uy = dy / L
              if (prev.ux != null && (ux * prev.ux + uy * prev.uy) < -0.98) spikes++
              prev = { x: pt.x, y: pt.y, ux: ux, uy: uy }
            }
          } else {
            prev = { x: pt.x, y: pt.y, ux: null, uy: null }
          }
          sampled++
        }
      }

      /* 描字动画必须真的被放行：脚本会把这一批动画先 pause 在 0，等
         DOMContentLoaded 后的第一帧再 play（见 split-title.js 的 armDrawing）。
         如果哪天在"放行"那一步挂了，标题会原地空着 —— 这里量得出来。 */
      var animStuck = 0, animTotal = 0
      if (document.getAnimations) {
        document.getAnimations().forEach(function (a) {
          var tg = a.effect && a.effect.target
          if (!tg || !tg.tagName || tg.tagName.toLowerCase() !== 'path') return
          var sv = tg.parentNode
          if (!sv || !sv.getAttribute || sv.getAttribute('class') !== 'qm') return
          animTotal++
          if (a.playState === 'paused') animStuck++
        })
      }

      return {
        text: (textFromGlyphs || (t.textContent || '').trim()),
        animTotal: animTotal,
        animStuck: animStuck,
        svgCount: svgs.length,
        pathCount: pathCount,
        dataQm: t.getAttribute('data-qm'),
        gapPx: gapPx,
        fontPx: fsPx,
        gapEm: (gapPx != null && fsPx) ? +(gapPx / fsPx).toFixed(3) : null,
        lenBad: lenBad,
        lenMax: +lenMax.toFixed(1),
        spikes: spikes,
        sampled: sampled,
        fontFamily: cs.fontFamily,
        firstFont: cs.fontFamily.split(',')[0].replace(/["']/g, ''),
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign,
        boxTop: Math.round(rect.top), boxBottom: Math.round(rect.bottom),
        textRight: lastRight,
        navFontFamily: nt ? getComputedStyle(nt).fontFamily.split(',')[0].replace(/["']/g, '') : null,
        navText: nt ? (nt.textContent || '').trim() : null,
        vp: [window.innerWidth, window.innerHeight]
      }
    })())`))

    console.log('  实测: ' + JSON.stringify(m))

    check('站名文本 = 启明', m.text === '启明', m.text)
    /* 逐笔描边的前置：hero 站名必须已换成 SVG，且每条字形轮廓一个 <path>
       （合成一条 path 的话 dash 会连续计算，变成"绕着字一路画"）。 */
    check('hero 站名已换成 SVG（两个字）', m.svgCount === 2, 'svgCount=' + m.svgCount)
    check('每条字形轮廓独立成 path', m.pathCount >= 16,
      'pathCount=' + m.pathCount + '（启 8 + 明 10 = 18）')
    check('SVG 就位后关掉了纯文字兜底', m.dataQm === 'svg', 'data-qm=' + m.dataQm)
    /* 18 条轮廓 × (qmDraw + qmFillIn) = 36 条动画，全部不能被永久按停 */
    check('描字动画已放行（没有卡在 paused）',
      m.animTotal >= 36 && m.animStuck === 0,
      '动画 ' + m.animTotal + ' 条，其中 paused ' + m.animStuck + ' 条')
    /* 描边动画的两条不变量：见上面 eval 里的说明。放宽到 1 单位 —— lengths[]
       是 1 位小数，d 的坐标也是 1 位小数，实测最大偏差 0.1。 */
    check('每条子路径的烘焙长度 = 浏览器实测长度（dash 不露馅的前提）',
      m.lenBad === 0, '不匹配 ' + m.lenBad + ' 条，最大偏差 ' + m.lenMax + ' 单位')
    check('子路径无 180° 折返（零宽毛刺）',
      m.spikes === 0, '折返 ' + m.spikes + ' 处 / 采样 ' + m.sampled + ' 点')
    /* 字距：SVG 盒子就是墨迹框，间隙 = 第二个字形的 margin-left（--qm-gap）。
       判据取 0.18~0.34em：下界保证两字不再贴在一起（修前实测 0.00em），
       上界防止有人越调越散。纯文字排版时字体天然字距约 0.184em，是参考点。 */
    check('站名两字间隙（--qm-gap）在 0.18~0.34em',
      m.gapEm != null && m.gapEm >= 0.18 && m.gapEm <= 0.34,
      '实测 ' + m.gapPx + 'px / ' + m.fontPx + 'px = ' + m.gapEm + 'em（纯文字天然字距≈0.184em）')
    check('导航站名仍是文字且用衬线栈',
      !!m.navText && /serif/i.test(m.navFontFamily + ''), 'nav=' + m.navFontFamily)

    /* 不压木星：实测木星可见左缘在文字所在行约 771~876，
       取最保守的 771，再留 30px 安全余量 → 判据 741。 */
    const JUPITER_LIMB_X = 771
    const SAFE = 30
    check('站名不压木星（实际文字右缘 < 木星左缘 - 30px）',
      m.textRight != null && m.textRight < JUPITER_LIMB_X - SAFE,
      '文字右缘=' + m.textRight + '  判据<' + (JUPITER_LIMB_X - SAFE))
    check('站名在 hero 可见竖带内（top>0 且 bottom<视口高）',
      m.boxTop > 0 && m.boxBottom < m.vp[1],
      'top=' + m.boxTop + ' bottom=' + m.boxBottom + ' vp=' + m.vp.join('x'))
  } catch (e) {
    console.error('失败: ' + (e && e.message ? e.message : e))
    code = 1
  } finally {
    try { if (ws) ws.close() } catch (e) {}
    child.kill()
    await sleep(250)
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch (e) {}
  }
  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('  失败项: ' + failures.join(' | ')); process.exit(1) }
  console.log('  ALL CHECKS PASSED')
  process.exit(code)
}

main()
