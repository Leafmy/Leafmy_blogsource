/* ============================================================
   黑白模式按钮迁入顶部导航栏 (custom inject)
   -----------------------------------------------
   把 #darkmode 从主题右侧悬浮栏(#rightside)移到 #nav 的 #menus 里：
   - 桌面端在检索键(.nav-search)左边(靠右贴搜索胶囊);
   - 移动端在导航栏最左边(由 nav-darkmode.css 的 order 控制)。
   图标改为「日月」：light 显月亮(fa-moon)、dark 显太阳(fa-sun)，
   并随主题切换实时更新。
   依赖 nav-darkmode.css(布局 + 按钮底)。
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
})()
