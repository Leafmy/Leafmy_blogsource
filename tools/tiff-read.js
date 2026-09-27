'use strict'
/* ============================================================
   8bit 平面式 TIFF 读取 (tools/tiff-read.js)
   ------------------------------------------------------------
   为什么需要：OPAL 官方发布的 "globalmap" 产品是 TIFF，而本机没有
   libtiff / sharp 之类的依赖，仓库既有做法是"能自己读的就自己读"
   （见 tools/opus-composite.js 的最小 TIFF 读取、tools/planet-resize.js
   的基线 JPEG 解码）。

   只支持本项目实际遇到的那一种布局（够用且可断言，不做通用解码器）：
     · 标准 TIFF（magic=42），小端或大端
     · Compression=1（未压缩）
     · BitsPerSample=8 且全部相同
     · PlanarConfiguration=1（交错 RGB）或 2（平面分离 RGB/RGBA）
     · 布局为一维条带（StripOffsets/StripByteCounts），不处理瓦片

   导出:
     readTiff(buf) -> { w, h, ch, planar, data }
       data 在 planar=1 时是交错 RGB/RGBA；在 planar=2 时**保持平面布局**
       （ch 段，每段 w*h 字节）—— 调用方若要交错需要自己拌，
       见 tools/jupiter-map-opal.js 里的 toInterleaved()。
   ============================================================ */

function readTiff (buf) {
  if (buf.length < 8) throw new Error('TIFF 太短')
  const le = buf[0] === 0x49 && buf[1] === 0x49
  const be = buf[0] === 0x4d && buf[1] === 0x4d
  if (!le && !be) throw new Error('不是 TIFF（字节序标记不对）')
  const rd16 = (o) => le ? buf[o] + (buf[o + 1] << 8) : (buf[o] << 8) + buf[o + 1]
  const rd32 = (o) => le
    ? (buf[o] + (buf[o + 1] << 8) + (buf[o + 2] << 16) + buf[o + 3] * 16777216) >>> 0
    : (buf[o] * 16777216 + (buf[o + 1] << 16) + (buf[o + 2] << 8) + buf[o + 3]) >>> 0
  if (rd16(2) !== 42) throw new Error('不是标准 TIFF（可能是 BigTIFF，未支持）')

  const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 }
  const ifd = rd32(4)
  const n = rd16(ifd)
  const tags = {}
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12
    const tag = rd16(e)
    const type = rd16(e + 2)
    const count = rd32(e + 4)
    let off = e + 8
    if ((TYPE_SIZE[type] || 1) * count > 4) off = rd32(e + 8)
    tags[tag] = { type, count, off }
  }
  const vals = (tag) => {
    const t = tags[tag]
    if (!t) return null
    const out = []
    for (let i = 0; i < t.count; i++) {
      if (t.type === 3) out.push(rd16(t.off + i * 2))
      else if (t.type === 4) out.push(rd32(t.off + i * 4))
      else if (t.type === 2) out.push(buf[t.off + i])
      else if (t.type === 1) out.push(buf[t.off + i])
      else if (t.type === 8) out.push(rd16(t.off + i * 2))
      else if (t.type === 5) out.push([rd32(t.off + i * 8), rd32(t.off + i * 8 + 4)])
      else throw new Error('TIFF 标签 ' + tag + ' 的类型 ' + t.type + ' 未支持')
    }
    return out
  }
  const one = (tag) => { const v = vals(tag); return v ? v[0] : null }

  const w = one(256)
  const h = one(257)
  const ch = one(277) || 1                  // SamplesPerPixel
  const comp = one(259)
  const photo = one(262)
  const planar = one(284) || 1
  if (w == null || h == null) throw new Error('TIFF 缺 ImageWidth/ImageLength')
  if (comp !== 1) throw new Error('只支持未压缩 TIFF（Compression=' + comp + '）')
  const bps = vals(258)
  if (!bps || bps.length !== ch || bps.some((b) => b !== 8)) {
    throw new Error('只支持每样本 8bit 且各通道一致的 TIFF，实际 ' + JSON.stringify(bps))
  }
  if (planar !== 1 && planar !== 2) throw new Error('PlanarConfiguration=' + planar + ' 未支持')
  if (tags[322]) throw new Error('瓦片式 TIFF 未支持（只有条带式）')

  const offs = vals(273)
  const counts = vals(279)
  if (!offs || !counts) throw new Error('TIFF 缺 StripOffsets/StripByteCounts')

  const out = Buffer.alloc(w * h * ch)
  const nPlanes = planar === 2 ? ch : 1
  const perPlane = Math.round(offs.length / nPlanes)
  if (perPlane * nPlanes !== offs.length) {
    throw new Error('条带数 ' + offs.length + ' 不能被平面数 ' + nPlanes + ' 整除')
  }
  if (planar === 2 && perPlane !== h) {
    throw new Error('平面式排布下，每平面条带数 ' + perPlane + ' 应当等于图像高 ' + h)
  }

  /* 行字节数（stride）与每行实际有效字节：
       本项目两个产品都是**每行 4 字节对齐**的（3600 → 3604），所以
       StripByteCounts ≠ 行数 × 宽，直接拿它除以宽会算出双倍的行数。
       能自洽推出 stride 的两条路，按优先级：
         A) RowsPerStrip 存在   → stride = (下一带偏移 − 本带偏移) / RowsPerStrip
         B) 否则               → stride = StripByteCounts / 每带行数
       两条都只用文件自身的信息，不假设"每行就是 w 字节"。 */
  const rowsPerStripTag = vals(278)
  const strideOf = (s) => {
    const rps = (rowsPerStripTag && rowsPerStripTag[s]) || 1
    const nextOff = s + 1 < offs.length ? offs[s + 1] : null
    if (nextOff != null && nextOff > offs[s]) {
      const d = nextOff - offs[s]
      if (d % rps === 0 && d / rps >= w) return d / rps
    }
    const byCount = Math.floor(counts[s] / rps)
    if (byCount >= w) return byCount
    throw new Error('条带 #' + s + ' 推不出行字节数（偏移差与字节数都不够一行）')
  }

  const rowBytes = planar === 2 ? w : w * ch
  for (let p = 0; p < nPlanes; p++) {
    const s0 = p * perPlane
    const rps = (rowsPerStripTag && rowsPerStripTag[s0]) || 1
    const stride = strideOf(s0)
    if (stride < rowBytes) {
      throw new Error('平面 ' + p + ' 的行字节数 ' + stride + ' < 每行需要的 ' + rowBytes)
    }
    let y = 0
    for (let s = 0; s < perPlane && y < h; s++) {
      const rows = Math.min(rps, h - y)
      const base = offs[s0 + s]
      for (let r = 0; r < rows; r++) {
        const src = base + r * stride
        const dst = planar === 2 ? (p * h + (y + r)) * w : (y + r) * w * ch
        Buffer.from(buf.buffer, buf.byteOffset + src, rowBytes).copy(out, dst)
      }
      y += rows
    }
    if (y !== h) {
      throw new Error('平面 ' + p + ' 只拼出 ' + y + ' 行，图像高 ' + h)
    }
  }
  return { w, h, ch, planar, photometric: photo, data: out }
}

/* 取第 c 个平面为单通道图像（planar=2 时最常用：一个文件里三个波段）。 */
function plane (tif, c) {
  if (tif.planar === 1) {
    const out = Buffer.alloc(tif.w * tif.h)
    for (let i = 0; i < tif.w * tif.h; i++) out[i] = tif.data[i * tif.ch + c]
    return { w: tif.w, h: tif.h, ch: 1, data: out }
  }
  const n = tif.w * tif.h
  return { w: tif.w, h: tif.h, ch: 1, data: tif.data.slice(c * n, (c + 1) * n) }
}

/* 平面分离 → 交错（RGB）。planar=1 时原样返回。 */
function toInterleaved (tif) {
  if (tif.planar === 1) return tif
  const { w, h, ch, data } = tif
  const out = Buffer.alloc(w * h * ch)
  const plane = w * h
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < ch; c++) out[i * ch + c] = data[c * plane + i]
  }
  return { w, h, ch, planar: 1, photometric: tif.photometric, data: out }
}

module.exports = { readTiff, toInterleaved, plane }
