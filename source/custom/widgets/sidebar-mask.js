/* ============================================================
   侧边栏抽屉遮罩状态管理 (custom inject)
   ---------------------------------------------------------------
   问题: 主题 main.js 关闭抽屉时【立即移除 .open】, 但 #sidebar-menus
   还要过渡 .5s 才完全滑出屏幕。mobile-fix.css 靠 body:has(.open) 压低
   顶部 #nav 的规则随之立即失效 → #nav 瞬间回到 z-index:999, 浮到还没
   收起的抽屉上方(导航条横压在侧边栏上)。
   方案: 监听 #sidebar-menus 的 transform 过渡起止——
   - 抽屉【失去 .open 开始滑出】(transitionstart 且无 .open)时,
     给 body 加 .sb-closing: mobile-fix.css 据此在整个收起动画期间
     继续把 #nav 压到遮罩之下、抽屉之下;
   - 滑出结束(transitionend)移除 .sb-closing, #nav 正常恢复。
   展开方向(加 .open)不受影响: 由 body:has(.open) 接管压低。
   依赖 mobile-fix.css(第 3/4 节的 media 规则)。
   ============================================================ */
(function () {
  'use strict'
  var sb = document.getElementById('sidebar-menus')
  if (!sb) return

  sb.addEventListener('transitionstart', function (e) {
    // 只关心抽屉位移动画; 其它属性(背景/圆角等)的过渡不参与层叠管理
    if (e.propertyName !== 'transform') return
    // 收起方向: .open 已被移除, 抽屉正滑出屏幕 → 标记整个滑出期
    if (!sb.classList.contains('open')) {
      document.body.classList.add('sb-closing')
    }
  })

  sb.addEventListener('transitionend', function (e) {
    if (e.propertyName !== 'transform') return
    document.body.classList.remove('sb-closing')
  })
})()
