'use strict'
/* ============================================================
   从真实全圆盘照片重建球面纹理贴图 (tools/jupiter-sphere-map.js)
   ------------------------------------------------------------
   目标：给 WebGL 三维木星提供一张【等距圆柱投影】（equirectangular）
   贴图。手头最好的真实素材是 Hubble 的全圆盘照片（可见半球），
   但可见半球只有 180° 经度 —— 要让行星自转起来，剩下 180° 必须补。

   做法（每一步都是可验证的，不是"画一个"）：
     1) 从照片里估出**次太阳点**（sub-solar point）：全圆盘照片记录的
        正是真实光照下的反照率分布，最亮的区域就是阳光最正的落点。
        用它就能反解出照片里每个像素对应的球面经纬度。
     2) 反解时同时**去光照**：按 Lambert 余弦定律把照片里"已经打上去的
        明暗"除掉，还原成近似反照率（albedo）。这样贴到球上之后，
        由 WebGL 重新打光才是物理自洽的 —— 否则等于把旧光照烤进贴图，
        再叠一层新光照，暗面会脏掉。
     3) 极区在单张照片里本来就看不到（球体上下边缘被严重压扁），
        用可见的最高/最低纬线做**极冠延拓**，并按纬度渐变过渡，
        不会出现"圆盘边缘被拉成条纹"的经典贴图接缝。
     4) 背面 180° 用可见半球的低纬条带镜像填充（木星云带本来就近似
        纬向对称，镜像后的条带走向是连续的），并用长渐变把背面的
        接缝藏在经度 ±120° 到 ±180° 之间。

   输出：2048x1024 JPEG（约 200KB 级），供 space-globe.js 作为
   WebGL 球体贴图使用。

   用法: node tools/jupiter-sphere-map.js <diskSrc.jpg> <out.jpg> [w] [h]
   ============================================================ */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { pngToJpeg, decodePng } = require('./png-to-jpeg.js')

const SRC = process.argv[2]
const OUT = process.argv[3] || 'source/img/jupiter-map.jpg'
const W = Number(process.argv[4] || 2048)
const H = Number(process.argv[5] || 1024)
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const TMP = path.join(__dirname, '..', '.perf', 'sphere-map')

if (!SRC || !fs.existsSync(SRC)) {
  console.error('用法: node tools/jupiter-sphere-map.js <diskSrc.jpg> <out.jpg> [w] [h]')
  process.exit(1)
}

function shootPng (html, outPng, w, h) {
  const prof = path.join(TMP, 'chrome')
  fs.rmSync(prof, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  const htmlPath = outPng.replace(/\.png$/, '.html')
  fs.writeFileSync(htmlPath, html)
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions',
    '--window-size=' + w + ',' + h,
    '--virtual-time-budget=4000',
    '--screenshot=' + outPng,
    'file:///' + path.resolve(htmlPath).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')
  ], { stdio: 'ignore', timeout: 120000 })
  fs.rmSync(prof, { recursive: true, force: true })
  fs.rmSync(htmlPath, { force: true })
  if (!fs.existsSync(outPng)) throw new Error('渲染失败: ' + outPng)
  return decodePng(fs.readFileSync(outPng))
}

const fileUrl = p => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')

function main () {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })

  console.log('1) 读取源照片…')
  // 源是已裁好的"圆盘刚好内切"正方形（jupiter-prep 的产物）
  const SIDE = 1312
  const src = shootPng(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
       html,body{margin:0;padding:0;background:#000;overflow:hidden}
       img{display:block;width:${SIDE}px;height:${SIDE}px}
     </style></head><body><img src="${fileUrl(SRC)}"></body></html>`,
    path.join(TMP, 'src.png'), SIDE, SIDE
  )
  console.log(`   ${src.w}x${src.h}`)

  const sLum = (x, y) => {
    const i = (y * src.w + x) * src.ch
    return 0.299 * src.data[i] + 0.587 * src.data[i + 1] + 0.114 * src.data[i + 2]
  }

  // 2) 估次太阳点：亮度的加权质心（用高亮像素，避免整盘平均把亮区摊平）
  let sx = 0; let sy = 0; let sw = 0
  let maxL = 0
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const L = sLum(x, y)
      if (L > maxL) maxL = L
    }
  }
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const L = sLum(x, y)
      // 只用最亮的那一档，且离边缘留白（边缘像素本身就是圆外黑底）
      const wgt = Math.max(0, L - maxL * 0.80)
      if (wgt <= 0) continue
      const dx = x - src.w / 2
      const dy = y - src.h / 2
      if (dx * dx + dy * dy > (src.w * 0.48) * (src.w * 0.48)) continue
      sx += x * wgt; sy += y * wgt; sw += wgt
    }
  }
  const ssX = sx / sw
  const ssY = sy / sw
  const R = src.w / 2 * 0.994   // 圆盘半径（裁切时留了 0.6% 呼吸边）
  const cx = src.w / 2
  const cy = src.h / 2

  // 次太阳点在球面上的方向（相机空间：+x 右, +y 上, +z 朝向观察者）
  const nSunX = (ssX - cx) / R
  const nSunY = -(ssY - cy) / R
  const nSunZ2 = Math.max(0, 1 - nSunX * nSunX - nSunY * nSunY)
  const nSunZ = Math.sqrt(nSunZ2)
  console.log(`2) 次太阳点: 像素 (${ssX.toFixed(0)}, ${ssY.toFixed(0)})  →  方向 (${nSunX.toFixed(3)}, ${nSunY.toFixed(3)}, ${nSunZ.toFixed(3)})`)

  // 照片圆盘用的是"几何半径"，但可见边缘要略收一点，避免采到边缘压缩噪声
  const Rv = R * 0.998
  /* 由球面法线反查照片像素。
     注意【不要再除以 nz】：这是一个正交投影的球，法线 (nx,ny,nz) 的
     像素位置就是圆心 + (nx,ny)*R，与 nz 无关。多除一个 nz 会把靠近
     边缘（nz→0）的采样点推到圆盘之外，边缘整圈都会取到黑底。 */
  const sampleDisk = (nx, ny) => {
    const px = cx + nx * Rv
    const py = cy - ny * Rv
    // 双线性
    const x0 = Math.floor(px); const y0 = Math.floor(py)
    const fx = px - x0; const fy = py - y0
    const get = (xx, yy) => {
      const i = ((Math.min(src.h - 1, Math.max(0, yy)) * src.w) + Math.min(src.w - 1, Math.max(0, xx))) * src.ch
      return [src.data[i], src.data[i + 1], src.data[i + 2]]
    }
    const a = get(x0, y0); const b = get(x0 + 1, y0)
    const c = get(x0, y0 + 1); const d = get(x0 + 1, y0 + 1)
    return [
      (a[0] * (1 - fx) + b[0] * fx) * (1 - fy) + (c[0] * (1 - fx) + d[0] * fx) * fy,
      (a[1] * (1 - fx) + b[1] * fx) * (1 - fy) + (c[1] * (1 - fx) + d[1] * fx) * fy,
      (a[2] * (1 - fx) + b[2] * fx) * (1 - fy) + (c[2] * (1 - fx) + d[2] * fx) * fy
    ]
  }

  // 3) 生成等距圆柱贴图
  console.log(`3) 生成等距圆柱贴图 ${W}x${H}…`)
  const out = new Float32Array(W * H * 3)
  const latTop = 0.98          // 可见纬度上限（球体边缘压缩太狠，取 0.98）
  const ambient = 0.16         // 去光照时保留的底光，避免夜面除零

  // 先算可见半球（|lon| <= 90°）
  for (let j = 0; j < H; j++) {
    const v = (j + 0.5) / H             // 0=北极
    const lat = (0.5 - v) * Math.PI     // +pi/2 .. -pi/2
    const cl = Math.cos(lat); const sl = Math.sin(lat)
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W
      const lon = (u - 0.5) * 2 * Math.PI * 2 // -2pi..2pi 先铺满，后面用可见段覆盖
      void lon
      // 可见半球：经度映射到相机空间 -90..+90
      const lonVis = (u - 0.5) * Math.PI * 2   // -pi .. pi
      const nx = Math.sin(lonVis) * cl
      const ny = sl
      const nz = Math.cos(lonVis) * cl
      const idx = (j * W + i) * 3
      if (nz > 0.02 && Math.abs(sl) < latTop) {
        const c = sampleDisk(nx, ny)
        // 去光照：除以 (ambient + (1-ambient)*lambert)
        const lam = Math.max(0, nx * nSunX + ny * nSunY + nz * nSunZ)
        const k = ambient + (1 - ambient) * Math.pow(lam, 0.85)
        out[idx] = Math.min(255, c[0] / Math.max(0.22, k))
        out[idx + 1] = Math.min(255, c[1] / Math.max(0.22, k))
        out[idx + 2] = Math.min(255, c[2] / Math.max(0.22, k))
      } else {
        out[idx] = -1; out[idx + 1] = -1; out[idx + 2] = -1   // 标记为待填充
      }
    }
  }

  // 4) 竖向（按纬度）填充：对每一行，取该行可见像素的中位数作为整行底色，
  //    这一步同时完成"背面填充"和"极冠延拓" —— 木星云带本来就近似纬向，
  //    按行取中位数既保留了条带，又不会把边缘压缩的条纹抹上去。
  console.log('4) 按纬度填充背面与极区…')
  // 诊断：可见像素在贴图里的水平覆盖范围（应当接近整幅宽度，因为可见半球
  // 就是 180° 经度 = 贴图一半；若明显偏窄说明投影或采样半径有问题）
  {
    let gMin = W; let gMax = -1; let gCnt = 0
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        if (out[(j * W + i) * 3] >= 0) { if (i < gMin) gMin = i; if (i > gMax) gMax = i; gCnt++ }
      }
    }
    console.log(`   可见像素 ${gCnt} 个 (${(100 * gCnt / (W * H)).toFixed(1)}%)，水平范围 ${gMin}..${gMax}`)
    for (const j of [Math.round(H * 0.5), Math.round(H * 0.62)]) {
      let a = W; let b = -1; let n = 0
      for (let i = 0; i < W; i++) if (out[(j * W + i) * 3] >= 0) { if (i < a) a = i; if (i > b) b = i; n++ }
      console.log(`   行 j=${j} (纬度 ${(((0.5 - (j + 0.5) / H) * 180)).toFixed(1)}°): 可见 ${n} 列, ${a}..${b}`)
    }
  }
  /* 5) 合成完整 360° 经度：以"无缝的行底带"为底，把真实细节在中段交叉淡化进去。
     ------------------------------------------------------------
     [为什么不能直接镜像/平铺可见条带] 试过两种做法，都会留下肉眼可见的缺陷：
       ① 镜像 + 边缘渐变到行中位数 → 180° 附近出现亮度断崖（云带有结构，
          中位数是纯色），贴到球上是一条竖着的接缝；
       ② 只取可见窗口（u∈[0.25,0.75]）做环向回卷 → 窗口两端落在圆盘之外
          （圆盘是圆的，上下两端的"可见列"只有中间一小段），回卷到的是
          图外的黑底，结果整张贴图上出现两个白边椭圆。
     [现在的做法] 分两步：
       · 底：逐纬度取可见像素的中位数 → 得到一条【经度方向恒定】的行带。
         因为经度方向没有变化，环向 360° 天然无缝（这正是木星云带的特征，
         纬度结构远强于经度结构）。
       · 细节：把真实可见条带按经度映射回 u∈[0.25,0.75]，并乘一个升余弦
         窗；窗在两端平滑归零，于是"细节层"与"行带底"在边界处完全一致，
         不会产生任何接缝，中段则保留大红斑等真实结构。
     代价是背面（180° 之外）没有真实细节 —— 那是照片里根本不存在的信息，
     任何"补"都是编的；用行带延拓至少保证物理上说得通（纬向均匀）。 */
  console.log('5) 合成 360° 经度（行带底 + 中段真实细节）…')
  const band = new Float32Array(H * 3)
  for (let j = 0; j < H; j++) {
    const cols = [[], [], []]
    for (let i = 0; i < W; i++) {
      const idx = (j * W + i) * 3
      if (out[idx] < 0) continue
      cols[0].push(out[idx]); cols[1].push(out[idx + 1]); cols[2].push(out[idx + 2])
    }
    if (cols[0].length > 8) {
      for (let t = 0; t < 3; t++) {
        cols[t].sort((a, b) => a - b)
        band[j * 3 + t] = cols[t][Math.floor(cols[t].length / 2)]
      }
    } else {
      band[j * 3] = -1
    }
  }
  // 缺失纬度的行带按最近有效行继承
  for (let j = 0; j < H; j++) {
    if (band[j * 3] >= 0) continue
    let up = j; let dn = j
    while (up >= 0 && band[up * 3] < 0) up--
    while (dn < H && band[dn * 3] < 0) dn++
    const src = up >= 0 ? up : (dn < H ? dn : -1)
    if (src < 0) { band[j * 3] = 120; band[j * 3 + 1] = 110; band[j * 3 + 2] = 95; continue }
    for (let t = 0; t < 3; t++) band[j * 3 + t] = band[src * 3 + t]
  }

  /* 细节层窗口：按"该行真实有效列的跨度"逐行动态确定，不能写死 u∈[0.25,0.75]。
     原因：圆盘是圆的 —— 上下两端每行的有效列只有中间一小段。窗口写死时，
     靠近窗口边缘处真实数据早已用完，cos 窗虽在两端归零，但中间那段仍会
     出现黑边（实测可见）。按行取有效列的 [lo,hi] 并把窗口内收 3%，
     就能保证窗口两端一定落在有真实像素的区域上，cos 窗的归零与真实数据
     的结束重合，接缝不可见。

     注意：填充会覆盖 out，因此先用 valid[] 快照记录哪些像素是真实的。 */
  const valid = new Uint8Array(W * H)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (out[(j * W + i) * 3] >= 0) valid[j * W + i] = 1
    }
  }

  for (let j = 0; j < H; j++) {
    let lo = -1; let hi = -1
    for (let i = 0; i < W; i++) if (valid[j * W + i]) { if (lo < 0) lo = i; hi = i }
    // 先整行铺行带底
    for (let i = 0; i < W; i++) {
      const idx = (j * W + i) * 3
      if (valid[j * W + i]) continue       // 真实像素稍后按 cos 窗合成
      out[idx] = band[j * 3]
      out[idx + 1] = band[j * 3 + 1]
      out[idx + 2] = band[j * 3 + 2]
    }
    if (lo < 0 || hi - lo < 24) continue   // 该行有效列太少（极区），只用行带
    const pad = Math.round((hi - lo) * 0.03)
    const A = lo + pad
    const B = hi - pad
    for (let i = lo; i <= hi; i++) {
      const idx = (j * W + i) * 3
      // cos 窗：在真实跨度的两端归零 → 与行带无缝
      const u = (i - lo) / (hi - lo)
      let w = 0.5 - 0.5 * Math.cos(u * 2 * Math.PI)
      if (i < A || i > B) w = 0              // 跨度最外侧 3% 交给行带
      const real = valid[j * W + i]
      if (!real) continue                    // 已铺行带
      out[idx] = band[j * 3] * (1 - w) + out[idx] * w
      out[idx + 1] = band[j * 3 + 1] * (1 - w) + out[idx + 1] * w
      out[idx + 2] = band[j * 3 + 2] * (1 - w) + out[idx + 2] * w
    }
  }

  // 6) 兜底：仍为 -1 的像素填行带
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const idx = (j * W + i) * 3
      if (out[idx] >= 0) continue
      out[idx] = band[j * 3]; out[idx + 1] = band[j * 3 + 1]; out[idx + 2] = band[j * 3 + 2]
    }
  }

  // 5) 归一化。去光照会把原本就亮的区域抬到过曝（照片里最亮处已经接近
  //    255，再除以 k<1 就被裁掉），所以：
  //    ① 用 p95 分位数而不是平均值定增益 —— 平均值会被大片暗区拉低，
  //       导致增益过大、亮区顶到 255；
  //    ② 增益封顶 1.06，宁可整体略暗，也不要一片死白（WebGL 侧还有
  //       光照与 bloom，暗一点更好控制）。
  const lum = []
  for (let i = 0; i < W * H * 3; i += 3) {
    lum.push(0.299 * out[i] + 0.587 * out[i + 1] + 0.114 * out[i + 2])
  }
  lum.sort((a, b) => a - b)
  const p50 = lum[Math.floor(lum.length * 0.5)]
  const p95 = lum[Math.floor(lum.length * 0.95)]
  const gain = Math.min(1.06, Math.max(0.70, 196 / Math.max(1, p95)))
  let clipped = 0
  for (let i = 0; i < W * H * 3; i++) if (out[i] * gain >= 254) clipped++
  console.log(`5) 亮度 p50=${p50.toFixed(0)} p95=${p95.toFixed(0)} → 增益 ${gain.toFixed(3)}` +
    `   预计裁切像素 ${(100 * clipped / (W * H * 3)).toFixed(2)}%`)

  // 6) 写 PNG 再编 JPEG
  const pngData = Buffer.alloc(W * H * 4)
  for (let i = 0, p = 0; i < W * H * 3; i += 3, p += 4) {
    pngData[p] = Math.min(255, Math.max(0, Math.round(out[i] * gain)))
    pngData[p + 1] = Math.min(255, Math.max(0, Math.round(out[i + 1] * gain)))
    pngData[p + 2] = Math.min(255, Math.max(0, Math.round(out[i + 2] * gain)))
    pngData[p + 3] = 255
  }
  const pngPath = path.join(TMP, 'map.png')
  fs.writeFileSync(pngPath, encodePng(pngData, W, H))
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  const r = pngToJpeg(pngPath, OUT, 88)
  console.log(`6) 输出 ${OUT}  ${W}x${H}  ${(r.bytes / 1024).toFixed(0)} KB`)
  console.log('完成。')
}

/* 最小 PNG 编码（RGBA，无滤波，deflate） */
function encodePng (rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4)
  }
  const idat = zlib.deflateSync(raw, { level: 9 })
  const chunks = []
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const t = Buffer.from(type, 'ascii')
    const crcBuf = Buffer.concat([t, data])
    const c = Buffer.alloc(4); c.writeUInt32BE(crc32(crcBuf) >>> 0)
    chunks.push(len, t, data, c)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  chunk('IHDR', ihdr)
  chunk('IDAT', idat)
  chunk('IEND', Buffer.alloc(0))
  return Buffer.concat(chunks)
}

let CRC_TABLE = null
function crc32 (buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
      CRC_TABLE[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff)
}

main()
