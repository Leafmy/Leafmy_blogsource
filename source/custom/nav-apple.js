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
  document.body.appendChild(nav)

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

    item.addEventListener('mouseenter', function () {
      fetchArticles(conf.href, conf.selector)
        .then(function (articles) { buildPanel(item, conf.label, articles) })
        .catch(function () { buildPanel(item, conf.label, []) })
    })

    // 移动端（无 hover，触屏）：点击切换 .open 显示面板
    // 用 matchMedia('(hover: none)') 判断触摸设备；PC 上仍让链接直接跳转
    link.addEventListener('click', function (e) {
      if (!window.matchMedia || !window.matchMedia('(hover: none)').matches) return
      e.preventDefault()
      var wasOpen = item.classList.contains('open')
      // 关闭其它
      menus.forEach(function (m) { m.classList.remove('open') })
      if (!wasOpen) item.classList.add('open')
    })
  })

  // 触摸设备点击页面其它区域时关闭 open 面板
  document.addEventListener('click', function (e) {
    if (window.matchMedia && window.matchMedia('(hover: none)').matches && !nav.contains(e.target)) {
      menus.forEach(function (m) { m.classList.remove('open') })
    }
  })
})()
