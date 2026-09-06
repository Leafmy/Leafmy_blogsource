/* ============================================================
   Footer — normal document-flow footer (custom inject, v5)
   回归普通网站形态：footer 随内容正常排版在页面最底部，
   默认直接显示，滚动到底即可看到，不再悬浮、不再 hover 触发。
   本文件只做一件小事：标记 html.js，供 CSS 控制玻璃背景。
   ============================================================ */
(function () {
  'use strict'
  document.documentElement.classList.add('js')
})()
