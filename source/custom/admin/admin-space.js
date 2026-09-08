/* ============================================================
   管理页宇宙背景（canvas）
   ------------------------------------------------------------
   层次（从后到前）：
   1. 螺旋星系（银河）：3 条对数螺旋悬臂 + 核球 + 尘埃带 + 差速旋转
   2. 星场：按深度分层视差漂移 + 闪烁
   3. 星链：邻近星点连线（星座效果）
   4. 恒星：几颗大亮星，多层光晕 + 十字星芒，缓慢脉动
   5. 黑洞：吸积盘旋转 + 引力透镜弧 + 事件视界
   6. 流星：头在前、尾拖后，飞出画面才回收

   抗锯齿：canvas 按 DPR×1.5（上限 3）超采样 + imageSmoothing 高质量；
   所有曲线/细线都落在亚像素精度上。
   ============================================================ */
(function () {
  'use strict'

  var canvas = document.getElementById('admin-space')
  if (!canvas) return
  var ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return

  var DPR = Math.min((window.devicePixelRatio || 1) * 1.5, 3)
  var W = 0, H = 0
  var stars = [], suns = []
  var shooters = []
  var running = true
  var rafId = 0
  var lastT = 0
  var nextShoot = 2.5
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var lastLinkCount = 0

  var LINK_DIST = 128
  var LINK_MAX = 3
  var BH = { x: 0, y: 0, r: 44 }
  var GALAXY = { cx: 0, cy: 0, R: 0, flatten: 0.4, tilt: -0.26, parts: [] }

  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')'
  }

  // ---------- 尺寸 / 布局 ----------
  function layout() {
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.max(1, Math.floor(W * DPR))
    canvas.height = Math.max(1, Math.floor(H * DPR))
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'

    BH.x = Math.round(W * 0.14)
    BH.y = Math.round(H * 0.74)
    BH.r = Math.max(34, Math.min(58, Math.round(Math.min(W, H) * 0.05)))

    // 星系放右下角，悬臂向左上扫过画面
    GALAXY.cx = W * 0.66
    GALAXY.cy = H * 0.86
    GALAXY.R = Math.max(W, H) * 0.46

    buildStars()
    buildGalaxy()
    buildSuns()
  }

  function buildStars() {
    var count = Math.round(Math.min(190, Math.max(70, (W * H) / 12000)))
    stars = []
    for (var i = 0; i < count; i++) {
      var z = Math.random()
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: z,
        r: 0.5 + z * 1.25,
        vx: 1.6 + z * 6,
        vy: 0.8 + z * 3,
        ph: Math.random() * Math.PI * 2,
        sp: 0.5 + Math.random() * 1.5
      })
    }
  }

  // 螺旋星系：对数螺旋悬臂 + 高斯散布 + 盘厚 + 差速旋转
  function buildGalaxy() {
    var parts = []
    var arms = 3
    var count = 1500
    var R = GALAXY.R
    for (var i = 0; i < count; i++) {
      // 半径分布：核球密、外缘稀
      var t = Math.pow(Math.random(), 0.58)
      var r = t * R
      // 悬臂基准角 + 螺旋扭转
      var baseAngle = (i % arms) / arms * Math.PI * 2 + t * 3.6
      // 越靠外越散（核球几乎成团）
      var spread = 0.1 + 0.42 * t
      var angle = baseAngle + (Math.random() + Math.random() - 1) * spread
      var rr = r * (0.93 + Math.random() * 0.14)
      var thick = (Math.random() + Math.random() - 1) * (5 + 26 * t)
      // 色温：核球暖白 → 中盘白 → 外缘冷蓝；悬臂里掺一点粉（电离氢区）
      var warm = Math.random() < (1 - t) * 0.8
      var col = warm ? [255, 228, 194] : [192, 216, 255]
      if (t < 0.16) col = [255, 246, 228]
      if (!warm && Math.random() < 0.05) col = [255, 190, 220]
      parts.push({
        r: rr,
        a: angle,
        z: thick,
        size: 0.4 + Math.random() * 1.2 * (1.15 - t * 0.45),
        alpha: (0.22 + Math.random() * 0.5) * (0.55 + 0.45 * (1 - t)),
        col: col,
        // 差速旋转：内圈角速度大 → 悬臂自然剪切成螺旋
        om: 0.34 / (0.3 + Math.pow(rr / R, 0.7)),
        bright: Math.random() < 0.022
      })
    }
    GALAXY.parts = parts
  }

  // 恒星：几颗大亮星
  function buildSuns() {
    var palette = [
      [255, 246, 224],
      [190, 220, 255],
      [255, 214, 170],
      [220, 235, 255]
    ]
    var spots = [
      { x: 0.78, y: 0.16, s: 1.0 },
      { x: 0.93, y: 0.6, s: 0.72 },
      { x: 0.36, y: 0.08, s: 0.6 },
      { x: 0.58, y: 0.9, s: 0.66 }
    ]
    suns = spots.map(function (sp, i) {
      return {
        x: sp.x * W,
        y: sp.y * H,
        r: (11 + Math.random() * 5) * sp.s,
        c: palette[i % palette.length],
        ph: Math.random() * Math.PI * 2,
        sp: 0.25 + Math.random() * 0.3
      }
    })
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

  // ---------- 绘制 ----------
  // 螺旋星系：外发光 → 尘埃带 → 粒子（差速旋转）→ 核球
  function drawGalaxy(t) {
    var g = GALAXY
    if (!g.parts.length) return
    var cosT = Math.cos(g.tilt), sinT = Math.sin(g.tilt)

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'

    // 1) 星系整体外发光
    var halo = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.R * 1.3)
    halo.addColorStop(0, 'rgba(255,242,220,.20)')
    halo.addColorStop(0.16, 'rgba(196,205,255,.13)')
    halo.addColorStop(0.46, 'rgba(120,148,255,.06)')
    halo.addColorStop(1, 'rgba(70,96,220,0)')
    ctx.fillStyle = halo
    ctx.beginPath()
    ctx.ellipse(g.cx, g.cy, g.R * 1.3, g.R * 1.3 * g.flatten, g.tilt, 0, Math.PI * 2)
    ctx.fill()

    // 2) 尘埃带：悬臂之间压暗
    ctx.globalCompositeOperation = 'source-over'
    for (var d = 0; d < 3; d++) {
      ctx.save()
      ctx.translate(g.cx, g.cy)
      ctx.rotate(g.tilt)
      ctx.scale(1, g.flatten)
      ctx.rotate(d / 3 * Math.PI * 2 + t * 0.06)
      var dustG = ctx.createRadialGradient(0, 0, g.R * 0.22, 0, 0, g.R * 0.95)
      dustG.addColorStop(0, 'rgba(0,0,0,0)')
      dustG.addColorStop(0.55, 'rgba(2,4,12,.30)')
      dustG.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.fillStyle = dustG
      ctx.beginPath()
      ctx.ellipse(0, 0, g.R * 0.95, g.R * 0.3, 0.5, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }

    // 3) 粒子
    ctx.globalCompositeOperation = 'lighter'
    for (var i = 0; i < g.parts.length; i++) {
      var p = g.parts[i]
      var ang = p.a + (reduce ? 0 : t * p.om)
      var x = Math.cos(ang) * p.r
      var y = Math.sin(ang) * p.r * g.flatten + p.z
      var px = g.cx + (x * cosT - y * sinT)
      var py = g.cy + (x * sinT + y * cosT)
      if (px < -24 || px > W + 24 || py < -24 || py > H + 24) continue
      ctx.beginPath()
      ctx.fillStyle = rgba(p.col, p.alpha)
      ctx.arc(px, py, p.size, 0, Math.PI * 2)
      ctx.fill()
      if (p.bright) {
        var bg = ctx.createRadialGradient(px, py, 0, px, py, p.size * 7)
        bg.addColorStop(0, rgba(p.col, .8))
        bg.addColorStop(1, rgba(p.col, 0))
        ctx.fillStyle = bg
        ctx.beginPath()
        ctx.arc(px, py, p.size * 7, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // 4) 核球
    var core = ctx.createRadialGradient(g.cx, g.cy, 0, g.cx, g.cy, g.R * 0.17)
    core.addColorStop(0, 'rgba(255,255,248,.95)')
    core.addColorStop(0.3, 'rgba(255,240,206,.62)')
    core.addColorStop(0.68, 'rgba(255,208,150,.20)')
    core.addColorStop(1, 'rgba(255,180,120,0)')
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.ellipse(g.cx, g.cy, g.R * 0.17, g.R * 0.17 * (g.flatten + 0.22), g.tilt, 0, Math.PI * 2)
    ctx.fill()

    ctx.restore()
  }

  function drawBlackHole(t) {
    var cx = BH.x, cy = BH.y, R = BH.r
    ctx.save()

    var glow = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 4.6)
    glow.addColorStop(0, 'rgba(120,170,255,.20)')
    glow.addColorStop(0.45, 'rgba(110,150,255,.07)')
    glow.addColorStop(1, 'rgba(110,150,255,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, R * 4.6, 0, Math.PI * 2)
    ctx.fill()

    // 吸积盘
    ctx.globalCompositeOperation = 'lighter'
    ctx.translate(cx, cy)
    ctx.rotate(-0.42 + t * 0.06)
    var diskGrad = ctx.createLinearGradient(-R * 3, 0, R * 3, 0)
    diskGrad.addColorStop(0, 'rgba(120,170,255,0)')
    diskGrad.addColorStop(0.3, 'rgba(150,200,255,.35)')
    diskGrad.addColorStop(0.5, 'rgba(255,240,220,.75)')
    diskGrad.addColorStop(0.7, 'rgba(255,180,150,.35)')
    diskGrad.addColorStop(1, 'rgba(255,150,120,0)')
    ctx.strokeStyle = diskGrad
    ctx.lineCap = 'round'
    ctx.lineWidth = R * 0.42
    ctx.beginPath()
    ctx.ellipse(0, 0, R * 2.05, R * 0.5, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = R * 0.16
    ctx.beginPath()
    ctx.ellipse(0, 0, R * 2.5, R * 0.62, 0, 0, Math.PI * 2)
    ctx.stroke()

    // 引力透镜弧
    ctx.lineWidth = 1.6
    ctx.strokeStyle = 'rgba(220,235,255,.55)'
    ctx.beginPath()
    ctx.ellipse(0, 0, R * 1.45, R * 1.45, 0, Math.PI * 1.08, Math.PI * 1.92)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(190,215,255,.35)'
    ctx.beginPath()
    ctx.ellipse(0, 0, R * 1.45, R * 1.45, 0, Math.PI * 0.08, Math.PI * 0.92)
    ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'

    // 事件视界
    ctx.beginPath()
    ctx.fillStyle = '#000'
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.fill()
    ctx.lineWidth = 1.2
    ctx.strokeStyle = 'rgba(150,190,255,.45)'
    ctx.beginPath()
    ctx.arc(0, 0, R, 0, Math.PI * 2)
    ctx.stroke()

    ctx.restore()
  }

  function drawSun(s, t) {
    var pulse = 1 + 0.12 * Math.sin(t * s.sp * 2 + s.ph)
    var r = s.r * pulse
    var g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 9)
    g.addColorStop(0, rgba(s.c, .95))
    g.addColorStop(0.14, rgba(s.c, .55))
    g.addColorStop(0.42, rgba(s.c, .12))
    g.addColorStop(1, rgba(s.c, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(s.x, s.y, r * 9, 0, Math.PI * 2)
    ctx.fill()

    ctx.beginPath()
    ctx.fillStyle = '#fff'
    ctx.arc(s.x, s.y, r * 0.5, 0, Math.PI * 2)
    ctx.fill()

    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = rgba(s.c, .5)
    ctx.lineWidth = 1.1
    ctx.beginPath()
    ctx.moveTo(s.x - r * 7, s.y)
    ctx.lineTo(s.x + r * 7, s.y)
    ctx.moveTo(s.x, s.y - r * 7)
    ctx.lineTo(s.x, s.y + r * 7)
    ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'
  }

  function draw(now) {
    var t = now / 1000
    ctx.clearRect(0, 0, W, H)

    drawGalaxy(t)

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]
      if (!reduce) {
        s.x += s.vx / 60
        s.y += s.vy / 60
        if (s.x > W + 4) s.x = -4
        if (s.y > H + 4) s.y = -4
      }
    }

    // 星链
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
        ctx.strokeStyle = 'rgba(124,190,255,' + (k * 0.4 * (0.35 + 0.65 * Math.min(sa.z, sb.z))).toFixed(3) + ')'
        ctx.beginPath()
        ctx.moveTo(sa.x, sa.y)
        ctx.lineTo(sb.x, sb.y)
        ctx.stroke()
        linked++
        lastLinkCount++
      }
    }

    // 星点
    for (var c = 0; c < stars.length; c++) {
      var st = stars[c]
      var tw = 0.55 + 0.45 * Math.sin(t * st.sp + st.ph)
      ctx.beginPath()
      ctx.fillStyle = 'rgba(214,232,255,' + ((0.32 + 0.5 * st.z) * tw).toFixed(3) + ')'
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2)
      ctx.fill()
    }

    for (var si = 0; si < suns.length; si++) drawSun(suns[si], t)

    drawBlackHole(t)

    // 流星
    if (!reduce) {
      nextShoot -= 1 / 60
      if (nextShoot <= 0) { spawnShooter(); nextShoot = 4 + Math.random() * 7 }
    }
    for (var m = shooters.length - 1; m >= 0; m--) {
      var sh = shooters[m]
      if (!reduce) { sh.x += sh.vx / 60; sh.y += sh.vy / 60; sh.life += 1 / 60 }
      var spd = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy) || 1
      var ux = sh.vx / spd, uy = sh.vy / spd
      var hx = sh.x, hy = sh.y
      var tx = sh.x - ux * sh.len, ty = sh.y - uy * sh.len
      var g = ctx.createLinearGradient(hx, hy, tx, ty)
      g.addColorStop(0, 'rgba(228,242,255,.95)')
      g.addColorStop(0.25, 'rgba(200,225,255,.42)')
      g.addColorStop(1, 'rgba(190,220,255,0)')
      ctx.strokeStyle = g
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.stroke()
      ctx.beginPath()
      ctx.fillStyle = 'rgba(240,248,255,.95)'
      ctx.arc(hx, hy, 1.9, 0, Math.PI * 2)
      ctx.fill()
      var off = 120
      if (sh.x - sh.len > W + off || sh.y - sh.len > H + off || sh.x < -off * 2 || sh.y < -off * 2 || sh.life > sh.ttl) {
        shooters.splice(m, 1)
      }
    }
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
        stars: stars.length,
        galaxyParts: GALAXY.parts.length,
        suns: suns.length,
        links: lastLinkCount,
        shooters: shooters.length,
        firstShooter: s ? { x: Math.round(s.x), y: Math.round(s.y), vx: Math.round(s.vx), vy: Math.round(s.vy), len: Math.round(s.len) } : null,
        blackHole: { x: BH.x, y: BH.y, r: BH.r },
        galaxy: { cx: Math.round(GALAXY.cx), cy: Math.round(GALAXY.cy), R: Math.round(GALAXY.R) },
        dpr: DPR,
        reduce: reduce
      }
    },
    spawn: function () { spawnShooter(); return shooters.length },
    viewport: function () { return { w: W, h: H } }
  }
})()
