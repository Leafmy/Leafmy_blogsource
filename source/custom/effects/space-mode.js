/* ============================================================
   性能模式 (source/custom/effects/space-mode.js)
   ------------------------------------------------------------
   首页那颗木星要按 GPU 时间跑后处理链（HDR + bloom + MSAA + 各向异性），
   在独显上实测极轻（CPU 提交 0.04ms/帧、rAF 257fps），但在集显/移动端
   就不是了。这个模块负责：判定档位 → 提示用户 → 提供手动切换。

   === 为什么判据是 GPU 时间而不是帧率 ===
   帧率被 vsync 钉在 60（或 120）：一台"刚好卡"的机器和一台"很吃力"的机器
   读数一样。`EXT_disjoint_timer_query_webgl2` 给的是"这一帧 GPU 花了多少
   毫秒"，才是可比较的量。所以主判据取 GPU 中位时间，拿不到该扩展时才回退
   到帧间隔 —— 并把 detectedBy 如实标出来，不把两种判据混为一谈。

   === 优先级 ===
     ?perf=high|low  >  localStorage  >  自动检测
   URL 永远最高：排障时要能一句话钉死档位，否则"到底是模式还是参数生效"说不清。

   === 判据与存储是两件事 ===
   渲染器（space-globe.js）只提供原始数据与运行时开关；阈值、"该判哪一档"、
   localStorage、UI 全在这里。渲染器不 import 这个文件，这个文件也不改渲染器内部。

   依赖：space-mode.css（提示条与按钮的样式）
   ============================================================ */
(function () {
  'use strict'

  // 站点文字表（管理页 /admin/「文字」标签页写的）；window.st 由 <head> 内联脚本提供
  var st = window.st || function (key, fallback) { return fallback }

  var STORE_KEY = 'leafmytop:space-perf-mode'      // 'high' | 'low'
  var SEEN_KEY = 'leafmytop:space-perf-toast'      // 已提示过的模式组合，避免每次刷新都弹
  /* 一次性标记：用户刚点过切换按钮。切换会重载页面，重载后内存里没有任何
     线索能区分"用户刚改的档位"和"上次访问留下的档位"，所以用它传过去。
     只读一次即清（见下面 manualJustNow），不会让后续访问也弹提示。 */
  var JUST_KEY = 'leafmytop:space-perf-switched'

  /* 判据阈值。17ms ≈ 60fps 的 16.7ms，留出合成与 JS 的余量后仍算"能跑满"；
     p75 > 34ms 表示每隔几帧就掉一次，比中位数更能反映"卡顿感"。
     这两个数是可调的：真弱机上复核后按需收紧/放宽。 */
  var GPU_MEDIAN_LOW_MS = 17
  var GPU_P75_LOW_MS = 34
  var RAF_MEDIAN_LOW_MS = 20

  var qs = (function () {
    var m = new RegExp('[?&]perf=([^&]*)').exec(location.search)
    return m ? decodeURIComponent(m[1]).toLowerCase() : ''
  })()
  var qsTest = (function () {
    var m = new RegExp('[?&]perftest=([^&]*)').exec(location.search)
    return m ? decodeURIComponent(m[1]).toLowerCase() : ''
  })()
  /* 通用查询串读取：只有需要"可被自动化覆盖"的参数才走这里 */
  function qs2 (key) {
    var m = new RegExp('[?&]' + key + '=([^&]*)').exec(location.search)
    return m ? decodeURIComponent(m[1]) : ''
  }

  function store (key, val) {
    try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val) } catch (e) { /* 无痕模式忽略 */ }
    return null
  }

  /* ---- 快通道启发式：明显跑不动的设备不必等采样 ---- */
  function fastHeuristic () {
    var notes = []
    try {
      var c = document.createElement('canvas')
      var gl = c.getContext('webgl2') || c.getContext('webgl')
      if (!gl) return { mode: 'low', why: 'no-webgl' }
      var dbg = gl.getExtension('WEBGL_debug_renderer_info')
      var r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : ''
      if (/swiftshader|llvmpipe|software|basic render/i.test(r)) {
        return { mode: 'low', why: 'software-renderer', gpuName: r }
      }
      notes.push({ gpuName: r })
      // 松手释放上下文，别占着一个 GL context
      var lose = gl.getExtension('WEBGL_lose_context')
      if (lose) lose.loseContext()
    } catch (e) { /* 探测失败就当正常，交给采样判 */ }
    var cores = navigator.hardwareConcurrency || 0
    if (cores > 0 && cores <= 2) return { mode: 'low', why: 'cores<=2', cores: cores }
    var mem = navigator.deviceMemory
    if (typeof mem === 'number' && mem > 0 && mem <= 2) return { mode: 'low', why: 'deviceMemory<=2', deviceMemory: mem }
    return { mode: null, notes: notes }
  }

  /* ---- rAF 回退判据：拿不到 GPU 计时扩展时用 ---- */
  function measureRaf (frames) {
    return new Promise(function (resolve) {
      var dt = []
      var last = 0, n = 0
      ;(function loop (t) {
        if (last) dt.push(t - last)
        last = t
        n++
        if (n >= frames + 1) {
          dt.sort(function (a, b) { return a - b })
          resolve({ medianMs: dt.length ? dt[Math.floor(dt.length / 2)] : null, samples: dt.length })
          return
        }
        requestAnimationFrame(loop)
      })()
    })
  }

  function median (a) {
    if (!a || !a.length) return null
    var s = a.slice().sort(function (x, y) { return x - y })
    return s[Math.floor(s.length / 2)]
  }

  /* ---- 决定档位 ----
     [优先级：存储 > URL > 自动检测。看起来违反直觉，但 URL 放前面会坏掉切换按钮]
     贴图档位是加载期决定的，所以"切到低配"要重载页面。若 URL(?perf=) 优先于存储，
     那么用户在 ?perf=high 页面点按钮 → 写存储为 low → 重载 → URL 又把档位拽回
     high，表现为"点了没反应"。实测就是这么坏的（verify-perf-mode 第 4 组失败）。
     真正的语义应该是：**URL 是一次性覆盖**（排障时钉死这一次），
     只要存储里已有值，就以存储为准。
     代价：想反复用 ?perf=high 排障时，得先清掉存储（或换 profile）——
     这个代价换来的是切换按钮真的能用，值得。 */
  var api = window.__spaceGlobe
  if (!api) return
  if (!document.querySelector('.space-bg')) return   // 只有首页有场景
  if (document.querySelector('.space-bg.space-gl-off')) return  // 无 WebGL：已在兜底，不打扰

  var state = {
    mode: null,
    detectedBy: '',
    gpu: null,
    raf: null,
    why: ''
  }

  var stored = store(STORE_KEY)
  /* "刚手动切换过"：读一次即清，避免它影响之后的每次访问 */
  var manualJustNow = false
  try {
    manualJustNow = store(JUST_KEY) === '1'
    if (manualJustNow) store(JUST_KEY, '')
  } catch (e) { /* 无痕模式忽略 */ }
  console.log('[space-mode] 启动: stored=' + stored + ' qs=' + JSON.stringify(qs) +
    ' perfMode=' + (api.perfMode ? api.perfMode().mode : '?'))
  if (stored === 'low' || stored === 'high') {
    state.mode = stored
    state.detectedBy = 'stored'
    api.setPerfMode(stored, { by: 'stored' })
    console.log('[space-mode] 套用存储档位=' + stored + ' → 现在 ' + api.perfMode().detectedBy)
  } else if (qs === 'low' || qs === 'high') {
    state.mode = qs
    state.detectedBy = 'url'
    api.setPerfMode(qs, { by: 'url' })
    console.log('[space-mode] 套用 URL 档位=' + qs + ' → 现在 ' + api.perfMode().detectedBy)
  }

  /* ---- 阈值判定：把"GPU 统计"变成"哪一档" ----
     阈值放在这里而不是渲染器里：渲染器只报事实（多少毫秒），
     "多少毫秒算慢"是产品决策，改它不该动渲染代码。 */
  function decide (info) {
    if (!info || !info.gpu) return null
    if (info.gpu.medianMs > GPU_MEDIAN_LOW_MS) return 'low'
    if (info.gpu.p75Ms > GPU_P75_LOW_MS) return 'low'
    return 'high'
  }

  /* ---- 导航按钮 ---- */
  function buildButton () {
    if (document.querySelector('.space-mode-item')) return
    var menus = document.querySelector('#nav .menus_items')
    if (!menus) return
    var items = menus.querySelectorAll('.menus_item')
    var aboutItem = null
    for (var i = 0; i < items.length; i++) {
      var a = items[i].querySelector('a')
      var href = a ? (a.getAttribute('href') || '') : ''
      if (/^\/about\/?/.test(href) || /关于/.test(a ? a.textContent : '')) { aboutItem = items[i]; break }
    }
    if (!aboutItem) return
    var li = document.createElement('li')
    li.className = 'menus_item space-mode-item'
    var btn = document.createElement('a')
    btn.href = 'javascript:;'
    btn.setAttribute('role', 'button')
    btn.title = '在"完整画质"与"低配"之间切换（GPU 渲染负载）'
    btn.innerHTML = '<i class="fas fa-gauge-high"></i><span class="space-mode-label"></span>'
    li.appendChild(btn)
    aboutItem.insertAdjacentElement('afterend', li)
    btn.addEventListener('click', function (e) {
      e.preventDefault()
      var next = (state.mode === 'low') ? 'high' : 'low'
      state.mode = next
      state.detectedBy = 'manual'
      store(STORE_KEY, next)          // 先落盘：会重载，重载后要靠它定档
      /* 标记"这次是用户刚点的切换"，让重载后的那一轮知道该弹一次提示
         （重载后 detectedBy 会是 'stored'，而 stored 默认是静默的）。 */
      try { store(JUST_KEY, '1') } catch (e) {}
      api.setPerfMode(next, { by: 'manual' })
      /* [两个方向都重载 —— 不要在某个方向做"就地切换"]
         低配与正常档之间有三样东西是**加载期**决定的，运行时改不了：
         贴图档位（2048 vs 3072）、各向异性（2 vs 设备上限）、以及直渲路径下
         曝光的量纲。就地切换会漏掉它们 —— 实测过一次：切到低配后
         exposure 停在 3.3（应为 1.1），而低配走直渲、曝光由着色器自己乘，
         画面直接过亮；同时 aniso 也没降到 2。既然重载是唯一能让三样都生效的
         方式，就两个方向都重载，行为一致、也没有"半生效"的中间态。 */
      location.reload()
    })
    render()
  }
  function render () {
    var label = document.querySelector('.space-mode-label')
    if (!label) return
    label.textContent = state.mode === 'low'
      ? st('nav.perf.low', '低配模式')
      : st('nav.perf.high', '性能模式')
    var item = document.querySelector('.space-mode-item')
    if (item) item.classList.toggle('is-low', state.mode === 'low')
  }

  /* ---- 提示条 ---- */
  function toast (manual) {
    var seen = store(SEEN_KEY) || ''
    var tag = state.mode + ':' + state.detectedBy
    if (!manual && seen.indexOf(tag) >= 0) return
    if (!manual) store(SEEN_KEY, seen ? seen + ',' + tag : tag)

    var el = document.getElementById('space-mode-toast')
    if (!el) {
      el = document.createElement('div')
      el.id = 'space-mode-toast'
      el.setAttribute('role', 'status')
      document.body.appendChild(el)
    }
    var g = state.gpu
    var perf = g && typeof g.medianMs === 'number'
      ? st('perf.gpu', 'GPU 中位 {ms} ms/帧', { ms: g.medianMs.toFixed(1) })
      : (state.raf && state.raf.medianMs
        ? st('perf.raf', '帧间隔中位 {ms} ms', { ms: state.raf.medianMs.toFixed(1) })
        : st('perf.noGpu', '未取到 GPU 计时'))
    var msg
    if (state.mode === 'low') {
      msg = st('perf.toastLow',
        '已开启<strong>低配模式</strong>（{perf}）：关闭了后处理光晕、降低抗锯齿与各向异性，木星贴图用较小档。想恢复完整画质，点导航栏「性能模式」切换。',
        { perf: perf })
    } else {
      msg = st('perf.toastHigh',
        '当前为<strong>完整画质</strong>（{perf}）。若卡顿严重，可点导航栏「性能模式」切换为低配模式。',
        { perf: perf })
    }
    el.innerHTML = '<span class="space-mode-close" aria-label="关闭">×</span>' + msg
    el.className = 'show'
    el.querySelector('.space-mode-close').addEventListener('click', function () { el.className = '' })
    clearTimeout(toast._t)
    /* 展示时长可覆盖（?toastms=30000）：默认 9 秒对真人够用，
       但对自动化验证太短 —— 检测本身要等若干帧，加上页面加载，
       9 秒的窗口会让"提示条有没有弹"变成一场和计时器的赛跑（实测就踩到了）。 */
    var ms = parseFloat(qs2('toastms'))
    toast._t = setTimeout(function () { el.className = '' }, isFinite(ms) && ms > 0 ? ms : 9000)
  }

  /* ---- 检测编排 ---- */
  function autoDetect () {
    var h = fastHeuristic()
    if (h.mode) {
      state.mode = h.mode
      state.detectedBy = 'heuristic'
      state.why = h.why
      store(STORE_KEY, h.mode)
      api.setPerfMode(h.mode, { by: 'heuristic' })
      finish()
      return
    }
    /* 等采样齐再决定：判据与展示用同一批数（见 perfStats.waitGpu 的注释）。
       拿不到 GPU 计时就回退帧间隔。 */
    function withRaf () {
      return measureRaf(60).then(function (r) {
        state.raf = r
        state.detectedBy = 'raf'
        state.mode = (r.medianMs && r.medianMs > RAF_MEDIAN_LOW_MS) ? 'low' : 'high'
        store(STORE_KEY, state.mode)
        api.setPerfMode(state.mode, { by: 'raf' })
        finish()
      })
    }
    if (!api.perfStats || typeof api.perfStats.waitGpu !== 'function') { withRaf(); return }
    if (!api.perfStats.canSample()) {
      /* prefers-reduced-motion 或 ?freeze= 定影：画面本身不再重绘，
         测量什么都不成立 —— 不要假装量过（doc 里如实标 raf/reduced）。
         这条在无头环境下必走（它默认报 reduced），所以 URL 给了
         ?perfsamples= 时渲染器会自己开一条采样循环，canSample 才是 true。 */
      withRaf()
      return
    }
    api.perfStats.waitGpu(2500).then(function (g) {
      state.gpu = g
      if (!g || !g.samples || !api.perfMode().hasTimerQuery) { withRaf(); return }
      state.detectedBy = 'gpu-timer'
      state.mode = decide({ gpu: g })
      store(STORE_KEY, state.mode)
      api.setPerfMode(state.mode, { by: 'gpu-timer' })
      finish()
    })
  }

  function finish () {
    buildButton()
    render()
    if (qsTest === 'quiet') return
    /* [什么时候不该弹]
       · URL 指定档位：那是排障入口，不是给访客看的
       · 命中 localStorage 且**不是刚手动切换过**：用户上次已经看过这个提示、
         也已经选过档位了，每次打开都弹一遍是打扰。
         手动切换这件事用一次性标记传过来（见 JUST_KEY）：因为切换会重载，
         重载后无法从内存里知道"用户刚点了按钮"。 */
    var quiet = state.detectedBy === 'url' ||
      (state.detectedBy === 'stored' && !manualJustNow)
    if (!quiet) toast(false)
    if (qsTest) {
      console.log('[space-mode] ' + JSON.stringify({
        mode: state.mode, detectedBy: state.detectedBy, gpu: state.gpu, raf: state.raf,
        why: state.why, quality: api.quality()
      }))
    }
  }

  if (state.mode) {
    /* 已有档位（URL 或存储）：不检测、不写存储，直接上 UI。
       URL 指定的档位不弹提示（那是排障入口，不是给访客看的）。 */
    finish()
    if (qs) { var el = document.getElementById('space-mode-toast'); if (el) el.className = '' }
  } else {
    buildButton()
    autoDetect()
  }
})()
