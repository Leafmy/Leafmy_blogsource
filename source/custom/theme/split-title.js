/* ============================================================
   站名「启明」的描边动画组装（stroke draw）
   (source/custom/theme/split-title.js)
   ------------------------------------------------------------
   把 hero 站名的文字替换成内联 SVG：每条字形轮廓一个 <path>，
   由 CSS 用 stroke-dasharray/dashoffset 逐笔画出轮廓，画完再整体浮出填充。

   [为什么必须是 SVG 路径]
   纯 CSS 的 `-webkit-text-stroke` 只能整条淡入淡出 —— 它没有"路径长度"这个
   量，做不了 dash 动画。字形轮廓由 tools/gen-title-svg.js 从系统字体
   （Noto Serif SC 的 glyf 表）提取，烘焙成 source/custom/theme/title-paths.js。

   [为什么每条轮廓单独一个 <path>]
   SVG 的 stroke-dasharray/dashoffset 对一条 path 内的多条子路径是**连续**
   计算的：18 条轮廓合成一条 path 会被当成一根长线依次描出，视觉上是
   "绕着字一路画"。拆开才是"每一笔各自出现"。

   [尺寸为什么给 em 而不是像素数]
   SVG 的 `width="857"` 会被当成 **857px**（与 viewBox 无关）—— 实测标题
   因此从文字宽 273px 撑到 938px。所以宽高都按 em 比例给：
     width: calc(--qm-w * 1em)   （--qm-w = 该字宽 / 字体 em 单位）
   字号一变整体等比缩放，stroke-width 也能直接用 em 换算。

   [兜底] 没有 title-paths.js / 文本与路径不匹配时：**保留原文字**，
   由 custom-font.css 的 qmTextFallback 退化成"描边亮起 → 填充浮出"。

   [为什么组装要包在 html.qm-pending 里 —— 这是"进站闪一下"的根因]
   <h1> 的文字是 HTML 解析到 hero 时就存在的，而本脚本在文档靠后的位置执行。
   中间那段时间浏览器**会先画一帧纯文字**，而 custom-font.css 里
   `#site-title:not([data-qm])` 的兜底动画（0% = 填充透明 + 2.6px 描边）会立刻
   开始 —— 用户看到的就是"启明 完整轮廓亮一下（无填充），然后消失、重新逐笔描"。
   实测（.perf/probe-title-fouc.js，无头冷启动）：文字带描边可见 132~480ms，
   真机更慢时能到一秒。
   所以：inject_head_js.js 在 <head> 里最早打上 html.qm-pending（CSS 据此把
   hero 站名 visibility:hidden），本脚本无论成功还是兜底都在同一个任务里摘掉它 ——
   同一任务内的加/删不会产生中间帧，文字因此**一帧都不会被画出来**。
   ============================================================ */
(function () {
  'use strict'

  var SVG_NS = 'http://www.w3.org/2000/svg'
  var STAGGER = 0.075   // 每条轮廓的错峰（秒），与 CSS 里 .55s 单条时长配套

  function buildSvg () {
    var el = document.querySelector('#page-header.full_page #site-title')
    if (!el) return false
    if (el.querySelector('svg')) return false            // 幂等
    var glyphs = window.__titleGlyphs
    if (!glyphs || !glyphs.length) return false          // 没有路径数据 → 保留文字
    var text = (el.textContent || '').replace(/\s+/g, '')
    if (text !== glyphs.map(function (g) { return g.ch }).join('')) return false

    /* 先按 Z 切出每条子路径，避免在循环里反复 split */
    var frag = document.createDocumentFragment()
    var order = 0
    for (var i = 0; i < glyphs.length; i++) {
      var g = glyphs[i]
      var segs = g.d.split('Z').filter(function (s) { return s.trim() })
      if (segs.length !== g.lengths.length) continue     // 数据不一致 → 不冒险

      var svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('class', 'qm')
      svg.setAttribute('viewBox', '0 0 ' + g.w + ' ' + g.h)
      svg.setAttribute('aria-hidden', 'true')
      svg.setAttribute('focusable', 'false')
      /* 显示尺寸走 em 比例；高度也显式给，否则 inline-block 的 SVG 会被
         line-height 影响、与字形比例不符。 */
      svg.style.setProperty('--qm-w', String(g.wEm))
      svg.style.setProperty('--qm-h', String(g.hEm))

      for (var k = 0; k < segs.length; k++) {
        var p = document.createElementNS(SVG_NS, 'path')
        p.setAttribute('d', segs[k] + 'Z')
        /* [长度必须是"无单位数值"] keyframes 里写的是
           `stroke-dashoffset: var(--qm-len)`，而 dashoffset 在 CSS 里接受
           <length-percentage>|number —— 塞一个 "458.7px" 进去直接算不出来，
           实测逐帧读到 NaN。dasharray/dashoffset 的**属性**则只用数字，
           所以同一份数值两处都能用，统一传无单位。 */
        var len = +(g.lengths[k] * 1.02).toFixed(1)      // ×1.02 保证描完不留缺口
        p.setAttribute('stroke-dasharray', String(len))
        p.setAttribute('stroke-dashoffset', String(len))
        p.style.setProperty('--qm-len', String(len))
        p.style.setProperty('--qm-delay', (order * STAGGER).toFixed(3) + 's')
        order++
        svg.appendChild(p)
      }
      frag.appendChild(svg)
    }
    if (!order) return false                             // 一条都没组出来 → 保留文字

    el.textContent = ''
    el.appendChild(frag)
    el.setAttribute('data-qm', 'svg')                    // 关掉纯文字兜底动画
    armDrawing(el)
    return true
  }

  /* ============================================================
     动画起点：**显式接管，不用 CSS 的隐式起始时刻**
     ------------------------------------------------------------
     [为什么必须接管 —— "描字动画没了"的根因]
     CSS 动画的起点是"元素第一次被样式解析"那一刻决定的。组装脚本现在紧跟在
     hero 之后执行（这是为了不再闪纯文字），也就是页面还在解析、后面十几个
     同步脚本（含 WebGL 场景初始化、星表解析）都还没跑的时候。而
     `stroke-dashoffset` / `fill-opacity` **都不是合成器动画**：主线程一旦被
     占住，动画的时钟照走、却一帧也画不出来；等主线程空下来，这 2.8 秒已经
     过去了 —— 用户看到的就是画完的静态标题。
     [实测] 早期版本把动画起点交给浏览器隐式决定，本机快（首帧 ~0.8s）时能
     看到逐笔；一旦主线程被占住（慢网络 + 慢机器，或部署在 GitHub Pages 上
     二十来个脚本逐个下载执行），动画就在"看不见的时候"跑完了。

     [做法] 组装完立刻把这一批动画（18 条 qmDraw + 18 条 qmFillIn）
     pause 在 currentTime = 0，然后等 **DOMContentLoaded**
     （= 解析结束、所有同步脚本都跑完、主线程空出来）之后的第一个 rAF 再
     `play()`。rAF 只在浏览器真能出帧时才触发，等于"等页面画得动了再落笔"。
     pjax 换页时文档已经 ready，直接走这条路（同样等一个 rAF）。
     老浏览器没有 WAAPI：函数直接返回，退回 CSS 的隐式起点，不影响功能。
     ============================================================ */
  function armDrawing (el) {
    if (!document.getAnimations) return
    var anims = document.getAnimations().filter(function (a) {
      var target = a.effect && a.effect.target
      if (!target || !target.tagName || target.tagName.toLowerCase() !== 'path') return false
      var svg = target.parentNode
      return !!(svg && svg.getAttribute && svg.getAttribute('class') === 'qm')
    })
    if (!anims.length) return

    var held = false
    anims.forEach(function (a) {
      try { a.pause(); a.currentTime = 0; held = true } catch (e) {}
    })
    if (!held) return

    var started = false
    var go = function () {
      if (started) return
      started = true
      /* 等到"能出帧"的那一帧：主线程还被占着时这个回调会一直往后推 */
      requestAnimationFrame(function () {
        anims.forEach(function (a) {
          try { a.currentTime = 0; a.play() } catch (e) {}
        })
      })
    }
    if (document.readyState === 'interactive' || document.readyState === 'complete') go()
    else document.addEventListener('DOMContentLoaded', go, { once: true })
    /* 保命：解析异常慢（或同步脚本报错卡住）也不能让站名一直空着 */
    setTimeout(go, 6000)
  }

  /* 组装期间藏住 hero 站名（CSS 见 custom-font.css 的 html.qm-pending 那条）。
     加/删都在同一个任务里完成 ⇒ 不产生中间帧 ⇒ 纯文字一帧都不会被画出来。
     pjax 换页走的是同一个入口：新 header 刚插进来就同步摘掉标记。 */
  function build () {
    var root = document.documentElement
    root.classList.add('qm-pending')
    try {
      return buildSvg()
    } finally {
      root.classList.remove('qm-pending')
    }
  }

  build()
  /* pjax 会替换 #body-wrap，那时标题是新的、没换过 */
  if (window.btf && typeof window.btf.addGlobalFn === 'function') {
    window.btf.addGlobalFn('pjaxComplete', build, 'buildTitleSvg')
  } else {
    document.addEventListener('pjax:complete', build)
  }
})()
