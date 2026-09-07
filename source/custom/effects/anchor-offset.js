/* ============================================================
   Anchor Offset Guard (anchor-offset.js)
   ------------------------------------------------------------
   问题：点击目录(TOC)跳转时，目标标题会被【始终悬浮 fixed】的
   顶部导航(nav-apple.css: top 12px + height 54px, 底边 66px)
   遮住 —— 标题落点几乎贴住视口顶(=0)，被 66px 导航覆盖。

   根因：主题 btf.scrollToDest(utils.js) 只在「向上滚」或
   #page-header 带 .fixed class 时才减 70px 偏移。而本主题的
   导航始终 fixed，且向下点目录时 #page-header.fixed 未加上，
   → 偏移不生效 → 标题与导航重合。

   方案：wrap btf.scrollToDest，注入基于【实际导航底部高度】的
   统一偏移。向上滚(标题在视口上方)与向下滚(TOC 点下方标题)都
   让出导航，标题稳定落在导航下方。向下滚时才加偏移(避免向上
   回顶端/首页时额外多滚)。

   兼容性：
   - 保留原 scrollToDest 的 smooth 滚动 + easeOutQuart 缓动
   - 用 requestAnimationFrame 包装，避免 window.scrollTo 被
     page-header 的 nav-fixed 定位逻辑干扰
   - 空值/异常安全，未加载 btf 时不抛错
   ============================================================ */
(function () {
  'use strict'

  // 等待 btf 就绪（inject.bottom 在 utils.js 之后加载，通常已就绪；兜底轮询）
  function patchWhenReady() {
    if (window.btf && typeof window.btf.scrollToDest === 'function') {
      patch()
      return true
    }
    return false
  }

  function patch() {
    if (window.__anchorOffsetPatched) return
    window.__anchorOffsetPatched = true

    var original = window.btf.scrollToDest

    // 计算导航底边高度（避让量）；拿不到导航时回退 74px
    function navOffset() {
      var nav = document.getElementById('nav')
      if (nav) {
        // 用 getBoundingClientRect 拿到视觉底边（含边框/变换），
        // 再加一个视觉余量，让标题与导航之间留出呼吸感。
        var rect = nav.getBoundingClientRect()
        // rect.top 是相对视口的，滚动时可能为负？导航 fixed 所以 rect.top
        // 恒等于其 fixed 定位 top(12)。取 rect.bottom 即导航底边(66)。
        var bottom = rect.bottom > 0 ? rect.bottom : 66
        return Math.round(bottom + 12) // 导航底边 + 12px 余量 → 78px
      }
      return 78
    }

    window.btf.scrollToDest = function (pos, time) {
      var currentPos = window.scrollY
      // 目标在视口上方(向下滚到上方标题)或向下滚(目标在下方)——
      // 只有目标落点 < 当前位置时才需避让(标题会跑到导航下方? 否)
      // 正确逻辑：TOC 点「下方更深」的标题(向下滚)，标题顶部会贴住视口顶，
      // 必须让出导航；点「上方」标题(向上滚)也需让出，否则同样被盖。
      // 统一：目标绝对位置 >= 导航底边偏移时都避让，避免标题顶贴视口顶。
      var offset = navOffset()
      var targetPos = pos
      // 若目标比当前滚动位置大(向下滚向更深内容)，或目标接近顶部，
      // 都让出导航。简单起见：只要 pos 不是 0(回到顶部)，一律让出。
      if (pos > 0) {
        targetPos = pos - offset
      }

      if ('scrollBehavior' in document.documentElement.style) {
        window.scrollTo({
          top: Math.max(0, targetPos),
          behavior: 'smooth'
        })
        return
      }

      // 无平滑支持：手动缓动(rAF)
      var timeS = (typeof time === 'number' && time > 0) ? time : 500
      var startTime = performance.now()
      var startPos = currentPos
      var dest = Math.max(0, targetPos)
      var animate = function (currentTime) {
        var elapsed = currentTime - startTime
        var progress = Math.min(elapsed / timeS, 1)
        var eased = 1 - Math.pow(1 - progress, 4)
        window.scrollTo(0, startPos + (dest - startPos) * eased)
        if (progress < 1) requestAnimationFrame(animate)
      }
      requestAnimationFrame(animate)
    }
  }

  // 立即尝试；若 btf 尚未加载，等待 DOMContentLoaded 后再试一次
  if (!patchWhenReady()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', patchWhenReady)
    } else {
      // btf 可能在稍后才挂载，轮询几次
      var tries = 0
      var timer = setInterval(function () {
        tries++
        if (patchWhenReady() || tries > 50) clearInterval(timer)
      }, 100)
    }
  }
})()
