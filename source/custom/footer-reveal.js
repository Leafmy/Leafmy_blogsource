/* ============================================================
   Footer reveal (custom inject, v3)
   滚动到页面最底部 → footer 向上滑入(加 .ft-shown)；离开
   底部 → 滑回隐藏。CSS 侧 footer fixed 于视口底部，docH 恒定。

   v3 修复两个误弹问题：
   1) 「不到最底部也弹出」：页面加载初期(尤其图片懒加载未完成)
      文档高度偏小 → atBottom() 误判到底。v3 在 load 事件与
      文档高度变化时重新评估，自动纠正。
   2) 「上页弹出状态继承到下页」：浏览器会恢复滚动位置，新页面
      加载时若位置接近底部会立即判定到底。v3 增加 userIntent
      门槛：未发生用户主动滚动(wheel/touch/键盘)前一律不显示，
      恢复的滚动位置不触发 footer。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const FOOTER_SEL = '#footer'
  const MARGIN = 6 // 距文档底部多近算“到达底部”(px)

  const getFooter = () => document.querySelector(FOOTER_SEL)
  const getScrollY = () => window.scrollY || document.documentElement.scrollTop || 0
  const atBottom = () => {
    const doc = document.documentElement
    const maxScroll = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0)
    return window.innerHeight + getScrollY() >= maxScroll - MARGIN
  }

  let ticking = false
  let wasBottom = null
  let userIntent = false // 用户是否主动滚动过

  const update = () => {
    ticking = false
    const footer = getFooter()
    if (!footer) return

    const bottom = atBottom()

    // 未主动滚动：不因浏览器恢复的滚动位置而显示 footer
    if (!userIntent) {
      if (footer.classList.contains('ft-shown')) footer.classList.remove('ft-shown')
      wasBottom = null
      return
    }

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

  // 用户主动滚动意图（滚动恢复事件不含 wheel/touch/key）
  const markIntent = () => {
    if (!userIntent) {
      userIntent = true
      schedule()
    }
  }
  window.addEventListener('wheel', markIntent, { passive: true })
  window.addEventListener('touchstart', markIntent, { passive: true })
  window.addEventListener('touchmove', markIntent, { passive: true })
  window.addEventListener('keydown', markIntent)
  window.addEventListener('scroll', schedule, { passive: true })
  window.addEventListener('resize', schedule)

  // 内容加载完成 / 文档高度变化(图片懒加载等)后重新评估，纠正提前误弹
  window.addEventListener('load', schedule)
  let lastH = 0
  const heightWatch = setInterval(() => {
    const h = document.documentElement.scrollHeight
    if (h !== lastH) {
      lastH = h
      schedule()
    }
  }, 400)

  // 页面进出(含 bfcache 前进/后退)：重置状态，避免状态继承
  const reset = () => {
    userIntent = false
    wasBottom = null
    const footer = getFooter()
    if (footer) footer.classList.remove('ft-shown')
  }
  window.addEventListener('pageshow', reset)

  // 初始化：默认隐藏；等用户滚动或内容稳定后再评估
  const init = () => {
    const footer = getFooter()
    if (!footer) return
    footer.classList.remove('ft-shown')
    lastH = document.documentElement.scrollHeight
    wasBottom = null
    // 300ms 后若用户已滚动且确在底部(短页面等)再显示
    setTimeout(() => { if (userIntent) schedule() }, 300)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // footer 不存在时停止高度轮询
  if (!getFooter()) clearInterval(heightWatch)
})()
