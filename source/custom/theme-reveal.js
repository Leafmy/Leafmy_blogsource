/* ============================================================
   Theme switch: circular reveal animation (custom inject)
   拦截右上角暗色按钮 #darkmode 的点击：
   1) 在捕获阶段接管，避免与主题自带 handler 重复切换
   2) 用 View Transitions API 实现「从按钮位置向外圆形扩散」
   3) 完全复刻主题原本的切换、持久化、提示逻辑
   ============================================================ */
(function () {
  'use strict'

  if (typeof window.btf === 'undefined') return

  const root = document.documentElement
  const isDarkMode = () => root.getAttribute('data-theme') === 'dark'

  /* 执行切换：与主题原生 darkmode handler 行为一致 */
  const performSwitch = (mode) => {
    if (mode === 'dark') {
      if (window.btf.activateDarkMode) window.btf.activateDarkMode()
    } else {
      if (window.btf.activateLightMode) window.btf.activateLightMode()
    }

    // 持久化用户选择（保留 2 天）
    if (window.btf.saveToLocal) window.btf.saveToLocal.set('theme', mode, 2)

    // 触发第三方组件（评论等）的主题切换回调，与主题行为一致
    const globalFn = window.globalFn || {}
    const themeChange = globalFn.themeChange
    if (themeChange) {
      Object.keys(themeChange).forEach((key) => {
        if (typeof themeChange[key] === 'function') themeChange[key](mode)
      })
    }

    // 右下角提示（Snackbar 启用时）
    if (window.GLOBAL_CONFIG && window.GLOBAL_CONFIG.Snackbar &&
        typeof window.btf.snackbarShow === 'function') {
      const msg = window.GLOBAL_CONFIG.Snackbar[mode === 'dark' ? 'day_to_night' : 'night_to_day']
      if (msg !== undefined) window.btf.snackbarShow(msg)
    }
  }

  document.addEventListener('click', (e) => {
    const target = e.target
    const btn = target && target.closest ? target.closest('#darkmode') : null
    if (!btn) return

    // 接管本次点击：阻止事件继续传播到主题的 #rightside 委托 handler
    e.stopPropagation()
    e.preventDefault()

    const mode = isDarkMode() ? 'light' : 'dark'
    const reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    // 支持 View Transitions 且用户未开启“减少动态效果”时，播放扩散动画
    if (document.startViewTransition && !reduced) {
      const rect = btn.getBoundingClientRect()
      const x = Math.round(rect.left + rect.width / 2)
      const y = Math.round(rect.top + rect.height / 2)
      root.style.setProperty('--theme-reveal-x', x + 'px')
      root.style.setProperty('--theme-reveal-y', y + 'px')

      const vt = document.startViewTransition(() => performSwitch(mode))
      if (vt && vt.finished) {
        vt.finished.finally(() => {
          root.style.removeProperty('--theme-reveal-x')
          root.style.removeProperty('--theme-reveal-y')
        }).catch(() => {})
      }
    } else {
      // 兜底：直接切换，无动画
      performSwitch(mode)
    }
  }, true)
})()
