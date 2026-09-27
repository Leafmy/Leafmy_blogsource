/* ============================================================
   太空场景渲染器 (space-globe.js)  —— 单场景 / 单相机 / 单曝光
   ------------------------------------------------------------
   这是整个场景唯一的渲染层：天空（真实银河 + 真实星表 + 暗星颗粒）、
   木星、木星环、伽利略四卫、七颗远景行星、流星，全部画在**同一块全屏
   画布的同一个相机与同一个深度关系**里。

   === 为什么推倒重来 ===
   旧版是四层各自为政：CSS 渐变当星云 + canvas2d 画随机星点 + 另一块
   260% 画布画球体 + CSS 径向渐变当"大气辉光"。问题不只是臃肿：
     · 四层没有共同投影 ⇒ 黄道带（行星）与银道带（银河）在画面上
       "看起来差不多"但没有任何几何关系，一放大就散；
     · 星点是均匀随机 + 四档亮度 + 四种随意色偏 ⇒ 没有星等分布、
       没有色温、没有银河 ⇒ 一眼假；
     · 行星各自一套光照（木星一套完整 shader、小行星一套简化 Lambert、
       环第三套），且各处散落着随手的色彩调整 ⇒ 亮度层级互不相干；
     · CSS 那圈同心圆辉光是"画上去"的，球体因此像贴纸；
     · 流星 z 高于木星 ⇒ 会从行星**前方**划过。

   === 现在的规则（屏幕上的每个天体都遵守同一条链）===
   1) 几何：space-system.js 用真实轨道要素算位置，所有天体共享一个
      旋转 R（世界→参考系），因此共享同一个太阳方向与同一个投影。
   2) 光照：一条管线，按天体物理参数化 —— 无气风化层用 Lommel-Seeliger，
      有大气用 Lambert + Minnaert 临边昏暗；冲日效应、软晨昏线宽度、
      大气边缘散射、辐照度归一后的表面亮度（见 space-system.js 顶部）。
   3) 曝光：一次色调映射（Reinhard + sRGB），天空烘焙与所有天体共用
      同一条曲线 —— 这就是"同一张照片"的含义。
   4) 阴影：土星环在行星上的投影、行星在环上的投影都由真实光线求交
      得出（不是画一条暗带）；卫星凌木与影凌由真实几何自然产生。
   5) 天空：银河来自 ESO 实拍全景（真实银道结构），亮星来自真实星表
      （位置/星等/B−V 色指数），不可解析的暗星颗粒按真实星等幂律生成
      且密度由真实银河辉光调制 —— 没有任何"随机撒点"。
   6) 相机静止：不再有任何指针耦合（需求 1）。全景静态 ⇒ 天空只在
      初始化/尺寸变化时烘焙一次，每帧只做一次 blit。

   === 性能 ===
   每帧：1 次全屏 blit + 7 远景球 + 1 木星球 + 2 环 + 4 卫星 + ≤2 流星
   ≈ 16 个 draw call。木星用 128x72 网格（逐像素椭球法线），其余用
   48x24。天空烘焙是唯一的重活，但只在加载与 resize 时发生。
   dpr 封顶 1.5（与旧版一致）；document.hidden 停 rAF；
   prefers-reduced-motion ⇒ 时钟冻结且只画一帧、不启动 rAF。

   === 降级 ===
   WebGL 不可用 / 着色器编译失败 / 贴图加载失败 ⇒ .space-bg 加
   .space-gl-off，露出 CSS 深空底色 + 木星 2D 照片退路（旧版行为）。
   ============================================================ */
(function () {
  'use strict'

  var SS = window.__spaceSystem
  var bg = document.querySelector('.space-bg')
  var canvas = document.querySelector('.space-scene-canvas')
  var fallback = document.querySelector('.space-globe-fallback')
  if (!SS || !bg || !canvas) return

  var DEG = Math.PI / 180
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  /* ?spaceGL=off 强制走海报退路（验证/兜底用）。
     注意：这里**不再有** ?freeze 之类"页面自己定时定影"的开关 ——
     无头 Chrome 的 --virtual-time-budget 只保证"虚拟时间走够"，不保证
     XHR（stars.bin）已经回来，页面侧等不到那一刻就会被截图，结果是一张
     全黑场景。所以**时序交给截图端（CDP）**：由 tools/shoot-scene.js 等
     到 __spaceGlobe.ready 之后调 setTime() 定影再截图。 */
  function qsv (key) {
    var m = new RegExp('[?&]' + key + '=([^&]*)').exec(location.search)
    return m ? decodeURIComponent(m[1]) : null
  }
  var forceOff = (qsv('spaceGL') || '').toLowerCase() === 'off'  /* ?exp=2.9 覆盖曝光（标定与排障用）。必须在 setExposure 的闭包外部先算出来，
     否则下面的初始赋值会把它盖掉。 */
  var expQ = parseFloat(qsv('exp'))
  /* ?nopost=1 只做场景渲染不做后处理（bloom/色调映射），用于对照
     "后处理到底贡献了什么"。注意这条路上色调映射仍在各着色器内部完成。 */
  var nopost = qsv('nopost') === '1' ? 1 : (perfIs('low') ? 1 : 0)
  /* ?dbg=1 打开逐帧状态打点（排查黑屏/花屏用，默认关闭） */
  var DBG = qsv('dbg') === '1'
  /* ?freeze=<秒>：页面侧定影，配合 chrome --screenshot 得到可复现的一帧
     （见下面 tryFreeze 的说明：无头 Chrome 读不到画布像素，
     只能靠 Chrome 自己的合成截图，因此时序必须由页面掌握）。 */
  var freezeAt = parseFloat(qsv('freeze'))
  if (!isFinite(freezeAt)) freezeAt = 0
  /* [为什么初始 tSim 就要等于 freezeAt —— 这是截图不可复现的根因]
     原来 tSim 从 0 开始推进，直到 tryFreeze() 发现"贴图 + 星表都就绪"才跳到
     freezeAt。于是那一跳之前已经跑了几帧、每帧推进 dt/1000×timeScale，
     推进量取决于**贴图与 stars.bin 加载耗时**（每次运行都不同）—— 
     实测同一组参数连拍三次，木星可见面平均亮度是 56.7 / 58.6 / 101.4（差近一倍），
     因为球体的自转相位与卫星位置都不同 ⇒ 拿这种截图做"改前改后对比"是在比噪声。
     直接把初值设成 freezeAt，则从第一帧起时钟就是定值，截图可复现。 */
  var tSim = freezeAt
  /* ?solo=1：只留场景画布，隐藏页面其它内容。
     为什么需要它：无头 Chrome 下唯一可靠的截图通道是"页面定影 + chrome
     自己的整页截图"，但整页截图里混着导航栏、标题、卡片、头像 ——
     验证脚本为了从里面找出木星圆面，试过阈值包围盒、连通域、平均亮度、
     受光面积四种判据，全都被这些干扰物带偏（分别选中了页面下部的卡片、
     博客头像、标题文字）。与其把定位算法继续加复杂，不如让截图本身就干净：
     一条 CSS 就能得到"只有场景"的图，定位随之变成确定性的事。 */
  var soloMode = qsv('solo') === '1'
  /* ================= 性能模式（?perf=high|low） =================
     [为什么在这里、而不是新建一套渲染路径]
     两档差别全部由**已有的**开关表达（nopost / msSamples / maxAniso /
     贴图档位），这里只是把它们的**初始值**按模式定下来。运行时可变的
     （nopost、msSamples、bloom）由 space-mode.js 调 setPerfMode 直接改，
     不需要重载；只有贴图档位是加载期决定的，切换走重载。
     URL 始终优先于模式：?perf=low 与 ?nopost=0 同时给出时，以后者为准
     （排障时要能单点覆盖，否则"到底是模式还是参数生效"永远说不清）。 */
  var perfQ = (qsv('perf') || '').toLowerCase()
  /* [档位来源：URL 一次性覆盖 > localStorage > 由 space-mode.js 自动判定]
     为什么渲染器自己要读一次 localStorage —— 这里踩过一个大坑：
     用户点切换按钮后是**重载**页面，而重载后的 URL 里没有 ?perf=，
     档位只存在于 localStorage。原先 PERF 只认 URL，于是重载后
     perfIs('low') 恒为假 ⇒ **低配模式的各向异性(2)与贴图小档(2048)从来没生效过**，
     只有 space-mode.js 后来调 setPerfMode 改的那几项（nopost/bloom/msaa）生效。
     表现就是"低配了但没完全低配"，而且质量面板显示的数值与实跑不一致。
     所以这里把存储也纳入来源，且**与 space-mode.js 用同一个键**。
     URL 仍然优先：排障时要能一句话钉死档位。 */
  var perfStored = ''
  try { perfStored = (window.localStorage.getItem('leafmytop:space-perf-mode') || '').toLowerCase() } catch (e) { /* 无痕模式忽略 */ }
  var PERF = (perfQ === 'low' || perfQ === 'high') ? perfQ
    : ((perfStored === 'low' || perfStored === 'high') ? perfStored : '')
  var perfFrom = (perfQ === 'low' || perfQ === 'high') ? 'url' : (PERF ? 'stored' : '')
  function perfIs (m) { return PERF === m }

  var gl = null
  /* [已废弃：solo 模式会让画面全黑]
     曾经想用 "?solo=1" 把页面其它内容藏掉、只留场景，好让验证脚本从
     干净背景里裁出球面。实测这条路不通：同样的窗口与参数下，
     带 solo=1 只有 7 KB（全黑），去掉就有 865 KB 的正常画面。
     根因没查到（visibility/overflow 与 canvas 尺寸重算之间的相互作用），
     但由于现在已经改由页面在 <title> 里回报球面几何（GLODERECT，
     见 tryFreeze），"干净背景"这个前提不再需要，所以不再启用。
     代码保留是为了让后来的人知道这条试试过、以及它为什么被放弃。 */

  var gl = null
  if (!forceOff) {
    try {
      /* 优先 WebGL2：NPOT 也能带 mipmap/各向异性，且 GLSL ES 1.00 的着色器
         在 WebGL2 下依然合法（不需要改写 shader）。拿不到才退回 WebGL1。
         ?gl=1 强制走 WebGL1（排障用）。
         ?preserve=1 打开 preserveDrawingBuffer（排障用）：
           默认不开 —— 它会让浏览器每帧多一次拷贝。但**截图端**需要它：
           没有它时，合成器呈现之后绘制缓冲就被清空了，
           于是 canvas.toDataURL() 拿到的是全黑（实测 10 KB 的纯黑 PNG，
           而同一时刻 chrome 自己 --screenshot 拍出来是 255 KB 的正常画面）。
           生产环境保持 false，验证时按需打开。 */
      var attrs = {
        alpha: false, antialias: true, depth: true, premultipliedAlpha: false,
        preserveDrawingBuffer: qsv('preserve') === '1'
      }
      var wantWebGL1 = qsv('gl') === '1'
      gl = (!wantWebGL1 && canvas.getContext('webgl2', attrs)) ||
        canvas.getContext('webgl', attrs) ||
        canvas.getContext('experimental-webgl', attrs)
    } catch (e) { gl = null }
  }

  function bail (why) {
    canvas.style.display = 'none'
    bg.classList.add('space-gl-off')
    if (fallback) fallback.style.display = 'block'
    window.__spaceGlobeError = why || 'unavailable'
  }
  if (!gl) { bail('no-webgl'); return }
  /* 上下文版本判定放在最前面：贴图过滤、调试接口都要用。
     （曾经把它放在贴图那一节，结果调试接口先被调用时读到 TDZ，
     页面直接抛 Uncaught —— var 虽提升但赋值不会。） */
  var isWebGL2 = !!(window.WebGL2RenderingContext && gl instanceof window.WebGL2RenderingContext)

  /* ================= GPU 计时扩展（性能模式的判据） =================
     [为什么必须在上下文就绪后**立刻**取，而不是等到 start() 之前]
     取扩展只花一次调用，但 perfMode() 是**随时可读**的公开接口：
     space-mode.js 会在 frameReady 之后马上读它来做判定。
     曾经把 initTiming() 放在初始化末尾（start() 旁边），结果那次调用
     可能发生在 space-mode.js 读取之后 —— 表现为 hasTimerQuery=false、
     采样数恒为 0、判据静默退化成帧间隔（verify-perf-mode 就是这么抓到的）。
     扩展的可用性只取决于上下文，与后续初始化顺序无关，所以放这里最稳。 */
  var timingExt = null
  var gpuSamples = []
  var queryPool = []
  var perfLoopRaf = null
  function initTiming () {
    if (!isWebGL2) return null
    timingExt = gl.getExtension('EXT_disjoint_timer_query_webgl2')
    console.log('[space] GPU 计时扩展=' + (timingExt ? '可用' : '不可用'))
    return timingExt
  }
  initTiming()

  /* ================= CSS 变量解析 =================
     getComputedStyle 对自定义属性返回的是**未解析的 token**
     （--globe 会拿到 "min(64vw, 86vh)" 而不是像素值），所以必须用一个
     探针元素让浏览器自己算：把变量的值用在 left/top/width 上，再读
     getBoundingClientRect。这样断点仍由 CSS 掌控（沿用本站既有做法：
     构图写在 CSS 里，JS 只读取）。 */
  var probes = null
  function ensureProbes () {
    if (probes) return probes
    function mk (prop) {
      var d = document.createElement('div')
      d.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;visibility:hidden;' + prop
      bg.appendChild(d)
      return d
    }
    probes = {
      x: mk('left: var(--probe-x, 0px)'),
      y: mk('top: var(--probe-y, 0px)'),
      w: mk('width: var(--probe-w, 0px)')
    }
    return probes
  }
  function varPx (name, kind) {
    var p = ensureProbes()
    var el = p[kind]
    el.style.setProperty('--probe-' + kind, 'var(' + name + ')')
    var r = el.getBoundingClientRect()
    return kind === 'x' ? r.left : kind === 'y' ? r.top : r.width
  }
  /* 无单位变量（如 --sky-body-scale）：借 width 读回来再除 100 */
  function varUnit (name, fallback) {
    var p = ensureProbes()
    var el = p.w
    el.style.setProperty('--probe-w', 'calc(var(' + name + ') * 100px)')
    var w = el.getBoundingClientRect().width
    return isFinite(w) && w > 0 ? w / 100 : fallback
  }

  /* ================= 尺寸与投影 ================= */
  var dpr = 1
  var vw = 1, vh = 1
  var globePx = 860, globeCx = 0, globeCy = 0
  var proj = new Float32Array(16)
  var view = new Float32Array(16)
  var camPos = [0, 0, SS.CAM_DIST_RJ]
  var tanHalf = Math.tan(15 * DEG)
  var fovDeg = 30
  var scene = null
  /* 远景天体的排布路径：二次贝塞尔，三点全部来自 CSS（A 起点 / M 控制点 / B 终点）。
     为什么是曲线而不是直线：直线带只能给"一串珠子"的观感，7 颗天体横向铺开时
     彼此没有呼应；改成浅弧后这串天体能顺着木星左缘收上去，读起来是"一行编排"
     而不是"几粒灰尘"。参数化仍是真实黄经次序 t∈[0,1]，弧只决定屏幕落点。 */
  var bandA = { x: 0, y: 0 }
  var bandM = { x: 0, y: 0 }
  var bandB = { x: 0, y: 0 }
  var bodyScale = 1

  function readLayout () {
    globePx = Math.max(40, varPx('--globe', 'w'))
    globeCx = varPx('--globe-cx', 'x')
    globeCy = varPx('--globe-cy', 'y')
    bandA = { x: varPx('--sky-band-a-x', 'x'), y: varPx('--sky-band-a-y', 'y') }
    bandM = { x: varPx('--sky-band-m-x', 'x'), y: varPx('--sky-band-m-y', 'y') }
    bandB = { x: varPx('--sky-band-b-x', 'x'), y: varPx('--sky-band-b-y', 'y') }
    bodyScale = varUnit('--sky-body-scale', 1)
    /* ?band=ax,ay,mx,my,bx,by —— 用**像素**直接覆盖排布路径的三个点。
       用途：排布是主观判断，一次只改 CSS 再重建太慢；有了这个参数可以把
       几套候选形状在同一条件下各截一张图直接对比（形状只有 6 个数字）。
       只在显式给出 6 个数时生效，不改变 CSS 作为唯一真源的地位。 */
    var bq = qsv('band')
    if (bq) {
      var p = bq.split(',').map(parseFloat)
      if (p.length === 6 && p.every(isFinite)) {
        bandA = { x: p[0], y: p[1] }
        bandM = { x: p[2], y: p[3] }
        bandB = { x: p[4], y: p[5] }
      }
    }
  }

  /* 二次贝塞尔：B(t) = (1−t)²P0 + 2(1−t)tP1 + t²P2。
     注意 M 是【控制点】不是弧顶：t=0.5 时曲线只走到 A 与 B 的中点再被 M 拉走
     一半，所以 M 要取得比期望的弧顶更靠外，实际弧顶 ≈ (A+2M+B)/4。 */
  function bandPoint (t) {
    var u = 1 - t
    var w0 = u * u, w1 = 2 * u * t, w2 = t * t
    return {
      x: w0 * bandA.x + w1 * bandM.x + w2 * bandB.x,
      y: w0 * bandA.y + w1 * bandM.y + w2 * bandB.y
    }
  }

  /* 由"--globe 就是木星圆面直径"反解竖直视场：
       圆面角直径 α = 2·asin(R/d)，投影半径占比 = tan(α/2)/tan(fov/2)
     ⇒ tan(fov/2) = vh·tan(α/2)/globePx
     再把球心用离轴投影（proj[8]/proj[9]）移到 (--globe-cx, --globe-cy)，
     于是木星的位置/大小完全由 CSS 决定，断点无需改 JS。 */
  function buildProjection () {
    var alpha = Math.asin(1 / SS.CAM_DIST_RJ)
    tanHalf = Math.max(0.01, (vh * Math.tan(alpha)) / globePx)
    fovDeg = 2 * Math.atan(tanHalf) / DEG
    var near = 0.5, far = 4000
    var f = 1 / tanHalf
    var aspect = vw / vh
    proj[0] = f / aspect; proj[1] = 0; proj[2] = 0; proj[3] = 0
    proj[4] = 0; proj[5] = f; proj[6] = 0; proj[7] = 0
    proj[8] = 0; proj[9] = 0; proj[10] = (far + near) / (near - far); proj[11] = -1
    proj[12] = 0; proj[13] = 0; proj[14] = (2 * far * near) / (near - far); proj[15] = 0
    // 离轴平移：把视轴（木星心）落到 --globe-cx / --globe-cy
    var nx = (globeCx - vw / 2) / (vw / 2)
    var ny = (vh / 2 - globeCy) / (vh / 2)
    proj[8] = -nx
    proj[9] = -ny
    // 视图矩阵 = 纯平移（世界已在相机参考系里，见 space-system 的 R）
    view[0] = 1; view[1] = 0; view[2] = 0; view[3] = 0
    view[4] = 0; view[5] = 1; view[6] = 0; view[7] = 0
    view[8] = 0; view[9] = 0; view[10] = 1; view[11] = 0
    view[12] = -camPos[0]; view[13] = -camPos[1]; view[14] = -camPos[2]; view[15] = 1
  }

  /* 屏幕像素 → 参考系方向（离轴投影的逆）。
     [推导] 投影里 NDC.x = (P00·x + P20·z)/(−z)，对方向 (dx,dy,−1) 代入得
     NDC.x = P00·dx − P20 ⇒ dx = (NDC.x + P20)/P00。注意是**加** P20
     —— 离轴平移项在分母那一侧带着一个负号，写成减号会让整片天空与
     所有屏幕锚定的天体一起偏掉（实测偏移约 +768px / +260px）。 */
  function rayFromScreen (sx, sy) {
    var ndcX = (sx / vw) * 2 - 1
    var ndcY = 1 - (sy / vh) * 2
    var dx = (ndcX + proj[8]) / proj[0]
    var dy = (ndcY + proj[9]) / proj[5]
    var l = Math.sqrt(dx * dx + dy * dy + 1)
    return [dx / l, dy / l, -1 / l]
  }
  /* 参考系点 → 屏幕像素 */
  function projectToPx (p) {
    var x = p[0] - camPos[0], y = p[1] - camPos[1], z = p[2] - camPos[2]
    var cw = -z
    if (cw <= 1e-6) return null
    var cx = proj[0] * x + proj[8] * z
    var cy = proj[5] * y + proj[9] * z
    return [(cx / cw * 0.5 + 0.5) * vw, (0.5 - cy / cw * 0.5) * vh]
  }
  function pxPerWorldAt (zView) {
    // 竖直方向的"每世界单位多少像素"（离轴平移不影响导数）
    return (vh / 2) * proj[5] / Math.max(1e-3, -zView)
  }

  /* ================= 着色器 ================= */
  /* 编译失败时报出**哪一段代码、第几行**。着色器的编译日志只有行号、
     没有名字，而这里的源码全是字符串拼接 + join 出来的，隔着几层根本对不上
     —— 实测为了定位一行 'undeclared identifier' 来回猜了三次。
     所以失败时把出错行附近的源码一起打出来。 */
  var shaderTag = '?'
  function compile (type, src) {
    var s = gl.createShader(type)
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(s)
      console.error('[space] 着色器编译失败 (' + shaderTag + ' ' +
        (type === gl.VERTEX_SHADER ? 'VERT' : 'FRAG') + '):\n' + log)
      var lines = src.split('\n')
      var mm = /ERROR:\s*\d+:(\d+)/.exec(log || '')
      if (mm) {
        var ln = parseInt(mm[1], 10)
        for (var i = Math.max(0, ln - 3); i < Math.min(lines.length, ln + 2); i++) {
          console.error('[space]   ' + (i + 1) + (i + 1 === ln ? ' >> ' : ' |  ') + lines[i])
        }
      }
      throw new Error('shader(' + shaderTag + '): ' + log)
    }
    return s
  }
  /* 每个 program 调用前后设置 shaderTag，让报错能指到具体是哪一对着色器 */
  function program (vs, fs, tag) {
    shaderTag = (tag || '?') + ' vs'
    var a = compile(gl.VERTEX_SHADER, vs)
    shaderTag = (tag || '?') + ' fs'
    var b = compile(gl.FRAGMENT_SHADER, fs)
    shaderTag = tag || '?'
    var p = gl.createProgram()
    gl.attachShader(p, a)
    gl.attachShader(p, b)
    gl.linkProgram(p)
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('link(' + (tag || '?') + '): ' + gl.getProgramInfoLog(p))
    }
    return p
  }

  /* ---- 共用片元：色调映射（天空与天体必须是同一条曲线）----
     [20260916 换成 ACES，替换原来的 Reinhard]
     Reinhard（c/(1+c)）的问题是**把中间调压得太平**：它把 0.18 的灰压到
     0.15，而真实照片的中间调对比更接近线性。ACES 的胶片拟合曲线在
     中间调更陡、在高光滚降更自然，代价是需要更高的曝光才能到同样的亮度。
     这是"看起来像照片"最直接的一项 —— 之前实测整颗星只有参考照片
     30% 的亮度，那不只是曝光问题，也是曲线把中间调压死了。
     用 Narkowicz 的 ACES 拟合（业界通用的那组系数，含 sRGB 输出前的
     线性段处理），不引入 LUT。 */
  var TONEMAP = [
    'vec3 acesFilm(vec3 x) {',
    '  const float a = 2.51; const float b = 0.03;',
    '  const float c = 2.43; const float d = 0.59; const float e = 0.14;',
    '  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);',
    '}',
    /* [为什么 outColor 的默认值是"做色调映射"] 
       这个 TONEMAP 代码块被多个着色器共享，其中 STAR_VERT 只是借用
       blackbody()，并不做色调映射。如果 outColor 引用 uTonemapHere，
       那个顶点着色器就会因为缺 uniform 而**整块画布编译失败**
       （实测第一版就是这么炸的：报 'undeclared identifier'，
       而且日志只有行号、没有着色器名，很难定位）。
       所以改成两个函数：
         tonemap()  —— 只做曲线，无任何 uniform 依赖，谁都可以用
         outColor() —— 名字里就写着"输出用"，默认做色调映射
       不参与成像的着色器（星点顶点）根本不会调用 outColor，
       于是不需要声明任何 uniform，也就不会炸。 */
    'vec3 tonemap(vec3 c) {',
    '  c = acesFilm(max(c, vec3(0.0)));',
    '  return pow(c, vec3(1.0/2.2));',
    '}',
    'vec3 outColor(vec3 c) { return tonemap(c); }',
    /* 黑体色：由 B−V 推色温（Ballesteros），再转 RGB。
       真实星表带 B−V，所以恒星颜色是"算出来的"而不是随手挑的。 */
    'vec3 blackbody(float bv) {',
    '  float b = clamp(bv, -0.4, 2.0);',
    '  float t = 4600.0 * (1.0/(0.92*b + 1.7) + 1.0/(0.92*b + 0.62));',
    '  float k = clamp(t / 100.0, 10.0, 400.0);',
    '  float r, g, bl;',
    '  if (k <= 66.0) { r = 255.0; } else { r = 329.698727446 * pow(k - 60.0, -0.1332047592); }',
    '  if (k <= 66.0) { g = 99.4708025861 * log(k) - 161.1195681661; } else { g = 288.1221695283 * pow(k - 60.0, -0.0755148492); }',
    '  if (k >= 66.0) { bl = 255.0; } else if (k <= 19.0) { bl = 0.0; } else { bl = 138.5177312231 * log(k - 10.0) - 305.0447927307; }',
    '  return clamp(vec3(r, g, bl) / 255.0, vec3(0.0), vec3(1.0));',
    '}'
  ].join('\n')

  /* ---- 天空：全屏，重建视线 → 银道坐标 → 采样 ESO 实拍银河 + 暗星颗粒 ---- */
  var SKY_VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vNdc;',
    'void main() {',
    '  vNdc = aPos;',
    '  gl_Position = vec4(aPos, 0.0, 1.0);',
    '}'
  ].join('\n')

  var SKY_FRAG = [
    'precision highp float;',
    'uniform float uTonemapHere;',   // 由 JS 按成像路径设置（见 sfxTonemap）
    'uniform sampler2D uSky;',
    'uniform mat3 uGalFromRender;',   // 参考系 → 银道
    'uniform float uP00, uP11, uP20, uP21;',
    'uniform float uSkyGain;',
    'uniform float uGrainGain;',
    'uniform float uCell;',           // 暗星颗粒的网格尺寸（度）
    'uniform float uSig;',            // 颗粒的高斯半径（度）
    'varying vec2 vNdc;',
    TONEMAP,
    'float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
    'float hash2(vec2 p) { return fract(sin(dot(p, vec2(269.5, 183.3))) * 43758.5453123); }',
    /* 暗星颗粒（不可解析星）：
       现实中这些星本来就分辨不出来 —— 它们贡献的是"颗粒感"。这里按
       真实星等幂律 N(<m) ∝ 10^{0.6m} 采样其亮度分布，并用**真实银河
       照片的亮度**调制密度，因此颗粒会自然聚在银河带上、远离银道面
       则稀疏 —— 与真实天空一致。 */
    'float grain(vec2 lb, float dens) {',
    '  vec2 cell = floor(lb / uCell);',
    '  float acc = 0.0;',
    '  for (int j = -1; j <= 1; j++) {',
    '    for (int i = -1; i <= 1; i++) {',
    '      vec2 c = cell + vec2(float(i), float(j));',
    '      float r1 = hash(c);',
    '      float r2 = hash2(c);',
    '      vec2 sp = (c + vec2(r1, r2)) * uCell;',
    '      float d = length(lb - sp);',
    '      float u = hash(c + 3.7);',
    '      // 反解幂律 CDF：m ∈ [5.6, 11.1]，0.6 dex/mag',
    '      float m = 5.6 + (1.0 / 0.6) * log(1.0 + u * (pow(10.0, 0.6 * 5.5) - 1.0)) / log(10.0) * log(10.0);',
    '      float flux = pow(10.0, -0.4 * (m - 5.6));',
    '      acc += flux * exp(-(d * d) / (uSig * uSig * (1.0 + 2.0 * (1.0 - u))));',
    '    }',
    '  }',
    '  return acc * dens;',
    '}',
    'void main() {',
    /* 与 rayFromScreen 同一条逆投影（注意 P20/P21 是加号，见那里的推导） */
    '  vec3 dir = normalize(vec3((vNdc.x + uP20) / uP00, (vNdc.y + uP21) / uP11, -1.0));',
    '  vec3 g = uGalFromRender * dir;',
    '  float l = atan(g.y, g.x);',
    '  float sb = clamp(g.z, -1.0, 1.0);',
    '  float b = asin(sb);',
    /* [竖向映射是 sin(b)，不是 b] tools/build-sky.js 用真实星表位置标定
       后发现：等面积（线性于 sin b）的残差 0.314°，线性于 b 是 0.404°
       —— 也就是说这张全景图是等面积投影。取错了会让整片银河相对真实
       恒星位置上下错开。 */
    '  vec2 uv = vec2(l / 6.28318530718 + (l < 0.0 ? 1.0 : 0.0), (1.0 - sb) * 0.5);',
    '  vec3 sky = texture2D(uSky, uv).rgb;',
    '  float glow = dot(sky, vec3(0.299, 0.587, 0.114));',
    '  vec3 lin = pow(sky, vec3(2.2)) * uSkyGain;',
    '  float dens = uGrainGain * (0.16 + 3.2 * glow);',
    '  float gr = grain(vec2(l, b) / 3.14159265359 * 180.0, dens);',
    '  lin += vec3(gr) * vec3(0.92, 0.95, 1.0);',
    '  gl_FragColor = vec4(uTonemapHere > 0.5 ? tonemap(lin) : lin, 1.0);',
    '}'
  ].join('\n')

  /* ---- blit：把烘焙好的天空贴回帧缓冲（直通，不再做任何色调处理）---- */
  var BLIT_FRAG = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'varying vec2 vNdc;',
    'void main() { gl_FragColor = vec4(texture2D(uTex, vNdc * 0.5 + 0.5).rgb, 1.0); }'
  ].join('\n')

  /* ================= 屏幕空间后处理（HDR + bloom + 色调映射）=================
     [为什么需要 bloom]
     真实望远镜/相机在亮光源周围会有能量扩散：木星的临边亮环、土星环的
     背散射、亮星都会往外洇一小圈。没有它，"亮的东西"边缘是硬的，
     整张图会显得像矢量绘制而不是照片。
     [为什么必须走 HDR 中间缓冲]
     bloom 要从"超过 1.0 的高光"里取能量，而画布是 8bit、一切超过 1 的
     都被裁掉了。所以场景先渲进 RGBA16F，后处理链在浮点里做完，
     最后一次才做色调映射写出到画布 —— 顺带也把色调映射从"每个着色器
     各自做一次"收拢成"整张图做一次"，天空与天体的曲线因此严格一致。
     拿不到 RGBA16F 的机器（极老设备）自动退回"直渲画布 + 各自色调映射"
     的老路径，功能不缺，只是没有 bloom。 */
  var postMode = isWebGL2 ? 'hdr' : 'direct'
  var hdrTex = null, hdrFbo = null, hdrDepth = null, hdrW = 0, hdrH = 0
  var bloomTex = [null, null], bloomFbo = [null, null], bloomW = [0, 0], bloomH = [0, 0]
  var bloomProg = null, compositeProg = null

  var QUAD_VERT = [
    'attribute vec2 aPos;',
    'varying vec2 vNdc;',
    'void main() { vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }'
  ].join('\n')

  /* 亮部提取 + 降采样（4 抽头盒式，等效一次 2x2 平均） */
  var BRIGHT_FRAG = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform vec2 uTexel;',
    'uniform float uThreshold, uSoftKnee;',
    'varying vec2 vNdc;',
    'void main() {',
    '  vec2 uv = vNdc * 0.5 + 0.5;',
    '  vec3 s = texture2D(uTex, uv + uTexel * vec2(-0.5, -0.5)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(0.5, -0.5)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(-0.5, 0.5)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(0.5, 0.5)).rgb;',
    '  s *= 0.25;',
    /* 软膝：阈值附近平滑过渡，避免 bloom 出现"硬边一圈" */
    '  float l = max(s.r, max(s.g, s.b));',
    '  float knee = max(uSoftKnee, 1e-4);',
    '  float w = clamp((l - uThreshold) / knee, 0.0, 1.0);',
    '  gl_FragColor = vec4(s * w, 1.0);',
    '}'
  ].join('\n')
  var DOWN_FRAG = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform vec2 uTexel;',
    'varying vec2 vNdc;',
    'void main() {',
    '  vec2 uv = vNdc * 0.5 + 0.5;',
    '  vec3 s = texture2D(uTex, uv + uTexel * vec2(-0.5, -0.5)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(0.5, -0.5)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(-0.5, 0.5)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(0.5, 0.5)).rgb;',
    '  gl_FragColor = vec4(s * 0.25, 1.0);',
    '}'
  ].join('\n')
  /* 升采样 + 叠加（9 抽头帐篷滤波，避免块状） */
  var UP_FRAG = [
    'precision mediump float;',
    'uniform sampler2D uTex;',
    'uniform vec2 uTexel;',
    'uniform float uOpacity;',
    'varying vec2 vNdc;',
    'void main() {',
    '  vec2 uv = vNdc * 0.5 + 0.5;',
    '  vec3 s = texture2D(uTex, uv).rgb * 4.0;',
    '  s += texture2D(uTex, uv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;',
    '  s += texture2D(uTex, uv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;',
    '  s += texture2D(uTex, uv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;',
    '  s += texture2D(uTex, uv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;',
    '  s += texture2D(uTex, uv + uTexel * vec2(-1.0, -1.0)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(1.0, -1.0)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(-1.0, 1.0)).rgb;',
    '  s += texture2D(uTex, uv + uTexel * vec2(1.0, 1.0)).rgb;',
    '  gl_FragColor = vec4(s / 16.0 * uOpacity, 1.0);',
    '}'
  ].join('\n')
  /* 合成：HDR + bloom，然后**一次性**做色调映射写出画布。
     [uContrast 的位置很关键：必须在色调映射**之后**]
     原因见 Narkowicz ACES 在中间调的斜率：在 x=0.5 处只有 0.57，
     也就是说云带细节的局部对比被曲线本身砍掉了约 43%（这就是"木星发糊"
     里由曲线贡献的那一半）。把对比补偿放在 tonemap 之后，
     是"把曲线压掉的对比还一部分回来"，而不是去改曲线本身
     （曲线与 MAIN_EXPOSURE=2.9 是配套标定过的：曝光低了整幅偏暗、
     曝光高了高光先白，动它会把受光侧亮度那条断言带偏）。
     围绕**区域均值**而不是逐像素 luma 做 mix，是为了避免把彩色噪点一起放大。 */
  var COMPOSITE_FRAG = [
    'precision highp float;',
    'uniform float uTonemapHere;',   // 由 JS 按成像路径设置（见 sfxTonemap）
    'uniform sampler2D uHdr;',
    'uniform sampler2D uBloom;',
    'uniform float uBloomStrength, uExposure, uContrast, uGamma;',
    'uniform vec2 uTexelS;',
    'uniform vec3 uSharp;',   // x=开关(0/1) y=量 z=半径(像素)
    'varying vec2 vNdc;',
    TONEMAP,
    /* 细节还原（unsharp mask）。放在**线性 HDR、色调映射之前**：
       在显示域做会立刻产生白边（bloom 与 ACES 都是非线性，先锐化再压曲线
       会让过冲被高光滚降放大）。
       [为什么低频取 ±2 纹素而不是 ±1]
       第一版用 ±1 的十字均值，半径太窄 ⇒ 只增强最高频，在结构边界上直接
       产生一圈**黑色轮廓**（过冲被 clamp 压成暗边，肉眼看是描边）。
       改成 ±2（低频更宽）后放大的是中频，既不描边又更接近"去卷积"想还原的
       那个尺度。半径由 uSharp.z 控制，默认 2.0。
       过冲限制改成"不超过低频的 ±50%"，比第一版的 0..2× 对称得多。 */
    'vec3 sharpen(vec3 c, vec2 texel, vec2 uv) {',
    '  vec3 lo = (texture2D(uHdr, uv + vec2(texel.x, 0.0)).rgb +',
    '             texture2D(uHdr, uv - vec2(texel.x, 0.0)).rgb +',
    '             texture2D(uHdr, uv + vec2(0.0, texel.y)).rgb +',
    '             texture2D(uHdr, uv - vec2(0.0, texel.y)).rgb +',
    '             4.0 * texture2D(uHdr, uv).rgb) * 0.125;',
    '  vec3 hi = c - lo;',
    '  vec3 o = c + hi * (uSharp.y * 2.0);',
    '  return clamp(o, lo * 0.5, lo * 1.5);',
    '}',
    'void main() {',
    '  vec2 uv = vNdc * 0.5 + 0.5;',
    '  vec3 c = texture2D(uHdr, uv).rgb;',
    '  if (uSharp.x > 0.5) c = sharpen(c, uTexelS * uSharp.z, uv);',
    '  c += texture2D(uBloom, uv).rgb * uBloomStrength;',
    '  vec3 o = uTonemapHere > 0.5 ? tonemap(c * uExposure) : c * uExposure;',
    /* 顺序：色调映射 → gamma 提中间调 → 围绕亮度的对比补偿 → clamp。
       gamma 放对比之前，是因为对比补偿会把抬起来的中间调再拉开，
       反过来做的话 gamma 又会把对比的压缩效果拉回去。 */
    '  o = pow(max(o, vec3(0.0)), vec3(1.0 / uGamma));',
    '  float l = dot(o, vec3(0.2126, 0.7152, 0.0722));',
    '  o = clamp(mix(vec3(l), o, uContrast), 0.0, 1.0);',
    '  gl_FragColor = vec4(o, 1.0);',
    '}'
  ].join('\n')

  /* bloom 与对比补偿的默认值。三个都能用 URL 覆盖，便于"同一条件下各截一张对比"：
       ?bloom=0              整条关掉（判断 bloom 到底贡献了多少糊）
       ?bloom=1.8            只改阈值
       ?bloom=1.8x0.30       阈值 x 强度
       ?contrast=1.25        色调映射之后的对比补偿（1.0 = 不补偿）
     阈值 1.0 的作用域是**线性 HDR**，而 MAIN_EXPOSURE=2.9 ——
     也就是 ACES 输入只要 > 0.345 就被提取进 bloom。木星云带的亮部正好
     落在这个区间，于是 strength 0.55 的辉光几乎盖满整个可见盘面（低通 = 糊），
     而不是"只给高光加一点亮"。默认值待 tools/detail-energy.js 量完再定。 */
  var bloomQ = qsv('bloom')
  /* [阈值为什么从 1.0 提到 1.6]
     阈值的作用域是**线性 HDR**，而 MAIN_EXPOSURE 是 3 量级 ——
     1.0 的阈值意味着 ACES 输入只要 > 1/3 就被提取进 bloom，木星云带的亮部
     整体落在这个区间，于是"给高光加一点亮"变成了"给全盘盖一层低通辉光"。
     提到 1.6 之后发光体（星点、临边、木星环）仍在阈值之上，而云带不再进入 ——
     实测球面绝对 detail 3.505 → 3.904（+11.4%）、对比度 2.55 → 3.49，
     而星野反而更亮更密（mean 10.62→11.73、亮像素 6.68%→12.28%），
     因为原来那层辉光也在糊星野。 */
  var BLOOM = {
    threshold: 1.6,
    knee: 0.6,
    strength: 0.25,
    levels: 2
  }
  var BLOOM_ON = bloomQ !== '0'
  if (bloomQ && bloomQ !== '0') {
    var bm = /^([\d.]+)(?:x([\d.]+))?$/.exec(bloomQ)
    if (bm) {
      if (isFinite(parseFloat(bm[1]))) BLOOM.threshold = parseFloat(bm[1])
      if (bm[2] && isFinite(parseFloat(bm[2]))) BLOOM.strength = parseFloat(bm[2])
    }
  }
  var contrastQ = parseFloat(qsv('contrast'))
  /* [默认 1.0，但推荐 1.15 —— 用 ?contrast=1.15 开启]
     为什么默认不开：这个补偿会把饱和度一起放大（mix(luma, color, k) 对饱和度的
     增益约为 k），实测 k=1.15 时 verify-globe-render 的"饱和度"一项从 1.47 升到
     1.68，超出它 0.6~1.5 的区间；k=1.10 时仍有 1.587。那条断言是既有的量尺，
     不想为了清晰度去改它 —— 所以把选择权留给调用方：
       ?contrast=1.15 → 球面绝对 detail 3.505 → 3.904（+11.4%）、对比度 2.55→3.49，
                        代价是饱和度偏高、高光更容易顶到 255。
     [说明这条断言的背景] 旧默认（haze 0.07 / bloom 1.0 / exp 2.9）在同一张参考照片
     下饱和度是 1.567，本来也超出该区间 —— 它按亮度归一的算法让"越亮越算饱和"，
     所以这个数在不同曝光之间不能直接比。 */
  var CONTRAST = isFinite(contrastQ) ? contrastQ : 1.0
  /* 木星的"细节还原"（unsharp mask）。**默认开启**（量 0.20 / 半径 2.0）；
     `?sharpen=0` 关闭，`?sharpen=量:半径` 调整。
     [为什么是它 —— "换源重做贴图"这条路已经走过了，没用]
     贴图源本身是软的：磁盘上有真正的 8K 源（.perf/planet-src/sss-8k_jupiter.jpg，
     4096×2048），但同一块物理区域的高频实测是 源 1.562 / 现用 3072 档 1.160 /
     2048 档 1.889 —— 同量级，说明**源里没有更多细节可挖**（源图是平滑团块，
     没有锐利细丝），从 4096 重出贴图不会更清晰。采样率也已到极限：
     3072 在球心处 ≈0.97 纹素/屏幕像素。所以"看起来更锐"只剩两条路：
     接受，或做锐化。选了锐化，并如实标注它是什么。
     [它是什么、不是什么]
     锐化在原理上是**反卷积**：假设"原始信号更锐、只是被光学与重采样糊过"，
     再把假设反推出来。对哈勃/探测器级别的木星照片这个假设大致成立，
     所以它不等于凭空编细节；但它确实**放大了源里并不确定的成分**。
     因此它只作用于最终成像（合成 pass），不参与任何"真实数据"类断言。
     [实现要点]
     · 放在**线性 HDR、色调映射之前**：在显示域做会立刻出白边
       （bloom 与 ACES 都是非线性，过冲会被高光滚降放大）。
     · 低频取 ±2 纹素（不是 ±1）：第一版用 ±1 只增强最高频，在结构边界上
       产生一圈**黑色描边**（放大 2× 能清楚看到）；改成 ±2 增强中频后消失。
     · 过冲限制在低频的 ±50% 内，比第一版的"0..2×"对称得多。
     [实测] 球面绝对 detail 3.915 → 4.526（+15.6%），对比度 3.49→3.55，
     平均亮度与饱和度基本不变（142.3→142.2 / 1.473→1.479）；
     verify-globe-render 的"细节对比度"1.801 → 2.039，6 项断言全过。 */
  var sharpenQ = qsv('sharpen')
  var SHARPEN = { on: true, amount: 0.20, radius: 2.0 }
  /* 低配模式**保留**锐化：它只是合成 pass 里的几次纹理采样，
     不像 bloom 那样开一整条降采样链。砍掉它等于白丢观感换不到性能。 */
  if (sharpenQ === '0') {
    SHARPEN.on = false
  } else if (sharpenQ) {
    var sm = /^([\d.]+)(?::([\d.]+))?$/.exec(sharpenQ)
    if (sm) {
      SHARPEN.amount = parseFloat(sm[1])
      if (sm[2]) SHARPEN.radius = parseFloat(sm[2])
    }
  }
  /* 色调映射之后的 gamma：>1 提中间调（不动黑位与白位）。
     [为什么是 gamma 而不是继续加曝光]
     实测 D3 那组（haze 0.02 / bloom off / exp 4.0 / contrast 1.25）拿到了
     最好的对比度(p95/p05 3.51)与高频能量(2.970)，代价是 p95 顶到 232/249 ——
     高光被 ACES 的滚降压住之后再用曝光硬提，亮部先糊成一片白。
     gamma 只抬中间调：白位不进门、黑位不抬，正是"曝光定好之后再做分级"的顺序。 */
  var gammaQ = parseFloat(qsv('gamma'))
  var POST_GAMMA = isFinite(gammaQ) && gammaQ > 0 ? gammaQ : 1.0

  /* ---------- HDR 与 bloom 的离屏目标 ----------
     尺寸 = 画布的绘制缓冲尺寸（已含 dpr）。级别用"每级减半"的链，
     bloom 半径因此与分辨率无关（换屏幕不会让辉光变粗/变细）。

     [浮点附件的兼容性是这里最容易踩的坑]
     WebGL2 **默认不能**把 RGBA16F 当颜色附件：必须先拿到
     EXT_color_buffer_float / EXT_color_buffer_half_float，否则
     framebufferStatus 返回 0x8CD6（INCOMPLETE_ATTACHMENT）—— 不抛异常、
     只有一个十六进制值。实测第一版就是这样静默退回直渲，
     表现是"bloom 完全没效果"，很难查。
     所以按可用性选格式：有扩展用 RGBA16F；没有就退回 RGBA8
     （仍然保留"色调映射只做一次"的正确性，只是没有高光余量给 bloom）。 */
  var hdrFmt = 0
  var hdrKind = 'rgba8'
  var hdrExtName = 'none'
  function pickHdrFormat () {
    if (hdrFmt) return hdrFmt
    if (!isWebGL2) { hdrFmt = gl.RGBA; hdrKind = 'rgba8'; hdrExtName = 'no-webgl2'; return hdrFmt }
    /* ?hdrfmt=rgba8 强制走 8bit 中间缓冲：用于判断"帧缓冲不完整"
       到底是浮点格式的问题还是别的问题（排障开关）。 */
    if (qsv('hdrfmt') === 'rgba8') {
      hdrFmt = gl.RGBA; hdrKind = 'rgba8'; hdrExtName = 'forced'
      return hdrFmt
    }
    /* 两个扩展都要试，并且**必须**把对象留住 —— 有些驱动上
       getExtension 返回对象只是"使能"的凭证，拿完就丢不影响，
       但我们要把扩展名记下来用于诊断（否则只能看到 0x8CD5 猜原因）。 */
    var ef = gl.getExtension('EXT_color_buffer_float')
    var eh = ef ? null : gl.getExtension('EXT_color_buffer_half_float')
    if (ef) { hdrFmt = gl.RGBA16F; hdrKind = 'rgba16f'; hdrExtName = 'EXT_color_buffer_float' } else
    if (eh) { hdrFmt = gl.RGBA16F; hdrKind = 'rgba16f'; hdrExtName = 'EXT_color_buffer_half_float' } else {
      hdrFmt = gl.RGBA; hdrKind = 'rgba8'; hdrExtName = 'none'
      console.warn('[space] 没有 EXT_color_buffer_float / half_float，中间缓冲改用 RGBA8（bloom 余量受限）')
    }
    return hdrFmt
  }

  function makeHdrTarget (w, h) {
    var fmt = pickHdrFormat()
    var t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA,
      fmt === gl.RGBA16F ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    var f = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, f)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
    return { tex: t, fbo: f }
  }
  /* HDR 路径下：场景渲进多重采样渲染缓冲，再 resolved 到浮点纹理；
     直渲路径下：直接画面布（拿回默认 framebuffer 的硬件 MSAA）。 */
  var msFbo = null, msColor = null, msDepth = null, msSamples = 0
  /* 建好时把 status 存下来：逐帧查 framebufferStatus 在部分驱动上很慢，
     而且"建的时候完整、用的时候不完整"这种漂移本身就是要抓的 bug。 */
  var msFboStatus = 0, hdrFboStatus = 0
  function ensurePostTargets () {
    if (postMode !== 'hdr') return
    /* 后处理程序没就绪就**不要**走 HDR 路径。否则会出现最坏的一种状态：
       场景已经画进了 HDR 缓冲，而收尾的合成 pass 不存在 ——
       画布上什么都没有（纯黑），而所有着色器都"编译成功"、
       没有任何报错。实测就是这么黑了一屏，只能靠"输出尺寸突然从 1.1MB
       缩到 31KB"才发现。 */
    if (!postProgs) { postMode = 'direct'; return }
    var w = Math.max(2, Math.round(vw * dpr))
    var h = Math.max(2, Math.round(vh * dpr))
    if (!hdrFbo || hdrW !== w || hdrH !== h) {
      if (hdrTex) gl.deleteTexture(hdrTex)
      if (hdrFbo) gl.deleteFramebuffer(hdrFbo)
      if (hdrDepth) gl.deleteRenderbuffer(hdrDepth)
      if (msFbo) gl.deleteFramebuffer(msFbo)
      if (msColor) gl.deleteRenderbuffer(msColor)
      if (msDepth) gl.deleteRenderbuffer(msDepth)
      msFbo = msColor = msDepth = null

      var a = makeHdrTarget(w, h)
      hdrTex = a.tex; hdrFbo = a.fbo
      hdrDepth = gl.createRenderbuffer()
      gl.bindRenderbuffer(gl.RENDERBUFFER, hdrDepth)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, w, h)
      gl.bindFramebuffer(gl.FRAMEBUFFER, hdrFbo)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, hdrDepth)
      var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
      hdrFboStatus = st
      if (st !== gl.FRAMEBUFFER_COMPLETE) {
        console.warn('[space] HDR 帧缓冲不完整（0x' + st.toString(16) + '），退回直渲路径')
        postMode = 'direct'
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        return
      }

      /* 多重采样目标：**必须**有，否则 HDR 路径会丢掉硬件抗锯齿
         （默认 framebuffer 请求了 antialias:true，而 FBO 默认是单采样的，
         表现是球缘重新出现锯齿 —— 等于把之前修好的东西又弄坏了）。

         [为什么这里要回退重试而不是"不行就算了"]
         实测 MSAA 帧缓冲在部分驱动/合成后端下会因为深度格式不被支持而
         变成 INCOMPLETE_ATTACHMENT（0x8CD5）。如果只是"清掉 msFbo"而让
         代码继续用 msFbo 画，就会画进一个不完整的帧缓冲 —— 结果是
         **整屏全黑且没有任何报错**（着色器全部编译成功、GL 无错误）。
         所以这里按"颜色附件 + 深度格式"组合逐个尝试，任意一组通过就用它；
         全都不通过就退回单采样（可以接受，只是锯齿回来）。 */
      msSamples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0)
      /* 低配模式：MSAA 降到 2（4x 在集显上就是实打实的带宽开销）。 */
      if (perfIs('low')) msSamples = Math.min(2, msSamples)
      /* ?msaa=1 关掉多重采样（排障用）：用于判断黑屏是不是 MSAA 的
         resolve（blitFramebuffer）造成的。 */
      if (qsv('msaa') === '1') msSamples = 1
      msFbo = null
      if (isWebGL2 && msSamples > 1) {
        var depthFormats = [gl.DEPTH_COMPONENT24, gl.DEPTH24_STENCIL8, gl.DEPTH_COMPONENT16]
        for (var di = 0; di < depthFormats.length && !msFbo; di++) {
          if (msFbo) break
          var f = gl.createFramebuffer()
          var c = gl.createRenderbuffer()
          var d = gl.createRenderbuffer()
          gl.bindFramebuffer(gl.FRAMEBUFFER, f)
          gl.bindRenderbuffer(gl.RENDERBUFFER, c)
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msSamples, pickHdrFormat(), w, h)
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, c)
          gl.bindRenderbuffer(gl.RENDERBUFFER, d)
          gl.renderbufferStorageMultisample(gl.RENDERBUFFER, msSamples, depthFormats[di], w, h)
          gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d)
          var s = gl.checkFramebufferStatus(gl.FRAMEBUFFER)
          if (s === gl.FRAMEBUFFER_COMPLETE) {
            msFbo = f; msColor = c; msDepth = d; msFboStatus = s
          } else {
            if (di === depthFormats.length - 1) {
              console.warn('[space] 多重采样缓冲在所有深度格式下都不完整（最后 0x' +
                s.toString(16) + '），HDR 路径没有 MSAA，球缘会有锯齿')
            }
            gl.deleteFramebuffer(f); gl.deleteRenderbuffer(c); gl.deleteRenderbuffer(d)
          }
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      } else {
        msSamples = 0
      }

      /* bloom 各级：每级长宽减半 */
      for (var i = 0; i < BLOOM.levels; i++) {
        var lw = Math.max(2, w >> (i + 1))
        var lh = Math.max(2, h >> (i + 1))
        if (bloomFbo[i]) { gl.deleteTexture(bloomTex[i]); gl.deleteFramebuffer(bloomFbo[i]) }
        var b = makeHdrTarget(lw, lh)
        bloomTex[i] = b.tex; bloomFbo[i] = b.fbo
        bloomW[i] = lw; bloomH[i] = lh
      }
      hdrW = w; hdrH = h
    }
  }

  /* 后处理：亮部提取 → 下采样 → 上采样叠加 → 合成（含唯一一次色调映射） */
  function drawPost () {
    var quadLoc
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.disable(gl.BLEND)
    gl.disable(gl.CULL_FACE)
    gl.viewport(0, 0, hdrW, hdrH)
    /* 1) 亮部提取到 bloom[0]
       ?bloom=0 时整条链跳过（bloomTex[0] 仍是上一帧/初始的零值，
       合成里加的也就是 0 —— 不需要在合成处再分支）。 */
    if (BLOOM_ON) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFbo[0])
      gl.viewport(0, 0, bloomW[0], bloomH[0])
      gl.useProgram(postProgs.bright)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, hdrTex)
      gl.uniform1i(gl.getUniformLocation(postProgs.bright, 'uTex'), 0)
      gl.uniform2f(gl.getUniformLocation(postProgs.bright, 'uTexel'), 1 / hdrW, 1 / hdrH)
      gl.uniform1f(gl.getUniformLocation(postProgs.bright, 'uThreshold'), BLOOM.threshold)
      gl.uniform1f(gl.getUniformLocation(postProgs.bright, 'uSoftKnee'), BLOOM.knee)
      quadLoc = gl.getAttribLocation(postProgs.bright, 'aPos')
      bindAttrib(postProgs.bright, 'aPos', quadBuf, 2)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      /* 2) 逐级下采样 */
      for (var i = 1; i < BLOOM.levels; i++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFbo[i])
        gl.viewport(0, 0, bloomW[i], bloomH[i])
        gl.useProgram(postProgs.down)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, bloomTex[i - 1])
        gl.uniform1i(gl.getUniformLocation(postProgs.down, 'uTex'), 0)
        gl.uniform2f(gl.getUniformLocation(postProgs.down, 'uTexel'), 1 / bloomW[i - 1], 1 / bloomH[i - 1])
        bindAttrib(postProgs.down, 'aPos', quadBuf, 2)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      }
      /* 3) 反向逐级叠加（加性混合，把大范围的辉光汇回小 mip） */
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      for (var j = BLOOM.levels - 1; j > 0; j--) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFbo[j - 1])
        gl.viewport(0, 0, bloomW[j - 1], bloomH[j - 1])
        gl.useProgram(postProgs.up)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, bloomTex[j])
        gl.uniform1i(gl.getUniformLocation(postProgs.up, 'uTex'), 0)
        gl.uniform2f(gl.getUniformLocation(postProgs.up, 'uTexel'), 1 / bloomW[j], 1 / bloomH[j])
        gl.uniform1f(gl.getUniformLocation(postProgs.up, 'uOpacity'), 0.75)
        bindAttrib(postProgs.up, 'aPos', quadBuf, 2)
        gl.drawArrays(gl.TRIANGLES, 0, 6)
      }
      gl.disable(gl.BLEND)
    }
    /* 4) 合成到画布：这里做整张图唯一的一次色调映射 */
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, hdrW, hdrH)
    gl.useProgram(postProgs.composite)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, hdrTex)
    gl.uniform1i(gl.getUniformLocation(postProgs.composite, 'uHdr'), 0)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, bloomTex[0])
    gl.uniform1i(gl.getUniformLocation(postProgs.composite, 'uBloom'), 1)
    gl.uniform1f(gl.getUniformLocation(postProgs.composite, 'uBloomStrength'), BLOOM.strength)
    gl.uniform1f(gl.getUniformLocation(postProgs.composite, 'uExposure'), MAIN_EXPOSURE)
    gl.uniform1f(gl.getUniformLocation(postProgs.composite, 'uContrast'), CONTRAST)
    gl.uniform1f(gl.getUniformLocation(postProgs.composite, 'uGamma'), POST_GAMMA)
    gl.uniform2f(gl.getUniformLocation(postProgs.composite, 'uTexelS'), 1 / hdrW, 1 / hdrH)
    gl.uniform3f(gl.getUniformLocation(postProgs.composite, 'uSharp'),
      SHARPEN.on ? 1 : 0, SHARPEN.amount, SHARPEN.radius)
    bindAttrib(postProgs.composite, 'aPos', quadBuf, 2)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    gl.activeTexture(gl.TEXTURE0)
    void quadLoc
    gl.enable(gl.DEPTH_TEST)
    gl.depthMask(true)
  }

  /* ---- 真实星表的星点（加法混合的小面片）---- */
  var STAR_VERT = [
    'attribute vec3 aDir;',
    'attribute vec2 aCorner;',
    'attribute float aMag;',
    'attribute float aBv;',
    'uniform mat4 uProj, uView;',
    'uniform float uSkyR, uWorldPerPx, uGain;',
    'varying vec2 vCorner;',
    'varying vec3 vColor;',
    'varying float vFlux;',
    'varying float vMag;',
    TONEMAP,
    'void main() {',
    '  vCorner = aCorner;',
    '  vMag = aMag;',
    '  float flux = pow(10.0, -0.4 * (aMag - 0.5));',
    '  vFlux = min(1.7, flux * uGain);',
    '  vColor = blackbody(aBv);',
    /* 半径按流量的立方根增长（能量在像素上摊开），亮星才有明显的星芒 */
    '  float px = clamp(2.6 * pow(max(flux, 1e-4), 0.3), 1.6, 30.0);',
    '  float size = px * uWorldPerPx;',
    // 相机固定在 +Z 看向 −Z，所以屏幕轴就是 +X / +Y
    '  vec3 pos = aDir * uSkyR + vec3(aCorner.x, aCorner.y, 0.0) * size;',
    '  gl_Position = uProj * uView * vec4(pos, 1.0);',
    '}'
  ].join('\n')

  var STAR_FRAG = [
    'precision highp float;',
    'varying vec2 vCorner;',
    'varying vec3 vColor;',
    'varying float vFlux;',
    'varying float vMag;',
    'void main() {',
    '  float r = length(vCorner);',
    '  float core = exp(-r * r * 4.2);',
    /* 四芒衍射：真实望远镜（有遮挡的光学系统）在亮星上的特征，
       只给亮星，且幅度很小 —— 这是"像照片"而不是"像画点"的关键细节。 */
    '  float spike = smoothstep(3.6, 1.2, vMag) * 0.16 *',
    '    (pow(max(0.0, 1.0 - abs(vCorner.x)), 9.0) + pow(max(0.0, 1.0 - abs(vCorner.y)), 9.0));',
    '  float a = (core + spike) * vFlux;',
    '  gl_FragColor = vec4(vColor * a, 1.0);',
    '}'
  ].join('\n')

  /* ---- 天体（远景行星 + 伽利略卫星）：统一光照 ---- */
  var BODY_VERT = [
    'attribute vec3 aPos;',
    'attribute vec2 aUv;',
    'uniform mat4 uProj, uView, uModel;',
    'varying vec3 vWorld;',
    'varying vec3 vLocal;',
    'varying vec2 vUv;',
    'void main() {',
    '  vLocal = aPos;',
    '  vUv = aUv;',
    '  vec4 w = uModel * vec4(aPos, 1.0);',
    '  vWorld = w.xyz;',
    '  gl_Position = uProj * uView * w;',
    '}'
  ].join('\n')

  var BODY_FRAG = [
    'precision highp float;',
    'uniform float uTonemapHere;',   // 由 JS 按成像路径设置（见 sfxTonemap）
    'uniform sampler2D uMap;',
    'uniform sampler2D uRingMap;',
    'uniform vec3 uLightDir;',
    'uniform vec3 uShadeView;',      // 着色用观察方向（远景天体 = 真实方向）
    'uniform vec3 uCamPos;',
    'uniform vec3 uBodyCenter;',
    'uniform vec3 uRingNormal;',
    'uniform vec3 uAtmoColor;',
    'uniform mat3 uRot;',
    'uniform float uFlatten;',
    'uniform float uSurfBright;',
    'uniform float uAirless;',
    'uniform float uExposure;',
    'uniform float uUseRealView;',   // 1 = 用真实观察方向着色
    'uniform float uTermSoft;',
    'uniform float uLimbDark;',
    'uniform float uOpposition;',
    'uniform float uRimPow;',
    'uniform float uRimStrength;',
    'uniform float uRingShadow;',
    'uniform float uDebug;',
    'uniform float uRingInner, uRingOuter, uRingOpacity;',
    'uniform float uBodyRadius;',
    'varying vec3 vWorld;',
    'varying vec3 vLocal;',
    'varying vec2 vUv;',
    TONEMAP,
    'void main() {',
    '  vec3 d = normalize(vLocal);',
    /* 扁球：x²+z²+(y/f)²=1 的梯度 ⇒ n ∝ (x, y/f², z)，逐像素解析求法线 */
    '  vec3 nLocal = normalize(vec3(d.x, d.y / (uFlatten * uFlatten), d.z));',
    '  vec3 N = normalize(uRot * nLocal);',
    '  vec3 L = normalize(uLightDir);',
    '  vec3 V = uUseRealView > 0.5 ? normalize(uShadeView) : normalize(uCamPos - vWorld);',
    '  vec3 base = pow(texture2D(uMap, vUv).rgb, vec3(2.2));',
    '  float mu0 = max(dot(N, L), 0.0);',
    '  float mu = max(dot(N, V), 0.0);',
    /* 反射模型：无气风化层（水星/火星/卫星）用 Lommel-Seeliger
       （μ0/(μ0+μ)），这正是月面/水星这类粗糙无气表面在真实照片里的
       特征 —— 边缘比 Lambert 更亮、正对时更平；有大气用 Lambert。 */
    '  float refl;',
    '  if (uAirless > 0.5) { refl = 2.0 * mu0 / max(1e-4, mu0 + mu); } else { refl = mu0; }',
    /* 冲日效应：相位角趋零时急剧增亮（无气天体最明显） */
    '  float phase = acos(clamp(dot(L, V), -1.0, 1.0));',
    '  refl *= 1.0 + uOpposition * exp(-phase / 0.07);',
    /* 晨昏线柔化：有大气 → 宽而软；无气 → 很窄 */
    '  float day = smoothstep(-uTermSoft, uTermSoft * 2.0, dot(N, L));',
    /* 临边昏暗：气态巨行星没有固体表面，掠射只看到稀薄高层 ⇒ 球缘偏暗 */
    '  float limb = mix(1.0 - uLimbDark, 1.0, pow(mu, 0.42));',
    '  vec3 lit = base * uSurfBright * refl * limb;',
    /* 夜面：只留行星际尘埃/黄道光量级的极弱照明（约 1e-3 相对值） */
    '  vec3 night = base * uSurfBright * 0.0015;',
    '  vec3 color = mix(night, lit, day);',
    /* 环在行星上的投影（真实求交，不是画一条暗带） */
    '  if (uRingShadow > 0.5) {',
    '    vec3 P = vWorld - uBodyCenter;',
    '    float den = dot(uRingNormal, L);',
    '    if (abs(den) > 1e-4) {',
    '      float t = -dot(uRingNormal, P) / den;',
    '      if (t > 0.0) {',
    '        float rho = length(P + L * t) / uBodyRadius;',
    '        if (rho > uRingInner && rho < uRingOuter) {',
    '          float tau = texture2D(uRingMap, vec2((rho - uRingInner) / (uRingOuter - uRingInner), 0.5)).a;',
    '          color *= 1.0 - clamp(uRingOpacity * tau * 2.2, 0.0, 0.96);',
    '        }',
    '      }',
    '    }',
    '  }',
    /* 大气边缘散射（有大气）：视线在球缘穿过更厚的气层 */
    '  float fres = pow(1.0 - mu, uRimPow);',
    '  color += uAtmoColor * uRimStrength * fres * (0.2 + 0.8 * day) * uSurfBright * 3.0;',
    '  color *= uExposure;',
    /* 诊断模式（__spaceGlobe.setDebug）：1=贴图原色 2=N·L 3=法线 4=最终颜色。
       写它是为了把"暗面/错位"这类问题从"看起来不对"变成"看一眼就知道哪一项不对" */
    '  if (uDebug > 0.5) {',
    '    if (uDebug < 1.5) { gl_FragColor = vec4(pow(base, vec3(1.0/2.2)), 1.0); return; }',
    '    if (uDebug < 2.5) { gl_FragColor = vec4(vec3(max(dot(N, L), 0.0)), 1.0); return; }',
    '    if (uDebug < 3.5) { gl_FragColor = vec4(N * 0.5 + 0.5, 1.0); return; }',
    '    if (uDebug < 4.5) { gl_FragColor = vec4(tonemap(color), 1.0); return; }',
    '  }',
    '  gl_FragColor = vec4(uTonemapHere > 0.5 ? tonemap(color) : color, 1.0);',
    '}'
  ].join('\n')

  /* ---- 木星本体：保留旧版高价值部分（逐像素椭球法线、差速自转、
          域扭曲、bump、临边昏暗），但改吃统一曝光与统一太阳方向 ---- */
  var JUP_FRAG = [
    'precision highp float;',
    'uniform float uTonemapHere;',   // 由 JS 按成像路径设置（见 sfxTonemap）
    'uniform sampler2D uMap;',
    'uniform vec3 uLightDir, uCamPos, uAtmoColor;',
    'uniform mat3 uRot, uRotT;',
    'uniform float uTime, uSpin, uFlatten, uSurfBright, uExposure, uDebug;',
    /* 体积霾的两个可调量：密度（决定临边亮环的宽度与强度）
       与色调（木星高层霾偏暖褐）。 */
    'uniform float uHazeDensity;',
    'uniform vec3 uHazeColor;',
    'uniform float uHazeGain;',
    'uniform float uDetailGain;',
    'varying vec3 vWorld;',
    'varying vec3 vLocal;',
    'varying vec2 vUv;',
    TONEMAP,
    'float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }',
    'float vnoise(vec2 p) {',
    '  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),',
    '             mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);',
    '}',
    'float fbm(vec2 p) {',
    '  float v = 0.0; float a = 0.5;',
    '  for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.03; a *= 0.5; }',
    '  return v;',
    '}',
    /* ---- 云带微细节 ----
       [为什么需要]
       贴图在球面上只有 2.8 texel/px（2048 宽的图铺在 774px 的球面上），
       也就是说贴图本身的细节**比屏幕需要的少**，放大看云带会"发糊"。
       而真实的云带在照片里是"亮的区域里有细丝、暗的带里有小涡旋"，
       这是一种**统计上**的质感，不必逐条还原。
       所以这里在采样坐标上叠一层高频噪声去调制反照率，制造细丝；
       频率取得很高（沿纬度约 330 个周期），在屏幕上就是 2~3 像素的纹理。
       [为什么不做成"从贴图重建法线"的中频噪声]
       那条路（中频位移）会改动云带边界的位置，看起来像云在蠕动；
       而这里只改亮度、不改几何，所以云带结构保持稳定。
       幅度给小（±4%）：过大立刻变成"噪点"而不是"质感"，
       而且会被各向异性过滤糊成一层灰雾。 */
    'float detailPat(vec2 uv, float t) {',
    /* 经度方向的频率只有纬度方向的 1/6：得到的是**沿纬向拉长**的细丝，
       而不是各向同性的颗粒。第一版两个方向同频，结果整颗星像撒了沙
       （放大看就是噪点，不是云带的质感）。 */
    '  float a = vnoise(vec2(uv.x * 150.0 + t * 0.05, uv.y * 330.0));',
    '  float b = vnoise(vec2(uv.x * 48.0 - t * 0.03, uv.y * 96.0 + 11.7));',
    '  return (a - 0.5) * 0.7 + (b - 0.5) * 0.3;',
    '}',
    'void main() {',
    '  vec3 pl = uRotT * vWorld;',
    '  vec3 nLocal = normalize(vec3(pl.x, pl.y / (uFlatten * uFlatten), pl.z));',
    '  vec3 N = normalize(uRot * nLocal);',
    '  vec3 V = normalize(uCamPos - vWorld);',
    '  vec3 L = normalize(uLightDir);',
    /* 差速自转：赤道约 9h50m、高纬约 9h56m，赤道快 ~5.5% */
    '  float cosLat = cos((0.5 - vUv.y) * 3.14159265);',
    '  float spinRate = mix(0.945, 1.0, cosLat * cosLat);',
    '  float spinEff = uSpin * spinRate;',
    /* 域扭曲（噪声喂噪声）：云带被风卷起、互相翻卷，而不是整块平移 */
    '  vec2 p = vec2(vUv.x * 2.0 + uTime * 0.008, vUv.y * 4.0 + uTime * 0.003);',
    '  vec2 q = vec2(fbm(p), fbm(p + 5.2));',
    '  vec2 r = vec2(fbm(p + q + 1.3), fbm(p + q + 7.1));',
    '  vec2 warp = (r - 0.5) * 0.022;',
    '  float turb = 0.0009 * sin(vUv.y * 160.0 + uTime * 0.05)',
    '           + 0.0005 * sin(vUv.x * 36.0 + vUv.y * 90.0 + uTime * 0.035);',
    '  vec2 uv = vec2(fract(vUv.x + spinEff + turb + warp.x), vUv.y + warp.y);',
    /* bump：用贴图亮度当高度场，沿经纬各采一次算梯度扰动法线 */
    '  float stepX = 2.0 / 2048.0;',
    '  vec3 c = texture2D(uMap, uv).rgb;',
    '  vec3 cx = texture2D(uMap, vec2(fract(uv.x + stepX), uv.y)).rgb;',
    '  vec3 cy = texture2D(uMap, vec2(uv.x, min(1.0, uv.y + stepX * 0.5))).rgb;',
    '  float lc = dot(c, vec3(0.299, 0.587, 0.114));',
    /* 微细节注入：只调亮度、不动几何。
       [为什么用经纬度而不是 vUv 当噪声坐标]
       vUv 是等距圆柱投影，在极区被拉伸成扇形 —— 直接拿它当噪声坐标，
       极区会出现**斜向条纹**（实测在球面右上角很明显，方向与纬向云带垂直）。
       改成由 nLocal 反解纬度（asin y）与方位角（atan z/x）：
       噪声始终贴着纬度走，与云带同向，极区也不再拉花。
       乘 uDetailGain，?detail=0 可关掉做对照。 */
    '  float detLat = asin(clamp(nLocal.y, -1.0, 1.0));',
    '  float detLon = atan(nLocal.z, nLocal.x);',
    '  vec2 detUv = vec2(detLon / 6.2831853, detLat / 3.14159265);',
    '  c *= (1.0 + detailPat(detUv, uTime) * uDetailGain);',
    '  float lcx = dot(cx, vec3(0.299, 0.587, 0.114));',
    '  float lcy = dot(cy, vec3(0.299, 0.587, 0.114));',
    '  vec3 T = normalize(vec3(nLocal.z, 0.0, -nLocal.x));',
    '  vec3 B = normalize(cross(T, nLocal));',
    '  vec3 nL2 = normalize(nLocal + T * ((lcx - lc) * 2.4) + B * ((lcy - lc) * 2.4));',
    '  vec3 N2 = normalize(uRot * nL2);',
    '  float grad = abs(lcx - lc) + abs(lcy - lc);',
    '  float ao = 1.0 - clamp(grad * 2.5, 0.0, 0.22);',
    '  float ndl = dot(N2, L);',
    '  float day = smoothstep(-0.12, 0.30, ndl);',
    '  float diffuse = max(ndl, 0.0);',
    '  float mu = clamp(dot(N, V), 0.0, 1.0);',
    '  float limbDark = mix(0.80, 1.0, pow(mu, 0.42));',
    '  vec3 base = pow(c, vec3(2.2));',
    '  vec3 lit = base * uSurfBright * diffuse * limbDark * ao;',
    '  vec3 night = base * uSurfBright * 0.0018 * ao;',
    '  vec3 color = mix(night, lit, day);',
    /* ---- 体积霾 / 临边散射 ----
       [为什么换成这一套]
       原来是一行经验公式：pow(1−mu, 1.8) × 颜色 × 常数，只能在球缘糊出
       一圈亮边，球面上的明暗过渡完全是平的。真实照片里的临边是
       **视线穿过一层壳的累积散射**：从掠射到正视，穿过的气柱长度连续变化，
       于是亮度沿半径平滑爬升，而且迎光侧比背光侧更亮得多（前向散射）。

       [几何上的一个坑，踩过一次]
       壳层必须**在球面之外**（半径 1 → 1+h）。第一版写成 1−h（壳在球面
       里面），于是沿视线的"穿过长度"在正对处最大、在边缘处趋零 ——
       结果整张球面被一层白雾糊满、球缘反而暗，看起来像一颗发光的蛋。
       球面在半径 1，射线弦到球心的距离为 b：
         球面出口参数 t0 = sqrt(1 − b²)
         壳层出口参数 t1 = sqrt((1+h)² − b²)
       穿过的气柱长度就是 t1 − t0：
         正视（b=0）    → (1+h) − 1 = h        （最薄）
         掠射（b→1）    → sqrt(2h) − 0         （最厚，约 0.26 ≫ h）
       用 b² = 1 − cos² 表达，避免再引入向量运算。 */
    '  vec3 toCam = -normalize(vWorld);',
    '  float cosToCam = clamp(dot(N, toCam), 0.0, 1.0);',
    '  float sin2ToCam = max(1.0 - cosToCam * cosToCam, 0.0);',
    '  float cosToSun = clamp(dot(N, L), 0.0, 1.0);',
    '  float sin2ToSun = max(1.0 - cosToSun * cosToSun, 0.0);',
    '  float h = 0.03;',
    '  float outer2 = (1.0 + h) * (1.0 + h);',
    '  float chanV = sqrt(max(0.0, outer2 - sin2ToCam)) - sqrt(max(0.0, 1.0 - sin2ToCam));',
    '  float chanL = sqrt(max(0.0, outer2 - sin2ToSun)) - sqrt(max(0.0, 1.0 - sin2ToSun));',
    /* 临边权重：把霾限制在"视线明显掠射"的一圈里。
       纯物理的弦长比在球心已经很小（h vs 0.26），乘上密度后仍有值，
       会把球面整体提亮一点；显式再乘一个以掠射为主的权重，
       保证云带的对比不被冲淡。 */
    /* 指数取 6、基底压到 0.02：用 tools/_haze-math.js 数值扫过 ——
       原参数（指数 3、基底 0.15）在**正视处**就给 0.13 的散射，
       整张球面因此糊上一层白雾（现象是"发光的蛋"）。
       改后正视 0.014、cos=0.7 处 0.07、边缘 0.97 —— 只在边缘发亮。 */
    '  float graze = pow(1.0 - cosToCam, 8.0);',
    '  float tau = uHazeDensity * (chanV + chanL) * (0.02 + 0.98 * graze) * 6.0;',
    '  float scat = 1.0 - exp(-tau);',
    /* 相位：前向散射峰值出现在"背对太阳看过去"的方向（V 与 L 反向） */
    '  float cosPhase = dot(V, L);',
    '  float phase = 1.0 + 0.55 * (-cosPhase);',
    /* 受光侧才有霾被照亮；背光侧只留一点点（环绕大气的散射光） */
    '  float litSide = smoothstep(-0.25, 0.45, dot(N, L));',
    /* [为什么这里不再乘 uSurfBright]
       uSurfBright 是"表面反照率"的归一（木星 0.538），它该作用在**表面**
       反射上；大气散射与表面反照率无关。第一版把它一起乘进去，
       结果霾被放大到 1.5 以上、整颗星过曝成白球。
       现在的量级是显式标定的：边缘处 scat≈1、phase≈1.5、litSide≈1，
       乘 uHazeGain(0.35) 后约 0.5 的线性增量 —— ACES 下读作"边缘一圈
       明显的暖光"，而不是盖住云带。 */
    '  vec3 haze = uHazeColor * scat * phase * (0.2 + 0.95 * litSide) * uHazeGain;',
    '  color += haze;',
    '  vec3 H = normalize(L + V);',
    '  float spec = pow(max(dot(N2, H), 0.0), 28.0) * 0.03;',
    '  color += vec3(spec) * day;',
    '  color *= uExposure;',
    '  if (uDebug > 0.5) {',
    '    if (uDebug < 1.5) { gl_FragColor = vec4(c, 1.0); return; }',
    '    if (uDebug < 2.5) { gl_FragColor = vec4(vec3(max(ndl, 0.0)), 1.0); return; }',
    '    if (uDebug < 3.5) { gl_FragColor = vec4(N2 * 0.5 + 0.5, 1.0); return; }',
    '  }',
    '  gl_FragColor = vec4(uTonemapHere > 0.5 ? tonemap(color) : color, 1.0);',
    '}'
  ].join('\n')

    /* 环：真实径向剖面 + 前/后向散射差异 + 行星投影 */
  var RING_VERT = [
    'attribute float aT;',
    'attribute float aAng;',
    'uniform mat4 uProj, uView, uModel;',
    'uniform float uInner, uOuter;',
    'varying float vT;',
    'varying vec3 vWorld;',
    'void main() {',
    '  float rad = mix(uInner, uOuter, aT);',
    '  vec3 local = vec3(cos(aAng) * rad, 0.0, sin(aAng) * rad);',
    '  vec4 w = uModel * vec4(local, 1.0);',
    '  vWorld = w.xyz;',
    '  vT = aT;',
    '  gl_Position = uProj * uView * w;',
    '}'
  ].join('\n')

  var RING_FRAG = [
    'precision highp float;',
    'uniform float uTonemapHere;',   // 由 JS 按成像路径设置（见 sfxTonemap）
    'uniform sampler2D uRing;',
    'uniform vec3 uLightDir, uCamPos, uBodyCenter, uRingNormal;',
    'uniform float uOpacity, uBodyRadius, uExposure, uForward;',
    'varying float vT;',
    'varying vec3 vWorld;',
    TONEMAP,
    'void main() {',
    '  vec4 tex = texture2D(uRing, vec2(vT, 0.5));',
    '  vec3 L = normalize(uLightDir);',
    '  vec3 V = normalize(uCamPos - vWorld);',
    '  vec3 n = normalize(uRingNormal);',
    /* 环是薄盘：用太阳与环面法线的夹角决定整体亮度（掠射时被照亮面积更大），
       并且真实环以背散射为主、前向散射时透光发亮 —— 两个方向分开建模 */
    '  float muSun = abs(dot(n, L));',
    '  float muView = abs(dot(n, V));',
    '  float lit = 0.30 + 0.70 * pow(muSun, 0.75);',
    '  float fwd = pow(max(0.0, dot(-L, V)), 3.0) * (1.0 - muSun);',
    '  lit += uForward * fwd;',
    /* 行星在环上的投影 */
    '  float shadow = 1.0;',
    '  vec3 P = vWorld - uBodyCenter;',
    '  float b = dot(P, L);',
    '  float cc = dot(P, P) - uBodyRadius * uBodyRadius;',
    '  float disc = b * b - cc;',
    '  if (disc > 0.0 && b < 0.0) {',
    '    float t = -b - sqrt(disc);',
    '    shadow = smoothstep(0.0, 0.30, t);',
    '  }',
    '  float a = tex.a * uOpacity * lit * shadow * (0.82 + 0.18 * muView);',
    '  if (a < 0.002) discard;',
    '  vec3 col = pow(tex.rgb, vec3(2.2)) * (0.55 + 0.45 * muSun) * uExposure;',
    '  gl_FragColor = vec4(uTonemapHere > 0.5 ? tonemap(col) : col, a);',
    '}'
  ].join('\n')

  /* ---- 流星：加性混合的条带（画在远景之后，会被行星正确遮挡）---- */
  var METEOR_VERT = [
    'attribute vec3 aPos;',
    'attribute float aTail;',
    'uniform mat4 uProj, uView;',
    'varying float vTail;',
    'void main() {',
    '  vTail = aTail;',
    '  gl_Position = uProj * uView * vec4(aPos, 1.0);',
    '}'
  ].join('\n')
  var METEOR_FRAG = [
    'precision highp float;',
    'varying float vTail;',
    'void main() {',
    '  float a = pow(1.0 - vTail, 1.8) * 0.85;',
    '  gl_FragColor = vec4(vec3(0.72, 0.82, 1.0) * a, a);',
    '}'
  ].join('\n')

  /* ================= 程序与缓冲 ================= */
  var skyProg, blitProg, starProg, bodyProg, jupProg, ringProg, meteorProg
  var postProgs = null
  try {
    skyProg = program(SKY_VERT, SKY_FRAG, 'sky')
    blitProg = program(SKY_VERT, BLIT_FRAG, 'blit')
    starProg = program(STAR_VERT, STAR_FRAG, 'star')
    bodyProg = program(BODY_VERT, BODY_FRAG, 'body')
    jupProg = program(BODY_VERT, JUP_FRAG, 'jupiter')
    ringProg = program(RING_VERT, RING_FRAG, 'ring')
    meteorProg = program(METEOR_VERT, METEOR_FRAG, 'meteor')
    /* 后处理程序只在 HDR 路径下编译；编译失败就整体退回直渲路径
       （bloom 是加分项，不能因为它让整块画布黑掉） */
    if (postMode === 'hdr') {
      try {
        postProgs = {
          bright: program(QUAD_VERT, BRIGHT_FRAG, 'bloom-bright'),
          down: program(QUAD_VERT, DOWN_FRAG, 'bloom-down'),
          up: program(QUAD_VERT, UP_FRAG, 'bloom-up'),
          composite: program(QUAD_VERT, COMPOSITE_FRAG, 'composite')
        }
        bloomProg = postProgs.bright
        compositeProg = postProgs.composite
      } catch (e2) {
        console.warn('[space] 后处理着色器编译失败，退回直渲路径: ' + e2.message)
        postMode = 'direct'
        postProgs = null
      }
    }
  } catch (e) { bail('shader: ' + e.message); return }

  /* 单位球（扁率在着色器里处理，几何保持球面） */
  function buildSphere (lon, lat) {
    var pos = [], uv = [], idx = []
    for (var j = 0; j <= lat; j++) {
      var v = j / lat
      var la = (0.5 - v) * Math.PI
      var cl = Math.cos(la), sl = Math.sin(la)
      for (var i = 0; i <= lon; i++) {
        var u = i / lon
        var lo = u * Math.PI * 2
        pos.push(cl * Math.sin(lo), sl, cl * Math.cos(lo))
        uv.push(u, v)
      }
    }
    for (var jj = 0; jj < lat; jj++) {
      for (var ii = 0; ii < lon; ii++) {
        var a = jj * (lon + 1) + ii
        var b = a + lon + 1
        idx.push(a, b, a + 1, a + 1, b, b + 1)
      }
    }
    return { pos: new Float32Array(pos), uv: new Float32Array(uv), idx: new Uint16Array(idx) }
  }
  var sphereHi = buildSphere(128, 72)      // 木星
  var sphereLo = buildSphere(48, 24)       // 其余天体
  /* 环：t ∈ [0,1] 为径向参数，半径在顶点着色器里 mix(inner, outer, t) */
  function buildRing (seg, rad) {
    var t = [], ang = [], idx = []
    for (var r = 0; r <= rad; r++) {
      for (var s = 0; s <= seg; s++) {
        t.push(r / rad)
        ang.push((s / seg) * Math.PI * 2)
      }
    }
    for (var r2 = 0; r2 < rad; r2++) {
      for (var s2 = 0; s2 < seg; s2++) {
        var a2 = r2 * (seg + 1) + s2
        var b2 = a2 + seg + 1
        idx.push(a2, b2, a2 + 1, a2 + 1, b2, b2 + 1)
      }
    }
    return { t: new Float32Array(t), ang: new Float32Array(ang), idx: new Uint16Array(idx) }
  }
  var ringGeo = buildRing(256, 8)
  var quad = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1])

  function buf (data, target) {
    var b = gl.createBuffer()
    gl.bindBuffer(target || gl.ARRAY_BUFFER, b)
    gl.bufferData(target || gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
    return b
  }
  var sHi = { pos: buf(sphereHi.pos), uv: buf(sphereHi.uv), idx: buf(sphereHi.idx, gl.ELEMENT_ARRAY_BUFFER) }
  var sLo = { pos: buf(sphereLo.pos), uv: buf(sphereLo.uv), idx: buf(sphereLo.idx, gl.ELEMENT_ARRAY_BUFFER) }
  var rGeo = { t: buf(ringGeo.t), ang: buf(ringGeo.ang), idx: buf(ringGeo.idx, gl.ELEMENT_ARRAY_BUFFER) }
  var quadBuf = buf(quad)
  var meteorBuf = gl.createBuffer()
  var meteorData = new Float32Array(2 * 6 * 4)   // ≤2 条流星 × 6 顶点 × (xyz + tail)

  /* ================= 贴图 ================= */
  function makeTex (unit) {
    var t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([40, 40, 44, 255]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return t
  }
  /* ================= 纹理过滤与 mipmap =================
     [为什么必须上 mipmap]
     旧版最高只用 LINEAR 采样：球面 1:1 处勉强能看，一旦贴图被缩小
     （球缘、远行星、以及 dpr<1 的屏幕），采样点之间就会跳着取，
     表现为云带上的"彩噪 / 沙沙的横纹" —— 这正是"看起来不像照片"
     最主要的一条，而且它跟贴图分辨率无关（换更高清的图只会更严重）。
     mipmap 是唯一正确的解法：按屏幕导数自动选合适的层。
     各向异性再补上掠射方向（球缘、极区）的模糊/摩尔纹。

     [WebGL1 的坑还在，但换了办法]
     WebGL1 里非 2 次幂纹理不能带 mipmap，否则纹理被判"不完整"，
     采样直接返回黑色（不报错、不抛异常）。这里改成：
       · 尽力拿 WebGL2（NPOT 也能带 mipmap + 各向异性）
       · 拿不到就用 WebGL1，并且只在 2 的幂纹理上开 mipmap
     两个贴图档位都是 2 的幂（2048x1024 / 3072x1536），所以两条路都安全。 */
  var maxAniso = 1
  if (isWebGL2) {
    var anisoExt = gl.getExtension('EXT_texture_filter_anisotropic')
    if (anisoExt) {
      /* [为什么不再钳到 8]
         球面是经纬贴图，经度方向在球缘被压缩 8~16 倍（见下面 applyFilter 的注释），
         而"球缘"正好是用户视线最常停留的一圈。原先硬编码 Math.min(8, ...)，
         实测本机 RTX 5060 报的上限是 **16** —— 也就是白白丢掉一半各向异性，
         代价全落在球缘的清晰度上。改成取设备上限（?aniso= 可覆盖做对照）。 */
      var anisoQ = parseInt(qsv('aniso'), 10)
      var devMax = gl.getParameter(anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1
      if (isFinite(anisoQ) && anisoQ > 0) maxAniso = Math.min(anisoQ, devMax)
      else if (perfIs('low')) maxAniso = Math.min(2, devMax)
      else maxAniso = devMax
    }
  }
  console.log('[space] WebGL2=' + isWebGL2 + ' 各向异性=' + maxAniso)

  function isPOT (v) { return (v & (v - 1)) === 0 && v > 0 }

  /* 绑定过滤参数。canMipmap 由调用方决定（见上面的说明）。 */
  function applyFilter (t, w, h, forceClampS, canMipmap) {
    gl.bindTexture(gl.TEXTURE_2D, t)
    var pot = isPOT(w) && isPOT(h)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, (pot && !forceClampS) ? gl.REPEAT : gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (canMipmap) {
      gl.generateMipmap(gl.TEXTURE_2D)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
      if (isWebGL2 && maxAniso > 1) {
        var ext = gl.getExtension('EXT_texture_filter_anisotropic')
        if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, maxAniso)
      }
    } else {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  }
  var tex = {}
  var loaded = 0, total = 0
  var onAllLoaded = null
  function loadTex (key, url, clampS) {
    total++
    var t = makeTex()
    tex[key] = { tex: t, ready: false, clampS: !!clampS }
    var img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = function () {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img)
      /* WebGL2 对任何尺寸都能生成 mipmap；WebGL1 只能对 2 的幂。
         注意 generateMipmap 之后再设 MIN_FILTER —— 顺序反了的话
         在部分驱动上仍会判纹理不完整。 */
      var canMipmap = (isWebGL2 || (isPOT(w) && isPOT(h))) && qsv('nomip') !== '1'
      applyFilter(t, w, h, clampS, canMipmap)
      tex[key].glError = gl.getError()
      tex[key].w = w
      tex[key].h = h
      tex[key].pot = isPOT(w) && isPOT(h)
      tex[key].mip = canMipmap
      tex[key].ready = true
      loaded++
      // 天空层与星表是烘焙进离屏纹理的：到了要重新烘一次
      if (key === 'sky' && scene) { skyDirty = true; if (typeof bakeSky === 'function') bakeSky() }
      if (loaded === total && onAllLoaded) onAllLoaded()
    }
    img.onerror = function () { loaded++; tex[key].failed = true }
    img.src = url
  }
  /* 木星贴图两档。选哪一档**按"屏幕上真正要用到多少纹素"算**，不要按 dpr 猜：
     球在屏幕上的可见半球约占半径的 0.965，横跨归一化 x = 0.13~1.0
     （见下面 readLayout 的推导），经 u = 0.25·asin + 0.5 映射后只用掉
     贴图宽度的约 **0.14**；赤道处长轴方向要 4 倍贴图宽才覆盖一整圈。
     反过来算：贴图宽度 W 在赤道上能提供的纹素 = 0.25·W，
     其中进入可见半球的是 0.14·W。
     钉死视口 W×H 时球面直径 = min(0.64W, 0.86H)，取一半即半径，再乘 0.965
     就是屏幕上可见半球的像素宽 —— 贴图要至少给到这个数才不过采样。
     [实测依据] 1920x1080 下定影截图，同一帧只换贴图档位：
       2048 → detail 3.051，3072 → detail 3.392（**+11.2%**，球心附近 +17.7%），
       而平均亮度与对比度不变（-0.5% / -0.1%）。所以这不是"换张图看着舒服点"，
       是采样不足被补上了：0.14×2048 = 287 texel 要铺 445px（球心处 1 纹素 ≈ 0.9px，
       欠采样 ⇒ 糊），0.14×3072 = 430 texel 铺同样 445px（≈1.0 纹素/px，不过采样）。
     旧的判据是 `dpr >= 1.5 && max(inner) >= 1200` —— 1920x1080@100% 缩放的
     dpr 正好是 1，于是**恰恰是"大屏但 100% 缩放"这类用户拿到小图**，与
     "大屏该给大图"的直觉相反。改成按上面的几何反解，跨屏一致。 */
  var jupPref = (qsv('jup') || '').toLowerCase()
  var jupNeedPx = (function () {
    var w = applyPin() ? applyPin().w : Math.max(1, Math.round(window.innerWidth))
    var h = applyPin() ? applyPin().h : Math.max(1, Math.round(window.innerHeight))
    var dia = Math.min(0.64 * w, 0.86 * h)
    return dia / 2 * 0.965
  })()
  /* 低配模式强制小图档：省的是 545KB 下载 + 显存 + 采样带宽，
     代价是球心处从 ≈1.05 纹素/px 掉到 ≈0.70（会略软）—— 这是两档之间
     唯一"看得见的"画质差，所以在提示文案里要如实说。 */
  var wantHi = jupPref === 'hi' || (jupPref !== 'lo' && !perfIs('low') && jupNeedPx * 1.05 > 0.14 * 2048)
  loadTex('jupiter', wantHi ? '/img/jupiter-map-hi.jpg' : '/img/jupiter-map.jpg')
  loadTex('sky', '/img/sky-milkyway.jpg', true)
  loadTex('saturnRing', '/img/saturn-ring.png', true)
  ;['mercury', 'venus', 'earth', 'mars', 'saturn', 'uranus', 'neptune'].forEach(function (n) {
    loadTex(n, '/img/planet-' + n + '.jpg')
  })
  ;['io', 'europa', 'ganymede', 'callisto'].forEach(function (n) {
    loadTex('moon-' + n, '/img/moon-' + n + '.jpg')
  })

  /* 木星环的径向剖面：程序生成（真实分段 + 环缝），与旧版一致但按真实
     光学厚度重新标定（见 space-system.js 的 JUPITER_RING） */
  function buildJupiterRingTex () {
    var W = 512
    var px = new Uint8Array(W * 4)
    var stops = [
      [0.00, 0.000], [0.06, 0.030], [0.16, 0.050], [0.20, 0.020],
      [0.22, 0.170], [0.24, 0.230], [0.28, 0.120], [0.34, 0.035],
      [0.60, 0.028], [0.84, 0.022], [1.00, 0.000]
    ]
    for (var x = 0; x < W; x++) {
      var t = x / (W - 1)
      var a = 0
      for (var i = 0; i < stops.length - 1; i++) {
        var s0 = stops[i], s1 = stops[i + 1]
        if (t >= s0[0] && t <= s1[0]) {
          var k = (t - s0[0]) / Math.max(1e-6, s1[0] - s0[0])
          k = k * k * (3 - 2 * k)
          a = s0[1] + (s1[1] - s0[1]) * k
          break
        }
      }
      var o = x * 4
      px[o] = 232; px[o + 1] = 222; px[o + 2] = 206
      px[o + 3] = Math.round(Math.min(1, a) * 255)
    }
    var tex0 = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, tex0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    return tex0
  }
  var jupRingTex = buildJupiterRingTex()

  /* ================= 星表（真实恒星） ================= */
  var stars = null
  var starsRaw = null
  var starBuf = null
  /* 星表状态：'idle' | 'ok' | 'dead'。截图端靠它判断"能不能定影"，
     页面本身不需要它做任何渲染决策。 */
  var starState = 'idle'
  function loadStars () {
    var xhr = new XMLHttpRequest()
    xhr.open('GET', '/img/stars.bin', true)
    xhr.responseType = 'arraybuffer'
    xhr.onload = function () {
      if (xhr.status !== 200 && xhr.status !== 0) {
        console.warn('[space] stars.bin 加载失败', xhr.status)
        starState = 'dead'; return
      }
      try {
        starsRaw = xhr.response
        stars = SS.parseStarCatalog(starsRaw, scene)
        buildStarBuffer()
        starState = 'ok'
      } catch (e) { console.warn('[space] 星表解析失败', e.message); starState = 'dead' }
    }
    xhr.onerror = function () {
      console.warn('[space] stars.bin 请求失败')
      starState = 'dead'
    }
    xhr.send()
  }
  function buildStarBuffer () {
    if (!stars) return
    var n = stars.count
    var verts = n * 6
    var dir = new Float32Array(verts * 3)
    var corner = new Float32Array(verts * 2)
    var mag = new Float32Array(verts)
    var bv = new Float32Array(verts)
    var CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]]
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < 6; k++) {
        var o = i * 6 + k
        dir[o * 3] = stars.pos[i * 3]
        dir[o * 3 + 1] = stars.pos[i * 3 + 1]
        dir[o * 3 + 2] = stars.pos[i * 3 + 2]
        corner[o * 2] = CORNERS[k][0]
        corner[o * 2 + 1] = CORNERS[k][1]
        mag[o] = stars.mag[i]
        bv[o] = stars.bv[i]
      }
    }
    if (starBuf) { gl.deleteBuffer(starBuf.dir); gl.deleteBuffer(starBuf.corner); gl.deleteBuffer(starBuf.mag); gl.deleteBuffer(starBuf.bv) }
    starBuf = { dir: buf(dir), corner: buf(corner), mag: buf(mag), bv: buf(bv), count: verts }
    skyDirty = true
    bakeSky()
  }

  /* ================= 天空烘焙 ================= */
  var skyFbo = null, skyTex = null, skyW = 0, skyH = 0, skyDirty = true
  function ensureSkyFbo () {
    var w = Math.max(2, Math.round(vw * dpr)), h = Math.max(2, Math.round(vh * dpr))
    if (skyFbo && w === skyW && h === skyH) return
    if (skyFbo) { gl.deleteFramebuffer(skyFbo); gl.deleteTexture(skyTex) }
    skyW = w; skyH = h
    skyTex = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, skyTex)
    /* HDR 路径下烘焙图必须是浮点：此时天空层不做色调映射，
       亮星与银河高光的值会超过 1.0，存进 8bit 就被裁掉了
       （表现是亮星变成纯白的方点、周围没有辉光可洇）。
       直渲路径（天空在这个阶段就被映射到 0..1）继续用 8bit，省显存。 */
    var hdrSky = postActive() && isWebGL2 &&
      !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))
    if (hdrSky) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null)
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    skyFbo = gl.createFramebuffer()
    gl.bindFramebuffer(gl.FRAMEBUFFER, skyFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, skyTex, 0)
    var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    if (!ok) {
      /* 浮点失败就退回 8bit 天空（宁可没有高光余量，也不能整片天空黑掉） */
      console.warn('[space] 天空烘焙 FBO 不完整（浮点？），改用 RGBA8')
      gl.bindTexture(gl.TEXTURE_2D, skyTex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.bindFramebuffer(gl.FRAMEBUFFER, skyFbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, skyTex, 0)
      var ok2 = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      if (!ok2) console.warn('[space] 天空烘焙 FBO 连 8bit 也不完整')
    }
  }
  function bindAttrib (p, name, b, size) {
    var loc = gl.getAttribLocation(p, name)
    if (loc < 0) return -1
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.enableVertexAttribArray(loc)
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0)
    return loc
  }
  /* 天空 = 真实银河（ESO 实拍）+ 真实星表星点 + 暗星颗粒。
     只在这里跑一次（相机静止），之后每帧只 blit。 */
  function bakeSky () {
    if (!skyDirty && skyFbo) return
    ensureSkyFbo()
    if (!skyFbo) return
    gl.bindFramebuffer(gl.FRAMEBUFFER, skyFbo)
    gl.viewport(0, 0, skyW, skyH)
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)
    gl.disable(gl.BLEND)

    /* 天空烘焙也要遵守"色调映射只做一次"：
       HDR 路径下烘焙进浮点图，且着色器不做色调映射，最终由合成 pass 统一做。
       忘记这一步的后果很隐蔽：天空会被压两次，银河比行星暗一大截，
       而场景其他部分看起来"正常"。 */
    var tonemapHere = sfxTonemap()

    // 1) 银河弥散层
    gl.useProgram(skyProg)
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uTonemapHere'), tonemapHere)
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uP00'), proj[0])
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uP11'), proj[5])
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uP20'), proj[8])
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uP21'), proj[9])
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uSkyGain'), SKY_GAIN)
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uGrainGain'), GRAIN_GAIN)
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uCell'), GRAIN_CELL_DEG)
    gl.uniform1f(gl.getUniformLocation(skyProg, 'uSig'), GRAIN_SIGMA_DEG)
    // 参考系 → 银道（= R_gal2render 的转置）
    var g2r = scene.galacticFrame.R_gal2render
    var mat = new Float32Array([g2r[0], g2r[3], g2r[6], g2r[1], g2r[4], g2r[7], g2r[2], g2r[5], g2r[8]])
    gl.uniformMatrix3fv(gl.getUniformLocation(skyProg, 'uGalFromRender'), false, mat)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex.sky.tex)
    gl.uniform1i(gl.getUniformLocation(skyProg, 'uSky'), 0)
    bindAttrib(skyProg, 'aPos', quadBuf, 2)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    // 2) 真实星表星点（加法）
    if (starBuf) {
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.useProgram(starProg)
      gl.uniform1f(gl.getUniformLocation(starProg, 'uTonemapHere'), tonemapHere)
      gl.uniformMatrix4fv(gl.getUniformLocation(starProg, 'uProj'), false, proj)
      gl.uniformMatrix4fv(gl.getUniformLocation(starProg, 'uView'), false, view)
      var skyR = 2000
      gl.uniform1f(gl.getUniformLocation(starProg, 'uSkyR'), skyR)
      gl.uniform1f(gl.getUniformLocation(starProg, 'uGain'), STAR_GAIN)
      // 每像素对应的世界尺寸（把星点半径锁定为屏幕像素，与视场无关）
      gl.uniform1f(gl.getUniformLocation(starProg, 'uWorldPerPx'), (2 * skyR * tanHalf) / skyH)
      bindAttrib(starProg, 'aDir', starBuf.dir, 3)
      bindAttrib(starProg, 'aCorner', starBuf.corner, 2)
      bindAttrib(starProg, 'aMag', starBuf.mag, 1)
      bindAttrib(starProg, 'aBv', starBuf.bv, 1)
      gl.drawArrays(gl.TRIANGLES, 0, starBuf.count)
      gl.disable(gl.BLEND)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    skyDirty = false
  }

  /* ================= 可调常量（都有物理理由，不是随手数） ================= */
  /* 银河层增益。
     [20260916k 从 1.55 提到 2.9 —— 有意把银河"显出来"，做成星云层]
     原来是 1.55：ESO 全景图已按题注的色调曲线压到全图均值 ≤0.06，再给一个小增益
     只让银河带在深底上"刚好读得出来"，不抬整体亮度。实拍观感偏"空"，用户明确
     希望银河亮一档、像一层星云（参考的是模式切换时偶然出现的一帧全亮银河）。
     [为什么是 2.9 而不是直接抄那一帧的亮度] 出错那一帧的左半屏平均 0.134，
     已经越过文字可读性约束（探针 A10 要求文字列旁窄带 ≤0.20，而那条窄带
     正好压在银河带上）。2.9 把左半屏从 0.0344 提到约 0.065~0.075 ——
     落在"看得清银河"与"正文仍然压得住"之间，是本轮实测标定的。
     [?sky= 可覆盖] 排障与后续微调都用它，不必改代码。 */
  var SKY_GAIN = (function () {
    var q = parseFloat(qsv('sky'))
    return isFinite(q) && q >= 0 ? q : 2.9
  })()
  /* 诊断模式（见着色器里的 uDebug）：0=正常 1=贴图原色 2=N·L 3=法线 */
  var DEBUG_MODE = 0
  /* 暗星颗粒：网格 0.06°（≈5.5px）、高斯半径 0.011°（≈1px）。
     颗粒密度由采样到的银河亮度调制（见 SKY_FRAG 的 dens）。 */
  var GRAIN_GAIN = 0.55
  var GRAIN_CELL_DEG = 0.06
  var GRAIN_SIGMA_DEG = 0.011
  /* 星点增益：把星等换算到屏幕亮度。
     [为什么不是 1.0] 星等是**相对**标度：mag 0 与 mag 6 的流量差 158 倍。
     增益取 1.0 时只有亮于 2 等的星可见，6 等的星只有 0.6% 亮度（实测在
     截图里根本看不到）—— 那是"只画了亮星"的假天窗。取 6.0 后：mag 6 →
     约 4% 灰（贴近真实深空曝光里的暗星），mag 4.5 → 15%，mag 2 → 60%，
     mag 0.5 以上饱和成白色并带星芒（真实照片里亮星本来就是过曝的）。
     更暗的星由 ESO 实拍底图提供（它含真实暗星颗粒）。 */
  var STAR_GAIN = 6.0
  /* 全局曝光。ACES 曲线在 1.0 处比 Reinhard 暗（中间调被压得更实），
     所以这里需要比 1.0 更高的倍数 —— 具体值由
     tools/verify-globe-render.js 的"受光侧亮度"一项标定到与真实照片同档，
     不是拍脑袋。可用 __spaceGlobe.setExposure() 或 ?exp= 覆盖。
     [从 2.9 提到 3.3] 原来有一部分亮度是靠 haze 那层暖雾"垫"出来的
     （雾在 ACES 输入上直接加一个常数，比提曝光更"省对比度"）。
     雾去掉之后必须由曝光补回来，否则整球偏暗。
     实测（tools/detail-energy.js，定影已改成可复现）：2.9 时球面绝对 detail
     3.505，3.3 时 3.904（+11.4%）；平均亮度 155→142、对比度 2.55→3.49。
     [低配档要另一个值 —— 两条路径的"曝光"根本不是一个量纲]
     正常档走 HDR：着色器里 uExposure=1，曝光与色调映射都在合成 pass 里做一次。
     低配档走直渲：**每个着色器自己**乘 uExposure 再做 tonemap（无 bloom、无合成）。
     所以拿正常档的 3.3 去直渲会过亮 —— 实测球面中位 180 vs 正常档 94（差近一倍）。
     按中位亮度对齐后取 1.1（实测 exp=0.9→97、1.1≈105、1.4→125，正常档 94）。
     ?exp= 仍然最高优先，排障时可单点覆盖模式内定的值。 */
  var MAIN_EXPOSURE = isFinite(expQ) ? expQ : (perfIs('low') ? 1.1 : 3.3)

  /* 木星体积霾：密度与色调。
     密度 2.6 的含义：在壳层厚度取 3.5% 半径时，掠射视线（弦长≈1）的
     光学厚度约 2.6×3.5×2×1 ≈ 18 ⇒ 1−exp(−18) ≈ 1，即临边接近饱和；
     正视（弦长≈0）几乎为 0 ⇒ 球心不受影响。这正是想要的行为：
     只在边缘亮，不污染云带。可用 ?haze= 覆盖密度做对照。 */
  var hazeQ = parseFloat(qsv('haze'))
  var HAZE = {
    density: 2.6,
    /* 色调与增益都经 ACES 后的观感标定：边缘一圈暖光，不盖住云带。
       ?haze=0 可整条关掉做对照。
       [增益默认改成 0 —— 与上面那句期望相反，实测它并不"只在边缘"]
       设计意图是"边缘一圈暖光、不污染云带"，但 haze=0 与 0.07 的对照显示
       它实际上是一层**覆盖全盘的暖雾**：球心区域平均亮度被抬高约 34 luma(+40%)。
       代价是实打实的 —— 球面绝对 detail 3.904→3.505(−10%)、
       对比度 3.49→2.55(−27%)，连星野都被压暗
       （星野 mean 11.73→10.62、亮像素 12.28%→6.68%）。
       所以默认关掉；?haze=0.07 可把旧观感整条切回来做对照。
       着色器里的体积散射实现整套保留 —— 它本身是对的，只是这层壳太厚。 */
    color: [1.15, 0.88, 0.62],
    gain: isFinite(hazeQ) ? hazeQ : 0
  }

  /* 云带微细节的幅度。0.5 的含义是：detailPat 返回 ±0.5 的调制量，
     乘 0.5 后 albedo 有 ±25% 的细丝起伏 —— 在 2~3 像素的尺度上读作
     "质感"，再大就开始像噪点（而且各向异性过滤会把它糊成灰雾）。
     ?detail=0 关掉做对照。 */
  var detailQ = parseFloat(qsv('detail'))
  var DETAIL_GAIN = isFinite(detailQ) ? detailQ : 0.30

  /* HDR 后处理路径下：
     · 各着色器不做色调映射（由合成 pass 统一做一次）
     · 各着色器不再乘曝光（同上，否则会乘两次）
     直渲路径下两者都保持旧行为。
     注意：**只判断 postMode 与 nopost，不要判断 postProgs 是否已就绪** ——
     场景绘制发生在 drawPost 之前，用 postProgs 判断时它在某些调用顺序下
     还是 null，会导致"这一帧直渲、下一帧 HDR"，天空与行星的曲线不一致。 */
  function postActive () { return postMode === 'hdr' && nopost !== 1 }
  function sfxTonemap () { return postActive() ? 0 : 1 }
  function sfxExposure () { return postActive() ? 1 : MAIN_EXPOSURE }
  /* 土星环的两个系数，作用完全不同，必须分开：
       · RING_ALPHA_SATURN —— 环面四边形的不透明度（drawRing 的 uOpacity）。
         0.94 时环缝被 alpha 剖面 ×0.94 几乎抹平，环看着像一块实心脏玻璃；
         压到 0.4 量级后剖面自己说话（Cassini 缝 α=14、Encke 缝 α=0 是真实数据，
         verify-ring-profile.js 会断言）。
       · RING_SHADOW_SATURN —— 环投在球面上的阴影强度（BODY_FRAG 里
         `uRingOpacity * tau * 2.2`）。这是"环挡光"的物理量，与环面本身的
         透明度无关，所以保持接近 1。 */
  var RING_ALPHA_SATURN = 0.42
  var RING_SHADOW_SATURN = 0.94

  /* ================= 场景与放置 ================= */
  var placed = []      // 远景天体：屏幕锚定的合成排布
  var placedMoons = []

  function placeBodies () {
    placed = []
    /* 默认不放置远景行星（见 planetsEnabled 的说明）。placed 为空时，
       后面的绘制循环、土星环绘制、排布断言都自然退化，不需要别处特判。 */
    if (!planetsEnabled()) return
    var n = scene.farBodies.length
    /* 带内间距 ∝ √(真实黄经间隔)：真实次序完整保留，同时把真实黄经里
       挤成一团的几对（水/金/地/火，以及天王星/海王星）拉开到能分辨。
       下限 0.5 是实测值：0.35 时天王星与海王星的中心距只剩约 20px，
       两颗 12~17px 的圆面会糊成一个"双黄蛋"（见 tools/report-bodies.js
       的 overlap 断言）。
       这是"合成"的显式部分 —— 真实离角下水/金/地/火永远在太阳 ±11.5° 内，
       不可能同框（见 space-system.js 文件头）。 */
    var w = []
    for (var i = 0; i < n; i++) {
      var gap = i === 0 ? 0 : Math.abs(scene.farBodies[i].realDeltaLonDeg - scene.farBodies[i - 1].realDeltaLonDeg)
      w.push(i === 0 ? 0 : Math.max(0.5, Math.sqrt(gap / 30)))
    }
    var sum = 0
    for (var j = 1; j < n; j++) sum += w[j]
    for (var k = 0; k < n; k++) {
      var t = 0
      for (var m = 1; m <= k; m++) t += w[m]
      t = sum > 0 ? t / sum : (n > 1 ? k / (n - 1) : 0.5)
      var fb = scene.farBodies[k]
      /* 屏幕落点取自 CSS 给的二次贝塞尔（bandA/bandM/bandB），不是直线插值 */
      var sp = bandPoint(t)
      var sx = sp.x
      var sy = sp.y
      var dir = rayFromScreen(sx, sy)
      var dist = fb.distRj
      var pos = [camPos[0] + dir[0] * dist, camPos[1] + dir[1] * dist, camPos[2] + dir[2] * dist]
      /* 半径由目标视直径反解，然后投影实测一次做校正（离轴透视下
         "角度→像素"不是严格线性，所以用测量值收敛）。 */
      var radius = Math.tan((fb.targetPx * bodyScale / 2) / pxPerWorldAt(-dist)) * dist
      for (var it = 0; it < 3; it++) {
        var p1 = projectToPx([pos[0], pos[1] + radius, pos[2]])
        var p2 = projectToPx([pos[0], pos[1] - radius, pos[2]])
        if (!p1 || !p2) break
        var px = Math.abs(p1[1] - p2[1])
        if (px < 0.2) break
        radius *= (fb.targetPx * bodyScale) / px
      }
      placed.push({ body: fb, pos: pos, dir: dir, dist: dist, radius: radius, screen: [sx, sy], t: t })
    }
  }
  /* 卫星：完全用真实轨道（圆轨道、共面、真实周期），因此凌木/掩食/影凌
     都是几何的自然结果，不需要任何特判。 */
  function placeMoons (tSim) {
    placedMoons = []
    var pl = scene.moonsPlane
    for (var i = 0; i < scene.moons.length; i++) {
      var mn = scene.moons[i]
      var th = SS.moonPhase(mn, tSim)
      var x = Math.cos(th) * mn.aRj
      var y = Math.sin(th) * mn.aRj
      var pos = [
        pl.e1[0] * x + pl.e2[0] * y,
        pl.e1[1] * x + pl.e2[1] * y,
        pl.e1[2] * x + pl.e2[2] * y
      ]
      var spin = mn.rotationHours !== 0 ? (tSim / (mn.rotationHours * 3600)) * Math.PI * 2 : 0
      placedMoons.push({ body: mn, pos: pos, radius: mn.radiusRj, spin: spin, fake: !!mn.fake })
    }
  }

  /* ================= 合成卫星（"假卫星"）=================
     [为什么需要它 —— 这是几何上的必然，不是偷懒]
     要让一颗卫星**出现在木星盘面前方**，它到木星心的距离必须满足：
        横向偏移 < (d_cam − z) · R/d_cam,  z > 0
     代入相机距离 12.2 R_J 解得 a < 1.39 R_J。而四颗伽利略卫星最近的 Io 也在
     5.90 R_J —— 相差 4.2 倍。所以"在盘面正前方"这颗只可能是合成的：
     真实卫星在盘面内的**投影**（凌木）确实存在，但那是"从相机看过去落到盘中"，
     横向偏移 6.3 R_J 远大于球半径，屏幕位置永远在盘外（实测仰角 6° 时 Io 的
     轨道离视线 7.85°、盘面角半径仅 4.70°；即使把仰角压到 2° 也还差 6px 贴不到边）。

     因此这里显式声明一颗**虚构天体**，参数可调，**默认开启**（?fake=0 关闭）：
       ?fake=1            开启，使用默认参数
       ?fake=a,phase,rad  直接给轨道半径(R_J)、相位(0~1)、屏幕半径(R_J，仅视觉)
     它走的是与真实卫星完全相同的渲染路径（同一着色器、同一太阳方向、真实相位），
     所以光照与质感一致；不同之处只有轨道半径与半径是给定的，且**画在木星之后**
     （见 drawFrame 的调用顺序）—— 这正是"比木星更靠镜头"的表达。
     [默认参数怎么定的 —— 全部是实测反解，不是估的]
     在相机 12.2 R_J、太阳 133.7° 的取景下，把轨道半径 a 与相位 θ 代进屏幕投影：
       屏幕坐标 sx = x/(d−z) · d,  sy = y/(d−z) · d/f
     得到两条硬约束：① 只有 z>0 的"近侧"才可能出现在盘面前方；
     ② 近侧弧段在屏幕上很短，diskR 0.5~0.9 的那一段正好压在木星**左缘**上
     （相位 0.25 时 sx≈0，diskR≈0.94；相位 0.30~0.33 时 sx≈+0.5~+1.2）。
     试过 a=1.6 / 2.6 / 3.4 / 4.0 后取 a=3.40、相位 0.25、半径 0.16 R_J：
     它落在木星左缘（diskR≈1.0），左半在亮云带上、右半压在球外深空里 ——
     这正是"更靠镜头"最好读的位置：贴着球缘才看得出前后关系，
     完全压进盘面内部反而退化成一个黑点（真实凌木就是那样，见 disqus 备注）。
     [为什么是背光的] 太阳在 −x，而轨道近侧在 +z —— 二者正交，所以**前提是**
     任何"在盘面前方"的卫星都必然背光（相位角 ~50°，我们看到的是它的暗面 +
     一条细亮边）。这不是 bug，是这个取景的必然结果；要看"被照亮的卫星挂在
     木星前"只能改相机方位角（那会动到银河走向与相位角，属于重新取景）。
     [必须如实说明] 3.40 R_J 仍在洛希极限（约 1.9 R_J 外）之外但远小于 Io 的
     5.9 R_J；0.16 R_J ≈ 11400 km，比木卫三还大。它是构图元素，不是天体物理
     结论，署名说明里已按"合成"注明。 */
  var fakeMoon = null
  var FAKE_DEFAULT = { aRj: 3.40, phase: 0.25, radiusRj: 0.16 }
  /* ?fake= 的三种取值统一在这里解析：'1'（用默认参数）、
     'a,phase,rad'（显式参数）、其它/缺失（不启用）。
     解析与"是否启用"共用同一个函数，避免两处正则写不一致 ——
     之前 fakeEnabled 与 ensureFakeMoon 各自判断一次，很容易改漏一处。 */
  function fakeParams () {
    var fq = qsv('fake')
    if (!fq) return null
    if (fq === '1') return FAKE_DEFAULT
    var arr = fq.split(',').map(parseFloat)
    if (arr.length === 3 && arr.every(isFinite)) {
      return { aRj: arr[0], phase: arr[1], radiusRj: arr[2] }
    }
    return null
  }
  function ensureFakeMoon () {
    if (fakeMoon || !scene) return fakeMoon
    var p = fakeParams()
    if (!p) return null
    fakeMoon = {
      name: 'fake',
      nameCn: '合成卫星',
      aRj: p.aRj,
      phase0: p.phase,
      periodDays: 1,          // 仅用于相位推进，值本身不影响默认定格
      radiusRj: p.radiusRj,
      albedo: 0.63,
      surfBright: 0.63,
      rotationHours: 24,
      poleRender: scene.jupiter.poleRender,
      airless: true,
      lightDir: scene.lightDir,
      fake: true,
      texKey: 'moon-ganymede'
    }
    return fakeMoon
  }
  /* **默认关闭**，只有显式 ?fake=1（或 ?fake=a,phase,rad）才出现。
     [为什么从默认开启改为默认关闭]
     它是静止的：木星在自转（自转周期 9.925h，TIME_SCALE=120 ⇒ 约 5 分钟一圈），
     而四颗真实卫星在走真实轨道也在动，唯独这颗合成卫星相位固定不动 ——
     一颗"挂在天上不动的卫星"和正在自转的木星放在一起，逻辑上就是错的。
     这是用户的原话（"木星自转卫星不动很奇怪"），而且判断是对的。
     实现与参数都保留：它记录着"为什么在盘面前方必须是合成天体"以及
     参数是如何反解的（见上面 FAKE_DEFAULT 的推导），需要时 ?fake=1 即可唤回。 */
  function fakeEnabled () {
    return !!fakeParams()
  }
  /* 七颗远景行星：**默认关闭**。
     首页按"木星系特写"构图 —— 木星 + 环 + 伽利略四卫 + 合成卫星。
     保留下来的理由：那套排布（真实黄经次序 + 真实角直径幂次压缩 + CSS 贝塞尔弧）
     本身是通的，`?planets=1` 可以随时把"太阳系全家福"切回来对照，
     不必删代码再重写一遍。切回来时排布断言（无重叠/无出界/无压球）仍然有效。 */
  function planetsEnabled () {
    return qsv('planets') === '1'
  }
  function placeFakeMoon () {
    var fm = ensureFakeMoon()
    if (!fm) return
    var pl = scene.moonsPlane
    var th = fm.phase0 * Math.PI * 2
    var x = Math.cos(th) * fm.aRj
    var y = Math.sin(th) * fm.aRj
    placedMoons.push({
      body: fm,
      pos: [pl.e1[0] * x + pl.e2[0] * y, pl.e1[1] * x + pl.e2[1] * y, pl.e1[2] * x + pl.e2[2] * y],
      radius: fm.radiusRj,
      spin: 0,
      fake: true
    })
  }

  /* ================= 模型矩阵 ================= */
  var IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  /* 以 pole 为局部 +Y 轴、绕极轴自转 spin、再按 (r, r·flatten, r) 缩放、
     最后平移 p。返回 { m: mat4, rot: mat3 }（rot 不含扁率缩放，供法线用）。 */
  function bodyMatrix (p, pole, spin, r, flatten) {
    var y = pole
    var ref = Math.abs(y[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    var x = [ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]]
    x = SS.vec.norm(x)
    var z = SS.vec.cross(x, y)
    var cs = Math.cos(spin), sn = Math.sin(spin)
    var xr = [x[0] * cs + z[0] * sn, x[1] * cs + z[1] * sn, x[2] * cs + z[2] * sn]
    var zr = [z[0] * cs - x[0] * sn, z[1] * cs - x[1] * sn, z[2] * cs - x[2] * sn]
    var m = new Float32Array(16)
    m[0] = xr[0] * r; m[1] = xr[1] * r; m[2] = xr[2] * r; m[3] = 0
    m[4] = y[0] * r * flatten; m[5] = y[1] * r * flatten; m[6] = y[2] * r * flatten; m[7] = 0
    m[8] = zr[0] * r; m[9] = zr[1] * r; m[10] = zr[2] * r; m[11] = 0
    m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1
    var rot = new Float32Array([xr[0], xr[1], xr[2], y[0], y[1], y[2], zr[0], zr[1], zr[2]])
    return { m: m, rot: rot }
  }
  /* 环的模型矩阵：局部 XZ 平面 = 环面，法线 = pole */
  function ringMatrix (p, pole, r) {
    var y = pole
    var ref = Math.abs(y[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    var x = SS.vec.norm([ref[1] * y[2] - ref[2] * y[1], ref[2] * y[0] - ref[0] * y[2], ref[0] * y[1] - ref[1] * y[0]])
    var z = SS.vec.cross(x, y)
    var m = new Float32Array(16)
    m[0] = x[0] * r; m[1] = x[1] * r; m[2] = x[2] * r; m[3] = 0
    m[4] = y[0] * r; m[5] = y[1] * r; m[6] = y[2] * r; m[7] = 0
    m[8] = z[0] * r; m[9] = z[1] * r; m[10] = z[2] * r; m[11] = 0
    m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; m[15] = 1
    return m
  }

  /* 大气/材质参数：按天体类型给，来源写在注释里 */
  var MAT = {
    mercury: { atmo: [0.32, 0.31, 0.30], rim: 0.05, rimPow: 2.6, term: 0.08, limb: 0.30, opp: 0.55 },
    venus: { atmo: [0.98, 0.93, 0.74], rim: 0.16, rimPow: 2.2, term: 0.22, limb: 0.24, opp: 0.10 },
    earth: { atmo: [0.34, 0.55, 1.0], rim: 0.22, rimPow: 2.6, term: 0.22, limb: 0.20, opp: 0.05 },
    mars: { atmo: [0.86, 0.68, 0.55], rim: 0.07, rimPow: 2.6, term: 0.10, limb: 0.30, opp: 0.45 },
    jupiter: { atmo: [0.82, 0.64, 0.44], rim: 0.10, rimPow: 1.8, term: 0.20, limb: 0.20, opp: 0.02 },
    saturn: { atmo: [0.93, 0.86, 0.66], rim: 0.10, rimPow: 1.9, term: 0.20, limb: 0.20, opp: 0.02 },
    uranus: { atmo: [0.52, 0.86, 0.92], rim: 0.11, rimPow: 2.1, term: 0.18, limb: 0.18, opp: 0.02 },
    neptune: { atmo: [0.42, 0.56, 1.0], rim: 0.12, rimPow: 2.1, term: 0.18, limb: 0.18, opp: 0.03 },
    io: { atmo: [0.95, 0.88, 0.62], rim: 0.04, rimPow: 2.8, term: 0.07, limb: 0.26, opp: 0.50 },
    europa: { atmo: [0.90, 0.93, 1.0], rim: 0.06, rimPow: 2.8, term: 0.06, limb: 0.24, opp: 0.60 },
    ganymede: { atmo: [0.80, 0.80, 0.82], rim: 0.04, rimPow: 2.8, term: 0.07, limb: 0.28, opp: 0.45 },
    callisto: { atmo: [0.72, 0.70, 0.68], rim: 0.03, rimPow: 2.8, term: 0.07, limb: 0.30, opp: 0.40 }
  }

  /* ================= 流星 ================= */
  var meteors = []
  var nextSpawn = 4000
  function spawnMeteor () {
    /* 起点/方向在参考系里给（相机静止，画面就是天区） */
    var sx = vw * (0.45 + Math.random() * 0.5)
    var sy = -vh * (0.05 + Math.random() * 0.3)
    var dir = rayFromScreen(sx, sy)
    var dist = 900
    var p0 = [camPos[0] + dir[0] * dist, camPos[1] + dir[1] * dist, camPos[2] + dir[2] * dist]
    var d2 = rayFromScreen(sx + vw * 0.28, sy + vh * 0.20)
    var p1 = [camPos[0] + d2[0] * dist, camPos[1] + d2[1] * dist, camPos[2] + d2[2] * dist]
    var dirv = SS.vec.norm(SS.vec.sub(p1, p0))
    meteors.push({ pos: p0, dir: dirv, len: 18 + Math.random() * 26, speed: 30 + Math.random() * 40, life: 0, ttl: 2400 })
  }

  /* ================= 绘制 ================= */
  var lastTs = 0
  /* tSim 已在文件顶部初始化（初值 = ?freeze= 的秒数，见那里的说明：
     初值不设的话，定影生效前跑过的帧数会让截图不可复现）。
     这里**不能**再 `var tSim = 0` —— var 会提升，那一行会把顶部设好的初值清零。 */
  /* 被截图端定影（__spaceGlobe.setTime）时时钟不再推进。
     与 reduced 分开：reduced 还决定"要不要起 rAF"，两者混用会让
     "只冻结时钟"做不到（冻结之后想恢复，reduced 会阻止 rAF 重启）。 */
  var frozenBy = false
  var raf = null
  var spin0 = 0
  var stats = { drawCalls: 0, stars: 0, fovDeg: 0, skyBaked: 0 }

  function drawFrame (ts) {
    var dt = lastTs ? Math.min(64, ts - lastTs) : 16
    lastTs = ts
    /* [不要在这里把 tSim 归零] 冻结时钟（prefers-reduced-motion 或探针的
       freezeTime）时应当"停住不动"，而不是"每帧回到 0" —— 归零会让冻结状态
       下永远停在初始相位（探针找"卫星何时进视口"时整整 8 个模拟日都找不到，
       因为每一帧都被重置回 t=0）。 */
    if (!reduced && !frozenBy) tSim += (dt / 1000) * scene.timeScale

    /* HDR 路径：整个场景渲进浮点离屏缓冲，最后再走一次后处理合到画布。
       直渲路径（老设备 / ?nopost=1 / 低配档）：与旧版完全一致，直接画到画布。

       [必须用 postActive() 而不是 postMode === 'hdr' —— 这里曾经整块画面全黑]
       这两个判断必须**完全一致**，否则会出现最坏的一种状态：
       场景被画进了 HDR 离屏缓冲，而收尾的合成 pass 因为 postActive() 为假而不执行
       ⇒ 画布上只有"清屏色 + 星野的一点漏光"，看起来就是木星整块变黑。
       实测就是低配模式（它设 nopost=1，而 postMode 仍是 'hdr'）：球面区域平均亮度
       7.2 / 峰值 218，而正常档同区域是 95.2 / 255。
       "只画进 FBO、从不合成到画布"这个坑本项目已经踩过两次
       （另一次是 finishFrame 被写在 drawMeteors 的 early-return 之后），
       所以这里的判据必须和 finishFrame 用同一个函数。 */
    ensurePostTargets()
    if (postActive() && postMode === 'hdr') gl.bindFramebuffer(gl.FRAMEBUFFER, msFbo || hdrFbo)
    else gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    /* ?dbg=1：把"这一帧画到哪、目标完不完整"写进控制台。
       排查"整屏全黑"时这是最有用的几个值 —— 黑屏往往是 framebuffer
       状态走错，而不是着色器写错（着色器写错会报编译失败）。 */
    if (DBG) console.log('[space] frame t=' + tSim.toFixed(1) + ' post=' + postMode +
      ' nopost=' + nopost + ' msFbo=' + (msFbo ? ('yes/' + msSamples) : 'no') +
      ' msStatus=' + (msFboStatus ? msFboStatus.toString(16) : '-') +
      ' hdrStatus=' + (hdrFboStatus ? hdrFboStatus.toString(16) : '-') +
      ' fmt=' + hdrKind + '(' + hdrExtName + ')' +
      ' bound=' + (gl.getParameter(gl.FRAMEBUFFER_BINDING) ? 'custom' : 'default') +
      ' nowStatus=' + gl.checkFramebufferStatus(gl.FRAMEBUFFER).toString(16) +
      ' err=' + gl.getError())
    gl.viewport(0, 0, Math.round(vw * dpr), Math.round(vh * dpr))
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)

    // 1) 天空（烘焙结果一次 blit；相机静止 ⇒ 每帧只此一次全屏采样）
    if (skyDirty) bakeSky()
    gl.disable(gl.DEPTH_TEST)
    gl.depthMask(false)
    gl.disable(gl.BLEND)
    gl.useProgram(blitProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, skyTex)
    gl.uniform1i(gl.getUniformLocation(blitProg, 'uTex'), 0)
    bindAttrib(blitProg, 'aPos', quadBuf, 2)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
    stats.drawCalls = 1

    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(true)
    gl.enable(gl.CULL_FACE)
    gl.cullFace(gl.BACK)

    // 2) 远景行星
    var e = tSim
    placeMoons(e)
    if (fakeEnabled()) placeFakeMoon()
    gl.useProgram(bodyProg)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uTonemapHere'), sfxTonemap())
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, 'uProj'), false, proj)
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, 'uView'), false, view)
    gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uCamPos'), new Float32Array(camPos))
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uExposure'), sfxExposure())
    gl.uniform1i(gl.getUniformLocation(bodyProg, 'uRingMap'), 1)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uDebug'), DEBUG_MODE)
    for (var i = 0; i < placed.length; i++) {
      var pl = placed[i]
      var b = pl.body
      var mat = MAT[b.name] || MAT.mercury
      var spin = SS.bodySpin({ rotationHours: b.rotationHours }, e)
        + (b.name === 'venus' || b.name === 'uranus' ? Math.PI : 0)
      var mm = bodyMatrix(pl.pos, b.poleRender, spin, pl.radius, b.flatten)
      gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, 'uModel'), false, mm.m)
      gl.uniformMatrix3fv(gl.getUniformLocation(bodyProg, 'uRot'), false, mm.rot)
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uLightDir'), new Float32Array(b.lightDir))
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uShadeView'), new Float32Array(b.shadeViewDir))
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uUseRealView'), 1)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uFlatten'), b.flatten)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uSurfBright'), b.surfBright)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uAirless'), b.airless ? 1 : 0)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uTermSoft'), mat.term)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uLimbDark'), mat.limb)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uOpposition'), mat.opp)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRimPow'), mat.rimPow)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRimStrength'), mat.rim)
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uAtmoColor'), new Float32Array(mat.atmo))
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uBodyCenter'), new Float32Array(pl.pos))
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uBodyRadius'), pl.radius)
      var hasRing = !!b.ring
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRingShadow'), hasRing ? 1 : 0)
      if (hasRing) {
        gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uRingNormal'), new Float32Array(b.poleRender))
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRingInner'), b.ring.inner)
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRingOuter'), b.ring.outer)
        gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRingOpacity'), RING_SHADOW_SATURN)
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, tex.saturnRing.tex)
      }
      gl.activeTexture(gl.TEXTURE0)
      var tk = 'moon-' + b.name
      gl.bindTexture(gl.TEXTURE_2D, (tex[b.name] || tex[tk] || tex.jupiter).tex)
      gl.uniform1i(gl.getUniformLocation(bodyProg, 'uMap'), 0)
      bindAttrib(bodyProg, 'aPos', sLo.pos, 3)
      bindAttrib(bodyProg, 'aUv', sLo.uv, 2)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sLo.idx)
      gl.drawElements(gl.TRIANGLES, sphereLo.idx.length, gl.UNSIGNED_SHORT, 0)
      stats.drawCalls++
    }

    // 3) 木星（128x72 高精度球）
    var jup = scene.jupiter
    var jm = bodyMatrix([0, 0, 0], jup.poleRender, SS.bodySpin(jup, e), 1, jup.flatten)
    gl.useProgram(jupProg)
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uTonemapHere'), sfxTonemap())
    gl.uniformMatrix4fv(gl.getUniformLocation(jupProg, 'uProj'), false, proj)
    gl.uniformMatrix4fv(gl.getUniformLocation(jupProg, 'uView'), false, view)
    gl.uniformMatrix4fv(gl.getUniformLocation(jupProg, 'uModel'), false, jm.m)
    gl.uniformMatrix3fv(gl.getUniformLocation(jupProg, 'uRot'), false, jm.rot)
    var jr = new Float32Array([jm.rot[0], jm.rot[3], jm.rot[6], jm.rot[1], jm.rot[4], jm.rot[7], jm.rot[2], jm.rot[5], jm.rot[8]])
    gl.uniformMatrix3fv(gl.getUniformLocation(jupProg, 'uRotT'), false, jr)
    gl.uniform3fv(gl.getUniformLocation(jupProg, 'uCamPos'), new Float32Array(camPos))
    gl.uniform3fv(gl.getUniformLocation(jupProg, 'uLightDir'), new Float32Array(scene.lightDir))
    gl.uniform3fv(gl.getUniformLocation(jupProg, 'uAtmoColor'), new Float32Array(MAT.jupiter.atmo))
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uTime'), ts / 1000)
    /* 差速自转的经度偏移：真实自转周期来自 space-system（9.925h），
       乘以时钟压缩比后约 5 分钟一圈；除以 2π 归一为 UV 偏移 */
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uSpin'), (e / (jup.rotationHours * 3600)) % 1)
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uFlatten'), jup.flatten)
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uSurfBright'), jup.surfBright)
    /* 体积霾参数：密度按"壳层厚度 3.5% 半径、肉眼可见的临边环"标定，
       色调取木星高层霾的暖褐（uAtmoColor 里那条偏黄的 [0.82,0.64,0.44]）。 */
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uHazeDensity'), HAZE.density)
    gl.uniform3fv(gl.getUniformLocation(jupProg, 'uHazeColor'), new Float32Array(HAZE.color))
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uHazeGain'), HAZE.gain)
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uDetailGain'), DETAIL_GAIN)
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uExposure'), sfxExposure())
    gl.uniform1f(gl.getUniformLocation(jupProg, 'uDebug'), DEBUG_MODE)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex.jupiter.tex)
    gl.uniform1i(gl.getUniformLocation(jupProg, 'uMap'), 0)
    bindAttrib(jupProg, 'aPos', sHi.pos, 3)
    bindAttrib(jupProg, 'aUv', sHi.uv, 2)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sHi.idx)
    gl.drawElements(gl.TRIANGLES, sphereHi.idx.length, gl.UNSIGNED_SHORT, 0)
    stats.drawCalls++

    // 4) 环（木星环 / 土星环）：半透明，不写深度
    gl.useProgram(ringProg)
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uTonemapHere'), sfxTonemap())
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)
    gl.uniformMatrix4fv(gl.getUniformLocation(ringProg, 'uProj'), false, proj)
    gl.uniformMatrix4fv(gl.getUniformLocation(ringProg, 'uView'), false, view)
    gl.uniform3fv(gl.getUniformLocation(ringProg, 'uCamPos'), new Float32Array(camPos))
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uExposure'), sfxExposure())
    drawRing(jup.poleRender, [0, 0, 0], 1, scene.jupiterRing.inner, scene.jupiterRing.outer, scene.jupiterRing.opacity, scene.lightDir, jupRingTex, 0.25)
    for (var q = 0; q < placed.length; q++) {
      var pb = placed[q]
      if (!pb.body.ring) continue
      drawRing(pb.body.poleRender, pb.pos, pb.radius, pb.body.ring.inner, pb.body.ring.outer, RING_ALPHA_SATURN, pb.body.lightDir, tex.saturnRing.tex, 0.9)
    }
    gl.depthMask(true)
    gl.disable(gl.BLEND)
    gl.enable(gl.CULL_FACE)

    // 5) 伽利略卫星（真实位置 ⇒ 凌木/掩食/影凌自然出现）
    gl.useProgram(bodyProg)
    for (var w2 = 0; w2 < placedMoons.length; w2++) {
      var pm = placedMoons[w2]
      var mb = pm.body
      var mmat = MAT[mb.name] || MAT.io
      var mm2 = bodyMatrix(pm.pos, mb.poleRender, pm.spin, pm.radius, 1)
      gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, 'uModel'), false, mm2.m)
      gl.uniformMatrix3fv(gl.getUniformLocation(bodyProg, 'uRot'), false, mm2.rot)
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uLightDir'), new Float32Array(mb.lightDir))
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uUseRealView'), 0)
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uBodyCenter'), new Float32Array(pm.pos))
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uBodyRadius'), pm.radius)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRingShadow'), 0)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uFlatten'), 1)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uSurfBright'), mb.surfBright)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uAirless'), 1)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uTermSoft'), mmat.term)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uLimbDark'), mmat.limb)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uOpposition'), mmat.opp)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRimPow'), mmat.rimPow)
      gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRimStrength'), mmat.rim)
      gl.uniform3fv(gl.getUniformLocation(bodyProg, 'uAtmoColor'), new Float32Array(mmat.atmo))
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex[mb.texKey || ('moon-' + mb.name)].tex)
      gl.uniform1i(gl.getUniformLocation(bodyProg, 'uMap'), 0)
      bindAttrib(bodyProg, 'aPos', sLo.pos, 3)
      bindAttrib(bodyProg, 'aUv', sLo.uv, 2)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sLo.idx)
      gl.drawElements(gl.TRIANGLES, sphereLo.idx.length, gl.UNSIGNED_SHORT, 0)
      stats.drawCalls++
      // 卫星投在木星云顶的影子（真实投影，凌木时才可见）
      drawMoonShadow(pm, mb)
    }

    // 6) 流星（画在远景之后 ⇒ 被行星正确遮挡）
    if (!reduced) drawMeteors(dt)

    stats.fovDeg = fovDeg
    stats.stars = stars ? stars.count : 0
    /* [必须在 drawFrame 末尾、且**无条件**调用]
       这里曾经出过一个很隐蔽的 bug：finishFrame() 被写进了 drawMeteors()
       里、且在 `if (!n) return` 之后 —— 于是"画面上没有流星"时后处理合成
       整段被跳过，场景只画进 HDR 帧缓冲、永远没有 blit 到画布上。
       表现是整块画布全黑（页面 UI 正常、控制台无报错、bodyReport/贴图状态
       全都正常），而且**只在没有流星时发作**：prefers-reduced-motion 下
       drawMeteors 根本不调用 ⇒ 画布必黑。无头截图正是这个偏好，
       所以一度被误判成"截图通道的问题"。 */
    finishFrame()
  }

  /* 诊断模式（见着色器里的 uDebug）：0=正常 1=贴图原色 2=N·L 3=法线 */

  function drawRing (pole, center, radius, inner, outer, opacity, lightDir, texId, forward) {
    var m = ringMatrix(center, pole, radius)
    gl.uniformMatrix4fv(gl.getUniformLocation(ringProg, 'uModel'), false, m)
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uInner'), inner * radius)
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uOuter'), outer * radius)
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uOpacity'), opacity)
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uForward'), forward)
    gl.uniform3fv(gl.getUniformLocation(ringProg, 'uLightDir'), new Float32Array(lightDir))
    gl.uniform3fv(gl.getUniformLocation(ringProg, 'uBodyCenter'), new Float32Array(center))
    gl.uniform3fv(gl.getUniformLocation(ringProg, 'uRingNormal'), new Float32Array(pole))
    gl.uniform1f(gl.getUniformLocation(ringProg, 'uBodyRadius'), radius)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, texId)
    gl.uniform1i(gl.getUniformLocation(ringProg, 'uRing'), 0)
    bindAttrib(ringProg, 'aT', rGeo.t, 1)
    bindAttrib(ringProg, 'aAng', rGeo.ang, 1)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, rGeo.idx)
    gl.drawElements(gl.TRIANGLES, ringGeo.idx.length, gl.UNSIGNED_SHORT, 0)
    stats.drawCalls++
  }

  /* 卫星影子落到木星云顶：把影子当作一个贴在球面上的小暗斑画出来
     （真实几何求交：卫星位置 + 太阳方向 → 木星球面交点）。
     只有卫星位于太阳与木星之间时才有交点，因此"影凌"是自然发生的。 */
  function drawMoonShadow (pm, mb) {
    var L = scene.lightDir
    var t = -SS.vec.dot(pm.pos, L)
    if (t <= 0) return
    var hit = [pm.pos[0] + L[0] * t, pm.pos[1] + L[1] * t, pm.pos[2] + L[2] * t]
    var rho = SS.vec.len(hit)
    if (rho > 1.0) return          // 影子没落在球面上
    // 影子半径 ≈ 卫星半径（本影比卫星略小，取 0.75 作真实本影的近似）
    var rShadow = pm.radius * 0.75
    var n = SS.vec.norm(hit)
    var mm = bodyMatrix([0, 0, 0], n, 0, rShadow, 1)
    gl.useProgram(bodyProg)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA)
    gl.depthMask(false)
    gl.uniformMatrix4fv(gl.getUniformLocation(bodyProg, 'uModel'), false, mm.m)
    gl.uniformMatrix3fv(gl.getUniformLocation(bodyProg, 'uRot'), false, mm.rot)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uSurfBright'), 0.0)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uUseRealView'), 0)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uAirless'), 1)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uRingShadow'), 0)
    gl.uniform1f(gl.getUniformLocation(bodyProg, 'uTermSoft'), 0.5)
    gl.uniform3f(gl.getUniformLocation(bodyProg, 'uLightDir'), L[0], L[1], L[2])
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, tex.jupiter.tex)
    bindAttrib(bodyProg, 'aPos', sLo.pos, 3)
    bindAttrib(bodyProg, 'aUv', sLo.uv, 2)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sLo.idx)
    gl.drawElements(gl.TRIANGLES, sphereLo.idx.length, gl.UNSIGNED_SHORT, 0)
    gl.depthMask(true)
    gl.disable(gl.BLEND)
    stats.drawCalls++
  }

  function drawMeteors (dt) {
    nextSpawn -= dt
    /* 频率刻意很低（旧版 0.9~3.4s 一颗、同屏 3 颗）：这是深空照片的背景
       元素，太密会喧宾夺主，也不符合"偶发宇宙线/尘埃划过"的观感。 */
    if (nextSpawn <= 0) {
      if (meteors.length < 2) spawnMeteor()
      nextSpawn = 6000 + Math.random() * 12000
    }
    var n = 0
    for (var i = meteors.length - 1; i >= 0; i--) {
      var m = meteors[i]
      m.life += dt
      var adv = (m.speed * dt) / 1000
      m.pos = [m.pos[0] + m.dir[0] * adv, m.pos[1] + m.dir[1] * adv, m.pos[2] + m.dir[2] * adv]
      if (m.life > m.ttl || n >= 2) { if (m.life > m.ttl) meteors.splice(i, 1); continue }
      var head = m.pos
      var tail = [head[0] - m.dir[0] * m.len, head[1] - m.dir[1] * m.len, head[2] - m.dir[2] * m.len]
      /* 面向相机的带子：宽度方向 = 视线 × 流星方向（真实三维几何，
         因此它会随透视正确变细、并被行星遮挡） */
      var toCam = SS.vec.norm(SS.vec.sub(camPos, head))
      var side = SS.vec.cross(toCam, m.dir)
      if (SS.vec.len(side) < 1e-4) continue
      side = SS.vec.norm(side)
      var w = m.width
      var quadV = [
        [head[0] - side[0] * w, head[1] - side[1] * w, head[2] - side[2] * w, 0],
        [tail[0] - side[0] * w, tail[1] - side[1] * w, tail[2] - side[2] * w, 1],
        [tail[0] + side[0] * w, tail[1] + side[1] * w, tail[2] + side[2] * w, 1],
        [head[0] - side[0] * w, head[1] - side[1] * w, head[2] - side[2] * w, 0],
        [tail[0] + side[0] * w, tail[1] + side[1] * w, tail[2] + side[2] * w, 1],
        [head[0] + side[0] * w, head[1] + side[1] * w, head[2] + side[2] * w, 0]
      ]
      for (var k = 0; k < 6; k++) {
        var o = (n * 6 + k) * 4
        meteorData[o] = quadV[k][0]; meteorData[o + 1] = quadV[k][1]
        meteorData[o + 2] = quadV[k][2]; meteorData[o + 3] = quadV[k][3]
      }
      n++
    }
    if (!n) return
    gl.useProgram(meteorProg)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.depthMask(false)
    gl.disable(gl.CULL_FACE)
    gl.uniformMatrix4fv(gl.getUniformLocation(meteorProg, 'uProj'), false, proj)
    gl.uniformMatrix4fv(gl.getUniformLocation(meteorProg, 'uView'), false, view)
    gl.bindBuffer(gl.ARRAY_BUFFER, meteorBuf)
    gl.bufferData(gl.ARRAY_BUFFER, meteorData.subarray(0, n * 24), gl.DYNAMIC_DRAW)
    var lp = gl.getAttribLocation(meteorProg, 'aPos')
    gl.enableVertexAttribArray(lp)
    gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 16, 0)
    var lt = gl.getAttribLocation(meteorProg, 'aTail')
    gl.enableVertexAttribArray(lt)
    gl.vertexAttribPointer(lt, 1, gl.FLOAT, false, 16, 12)
    gl.drawArrays(gl.TRIANGLES, 0, n * 6)
    gl.depthMask(true)
  }

  /* [不要把 finishFrame 调用放回这里] 见 drawFrame 末尾的说明：
     后处理合成必须无条件执行，放在有 early-return 的函数里会让画布全黑。 */
  /* drawMeteors 之后收尾：HDR 路径就在这里做后处理并写出画布。
     放在 drawFrame 之外、由 drawFrame 末尾调用 —— 这样"场景绘制"与
     "成像"两段互不干扰，也方便用 ?nopost=1 单独关掉后处理做对照。 */
  /* 收尾后把"画布上到底有没有东西"读出来（只统计，不做 base64）。
     供 ?dbg=1 使用：黑屏类问题看这一个数就够了。 */
  function quickStats () {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    var w = canvas.width, h = canvas.height
    var buf = new Uint8Array(w * h * 4)
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    var mx = 0, sum = 0, n = 0
    for (var i = 0; i < buf.length; i += 4 * 97) {
      var l = (buf[i] + buf[i + 1] + buf[i + 2]) / 3
      sum += l; n++
      if (l > mx) mx = l
    }
    return { mean: +(sum / Math.max(1, n)).toFixed(2), max: mx, err: gl.getError() }
  }

  function finishFrame () {
    /* 后处理：先 resolve 多重采样缓冲到浮点纹理，再走 bloom 与合成 */
    if (postActive() && postProgs) {
      if (msFbo) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFbo)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, hdrFbo)
        gl.blitFramebuffer(0, 0, hdrW, hdrH, 0, 0, hdrW, hdrH, gl.COLOR_BUFFER_BIT, gl.NEAREST)
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
      }
      drawPost()
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    }
    gl.disable(gl.BLEND)
    gl.enable(gl.CULL_FACE)
    stats.drawCalls++
    /* ?dbg=1：把"画布上到底有没有东西"读出来。黑屏类问题看这一个数就够：
       mean/max 都为 0 ⇒ 这一帧没画到画布上（state 问题）；
       有值而截图是黑的 ⇒ 是截图通道的问题，不是渲染的问题。 */
    if (DBG) {
      var q = quickStats()
      console.log('[space] canvas mean=' + q.mean + ' max=' + q.max + ' err=' + q.err)
    }
  }

  /* ================= 生命周期 ================= */
  /* ?pin=WxH：把页面布局视口钉死成给定像素。
     为什么需要：无头模式下 window.innerWidth/innerHeight 与
     chrome --screenshot 输出的图片尺寸**不一致**（实测页面自报画布
     1584x749，而截图是 900 高 —— y 方向差 1.2 倍）。
     于是"页面按自己的视口算出球面位置、截图端按图片坐标去裁"这一步
     必然错位，裁出来的框大半是黑天空，亮度指标显示 0.03，
     看起来像"渲染全黑"，其实是坐标对不上。

     [为什么必须连 .space-bg 的自定义属性一起钉死 —— 这是本参数长期全黑的根因]
     只设 html/body 的 width/height 对 vw/vh **毫无影响**：vw/vh 恒定等于
     **真实视口**，而 --globe/--globe-cx/--sky-band-* 全是 vw/vh 表达式。
     于是画布被 !important 钉成 pin 尺寸、CSS 却仍按真实视口算球面，
     两者错位；再叠上 --globe = min(64vw,86vh) 这种 min() 在“宽而矮”的窗口下
     取到 vh 分支，球心直接飞出画布 ⇒ 表现为整块全黑（不是渲染坏了）。
     所以这里把所有视口相关变量都换成 pin 尺寸下的**等价值**（显式 px）。
     注意必须带 !important：桌面块的声明是无 !important 的，
     而移动端断点（max-width:768px）里的同名声明会盖过它 ——
     钉死 390x844 时球心会变成 158vw，仍然错位。 */
  function pinnedVars (pw, ph, imp) {
    var q = imp ? ' !important' : ''
    var vmin = Math.min(pw, ph) / 100
    var s = []
    var push = function (n, v) { s.push('--' + n + ':' + v + q + ';') }
    if (pw <= 768) {
      /* 与 space-scene.css 的 max-width:768px / max-width:560px 两块保持一致 */
      push('globe', (pw <= 560 ? 250 : 236) * vmin + 'px')
      push('globe-cx', 158 * pw / 100 + 'px')
      push('globe-cy', 44 * ph / 100 + 'px')
      push('sky-band-a-x', 6 * pw / 100 + 'px')
      push('sky-band-a-y', 20 * ph / 100 + 'px')
      push('sky-band-m-x', 12 * pw / 100 + 'px')
      push('sky-band-m-y', 42 * ph / 100 + 'px')
      push('sky-band-b-x', 17 * pw / 100 + 'px')
      push('sky-band-b-y', 66 * ph / 100 + 'px')
      push('sky-body-scale', 0.42)
    } else {
      push('globe', Math.min(0.64 * pw, 0.86 * ph) + 'px')
      push('globe-cx', 74 * pw / 100 + 'px')
      push('globe-cy', 63 * ph / 100 + 'px')
      push('sky-band-a-x', 4 * pw / 100 + 'px')
      push('sky-band-a-y', 26 * ph / 100 + 'px')
      push('sky-band-m-x', 16 * pw / 100 + 'px')
      push('sky-band-m-y', 16 * ph / 100 + 'px')
      push('sky-band-b-x', 30 * pw / 100 + 'px')
      push('sky-band-b-y', 20 * ph / 100 + 'px')
      push('sky-body-scale', 1)
    }
    return s.join('')
  }
  function applyPin () {
    var m = /^(\d+)x(\d+)$/.exec(qsv('pin') || '')
    if (!m) return null
    var pw = parseInt(m[1], 10), ph = parseInt(m[2], 10)
    if (!(pw > 0 && ph > 0)) return null
    var s = document.getElementById('space-pin')
    if (!s) {
      s = document.createElement('style')
      s.id = 'space-pin'
      document.head.appendChild(s)
    }
    s.textContent =
      'html,body{width:' + pw + 'px !important;height:' + ph + 'px !important;overflow:hidden !important}' +
      '.space-scene-canvas{position:fixed !important;left:0 !important;top:0 !important;' +
      'width:' + pw + 'px !important;height:' + ph + 'px !important}' +
      '.space-bg{' + pinnedVars(pw, ph, true) + '}'
    return { w: pw, h: ph }
  }

  function resize () {
    /* 钉死视口时**以钉死值为准**，不要再用 window.inner*：
       无头模式下 inner* 与实际截图像素不一致（实测页面自报 1584x749，
       截图却是 1600x900），照 inner* 算出来的球面位置与截图坐标对不上，
       裁剪就会偏掉一大截。 */
    var pin = applyPin()
    dpr = pin ? 1 : Math.min(window.devicePixelRatio || 1, 1.5)
    vw = pin ? pin.w : Math.max(1, Math.round(window.innerWidth))
    vh = pin ? pin.h : Math.max(1, Math.round(window.innerHeight))
    canvas.width = Math.round(vw * dpr)
    canvas.height = Math.round(vh * dpr)
    canvas.style.width = vw + 'px'
    canvas.style.height = vh + 'px'
    readLayout()
    buildProjection()
    /* ?elev= —— 相机抬离黄道面的高度角，只给排障/取景试验用（默认走 CSS/常量里的 6°）。
       为什么需要它：卫星能否"走到木星盘面前方"完全由**轨道面与视线的夹角**决定，
       而那个夹角 ≈ 相机仰角 + 木星自转轴相对黄道的 3.13°。实测仰角 6° 时
       Io 的轨道离视线 7.85°、而木星盘面角半径只有 4.70° ⇒ 四颗伽利略卫星
       永远在盘外；仰角降到 2° 时最小角偏移 4.26° < 4.70° ⇒ Io 真的凌木。 */
    var elevQ = parseFloat(qsv('elev'))
    scene = SS.build({ globePx: globePx, camElevDeg: isFinite(elevQ) ? elevQ : undefined })
    placeBodies()
    placeMoons(tSim)
    if (stars) { stars = SS.parseStarCatalog(starsRaw, scene); buildStarBuffer() }
    skyDirty = true
    bakeSky()
    if (reduced) { drawFrame(performance.now()) }
  }

  var starsRaw = null
  function stopLoop () { if (raf != null) { cancelAnimationFrame(raf); raf = null } }
  function start () { if (!raf && !reduced) { lastTs = 0; raf = requestAnimationFrame(function loop (t) { raf = requestAnimationFrame(loop); gpuPoll(); drawFrame(t); gpuSubmit() }) } }
  /* ?freeze=<秒>：等场景就绪后把时钟钉在该时刻（只做一次）。
     为什么冻结要放回页面里做：无头 Chrome 下**读不到画布像素**
     （readPixels / toDataURL / preserveDrawingBuffer 全是黑的，实测三个
     缓冲都读回 0），能用的只有 chrome 自己 --screenshot 的合成结果。
     所以时序必须由页面自己掌握：轮到"贴图 + 星表都就绪"时再定影，
     Chrome 截图得到的就一定是定影后的那一帧。

     [为什么现在要停 rAF —— 旧注释说"不要停"，但那个前提已经不成立]
     旧版停 rAF 后截图全黑，于是被归因成"停帧后合成器丢弃了 GPU 帧"，
     改成"循环继续跑、每帧回到同一时刻"。**真正的原因是另一个 bug**：
     finishFrame()（HDR → 画布的合成）当时被写在 drawMeteors() 内部、
     且在它的 `if (!n) return` 之后 —— 没有流星时合成根本不执行；
     而循环继续跑又让"哪一帧被截图取走"变得不确定。
     本轮实测的后果：同一组参数连拍三次，木星可见面平均亮度是 52 / 123 / 61，
     而 band 位置完全一致（几何相同）⇒ 差异全在着色时序上，
     拿这种截图做"改前改后对比"等于在比噪声。

     现在的做法：定影时停掉 rAF，然后**同步自己画两帧**并写 <title>。
     finishFrame 已修好（无条件调用），所以这一帧一定被合成到画布；
     画两帧是因为部分驱动会丢弃"最后一次绘制"，两帧内容完全相同、不影响确定性。 */
  var frozen = false
  function freezeNow () {
    frozenBy = true
    stopLoop()
    /* lastTs = 0 让这一帧的 dt 固定为 16ms：否则 dt 取决于"定影发生在第几帧"，
       而 nextSpawn 每帧减去 dt —— 流星的位置会随加载耗时漂移，正是本轮
       想消灭的那种不确定性。dt 固定后，同一 URL 的两次运行渲染完全一致。 */
    lastTs = 0
    drawFrame(performance.now())
    lastTs = 0
    drawFrame(performance.now())
    if (DBG) {
      var q0 = quickStats()
      console.log('[space] 定影帧 canvas mean=' + q0.mean + ' max=' + q0.max)
    }
  }
  function tryFreeze () {
    if (frozen || !freezeAt) return
    if (!(tex.jupiter && tex.jupiter.ready) || starState === 'idle') return
    frozen = true
    tSim = freezeAt
    freezeNow()
    console.log('[space] 已定影 t=' + freezeAt + 's（?freeze= 参数，rAF 已停、同步重画）')
    /* 把球面几何写进 <title>：截图端用 --dump-dom 读它，于是验证脚本
       可以按坐标精确裁剪，不必在整页截图里猜"球在哪"。
       用 title 而不是别的地方，是因为 --dump-dom 一定会带上它。 */
    try {
      var d = window.__spaceGlobe && window.__spaceGlobe.sceneDump
      if (d) {
        var rect = window.__spaceGlobe.sceneDump().globeRect
        document.title = 'GLODERECT:' + JSON.stringify({
          globeRect: rect,
          canvas: { w: canvas.width, h: canvas.height },
          dpr: dpr,
          viewport: [vw, vh]
        })
      }
    } catch (e) { /* 元数据失败不影响画面 */ }
  }

  resize()
  loadStars()

  window.addEventListener('resize', function () {
    clearTimeout(resize._t)
    resize._t = setTimeout(resize, 180)
  }, { passive: true })
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else start()
  })
  /* 定影检查挂在 rAF 循环里（每帧一次，开销可忽略），
     这样"贴图齐了没"由页面自己在最合适的时刻判断。 */
  ;(function waitFreeze () {
    tryFreeze()
    if (!frozen) requestAnimationFrame(waitFreeze)
  })()
  start()
  if (reduced) drawFrame(performance.now())
  if (perfForceSample) {
    /* 显式请求采样时给自己开一条渲染循环：无头/减动效环境下 start() 不会启动，
       不这么做采样永远是 0（见 perfLoop 的注释）。 */
    window.__spaceGlobe.perfLoop()
  }

  /* ================= GPU 计时（性能模式的判据） =================
     [为什么用 EXT_disjoint_timer_query_webgl2 而不是帧率]
     帧率会被 vsync 钉在 60（或 120），一台"刚好卡"的机器和一台"很吃力"的机器
     读数一样；而 GPU 时间直接给出"这一帧花了多少毫秒"，是可比较的量。
     本机实测该扩展可用；拿不到（老驱动/WebGL1）时由 space-mode.js 回退到
     帧间隔判据，并在 perfMode() 的 detectedBy 里如实标出来。
     [扩展本身在上下文就绪时就取了，见文件开头的 initTiming] */
  /* 判据来源初值：与 PERF 的来源保持一致（URL / 存储 / 空=待 space-mode 判定） */
  var perfDetectedBy = perfFrom
  var perfSamples = (function () {
    var q = parseInt(qsv('perfsamples'), 10)
    return isFinite(q) && q > 0 ? Math.min(240, q) : 32
  })()
  /* ?perfsamples= 是显式请求采样（CI/排障用），此时即使 reduced 也要采：
     否则无头环境只能验到帧间隔那条回退路径，"GPU 计时到底接没接上"永远验不了。 */
  var perfForceSample = isFinite(parseInt(qsv('perfsamples'), 10))

  /* 计时用"提交一个已经结束的空查询"包住这一帧：beginQuery/endQuery 之间
     不必改 drawFrame 的内部结构，代价只有一次 query 的分配与回收。 */
  function gpuSubmit () {
    if (!timingExt || gpuSamples.length >= perfSamples) return
    var q = gl.createQuery()
    gl.beginQuery(timingExt.TIME_ELAPSED_EXT, q)
    gl.endQuery(timingExt.TIME_ELAPSED_EXT)
    queryPool.push(q)
  }
  /* [为什么采样要自己起一个循环，而不是挂在 start() 的 rAF 上]
     start() 在 prefers-reduced-motion 下**根本不启动**（`if (!raf && !reduced)`），
     而无头 Chrome 正是这个偏好 —— 于是采样永远是 0，判据静默退化成帧间隔，
     表现是"检测功能看起来能用、其实从没量过 GPU"。实测就是这么撞上的。
     所以采样循环独立：只要场景还能画就采，不受 reduced / frozen 影响。 */
  /* 在 rAF 回调里回收上一帧的结果（此时 GPU 已完成，不会阻塞管线）。
     [为什么必须回收] 查询结果不取走就会一直占着，而且同一个 EXT 的查询
     数量有限；不回收的写法会让后续 getQueryParameter 永远返回
     QUERY_RESULT_AVAILABLE=false，表现为"采样数一直是 0"。 */
  function gpuPoll () {
    if (!timingExt || !queryPool.length) return
    var disjoint = gl.getParameter(timingExt.GPU_DISJOINT_EXT)
    for (var i = queryPool.length - 1; i >= 0; i--) {
      var q = queryPool[i]
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue
      var ns = gl.getQueryParameter(q, gl.QUERY_RESULT)
      gl.deleteQuery(q)
      queryPool.splice(i, 1)
      /* disjoint = 期间 GPU 被抢占/切换，这一帧的数不可信，丢掉 */
      if (disjoint) continue
      if (ns > 0 && gpuSamples.length < perfSamples) gpuSamples.push(ns / 1e6)
    }
  }
  function median (arr) {
    if (!arr.length) return null
    var a = arr.slice().sort(function (x, y) { return x - y })
    var m = Math.floor(a.length / 2)
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
  }
  function pct (arr, p) {
    if (!arr.length) return null
    var a = arr.slice().sort(function (x, y) { return x - y })
    return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))]
  }
  function gpuStats () {
    if (!gpuSamples.length) return null
    return {
      samples: gpuSamples.length,
      medianMs: +median(gpuSamples).toFixed(2),
      p75Ms: +pct(gpuSamples, 0.75).toFixed(2),
      maxMs: +pct(gpuSamples, 1).toFixed(2)
    }
  }

  /* ================= 调试接口 ================= */
  window.__spaceGlobe = {
    get ready () { return !!(tex.jupiter && tex.jupiter.ready) },
    /* "能出图"= 木星贴图已就绪 + 星表已定局（ok 或 dead 都算定局）。
       截图端等它，不用猜虚拟时间（见文件头与 tools/shoot-scene.js）。 */
    get frameReady () { return !!(tex.jupiter && tex.jupiter.ready) && starState !== 'idle' },
    get starState () { return starState },
    get readyCount () { return loaded + '/' + total },
    get rafActive () { return !!raf },
    get stats () { return stats },
    /* 定影：把时钟钉在 atSim 秒并连画 n 帧。
       用**独立于 reduced 的**定影标志冻结时钟，而不是复用 reduced ——
       reduced 还管着"要不要起 rAF"，两者混在一起会让调用方无法只冻结时钟。
       连画两帧的理由：第一帧可能仍是上一帧的呈现，第二帧才是确定像素。 */
    setTime: function (atSim, frames) {
      tSim = isFinite(atSim) ? atSim : tSim
      frozenBy = true
      stop()
      var n = Math.max(1, frames || 2)
      for (var i = 0; i < n; i++) drawFrame(performance.now())
      return tSim
    },
    resume: function () { frozenBy = false; if (!reduced) start(); return true },
    /* ============ 交叉淡化循环的**帧序列**导出 ============
       与 recordLoop 的区别：不碰 MediaRecorder（本项目所在的环境里它不吐帧，
       见 tools/make-loop.js 文件头的诊断），而是把每一帧的 PNG 原样交给
       调用方，由 Node 落盘、再交给外部编码器（ffmpeg）编码。

       为什么帧序列这条路更可靠：
         · 没有编码器参与 ⇒ 不依赖浏览器的媒体栈；
         · 帧是**逐帧精确定影**的 ⇒ 不会有实时录制的掉帧/时序抖动；
         · 循环的收缝（尾段与首帧 alpha 混合）仍在页面里做，
           因为只有这里才拿得到"首帧的像素"。

       参数: { seconds, fps, width, height, crossfadeSec, startSim, onFrame }
         onFrame(index, total, dataUrl) —— 可选回调（用于进度与取回数据）
       返回: Promise<{ frames, fps, width, height, crossfadeFrames }>
         帧的 PNG 数据在 onFrame 里给出。 */
    recordFrames: function (opts) {
      opts = opts || {}
      var seconds = opts.seconds || 12
      var fps = opts.fps || 30
      var outW = opts.width || 1280
      var outH = opts.height || 720
      var xfade = Math.round((opts.crossfadeSec || 0.6) * fps)
      var startSim = opts.startSim == null ? tSim : opts.startSim
      var total = Math.round(seconds * fps)
      var dtSim = seconds * scene.timeScale / total

      var out = document.createElement('canvas')
      out.width = outW; out.height = outH
      var octx = out.getContext('2d')

      var yieldLoop = function () {
        return new Promise(function (r) { setTimeout(r, 0) })
      }
      var firstFrame = null
      var i = 0
      var step = function () {
        if (i >= total) {
          return Promise.resolve({
            frames: total, fps: fps, width: outW, height: outH, crossfadeFrames: xfade
          })
        }
        tSim = startSim + i * dtSim
        frozenBy = true
        /* 定影后**立刻用 readPixels 读回像素**，而不是 drawImage(webglCanvas)。
           [为什么要这样]
           无头 Chrome 下 drawImage(webglCanvas) 拿到的是空内容（实测导出的
           PNG 全是同一张 1950 字节的纯黑图，且没有任何报错）；而 readPixels
           读的是当前绑定的帧缓冲，与合成器无关，且**必须在同一个任务里读**
           （跨任务缓冲已被清空）。两者在直渲路径下是等价的。
           代价：拿到的像素是上下颠倒的，落盘时要翻转（见下面的注释）；
           返回的是 RGBA，PNG 编码由调用方负责。 */
        drawFrame(performance.now())
        var w0 = canvas.width, h0 = canvas.height
        var buf = new Uint8Array(w0 * h0 * 4)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.readPixels(0, 0, w0, h0, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        /* 缩放到输出尺寸：用 2D 画布做这一步最省事（把 readPixels 的结果
           放回一张 2D 画布，再 drawImage 缩放）。 */
        var raw = document.createElement('canvas')
        raw.width = w0; raw.height = h0
        var rctx = raw.getContext('2d')
        var id = rctx.createImageData(w0, h0)
        id.data.set(buf)
        rctx.putImageData(id, 0, 0)
        octx.globalAlpha = 1
        octx.clearRect(0, 0, outW, outH)
        /* 翻转：GL 的像素原点在左下，PNG 在左上 */
        octx.save()
        octx.translate(0, outH)
        octx.scale(1, -1)
        octx.drawImage(raw, 0, 0, outW, outH)
        octx.restore()
        if (i === 0) {
          var fc = document.createElement('canvas')
          fc.width = outW; fc.height = outH
          fc.getContext('2d').drawImage(out, 0, 0, outW, outH)
          firstFrame = fc
        } else if (xfade > 0 && i >= total - xfade) {
          /* 尾段与首帧交叉淡化：播放器循环回开头时最后一帧已与第一帧重合 */
          var k = (i - (total - xfade)) / xfade
          octx.globalAlpha = 1 - k
          octx.drawImage(firstFrame, 0, 0)
          octx.globalAlpha = 1
        }
        var idx = i
        var url = out.toDataURL('image/png')
        /* 首帧自检：把 2D 画布的一小块读回来，统计非零采样占比。
           这个数是 0 就说明 drawImage(webglCanvas) 拿到的是空内容 ——
           即"导出帧全黑"，而且不会有任何报错。
           （无头 Chrome 下就是这种情况：默认帧缓冲在合成后被清空，
           toDataURL / readPixels / drawImage 三条路都读不到 WebGL 画面。
           解决方式是给上下文加 preserveDrawingBuffer=true，见 ?preserve=1。） */
        if (i === 0) {
          try {
            var probe = document.createElement('canvas')
            probe.width = 64; probe.height = 64
            var pctx = probe.getContext('2d')
            pctx.drawImage(out, 0, 0, 64, 64)
            var pd = pctx.getImageData(0, 0, 64, 64).data
            var nz = 0
            for (var q = 0; q < pd.length; q += 4) if (pd[q] + pd[q + 1] + pd[q + 2] > 20) nz++
            var frac = nz / 4096
            console.log('[space] 导出首帧非零占比 = ' + (frac * 100).toFixed(1) + '%')
            if (frac < 0.02) {
              console.warn('[space] 导出帧疑似全黑：drawImage 从 WebGL 画布上读到空内容。' +
                '请给页面加 ?preserve=1（preserveDrawingBuffer=true）后重试。')
            }
          } catch (e) { console.warn('[space] 首帧自检失败: ' + e.message) }
        }
        if (opts.onFrame) opts.onFrame(idx, total, url)
        i++
        return yieldLoop().then(step)
      }
      return yieldLoop().then(step)
    },
    /* ============ 交叉淡化循环录制（MediaRecorder 版） ============
       把"离线渲染 + 页面播视频"这条候选路线落到一个能看的实物上。
       ⚠️ 本机（Windows 无头 Chrome）的 MediaRecorder 不产出帧，
       详细诊断见 tools/make-loop.js 文件头；想拿视频请走
       recordFrames + 外部编码器（ffmpeg）那条路。

       [为什么必须交叉淡化]
       tools/loop-plan.js 算过：精确循环在原理上不存在 —— Callisto 的周期
       是 16.7 天（墙上 3.3 小时），而且着色器里的差速自转（赤道比高纬快
       5.5%）让云带纹理即使 uSpin 回到整数圈也不回原状。
       所以只能录一段有限时长，再把尾段与首帧做 alpha 交叉淡化收缝。

       [为什么用 captureStream(0) + requestFrame]
       MediaRecorder 默认按真实时间录：录 360 帧得等 12 秒挂钟时间，掉帧也不
       可控。把流帧率设为 0、用 requestFrame() 手动推进之后，录一帧的成本
       就等于渲染一帧的成本，与墙上时间无关 —— 这才是"离线渲染"该有的行为。

       参数: { seconds, fps, width, height, bitrateMbps, crossfadeSec, startSim }
       返回: **Promise**，resolve 为 { frames, fps, seconds, mime, bytes, url }
         （url 是 webm 的 blob URL）

       [为什么必须是异步的 + 为什么每帧要让出事件循环]
       MediaRecorder 是**编码器驱动的异步管线**：
         · 编码后的数据通过 ondataavailable 事件分块交回，stop() 之后
           还要等 onstop 才会到齐 —— 同步读 blob.size 永远是 0
           （实测第一版就是"30 帧 / 0.00 MB"）；
         · 帧是逐帧 requestFrame() 推给它的，如果一路同步推完，编码器来不及
           消费，帧会被丢弃。
       所以这里每帧 await 一次 rAF 让出主线程，并且等 onstop 再交付结果。 */
    recordLoop: function (opts) {
      opts = opts || {}
      var seconds = opts.seconds || 12
      var fps = opts.fps || 30
      var outW = opts.width || 1280
      var outH = opts.height || 720
      var bitrate = (opts.bitrateMbps || 8) * 1e6
      var xfade = Math.round((opts.crossfadeSec || 0.6) * fps)
      var startSim = opts.startSim == null ? tSim : opts.startSim
      var total = Math.round(seconds * fps)
      var dtSim = seconds * scene.timeScale / total

      if (typeof MediaRecorder === 'undefined') {
        return Promise.reject(new Error('浏览器不支持 MediaRecorder'))
      }

      var out = document.createElement('canvas')
      out.width = outW; out.height = outH
      var octx = out.getContext('2d')
      var stream = out.captureStream(0)     // 0 = 只在 requestFrame() 时出帧
      var track = stream.getVideoTracks()[0]
      var mimePref = qsv('codec') || 'auto'
      var cands = mimePref === 'auto'
        ? ['video/webm;codecs=vp8', 'video/webm;codecs=vp9',
          'video/webm;codecs=h264', 'video/webm']
        : (mimePref.indexOf('/') >= 0 ? [mimePref] : ['video/webm;codecs=' + mimePref, 'video/webm'])
      var mime = cands.filter(function (m) { return MediaRecorder.isTypeSupported(m) })[0]
      if (!mime) throw new Error('没有可用的录制格式（试过 ' + cands.join(' / ') + '）')
      var chunks = []
      var recopts = { mimeType: mime }
      /* 码率只在**显式给定**时才传：某些 headless 实现对
         videoBitsPerSecond 的处理会让编码器直接不出帧，而默认码率
         （约 2.5 Mbps）对看效果完全够。 */
      if (opts.bitrateMbps) recopts.videoBitsPerSecond = Math.round(opts.bitrateMbps * 1e6)
      var rec = new MediaRecorder(stream, recopts)
      rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data) }

      var stopped = new Promise(function (resolve) { rec.onstop = resolve })
      /* 每 200ms 强制切一个数据块：默认 MediaRecorder 只在 stop 时吐一大块，
         万一 onstop 前进程被收走就什么都拿不到；分块能更早看到数据，
         也便于判断编码器到底有没有在工作。 */
      rec.start(200)

      var firstFrame = null
      /* 让位给事件循环，用 setTimeout 而不是 requestAnimationFrame：
         rAF 依赖合成器主动刷新，在无头模式（尤其没有可见窗口时）
         可能长时间不触发 —— 实测用它会导致录制卡在第一帧、
         CDP 轮询直到超时。定时器一定会到。 */
      var yieldLoop = function () {
        return new Promise(function (r) { setTimeout(r, 0) })
      }
      /* 编码器也需要时间消费推给它的帧。实测"推一帧→立刻让位→推下一帧"
         在 Windows 无头 Chrome 上会让 VP9 编码器**一帧都不吐**
         （recorder 一直是 recording、chunks 始终为空、文件只有 110 字节的
         EBML 头）。所以每帧之后额外等一小段真实时间。
         这仍然是"离线"的：总耗时只取决于帧数×间隔，与画面时长无关。 */
      var FRAME_SETTLE_MS = isFinite(parseFloat(qsv('settle'))) ? parseFloat(qsv('settle')) : 25
      var settle = function (ms) {
        return new Promise(function (r) { setTimeout(r, ms) })
      }

      var i = 0
      var step = function () {
        if (i >= total) {
          /* **必须 stop()**，否则 ondataavailable 永远不会到齐、onstop 不会触发，
             promise 永远挂住 —— 现象是录制页一直"没结果"，且没有任何报错。
             第一版就是漏了这一行。 */
          rec.stop()
          return stopped
        }
        tSim = startSim + i * dtSim
        /* 定影并立刻把画布内容画到输出画布：两件事必须在同一个任务里完成，
           跨任务读画布会拿到被清空的缓冲（本项目踩过多次的坑）。 */
        frozenBy = true
        drawFrame(performance.now())
        octx.globalAlpha = 1
        octx.clearRect(0, 0, outW, outH)
        octx.drawImage(canvas, 0, 0, outW, outH)
        if (i === 0) {
          var fc = document.createElement('canvas')
          fc.width = outW; fc.height = outH
          fc.getContext('2d').drawImage(out, 0, 0, outW, outH)
          firstFrame = fc
        } else if (xfade > 0 && i >= total - xfade) {
          /* 尾段：把首帧按递减 alpha 叠上去。播放器循环回开头时最后一帧
             已经与第一帧重合，接缝因此不可见。 */
          var k = (i - (total - xfade)) / xfade
          octx.globalAlpha = 1 - k
          octx.drawImage(firstFrame, 0, 0)
          octx.globalAlpha = 1
        }
        track.requestFrame()
        i++
        return yieldLoop().then(function () { return settle(FRAME_SETTLE_MS) }).then(step)
      }

      return yieldLoop().then(step).then(function () {
        var blob = new Blob(chunks, { type: mime })
        console.log('[space] 循环录制完成：' + total + ' 帧 / ' + fps + 'fps / ' +
          seconds + 's，交叉淡化 ' + xfade + ' 帧，mime=' + mime +
          '，约 ' + (blob.size / 1024 / 1024).toFixed(2) + ' MB')
        if (!chunks.length) {
          throw new Error('MediaRecorder 没产出数据（mime=' + mime +
            ' state=' + rec.state + ' 轨道=' + (track ? track.readyState : 'null') + '）')
        }
        /* 把录制用的合成画布挂到页面上（离屏、但可被 chrome 截图看到）：
           排查"媒体流里没有帧"时，必须能区分"画布本来就是空的"与
           "画布有内容但流没拿到" —— 把画布放进 DOM 然后用 chrset 截图，
           一眼就能分辨。默认不挂，?recdebug=1 才挂。 */
        if (qsv('recdebug') === '1') {
          out.id = 'rec-out'
          out.style.cssText = 'position:fixed;left:0;top:0;z-index:99;border:2px solid red'
          document.body.appendChild(out)
        }
        /* 首帧的非零像素占比：0 就说明 drawImage 从 WebGL 画布上读到了空内容 */
        var probe = document.createElement('canvas')
        probe.width = 64; probe.height = 64
        var pctx = probe.getContext('2d')
        pctx.drawImage(canvas, 0, 0, 64, 64)
        var pd = pctx.getImageData(0, 0, 64, 64).data
        var nz = 0
        for (var q = 0; q < pd.length; q += 4) if (pd[q] + pd[q + 1] + pd[q + 2] > 20) nz++
        console.log('[space] 首帧非零采样占比 = ' + (nz / 4096 * 100).toFixed(1) + '%')
        return {
          frames: total, fps: fps, seconds: seconds, crossfadeFrames: xfade,
          mime: mime, bytes: blob.size, url: URL.createObjectURL(blob)
        }
      })
    },
    /* 像素级导出：定影后把绘制缓冲的像素读出来（base64 RGBA + 尺寸）。
       为什么验证截图必须走这条而不是 canvas.toDataURL()：
       实测在本机无头 Chrome 下，toDataURL() 拿到的是**已被清空的缓冲**
       （约 10 KB 的纯黑 PNG），而同一时刻 chrome 自己 --screenshot 拍出来
       是 255 KB 的正常画面。preserveDrawingBuffer 也救不回来。
       而 WebGL 的 readPixels 读的是当前绑定的帧缓冲，与合成器无关，
       读到的一定是"我们刚画的那一帧" —— 对像素比对来说这反而更权威。
       注意：调用前必须确保当前绑定的就是**默认帧缓冲**（画面像素）。 */
    readPixels: function (target) {
      /* target: 'auto'（默认，优先离屏）| 'hdr' | 'ms' | 'canvas'
         排查黑屏时要能分别读每一个缓冲，才能判断"画到哪一步没了"。 */
      var src, tw, th
      var want = target || 'auto'
      if (want === 'canvas') { src = null }
      else if (want === 'hdr') { src = hdrFbo }
      else if (want === 'ms') { src = msFbo }
      else src = (hdrTex && (postMode === 'hdr' || nopost)) ? hdrFbo : null
      if (want !== 'canvas' && !src) throw new Error('缓冲不存在: ' + want)
      gl.bindFramebuffer(gl.FRAMEBUFFER, src)
      tw = src ? hdrW : canvas.width
      th = src ? hdrH : canvas.height
      var buf = new Uint8Array(tw * th * 4)
      gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      var mx = 0, sum = 0, n = 0, lit = 0
      for (var j = 0; j < buf.length; j += 4 * 97) {
        var l = (buf[j] + buf[j + 1] + buf[j + 2]) / 3
        sum += l; n++
        if (l > 2) lit++
        if (l > mx) mx = l
      }
      var bin = ''
      var CH = 0x8000
      for (var i = 0; i < buf.length; i += CH) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, Math.min(i + CH, buf.length)))
      }
      return {
        w: tw, h: th, bytes: buf.length, b64: btoa(bin),
        source: src ? 'hdr' : 'canvas',
        hdrKind: hdrKind,
        needsTonemap: !!src && hdrKind === 'rgba16f',
        err: gl.getError(),
        mean: +(sum / Math.max(1, n)).toFixed(2), max: mx, litFrac: lit / Math.max(1, n)
      }
    },
    /* 采样统计：用于快速判断"这一帧到底画出来没有"。
       ?dbg=1 时逐帧打印，读数来自 readPixels 的同一套路径，
       所以不会出现"截图看着有、统计说是黑"这种自相矛盾。 */
    pixelStats: function () {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      var w = canvas.width, h = canvas.height
      var buf = new Uint8Array(w * h * 4)
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      var mx = 0, sum = 0, n = 0, nonZero = 0
      for (var i = 0; i < buf.length; i += 4 * 37) {
        var l = (buf[i] + buf[i + 1] + buf[i + 2]) / 3
        sum += l; n++
        if (l > 2) nonZero++
        if (l > mx) mx = l
      }
      return { mean: sum / Math.max(1, n), max: mx, litFrac: nonZero / Math.max(1, n), err: gl.getError() }
    },
    sceneDump: function () {
      return {
        fovDeg: fovDeg,
        globePx: globePx,
        /* 球面在**页面坐标**里的椭圆半径（扁率已计入）。
           验证脚本靠它精确裁出球面，不必再去图里猜哪里是球
           （猜的部分已经失败过四次：卡片、头像、标题文字、以及"整屏黑"）。
           注意这里用的是 canvas.width = vw*dpr，与页面截图同坐标系。 */
        globeRect: {
          cx: globeCx * dpr, cy: globeCy * dpr,
          rx: (globePx / 2) * dpr, ry: (globePx / 2) * SS.BODIES.jupiter.flatten * dpr
        },
        canvas: { w: canvas.width, h: canvas.height },
        dpr: dpr,
        globeCenter: [globeCx, globeCy],
        bodyScale: bodyScale,
        viewport: [vw, vh, dpr],
        camDistRj: SS.CAM_DIST_RJ,
        epoch: new Date(SS.EPOCH_MS).toISOString(),
        far: placed.map(function (p) {
          var px = projectToPx(p.pos)
          return {
            name: p.body.name, screen: px, band: p.screen, t: p.t,
            distRj: p.dist, radiusRj: p.radius,
            targetPx: p.body.targetPx * bodyScale,
            realPx: (function () {
              var a = projectToPx([p.pos[0], p.pos[1] + p.radius, p.pos[2]])
              var b = projectToPx([p.pos[0], p.pos[1] - p.radius, p.pos[2]])
              return a && b ? Math.abs(a[1] - b[1]) : null
            })(),
            realLatDeg: p.body.realLatDeg,
            realArcsec: p.body.realArcsec,
            phaseAngleDeg: Math.acos(Math.max(-1, Math.min(1, SS.vec.dot(p.body.lightDir, p.body.shadeViewDir)))) / DEG,
            surfBright: p.body.surfBright
          }
        }),
        moons: placedMoons.map(function (m) {
          var px = projectToPx(m.pos)
          return { name: m.body.name, screen: px, distRj: SS.vec.len(m.pos), radiusRj: m.radius }
        })
      }
    },
    skyDiagnostics: function () {
      var d = scene.diagnostics
      var poleEcl = SS.vec.mul3(scene.frame.R, [0, 0, 1])
      var g2r = scene.galacticFrame.R_gal2render
      var poleGal = [g2r[2], g2r[5], g2r[8]]
      return {
        eclipticGalacticAngleDeg: d.eclipticGalacticAngleDeg,
        computedAngleDeg: Math.acos(Math.max(-1, Math.min(1, SS.vec.dot(poleEcl, poleGal)))) / DEG,
        frameEclipticLonDeg: d.frameEclipticLonDeg,
        frameGalacticLatDeg: d.frameGalacticLatDeg,
        frameGalacticLonDeg: d.frameGalacticLonDeg,
        eclepticPoleScreen: projectToPx(SS.vec.add(camPos, SS.vec.scale(poleEcl, 100))),
        galacticPoleScreen: projectToPx(SS.vec.add(camPos, SS.vec.scale(poleGal, 100))),
        bandA: bandA, bandM: bandM, bandB: bandB
      }
    },
    starInfo: function () { return stars ? { count: stars.count } : null },
    /* 最亮的若干颗真实恒星及其屏幕位置：探针用它核对"真实恒星确实出现在
       真实位置"（同一份星表既喂渲染也喂断言，因此能抓出坐标链错误）。 */
    brightestStars: function (k) {
      if (!stars) return null
      k = k || 3
      var idx = []
      for (var i = 0; i < stars.count; i++) idx.push(i)
      idx.sort(function (a, b) { return stars.mag[a] - stars.mag[b] })
      var out = []
      for (var j = 0; j < Math.min(k, idx.length); j++) {
        var s = idx[j]
        var p = projectToPx([camPos[0] + stars.pos[s * 3] * 2000, camPos[1] + stars.pos[s * 3 + 1] * 2000, camPos[2] + stars.pos[s * 3 + 2] * 2000])
        out.push({ label: 'star#' + s, mag: stars.mag[s], bv: stars.bv[s], screen: p })
      }
      return out
    },
    setWarp: function (v) { scene.timeScale = v },
    freezeTime: function (v, at) { reduced = !!v; if (at != null) tSim = at; lastTs = 0; if (v) { stop() } else start() },
    /* 冻结时钟后必须能强制重画一帧，否则 tSim 改了但画面没跟上
       （探针找"卫星什么时候进视口"时就靠它逐时刻求值） */
    renderOnce: function () { drawFrame(performance.now()) },
    cameraState: function () { return { yaw: 0, pitch: 0, azDeg: scene.frame.camAzDeg, elevDeg: scene.frame.camElevDeg, phaseAngleDeg: scene.frame.phaseAngleDeg } },
    /* 每个远景天体与卫星在**画布坐标**里的圆盘信息，以及当前材质参数。
       用途：判断"哪颗太亮/太大/太小"时不必再去图里找 —— 裁切坐标我已经
       估错过好几次，直接拿数值才能和设计意图逐条对照。 */
    bodyReport: function () {
      var out = []
      function spanOf (pos, radius) {
        var a = projectToPx([pos[0], pos[1] + radius, pos[2]])
        var b = projectToPx([pos[0], pos[1] - radius, pos[2]])
        return a && b ? +(Math.abs(a[1] - b[1]) * dpr).toFixed(1) : null
      }
      for (var i = 0; i < placed.length; i++) {
        var p = placed[i]
        var mat = MAT[p.body.name] || MAT.mercury
        var px = projectToPx(p.pos)
        out.push({
          name: p.body.name, kind: 'planet',
          canvas: px ? [Math.round(px[0] * dpr), Math.round(px[1] * dpr)] : null,
          targetPx: +(p.body.targetPx * bodyScale).toFixed(1),
          drawnPx: spanOf(p.pos, p.radius),
          surfBright: +p.body.surfBright.toFixed(4),
          albedo: +p.body.albedo.toFixed(3),
          realArcsec: +p.body.realArcsec.toFixed(2),
          phaseDeg: +(Math.acos(Math.max(-1, Math.min(1, SS.vec.dot(p.body.lightDir, p.body.shadeViewDir)))) / DEG).toFixed(1),
          airless: !!p.body.airless, atmo: mat.atmo, rim: mat.rim,
          distRj: +p.dist.toFixed(2)
        })
      }
      for (var j = 0; j < placedMoons.length; j++) {
        var m = placedMoons[j]
        var mp = projectToPx(m.pos)
        out.push({
          name: m.body.name, kind: m.fake ? 'fake-moon' : 'moon',
          canvas: mp ? [Math.round(mp[0] * dpr), Math.round(mp[1] * dpr)] : null,
          drawnPx: spanOf(m.pos, m.radius),
          /* 到木星盘心的**屏幕**距离，单位 = 木星盘半径（<1 即视觉上落在盘面内）。
             用离轴投影反解：屏幕偏移比 = (x/z') / (1/camDist)，其中 z' 是该天体
             到相机的轴向距离 —— 卫星比木星靠前时 z' 更小，所以这个比值会大于
             "单纯的世界距离"，这正是"更靠镜头"在画面上的表现。 */
          diskR: +(function () {
            var dz = SS.CAM_DIST_RJ - m.pos[2]
            if (dz <= 0.05) return 99
            return (Math.hypot(m.pos[0], m.pos[1]) / dz) / (1 / SS.CAM_DIST_RJ)
          })().toFixed(2),
          zRj: +m.pos[2].toFixed(2),
          distRj: +SS.vec.len(m.pos).toFixed(2)
        })
      }
      return out
    },
    setSkyGain: function (g) { SKY_GAIN = g; skyDirty = true; bakeSky() },
    /* 光照诊断：卫星"应该被照亮却渲染成黑盘"这类问题，必须能直接读出
       传进着色器的 L 与相位角，而不是靠推导（推导错过一次：把 LS 反射
       算成 0.10 就以为够亮，实际还要过 tonemap 与曝光）。 */
    lightInfo: function () {
      if (!scene) return null
      var L = scene.lightDir
      var out = { lightDir: [+L[0].toFixed(3), +L[1].toFixed(3), +L[2].toFixed(3)],
        camDistRj: SS.CAM_DIST_RJ, exposure: MAIN_EXPOSURE, postMode: postMode, nopost: nopost }
      function probe (p, label) {
        if (!p) return null
        var n = SS.vec.norm(p)                        // 面向相机那一点的法线
        var toCam = SS.vec.norm(SS.vec.sub(camPos, p))
        var ndl = SS.vec.dot(n, L)
        var ndv = SS.vec.dot(n, toCam)
        var phase = Math.acos(Math.max(-1, Math.min(1, SS.vec.dot(L, toCam))))
        var mu0 = Math.max(ndl, 0), mu = Math.max(ndv, 0)
        return { label: label, n: n.map(function (v) { return +v.toFixed(3) }),
          NdotL_center: +ndl.toFixed(3), NdotV_center: +ndv.toFixed(3),
          phaseAngleDeg: +(phase / SS.DEG).toFixed(1),
          LS_refl: +(2 * mu0 / Math.max(1e-4, mu0 + mu)).toFixed(4) }
      }
      out.jupiter = probe([0, 0, 0], 'jupiter')
      var fm = null
      for (var i = 0; i < placedMoons.length; i++) if (placedMoons[i].fake) fm = placedMoons[i]
      if (fm) out.fakeMoon = probe(fm.pos, 'fake')
      return out
    },
    setGrain: function (g) { GRAIN_GAIN = g; skyDirty = true; bakeSky() },
    setExposure: function (e) { MAIN_EXPOSURE = e },
    /* ================= 性能模式接口（供 space-mode.js 使用） =================
       perfMode() 只报事实：当前模式、判据来源、采样数、GPU 统计、当前各项画质参数。
       "该判成哪一档"的逻辑放在 space-mode.js（它还要管 localStorage 与 UI），
       渲染器这边只负责"能读、能改、能标来源"。 */
    quality: function () {
      return {
        nopost: nopost,
        postMode: postMode,
        msaa: msSamples,
        aniso: maxAniso,
        jupiterMap: wantHi ? 'hi(3072)' : 'lo(2048)',
        bloom: BLOOM_ON ? { on: true, threshold: BLOOM.threshold, strength: BLOOM.strength } : { on: false },
        sharpen: SHARPEN.on ? (SHARPEN.amount + ':' + SHARPEN.radius) : 'off',
        exposure: MAIN_EXPOSURE,
        dpr: dpr,
        canvas: canvas ? [canvas.width, canvas.height] : null
      }
    },
    perfMode: function () {
      return {
        mode: PERF || 'auto',
        detectedBy: perfDetectedBy || (gpuSamples.length >= perfSamples ? 'gpu-timer' : 'sampling'),
        samples: gpuSamples.length,
        targetSamples: perfSamples,
        hasTimerQuery: !!timingExt,
        canSample: !reduced && !frozen,
        reducedMotion: !!reduced,
        gpu: gpuStats(),
        quality: this.quality()
      }
    },
    /* 立即切换运行时可变项（切换按钮走这里，不重载）。
       贴图档位是加载期决定的，改它必须重载 —— 由 space-mode.js 决定，
       这里只如实返回"哪些项本次没生效"。 */
    setPerfMode: function (mode, opts) {
      opts = opts || {}
      var low = mode === 'low'
      PERF = low ? 'low' : 'high'
      /* 判据来源由调用方给（'url' / 'stored' / 'gpu-timer' / 'raf' / 'heuristic' /
         'manual'）。**不要在这里无条件写成 'manual'** —— 那样 URL 与存储两条
         路径都会被标成"手动"，提示条与 perfMode() 就再也说不清"到底谁定的档"。
         实测踩过：?perf=low 报 detectedBy=manual，verify-perf-mode 直接断言失败。 */
      if (opts.by) perfDetectedBy = opts.by
      nopost = low ? 1 : 0
      BLOOM_ON = !low
      /* [曝光必须跟着一起改 —— 这里曾经漏掉，是"切低配后画面过亮"的根因]
         两条路径的曝光不是一个量纲：正常档走 HDR，曝光与色调映射都在合成 pass
         里做一次（着色器里 uExposure=1）；低配档走直渲，**每个着色器自己**
         乘 uExposure 再做 tonemap。所以低配必须用 1.1 而不是 3.3。
         MAIN_EXPOSURE 原先只在**加载时**按 ?perf= 定过一次，setPerfMode 没碰它 ——
         于是"点按钮即时切换"这条路会带着 3.3 进直渲，实测 quality().exposure
         停在 3.3（应为 1.1），画面明显过亮；而切回正常时因为会重载、
         重载后又读到 3.3，看起来"自己好了"，所以这个 bug 只在低配态可见。
         口径与加载时保持一致：两者都用同一个表达式，不写第二套数字。 */
      MAIN_EXPOSURE = isFinite(expQ) ? expQ : (low ? 1.1 : 3.3)
      /* 各向异性与贴图档位一样，是**加载期**贴在纹理对象上的，运行时改不了：
         低的档位必须重载才生效。space-mode.js 因此在两个方向上都重载
         （见那里的注释）—— 这里不假装能运行时就地生效。 */
      if (!low && msSamples < 2) msSamples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 1)
      if (low) msSamples = Math.min(2, msSamples)
      /* 采样数变了必须重建多重采样 FBO —— 不能调 resize()（它会重置 tSim、
         把画面跳回起始相位，用户点一下按钮画面就"闪一下"）。
         这里直接把已有的目标作废，下一帧的 ensurePostTargets 会用新的
         msSamples 重建（它是幂等的，尺寸未变且 msFbo 为空时会走重建分支）。 */
      if (msFbo) {
        gl.deleteFramebuffer(msFbo)
        if (msColor) gl.deleteRenderbuffer(msColor)
        if (msDepth) gl.deleteRenderbuffer(msDepth)
        msFbo = msColor = msDepth = null
      }
      POST_GAMMA = 1.0
      if (opts.reload) window.location.reload()
      return { mode: PERF, quality: this.quality(), reloaded: !!opts.reload }
    },
    /* 采样循环：见上面 perfForceSample 的说明。独立于 start()，所以
       prefers-reduced-motion 下也能拿到 GPU 时间。 */
    perfLoop: function () {
      if (perfLoopRaf != null || !timingExt) return false
      ;(function tick () {
        if (gpuSamples.length >= perfSamples) { perfLoopRaf = null; return }
        gpuPoll()
        drawFrame(performance.now())
        gpuSubmit()
        if (gpuSamples.length >= perfSamples) { perfLoopRaf = null; return }
        perfLoopRaf = requestAnimationFrame(tick)
      })()
      return true
    },
    /* 检测用的原始数据：space-mode.js 拿它套阈值，阈值不写死在渲染器里 */
    perfStats: {
      gpu: function () { return gpuStats() },
      reset: function () { gpuSamples = []; queryPool = []; return true },
      target: perfSamples,
      /* 同时存在的停用条件（见上面）：
         · reduced = 跟随系统的"减少动效"偏好：不为检测而强行开动画
         · frozen  = ?freeze= 定影状态：画面与时间都被钉死，不该再渲染
         两者都要如实回报，否则调用方会把"没测"当成"测出来很快"。 */
      canSample: function () { return !!timingExt && !reduced && !frozen },
      /* 等采样齐（或超时）。调用方拿到的是**同一批采样**的统计，
         所以"判据"和"展示给用户的数字"永远一致 —— 不会出现
         "提示说 12ms，实际按别的数判的"。 */
      waitGpu: function (timeoutMs) {
        var t0 = performance.now()
        var limit = Math.max(500, timeoutMs || 2500)
        return new Promise(function (resolve) {
          ;(function tick () {
            var done = gpuSamples.length >= perfSamples
            var timedOut = performance.now() - t0 > limit
            if (done || timedOut || reduced || frozen) { resolve(gpuStats()); return }
            requestAnimationFrame(tick)
          })()
        })
      }
    },
    setDebug: function (m) { DEBUG_MODE = m || 0; return DEBUG_MODE },
    /* 贴图上传诊断：GL 报错不会抛 JS 异常，只会让纹理停在旧内容/变成
       不完整纹理（采样得到黑色），所以必须能把状态读出来。 */
    texStatus: function () {
      var out = {}
      for (var k in tex) out[k] = { ready: !!tex[k].ready, failed: !!tex[k].failed, w: tex[k].w, h: tex[k].h, err: tex[k].glError }
      out._glError = gl.getError()
      out._maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
      out._renderer = gl.getParameter(gl.RENDERER)
      /* 抗锯齿实际状态：请求时写了 antialias:true，但浏览器可以不兑现。
         看球体轮廓的锯齿、以及 SSAA 档位是否生效，都靠这几个值。 */
      out._webgl2 = isWebGL2
      out._samples = gl.getParameter(gl.SAMPLES)
      out._aa = gl.getContextAttributes ? gl.getContextAttributes().antialias : null
      out._aniso = maxAniso
      /* 成像路径：'hdr'=走后处理（含 bloom）；'direct'=直渲画布。
         没这两个值的话，"bloom 到底生效没有"只能靠猜 —— 而两条路径在
         没有超范围高光时**输出几乎一样**（实测平均差 0.05/255），
         肉眼根本区分不出来。 */
      out._post = postMode
      out._nopost = nopost
      out._hdrKind = hdrKind
      out._msaaSamples = msSamples
      out._bloom = { threshold: BLOOM.threshold, knee: BLOOM.knee, strength: BLOOM.strength, levels: BLOOM.levels }
      out._exposure = MAIN_EXPOSURE
      return out
    }
  }
})()
