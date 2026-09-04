/* ============================================================
   Glass backdrop layer (custom inject)
   关键原理：backdrop-filter 只能模糊"其后方的真实 DOM 内容"，
   纯 body/html 背景(background-image)不被采样 → 玻璃感缺失。
   本脚本在 body 前插入一个固定彩色光斑层 .glass-bg，
   让卡片真正"透过"一层可模糊的内容，形成磨砂玻璃观感。
   依赖 glass-bg.css（光斑样式 + 层级控制）。
   ============================================================ */
(function () {
  'use strict'
  if (document.querySelector('.glass-bg')) return

  var bg = document.createElement('div')
  bg.className = 'glass-bg'
  bg.setAttribute('aria-hidden', 'true')

  // 液体层：比视口大一圈，承载彩色光斑渐变，用 transform 平移（GPU 合成，
  // 不触发 CPU 逐帧重绘 background-position），由 .glass-bg 的 overflow:hidden 裁切。
  var liquid = document.createElement('div')
  liquid.className = 'bg-liquid'
  liquid.setAttribute('aria-hidden', 'true')
  bg.appendChild(liquid)

  document.body.insertBefore(bg, document.body.firstChild)
})()
