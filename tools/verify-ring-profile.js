'use strict'
/* 土星环剖面自检 (tools/verify-ring-profile.js)
   ------------------------------------------------------------
   为什么单独验：环在屏幕上只有 80px 宽，肉眼分不出"真实环缝"与"一条渐变的
   灰带"。这个工具把 source/img/saturn-ring.png（1024x1 RGBA）解出来，
   按半径逐点算 alpha，然后断言**物理上必须成立**的几条：
     · 两端 alpha 必须为 0（否则内外边界会切出硬边）
     · C / B / 卡西尼缝 / A 环 / 恩克缝 的相对位置与相对亮度
     · 卡西尼缝（1.95 R_S）必须是一个真实的局部极小，而不是斜坡上的一点
   这些断言在改剖面分辨率或换源图时会立刻报警 —— 比看渲染图可靠得多。 */
const fs = require('fs')
const path = require('path')
const { decodePng } = require('./png-to-jpeg.js')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'source', 'img', 'saturn-ring.png')
const INNER = 1.11, OUTER = 2.32      // SSS 约定：x=0 ↔ 1.11 R_S, 末列 ↔ 2.32 R_S

let pass = 0, fail = 0
const failures = []
function check (name, ok, detail) {
  if (ok) { pass++; console.log('  \u2705 ' + name + (detail ? '  ' + detail : '')) } else {
    fail++; failures.push(name); console.log('  \u274c ' + name + (detail ? '  ' + detail : ''))
  }
}
const f = (v, n) => Number(v).toFixed(n == null ? 3 : n)

const raw = decodePng(fs.readFileSync(P))
console.log('\n=== 土星环剖面 ' + raw.w + 'x' + raw.h + ' ===')
const L = raw.w
const alpha = (i) => raw.data[i * raw.ch + 3]
const rad = (i) => INNER + (i / (L - 1)) * (OUTER - INNER)

check('剖面是一维条带（高为 1）', raw.h === 1, raw.h + ' 行')
check('两端 alpha = 0（无硬边）', alpha(0) === 0 && alpha(L - 1) === 0,
  'alpha(0)=' + alpha(0) + ' alpha(L-1)=' + alpha(L - 1))

/* 每个采样半径的 alpha（多点取中位，抗单点噪声） */
function aAt (rs) {
  const i = Math.round((rs - INNER) / (OUTER - INNER) * (L - 1))
  const lo = Math.max(0, i - 6), hi = Math.min(L - 1, i + 6)
  const v = []
  for (let k = lo; k <= hi; k++) v.push(alpha(k))
  v.sort((a, b) => a - b)
  return v[Math.floor(v.length / 2)]
}

const probes = [
  ['D 环 1.15', 1.15], ['C 环 1.30', 1.30], ['B 环内 1.55', 1.55],
  ['B 环外 1.85', 1.85], ['卡西尼缝 1.95', 1.95], ['A 环 2.10', 2.10],
  ['恩克缝 2.214', 2.214], ['F 环 2.30', 2.30]
]
console.log('\n  ' + ['位置', '半径 R_S', 'alpha'].join('\t'))
for (const [n, rs] of probes) console.log('  ' + n.padEnd(12) + f(rs, 3) + '\t\t' + aAt(rs))

const aC = aAt(1.30), aB = Math.max(aAt(1.55), aAt(1.85)), aA = aAt(2.10)
const aCass = aAt(1.95), aEncke = aAt(2.214), aF = aAt(2.30)

const aEnckeMin = (() => {
  /* 恩克缝只有约 325 km（≈0.0054 R_S）。**不能**用"在 2.214 附近取中位"
     那种跨窗口采样去测 —— 窗口一跨就把缝抹平了（第一版就是这么把
     202 与两侧 177/0 当成"无缝隙"的误报）。
     正确做法：在 2.20~2.28 这一段里找**逐采样点的局部极小**，
     再与两侧各 0.02 R_S 的均值比较。 */
  const iLo = Math.round((2.20 - INNER) / (OUTER - INNER) * (L - 1))
  const iHi = Math.round((2.28 - INNER) / (OUTER - INNER) * (L - 1))
  let bi = -1
  for (let i = iLo + 2; i <= iHi - 2; i++) {
    if (alpha(i) <= alpha(i - 1) && alpha(i) <= alpha(i + 1) &&
        alpha(i) <= alpha(i - 2) && alpha(i) <= alpha(i + 2)) {
      if (bi < 0 || alpha(i) < alpha(bi)) bi = i
    }
  }
  const side = Math.max(4, Math.round(0.02 / (OUTER - INNER) * (L - 1)))
  const nb = []
  for (let k = Math.max(0, bi - side * 2); k < Math.max(0, bi - side); k++) nb.push(alpha(k))
  for (let k = Math.min(L - 1, bi + side); k < Math.min(L, bi + side * 2); k++) nb.push(alpha(k))
  nb.sort((a, b) => a - b)
  return { rs: bi >= 0 ? rad(bi) : NaN, a: bi >= 0 ? alpha(bi) : NaN, nb: nb[Math.floor(nb.length / 2)] }
})()

console.log('')
check('B 环比 C 环亮（真实：B 环光学厚度最大）', aB > aC, 'B=' + aB + ' vs C=' + aC)
check('A 环比 B 环暗（真实：A 环较稀薄）', aA < aB, 'A=' + aA + ' vs B=' + aB)
check('卡西尼缝是明显暗带（alpha ≤ B 环的 45%）', aCass <= aB * 0.45,
  '缝=' + aCass + ' B=' + aB)
check('卡西尼缝比两侧都暗（B 环 1.85 与 A 环 2.10）',
  aCass < Math.min(aAt(1.85), aAt(2.10)),
  '缝=' + aCass + ' 左=' + aAt(1.85) + ' 右=' + aAt(2.10))
console.log('  恩克缝：半径 ' + f(aEnckeMin.rs, 4) + ' R_S  alpha=' + aEnckeMin.a +
  '  两侧中位 ' + aEnckeMin.nb)
check('A 环内存在恩克缝（局部极小 ≤ 两侧的 70%）',
  isFinite(aEnckeMin.a) && aEnckeMin.a <= aEnckeMin.nb * 0.7,
  '缝 alpha=' + aEnckeMin.a + ' vs 两侧 ' + aEnckeMin.nb)
check('恩克缝位置接近真实 2.214 R_S（±0.05）',
  isFinite(aEnckeMin.rs) && Math.abs(aEnckeMin.rs - 2.214) < 0.05, f(aEnckeMin.rs, 4))
check('F 环区域仍可见（alpha > 0）', aF > 0, 'alpha=' + aF)

/* 全局：剖面必须有真实的起伏，而不是一条平带。
   阈值取"峰值 ≥ 均值的 1.5 倍"：环剖面里 D/C 环占了不少低值区，
   均值天然被拉低；1.5 倍既能挡住"被抹平"，也不会误报真实剖面
   （实测峰值 248 / 均值约 152 ⇒ 1.63）。 */
let mn = 255, mx = 0, sum = 0
for (let i = 0; i < L; i++) { const a = alpha(i); if (a < mn) mn = a; if (a > mx) mx = a; sum += a }
check('剖面有真实起伏（峰值 ≥ 均值的 1.5 倍）', mx > (sum / L) * 1.5,
  '峰值 ' + mx + ' 均值 ' + f(sum / L, 1))

console.log('\n=== 汇总 ===')
console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) { console.log('  失败项: ' + failures.join(' | ')); process.exit(1) }
console.log('  ALL CHECKS PASSED')
