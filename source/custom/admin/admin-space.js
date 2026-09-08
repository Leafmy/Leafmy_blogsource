/* ============================================================
   管理页背景（canvas）—— 液态玻璃 + 星链 + 流星
   ------------------------------------------------------------
   只保留三样东西：
   1. 液态玻璃：几团大色斑以不同速度缓慢漂移、呼吸、互相叠加，
      再加一道缓慢扫过的玻璃高光 → 通透的"液态玻璃"底
   2. 星链：稀疏星点 + 邻近连线（星座效果）
   3. 流星：头在前、尾拖后，飞出画面才回收

   抗锯齿：DPR×1.5（上限 3）超采样 + imageSmoothing 高质量
   ============================================================ */
(function () {
  'use strict'

  var canvas = document.getElementById('admin-space')
  if (!canvas) return
  var ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return

  var DPR = Math.min((window.devicePixelRatio || 1) * 1.5, 3)
  var W = 0, H = 0
  var blobs = [], stars = [], shooters = []
  var running = true
  var rafId = 0
  var lastT = 0
  var nextShoot = 3
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var lastLinkCount = 0

  // 液态玻璃层用半分辨率离屏画布渲染再放大：色斑本身是软的，放大无肉眼差别，
  // 但填充像素量降到 1/4（实测 5 个大色斑 + 全屏光带从 ~16ms 降到 ~4ms/帧）
  var BG_SCALE = 0.5
  var bgCanvas = document.createElement('canvas')
  var bgCtx = bgCanvas.getContext('2d')

  var LINK_DIST = 132
  var LINK_MAX = 3

  // 液态玻璃色斑配色（冷色为主，掺一点粉）
  var BLOB_COLORS = [
    [86, 132, 255],   // 蓝
    [140, 96, 255],   // 紫
    [64, 214, 255],   // 青
    [255, 96, 190],   // 粉
    [46, 178, 206]    // 青绿
  ]

  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')'
  }

  // ---------- 尺寸 ----------
  function layout() {
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.max(1, Math.floor(W * DPR))
    canvas.height = Math.max(1, Math.floor(H * DPR))
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    // 主画布只做"离屏层放大贴回"，用 bilinear 就够（high 质量滤镜很贵）
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'low'

    // 离屏液态层：半分辨率，坐标空间仍是 CSS 像素
    bgCanvas.width = Math.max(1, Math.round(W * BG_SCALE))
    bgCanvas.height = Math.max(1, Math.round(H * BG_SCALE))
    bgCtx.setTransform(BG_SCALE, 0, 0, BG_SCALE, 0, 0)
    bgCtx.imageSmoothingEnabled = true

    buildBlobs()
    buildStars()
  }

  // ---------- 液态玻璃色斑 ----------
  function buildBlobs() {
    blobs = []
    for (var i = 0; i < BLOB_COLORS.length; i++) {
      blobs.push({
        c: BLOB_COLORS[i],
        // 基准位置（视口比例）
        bx: 0.12 + Math.random() * 0.76,
        by: 0.1 + Math.random() * 0.8,
        // 漂移幅度（视口比例）
        ax: 0.08 + Math.random() * 0.14,
        ay: 0.07 + Math.random() * 0.12,
        px: Math.random() * Math.PI * 2,
        py: Math.random() * Math.PI * 2,
        sx: 0.045 + Math.random() * 0.045,   // rad/s（20~40 秒一个来回）
        sy: 0.035 + Math.random() * 0.045,
        r: 0.34 + Math.random() * 0.2,       // 半径（相对 min(W,H)）
        bp: Math.random() * Math.PI * 2,
        bs: 0.07 + Math.random() * 0.07,     // 呼吸速度
        alpha: 0.15 + Math.random() * 0.1
      })
    }
  }

  function drawLiquid(t) {
    var minD = Math.min(W, H)
    var g2 = bgCtx

    g2.clearRect(0, 0, W, H)

    // 1) 色斑（加色叠加 → 交叠处自然出高光）
    g2.globalCompositeOperation = 'lighter'
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i]
      var x = (b.bx + Math.sin(t * b.sx + b.px) * b.ax) * W
      var y = (b.by + Math.cos(t * b.sy + b.py) * b.ay) * H
      var r = minD * b.r * (1 + Math.sin(t * b.bs + b.bp) * 0.14)
      var g = g2.createRadialGradient(x, y, 0, x, y, r)
      g.addColorStop(0, rgba(b.c, b.alpha))
      g.addColorStop(0.42, rgba(b.c, b.alpha * 0.5))
      g.addColorStop(0.75, rgba(b.c, b.alpha * 0.14))
      g.addColorStop(1, rgba(b.c, 0))
      g2.fillStyle = g
      g2.beginPath()
      g2.arc(x, y, r, 0, Math.PI * 2)
      g2.fill()
    }

    // 2) 玻璃高光：一道很淡的斜向光带缓慢扫过
    var sweep = ((t * 0.035) % 2) - 0.5
    var gx = sweep * W * 1.2
    var sg = g2.createLinearGradient(gx - W * 0.34, 0, gx + W * 0.34, H * 0.5)
    sg.addColorStop(0, 'rgba(255,255,255,0)')
    sg.addColorStop(0.45, 'rgba(255,255,255,.035)')
    sg.addColorStop(0.5, 'rgba(255,255,255,.06)')
    sg.addColorStop(0.55, 'rgba(255,255,255,.035)')
    sg.addColorStop(1, 'rgba(255,255,255,0)')
    g2.fillStyle = sg
    g2.fillRect(0, 0, W, H)

    g2.globalCompositeOperation = 'source-over'

    // 放大贴回主画布（双线性插值，软色斑看不出差别）
    ctx.drawImage(bgCanvas, 0, 0, W, H)
  }

  // ---------- 星链 ----------
  function buildStars() {
    // 只做星链的锚点：稀疏、细小
    var count = Math.round(Math.min(110, Math.max(46, (W * H) / 20000)))
    stars = []
    for (var i = 0; i < count; i++) {
      var z = Math.random()
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: z,
        r: 0.5 + z * 1.05,
        vx: 1.2 + z * 4.4,
        vy: 0.6 + z * 2.4,
        ph: Math.random() * Math.PI * 2,
        sp: 0.5 + Math.random() * 1.4
      })
    }
  }

  function drawLinks(t) {
    ctx.lineWidth = 1.1
    lastLinkCount = 0
    for (var a = 0; a < stars.length; a++) {
      var sa = stars[a], linked = 0
      for (var b = a + 1; b < stars.length && linked < LINK_MAX; b++) {
        var sb = stars[b]
        var dx = sa.x - sb.x, dy = sa.y - sb.y
        var d2 = dx * dx + dy * dy
        if (d2 > LINK_DIST * LINK_DIST) continue
        var k = 1 - Math.sqrt(d2) / LINK_DIST
        ctx.strokeStyle = 'rgba(168,214,255,' + (k * 0.5 * (0.4 + 0.6 * Math.min(sa.z, sb.z))).toFixed(3) + ')'
        ctx.beginPath()
        ctx.moveTo(sa.x, sa.y)
        ctx.lineTo(sb.x, sb.y)
        ctx.stroke()
        linked++
        lastLinkCount++
      }
    }
    for (var c = 0; c < stars.length; c++) {
      var st = stars[c]
      var tw = 0.55 + 0.45 * Math.sin(t * st.sp + st.ph)
      ctx.beginPath()
      ctx.fillStyle = 'rgba(226,240,255,' + ((0.4 + 0.5 * st.z) * tw).toFixed(3) + ')'
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ---------- 流星 ----------
  function spawnShooter() {
    var fromTop = Math.random() < 0.65
    var ang = (26 + Math.random() * 24) * Math.PI / 180
    var speed = 620 + Math.random() * 460
    shooters.push({
      x: fromTop ? Math.random() * W * 0.9 : -40,
      y: fromTop ? -40 : Math.random() * H * 0.45,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      len: 130 + Math.random() * 170,
      life: 0,
      ttl: 6
    })
  }

  function drawShooters() {
    for (var m = shooters.length - 1; m >= 0; m--) {
      var sh = shooters[m]
      if (!reduce) { sh.x += sh.vx / 60; sh.y += sh.vy / 60; sh.life += 1 / 60 }
      var spd = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy) || 1
      var ux = sh.vx / spd, uy = sh.vy / spd
      var hx = sh.x, hy = sh.y
      var tx = sh.x - ux * sh.len, ty = sh.y - uy * sh.len
      var g = ctx.createLinearGradient(hx, hy, tx, ty)
      g.addColorStop(0, 'rgba(240,248,255,.95)')
      g.addColorStop(0.25, 'rgba(206,232,255,.42)')
      g.addColorStop(1, 'rgba(190,220,255,0)')
      ctx.strokeStyle = g
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      ctx.beginPath()
      ctx.fillStyle = 'rgba(245,250,255,.95)'
      ctx.arc(hx, hy, 1.9, 0, Math.PI * 2)
      ctx.fill()
      var off = 120
      if (sh.x - sh.len > W + off || sh.y - sh.len > H + off || sh.x < -off * 2 || sh.y < -off * 2 || sh.life > sh.ttl) {
        shooters.splice(m, 1)
      }
    }
  }

  // ---------- 主循环 ----------
  function draw(now) {
    var t = now / 1000
    ctx.clearRect(0, 0, W, H)

    drawLiquid(t)

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]
      if (!reduce) {
        s.x += s.vx / 60
        s.y += s.vy / 60
        if (s.x > W + 4) s.x = -4
        if (s.y > H + 4) s.y = -4
      }
    }
    drawLinks(t)

    if (!reduce) {
      nextShoot -= 1 / 60
      if (nextShoot <= 0) { spawnShooter(); nextShoot = 4 + Math.random() * 7 }
    }
    drawShooters()
  }

  function loop(now) {
    if (!running) return
    if (!lastT || now - lastT >= 15) {
      lastT = now
      draw(now)
    }
    rafId = requestAnimationFrame(loop)
  }

  // ---------- 事件 ----------
  window.addEventListener('resize', function () {
    layout()
    if (reduce) draw(performance.now())
  })

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      running = false
      cancelAnimationFrame(rafId)
    } else if (!reduce) {
      running = true
      lastT = 0
      rafId = requestAnimationFrame(loop)
    }
  })

  layout()
  if (reduce) {
    draw(performance.now())
  } else {
    rafId = requestAnimationFrame(loop)
  }

  // 自检钩子
  window.__adminSpace = {
    stats: function () {
      var s = shooters[0]
      return {
        blobs: blobs.length,
        stars: stars.length,
        links: lastLinkCount,
        shooters: shooters.length,
        firstShooter: s ? { x: Math.round(s.x), y: Math.round(s.y), vx: Math.round(s.vx), vy: Math.round(s.vy), len: Math.round(s.len) } : null,
        dpr: DPR,
        reduce: reduce
      }
    },
    spawn: function () { spawnShooter(); return shooters.length },
    viewport: function () { return { w: W, h: H } }
  }
})()
