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
  // 光斑做成独立合成层(.nav-glow-spot) + 边缘环(.nav-edge>.nav-edge-light)，
  // 位置全部由 JS【直写 style.transform】控制（不再用 CSS 变量，避免每帧
  // 变量传播/样式重算/背景重绘造成的拖影与跳动）。
  // 点亮范围：鼠标移动到光斑可影响导航栏的椭圆范围(96x76px)内即泛光，
  // 且亮度随距离渐变(--越近越亮)，苹果官网式"接近即泛光"。
  // 关键技巧：光心取"鼠标到导航栏矩形的最近投影点"(clamp)。
  //   - 鼠标在导航栏内 → 投影点=鼠标本身，光斑跟手(与原行为一致)；
  //   - 鼠标在导航栏外但靠近 → 投影点落在最近的边上，强光中心压在该边上，
  //     导航栏边缘明显被照亮且随鼠标滑动。
  // 性能：
  //   1) nav 是 fixed 定位，rect 几乎不变 → 缓存，仅 resize 时重测，
  //      避免每次 mousemove 都 getBoundingClientRect() 强制同步布局(reflow)。
  //   2) mousemove 事件频率远高于屏幕刷新率 → rAF 节流：一帧最多写一次
  //      transform；且仅在"已进入点亮范围"时才调度写入，范围外不写。
  ;(function initGlow() {
    var rect = null
    var lastX = 0, lastY = 0 // 最近一次指针(视口坐标)，帧回调时使用
    var raf = null
    var lastA = -1 // 最近一次写入的亮度(-1=从未写)，用于避免重复写 0
    // 淡出(移出范围/窗口)动画状态：从当前亮度线性衰减到 0
    var fadeRaf = null, fadeFrom = 0, fadeT0 = 0
    // 光斑径向渐变椭圆半径(px)：radial-gradient(96px 76px at 50% 50%) 的 ending-shape。
    // 以此作为"光效可影响导航栏"的范围，指针进入该椭圆即点亮。
    var RX = 96, RY = 76

    // 光斑做成独立合成层：裁剪容器 + 光斑元素，用 transform 平移。
    // transform 只走合成器(compositor)不触发重绘(paint)，比在 ::after 上
    // 移动 radial-gradient 中心省得多——后者每帧都要重绘整条导航栏。
    var clip = document.createElement('div')
    clip.className = 'nav-glow-clip'
    var spot = document.createElement('div')
    spot.className = 'nav-glow-spot'
    clip.appendChild(spot)
    // 边缘高亮环同款合成层：固定 mask 抠环 + 内嵌大渐变层(transform 直写平移)。
    // 绝不能再用 CSS 变量移动 ::before 的渐变中心(每帧变量传播+重绘=拖影/跳动)。
    var edge = document.createElement('div')
    edge.className = 'nav-edge'
    var edgeLight = document.createElement('div')
    edgeLight.className = 'nav-edge-light'
    edge.appendChild(edgeLight)
    clip.appendChild(edge)
    nav.appendChild(clip)

    function measure() { rect = nav.getBoundingClientRect() }
    measure()
    window.addEventListener('resize', measure)

    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

    // 把亮度写到光斑与边缘环 opacity（带 lastA 去重，全部直写 style）
    function setAlpha(a) {
      a = Math.max(0, Math.min(1, a))
      a = +a.toFixed(3)
      if (a === lastA) return
      spot.style.opacity = String(a)
      edge.style.opacity = String(a)
      lastA = a
    }
    // 计算某点的"目标亮度"：越近越亮(椭圆归一化距离的补数)
    function targetAlphaAt(x, y) {
      if (!rect || !rect.width || !rect.height) return 0
      var dx = 0, dy = 0
      if (x < rect.left) dx = rect.left - x
      else if (x > rect.right) dx = x - rect.right
      if (y < rect.top) dy = rect.top - y
      else if (y > rect.bottom) dy = y - rect.bottom
      var t = Math.sqrt((dx / RX) * (dx / RX) + (dy / RY) * (dy / RY))
      return Math.max(0, Math.min(1, 1 - t))
    }
    function inGlowRange(x, y) {
      return targetAlphaAt(x, y) > 0
    }
    // 写光斑位置(transform) + 边缘环光心(transform)；用最近投影点 clamp。
    // 全部直写 style，不经 CSS 变量 → 无每帧变量传播/样式重算，只走合成器。
    function writePos() {
      if (!rect) return
      var cx = clamp(lastX, rect.left, rect.right)
      var cy = clamp(lastY, rect.top, rect.bottom)
      var px = cx - rect.left
      var py = cy - rect.top
      spot.style.transform = 'translate3d(' + (px - 96).toFixed(2) + 'px,' + (py - 76).toFixed(2) + 'px,0)'
      // 边缘环光心：edgeLight 中心(800,200) 平移到 (px,py)
      edgeLight.style.transform = 'translate3d(' + (px - 800).toFixed(2) + 'px,' + (py - 200).toFixed(2) + 'px,0)'
    }
    // 常态跟手：一次 rAF 内位置+亮度直写目标值（无滞后，合成器动画）
    function writeGlow() {
      raf = null
      if (!rect) return
      writePos()
      setAlpha(targetAlphaAt(lastX, lastY))
    }

    // ---- 移入渐亮(淡入) ----
    // 鼠标从文档外进入(上方/侧边移回窗口)时，若直接落在光斑影响范围内，
    // 首个 mousemove 会瞬时全亮(突兀)。改为：进入后 ~FADE_IN_MS 内，
    // 亮度 = 目标亮度 × easeOut(进度)，从 0 平滑亮起；位置照常跟手。
    // 与"移出渐渐熄灭"对称，视觉更柔和统一。
    var FADE_IN_MS = 240
    var enterAt = 0    // 最近一次进入文档的时间戳；0=已在文档内
    var fadeInRaf = null
    function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3) }
    function onDocEnter(e) {
      if (e && typeof e.clientX === 'number') { lastX = e.clientX; lastY = e.clientY }
      enterAt = performance.now()
      // 进入瞬间若恰在淡出中，取消淡出改由淡入接管
      if (fadeRaf !== null) { cancelAnimationFrame(fadeRaf); fadeRaf = null }
      if (fadeInRaf === null) fadeInRaf = requestAnimationFrame(fadeInTick)
    }
    function fadeInTick(now) {
      fadeInRaf = null
      if (!enterAt) return // 已被取消/完成
      var k = (now - enterAt) / FADE_IN_MS
      var done = k >= 1
      var prog = done ? 1 : easeOutCubic(k)
      if (done) enterAt = 0
      writePos() // 位置跟手
      setAlpha(targetAlphaAt(lastX, lastY) * prog)
      if (!done) {
        fadeInRaf = requestAnimationFrame(fadeInTick)
      } else if (raf === null && inGlowRange(lastX, lastY)) {
        raf = requestAnimationFrame(writeGlow) // 回到常态直写
      }
    }
    function cancelFadeIn() {
      if (fadeInRaf !== null) { cancelAnimationFrame(fadeInRaf); fadeInRaf = null }
      enterAt = 0
    }

    function track(e) {
      lastX = e.clientX
      lastY = e.clientY
      // 淡入进行中：坐标已更新，位置/亮度由 fadeInTick 每帧写入，无需重复调度
      if (fadeInRaf !== null) {
        if (!inGlowRange(lastX, lastY)) { cancelFadeIn(); fadeOut() }
        return
      }
      // 仅当鼠标进入"光斑可影响导航栏"的椭圆范围才调度写入并点亮
      if (inGlowRange(lastX, lastY)) {
        if (raf === null) raf = requestAnimationFrame(writeGlow)
      } else {
        // 完全离开范围：取消待写帧，从当前亮度渐渐淡出（250ms）
        if (raf !== null) { cancelAnimationFrame(raf); raf = null }
        fadeOut()
      }
    }
    // 渐隐淡出：从当前亮度在 ~250ms 内线性衰减到 0（每次 mousemove 离开范围
    // 时若已在淡出则不重启，只有从有光到无光才启动一次）
    function fadeOut() {
      if (fadeRaf !== null) return // 已在淡出，不重启
      if (lastA <= 0) return
      fadeFrom = lastA
      fadeT0 = performance.now()
      var step = function (now) {
        var k = Math.min(1, (now - fadeT0) / 250)
        var a = fadeFrom * (1 - k)
        if (k >= 1) { fadeRaf = null; setAlpha(0); return }
        setAlpha(a)
        fadeRaf = requestAnimationFrame(step)
      }
      fadeRaf = requestAnimationFrame(step)
    }
    // 立即熄灭（窗口 blur 用：窗口已不可见，淡出无意义且 rAF 可能被节流）
    function extinguishNow() {
      cancelFadeIn()
      if (fadeRaf !== null) { cancelAnimationFrame(fadeRaf); fadeRaf = null }
      if (raf !== null) { cancelAnimationFrame(raf); raf = null }
      setAlpha(0)
    }
    // 挂在 document：鼠标从正文/窗口其它区域接近导航栏时也能点亮，
    // 离开范围后自动渐渐熄灭（每次 mousemove 重新判定）
    document.addEventListener('mousemove', track)
    // 顶部导航栏：鼠标向上移出浏览器窗口后 DOM 不再有 mousemove，光效会
    // 卡在移出前的位置 → 监听"鼠标离开文档"触发渐渐熄灭。
    //   - documentElement.mouseleave：鼠标离开 <html> 边界(含移出窗口)触发；
    //   - document mouseout 且 relatedTarget===null：同样表示离开文档进入
    //     浏览器 UI / 视口外，作为兜底（mouseleave 在某些情况不冒泡可靠）。
    document.documentElement.addEventListener('mouseleave', fadeOut)
    document.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget) fadeOut()
    })
    // 移入渐亮：鼠标从文档外进入页面（mouseover 的 relatedTarget 为 null，
    // 或 documentElement mouseenter），若落在光斑范围则从 0 平滑亮起。
    document.documentElement.addEventListener('mouseenter', onDocEnter)
    document.addEventListener('mouseover', function (e) {
      if (!e.relatedTarget) onDocEnter(e)
    })
    window.addEventListener('blur', extinguishNow)
  })()

  // ---- 悬浮下拉：最新文章 / 归档 ----
  var menus = nav.querySelectorAll('.menus_items .menus_item')
  var cache = {} // url -> [{ title, href }]

  // 抓取目标页面的链接列表（利用同源 fetch + 模板解析，避免依赖已启用搜索）
  // url: 抓取页; selector: 链接选择器; titleSel: 可选，取链接内更精确的标题节点
  function fetchArticles(url, selector, titleSel) {
    if (cache[url]) return Promise.resolve(cache[url])
    return fetch(url, { credentials: 'same-origin' })
      .then(function (r) { return r.text() })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html')
        var out = []
        doc.querySelectorAll(selector).forEach(function (a) {
          var tEl = titleSel ? a.querySelector(titleSel) : null
          var title = tEl ? tEl.textContent : (a.getAttribute('title') || a.textContent)
          out.push({
            title: title.replace(/\s+/g, ' ').trim(),
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

    // 面板内指针光斑（同款光效语言）：transform 直写，跟随面板内指针
    var dropGlow = document.createElement('div')
    dropGlow.className = 'nav-drop-glow'
    drop.appendChild(dropGlow)

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
    // fetch 是异步的：面板可能在鼠标静止(悬停按钮)后才构建完，
    // 此时没有新的 mousemove tick 来定位 glow → 立即用最近坐标初始化一次
    if (item.classList.contains('open')) updateDropGlow(dropX, dropY)
  }

  // 更新已打开下拉面板内的指针光斑：光心 = 指针 clamp 到面板矩形内，
  // 用 transform 直写(合成层)，鼠标在面板上时毛玻璃泛起与导航一致的辉光。
  function updateDropGlow(x, y) {
    menus.forEach(function (item) {
      if (!item.classList.contains('open')) return
      var glow = item.querySelector('.nav-drop .nav-drop-glow')
      if (!glow) return
      var r = glow.parentNode.getBoundingClientRect()
      if (!r.width || !r.height) return
      var gx = (x < r.left ? r.left : (x > r.right ? r.right : x)) - r.left
      var gy = (y < r.top ? r.top : (y > r.bottom ? r.bottom : y)) - r.top
      // glow 260x180，中心(130,90)平移到指针
      glow.style.transform = 'translate3d(' + (gx - 130).toFixed(2) + 'px,' + (gy - 90).toFixed(2) + 'px,0)'
    })
  }

  // 菜单 href → 下拉配置
  // 文章：首页最近文章标题；归档：归档页侧栏的"月度归档"入口(如 九月 2026 → /archives/2026/09/)
  var config = [
    { href: '/', label: '文章', selector: '.recent-post-items a.article-title' },
    { href: '/archives/', label: '归档', selector: '.card-archive-list-link', titleSel: '.card-archive-list-date' }
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
      fetchArticles(conf.href, conf.selector, conf.titleSel)
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
  // 与光斑一样用 rAF 节流：一帧最多做一次命中判定/几何读取，避免高频
  // mousemove 下反复 getBoundingClientRect(强制样式/layout flush)拖累跟手。
  var dropX = 0, dropY = 0, dropRaf = null
  function updateDrop() {
    dropRaf = null
    var x = dropX, y = dropY
    // 1) 鼠标在某按钮文字区上 → 打开它（setOpen 内部互斥关闭其它面板）。
    var linkHit = linkHitItem(x, y)
    if (linkHit) setOpen(linkHit, true)
    else {
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
    }
    // 3) 已打开面板内的指针光斑跟随（每次 tick 更新；无 open 面板则跳过）
    updateDropGlow(x, y)
  }
  document.addEventListener('mousemove', function (e) {
    dropX = e.clientX
    dropY = e.clientY
    if (dropRaf === null) dropRaf = requestAnimationFrame(updateDrop)
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
