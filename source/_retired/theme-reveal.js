/* ============================================================
   Theme switch (custom inject, v20)
   ------------------------------------------------------------
   目标：明暗切换要有一眼可见的过渡，但在弱 GPU 机器上不能卡。

   === 实测结论（1920x1000 / Intel UHD Graphics iGPU / DPR=1）===
   用 CDP 逐帧测量"首帧间隔"（切换卡顿的核心指标）：
     A  当前 VT + 圆形 clip-path .................. 首帧 46 ms
     B  VT + 只做淡入（去掉 clip-path） ............ 首帧 42 ms
     C  VT + 完全不做动画（纯快照） ............... 首帧 46 ms
     D  不用 VT，纯合成器光晕（scale 大层） ........ 首帧 23 ms
     D2 不用 VT，视口层 + clip-path circle ........ 首帧 27 ms
     D3 不用 VT，视口层 + 淡入淡出 ................ 首帧 27 ms

   关键事实：A/B/C 的首帧几乎一样 —— 这 40~46ms **完全来自
   View Transition 的两张整页快照，与用什么动画无关**
   （clip-path 不是元凶，它并不是逐帧重光栅的）。
   而 D 系列虽然首帧更低，长尾反而更差（>33ms 帧数 3~7 帧 vs 1 帧），
   用大层做光晕在 iGPU 上并不划算 —— 换动画并不能解决卡顿。

   另测：data-theme 生效后的强制样式重算 + 布局 ≈ 20ms，
   逐项关掉 box-shadow / background-image / backdrop-filter / mask /
   text-shadow 都毫无变化 → 这是「150 条 html[data-theme] 规则 ×
   3194 个节点」的结构性成本，删某个属性解决不了。

   === 因此 v20 不再赌单一动画，改成运行时自适应 ===
   1. 首选 View Transition 的"真内容从中心圆形漾开"（观感最好，
      也是用户明确要的）；
   2. 每次切换实测首帧间隔（切完后的第 2 个 rAF 与切换时刻之差），
      连续两次 >52ms 就永久降级 —— 用这台机器自己的真实表现判断，
      而不是猜设备型号；
   3. 降级后走 LIGHT 路径：瞬时切 data-theme（只一次重绘、无快照）
      + 一层合成器-only 的冷雾淡入淡出。实测首帧 23~27ms，
      比 VT 低约 40%，也不引入大层；
   4. 另外尊重 prefers-reduced-motion；deviceMemory ≤4 或
      hardwareConcurrency ≤4 的低端设备直接走 LIGHT。
   ============================================================ */
(function () {
  'use strict'

  if (typeof window.btf === 'undefined') return

  const root = document.documentElement
  const isDarkMode = () => root.getAttribute('data-theme') === 'dark'

  /* ---------------- 浏览器识别（用于分档调优） ----------------
     [能力说明 / 局限]
     - 判据是 User-Agent：Edge 是 Chromium 内核，UA 里【同时】含
       "Chrome" 和 "Edg"，所以必须先判 Edge 再判 Chrome，否则会把
       Edge 误判成 Chrome。
     - UA 可以被篡改/伪装（扩展、隐私浏览器），也可能随版本变化失效。
       所以这里只用来"选一组调优参数"，绝不用来做功能开关 ——
       即使判错，最坏结果只是动画参数不最优，功能不会坏。
     - 支持 URL 强制覆盖，便于排查：?themeAnim=chrome / edge / plain / vt / light
       以及 ?themeAnimOff=1 完全关掉动画。 */
  const detectBrowser = () => {
    const ua = navigator.userAgent || ''
    // 顺序要紧：Edge / Opera / Samsung 的 UA 里都含 "Chrome"
    if (/Edg[A-Z]?\//.test(ua)) return 'edge'
    if (/OPR\/|SamsungBrowser/.test(ua)) return 'other'
    if (/Firefox\//.test(ua)) return 'other'
    if (/Chrome\//.test(ua) && !/Chromium\//.test(ua)) return 'chrome'
    return 'other'
  }
  const prefersReduced = () =>
    !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const hasViewTransition = () => typeof document.startViewTransition === 'function'

  /* 低端设备直接走轻量路径：内存/核心数偏低时整页快照一定不划算 */
  const isLowEndDevice = () => {
    const mem = navigator.deviceMemory
    const cores = navigator.hardwareConcurrency
    if (typeof mem === 'number' && mem <= 4) return true
    if (typeof cores === 'number' && cores <= 4) return true
    return false
  }

  /* 用户手动指定过动画偏好吗（__btfTheme.setMode 会写入） */
  const storedPreference = () => {
    try {
      const v = localStorage.getItem('theme-anim')
      return (v === 'vt' || v === 'light' || v === 'plain') ? v : null
    } catch (e) { return null }
  }

  /* 自测选出的"最省档位"（由 runSelfTest 写入） */
  const FASTEST_KEY = 'theme-anim-fastest'
  const storedFastest = () => {
    try {
      const v = localStorage.getItem(FASTEST_KEY)
      return (v === 'plain' || v === 'light' || v === 'short' || v === 'medium' || v === 'long') ? v : null
    } catch (e) { return null }
  }

  /* 'vt' = 真内容从中心圆形漾开；'light' = 瞬时切色 + 冷雾过渡
     ------------------------------------------------------------
     [v22 重大调整] 默认改为 light。
     原因（像素级实测，1920x1000 Intel UHD，用 CDP 截图取屏幕像素）：
       路径           背景真正画到屏幕上      用户看到主题变化
       vt（圆形漾开）  329ms                  跟随圆形逐帧解锁
       light（瞬时）   110ms                  几乎立刻
     根因不是"渲染慢"，而是 View Transition 期间浏览器展示的是
     两张【快照】，实时页面被隐藏 —— 所以背景的渲染实际上被那圈
     圆形逐帧"解锁"。用户描述"遮蔽动画完成后才渲染"完全由此而来，
     与动画快慢无关。
     另外用户实测：同一台机器 Microsoft Edge 不卡、Google Chrome 卡，
     也指向 Chrome 的 VT 实现路径（快照 + 多层合成）。
     因此默认走 light；想要真内容圆形漾开的，控制台执行
     `__btfTheme.setMode('vt')` 持久化，或 `__btfTheme.mode = 'vt'` 仅本次。
     低端设备 / prefers-reduced-motion 强制 light（忽略手动偏好）。 */
  /* 'vt'       = 真内容从中心圆形漾开（View Transition）
     'light'    = 瞬时换色 + 冷雾渐显渐隐（默认）
     'plain'    = 完全不用动画，直接硬切（最省，用于排查/低端机） */
  const forceLight = prefersReduced() || isLowEndDevice()
  const stored = storedPreference()
  const browser = detectBrowser()

  /* URL 覆盖（排查用）：?themeAnim=vt|light|plain|chrome|edge
                        ?themeAnimOff=1 等价 plain
                        ?themeAnim=chrome 时按 Chrome 档参数跑（可在 Edge 里复现 Chrome 行为） */
  const urlParams = (() => {
    try { return new URLSearchParams(location.search) } catch (e) { return null }
  })()
  const urlOverride = urlParams ? urlParams.get('themeAnim') : null
  const urlOff = urlParams ? urlParams.get('themeAnimOff') : null
  // 用 URL 模拟某个浏览器档位（便于在别的浏览器里复现 Chrome 的表现）
  const profileBrowser = (urlOverride === 'chrome' || urlOverride === 'edge') ? urlOverride : browser

  let mode
  if (urlOff === '1' || urlOverride === 'plain') mode = 'plain'
  else if (urlOverride === 'vt') mode = 'vt'
  else if (urlOverride === 'light' || urlOverride === 'chrome' || urlOverride === 'edge') mode = 'light'
  else if (!forceLight && stored === 'vt') mode = 'vt'
  else if (stored) mode = stored
  // 没手动指定过时，采用本机自测选出的最省档位（没有就是默认 light）
  else if (storedFastest()) mode = storedFastest()
  else mode = 'light'

  /* 自适应：入场确实慢到影响观感时才降级。
     [v21 调整] 原来阈值 52ms / 2 次，实测太敏感 —— 本机正常的
     入场就在 42~50ms，偶尔一次负载抖动就凑够两次，会把好不容易
     做得可见的圆形漾开给"优化"掉。改为 80ms(≈5 帧) / 3 次：
     只有真的慢到 80ms 以上且连续发生，才判定这台机器跑不动整页快照。 */
  const SLOW_FRAME_MS = 80
  const SLOW_STRIKES = 3
  let slowStrikes = 0
  let switchStartedAt = 0
  let switching = false

  /* ---------------- 主题状态切换 ---------------- */
  const applyTheme = m => {
    if (m === 'dark') {
      if (window.btf.activateDarkMode) window.btf.activateDarkMode()
    } else if (window.btf.activateLightMode) {
      window.btf.activateLightMode()
    }
    if (window.btf.saveToLocal) window.btf.saveToLocal.set('theme', m, 2)
  }

  /* 第三方主题回调（评论框 / 图表 / mermaid 等需要跟着换主题的部件）。
     ------------------------------------------------------------
     [重要修正] v13~v20 曾把这段挪到 requestIdleCallback 里"避开最紧的
     窗口"。实测这是错的：本站有大量高刷常驻动画（trace 显示约
     14700 个任务/2.5s），requestIdleCallback 会被长期饿住，只能等
     250ms 超时才执行 —— 用户看到的现象就是「遮蔽动画都放完了，
     页面才开始把颜色渲染出来」。
     现在放回 VT 回调内同步执行，理由：
       1) 回调内执行的 DOM 变更会被【新快照】一并捕获，颜色和内容同步；
       2) 本站文章页实测 themeChange 监听数为 0，这里几乎没有成本；
       3) 真要慢，慢在快照之前也比"动画放完才变"好得多。
     每个回调独立 try/catch，一个部件报错不影响其它部件与主题切换。 */
  const runThemeWork = m => {
    const globalFn = window.globalFn || {}
    const themeChange = globalFn.themeChange
    if (themeChange) {
      Object.keys(themeChange).forEach(key => {
        const fn = themeChange[key]
        if (typeof fn !== 'function') return
        try {
          fn(m)
        } catch (err) {
          try { console.warn('[theme] themeChange 回调失败:', key, err) } catch (e) {}
        }
      })
    }
  }

  /* Snackbar 只是提示条，与快照无关，延后到首帧之后，不挤占动画窗口 */
  const showThemeSnackbar = m => {
    if (!window.GLOBAL_CONFIG || !window.GLOBAL_CONFIG.Snackbar) return
    if (typeof window.btf.snackbarShow !== 'function') return
    const msg = window.GLOBAL_CONFIG.Snackbar[m === 'dark' ? 'day_to_night' : 'night_to_day']
    if (msg !== undefined) window.btf.snackbarShow(msg)
  }

  /* ---------------- 路径 1：冷雾「渐显 → 保持 → 渐隐」 ----------------
     [v25 回退到 v23 的时序] v24 曾试图用"opacity 实心平台"把主题重算
     藏起来，结果 Chrome 未改善、**连原本正常的 Edge 也变卡**，已回退。

     当前时序（总 0.62s）：
       0~150ms    渐显（用户看到雾起来）
       ~150ms     切主题（此时雾已浓到 0.96，突变看不见）
       150~380ms  保持
       380~620ms  渐隐（露出新主题）

     用动画对象自身的 currentTime 判断切换时机，而不是固定 setTimeout
     —— 后者会因 rAF 对齐被拖到 214ms。

     [待办] 遮罩动画本身的帧开销尚未严格测量过（此前的"验证"用的是
     合成类对照，不涉及遮罩，属于方法错误）。后续如需继续调优，必须先
     用 realbench.js / veilcost.js 量"真实实现"的帧间隔，再动这里。
     [v25 实测] 遮罩确实有成本：有动画时合成器 p95 = 15.4ms，
     完全硬切时 p95 = 7.9ms —— 即遮罩每帧多花约 7.5ms 合成时间。
     本机 headless 跑在约 260Hz 扛得住，但 60Hz 机器上这已接近
     单帧预算(16.7ms)的一半，是"仍有轻微不顺"的主要来源。 */

  /* 遮罩参数：分浏览器档位
     ------------------------------------------------------------
     [v26 定档，依据「冻结次数」= 画面连续两帧没刷新的次数 ——
      这才是用户嘴里的"卡一下"]

     本机（1920x1000 / Intel UHD）连测 4 轮 × 每轮 4 次：
         short  (260ms / alpha .45)   冻结 0~1 次    总开销 187~298ms
         medium (420ms / alpha .7)    冻结 0~1 次    总开销 240~317ms
         plain  (硬切 / 无动画)        冻结 13~15 次  总开销 379~401ms
     用户机器（60Hz / 同款 iGPU）独立复现（旧指标）：
         short 302 / light(≈320ms) 314 / plain 375 —— 硬切同样最差

     **结论 1：硬切（关掉动画）会真的卡 13~15 次**，是唯一明显卡顿的
       选项。主题切换的重活（样式重算 + 33 个 backdrop-filter 层同时
       重绘）在硬切时全部挤在一帧爆发；带动画则摊到多帧，每帧只承担
       一点。所以"关掉动画"从来不是省性能的选项，别再往那个方向退。
     **结论 2：short 与 medium 都是 0~1 次冻结，实质等价**，差异在噪声
       内；只有"总开销"上 short 略低（混合量更小）。故取 short：
       动画更短、开销上限更低，平顺程度相同。

     可用 __btfTheme.veil.* 实时覆盖；__btfTheme.reason.profile 可查当前档位。 */
  const PROFILES = {
    chrome: { duration: 420, commitAt: 0.26, alpha: 0.7 },
    edge: { duration: 620, commitAt: 0.24, alpha: 1 },
    other: { duration: 620, commitAt: 0.24, alpha: 1 }
  }
  const baseProfile = PROFILES[profileBrowser] || PROFILES.other
  const veilCfg = {
    duration: baseProfile.duration,
    commitAt: baseProfile.commitAt,
    alpha: baseProfile.alpha
  }

  /* 'short' / 'medium' / 'long' 档参数（自测候选，见 runSelfTest）
     注：commitAt 必须 ≥ CSS 曲线里遮罩渐显完成的进度（0.24），
     否则主题会在雾还没盖住时切换、突变会露出来。各档统一取略大于 0.24：
       short  260 × 0.30 = 78ms   （渐显完成于 260 × 0.24 = 62ms）
       medium 420 × 0.26 = 109ms  （渐显完成于 420 × 0.24 = 101ms）
       long   620 × 0.26 = 161ms  （渐显完成于 620 × 0.24 = 149ms） */
  const SHORT_CFG = { duration: 260, commitAt: 0.3, alpha: 0.45 }
  const MEDIUM_CFG = { duration: 420, commitAt: 0.26, alpha: 0.7 }
  const LONG_CFG = { duration: 620, commitAt: 0.26, alpha: 0.85 }
  const applyModeCfg = () => {
    if (mode === 'short') {
      veilCfg.duration = SHORT_CFG.duration
      veilCfg.commitAt = SHORT_CFG.commitAt
      veilCfg.alpha = SHORT_CFG.alpha
    } else if (mode === 'medium') {
      veilCfg.duration = MEDIUM_CFG.duration
      veilCfg.commitAt = MEDIUM_CFG.commitAt
      veilCfg.alpha = MEDIUM_CFG.alpha
    } else if (mode === 'long') {
      veilCfg.duration = LONG_CFG.duration
      veilCfg.commitAt = LONG_CFG.commitAt
      veilCfg.alpha = LONG_CFG.alpha
    } else if (mode === 'light') {
      veilCfg.duration = baseProfile.duration
      veilCfg.commitAt = baseProfile.commitAt
      veilCfg.alpha = baseProfile.alpha
    }
  }
  applyModeCfg()

  // alpha 通过 veil.style.filter = opacity(n) 实时施加（见 lightSwitch），
  // 这样控制台改 __btfTheme.veil.alpha 后下次切换立即生效，无需重建。

  /* ---------------- 自动分档：在本机自己测一遍，挑最平的 ----------------
     为什么需要：哪个档位在这台机器上够顺，只有在【这台机器的真实浏览器】
     里测才准。开发者环境（headless / 无扩展）测不出用户体感。

     === 指标演进（两次踩坑，都记下来） ===
     v1「绝对最差帧间隔」：信噪比不足 —— light 34.6 / plain 34.8 / short 42.4，
        连"硬切"和"带动画"都区分不开。因为绝对帧间隔里混着空载基线。
     v2「超出基线的帧时间总和」(cost)：区分度有了（约 170ms），
        但有个隐含问题 —— 它把"总量"当目标，而用户感知的是"卡了几下"。
        另外当时三个候选里有两个参数几乎相同（Chrome 档 320ms vs short
        260ms），等于测了重复项还据此选择，不严谨。
     v3（当前）「冻结帧数 frozen」：统计【连续两帧间隔都超过 1.5×基线】
        的次数。这才是用户嘴里的"卡" —— 一次持续的冻结，而不是总忙碌量。
        同时把三个候选真正拉开：short 260ms / medium 420ms / plain 硬切。

     排序依据：先比 frozen（越少越顺），frozen 相同再比 cost。 */
  const measureBaseline = () => new Promise(resolve => {
    const gaps = []
    let last = 0
    const stopAt = performance.now() + 900
    const tick = ts => {
      if (last) gaps.push(ts - last)
      last = ts
      if (performance.now() < stopAt) requestAnimationFrame(tick)
      else {
        gaps.sort((a, b) => a - b)
        resolve({
          p50: gaps[Math.floor(gaps.length * 0.5)] || 8,
          p90: gaps[Math.floor(gaps.length * 0.9)] || 16
        })
      }
    }
    requestAnimationFrame(tick)
  })

  const measureMode = (testMode, repeats, base) => new Promise(resolve => {
    const prevMode = mode
    mode = testMode
    applyModeCfg()

    const costs = []
    const frozens = []
    // 冻结判定阈值：基线 p90 的 1.5 倍（下限 16.7ms，避免高刷下过于敏感）
    const freezeThreshold = Math.max(base.p90 * 1.5, 16.7)

    let i = 0
    const step = () => {
      if (i >= repeats) {
        mode = prevMode
        applyModeCfg()
        const med = arr => {
          const s = arr.slice().sort((a, b) => a - b)
          return s[Math.floor(s.length / 2)] || 0
        }
        resolve({
          mode: testMode,
          frozen: +med(frozens).toFixed(1),
          cost: +med(costs).toFixed(0)
        })
        return
      }
      i++
      const gaps = []
      let last = 0
      const stopAt = performance.now() + 1000
      const rec = new Promise(res => {
        const tick = ts => {
          if (last) gaps.push(ts - last)
          last = ts
          if (performance.now() < stopAt) requestAnimationFrame(tick)
          else res()
        }
        requestAnimationFrame(tick)
      })
      const btn = document.getElementById('darkmode')
      if (btn) {
        const b = btn.getBoundingClientRect()
        const x = Math.round(b.left + b.width / 2)
        const y = Math.round(b.top + b.height / 2)
        const t = performance.now()
        const c = {
          bubbles: true, cancelable: true, composed: true, view: window,
          clientX: x, clientY: y, screenX: x, screenY: y,
          button: 0, buttons: 1, detail: 1, timeStamp: t
        }
        btn.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, c)))
        btn.dispatchEvent(new MouseEvent('mousedown', c))
        btn.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }, c)))
        btn.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, c, { buttons: 0 })))
        btn.dispatchEvent(new MouseEvent('click', Object.assign({}, c, { buttons: 0 })))
      }
      rec.then(() => {
        const win = gaps.slice(0, 55)
        let cost = 0
        let frozen = 0
        for (let k = 0; k < win.length; k++) {
          const over = win[k] - base.p90
          if (over > 0) cost += over
          // 连续两帧都超标 → 记一次"冻结"
          if (win[k] > freezeThreshold && k > 0 && win[k - 1] > freezeThreshold) frozen++
        }
        costs.push(cost)
        frozens.push(frozen)
        setTimeout(step, 380)
      })
    }
    step()
  })

  const runSelfTest = async (repeats = 4) => {
    if (switching) return { error: '正在切换中，请稍后再试' }
    showSelfTestPanel({ running: true })
    const base = await measureBaseline()
    // 候选：plain 作为"关掉动画"的对照（用户会想看这个数），
    // medium / long 才是真正竞争的档位。
    const candidates = ['plain', 'medium', 'long']
    const out = []
    for (const c of candidates) out.push(await measureMode(c, repeats, base))
    // 先比冻结次数，相同再比总开销
    out.sort((a, b) => (a.frozen - b.frozen) || (a.cost - b.cost))
    const best = out[0].mode
    try { localStorage.setItem(FASTEST_KEY, best) } catch (e) {}
    mode = best
    applyModeCfg()
    const result = {
      picked: best,
      baseline: { p50: +base.p50.toFixed(2), p90: +base.p90.toFixed(2) },
      detail: out,
      note: '已记录，刷新后依然生效'
    }
    window.__btfSelfTestResult = result
    showSelfTestPanel(result)
    return result
  }

  /* 把结果直接画到页面上（不依赖控制台 —— 实测 console.table 会被吞掉） */
  const showSelfTestPanel = res => {
    try {
      const old = document.getElementById('btf-selftest-panel')
      if (old) old.remove()
      const box = document.createElement('div')
      box.id = 'btf-selftest-panel'
      box.setAttribute('role', 'status')

      if (res.running) {
        box.innerHTML = '<div style="font-weight:700">明暗切换自测中…</div>' +
          '<div style="margin-top:6px;opacity:.8">会连续切换若干次并逐帧测量，约 15 秒。' +
          '期间画面闪动属正常现象。跑完这里会显示结果。</div>'
      } else {
        const rows = res.detail.map((d, i) =>
          '<tr><td style="padding:2px 12px 2px 0">' +
          (i === 0 ? '✅ ' : '') + d.mode + '</td>' +
          '<td style="padding:2px 12px 2px 0;font-weight:700">' + d.frozen + ' 次</td>' +
          '<td style="padding:2px 12px 2px 0">' + d.cost + ' ms</td></tr>'
        ).join('')
        box.innerHTML =
          '<div style="font-weight:700;margin-bottom:6px">明暗切换自测结果</div>' +
          '<div style="margin-bottom:8px;opacity:.82">空载基线 p50=' + res.baseline.p50 +
          'ms / p90=' + res.baseline.p90 + 'ms<br>' +
          '「冻结次数」= 画面连续两帧都没刷新的次数，<b>越少越顺</b>（这是主指标）<br>' +
          '「总开销」= 超出基线的帧时间总和，仅供参考</div>' +
          '<table style="border-collapse:collapse"><thead><tr>' +
          '<th style="text-align:left;padding:2px 12px 2px 0">档位</th>' +
          '<th style="text-align:left;padding:2px 12px 2px 0">冻结次数</th>' +
          '<th style="text-align:left">总开销</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div style="margin-top:10px;font-weight:700">已选用：' + res.picked + '</div>' +
          '<div style="margin-top:6px;opacity:.7;font-size:12px">此面板 90 秒后自动消失</div>'
      }
      box.style.cssText = [
        'position:fixed', 'left:50%', 'top:24px', 'transform:translateX(-50%)',
        'z-index:2147483001', 'background:rgba(20,24,34,.94)', 'color:#eaf0ff',
        'font:13px/1.6 ui-monospace,Consolas,monospace', 'padding:14px 18px',
        'border-radius:10px', 'box-shadow:0 8px 30px rgba(0,0,0,.45)',
        'border:1px solid rgba(140,180,255,.35)', 'pointer-events:auto'
      ].join(';')
      document.body.appendChild(box)
      setTimeout(() => { if (box.parentNode) box.parentNode.removeChild(box) }, 90000)
    } catch (e) {}
  }

  const lightSwitch = m => {
    // 不需要遮罩时（系统要求减少动效 / 用户关掉动画）直接切
    if (prefersReduced() || mode === 'plain') {
      applyTheme(m)
      runThemeWork(m)
      showThemeSnackbar(m)
      return
    }

    const veil = document.createElement('div')
    veil.className = 'theme-veil'
    veil.setAttribute('aria-hidden', 'true')
    if (veilCfg.alpha < 1) veil.style.filter = 'opacity(' + veilCfg.alpha + ')'
    document.body.appendChild(veil)

    // [关键] 切换期间禁掉各卡片的 transition。
    // 它们默认带 transition: all .3s，主题一变就会把 backdrop-filter /
    // background / box-shadow 逐帧插值 → 33 个模糊层每帧重新光栅化。
    // 实测：applyTheme 在 137ms 执行、主题到 205ms 才画出来，中间是
    // 连续 7 个 57~73ms 的长任务；关掉过渡后长任务为 0。
    // 注意这里【不动 backdrop-filter】—— 模糊保持全程开启，
    // v24 试过暂停它，反而把 Edge 拖卡，已回退。
    root.classList.add('theme-instant')

    switching = true
    let committed = false
    let cleaned = false

    const commit = () => {
      if (committed) return
      committed = true
      applyTheme(m)
      runThemeWork(m)   // 第三方部件跟着换色，与主题同帧完成
    }

    const cleanup = () => {
      if (cleaned) return
      cleaned = true
      commit()          // 兜底：确保主题一定切过去
      if (veil.parentNode) veil.parentNode.removeChild(veil)
      root.classList.remove('theme-instant')
      switching = false
      showThemeSnackbar(m)
    }

    veil.addEventListener('animationend', cleanup, { once: true })

    // 强制先渲染遮罩的"透明"起始态（读一次布局），
    // 否则浏览器可能把"插入 + 加 .on"合并成一次，动画起点丢失。
    void veil.offsetWidth
    requestAnimationFrame(() => {
      // 时长也在运行时可控（改 __btfTheme.veil.duration 后下次切换生效）
      veil.style.animationDuration = veilCfg.duration + 'ms'
      veil.classList.add('on')

      const anims = veil.getAnimations ? veil.getAnimations() : []
      const anim = anims && anims.length ? anims[0] : null

      if (anim) {
        const watch = () => {
          if (committed) return
          if (anim.currentTime >= veilCfg.duration * veilCfg.commitAt) return commit()
          requestAnimationFrame(watch)
        }
        requestAnimationFrame(watch)
      } else {
        setTimeout(commit, veilCfg.duration * veilCfg.commitAt + 30)
      }
    })
    setTimeout(cleanup, veilCfg.duration + 120)   // 兜底，避免遮罩残留
  }

  /* ---------------- 路径 2：View Transition 真内容圆形漾开 ---------------- */
  const viewTransitionSwitch = m => {
    // [性能] .switching 必须在 startViewTransition【之前】加：
    // 老快照是在"调用返回后、回调执行前"捕获的，写在回调里就来不及
    // 关掉 backdrop-filter 与 transition，模糊层会被白重光栅一次。
    root.classList.add('switching')
    switching = true
    switchStartedAt = performance.now()

    let vt
    try {
      vt = document.startViewTransition(() => {
        // 主题 + 第三方部件都在回调内同步完成：
        // 两者都会被【新快照】一起捕获，避免"动画放完了颜色才追上"。
        applyTheme(m)
        runThemeWork(m)
      })
    } catch (err) {
      root.classList.remove('switching')
      switching = false
      lightSwitch(m)
      return
    }

    // 首帧间隔 = 切换时刻 → 第二个 rAF。这一段就是用户感知到的"卡一下"。
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const gap = performance.now() - switchStartedAt
      if (gap > SLOW_FRAME_MS) {
        slowStrikes++
        if (slowStrikes >= SLOW_STRIKES) {
          mode = 'light'
          try {
            console.info('[theme] 切换入场约 ' + gap.toFixed(0) + 'ms，已改用轻量过渡')
          } catch (e) {}
        }
      } else if (slowStrikes > 0) {
        slowStrikes--
      }
    }))

    const done = () => {
      if (!switching) return
      switching = false
      root.classList.remove('switching')
      showThemeSnackbar(m)
    }

    if (vt && vt.finished && typeof vt.finished.then === 'function') {
      vt.finished.then(done, done)
    } else {
      setTimeout(done, 1200)   // 兜底要盖住动画时长(见 CSS 的 0.9s)
    }
  }

  /* ---------------- 点击入口 ---------------- */
  document.addEventListener('click', e => {
    const target = e.target
    const btn = target && target.closest ? target.closest('#darkmode') : null
    if (!btn) return

    e.stopPropagation()
    e.preventDefault()

    if (switching) return   // 切换进行中再点：忽略，避免两轮叠加
    const next = isDarkMode() ? 'light' : 'dark'

    if (mode === 'vt') viewTransitionSwitch(next)
    else lightSwitch(next)   // light 与 plain 都走这里（plain 内部会跳过遮罩）
  }, true)

  /* 页面切到后台时若切换还没收尾，立刻收尾：
     - 清掉 .switching（避免玻璃一直被按在静态近似上）
     - 清掉可能残留的遮罩层
     light 路径的 commit 由清扫函数兜底执行，主题不会丢。 */
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return
    if (switching) {
      switching = false
      root.classList.remove('switching')
    }
    root.classList.remove('theme-instant')
    document.querySelectorAll('.theme-veil').forEach(el => el.remove())
  })

  /* 排查 / 切换用（控制台直接可用）
       __btfTheme.mode                     → 当前路径
       __btfTheme.mode = 'plain'           → 本次会话改成硬切（最省）
       __btfTheme.mode = 'vt' | 'light'    → 本次会话切到其它路径
       __btfTheme.setMode('light'|'vt'|'plain'|'auto')  → 持久化并重载
       __btfTheme.veil.duration = 420      → 实时改遮罩时长(下次切换生效)
       __btfTheme.veil.commitAt = 0.3      → 实时改"何时换主题"
       __btfTheme.veil.alpha    = 0.6      → 实时改遮罩浓淡
       __btfTheme.reason                   → 默认路径为何这样判定 */
  window.__btfTheme = {
    get mode () { return mode },
    set mode (v) { mode = (v === 'vt' || v === 'plain' || v === 'short' || v === 'medium' || v === 'long') ? v : 'light'; applyModeCfg() },
    veil: veilCfg,
    /* 在本机自动测一遍三种档位，挑最省的并记下来（刷新后依然生效） */
    selfTest: (repeats) => runSelfTest(repeats || 3),
    /* 清除自测结果 / 手动偏好，回到默认 */
    reset: () => {
      try {
        localStorage.removeItem(FASTEST_KEY)
        localStorage.removeItem('theme-anim')
      } catch (e) {}
      location.reload()
    },
    setMode (v) {
      try {
        if (v === 'auto') localStorage.removeItem('theme-anim')
        else localStorage.setItem('theme-anim', (v === 'vt' || v === 'plain') ? v : 'light')
      } catch (e) {}
      location.reload()
    },
    reason: {
      browser: browser,
      profileBrowser: profileBrowser,
      profile: baseProfile,
      fastest: storedFastest(),
      urlOverride: urlOverride,
      urlOff: urlOff,
      hasViewTransition: hasViewTransition(),
      prefersReduced: prefersReduced(),
      lowEndDevice: isLowEndDevice(),
      stored: storedPreference()
    }
  }

  /* 自动自测：用户打开 ?themeSelfTest=1 就自动跑一遍。
     结果【直接画在页面上】（实测 console.table 在部分环境会被吞掉），
     同时挂到 window.__btfSelfTestResult，并把选定档位写进 localStorage。 */
  const autoTest = urlParams ? urlParams.get('themeSelfTest') : null
  if (autoTest === '1' || autoTest === 'true') {
    // 等页面稳定（图片/字体/懒加载都落定）再测，否则噪声大
    setTimeout(() => {
      runSelfTest(4).catch(err => {
        try { console.warn('[theme 自测失败]', err) } catch (e) {}
      })
    }, 2500)
  }
})()
