/* ============================================================
   管理页宇宙背景（canvas）
   ------------------------------------------------------------
   层次（从后到前）：
   1. 银河带：斜向星尘带 + 柔光，沿带缓慢流动
   2. 星场：按深度分层视差漂移 + 闪烁
   3. 星链：邻近星点连线（星座效果）
   4. 恒星：几颗大亮星，多层光晕 + 十字星芒，缓慢脉动
   5. 黑洞：吸积盘旋转 + 引力透镜弧 + 事件视界
   6. 流星：头在前、尾拖后，飞出画面才回收

   说明：按用户要求"交给 GPU"，视觉优先，不做性能降级；
   仅保留必要优化（静态渐变缓存、隐藏标签页暂停、DPR 上限 2）。
   ============================================================ */
(function () {
  'use strict'

  var canvas = document.getElementById('admin-space')
  if (!canvas) return
  var ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return

  var DPR = Math.min(window.devicePixelRatio || 1, 2)
  var W = 0, H = 0
  var stars = [], suns = [], dust = []
  var shooters = []
  var running = true
  var rafId = 0
  var lastT = 0
  var nextShoot = 2.5
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var lastLinkCount = 0

  var LINK_DIST = 128
  var LINK_MAX = 3
  var GALAXY_ANGLE = -0.34          // 银河带倾角
  var BH = { x: 0, y: 0, r: 44 }    // 黑洞（随视口布局）

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
    BH.x = Math.round(W * 0.16)
    BH.y = Math.round(H * 0.78)
    BH.r = Math.max(34, Math.min(58, Math.round(Math.min(W, H) * 0.05)))
    buildStars()
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

  // 银河带星尘：沿带方向分布，垂直方向高斯衰减
  function buildDust() {
    var count = Math.round(Math.min(420, Math.max(160, (W * H) / 4200)))
    var cx = W * 0.5, cy = H * 0.46
    var dir = { x: Math.cos(GALAXY_ANGLE), y: Math.sin(GALAXY_ANGLE) }
    var nor = { x: -dir.y, y: dir.x }
    var halfLen = Math.max(W, H) * 0.72
    var halfWid = Math.min(W, H) * 0.11
    dust = []
    for (var i = 0; i < count; i++) {
      // 沿带均匀，垂直方向高斯
      var t = (Math.random() * 2 - 1) * halfLen
      var g = (Math.random() + Math.random() + Math.random() - 1.5) / 1.5
      var o = g * halfWid
      var warm = Math.random() < 0.22
      dust.push({
        x: cx + dir.x * t + nor.x * o,
        y: cy + dir.y * t + nor.y * o,
        r: 0.5 + Math.random() * 1.1,
        a: (1 - Math.abs(g)) * (0.35 + Math.random() * 0.5),
        c: warm ? [255, 224, 188] : (Math.random() < 0.5 ? [205, 224, 255] : [255, 255, 255]),
        ph: Math.random() * Math.PI * 2,
        sp: 0.4 + Math.random() * 1.2,
        flow: 3 + Math.random() * 9        // 沿带流动速度 px/s
      })
    }
  }

  // 恒星：几颗大亮星
  function buildSuns() {
    var palette = [
      { c: [255, 246, 224], r: 0 },
      { c: [190, 220, 255], r: 0 },
      { c: [255, 214, 170], r: 0 },
      { c: [220, 235, 255], r: 0 }
    ]
    var spots = [
      { x: 0.78, y: 0.16, s: 1.0 },
      { x: 0.93, y: 0.62, s: 0.72 },
      { x: 0.38, y: 0.09, s: 0.6 },
      { x: 0.62, y: 0.86, s: 0.66 }
    ]
    suns = spots.map(function (sp, i) {
      var p = palette[i % palette.length]
      return {
        x: sp.x * W,
        y: sp.y * H,
        r: (11 + Math.random() * 5) * sp.s,
        c: p.c,
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
  function drawGalaxy(t) {
    // 柔光带：沿垂直方向做线性渐变，填充一个旋转矩形
    var cx = W * 0.5, cy = H * 0.46
    var half = Math.max(W, H) * 0.95
    var wid = Math.min(W, H) * 0.34
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(GALAXY_ANGLE)
    var g = ctx.createLinearGradient(0, -wid, 0, wid)
    g.addColorStop(0, 'rgba(120,160,255,0)')
    g.addColorStop(0.34, 'rgba(96,150,255,.075)')
    g.addColorStop(0.44, 'rgba(150,175,255,.14)')
    g.addColorStop(0.5, 'rgba(214,226,255,.20)')
    g.addColorStop(0.56, 'rgba(190,150,255,.14)')
    g.addColorStop(0.66, 'rgba(120,160,255,.075)')
    g.addColorStop(1, 'rgba(120,160,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(-half, -wid, half * 2, wid * 2)
    ctx.restore()

    // 星尘：沿带缓慢流动（越界回绕）
    var dir = { x: Math.cos(GALAXY_ANGLE), y: Math.sin(GALAXY_ANGLE) }
    var span = half * 2
    for (var i = 0; i < dust.length; i++) {
      var d = dust[i]
      if (!reduce) {
        d.x += dir.x * d.flow / 60
        d.y += dir.y * d.flow / 60
      }
      // 回绕：沿带方向超出范围就回到另一端
      var rel = (d.x - cx) * dir.x + (d.y - cy) * dir.y
      if (rel > half) { d.x -= dir.x * span; d.y -= dir.y * span }
      var tw = 0.6 + 0.4 * Math.sin(t * d.sp + d.ph)
      ctx.beginPath()
      ctx.fillStyle = rgba(d.c, d.a * tw)
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  function drawBlackHole(t) {
    var cx = BH.x, cy = BH.y, R = BH.r
    ctx.save()

    // 外层光晕
    var glow = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 4.6)
    glow.addColorStop(0, 'rgba(120,170,255,.20)')
    glow.addColorStop(0.45, 'rgba(110,150,255,.07)')
    glow.addColorStop(1, 'rgba(110,150,255,0)')
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(cx, cy, R * 4.6, 0, Math.PI * 2)
    ctx.fill()

    // 吸积盘（旋转椭圆环，加色混合）
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

    // 引力透镜弧（上下两道细亮弧）
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
    // 光晕
    var g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r * 9)
    g.addColorStop(0, rgba(s.c, .95))
    g.addColorStop(0.14, rgba(s.c, .55))
    g.addColorStop(0.42, rgba(s.c, .12))
    g.addColorStop(1, rgba(s.c, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(s.x, s.y, r * 9, 0, Math.PI * 2)
    ctx.fill()
    // 核心
    ctx.beginPath()
    ctx.fillStyle = '#fff'
    ctx.arc(s.x, s.y, r * 0.5, 0, Math.PI * 2)
    ctx.fill()
    // 十字星芒
    ctx.globalCompositeOperation = 'lighter'
    ctx.strokeStyle = rgba(s.c, .5)
    ctx.lineWidth = 1.1
    ctx.beginPath()
    ctx.moveTo(s.x - r * 7, s.y); ctx.lineTo(s.x + r * 7, s.y)
    ctx.moveTo(s.x, s.y - r * 7); ctx.lineTo(s.x, s.y + r * 7)
    ctx.stroke()
    ctx.globalCompositeOperation = 'source-over'
  }

  function draw(now) {
    var t = now / 1000
    ctx.clearRect(0, 0, W, H)

    // ---- 银河 ----
    drawGalaxy(t)

    // ---- 星场漂移 ----
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]
      if (!reduce) {
        s.x += s.vx / 60
        s.y += s.vy / 60
        if (s.x > W + 4) s.x = -4
        if (s.y > H + 4) s.y = -4
      }
    }

    // ---- 星链 ----
    ctx.lineWidth = 1
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

    // ---- 星点 ----
    for (var c = 0; c < stars.length; c++) {
      var st = stars[c]
      var tw = 0.55 + 0.45 * Math.sin(t * st.sp + st.ph)
      ctx.beginPath()
      ctx.fillStyle = 'rgba(214,232,255,' + ((0.32 + 0.5 * st.z) * tw).toFixed(3) + ')'
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2)
      ctx.fill()
    }

    // ---- 恒星 ----
    for (var d2i = 0; d2i < suns.length; d2i++) drawSun(suns[d2i], t)

    // ---- 黑洞 ----
    drawBlackHole(t)

    // ---- 流星 ----
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
    buildDust()
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
  buildDust()
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
        dust: dust.length,
        suns: suns.length,
        links: lastLinkCount,
        shooters: shooters.length,
        firstShooter: s ? { x: Math.round(s.x), y: Math.round(s.y), vx: Math.round(s.vx), vy: Math.round(s.vy), len: Math.round(s.len) } : null,
        blackHole: { x: BH.x, y: BH.y, r: BH.r },
        reduce: reduce
      }
    },
    spawn: function () { spawnShooter(); return shooters.length },
    viewport: function () { return { w: W, h: H } }
  }
})()
