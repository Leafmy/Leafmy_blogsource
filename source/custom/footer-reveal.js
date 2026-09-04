/* ============================================================
   Footer reveal — hover grip (custom inject, v4)
   交互改为「鼠标移上去才滑出」(类似侧边栏悬浮按钮)：
   - 屏幕底部常驻一条极窄半透明 grip 热区条
   - 鼠标移入 grip（或滑出的 footer 本体）→ footer 从底部滑出
   - 鼠标离开 → footer 收回底部
   纯 CSS :hover 完成展示/收起，不依赖滚动位置，
   彻底消除此前"提前弹出 / 跨页继承"两类误弹。
   无 JS 时 grip 不插入，footer 保持主题文档流样式（CSS 由
   html.js 控制）。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const footer = document.querySelector('#footer')
  if (!footer) return

  // 在 footer 前插入 grip 热区（同属 body 子元素，可被相邻兄弟选择器命中）
  if (!document.querySelector('.footer-grip')) {
    const grip = document.createElement('div')
    grip.className = 'footer-grip'
    grip.setAttribute('aria-hidden', 'true')
    footer.parentNode.insertBefore(grip, footer)
  }
})()
