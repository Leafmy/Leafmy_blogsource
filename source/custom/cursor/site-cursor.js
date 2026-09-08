/* ============================================================
   自定义光标 - Win11 概念版 (SVG 矢量图)
   ============================================================ */
(function () {
  'use strict'

  // 检查是否为触屏设备或移动端
  if (window.matchMedia('(hover: none) and (pointer: coarse)').matches ||
      window.matchMedia('(max-width: 768px)').matches) {
    return
  }

  // 创建光标元素 - 圆滑正三角 + 底边浅凹 + 流光溢彩
  var cursor = document.createElement('div')
  cursor.id = 'custom-cursor'
  // SVG 矢量光标：正三角形 + 三圆角 + 底边浅凹 + 内部流光渐变
  cursor.innerHTML = `
    <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <!-- 流光溢彩渐变 -->
        <linearGradient id="flow-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ff6b6b"/>
          <stop offset="25%" stop-color="#feca57"/>
          <stop offset="50%" stop-color="#48dbfb"/>
          <stop offset="75%" stop-color="#ff9ff3"/>
          <stop offset="100%" stop-color="#54a0ff"/>
        </linearGradient>
        <!-- 动画渐变 -->
        <linearGradient id="flow-gradient-animated" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ff6b6b">
            <animate attributeName="stop-color" values="#ff6b6b;#feca57;#48dbfb;#ff9ff3;#ff6b6b" dur="6s" repeatCount="indefinite"/>
          </stop>
          <stop offset="50%" stop-color="#48dbfb">
            <animate attributeName="stop-color" values="#48dbfb;#ff9ff3;#ff6b6b;#feca57;#48dbfb" dur="6s" repeatCount="indefinite"/>
          </stop>
          <stop offset="100%" stop-color="#ff9ff3">
            <animate attributeName="stop-color" values="#ff9ff3;#ff6b6b;#feca57;#48dbfb;#ff9ff3" dur="6s" repeatCount="indefinite"/>
          </stop>
        </linearGradient>
        <!-- 光标形状蒙版 -->
        <clipPath id="cursor-clip">
          <path d="M14 2 Q13 3 12 5 L5 21 Q4 23 6 24 Q8 25 10 24 Q12 23 14 21 Q16 23 18 24 Q20 25 22 24 Q24 23 23 21 L16 5 Q15 3 14 2 Z"/>
        </clipPath>
      </defs>
      <!-- 流光溢彩层（裁剪到光标形状内） -->
      <rect x="0" y="0" width="28" height="28" fill="url(#flow-gradient-animated)" clip-path="url(#cursor-clip)"/>
      <!-- 白色描边 -->
      <path class="cursor-stroke" d="M14 2 Q13 3 12 5 L5 21 Q4 23 6 24 Q8 25 10 24 Q12 23 14 21 Q16 23 18 24 Q20 25 22 24 Q24 23 23 21 L16 5 Q15 3 14 2 Z" 
            stroke="white" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
  `
  document.body.appendChild(cursor)

  // 直接同步跟随，零延迟（热点在箭头尖端）
  document.addEventListener('mousemove', function (e) {
    cursor.style.transform = 'translate3d(' + (e.clientX - 2) + 'px, ' + (e.clientY - 2) + 'px, 0) rotate(-45deg)'
  })

  // 点击反馈
  document.addEventListener('mousedown', function () {
    cursor.classList.add('clicking')
  })

  document.addEventListener('mouseup', function () {
    cursor.classList.remove('clicking')
  })

  // 鼠标离开窗口时隐藏
  document.addEventListener('mouseleave', function () {
    cursor.style.opacity = '0'
  })

  document.addEventListener('mouseenter', function () {
    cursor.style.opacity = '1'
  })
})()
