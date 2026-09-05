/* ============================================================
   顶部导航栏 一体式胶囊检索 (custom inject)
   -----------------------------------------------
   UI：一个毛玻璃胶囊 = 放大镜图标 + 输入框(同盒)。
     - 常态：胶囊只显示图标(输入区宽0)。hover 仅提亮，无光晕遮罩。
     - 点击胶囊 → .nav-search-open：输入区在图标右侧平滑滑出，
       图标保持在胶囊内(图标被搜索栏"包起来")。
     - 再次点击胶囊 / Esc / 点击空白 / 滚动 → 收起。
     - 无输入/空输入时不显示任何浮层；只有产生检索内容
       (结果 / 无结果 / 索引失败 / 加载中)才弹出结果浮层。
   检索逻辑：索引由 scripts/search-json.js 构建期生成 /search.json。
     每条 { t:标题,u:链接,d:日期,tags[],cats[],s:摘要 }。
   ============================================================ */
(function () {
  'use strict'
  var nav = document.querySelector('#nav')
  if (!nav) return
  var menus = nav.querySelector('#menus')
  if (!menus) return

  var INDEX_URL = '/search.json'
  var MAX = 8
  var indexCache = null
  var indexState = 'idle' // idle | loading | ready | error
  var indexPromise = null
  var isOpen = false
  var searchTimer = null
  var lastQuery = ''
  var showTimer = null
  var clearBtn = null
  var marqueeEl = null
  var marqueeInnerEl = null

  // ---------- DOM: 一体胶囊 ----------
  var wrap = document.createElement('div')
  wrap.className = 'nav-search'

  var bar = document.createElement('div')
  bar.className = 'nav-search-bar'
  bar.setAttribute('role', 'search')
  bar.setAttribute('aria-label', '搜索')

  // 图标固定在胶囊右侧(最右)，输入框在其左侧展开 —— 展开时图标不移动
  var input = document.createElement('input')
  input.className = 'nav-search-input'
  input.type = 'text'                 // 弃用 type=search 的原生清除按钮(伪元素不可点击)
  input.placeholder = ' '             // 占位符由跑马灯承担, 置空字符
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('spellcheck', 'false')
  bar.appendChild(input)

  // 跑马灯: 覆盖在输入框内容区, 未输入/未聚焦时循环滚动, 颜色取大背景主色
  var marquee = document.createElement('div')
  marquee.className = 'nav-search-marquee'
  marquee.setAttribute('aria-hidden', 'true')
  var marqueeInner = document.createElement('span')
  marqueeInner.textContent = '搜索文章、标签、分类'
  marquee.appendChild(marqueeInner)
  bar.appendChild(marquee)

  // 真实可点击的清除按钮(仅当有输入时显示)
  var clear = document.createElement('i')
  clear.className = 'fas fa-times nav-search-clear'
  clear.title = '清空'
  clear.setAttribute('role', 'button')
  clear.setAttribute('aria-label', '清空搜索')
  bar.appendChild(clear)

  var ico = document.createElement('i')
  ico.className = 'fas fa-search nav-search-ico'
  bar.appendChild(ico)

  // 自定义光标(渐变 + 光晕 + 呼吸): 取代原生生硬闪烁条, 由 positionCaret 定位
  var caret = document.createElement('span')
  caret.className = 'nav-search-caret'
  caret.setAttribute('aria-hidden', 'true')
  bar.appendChild(caret)

  wrap.appendChild(bar)

  clearBtn = bar.querySelector('.nav-search-clear')
  marqueeEl = bar.querySelector('.nav-search-marquee')
  marqueeInnerEl = marqueeEl.querySelector('span')

  var panel = document.createElement('div')
  panel.className = 'nav-search-panel'
  panel.setAttribute('role', 'listbox')
  panel.innerHTML =
    '<div class="nav-drop-edge"><div class="nav-drop-edge-light"></div></div>' +
    '<div class="nav-drop-glow"></div>' +
    '<div class="nav-search-status" hidden></div>' +
    '<ul class="nav-search-results" hidden></ul>'
  wrap.appendChild(panel)

  // 放 #menus 最右
  var toggle = menus.querySelector('#toggle-menu')
  if (toggle && toggle.parentNode === menus) menus.insertBefore(wrap, toggle)
  else menus.appendChild(wrap)

  var statusEl = panel.querySelector('.nav-search-status')
  var listEl = panel.querySelector('.nav-search-results')

  // ---------- 索引 ----------
  function loadIndex() {
    if (indexCache) return Promise.resolve(indexCache)
    if (indexState === 'loading') return indexPromise
    indexState = 'loading'
    indexPromise = fetch(INDEX_URL, { credentials: 'same-origin' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (data) {
        indexCache = Array.isArray(data) ? data : []
        indexState = 'ready'
        return indexCache
      })
      .catch(function () {
        indexState = 'error'
        throw new Error('index-error')
      })
    return indexPromise
  }

  function renderStatus(cls, html) {
    statusEl.hidden = false
    statusEl.className = 'nav-search-status ' + cls
    statusEl.innerHTML = html
    listEl.hidden = true
    listEl.innerHTML = ''
    showPanel()
  }
  function renderList() {
    statusEl.hidden = true
    statusEl.innerHTML = ''
    listEl.hidden = false
    showPanel()
  }
  function hidePanel() {
    wrap.classList.remove('show-panel')
    statusEl.hidden = true
    listEl.hidden = true
  }
  function showPanel() {
    wrap.classList.add('show-panel')
  }

  // 同步输入区状态控件: 有输入→隐藏跑马灯、显示清除按钮; 空→反之
  function updateControls(query) {
    var has = !!query
    // 跑马灯: 无输入时可见(循环滚动), 有输入/聚焦时隐藏
    marqueeEl.classList.toggle('hidden', has)
    // 清除按钮: 有输入时显示
    clearBtn.classList.toggle('show', has)
  }

  // ---------- 自定义光标定位(弹簧弹性动画) ----------
  // 用 canvas.measureText 量出"光标前文字"宽度, 与输入框字体一致。
  // 光标移动不走线性跳变, 而用弹簧物理(刚度 + 阻尼)做非线性弹性滑动:
  // 位移→加速度→速度→位移 闭环, 天然带过冲回弹、非匀速轨迹。
  var measureCtx = null
  var caretX = null          // 光标当前 X(相对 bar)
  var caretV = 0             // 速度
  var caretTargetX = null    // 目标 X
  var caretRaf = null
  var caretLastTs = 0
  var SPRING_STIFFNESS = 230 // 弹簧刚度(越高响应越快)
  var SPRING_DAMPING = 20    // 阻尼(相对刚度越低, 过冲回弹越明显)

  function getMeasureCtx() {
    if (!measureCtx) {
      measureCtx = document.createElement('canvas').getContext('2d')
      measureCtx.font = window.getComputedStyle(input).font
    }
    return measureCtx
  }
  function caretTargetLeft() {
    var pos = (typeof input.selectionStart === 'number') ? input.selectionStart : input.value.length
    var text = input.value.slice(0, pos)
    var w = text ? getMeasureCtx().measureText(text).width : 0
    var padL = parseFloat(window.getComputedStyle(input).paddingLeft) || 0
    return input.offsetLeft + padL + w
  }
  function caretSpringTick(ts) {
    var dt = ts ? (ts - caretLastTs) / 1000 : (1 / 60)
    caretLastTs = ts || 0
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60   // 限幅, 避免跳帧/暂停导致大步长
    // 子步进: 每步 ≤ 1/240s, 保证半隐式欧拉数值稳定(低帧率下 dt 过大
    // 会让高刚度弹簧发散, 轨迹爆炸)。步数上限 24 防极端 dt。
    var steps = Math.max(1, Math.min(24, Math.ceil(dt * 240)))
    var h = dt / steps
    for (var i = 0; i < steps; i++) {
      var dx = caretTargetX - caretX
      // 弹簧物理: 加速度 = 刚度 * 位移 - 阻尼 * 速度
      caretV += (SPRING_STIFFNESS * dx - SPRING_DAMPING * caretV) * h
      caretX += caretV * h
    }
    caret.style.left = caretX + 'px'
    // 收敛: 位移与速度都足够小 → 吸附到位, 停止动画
    if (Math.abs(caretTargetX - caretX) < 0.25 && Math.abs(caretV) < 0.4) {
      caretX = caretTargetX
      caretV = 0
      caret.style.left = caretTargetX + 'px'
      caretRaf = null
      return
    }
    caretRaf = requestAnimationFrame(caretSpringTick)
  }
  function setCaretAt(target) {
    // 即时定位(无动画): 首次出现 / 重新打开恢复残留值时用
    caretX = target
    caretTargetX = target
    caretV = 0
    if (caretRaf) { cancelAnimationFrame(caretRaf); caretRaf = null }
    caret.style.left = target + 'px'
  }
  function positionCaret() {
    if (!isOpen || document.activeElement !== input) {
      caret.classList.remove('on')
      caretV = 0
      if (caretRaf) { cancelAnimationFrame(caretRaf); caretRaf = null }
      caretX = null          // 重置: 下次重新聚焦时直接到位(不做滑动)
      return
    }
    caret.classList.add('on')
    var target = caretTargetLeft()
    // 首次出现: 直接到位, 不播放动画
    if (caretX === null) {
      setCaretAt(target)
      return
    }
    caretTargetX = target
    if (caretRaf === null) {
      caretLastTs = 0
      caretRaf = requestAnimationFrame(caretSpringTick)
    }
  }

  // ---------- 匹配 ----------
  function matchScore(item, q) {
    var t = (item.t || '').toLowerCase()
    var tags = (item.tags || []).join(' ').toLowerCase()
    var cats = (item.cats || []).join(' ').toLowerCase()
    var s = (item.s || '').toLowerCase()
    var qi = q.toLowerCase()
    if (t.indexOf(qi) === 0) return 0
    if (t.indexOf(qi) > 0) return 1
    if (tags.indexOf(qi) >= 0 || cats.indexOf(qi) >= 0) return 2
    if (s.indexOf(qi) >= 0) return 3
    return -1
  }

  function excerpt(item, q) {
    var s = item.s || ''
    var qi = q.toLowerCase()
    var idx = s.toLowerCase().indexOf(qi)
    if (idx < 0) return s.slice(0, 90)
    var start = Math.max(0, idx - 20)
    return (start > 0 ? '…' : '') + s.slice(start, idx + q.length + 60) + '…'
  }

  function highlight(text, q) {
    if (!text) return ''
    var esc = String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
    var qi = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return esc.replace(new RegExp('(' + qi + ')', 'ig'), '<mark>$1</mark>')
  }

  function runSearch(raw) {
    var query = (raw || '').trim()

    // 同步输入区状态控件: 有内容→隐藏跑马灯+显示清除按钮; 空→显示跑马灯+隐藏清除
    updateControls(query)

    // 空/仅空白：不检索、清面板(不下拉任何提示)
    if (!query) {
      lastQuery = ''
      hidePanel()
      return
    }
    if (query === lastQuery) return
    lastQuery = query

    // 索引未就绪 → loading；就绪后补一次
    if (!indexCache) {
      renderStatus('nav-search-loading',
        '<span class="dot"></span><span class="dot"></span><span class="dot"></span>' +
        '<span class="ns-text">正在搜索…</span>')
      loadIndex()
        .then(function () {
          if (isOpen && input.value.trim() === query) { lastQuery = ''; runSearch(query) }
        })
        .catch(function () {
          if (isOpen) renderStatus('nav-search-error', '<i class="fas fa-exclamation-triangle nav-s-ico"></i>检索索引加载失败，请刷新后重试')
        })
      return
    }

    var data = indexCache || []
    var scored = []
    data.forEach(function (it) {
      var sc = matchScore(it, query)
      if (sc >= 0) scored.push({ item: it, sc: sc })
    })
    scored.sort(function (a, b) {
      return a.sc - b.sc || (b.item.d || '').localeCompare(a.item.d || '')
    })
    var top = scored.slice(0, MAX)

    if (!top.length) {
      renderStatus('nav-search-empty', '<i class="fas fa-inbox nav-s-ico"></i>未找到与「<b></b>」相关的内容，换个关键词试试')
      statusEl.querySelector('b').textContent = query
      return
    }
    renderList()
    listEl.innerHTML = top.map(function (r) {
      var it = r.item
      var meta = []
      if (it.d) meta.push('<time>' + it.d + '</time>')
      if (it.cats && it.cats.length) meta.push('<span class="ns-cat">' + it.cats.map(function (c) { return highlight(c, query) }).join(' / ') + '</span>')
      if (it.tags && it.tags.length) meta.push('<span class="ns-tags">' + it.tags.map(function (t) { return highlight(t, query) }).join(' ') + '</span>')
      return (
        '<li class="nav-search-item"><a href="' + it.u + '">' +
        '<span class="ns-title">' + highlight(it.t, query) + '</span>' +
        (meta.length ? '<span class="ns-meta">' + meta.join('') + '</span>' : '') +
        '<span class="ns-excerpt">' + excerpt(it, query) + '</span>' +
        '</a></li>'
      )
    }).join('')
  }

  // ---------- 开/关 ----------
  function openBox(doFocus) {
    isOpen = true
    wrap.classList.add('nav-search-open')
    // 打开时若上次有残留值, 同步控件状态
    updateControls(input.value.trim())
    // 有残留值: 重新检索并恢复结果面板(收起时面板被隐藏 + lastQuery 清空,
    // 重新展开若不重新 runSearch, 结果栏就不会再出现)
    if (input.value.trim()) runSearch(input.value)
    // 光效初始化: 用最近鼠标位置 clamp 到面板内(面板刚展开, 指针静止时
    // 光斑不会卡在初始左上角)
    updateSearchGlow(lastMouseX, lastMouseY)
    if (doFocus !== false) {
      clearTimeout(showTimer)
      showTimer = setTimeout(function () {
        input.focus()
        // 有残留值时把光标放到末尾, 并同步自定义光标位置
        var len = input.value.length
        if (len && input.setSelectionRange) input.setSelectionRange(len, len)
        // 重新打开恢复残留值: 直接到位, 不播放滑动动画
        if (isOpen && document.activeElement === input) {
          caret.classList.add('on')
          setCaretAt(caretTargetLeft())
        }
      }, 430) // 对齐输入框展开动画(width .4s), 让自定义光标在展开完成后才出现
    }
    // 静默预取索引(不显示 loading, 输入时才用)
    if (!indexCache && indexState === 'idle') loadIndex().catch(function () {})
  }
  function closeBox() {
    isOpen = false
    wrap.classList.remove('nav-search-open')
    wrap.classList.remove('show-panel')
    lastQuery = ''
    // 收起时隐藏清除按钮: 输入值仍在(供下次展开恢复), 但收起态的小胶囊
    // 只显示图标, 叉不应浮在上面
    clearBtn.classList.remove('show')
    input.blur()
  }

  // 清除按钮: 点它清空输入并复位状态
  clearBtn.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    input.value = ''
    lastQuery = ''
    runSearch('')
    input.focus()
  })

  // 点击胶囊: 已开则收起, 未开则展开并聚焦; 点输入框本身不收起
  bar.addEventListener('click', function (e) {
    e.preventDefault()
    var t = e.target
    // 点击清除按钮(有独立 listener, 此处兜底)或跑马灯 → 不收起
    if (t === clearBtn) return
    if (t === marqueeInnerEl || t === marqueeEl) { input.focus(); return }
    if (isOpen) {
      // 点的是输入框(想放光标) → 不收起; 点图标/胶囊空白 → 收起
      if (t === input) { input.focus(); return }
      closeBox()
    } else {
      openBox()
    }
  })
  // 输入
  input.addEventListener('input', function () {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () { runSearch(input.value) }, 80)
  })
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closeBox() }
  })
  // 自定义光标: 聚焦/失焦/输入/点击/移动光标时重定位
  input.addEventListener('focus', positionCaret)
  input.addEventListener('blur', positionCaret)
  input.addEventListener('input', positionCaret)
  input.addEventListener('keyup', positionCaret)
  input.addEventListener('click', positionCaret)
  input.addEventListener('select', positionCaret)
  // 结果浮层: "文章"下拉页(nav-drop)同款光效质感(冷雾蓝 + 边缘环 +
  // 光斑), 但可见性改为"进入光效范围才发光、移出渐灭":
  // 光心 clamp 到面板内跟随指针, opacity 由范围判定控制
  var panelEdge = panel.querySelector('.nav-drop-edge')
  var panelEdgeLight = panel.querySelector('.nav-drop-edge-light')
  var panelGlow = panel.querySelector('.nav-drop-glow')
  var lastMouseX = 0
  var lastMouseY = 0
  var SEARCH_RX = 140  // 面板外扩椭圆半径 X(水平光效影响范围)
  var SEARCH_RY = 120  // 面板外扩椭圆半径 Y(垂直光效影响范围)
  function updateSearchGlow(x, y) {
    lastMouseX = x
    lastMouseY = y
    var r = panel.getBoundingClientRect()
    if (!r.width || !r.height) return
    // 椭圆影响范围 + 距离衰减(与导航栏 targetAlphaAt 同构):
    // 指针在面板内 t=0 → 最亮; 在面板外但椭圆内 → 亮度 1-t 渐暗;
    // 椭圆外 → 0 熄灭。即"光标在外面, 但光效影响范围先触及边缘, 边框就发光"。
    var dx = 0, dy = 0
    if (x < r.left) dx = r.left - x
    else if (x > r.right) dx = x - r.right
    if (y < r.top) dy = r.top - y
    else if (y > r.bottom) dy = y - r.bottom
    var t = Math.sqrt((dx / SEARCH_RX) * (dx / SEARCH_RX) + (dy / SEARCH_RY) * (dy / SEARCH_RY))
    var alpha = Math.max(0, Math.min(1, 1 - t))
    if (panelEdge) panelEdge.style.opacity = alpha.toFixed(3)
    if (panelGlow) panelGlow.style.opacity = (alpha * 0.9).toFixed(3)
    // 光心 clamp 到面板内跟随指针(与 nav-drop 的 updateDropGlow 同构)
    var gx = (x < r.left ? r.left : (x > r.right ? r.right : x)) - r.left
    var gy = (y < r.top ? r.top : (y > r.bottom ? r.bottom : y)) - r.top
    if (panelGlow) panelGlow.style.transform = 'translate3d(' + (gx - 130).toFixed(2) + 'px,' + (gy - 90).toFixed(2) + 'px,0)'
    if (panelEdgeLight) panelEdgeLight.style.transform = 'translate3d(' + (gx - 340).toFixed(2) + 'px,' + (gy - 120).toFixed(2) + 'px,0)'
  }
  document.addEventListener('mousemove', function (e) {
    updateSearchGlow(e.clientX, e.clientY)
  })
  // 点外部空白收起
  document.addEventListener('pointerdown', function (e) {
    if (!isOpen) return
    if (!wrap.contains(e.target)) closeBox()
  })
  // 滚动: 仅当检索栏为空(无输入、无结果)时才收起;
  // 有文字(正在输入/有搜索结果)时保持展开, 方便边滚动边看结果
  // (导航 #nav 为 position:fixed, 浮层 absolute 随导航固定, 滚动不脱锚)
  window.addEventListener('scroll', function () {
    if (!isOpen) return
    if (!input.value.trim()) closeBox()
  }, { passive: true })
})()
