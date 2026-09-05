/* ============================================================
   顶部导航栏 检索图标 + 检索栏 (custom inject)
   -----------------------------------------------
   功能：
   1. 在 #nav 右侧(#menus 内最右)注入检索图标(放大镜)。
   2. 点击图标 → 输入条以非线性缓动(easeOutBack)向左展开；再次点击
      图标、按 Esc、或点击导航外空白 → 收起。
   3. 标准检索逻辑(无第三方插件，检索索引由 scripts/search-json.js
      在构建期生成 /search.json)：
        - 输入校验：去首尾空白；空/仅空白 → 不检索并给提示
        - 空值处理：输入被清空 → 回到初始提示态(不残留结果)
        - 加载状态：索引 fetch 中 → 显示 loading 点
        - 匹配：标题/标签/分类/摘要 子串匹配，标题命中优先，
          结果分组展示；点击结果跳转
        - 无结果提示 + 输入恢复焦点
        - 结果限 8 条
   样式依赖 nav-search.css；展开条与结果浮层均绝对定位，
   不推挤/遮挡导航内其它元素。
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
  var panelOpen = false
  var searchTimer = null
  var lastQuery = ''
  var showTimer = null

  // ---------- DOM 构建 ----------
  var wrap = document.createElement('div')
  wrap.className = 'nav-search'

  var btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'nav-search-btn'
  btn.setAttribute('aria-label', '搜索')
  btn.innerHTML = '<i class="fas fa-search"></i>'
  wrap.appendChild(btn)

  var field = document.createElement('div')
  field.className = 'nav-search-field'
  var input = document.createElement('input')
  input.className = 'nav-search-input'
  input.type = 'search'
  input.placeholder = '搜索文章、标签…'
  input.setAttribute('autocomplete', 'off')
  input.setAttribute('spellcheck', 'false')
  field.appendChild(input)
  wrap.appendChild(field)

  // 状态消息(loading/校验/空值/错误) + 结果区 合并为一块浮层
  var panel = document.createElement('div')
  panel.className = 'nav-search-panel'
  panel.setAttribute('role', 'listbox')
  panel.innerHTML =
    '<div class="nav-search-status" hidden></div>' +
    '<ul class="nav-search-results" hidden></ul>'
  wrap.appendChild(panel)

  // 放到 #menus 里最右(#toggle-menu 之前; 桌面端 toggle 隐藏)
  var toggle = menus.querySelector('#toggle-menu')
  if (toggle && toggle.parentNode === menus) menus.insertBefore(wrap, toggle)
  else menus.appendChild(wrap)

  var statusEl = panel.querySelector('.nav-search-status')
  var listEl = panel.querySelector('.nav-search-results')

  // ---------- 索引加载 ----------
  function loadIndex() {
    if (indexCache) return Promise.resolve(indexCache)
    if (indexState === 'loading') return indexPromise
    indexState = 'loading'
    statusEl.hidden = false
    statusEl.className = 'nav-search-status nav-search-loading'
    statusEl.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="ns-text">正在建立索引…</span>'
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
  }

  // ---------- 检索匹配 ----------
  function matchScore(item, q) {
    var t = (item.t || '').toLowerCase()
    var tags = (item.tags || []).join(' ').toLowerCase()
    var cats = (item.cats || []).join(' ').toLowerCase()
    var s = (item.s || '').toLowerCase()
    var qi = q.toLowerCase()
    // 标题命中优先；标签/分类次之；正文摘要最后
    if (t.indexOf(qi) === 0) return 0
    if (t.indexOf(qi) > 0) return 1
    if (tags.indexOf(qi) >= 0 || cats.indexOf(qi) >= 0) return 2
    if (s.indexOf(qi) >= 0) return 3
    return -1
  }

  // 摘要中高亮关键字片段(截取命中附近文本)
  function excerpt(item, q) {
    var s = item.s || ''
    var qi = q.toLowerCase()
    var idx = s.toLowerCase().indexOf(qi)
    if (idx < 0) return s.slice(0, 90)
    var start = Math.max(0, idx - 20)
    var frag = (start > 0 ? '…' : '') + s.slice(start, idx + q.length + 60) + '…'
    return frag
  }

  function highlight(text, q) {
    if (!text) return ''
    var esc = String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
    })
    var qi = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    var re = new RegExp('(' + qi + ')', 'ig')
    return esc.replace(re, '<mark>$1</mark>')
  }

  function runSearch(q) {
    // 校验: 去首尾空白
    var query = (q || '').trim()
    var v = query === ''

    if (v) {
      // 空值处理: 回到初始提示态，不残留结果
      lastQuery = ''
      renderStatus('', '<i class="fas fa-search nav-s-ico"></i>输入关键字检索文章、标签与内容')
      return
    }
    if (query === lastQuery) return
    lastQuery = query

    var data = indexCache || []
    var scored = []
    data.forEach(function (it) {
      var sc = matchScore(it, query)
      if (sc >= 0) scored.push({ item: it, sc: sc })
    })
    // 优先级: 分数小在前；同分按日期倒序
    scored.sort(function (a, b) {
      return a.sc - b.sc || (b.item.d || '').localeCompare(a.item.d || '')
    })
    var top = scored.slice(0, MAX)

    if (!top.length) {
      renderStatus('nav-search-empty', '<i class="fas fa-inbox nav-s-ico"></i>未找到与「<b></b>」相关的内容，换个关键词试试')
      statusEl.querySelector('b').textContent = query
      return
    }
    // 有结果
    statusEl.hidden = true
    listEl.hidden = false
    listEl.innerHTML = top.map(function (r) {
      var it = r.item
      var meta = []
      if (it.d) meta.push('<time>' + it.d + '</time>')
      if (it.cats && it.cats.length) meta.push('<span class="ns-cat">' + it.cats.map(function (c) { return highlight(c, query) }).join(' / ') + '</span>')
      if (it.tags && it.tags.length) meta.push('<span class="ns-tags">' + it.tags.map(function (t) { return highlight(t, query) }).join(' ') + '</span>')
      return (
        '<li class="nav-search-item"><a href="' + it.u + '" data-index="' + r.sc + '">' +
        '<span class="ns-title">' + highlight(it.t, query) + '</span>' +
        (meta.length ? '<span class="ns-meta">' + meta.join('') + '</span>' : '') +
        '<span class="ns-excerpt">' + excerpt(it, query) + '</span>' +
        '</a></li>'
      )
    }).join('')
  }

  // ---------- 开关 ----------
  function openPanel(autofocus) {
    panelOpen = true
    nav.classList.add('nav-search-open')
    btn.classList.add('active')
    if (autofocus !== false) {
      clearTimeout(showTimer)
      showTimer = setTimeout(function () { input.focus() }, 220)
    }
    // 首次打开即预取索引(展示 loading 态)
    loadIndex()
      .then(function () {
        if (!panelOpen) return
        // 索引就绪: 若当前有输入则立即出结果; 否则初始提示
        if (input.value.trim()) { lastQuery = ''; runSearch(input.value) }
        else renderStatus('', '<i class="fas fa-search nav-s-ico"></i>输入关键字检索文章、标签与内容')
      })
      .catch(function () {
        if (!panelOpen) return
        renderStatus('nav-search-error', '<i class="fas fa-exclamation-triangle nav-s-ico"></i>检索索引加载失败，请刷新后重试')
      })
  }

  function closePanel() {
    panelOpen = false
    nav.classList.remove('nav-search-open')
    btn.classList.remove('active')
    input.blur()
  }

  // 展开/收起切换(图标点击)
  btn.addEventListener('click', function (e) {
    e.preventDefault()
    e.stopPropagation()
    if (panelOpen) closePanel()
    else openPanel()
  })

  // 输入
  input.addEventListener('input', function () {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () { runSearch(input.value) }, 90)
  })
  // 高亮全选 / 快捷键
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { e.preventDefault(); closePanel(); return }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') return
  })

  // 点击导航外空白 → 收起(检索 wrap 内的点击不收起)
  document.addEventListener('pointerdown', function (e) {
    if (!panelOpen) return
    if (!wrap.contains(e.target) && !nav.contains(e.target)) closePanel()
  })
  // 滚动时也收起(浮层随滚动脱锚)
  window.addEventListener('scroll', function () {
    if (panelOpen) closePanel()
  }, { passive: true })
})()

/* 让旧浏览器不因缺少 NodeList.forEach 等出错(不需要, 现代浏览器OK) */
