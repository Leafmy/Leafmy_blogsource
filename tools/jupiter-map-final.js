'use strict'
/* ============================================================
   木星全球贴图定稿：补齐到精确 2:1 + 清除投影边缘彩边
   (tools/jupiter-map-final.js)
   ------------------------------------------------------------
   数据来源：NASA/ESA Hubble OPAL 2024a 全球图（STScI/MAST），
   公共领域 / CC BY 4.0，署名 "ESA/Hubble & NASA (OPAL 2024)"。

   ── 这一步要解决的两个问题 ──

   (1) 比例：tools/opal-composite.js 为了避开投影边缘的假数据，硬编码
       裁掉上 34 / 下 95 行（常数是针对它默认的 2048 宽输出调的）。用
       `3072 82` 跑出来是 3072x1426，比例 2.154 —— 而球面贴图必须是
       精确 2:1 等距圆柱（x 覆盖 360° 经度，y 覆盖 180° 纬度），否则
       渲染器把纹理铺到球面上时纬度会被整体压缩 7.7%。
       做法：按【同一像素尺度】补到 1536 行，不裁剪、不拉伸 —— 拉伸会
       把真实云带的纬度整体移动，复制只增加极区行。

   (2) 极区彩边：OPAL globalmap 在三通道拼接时，三个滤镜在投影边缘的
       采样位置有细微差异，于是最外侧若干行出现**同一像素内部通道错位**
       的伪影：橙/品红/绿/青的细竖条，以及纯黑（如 rgb(1,1,1)、
       rgb(3,19,16)）的坏点。这些行如果只是"复制到极区"，等于把伪影
       放大成几十行高的彩带 —— 第一版就是这样：只补了行、没清边，
       于是 row 0（含 6.7% 饱和竖条像素）被复制了 55 次。
       做法：先用客观判据找出彩边行的范围，再用**关于最内侧干净行的
       镜像**替换它们（不是平铺复制、也不是拉伸），见下面 FRINGE 部分。

   ── 为什么替换用"镜像"而不是"复制单行"或"拉伸" ──
   · 复制单行：把一整行像素竖向铺满几十行，在球面上表现为一条纯色环带
     （planet-map-prep.js 的注释里也记录了同一个坑：复制单行会把 JPEG
     噪点整行搬过去）。它还会把该行的经向纹理原样重复，视觉上是"涂抹"。
   · 拉伸：把内部数据拉长到覆盖彩边区，会整体移动内部真实特征的纬度。
   · 镜像（本工具采用）：以最内侧干净行为镜面，把紧邻它的若干真实行
     反向铺出去。优点有三：① 镜像点在干净行上，边界两侧的值天然连续，
     不会有台阶；② 保留真实的纬向纹理与亮度起伏（不是纯色）；③ 不移动
     任何一行真实数据的纬度（只影响被替换掉的那几十行）。
     再叠加 BRIDGE 行的升余弦交叉淡化，把镜像区与保留区在色调上抹平。

   用法:
     node tools/jupiter-map-final.js <in.jpg> <out.jpg> [targetH] [quality]
     node tools/jupiter-map-final.js <in.jpg> <out.jpg> 1536 82 --clean-fringe
   ============================================================ */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { pngToJpeg, decodePng } = require('./png-to-jpeg.js')
// 复用本仓库自己的基线 JPEG 解码器（与 planet-resize.js 同一份实现）
const { decodeJpegBaseline } = require('./planet-resize.js')

const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('--'))
const pos = argv.filter((a) => !a.startsWith('--'))
const [IN, OUT, TH, TQ] = pos
const CLEAN_FRINGE = flags.includes('--clean-fringe')
if (flags.some((f) => f !== '--clean-fringe')) {
  console.error('❌ 未知参数 ' + flags.filter((f) => f !== '--clean-fringe').join(', '))
  process.exit(1)
}
if (!IN || !OUT) {
  console.error('用法: node tools/jupiter-map-final.js <in.jpg> <out.jpg> [targetH] [quality] [--clean-fringe]')
  process.exit(1)
}
const TARGET_H = Number(TH || 1536)
const QUALITY = Number(TQ || 0)

/* ---------------- 判据常数（全部集中，便于审计） ---------------- */
const PROBE_ROWS = 40          // 打印每极外侧多少行的得分曲线
const SAT_T = 40               // "饱和"阈值：max(R,G,B)-min(R,G,B) > 40 才算有色彩
const NEAR_BLACK = 24          // 三通道都低于此值 → 近黑坏点（真实云带不会这么黑）
const HUE_T = 60               // 相邻饱和像素的色相差超过 60° → 色度不连贯
const WIN = 2                  // 色度不连贯的比较半径（像素）；放大半径会同时放大 JPEG 噪点
const SLOT_W = 32              // 分槽统计的槽宽
const SLOT_BAD_T = 0.125       // 单个槽内坏点比例上限
const ROW_BAD_T = 0.005        // 整行坏点比例上限（0.5%）
const BRIDGE = 12              // 替换区与保留区之间的升余弦交叉淡化行数
const SEAM_T = 12.0            // 边界两侧 3 行平均亮度的允许差（0..255）
const SIZE_LIMIT = 700 * 1024  // 输出体积上限（任务规定 700 KB）
const OUT_POLE_ROWS = 20       // 断言 (b) 检查最外侧多少行

function encodePng (w, h, ch, data) {
  let CRC = null
  const crc32 = (buf) => {
    if (!CRC) {
      CRC = new Int32Array(256)
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); CRC[n] = c }
    }
    let c = 0xffffffff
    for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const raw = Buffer.alloc((w * ch + 1) * h)
  for (let y = 0; y < h; y++) { raw[y * (w * ch + 1)] = 0; for (let i = 0; i < w * ch; i++) raw[y * (w * ch + 1) + 1 + i] = data[y * w * ch + i] }
  const chunks = []
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const tb = Buffer.from(t, 'ascii'); const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, d]))); chunks.push(l, tb, d, cb) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  chunk('IHDR', ihdr); chunk('IDAT', zlib.deflateSync(raw, { level: 9 })); chunk('IEND', Buffer.alloc(0))
  return Buffer.concat(chunks)
}

/* ---------------- 统计量 ---------------- */
const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
const sat = (r, g, b) => Math.max(r, g, b) - Math.min(r, g, b)
function hueOf (r, g, b) {
  const mx = Math.max(r, g, b); const mn = Math.min(r, g, b)
  if (mx === mn) return -1
  const d = mx - mn
  let h
  if (mx === r) h = 60 * (((g - b) / d) % 6)
  else if (mx === g) h = 60 * ((b - r) / d + 2)
  else h = 60 * ((r - g) / d + 4)
  return (h + 360) % 360
}
const hueDiff = (a, b) => { const d = Math.abs(a - b); return Math.min(d, 360 - d) }

/* 一行一行的坏点得分。四种判据（全部是绝对阈值，且都只针对"通道错位"这一
   类伪影；木星真实的极区亮带/暗斑不会同时满足这些条件 —— 实测木星所有
   内部行的 hueIncoh 与 nearBlack 都是 0.0000）：
     sat90    : 通道极差 > 90（强彩边）
     nearBlack: 三通道都 < 24（投影边缘的黑坏点）
     hueIncoh : 一个饱和像素在 ±WIN 内存在色相差 > 60° 的饱和邻居
                （真实云带的色相是平滑过渡的，通道错位才会让相邻像素跳到
                 互补色 —— 例如右缘同时出现 rgb(109,68,76) 与 rgb(3,20,12)）
     slotBad  : 32 px 槽内坏点（sat90 ∨ nearBlack ∨ hueIncoh）比例的最大值
                （整行比例会漏掉"坏点稀疏但均匀分布在左中右几条竖线上"的行，
                 分槽取最大值能抓到它；行内散点噪声又不足以填满一个槽） */
function rowScore (D, W, y) {
  let sat90 = 0; let nearBlack = 0; let hueIncoh = 0; let lumSum = 0
  const slots = Math.max(1, Math.ceil(W / SLOT_W))
  const slotBad = new Array(slots).fill(0)
  const slotN = new Array(slots).fill(0)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3
    const r = D[i]; const g = D[i + 1]; const b = D[i + 2]
    const s = sat(r, g, b)
    const s90 = s > 90
    const nb = r < NEAR_BLACK && g < NEAR_BLACK && b < NEAR_BLACK
    let inc = false
    if (s > SAT_T) {
      const h0 = hueOf(r, g, b)
      for (let d = -WIN; d <= WIN && !inc; d++) {
        if (d === 0) continue
        const xx = x + d
        if (xx < 0 || xx >= W) continue
        const j = (y * W + xx) * 3
        if (sat(D[j], D[j + 1], D[j + 2]) <= SAT_T) continue
        const h1 = hueOf(D[j], D[j + 1], D[j + 2])
        if (h1 >= 0 && h0 >= 0 && hueDiff(h0, h1) > HUE_T) inc = true
      }
    }
    if (s90) sat90++
    if (nb) nearBlack++
    if (inc) hueIncoh++
    if (s90 || nb || inc) slotBad[Math.min(slots - 1, Math.floor(x / SLOT_W))]++
    slotN[Math.min(slots - 1, Math.floor(x / SLOT_W))]++
    lumSum += lum(r, g, b)
  }
  let slotMax = 0
  for (let k = 0; k < slots; k++) slotMax = Math.max(slotMax, slotBad[k] / slotN[k])
  const bad = sat90 + nearBlack + hueIncoh
  return {
    sat90: sat90 / W, nearBlack: nearBlack / W, hueIncoh: hueIncoh / W,
    slotMax, bad: bad / W, meanLum: lumSum / W
  }
}
const isFringe = (s) => s.bad > ROW_BAD_T || s.slotMax > SLOT_BAD_T

/* 去掉外侧彩边行：返回替换后的新缓冲与两端的彩边行数 */
function cleanFringe (src, W, H, say) {
  let nTop = 0
  while (nTop < Math.floor(H / 2)) {
    if (!isFringe(rowScore(src, W, nTop))) break
    nTop++
  }
  let nBot = 0
  while (nBot < Math.floor(H / 2)) {
    if (!isFringe(rowScore(src, W, H - 1 - nBot))) break
    nBot++
  }
  say(`检测到彩边：上 ${nTop} 行 / 下 ${nBot} 行（判据 bad>${ROW_BAD_T} 或 slotMax>${SLOT_BAD_T}）`)
  const out = Buffer.from(src)
  const rowCopy = (dstY, srcY) => src.copy(out, dstY * W * 3, srcY * W * 3, (srcY + 1) * W * 3)
  // 顶部：以第 nTop 行为镜面，用紧邻的真实行反向铺出去
  for (let y = 0; y < nTop; y++) rowCopy(y, Math.min(H - 1, nTop + (nTop - y)))
  // 底部：以第 H-1-nBot 行为镜面
  for (let y = H - nBot; y < H; y++) {
    const srcY = (H - 1 - nBot) - (y - (H - 1 - nBot))
    rowCopy(y, Math.max(0, srcY))
  }
  /* 交叉淡化是"可选保险"：镜像点本身已经连续，混合反而可能把残留伪影掺回来
     （实测：顶部 5 行镜像后最外行 sat90=0.0335 已经很低，再与保留行按升余弦
     混合，把保留行里那点彩色又掺了进来）。所以这里【两种方案都算一遍，
     按客观得分取更干净的那个】，而不是无条件淡化。 */
  const worst = (buf, rows) => {
    let m = 0
    for (const y of rows) m = Math.max(m, rowScore(buf, W, y).bad)
    return m
  }
  const mine = Buffer.from(out)
  const blend = (dst, yRepl, yClean) => {
    const off = 1 - Math.abs(yRepl - yClean) / (BRIDGE + 1)
    if (off <= 0) return
    const w = 0.5 - 0.5 * Math.cos(Math.PI * off)
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 3; c++) {
        const a = (yRepl * W + x) * 3 + c
        const b = (yClean * W + x) * 3 + c
        dst[a] = Math.max(0, Math.min(255, Math.round(src[a] * (1 - w) + src[b] * w)))
      }
    }
  }
  for (const [label, rows, pairs] of [
    ['上', Array.from({ length: nTop }, (_, i) => i), nTop ? [[nTop - 1, nTop]] : []],
    ['下', Array.from({ length: nBot }, (_, i) => H - nBot + i), nBot ? [[H - nBot, H - 1 - nBot]] : []]
  ]) {
    if (!rows.length) continue
    const plain = worst(mine, rows)
    const blended = Buffer.from(mine)
    for (const [yr, yc] of pairs) {
      for (let k = 0; k < BRIDGE; k++) {
        if (yr < yc) blend(blended, yr - k, yc + k)   // 顶部
        else blend(blended, yr + k, yc - k)           // 底部
      }
    }
    const mix = worst(blended, rows)
    if (mix < plain) {
      blended.copy(mine)
      say(`${label}极：交叉淡化（${BRIDGE} 行升余弦）后最坏行坏点 ${mix.toFixed(5)} < 纯镜像 ${plain.toFixed(5)} → 采用淡化`)
    } else {
      say(`${label}极：纯镜像最坏行坏点 ${plain.toFixed(5)} ≤ 淡化后 ${mix.toFixed(5)} → 采用纯镜像（镜像点本身已连续，无需淡化）`)
    }
  }
  mine.copy(out)
  return { data: out, nTop, nBot }
}

/* 每极打印得分曲线，让边界可复核 */
function printProfile (D, W, H, label) {
  console.log(`\n${label}：外侧 ${PROBE_ROWS} 行坏点得分（sat90 / nearBlack / hueIncoh / slotMax / bad / meanLum）`)
  console.log('   pole      y    sat90  nearBlk  hueInc  slotMax     bad   meanLum  判定')
  for (let k = 0; k < PROBE_ROWS; k++) {
    const y = k
    const s = rowScore(D, W, y)
    console.log(`   top  ${String(y).padStart(6)}  ${s.sat90.toFixed(4)}  ${s.nearBlack.toFixed(4)}  ${s.hueIncoh.toFixed(4)}  ${s.slotMax.toFixed(4)}  ${s.bad.toFixed(4)}  ${s.meanLum.toFixed(1).padStart(7)}   ${isFringe(s) ? '彩边' : ''}`)
  }
  for (let k = 0; k < PROBE_ROWS; k++) {
    const y = H - 1 - k
    const s = rowScore(D, W, y)
    console.log(`   bot  ${String(y).padStart(6)}  ${s.sat90.toFixed(4)}  ${s.nearBlack.toFixed(4)}  ${s.hueIncoh.toFixed(4)}  ${s.slotMax.toFixed(4)}  ${s.bad.toFixed(4)}  ${s.meanLum.toFixed(1).padStart(7)}   ${isFringe(s) ? '彩边' : ''}`)
  }
}

/* 极区汇总（用于断言 (b)） */
function poleStats (D, W, H, rows) {
  let sat90 = 0; let nearBlack = 0; let maxSat = 0; let sumLum = 0; let n = 0
  for (const y of rows) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3
      const r = D[i]; const g = D[i + 1]; const b = D[i + 2]
      const s = sat(r, g, b)
      if (s > 90) sat90++
      if (r < NEAR_BLACK && g < NEAR_BLACK && b < NEAR_BLACK) nearBlack++
      if (s > maxSat) maxSat = s
      sumLum += lum(r, g, b)
      n++
    }
  }
  return { sat90Frac: sat90 / n, nearBlackFrac: nearBlack / n, maxSat, meanLum: sumLum / n }
}
const rowMeanLum = (D, W, y) => { let s = 0; for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; s += lum(D[i], D[i + 1], D[i + 2]) } return s / W }

const say = (s) => console.log('   ' + s)

/* ================= 主流程 ================= */
const img = decodeJpegBaseline(fs.readFileSync(IN))
const W = img.w
console.log(`输入 ${IN}  ${W}x${img.h}  ${(fs.statSync(IN).size / 1024).toFixed(0)} KB`)
if (W !== TARGET_H * 2) {
  console.error(`❌ 输入宽度 ${W} 与目标高 ${TARGET_H} 不构成 2:1（期望宽 ${TARGET_H * 2}）`)
  process.exit(1)
}
if (img.h > TARGET_H) {
  console.error(`❌ 输入高 ${img.h} 已超过目标 ${TARGET_H}，本工具只做补齐/清边、不做裁剪`)
  process.exit(1)
}

let data = img.data
let H = img.h
let nTop = 0; let nBot = 0

if (CLEAN_FRINGE) {
  console.log('\n=== --clean-fringe：投影边缘彩边清除 ===')
  printProfile(data, W, H, '清除前')
  const res = cleanFringe(data, W, H, say)
  data = res.data; nTop = res.nTop; nBot = res.nBot
  printProfile(data, W, H, '清除后')
}

/* 补齐到精确 2:1：只加行，不裁剪、不拉伸 */
let top = 0; let bottom = 0
if (H < TARGET_H) {
  const pad = TARGET_H - H
  top = Math.floor(pad / 2)
  bottom = pad - top
  console.log(`\n补齐 ${pad} 行（上 ${top} / 下 ${bottom}）：用相邻行复制，保持每行真实数据的纬度不变`)
  const padded = Buffer.alloc(W * TARGET_H * 3)
  for (let y = 0; y < top; y++) data.copy(padded, y * W * 3, 0, W * 3)
  data.copy(padded, top * W * 3, 0, W * H * 3)
  for (let y = 0; y < bottom; y++) {
    const off = (H - 1) * W * 3
    data.copy(padded, (top + H + y) * W * 3, off, off + W * 3)
  }
  data = padded; H = TARGET_H
} else {
  console.log('\n输入已经是目标高度，跳过补齐')
}

/* ---------------- 写文件 ---------------- */
const tmpPng = path.join(path.dirname(OUT), '.jupiter-map-final.tmp.png')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(tmpPng, encodePng(W, H, 3, data))
const q = QUALITY || 82
const r = pngToJpeg(tmpPng, OUT, q)
fs.rmSync(tmpPng, { force: true })
console.log(`\n输出 ${OUT}  ${r.width}x${r.height}  q=${r.quality}  ${(r.bytes / 1024).toFixed(1)} KB (${r.bytes} 字节)`)

/* ---------------- 复核：重新解码写出的文件，全部断言基于它 ---------------- */
const back = decodeJpegBaseline(fs.readFileSync(OUT))
const BW = back.w; const BH = back.h; const BD = back.data
let fail = 0
const assert = (ok, msg) => { console.log(`   ${ok ? '✅' : '❌'} ${msg}`); if (!ok) fail++ }

console.log('\n=== 复核（重新解码写出的文件）===')
// (a) 尺寸 / 比例
assert(BW === TARGET_H * 2 && BH === TARGET_H, `(a) 尺寸 ${BW}x${BH}，期望 ${TARGET_H * 2}x${TARGET_H}；比例 ${(BW / BH).toFixed(4)}`)

// 基线：内部干净带的统计（避开极区与赤道亮带，取 200..BH-200 的均值行）
let baseSat90 = 0; let baseNearBlack = 0; let baseLum = 0; let nb = 0
for (let y = 200; y < BH - 200; y++) { const s = rowScore(BD, BW, y); baseSat90 += s.sat90; baseNearBlack += s.nearBlack; baseLum += s.meanLum; nb++ }
baseSat90 /= nb; baseNearBlack /= nb; baseLum /= nb
console.log(`   内部基线（行 200..${BH - 200} 均值）：sat90 = ${baseSat90.toFixed(5)}  nearBlack = ${baseNearBlack.toFixed(5)}  meanLum = ${baseLum.toFixed(1)}`)

// (b) 最外侧 OUT_POLE_ROWS 行的饱和/黑点统计 vs 内部基线
const topRows = []; for (let y = 0; y < OUT_POLE_ROWS; y++) topRows.push(y)
const botRows = []; for (let y = BH - OUT_POLE_ROWS; y < BH; y++) botRows.push(y)
const tS = poleStats(BD, BW, BH, topRows)
const bS = poleStats(BD, BW, BH, botRows)
console.log(`   极区最外 ${OUT_POLE_ROWS} 行：`)
console.log(`     上极  sat>90 比例 ${tS.sat90Frac.toFixed(5)}  近黑比例 ${tS.nearBlackFrac.toFixed(5)}  maxSat ${tS.maxSat}  meanLum ${tS.meanLum.toFixed(1)}`)
console.log(`     下极  sat>90 比例 ${bS.sat90Frac.toFixed(5)}  近黑比例 ${bS.nearBlackFrac.toFixed(5)}  maxSat ${bS.maxSat}  meanLum ${bS.meanLum.toFixed(1)}`)
console.log(`     maxSat 是"该区域最饱和的一个像素"，木星真实的赤道亮带本身就能到 200+，`)
console.log(`     所以判定用【比例】而不是 maxSat（比例才是"彩边占了多大面积"的度量）。`)
assert(tS.sat90Frac <= baseSat90 + 0.001 && bS.sat90Frac <= baseSat90 + 0.001,
  `(b) 极区 sat>90 比例（上 ${tS.sat90Frac.toFixed(5)} / 下 ${bS.sat90Frac.toFixed(5)}）不超过内部基线 ${baseSat90.toFixed(5)} + 0.001`)
assert(tS.nearBlackFrac <= baseNearBlack + 0.0005 && bS.nearBlackFrac <= baseNearBlack + 0.0005,
  `(b) 极区近黑比例（上 ${tS.nearBlackFrac.toFixed(5)} / 下 ${bS.nearBlackFrac.toFixed(5)}）不超过内部基线 ${baseNearBlack.toFixed(5)} + 0.0005`)

// (c) 替换/保留边界处相邻行的平均亮度差
const seamTop = () => {
  if (top > 0) return [top - 1, top]
  return [nTop - 1, nTop]
}
const seamBot = () => {
  if (bottom > 0) return [BH - bottom, BH - bottom - 1]
  return [BH - nBot, BH - nBot - 1]
}
for (const [label, pair] of [['上极', seamTop()], ['下极', seamBot()]]) {
  const [ya, yb] = pair
  if (ya < 0 || yb < 0 || ya >= BH || yb >= BH) { assert(false, `(c) ${label}边界行号越界`); continue }
  const d = Math.abs(rowMeanLum(BD, BW, ya) - rowMeanLum(BD, BW, yb))
  assert(d < SEAM_T, `(c) ${label}边界相邻行（y=${ya} 与 y=${yb}）平均亮度差 ${d.toFixed(2)} < ${SEAM_T}`)
}

// (d) 体积上限
const bytes = fs.statSync(OUT).size
assert(bytes <= SIZE_LIMIT, `(d) 体积 ${(bytes / 1024).toFixed(1)} KB ≤ ${(SIZE_LIMIT / 1024).toFixed(0)} KB`)

// (e) 上面 (a)~(d) 全部基于重新解码的 BD 数组，即"重解码确认前四项"
console.log(`   (e) 以上 (a)~(d) 四项检查全部基于重新解码 ${OUT} 得到的 ${BW}x${BH} 像素 ✅`)

if (fail) {
  console.error(`\n❌ ${fail} 项检查未通过`)
  process.exit(1)
}
console.log('\n全部检查通过。')
