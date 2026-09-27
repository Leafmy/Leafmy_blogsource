/* ============================================================
   太阳系几何与取景核心 (space-system.js)
   ------------------------------------------------------------
   这是整个太空场景唯一的"事实来源"：位置、方向、大小、相位全部在这里
   由真实天文数据算出来，渲染器 (space-globe.js) 只负责把它画出来。
   拆成独立模块的原因：
     · 可以脱离浏览器在 Node 里跑自检（tools/verify-space-system.js），
       天文数值出错时不必靠"看截图猜"；
     · 渲染层不再出现任何硬编码坐标（旧版把四颗行星写死在
       pos:[-1.6,0.6,-1.8] 这种"离木星心 1.8 个木星半径"的地方，
       而真实距离是 6700~33000 个木星半径 —— 那等于把行星塞进木星内部）。

   === 坐标系 ===
   1) 黄道 J2000 直角坐标（右手系，x 指向春分点，z 指向黄道北极）
      —— 开普勒要素天然给在这一系里。
   2) 参考系（render）：相机在 (0,0,D) 看向 -Z、+Y 为上方，木星在原点。
      两系之间只有一个固定旋转 R（由相机基构成），因此所有天体共享
      同一个太阳方向、同一个投影、同一套深度关系。
   3) 赤道 J2000 / 银道 J2000：星空层用。恒星表是赤道坐标，ESO 银河
      照片是银道坐标，两者都必须和行星所在的黄道系严格一致 —— 否则
      "行星在黄道上、银河斜穿 60°"这件事就只是画上去的，不是算出来的。

   === 轨道要素来源与校验 ===
   要素取自 JPL SSD《Approximate Positions of the Major Planets》
   (E.M. Standish) 的 J2000 表 + 每儒略世纪变化率：
       https://ssd.jpl.nasa.gov/planets/approx_pos.html
   [为什么是手抄而不是运行时抓取] 该站在本次实施环境里连接极不稳定
   （多次超时/连接被重置），因此把已发表的表原样落在常量里，并做**内部
   校验**：L 的世纪变化率 ÷ 36525 得到平均角速度，反算周期必须等于已知
   恒星周期（水星 87.969d / 金星 224.701d / 地球 365.256d / 火星 686.980d
   / 木星 4332.59d / 土星 10759.2d / 天王星 30688.5d / 海王星 60182d）。
   这条校验能在 1e-3 相对误差内抓出抄错一位数字的问题，见
   tools/verify-space-system.js 的 `period` 检查。

   === 合成本质（必须诚实标注） ===
   在"木星圆面 = --globe ≈860px、可见纵向 ≈11°"的取景下，1px ≈ 39 角秒。
   从木星看：土星真实角直径 38″ ≈ 0.96px、地球 4.18″ ≈ 0.11px。
   所以"在木星处真实拍摄"在物理上只能是合成图：
     · 位置：真实日心黄经只决定**次序与间距权重**，离角被压缩进画面
       （真实离角下水/金/地/火永远挤在太阳 ±11.5° 内，不可能同框）；
     · 大小：按各体真实角直径做 0.55 次幂压缩（保留次序与近似比例）；
     · 相位与光照：**完全真实**，由真实太阳方向逐体计算；
     · 亮度：单一曝光 + 真实几何反照率 ⇒ 表面亮度物理正确
       （表面亮度与距离无关，所以"放大视直径"等价于换长焦，光度自洽）。
   这些常数集中在本文件顶部，改动即改取景，注释里都标了理由。
   ============================================================ */
(function (root, factory) {
  var api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.__spaceSystem = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  var DEG = Math.PI / 180
  var RAD = 180 / Math.PI
  var AS_PER_RAD = 206264.806

  /* ================= 物理常数 ================= */
  var R_J_KM = 71492                 // 木星赤道半径
  var AU_KM = 149597870.7
  var AU_IN_RJ = AU_KM / R_J_KM      // 1 AU = 2092.6 个木星半径
  var OBLIQUITY = 23.4392911 * DEG   // 黄赤交角 J2000
  var ARCSEC_PER_RAD = AS_PER_RAD

  /* 银道系 J2000：由两个已发表方向构造基（比记旋转矩阵更不容易抄错）
       NGP  北银极     RA 192.85948°  Dec +27.12825°
       GC   银心方向   RA 266.40499°  Dec -28.93617°
     由这两者可得银道面与黄道面交角 60.19°、北银极黄道纬度 +29.81°
     —— 与实测值一致，tools/verify-space-system.js 会断言这一点。 */
  var GAL = {
    ngpRa: 192.85948 * DEG,
    ngpDec: 27.12825 * DEG,
    gcRa: 266.40499 * DEG,
    gcDec: -28.93617 * DEG
  }

  /* ================= 取景常数（改动即改构图） =================
     EPOCH_MS / CAM_AZ_DEG 不是随手取的，它们是"取景条件"的解：
       条件 1  阳光必须来自画面左侧 —— 木星球心由 CSS 推到视口右侧之外，
               窄屏（移动端 --globe-cx:158vw）只露出左弧面，若阳光从右侧来
               则可见弧面正好落在暗面里（旧版注释里记过这个坑）。
               数值上要求参考系内 lightDir.x < -0.35。
       条件 2  银河要以大角度斜穿画面且不糊满整幅 —— 要求画面中心银纬
               落在 3°~26°（太接近银道面会整幅发亮，太远则画面里没有银河）。
     扫描 2024~2029 各历元 × 方位偏移 ±46° 后发现：只有 +46° 同时满足
     条件 1，而 +46° 下只有 2024 年年中的历元满足条件 2
     （2024-01-05 → 银纬 −2.0° 过亮；2025-06-15 → +36° 银河出画）。
     于是取 2024-06-15：画面中心银纬 +10.6°，银经 200.6°。
     [为什么不用"当天"做历元] 合成图本来就不是单次曝光（离角与尺度都是
     压缩的，见文件头），历元在这里的作用是"选定真实的行星方位与相位、
     并决定取景黄经"。2024 年年中也与木星贴图的来源（Hubble OPAL 2024-01
     观测）同期，两者在同一时代。 */
  var EPOCH_MS = Date.UTC(2024, 5, 15)   // 取景历元 2024-06-15T00:00Z
  var CAM_AZ_DEG = 46                    // 相机相对"太阳方向"在黄道面内的方位偏移
  var CAM_ELEV_DEG = 6                   // 相机抬离黄道面的高度角
  var CAM_DIST_RJ = 12.2                 // 相机到木星心距离（在 Europa 9.4 与 Ganymede 15.7 之间）
  var AZ_SIGN = 1                        // 方位偏移的旋向：取正使阳光落在画面左侧（可见弧面被照亮）

  var TIME_SCALE = 120                   // 模拟时钟压缩比（木星自转 ≈5 分钟一圈）
  var SIZE_BASE_PX = 64                  // 土星的目标视直径
  var SIZE_EXP = 0.55                    // 角直径 → 目标像素的幂次压缩
  var SIZE_REF_GLOBE_PX = 860            // 参考取景下木星圆面像素（对应可见纵向 ≈11°）
  var FAR_DIST_BASE_RJ = 120             // 远景天体最近距离（> Callisto 26.4，保证在所有卫星之后）
  var FAR_DIST_STEP_RJ = 40              // 按真实日心次序逐档排开

  /* ================= 天体物理参数 =================
     radiusKm / albedo 为实测值；rotationHours 为 IAU 自转周期（负 = 逆行）。
     targetPx 不写死，由真实角直径按 SIZE_EXP 规则算（见 targetPixels）。 */
  var BODIES = {
    mercury: { name: 'mercury', nameCn: '水星', radiusKm: 2439.7, albedo: 0.142, rotationHours: 1407.6, flatten: 0.999, airless: true, pole: [281.0103, 61.4155] },
    venus: { name: 'venus', nameCn: '金星', radiusKm: 6051.8, albedo: 0.689, rotationHours: -5832.5, flatten: 0.999, airless: false, pole: [272.76, 67.16] },
    earth: { name: 'earth', nameCn: '地球', radiusKm: 6371.0, albedo: 0.434, rotationHours: 23.9345, flatten: 0.9965, airless: false, pole: [0, 90] },
    mars: { name: 'mars', nameCn: '火星', radiusKm: 3389.5, albedo: 0.170, rotationHours: 24.6229, flatten: 0.994, airless: true, pole: [317.681, 52.887] },
    jupiter: { name: 'jupiter', nameCn: '木星', radiusKm: 71492, albedo: 0.538, rotationHours: 9.925, flatten: 0.935, airless: false, pole: [268.057, 64.495] },
    saturn: { name: 'saturn', nameCn: '土星', radiusKm: 60268, albedo: 0.499, rotationHours: 10.656, flatten: 0.902, airless: false, pole: [40.589, 83.537], ring: { inner: 1.11, outer: 2.32 } },
    uranus: { name: 'uranus', nameCn: '天王星', radiusKm: 25559, albedo: 0.488, rotationHours: -17.24, flatten: 0.977, airless: false, pole: [257.311, -15.175] },
    neptune: { name: 'neptune', nameCn: '海王星', radiusKm: 24764, albedo: 0.442, rotationHours: 16.11, flatten: 0.983, airless: false, pole: [299.36, 43.46] }
  }
  /* 木星环（真实分段，单位=木星半径）：halo 1.40~1.71 / main 1.72~1.81 /
     Amalthea gossamer 1.81~2.55 / Thebe gossamer 2.55~3.11。
     真实光学厚度极低，所以不透明度必须压到 0.18 量级 —— 旧版 0.62 是
     为了"看得出有环"而夸大的，与真实照片不符。 */
  var JUPITER_RING = { inner: 1.40, outer: 3.11, opacity: 0.18 }
  /* [辐照度归一 / 逐体曝光]
     物理上表面亮度 ∝ 反照率 / 日心距²。照实算的话海王星比水星暗 3 万倍，
     同一幅画面不可能同时呈现 —— 真实拍摄必须给外行星极长曝光。于是声明
     "每颗各拍一张、曝光不同，再合成进同一幅画面"（合成图本来就是这个前提），
     并把曝光曲线写成显式的一条：

        surfBright(r) = albedo · (r_木星 / r)^(2−2κ)

     指数 2−2κ 是"压缩后的真实 1/r²"：κ=1 时是严格的 1/r²（不压缩），κ=0 时
     完全不随距离变。旧版是 (r_木星/r)^0.7 ⇒ 等价于 κ=0.65，但它以【木星】
     为原点，于是在木星内侧几乎不压缩：实测金星 2.75 / 海王星 0.13 = 21:1，
     金星整盘削平成一块白斑，而海王星只剩 0.13 的灰点。

     κ=0.728 不是随手取的：它是"极差 12:1"的反解 ——
       2(1−κ)·ln(r_海 / r_水) = ln 12 ⇒ κ = 1 − ln12 / (2·ln(30.07/0.387))
     12:1 是照相机能同时容纳的量级（金星仍有轻微过曝，与真实照片一致：
     金星是全天最亮的行星，真实合影里它就是会过曝）。

     代价必须写明：κ<1 会重排**视觉星等的次序**（真实排名 金 > 木 > 土 > 火 > 水）。
     本模型下变成 金 > 地 > 水 > 土 > 火 > 天 > 海 —— 火星因为反照率只有 0.170
     掉到土星之后，水星则被抬高。相对大小、画面次序、相位仍全部来自真实数据，
     改的只是"各自曝光多久"。 */
  var IRRADIANCE_COMPRESS = 0.728
  function surfBrightOf (albedo, distAU) {
    return albedo * Math.pow(ELEMENTS.jupiter[0] / distAU, 2 - 2 * IRRADIANCE_COMPRESS)
  }

  /* 伽利略卫星：真实轨道半径/半径/周期。e、i 极小（<0.5°、<0.01）
     故取圆轨道共面 —— 位置误差 <1%，但换来"位置/相位/影子完全自洽"。
     参考面是木星赤道面（其极轴 IAU J2000：RA 268.057°、Dec 64.495°），
     而木星赤道相对黄道只差 3.13°，所以卫星连线在画面里几乎与黄道带平行
     —— 这正是真实木星照片里的样子。
     [phase0 不是随便取的] 起始相位满足真实的 Laplace 共振
     λ_Io − 3·λ_Europa + 2·λ_Ganymede = 180°（自检里有断言）。之后各卫按
     自己的真实周期演化，共振关系的缓慢漂移与真实系统的天平动同量级。 */
  var MOONS = [
    { name: 'io', nameCn: '木卫一 Io', radiusKm: 1821.6, aKm: 421700, periodDays: 1.769138, albedo: 0.63, phase0: 0.00 },
    { name: 'europa', nameCn: '木卫二 Europa', radiusKm: 1560.8, aKm: 671034, periodDays: 3.551181, albedo: 0.67, phase0: 0.62 },
    { name: 'ganymede', nameCn: '木卫三 Ganymede', radiusKm: 2634.1, aKm: 1070412, periodDays: 7.154553, albedo: 0.43, phase0: 0.18 },
    { name: 'callisto', nameCn: '木卫四 Callisto', radiusKm: 2410.3, aKm: 1882707, periodDays: 16.689018, albedo: 0.22, phase0: 0.81 }
  ]
  /* 木星赤道极轴（IAU J2000，赤道坐标，度） */
  var JUP_POLE = { ra: 268.056595, dec: 64.495303 }

  /* ================= 向量 / 矩阵 ================= */
  function sub (a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
  function add (a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]] }
  function scale (a, s) { return [a[0] * s, a[1] * s, a[2] * s] }
  function dot (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
  function cross (a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  }
  function norm (a) {
    var l = Math.sqrt(dot(a, a)) || 1
    return [a[0] / l, a[1] / l, a[2] / l]
  }
  function len (a) { return Math.sqrt(dot(a, a)) }

  /* 行主序 3x3：m[0..2] 是"参考系 x 轴在世界系里的分量"，其余类推。
     即 render = m · world。 */
  function mul3 (m, v) {
    return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
      m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
      m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
  }
  function matMul3 (a, b) {
    var o = new Array(9)
    for (var r = 0; r < 3; r++) {
      for (var c = 0; c < 3; c++) {
        o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
      }
    }
    return o
  }
  /* 由两个世界系向量构造"前者→+Z、后者投影→+Y"的旋转（行主序 3x3） */
  function frameFrom (toZ, upHint) {
    var z = norm(toZ)
    var u = sub(upHint, scale(z, dot(upHint, z)))
    u = norm(u)
    var x = cross(u, z)                    // 右手系：x = y × z
    return [x[0], x[1], x[2], u[0], u[1], u[2], z[0], z[1], z[2]]
  }
  function rotZ (v, a) {
    var c = Math.cos(a); var s = Math.sin(a)
    return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]]
  }
  function sphericalToVec (raDeg, decDeg) {
    var ra = raDeg * DEG; var dec = decDeg * DEG
    var cd = Math.cos(dec)
    return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)]
  }

  /* 黄道 → 赤道：绕 x 轴（春分点）旋转 +ε。
     校验：黄经 λ 的黄道点应得到 tanα = sinλcosε/cosλ、sinδ = sinλ sinε。 */
  function eclipticToEquatorial (v) {
    var c = Math.cos(OBLIQUITY); var s = Math.sin(OBLIQUITY)
    return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c]
  }
  /* 赤道 → 黄道（逆变换，用于把 IAU 极轴换算进黄道系） */
  function equatorialToEcliptic (v) {
    var c = Math.cos(OBLIQUITY); var s = Math.sin(OBLIQUITY)
    return [v[0], v[1] * c + v[2] * s, -v[1] * s + v[2] * c]
  }
  /* 赤道 → 银道：用 NGP / 银心两个已发表方向构造正交基 */
  var GAL_BASIS = (function () {
    var ngp = sphericalToVec(GAL.ngpRa * RAD, GAL.ngpDec * RAD)
    var gc = sphericalToVec(GAL.gcRa * RAD, GAL.gcDec * RAD)
    var zg = norm(ngp)
    var xg = norm(sub(gc, scale(zg, dot(gc, zg))))   // 银心在银道面内的正交化
    var yg = cross(zg, xg)
    return { x: xg, y: yg, z: zg }
  })()
  function equatorialToGalactic (v) {
    return [dot(v, GAL_BASIS.x), dot(v, GAL_BASIS.y), dot(v, GAL_BASIS.z)]
  }

  /* ================= 开普勒解算 ================= */
  function solveKepler (M, e) {
    // 归一化到 [-π, π]，牛顿迭代足够（e 最大 0.21）
    var m = M % (2 * Math.PI)
    if (m > Math.PI) m -= 2 * Math.PI
    if (m < -Math.PI) m += 2 * Math.PI
    var E = m + e * Math.sin(m)
    for (var i = 0; i < 12; i++) {
      var f = E - e * Math.sin(E) - m
      var fp = 1 - e * Math.cos(E)
      var d = f / fp
      E -= d
      if (Math.abs(d) < 1e-12) break
    }
    return E
  }

  /* JPL 近似要素：J2000 值 + 每儒略世纪变化率
     顺序: a(AU) e i(deg) L(deg) longPeri(deg) longNode(deg) */
  var ELEMENTS = {
    mercury: [0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593,
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
    venus: [0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255,
      0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418],
    earth: [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0,
      0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0],
    mars: [1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
    jupiter: [5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
    saturn: [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
      -0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
    uranus: [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503,
      -0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
    neptune: [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574,
      0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]
  }

  var PLANET_ORDER = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']

  function julianCenturies (epochMs) {
    // JD = 2440587.5 + ms/86400000 ；J2000 = 2451545.0
    var jd = 2440587.5 + epochMs / 86400000
    return (jd - 2451545.0) / 36525
  }

  /* 日心黄道 J2000 直角坐标（AU），另附轨道要素供检查 */
  function heliocentric (name, T) {
    var el = ELEMENTS[name]
    if (!el) throw new Error('unknown body: ' + name)
    var a = el[0] + el[6] * T
    var e = el[1] + el[7] * T
    var i = (el[2] + el[8] * T) * DEG
    var L = (el[3] + el[9] * T) * DEG
    var w = el[4] + el[10] * T          // 近日点黄经 ϖ
    var O = el[5] + el[11] * T          // 升交点黄经 Ω
    var M = L - w * DEG
    var E = solveKepler(M, e)
    var xp = a * (Math.cos(E) - e)
    var yp = a * Math.sqrt(1 - e * e) * Math.sin(E)
    var argp = (w - O) * DEG
    var cw = Math.cos(argp); var sw = Math.sin(argp)
    var cO = Math.cos(O * DEG); var sO = Math.sin(O * DEG)
    var ci = Math.cos(i); var si = Math.sin(i)
    var x = (cw * cO - sw * sO * ci) * xp + (-sw * cO - cw * sO * ci) * yp
    var y = (cw * sO + sw * cO * ci) * xp + (-sw * sO + cw * cO * ci) * yp
    var z = (sw * si) * xp + (cw * si) * yp
    return {
      pos: [x, y, z],
      a: a, e: e, iDeg: i * RAD, LDeg: L * RAD, periDeg: w, nodeDeg: O,
      distAU: Math.sqrt(x * x + y * y + z * z),
      lonDeg: Math.atan2(y, x) * RAD,
      latDeg: Math.asin(z / Math.sqrt(x * x + y * y + z * z)) * RAD
    }
  }

  /* ================= 目标视直径（合成长焦规则）=================
     renderD = BASE · (D_real / D_saturn)^EXP
     · D_real 取各体「最接近木星时」的真实角直径 —— 真实照片必然取各自
       近点/冲位，否则同一天体不同日期会差 2~3 倍；
     · EXP=0.55 是幂次压缩：严格 1:1 时地球只有 0.11px，压缩后得到
       10~64px 的可辨识范围，且**次序与近似比例被保留**（土星最大、
       水星最小），这条比"绝对比例"更重要。 */
  function realMinAngularDiameterArcsec (name) {
    var b = BODIES[name]
    var aJ = ELEMENTS.jupiter[0]
    var aSelf = ELEMENTS[name][0]
    var dAu = Math.abs(aSelf - aJ)
    if (dAu < 1e-6) return null
    var dKm = dAu * AU_KM
    return (2 * b.radiusKm / dKm) * ARCSEC_PER_RAD
  }

  function buildSizes (globePx) {
    var dSat = realMinAngularDiameterArcsec('saturn')
    var out = {}
    for (var i = 0; i < PLANET_ORDER.length; i++) {
      var n = PLANET_ORDER[i]
      if (n === 'jupiter') continue
      var d = realMinAngularDiameterArcsec(n)
      out[n] = {
        realArcsec: d,
        /* 取景放大：--globe 变大（窄屏）时整体等比放大，构图跨断点一致 */
        targetPx: SIZE_BASE_PX * Math.pow(d / dSat, SIZE_EXP) * (globePx / SIZE_REF_GLOBE_PX)
      }
    }
    return out
  }

  /* ================= 相机与参考系 =================
     相机位于木星的「向阳侧」、看向背离太阳的方向：这样木星呈现被照亮的
     大半面（真实探测器机位就是这样），而画面深处是外太阳系方向。
     方位偏移 CAM_AZ_DEG 有两个作用：
       · 相位角 ≈ 方位偏移 + 高度角 ⇒ 木星呈"凸相"，晨昏线落在边缘附近，
         不像满相那样扁平；
       · 决定画面对着哪一段黄经，从而决定银河以什么角度穿过画面。
     旋向由 AZ_SIGN 固定为「阳光落在画面左侧」—— 木星球心被 CSS 推到
     视口右侧之外，只有左弧面可见，光必须从左后方来才照得到可见弧面
     （旧版注释里踩过这个坑，这里改为由常量+自检保证）。 */
  function cameraDir (sHatIn, azDeg, elevDeg, azSign) {
    var az = azSign * azDeg * DEG
    var elev = elevDeg * DEG
    // 先在黄道面内绕黄极转 az，再抬高 elev（先转后抬，保证相位角 ≈ |az| + |elev|）
    var inPlane = rotZ(norm(sHatIn), az)
    return norm(add(scale(inPlane, Math.cos(elev)), [0, 0, Math.sin(elev)]))
  }

  /* ================= 星空：真实银道面与恒星的取向 ================= */
  /* 天顶方向（黄道北极）与银道北极在参考系里的夹角必须等于实测的
     60.19°（= 90° − 29.81°）。渲染器用这个数做自检，防止坐标链里
     出现转置/符号错误 —— 这类错误肉眼看银河"也挺像"的，但整片天空
     会相对黄道带错位。 */
  function galacticPoleInEcliptic () {
    // NGP 的赤道坐标 → 黄道坐标
    return equatorialToEcliptic(GAL_BASIS.z)
  }

  /* ================= 恒星表解析 =================
     二进制格式与 tools/build-star-catalog.js 一一对应（12 字节头 + 6 字节/星）。
     这里只做"字节 → 参考系单位向量 + 星等 + 色指数"的转换，位置/颜色
     的真实性由星表本身保证。 */
  function parseStarCatalog (buffer, scene) {
    if (!buffer) return null
    var dv = new DataView(buffer)
    var magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
    if (magic !== 'SKY1') throw new Error('stars.bin: bad magic ' + magic)
    var n = dv.getUint32(4, true)
    if (buffer.byteLength < 12 + n * 6) throw new Error('stars.bin: truncated')
    var pos = new Float32Array(n * 3)
    var mag = new Float32Array(n)
    var bv = new Float32Array(n)
    var m = scene.starFrame.R_eq2render
    for (var i = 0; i < n; i++) {
      var o = 12 + i * 6
      var ra = dv.getUint16(o, true) / 100 * DEG
      var dec = (dv.getUint16(o + 2, true) / 100 - 90) * DEG
      var q = dv.getUint8(o + 4)
      var qb = dv.getUint8(o + 5)
      var cd = Math.cos(dec)
      var v = [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)]
      var w = mul3(m, v)
      pos[i * 3] = w[0]; pos[i * 3 + 1] = w[1]; pos[i * 3 + 2] = w[2]
      mag[i] = q * 0.05 - 1.5
      bv[i] = qb * 0.02 - 0.4
    }
    return { count: n, pos: pos, mag: mag, bv: bv }
  }

  /* B−V → 有效温度（Ballesteros 近似，NASA SVS 星图用的同一公式），
     再由温度给黑体色。星空层与星空自检都用它。 */
  function bvToTempK (bv) {
    var b = Math.max(-0.4, Math.min(2.0, bv))
    return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62))
  }

  /* ================= 场景构建 =================
     返回渲染器需要的全部几何。任何"看起来像坐标"的数字都必须来自这里。 */
  function build (opts) {
    opts = opts || {}
    var epochMs = opts.epochMs == null ? EPOCH_MS : opts.epochMs
    var globePx = opts.globePx || SIZE_REF_GLOBE_PX
    var azDeg = opts.camAzDeg == null ? CAM_AZ_DEG : opts.camAzDeg
    var elevDeg = opts.camElevDeg == null ? CAM_ELEV_DEG : opts.camElevDeg
    var camDistRj = opts.camDistRj == null ? CAM_DIST_RJ : opts.camDistRj
    var azSign = opts.azSign == null ? AZ_SIGN : opts.azSign
    var T = julianCenturies(epochMs)

    var helio = {}
    for (var i = 0; i < PLANET_ORDER.length; i++) {
      var n = PLANET_ORDER[i]
      helio[n] = heliocentric(n, T)
    }
    var jup = helio.jupiter
    var sHat = norm(scale(jup.pos, -1))          // 木星 → 太阳

    var camDir = cameraDir(sHat, azDeg, elevDeg, azSign)
    var nEcl = [0, 0, 1]
    /* 参考系：相机方向 → +Z（相机在 +Z 看向原点），黄道北极投影 → +Y */
    var R = frameFrom(camDir, nEcl)              // render = R · ecliptic

    // 木星系的光向（参考系内）
    var lightDir = norm(mul3(R, sHat))

    var sizes = buildSizes(globePx)

    /* --- 远景行星：按真实日心黄经相对木星的差值排序，得到画面次序 --- */
    var far = []
    for (var j = 0; j < PLANET_ORDER.length; j++) {
      var nm = PLANET_ORDER[j]
      if (nm === 'jupiter') continue
      var h = helio[nm]
      var rel = sub(h.pos, jup.pos)              // 木星 → 该行星（真实方向）
      var dirEcl = norm(rel)
      var dLon = Math.atan2(dirEcl[1], dirEcl[0]) - Math.atan2(sHat[1], sHat[0])
      // 归一到 (-π, π]
      while (dLon <= -Math.PI) dLon += 2 * Math.PI
      while (dLon > Math.PI) dLon -= 2 * Math.PI
      // 自转轴：用 IAU 极点（真实取向），否则球体姿态会与真实照片不符
      var bodyPole = norm(mul3(R, equatorialToEcliptic(sphericalToVec(BODIES[nm].pole[0], BODIES[nm].pole[1]))))
      far.push({
        name: nm,
        nameCn: BODIES[nm].nameCn,
        radiusRj: BODIES[nm].radiusKm / R_J_KM,
        albedo: BODIES[nm].albedo,
        /* 表面亮度（逐体曝光压缩后的值，见 IRRADIANCE_COMPRESS 说明） */
        surfBright: surfBrightOf(BODIES[nm].albedo, h.distAU),
        rotationHours: BODIES[nm].rotationHours,
        flatten: BODIES[nm].flatten || 1,
        airless: !!BODIES[nm].airless,
        poleRender: bodyPole,
        ring: BODIES[nm].ring || null,
        realArcsec: sizes[nm].realArcsec,
        targetPx: sizes[nm].targetPx,
        helioDistAU: h.distAU,
        realLonDeg: h.lonDeg,
        realLatDeg: h.latDeg,
        realDeltaLonDeg: dLon * RAD,
        distFromJupiterAU: len(rel),
        /* 每颗行星的太阳方向（真实，逐体不同 —— 内行星与远行星的相位
           差别正来自这里） */
        lightDir: norm(mul3(R, norm(scale(h.pos, -1)))),
        /* [合成分帧的关键] 着色用的"观察方向"取**真实**方向（该行星 →
           木星/探测器），而不是它在画面里被挪到的那条视线方向。
           理由：位置被压缩了离角，若用画面视线去着色，相位角就变成
           排布的副产物；用真实方向着色后，相位角、晨昏线宽度、被照亮
           比例都是真实值（等价于"每颗行星各拍一张长焦，再合成进同一幅
           画面"——真实的天体合成图正是这么做的）。 */
        shadeViewDir: norm(mul3(R, sub(jup.pos, h.pos))),
        dirRender: mul3(R, dirEcl)
      })
    }
    far.sort(function (a, b) { return a.realDeltaLonDeg - b.realDeltaLonDeg })
    for (var s = 0; s < far.length; s++) far[s].slot = s
    /* 画面次序 = 真实黄经次序（slot）；**深度** = 真实日心距次序
       （内行星在前、海王星最远），且全部远于 Callisto 的 26.4 R_J。
       半径由目标视直径反解，因此是"缩比合成"（已在注释与关于页声明）。 */
    var byDist = far.slice().sort(function (a, b) { return a.distFromJupiterAU - b.distFromJupiterAU })
    for (var d2 = 0; d2 < byDist.length; d2++) {
      byDist[d2].distRj = FAR_DIST_BASE_RJ + d2 * FAR_DIST_STEP_RJ
      byDist[d2].depthRank = d2
    }

    /* --- 木星赤道面（卫星轨道面）--- */
    var poleEq = sphericalToVec(JUP_POLE.ra, JUP_POLE.dec)   // 赤道坐标
    var poleEcl = equatorialToEcliptic(poleEq)               // → 黄道
    var poleRender = norm(mul3(R, poleEcl))
    var nodeRender = norm(cross([0, 0, 1], poleRender))
    if (!isFinite(nodeRender[0]) || len(nodeRender) < 1e-6) nodeRender = [1, 0, 0]
    var e2 = norm(cross(poleRender, nodeRender))

    var moons = []
    for (var k = 0; k < MOONS.length; k++) {
      var mo = MOONS[k]
      moons.push({
        name: mo.name,
        nameCn: mo.nameCn,
        radiusRj: mo.radiusKm / R_J_KM,
        aRj: mo.aKm / R_J_KM,
        periodDays: mo.periodDays,
        albedo: mo.albedo,
        /* 卫星与木星同距太阳，辐照度因子为 1 */
        surfBright: mo.albedo,
        phase0: mo.phase0,
        /* 潮汐锁定：自转周期 = 公转周期；自转轴 = 木星自转轴 */
        rotationHours: mo.periodDays * 24,
        poleRender: poleRender,
        airless: true,
        lightDir: lightDir
      })
    }

    /* --- 星空 / 银河的坐标链 --- */
    var R_eq2ecl = (function () {
      // 赤道 → 黄道 的 3x3（行主序），与 equatorialToEcliptic 一致
      var c = Math.cos(OBLIQUITY); var ss = Math.sin(OBLIQUITY)
      return [1, 0, 0, 0, c, ss, 0, -ss, c]
    })()
    var R_ecl2gal = (function () {
      // 黄道 → 银道 = (赤道 → 银道) ∘ (黄道 → 赤道)
      var c = Math.cos(OBLIQUITY); var ss = Math.sin(OBLIQUITY)
      var R_ecl2eq = [1, 0, 0, 0, c, -ss, 0, ss, c]
      var R_eq2gal = [
        GAL_BASIS.x[0], GAL_BASIS.x[1], GAL_BASIS.x[2],
        GAL_BASIS.y[0], GAL_BASIS.y[1], GAL_BASIS.y[2],
        GAL_BASIS.z[0], GAL_BASIS.z[1], GAL_BASIS.z[2]
      ]
      return matMul3(R_eq2gal, R_ecl2eq)
    })()

    var starFrame = {
      /* 赤道 → 参考系 = (黄道 → 参考系) ∘ (赤道 → 黄道) */
      R_eq2render: matMul3(R, R_eq2ecl)
    }
    var galacticFrame = {
      /* 银道 → 参考系 = (黄道 → 参考系) ∘ (银道 → 黄道) */
      R_gal2render: matMul3(R, (function () {
        // 银道 → 黄道 = transpose(R_ecl2gal)
        var o = new Array(9)
        for (var r = 0; r < 3; r++) for (var cc = 0; cc < 3; cc++) o[r * 3 + cc] = R_ecl2gal[cc * 3 + r]
        return o
      })())
    }

    /* --- 取景诊断 --- */
    var viewDir = scale(camDir, -1)                 // 相机 → 木星心 = 视线
    var galDir = mul3(R_ecl2gal, viewDir)
    var frameGalLat = Math.asin(Math.max(-1, Math.min(1, galDir[2]))) * RAD
    var frameGalLon = Math.atan2(galDir[1], galDir[0]) * RAD
    if (frameGalLon < 0) frameGalLon += 360
    var poleEclRender = mul3(R, nEcl)
    // 银极在参考系里 = R_gal2render · (0,0,1)（即矩阵第 3 列）
    var galPoleRender = [
      galacticFrame.R_gal2render[2], galacticFrame.R_gal2render[5], galacticFrame.R_gal2render[8]
    ]
    var planeAngle = Math.acos(Math.max(-1, Math.min(1, dot(poleEclRender, norm(galPoleRender))))) * RAD

    return {
      epochMs: epochMs,
      T: T,
      timeScale: opts.timeScale == null ? TIME_SCALE : opts.timeScale,
      sunDirEcliptic: sHat,
      lightDir: lightDir,
      jupiterRing: JUPITER_RING,
      jupiter: {
        name: 'jupiter',
        radiusRj: 1,
        flatten: BODIES.jupiter.flatten,
        albedo: BODIES.jupiter.albedo,
        surfBright: BODIES.jupiter.albedo,
        rotationHours: BODIES.jupiter.rotationHours,
        poleRender: poleRender,
        lightDir: lightDir,
        helio: jup.pos,
        lonDeg: jup.lonDeg,
        latDeg: jup.latDeg,
        distAU: jup.distAU
      },
      frame: {
        R: R,
        camDir: camDir,
        camPosRender: [0, 0, camDistRj],
        camDistRj: camDistRj,
        camAzDeg: azDeg,
        camElevDeg: elevDeg,
        azSign: azSign,
        viewDirEcliptic: viewDir,
        phaseAngleDeg: Math.acos(Math.max(-1, Math.min(1, dot(camDir, sHat)))) * RAD
      },
      farBodies: far,
      moons: moons,
      moonsPlane: { normal: poleRender, e1: nodeRender, e2: e2 },
      starFrame: starFrame,
      galacticFrame: galacticFrame,
      sizeRule: { basePx: SIZE_BASE_PX, exp: SIZE_EXP, refGlobePx: SIZE_REF_GLOBE_PX, globePx: globePx },
      diagnostics: {
        frameEclipticLonDeg: (Math.atan2(viewDir[1], viewDir[0]) * RAD + 360) % 360,
        frameGalacticLatDeg: frameGalLat,
        frameGalacticLonDeg: frameGalLon,
        eclipticGalacticAngleDeg: planeAngle,
        farOrder: far.map(function (f) { return f.name })
      }
    }
  }

  /* 卫星在模拟时刻的相位角（弧度）—— 与木星自转共用同一个时钟，
     因此"自转 / 公转 / 相位 / 影子"永远互相自洽。 */
  function moonPhase (moon, tSimSeconds) {
    var frac = (moon.phase0 + tSimSeconds / (moon.periodDays * 86400)) % 1
    if (frac < 0) frac += 1
    return frac * 2 * Math.PI
  }

  function bodySpin (body, tSimSeconds) {
    var days = body.rotationHours / 24
    var frac = (tSimSeconds / (days * 86400)) % 1
    if (frac < 0) frac += 1
    return frac * 2 * Math.PI
  }

  return {
    DEG: DEG, RAD: RAD,
    R_J_KM: R_J_KM, AU_KM: AU_KM, AU_IN_RJ: AU_IN_RJ,
    OBLIQUITY: OBLIQUITY,
    EPOCH_MS: EPOCH_MS, TIME_SCALE: TIME_SCALE,
    CAM_AZ_DEG: CAM_AZ_DEG, CAM_ELEV_DEG: CAM_ELEV_DEG, CAM_DIST_RJ: CAM_DIST_RJ,
    SIZE_BASE_PX: SIZE_BASE_PX, SIZE_EXP: SIZE_EXP, SIZE_REF_GLOBE_PX: SIZE_REF_GLOBE_PX,
    FAR_DIST_BASE_RJ: FAR_DIST_BASE_RJ, FAR_DIST_STEP_RJ: FAR_DIST_STEP_RJ,
    IRRADIANCE_COMPRESS: IRRADIANCE_COMPRESS,
    surfBrightOf: surfBrightOf,
    BODIES: BODIES, MOONS: MOONS, PLANET_ORDER: PLANET_ORDER, ELEMENTS: ELEMENTS,
    GAL: GAL,
    build: build,
    heliocentric: heliocentric,
    julianCenturies: julianCenturies,
    realMinAngularDiameterArcsec: realMinAngularDiameterArcsec,
    targetPixels: function (globePx) { return buildSizes(globePx) },
    solveKepler: solveKepler,
    eclipticToEquatorial: eclipticToEquatorial,
    equatorialToEcliptic: equatorialToEcliptic,
    equatorialToGalactic: equatorialToGalactic,
    galacticPoleInEcliptic: galacticPoleInEcliptic,
    parseStarCatalog: parseStarCatalog,
    bvToTempK: bvToTempK,
    moonPhase: moonPhase,
    bodySpin: bodySpin,
    vec: { sub: sub, add: add, scale: scale, dot: dot, cross: cross, norm: norm, len: len, mul3: mul3, matMul3: matMul3 }
  }
})
