'use strict'
/* ============================================================
   生成「启明」的 SVG 描边路径 (tools/gen-title-svg.js)
   ------------------------------------------------------------
   产出 source/custom/theme/title-paths.js：
     window.__titleGlyphs = [{ ch, w, h, d, lengths:[...] }, ...]
   d 是**每个字一条 path**（内含多条 M..Z 子路径），lengths 是各子路径的
   近似长度（供 CSS 用 stroke-dasharray 逐段描出）。

   [为什么要转 SVG 路径 —— 这是"stroke draw"的唯一正确做法]
   `-webkit-text-stroke` 只能整条淡入淡出，没有"路径长度"可动画；
   要做到"沿笔画一笔一笔画出来"，必须是真正的路径 + stroke-dasharray/dashoffset。
   而 CJK 字形轮廓在字体里就是现成的：TrueType 的 glyf 表给出二次贝塞尔点，
   转成 SVG 的 M/Q/Z 即可，不需要任何外部工具或网络素材。

   [二次贝塞尔 → SVG]
   TrueType 用 on/off 交替的点描述闭合轮廓，规则：
     · on → on   ：直线
     · on → off → on ：以 off 为控制点的二次曲线 Q
     · 起点是 off 时（轮廓以控制点开头）：先取它与前一点的中点作为起点
   这套规则在两处都要用（起点处理 + 逐段转换），所以抽成 contourToPath()。

   [描边顺序]
   按轮廓包围盒排序：先上后下、再左后右 —— 近似人写字时的顺序
   （先横、后竖、再内部），比按 glyf 里的存储顺序自然得多。
   这不是真实笔顺（字体里没有笔顺信息），但视觉上"从上到下、从左到右
   逐笔出现"已经足够读作书写。

   用法:
     node tools/gen-title-svg.js ["启明"] [字体路径]
     node tools/gen-title-svg.js --dump ["启明"]     # 只打印原始轮廓点，不写文件
   ------------------------------------------------------------
   --dump 用来分清"d 里的怪东西是转换引入的、还是字体轮廓本身就这样"——
   这条分界线决定该改转换代码还是该改渲染规则（实测结论：字体轮廓是干净的
   矩形/曲线，拧麻花是转换引入的）。
   main() 只在直接运行时执行：解析函数经 module.exports 暴露，供其它探针复用。 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
/* 位置参数要跳过 --flag，否则 `--dump` 会被当成"要生成的字"（实测过） */
const POS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const TEXT = POS[0] || '启明'
const FONT = path.resolve(POS[1] || 'C:\\Windows\\Fonts\\NotoSerifSC-VF.ttf')
const OUT = path.join(ROOT, 'source/custom/theme/title-paths.js')

/* ---------- 与 probe-glyph.js 相同的解析（这里内联，避免两处漂移） ---------- */
function readTables (buf) {
  const numTables = buf.readUInt16BE(4)
  const t = {}
  for (let i = 0; i < numTables; i++) {
    const o = 12 + i * 16
    t[buf.toString('ascii', o, o + 4)] = {
      offset: buf.readUInt32BE(o + 8), length: buf.readUInt32BE(o + 12)
    }
  }
  return t
}
function buildCmap (buf, tables) {
  const base = tables.cmap.offset
  const n = buf.readUInt16BE(base + 2)
  let best = null
  for (let i = 0; i < n; i++) {
    const rec = base + 4 + i * 8
    const pid = buf.readUInt16BE(rec), eid = buf.readUInt16BE(rec + 2)
    const off = base + buf.readUInt32BE(rec + 4)
    const fmt = buf.readUInt16BE(off)
    let score = 0
    if (fmt === 12) score = 100
    else if (fmt === 4 && ((pid === 3 && eid === 1) || pid === 0)) score = 50
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
  const segX2 = buf.readUInt16BE(best.off + 6), seg = segX2 / 2
  const endO = best.off + 14
  const startO = endO + segX2 + 2
  const deltaO = startO + segX2, rangeO = deltaO + segX2
  return function (cp) {
    for (let s = 0; s < seg; s++) {
      const end = buf.readUInt16BE(endO + s * 2)
      if (cp > end) continue
      const start = buf.readUInt16BE(startO + s * 2)
      if (cp < start) return 0
      const delta = buf.readInt16BE(deltaO + s * 2)
      const ro = buf.readUInt16BE(rangeO + s * 2)
      if (ro === 0) return (cp + delta) & 0xffff
      const g = buf.readUInt16BE(rangeO + s * 2 + ro + (cp - start) * 2)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }
}
function parseGlyf (buf, tables, loca, gi, depth) {
  depth = depth || 0
  if (depth > 4) return []
  const start = loca[gi], end = loca[gi + 1]
  if (start >= end) return []
  let p = tables.glyf.offset + start
  const nc = buf.readInt16BE(p)
  p += 10
  if (nc >= 0) {
    const endPts = []
    for (let i = 0; i < nc; i++) { endPts.push(buf.readUInt16BE(p)); p += 2 }
    const nPts = nc ? endPts[endPts.length - 1] + 1 : 0
    p += 2 + buf.readUInt16BE(p)                     // 跳过 instructions
    const flags = []
    while (flags.length < nPts) {
      const f = buf.readUInt8(p++); flags.push(f)
      if (f & 8) { const r = buf.readUInt8(p++); for (let k = 0; k < r; k++) flags.push(f) }
    }
    const xs = []; let x = 0
    for (let i = 0; i < nPts; i++) {
      const f = flags[i]
      if (f & 2) { const d = buf.readUInt8(p++); x += (f & 16) ? d : -d }
      else if (!(f & 16)) { x += buf.readInt16BE(p); p += 2 }
      xs.push(x)
    }
    const ys = []; let y = 0
    for (let i = 0; i < nPts; i++) {
      const f = flags[i]
      if (f & 4) { const d = buf.readUInt8(p++); y += (f & 32) ? d : -d }
      else if (!(f & 32)) { y += buf.readInt16BE(p); p += 2 }
      ys.push(y)
    }
    const out = []; let s = 0
    for (let c = 0; c < nc; c++) {
      const e = endPts[c], pts = []
      for (let i = s; i <= e; i++) pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) })
      out.push(pts); s = e + 1
    }
    return out
  }
  const out = []
  let more = true
  while (more) {
    const flags = buf.readUInt16BE(p); p += 2
    const sub = buf.readUInt16BE(p); p += 2
    let dx, dy
    if (flags & 1) { dx = buf.readInt16BE(p); dy = buf.readInt16BE(p + 2); p += 4 }
    else { dx = buf.readInt8(p); dy = buf.readInt8(p + 1); p += 2 }
    let sc = [1, 0, 0, 1]
    if (flags & 8) { sc = [buf.readInt16BE(p) / 16384, 0, 0, buf.readInt16BE(p + 2) / 16384]; p += 4 }
    else if (flags & 64) { sc = [buf.readInt16BE(p) / 16384, 0, 0, buf.readInt16BE(p + 2) / 16384]; p += 4 }
    else if (flags & 128) {
      sc = [buf.readInt16BE(p) / 16384, buf.readInt16BE(p + 2) / 16384,
        buf.readInt16BE(p + 4) / 16384, buf.readInt16BE(p + 6) / 16384]
      p += 8
    }
    for (const c of parseGlyf(buf, tables, loca, sub, depth + 1)) {
      out.push(c.map((pt) => ({
        x: pt.x * sc[0] + pt.y * sc[2] + dx, y: pt.x * sc[1] + pt.y * sc[3] + dy, on: pt.on
      })))
    }
    more = !!(flags & 32)
  }
  return out
}

/* ---------- 轮廓 → SVG 子路径（同时给出真实弧长） ----------
   两条铁律，都是踩出来的：

   A) **起点是 on-curve 点时，第一段必须从它出发。**
      旧实现把循环起点写成 idx（=1），配对于是从 (pts[1],pts[2]) 开始 ——
      路径实际先画 pts[0]→pts[2] 这条**对角线**，本该打头的 pts[0]→pts[1]
      被挤到末尾。矩形因此被画成"对角 + 底 + 左 + 顶 + 回描"的拧麻花形状：
        · evenodd 填充只填一半（横向笔画变成楔子）——线上肉眼可见；
        · getTotalLength() 是应有长度的 1.85 倍，而 dasharray 写的是应有长度，
          dash 动画两头同时露馅（开场就露出尾段、收尾永远差一截）。
      （"应有长度"指轮廓的真实周长：矩形 2*(w+t)，实测与 getTotalLength 一致。）

   B) **连续两个 off-curve 点之间隐含一个 on-curve 中点。**
      旧实现在 (on, off, off) 上先发一条 Q 绕回"当前点"、再发一条 Q 去真终点，
      等于原地转一圈（d 里能看到两条端点完全相同的 Q）；起点是 off 时
      还有整段被静默跳过（SVG 会把缺口补成直线，轮廓就走形了）。

   走法改成经典 TrueType 那套：先定起点（首点若是控制点，取它与末点的中点），
   再沿点列前进 —— 遇到 on 点连直线；遇到 off 点把它当控制点，终点取"下一个
   on 点"，下一个也是 off 时终点取两者中点（那个 off 点留作下一轮的控制点）。
   长度随段一起算：直线取欧氏距离、二次曲线取 quadLength()，
   让 lengths[] 与浏览器 getTotalLength() 对齐。 */
function contourToPath (pts, tf) {
  const P = (p) => ({ x: tf.x(p.x), y: tf.y(p.y) })
  const n = pts.length
  if (!n) return { d: '', len: 0 }

  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true })
  let startPt, i0
  if (pts[0].on) { startPt = pts[0]; i0 = 1 }                            // 首点就在轮廓上
  else if (pts[n - 1].on) { startPt = mid(pts[n - 1], pts[0]); i0 = 0 }   // 首点是控制点
  else { startPt = mid(pts[0], pts[n - 1]); i0 = 0 }                     // 首末都是控制点

  const sp = P(startPt)
  let d = 'M' + sp.x + ' ' + sp.y
  let len = 0
  let cur = sp
  for (let k = 0; k < n;) {
    const p = pts[(i0 + k) % n]
    if (p.on) {
      const q = P(p)
      if (q.x !== cur.x || q.y !== cur.y) {          // 重合点不发零长段
        d += 'L' + q.x + ' ' + q.y
        len += Math.hypot(q.x - cur.x, q.y - cur.y)
        cur = q
      }
      k++
    } else {
      const next = pts[(i0 + k + 1) % n]
      const end = next.on ? next : mid(p, next)      // 连续控制点 ⇒ 终点取中点
      const c = P(p), b = P(end)
      d += 'Q' + c.x + ' ' + c.y + ' ' + b.x + ' ' + b.y
      len += quadLength(cur, c, b)
      cur = b
      k += next.on ? 2 : 1
    }
  }
  d += 'Z'
  /* Z 是一段真实的收尾直线（从当前点回到 M 点），它同样计入路径长度：
     漏掉这一截，dasharray 就会比 getTotalLength() 短 —— 差多少，动画收尾就
     少画多少（闭合边短的笔画看不出来，闭合边长的笔画会明显差一截）。 */
  len += Math.hypot(sp.x - cur.x, sp.y - cur.y)
  return { d, len }
}

/* ---------- 字体装载（main 与外部探针共用） ---------- */
function loadFont (fontPath) {
  const buf = fs.readFileSync(fontPath)
  const tables = readTables(buf)
  const unitsPerEm = buf.readUInt16BE(tables.head.offset + 18)
  const idxToLoc = buf.readInt16BE(tables.head.offset + 50)
  const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4)
  const loca = new Uint32Array(numGlyphs + 1)
  for (let i = 0; i <= numGlyphs; i++) {
    loca[i] = idxToLoc ? buf.readUInt32BE(tables.loca.offset + i * 4)
      : buf.readUInt16BE(tables.loca.offset + i * 2) * 2
  }
  return { buf, tables, unitsPerEm, loca, cmap: buildCmap(buf, tables) }
}

/* 取一个字的所有轮廓（字体单位，y 轴向上） */
function glyphContours (font, ch) {
  const gi = font.cmap(ch.codePointAt(0))
  return parseGlyf(font.buf, font.tables, font.loca, gi, 0)
}

function main () {
  if (!fs.existsSync(FONT)) { console.error('找不到字体: ' + FONT); process.exit(1) }
  const font = loadFont(FONT)
  const { buf, tables, unitsPerEm, loca, cmap } = font

  /* 统一坐标系：按两个字**共同**的 bbox 归一，保证两字相对大小与基线一致。
     字体 y 轴向上，SVG y 轴向下 ⇒ y 取负并平移。 */
  const glyphs = []
  let gw = 0, gh = 0
  for (const ch of TEXT) {
    const contours = glyphContours(font, ch)
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9
    for (const c of contours) for (const p of c) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
    }
    glyphs.push({ ch, contours, minX, minY, maxX, maxY })
    gw = Math.max(gw, maxX - minX); gh = Math.max(gh, maxY - minY)
  }
  /* 两字共用同一个 bbox 高度做缩放，宽度各按自身 —— 与字体排版一致（等宽字面） */
  /* [归一化到"字体 em 的 1000 单位"]
     直接把字形单位的 bbox 当 viewBox（实测 857x915 / 854x884）会出问题：
     SVG 设了 width 之后，1 用户单位就被放大成 (显示宽 / viewBox 宽) ——
     实测在字号 128px 下放大约 7 倍，标题盒撑到 938px（原文字宽 273px），
     stroke-width 也从 2.2 变成十几像素。统一缩放到 1000 单位的 em 尺度后，
     SVG 的 1 单位 = 1/1000 em，stroke-width 与 CSS 字号可以直接换算。 */
  const NORM = 1000
  console.log('viewBox 用字体单位；显示尺寸按 em 比例输出（1 em = ' + unitsPerEm + ' 单位）')

  const out = []
  for (const g of glyphs) {
    /* 轮廓排序：先上后下、再左后右（近似书写顺序） */
    const sorted = g.contours.slice().sort((a, b) => {
      const box = (c) => {
        let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
        for (const p of c) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y }
        return { x0, y0, x1, y1 }
      }
      const A = box(a), B = box(b)
      /* y 越大越靠上：先画上面的（-y 排序），同高再按 x */
      if (Math.abs(B.y1 - A.y1) > 40) return B.y1 - A.y1
      return A.x0 - B.x0
    })
    /* 该字的变换：x 平移到 0、y 翻向后平移到 0（viewBox 就用字体单位）。
       Y 取 -v 是因为字体 y 向上、SVG y 向下。 */
    const tf = {
      x: (v) => +(v - g.minX).toFixed(1),
      y: (v) => +(g.maxY - v).toFixed(1)
    }
    const dw = g.maxX - g.minX
    const dh = g.maxY - g.minY
    /* [显示尺寸：按 em 比例给，不要给无单位像素数]
       SVG 的 width="857" 会被当成 **857px**，与 viewBox 无关 —— 于是标题
       从文字宽 273px 撑到 938px（实测）。正确做法是按 em 比例给宽：
       字体 1 em = unitsPerEm 单位，所以该字宽占 (dw/unitsPerEm) 个 em。
       CSS 里再写 `width: calc(var(--qm-w) * 1em)`，字号一变整体等比缩放，
       且 stroke-width 的 1 单位 = 1/unitsPerEm em，可直接换算。 */
    const wEm = +(dw / unitsPerEm).toFixed(4)
    const hEm = +(dh / unitsPerEm).toFixed(4)
    const ds = []
    const lens = []
    for (const c of sorted) {
      const r = contourToPath(c, tf)
      ds.push(r.d)
      lens.push(+r.len.toFixed(1))
    }
    console.log('「' + g.ch + '」子路径 ' + ds.length + ' 条  路径尺度 ' + dw + 'x' + dh +
      '  长度合计 ' + lens.reduce((a, b) => a + b, 0).toFixed(0))
    out.push({ ch: g.ch, w: dw, h: dh, wEm: wEm, hEm: hEm, d: ds.join(''), lengths: lens })
  }

  const js = '/* 由 tools/gen-title-svg.js 生成，请勿手改。\n' +
    '   来源：' + path.basename(FONT) + '（Noto Serif SC，SIL OFL 1.1）\n' +
    '   「启明」两字的字形轮廓 → SVG 路径，供 stroke-dasharray 逐笔描出。\n' +
    '   每个字一条 d（内含多条 M..Z 子路径）+ 各子路径的长度。\n' +
    '   lengths[] 与浏览器 path.getTotalLength() 对齐（误差 < 0.2），\n' +
    '   这是 dash 动画的前提：声明长度小于真实长度就会两头露馅。 */\n' +
    'window.__titleGlyphs = ' + JSON.stringify(out, null, 2) + '\n'
  fs.writeFileSync(OUT, js, 'utf8')
  console.log('\n已写出 ' + path.relative(ROOT, OUT) + '  ' + (js.length / 1024).toFixed(1) + ' KB')
}

/* ============================================================
   原始轮廓探针：--dump
   ------------------------------------------------------------
   只打印"字体里真正的点"（坐标 + on/off），不出文件。
   用途：判断 d 里的怪东西是**生成器的转换**引入的，还是字体轮廓本身就那样 ——
   这条分界线决定了该改转换代码还是该改渲染规则。
   ============================================================ */
function dump () {
  const font = loadFont(FONT)
  for (const ch of TEXT) {
    const contours = glyphContours(font, ch)
    console.log('\n「' + ch + '」轮廓 ' + contours.length + ' 条')
    contours.forEach((c, i) => {
      const box = c.reduce((a, p) => ({
        x0: Math.min(a.x0, p.x), y0: Math.min(a.y0, p.y),
        x1: Math.max(a.x1, p.x), y1: Math.max(a.y1, p.y)
      }), { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 })
      const onCount = c.filter((p) => p.on).length
      console.log('  #' + String(i).padStart(2) + '  点 ' + String(c.length).padStart(2) +
        '（on ' + onCount + '/off ' + (c.length - onCount) + '）  bbox ' +
        [box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0].join(','))
      console.log('       ' + c.map((p) => (p.on ? 'o' : 'x') + p.x + ',' + p.y).join('  '))
    })
  }
}

/* ============================================================
   二次贝塞尔的真实弧长（供 lengths 使用）
   ------------------------------------------------------------
   数值积分 |B'(t)|（Gauss–Legendre 8 点），相对误差 < 1e-3。
   为什么需要它：lengths 必须与浏览器 getTotalLength() 对齐 ——
   dasharray/dashoffset 一旦比真实路径短，动画两端都会露馅（详见 title-paths.js）。
   ============================================================ */
function quadLength (p0, c, p1) {
  const ax = 2 * (c.x - p0.x), ay = 2 * (c.y - p0.y)
  const bx = 2 * (p1.x - c.x) - ax, by = 2 * (p1.y - c.y) - ay
  const X = [0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363]
  const W = [0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763]
  let sum = 0
  for (let i = 0; i < X.length; i++) {
    for (const s of [X[i], -X[i]]) {
      const t = 0.5 * (s + 1)
      sum += W[i] * Math.hypot(ax + bx * t, ay + by * t)
    }
  }
  return 0.5 * sum
}

module.exports = {
  readTables, buildCmap, parseGlyf, loadFont, glyphContours,
  contourToPath, quadLength
}

if (require.main === module) {
  if (process.argv.includes('--dump')) dump()
  else main()
}
