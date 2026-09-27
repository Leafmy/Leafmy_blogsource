'use strict'
/* ============================================================
   木星照片预处理 (tools/jupiter-prep.js)
   ------------------------------------------------------------
   官方图是"黑底 + 居中圆盘"，但圆盘并不精确居中、四周留白也不均匀，
   直接 border-radius:50% 裁切会切掉云带或留下多余黑角。
   本脚本：
     1) 用无头 Chrome 把源图渲染成 PNG 并解码像素（不引入 sharp/jimp
        之类的原生依赖）；
     2) 用【较高亮度阈值 + 逐行/逐列取边界再取中位数】定位圆盘 ——
        阈值取低会把 JPEG 压缩噪点算进去、取高会削掉暗淡的极区，
        因此取 60 并配中位数抗噪；
     3) 按"圆盘刚好内切 + 极小呼吸边"算出一个正方形裁剪框；
     4) 一次渲染直接输出 1x / 2x 两档（用 transform 缩放，避免二次插值）。

   用法: node tools/jupiter-prep.js <src.jpg> <outDir> [srcSize]
   ============================================================ */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')

const SRC = process.argv[2]
const OUT = process.argv[3] || 'source/img'
const SRC_SIZE = Number(process.argv[4] || 1312)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const TMP = path.join(__dirname, '..', '.perf', 'jupiter-prep')

if (!SRC || !fs.existsSync(SRC)) {
  console.error('用法: node tools/jupiter-prep.js <src.jpg> <outDir> [srcSize]')
  process.exit(1)
}

function decodePng (buf) {
  let p = 8; let w = 0; let h = 0; let ct = 0
  const idat = []
  while (p < buf.length) {
    const L = buf.readUInt32BE(p)
    const t = buf.toString('ascii', p + 4, p + 8)
    const d = buf.slice(p + 8, p + 8 + L)
    if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9] }
    else if (t === 'IDAT') idat.push(d)
    else if (t === 'IEND') break
    p += 12 + L
  }
  const ch = ct === 6 ? 4 : 3
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

/* 用无头 Chrome 渲染一段 HTML 并截图（本机没有 canvas 库，这是最省事的
   光栅化通道）。返回截图像素。 */
function shoot (html, outPng, winW, winH, scale) {
  const prof = path.join(TMP, 'chrome-prof')
  fs.rmSync(prof, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  const htmlPath = outPng.replace(/\.png$/, '.html')
  fs.writeFileSync(htmlPath, html)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions',
    '--force-device-scale-factor=' + (scale || 1),
    `--window-size=${winW},${winH}`,
    '--virtual-time-budget=4000',
    '--screenshot=' + outPng,
    'file:///' + path.resolve(htmlPath).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')
  ], { stdio: 'ignore', timeout: 120000 })
  fs.rmSync(prof, { recursive: true, force: true })
  fs.rmSync(htmlPath, { force: true })
  if (!fs.existsSync(outPng)) throw new Error('截图失败: ' + outPng)
  return decodePng(fs.readFileSync(outPng))
}

const fileUrl = p => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')

function median (arr) {
  if (!arr.length) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function main () {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })

  // 1) 源图 → PNG 像素
  console.log('1) 渲染源图并解码像素…')
  const img = shoot(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:#000;overflow:hidden}
       img{display:block;width:${SRC_SIZE}px;height:${SRC_SIZE}px}
     </style></head><body><img src="${fileUrl(SRC)}"></body></html>`,
    path.join(TMP, 'full.png'), SRC_SIZE, SRC_SIZE, 1
  )
  console.log(`   ${img.w}x${img.h}`)

  // 2) 定位圆盘：逐行/逐列取边界，再取中位数抗 JPEG 噪点
  const TH = 60
  const lum = (x, y) => {
    const i = (y * img.w + x) * img.ch
    return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
  }
  const rowL = []; const rowR = []; const colT = []; const colB = []
  for (let y = 0; y < img.h; y++) {
    let l = -1; let r = -1
    for (let x = 0; x < img.w; x++) if (lum(x, y) > TH) { if (l < 0) l = x; r = x }
    if (l >= 0) { rowL.push(l); rowR.push(r) }
  }
  for (let x = 0; x < img.w; x++) {
    let t = -1; let b = -1
    for (let y = 0; y < img.h; y++) if (lum(x, y) > TH) { if (t < 0) t = y; b = y }
    if (t >= 0) { colT.push(t); colB.push(b) }
  }
  const left = median(rowL); const right = median(rowR)
  const top = median(colT); const bottom = median(colB)
  // 极值（外接盒）用于估计真实半径
  const minX = Math.min(...rowL); const maxX = Math.max(...rowR)
  const minY = Math.min(...colT); const maxY = Math.max(...colB)
  console.log(`2) 圆盘边界中位数: x ${left}..${right}  y ${top}..${bottom}`)
  console.log(`   外接盒:           x ${minX}..${maxX}  y ${minY}..${maxY}`)

  // 圆心取外接盒中心；半径取两个方向的最大半径（取大值才不会切到边）
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const r = Math.max(maxX - minX, maxY - minY) / 2
  console.log(`   圆心 (${cx.toFixed(1)}, ${cy.toFixed(1)})  半径 ${r.toFixed(1)}`)

  // 3) 裁切框：圆盘刚好内切 + 0.6% 呼吸边
  const side = Math.round(r * 2 * 1.006)
  const cropL = Math.round(cx - side / 2)
  const cropT = Math.round(cy - side / 2)
  console.log(`3) 裁切 ${side}x${side} @ (${cropL}, ${cropT})`)

  // 4) 输出两档。用 transform: scale(k) 把源图放大后再用 -cropL*k 平移，
  //    这样坐标系始终是"源图像素 × k"，不会出现尺寸/偏移单位不一致。
  //    [为什么出 JPEG 不出 PNG] 云带是连续渐变色，PNG 无损要 600KB+，
  //    而 JPEG q=0.9 只要 1/4 左右且肉眼无差；配合 source 端 JPEG 底，
  //    圆盘外的纯黑四角由 CSS 的 border-radius 裁掉，不会露出黑边。
  fs.mkdirSync(OUT, { recursive: true })
  const { pngToJpeg } = require('./png-to-jpeg.js')
  const targets = [
    { name: 'jupiter-760.jpg', size: 760 },
    { name: 'jupiter-1140.jpg', size: 1140 }
  ]
  for (const t of targets) {
    const k = t.size / side
    const out = path.join(OUT, t.name)
    // 一次渲染：源图先按 k 放大，再用 -cropL*k 平移，裁出 side*k 的正方形。
    // 用 transform-origin:0 0 保证缩放与平移的坐标系一致（源图像素 × k）。
    const shotPng = path.join(TMP, t.name.replace(/\.jpg$/, '.png'))
    const img = shoot(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
         html,body{margin:0;padding:0;background:#000;overflow:hidden}
         #box{position:relative;width:${t.size}px;height:${t.size}px;overflow:hidden}
         img{position:absolute;left:0;top:0;display:block;
             width:${SRC_SIZE}px;height:${SRC_SIZE}px;
             transform-origin:0 0;transform:scale(${k}) translate(${-cropL}px, ${-cropT}px)}
       </style></head><body><div id="box"><img src="${fileUrl(SRC)}"></div></body></html>`,
      shotPng, t.size, t.size, 1
    )
    // 校验裁切质量：圆盘应当几乎填满画面且居中
    const pngLum = (x, y) => {
      const i = (y * img.w + x) * img.ch
      return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
    }
    let a = img.w; let b = -1; let c = img.h; let d = -1
    for (let y = 0; y < img.h; y++) {
      for (let x = 0; x < img.w; x++) {
        if (pngLum(x, y) > 60) { if (x < a) a = x; if (x > b) b = x; if (y < c) c = y; if (y > d) d = y }
      }
    }
    const fillW = (b - a + 1) / img.w
    const fillH = (d - c + 1) / img.h
    const offX = (a + b) / 2 - img.w / 2
    const offY = (c + d) / 2 - img.h / 2
    const okFill = fillW > 0.97 && fillH > 0.97
    const centered = Math.abs(offX) < 8 && Math.abs(offY) < 8
    // 编码 JPEG（Chrome 只能出 PNG，JPEG 交给本地编码器）
    const r = pngToJpeg(shotPng, out, 90)
    console.log(`4) ${t.name}  ${t.size}x${t.size}  ${(r.bytes / 1024).toFixed(0)} KB`)
    console.log(`   校验: 圆盘占框 ${(fillW * 100).toFixed(1)}% x ${(fillH * 100).toFixed(1)}%` +
      `   居中偏移 (${offX.toFixed(0)}, ${offY.toFixed(0)})` +
      `   ${okFill && centered ? '✅ 合格' : '⚠️ 需检查'}`)
  }
  console.log('\n完成。')
}

main()
