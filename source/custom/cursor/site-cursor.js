/* ============================================================
   全站自定义光标 (site-cursor.js)
   ------------------------------------------------------------
   参考图同款「箭头光标」，跟手 + 不掉帧优先。
   - 亮色: 白描边 + 黑芯
   - 暗色: 亮芯 + 淡描边 + 冷光晕
   - 内部: 流光溢彩(静态渐变 + opacity 淡变, 不用 transform 动画)
   - 无蓝色磨砂底
   性能关键:
   - 【无 SVG filter / 无 clip-path / 无持续 transform 动画】
     > 滤镜+裁剪+每帧动画是掉帧主因；全部移除。
   - 光标本体只做 translate3d(走 GPU 合成层), 不触发 reflow/repaint。
   - 流光用「预渲染渐变层 + opacity 呼吸」, compositor 友好。
   - 光晕用纯 CSS radial-gradient div, 无 SVG 滤镜。
   - pointermove 直接 setProperty 写 --cur-x/--cur-y。
   依赖 site-cursor.css。
   ============================================================ */
(function () {
  'use strict'

  // 触屏/无精细指针 -> 不启用
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches
  if (!fine || document.getElementById('site-cursor')) return

  /* ---------- 箭头光标 SVG: 纯填充路径, 无滤镜无裁剪无动画 ---------- */
  var ARROW_PATH = 'M2 2 L10 21 L13.2 13.8 L21 11 Z'
  var svgNS = 'http://www.w3.org/2000/svg'
  var svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('class', 'cur-arrow')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '26')
  svg.setAttribute('height', '26')

  // 静态渐变(流光层, 只做 opacity 淡变, 不做 transform 动画)
  var defs = document.createElementNS(svgNS, 'defs')
  var grad = document.createElementNS(svgNS, 'linearGradient')
  grad.setAttribute('id', 'cur-flow-grad');
  grad.setAttribute('gradientUnits', 'userSpaceOnUse');
  grad.setAttribute('x1', '2');
  grad.setAttribute('y1', '2');
  grad.setAttribute('x2', '21');
  grad.setAttribute('y2', '18');
  [
    ['#ff6b9d', 0],
    ['#ffd54f', .25],
    ['#4f9dff', .5],
    ['#6bffb0', .75],
    ['#c86bff', 1]
  ].forEach(function (s) {
    var st = document.createElementNS(svgNS, 'stop')
    st.setAttribute('offset', String(s[1]))
    st.setAttribute('stop-color', s[0])
    grad.appendChild(st)
  })
  defs.appendChild(grad)
  svg.appendChild(defs)

  // 流光层(静态渐变, 裁剪交给 CSS mask/clip-path? 不 —— 用纯 path fill, 无需裁剪:
  // 直接把渐变作为箭头路径自身的一部分颜色? 不行, 渐变要盖住黑芯且从边缘透出。
  // 方案: 两层 path —— 底层=渐变流光(箭头路径), 顶层=半透明芯(透出流光)。
  // 这样完全不需要 clip-path, 也不会每帧重排。)
  var flow = document.createElementNS(svgNS, 'path')
  flow.setAttribute('class', 'a-flow')          // 箭头形状, 填渐变
  flow.setAttribute('d', ARROW_PATH)
  flow.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(flow)

  // 芯(盖在流光上, 用半透明 + color 让流光从边缘透出; 明暗由 CSS 控制)
  var core = document.createElementNS(svgNS, 'path')
  core.setAttribute('class', 'a-core')
  core.setAttribute('d', ARROW_PATH)
  core.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(core)

  // 白描边(最外, 参考图同款)
  var stroke = document.createElementNS(svgNS, 'path')
  stroke.setAttribute('class', 'a-stroke')
  stroke.setAttribute('d', ARROW_PATH)
  stroke.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(stroke)

  // 容器(只做 translate3d 跟随)
  var cur = document.createElement('div')
  cur.id = 'site-cursor'
  cur.appendChild(svg)

  // 光晕 = 纯 CSS radial-gradient 圆, 无 SVG 滤镜, compositor 友好
  var ring = document.createElement('div')
  ring.id = 'site-cursor-ring'

  document.body.appendChild(cur)
  document.body.appendChild(ring)

  /* ---------- 跟手: pointermove 直写 CSS 变量, 零插值 ---------- */
  var shown = false
  var root = document.documentElement
  var INTERACTIVE = 'a, button, input, textarea, select, [role="button"], .nav-search, #darkmode'

  function move(e) {
    root.style.setProperty('--cur-x', e.clientX + 'px')
    root.style.setProperty('--cur-y', e.clientY + 'px')
    if (!shown) {
      shown = true
      cur.classList.add('on')
      ring.classList.add('on')
    }
  }

  // 流光点亮(只在元素边界触发)
  function setGlow(el) {
    var hit = el && el.closest && el.closest(INTERACTIVE)
    cur.classList.toggle('glow', !!hit)
  }
  document.addEventListener('pointerover', function (e) { setGlow(e.target) })
  document.addEventListener('pointerout', function (e) {
    var to = e.relatedTarget
    if (!(to && to.closest && to.closest(INTERACTIVE))) setGlow(null)
  })

  // 按下反馈
  document.addEventListener('mousedown', function () {
    cur.classList.add('pressed')
    ring.classList.add('pressed')
  })
  document.addEventListener('mouseup', function () {
    cur.classList.remove('pressed')
    ring.classList.remove('pressed')
  })

  function leave() {
    cur.classList.remove('on')
    ring.classList.remove('on')
    shown = false
  }
  function enterIn() { shown = false }

  document.addEventListener('pointermove', move, { passive: true })
  document.addEventListener('mouseleave', leave)
  document.addEventListener('mouseenter', enterIn)
})()
