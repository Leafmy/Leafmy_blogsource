/* ============================================================
   标签页可见性优化 —— 降低"从后台唤醒/切换标签页"卡顿
   背景: 页面上存在若干常驻 CSS 动画(如导航搜索光标的呼吸动画、
   设置按钮的 fa-spin), 浏览器在标签页失焦时会对动画节流
   (throttling), 重新聚焦一瞬间可能一次性重算 + 重绘全部
   动画层与 backdrop-filter 模糊层 → 卡一下。
   方案: 监听 visibilitychange, 页面隐藏时给 <html> 加 .tab-hidden,
   CSS 据此暂停所有动画(animation-play-state: paused); 切回时移除。
   这样浏览器恢复时无需重算动画, 卡顿显著减轻。
   注: 原先注释里提到的 .bg-liquid 46s 漂移动画已移除
   (那个动画正是滚动/唤醒掉帧主因, 已改为静态光斑),
   但"后台暂停全部动画"对剩余的呼吸/旋转动画依然有效, 保留。
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
