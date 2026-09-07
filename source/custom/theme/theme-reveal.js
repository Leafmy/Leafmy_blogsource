/* ============================================================
   Theme switch: 明显圆形展开 (custom inject, v11)
   = 机制 = 纯 GPU 合成圆形波纹, 无全页快照, 效果明显可见
   ------------------------------------------------------------
   用户要求"明显的圆形展开动画"。实测 startViewTransition 在
   6353px 长文页即使优化后仍掉帧(maxGap 115ms, over50 1帧)——
   因为它对【整个 root】光栅化两帧快照。

   v11 方案(两全其美):
   - 不用 startViewTransition(免全页快照/免掉帧);
   - 点击切主题: 立即 activateDarkMode/LightMode(瞬时切 data-theme);
   - 在【空固定合成层】上做 transform:scale() 圆形波纹——但这次
     用【目标主题的实色】(light 冷雾灰蓝 / dark 深黑) 做不透明圆形,
     从点击中心 0→覆盖全屏(scale ~6), 让用户清楚看到"新主题色
     圆形漾开盖满屏幕"。scale 走 GPU 合成器, 层内只有纯色圆无
     内容 → 明显可见 + 无快照 + 不掉帧。
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

  /* 明显圆形波纹: 空固定层 + 目标主题实色圆形 scale 扩散, 无快照 */
  const roundReveal = (x, y, mode) => {
    const overlay = document.createElement('div')
    overlay.className = 'theme-round-reveal'
    // 目标主题确定圆形遮罩底色(light 冷雾灰蓝 / dark 深黑) —— 明显可见
    overlay.dataset.theme = mode
    overlay.setAttribute('aria-hidden', 'true')
    overlay.style.setProperty('--reveal-x', (x || innerWidth / 2) + 'px')
    overlay.style.setProperty('--reveal-y', (y || innerHeight / 2) + 'px')
    document.body.appendChild(overlay)

    // 动画(.68s)结束后移除遮罩 —— 用 animationend 精确清理, 无残留
    const remove = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) }
    overlay.addEventListener('animationend', remove, { once: true })
    // 兜底: 750ms 仍未触发 animationend(如隐藏标签页)则强制移除
    const s = setTimeout(() => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay) }, 760)

    requestAnimationFrame(() => {
      requestAnimationFrame(() => { overlay.classList.add('on') })
    })
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

    const rect = btn.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2

    if (reduced) {
      performSwitch(mode)
      return
    }

    // 明显圆形波纹(GPU 合成, 无快照) + 即时切换主题
    // 遮罩由 animationend 自动清理(见 roundReveal)
    roundReveal(cx, cy, mode)
    performSwitch(mode)
  }, true)
})()
