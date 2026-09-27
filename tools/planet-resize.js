'use strict'
/* ============================================================
   行星贴图降采样 + 土星环径向剖面 (tools/planet-resize.js)
   ------------------------------------------------------------
   【为什么需要这个脚本】
   网页里的行星（外行星近距离视角 / 内行星远景）用的是等距圆柱
   (equirectangular) 球面贴图。源图是 2K（2048x1024），直接丢给
   WebGL 会浪费显存与带宽：512x256 已经足够（球面上 1 像素≈0.7°），
   所以这里做一次严格 4x4 盒式滤波降采样，而不是双线性抽点 ——
   抽点会在金星云带、火星暗区上产生锯齿/摩尔纹。
   另外土星环要用一张"半径→(颜色,不透明度)"的 1D 纹理才能画出
   C 环 / B 环 / 卡西尼缝 / A 环 / 恩克缝 / F 环的真实径向结构，
   本脚本从官方 2D 环纹理里把这条径向剖面抽出来，重采样成 1024x1。

   【数据来源与许可】
   1) Solar System Scope 2K 行星贴图（6 张），CC BY 4.0，
      署名 "Solar System Scope"（https://www.solarsystemscope.com/textures/）：
        sss-2k_venus_atmosphere.jpg  ← 金星【大气/云顶】图
        sss-2k_earth_daymap.jpg      ← 地球白昼图
        sss-2k_mars.jpg              ← 火星反照率图
        sss-2k_saturn.jpg            ← 土星（含环阴影，仅取球面）
        sss-2k_uranus.jpg            ← 天王星
        sss-2k_neptune.jpg           ← 海王星
      为什么金星必须用 atmosphere 而非 surface：可见光下我们看到的
      是硫酸云顶（黄白色、几乎无地标），radar/表面图是合成出来的
      假彩色，直接当反照率贴图是错的。
   2) sss-2k_saturn_ring_alpha.png —— 土星环纹理（带 alpha），
      同一来源，CC BY 4.0，署名 "Solar System Scope"。
      实测尺寸 **2048x125**、8bit RGBA、非隔行（zlib 压缩后仅 11.6 KB）。
      内容本质是 1D 剖面被竖向铺满：每列在行方向上的抖动只有 ±6（8bit
      量化残差），所以径向剖面对每一列取 125 行的【中位数】（不是均值：
      C 环内侧的 13/26/42/62 台阶是真实结构，均值会把它抹成斜坡）。

   【关键常数（都有出处，别随手改）】
   - OUT_W/OUT_H = 512x256：2:1，等距圆柱标准比例。
     **20260916 更新**：默认改成 1024x512。原先选 512x256 的理由是
     "球面上 1 像素≈0.7°，够用"，但那是在远景天体只有 8~70px 的前提下
     算的 —— 实测这条推不成立：一个 40px 的球只展示整张贴图的 5.6%，
     换句话说 512 宽的图里被采样的只有 28 列，细节必然糊。
     提到 1024 后每颗约多 40~90 KB，六颗合计约 +400 KB，可以接受。
     用 --w=512 可以回到旧档位。
   - Q = 88：源图本身是 JPEG，再压一次 88 在 512px 下肉眼看不出，
     体积却只有 PNG 的 1/5 左右。
   - 亮度下限 0.05 / 上限 0.85：贴图整张全黑（下载失败/全透明）或
     全白（过曝）都是坏数据，必须让脚本直接失败而不是产出坏贴图。
   - 环纹理半径映射：SSS 约定 贴图内缘 x=0 ↔ 1.11 R_S、
     外缘 ↔ 2.32 R_S（R_S = 土星赤道半径 60268 km）。输出的
     1024x1 沿用同一约定：x=0 ↔ 1.11 R_S，x=1023 ↔ 2.32 R_S。
   - 环 alpha 端点处理：源 PNG 在内缘有一圈 value=7 的噪声底、
     在外缘最后一列有个 1 像素的残留。输出必须两端 alpha=0
     （否则环会在内外边界切出硬边），所以在 1.11~1.13 R_S 与
     2.316~2.32 R_S 各加一小段线性淡出斜坡，斜坡宽度只有十几像素，
     真实环结构（D/C 环内缘、F 环）都在斜坡之外，不受影响。

   用法:
     node tools/planet-resize.js                  # 6 张行星图 + 土星环
     node tools/planet-resize.js --only=mars      # 只做一张
     node tools/planet-resize.js --ring           # 只做环
   ============================================================ */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { pngToJpeg, decodePng } = require('./png-to-jpeg.js')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const ROOT = path.join(__dirname, '..')
const SRC_DIR = path.join(ROOT, '.perf', 'planet-src')
const TMP = path.join(ROOT, '.perf', 'planet-tmp')
const OUT_DIR = path.join(ROOT, 'source', 'img')

/* 输出尺寸：可用 --w=<宽> 覆盖（高自动取一半，等距圆柱必须 2:1）。
   默认 1024x512，理由见文件头。 */
const OUT_W = (function () {
  const hit = process.argv.find((a) => a.startsWith('--w='))
  const v = hit ? Number(hit.split('=')[1]) : 1024
  if (!isFinite(v) || v < 64 || v % 2) {
    console.error('--w= 需要是 ≥64 的偶数，收到 ' + (hit ? hit.split('=')[1] : ''))
    process.exit(1)
  }
  return v
})()
const OUT_H = OUT_W / 2
const Q = 88

/* 环纹理的半径映射（SSS 约定） */
const RING_INNER_RS = 1.11
const RING_OUTER_RS = 2.32
/* 环剖面的输出长度。
   **20260916 从 1024 提到 4096**：半径跨度 1.11~2.32 R_S = 1.21×60268 km
   ≈ 72900 km，1024 宽时每个采样≈71 km；而**恩克缝只有约 325 km**，
   在 1024 宽下是 4.6 个采样、在渐变里几乎读不出来（实测该处的 alpha 202，
   两侧 177/0 —— 完全被抹平）。提到 4096 后每采样≈18 km，
   恩克缝占 ~18 个采样，才可能作为真实暗带存在。
   文件只从 3 KB 变成约 12 KB（PNG 一维数据压缩率极高），代价可忽略。 */
const RING_OUT_LEN = 4096

const PLANETS = [
  { name: 'venus', file: 'sss-2k_venus_atmosphere.jpg', out: 'planet-venus.jpg' },
  { name: 'earth', file: 'sss-2k_earth_daymap.jpg', out: 'planet-earth.jpg' },
  { name: 'mars', file: 'sss-2k_mars.jpg', out: 'planet-mars.jpg' },
  { name: 'saturn', file: 'sss-2k_saturn.jpg', out: 'planet-saturn.jpg' },
  { name: 'uranus', file: 'sss-2k_uranus.jpg', out: 'planet-uranus.jpg' },
  { name: 'neptune', file: 'sss-2k_neptune.jpg', out: 'planet-neptune.jpg' }
]

const CREDIT = 'Solar System Scope (CC BY 4.0)'
const RING_SRC = 'sss-2k_saturn_ring_alpha.png'

/* ---------- 失败即退出 ---------- */
function die (msg) {
  console.error('\n❌ ' + msg)
  process.exit(1)
}

/* ============================================================
   JPEG 基线解码器
   ------------------------------------------------------------
   本机没有 sharp/jimp，仓库既有做法是"丢给无头 Chrome 截图再解 PNG"。
   但截图通道只有一次渲染机会：在 2048x1024 上先画后降采样，会引入
   一次额外的浏览器插值；而直接用 <canvas> 逐像素读取又受
   --screenshot 只能出 PNG 的限制。行星贴图是对色彩准确性要求最高的
   资产（地球的蓝、火星的锈红），所以这里自己解 JPEG：基线 8bit、
   非隔行、Huffman + 反量化 + 2D IDCT，覆盖实测到的全部源文件
   （SOF0、Y 1x1/2x2 抽样、单独 DHT 段）。只支持这几种，遇到别的
   (渐进式 / 算术编码 / 12bit) 直接报错，不猜。
   ============================================================ */
const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
]

const IDCT_COS = []
for (let x = 0; x < 8; x++) {
  IDCT_COS.push([])
  for (let u = 0; u < 8; u++) {
    // 归一化因子很容易写错，这里写清楚为什么是 /2 而不是 /4：
    // 分离式 2D IDCT 要的是 [C(u)/2] * [C(v)/2]，两个方向各乘一次，合起来 DC 增益 1/4。
    // 但本表只放 1D 的 C(u)/2；函数里两个方向各用一次这张表，于是自动乘了两次。
    // 再乘一个 1/4 就会变成 1/16（DC 增益 1/16），整张图会塌向 128 灰 —— 这个坑
    // 踩过一次：现象是"平坦区域解出来只比 128 偏一点、梯度被压成 1/4"。
    IDCT_COS[x].push((u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2)
  }
}

function idct8x8 (coef, out) {
  const tmp = new Float64Array(64)
  for (let v = 0; v < 8; v++) {
    for (let x = 0; x < 8; x++) {
      let s = 0
      for (let u = 0; u < 8; u++) s += IDCT_COS[x][u] * coef[v * 8 + u]
      tmp[v * 8 + x] = s
    }
  }
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let s = 0
      for (let v = 0; v < 8; v++) s += IDCT_COS[y][v] * tmp[v * 8 + x]
      out[y * 8 + x] = s
    }
  }
}

function buildHuff (counts, symbols) {
  // codes[len][code] = 该长度的码字对应的符号，未定义处为 -1（最多 2^len 项，len<=16）
  const codes = []
  for (let len = 0; len <= 16; len++) codes.push(new Int32Array(1 << len).fill(-1))
  let code = 0; let k = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) { codes[len][code] = symbols[k]; code++; k++ }
    code <<= 1
  }
  return { codes, counts, symbols }
}

function extend (v, t) {
  return v < (1 << (t - 1)) ? v - (1 << t) + 1 : v
}

function decodeJpegBaseline (buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG（缺 SOI）')
  const qt = {}
  const huffDC = {}
  const huffAC = {}
  let frame = null
  let restartInterval = 0
  let p = 2
  let scanStart = -1
  while (p < buf.length - 1) {
    if (buf[p] !== 0xff) { p++; continue }
    let m = buf[p + 1]
    while (m === 0xff) { p++; m = buf[p + 1] }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue }
    if (m === 0xd9) break
    const L = buf.readUInt16BE(p + 2)
    const d = buf.slice(p + 4, p + 2 + L)
    if (m === 0xdb) {
      let q = 0
      while (q < d.length) {
        const pq = d[q] >> 4; const tq = d[q] & 15; q++
        const t = new Uint16Array(64)
        for (let i = 0; i < 64; i++) {
          t[ZIGZAG[i]] = pq ? d.readUInt16BE(q + i * 2) : d[q + i]
        }
        q += pq ? 128 : 64
        qt[tq] = t
      }
    } else if (m === 0xc4) {
      let q = 0
      while (q < d.length) {
        const tc = d[q] >> 4; const th = d[q] & 15; q++
        const counts = []
        let total = 0
        for (let i = 0; i < 16; i++) { counts.push(d[q + i]); total += d[q + i] }
        q += 16
        const symbols = Array.from(d.slice(q, q + total))
        q += total
        const tbl = buildHuff(counts, symbols)
        if (tc === 0) huffDC[th] = tbl; else huffAC[th] = tbl
      }
    } else if (m === 0xdd) {
      restartInterval = d.readUInt16BE(0)
    } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (m !== 0xc0) throw new Error('仅支持基线 JPEG（SOF0），实际 SOF 0x' + m.toString(16) + '（渐进式请勿直接使用）')
      const n = d[5]
      const comps = []
      for (let i = 0; i < n; i++) {
        comps.push({
          id: d[6 + i * 3],
          h: d[7 + i * 3] >> 4,
          v: d[7 + i * 3] & 15,
          tq: d[8 + i * 3]
        })
      }
      frame = { h: d.readUInt16BE(1), w: d.readUInt16BE(3), comps }
    } else if (m === 0xda) {
      // SOS：只需要分量→Huffman 表映射
      const ns = d[0]
      for (let i = 0; i < ns; i++) {
        const id = d[1 + i * 2]
        const c = frame.comps.find((c) => c.id === id)
        c.td = d[2 + i * 2] >> 4
        c.ta = d[2 + i * 2] & 15
      }
      scanStart = p + 2 + L
      break
    }
    p += 2 + L
  }
  if (!frame) throw new Error('JPEG 里没有找到 SOF')
  if (scanStart < 0) throw new Error('JPEG 里没有找到 SOS')
  if (!qt[0]) throw new Error('JPEG 缺少量化表 0')

  const { w: W, h: H, comps } = frame
  const hmax = Math.max(...comps.map((c) => c.h))
  const vmax = Math.max(...comps.map((c) => c.v))
  const mcux = Math.ceil(W / (8 * hmax))
  const mcuy = Math.ceil(H / (8 * vmax))
  for (const c of comps) {
    c.bw = mcux * c.h * 8
    c.bh = mcuy * c.v * 8
    c.plane = new Uint8Array(c.bw * c.bh)
    c.q = qt[c.tq]
  }

  /* 熵解码：按 bit 读，处理 0xFF00 填充与 RST 标记 */
  const total = mcux * mcuy
  let bp = scanStart
  let bitBuf = 0
  let bitCnt = 0
  const resetBits = () => {
    // 扫描到下一个非 RST 的字节
    while (bp < buf.length - 1 && !(buf[bp] === 0xff && buf[bp + 1] !== 0x00 && !(buf[bp + 1] >= 0xd0 && buf[bp + 1] <= 0xd7))) bp++
    bitBuf = 0; bitCnt = 0
  }
  const nextByte = () => {
    if (bp >= buf.length) return 0
    const v = buf[bp++]
    if (v === 0xff) {
      const n = buf[bp]
      if (n === 0x00) { bp++; return 0xff }
      return v // 标记字节：交给上层继续读（会被当 0 用）
    }
    return v
  }
  const readBit = () => {
    if (bitCnt === 0) { bitBuf = nextByte(); bitCnt = 8 }
    bitCnt--
    return (bitBuf >> bitCnt) & 1
  }
  /* 逐位走 Huffman 码字，而不用 16 位查找表。
     位表看似更快，但这里错了两次都是它：JPEG 的 Huffman 码是"最长 16 位
     的前缀码"，用 code<<(16-len) 当索引时，只有当 len 位的 code 恰好是
     码字本身才成立；一旦写错一个移位，就会在整张图上表现为"直流系数
     全错、AC 读到 63 个"的雪崩。逐位版本 3 行、可读、可证，且解
     2048x1024 只要几百毫秒，不值得为速度冒这个险。 */
  const decodeHuff = (tbl) => {
    let code = 0
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | readBit()
      const s = tbl.codes[len][code]
      if (s >= 0) return s
    }
    throw new Error('JPEG Huffman 码字非法')
  }
  const receiveExtend = (s) => {
    if (s === 0) return 0
    let v = 0
    for (let i = 0; i < s; i++) v = (v << 1) | readBit()
    return extend(v, s)
  }

  const coef = new Float64Array(64)
  const blk = new Float64Array(64)
  const pred = new Int32Array(comps.length)
  let mcu = 0
  for (let my = 0; my < mcuy; my++) {
    for (let mx = 0; mx < mcux; mx++) {
      if (restartInterval && mcu > 0 && mcu % restartInterval === 0) {
        resetBits()
        pred.fill(0)
      }
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci]
        for (let by = 0; by < c.v; by++) {
          for (let bx = 0; bx < c.h; bx++) {
            const dcT = huffDC[c.td]
            const acT = huffAC[c.ta]
            if (!dcT || !acT) throw new Error('JPEG 引用了未定义的 Huffman 表')
            coef.fill(0)
            const t = decodeHuff(dcT)
            pred[ci] += receiveExtend(t)
            coef[0] = pred[ci] * c.q[0]
            for (let k = 1; k < 64;) {
              const rs = decodeHuff(acT)
              const s = rs & 15
              const r = rs >> 4
              if (s === 0) {
                if (r === 15) { k += 16; continue }
                break
              }
              k += r
              if (k > 63) break
              coef[ZIGZAG[k]] = receiveExtend(s) * c.q[ZIGZAG[k]]
              k++
            }
            idct8x8(coef, blk)
            const ox = (mx * c.h + bx) * 8
            const oy = (my * c.v + by) * 8
            for (let y = 0; y < 8; y++) {
              const row = (oy + y) * c.bw + ox
              for (let x = 0; x < 8; x++) {
                const v = Math.round(blk[y * 8 + x] + 128)
                c.plane[row + x] = v < 0 ? 0 : v > 255 ? 255 : v
              }
            }
          }
        }
      }
      mcu++
    }
  }

  /* 抽样还原（2x2 平均上采样，与 libjpeg 的 "fancy upsampling" 同思路） */
  const out = Buffer.alloc(W * H * 3)
  const ycc = new Float64Array(comps.length)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let ci = 0; ci < comps.length; ci++) {
        const c = comps[ci]
        let v
        if (c.h === hmax && c.v === vmax) {
          v = c.plane[Math.min(c.bh - 1, y) * c.bw + Math.min(c.bw - 1, x)]
        } else {
          const sx = (x * c.h) / hmax
          const sy = (y * c.v) / vmax
          const x0 = Math.floor(sx); const y0 = Math.floor(sy)
          const fx = sx - x0; const fy = sy - y0
          const x1 = Math.min(c.bw - 1, x0 + 1)
          const y1 = Math.min(c.bh - 1, y0 + 1)
          const g = (xx, yy) => c.plane[Math.min(c.bh - 1, yy) * c.bw + Math.min(c.bw - 1, xx)]
          v = (g(x0, y0) * (1 - fx) + g(x1, y0) * fx) * (1 - fy) +
              (g(x0, y1) * (1 - fx) + g(x1, y1) * fx) * fy
        }
        ycc[ci] = v
      }
      const Y = ycc[0]
      const Cb = ycc[1] - 128
      const Cr = ycc[2] - 128
      const o = (y * W + x) * 3
      out[o] = Math.max(0, Math.min(255, Math.round(Y + 1.402 * Cr)))
      out[o + 1] = Math.max(0, Math.min(255, Math.round(Y - 0.344136 * Cb - 0.714136 * Cr)))
      out[o + 2] = Math.max(0, Math.min(255, Math.round(Y + 1.772 * Cb)))
    }
  }
  return { w: W, h: H, ch: 3, data: out }
}

/* 无头 Chrome 兜底通道：仓库既有做法（tools/jupiter-prep.js 的 shoot）。
   本脚本自带 JPEG 解码器，覆盖了实测到的全部源文件；这里留一个
   Chrome 通道只是为了将来换源图时（比如碰到渐进式 JPEG）有路可走。 */
function decodeViaChrome (file, w, h) {
  fs.mkdirSync(TMP, { recursive: true })
  const prof = path.join(TMP, 'chrome-prof')
  fs.rmSync(prof, { recursive: true, force: true })
  const html = path.join(TMP, 'img.html')
  const png = path.join(TMP, 'img.png')
  const esc = (p) => path.resolve(p).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')
  fs.writeFileSync(html,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>` +
    `html,body{margin:0;padding:0;background:#000;overflow:hidden}` +
    `img{display:block;width:${w}px;height:${h}px}</style></head>` +
    `<body><img src="file:///${esc(file)}"></body></html>`)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions',
    '--force-device-scale-factor=1',
    `--window-size=${w},${h}`, '--virtual-time-budget=4000',
    '--screenshot=' + png, 'file:///' + esc(html)
  ], { stdio: 'ignore', timeout: 120000 })
  fs.rmSync(prof, { recursive: true, force: true })
  const img = decodePng(fs.readFileSync(png))
  fs.rmSync(png, { force: true })
  fs.rmSync(html, { force: true })
  return img
}

function decodeImage (file) {
  const buf = fs.readFileSync(file)
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return decodePng(buf)
  if (buf[0] === 0xff && buf[1] === 0xd8) return decodeJpegBaseline(buf)
  throw new Error('无法识别的图片格式: ' + file)
}

/* 写 8bit RGB/RGBA PNG（+3 字节/行的 filter 字节），供 pngToJpeg 使用 */
let CRC_T = null
function crc32 (buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_T[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function encodePng (w, h, ch, data) {
  const bpp = ch
  const raw = Buffer.alloc((w * bpp + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * bpp + 1)] = 0
    for (let i = 0; i < w * bpp; i++) raw[y * (w * bpp + 1) + 1 + i] = data[y * w * bpp + i]
  }
  const chunks = []
  const chunk = (type, d) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(d.length)
    const tb = Buffer.from(type, 'ascii')
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, d])))
    chunks.push(len, tb, d, cb)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = ch === 4 ? 6 : 2
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  chunk('IHDR', ihdr)
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 }))
  chunk('IEND', Buffer.alloc(0))
  return Buffer.concat(chunks)
}

/* 盒式滤波降采样：每个输出像素 = 对应源区间的面积平均。
   这是"像素覆盖"积分，等价于把源图当成阶梯函数做一次低通，
   比双线性抽点更抗混叠（金星云带的细密纹理、火星的噪点边缘）。 */
function boxDown (img, ow, oh) {
  const { w, h, ch, data } = img
  const out = Buffer.alloc(ow * oh * 3)
  for (let y = 0; y < oh; y++) {
    const y0 = Math.floor((y * h) / oh)
    const y1 = Math.min(h, Math.max(y0 + 1, Math.ceil(((y + 1) * h) / oh)))
    for (let x = 0; x < ow; x++) {
      const x0 = Math.floor((x * w) / ow)
      const x1 = Math.min(w, Math.max(x0 + 1, Math.ceil(((x + 1) * w) / ow)))
      let r = 0; let g = 0; let b = 0; let n = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * w + sx) * ch
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++
        }
      }
      const o = (y * ow + x) * 3
      out[o] = Math.round(r / n)
      out[o + 1] = Math.round(g / n)
      out[o + 2] = Math.round(b / n)
    }
  }
  return { w: ow, h: oh, ch: 3, data: out }
}

function stats (img) {
  let sum = 0; let dark = 0; let sumR = 0; let sumG = 0; let sumB = 0
  const n = img.w * img.h
  for (let i = 0; i < n; i++) {
    const r = img.data[i * img.ch]
    const g = img.data[i * img.ch + 1]
    const b = img.data[i * img.ch + 2]
    sumR += r; sumG += g; sumB += b
    sum += 0.299 * r + 0.587 * g + 0.114 * b
    if (Math.max(r, g, b) < 8) dark++
  }
  return {
    mean: sum / n / 255,
    meanR: sumR / n, meanG: sumG / n, meanB: sumB / n,
    darkFrac: dark / n
  }
}

/* ============================================================
   任务 1：6 张行星贴图 → 512x256 JPEG(q88)
   ============================================================ */
function runPlanets (only) {
  console.log('=== 任务 1：行星贴图 ' + OUT_W + 'x' + OUT_H + ' (JPEG q' + Q + ') ===')
  console.log('来源：' + CREDIT + '   源目录 .perf/planet-src/')
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.mkdirSync(TMP, { recursive: true })
  const list = only ? PLANETS.filter((p) => p.name === only) : PLANETS
  if (!list.length) die('--only=' + only + ' 不是已知行星（可选：' + PLANETS.map((p) => p.name).join('/') + '）')

  const rows = []
  for (const p of list) {
    const src = path.join(SRC_DIR, p.file)
    if (!fs.existsSync(src)) die('缺少源文件 ' + src)
    const img = decodeImage(src)
    console.log(`\n[${p.name}] ${p.file}  ${img.w}x${img.h} ch=${img.ch}`)
    // 断言 2:1 等距圆柱；不是就停下报告，绝不静默裁剪
    if (Math.abs(img.w / img.h - 2) > 1e-6) {
      die(`${p.file} 不是 2:1 等距圆柱贴图（${img.w}x${img.h}，比例 ${(img.w / img.h).toFixed(4)}）；` +
          '请换正确的贴图，而不是裁掉多余部分。')
    }
    const small = boxDown(img, OUT_W, OUT_H)
    const png = path.join(TMP, p.name + '.tmp.png')
    fs.writeFileSync(png, encodePng(small.w, small.h, 3, small.data))
    const r = pngToJpeg(png, path.join(OUT_DIR, p.out), Q)
    fs.rmSync(png, { force: true })

    // 重新解码写出的 JPEG 再校验（确认编码器/量化没把图压坏）
    const back = decodeImage(path.join(OUT_DIR, p.out))
    if (back.w !== OUT_W || back.h !== OUT_H) {
      die(`${p.out} 尺寸异常：期望 ${OUT_W}x${OUT_H}，实际 ${back.w}x${back.h}`)
    }
    const st = stats(back)
    if (st.darkFrac > 0) {
      die(`${p.out} 有 ${(st.darkFrac * 100).toFixed(3)}% 的像素 max(R,G,B)<8（疑似黑边/透明区）`)
    }
    if (!(st.mean >= 0.05 && st.mean <= 0.85)) {
      die(`${p.out} 平均亮度 ${st.mean.toFixed(4)} 越界（要求 0.05..0.85）`)
    }
    rows.push({
      name: p.name, out: p.out, size: `${back.w}x${back.h}`,
      kb: r.bytes / 1024, mean: st.mean, rgb: [st.meanR, st.meanG, st.meanB]
    })
  }

  console.log('\n--- 任务 1 汇总（重新解码输出文件后测得）---')
  console.log('name      file                 size        KB      mean    mean R/G/B')
  for (const r of rows) {
    console.log(
      r.name.padEnd(9) + r.out.padEnd(21) + r.size.padEnd(12) +
      r.kb.toFixed(1).padStart(6) + '  ' + r.mean.toFixed(4).padStart(7) + '   ' +
      r.rgb.map((v) => v.toFixed(1)).join(' / ')
    )
  }
  console.log(`\n断言：全部 ${rows.length} 张 = ${OUT_W}x${OUT_H}，无 max(R,G,B)<8 的像素，` +
    '平均亮度 ∈ [0.05, 0.85] ✅')
  return rows
}

/* ============================================================
   任务 2：土星环径向剖面 → saturn-ring.png (1024x1, RGBA8)
   ------------------------------------------------------------
   源图 2048x125 的 125 行内容几乎相同（每列行间抖动 ±6，是 8bit 量化残差），
   所以取【逐列竖直径向中位数】作为剖面，而不是水平扫描线或径向平均：
   - 不用单行：单行会带进 ±6 的抖动，在 1024 宽的输出上表现为锯齿；
   - 不用均值：C 环内侧是一串真实台阶（13/26/42/62…），均值会把台阶
     抹成斜坡，而台阶正是 C 环的细密结构；
   - 中位数同时做到"抗抖动"与"保台阶"。
   扫描方向 = x 方向（x 增大 = 半径增大，与 SSS 约定一致）。
   ============================================================ */
function runRing () {
  console.log('\n=== 任务 2：土星环径向剖面 → saturn-ring.png (1024x1 RGBA8) ===')
  const src = path.join(SRC_DIR, RING_SRC)
  if (!fs.existsSync(src)) die('缺少环纹理 ' + src)
  const img = decodeImage(src)
  console.log(`来源：${RING_SRC}  ${img.w}x${img.h} ch=${img.ch}   ${CREDIT}`)
  if (img.ch !== 4) die('环纹理期望带 alpha（RGBA），实际 ch=' + img.ch)

  // 校验：所有行是否一致。实测每列在行方向上有 ±6 的抖动（源图是 8bit 量化
  // 出来的，行与行之间并不是位相同的复制），所以不能简单取一行当剖面。
  const yc = Math.floor((img.h - 1) / 2)
  let maxRowDiff = 0
  let rowSpreadMax = 0
  for (let x = 0; x < img.w; x++) {
    let lo = 255; let hi = 0
    for (let y = 0; y < img.h; y++) {
      const v = img.data[(y * img.w + x) * 4 + 3]
      if (v < lo) lo = v
      if (v > hi) hi = v
      const d = Math.abs(v - img.data[(yc * img.w + x) * 4 + 3])
      if (d > maxRowDiff) maxRowDiff = d
    }
    if (hi - lo > rowSpreadMax) rowSpreadMax = hi - lo
  }
  console.log(`剖面取法：竖直径向【中位数】（对每一列 x 取 125 行的中位数）。` +
    `行方向抖动实测：与 y=${yc} 的最大差 ${maxRowDiff}、单列跨行极差最大 ${rowSpreadMax}`)
  if (rowSpreadMax > 16) die('环纹理行间差异过大（' + rowSpreadMax + '），已不满足"1D 剖面竖向铺满"的前提，请人工复核')

  const SW = img.w
  const profA = new Float64Array(SW)
  const profR = new Float64Array(SW)
  const profG = new Float64Array(SW)
  const profB = new Float64Array(SW)
  /* 每列取 125 行的中位数：
     - 中位数而不是均值 —— C 环内侧是一串平台（13/26/42/62…），这些台阶是真实的
       环结构，取均值会被相邻台阶与抖动抹成斜坡；中位数保留台阶、去掉抖动。
     - 颜色同样取中位数，但只用 alpha>0 的行（alpha=0 的行 RGB 是白色无意义值）。 */
  const med = (arr, n) => {
    const s = arr.slice(0, n).sort((a, b) => a - b)
    return s[n >> 1]
  }
  for (let x = 0; x < SW; x++) {
    const cl = []
    for (let y = 0; y < img.h; y++) cl.push(img.data[(y * SW + x) * 4 + 3])
    profA[x] = med(cl, img.h)
    // 颜色：只统计 alpha>=最大alpha一半的行，避免把边缘噪声行的颜色混进来
    const ar = []; const ag = []; const ab = []
    for (let y = 0; y < img.h; y++) {
      const i = (y * SW + x) * 4
      if (img.data[i + 3] * 2 >= profA[x] && img.data[i + 3] > 0) {
        ar.push(img.data[i]); ag.push(img.data[i + 1]); ab.push(img.data[i + 2])
      }
    }
    if (ar.length) {
      profR[x] = med(ar, ar.length); profG[x] = med(ag, ag.length); profB[x] = med(ab, ab.length)
    }
  }
  /* 源图在 alpha=0 处 RGB 是无意义值（外缘是白色 255,255,255）。但 alpha=0
     有两种含义，必须分开处理：
       (a) 环之外的空白（x<110 和 x>2047 附近）—— 颜色无所谓，反正 A=0；
       (b) **环内部的缝**（恩克缝 1947..1964、A 环外缘 1965 起）—— 这里
           RGB 仍然必须写"环的颜色"，否则直 alpha 纹理在缝里会透出黑边，
           而不是"透出背景"。
     所以颜色剖面只对"被 alpha>0 夹住"的空洞做最近有效值填补（闭运算思路），
     两端的空白则沿用最外侧的有效颜色。alpha 剖面不动，缝隙依然是透明的。 */
  const valid = (x) => x >= 0 && x < SW && profA[x] > 0
  let firstV = -1; let lastV = -1
  for (let x = 0; x < SW; x++) if (valid(x)) { if (firstV < 0) firstV = x; lastV = x }
  if (firstV < 0) die('环纹理里找不到任何 alpha>0 的像素')
  const fillR = Float64Array.from(profR)
  const fillG = Float64Array.from(profG)
  const fillB = Float64Array.from(profB)
  const NEAR = 2
  for (let x = firstV; x <= lastV; x++) {
    if (valid(x)) continue
    let l = -1; let r = -1
    for (let k = x - 1; k >= firstV && k >= x - NEAR; k--) if (valid(k)) { l = k; break }
    for (let k = x + 1; k <= lastV && k <= x + NEAR; k++) if (valid(k)) { r = k; break }
    let s = -1
    if (l >= 0 && r >= 0) s = (x - l) <= (r - x) ? l : r
    else if (l >= 0) s = l
    else if (r >= 0) s = r
    if (s >= 0) { fillR[x] = profR[s]; fillG[x] = profG[s]; fillB[x] = profB[s] }
  }
  for (let x = 0; x < firstV; x++) { fillR[x] = fillR[firstV]; fillG[x] = fillG[firstV]; fillB[x] = fillB[firstV] }
  for (let x = lastV + 1; x < SW; x++) { fillR[x] = fillR[lastV]; fillG[x] = fillG[lastV]; fillB[x] = fillB[lastV] }
  let holes = 0
  for (let x = firstV; x <= lastV; x++) if (!valid(x)) holes++
  console.log(`颜色剖面填补：环内部 alpha=0 的空洞 ${holes} 个源像素（恩克缝 / A 环外缘）已用邻近环色填充；` +
    `alpha 剖面保持原样`)

  // 双线性重采样 2048 → 1024（x=0 ↔ 1.11 R_S，x=1023 ↔ 2.32 R_S）
  const OL = RING_OUT_LEN
  const a = new Float64Array(OL)
  const cr = new Float64Array(OL)
  const cg = new Float64Array(OL)
  const cb = new Float64Array(OL)
  for (let x = 0; x < OL; x++) {
    const sx = (x * (SW - 1)) / (OL - 1)
    const i0 = Math.floor(sx)
    const i1 = Math.min(SW - 1, i0 + 1)
    const f = sx - i0
    a[x] = profA[i0] * (1 - f) + profA[i1] * f
    cr[x] = fillR[i0] * (1 - f) + fillR[i1] * f
    cg[x] = fillG[i0] * (1 - f) + fillG[i1] * f
    cb[x] = fillB[i0] * (1 - f) + fillB[i1] * f
  }
  /* 端点淡出：源图内缘有一圈 value=7 的量化噪声底。环必须两端 alpha=0，
     否则内外边界会切出硬边。
     - 内缘斜坡 69 px（≈1.11~1.13 R_S）：这段在源图里本来就是 0..7 的噪声底
       （D 环位置、数据缺失），直接归零没有信息损失。
     - 外缘斜坡只做 1 px：源图最后一列 alpha=7/255≈2.7%，如果也铺 5~6 px 的
       斜坡，把 F 环（2.28~2.32 R_S，实测 alpha≈4~13）抹掉 3% 半径；既然
       alpha>0 的第一个输出像素就在末端，1 px 斜坡即可满足"端点严格为 0"，
       代价最小。 */
  const FADE_IN = Math.max(1, Math.round(OL * (0.02 / (RING_OUTER_RS - RING_INNER_RS))))
  const FADE_OUT = 1
  for (let x = 0; x < OL; x++) {
    if (x < FADE_IN) a[x] *= x / FADE_IN
    const tail = OL - 1 - x
    if (tail < FADE_OUT) a[x] *= tail / FADE_OUT
  }
  a[0] = 0; a[OL - 1] = 0

  // 打包 RGBA8（straight / 非预乘 alpha：RGB 就是环的颜色，A 是覆盖度）
  const px = Buffer.alloc(OL * 4)
  for (let x = 0; x < OL; x++) {
    px[x * 4] = Math.max(0, Math.min(255, Math.round(cr[x])))
    px[x * 4 + 1] = Math.max(0, Math.min(255, Math.round(cg[x])))
    px[x * 4 + 2] = Math.max(0, Math.min(255, Math.round(cb[x])))
    px[x * 4 + 3] = Math.max(0, Math.min(255, Math.round(a[x])))
  }
  const outPath = path.join(OUT_DIR, 'saturn-ring.png')
  fs.writeFileSync(outPath, encodePng(OL, 1, 4, px))
  console.log(`写出 ${path.relative(ROOT, outPath)}  ${fs.statSync(outPath).size} 字节`)

  // 用 decodePng 复核写出的文件
  const back = decodePng(fs.readFileSync(outPath))
  if (back.w !== OL || back.h !== 1 || back.ch !== 4) {
    die(`saturn-ring.png 期望 ${OL}x1 RGBA，实际 ${back.w}x${back.h} ch=${back.ch}`)
  }
  const A = (x) => back.data[x * 4 + 3]
  const rad = (x) => RING_INNER_RS + (x / (OL - 1)) * (RING_OUTER_RS - RING_INNER_RS)

  // 16 个等间距半径采样
  console.log('\n16 个等间距半径采样（alpha 0..255，RGB 为该处环色）：')
  console.log('  i     x     R_S      alpha   RGB')
  for (let k = 0; k < 16; k++) {
    const x = Math.round((k * (OL - 1)) / 15)
    console.log('  ' + String(k).padStart(2) + '  ' + String(x).padStart(5) + '   ' +
      rad(x).toFixed(3) + '   ' + String(A(x)).padStart(5) + '   ' +
      [back.data[x * 4], back.data[x * 4 + 1], back.data[x * 4 + 2]].join(','))
  }

  /* 卡西尼缝：在 B 环外缘与 A 环内缘之间（约 1.80~1.98 R_S）找 alpha 局部极小。
     限定范围是必要的 —— 恩克缝（约 2.21 R_S）的 alpha 更低，全局极小会选错。 */
  const lo = Math.round(((1.80 - RING_INNER_RS) / (RING_OUTER_RS - RING_INNER_RS)) * (OL - 1))
  const hi = Math.round(((1.98 - RING_INNER_RS) / (RING_OUTER_RS - RING_INNER_RS)) * (OL - 1))
  let cx = lo
  for (let x = lo; x <= hi; x++) if (A(x) < A(cx)) cx = x
  console.log(`\n卡西尼缝：x=${cx}  → ${rad(cx).toFixed(4)} R_S   alpha=${A(cx)}` +
    `（真实值 1.95 R_S，切线位置误差 ${(rad(cx) - 1.95).toFixed(4)} R_S = ${(Math.abs(rad(cx) - 1.95) * 60268).toFixed(0)} km）`)

  // 其它已知结构的诊断输出（不参与断言，仅用于人工判断剖面是否可信）
  const findMin = (r0, r1) => {
    const i0 = Math.round(((r0 - RING_INNER_RS) / (RING_OUTER_RS - RING_INNER_RS)) * (OL - 1))
    const i1 = Math.round(((r1 - RING_INNER_RS) / (RING_OUTER_RS - RING_INNER_RS)) * (OL - 1))
    let bx = i0
    for (let x = i0; x <= i1; x++) if (A(x) < A(bx)) bx = x
    return bx
  }
  const encke = findMin(2.15, 2.28)
  console.log(`恩克缝（在 2.15~2.28 R_S 内找极小）：x=${encke} → ${rad(encke).toFixed(4)} R_S  alpha=${A(encke)}（真实 2.214 R_S）`)
  const firstOpaque = (() => { for (let x = 0; x < OL; x++) if (A(x) > 0) return x; return -1 })()
  const lastOpaque = (() => { for (let x = OL - 1; x >= 0; x--) if (A(x) > 0) return x; return -1 })()
  console.log(`有 alpha>0 的范围：x ${firstOpaque}..${lastOpaque} → ${rad(firstOpaque).toFixed(3)}..${rad(lastOpaque).toFixed(3)} R_S`)
  const bmax = (() => { let bx = 0; for (let x = 0; x < OL; x++) if (A(x) > A(bx)) bx = x; return bx })()
  console.log(`B 环最亮处：x=${bmax} → ${rad(bmax).toFixed(4)} R_S  alpha=${A(bmax)}`)

  // 断言
  if (A(0) !== 0 || A(OL - 1) !== 0) die(`两端 alpha 必须为 0，实际 ${A(0)} / ${A(OL - 1)}`)
  const ringInterior = []
  for (let x = 1; x < OL - 1; x++) if (A(x) > 0) ringInterior.push(x)
  if (!ringInterior.length) die('剖面里没有任何 alpha>0 的像素')
  /* 注意：局部极小只能在"环的内部"找。两端的淡出斜坡本身就是一路降到 0 的，
     如果把整条剖面都算进去，最深的极小永远是端点附近的斜坡（第一版就是
     这样误报了 x=1020），而不是真实的缝。这里在 1.20~2.28 R_S 之间找。 */
  const iLo = Math.round(((1.20 - RING_INNER_RS) / (RING_OUTER_RS - RING_INNER_RS)) * (OL - 1))
  const iHi = Math.round(((2.28 - RING_INNER_RS) / (RING_OUTER_RS - RING_INNER_RS)) * (OL - 1))
  let localMin = -1
  for (let x = iLo + 2; x <= iHi - 2; x++) {
    if (A(x) < A(x - 1) && A(x) < A(x + 1) && A(x) < A(x - 2) && A(x) < A(x + 2)) {
      if (localMin < 0 || A(x) < A(localMin)) localMin = x
    }
  }
  if (localMin < 0) die('环内部找不到任何局部极小（缺缝）')
  if (A(cx) >= A(bmax) * 0.9) die('卡西尼缝处的 alpha 没有明显低于 B 环峰值，剖面可疑')
  if (Math.abs(rad(cx) - 1.95) > 0.05) {
    die(`卡西尼缝位置 ${rad(cx).toFixed(3)} R_S 偏离真实值 1.95 R_S 超过 0.05 R_S，半径映射可疑`)
  }
  console.log(`\n环内部最深局部极小：x=${localMin} → ${rad(localMin).toFixed(4)} R_S  alpha=${A(localMin)}` +
    `（卡西尼缝 x=${cx}，两者相距 ${(Math.abs(localMin - cx) * (RING_OUTER_RS - RING_INNER_RS) / (OL - 1)).toFixed(4)} R_S）`)
  console.log('断言：两端 alpha=0 ✅   环内部存在清晰局部极小（卡西尼缝）✅   卡西尼缝落在 1.95±0.05 R_S ✅')
  return { ax: cx, alpha: A(cx), rs: rad(cx) }
}

/* ============================================================ */
function main () {
  const argv = process.argv.slice(2)
  const onlyArg = argv.find((a) => a.startsWith('--only='))
  const only = onlyArg ? onlyArg.split('=')[1] : null
  const ringOnly = argv.includes('--ring')
  const wantRing = ringOnly || !only

  if (!ringOnly) runPlanets(only)
  if (wantRing) runRing()
  console.log('\n完成。')
}

/* 作为模块使用时导出解码器（tools/jupiter-map-final.js 复用它来复核输出，
   避免在仓库里出现第二份 JPEG 解码实现）；直接 `node tools/planet-resize.js`
   时仍然走下面的 main()。 */
module.exports = { decodeJpegBaseline, decodeImage, encodePng, boxDown }

if (require.main === module) main()
