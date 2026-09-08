/* ============================================================
   Scroll Performance Guard (scroll-perf.js)
   ------------------------------------------------------------
   功能：检测快速滚动，临时降级 GPU 密集型效果（backdrop-filter
   等），滚动停止后恢复完整视觉。
   
   原理：
   1. 每帧记录 scrollY，计算滚动速度（px/frame）
   2. 速度超过阈值时给 body 加 .fast-scrolling（CSS 降级规则
      已在 theme-glass.css 中定义）
   3. 滚动停止后（200ms 无新滚动事件）移除该类，恢复效果
   
   性能开销：仅在 scroll 事件中做一次减法 + 一次 class 操作，
   不引入额外 rAF 循环。
   ============================================================ */
(function () {
  'use strict'

  var SPEED_THRESHOLD = 40   // px/frame，约等于快速拖拽滚动条
  var STOP_DELAY = 200       // ms，滚动停止后恢复
  var lastY = 0
  var lastTime = 0
  var stopTimer = null
  var isActive = false

  function onScroll() {
    var now = performance.now()
    var y = window.scrollY || document.documentElement.scrollTop
    var dt = now - lastTime

    // 至少间隔一帧（~16ms）才计算速度，避免噪声
    if (dt > 8) {
      var speed = Math.abs(y - lastY) / (dt / 16.7) // 归一化到 px/frame
      if (speed > SPEED_THRESHOLD && !isActive) {
        document.body.classList.add('fast-scrolling')
        isActive = true
      }
      lastY = y
      lastTime = now
    }

    // 重置停止计时器
    clearTimeout(stopTimer)
    stopTimer = setTimeout(function () {
      if (isActive) {
        document.body.classList.remove('fast-scrolling')
        isActive = false
      }
    }, STOP_DELAY)
  }

  // 初始化
  function init() {
    lastY = window.scrollY || document.documentElement.scrollTop
    lastTime = performance.now()
    window.addEventListener('scroll', onScroll, { passive: true })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }
})()
