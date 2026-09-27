'use strict'
/* ============================================================
   极简 PNG → JPEG 转码 (tools/png-to-jpeg.js)
   ------------------------------------------------------------
   为什么需要它：本机没有 sharp / jimp 这类原生图像库，而 Chrome 的
   --screenshot 只能输出 PNG。木星云带是连续渐变，PNG 无损要 600KB+，
   换 JPEG(q90) 只要约 1/4，页面加载负担小得多。

   实现：自己写一个 Baseline JPEG 编码器（标准亮度/色度量化表 +
   Huffman 表，4:2:0 色度抽样）。代码量比引入依赖小，且完全可控。
   仅支持 8bit RGB/RGBA 输入（本项目的截图正好是这两种）。

   用法（模块）：const { pngToJpeg } = require('./png-to-jpeg.js')
                pngToJpeg('in.png', 'out.jpg', 90)
   用法（命令行）：node tools/png-to-jpeg.js in.png out.jpg [quality]
   ============================================================ */

const fs = require('fs')
const zlib = require('zlib')

/* ---------------- PNG 解码 ---------------- */
function decodePng (buf) {
  let p = 8; let w = 0; let h = 0; let ct = 0; let bd = 0
  const idat = []
  while (p < buf.length) {
    const L = buf.readUInt32BE(p)
    const t = buf.toString('ascii', p + 4, p + 8)
    const d = buf.slice(p + 8, p + 8 + L)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); bd = d[8]; ct = d[9] }
    else if (t === 'IDAT') idat.push(d)
    else if (t === 'IEND') break
    p += 12 + L
  }
  if (bd !== 8) throw new Error('只支持 8bit PNG')
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : 0
  if (!ch) throw new Error('不支持的颜色类型 ' + ct)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const st = w * ch
  const out = Buffer.alloc(w * h * ch)
  let prev = Buffer.alloc(st); let rp = 0
  for (let y = 0; y < h; y++) {
    const f = raw[rp++]
    const line = Buffer.from(raw.slice(rp, rp + st)); rp += st
    for (let x = 0; x < st; x++) {
      const a = x >= ch ? line[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let v = line[x]
      if (f === 1) v += a
      else if (f === 2) v += b
      else if (f === 3) v += (a + b) >> 1
      else if (f === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a); const pb = Math.abs(pp - b); const pc = Math.abs(pp - c)
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
      }
      line[x] = v & 255
    }
    line.copy(out, y * st)
    prev = line
  }
  return { w, h, ch, data: out }
}

/* ---------------- JPEG 标准表 ---------------- */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
]

const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
]
const STD_CHROMA_Q = [
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99
]

// 标准 Huffman 表（DC/AC，亮度/色度）
const BITS_DC_L = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const VAL_DC_L = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const BITS_DC_C = [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]
const VAL_DC_C = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
const BITS_AC_L = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const VAL_AC_L = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
  0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
  0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
  0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
  0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
  0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
]
const BITS_AC_C = [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]
const VAL_AC_C = [
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
  0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
  0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
  0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
  0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
  0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
  0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
  0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
  0xf9, 0xfa
]

function buildHuffTable (bits, vals) {
  const table = {}
  let code = 0; let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) {
      table[vals[k]] = { code: code, len: len }
      code++; k++
    }
    code <<= 1
  }
  return table
}

const HUFF_DC_L = buildHuffTable(BITS_DC_L, VAL_DC_L)
const HUFF_DC_C = buildHuffTable(BITS_DC_C, VAL_DC_C)
const HUFF_AC_L = buildHuffTable(BITS_AC_L, VAL_AC_L)
const HUFF_AC_C = buildHuffTable(BITS_AC_C, VAL_AC_C)

/* ---------------- 位写入器 ---------------- */
function BitWriter () {
  this.buf = []
  this.acc = 0
  this.n = 0
}
BitWriter.prototype.write = function (code, len) {
  for (let i = len - 1; i >= 0; i--) {
    this.acc = (this.acc << 1) | ((code >> i) & 1)
    this.n++
    if (this.n === 8) {
      this.buf.push(this.acc & 0xff)
      // 字节填充：0xFF 后必须补 0x00
      if ((this.acc & 0xff) === 0xff) this.buf.push(0)
      this.acc = 0; this.n = 0
    }
  }
}
BitWriter.prototype.flush = function () {
  while (this.n > 0) this.write(1, 1)   // 用 1 填充到最后
  return Buffer.from(this.buf)
}

/* ---------------- DCT（8x8，分离式） ---------------- */
const COS = []
for (let u = 0; u < 8; u++) {
  COS.push([])
  for (let x = 0; x < 8; x++) COS[u].push(Math.cos((2 * x + 1) * u * Math.PI / 16))
}
const C = []
for (let u = 0; u < 8; u++) C.push(u === 0 ? Math.SQRT1_2 : 1)

function fdct (block) {
  const tmp = new Float32Array(64)
  const out = new Float32Array(64)
  for (let y = 0; y < 8; y++) {
    for (let u = 0; u < 8; u++) {
      let s = 0
      for (let x = 0; x < 8; x++) s += block[y * 8 + x] * COS[u][x]
      tmp[y * 8 + u] = s * C[u] / 2
    }
  }
  for (let u = 0; u < 8; u++) {
    for (let v = 0; v < 8; v++) {
      let s = 0
      for (let y = 0; y < 8; y++) s += tmp[y * 8 + u] * COS[v][y]
      out[v * 8 + u] = s * C[v] / 2
    }
  }
  return out
}

function quantize (coef, qtable, out) {
  for (let i = 0; i < 64; i++) {
    out[i] = Math.round(coef[i] / qtable[i])
  }
}

function category (v) {
  let a = Math.abs(v); let n = 0
  while (a) { a >>= 1; n++ }
  return n
}

function encodeBlock (bw, zz, prevDC, dcTable, acTable) {
  // DC
  const diff = zz[0] - prevDC
  const cat = category(diff)
  const dcCode = dcTable[cat]
  bw.write(dcCode.code, dcCode.len)
  if (cat > 0) {
    const v = diff < 0 ? diff - 1 : diff
    bw.write(v & ((1 << cat) - 1), cat)
  }
  // AC
  let run = 0
  for (let i = 1; i < 64; i++) {
    if (zz[i] === 0) { run++; continue }
    while (run > 15) {
      const zrl = acTable[0xf0]
      bw.write(zrl.code, zrl.len)
      run -= 16
    }
    const cat2 = category(zz[i])
    const sym = (run << 4) | cat2
    const code = acTable[sym]
    bw.write(code.code, code.len)
    const v = zz[i] < 0 ? zz[i] - 1 : zz[i]
    bw.write(v & ((1 << cat2) - 1), cat2)
    run = 0
  }
  if (run > 0) {
    const eob = acTable[0x00]
    bw.write(eob.code, eob.len)
  }
  return zz[0]
}

/* ---------------- 主编码 ---------------- */
function pngToJpeg (inPath, outPath, quality) {
  const q = Math.min(100, Math.max(1, quality || 90))
  // 量化表按质量缩放（libjpeg 的经典公式）
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2
  const lq = STD_LUMA_Q.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))
  const cq = STD_CHROMA_Q.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))))

  const img = decodePng(fs.readFileSync(inPath))
  const { w, h, ch, data } = img

  // RGB → YCbCr，并按 2x2 平均做 4:2:0 色度抽样
  const Y = new Float32Array(w * h)
  const Cb = new Float32Array(w * h)
  const Cr = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * ch
      const r = data[i]; const g = data[i + 1]; const b = data[i + 2]
      Y[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128
      Cb[y * w + x] = -0.168736 * r - 0.331264 * g + 0.5 * b
      Cr[y * w + x] = 0.5 * r - 0.418688 * g - 0.081312 * b
    }
  }

  const bw = new BitWriter()

  // SOI
  bw.buf.push(0xff, 0xd8)
  const seg = (marker, payload) => {
    bw.buf.push(0xff, marker)
    bw.buf.push((payload.length + 2) >> 8, (payload.length + 2) & 0xff)
    for (const v of payload) bw.buf.push(v)
  }

  // APP0 (JFIF)
  seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])

  // DQT
  const dqt = []
  for (let i = 0; i < 64; i++) dqt.push(lq[ZIGZAG[i]])
  seg(0xdb, [0x00].concat(dqt))
  const dqtC = []
  for (let i = 0; i < 64; i++) dqtC.push(cq[ZIGZAG[i]])
  seg(0xdb, [0x01].concat(dqtC))

  // SOF0：3 分量，Y 2x2 抽样，Cb/Cr 1x1
  seg(0xc0, [
    0x08,
    h >> 8, h & 0xff,
    w >> 8, w & 0xff,
    0x03,
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01
  ])

  // DHT
  const dht = (cls, id, bits, vals) => seg(0xc4, [((cls << 4) | id)].concat(bits, vals))
  dht(0, 0, BITS_DC_L, VAL_DC_L)
  dht(1, 0, BITS_AC_L, VAL_AC_L)
  dht(0, 1, BITS_DC_C, VAL_DC_C)
  dht(1, 1, BITS_AC_C, VAL_AC_C)

  // SOS
  seg(0xda, [0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])

  const mcuW = Math.ceil(w / 16)
  const mcuH = Math.ceil(h / 16)
  const block = new Float32Array(64)
  const coef = new Float32Array(64)
  const qz = new Int32Array(64)
  let prevY = 0; let prevCb = 0; let prevCr = 0

  const sample = (plane, x, y) => plane[Math.min(h - 1, y) * w + Math.min(w - 1, x)]

  for (let my = 0; my < mcuH; my++) {
    for (let mx = 0; mx < mcuW; mx++) {
      // Y：4 个 8x8 块
      for (let by = 0; by < 2; by++) {
        for (let bx = 0; bx < 2; bx++) {
          const ox = mx * 16 + bx * 8
          const oy = my * 16 + by * 8
          for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) block[y * 8 + x] = sample(Y, ox + x, oy + y)
          }
          quantize(fdct(block), lq, coef)
          for (let i = 0; i < 64; i++) qz[i] = coef[ZIGZAG[i]]
          prevY = encodeBlock(bw, qz, prevY, HUFF_DC_L, HUFF_AC_L)
        }
      }
      // Cb / Cr：各 1 个 8x8 块（2x2 平均）
      for (const [plane, isCb] of [[Cb, true], [Cr, false]]) {
        const ox = mx * 8
        const oy = my * 8
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const sx = ox * 2 + x * 2
            const sy = oy * 2 + y * 2
            const v = (sample(plane, sx, sy) + sample(plane, sx + 1, sy) +
              sample(plane, sx, sy + 1) + sample(plane, sx + 1, sy + 1)) / 4
            block[y * 8 + x] = v
          }
        }
        quantize(fdct(block), cq, coef)
        for (let i = 0; i < 64; i++) qz[i] = coef[ZIGZAG[i]]
        if (isCb) prevCb = encodeBlock(bw, qz, prevCb, HUFF_DC_C, HUFF_AC_C)
        else prevCr = encodeBlock(bw, qz, prevCr, HUFF_DC_C, HUFF_AC_C)
      }
    }
  }

  bw.flush()
  bw.buf.push(0xff, 0xd9)   // EOI
  const out = Buffer.from(bw.buf)
  fs.writeFileSync(outPath, out)
  return { bytes: out.length, width: w, height: h, quality: q }
}

module.exports = { pngToJpeg, decodePng }

if (require.main === module) {
  const [, , inP, outP, q] = process.argv
  if (!inP || !outP) {
    console.error('用法: node tools/png-to-jpeg.js <in.png> <out.jpg> [quality]')
    process.exit(1)
  }
  const r = pngToJpeg(inP, outP, Number(q || 90))
  console.log(`${inP} → ${outP}  ${r.width}x${r.height}  q=${r.quality}  ${(r.bytes / 1024).toFixed(0)} KB`)
}
