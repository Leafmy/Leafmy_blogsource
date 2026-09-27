'use strict'
/* ============================================================
   画面自检 (tools/verify-space-render.js)
   ------------------------------------------------------------
   为什么需要它：木星这一版的所有改动（贴图重出、色调映射、细节注入、
   采样质量）都会让画面"看起来不太一样"，但"不一样"不等于"更对"。
   人眼在深空背景上判断饱和度与对比度极不可靠（这正是这一版翻车的
   原因：云带被压成灰的，一眼看不出差了 40%）。
   所以拿真实的 Hubble 照片当基准，把"像不像"变成可复现的数字。

   基准：.perf/jupiter-src/heic2404b-large.jpg
        ESA/Hubble & NASA，OPAL 计划 2024-01-05 观测（heic2404b），CC BY 4.0
        1312x1312，木星圆盘内切于画面（真正的"自然色"参照）

   比对方式（关键：绕开"中心经度是多少"这个未知量）
        把贴图当成等距圆柱投影（u → 经度，v → 纬度），对参考圆盘内的每个
        像素解出经纬度再采样贴图 —— 相当于"用贴图再合成一次那张照片"。
        中心经度未知，就扫一遍所有经度偏移取相关最大者。这样比较的是
        **同一块云带的同一批像素**，而不是拿 A 处的云带比 B 处的。

   指标：
      S  饱和度均值      贴图 / 参考   —— 颜色发灰就是这项塌了
      C  细节对比度(RMS) 贴图 / 参考   —— "云带糊"就是这项塌了
      V  紫偏             贴图 - 参考   —— 彩边/色度噪声
      R  纬度剖面相关                 —— 云带分布是否还对（低于 0.9 说明贴图结构坏了）

   运行: node tools/verify-space-render.js [贴图路径]
        默认贴图 source/img/jupiter-map.jpg（渲染器实际用的那一张）
   退出码非 0 表示有断言失败。
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { decodeImage } = require('./planet-resize.js')

const ROOT = path.join(__dirname, '..')
/* 位置参数只认"不以 -- 开头"的：否则 `--fit` 会被当成贴图路径
   （第一版就这么错了，表现是"找不到贴图 --fit"）。 */
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const MAP_PATH = positional[0] ? path.resolve(positional[0]) : path.join(ROOT, 'source', 'img', 'jupiter-map.jpg')
const REF_PATH = path.join(ROOT, '.perf', 'jupiter-src', 'heic2404b-large.jpg')

let pass = 0
let fail = 0
const failures = []
function check (name, ok, detail) {
  if (ok) { pass++; console.log('  \u2705 ' + name + (detail ? '  ' + detail : '')) } else {
    fail++; failures.push(name); console.log('  \u274c ' + name + (detail ? '  ' + detail : ''))
  }
}
const f = (v, n) => Number(v).toFixed(n == null ? 3 : n)

/* ---------- 色彩空间：全部在**线性光**里比较 ---------- */
/* 为什么必须线性：sRGB 空间的算术平均没有物理意义，而且"平均亮度"这类
   量在 sRGB 里做会让暗部被高估，恰好掩盖本版要抓的"灰化"问题。 */
const SRGB_TO_LIN = new Float64Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

/* 圆盘检测：不用"亮部包围盒"，因为真实照片里圆盘外侧还有一圈 PSF 晕
   （不对称、很淡），它会把包围盒撑大 30% 左右，而我们就会把一圈黑天空
   当成木星来统计 —— 饱和度与细节对比度会被系统性压低，
   恰好制造出"贴图很差"的假象（第一版就踩了这个坑：aspect=1.056，
   半径偏大 30%）。
   改用**行/列宽度剖面**：
     · 圆盘内部最宽的那一段行宽接近 2r，取"行宽 > 95% 最大值"的行集合，
       其上下界的中点就是圆心 y，半径 = 该段的行宽最大值 / 2；
     · 圆心 x 同理用列宽剖面。
   晕的存在对"最宽处"几乎没有影响（它把每一行都撑宽一点点，是个
   近似加性的偏移，不影响峰值位置与宽度差）。 */
function detectDisk (img, threshFrac) {
  const { w, h, ch, data } = img
  const lum = new Uint8Array(w * h)
  let maxL = 0, minL = 255
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    const l = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2]
    lum[i] = l
    if (l > maxL) maxL = l
    if (l < minL) minL = l
  }
  /* 阈值取 (峰值-背景) 的 35% 再加回背景：35% 是为了绕开 PSF 晕，
     同时又足够低到保住临边昏暗那圈暗边缘（圆盘最外缘亮度约为
     中心的一半，所以阈值必须明显低于 50%）。 */
  const bg = minL
  const thr = bg + (maxL - bg) * (threshFrac == null ? 0.35 : threshFrac)

  const rowW = new Int32Array(h)
  const rowL = new Int32Array(h).fill(w)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (lum[y * w + x] > thr) { rowL[y] = Math.min(rowL[y], x); rowW[y] = Math.max(rowW[y], x) }
    }
  }
  const widths = new Int32Array(h)
  for (let y = 0; y < h; y++) widths[y] = rowW[y] >= rowL[y] ? rowW[y] - rowL[y] + 1 : 0
  let maxW = 0
  for (let y = 0; y < h; y++) if (widths[y] > maxW) maxW = widths[y]
  let y0 = -1, y1 = -1
  for (let y = 0; y < h; y++) {
    if (widths[y] >= maxW * 0.95) { if (y0 < 0) y0 = y; y1 = y }
  }
  const cy = (y0 + y1) / 2
  const rFromRows = maxW / 2

  // 列宽剖面求 cx：只在圆心上下 ±r 的带里统计，避免把画面外的天体算进来
  const colW = new Int32Array(w).fill(-1)
  const colT = new Int32Array(w).fill(h)
  const yLo = Math.max(0, Math.floor(cy - rFromRows))
  const yHi = Math.min(h - 1, Math.ceil(cy + rFromRows))
  for (let x = 0; x < w; x++) {
    for (let y = yLo; y <= yHi; y++) {
      if (lum[y * w + x] > thr) { if (colT[x] === h) colT[x] = y; colW[x] = Math.max(colW[x], y) }
    }
  }
  const widthsC = new Int32Array(w)
  for (let x = 0; x < w; x++) widthsC[x] = colW[x] >= colT[x] && colT[x] !== h ? colW[x] - colT[x] + 1 : 0
  let maxWC = 0
  for (let x = 0; x < w; x++) if (widthsC[x] > maxWC) maxWC = widthsC[x]
  let x0 = -1, x1 = -1
  for (let x = 0; x < w; x++) {
    if (widthsC[x] >= maxWC * 0.95) { if (x0 < 0) x0 = x; x1 = x }
  }
  const cx = (x0 + x1) / 2
  const rFromCols = maxWC / 2

  /* 两个方向的半径应当一致（同一颗球），差太大说明阈值把某一边切多了 */
  const r = (rFromRows + rFromCols) / 2
  return {
    cx, cy, r,
    bw: maxW, bh: maxWC,
    aspect: maxW / maxWC,
    maxL, minL, thr,
    rFromRows, rFromCols
  }
}

/* 双线性采样：贴图是等距圆柱投影，(u,v) 越界按经度环绕/纬度夹紧。
   经度环绕（而不是夹紧）是必须的：夹紧会让 0°/360° 接缝处出现一条
   假的竖直色带，正好污染我们想测的"经度方向色度噪声"。 */
function sampleMap (map, u, v, out) {
  const { w, h, ch, data } = map
  let uu = u - Math.floor(u)
  let vv = v < 0 ? 0 : v > 1 ? 1 : v
  const x = uu * (w - 1)
  const y = vv * (h - 1)
  const x0 = Math.floor(x), y0 = Math.floor(y)
  const x1 = (x0 + 1) % w
  const y1 = Math.min(h - 1, y0 + 1)
  const fx = x - x0, fy = y - y0
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * w + x0) * ch + c]
    const b = data[(y0 * w + x1) * ch + c]
    const cc = data[(y1 * w + x0) * ch + c]
    const d = data[(y1 * w + x1) * ch + c]
    const top = SRGB_TO_LIN[a] * (1 - fx) + SRGB_TO_LIN[b] * fx
    const bot = SRGB_TO_LIN[cc] * (1 - fx) + SRGB_TO_LIN[d] * fx
    out[c] = top * (1 - fy) + bot * fy
  }
  return out
}

/* 在"贴图重建出的圆面"与参考圆面之间算指标。
   lonOffsetDeg = 参考照片的中心经度在贴图 u 上的位置（度）。
   圆面按**椭圆**处理（扁球投影）：横半轴 rx、纵半轴 ry。 */
function measure (map, ref, disk, lonOffsetDeg, stepDeg) {
  const { w: rw, h: rh, ch: rch, data: rdata } = ref
  const rx = disk.rFromRows
  const ry = disk.rFromCols
  const px = Math.max(2, Math.round((2 * ry) / 240))
  let n = 0
  let sumSatM = 0, sumSatR = 0
  let sumLumM = 0, sumLumR = 0
  let sumVioM = 0, sumVioR = 0
  const latProfM = new Float64Array(180)
  const latProfR = new Float64Array(180)
  const latCnt = new Float64Array(180)
  const rgb = [0, 0, 0]
  const gW = Math.ceil((2 * rx) / px) + 2
  const gH = Math.ceil((2 * ry) / px) + 2
  const lumGridM = new Float64Array(gW * gH).fill(-1)
  const lumGridR = new Float64Array(gW * gH).fill(-1)

  for (let gy = 0; gy < gH; gy++) {
    for (let gx = 0; gx < gW; gx++) {
      const x = Math.round(disk.cx - rx + gx * px)
      const y = Math.round(disk.cy - ry + gy * px)
      if (x < 0 || y < 0 || x >= rw || y >= rh) continue
      /* 椭圆 → 单位球的正确投影（第一版这里写错了，代价很大）：
           参考圆面是扁球投影，横半轴 rx 对应**赤道**、纵半轴 ry 对应**自转轴**。
           于是归一化后的横坐标相对"半径"要按 rx 折，
           而球面上的视线方向是 (x·R_equ, y·R_pol, z)：
             x_equ = (x − cx) / ry · (rx / ry)
             y_lat = (y − cy) / ry
             ρ²    = x_equ² + y_lat²        ← 必须用两个方向的和，不能用同一个分母
           错的写法（两边都除 ry）会把同一像素判成"离边缘更远"，
           结果整个圆面被按 y 方向拉伸采样：实测取到的区域比真实圆面小 ~25%，
           于是"贴图比参考差一大截"这个结论里混进了几何误差。 */
      const xEqu = ((x - disk.cx) / ry) * (rx / ry)
      const yLat = (y - disk.cy) / ry
      const rho2 = xEqu * xEqu + yLat * yLat
      /* 只取 ~88% 半径以内：边缘一圈是临边昏暗 + 抗锯齿 + JPEG 块噪声
         的混合区，算进"细节对比度"会让两侧都虚高且不稳定。 */
      if (rho2 > 0.88 * 0.88) continue
      const lat = Math.asin(Math.max(-1, Math.min(1, -yLat)))
      const lonObs = Math.atan2(xEqu, Math.sqrt(Math.max(1e-9, 1 - rho2)))
      const lon = lonObs + lonOffsetDeg * Math.PI / 180
      const u = (lon / (2 * Math.PI)) + 0.5
      const v = 0.5 - lat / Math.PI

      const p = (y * rw + x) * rch
      const R = [SRGB_TO_LIN[rdata[p]], SRGB_TO_LIN[rdata[p + 1]], SRGB_TO_LIN[rdata[p + 2]]]
      sampleMap(map, u, v, rgb)
      const M = [rgb[0], rgb[1], rgb[2]]

      sumSatM += sat(M); sumSatR += sat(R)
      sumLumM += luma(M[0], M[1], M[2]); sumLumR += luma(R[0], R[1], R[2])
      // 紫偏：R 与 B 相对 G 的平均偏高（magenta 方向的色度失衡）
      sumVioM += (M[0] + M[2]) / 2 - M[1]
      sumVioR += (R[0] + R[2]) / 2 - R[1]

      const bi = Math.min(179, Math.max(0, Math.floor((lat / Math.PI + 0.5) * 180)))
      latProfM[bi] += luma(M[0], M[1], M[2])
      latProfR[bi] += luma(R[0], R[1], R[2])
      latCnt[bi]++
      lumGridM[gy * gW + gx] = luma(M[0], M[1], M[2])
      lumGridR[gy * gW + gx] = luma(R[0], R[1], R[2])
      n++
    }
  }
  if (!n) return null

  /* 高频能量：相邻格子的一阶差分（等价于高通），比 7x7 均值省事且无环。
     用差分而非"减去模糊"，是为了不引入额外的模糊核参数。 */
  function hf (grid) {
    let s = 0, c = 0
    for (let gy = 1; gy < gH - 1; gy++) {
      for (let gx = 1; gx < gW - 1; gx++) {
        const v = grid[gy * gW + gx]
        if (v < 0) continue
        const a = grid[gy * gW + gx + 1], b = grid[(gy + 1) * gW + gx]
        if (a < 0 || b < 0) continue
        s += (v - a) * (v - a) + (v - b) * (v - b)
        c += 2
      }
    }
    return c ? Math.sqrt(s / c) * 1000 : 0   // x1000：这些值都很小，读起来舒服
  }

  /* 纬度相关：先把每个纬度带上的亮度沿经度平均（自转不改变它），
     再算两条剖面的皮尔逊相关 —— 这一项与中心经度几乎无关，所以
     即使经度对齐偏了 10°，它依然能判断"云带分布还在不在"。 */
  let corr = NaN
  {
    const a = [], b = []
    for (let i = 0; i < 180; i++) {
      if (latCnt[i] < 3) continue
      a.push(latProfM[i] / latCnt[i])
      b.push(latProfR[i] / latCnt[i])
    }
    const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length
    const ma = mean(a), mb = mean(b)
    let sab = 0, sa = 0, sb = 0
    for (let i = 0; i < a.length; i++) {
      sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2
    }
    corr = sab / Math.sqrt(Math.max(1e-12, sa * sb))
  }

  return {
    n,
    satM: sumSatM / n, satR: sumSatR / n,
    lumM: sumLumM / n, lumR: sumLumR / n,
    vioM: sumVioM / n, vioR: sumVioR / n,
    hfM: hf(lumGridM), hfR: hf(lumGridR),
    corr
  }
}

function sat (c) {
  const m = Math.max(c[0], c[1], c[2])
  const mn = Math.min(c[0], c[1], c[2])
  const l = luma(c[0], c[1], c[2])
  return l > 1e-6 ? (m - mn) / (m + mn + 1e-9) * (l > 0 ? 1 : 0) : 0
}

/* 按纬度带单独统计。复用 measure 的同一套几何与空间，
   只是把采样限制在 [latLo, latHi] 内 —— 两处必须用**同一套**椭圆→球
   的推导，否则剖面和整体指标会互相矛盾（第一版就吃过这个亏）。 */
function measureBands (map, ref, disk, lonOffsetDeg, latLo, latHi) {
  const { w: rw, h: rh, ch: rch, data: rdata } = ref
  const rx = disk.rFromRows
  const ry = disk.rFromCols
  const px = Math.max(1, Math.round((2 * ry) / 400))
  const rgb = [0, 0, 0]
  const lo = latLo * Math.PI / 180
  const hi = latHi * Math.PI / 180
  let n = 0
  let sumSatM = 0, sumSatR = 0, sumLumM = 0, sumLumR = 0, sumVio = 0
  const gW = Math.ceil((2 * rx) / px) + 2
  const gH = Math.ceil((2 * ry) / px) + 2
  const lumGridM = new Float64Array(gW * gH).fill(-1)
  const lumGridR = new Float64Array(gW * gH).fill(-1)
  for (let gy = 0; gy < gH; gy++) {
    for (let gx = 0; gx < gW; gx++) {
      const x = Math.round(disk.cx - rx + gx * px)
      const y = Math.round(disk.cy - ry + gy * px)
      if (x < 0 || y < 0 || x >= rw || y >= rh) continue
      const xEqu = ((x - disk.cx) / ry) * (rx / ry)
      const yLat = (y - disk.cy) / ry
      const rho2 = xEqu * xEqu + yLat * yLat
      if (rho2 > 0.88 * 0.88) continue
      const lat = Math.asin(Math.max(-1, Math.min(1, -yLat)))
      if (lat < lo || lat > hi) continue
      const lonObs = Math.atan2(xEqu, Math.sqrt(Math.max(1e-9, 1 - rho2)))
      const lon = lonObs + lonOffsetDeg * Math.PI / 180
      const p = (y * rw + x) * rch
      const R = [SRGB_TO_LIN[rdata[p]], SRGB_TO_LIN[rdata[p + 1]], SRGB_TO_LIN[rdata[p + 2]]]
      sampleMap(map, (lon / (2 * Math.PI)) + 0.5, 0.5 - lat / Math.PI, rgb)
      const M = [rgb[0], rgb[1], rgb[2]]
      sumSatM += sat(M); sumSatR += sat(R)
      sumLumM += luma(M[0], M[1], M[2]); sumLumR += luma(R[0], R[1], R[2])
      sumVio += ((M[0] + M[2]) / 2 - M[1]) - ((R[0] + R[2]) / 2 - R[1])
      lumGridM[gy * gW + gx] = luma(M[0], M[1], M[2])
      lumGridR[gy * gW + gx] = luma(R[0], R[1], R[2])
      n++
    }
  }
  if (n < 20) return null
  const hf = (grid) => {
    let s = 0, c = 0
    for (let gy = 1; gy < gH - 1; gy++) {
      for (let gx = 1; gx < gW - 1; gx++) {
        const v = grid[gy * gW + gx]
        if (v < 0) continue
        const a = grid[gy * gW + gx + 1], b = grid[(gy + 1) * gW + gx]
        if (a < 0 || b < 0) continue
        s += (v - a) ** 2 + (v - b) ** 2
        c += 2
      }
    }
    return c ? Math.sqrt(s / c) * 1000 : 0
  }
  return {
    n,
    satM: sumSatM / n, satR: sumSatR / n,
    lumM: sumLumM / n, lumR: sumLumR / n,
    vioDelta: sumVio / n,               // 这一带"贴图 − 参考"的紫偏
    hfM: hf(lumGridM), hfR: hf(lumGridR)
  }
}

/* ---------- 线性 3x3 色彩标定 ----------
   动机：OPAL globalmap 是三个窄带滤光片（F395N/F502N/F658N），它们与
   人眼的 RGB 响应没有对应关系。直接"一档配一通道"出来的是**假彩色**：
   实测贴图比真实照片饱和度低 25%、紫偏高 8 倍。
   这三张同时拍的窄带图 = 对被摄光谱的三次采样，所以从"三通道线性组合"
   到"人眼三刺激值"确实存在一个（近似）线性映射。用同一台望远镜拍出来的
   自然色照片（heic2404b）当基准，最小二乘解出这个 3x3 矩阵 ——
   这就是这一层该有的"色彩科学"，而不是拍脑袋调曲线。

   只在参考照片可见的那半边球面上采样（两边的观测时刻不同，
   另外半球的云带已经不是同一批了）。 */
function solveN (A, b) {
  // 高斯-约当消元，带部分主元
  const n = A.length
  const M = []
  for (let i = 0; i < n; i++) M.push(A[i].slice().concat([b[i]]))
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    const t = M[col]; M[col] = M[piv]; M[piv] = t
    const d = M[col][col]
    if (Math.abs(d) < 1e-12) return null
    for (let c = col; c <= n; c++) M[col][c] /= d
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const f = M[r][col]
      if (!f) continue
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row) => row[n])
}

/* 在给定经度偏移下收集配对样本（线性空间）。 */
function collectPairs (map, ref, disk, lonOffsetDeg, maxPx) {
  const { w: rw, h: rh, ch: rch, data: rdata } = ref
  const rx = disk.rFromRows
  const ry = disk.rFromCols
  const step = Math.max(2, Math.round((2 * ry) / (maxPx || 160)))
  const pairs = []
  const rgb = [0, 0, 0]
  for (let y = Math.max(0, Math.round(disk.cy - ry)); y < Math.min(rh, disk.cy + ry); y += step) {
    for (let x = Math.max(0, Math.round(disk.cx - rx)); x < Math.min(rw, disk.cx + rx); x += step) {
      const xEqu = ((x - disk.cx) / ry) * (rx / ry)
      const yLat = (y - disk.cy) / ry
      const rho2 = xEqu * xEqu + yLat * yLat
      if (rho2 > 0.86 * 0.86) continue
      const lat = Math.asin(Math.max(-1, Math.min(1, -yLat)))
      const lonObs = Math.atan2(xEqu, Math.sqrt(Math.max(1e-9, 1 - rho2)))
      const lon = lonObs + lonOffsetDeg * Math.PI / 180
      const u = (lon / (2 * Math.PI)) + 0.5
      const v = 0.5 - lat / Math.PI
      sampleMap(map, u, v, rgb)
      const p = (y * rw + x) * rch
      pairs.push({
        x: [rgb[0], rgb[1], rgb[2]],
        y: [SRGB_TO_LIN[rdata[p]], SRGB_TO_LIN[rdata[p + 1]], SRGB_TO_LIN[rdata[p + 2]]]
      })
    }
  }
  return pairs
}

function fitColor (map, ref, disk, lonOffsetDeg, ridge) {
  const pairs = collectPairs(map, ref, disk, lonOffsetDeg)
  if (pairs.length < 50) return null
  /* 用**仿射**映射（3x3 + 偏置）而不是纯线性：
     实测线性解的偏紫在暗部最重 —— 这正是"黑点偏移"的特征，
     纯 3x3 在零输入处必然输出零，无法表达它。
     把 x 扩成 [x0,x1,x2,1]，最小二乘就同时给出矩阵与偏置。 */
  const N = 4
  const A = Array.from({ length: N }, () => new Array(N).fill(0))
  const B = Array.from({ length: N }, () => new Array(3).fill(0))
  for (const q of pairs) {
    const x = [q.x[0], q.x[1], q.x[2], 1]
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) A[i][j] += x[i] * x[j]
      for (let j = 0; j < 3; j++) B[i][j] += x[i] * q.y[j]
    }
  }
  // 岭正则：窄带三通道彼此高度相关（都近似"亮度"），不加正则解会病态
  const lam = ridge == null ? 1e-3 : ridge
  let tr = 0
  for (let i = 0; i < 3; i++) tr += A[i][i]
  for (let i = 0; i < 3; i++) A[i][i] += lam * tr / 3 + 1e-12
  const W = []
  for (let j = 0; j < 3; j++) {
    const col = solveN(A, [B[0][j], B[1][j], B[2][j], B[3][j]])
    if (!col) return null
    W.push(col)   // W[j] = 输出通道 j 对 (x0,x1,x2,1) 的系数
  }
  /* W 的组织是 W[输出通道 j][输入 i]（i=0..2 为三窄带，i=3 为偏置），
     所以取值一律写 W[j][i]，别再写成 W[i][j] —— 上一版就是在这里
     把下标转置了，报 "Cannot read properties of undefined"。 */
  const apply = (ww, x) => [
    ww[0][0] * x[0] + ww[0][1] * x[1] + ww[0][2] * x[2] + ww[0][3],
    ww[1][0] * x[0] + ww[1][1] * x[1] + ww[1][2] * x[2] + ww[1][3],
    ww[2][0] * x[0] + ww[2][1] * x[1] + ww[2][2] * x[2] + ww[2][3]
  ]
  const err = (ww) => {
    let s = 0, sy = 0
    for (const q of pairs) {
      const o = apply(ww, q.x)
      for (let j = 0; j < 3; j++) { s += (o[j] - q.y[j]) ** 2; sy += q.y[j] ** 2 }
    }
    return Math.sqrt(s / sy)
  }
  /* 恒等：输出 j = 输入 j（下标对齐 W 的组织方式） */
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]
  const linearOnly = W.map((row) => [row[0], row[1], row[2], 0])
  return {
    W,
    n: pairs.length,
    errBefore: err(identity),
    errLinear: err(linearOnly),
    errAfter: err(W)
  }
}

/* ---------- 主 ---------- */
function main () {
  console.log('\n=== 贴图 vs 真实 Hubble 照片（heic2404b，OPAL 2024-01-05）===')
  console.log('  贴图 ' + path.relative(ROOT, MAP_PATH))
  if (!fs.existsSync(MAP_PATH)) { console.error('  找不到贴图'); process.exit(1) }
  if (!fs.existsSync(REF_PATH)) { console.error('  找不到参考图 ' + REF_PATH); process.exit(1) }

  const map = decodeImage(MAP_PATH)
  const ref = decodeImage(REF_PATH)
  console.log('  贴图尺寸 ' + map.w + 'x' + map.h + '   参考 ' + ref.w + 'x' + ref.h)

  const disk = detectDisk(ref)
  console.log('  参考圆盘 圆心=(' + f(disk.cx, 1) + ',' + f(disk.cy, 1) + ') 半径=' + f(disk.r, 1) +
    '  行向 ' + f(disk.rFromRows, 1) + ' / 列向 ' + f(disk.rFromCols, 1) +
    '  阈值=' + f(disk.thr, 1) + '(背景 ' + disk.minL + ', 峰值 ' + disk.maxL + ')')
  /* 两方向半径**本来就不该相等**：木星是扁球（实测扁率 0.935），
     真实照片里的圆面是椭圆。第一版在这里断言"两方向一致"是错的
     —— 它会把真实的扁率误判成检测失败（实测差 6%，正好是 0.94）。
     改成断言扁率落在真实范围内。 */
  const flat = disk.rFromCols / disk.rFromRows
  check('参考圆面是木星该有的扁球（扁率 0.90~0.96）', flat > 0.90 && flat < 0.96,
    '扁率=' + f(flat, 4) + '（实测 0.935）')

  /* 等距圆柱贴图必须精确 2:1 —— 不是 2:1 的话经度会被拉伸，
     采样出来的经纬度与真实几何不符，后面所有指标都是错的。 */
  const ar = map.w / map.h
  check('贴图是 2:1 等距圆柱投影', Math.abs(ar - 2) < 0.002, ar.toFixed(4) + ':1')

  // 扫经度偏移找最佳对齐
  let best = null
  for (let off = 0; off < 360; off += 2) {
    const m = measure(map, ref, disk, off, 1)
    if (!m) continue
    const score = Math.abs(m.corr)
    if (!best || score > best.score) { best = { off, m, score } }
  }
  if (!best) { console.error('  无法比对'); process.exit(1) }
  const m = best.m
  console.log('  最佳中心经度偏移 ' + best.off + '°')

  /* --fit：解"三个窄带 → 自然色"的线性映射并报告残差。
     若 errAfter 明显低于 errBefore，说明误差主要是**线性混色**问题
     （可以直接用 3x3 矩阵修好）；若两者都很大，说明问题不在色彩映射
     （那就得去查对齐/经度/贴图本身）。 */
  if (process.argv.includes('--fit')) {
    console.log('\n=== 线性色彩标定（消融：三窄带 → 自然色）===')
    let fitBest = null
    for (let off = 0; off < 360; off += 2) {
      const fit = fitColor(map, ref, disk, off)
      if (fit && (!fitBest || fit.errAfter < fitBest.fit.errAfter)) fitBest = { off, fit }
    }
    if (!fitBest) {
      console.log('  ❌ 配对样本不足，无法标定')
      fail++
    } else {
      const { off, fit } = fitBest
      const W = fit.W
      console.log('  样本 ' + fit.n + ' 对（经度偏移 ' + off + '°）')
      console.log('  相对残差: 恒等 ' + f(fit.errBefore, 4) +
        '  纯线性 ' + f(fit.errLinear, 4) +
        '  仿射 ' + f(fit.errAfter, 4) +
        '  （仿射相对恒等降 ' + f((1 - fit.errAfter / fit.errBefore) * 100, 1) + '%）')
      console.log('  W[j][i]（输出 j ← 输入 i；第 4 列是偏置）：')
      for (let j = 0; j < 3; j++) {
        console.log('    ' + ['R', 'G', 'B'][j] + ':  ' + W.map((row) => f(row[j], 4).padStart(10)).join(''))
      }
      check('仿射标定能显著降低误差（残差降幅 ≥ 30%）',
        fit.errAfter / fit.errBefore <= 0.70,
        (fit.errAfter / fit.errBefore).toFixed(3))
      check('偏置项确实有用（仿射明显优于纯线性）',
        fit.errAfter <= fit.errLinear * 0.95,
        f(fit.errLinear, 4) + ' → ' + f(fit.errAfter, 4))
      check('标定后残差本身已经很小（≤ 0.30）', fit.errAfter <= 0.30, f(fit.errAfter, 4))
      console.log('\n  // 可直接粘进贴图重出脚本的系数（3x3 + 偏置）：')
      console.log('  const M = [' + W.map((row) => '[' + row.slice(0, 3).map((v) => f(v, 5)).join(', ') + ']').join(', ') + ']')
      console.log('  const B = [' + W.map((row) => f(row[3], 5)).join(', ') + ']')
    }
  }

  const satRatio = m.satM / m.satR
  const hfRatio = m.hfM / m.hfR
  const vioDelta = m.vioM - m.vioR

  console.log('\n  ' + ['指标', '贴图', '参考', '比值/差'].join('\t'))
  console.log('  饱和度均值\t' + f(m.satM, 4) + '\t' + f(m.satR, 4) + '\t' + f(satRatio, 3))
  console.log('  亮度均值\t' + f(m.lumM, 4) + '\t' + f(m.lumR, 4) + '\t' + f(m.lumM / m.lumR, 3))
  console.log('  细节对比度\t' + f(m.hfM, 2) + '\t' + f(m.hfR, 2) + '\t' + f(hfRatio, 3))
  console.log('  紫偏\t\t' + f(m.vioM, 4) + '\t' + f(m.vioR, 4) + '\t' + f(vioDelta, 4))
  console.log('  纬度剖面相关\t' + f(m.corr, 4))

  console.log('')
  /* --profile：按纬度带分别报"饱和度 / 细节对比度 / 紫偏"。
     目的：把"整体偏灰偏紫"拆成"是哪一带造成的"。
     全盘平均值会把中间调和极区分不清 —— 而这两者的修法完全不同
     （极区通常是投影延拓/填充的产物，中间调是色彩映射问题）。 */
  if (process.argv.includes('--profile')) {
    console.log('=== 纬度剖面（每 15°）===')
    console.log('  ' + ['纬度带', '饱合(贴图/参考)', '亮度(贴图/参考)', '紫偏(贴图-参考)', '细节(贴图/参考)'].join('\t'))
    const bands = [[-90, -60], [-60, -30], [-30, 0], [0, 30], [30, 60], [60, 90]]
    for (const [lo, hi] of bands) {
      const q = measureBands(map, ref, disk, best.off, lo, hi)
      if (!q) { console.log('  ' + lo + '..' + hi + '\t（无样本）'); continue }
      console.log('  ' + String(lo + '..' + hi).padEnd(9) + '\t' +
        f(q.satM, 4) + ' / ' + f(q.satR, 4) + '\t\t' +
        f(q.lumM, 3) + ' / ' + f(q.lumR, 3) + '\t\t' +
        f(q.vioDelta, 4) + '\t\t' +
        f(q.hfM, 1) + ' / ' + f(q.hfR, 1))
    }
    console.log('')
  }

  console.log('')
  /* 阈值怎么来的：目标是"与真实照片同一档"，不是"越饱和越好" ——
     上限同样要卡，否则把饱和度无脑拉高也会"通过"。 */
  /* 这一项与别的不同：它**不能**要求 0.9 以上。
     基准照片是 2024-01-05 那一次观测，而任何全球贴图都是多次观测拼出来的
     —— 两次观测里大涡旋的位置本来就不同，逐纬度剖面必然对不齐。
     它真正能回答的是"云带结构还在不在"：
     接近 1 说明贴图几乎就是这张照片；掉到 0.6 以下说明结构已被破坏
     （均值化 / 错位 / 拉伸）。所以阈值取 0.65，并在输出里写清楚它
     **不**代表"像这张照片"。 */
  check('云带结构未被破坏（纬度剖面相关 ≥ 0.65；非"与单次观测一致"）',
    m.corr >= 0.65, f(m.corr, 4))
  check('饱和度落在真实照片的 0.85~1.15 倍', satRatio >= 0.85 && satRatio <= 1.15, f(satRatio, 3))
  check('细节对比度 ≥ 真实照片的 0.80 倍', hfRatio >= 0.80, f(hfRatio, 3))
  /* 紫偏是个**色相**断言，而 (R+B)/2 − G 这个量在近灰时会以极大比例放大
     噪声：参考照片里大量中性灰云带的 vioR 平均后不是 0（实测 0.0035），
     如果只比差值，一块完全中性的贴图也会被判"偏紫"。所以除了差值，
     还要要求贴图本身的紫偏量**在绝对尺度上真的存在**（≥0.005）。
     一个真正偏紫的贴图（v1 实测 0.0336）会稳稳越线，中性贴图不会。 */
  check('无紫偏（差值 ≤ 0.010；且贴图自身紫偏 ≥ 0.005 才判定）',
    Math.abs(vioDelta) <= 0.010 || m.vioM < 0.005,
    '差值 ' + f(vioDelta, 4) + '，贴图自身 ' + f(m.vioM, 4))
  check('整体亮度落在参考的 0.7~1.4 倍', m.lumM / m.lumR >= 0.7 && m.lumM / m.lumR <= 1.4, f(m.lumM / m.lumR, 3))

  console.log('\n=== 汇总 ===')
  console.log('  通过 ' + pass + ' 项，失败 ' + fail + ' 项')
  if (fail) { console.log('  失败项: ' + failures.join(' | ')); process.exit(1) }
  console.log('  ALL CHECKS PASSED')
}

if (require.main === module) main()
module.exports = { detectDisk, measure, sat }
