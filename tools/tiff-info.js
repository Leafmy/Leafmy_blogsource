'use strict'
/* ============================================================
   TIFF 头解析 (tools/tiff-info.js)
   ------------------------------------------------------------
   只读取 IFD 里的关键标签，用来判断分辨率、位深、通道数与数据布局
   （条带还是瓦片），不做解码。

   用法: node tools/tiff-info.js <file.tif>
   ============================================================ */

const fs = require('fs')

const f = process.argv[2]
if (!f || !fs.existsSync(f)) {
  console.error('用法: node tools/tiff-info.js <file.tif>')
  process.exit(1)
}
const b = fs.readFileSync(f)
console.log('文件: ' + f + '   ' + (b.length / 1048576).toFixed(2) + ' MB')

const le = b[0] === 0x49
const rd16 = (o) => le ? b[o] + (b[o + 1] << 8) : (b[o] << 8) + b[o + 1]
const rd32 = (o) => le
  ? b[o] + (b[o + 1] << 8) + (b[o + 2] << 16) + (b[o + 3] * 16777216)
  : b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]

const magic = rd16(2)
console.log('字节序: ' + (le ? 'little-endian' : 'big-endian') + '   magic=' + magic +
  (magic === 42 ? ' (标准 TIFF)' : magic === 43 ? ' (BigTIFF)' : ' (未知)'))

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }
const NAMES = {
  256: 'ImageWidth', 257: 'ImageLength', 258: 'BitsPerSample', 259: 'Compression',
  262: 'PhotometricInterpretation', 273: 'StripOffsets', 277: 'SamplesPerPixel',
  278: 'RowsPerStrip', 279: 'StripByteCounts', 282: 'XResolution', 283: 'YResolution',
  284: 'PlanarConfiguration', 322: 'TileWidth', 323: 'TileLength',
  324: 'TileOffsets', 325: 'TileByteCounts', 339: 'SampleFormat',
  33550: 'ModelPixelScale', 33922: 'ModelTiepoint', 34735: 'GeoKeyDirectory'
}

function readValues (entry, type, count) {
  const size = (TYPE_SIZE[type] || 1) * count
  let off = entry + 8
  if (size > 4) off = rd32(entry + 8)
  const out = []
  for (let i = 0; i < Math.min(count, 12); i++) {
    if (type === 3) out.push(rd16(off + i * 2))
    else if (type === 4) out.push(rd32(off + i * 4))
    else out.push(b[off + i])
  }
  return out
}

let ifd = rd32(4)
let pass = 0
while (ifd > 0 && ifd < b.length && pass < 4) {
  const n = rd16(ifd)
  console.log('\n--- IFD #' + (pass + 1) + ' @' + ifd + '  条目数 ' + n + ' ---')
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    const tag = rd16(e)
    const type = rd16(e + 2)
    const count = rd32(e + 4)
    const name = NAMES[tag] || ('tag' + tag)
    if (NAMES[tag]) {
      const vals = readValues(e, type, count)
      console.log('  ' + name.padEnd(26) + ' type=' + type + ' count=' + count +
        '  ' + (count > 12 ? '[' + vals.slice(0, 6).join(',') + ' …]' : JSON.stringify(vals)))
    }
  }
  ifd = rd32(ifd + 2 + n * 12)
  pass++
}
