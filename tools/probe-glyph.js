'use strict'
/* ============================================================
   TTF 字形轮廓探针 (tools/probe-glyph.js)
   ------------------------------------------------------------
   目的：「启」「明」两个字要能"描边画出"（stroke draw），就必须拿到
   **字形轮廓路径** —— 纯 CSS 做不到（-webkit-text-stroke 只能整条淡入淡出，
   没有路径长度可做 dasharray）。所以从系统字体里直接取轮廓。

   [为什么不用 fonttools.py]
   本机没有 fonttools，python 只是 Windows Store 的占位桩（调不出）。
   而 TrueType 的轮廓表（glyf）本身不复杂，纯 JS 解析即可，还免依赖。

   [这里只做探针：先把事实读出来再决定怎么生成 SVG]
   要读的表：
     head  indexToLocFormat（loca 表项是短格式(×2)还是长格式）
     maxp  numGlyphs
     cmap  Unicode → glyphIndex（取 format 4，BMP）
     loca  glyphIndex → glyf 偏移
     glyf  轮廓：简单字形（端点数组 + 二次贝塞尔）与复合字形（引用其它字形）
     hmtx  字宽（排版用）

   用法:
     node tools/probe-glyph.js "启明" [字体路径]
   ============================================================ */

const fs = require('fs')
const path = require('path')

const TEXT = process.argv[2] || '启明'
const FONT = path.resolve(process.argv[3] || 'C:\\Windows\\Fonts\\NotoSerifSC-VF.ttf')

function readTables (buf) {
  const numTables = buf.readUInt16BE(4)
  const t = {}
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    const tag = buf.toString('ascii', o, o + 4)
    t[tag] = { offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12) }
  }
  return t
}

/* cmap：只要 format 4（BMP）与 format 12（完整 Unicode） */
function buildCmap (buf, tables) {
  const base = tables.cmap.offset
  const n = buf.readUInt16BE(base + 2)
  let best = null
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8
    const pid = buf.readUInt16BE(rec)
    const eid = buf.readUInt16BE(rec + 2)
    const off = base + buf.readUInt32BE(rec + 4)
    const fmt = buf.readUInt16BE(off)
    let score = 0
    if (fmt === 12) score = 100
    else if (fmt === 4 && ((pid === 3 && eid === 1) || (pid === 0))) score = 50
    if (!best || score > best.score) best = { score, off, fmt }
  }
  if (!best) return () => 0
  if (best.fmt === 12) {
    const nGroups = buf.readUInt32BE(best.off + 12)
    return function (cp) {
      for (let g = 0; g < nGroups; g++) {
        const o = best.off + 16 + g * 12
        const s = buf.readUInt32BE(o), e = buf.readUInt32BE(o + 4), gid = buf.readUInt32BE(o + 8)
        if (cp >= s && cp <= e) return gid + (cp - s)
      }
      return 0
    }
  }
  const segX2 = buf.readUInt16BE(best.off + 6)
  const seg = segX2 / 2
  const endO = best.off + 14
  const startO = endO + segX2 + 2
  const deltaO = startO + segX2
  const rangeO = deltaO + segX2
  return function (cp) {
    for (let s = 0; s < seg; s++) {
      const end = buf.readUInt16BE(endO + s * 2)
      if (cp > end) continue
      const start = buf.readUInt16BE(startO + s * 2)
      if (cp < start) return 0
      const delta = buf.readInt16BE(deltaO + s * 2)
      const ro = buf.readUInt16BE(rangeO + s * 2)
      if (ro === 0) return (cp + delta) & 0xffff
      const gi = rangeO + s * 2 + ro + (cp - start) * 2
      const g = buf.readUInt16BE(gi)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
}

/* ---------- glyf 解析 ---------- */
function parseGlyf (buf, tables, loca, glyphIndex, depth) {
  depth = depth || 0
  if (depth > 4) return []
  const start = loca[glyphIndex]
  const end = loca[glyphIndex + 1]
  if (start >= end) return []          // 空字形（如空格）
  let p = tables.glyf.offset + start
  const numberOfContours = buf.readInt16BE(p)
  p += 10                              // xMin,yMin,xMax,yMax
  if (numberOfContours >= 0) {
    /* 简单字形：endPtsOfContours → instructions → flags → x/y 增量 */
    const endPts = []
    for (let i = 0; i < numberOfContours; i++) { endPts.push(buf.readUInt16BE(p)); p += 2 }
    const nPts = numberOfContours ? endPts[endPts.length - 1] + 1 : 0
    const instrLen = buf.readUInt16BE(p); p += 2 + instrLen
    const flags = []
    while (flags.length < nPts) {
      const f = buf.readUInt8(p++)
      flags.push(f)
      if (f & 8) { const rep = buf.readUInt8(p++); for (let r = 0; r < rep; r++) flags.push(f) }
    }
    const xs = []
    let x = 0
    for (let i = 0; i < nPts; i++) {
      const f = flags[i]
      if (f & 2) { const d = buf.readUInt8(p++); x += (f & 16) ? d : -d } else if (!(f & 16)) { x += buf.readInt16BE(p); p += 2 }
      xs.push(x)
    }
    const ys = []
    let y = 0
    for (let i = 0; i < nPts; i++) {
      const f = flags[i]
      if (f & 4) { const d = buf.readUInt8(p++); y += (f & 32) ? d : -d } else if (!(f & 32)) { y += buf.readInt16BE(p); p += 2 }
      ys.push(y)
    }
    /* 拆成若干闭合轮廓；点带 onCurve 标记 */
    const contours = []
    let s = 0
    for (let c = 0; c < numberOfContours; c++) {
      const e = endPts[c]
      const pts = []
      for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) })
      contours.push(pts)
      s = e + 1
    }
    return contours
  }
  /* 复合字形：按组件拼（带偏移/缩放），本项目只用于少量符号 */
  const out = []
  let more = true
  while (more) {
    const flags = buf.readUInt16BE(p); p += 2
    const gi = buf.readUInt16BE(p); p += 2
    let dx = 0, dy = 0
    if (flags & 1) { dx = buf.readInt16BE(p); dy = buf.readInt16BE(p + 2); p += 4 }
    else { dx = buf.readInt8(p); dy = buf.readInt8(p + 1); p += 2 }
    let scale = [1, 0, 0, 1]
    if (flags & 8) { scale = [buf.readInt16BE(p) / 16384, 0, 0, buf.readInt16BE(p + 2) / 16384]; p += 4 }
    else if (flags & 64) { scale = [buf.readInt16BE(p) / 16384, 0, 0, buf.readInt16BE(p + 2) / 16384]; p += 4 }
    else if (flags & 128) {
      scale = [buf.readInt16BE(p) / 16384, buf.readInt16BE(p + 2) / 16384,
        buf.readInt16BE(p + 4) / 16384, buf.readInt16BE(p + 6) / 16384]
      p += 8
    }
    const sub = parseGlyf(buf, tables, loca, gi, depth + 1)
    for (const c of sub) {
      out.push(c.map((pt) => ({
        x: pt.x * scale[0] + pt.y * scale[2] + dx,
        y: pt.x * scale[1] + pt.y * scale[3] + dy,
        on: pt.on
      })))
    }
    more = !!(flags & 32)
  }
  return out
}

function main () {
  if (!fs.existsSync(FONT)) { console.error('找不到字体: ' + FONT); process.exit(1) }
  const buf = fs.readFileSync(FONT)
  const tables = readTables(buf)
  console.log('字体 ' + path.basename(FONT) + '  表数 ' + Object.keys(tables).length)
  console.log('  有 glyf: ' + !!tables.glyf + '  有 cmap: ' + !!tables.cmap + '  有 loca: ' + !!tables.loca)
  if (!tables.glyf) { console.error('这是 CFF/OTF 轮廓（无 glyf），本项目解析器不支持'); process.exit(2) }

  const head = tables.head.offset
  const unitsPerEm = buf.readUInt16BE(head + 18)
  const idxToLoc = buf.readInt16BE(head + 50)
  const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4)
  console.log('  unitsPerEm=' + unitsPerEm + '  numGlyphs=' + numGlyphs + '  loca格式=' + (idxToLoc ? 'long' : 'short'))

  /* loca */
  const loca = new Uint32Array(numGlyphs + 1)
  const lb = tables.loca.offset
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = idxToLoc ? buf.readUInt32BE(lb + i * 4) : buf.readUInt16BE(lb + i * 2) * 2
  }
  const cmap = buildCmap(buf, tables)

  for (const ch of TEXT) {
    const cp = ch.codePointAt(0)
    const gi = cmap(cp)
    const contours = parseGlyf(buf, tables, loca, gi, 0)
    let nPts = 0, onCurve = 0, offCurve = 0
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
    for (const c of contours) {
      nPts += c.length
      for (const p of c) {
        if (p.on) onCurve++; else offCurve++
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
      }
    }
    console.log('\n「' + ch + '」U+' + cp.toString(16).toUpperCase() +
      '  字形 ' + gi + '  轮廓数 ' + contours.length + '  点数 ' + nPts +
      '（on ' + onCurve + ' / off ' + offCurve + '）')
    console.log('  bbox x[' + minX + ',' + maxX + '] y[' + minY + ',' + maxY + ']  ' +
      '  宽高 ' + (maxX - minX) + 'x' + (maxY - minY))
    contours.forEach((c, i) => {
      let cx0 = 1e9, cy0 = 1e9, cx1 = -1e9, cy1 = -1e9
      for (const p of c) {
        if (p.x < cx0) cx0 = p.x; if (p.x > cx1) cx1 = p.x
        if (p.y < cy0) cy0 = p.y; if (p.y > cy1) cy1 = p.y
      }
      console.log('    #' + i + ' 点数 ' + String(c.length).padStart(3) +
        '  x[' + String(cx0).padStart(5) + ',' + String(cx1).padStart(5) + ']' +
        '  y[' + String(cy0).padStart(5) + ',' + String(cy1).padStart(5) + ']')
    })
  }
}

main()
