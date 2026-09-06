/* ============================================================
   侧边栏抽屉遮罩状态管理 (custom inject)
   ---------------------------------------------------------------
   问题: 主题 main.js 关闭抽屉时【立即移除 .open】, 但 #sidebar-menus
   还要过渡 .5s 才完全滑出屏幕。mobile-fix.css 靠 body:has(.open) 隐藏
   顶部 #nav 的规则随之立即失效 → #nav 会瞬时浮回 z-index:999(抽搐闪烁
   的根源之一)。若改听 transitionstart 再标记, 事件派发晚于样式重算,
   中间仍可能漏出一帧导航。
   方案: 用 MutationObserver 观察 #sidebar-menus 的 class —— 在 .open
   被移除的【同一 DOM 批次(DOM 微任务, 早于下一帧渲染)】就给 body 加
   .sb-closing, mobile-fix.css 据此在整个收起动画期间继续隐藏 #nav;
   滑出结束(transitionend)移除, 并留 900ms 兜底计时器防漏。
   展开方向(加 .open)不受影响: 由 body:has(.open) 接管隐藏。
   依赖 mobile-fix.css(第 3 节的 media 规则)。
   ============================================================ */
(function () {
  'use strict'
  var sb = document.getElementById('sidebar-menus')
  if (!sb) return

  var body = document.body
  var wasOpen = sb.classList.contains('open') // 上批观察时的开合状态
  var fallbackTimer = null

  function clearClosing() {
    body.classList.remove('sb-closing')
  }

  // .open 被移除的瞬间标记: 与主题 close() 的 class 变更同批, 零渲染窗口
  var observer = new MutationObserver(function () {
    var open = sb.classList.contains('open')
    if (wasOpen && !open) {
      body.classList.add('sb-closing')
      clearTimeout(fallbackTimer)
      fallbackTimer = setTimeout(clearClosing, 900) // 兜底: 极端情况无 transitionend
    }
    wasOpen = open
  })
  observer.observe(sb, { attributes: true, attributeFilter: ['class'] })

  // 滑出动画结束 → 移除状态; 只认位移动画, 忽略其它属性过渡
  sb.addEventListener('transitionend', function (e) {
    if (e.propertyName !== 'transform') return
    clearClosing()
    clearTimeout(fallbackTimer)
  })
})()
