/* ============================================================
   顶部导航栏 Apple/macOS 毛玻璃固定定位 (custom inject)
   -----------------------------------------------
   问题：#page-header 有 backdrop-filter（hero 玻璃），它会创建
   containing block，使 #nav 的 position:fixed 相对 page-header 而非
   视口定位 → 滚动时导航栏跟着 page-header 一起被带走（top 变负）。
   方案：页面加载后把 #nav 移动到 body 下（脱离 page-header 的
   包含块），实现真正的视口 fixed 悬浮毛玻璃。
   -----------------------------------------------
   附加功能：悬浮「最新文章 / 归档」时向下展开文章列表。
   数据源：
     - 最新文章 → 首页 .recent-post-items .article-title
     - 归档     → 归档页 .article-sort-item-title
   懒加载 + 缓存，首次悬停时才 fetch 并解析对应页面。
   依赖 nav-apple.css（毛玻璃样式 + .nav-drop 面板样式）。
   ============================================================ */
(function () {
  'use strict'
  var nav = document.querySelector('#nav')
  if (!nav) return

  // 移动到 body 下（保持 fixed 视口定位）
  document.body.appendChild(nav);

  // ---- 指针周围局部光斑（跟随鼠标） ----
  // 光斑用 nav::after 的 radial-gradient 定位在 --gx/--gy（相对 nav 内坐标 %）。
  // mousemove 时换算指针相对 nav 的百分比并写入 CSS 变量，光斑即跟随指针。
  ;(function initGlow() {
    var set = function (e) {
      var r = nav.getBoundingClientRect()
      var px = e.clientX - r.left
      var py = e.clientY - r.top
      var x = Math.max(0, Math.min(100, (px / r.width) * 100)).toFixed(2)
      var y = Math.max(0, Math.min(100, (py / r.height) * 100)).toFixed(2)
      nav.style.setProperty('--gx', x + '%')
      nav.style.setProperty('--gy', y + '%')
    }
    nav.addEventListener('mousemove', set)
    // 进入时先定位一次，避免光斑停留在默认 50% 处
    nav.addEventListener('mouseenter', set)
  })()

  // ---- 悬浮下拉：最新文章 / 归档 ----
  var menus = nav.querySelectorAll('.menus_items .menus_item')
  var cache = {} // url -> [{ title, href }]

  // 抓取目标页面的文章标题链接（利用同源 fetch + 模板解析，避免依赖已启用搜索）
  function fetchArticles(url, selector) {
    if (cache[url]) return Promise.resolve(cache[url])
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.text() })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html')
        var out = []
        doc.querySelectorAll(selector).forEach(function (a) {
          out.push({
            title: (a.getAttribute('title') || a.textContent).replace(/\s+/g, ' ').trim(),
            href: a.getAttribute('href')
          })
        })
        cache[url] = out
        return out
      })
  }

  // 构建下拉面板（仅首次构建）
  function buildPanel(item, label, articles) {
    if (item.querySelector('.nav-drop')) return
    var drop = document.createElement('div')
    drop.className = 'nav-drop'

    var head = document.createElement('div')
    head.className = 'nav-drop-head'
    head.textContent = label
    drop.appendChild(head)

    var list = document.createElement('ul')
    list.className = 'nav-drop-list'
    if (!articles.length) {
      var empty = document.createElement('li')
      empty.className = 'nav-drop-empty'
      empty.textContent = '暂无文章'
      list.appendChild(empty)
    } else {
      articles.slice(0, 8).forEach(function (a) {
        var li = document.createElement('li')
        var link = document.createElement('a')
        link.href = a.href
        link.textContent = a.title
        li.appendChild(link)
        list.appendChild(li)
      })
    }
    drop.appendChild(list)
    item.appendChild(drop)
  }

  // 菜单 href → 下拉配置
  var config = [
    { href: '/', label: '最新文章', selector: '.recent-post-items a.article-title' },
    { href: '/archives/', label: '归档', selector: '.article-sort-item-title' }
  ]

  menus.forEach(function (item) {
    var link = item.querySelector('a.site-page')
    if (!link) return
    var href = link.getAttribute('href')
    var conf = null
    config.forEach(function (c) { if (c.href === href) conf = c })
    if (!conf) return

    item.addEventListener('mouseenter', function (e) {
      // 是否打开：若鼠标此刻已在"文字/图标<a>"区内则打开；否则交给 mousemove 状态机。
      // 避免指针刚触碰胶囊边缘(padding 留白)就弹面板（用户嫌检测范围太大）。
      if (inOpenZone(item, e.clientX, e.clientY)) setOpen(item, true)
      fetchArticles(conf.href, conf.selector)
        .then(function (articles) { buildPanel(item, conf.label, articles) })
        .catch(function () { buildPanel(item, conf.label, []) })
    })

    // 触屏/点击打开下拉：无 hover 的触屏设备点菜单切换 .open
    link.addEventListener('click', function (e) {
      var isTouch = window.matchMedia && (window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches)
      if (!isTouch) return // 桌面不拦截，链接直接跳转（有 mousemove 状态机）
      e.preventDefault()
      var wasOpen = item.classList.contains('open')
      menus.forEach(function (m) { m.classList.remove('open') })
      if (!wasOpen) item.classList.add('open')
    })
  })

  // 触屏设备点击页面其它区域时关闭 open 面板
  document.addEventListener('click', function (e) {
    var isTouch = window.matchMedia && (window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches)
    if (isTouch && !nav.contains(e.target)) {
      menus.forEach(function (m) { m.classList.remove('open') })
    }
  })

  // ---- 可靠的开启/关闭状态机 ----
  // 纯 CSS :hover + 悬停桥在"菜单项↔面板"的间隙会丢 hover 导致闪烁。
  // 改为：在 nav 上监听 mousemove，判断鼠标是否落在"菜单项矩形 ∪ 面板矩形"
  // 内；在范围内保持 .open，完全离开后延时关闭。坐标判定永不丢 hover。
  var closeTimers = {}

  function setOpen(item, on) {
    if (on) { item.classList.add('open'); cancelClose(item) }
    else { item.classList.remove('open') }
  }
  function cancelClose(item) {
    var key = menuKey(item)
    if (closeTimers[key]) { clearTimeout(closeTimers[key]); delete closeTimers[key] }
  }
  // 只在没有 timer 时启动一次关闭，避免鼠标在 zone 外移动时反复重置计时
  function scheduleClose(item, delay) {
    var key = menuKey(item)
    if (closeTimers[key]) return
    closeTimers[key] = setTimeout(function () {
      // 关闭前再确认鼠标是否真的不在 zone 内（防误关）
      if (!item.matches(':hover')) {
        var d = item.querySelector('.nav-drop')
        if (!(d && d.matches(':hover'))) item.classList.remove('open')
      }
      delete closeTimers[key]
    }, delay || 240)
  }
  function menuKey(item) {
    var a = item.querySelector('a.site-page')
    return (a && a.getAttribute) ? a.getAttribute('href') || 'x' : 'x'
  }

  // 命中检测：鼠标是否在某个含 .nav-drop 的菜单项自身或其面板范围内
  // 触发区收窄到"文字/图标<a>"本身(而非含 padding 的 .menus_item 胶囊)，
  // 避免指针在 11px 视觉留白上就误触发弹出（用户嫌检测范围太大）。
  function inOpenZone(item, x, y) {
    var r = item.querySelector('a.site-page, span.site-page')
    // 优先用链接< a> 作为触发区，失败则退回菜单项矩形
    var base = (r && r.getBoundingClientRect && r.getBoundingClientRect()) || item.getBoundingClientRect()
    if (x >= base.left && x <= base.right && y >= base.top && y <= base.bottom) return true
    var d = item.querySelector('.nav-drop')
    if (d) {
      var dr = d.getBoundingClientRect()
      if (x >= dr.left && x <= dr.right && y >= dr.top && y <= dr.bottom) return true
      // 连通带：链接底部(inOpenZone 用 base)到面板顶部之间的空隙也算 zone（鼠标下滑时不丢）
      if (x >= base.left && x <= base.right && y >= base.bottom && y <= dr.top) return true
    }
    return false
  }

  // mousemove 挂在 document 上：鼠标移出 nav 后仍能触发，才能正常延时关闭。
  document.addEventListener('mousemove', function (e) {
    var x = e.clientX, y = e.clientY
    menus.forEach(function (item) {
      if (!item.querySelector('.nav-drop')) return // 未构建面板的菜单项忽略
      if (inOpenZone(item, x, y)) {
        setOpen(item, true)
      } else {
        // 不在范围内，但若当前 open，启动延时关闭（鼠标移出 zone 才关）
        if (item.classList.contains('open')) scheduleClose(item)
      }
    })
  })
  // 失焦兜底：切走窗口时关闭所有已打开面板
  window.addEventListener('blur', function () {
    menus.forEach(function (m) { m.classList.remove('open') })
  })

  // 触屏设备点击页面其它区域时关闭 open 面板
  document.addEventListener('click', function (e) {
    var isTouch = window.matchMedia && (window.matchMedia('(hover: none)').matches || window.matchMedia('(pointer: coarse)').matches)
    if (isTouch && !nav.contains(e.target)) {
      menus.forEach(function (m) { m.classList.remove('open') })
    }
  })
})()
