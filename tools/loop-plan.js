'use strict'
/* ============================================================
   循环方案评估 (tools/loop-plan.js)
   ------------------------------------------------------------
   回答一个问题：**能不能把首页做成一段预渲染的无缝循环视频？**

   背景：有一条"替代 Unity"的候选路线是"离线渲染 + 页面播视频"——
   画质上限最高、运行时几乎零成本、静态站不需要构建链，代价是失去实时性。
   但它成立的前提是"能循环"，而循环能不能成立只能算，不能感觉。

   本工具把三条硬约束算出来：
     1) 各天体的周期（数值全部来自 space-system.js 的真实数据）；
     2) "画面多久后与自身精确重合" —— 需要所有周期同时回到整数圈。
        Callisto 一个周期就是 16.7 天，所以精确重合的门槛是数小时级，
        实用上不存在；
     3) **差速自转让精确循环在原理上不可能**：着色器里云带角速度按纬度在
        0.945~1.0 之间变化（赤道比高纬快 5.5%），所以即使 uSpin 回到
        整数圈，云带纹理也不会回到原状。
     ⇒ 结论：只能做"一段 10~30 秒 + 接缝交叉淡化"的近似循环。

   最后给出体积估算，便于与当前实时方案（图片 1.9 MB + 渲染 JS 108 KB）比较。

   用法: node tools/loop-plan.js
   ============================================================ */
const ss = require('../source/custom/effects/space-system.js')

const scene = ss.build({ globePx: ss.SIZE_REF_GLOBE_PX })
console.log('参考取景：木星圆面 ' + ss.SIZE_REF_GLOBE_PX + 'px，TIME_SCALE=' + scene.timeScale)
console.log('模拟时间每秒 = ' + scene.timeScale + ' 秒真实时间\n')

const jup = scene.jupiter
const jupSpinSec = jup.rotationHours * 3600
console.log('木星自转周期（模拟秒）: ' + jupSpinSec.toFixed(0) + '  → 墙上时间 ' +
  (jupSpinSec / scene.timeScale).toFixed(2) + ' s')

console.log('\n伽利略四卫（模拟秒 / 墙上秒）：')
for (const m of scene.moons) {
  const sec = m.periodDays * 86400
  console.log('  ' + m.name.padEnd(9) + sec.toFixed(0).padStart(10) + '  ' +
    (sec / scene.timeScale).toFixed(2).padStart(7) + ' s')
}

/* 最长周期就是"所有月亮都到位"所需时间（它们都是圆形共面轨道，相角单调） */
const periods = scene.moons.map((m) => m.periodDays * 86400).concat([jupSpinSec])
const maxP = Math.max(...periods)
console.log('\n最长周期 ' + maxP.toFixed(0) + ' 模拟秒 = ' + (maxP / scene.timeScale).toFixed(1) + ' 墙上秒')

/* 检查：最长周期是不是每个周期的 1/1 精度倍数（模运算下是否重合） */
console.log('\n各周期整除性（余数越小越接近无缝）：')
for (const m of scene.moons) {
  const p = m.periodDays * 86400
  const n = Math.round(maxP / p)
  console.log('  ' + m.name.padEnd(9) + ' n=' + String(n).padStart(3) +
    '  余数 ' + (maxP - n * p).toFixed(1) + ' 模拟秒')
}
const nJ = Math.round(maxP / jupSpinSec)
console.log('  木星自转  n=' + String(nJ).padStart(3) + '  余数 ' + (maxP - nJ * jupSpinSec).toFixed(1) + ' 模拟秒')

/* 差分自转：着色器里 uSpin 是全局自转，但云层内部按纬度有 5.5% 的速率差，
   所以即使 uSpin 回到整数圈，云带纹理也不会精确回到原状。 */
console.log('\n注意：着色器的差速自转（赤道比高纬快 5.5%）意味着 uSpin 回到整数圈时，' +
  '\n云带纹理仍不完全重合 —— 精确循环在物理上不存在，只能用交叉淡化收缝。')

/* 估算体积：给定帧数与分辨率 */
console.log('\n=== 体积估算（H.264 CRF20 / VP9 大致等效）===')
const variants = [
  { w: 1920, h: 1080, fps: 30 },
  { w: 1280, h: 720, fps: 30 },
  { w: 960, h: 540, fps: 24 }
]
const durations = [10, 30, maxP / scene.timeScale]
for (const v of variants) {
  for (const d of durations) {
    const frames = Math.round(v.fps * d)
    /* 经验值：深空 + 缓慢自转属于极低码率内容，约 0.03~0.06 bit/像素/帧 */
    const bitrate = v.w * v.h * v.fps * 0.04
    const mb = (bitrate * d) / 8 / 1024 / 1024
    console.log('  ' + (v.w + 'x' + v.h).padEnd(10) + ' ' + v.fps + 'fps  ' +
      d.toFixed(1).padStart(6) + 's  ' + String(frames).padStart(5) + ' 帧  约 ' +
      mb.toFixed(1).padStart(6) + ' MB')
  }
}
console.log('\n对照：当前实时方案的图片资源合计约 1.9 MB，JS 约 110 KB。')
