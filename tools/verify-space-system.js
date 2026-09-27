'use strict'
/* ============================================================
   太阳系几何自检 (tools/verify-space-system.js)
   ------------------------------------------------------------
   为什么要有它：这一层的错误（抄错一位轨道要素、矩阵转置、符号搞反）
   在截图里往往"看起来也挺像木星场景"，肉眼抓不出来，但整片天空会相对
   黄道带错位、相位会反、次序会乱。所以天文数值必须能在 Node 里离线跑
   断言，而不是靠看画面猜。

   运行: node tools/verify-space-system.js
   退出码非 0 表示有断言失败。
   ============================================================ */

const ss = require('../source/custom/effects/space-system.js')
const fs = require('fs')
const path = require('path')

let pass = 0
let fail = 0
const failures = []

function check (name, ok, detail) {
  if (ok) { pass++; console.log('  \u2705 ' + name + (detail ? '  ' + detail : '')) } else {
    fail++; failures.push(name); console.log('  \u274c ' + name + (detail ? '  ' + detail : ''))
  }
}
function near (a, b, tol) { return Math.abs(a - b) <= tol }
const f = (v, n) => Number(v).toFixed(n == null ? 3 : n)

/* ---------------- 1. 轨道要素自检：变化率必须反算出真实恒星周期 ----------------
   这是抓"抄错数字"最有效的一条：L 的世纪变化率 ÷ 36525 = 平均角速度（°/天），
   360 ÷ 角速度 = 周期，必须等于已知恒星周期。 */
const SIDEREAL = {
  mercury: 87.9691, venus: 224.7008, earth: 365.2564, mars: 686.9800,
  jupiter: 4332.589, saturn: 10759.22, uranus: 30688.5, neptune: 60182.0
}
console.log('\n=== 1. 轨道要素 → 恒星周期 ===')
const T0 = ss.julianCenturies(ss.EPOCH_MS)
ss.PLANET_ORDER.forEach(function (n) {
  const Lrate = ss.ELEMENTS[n][9]
  const period = 360 / (Lrate / 36525)
  const ref = SIDEREAL[n]
  check('period ' + n, Math.abs(period / ref - 1) < 0.002,
    f(period, 3) + 'd vs 实测 ' + ref + 'd  (' + f((period / ref - 1) * 100, 3) + '%)')
})

/* ---------------- 2. 位置范围与历元表 ---------------- */
console.log('\n=== 2. 历元 ' + new Date(ss.EPOCH_MS).toISOString() + ' 日心黄道坐标 ===')
console.log('  ' + ['天体', '黄经°', '黄纬°', '日心距AU', 'a(1±e)区间'].join('\t'))
const helio = {}
ss.PLANET_ORDER.forEach(function (n) {
  const h = ss.heliocentric(n, T0)
  helio[n] = h
  const lo = h.a * (1 - h.e) * 0.995
  const hi = h.a * (1 + h.e) * 1.005
  check('radius in range ' + n, h.distAU > lo && h.distAU < hi)
  check('lat within inclination ' + n, Math.abs(h.latDeg) <= h.iDeg + 0.2)
  console.log('  ' + n + '\t' + f(h.lonDeg, 3) + '\t' + f(h.latDeg, 4) + '\t' + f(h.distAU, 6) + '\t[' + f(lo, 3) + ', ' + f(hi, 3) + ']')
})

/* ---------------- 3. 银道面与黄道面的真实交角 ---------------- */
console.log('\n=== 3. 银道系取向（必须等于实测值，否则整片天空相对行星错位）===')
const ngpEcl = ss.galacticPoleInEcliptic()
const betaNgp = Math.asin(ngpEcl[2]) * ss.RAD
const lambdaNgp = (Math.atan2(ngpEcl[1], ngpEcl[0]) * ss.RAD + 360) % 360
check('北银极黄道纬度 = +29.811°', near(betaNgp, 29.811, 0.02), f(betaNgp, 4) + '°')
check('北银极黄经 = 180.02°', near(lambdaNgp, 180.023, 0.05), f(lambdaNgp, 4) + '°')
const planeAngle = 90 - betaNgp
check('黄道 / 银道交角 = 60.19°', near(planeAngle, 60.189, 0.02), f(planeAngle, 4) + '°')

/* ---------------- 4. 相机基与光照方向 ---------------- */
console.log('\n=== 4. 相机基 ===')
const scene = ss.build({ globePx: ss.SIZE_REF_GLOBE_PX })
const R = scene.frame.R
const v = ss.vec
const camDirR = v.mul3(R, scene.frame.camDir)
check('R · camDir = (0,0,1)', near(camDirR[0], 0, 1e-9) && near(camDirR[1], 0, 1e-9) && near(camDirR[2], 1, 1e-9),
  '[' + f(camDirR[0], 6) + ',' + f(camDirR[1], 6) + ',' + f(camDirR[2], 6) + ']')
const upR = v.mul3(R, [0, 0, 1])
check('黄道北极投影到 +Y（黄道带在画面里是水平的）', upR[1] > 0.95, '[' + f(upR[0], 4) + ',' + f(upR[1], 4) + ',' + f(upR[2], 4) + ']')
check('阳光来自画面左后方（可见左弧面被照亮，旧版踩过的坑）',
  scene.lightDir[0] < -0.4 && scene.lightDir[2] > 0.5,
  'lightDir=[' + f(scene.lightDir[0], 4) + ',' + f(scene.lightDir[1], 4) + ',' + f(scene.lightDir[2], 4) + ']')
console.log('  相位角 = ' + f(scene.frame.phaseAngleDeg, 2) + '°（' +
  (scene.frame.phaseAngleDeg < 90 ? '木星呈凸相，晨昏线靠近边缘' : '木星过半暗') + '）')
console.log('  取景黄经 = ' + f(scene.diagnostics.frameEclipticLonDeg, 2) + '°；画面中心银纬 = ' +
  f(scene.diagnostics.frameGalacticLatDeg, 2) + '°；银经 = ' + f(scene.diagnostics.frameGalacticLonDeg, 2) + '°')
check('银河以斜角穿过画面（画面中心不在银道面上，也不离太远）',
  Math.abs(scene.diagnostics.frameGalacticLatDeg) > 4 && Math.abs(scene.diagnostics.frameGalacticLatDeg) < 30,
  f(scene.diagnostics.frameGalacticLatDeg, 2) + '°')

/* ---------------- 5. 合成排布 ---------------- */
console.log('\n=== 5. 远景行星合成排布 ===')
check('7 颗行星全部参与排布', scene.farBodies.length === 7, scene.farBodies.map(b => b.name).join(' → '))
let prevDlon = -999
let orderOk = true
scene.farBodies.forEach(function (b) {
  if (b.realDeltaLonDeg < prevDlon) orderOk = false
  prevDlon = b.realDeltaLonDeg
})
check('画面次序 = 真实黄经次序', orderOk)
const byPx = scene.farBodies.slice().sort((a, b) => b.targetPx - a.targetPx).map(b => b.name)
const byReal = scene.farBodies.slice().sort((a, b) => b.realArcsec - a.realArcsec).map(b => b.name)
check('目标视直径次序 = 真实角直径次序', byPx.join(',') === byReal.join(','),
  '像素序 ' + byPx.join('>') + ' / 真实序 ' + byReal.join('>'))
let pxOk = true
scene.farBodies.forEach(function (b) { if (b.targetPx < 8 || b.targetPx > 70) pxOk = false })
check('目标视直径都在 8~70px 的可辨识区间', pxOk)
const byDepth = scene.farBodies.slice().sort((a, b) => a.depthRank - b.depthRank)
let depthOk = true
for (let i = 1; i < byDepth.length; i++) if (byDepth[i].distFromJupiterAU < byDepth[i - 1].distFromJupiterAU) depthOk = false
check('深度次序 = 真实日心距次序', depthOk, byDepth.map(b => b.name).join(' → '))
check('全部远景天体都在 Callisto 轨道（26.4 R_J）之外',
  scene.farBodies.every(b => b.distRj > 30), '最近 ' + scene.farBodies.reduce((m, b) => Math.min(m, b.distRj), 1e9) + ' R_J')

/* ---------------- 6. 相位：画面位置是合成的，相位必须是真实的 ---------------- */
console.log('\n=== 6. 相位角重建（着色方向 = 真实方向）===')
console.log('  ' + ['天体', '真实角直径″', '目标px', '相位角°', '被照亮比例'].join('\t'))
let phaseOk = true
scene.farBodies.forEach(function (b) {
  const phase = Math.acos(Math.max(-1, Math.min(1, v.dot(b.lightDir, b.shadeViewDir)))) * ss.RAD
  // 解析值：在真实几何里，太阳-行星-木星 的夹角
  const h = helio[b.name]
  const toSun = v.norm(v.scale(h.pos, -1))
  const toJup = v.norm(v.sub(helio.jupiter.pos, h.pos))
  const analytic = Math.acos(Math.max(-1, Math.min(1, v.dot(toSun, toJup)))) * ss.RAD
  if (!near(phase, analytic, 0.05)) phaseOk = false
  const lit = (1 + Math.cos(phase * ss.DEG)) / 2
  console.log('  ' + b.name + '\t' + f(b.realArcsec, 3) + '\t' + f(b.targetPx, 1) + '\t' + f(phase, 3) + '\t' + f(lit * 100, 1) + '%')
})
check('着色用方向重建出的相位角 = 真实解析相位角', phaseOk)

/* ---------------- 7. 伽利略卫星 ---------------- */
console.log('\n=== 7. 伽利略卫星 ===')
const moons = scene.moons
let monoOk = true
for (let i = 1; i < moons.length; i++) if (moons[i].periodDays <= moons[i - 1].periodDays) monoOk = false
check('轨道周期单调（Io < Europa < Ganymede < Callisto）', monoOk, moons.map(m => f(m.periodDays, 3) + 'd').join(' < '))
check('轨道半径在真实范围（5.9~26.4 R_J）', moons.every(m => m.aRj > 5 && m.aRj < 27),
  moons.map(m => f(m.aRj, 2)).join(', '))
const lap = (function () {
  const ph = moons.map(m => ss.moonPhase(m, 0) * ss.RAD)   // 度；= 平黄经
  let x = ph[0] - 3 * ph[1] + 2 * ph[2]
  x = ((x % 360) + 360) % 360
  return x
})()
check('起始相位满足 Laplace 共振 λ_Io − 3λ_Eu + 2λ_Ga = 180°', near(lap, 180, 1), f(lap, 3) + '°')
const pxPerDeg = ss.SIZE_REF_GLOBE_PX / (2 * Math.asin(1 / ss.CAM_DIST_RJ) * ss.RAD)
console.log('  参考取景 ' + f(pxPerDeg, 1) + ' px/°（木星圆面 ' + ss.SIZE_REF_GLOBE_PX + 'px）')
moons.forEach(function (m) {
  // 诚实报告：相机在 12.2 R_J，Ganymede/Callisto 的轨道在相机之外，
  // 因此"最近距离"要取 |camDist − a|（含相机位于轨道内侧的情形）
  const minD = Math.abs(ss.CAM_DIST_RJ - m.aRj)
  const farD = ss.CAM_DIST_RJ + m.aRj
  const pxNear = 2 * Math.atan(m.radiusRj / Math.max(0.05, minD)) * ss.RAD * pxPerDeg
  const pxFar = 2 * Math.atan(m.radiusRj / farD) * ss.RAD * pxPerDeg
  console.log('  ' + m.name.padEnd(9) + ' a=' + f(m.aRj, 2) + ' R_J  最近 d=' + f(minD, 2) + ' R_J → ' +
    f(pxNear, 0) + 'px ；最远 ' + f(pxFar, 0) + 'px' + '   影子/凌木/掩食由真实几何自然产生')
})

/* ---------------- 8. 恒星表 ---------------- */
console.log('\n=== 8. 真实恒星表 ===')
const binPath = path.join(__dirname, '..', 'source', 'img', 'stars.bin')
if (!fs.existsSync(binPath)) {
  check('stars.bin 存在', false, binPath + ' 不存在（先跑 tools/build-star-catalog.js）')
} else {
  const buf = fs.readFileSync(binPath)
  const cat = ss.parseStarCatalog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), scene)
  check('星表可解析', !!cat && cat.count > 4000, 'count=' + (cat && cat.count))
  // 最亮的一颗应当是天狼星：在参考系里它与真实赤道坐标一致即可
  let bi = 0
  for (let i = 1; i < cat.count; i++) if (cat.mag[i] < cat.mag[bi]) bi = i
  const siriusEq = (function () {
    const ra = 101.2872 * ss.DEG; const dec = -16.7161 * ss.DEG
    const cd = Math.cos(dec)
    return [cd * Math.cos(ra), cd * Math.sin(ra), Math.sin(dec)]
  })()
  const siriusRender = v.mul3(scene.starFrame.R_eq2render, siriusEq)
  const got = [cat.pos[bi * 3], cat.pos[bi * 3 + 1], cat.pos[bi * 3 + 2]]
  const dAng = Math.acos(Math.max(-1, Math.min(1, v.dot(siriusRender, v.norm(got))))) * ss.RAD
  check('最亮星 = 天狼星（与真实 RA/Dec 一致）', dAng < 0.05 && cat.mag[bi] < -1.3,
    'mag=' + f(cat.mag[bi], 2) + '  位置差 ' + f(dAng, 4) + '°')
  const darkish = (function () { let n = 0; for (let i = 0; i < cat.count; i++) if (cat.mag[i] > 5.5) n++; return n })()
  console.log('  共 ' + cat.count + ' 颗（全部亮于 6.0 等的真实恒星，即肉眼可见全集）；亮于 5.5 等 ' + darkish + ' 颗')
}

/* ---------------- 汇总 ---------------- */
console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('  失败项: ' + failures.join(' | '))
  process.exit(1)
}
console.log('  ALL CHECKS PASSED')
