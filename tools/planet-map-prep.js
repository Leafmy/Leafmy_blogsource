'use strict'
/* ============================================================
   行星 / 卫星全球贴图预处理 (tools/planet-map-prep.js)
   ------------------------------------------------------------
   目标：为 WebGL 太阳系渲染器（space-globe.js）产出水星与四颗伽利略
   卫星的**等距圆柱（equirectangular, 2:1）**球面贴图。
   真实感是第一优先级：数据黑洞和肉眼可见的拼缝都不可接受。

   ── 数据来源 ──────────────────────────────────────────────
   全部为 USGS Astrogeology 行星制图 WMS 的全球拼接正射产品，
   公有领域（public domain），USGS/NASA。已下载在 .perf/planet-src/：
     wms-mercury.jpg  2048x1024  LAYERS=MESSENGER_v8    （单色底图）
     wms-io.jpg       2048x1024  LAYERS=SSI_color       （Galileo SSI 彩色）
     wms-europa.jpg   2048x1024  LAYERS=GALILEO_VOYAGER
     wms-ganymede.jpg 2048x1024  LAYERS=GALILEO_VOYAGER
     wms-callisto.jpg 2048x1024  LAYERS=GALILEO_VOYAGER
   端点形如（map 参数按天体替换）：
     https://planetarymaps.usgs.gov/cgi-bin/mapserv?map=/maps/mercury/mercury_simp.map
         &SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=MESSENGER_v8
         &CRS=IAU2000:19900&SRS=IAU2000:19900&WIDTH=2048&HEIGHT=1024
   许可：USGS 行星制图产品属公有领域（美国联邦政府作品，17 U.S.C. S105），
   官方表述见
   https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
   （"USGS-authored or produced data and information are considered to be in
   the U.S. public domain"）。影像本身来自 NASA MESSENGER（水星）与
   NASA/JPL Galileo SSI（木卫），NASA 影像同样无版权限制。
   声明：本脚本只做几何 / 光度 / 色彩的一致性处理，不生成任何虚构内容。

   ── 为什么必须做这些步骤（.perf/_probe.js 对源图的实测结果）──
     · wms-mercury.jpg：**顶部 0..16 行被 255 纯白（饱和）填满** —— 这是
       WMS 请求超出数据纬度范围时地图服务器返回的"无数据"填充色，恰好是白
       而不是黑，所以只查黑色洞是查不出来的；底部 1018..1023 行同类异常；
       另有 0.50% 的 max(RGB)<8 真黑洞。
     · wms-io.jpg：**顶部 86 行整行全黑**（no-data），总计 12.26% 像素
       max(RGB)<8 —— 用户观察到的"中央偏左的黑色竖楔"就在其中；实测最大
       空洞深度 63 px，且其中 211975 个洞像素的 4 邻域全是洞。
     · wms-europa.jpg：**底部 992..1023 共 32 行全黑**；4.27% 黑洞。
     · wms-ganymede.jpg：顶部 0..2 行全黑；3.49% 黑洞。
     · wms-callisto.jpg：3.77% 黑洞（多为边缘弧形缺口）。
   直接拿这些图当球面贴图，极区会出现黑帽 / 白帽，拼缝会被球面投影放大
   成一条贯穿的竖线，因此下面每一步都是针对实测缺陷的定点修复。

   ── 管线（每一步都可量化、可断言，不做"看起来差不多"的猜测）──
     1) 用无头 Chrome 把 JPEG 渲染成 PNG 再解码像素（本机与仓库内都没有
        sharp / jimp 这类原生图像库，Chrome 截图是最省事的光栅化通道；
        JPEG 解码交给浏览器，PNG 解码用仓库自带的 tools/png-to-jpeg.js 的
        decodePng，不引入新依赖）。
     2) 无数据填充：max(R,G,B)<8 判为 no-data。主规则是"≥2 个有效 4 邻域的
        洞像素取这些邻域的均值"，邻域的左右按经度**环绕**（贴图是 360 度，
        第 0 列与第 W-1 列在球面上相邻），因此图像角上的洞也有 3 个邻域。
        主规则对大片实心空洞无效（实测 wms-io 有 21 万个洞像素 4 邻域全洞），
        因此另加多源 BFS 回填 + 环形搜索兜底，并把回填区做一次 3x3 中位数
        平滑以消掉层状残留。结束后断言整幅图不再有 max(R,G,B)<8 的像素。
     3) 极区检查与延拓（必须在光度趋势修正之前，理由见该节注释）。判据是
        "极区均值 / 饱和率与内侧参考带是否异常"，参考带内再剔除离群行。
        延拓公式保证延拓区的整体亮度等于参考带在该纬度的行均值，
        因此极点既不是黑帽也不是白帽，而纹理仍来自真实数据。
     3b) 光度趋势修正：对亮度拟合经度 / 纬度 2 阶多项式（经度用 cos/sin
        保证环绕连续），峰峰 / 均值超过 8% 就除以归一化趋势面并拉回原均值。
        理由：USGS 底图通常已做光度归一化，但若没有，烤进去的边缘减光
        （limb darkening）会让 WebGL 里再打一次光的行星看起来像贴上去的照片。
     4) 拼缝修复：逐列 / 逐行平均亮度与 17 抽头滑动中位数比较，超过
        max(3xMAD, 0.8%) 的列 / 行判为缝，用邻域中位数替换并在 ±3 px 内
        升余弦羽化。这是 opal-composite.js "对缝附近窄带做平滑"的定量化版本。
        因为第 3b 步已拿掉低频趋势，这里判的是真正的缝而不是纬度梯度。
     5) 光度趋势复核：事后重新拟合，确认极区延拓与拼缝羽化没引入新趋势。
     6) 色彩保真：
        · wms-io.jpg —— 伽利略 SSI 彩色马赛克有色偏，实测平均饱和度 0.404
          高于 Io 文献外观的淡黄橙（published 平均色 sRGB(230,205,148)
          即 S=0.357），因此把色度温和地朝该 published 平均色混合
          （IO_CHROMA_MIX，只动色度、不动亮度，并设饱和度死区）。
        · wms-mercury.jpg —— 是单色产品（实测色度恒为 0），因此套一层中性、
          极轻微偏暖的灰 MERCURY_TINT=(1.000, 0.988, 0.968)。依据：水星在
          可见光的盘面积分色本质接近中性灰、仅对 0.4~0.6 um 略偏红
          （MESSENGER/MDIS 与地基光谱给出的可见反照率斜率约每 100nm 几个
          百分点，对应 R/B 比约 1.03；换算成"乘底色"的线性系数即
          R=1.000 / G=0.988 / B=0.968）。这是有出处的常数，不是凭空造颜色；
          脚本不会给水星编造任何可见光的颜色结构。
     7) 盒式（面积平均，非最近邻）降采样到目标尺寸：水星 512x256，
        木卫 1024x512。源是 2048x1024，缩放为整数倍（4:1 / 2:1），
        因此盒式滤波正好整除、不产生采样相位误差。降采样会把个别像素压到
        黑洞阈值以下，所以补一步"黑地板"。
     8) 写 JPEG（仓库自带 tools/png-to-jpeg.js，q=88），然后**重新打开**
        写出的 JPEG（同样走 Chrome 通道）断言：尺寸精确、无 max(R,G,B)<8
        的像素、平均亮度落在 [0.05, 0.85]。JPEG 在平坦暗区的振铃会把编码前
        最暗 20 的像素拉回 5，过冲量无法先验算准，所以黑地板用闭环标定。

   用法:
     node tools/planet-map-prep.js                    # 构建全部 5 张
     node tools/planet-map-prep.js --only=io          # 只重建一张
     node tools/planet-map-prep.js --only=moon-callisto

   输出到 source/img/：planet-mercury.jpg 512x256，
   moon-{io,europa,ganymede,callisto}.jpg 1024x512。
   本脚本只写这 5 个文件，不触碰其它贴图（jupiter / venus / earth / mars /
   saturn / uranus / neptune / saturn-ring 由别的工具负责）。
   ============================================================ */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { execFileSync } = require('child_process')
const { pngToJpeg, decodePng } = require('./png-to-jpeg.js')

/* ---------------- 路径与外部工具 ---------------- */
const ROOT = path.join(__dirname, '..')
const SRC_DIR = path.join(ROOT, '.perf', 'planet-src')
const OUT_DIR = path.join(ROOT, 'source', 'img')
// 仓库其它工具用的同一路径（Windows 上 Chrome 的固定安装位置）
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
// Chrome 的 --user-data-dir 一旦含空格就会静默失败，所以临时目录放在
// 仓库内、且名字里没有空格和中文。
const TMP = path.join(ROOT, '.perf', 'planet-map-prep')

/* ---------------- 可调常量（全部集中在此，便于审计） ---------------- */
const SRC_W = 2048; const SRC_H = 1024   // 源产品尺寸（2:1 简单圆柱）
const HOLE_TH = 8                        // max(R,G,B) < 8 -> 判为 no-data
const FILL_SRC_MIN = 24                  // 合格的"填充源"像素下限。源里存在大量
                                         // max(RGB) 在 5~7 的暗像素，若允许它们
                                         // 参与填充，洞会被填成同样低于阈值的值
const FILL_MAX_PASS = 4096               // 无数据填充最大迭代轮数（就地生长后几轮即收）
const HOLE_RING_MAX = 256                // 环形兜底搜索的最大切比雪夫半径（像素）
const BLACK_FLOOR_TARGET = 26            // 编码前黑地板目标（给 JPEG 暗区振铃留余量）
const BLACK_FLOOR_PASS = 5               // 黑地板闭环标定的最大重写轮数
const QUALITY = 88                       // JPEG 质量
const SEAM_WIN = 17                      // 拼缝检测的滑动中位数窗口（抽头数）
const SEAM_MAD_K = 3                     // 判定阈值 = k x MAD（MAD = 偏差的中位数
                                         // 绝对偏差，即"本图自身的噪声尺度"）
const SEAM_DEADZONE = 0.008              // 死区 0.8%：作为 3xMAD 的下限
const SEAM_MIN_DEV = 0.02                // 绝对最小判定幅度 2%：低于此的列 / 行
                                         // 视觉上根本看不出，标了只会让羽化整体抬噪
const SEAM_MAX_FRAC = 0.06               // 被标记比例超过 6% 就放弃该方向修正（见 4a 注释）
const SEAM_LINE_SPAN = 5                 // 窄线检测器的比较跨度（左右各 N 列的均值）
const SEAM_LINE_MIN = 0.012              // 窄线判定的最小幅度 1.2%
const SEAM_FEATHER = 3                   // ±3 px 升余弦羽化
const SEAM_MED_WIN = 31                  // 被标记列 / 行取值用的邻域中位数窗口
const POLE_REF_ROWS = 32                 // 极点延拓的参考纬带厚度（也是行剖面长度）
const POLE_ZONE_FRAC = 0.08              // 极区 = 最外侧 8% 的行（上下各一段）
const POLE_ANOM_FRAC = 0.25              // 极区均值与内侧参考带偏差超过 25% 判为坏带
const POLE_SAT_FRAC = 0.03               // 极区饱和（>=254）比例超过 3% 判为坏带
const POLE_BAND_MAX = 2                  // 参考带内行均值 > K x 带内中位数的行视为离群
const POLE_BLEND_ROWS = 10               // 极区延拓的羽化长度（行）
const POLE_BASE_WIN = 65                 // 延拓用的"局部基线"滑动中位数窗口
const POLE_FILL_TAIL = 24                // 列尾 / 列首均值取样行数（圆形拼图缺口的填充）
const POLE_DETAIL = 0.45                 // 极冠保留的真实细节比例（1=照搬纹理，0=纯低频）
const POLAR_ROWS = 8                     // 极区至少这么多行（与 8% 取大）
const TREND_LIMIT = 0.08                 // 光度趋势峰峰 / 均值超过 8% 才修正
const TREND_MAX_ITER = 6                 // 去趋势最大迭代轮数
const TREND_OUTLIER_K = 4                // 抗离群：|残差| > K x 残差中位数的像素
                                         // 下一轮不参与拟合
const LUM_MIN = 0.05; const LUM_MAX = 0.85
const BRIGHT_GAIN_MAX = 2.5              // 亮度标定增益上限
const DARK_GAIN_MIN = 0.55               // 亮度标定增益下限

/* Io 的 published 平均色：淡黄橙（硫 / 二氧化硫霜 + 极少量铁镁硅酸盐），
   取文献外观口径的 sRGB(230,205,148)（S=0.357），仅用作"色度方向的目标"，
   不做像素级替换。 */
const IO_TARGET_RGB = [230, 205, 148]
const IO_CHROMA_MIX = 0.35               // 朝目标色度混合的比例
const IO_SAT_GATE = 0.12                 // 饱和度死区（低于此不动色度）

/* 水星的中性微暖灰（见文件头第 6 步的出处说明） */
const MERCURY_TINT = [1.000, 0.988, 0.968]

const MAPS = [
  { key: 'mercury', file: 'wms-mercury.jpg', out: 'planet-mercury.jpg', layer: 'MESSENGER_v8', w: 512, h: 256, mono: true },
  { key: 'io', file: 'wms-io.jpg', out: 'moon-io.jpg', layer: 'SSI_color', w: 1024, h: 512, io: true },
  { key: 'europa', file: 'wms-europa.jpg', out: 'moon-europa.jpg', layer: 'GALILEO_VOYAGER', w: 1024, h: 512 },
  { key: 'ganymede', file: 'wms-ganymede.jpg', out: 'moon-ganymede.jpg', layer: 'GALILEO_VOYAGER', w: 1024, h: 512 },
  { key: 'callisto', file: 'wms-callisto.jpg', out: 'moon-callisto.jpg', layer: 'GALILEO_VOYAGER', w: 1024, h: 512 }
]

/* ---------------- 小工具 ---------------- */
const fileUrl = p => 'file:///' + path.resolve(p).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23')

/* 用无头 Chrome 把一张图渲染成 PNG 并解码成像素（与 tools/jupiter-prep.js
   的 shoot() 同一套路：--headless=new + --screenshot + --virtual-time-budget）。
   注意截图路径必须传绝对路径：传相对路径时 Chrome 会静默不写文件。 */
function shoot (srcPath, outPng, w, h) {
  const prof = path.join(TMP, 'prof')
  fs.rmSync(prof, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const htmlPath = path.resolve(outPng).replace(/\.png$/, '.html')
  fs.writeFileSync(htmlPath,
    '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:#000;overflow:hidden}' +
    'img{display:block;width:' + w + 'px;height:' + h + 'px}' +
    '</style></head><body><img src="' + fileUrl(srcPath) + '"></body></html>')
  execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--user-data-dir=' + prof, '--no-first-run', '--disable-extensions',
    '--force-device-scale-factor=1',
    '--window-size=' + w + ',' + h,
    '--virtual-time-budget=4000',
    '--screenshot=' + path.resolve(outPng),
    fileUrl(htmlPath)
  ], { stdio: 'ignore', timeout: 180000 })
  fs.rmSync(prof, { recursive: true, force: true })
  fs.rmSync(htmlPath, { force: true })
  if (!fs.existsSync(outPng)) throw new Error('Chrome 截图失败: ' + outPng)
  const img = decodePng(fs.readFileSync(outPng))
  if (img.w !== w || img.h !== h) throw new Error('截图尺寸不符: 期望 ' + w + 'x' + h + '，实际 ' + img.w + 'x' + img.h)
  return img
}

function medianOf (arr) {
  if (!arr.length) return NaN
  const s = Array.prototype.slice.call(arr).sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/* 滑动中位数（wrap=true 时环绕，用于经度方向）。
   用中位数而不是均值：拼缝本身就是窄的异常带，均值会被它自己污染。 */
function slidingMedian (v, win, wrap) {
  const n = v.length; const out = new Float64Array(n); const half = (win - 1) >> 1
  const buf = []
  for (let i = 0; i < n; i++) {
    buf.length = 0
    for (let k = -half; k <= half; k++) {
      let j = i + k
      if (wrap) j = ((j % n) + n) % n
      else j = Math.max(0, Math.min(n - 1, j))
      buf.push(v[j])
    }
    out[i] = medianOf(buf)
  }
  return out
}

/* 邻近有效值的中位数（被标记的列 / 行取值用） */
function medianOfNeighbours (v, i, win, wrap) {
  const n = v.length; const half = (win - 1) >> 1; const buf = []
  for (let k = -half; k <= half; k++) {
    if (k === 0) continue
    let j = i + k
    if (wrap) j = ((j % n) + n) % n
    else j = Math.max(0, Math.min(n - 1, j))
    if (Number.isFinite(v[j])) buf.push(v[j])
  }
  return medianOf(buf)
}

/* 最小二乘（高斯消元 + 部分主元）；病态时返回 null 由调用方处理。
   注意 A 的行是 Float64Array，其 slice() 仍返回 TypedArray（没有 .concat），
   必须用 Array.from 转成真数组再拼增广列。 */
function solveLstsq (A, b) {
  const n = b.length
  const M = []
  for (let i = 0; i < n; i++) M.push(Array.from(A[i]).concat([b[i]]))
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r
    if (Math.abs(M[piv][c]) < 1e-9) return null
    const t = M[c]; M[c] = M[piv]; M[piv] = t
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / M[c][c]
      if (f === 0) continue
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i]
  return x
}

/* 趋势基函数：经度 2 阶（三角多项式）+ 纬度 2 阶（归一化 x 的幂），共 7 项。
   [为什么经度必须用 cos/sin] 用 lon、lon^2 的话贴图左右边界处多项式不连续，
   修正后会在球上留下一条自己制造的竖直缝；三角多项式天然周期，0 度与
   360 度的值严格相等。
   [为什么纬度用 x 属于 [-1,1] 的幂] 未归一化的行号会让法方程条件数极差
   （1e6 量级），高斯消元会因主元过小而失败。 */
function trendTerms (u, v) {
  const lon = u * 2 * Math.PI
  const x = 1 - 2 * v
  return [1, Math.cos(lon), Math.sin(lon), Math.cos(2 * lon), Math.sin(2 * lon), x, x * x]
}

/* 拟合亮度趋势面；excl 可选（1 = 排除该像素，用于抗离群迭代） */
function fitTrend (lum, w, h, excl) {
  const terms = trendTerms(0, 0).length
  const A = []; const b = []
  for (let i = 0; i < terms; i++) { A.push(new Float64Array(terms)); b.push(0) }
  let sum = 0; let cnt = 0
  const STEP = 2
  for (let y = 0; y < h; y += STEP) {
    const v = (y + 0.5) / h
    for (let x = 0; x < w; x += STEP) {
      const i = y * w + x
      const L = lum[i]
      if (!(L > 0)) continue
      if (excl && excl[i]) continue
      const t = trendTerms((x + 0.5) / w, v)
      for (let k = 0; k < terms; k++) {
        for (let j = 0; j < terms; j++) A[k][j] += t[k] * t[j]
        b[k] += t[k] * L
      }
      sum += L; cnt++
    }
  }
  if (cnt < terms * 4) return null
  const c = solveLstsq(A, b)
  if (!c) return null
  const mean = sum / cnt
  let lo = Infinity; let hi = -Infinity
  const pred = new Float64Array(w * h)
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h
    for (let x = 0; x < w; x++) {
      const t = trendTerms((x + 0.5) / w, v)
      let p = 0
      for (let k = 0; k < terms; k++) p += c[k] * t[k]
      pred[y * w + x] = p
      if (p < lo) lo = p
      if (p > hi) hi = p
    }
  }
  if (!(hi > 0) || !(lo > 0)) return null
  return { pred, ptp: (hi - lo) / mean, lo, hi, mean }
}

/* 去趋势（迭代 + 抗离群）。
   [为什么必须迭代并且排除离群像素] 水星顶部 17 行是 WMS 的饱和白填充。
   2 阶多项式拟合会被这条 ~255 的亮带往上拽，拟合出的极点值高达 119.7
   （真实约 85），于是"除以趋势面"在极点只除以 0.68，白帽从 255 只压到 173。
   （极区修复已放在本步之前，所以这里的输入里已经没有白帽了；迭代 + 抗离群
   是第二道保险。） */
function removeTrend (px, W, H) {
  const lum = new Float64Array(W * H)
  for (let i = 0; i < W * H; i++) lum[i] = lumAt(px, i)
  const fit = fitTrend(lum, W, H)
  if (!fit) return null
  const before = fit.ptp
  if (before <= TREND_LIMIT) return { before, after: before, iters: 0 }
  const excl = new Uint8Array(W * H)
  let after = before; let iters = 0
  for (let it = 0; it < TREND_MAX_ITER; it++) {
    const f = fitTrend(lum, W, H, it === 0 ? null : excl)
    if (!f) break
    const g = f.mean
    for (let i = 0; i < W * H; i++) {
      const k = g / Math.max(1e-6, f.pred[i])
      for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.max(0, Math.min(255, px[i * 3 + c] * k))
      lum[i] = lumAt(px, i)
    }
    iters++
    if (it === 0) {
      const resid = []
      for (let i = 0; i < W * H; i += 2) resid.push(Math.abs(lum[i] - f.mean))
      const med = medianOf(resid)
      for (let i = 0; i < W * H; i++) if (Math.abs(lum[i] - f.mean) > TREND_OUTLIER_K * Math.max(1, med)) excl[i] = 1
    }
    const f2 = fitTrend(lum, W, H, it === 0 ? null : excl)
    after = f2 ? f2.ptp : NaN
    if (!(after > TREND_LIMIT)) break
  }
  return { before, after, iters }
}

/* ---------------- PNG 编码（RGBA，无滤波）----------------
   仓库里只有 PNG 解码器 + JPEG 编码器，没有 PNG 编码器，而 pngToJpeg
   的入参是文件路径，所以必须先把像素落成一个 PNG。
   沿用 tools/jupiter-sphere-map.js 里的最小实现。 */
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
  return (c ^ 0xffffffff) >>> 0
}
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
    const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([t, data])))
    chunks.push(len, t, data, cb)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6
  chunks.push(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  chunk('IHDR', ihdr)
  chunk('IDAT', idat)
  chunk('IEND', Buffer.alloc(0))
  return Buffer.concat(chunks)
}

/* 全图统计用 Float32Array 存 RGB，方便逐像素运算 */
function toFloat (img) {
  const { w, h, ch, data } = img
  const f = new Float32Array(w * h * 3)
  for (let i = 0, j = 0; i < w * h; i++, j += ch) {
    f[i * 3] = data[j]; f[i * 3 + 1] = data[j + 1]; f[i * 3 + 2] = data[j + 2]
  }
  return { w, h, px: f }
}
const lumAt = (px, i) => 0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2]

function clampPx (px, W, H) {
  for (let i = 0; i < W * H * 3; i++) px[i] = Math.max(0, Math.min(255, px[i]))
}

function rgbMean (px, W, H) {
  let r = 0; let g = 0; let b = 0
  for (let i = 0; i < W * H; i++) { r += px[i * 3]; g += px[i * 3 + 1]; b += px[i * 3 + 2] }
  const n = W * H
  return { r: r / n, g: g / n, b: b / n }
}

function meanSat (px, W, H) {
  let s = 0
  for (let i = 0; i < W * H; i++) {
    const r = px[i * 3]; const g = px[i * 3 + 1]; const b = px[i * 3 + 2]
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b)
    s += mx === 0 ? 0 : (mx - mn) / mx
  }
  return s / (W * H)
}

function satOf (rgb) {
  const mx = Math.max(rgb[0], rgb[1], rgb[2]); const mn = Math.min(rgb[0], rgb[1], rgb[2])
  return mx === 0 ? 0 : (mx - mn) / mx
}

function rgb2ycc (r, g, b) {
  return {
    y: 0.299 * r + 0.587 * g + 0.114 * b,
    cb: -0.168736 * r - 0.331264 * g + 0.5 * b,
    cr: 0.5 * r - 0.418688 * g - 0.081312 * b
  }
}

/* 列 / 行拼缝修正：把被标记的列 / 行整体替换 + ±SEAM_FEATHER 范围内升余弦羽化。
   [为什么不能"逐个被标记列各自乘一次修正系数"] 第一版就是这么写的，实测
   反而把偏差从 4.8% 放大到 11.0%：水星有 156 行连续 / 密集地被标记，而每行
   的修正窗口是 ±3 px，于是一个像素会被 7 个邻居各自的系数乘 7 次 ——
   过度修正本身成了一条新的亮 / 暗带。正确做法是把所有修正**先合成到一个
   乘性修正场 m[]**（同一像素的多份贡献按权重累加，权重上限 1），再对整幅
   图乘一次 m。这样对"单个孤立缝"而言 ±3 px 邻域的权重和恰好为 1，
   羽化剖面就是一条平滑的余弦，不会留下台阶。 */
function applySeamFix (px, W, H, dir, flagged, fixedProfile, origProfile) {
  if (!flagged.length) return
  const N = dir === 'col' ? W : H
  const m = new Float64Array(N)
  m.fill(1)
  const wsum = new Float64Array(N)
  for (const idx0 of flagged) {
    /* 单个列 / 行的修正幅度必须封顶。
       [为什么] 实测 wms-io 有 594 列被标记（它的圆形拼图接缝本身就很宽），
       邻域中位数在这些位置可能偏离一倍以上，逐列乘一个大系数会把局部
       纹理整片拉平 / 抬起，在球面上表现为**纵向条纹**（实测可见）。
       封顶到 ±18% 后修正仍能压低真正的窄缝，但不会制造条纹。 */
    const k = Math.max(0.82, Math.min(1.18, fixedProfile[idx0] / Math.max(1e-6, origProfile[idx0])))
    for (let d = -SEAM_FEATHER; d <= SEAM_FEATHER; d++) {
      const j = idx0 + d
      if (j < 0 || j >= N) continue
      const w = 0.5 + 0.5 * Math.cos(Math.PI * d / (SEAM_FEATHER + 1))
      if (w <= 1e-6) continue
      m[j] += w * (k - 1)
      wsum[j] += w
    }
  }
  for (let j = 0; j < N; j++) {
    if (wsum[j] > 1) m[j] = 1 + (m[j] - 1) / wsum[j]   // 归一化，避免累加超过单次修正
  }
  for (let j = 0; j < N; j++) {
    if (Math.abs(m[j] - 1) < 1e-6) continue
    const kk = m[j]
    if (dir === 'col') {
      for (let y = 0; y < H; y++) {
        const o = (y * W + j) * 3
        for (let c = 0; c < 3; c++) px[o + c] *= kk
      }
    } else {
      for (let x = 0; x < W; x++) {
        const o = (j * W + x) * 3
        for (let c = 0; c < 3; c++) px[o + c] *= kk
      }
    }
  }
}

/* 重开 JPEG 的硬校验 */
function verify (img, m) {
  const { w, h, ch, data } = img
  const dimOk = w === m.w && h === m.h
  let minMax = 255; let dark = 0; let lumSum = 0
  for (let i = 0; i < w * h; i++) {
    const j = i * ch
    const mx = Math.max(data[j], data[j + 1], data[j + 2])
    if (mx < minMax) minMax = mx
    if (mx < HOLE_TH) dark++
    lumSum += 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
  }
  const meanLum = lumSum / (w * h) / 255
  const lumOk = meanLum >= LUM_MIN && meanLum <= LUM_MAX
  return { w, h, dimOk, darkOk: dark === 0, dark, minMax, meanLum, lumOk, ok: dimOk && dark === 0 && lumOk }
}

/* ---------------- 单张地图的处理 ---------------- */
function processMap (m) {
  const srcPath = path.join(SRC_DIR, m.file)
  if (!fs.existsSync(srcPath)) throw new Error('缺少源图: ' + srcPath)
  const outPath = path.join(OUT_DIR, m.out)
  const log = []
  const say = s => { console.log('   ' + s); log.push(s) }
  const seamReport = {}

  console.log('\n=== ' + m.key + '  (' + m.file + ' -> ' + m.out + ') ===')

  // ── 1) 解码
  const img = shoot(srcPath, path.join(TMP, m.key + '-src.png'), SRC_W, SRC_H)
  const F = toFloat(img)
  const W = F.w; const H = F.h; const px = F.px
  say('1) 解码 ' + W + 'x' + H)

  // ── 2) 无数据填充
  const isHole = new Uint8Array(W * H)
  const wasFilled = new Uint8Array(W * H)   // 哪些像素是"填出来的"（2e 步只平滑这些）
  let holes0 = 0
  for (let i = 0; i < W * H; i++) {
    if (Math.max(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]) < HOLE_TH) { isHole[i] = 1; holes0++ }
  }
  const filledFrac = holes0 / (W * H)
  let passes = 0
  /* [为什么"就地更新"而不是"先收集再统一写回"] 后者为了防止单轮过大还要加
     像素上限；实测在 wms-io 上直接崩掉：它的洞是上下两条**横跨整幅宽度**
     的带状区域，扫描顺序是行优先，一轮只能处理每行最左边的几个洞像素，
     1028 轮之后还剩 18 万像素没填。就地更新时左边 / 上边的邻域在本次扫描中
     已经被写成有效值，一条横带能在同一轮里从左到右一路铺满。 */
  while (holes0 > 0 && passes < FILL_MAX_PASS) {
    passes++
    let filledThisPass = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!isHole[i]) continue
        const xl = (x + W - 1) % W; const xr = (x + 1) % W
        let n = 0; let r = 0; let g = 0; let b = 0; let bright = 0
        const add = j => {
          if (isHole[j]) return
          const k = j * 3
          r += px[k]; g += px[k + 1]; b += px[k + 2]; n++
          if (Math.max(px[k], px[k + 1], px[k + 2]) >= FILL_SRC_MIN) bright++
        }
        add(y * W + xl); add(y * W + xr)
        if (y > 0) add(i - W)
        if (y < H - 1) add(i + W)
        /* 除了"≥2 个有效 4 邻域"，还要求其中至少一个邻域本身不低于
           FILL_SRC_MIN。源里存在大量 max(RGB) 在 5~7 的暗像素，只按"有效"
           取均值会把洞填成同样低于阈值的值（实测 10141 个像素填完仍是 5~7），
           于是"整幅图不再有 max(RGB)<8"这条断言永远无法通过。 */
        if (n >= 2 && bright >= 1) {
          px[i * 3] = r / n; px[i * 3 + 1] = g / n; px[i * 3 + 2] = b / n
          isHole[i] = 0; wasFilled[i] = 1; holes0--; filledThisPass++
        }
      }
    }
    if (!filledThisPass) break
  }
  /* [兜底：按列最近行延拓 —— 这是本脚本对极区缺口采用的主手段]
     ────────────────────────────────────────────────────────────
     wms-io 的洞不是"几个坏像素"，而是**两块 Galileo SSI 圆形拼图之间
     与圆外的整片空白**：实测每一列的 no-data 是上下两个连续的区间
     （例如经度 0..1023 的列从第 12 行起才有数据、到第 880 行为止），
     空洞最深 128 px，12.26% 的像素都在洞外。
     对这类"整段纬度缺失"，用邻域均值/BFS 生长去填是错的：生长出来的颜色
     没有纬度结构，在球面上就是两端一大片纵向拉丝（实测可见）。
     正确做法是按列取"最近的有效行"直接延拓：极区里相邻纬度的真实外观
     本来就高度相似，因此把最近的整行内容搬过去，既保持了该经度的真实
     纹理，又不会产生任何虚假的纵向结构。
     取 r±1 两行的平均而不是单行，是为了不让 JPEG 噪点整行复制。 */
  if (holes0 > 0) {
    let filled = 0
    const TAIL = POLE_FILL_TAIL
    for (let x = 0; x < W; x++) {
      let top = -1; let bot = -1
      for (let y = 0; y < H; y++) if (!isHole[y * W + x]) { if (top < 0) top = y; bot = y }
      if (top < 0) continue
      // 列尾均值：该列"最靠外的那一小段有效行"的平均色
      const meanOf = (y0, y1) => {
        let r = 0; let g = 0; let b = 0; let n = 0
        for (let y = y0; y <= y1; y++) {
          if (isHole[y * W + x]) continue
          const k = (y * W + x) * 3
          r += px[k]; g += px[k + 1]; b += px[k + 2]; n++
        }
        return n ? [r / n, g / n, b / n] : null
      }
      const headC = meanOf(top, Math.min(bot, top + TAIL))
      const tailC = meanOf(Math.max(top, bot - TAIL), bot)
      for (let y = 0; y < H; y++) {
        const i = y * W + x
        if (!isHole[i]) continue
        // 靠上边界的缺口用列首均值，靠下边界的用列尾均值
        const c3 = (y < top) ? headC : tailC
        if (!c3) continue
        px[i * 3] = c3[0]; px[i * 3 + 1] = c3[1]; px[i * 3 + 2] = c3[2]
        isHole[i] = 0; wasFilled[i] = 1; holes0--; filled++
      }
    }
    if (filled) say('2b) 按列列尾均值延拓 ' + filled + ' 个像素（圆形拼图缺口）')
  }
  /* 剩余的零散洞（不构成整段纬度缺失）再用区域生长 + BFS 处理 */
  if (holes0 > 0) {
    const N = W * H
    const dist = new Int32Array(N).fill(-1)
    const q = new Int32Array(N)
    let qh = 0; let qt = 0
    for (let i = 0; i < N; i++) if (!isHole[i]) { dist[i] = 0; q[qt++] = i }
    const seedCount = qt
    while (qh < qt) {
      const i = q[qh++]
      const x = i % W; const y = (i - x) / W
      const push = j => { if (dist[j] < 0) { dist[j] = dist[i] + 1; q[qt++] = j } }
      if (x > 0) push(i - 1)
      if (x < W - 1) push(i + 1)
      if (y > 0) push(i - W)
      if (y < H - 1) push(i + W)
    }
    for (let t = seedCount; t < qt; t++) {
      const i = q[t]
      const x = i % W; const y = (i - x) / W
      let n = 0; let r = 0; let g = 0; let b = 0; let bright = 0
      const add = j => {
        if (isHole[j]) return
        const k = j * 3
        r += px[k]; g += px[k + 1]; b += px[k + 2]; n++
        if (Math.max(px[k], px[k + 1], px[k + 2]) >= FILL_SRC_MIN) bright++
      }
      if (x > 0) add(i - 1)
      if (x < W - 1) add(i + 1)
      if (y > 0) add(i - W)
      if (y < H - 1) add(i + W)
      if (!n || !bright) continue
      px[i * 3] = r / n; px[i * 3 + 1] = g / n; px[i * 3 + 2] = b / n
      isHole[i] = 0; wasFilled[i] = 1; holes0--
    }
    const far = qt ? dist[q[qt - 1]] : 0
    say('2c) BFS 兜底回填（最大邻域距离 ' + far + ' px）')
  }
  /* ── 2e) 回填区平滑
     区域生长 / BFS 填出来的像素是"4 邻域均值"的迭代结果，在巨大空洞内部
     会残留细微的层状结构（实测 wms-io 的回填区在逐列亮度剖面上留下一条
     62% 的孤立列，被拼缝判据当成缝）。这里对回填像素做一次 3x3 中位数平滑：
     中位数不会糊掉真实纹理，但能消掉这种逐像素的层状残留。
     只作用于回填掩码覆盖的像素，原始数据一个像素都不动。 */
  {
    let n = 0
    const buf = []
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x
        if (!wasFilled[i]) continue
        for (let c = 0; c < 3; c++) {
          buf.length = 0
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy
            if (yy < 0 || yy >= H) continue
            for (let dx = -1; dx <= 1; dx++) {
              const xx = (x + dx + W) % W
              buf.push(px[(yy * W + xx) * 3 + c])
            }
          }
          px[i * 3 + c] = medianOf(buf)
        }
        n++
      }
    }
    if (n) say('2e) 回填区 3x3 中位数平滑 ' + n + ' 个像素')
  }
  /* 回填颜色可能取到源里本来就极暗的像素，再钳一次地板（抬到 HOLE_TH，
     保持三通道相对差）。只影响填出来的像素，不动原始数据。
     注意这一步必须放在 2e 的 3x3 中位数平滑**之后**：中位数会从邻域取出
     源里 5~7 的暗像素，平滑本身会把个别像素重新压到阈值以下（实测 3 个）。 */
  let fillFloor = 0
  for (let i = 0; i < W * H; i++) {
    if (!wasFilled[i]) continue
    const mx = Math.max(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])
    if (mx >= HOLE_TH) continue
    const add = HOLE_TH - mx
    px[i * 3] += add; px[i * 3 + 1] += add; px[i * 3 + 2] += add
    fillFloor++
  }
  if (fillFloor) say('2d) 回填结果地板校正 ' + fillFloor + ' 个像素（源数据本身存在 5~7 的暗像素）')
  /* 收尾兜底：到这一步任何仍低于阈值的像素都不可能是"真实数据洞"（第 2 步的
     断言马上就会检查），只可能是回填 / 平滑留下的残留，因此无条件抬到阈值。 */
  {
    let left = 0
    for (let i = 0; i < W * H; i++) {
      const mx = Math.max(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])
      if (mx >= HOLE_TH) continue
      const add = HOLE_TH - mx
      px[i * 3] += add; px[i * 3 + 1] += add; px[i * 3 + 2] += add
      left++
    }
    if (left) say('2d-2) 收尾地板校正 ' + left + ' 个像素')
  }
  let after = 0
  for (let i = 0; i < W * H; i++) if (Math.max(px[i * 3], px[i * 3 + 1], px[i * 3 + 2]) < HOLE_TH) after++
  say('2) 无数据填充: ' + (filledFrac * 100).toFixed(3) + '% (' + passes +
    ' 轮区域生长 + BFS + 环形兜底)，残留黑洞 ' + after)
  if (holes0 !== 0 || after !== 0) {
    console.error('无数据填充未完成（剩余 ' + after + ' 像素颜色低于阈值，迭代 ' + passes + ' 轮）')
    process.exit(1)
  }

  /* ── 3) 极区检查与延拓（必须在光度趋势修正之前做）
     实测到的极区问题有两类：
       (a) 极区整行是 no-data（wms-io 顶部 86 行全黑、wms-europa 底部 32 行
           全黑、wms-ganymede 顶部 3 行全黑）—— 第 2 步已把它们填成灰色，
           但"填出来的灰"没有真实结构，直接留在极点就是一顶平滑的灰帽；
       (b) 极区是**饱和白**（wms-mercury 顶部 0..16 行被 255 顶死，底部
           1018..1023 同类异常）—— 这不是黑洞，普通黑洞判据查不出来，
           但它是一顶刺眼的白帽，还会向下拖出一条 30 余行的过渡斜坡。

     [为什么必须放在趋势修正之前] 2 阶多项式拟合会被这条 ~255 的亮带往上
     拽：实测拟合出的极点值 119.7（真实约 85），"除以趋势面"在极点只除以
     0.68，白帽从 255 只压到 173；更糟的是这个乘性因子会把白帽重新写回真实
     行星数据之上，于是后面任何对极点行的局部修正都被它放大回去。先修极点，
     去趋势残差从 8.55% 降到 0.38%。

     [为什么参考带要先剔除离群行] 水星顶部的坏带不是 17 行就结束，17..~95 行
     是一条缓慢降下来的过渡斜坡（实测第 82..114 行的 R 均值仍高达 254）。
     直接把这 32 行当参考带，延拓取到的像素还是 255，白帽只是被搬到了极点。
     做法是先算参考带的行均值中位数 m，只保留行均值 <= POLE_BAND_MAX x m 的
     行参与取样。

     处理：极区 = 最外侧 POLE_ZONE_FRAC（至少 POLAR_ROWS 行）。若极区异常，
     就用紧邻其内侧的 POLE_REF_ROWS 行参考纬带向极点延拓：

         out = 目标纬度行均值 + (带内像素 - 局部基线)

     局部基线取 colMean 的 POLE_BASE_WIN 抽头环绕中位数。"带内像素 - 基线"
     的行均值恒为 0，所以延拓区的整体亮度严格等于目标纬度行均值 ——
     极点既不会有黑帽 / 白帽，也不会出现一条比周围亮的横带，而纹理仍然
     来自真实数据。
     [踩过的坑 1] 第一版拿"整行均值"这个标量直接和逐像素值相减，等于给每个
     像素都加回了一整个行均值，延拓区亮度变成参考带的 2.7 倍，长出一顶亮帽。
     基线必须是逐像素的局部值。
     [踩过的坑 2] 权重不能是整个极区做一次升余弦：那样前 20 行的权重接近 0，
     坏带根本没被替换。数据本身是坏的就该整段替换，升余弦只用来保证替换区
     与原始数据之间没有台阶，因此只在最靠内的 POLE_BLEND_ROWS 行做过渡。 */
  {
    const zone = Math.max(POLAR_ROWS, Math.round(H * POLE_ZONE_FRAC))
    const ref = POLE_REF_ROWS
    const rowLumP = new Float64Array(H)
    for (let y = 0; y < H; y++) {
      let s = 0
      for (let x = 0; x < W; x++) s += lumAt(px, y * W + x)
      rowLumP[y] = s / W
    }
    const poleReport = []
    for (const side of ['top', 'bottom']) {
      const isTop = side === 'top'
      /** 极区坐标 -> 绝对行号：k=0 是最靠极点的那一行 */
      const A = k => (isTop ? k : H - 1 - k)
      const idx = (k, x) => A(k) * W + x
      // (a) 极区统计（未归一化口径，直接对应黑帽 / 白帽）
      let sat = 0; let zoneSum = 0; let zoneCnt = 0; let zoneMin = 255
      for (let k = 0; k < zone; k++) {
        for (let x = 0; x < W; x++) {
          const i = idx(k, x)
          const mx = Math.max(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])
          if (mx >= 254) sat++
          const L = lumAt(px, i)
          if (L < zoneMin) zoneMin = L
          zoneSum += L; zoneCnt++
        }
      }
      const zoneMean = zoneCnt ? zoneSum / zoneCnt : 0
      const satFrac = zoneCnt ? sat / zoneCnt : 0
      // (b) 内侧参考带
      let rs = 0; let rc = 0
      for (let k = zone; k < Math.min(H, zone + ref); k++) {
        for (let x = 0; x < W; x++) { rs += lumAt(px, idx(k, x)); rc++ }
      }
      const refMean = rc ? rs / rc : 0
      const dev = Math.abs(zoneMean - refMean) / Math.max(1e-6, refMean)
      const bad = satFrac > POLE_SAT_FRAC || zoneMean < HOLE_TH || dev > POLE_ANOM_FRAC
      poleReport.push({ side, zone, zoneMean, refMean, dev, satFrac, fixed: bad })
      if (!bad) {
        say('3) 极区(' + side + ', ' + zone + ' 行): 均值 ' + zoneMean.toFixed(1) +
          ' vs 内侧参考带 ' + refMean.toFixed(1) + ' 偏差 ' + (dev * 100).toFixed(2) +
          '% <= ' + (POLE_ANOM_FRAC * 100).toFixed(0) + '%  饱和率 ' + (satFrac * 100).toFixed(2) +
          '% -> 未见异常，不延拓')
        continue
      }
      // (c) 参考带内剔除离群行后再取样
      const bandRowMean = new Float64Array(ref)
      for (let d = 0; d < ref; d++) bandRowMean[d] = rowLumP[A(Math.min(H - 1, zone + d))]
      const bandMed = medianOf(bandRowMean)
      const useRow = new Uint8Array(ref)
      let useCnt = 0
      for (let d = 0; d < ref; d++) {
        if (bandRowMean[d] <= POLE_BAND_MAX * Math.max(1, bandMed)) { useRow[d] = 1; useCnt++ }
      }
      if (useCnt < 4) { useRow.fill(1); useCnt = ref }
      const colMean = new Float64Array(W)
      for (let x = 0; x < W; x++) {
        let s = 0; let n = 0
        for (let d = 0; d < ref; d++) {
          if (!useRow[d]) continue
          s += lumAt(px, idx(zone + d, x)); n++
        }
        colMean[x] = s / Math.max(1, n)
      }
      const colBase = slidingMedian(colMean, Math.min(W, POLE_BASE_WIN | 1), true)
      // 取样行：在被保留的行里取最靠内的那一行（最远离坏带）
      let sampleD = 0
      for (let d = ref - 1; d >= 0; d--) if (useRow[d]) { sampleD = d; break }
      const IN = Math.min(sampleD, Math.max(0, ref - 1))
      const rowA = bandRowMean[IN]
      const rIn = idx(Math.min(H - 1, zone + IN), 0)
      const blendRows = Math.max(1, Math.min(POLE_BLEND_ROWS, zone))
      /* [为什么延拓不能把参考行"整段照搬"到极点] 等距圆柱投影在极区把同一段
         纬度压缩到极少的行上（wms-io 顶部 136 行就是从数据边界一路压到极点），
         把参考行的逐像素纹理直接平移上去，会在球的两端产生大片**纵向拉丝**
         （实测可见：条带方向与经线一致）。极冠在物理上应该是所有经线收敛到
         同一个值，因此正确做法是：
             out = 低频剖面 + (带内像素 - 局部基线) x POLE_DETAIL
         其中 低频剖面 用 colMean（跨参考行平均）表示该纬度的东西向结构，
         (带内像素 - 局部基线) 是均值恒为 0 的真实细节，POLE_DETAIL 把细节
         衰减掉，得到"平滑但非纯色"的极冠。最后按 目标行均值 / 低频剖面均值
         整体缩放，保证纬度亮度剖面照旧。 */
      const det = new Float64Array(W)
      let detMean = 0
      for (let x = 0; x < W; x++) { det[x] = px[rIn + x * 3] - colBase[x]; detMean += det[x] }
      detMean /= W
      let lowMean = 0
      for (let x = 0; x < W; x++) lowMean += colBase[x]
      lowMean /= W
      const renorm = rowA / Math.max(1e-6, lowMean)
      for (let k = 0; k < zone; k++) {
        // 羽化只在靠带边界的一侧：靠极点的一侧完全替换
        const dToEdge = zone - k
        const wt = dToEdge >= blendRows
          ? 1
          : 0.5 - 0.5 * Math.cos(Math.PI * dToEdge / blendRows)
        for (let x = 0; x < W; x++) {
          const o = idx(k, x) * 3
          const pIn = rIn + x * 3
          for (let c = 0; c < 3; c++) {
            // 低频结构（该纬度的东西向剖面）+ 衰减后的真实细节，再缩放到目标行均值
            const lf = px[pIn + c] - colBase[x] + lowMean
            const target = (lf + POLE_DETAIL * (px[pIn + c] - colBase[x] - detMean)) * renorm
            px[o + c] = px[o + c] * (1 - wt) + target * wt
          }
        }
      }
      clampPx(px, W, H)
      let extMean = 0
      for (let x = 0; x < W; x++) extMean += lumAt(px, idx(0, x))
      extMean /= W
      say('3) 极区(' + side + ', ' + zone + ' 行): 均值 ' + zoneMean.toFixed(1) +
        ' vs 内侧参考带 ' + refMean.toFixed(1) + ' 偏差 ' + (dev * 100).toFixed(1) +
        '%  饱和率 ' + (satFrac * 100).toFixed(2) + '%  最暗 ' + zoneMin.toFixed(1) +
        ' -> 判为异常，已用第 ' + zone + ' 行起的参考纬带向极点延拓' +
        '（参考带剔除 ' + (ref - useCnt) + '/' + ref + ' 行离群行，取样第 ' + (zone + IN) + ' 行）' +
        '  延拓后极点行均值 ' + extMean.toFixed(1) + '（参考行均值 ' + rowA.toFixed(1) + '）')
      if (extMean > 2 * Math.max(1, rowA) || extMean < HOLE_TH) {
        console.error('极区延拓结果异常：极点行均值 ' + extMean.toFixed(1) + ' vs 参考 ' + rowA.toFixed(1))
        process.exit(1)
      }
    }
    seamReport.pole = poleReport
  }

  /* ── 3b) 光度趋势修正（必须在拼缝修复之前做）
     [为什么顺序是"极区修复 -> 趋势 -> 拼缝"而不是按编号顺序] 水星这幅图的
     纬度亮度趋势极大（首轮拟合峰峰 / 均值 = 83.58%）。若不先拿掉这条低频
     趋势，拼缝判据会把"陡峭但真实"的纬度梯度当成缝（实测标记 149/1024 行），
     修正反而把真实梯度拉平，偏差从 16.99% 涨到 34.58%。
     极区修复必须在趋势之前（理由见上一节），趋势又必须在拼缝之前，
     所以真实顺序是 2 -> 3 -> 3b -> 4 -> 5 -> 6 -> 7 -> 8。
     报告口径仍是"进入 / 离开本步骤"的峰峰比（这张图还剩多少低频光度趋势）。 */
  const trendInfo = removeTrend(px, W, H)
  if (!trendInfo) {
    say('3b) 光度趋势: 拟合病态，跳过')
  } else {
    say('3b) 光度趋势(经 / 纬 2 阶多项式, ' + trendInfo.iters + ' 轮迭代 + 抗离群): 峰峰 / 均值 ' +
      (trendInfo.before * 100).toFixed(2) + '%' +
      (trendInfo.before > TREND_LIMIT
        ? ' > ' + (TREND_LIMIT * 100).toFixed(0) + '% -> 已除以趋势面并拉回原均值 -> 残差 ' +
          (trendInfo.after * 100).toFixed(2) + '%'
        : ' <= ' + (TREND_LIMIT * 100).toFixed(0) + '% -> 无需修正'))
  }

  /* ── 4) 拼缝修复
     逐列 / 逐行平均亮度与 17 抽头滑动中位数比较，超过 max(3xMAD, 0.8%) 的
     列 / 行判为缝，用邻域中位数替换 + ±3 px 升余弦羽化。
     上一步已经拿掉了低频光度趋势，这里"偏离局部中位数"剩下的就基本是真正的
     接缝 / 条带痕迹，而不再是行星自身的纬度梯度。 */
  {
    const colLum = new Float64Array(W); const rowLum = new Float64Array(H)
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let y = 0; y < H; y++) s += lumAt(px, y * W + x)
      colLum[x] = s / H
    }
    for (let y = 0; y < H; y++) {
      let s = 0
      for (let x = 0; x < W; x++) s += lumAt(px, y * W + x)
      rowLum[y] = s / W
    }
    // (a) 列（经度方向，环绕）
    const cm = slidingMedian(colLum, SEAM_WIN, true)
    const cdev = new Float64Array(W)
    for (let x = 0; x < W; x++) cdev[x] = Math.abs(colLum[x] - cm[x]) / Math.max(1e-6, cm[x])
    const cmad = medianOf(Array.from(cdev))
    // 阈值 = max(3xMAD, 0.8%)：MAD 是本图自身的噪声尺度，死区保证在亮度
    // 极低（MAD 趋近 0）的图上仍有一条最低限度的判据，两者取大。
    const thC = Math.max(SEAM_MAD_K * cmad, SEAM_DEADZONE, SEAM_MIN_DEV)
    const broadC = []
    for (let x = 0; x < W; x++) if (cdev[x] > thC) broadC.push(x)
    /* (a2) 窄线检测器（对"细接缝线"比上面的宽带判据灵敏得多）
       [为什么需要第二个判据] 真正的拼图接缝是 1~3 px 的细线，它们对"整列均值"
       的贡献很小 —— 一条 2 px 的亮线混在 512 行里只把列均值抬高约 0.4%，
       远低于 2% 的宽带阈值，于是会被漏掉（实测 wms-io 的两块圆形拼图边界与
       wms-europa 的经向缝都是这种情况，在一倍视图里肉眼清晰可见）。
       这里用"局部峰"判据：把该列与左右各 SEAM_LINE_SPAN 列的均值比较，
       超过 max(3xMAD, SEAM_LINE_MIN) 的列即为窄线。窄线在构造上必然是
       孤立细线，因此这一组永远安全，不参与下面的比例保护判定。 */
    const lineDev = new Float64Array(W)
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let d = -SEAM_LINE_SPAN; d <= SEAM_LINE_SPAN; d++) {
        if (d === 0) continue
        s += colLum[((x + d) % W + W) % W]
      }
      lineDev[x] = Math.abs(colLum[x] - s / (2 * SEAM_LINE_SPAN)) / Math.max(1e-6, colLum[x])
    }
    const lmad = medianOf(Array.from(lineDev))
    const lineTh = Math.max(SEAM_MAD_K * lmad, SEAM_LINE_MIN)
    const lineC = []
    for (let x = 0; x < W; x++) if (lineDev[x] > lineTh) lineC.push(x)
    /* [保护：什么时候"逐列修正"是有害的] 逐列 / 逐行修正在数学上假设
       "被标记的位置是少数、且邻域能代表它应有的值"。宽带判据被标记比例很大时
       这个假设不成立：实测 wms-io 有 440/2048 = 21% 的列超过 2%，因为该产品的
       逐列均值本身就是高频的（圆形拼图边界 + 大片缺口）。此时逐列乘修正系数
       会把整幅图推成**纵向条纹**（实测：修正后经向高频能量 0.90 -> 1.63，
       比源图还差）。所以"宽带组"超过 SEAM_MAX_FRAC 就整组放弃，
       但窄线组照常修正 —— 宁可不修，也不要修出条纹。 */
    const colSkip = broadC.length > SEAM_MAX_FRAC * W
    const flaggedC = colSkip ? lineC : broadC.concat(lineC.filter(x => broadC.indexOf(x) < 0))
    flaggedC.sort((a, b) => a - b)
    const beforeC = broadC.length ? Math.max.apply(null, broadC.map(x => cdev[x])) : 0
    let afterC = beforeC
    if (!flaggedC.length) {
      say('4a) 列拼缝: 阈值 ' + (thC * 100).toFixed(2) + '%  未标记任何列')
    } else {
      const fixedCol = colLum.slice()
      for (const x of flaggedC) fixedCol[x] = medianOfNeighbours(colLum, x, SEAM_MED_WIN, true)
      applySeamFix(px, W, H, 'col', flaggedC, fixedCol, colLum)
      clampPx(px, W, H)
      const colLum2 = new Float64Array(W)
      for (let x = 0; x < W; x++) { let s = 0; for (let y = 0; y < H; y++) s += lumAt(px, y * W + x); colLum2[x] = s / H }
      const cm2 = slidingMedian(colLum2, SEAM_WIN, true)
      afterC = 0
      for (const x of broadC) afterC = Math.max(afterC, Math.abs(colLum2[x] - cm2[x]) / Math.max(1e-6, cm2[x]))
      const allAfterC = new Float64Array(W)
      for (let x = 0; x < W; x++) allAfterC[x] = Math.abs(colLum2[x] - cm2[x]) / Math.max(1e-6, cm2[x])
      say('4a) 列拼缝: 宽带阈值 ' + (thC * 100).toFixed(2) + '%（3xMAD=' + (3 * cmad * 100).toFixed(2) +
        '%）宽带标记 ' + broadC.length + '/' + W + (colSkip ? '（比例过高，宽带组跳过）' : '') +
        ' + 窄线检测 ' + lineC.length + ' 列（阈值 ' + (lineTh * 100).toFixed(2) + '%）' +
        ' -> 实际修正 ' + flaggedC.length + ' 列  宽带最大偏差 ' + (beforeC * 100).toFixed(2) +
        '% -> ' + (afterC * 100).toFixed(2) + '%' +
        '  (全列最大 ' + (Math.max.apply(null, Array.from(cdev)) * 100).toFixed(2) + '% -> ' +
        (Math.max.apply(null, Array.from(allAfterC)) * 100).toFixed(2) + '%)')
      seamReport.colMaxAllAfter = Math.max.apply(null, Array.from(allAfterC))
    }
    seamReport.col = {
      flagged: flaggedC.length, th: thC, before: beforeC, after: afterC, skipped: colSkip,
      maxAllBefore: Math.max.apply(null, Array.from(cdev)),
      maxAllAfter: seamReport.colMaxAllAfter !== undefined
        ? seamReport.colMaxAllAfter
        : Math.max.apply(null, Array.from(cdev))
    }

    // (b) 行（纬度方向，不环绕）
    const rm = slidingMedian(rowLum, SEAM_WIN, false)
    const rdev = new Float64Array(H)
    for (let y = 0; y < H; y++) rdev[y] = Math.abs(rowLum[y] - rm[y]) / Math.max(1e-6, rm[y])
    const rmad = medianOf(Array.from(rdev))
    const thR = Math.max(SEAM_MAD_K * rmad, SEAM_DEADZONE, SEAM_MIN_DEV)
    const flaggedR = []
    for (let y = 0; y < H; y++) if (rdev[y] > thR) flaggedR.push(y)
    // 窄线检测器（同 4a，方向为纬度）：纬度方向不环绕
    const rowLineDev = new Float64Array(H)
    for (let y = 0; y < H; y++) {
      let s = 0; let n = 0
      for (let d = -SEAM_LINE_SPAN; d <= SEAM_LINE_SPAN; d++) {
        if (d === 0) continue
        const yy = y + d
        if (yy < 0 || yy >= H) continue
        s += rowLum[yy]; n++
      }
      rowLineDev[y] = n ? Math.abs(rowLum[y] - s / n) / Math.max(1e-6, rowLum[y]) : 0
    }
    const rowLineTh = Math.max(SEAM_MAD_K * medianOf(Array.from(rowLineDev)), SEAM_LINE_MIN)
    const rowLines = []
    for (let y = 0; y < H; y++) if (rowLineDev[y] > rowLineTh) rowLines.push(y)
    for (const y of rowLines) if (flaggedR.indexOf(y) < 0) flaggedR.push(y)
    flaggedR.sort((a, b) => a - b)
    const beforeR = flaggedR.length ? Math.max.apply(null, flaggedR.map(y => rdev[y])) : 0
    const fixedRow = rowLum.slice()
    for (const y of flaggedR) fixedRow[y] = medianOfNeighbours(rowLum, y, SEAM_MED_WIN, false)
    applySeamFix(px, W, H, 'row', flaggedR, fixedRow, rowLum)
    clampPx(px, W, H)
    const rowLum2 = new Float64Array(H)
    for (let y = 0; y < H; y++) { let s = 0; for (let x = 0; x < W; x++) s += lumAt(px, y * W + x); rowLum2[y] = s / W }
    const rm2 = slidingMedian(rowLum2, SEAM_WIN, false)
    let afterR = 0
    for (const y of flaggedR) afterR = Math.max(afterR, Math.abs(rowLum2[y] - rm2[y]) / Math.max(1e-6, rm2[y]))
    const allAfterR = new Float64Array(H)
    for (let y = 0; y < H; y++) allAfterR[y] = Math.abs(rowLum2[y] - rm2[y]) / Math.max(1e-6, rm2[y])
    seamReport.row = {
      flagged: flaggedR.length, th: thR, before: beforeR, after: afterR,
      maxAllBefore: Math.max.apply(null, Array.from(rdev)),
      maxAllAfter: Math.max.apply(null, Array.from(allAfterR))
    }
    say('4b) 行拼缝: 阈值 ' + (thR * 100).toFixed(2) + '%（3xMAD=' + (3 * rmad * 100).toFixed(2) + '%）' +
      ' 标记 ' + flaggedR.length + '/' + H + ' 行  最大偏差 ' + (beforeR * 100).toFixed(2) +
      '% -> ' + (afterR * 100).toFixed(2) + '%' +
      '  (全行最大 ' + (seamReport.row.maxAllBefore * 100).toFixed(2) + '% -> ' +
      (seamReport.row.maxAllAfter * 100).toFixed(2) + '%)')
  }

  /* ── 5) 光度趋势复核（不把光照烤进贴图）
     趋势修正在第 3b 步已经做过；这里重新拟合一次做事后核实，确认极区延拓
     与拼缝羽化没有把新的低频趋势引进来。 */
  {
    const lum = new Float64Array(W * H)
    for (let i = 0; i < W * H; i++) lum[i] = lumAt(px, i)
    const fit = fitTrend(lum, W, H)
    const after = fit ? fit.ptp : NaN
    if (trendInfo) {
      trendInfo.final = after
      say('5) 光度趋势复核: ' + (trendInfo.before * 100).toFixed(2) + '% -> ' +
        (trendInfo.after * 100).toFixed(2) + '%（趋势修正后）-> ' +
        (after * 100).toFixed(2) + '%（极区 / 拼缝处理后）')
    } else {
      say('5) 光度趋势复核: 峰峰 / 均值 ' + (after * 100).toFixed(2) + '%')
    }
    seamReport.trend = trendInfo
      ? { before: trendInfo.before, after: trendInfo.after, final: trendInfo.final }
      : null
  }

  /* ── 6) 色彩保真 */
  {
    const stat = rgbMean(px, W, H)
    const sat0 = meanSat(px, W, H)
    if (m.io) {
      const tgt = rgb2ycc(IO_TARGET_RGB[0], IO_TARGET_RGB[1], IO_TARGET_RGB[2])
      for (let i = 0; i < W * H; i++) {
        const r = px[i * 3]; const g = px[i * 3 + 1]; const b = px[i * 3 + 2]
        const y = 0.299 * r + 0.587 * g + 0.114 * b
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b
        const cr = 0.5 * r - 0.418688 * g - 0.081312 * b
        const mx = Math.max(r, g, b); const mn = Math.min(r, g, b)
        const s = mx === 0 ? 0 : (mx - mn) / mx
        if (s <= IO_SAT_GATE) continue
        // 饱和度越高，混合越强（线性门控 0..1）
        const gate = Math.min(1, (s - IO_SAT_GATE) / 0.25)
        const k = IO_CHROMA_MIX * gate
        const cb2 = cb + (tgt.cb - cb) * k
        const cr2 = cr + (tgt.cr - cr) * k
        // YCbCr -> RGB，Y 不变即亮度结构完全不动
        px[i * 3] = y + 1.402 * cr2
        px[i * 3 + 1] = y - 0.344136 * cb2 - 0.714136 * cr2
        px[i * 3 + 2] = y + 1.772 * cb2
      }
      clampPx(px, W, H)
      const stat2 = rgbMean(px, W, H)
      const sat1 = meanSat(px, W, H)
      say('6) Io 色彩保真: 平均 sRGB (' + stat.r.toFixed(1) + ', ' + stat.g.toFixed(1) + ', ' +
        stat.b.toFixed(1) + ') 平均饱和度 ' + sat0.toFixed(3) + ' > published ' +
        satOf(IO_TARGET_RGB).toFixed(3) + ' -> 色度朝 published 淡黄橙 sRGB(' +
        IO_TARGET_RGB.join(',') + ') 混合 ' + (IO_CHROMA_MIX * 100).toFixed(0) + '% -> (' +
        stat2.r.toFixed(1) + ', ' + stat2.g.toFixed(1) + ', ' + stat2.b.toFixed(1) +
        ') 饱和度 ' + sat1.toFixed(3))
      seamReport.color = { before: stat, after: stat2, satBefore: sat0, satAfter: sat1 }
    } else if (m.mono) {
      for (let i = 0; i < W * H; i++) {
        px[i * 3] *= MERCURY_TINT[0]
        px[i * 3 + 1] *= MERCURY_TINT[1]
        px[i * 3 + 2] *= MERCURY_TINT[2]
      }
      clampPx(px, W, H)
      const stat2 = rgbMean(px, W, H)
      say('6) 单色产品 -> 套中性微暖灰底 MERCURY_TINT=' + JSON.stringify(MERCURY_TINT) +
        '  平均 sRGB (' + stat.r.toFixed(1) + ', ' + stat.g.toFixed(1) + ', ' + stat.b.toFixed(1) +
        ') -> (' + stat2.r.toFixed(1) + ', ' + stat2.g.toFixed(1) + ', ' + stat2.b.toFixed(1) +
        ')（不添加任何可见光颜色结构）')
      seamReport.color = { before: stat, after: stat2 }
    } else {
      say('6) 色彩保真: 彩色产品按原样保留（未做二次调色）  平均 sRGB (' +
        stat.r.toFixed(1) + ', ' + stat.g.toFixed(1) + ', ' + stat.b.toFixed(1) + ')')
      seamReport.color = { before: stat, after: stat }
    }
  }

  /* ── 7) 盒式降采样 */
  const sx = W / m.w; const sy = H / m.h
  const out = Buffer.alloc(m.w * m.h * 4)
  for (let y = 0; y < m.h; y++) {
    const y0 = Math.floor(y * sy); const y1 = Math.max(y0 + 1, Math.round((y + 1) * sy))
    for (let x = 0; x < m.w; x++) {
      const x0 = Math.floor(x * sx); const x1 = Math.max(x0 + 1, Math.round((x + 1) * sx))
      let r = 0; let g = 0; let b = 0; let n = 0
      for (let yy = y0; yy < Math.min(H, y1); yy++) {
        for (let xx = x0; xx < Math.min(W, x1); xx++) {
          const i = (yy * W + xx) * 3
          r += px[i]; g += px[i + 1]; b += px[i + 2]; n++
        }
      }
      const o = (y * m.w + x) * 4
      out[o] = Math.max(0, Math.min(255, Math.round(r / n)))
      out[o + 1] = Math.max(0, Math.min(255, Math.round(g / n)))
      out[o + 2] = Math.max(0, Math.min(255, Math.round(b / n)))
      out[o + 3] = 255
    }
  }
  say('7) 盒式降采样 ' + W + 'x' + H + ' -> ' + m.w + 'x' + m.h + '（缩放 ' + sx + ':1 / ' + sy + ':1，面积平均）')

  /* ── 7b) 黑地板（编码前）
     源产品里"最暗但不为 0"的像素本来就贴着 8（水星实测最暗 max(RGB)=8），
     4:1 盒式平均会把其中少数压到 5~7。这里先把低于地板的像素抬到
     BLACK_FLOOR_TARGET（保持三通道相对差，因此不引入色彩偏移），
     剩下的过冲由第 8 步的闭环标定兜底。 */
  let floored = 0
  for (let i = 0; i < m.w * m.h; i++) {
    const o = i * 4
    const mx = Math.max(out[o], out[o + 1], out[o + 2])
    if (mx >= BLACK_FLOOR_TARGET) continue
    const add = BLACK_FLOOR_TARGET - mx
    out[o] = Math.min(255, out[o] + add)
    out[o + 1] = Math.min(255, out[o + 1] + add)
    out[o + 2] = Math.min(255, out[o + 2] + add)
    floored++
  }
  if (floored) {
    say('7b) 黑地板: 抬升 ' + floored + ' 个像素（' + (100 * floored / (m.w * m.h)).toFixed(3) +
      '%）到 max(RGB)=' + BLACK_FLOOR_TARGET)
  }
  {
    let below = 0; let mn = 255
    for (let i = 0; i < m.w * m.h; i++) {
      const o = i * 4
      const mx = Math.max(out[o], out[o + 1], out[o + 2])
      if (mx < mn) mn = mx
      if (mx < HOLE_TH) below++
    }
    say('7c) 编码前检查: 最暗 max(RGB)=' + mn + '  低于 ' + HOLE_TH + ' 的像素 ' + below)
  }

  /* ── 8) 写 JPEG + 重开校验（黑地板 / 亮度标定不达标时闭环重写）
     [为什么用"重开测量"驱动标定，而不是先验地选一个地板值] 实测 JPEG 在
     平坦暗区的振铃会把编码前最暗 20 的像素拉回重开后的 5，过冲 15 个色阶，
     远超量化步长本身（它来自 8x8 块内的振铃）。这个过冲幅度没法先验算准，
     所以这里改成闭环：先按黑色地板目标抬高"重开后仍越界"的那些像素
     （用逐像素增益，避免整幅一起变亮），重写后再测，最多 BLACK_FLOOR_PASS 轮。 */
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const gainPx = new Float64Array(m.w * m.h).fill(1)
  const gainApplied = new Float64Array(m.w * m.h).fill(1)
  let gain = 1
  let result = null
  for (let attempt = 0; attempt < BLACK_FLOOR_PASS + 2; attempt++) {
    if (attempt > 0) {
      for (let i = 0; i < m.w * m.h; i++) {
        const kk = gainPx[i] / gainApplied[i]
        if (kk === 1) continue
        const o = i * 4
        for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(out[o + c] * kk)))
        gainApplied[i] = gainPx[i]
      }
    }
    const tmpPng = path.join(TMP, m.key + '-out.png')
    fs.writeFileSync(tmpPng, encodePng(out, m.w, m.h))
    const enc = pngToJpeg(tmpPng, outPath, QUALITY)
    fs.rmSync(tmpPng, { force: true })
    const back = shoot(outPath, path.join(TMP, m.key + '-back.png'), m.w, m.h)
    result = verify(back, m)
    result.bytes = enc.bytes
    if (result.ok) break
    if (!result.dimOk) break
    let changed = false
    if (result.dark > 0) {
      const { w, h, ch, data } = back
      for (let i = 0; i < w * h; i++) {
        const j = i * ch
        const mx = Math.max(data[j], data[j + 1], data[j + 2])
        if (mx >= HOLE_TH) continue
        const src = out[i * 4] + out[i * 4 + 1] + out[i * 4 + 2]
        const want = BLACK_FLOOR_TARGET - mx
        if (want > 0 && src > 0) { gainPx[i] *= (1 + want / Math.max(1, src / 3)); changed = true }
      }
      if (changed) say('8) 重开后仍有 ' + result.dark + ' 个像素越界 -> 逐像素抬升后重写')
    }
    if (!changed && result.meanLum < LUM_MIN) {
      const g2 = Math.max(DARK_GAIN_MIN, Math.min(BRIGHT_GAIN_MAX, 0.30 / Math.max(1e-6, result.meanLum)))
      if (Math.abs(g2 - gain) >= 0.02) {
        gain = g2
        for (let i = 0; i < m.w * m.h; i++) gainPx[i] *= g2
        say('8) 重开后平均亮度 ' + result.meanLum.toFixed(3) + ' 低于下限 -> 亮度标定增益 x' +
          g2.toFixed(3) + ' 重写')
        changed = true
      }
    }
    if (!changed) break
  }
  say('8) 写 ' + m.out + ' ' + m.w + 'x' + m.h + ' q=' + QUALITY + ' ' +
    (result.bytes / 1024).toFixed(1) + ' KB  重开校验: 尺寸 ' + result.w + 'x' + result.h +
    (result.dimOk ? ' OK' : ' FAIL') + '  最暗 max(RGB)=' + result.minMax +
    '  平均亮度 ' + result.meanLum.toFixed(3) + (result.lumOk ? ' OK' : ' FAIL') +
    (gain !== 1 ? '  标定增益 x' + gain.toFixed(3) : ''))
  if (!result.ok) {
    console.error('输出校验失败: ' + m.out + '  ' + JSON.stringify(result))
    process.exit(1)
  }
  return {
    key: m.key, layer: m.layer, out: m.out, w: m.w, h: m.h,
    kb: result.bytes / 1024, filledFrac, seam: seamReport, minMax: result.minMax,
    meanLum: result.meanLum, gain,
    mean: seamReport.color ? seamReport.color.after : rgbMean(px, W, H)
  }
}

/* ---------------- 入口 ---------------- */
function main () {
  const onlyArg = process.argv.find(a => a.startsWith('--only='))
  let only = onlyArg ? onlyArg.slice('--only='.length).trim() : null
  if (only) only = only.replace(/^(planet|moon)-/, '').replace(/\.jpg$/, '')

  if (!fs.existsSync(CHROME)) {
    console.error('找不到 Chrome: ' + CHROME)
    process.exit(1)
  }
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })

  const list = only ? MAPS.filter(m => m.key === only) : MAPS
  if (!list.length) {
    console.error('未知 --only=' + only + '；可选: ' + MAPS.map(m => m.key).join(', '))
    process.exit(1)
  }

  const rows = []
  for (const m of list) rows.push(processMap(m))

  console.log('\n================ 汇总表 ================')
  console.log(['map', 'layer', 'size', 'KB', 'filled%', 'colDev before->after',
    'rowDev before->after', 'trend before->after', 'mean sRGB'].join(' | '))
  for (const r of rows) {
    const c = r.seam.col; const rw = r.seam.row; const t = r.seam.trend
    console.log([
      r.out,
      r.layer,
      r.w + 'x' + r.h,
      r.kb.toFixed(1),
      (r.filledFrac * 100).toFixed(2) + '%',
      (c.before * 100).toFixed(2) + '%->' + (c.after * 100).toFixed(2) + '%',
      (rw.before * 100).toFixed(2) + '%->' + (rw.after * 100).toFixed(2) + '%',
      t ? (t.before * 100).toFixed(2) + '%->' + (t.after * 100).toFixed(2) + '%' : 'n/a',
      '(' + r.mean.r.toFixed(1) + ', ' + r.mean.g.toFixed(1) + ', ' + r.mean.b.toFixed(1) + ')'
    ].join(' | '))
  }
  console.log('\n全部完成：' + rows.length + ' 张贴图。')
}

if (require.main === module) main()

module.exports = { processMap, MAPS, fitTrend, removeTrend, slidingMedian, medianOf }
