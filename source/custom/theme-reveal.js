/* ============================================================
   Theme switch: content reveal (custom inject, v8)
   = 机制 = v1：View Transitions，真实页面内容圆形 reveal
   = 位置 = 网页中心（百分比硬编码，无坐标传递，绝不偏移）

   关键：圆心固定为 50% 50%，直接用百分比写死在 CSS 里，
   不依赖 JS 传任何像素坐标 —— 彻底规避此前 root 快照
   坐标系偏移问题（v4/v6 起点偏的根因）。
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

    if (window.btf.saveToLocal) window.btf.saveToLocal.set('theme', mode, 2)

    const globalFn = window.globalFn || {}
    const themeChange = globalFn.themeChange
    if (themeChange) {
      Object.keys(themeChange).forEach((key) => {
        if (typeof themeChange[key] === 'function') themeChange[key](mode)
      })
    }

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

    e.stopPropagation()
    e.preventDefault()

    const mode = isDarkMode() ? 'light' : 'dark'
    const reduced = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (reduced || typeof document.startViewTransition !== 'function') {
      performSwitch(mode)
      return
    }

    try {
      // 内容级圆形 reveal：圆心固定网页中心（动画在 CSS 中定义）
      document.startViewTransition(() => performSwitch(mode))
    } catch (err) {
      performSwitch(mode)
    }
  }, true)
})()
