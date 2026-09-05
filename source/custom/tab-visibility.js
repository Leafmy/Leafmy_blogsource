/* ============================================================
   标签页可见性优化 —— 降低"从后台唤醒/切换标签页"卡顿
   根因: .bg-liquid 全屏光斑层有 glass-liquid-drift 46s 的 CSS 动画,
   浏览器在标签页失焦时会对动画节流(throttling), 重新聚焦一瞬间会
   一次性重算该全屏动画 + 全部 backdrop-filter 模糊层 → 卡一下。
   方案: 监听 visibilitychange, 页面隐藏时给 <html> 加 .tab-hidden,
   CSS 据此暂停所有动画(animation-play-state: paused); 切回时移除。
   这样浏览器恢复时无需重算动画, 卡顿显著减轻。
   ============================================================ */
(function () {
  'use strict'

  function setHidden(hidden) {
    var root = document.documentElement
    if (hidden) {
      root.classList.add('tab-hidden')
    } else {
      root.classList.remove('tab-hidden')
    }
  }

  document.addEventListener('visibilitychange', function () {
    setHidden(document.hidden)
  })

  // 初始状态同步
  if (document.hidden) setHidden(true)
})()
