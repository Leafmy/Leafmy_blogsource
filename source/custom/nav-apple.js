/* ============================================================
   顶部导航栏 Apple/macOS 毛玻璃固定定位 (custom inject)
   -----------------------------------------------
   问题：#page-header 有 backdrop-filter（hero 玻璃），它会创建
   containing block，使 #nav 的 position:fixed 相对 page-header 而非
   视口定位 → 滚动时导航栏跟着 page-header 一起被带走（top 变负）。
   方案：页面加载后把 #nav 移动到 body 下（脱离 page-header 的
   包含块），实现真正的视口 fixed 悬浮毛玻璃。
   依赖 nav-apple.css（毛玻璃样式）。
   ============================================================ */
(function () {
  'use strict'
  var nav = document.querySelector('#nav')
  if (!nav) return

  // 移动到 body 下（保持 fixed 视口定位）
  document.body.appendChild(nav)
})()
