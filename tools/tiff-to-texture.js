'use strict'
/* ============================================================
   TIFF → JPEG：把 STScI/OPAL 的全球贴图转成网站用的纹理
   ------------------------------------------------------------
   为什么需要它：OPAL 官方产出的 Jupiter 全球图是 TIFF（3600x1800、
   8bit RGB、PlanarConfiguration=2 即 R/G/B 三平面分开存放）。本机没有
   sharp / jimp / ImageMagick（system32 的 convert.exe 是磁盘转换工具，
   不是 ImageMagick），所以这里直接按 TIFF 规范读取条带并把三个平面合并
   成 RGB，再交给自写的 JPEG 编码器输出。

   为什么不用自己从照片反解贴图：OPAL 的 globalmap 本身就是把多次观测
   拼接、去投影（ellipsoid limb-fitting）后的 360° 科学产品 —— 经度
   覆盖完整、光照已做归一化，比用单张全圆盘照片反推可靠得多，也彻底
   解决了"背面 180° 只能编"的问题。

   用法: node tools/tiff-to-texture.js <in.tif> <out.jpg> [width] [quality]
   ============================================================ */

const fs = require('fs')
const { pngToJpeg } = require('./png-to-jpeg.js')

const SRC = process.argv[2]
const OUT = process.argv[3]
const TARGET_W = Number(process.argv[4] || 2048)
const QUALITY = Number(process.argv[5] || 90)

if (!SRC || !OUT || !fs.existsSync(SRC)) {
  console.error('用法: node tools/tiff-to-texture.js <in.tif> <out.jpg> [width] [quality]')
  process.exit(1)
}

/* ---------------- 最小 TIFF 读取（8bit、条带、PlanarConfiguration=2）---------------- */
function readTiff (path) {
  const b = fs.readFileSync(path)
  const le = b[0] === 0x49
  const rd16 = (o) => le ? b[o] + (b[o + 1] << 8) : (b[o] << 8) + b[o + 1]
  const rd32 = (o) => le
    ? b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + b[o + 3] * 16777216
    : b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
  if (rd16(2) !== 42) throw new Error('不是标准 TIFF')

  const ifd = rd32(4)
  const n = rd16(ifd)
  const tags = {}
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    tags[rd16(e)] = { type: rd16(e + 2), count: rd32(e + 4), entry: e }
  }
  const raw = (tag) => {
    const t = tags[tag]
    return t ? (t.type === 3 ? rd16(t.entry + 8) : rd32(t.entry + 8)) : undefined
  }
  const list = (tag) => {
    const t = tags[tag]
    if (!t) return []
    const out = []
    const size = (t.type === 3 ? 2 : 4) * t.count
    const off = size > 4 ? rd32(t.entry + 8) : (t.entry + 8)
    for (let i = 0; i < t.count; i++) out.push(t.type === 3 ? rd16(off + i * 2) : rd32(off + i * 4))
    return out
  }

  const W = raw(256); const H = raw(257)
  const spp = raw(277) || 1
  const planar = raw(284) || 1
  const compression = raw(259) || 1
  const bps = list(258)
  if (compression !== 1) throw new Error('仅支持未压缩 TIFF，实际 Compression=' + compression)
  if (spp !== 3) throw new Error('仅支持 3 通道，实际 SamplesPerPixel=' + spp)
  if (bps.some((v) => v !== 8)) throw new Error('仅支持 8bit，实际 ' + JSON.stringify(bps))

  const offsets = list(273)
  const counts = list(279)
  const rowsPerStrip = raw(278) || H
  console.log(`TIFF ${W}x${H}  通道 ${spp}  PlanarConfig ${planar}  ` +
    `条带 ${offsets.length} 条 x ${rowsPerStrip} 行`)

  const rgb = Buffer.alloc(W * H * 3)
  if (planar === 2) {
    // 三个平面分开存放：plane = stripIndex / (W*H / (rowsPerStrip*W)) …更稳妥地按
    // "每条带的字节数 = rowsPerStrip*W" 推出平面归属
    const stripsPerPlane = Math.ceil(H / rowsPerStrip)
    for (let p = 0; p < 3; p++) {
      for (let s = 0; s < stripsPerPlane; s++) {
        const idx = p * stripsPerPlane + s
        if (idx >= offsets.length) break
        const off = offsets[idx]
        const len = counts[idx] || (rowsPerStrip * W)
        const rowStart = s * rowsPerStrip
        const rows = Math.min(rowsPerStrip, H - rowStart)
        for (let r = 0; r < rows; r++) {
          for (let x = 0; x < W; x++) {
            rgb[((rowStart + r) * W + x) * 3 + p] = b[off + r * W + x]
          }
        }
      }
    }
  } else {
    // 交错存放
    let row = 0
    for (let s = 0; s < offsets.length; s++) {
      const off = offsets[s]
      const rows = Math.min(rowsPerStrip, H - row)
      for (let r = 0; r < rows; r++) {
        for (let x = 0; x < W; x++) {
          const si = off + (r * W + x) * 3
          const di = ((row + r) * W + x) * 3
          rgb[di] = b[si]; rgb[di + 1] = b[si + 1]; rgb[di + 2] = b[si + 2]
        }
      }
      row += rows
    }
  }
  return { W, H, rgb }
}

function main () {
  const t = readTiff(SRC)

  // 缩放（面积平均，避免最近邻的锯齿）
  const scale = TARGET_W / t.W
  const W = TARGET_W
  const H = Math.round(t.H * scale)
  console.log(`输出 ${W}x${H}（缩放 ${(scale * 100).toFixed(1)}%）`)
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) {
    const sy0 = Math.floor(y / scale)
    const sy1 = Math.min(t.H, Math.max(sy0 + 1, Math.ceil((y + 1) / scale)))
    for (let x = 0; x < W; x++) {
      const sx0 = Math.floor(x / scale)
      const sx1 = Math.min(t.W, Math.max(sx0 + 1, Math.ceil((x + 1) / scale)))
      let r = 0; let g = 0; let bl = 0; let n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * t.W + sx) * 3
          r += t.rgb[i]; g += t.rgb[i + 1]; bl += t.rgb[i + 2]; n++
        }
      }
      const di = (y * W + x) * 4
      out[di] = Math.round(r / n)
      out[di + 1] = Math.round(g / n)
      out[di + 2] = Math.round(bl / n)
      out[di + 3] = 255
    }
  }

  // 写 PNG（无压缩封装交给 zlib）再转 JPEG
  const zlib = require('zlib')
  const rawScan = Buffer.alloc((W * 4 + 1) * H)
  for (let y = 0; y < H; y++) {
    rawScan[y * (W * 4 + 1)] = 0
    out.copy(rawScan, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4)
  }
  const idat = zlib.deflateSync(rawScan, { level: 9 })
  const chunks = []
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
  const tmpPng = OUT.replace(/\.jpg$/, '.tmp.png')
  fs.mkdirSync(require('path').dirname(OUT), { recursive: true })
  fs.writeFileSync(tmpPng, Buffer.concat(chunks))

  const r = pngToJpeg(tmpPng, OUT, QUALITY)
  fs.rmSync(tmpPng, { force: true })
  console.log(`输出 ${OUT}  ${r.width}x${r.height}  ${(r.bytes / 1024).toFixed(0)} KB  q=${QUALITY}`)
}

main()
