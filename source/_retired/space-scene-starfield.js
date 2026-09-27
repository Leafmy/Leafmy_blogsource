/* ============================================================
   太空场景星空层 (space-scene.js, v1)
   ------------------------------------------------------------
   取代旧的 glass-bg.js / .bg-liquid「冷雾彩色光斑」层。
   背景不再是一层可被 backdrop-filter 采样的彩色玻璃，而是一个
   真实的深空场景：星野 + 星云辉光 + 木星与木星环 + 流星。

   === 为什么不用一张大图 / 不用 CSS 堆光斑 ===
   1) 星野：用 <canvas> 把星星【预渲染成一张离屏位图】，之后每帧
      只需 drawImage 一次（1 个绘制调用），而不是每帧画上千个
      arc()。星野本身是静态的，不参与逐帧重绘。
   2) 流星：同一张 canvas 上每帧 clearRect + 2~4 条线段，
      成本恒定且极低。
   3) 木星本体与木星环：纯 CSS 渐变层（见 space-scene.css），
      静态不动画 → 光栅化一次后走合成器缓存，滚动零重绘。

   === 性能约束（针对 Chrome 卡顿）===
   - 只在标签页可见时跑 rAF；document.hidden 时停掉循环
     （与 tab-visibility.js 的 .tab-hidden 互补）。
   - devicePixelRatio 封顶 1.5：4K + DPR2 全屏 canvas 会让 iGPU
     的填充率吃满，反而拖慢滚动。
   - 尊重 prefers-reduced-motion：直接不生成流星。
   - 全部元素 pointer-events:none，且 z-index 低于内容层。
   ============================================================ */
(function () {
  'use strict'

  var root = document.documentElement
  var reduced = !!(window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  /* ---------------- 1. 定位画布 ----------------
     场景的 DOM（星云 / 木星环 / 木星光球 / 画布）由模板
     themes/.../layout/includes/space-scene.pug 渲染，本脚本只负责
     画布内容：星野位图 + 流星。这样首屏不必等脚本执行完才出现场景。 */
  // [注意] 这里【不能】再写 "if (document.querySelector('.space-bg')) return"。
  // 场景 DOM 现在由模板渲染，.space-bg 在脚本执行前就已存在，那样的守卫
  // 会让整个脚本直接 return —— 症状是画布一直是默认的 300x150、星野和
  // 流星全部不出现（本轮实际踩到过）。改成按画布幂等初始化。
  var canvas = document.querySelector('.space-meteors')
  if (!canvas) return
  if (canvas.dataset.spaceInit === '1') return
  canvas.dataset.spaceInit = '1'

  var ctx = canvas.getContext('2d')
  var stars = null              // 离屏星野位图（预渲染，逐帧只 drawImage 一次）
  var cssW = 0
  var cssH = 0
  var dpr = 1

  function sizeCanvas() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    cssW = window.innerWidth
    cssH = window.innerHeight
    canvas.width = Math.max(1, Math.round(cssW * dpr))
    canvas.height = Math.max(1, Math.round(cssH * dpr))
    canvas.style.width = cssW + 'px'
    canvas.style.height = cssH + 'px'
  }

  /* 按视口面积决定星星数量：密度约 1 颗 / 2600 px²（1920×1000 ≈ 740 颗）。
     颜色/大小/透明度都做随机，并按亮度分档，模拟真实星等的层次。 */
  function buildStars() {
    var off = document.createElement('canvas')
    off.width = canvas.width
    off.height = canvas.height
    var octx = off.getContext('2d')

    var count = Math.min(1400, Math.max(220, Math.round(cssW * cssH / 2600)))
    var tints = [
      '255,255,255',   // 白
      '208,226,255',   // 蓝白
      '255,244,224',   // 暖黄
      '226,235,255'    // 冷蓝
    ]

    for (var i = 0; i < count; i++) {
      var x = Math.random() * off.width
      var y = Math.random() * off.height
      // 亮度分档：绝大多数是暗星，少量亮星撑起画面层次
      var roll = Math.random()
      var bright = roll > 0.985 ? 1 : roll > 0.9 ? 0.72 : roll > 0.62 ? 0.5 : 0.32
      var r = (bright > 0.9 ? 1.5 : bright > 0.6 ? 1.1 : 0.75) * dpr * (0.7 + Math.random() * 0.6)
      var tint = tints[(Math.random() * tints.length) | 0]

      octx.beginPath()
      octx.arc(x, y, r, 0, Math.PI * 2)
      octx.fillStyle = 'rgba(' + tint + ',' + (bright * (0.55 + Math.random() * 0.45)).toFixed(3) + ')'
      octx.fill()

      // 亮星加一圈很淡的光晕，接近真实星点的衍射感
      if (bright > 0.9) {
        var g = octx.createRadialGradient(x, y, 0, x, y, r * 6)
        g.addColorStop(0, 'rgba(' + tint + ',.30)')
        g.addColorStop(1, 'rgba(' + tint + ',0)')
        octx.fillStyle = g
        octx.beginPath()
        octx.arc(x, y, r * 6, 0, Math.PI * 2)
        octx.fill()
      }
    }
    stars = off
    paintStars()
  }

  function paintStars() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    if (stars) ctx.drawImage(stars, 0, 0)
  }

  /* ---------------- 3. 流星 ---------------- */
  var meteors = []
  var nextSpawn = 0
  var raf = null
  var lastTs = 0

  /* 流星从画面右上偏外起飞，向左下划过。
     角度固定在一个小范围（约 28°~40°），保证视觉方向一致 —— 真实
     流星雨的方向是平行的，随机乱飞反而假。 */
  function spawnMeteor() {
    var angle = (28 + Math.random() * 12) * Math.PI / 180
    var speed = (0.42 + Math.random() * 0.5) * Math.min(cssW, 1600) / 16.7 // px/ms 归一化到分辨率
    var dist = Math.hypot(cssW, cssH)
    // 起点散布在视口右上角外侧，避免所有流星从同一个点钻出来
    var startX = cssW * (0.62 + Math.random() * 0.5)
    var startY = -cssH * (0.02 + Math.random() * 0.34)

    meteors.push({
      x: startX,
      y: startY,
      dx: Math.cos(angle) * speed,
      dy: Math.sin(angle) * speed,
      len: (110 + Math.random() * 210) * (0.6 + Math.min(cssW, 1600) / 1600),
      width: 1.5 + Math.random() * 1.3,
      life: 0,
      // 总寿命按“对角线长度 / 速度”给足，让它飞出画面才消失
      ttl: Math.min(2400, dist / speed * 1.15)
    })
  }

  function drawMeteor(m) {
    var tailX = m.x - m.dx * m.len / Math.hypot(m.dx, m.dy) * 1
    var tailY = m.y - m.dy * m.len / Math.hypot(m.dx, m.dy) * 1
    var headX = m.x
    var headY = m.y
    // 用“进入/退出”两端淡入淡出，避免流星突然出现或突然消失
    var fade = Math.min(1, m.life / 220) * Math.min(1, (m.ttl - m.life) / 320)

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    var g = ctx.createLinearGradient(tailX, tailY, headX, headY)
    g.addColorStop(0, 'rgba(150,190,255,0)')
    g.addColorStop(0.55, 'rgba(190,215,255,' + (0.32 * fade).toFixed(3) + ')')
    g.addColorStop(1, 'rgba(255,255,255,' + (0.92 * fade).toFixed(3) + ')')

    ctx.strokeStyle = g
    ctx.lineWidth = m.width * dpr
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(tailX, tailY)
    ctx.lineTo(headX, headY)
    ctx.stroke()

    // 头部亮点
    var hg = ctx.createRadialGradient(headX, headY, 0, headX, headY, m.width * 5 * dpr)
    hg.addColorStop(0, 'rgba(255,255,255,' + (0.85 * fade).toFixed(3) + ')')
    hg.addColorStop(1, 'rgba(190,215,255,0)')
    ctx.fillStyle = hg
    ctx.beginPath()
    ctx.arc(headX, headY, m.width * 5 * dpr, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  }

  function step(ts) {
    raf = requestAnimationFrame(step)
    var dt = lastTs ? Math.min(64, ts - lastTs) : 16
    lastTs = ts

    // 生成节奏：0.9~3.4s 一颗，同时在屏上限 3 颗，保证稀疏不喧闹
    nextSpawn -= dt
    if (nextSpawn <= 0) {
      if (meteors.length < 3) spawnMeteor()
      nextSpawn = 900 + Math.random() * 2500
    }

    // 每帧全量重绘：先铺回星野位图（一次 drawImage），再画流星
    paintStars()
    for (var i = meteors.length - 1; i >= 0; i--) {
      var m = meteors[i]
      m.life += dt
      m.x += m.dx * dt
      m.y += m.dy * dt
      if (m.life > m.ttl || m.y - cssH > 160 || m.x + 200 < 0) {
        meteors.splice(i, 1)
        continue
      }
      drawMeteor(m)
    }
  }

  function startLoop() {
    if (raf) return
    lastTs = 0
    nextSpawn = 600
    raf = requestAnimationFrame(step)
  }

  function stopLoop() {
    if (!raf) return
    cancelAnimationFrame(raf)
    raf = null
    meteors.length = 0
    if (ctx) paintStars()
  }

  /* ---------------- 4. 事件 ---------------- */
  var resizeTimer = null
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(function () {
      sizeCanvas()
      buildStars()
      meteors.length = 0
    }, 220)
  }, { passive: true })

  // 后台标签页停掉 rAF：既省电，也避免切回时一次性补帧造成卡顿
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stopLoop()
    else if (!reduced) startLoop()
  })

  /* ---------------- 5. 启动 ---------------- */
  function init() {
    sizeCanvas()
    buildStars()
    if (!reduced) startLoop()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init)
  } else {
    init()
  }

  // 排查用：控制台可调 __spaceScene
  window.__spaceScene = {
    get starsPainted() { return !!stars },
    get meteors() { return meteors.length },
    reduced: reduced,
    rebuild: function () { sizeCanvas(); buildStars() }
  }
})()
