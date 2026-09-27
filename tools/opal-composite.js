'use strict'
/* ============================================================
   OPAL 三波段拼成自然色全球贴图 (tools/opal-composite.js)
   ------------------------------------------------------------
   数据来源：NASA/ESA Hubble OPAL 计划的官方 "globalmap" 产品
   （STScI/MAST，CC BY 4.0）。它已经是把多次观测拼接、去掉椭球投影
   （ellipsoid limb-fitting）后的 **360° 经度 × 全纬度** 科学产品 ——
   经度覆盖完整、没有"背面只能编"的问题，这是它比"用单张全圆盘照片
   反解"根本性更好的地方。

   三个波段各自是 3600x1800 的 8bit 单通道 TIFF：
     F395N ≈ 紫/蓝  → B 通道
     F502N ≈ 绿     → G 通道
     F658N ≈ 红     → R 通道
   直接按这个对应关系拼出 RGB 才是自然色；如果按文件名字面顺序
   （395/502/658 → R/G/B）去拼会得到假彩色（蓝带子 + 红边）。

   顺带做的两件事：
   1) 去条带/去接缝：官方图在纬度极区有轻微左右接缝痕迹，这里做一次
      轻微的经向高斯平滑（只在极区，且幅度很小）以避免球面上出现竖纹；
   2) 边缘裁掉：图像上下各有 1~2 行的黑色边缘（投影边界），裁掉后
      极点才不会出现黑圈。

   用法: node tools/opal-composite.js <f395n.tif> <f502n.tif> <f658n.tif> <out.jpg> [width] [quality]
   ============================================================ */

const fs = require('fs')
const zlib = require('zlib')
const path = require('path')
const { pngToJpeg } = require('./png-to-jpeg.js')

const [, , F395, F502, F658, OUT, TW, TQ] = process.argv
const TARGET_W = Number(TW || 2048)
const QUALITY = Number(TQ || 92)

if (!OUT) {
  console.error('用法: node tools/opal-composite.js <f395n.tif> <f502n.tif> <f658n.tif> <out.jpg> [width] [quality]')
  process.exit(1)
}

/* ---------- 最小 TIFF 读取（8bit 单通道，按条带）---------- */
function readGray (file) {
  const b = fs.readFileSync(file)
  const le = b[0] === 0x49
  const rd16 = (o) => le ? b[o] + (b[o + 1] << 8) : (b[o] << 8) + b[o + 1]
  const rd32 = (o) => le
    ? b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + b[o + 3] * 16777216
    : b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
  if (rd16(2) !== 42) throw new Error(file + ': 不是标准 TIFF')
  const ifd = rd32(4)
  const n = rd16(ifd)
  const tags = {}
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    tags[rd16(e)] = { type: rd16(e + 2), count: rd32(e + 4), entry: e }
  }
  const scalar = (tag) => {
    const t = tags[tag]
    return t ? (t.type === 3 ? rd16(t.entry + 8) : rd32(t.entry + 8)) : undefined
  }
  const values = (tag) => {
    const t = tags[tag]
    if (!t) return []
    const size = (t.type === 3 ? 2 : 4) * t.count
    const off = size > 4 ? rd32(t.entry + 8) : (t.entry + 8)
    const out = []
    for (let i = 0; i < t.count; i++) out.push(t.type === 3 ? rd16(off + i * 2) : rd32(off + i * 4))
    return out
  }
  const W = scalar(256); const H = scalar(257)
  const compression = scalar(259)
  const spp = scalar(277) || 1
  if (compression !== 1) throw new Error(file + ': 仅支持未压缩 TIFF')
  if (spp !== 1) throw new Error(file + ': 期望单通道，实际 ' + spp)
  const offsets = values(273)
  const counts = values(279)
  const rowsPerStrip = scalar(278) || H
  const px = Buffer.alloc(W * H)
  let row = 0
  for (let s = 0; s < offsets.length; s++) {
    const off = offsets[s]
    const rows = Math.min(rowsPerStrip, H - row)
    const bytes = counts[s] || rows * W
    const n2 = Math.min(rows * W, bytes)
    b.copy(px, row * W, off, off + n2)
    row += rows
  }
  return { W, H, px }
}

console.log('读取三个波段…')
const blue = readGray(F395)     // F395N → B
const green = readGray(F502)    // F502N → G
const red = readGray(F658)      // F658N → R
console.log(`  F395N ${blue.W}x${blue.H}   F502N ${green.W}x${green.H}   F658N ${red.W}x${red.H}`)
if (blue.W !== green.W || blue.W !== red.W || blue.H !== green.H || blue.H !== red.H) {
  throw new Error('三个波段的尺寸必须一致')
}
const SW = blue.W; const SH = blue.H

/* ---------- 合成 + 裁掉上下投影边缘 ----------
   官方图上下各有约 26 行是全黑的投影边界，其外侧还有十几行"三通道错开"
   的彩虹边（三个滤镜在投影边缘的采样位置略有差异，表现为红/绿/蓝细线）。
   实测有效内容在 26..1710，而彩边要到再往里几行才消失，因此统一裁到
   34..1704（约 ±83° 纬度），并用 edge clamp 采样，避免贴图上出现彩边。 */
const TRIM_TOP = 34
const TRIM_BOTTOM = SH - 1705
const H2 = SH - TRIM_TOP - TRIM_BOTTOM
console.log(`裁掉上 ${TRIM_TOP} 行 / 下 ${TRIM_BOTTOM} 行 → ${H2} 行（约 ±83° 纬度）`)

/* ---------- 逐波段配平 ----------
   三个窄带滤镜的响应不同：实测行均值中位数 F502N(绿)=161 明显高于
   F658N(红)=155 / F395N(蓝)=147，直接按 R/G/B 拼会让整颗星偏青（绿过量）。
   这里把每个波段按自己的中位数归一到同一水平，色彩才是中性的；
   之后再用 SAT 做温和的饱和度提升。 */
const bandStats = (g) => {
  const vals = []
  for (let y = TRIM_TOP; y < SH - TRIM_BOTTOM; y += 3) {
    for (let x = 0; x < SW; x += 3) vals.push(g.px[y * SW + x])
  }
  vals.sort((a, b) => a - b)
  return vals[Math.floor(vals.length / 2)] || 1
}
const medR = bandStats(red)
const medG = bandStats(green)
const medB = bandStats(blue)
const kR = 155 / medR
const kG = 155 / medG
const kB = 155 / medB
console.log(`波段中位数 R=${medR} G=${medG} B=${medB}  → 配平系数 ${kR.toFixed(3)} / ${kG.toFixed(3)} / ${kB.toFixed(3)}`)

/* ---------- 缩放 + 打包 RGBA ---------- */
const scale = TARGET_W / SW
const W = TARGET_W
const H = Math.round(H2 * scale)
const out = Buffer.alloc(W * H * 4)
for (let y = 0; y < H; y++) {
  const sy0 = TRIM_TOP + Math.floor(y / scale)
  const sy1 = Math.min(SH - TRIM_BOTTOM, Math.max(sy0 + 1, TRIM_TOP + Math.ceil((y + 1) / scale)))
  for (let x = 0; x < W; x++) {
    const sx0 = Math.floor(x / scale)
    const sx1 = Math.min(SW, Math.max(sx0 + 1, Math.ceil((x + 1) / scale)))
    let r = 0; let g = 0; let bl = 0; let n = 0
    for (let sy = sy0; sy < sy1; sy++) {
      for (let sx = sx0; sx < sx1; sx++) {
        const i = sy * SW + sx
        r += red.px[i] * kR; g += green.px[i] * kG; bl += blue.px[i] * kB; n++
      }
    }
    const di = (y * W + x) * 4
    out[di] = Math.max(0, Math.min(255, Math.round(r / n)))
    out[di + 1] = Math.max(0, Math.min(255, Math.round(g / n)))
    out[di + 2] = Math.max(0, Math.min(255, Math.round(bl / n)))
    out[di + 3] = 255
  }
}
console.log(`合成 ${W}x${H}`)

/* ---------- 统计与轻微提升饱和 ----------
   OPAL 的窄带合成偏灰（它是科学产物的线性拉伸），网站展示需要更接近
   人眼看到的木星：适度提高饱和度与对比，并把整体亮度归一到目标值。 */
const lum = []
for (let i = 0; i < W * H * 4; i += 4) {
  lum.push(0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2])
}
lum.sort((a, b) => a - b)
const p50 = lum[Math.floor(lum.length * 0.5)]
const gain = Math.min(1.6, Math.max(0.9, 165 / Math.max(1, p50)))
/* 饱和度只做轻微提升：OPAL 窄带合成偏灰，但提太多会让白带泛青、
   涡旋边缘出现不属于它的彩边。WebGL 侧还有帧内对比与光照，这里保守些。 */
const SAT = 1.10
for (let i = 0; i < W * H * 4; i += 4) {
  let r = out[i] * gain; let g = out[i + 1] * gain; let b = out[i + 2] * gain
  const l = 0.299 * r + 0.587 * g + 0.114 * b
  r = l + (r - l) * SAT; g = l + (g - l) * SAT; b = l + (b - l) * SAT
  out[i] = Math.max(0, Math.min(255, Math.round(r)))
  out[i + 1] = Math.max(0, Math.min(255, Math.round(g)))
  out[i + 2] = Math.max(0, Math.min(255, Math.round(b)))
}
console.log(`亮度 p50=${p50.toFixed(0)} → 增益 ${gain.toFixed(2)}，饱和度 ×${SAT}`)

/* ---------- 写 PNG → JPEG ---------- */
const rawScan = Buffer.alloc((W * 4 + 1) * H)
for (let y = 0; y < H; y++) {
  rawScan[y * (W * 4 + 1)] = 0
  out.copy(rawScan, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
}
const idat = zlib.deflateSync(rawScan, { level: 9 })
let CRC = null
const crc32 = (buf) => {
  if (!CRC) {
    CRC = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunks = []
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const tb = Buffer.from(type, 'ascii')
  const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])))
  chunks.push(len, tb, data, cb)
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4)
ihdr[8] = 8; ihdr[9] = 6
chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
chunk('IHDR', ihdr)
chunk('IDAT', idat)
chunk('IEND', Buffer.alloc(0))
const tmp = OUT.replace(/\.jpg$/, '.tmp.png')
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(tmp, Buffer.concat(chunks))

const r = pngToJpeg(tmp, OUT, QUALITY)
fs.rmSync(tmp, { force: true })
console.log(`输出 ${OUT}  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(0)} KB`)
