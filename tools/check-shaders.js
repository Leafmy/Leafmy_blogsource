'use strict'
/* 着色器静态自检：把 space-globe.js 里所有 *_VERT / *_FRAG 字符串数组取出来，
   逐个检查"声明与使用是否匹配"。着色的编译错误只报行号不报名字，
   隔着字符串拼接几乎没法定位 —— 所以在这里静态查出来，比上浏览器快得多。

   检查项：
     1) 用到 uTonemapHere 但没声明 → 必然编译失败（undeclared identifier）
     2) 声明了但没用到 → 无害，仅提示
     3) 用到 outColor 但没把 TONEMAP 拼进来 → undeclared function */
const fs = require('fs')
const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'source', 'custom', 'effects', 'space-globe.js'), 'utf8')

/* 捕获组只取数组字面量 `[...]`，`].join(...)` 的部分不在组内 ——
   `[\s\S]*?\]` 是懒惰匹配，会停在第一个 `]` 上，正是数组结尾。
   （第一版把 `].join('\n')` 也写进了组，求值出来就成了字符串，
   再调用 .join 直接报 "join is not a function"。） */
const re = /var ([A-Z][A-Z0-9_]*_(?:VERT|FRAG)) = (\[[\s\S]*?\])(?=\.join\('\\n'\))/g
const tonemapMatch = /var TONEMAP = (\[[\s\S]*?\])(?=\.join\('\\n'\))/.exec(src)
if (!tonemapMatch) { console.error('找不到 TONEMAP 块'); process.exit(1) }
const TONEMAP = (new Function('return ' + tonemapMatch[1]))().join('\n')

let m
let n = 0
let bad = 0
while ((m = re.exec(src))) {
  const name = m[1]
  const literal = m[2]
  let text
  try {
    text = (new Function('TONEMAP', 'return ' + literal))(TONEMAP).join('\n')
  } catch (e) {
    console.log('  ??  ' + name + ' 无法求值: ' + e.message)
    continue
  }
  n++
  const usesTonemapUniform = /uTonemapHere/.test(text)
  const declares = /uniform float uTonemapHere;/.test(text)
  /* 只认**调用**，不认定义：共享的 TONEMAP 块里写了 outColor 的定义，
     任何拼进这个块的着色器（例如只借 blackbody() 的星点顶点着色器）
     都会"包含 outColor"，但它并不调用。第一版按文本判断，
     于是星点顶点着色器被误报成有致命问题。 */
  const usesOutColor = /outColor\(/.test(text.replace(/vec3 outColor\(vec3 c\)[^\n]*\n/, ''))
  const hasTonemapFn = /vec3 tonemap\(vec3 c\)/.test(text)
  const problems = []
  if (usesTonemapUniform && !declares) problems.push('用了 uTonemapHere 但没声明')
  if (usesOutColor && !hasTonemapFn) problems.push('用了 outColor 但没有 TONEMAP 代码块')
  if (declares && !usesTonemapUniform) problems.push('声明了 uTonemapHere 却没用（无害）')
  if (problems.length) {
    if (problems.some((p) => !/无害/.test(p))) bad++
    console.log((bad ? '  ❌ ' : '  ·  ') + name + ': ' + problems.join('；'))
  } else {
    console.log('  ✅ ' + name + (hasTonemapFn ? '（走 outColor/色调映射）' : ''))
  }
}
console.log('\n共 ' + n + ' 个着色器，' + bad + ' 个有致命问题')
process.exit(bad ? 1 : 0)
