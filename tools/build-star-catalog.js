'use strict'
/* ============================================================
   tools/build-star-catalog.js
   ------------------------------------------------------------
   把真实星表 (.perf/planet-src/stars.6.json) 压成 WebGL 星空
   渲染器能直接喂给 GPU 的紧凑二进制 (source/img/stars.bin)。

   为什么是这个格式（每条记录固定 6 字节）：
   1) 定长记录 = 零解析开销。GPU 侧最省事的做法是把 vertex buffer
      直接建在这个文件上（每帧不复制、不上传），因此记录必须是
      2 字节对齐、定长、按输入顺序排列 —— 不能有变长字段。
   2) ra100/dec100 用 uint16 存"百分之一度"：
      - 赤经 0..360° → 0..36000，1e-2 度的量化误差 ≈ 0.036"
        （天球上 0.005° ≈ 18"），远小于星点贴图本身的角尺寸，
        肉眼与屏幕像素都无法分辨；
      - 赤纬 −90..+90° 平移成 0..180° 再 ×100 → 0..18000，
        **存储即"从南极起算的纬度"**，渲染端免去一次加法，
        也不会出现负数转换的符号问题。
   3) 星等 magQ 用 uint8 存 0.05 等步长：
      magQ = round((mag + 1.5) / 0.05) 覆盖 −1.5 .. +11.25 等。
      -1.5 的下界保证全天最亮的 Sirius (−1.46) 不会被 clamp 到
      错误亮度（magQ=1 → 解码 −1.45，误差 0.01 等）。
      0.05 等的量化步长比人眼/显示器的实际分辨力还细，够用。
   4) 色指数 bvQ 用 uint8 存 0.02 等步长，覆盖 −0.4 .. +4.70：
      B−V 只用来查"恒星色表"（蓝白 → 橙红），色表本身是分段的，
      0.02 的步长完全够；缺 B−V 的星直接写 bvQ = 128
      （解码 ≈ 0.0，即白/淡黄，最中性的兜底值），这样渲染端
      **不需要任何"缺失值分支"**。

   文件头 12 字节 + N×6 字节，小端：
      [0..3]  "SKY1"（魔数，渲染端用来确认字节序与版本正确）
      [4..7]  uint32 N
      [8..11] uint32 format version = 1
      [12..]  N × {uint16 ra100, uint16 dec100, uint8 magQ, uint8 bvQ}
   —— 魔数 + 显式版本号是为了以后扩展（比如加自行/视差）时，
      渲染端能明确拒绝看不懂的文件，而不是读出满屏乱点。

   用法:
     node tools/build-star-catalog.js
     node tools/build-star-catalog.js <in.json> <out.bin> [--min-count=N]

   注意（重要，2026-09-13 实测）：
   本仓库当前的 .perf/planet-src/stars.6.json 是 **Hipparcos 亮度截断
   到 V<=6.0 的子集，只有 5044 条**，而且它的赤经是 **−180..+180**
   表示法（2459 条为负）。因此：
     - 赤经必须先归一化到 [0,360) 再 ×100，否则一半星会跑到错误经度；
     - 脚本默认按 specs 要求断言 N >= 8000，会在当前输入上失败并
       exit 1（这是**输入数据规模问题，不是编码问题**）；
       确需生成二进制时用 --min-count=5000 显式放宽，或换用
       完整星表（Yale BSC 9110 条 / Hipparcos 全量）。
   ============================================================ */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

/* ---------- 输出格式常量（与渲染端契约，勿随意改） ---------- */
const MAGIC = 'SKY1'
const FORMAT_VERSION = 1
const HEADER_BYTES = 12
const RECORD_BYTES = 6

/* ---------- 量化常量 ---------- */
const RA_STEPS_PER_DEG = 100          // 1e-2 度
const DEC_STEPS_PER_DEG = 100         // 1e-2 度
const MAG_ZERO_POINT = -1.5           // magQ=0 代表的星等
const MAG_STEP = 0.05                 // 每级 0.05 等 → magQ=255 代表 +11.25
const BV_ZERO_POINT = -0.4            // bvQ=0 代表的 B−V
const BV_STEP = 0.02                  // 每级 0.02 → bvQ=255 代表 +4.70
const BV_MISSING_Q = 128              // 缺 B−V 时写入 ≈ 0.0（白/淡黄）

/* ---------- 断言常量 ---------- */
// specs 给的期望值；本仓库当前输入（Hipparcos 截断子集）达不到，
// 用 --min-count= 显式放宽（见文件头说明）。
const EXPECT_MIN_COUNT = 8000
const EXPECT_COUNT_HINT = 9110
const ROUNDTRIP_TOLERANCE_DEG = 0.005 // 量化误差上限 0.005° = 0.5 个量化格
const ROUNDTRIP_SAMPLE = 50
const SIRIUS_MAG_RANGE = [-1.6, -1.3] // 解码后的最亮星必须落在区间内
const SIRIUS_RA_DEG = 101.29
const SIRIUS_DEC_DEG = -16.72
const SIRIUS_MATCH_TOL_DEG = 0.5      // 认星容差（远小于天球上任意两颗亮星间距）
const BRIGHT_MAG_LIMIT = 2.0

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_IN = path.join(ROOT, '.perf', 'planet-src', 'stars.6.json')
const DEFAULT_OUT = path.join(ROOT, 'source', 'img', 'stars.bin')

/* ---------- 参数解析 ---------- */
const argv = process.argv.slice(2)
const positional = argv.filter((a) => !a.startsWith('--'))
const minCountArg = argv.find((a) => a.startsWith('--min-count='))
const minCount = minCountArg === undefined
  ? EXPECT_MIN_COUNT
  : Number(minCountArg.slice('--min-count='.length))

const IN_FILE = positional[0] || DEFAULT_IN
const OUT_FILE = positional[1] || DEFAULT_OUT

/* ---------- 断言收集（延迟到全部打印之后统一结算） ---------- */
const checks = []
function check (name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: String(detail) })
  console.log(`CHECK ${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}

function fail (msg) {
  console.error('ERROR ' + msg)
  process.exit(1)
}

/* ---------- 量化函数 ---------- */
function clampQ (v) {
  return Math.max(0, Math.min(255, v))
}
function quantizeRa (raDeg) {
  // 输入赤经可能是 [0,360) 也可能是 [−180,180]，先归一化，再取模防 360.0 → 36000
  const norm = ((raDeg % 360) + 360) % 360
  return Math.round(norm * RA_STEPS_PER_DEG) % 36000
}
function quantizeDec (decDeg) {
  const q = Math.round((decDeg + 90) * DEC_STEPS_PER_DEG)
  return Math.max(0, Math.min(18000, q))
}
function encodeMag (mag) {
  // magQ = round((mag + 1.5) / 0.05)，等价于 (mag - MAG_ZERO_POINT) / MAG_STEP
  return clampQ(Math.round((mag + 1.5) / MAG_STEP))
}
function encodeBv (bv) {
  return clampQ(Math.round((bv - BV_ZERO_POINT) / BV_STEP))
}
function decodeRa (q) { return q / RA_STEPS_PER_DEG }
function decodeDec (q) { return q / DEC_STEPS_PER_DEG - 90 }
function decodeMag (q) { return q * MAG_STEP + MAG_ZERO_POINT }
function decodeBv (q) { return q * BV_STEP + BV_ZERO_POINT }

/* ============================================================
   1) 读入并解析 GeoJSON
   ============================================================ */
console.log(`INPUT ${IN_FILE}`)
if (!fs.existsSync(IN_FILE)) fail(`输入文件不存在: ${IN_FILE}`)
const rawText = fs.readFileSync(IN_FILE, 'utf8')

let geo
try {
  geo = JSON.parse(rawText)
} catch (e) {
  fail(`输入不是合法 JSON: ${e.message}`)
}
if (!geo || geo.type !== 'FeatureCollection' || !Array.isArray(geo.features)) {
  fail('输入不是 GeoJSON FeatureCollection')
}

const features = geo.features
let skipped = 0
const skipReasons = { noGeometry: 0, badCoordinates: 0, badMag: 0 }
const stars = [] // { ra, dec, mag, bv, id }

for (let i = 0; i < features.length; i++) {
  const f = features[i]
  const g = f && f.geometry
  const p = (f && f.properties) || {}
  if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates) || g.coordinates.length < 2) {
    skipped++; skipReasons.noGeometry++; continue
  }
  const ra = Number(g.coordinates[0])
  const dec = Number(g.coordinates[1])
  if (!Number.isFinite(ra) || !Number.isFinite(dec) || dec < -90 || dec > 90) {
    skipped++; skipReasons.badCoordinates++; continue
  }
  const mag = Number(p.mag)
  if (p.mag === undefined || p.mag === null || p.mag === '' || !Number.isFinite(mag)) {
    skipped++; skipReasons.badMag++; continue
  }
  // bv 缺失/空/非数值 → undefined，编码时用 BV_MISSING_Q
  let bv
  if (p.bv !== undefined && p.bv !== null && p.bv !== '') {
    const n = Number(p.bv)
    if (Number.isFinite(n)) bv = n
  }
  stars.push({ ra, dec, mag, bv, id: f.id, bvMissing: bv === undefined })
}
console.log(`PARSED total=${features.length} usable=${stars.length} skipped=${skipped}` +
  ` (noGeometry=${skipReasons.noGeometry} badCoordinates=${skipReasons.badCoordinates} badMag=${skipReasons.badMag})`)

const N = stars.length
const bvMissingCount = stars.filter((s) => s.bvMissing).length

/* ============================================================
   2) 编码为二进制
   ============================================================ */
const buf = Buffer.allocUnsafe(HEADER_BYTES + RECORD_BYTES * N)
buf.write(MAGIC, 0, 4, 'ascii')
buf.writeUInt32LE(N, 4)
buf.writeUInt32LE(FORMAT_VERSION, 8)

let magMin = Infinity; let magMax = -Infinity
let bvMin = Infinity; let bvMax = -Infinity
let decMin = Infinity; let decMax = -Infinity
const encoded = new Array(N)

for (let i = 0; i < N; i++) {
  const s = stars[i]
  const ra100 = quantizeRa(s.ra)
  const dec100 = quantizeDec(s.dec)
  const magQ = encodeMag(s.mag)
  const bvQ = s.bvMissing ? BV_MISSING_Q : encodeBv(s.bv)
  const o = HEADER_BYTES + i * RECORD_BYTES
  buf.writeUInt16LE(ra100, o)
  buf.writeUInt16LE(dec100, o + 2)
  buf.writeUInt8(magQ, o + 4)
  buf.writeUInt8(bvQ, o + 5)
  encoded[i] = { ra100, dec100, magQ, bvQ }

  if (s.mag < magMin) magMin = s.mag
  if (s.mag > magMax) magMax = s.mag
  if (!s.bvMissing) {
    if (s.bv < bvMin) bvMin = s.bv
    if (s.bv > bvMax) bvMax = s.bv
  }
  if (s.dec < decMin) decMin = s.dec
  if (s.dec > decMax) decMax = s.dec
}

fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
fs.writeFileSync(OUT_FILE, buf)

const outBytes = fs.statSync(OUT_FILE).size
const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
console.log(`WROTE ${OUT_FILE} bytes=${outBytes}`)

/* ============================================================
   3) 读回文件做校验（校验的是"落盘的东西"，不只是内存对象）
   ============================================================ */
const disk = fs.readFileSync(OUT_FILE)

/* --- 检查 1：规模与文件大小 --- */
check('catalog.count>=expected',
  N >= minCount,
  `N=${N} min=${minCount} (spec 期望约 ${EXPECT_COUNT_HINT}，差值 ${N - EXPECT_COUNT_HINT})`)
check('file.size==12+6*N',
  outBytes === HEADER_BYTES + RECORD_BYTES * N,
  `${outBytes} == ${HEADER_BYTES} + 6*${N} = ${HEADER_BYTES + RECORD_BYTES * N}`)
check('file.magic',
  disk.toString('ascii', 0, 4) === MAGIC,
  `"${disk.toString('ascii', 0, 4)}" len=${disk.length}`)
check('file.version',
  disk.readUInt32LE(8) === FORMAT_VERSION,
  `v${disk.readUInt32LE(8)} (期望 ${FORMAT_VERSION})`)
check('file.headerCount==N',
  disk.readUInt32LE(4) === N,
  `${disk.readUInt32LE(4)} == ${N}`)

/* --- 检查 2：范围与 NaN --- */
let raBad = 0; let decBad = 0; let nanCount = 0
for (let i = 0; i < N; i++) {
  const o = HEADER_BYTES + i * RECORD_BYTES
  const ra100 = disk.readUInt16LE(o)
  const dec100 = disk.readUInt16LE(o + 2)
  if (!Number.isFinite(ra100) || !Number.isFinite(dec100)) nanCount++
  if (ra100 >= 36000) raBad++
  if (dec100 > 18000) decBad++
}
check('record.ra100<36000', raBad === 0, `越界 ${raBad} 条`)
check('record.dec100<=18000', decBad === 0, `越界 ${decBad} 条`)
check('record.noNaN', nanCount === 0, `NaN ${nanCount} 条`)

/* --- 检查 3：往返精度（前 50 条，用文件里的字节解码，再与输入原值比较） --- */
const sampleN = Math.min(ROUNDTRIP_SAMPLE, N)
let worstRa = 0; let worstDec = 0; let rtOk = true
for (let i = 0; i < sampleN; i++) {
  const o = HEADER_BYTES + i * RECORD_BYTES
  const ra = decodeRa(disk.readUInt16LE(o))
  const dec = decodeDec(disk.readUInt16LE(o + 2))
  const src = stars[i]
  // 输入赤经可能是 [0,360) 或 [−180,180]，比较前先归一到 [0,360)
  const srcRa = ((src.ra % 360) + 360) % 360
  let dRa = Math.abs(ra - srcRa)
  if (dRa > 180) dRa = 360 - dRa // 跨 0° 回绕
  const dDec = Math.abs(dec - src.dec)
  if (dRa > worstRa) worstRa = dRa
  if (dDec > worstDec) worstDec = dDec
  if (!(dRa <= ROUNDTRIP_TOLERANCE_DEG && dDec <= ROUNDTRIP_TOLERANCE_DEG)) rtOk = false
}
check('roundtrip.firstN<=tol',
  rtOk,
  `n=${sampleN} maxΔra=${worstRa.toFixed(6)}° maxΔdec=${worstDec.toFixed(6)}° tol=${ROUNDTRIP_TOLERANCE_DEG}°`)

/* --- 检查 4：星等合理性 / Sirius 认星 --- */
let brightIdx = 0
for (let i = 1; i < N; i++) if (stars[i].mag < stars[brightIdx].mag) brightIdx = i
const bOff = HEADER_BYTES + brightIdx * RECORD_BYTES
const brightRa = decodeRa(disk.readUInt16LE(bOff))
const brightDec = decodeDec(disk.readUInt16LE(bOff + 2))
const brightMag = decodeMag(disk.readUInt8(bOff + 4))

check('brightest.magInRange',
  brightMag >= SIRIUS_MAG_RANGE[0] && brightMag <= SIRIUS_MAG_RANGE[1],
  `decodedMag=${brightMag.toFixed(4)} range=[${SIRIUS_MAG_RANGE[0]}, ${SIRIUS_MAG_RANGE[1]}]`)
check('brightest.isSirius',
  Math.abs(brightRa - SIRIUS_RA_DEG) <= SIRIUS_MATCH_TOL_DEG &&
  Math.abs(brightDec - SIRIUS_DEC_DEG) <= SIRIUS_MATCH_TOL_DEG,
  `ra=${brightRa.toFixed(4)}° dec=${brightDec.toFixed(4)}° 期望 ra≈${SIRIUS_RA_DEG} dec≈${SIRIUS_DEC_DEG}`)

// 直接回输入 JSON 里采矿，确认最亮那颗就是 Sirius（ra≈101.29, dec≈−16.72）
const inputBright = features
  .filter((f) => f && f.geometry && f.geometry.type === 'Point' && Number.isFinite(Number(f.properties && f.properties.mag)))
  .reduce((a, b) => (Number(b.properties.mag) < Number(a.properties.mag) ? b : a))
const inRa = ((Number(inputBright.geometry.coordinates[0]) % 360) + 360) % 360
const inDec = Number(inputBright.geometry.coordinates[1])
check('inputJSON.brightestIsSirius',
  Math.abs(inRa - SIRIUS_RA_DEG) <= SIRIUS_MATCH_TOL_DEG &&
  Math.abs(inDec - SIRIUS_DEC_DEG) <= SIRIUS_MATCH_TOL_DEG,
  `id=${inputBright.id} mag=${inputBright.properties.mag} ra=${inRa.toFixed(4)}° dec=${inDec.toFixed(4)}° bv=${inputBright.properties.bv}`)

const brightCount = stars.filter((s) => s.mag < BRIGHT_MAG_LIMIT).length

/* ============================================================
   4) 打印摘要 / 最亮 10 颗 / 机器可读块
   ============================================================ */
const order = stars.map((s, i) => i).sort((a, b) => stars[a].mag - stars[b].mag)
console.log('')
console.log('# 10 brightest (mag, ra, dec, bv)')
for (let k = 0; k < Math.min(10, order.length); k++) {
  const i = order[k]
  const s = stars[i]
  const o = HEADER_BYTES + i * RECORD_BYTES
  const dRa = decodeRa(disk.readUInt16LE(o))
  const dDec = decodeDec(disk.readUInt16LE(o + 2))
  const dBv = decodeBv(disk.readUInt8(o + 5))
  const bvText = s.bvMissing ? 'missing' : s.bv.toFixed(4)
  console.log(`  ${s.mag.toFixed(2)}, ${dRa.toFixed(4)}, ${dDec.toFixed(4)}, ${bvText}` +
    `  [decoded mag=${decodeMag(disk.readUInt8(o + 4)).toFixed(3)} bvQ=${disk.readUInt8(o + 5)} decodedBv=${dBv.toFixed(3)}]`)
}

const failed = checks.filter((c) => !c.ok)
console.log('')
console.log('--- SUMMARY (machine readable) ---')
console.log(`status=${failed.length === 0 ? 'ok' : 'failed'}`)
console.log(`input=${IN_FILE}`)
console.log(`output=${OUT_FILE}`)
console.log(`features=${features.length}`)
console.log(`count=${N}`)
console.log(`expected_count=${EXPECT_COUNT_HINT}`)
console.log(`count_delta=${N - EXPECT_COUNT_HINT}`)
console.log(`min_count=${minCount}`)
console.log(`skipped=${skipped}`)
console.log(`skipped_no_geometry=${skipReasons.noGeometry}`)
console.log(`skipped_bad_coordinates=${skipReasons.badCoordinates}`)
console.log(`skipped_bad_mag=${skipReasons.badMag}`)
console.log(`bv_missing=${bvMissingCount}`)
console.log(`mag_min=${magMin.toFixed(4)}`)
console.log(`mag_max=${magMax.toFixed(4)}`)
console.log(`bv_min=${bvMin.toFixed(4)}`)
console.log(`bv_max=${bvMax.toFixed(4)}`)
console.log(`dec_min=${decMin.toFixed(4)}`)
console.log(`dec_max=${decMax.toFixed(4)}`)
console.log(`brightest_mag_decoded=${brightMag.toFixed(4)}`)
console.log(`brightest_ra=${brightRa.toFixed(4)}`)
console.log(`brightest_dec=${brightDec.toFixed(4)}`)
console.log(`count_mag_lt_2=${brightCount}`)
console.log(`bytes=${outBytes}`)
console.log(`sha256=${sha256}`)
console.log(`checks_total=${checks.length}`)
console.log(`checks_failed=${failed.length}`)
for (const c of failed) console.log(`failed_check=${c.name}`)

if (failed.length > 0) {
  console.error('')
  console.error(`ASSERTION FAILED (${failed.length}/${checks.length}): ${failed.map((c) => c.name).join(', ')}`)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
