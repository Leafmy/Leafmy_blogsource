/* ============================================================
   黑白模式按钮迁入顶部导航栏 (custom inject)
   -----------------------------------------------
   把 #darkmode 从主题右侧悬浮栏(#rightside)移到 #nav 的 #menus 里：
   - 桌面端在检索键(.nav-search)左边(靠右贴搜索胶囊);
   - 移动端在导航栏最左边(由 nav-darkmode.css 的 order 控制)。
   图标改为「日月」：light 显月亮(fa-moon)、dark 显太阳(fa-sun)，
   并随主题切换实时更新。
   桌面端运动模糊：检索胶囊宽度过渡期间给 #nav 加 .nav-moving，
   让检索栏与切换键播放一次运动模糊脉冲(仅桌面, CSS 限制在
   min-width:769px)。
   依赖 nav-darkmode.css(布局 + 按钮底 + 运动模糊样式)。
   ============================================================ */
(function () {
  'use strict'
  var nav = document.getElementById('nav')
  var menus = nav && nav.querySelector('#menus')
  var dm = document.getElementById('darkmode')
  if (!menus || !dm) return

  // 迁入导航栏(视觉顺序由 CSS order 控制, DOM 位置无关紧要)
  menus.appendChild(dm)

  // 图标: 日月随主题切换
  function setIcon() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark'
    var icon = dm.querySelector('i')
    if (icon) icon.className = 'fas ' + (isDark ? 'fa-sun' : 'fa-moon')
  }
  setIcon()

  // 主题切换时同步图标(theme-reveal 只改 data-theme, 无独立回调)
  if (window.MutationObserver) {
    var mo = new MutationObserver(setIcon)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  }

  // 桌面运动模糊: 检索胶囊的输入区宽度过渡期间, 给 #nav 加 .nav-moving,
  // 触发检索栏 + 切换键播放一次 blur 脉冲(移动感)。宽度过渡结束移除。
  var input = document.querySelector('#nav .nav-search-input')
  if (input && nav) {
    var onTransition = function (e, on) {
      if (e.propertyName !== 'width' && e.propertyName !== 'flex-grow') return
      nav.classList.toggle('nav-moving', on)
    }
    input.addEventListener('transitionstart', function (e) { onTransition(e, true) })
    input.addEventListener('transitionend', function (e) { onTransition(e, false) })
  }
})()
