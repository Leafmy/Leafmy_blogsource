/* ============================================================
   Theme switch: GPU 合成圆形扩散 (custom inject, v9)
   = 机制 = 免 View Transitions 全页快照, 纯 GPU 合成圆形扩散
   ------------------------------------------------------------
   掉帧根因(实测):
   - startViewTransition 会对【整个 root】拍两帧快照(6353px 长文 +
     22 个 backdrop 玻璃), 切换期间 maxGap 127ms(严重掉帧);
   - 切 data-theme 本身触发全站 199 条 html[data-theme] 规则重算
     (RecalcStyleDuration ≈0.33s), 用 VT 时被再次叠加放大到 0.47s。

   v9 方案:
   - 不调 startViewTransition(免全页快照/免主线程叠加重算);
   - 点击切主题: 立即 activateDarkMode/LightMode(瞬时切 data-theme);
   - 同步在一个【空的固定合成层】上做 transform: scale() 圆形扩散
     (从点击中心 0→覆盖全屏), 配合半透明径向渐变遮罩, 形成"新主题
     色从点击处圆形漾开"的过渡;
   - scale 走 GPU 合成器, 该层只含遮罩不含任何页面内容 → 无快照、
     无重排, 主线程仅一次 data-theme 切换。
   ============================================================ */
(function () {
  'use strict'

  if (typeof window.btf === 'undefined') return

  const root = document.documentElement
  const isDarkMode = () => root.getAttribute('data-theme') === 'dark'

  /* 执行切换：与主题原生 darkmode handler 行为一致(仅切 data-theme) */
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

  /* GPU 圆形扩散遮罩: 空固定层 + transform scale, 免全页快照 */
  const roundReveal = (x, y) => {
    // x,y 为点击点(相对视口) —— 圆形从此处漾开
    const overlay = document.createElement('div')
    overlay.className = 'theme-round-reveal'
    overlay.setAttribute('aria-hidden', 'true')
    // 遮罩圆心定位到点击点(相对视口坐标), 背景由 CSS 提供
    overlay.style.setProperty('--reveal-x', (x || innerWidth / 2) + 'px')
    overlay.style.setProperty('--reveal-y', (y || innerHeight / 2) + 'px')
    document.body.appendChild(overlay)

    const done = () => {
      overlay.classList.remove('on')
      setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) }, 320)
    }
    // 强制一帧同步后添加 .on 触发扩散, 确保动画起点正确
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { overlay.classList.add('on') })
    })
    return done
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

    // 点击点(圆形圆心) —— #darkmode 相对视口中心位置
    const rect = btn.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    if (reduced) {
      performSwitch(mode)
      return
    }

    // 启动 GPU 圆形扩散(空层, 无内容, 无快照)
    const done = roundReveal(cx, cy)
    // 即时切换主题(主线程只做这一次 data-theme 切换, 不与快照叠加)
    performSwitch(mode)
    setTimeout(done, 560)
  }, true)
})()
