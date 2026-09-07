/* ============================================================
   Theme switch: content reveal (custom inject, v12)
   = 机制 = v1：View Transitions，真实页面内容圆形 reveal
   = 位置 = 网页中心（百分比硬编码，无坐标传递，绝不偏移）

   用户要求："就要原来的那个，但 GPU 强制渲染"。
   即恢复真正的「新主题内容从网页中心圆形漾开」动画
   （View Transitions 原生 clip-path: circle() 内容扩散），
   而非盖一片实色圆的假动画。

   关键：圆心固定为 50% 50%，百分比写死在 CSS 里，不依赖 JS
   传像素坐标 —— 彻底规避 root 快照坐标系偏移问题。

   GPU 强制渲染：切换期间暂停 .bg-liquid 独立动画（vt-pause），
   关掉卡片/hero 的实时 backdrop-filter（switching），并给
   html 加 .vt-gpu 把关键元素推到独立合成层 → 让 VT 的两帧快照
   与 clip-path 圆形扩散尽量走 GPU 合成管线，把长文页掉帧压下去。
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
      // GPU 强制：切换期间暂停背景液体层独立动画 + 移除 will-change，
      // 让它被并入 root 一起被圆形 clip-path 裁切（避免被 VT 拆成独立组）。
      const bg = document.querySelector('.glass-bg')
      if (bg) bg.classList.add('vt-pause')

      // GPU 强制：动画期间给 html 加 .switching（关实时 backdrop-filter，
      // 减少 VT 快照光栅化重活）+ .vt-gpu（关键元素推独立合成层，走 GPU 管线）。
      const vt = document.startViewTransition(() => {
        root.classList.add('switching')
        root.classList.add('vt-gpu')
        performSwitch(mode)
      })

      // 切换结束后恢复背景层动画 + 玻璃 + 释放合成层
      const done = () => {
        if (bg) bg.classList.remove('vt-pause')
        root.classList.remove('switching')
        root.classList.remove('vt-gpu')
      }
      if (vt && typeof vt.finished === 'object' && vt.finished && vt.finished.then) {
        vt.finished.then(done, done)
      } else {
        // 兜底：给足动画时长后恢复（0.45s 动画 + 余量）
        setTimeout(done, 700)
      }
    } catch (err) {
      const bg = document.querySelector('.glass-bg')
      if (bg) bg.classList.remove('vt-pause')
      root.classList.remove('switching')
      root.classList.remove('vt-gpu')
      performSwitch(mode)
    }
  }, true)
})()
