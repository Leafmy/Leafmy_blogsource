'use strict'
/* ============================================================
   循环小样导出（逐帧截图 + ffmpeg）(tools/export-loop.js)
   ------------------------------------------------------------
   产出首页场景的一段**带交叉淡化的循环视频**。

   === 为什么是"逐帧截图 + ffmpeg"，而不是页面内录制 ===
   下面这些路在本机（Windows 无头 Chrome）**全部读不到 WebGL 画面**，
   而且都不报错、只给黑图或零字节：
     · canvas.toDataURL()                      → 纯黑
     · gl.readPixels(默认帧缓冲)                → 全 0
     · gl.readPixels(HDR / MSAA 离屏缓冲)       → 全 0
     · drawImage(webglCanvas) → 2D 画布         → 纯黑
     · preserveDrawingBuffer=true 亦然
     · MediaRecorder + captureStream(0)        → 0 帧（文件仅 110 字节 EBML 头）
   唯一验证可用的通道是：**页面侧定影 + chrome 自己的 --screenshot**
   （合成器的输出，不是 GL 的 back buffer）。所以帧就从这条通道取。

   代价：每帧要起一次 Chrome（约 1~2 秒），所以帧率不取 30 而取 12 ——
   本场景的运动很慢（木星自转一个周期是墙上 298 秒），12fps 足够顺滑。

   循环收缝：在 ffmpeg 里用 xfade 把尾部与开头混合，
   因为 tools/loop-plan.js 已证明精确循环在原理上不存在
   （Callisto 周期 16.7 天；差速自转让云带纹理回不到原状）。

   前置：node tools/serve-public.js
   用法:
     node tools/export-loop.js                      # 8s/12fps/720p
     node tools/export-loop.js --seconds=6 --fps=12 --w=1280 --h=720
     node tools/export-loop.js --keep-frames         # 保留 PNG 序列
   输出：.perf/shots/loop-<参数>.mp4
   ============================================================ */

const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const ROOT = path.join(__dirname, '..')
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT_DIR = path.join(ROOT, '.perf', 'shots')
const FRAME_DIR = path.join(ROOT, '.perf', 'loop-frames')

function arg (name, def) {
  const hit = process.argv.find((a) => a.startsWith('--' + name + '='))
  return hit ? hit.slice(name.length + 3) : def
}
const SECONDS = Number(arg('seconds', 8))
const FPS = Number(arg('fps', 12))
const W = Number(arg('w', 1280))
const H = Number(arg('h', 720))
const XFADE = Number(arg('xfade', '0.6'))
const START = Number(arg('start', '0'))
const PORT = arg('port', '8099')
const KEEP = process.argv.includes('--keep-frames')
const VERBOSE = process.argv.includes('--verbose')

function findFfmpeg () {
  const explicit = arg('ffmpeg', null)
  if (explicit && fs.existsSync(explicit)) return explicit
  for (const p of [path.join(ROOT, '.perf', 'tools', 'ffmpeg.exe'),
    path.join(ROOT, '.perf', 'tools', 'ffx', 'ffmpeg.exe')]) {
    if (fs.existsSync(p)) return p
  }
  const g = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' })
  return g.status === 0 ? 'ffmpeg' : null
}
function findFfprobe (ffmpeg) {
  if (ffmpeg === 'ffmpeg') return 'ffprobe'
  const p = path.join(path.dirname(ffmpeg), 'ffprobe.exe')
  return fs.existsSync(p) ? p : null
}

/* 判定一张截图是否"真的画出来了"：亮像素占比 + 峰值亮度。
   只看文件大小会放过"UI 在、画布空"的半黑帧（实测出现过 194 KB 的黑图）。 */
function frameQuality (pngPath) {
  try {
    const { decodeImage } = require('./planet-resize.js')
    const img = decodeImage(pngPath)
    let lit = 0, n = 0, mx = 0
    for (let y = 0; y < img.h; y += 4) {
      for (let x = 0; x < img.w; x += 4) {
        const o = (y * img.w + x) * img.ch
        const l = (img.data[o] + img.data[o + 1] + img.data[o + 2]) / 3
        if (l > 30) lit++
        if (l > mx) mx = l
        n++
      }
    }
    return { frac: lit / Math.max(1, n), peak: mx, ok: lit / Math.max(1, n) > 0.06 && mx > 150 }
  } catch (e) { return { frac: 0, peak: 0, ok: false } }
}

function shoot (simT, outPng) {
  const profile = path.join(os.tmpdir(), 'dsh-loop-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  const url = 'http://127.0.0.1:' + PORT + '/index.html?freeze=' + simT
  spawnSync(CHROME, [
    '--headless=new', '--no-sandbox', '--hide-scrollbars', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling',
    '--user-data-dir=' + profile,
    '--force-device-scale-factor=1',
    '--window-size=' + W + ',' + H,
    '--virtual-time-budget=20000',
    '--screenshot=' + outPng,
    url
  ], { stdio: VERBOSE ? 'inherit' : 'ignore', timeout: 120000 })
  fs.rmSync(profile, { recursive: true, force: true })
  return fs.existsSync(outPng)
}

function main () {
  const ffmpeg = findFfmpeg()
  if (!ffmpeg) {
    console.error('找不到 ffmpeg。任选一条：')
    console.error('  1) 把 ffmpeg.exe 放到 .perf/tools/ffmpeg.exe')
    console.error('  2) --ffmpeg=<完整路径>')
    console.error('  3) 装到 PATH')
    process.exit(1)
  }
  const ffprobe = findFfprobe(ffmpeg)
  const ver = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' })
  console.log('编码器 ' + ffmpeg + '  ' + String(ver.stdout || '').split('\n')[0].slice(0, 60))
  if (!fs.existsSync(CHROME)) { console.error('找不到 Chrome: ' + CHROME); process.exit(1) }

  const total = Math.round(SECONDS * FPS)
  /* 每帧推进的模拟秒：模拟时间 = 墙上时间 × TIME_SCALE。
     取 120（与 space-system.js 的 TIME_SCALE 一致）；这里只用于换算，
     真实值由页面按 URL 里的 freeze 参数定影。 */
  const TIME_SCALE = 120
  const dtSim = (SECONDS * TIME_SCALE) / total

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.rmSync(FRAME_DIR, { recursive: true, force: true })
  fs.mkdirSync(FRAME_DIR, { recursive: true })

  console.log('参数   ' + SECONDS + 's / ' + FPS + 'fps / ' + W + 'x' + H +
    ' ⇒ ' + total + ' 帧；起始模拟时刻 ' + START + 's，每帧 +' + dtSim.toFixed(1) + ' 模拟秒')
  console.log('取帧   逐帧 chrome --screenshot（唯一可用的通道，约 1~2s/帧）')

  const sw = Date.now()
  let bad = 0
  for (let i = 0; i < total; i++) {
    const out = path.join(FRAME_DIR, 'f' + String(i).padStart(5, '0') + '.png')
    let q = { ok: false, frac: 0, peak: 0 }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!shoot(START + i * dtSim, out)) continue
      q = frameQuality(out)
      if (q.ok) break
    }
    if (!q.ok) bad++
    const pct = ((i + 1) / total * 100).toFixed(0)
    process.stdout.write('  帧 ' + (i + 1) + '/' + total + ' (' + pct + '%)  亮像素 ' +
      (q.frac * 100).toFixed(1) + '%  峰值 ' + q.peak + (q.ok ? '' : ' ← 可疑') + '   \r')
  }
  console.log('\n取帧完成 ' + total + ' 帧，用时 ' + ((Date.now() - sw) / 1000).toFixed(0) + 's' +
    (bad ? '（其中 ' + bad + ' 帧可疑）' : ''))
  if (bad > total * 0.2) {
    console.error('超过 20% 的帧可疑，停止编码（先解决取帧）。')
    process.exit(1)
  }

  /* ffmpeg：先编正片，再用 xfade 把尾部与开头混合成一圈。
     offset = T−X 表示过渡从"最后 X 秒"开始 ⇒ 正片结束时画面等于第 0 帧，
     循环回开头时接缝不可见。 */
  const outPath = path.join(OUT_DIR, 'loop-' + SECONDS + 's-' + FPS + 'fps-' + W + 'x' + H + '.mp4')
  const seq = path.join(FRAME_DIR, 'f%05d.png')
  const useXfade = XFADE > 0 && SECONDS > XFADE * 2
  const vf = useXfade
    ? '[0:v]split=2[a][b];[b]trim=0:' + XFADE + ',setpts=PTS-STARTPTS[head];' +
      '[a][head]xfade=transition=fade:duration=' + XFADE +
      ':offset=' + (SECONDS - XFADE).toFixed(3) + '[v]'
    : '[0:v]null[v]'
  console.log('编码   ffmpeg xfade=' + (useXfade ? XFADE + 's（尾部接回开头）' : '无') + ' crf=20')
  const enc = spawnSync(ffmpeg, [
    '-y', '-framerate', String(FPS), '-i', seq,
    '-filter_complex', vf, '-map', '[v]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium',
    '-movflags', '+faststart', outPath
  ], { encoding: 'utf8', timeout: 600000 })
  if (enc.status !== 0) {
    console.error('ffmpeg 失败：\n' + String(enc.stderr || '').split('\n').slice(-10).join('\n'))
    process.exit(1)
  }
  const mb = fs.statSync(outPath).size / 1024 / 1024
  console.log('写入   ' + path.relative(ROOT, outPath) + '  (' + mb.toFixed(2) + ' MB)')

  /* 复核：用 ffprobe 读回时长/帧数，确认编码结果与预期一致
     （"写出文件"不等于"写对了"）。 */
  if (ffprobe) {
    const pr = spawnSync(ffprobe, ['-v', 'error', '-show_entries',
      'format=duration', '-show_entries', 'stream=nb_frames,width,height',
      '-of', 'default=noprint_wrappers=1', outPath], { encoding: 'utf8' })
    const txt = String(pr.stdout || '').trim().replace(/\n/g, '  ')
    console.log('复核   ' + txt)
    const dur = parseFloat((/duration=([\d.]+)/.exec(txt) || [])[1])
    const frames = parseInt((/nb_frames=(\d+)/.exec(txt) || [])[1], 10)
    const okDur = Math.abs(dur - SECONDS) < 0.2
    const okFrames = frames === total
    console.log('       ' + (okDur && okFrames
      ? '时长与帧数符合预期 ✅'
      : '⚠️ 预期 ' + SECONDS + 's / ' + total + ' 帧，实际 ' + dur + 's / ' + frames + ' 帧'))
  }
  console.log('\n对照：实时方案 = 图片 1.9 MB + 渲染 JS 108 KB，可互动、任意时刻；')
  console.log('      本视频 = ' + mb.toFixed(1) + ' MB，' + SECONDS + 's 后回到开头（xfade 收缝）。')
  console.log('      循环周期与体积的完整评估见 tools/loop-plan.js。')
  if (!KEEP) fs.rmSync(FRAME_DIR, { recursive: true, force: true })
  else console.log('帧序列保留在 ' + path.relative(ROOT, FRAME_DIR))
}

if (require.main === module) main()
