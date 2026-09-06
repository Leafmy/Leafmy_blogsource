/* ============================================================
   鸿蒙 OS 风压感光效组件 (force-glow.js)
   ------------------------------------------------------------
   功能:
   - 光效实时跟随触点/鼠标, 平滑插值无跳变
   - 力度(真实压力 / 按住时长降级) → 光晕亮度(opacity) + 扩散(scale)
     + 颜色渐变(冷蓝外晕 ↔ 暖白核心权重)
   - 输入: Pointer Events(统一鼠标/触屏/笔) + TouchEvent(iOS force)
   - 降级: 无压感设备用"按住时长"模拟力度(按住越久光晕越强越扩散)
   - 暴露: window.ForceGlow.create(el, opts) 供任意元素复用
   ============================================================ */
(function () {
  'use strict'

  /* ---------- 全局 rAF 调度(所有实例共享一个循环) ---------- */
  var tickers = []        // 活跃实例
  var rafId = 0
  function scheduleTick() {
    if (rafId || !tickers.length) return
    var last = performance.now()
    function frame(now) {
      rafId = 0
      var dt = Math.min(50, now - last)
      last = now
      for (var i = tickers.length - 1; i >= 0; i--) {
        if (!tickers[i]._step(dt)) tickers.splice(i, 1)
      }
      if (tickers.length) rafId = requestAnimationFrame(frame)
    }
    rafId = requestAnimationFrame(frame)
  }

  /* ---------- 压感能力检测(惰性, 首次触摸采样判定) ---------- */
  var forceMode = null    // null=未知, 'true', 'false'
  var forceSamples = []
  function hasPressure(e) {
    // 压感笔: PointerEvent.pressure 0~1 真实可用
    if (e.pointerType === 'pen') { forceMode = 'true'; return true }
    // 触摸: 看 touch.force 离散度
    if (e.touches && e.touches.length) {
      var f = e.touches[0].force
      if (typeof f === 'number' && f > 0) {
        forceSamples.push(f)
        if (forceSamples.length > 4) {
          var min = Infinity, max = -Infinity
          for (var i = 0; i < forceSamples.length; i++) {
            if (forceSamples[i] < min) min = forceSamples[i]
            if (forceSamples[i] > max) max = forceSamples[i]
          }
          // 采样有离散 → 有压感; 全恒等 → 降级
          forceMode = (max - min) > 0.08 ? 'true' : 'false'
          return forceMode === 'true'
        }
        return true // 采样中先假定有, 后续再收敛
      }
      forceMode = 'false'
      return false
    }
    return false
  }
  function pressureOf(e) {
    if (e.pointerType === 'pen' && typeof e.pressure === 'number') {
      return Math.max(0, Math.min(1, e.pressure))
    }
    if (e.touches && e.touches.length && typeof e.touches[0].force === 'number') {
      var f = e.touches[0].force
      if (f > 0 && f <= 1) return f
      if (f > 1) return 1
    }
    return 0
  }

  /* ---------- 实例 ---------- */
  function ForceGlowHost(host, opts) {
    this.host = host
    this.opts = opts
    this.glow = null
    // 平滑插值状态(展示值 cur, 目标值 target)
    this.cx = 0; this.cy = 0          // 当前触点(相对 host)
    this.tx = 0; this.ty = 0          // 目标触点
    this.curForce = 0                 // 当前力度(展示)
    this.targetForce = 0              // 目标力度
    this.pressed = false              // 是否按压中
    this.holdStart = 0                // 按住起始时间(降级模拟用)
    this.active = false               // 是否在 ticker 中
    this._build()
  }

  ForceGlowHost.prototype._build = function () {
    var self = this
    var host = this.host
    // 注入光晕元素
    var glow = document.createElement('span')
    glow.className = 'force-glow'
    glow.setAttribute('aria-hidden', 'true')
    host.appendChild(glow)
    host.classList.add('force-glow-host')
    this.glow = glow

    // 鼠标进入(桌面 hover 也点亮, 替代旧静态光晕)
    host.addEventListener('pointerenter', function (e) {
      self._move(e)
      if (!self.pressed) self.targetForce = self.opts.hoverForce
      self._ensureActive()
    })
    host.addEventListener('pointermove', function (e) {
      self._move(e)
      if (!self.pressed) {
        self.targetForce = self.opts.hoverForce
        self._ensureActive()
      }
    })
    host.addEventListener('pointerleave', function () {
      if (!self.pressed) self._fadeOut()
    })
    // 按压开始
    host.addEventListener('pointerdown', function (e) {
      // 忽略非主键/非触摸(右键等)
      if (e.pointerType === 'mouse' && e.button !== 0) return
      self.pressed = true
      self._move(e)
      // 力度来源:
      //  1) 压感笔/真压感触屏(pointer 事件给 pressure)
      //  2) iOS touch.force(单独在 touchstart/move 采样)
      //  3) 否则: 按住时长降级模拟
      if (e.pointerType === 'pen') {
        self.forceType = 'pressure'
        self.targetForce = self.opts.minForce +
          (self.opts.maxForce - self.opts.minForce) * pressureOf(e)
      } else if (forceMode !== 'true' && !(e.touches && e.touches[0] && e.touches[0].force)) {
        self.forceType = 'hold'       // 降级: 时长模拟
        self.holdStart = performance.now()
        self.targetForce = self.opts.holdStartForce
      } else {
        self.forceType = 'pressure'
        self.targetForce = self.opts.minForce +
          (self.opts.maxForce - self.opts.minForce) * Math.max(0.15, pressureOf(e))
      }
      self._ensureActive()
      host.setPointerCapture && host.setPointerCapture(e.pointerId)
    })
    host.addEventListener('pointerup', function () { self._release() })
    host.addEventListener('pointercancel', function () { self._release() })

    // iOS Safari: PointerEvent 不提供 force, 单独监听 touch 补充
    if (window.PointerEvent && window.TouchEvent && ('ontouchstart' in window)) {
      host.addEventListener('touchstart', function (e) { self._onTouch(e) }, { passive: true })
      host.addEventListener('touchmove', function (e) { self._onTouch(e) }, { passive: true })
    }
  }

  /* 触点坐标 → host 局部 */
  ForceGlowHost.prototype._move = function (e) {
    var r = this.host.getBoundingClientRect()
    var x, y
    if (e.touches && e.touches.length) {
      x = e.touches[0].clientX; y = e.touches[0].clientY
    } else {
      x = e.clientX; y = e.clientY
    }
    this.tx = x - r.left
    this.ty = y - r.top
  }

  /* iOS touch force 补充 */
  ForceGlowHost.prototype._onTouch = function (e) {
    var self = this
    if (e.touches && e.touches.length) {
      self._move(e)
      if (self.pressed) {
        var capable = hasPressure(e)
        var p = pressureOf(e)
        if (capable) {
          self.forceType = 'pressure'
          self.targetForce = self.opts.minForce +
            (self.opts.maxForce - self.opts.minForce) * Math.max(0.15, p)
        } else if (self.forceType !== 'hold' && forceMode !== 'true') {
          // 采样中/判定为无压感 → 转时长模拟
          self.forceType = 'hold'
          self.holdStart = performance.now()
          self.targetForce = self.opts.holdStartForce
        }
      }
    }
  }

  ForceGlowHost.prototype._release = function () {
    var self = this
    if (!self.pressed) return
    self.pressed = false
    self._fadeOut()
    try { self.host.releasePointerCapture && self.host.releasePointerCapture(0) } catch (e) {}
  }

  ForceGlowHost.prototype._fadeOut = function () {
    this.targetForce = 0
    // 光晕 opacity 由 .on 控制; 此处淡出
    this.glow.classList.remove('on')
    // 若仍被 move 到(鼠标还在)会在 pointermove 恢复
  }

  ForceGlowHost.prototype._ensureActive = function () {
    var self = this
    if (!this.active) {
      this.active = true
      this.glow.classList.add('on')
      tickers.push(this)
      scheduleTick()
    } else {
      // 已激活但可能刚淡出(移除 on 后 targetForce>0 时重新点亮)
      if (!this.glow.classList.contains('on') && this.targetForce > 0.01) {
        this.glow.classList.add('on')
      }
    }
  }

  /* 每帧插值: 触点跟随 + 力度平滑 */
  ForceGlowHost.prototype._step = function (dt) {
    var f = Math.min(1, dt / 16.7)
    // 触点指数平滑(更快跟随: 0.42)
    var k = 1 - Math.pow(0.42, f)
    this.cx += (this.tx - this.cx) * k
    this.cy += (this.ty - this.cy) * k
    // 力度平滑(更缓: 0.16 → 压力变化柔和)
    var kf = 1 - Math.pow(0.16, f)
    this.curForce += (this.targetForce - this.curForce) * kf

    var self = this
    // 降级: 按住时长 → 力度爬升(600ms 到峰值), 松手后 curForce 已淡向 0
    if (this.pressed && this.forceType === 'hold') {
      var elapsed = (performance.now() - this.holdStart) / this.opts.holdRamp
      var holdF = this.opts.holdStartForce +
        (this.opts.maxForce - this.opts.holdStartForce) * Math.min(1, elapsed)
      this.targetForce = holdF
    }

    var off = Math.abs(this.curForce) < 0.005 &&
      Math.abs(this.cx - this.tx) < 0.5 && Math.abs(this.cy - this.ty) < 0.5
    if (off && !this.pressed) {
      // 完全收敛且无按压: 结束并隐藏
      this.active = false
      this.glow.classList.remove('on')
      return false
    }
    this._paint()
    return true
  }

  /* 写合成器属性: 位置 + 扩散 scale + 核心冷暖渐变权重 */
  ForceGlowHost.prototype._paint = function () {
    var g = this.glow
    var host = this.host
    // 光晕锚点即触点(cx,cy 为相对 host 的 px)
    var x = this.cx, y = this.cy
    // 扩散: 力度 0→1 → scale 0.55→1.7
    var s = 0.55 + this.curForce * 1.15
    g.style.transform = 'translate3d(' + x.toFixed(2) + 'px,' + y.toFixed(2) +
      'px,0) scale(' + s.toFixed(3) + ')'
    // 核心冷暖渐变权重: 力度小偏冷蓝, 大时核心暖白显形
    var core = 0.10 + this.curForce * 0.85
    g.style.setProperty('--fg-core-alpha', core.toFixed(3))
  }

  /* ---------- 对外 API ---------- */
  function create(els, opts) {
    var o = Object.assign({
      hoverForce: 0.34,       // 鼠标悬浮/轻触力度
      minForce: 0.18,         // 按压基础
      maxForce: 1,            // 满压
      holdStartForce: 0.25,   // 降级起始(刚按下)
      holdRamp: 600           // 降级: 按住多久到峰值(ms)
    }, opts || {})
    var list = (typeof els === 'string') ? document.querySelectorAll(els) : els
    var out = []
    ;[].forEach.call(list, function (el) {
      if (!el || el._forceGlow) return
      el._forceGlow = new ForceGlowHost(el, o)
      out.push(el._forceGlow)
    })
    return out
  }

  /* 自动挂载: 导航栏菜单项(替代旧 hover 静态光晕) */
  function autoMount() {
    if (document.querySelector('#nav .menus_item')) {
      create('#nav .menus_item')
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoMount)
  } else {
    autoMount()
  }

  window.ForceGlow = { create: create }
})()
