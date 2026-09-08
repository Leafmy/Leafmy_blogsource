/* ============================================================
   管理页宇宙背景（canvas 星场）
   ------------------------------------------------------------
   - 星点：按面积自适应数量，按深度(z)分层，缓慢漂移 + 闪烁
   - 星链：邻近星点之间连线，透明度随距离衰减（星座效果）
   - 流星：头部在前、尾部拖后，沿方向飞出画面后才回收
   - 主题：跟随 html[data-theme]，明/暗两套配色
   - 性能：单个 canvas + rAF；隐藏标签页暂停；DPR 上限 2；
           prefers-reduced-motion 时只画静态一帧
   ============================================================ */
(function () {
  'use strict'

  var canvas = document.getElementById('admin-space')
  if (!canvas) return
  var ctx = canvas.getContext('2d', { alpha: true })
  if (!ctx) return

  var DPR = Math.min(window.devicePixelRatio || 1, 2)
  var W = 0, H = 0
  var stars = []
  var shooters = []
  var running = true
  var rafId = 0
  var lastT = 0
  var nextShoot = 2.5
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  var theme = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
  var lastLinkCount = 0

  // 星链最大连接距离 / 每颗星最多连几条
  var LINK_DIST = 132
  var LINK_MAX = 3

  var PALETTE = {
    dark: {
      star: [214, 232, 255],
      bright: [255, 255, 255],
      warm: [255, 226, 178],
      link: [124, 190, 255],
      shoot: [225, 240, 255]
    },
    light: {
      star: [58, 92, 140],
      bright: [22, 48, 88],
      warm: [150, 96, 40],
      link: [56, 116, 196],
      shoot: [40, 90, 160]
    }
  }

  function pal() { return PALETTE[theme] || PALETTE.dark }

  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + a.toFixed(3) + ')'
  }

  // ---------- 尺寸 ----------
  function resize() {
    W = window.innerWidth
    H = window.innerHeight
    canvas.width = Math.max(1, Math.floor(W * DPR))
    canvas.height = Math.max(1, Math.floor(H * DPR))
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    buildStars()
  }

  function buildStars() {
    // 密度：每 ~11000px² 一颗，限制 70~200 颗
    var count = Math.round(Math.min(200, Math.max(70, (W * H) / 11000)))
    stars = []
    for (var i = 0; i < count; i++) {
      var z = Math.random()               // 0 远 → 1 近
      var isBright = Math.random() < 0.07
      stars.push({
        x: Math.random() * W,
        y: Math.random() * H,
        z: z,
        r: (isBright ? 1.6 : 0.5) + z * 1.3,
        vx: 2 + z * 7,                    // px/s（越近漂得越快 → 视差）
        vy: 1 + z * 3.5,
        ph: Math.random() * Math.PI * 2,  // 闪烁相位
        sp: 0.5 + Math.random() * 1.5,    // 闪烁速度
        bright: isBright,
        warm: isBright && Math.random() < 0.35
      })
    }
  }

  // ---------- 流星 ----------
  function spawnShooter() {
    // 从上方或左侧进入，朝右下飞，保证能飞出画面
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
  function draw(now) {
    var t = now / 1000
    var p = pal()
    ctx.clearRect(0, 0, W, H)

    // 星点漂移 + 环绕
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i]
      s.x += s.vx * (reduce ? 0 : 1) / 60
      s.y += s.vy * (reduce ? 0 : 1) / 60
      if (s.x > W + 4) s.x = -4
      if (s.y > H + 4) s.y = -4
    }

    // ---- 星链 ----
    ctx.lineWidth = 1
    lastLinkCount = 0
    for (var a = 0; a < stars.length; a++) {
      var sa = stars[a]
      var linked = 0
      for (var b = a + 1; b < stars.length && linked < LINK_MAX; b++) {
        var sb = stars[b]
        var dx = sa.x - sb.x
        var dy = sa.y - sb.y
        var d2 = dx * dx + dy * dy
        if (d2 > LINK_DIST * LINK_DIST) continue
        var d = Math.sqrt(d2)
        var k = 1 - d / LINK_DIST
        // 越近的星连线越亮；深度差越大越淡（层次感）
        var alpha = k * 0.42 * (0.35 + 0.65 * Math.min(sa.z, sb.z))
        ctx.strokeStyle = rgba(p.link, alpha)
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
      var tw = 0.55 + 0.45 * Math.sin(t * st.sp + st.ph)     // 闪烁 0.1~1
      var alpha = (st.bright ? 0.95 : 0.35 + 0.45 * st.z) * tw
      var col = st.warm ? p.warm : (st.bright ? p.bright : p.star)
      ctx.beginPath()
      ctx.fillStyle = rgba(col, alpha)
      ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2)
      ctx.fill()
      // 亮星加一圈光晕
      if (st.bright) {
        ctx.beginPath()
        ctx.fillStyle = rgba(col, alpha * 0.14)
        ctx.arc(st.x, st.y, st.r * 3.4, 0, Math.PI * 2)
        ctx.fill()
      }
    }

    // ---- 流星（头在前、尾拖后，飞出画面才回收）----
    if (!reduce) {
      nextShoot -= 1 / 60
      if (nextShoot <= 0) {
        spawnShooter()
        nextShoot = 4 + Math.random() * 7
      }
    }
    for (var m = shooters.length - 1; m >= 0; m--) {
      var sh = shooters[m]
      if (!reduce) {
        sh.x += sh.vx / 60
        sh.y += sh.vy / 60
        sh.life += 1 / 60
      }
      var spd = Math.sqrt(sh.vx * sh.vx + sh.vy * sh.vy) || 1
      var ux = sh.vx / spd, uy = sh.vy / spd
      // 头（前）→ 尾（后）
      var hx = sh.x, hy = sh.y
      var tx = sh.x - ux * sh.len, ty = sh.y - uy * sh.len

      var g = ctx.createLinearGradient(hx, hy, tx, ty)
      g.addColorStop(0, rgba(p.shoot, 0.95))
      g.addColorStop(0.25, rgba(p.shoot, 0.45))
      g.addColorStop(1, rgba(p.shoot, 0))
      ctx.strokeStyle = g
      ctx.lineWidth = 2
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(tx, ty)
      ctx.lineTo(hx, hy)
      ctx.stroke()

      // 头部亮点
      ctx.beginPath()
      ctx.fillStyle = rgba(p.shoot, 0.9)
      ctx.arc(hx, hy, 1.9, 0, Math.PI * 2)
      ctx.fill()

      // 完全飞出画面才回收
      var off = 120
      if (sh.x - sh.len > W + off || sh.y - sh.len > H + off || sh.x < -off * 2 || sh.y < -off * 2 || sh.life > sh.ttl) {
        shooters.splice(m, 1)
      }
    }
  }

  function loop(now) {
    if (!running) return
    // 限帧到 ~60fps，避免高刷屏空转
    if (!lastT || now - lastT >= 15) {
      lastT = now
      draw(now)
    }
    rafId = requestAnimationFrame(loop)
  }

  // ---------- 事件 ----------
  window.addEventListener('resize', function () {
    resize()
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

  // 主题切换：admin.js 会派发 admin:theme 事件
  document.addEventListener('admin:theme', function (e) {
    theme = (e && e.detail === 'light') ? 'light' : 'dark'
    if (reduce) draw(performance.now())
  })

  resize()
  if (reduce) {
    draw(performance.now())
  } else {
    rafId = requestAnimationFrame(loop)
  }

  // 调试/自检钩子（只读 + 强制生成一颗流星）
  window.__adminSpace = {
    stats: function () {
      var s = shooters[0]
      return {
        stars: stars.length,
        links: lastLinkCount,
        shooters: shooters.length,
        firstShooter: s ? { x: Math.round(s.x), y: Math.round(s.y), vx: Math.round(s.vx), vy: Math.round(s.vy), len: Math.round(s.len) } : null,
        theme: theme,
        reduce: reduce
      }
    },
    spawn: function () { spawnShooter(); return shooters.length },
    viewport: function () { return { w: W, h: H } }
  }
})()
