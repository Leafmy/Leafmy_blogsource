'use strict'
/* ============================================================
   贴图比对图 (tools/compare-jupiter-map.js)
   ------------------------------------------------------------
   把"贴图 vs 真实照片"的比对**画出来**，而不是只给数字。
   动机：tools/verify-space-render.js 的两个经度最优解差了 146°，
   在看不到图的情况下无法判断是"映射写错了"还是"贴图背面是镜像填充"。
   数字看不出这类问题，图一眼就能看出。

   输出一张三行的条带图：
     第 1 行：参考照片圆面
     第 2 行：按最佳经度偏移用贴图重建出的同一半球
     第 3 行：逐像素亮度差（红=贴图更亮，蓝=参考更亮，灰=一致）

   用法: node tools/compare-jupiter-map.js [贴图] [输出png] [偏移度]
        默认贴图 source/img/jupiter-map.jpg
        默认输出 .perf/shots/jupiter-compare.png
        不给偏移时自动扫描（与 verify 同一套指标）
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage, encodePng } = require('./planet-resize.js')
const { detectDisk } = require('./verify-space-render.js')

const ROOT = path.join(__dirname, '..')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const MAP_PATH = positional[0] ? path.resolve(positional[0]) : path.join(ROOT, 'source', 'img', 'jupiter-map.jpg')
const OUT_PATH = positional[1] ? path.resolve(positional[1]) : path.join(ROOT, '.perf', 'shots', 'jupiter-compare.png')
const FORCE_OFF = positional[2] != null ? Number(positional[2]) : null
const REF_PATH = path.join(ROOT, '.perf', 'jupiter-src', 'heic2404b-large.jpg')

const SRGB_TO_LIN = new Float64Array(256)
const LIN_TO_SRGB = new Uint8Array(1024)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
for (let i = 0; i < 1024; i++) {
  const l = i / 1023
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  LIN_TO_SRGB[i] = Math.max(0, Math.min(255, Math.round(s * 255)))
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b
const enc = (lin) => LIN_TO_SRGB[Math.max(0, Math.min(1023, Math.round(lin * 1023)))]

function sampleMap (map, u, v, out) {
  const { w, h, ch, data } = map
  const uu = u - Math.floor(u)
  const vv = v < 0 ? 0 : v > 1 ? 1 : v
  const x = uu * (w - 1), y = vv * (h - 1)
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const x1 = (x0 + 1) % w
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  for (let c = 0; c < 3; c++) {
    const a = SRGB_TO_LIN[data[(y0 * w + x0) * ch + c]]
    const b = SRGB_TO_LIN[data[(y0 * w + x1) * ch + c]]
    const cc = SRGB_TO_LIN[data[(y1 * w + x0) * ch + c]]
    const d = SRGB_TO_LIN[data[(y1 * w + x1) * ch + c]]
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy
  }
  return out
}

function main () {
  const map = decodeImage(MAP_PATH)
  const ref = decodeImage(REF_PATH)
  const disk = detectDisk(ref)
  const rx = disk.rFromRows, ry = disk.rFromCols
  const W = Math.round(2 * rx)
  const H = Math.round(2 * ry)

  const rgb = [0, 0, 0]
  function renderAt (off) {
    const out = Buffer.alloc(W * H * 3)
    const dif = Buffer.alloc(W * H * 3)
    let sum = 0, n = 0, sumAbs = 0
    for (let yy = 0; yy < H; yy++) {
      for (let xx = 0; xx < W; xx++) {
        /* 椭圆 → 单位球：横坐标按 rx 折算（与 verify-space-render.js 同一套推导） */
        const xEqu = ((xx - W / 2) / (H / 2)) * (W / H)
        const yLat = (yy - H / 2) / (H / 2)
        const rho2 = xEqu * xEqu + yLat * yLat
        const o = (yy * W + xx) * 3
        if (rho2 > 1) { out[o] = out[o + 1] = out[o + 2] = 0; dif[o] = dif[o + 1] = dif[o + 2] = 0; continue }
        const lat = Math.asin(Math.max(-1, Math.min(1, -yLat)))
        const lonObs = Math.atan2(xEqu, Math.sqrt(Math.max(1e-9, 1 - rho2)))
        const lon = lonObs + off * Math.PI / 180
        sampleMap(map, (lon / (2 * Math.PI)) + 0.5, 0.5 - lat / Math.PI, rgb)
        out[o] = enc(rgb[0]); out[o + 1] = enc(rgb[1]); out[o + 2] = enc(rgb[2])
        // 参考像素（同一归一化坐标）
        const sx = Math.round(disk.cx - rx + xx)
        const sy = Math.round(disk.cy - ry + yy)
        if (sx < 0 || sy < 0 || sx >= ref.w || sy >= ref.h) continue
        const p = (sy * ref.w + sx) * ref.ch
        const rl = SRGB_TO_LIN[ref.data[p]], gl = SRGB_TO_LIN[ref.data[p + 1]], bl = SRGB_TO_LIN[ref.data[p + 2]]
        if (rho2 < 0.86 * 0.86) {
          const d = luma(rgb[0], rgb[1], rgb[2]) - luma(rl, gl, bl)
          sum += d * d; sumAbs += Math.abs(d); n++
          // 差值可视化：以 0.25 线性亮度为满量程
          const k = Math.max(-1, Math.min(1, d / 0.25))
          dif[o] = k > 0 ? 200 : 60
          dif[o + 1] = Math.round(120 * (1 - Math.abs(k)))
          dif[o + 2] = k < 0 ? 230 : 50
        }
      }
    }
    return { out, dif, rms: Math.sqrt(sum / Math.max(1, n)), mae: sumAbs / Math.max(1, n), n }
  }

  /* 临时诊断：把两个缓冲区的实际内容统计打出来（见下方 --debug-rows） */
  if (process.argv.includes('--debug-rows')) {
    const r = renderAt(FORCE_OFF != null ? FORCE_OFF : 100)
    const stat = (b) => {
      let n = 0, mx = 0, firstNonZero = -1
      for (let i = 0; i < b.length; i++) {
        if (b[i] !== 0) { n++; if (firstNonZero < 0) firstNonZero = i; if (b[i] > mx) mx = b[i] }
      }
      return '非零 ' + n + '/' + b.length + ' 首非零下标 ' + firstNonZero + ' 最大 ' + mx
    }
    console.log('renderAt 诊断  off=' + (FORCE_OFF != null ? FORCE_OFF : 100) + '  n=' + r.n +
      '  rms=' + r.rms.toFixed(4))
    console.log('  out: ' + stat(r.out))
    console.log('  dif: ' + stat(r.dif))
    return
  }

  /* 自动扫描：用**逐像素亮度差的 RMS** 当判据（比纬度相关灵敏得多，
     而且不依赖"最佳对齐"这个前提 —— 谁对齐了谁就小）。
     360 个偏移各渲染一遍是几秒的事，只做一轮，后面复用结果。 */
  const offs = FORCE_OFF != null ? [FORCE_OFF] : Array.from({ length: 360 }, (_, i) => i)
  const results = offs.map((off) => { const r = renderAt(off); return { off, r, rms: r.rms } })
  const all = results.slice().sort((a, b) => a.rms - b.rms)
  const best = all[0]
  console.log('贴图 ' + path.relative(ROOT, MAP_PATH))
  console.log('最佳经度偏移 ' + best.off + '°   逐像素亮度 RMS ' + best.rms.toFixed(4) +
    '   平均绝对差 ' + best.r.mae.toFixed(4) + '   样本 ' + best.r.n)

  /* 第二、第三名：如果"相差很大"的偏移也能给出接近的 RMS，说明这张贴图
     沿经度方向缺乏鉴别性（背面很可能是镜像/平均填充），这本身就是结论。 */
  console.log('\n最佳 5 个偏移：' + all.slice(0, 5).map((a) => a.off + '°(' + a.rms.toFixed(4) + ')').join('  '))
  const far = all.filter((a) => Math.abs(((a.off - best.off + 540) % 360) - 180) < 60)
  console.log('对面 120° 扇区里的最好成绩：' + (far.length
    ? far.slice(0, 3).map((a) => a.off + '°(' + a.rms.toFixed(4) + ')').join('  ')
    : '（无）'))
  const ratio = far.length ? far[0].rms / all[0].rms : NaN
  console.log('  对面/最佳 RMS 比 = ' + (isFinite(ratio) ? ratio.toFixed(3) : 'n/a') +
    '（接近 1 说明经度方向几乎无鉴别性）')

  /* 拼三行：参考 / 重建 / 差值 */
  const gap = 6
  const TH = H * 3 + gap * 2
  const img = Buffer.alloc(W * TH * 3)
  const refRow = Buffer.alloc(W * H * 3)
  for (let yy = 0; yy < H; yy++) {
    for (let xx = 0; xx < W; xx++) {
      const sx = Math.round(disk.cx - rx + xx)
      const sy = Math.round(disk.cy - ry + yy)
      const o = (yy * W + xx) * 3
      if (sx < 0 || sy < 0 || sx >= ref.w || sy >= ref.h) continue
      const p = (sy * ref.w + sx) * ref.ch
      refRow[o] = ref.data[p]; refRow[o + 1] = ref.data[p + 1]; refRow[o + 2] = ref.data[p + 2]
    }
  }
  const put = (row, buf) => buf.copy(img, row * W * 3)
  put(0, refRow)
  put(1, best.r.out)
  put(2, best.r.dif)
  /* 自检：三行各自都要有内容。曾经第 2/3 行整行全黑而脚本毫无报错 ——
     "写出去一张图"不等于"写出去的是对的图"，所以在这里就把每行的
     非黑像素数打出来，一眼能看出哪一行是空的。 */
  const rowStat = (row) => {
    let n = 0
    for (let i = 0; i < W * H; i++) {
      const o = (row * H * W + i) * 3
      if (img[o] > 8 || img[o + 1] > 8 || img[o + 2] > 8) n++
    }
    return n + '/' + (W * H) + ' (' + (n / (W * H) * 100).toFixed(1) + '%)'
  }
  console.log('\n三行自检：参考 ' + rowStat(0) + '  重建 ' + rowStat(1) + '  差值 ' + rowStat(2))
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true })
  fs.writeFileSync(OUT_PATH, encodePng(W, TH, 3, img))
  console.log('\n写入 ' + path.relative(ROOT, OUT_PATH) + '  (' + W + 'x' + TH + ')')
  console.log('  第 1 行 = 参考照片圆面 / 第 2 行 = 贴图重建 / 第 3 行 = 亮度差（蓝=贴图更暗，红=更亮）')
}

if (require.main === module) main()
