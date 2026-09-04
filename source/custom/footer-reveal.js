/* ============================================================
   Footer reveal (custom inject, v2)
   滚动到最底部 → footer 向上滑入(加 .ft-shown)；离开底部 →
   滑回隐藏。CSS 侧 footer 默认 fixed 于视口底部外，
   docH 恒定无弹跳。无 JS 时 footer 也正常(不显示悬浮，仅
   文档流样式) —— 由 CSS 的 fixed 保证。
   ============================================================ */
(function () {
  'use strict'

  // 标记 JS 已启用：CSS 仅在 html.js 下把 footer 改为 fixed 悬浮，
  // 无 JS 时 footer 保持普通文档流显示，功能不退化。
  document.documentElement.classList.add('js')

  const FOOTER_SEL = '#footer'
  const MARGIN = 4 // 距文档底部多近算“到达底部”(px)

  const getFooter = () => document.querySelector(FOOTER_SEL)
  const atBottom = () =>
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - MARGIN

  let ticking = false
  let wasBottom = null

  const update = () => {
    ticking = false
    const footer = getFooter()
    if (!footer) return
    const bottom = atBottom()
    if (bottom === wasBottom) return
    wasBottom = bottom
    footer.classList.toggle('ft-shown', bottom)
  }

  const schedule = () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(update)
    }
  }

  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)

  // 初始化状态：加载时是否已在底部
  const init = () => {
    const footer = getFooter()
    if (!footer) return
    wasBottom = atBottom()
    footer.classList.toggle('ft-shown', wasBottom)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
