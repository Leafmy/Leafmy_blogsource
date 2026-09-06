/* ============================================================
   全站自定义光标 (site-cursor.js)
   ------------------------------------------------------------
   注入一个参考图同款「箭头光标」SVG 跟随全站鼠标：
   - 亮色: 白描边 + 黑芯
   - 暗色: 亮芯 + 淡描边 + 冷光晕
   - 内部: 流光溢彩(流形渐变, 仅芯内可见, 交到可交互元素时点亮)
   - 无蓝色磨砂底
   设计(低延迟优先):
   - Pointer Events 统一鼠标/触屏; 仅精细指针启用
   - 【跟手】在 pointermove 里直接同步写入坐标(无插值/无 rAF 循环),
     位置经 CSS 变量 --cur-x/--cur-y 承载, 由 CSS 合成 transform → 瞬时贴合
   - 流光判定用 pointerover/pointerout, 只在元素边界触发, 不逐像素开销
   - 按下缩放反馈
   依赖 site-cursor.css。
   ============================================================ */
(function () {
  'use strict'

  // 触屏/无精细指针 -> 不启用
  var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches
  if (!fine || document.getElementById('site-cursor')) return

  /* ---------- 箭头光标 SVG (参考图造型: 尖端圆润的箭头, 尖端在 2,2) ---------- */
  var ARROW_PATH = 'M2 2 L10 21 L13.2 13.8 L21 11 Z'
  var svgNS = 'http://www.w3.org/2000/svg'
  var svg = document.createElementNS(svgNS, 'svg')
  svg.setAttribute('class', 'cur-arrow')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '26')
  svg.setAttribute('height', '26')

  var defs = document.createElementNS(svgNS, 'defs')

  // 流形渐变(流光)
  var grad = document.createElementNS(svgNS, 'linearGradient')
  grad.setAttribute('id', 'cur-flow-grad')
  grad.setAttribute('gradientUnits', 'userSpaceOnUse')
  grad.setAttribute('x1', '2')
  grad.setAttribute('y1', '2')
  grad.setAttribute('x2', '21')
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

  // 裁剪: 只暴露箭头芯内部
  var clip = document.createElementNS(svgNS, 'clipPath')
  clip.setAttribute('id', 'cur-core-clip')
  var clipPath = document.createElementNS(svgNS, 'path')
  clipPath.setAttribute('d', ARROW_PATH)
  clip.appendChild(clipPath)
  defs.appendChild(clip)

  // 柔和发光滤镜
  var filter = document.createElementNS(svgNS, 'filter')
  filter.setAttribute('id', 'cur-glow-filter')
  filter.setAttribute('x', '-60%')
  filter.setAttribute('y', '-60%')
  filter.setAttribute('width', '220%')
  filter.setAttribute('height', '220%')
  var blur = document.createElementNS(svgNS, 'feGaussianBlur')
  blur.setAttribute('stdDeviation', '1.4')
  filter.appendChild(blur)
  defs.appendChild(filter)

  svg.appendChild(defs)

  // 白描边(外)
  var stroke = document.createElementNS(svgNS, 'path')
  stroke.setAttribute('class', 'a-stroke')
  stroke.setAttribute('d', ARROW_PATH)
  stroke.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(stroke)

  // 流光层(芯内, 裁剪 + 滤镜, 动画移动)
  var glowG = document.createElementNS(svgNS, 'g')
  glowG.setAttribute('class', 'a-glow')
  glowG.setAttribute('clip-path', 'url(#cur-core-clip)')
  var glowRect = document.createElementNS(svgNS, 'rect')
  glowRect.setAttribute('class', 'a-glowrect')
  glowRect.setAttribute('x', '-1')
  glowRect.setAttribute('y', '-1')
  glowRect.setAttribute('width', '26')
  glowRect.setAttribute('height', '26')
  glowRect.setAttribute('fill', 'url(#cur-flow-grad)')
  glowRect.setAttribute('filter', 'url(#cur-glow-filter)')
  glowG.appendChild(glowRect)
  svg.appendChild(glowG)

  // 黑/白芯(盖在流光上方, 流光从边缘透出)
  var core = document.createElementNS(svgNS, 'path')
  core.setAttribute('class', 'a-core')
  core.setAttribute('d', ARROW_PATH)
  core.setAttribute('stroke-linejoin', 'round')
  svg.appendChild(core)

  // 容器 + 外圈柔光环
  var cur = document.createElement('div')
  cur.id = 'site-cursor'
  cur.appendChild(svg)
  var ring = document.createElement('div')
  ring.id = 'site-cursor-ring'
  document.body.appendChild(cur)
  document.body.appendChild(ring)

  /* ---------- 跟手: 直接同步写坐标, 无插值无 rAF ---------- */
  var shown = false
  var root = document.documentElement
  var INTERACTIVE = 'a, button, input, textarea, select, [role="button"], .nav-search, #darkmode'

  function move(e) {
    // 同步写入 CSS 变量, 由 CSS 下一帧合成 translate —— 零追赶延迟
    if (root.style.setProperty) {
      root.style.setProperty('--cur-x', e.clientX + 'px')
      root.style.setProperty('--cur-y', e.clientY + 'px')
    } else {
      // 兜底: 直写 inline transform
      cur.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'
      ring.style.transform = 'translate(' + e.clientX + 'px,' + e.clientY + 'px)'
    }
    if (!shown) {
      shown = true
      cur.classList.add('on')
      ring.classList.add('on')
    }
  }

  function setGlow(el) {
    var hit = el && el.closest && el.closest(INTERACTIVE)
    cur.classList.toggle('glow', !!hit)
  }
  // 只在元素边界触发(pointerover/out), 不逐像素
  document.addEventListener('pointerover', function (e) {
    setGlow(e.target)
  })
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
  function enterIn() {
    shown = false
  }

  // 唯一事件入口(pointer 统一鼠标/笔, 触屏因 coarse 已在 CSS 隐藏)
  document.addEventListener('pointermove', move, { passive: true })
  document.addEventListener('mouseleave', leave)
  document.addEventListener('mouseenter', enterIn)
})()
