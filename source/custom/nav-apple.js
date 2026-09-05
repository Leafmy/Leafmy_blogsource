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
  // 性能（保证"跟手"）：
  //   1) nav 是 fixed 定位，rect 几乎不变 → 缓存，仅在 resize 时重测；
  //      避免每次 mousemove 都 getBoundingClientRect() 强制同步布局(reflow)。
  //   2) mousemove 事件频率远高于屏幕刷新率 → rAF 节流：一帧最多写一次
  //      CSS 变量，去掉每事件都触发样式重算造成的掉帧/滞后感。
  ;(function initGlow() {
    var rect = null
    var lastX = 0, lastY = 0 // 最近一次指针(视口坐标)，帧回调时使用
    var raf = null

    // 光斑做成独立合成层：裁剪容器 + 光斑元素，用 transform 平移。
    // transform 只走合成器(compositor)不触发重绘(paint)，比在 ::after 上
    // 移动 radial-gradient 中心省得多——后者每帧都要重绘整条导航栏。
    var clip = document.createElement('div')
    clip.className = 'nav-glow-clip'
    var spot = document.createElement('div')
    spot.className = 'nav-glow-spot'
    clip.appendChild(spot)
    nav.appendChild(clip)

    function measure() { rect = nav.getBoundingClientRect() }
    measure()
    window.addEventListener('resize', measure)

    function writeGlow() {
      raf = null
      if (!rect || !rect.width || !rect.height) return
      var px = lastX - rect.left
      var py = lastY - rect.top
      // 写像素坐标(px)：光斑用 transform 平移，边缘环 ::before 用 px 定位渐变中心
      nav.style.setProperty('--gx', px.toFixed(2) + 'px')
      nav.style.setProperty('--gy', py.toFixed(2) + 'px')
    }
    function track(e) {
      lastX = e.clientX
      lastY = e.clientY
      if (raf === null) raf = requestAnimationFrame(writeGlow)
    }
    nav.addEventListener('mousemove', track)
    // 进入时同步定位一次，避免光斑从默认位置跳变到指针处
    nav.addEventListener('mouseenter', function (e) {
      lastX = e.clientX
      lastY = e.clientY
      writeGlow()
    })
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
      if (isInLinkZone(item, e.clientX, e.clientY)) setOpen(item, true)
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
    if (on) {
      // 互斥：打开当前菜单项时，立即关闭其它所有菜单项的下拉面板，
      // 保证任一时刻只显示一个面板（否则从"最新文章"滑到"归档"时两会同开）。
      menus.forEach(function (m) {
        if (m !== item) { m.classList.remove('open'); cancelClose(m) }
      })
      item.classList.add('open')
      cancelClose(item)
    } else {
      item.classList.remove('open')
    }
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

  // ---- 触发区 / 保持区 分离（关键）----
  // 之前把"面板矩形"也当作触发区，两个面板水平方向重叠(都以按钮为中心向两侧扩
  // 240px，而两按钮中心间距仅~92px)，导致鼠标在「最新文章」面板里横向移动时，
  // 就提前命中了「归档」的面板矩形而被 setOpen 打开（用户反馈"还没移到归档就被触发"）。
  // 修复：两类区分开——
  //   触发区 = 按钮文字/图标 <a> 本体：鼠标真正移到按钮上才打开（且互斥）。
  //   保持区 = 面板本体 + 按钮与面板间的连接带：已打开的面板鼠标进入时保持不丢，
  //            但绝不触发其它面板。
  function isInLinkZone(item, x, y) {
    var r = item.querySelector('a.site-page, span.site-page')
    var base = (r && r.getBoundingClientRect && r.getBoundingClientRect()) || item.getBoundingClientRect()
    return x >= base.left && x <= base.right && y >= base.top && y <= base.bottom
  }
  function isInKeepZone(item, x, y) {
    var base = item.querySelector('a.site-page, span.site-page')
    var baseR = (base && base.getBoundingClientRect && base.getBoundingClientRect()) || item.getBoundingClientRect()
    var d = item.querySelector('.nav-drop')
    if (!d) return false
    var dr = d.getBoundingClientRect()
    // 面板本体
    if (x >= dr.left && x <= dr.right && y >= dr.top && y <= dr.bottom) return true
    // 连接带：按钮底(baseR.bottom)到面板顶(dr.top)之间的空隙（鼠标下滑时不丢）
    if (x >= baseR.left && x <= baseR.right && y >= baseR.bottom && y <= dr.top) return true
    return false
  }

  // 找到鼠标所在的"按钮文字区"菜单项（触发用）。按钮彼此不相交 → 最多一个。
  function linkHitItem(x, y) {
    var hit = null
    menus.forEach(function (item) {
      if (!item.querySelector('.nav-drop')) return
      if (isInLinkZone(item, x, y)) hit = item
    })
    return hit
  }

  // mousemove 挂在 document 上：鼠标移出 nav 后仍能触发，才能正常延时关闭。
  document.addEventListener('mousemove', function (e) {
    var x = e.clientX, y = e.clientY
    // 1) 鼠标在某按钮文字区上 → 打开它（setOpen 内部互斥关闭其它面板）。
    var linkHit = linkHitItem(x, y)
    if (linkHit) { setOpen(linkHit, true); return }

    // 2) 不在任何按钮文字区 → 只对已 open 的项做"保持/关闭"，绝不新开别的面板：
    //    鼠标仍在该项的面板/连接带内 → 保持；否则延时关闭。
    //    这样鼠标在「最新文章」面板里横向移动，即使进入两面板重叠区，
    //    只要不真正碰到「归档」按钮文字区，就不会提前打开归档。
    menus.forEach(function (item) {
      if (!item.querySelector('.nav-drop')) return
      if (!item.classList.contains('open')) return
      if (isInKeepZone(item, x, y)) cancelClose(item)
      else scheduleClose(item)
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
