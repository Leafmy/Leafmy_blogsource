'use strict'
/* ============================================================
   改注入行的资源版本号 (tools/bump-asset-version.js)
   ------------------------------------------------------------
   为什么单独做成脚本、而不是用 PowerShell 改：
   `(Get-Content -Raw) -replace ... | Set-Content -Encoding UTF8` 在 WinPS 5.1 下
   会把整个文件按本地代码页(GBK)往返，把同文件里的中文注释变成 mojibake
   （本项目因此损坏过一次主题配置，导致整站生成失败）。所以涉及这个文件的
   任何写入都走 Node 的 fs。

   本脚本只改**纯 ASCII 的注入行**：按"路径前缀 + ?v="定位，替换版本号，
   行内其它内容与整个文件的其它行一律不动。

   [为什么还要扫 layout.pug]
   /custom/theme/title-paths.js 与 split-title.js 的注入行后来从本配置挪到了
   layout/includes/layout.pug（它们必须紧跟 hero 执行，见那里的注释）。
   只扫 _config.yml 的话，这两个资源的版本号会永远"命中 0 处"、悄悄不更新 ——
   浏览器继续吃旧脚本（实际踩到）。所以两处都扫。

   用法:
     node tools/bump-asset-version.js <资源路径> <新版本>     # 只报告
     node tools/bump-asset-version.js --write ...            # 落盘
   ============================================================ */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
/* 按顺序扫：自定义资源的注入行可能出现在任一文件里 */
const TARGETS = [
  'themes/hexo-theme-butterfly/_config.yml',
  'themes/hexo-theme-butterfly/layout/includes/layout.pug'
].map((p) => path.join(ROOT, p))
const argv = process.argv.slice(2)
const WRITE = argv.includes('--write')
const args = argv.filter((a) => a !== '--write')

if (args.length !== 2) {
  console.error('用法: node tools/bump-asset-version.js [--write] <资源路径> <新版本>')
  process.exit(1)
}
const [asset, ver] = args

/* 只匹配 `href="/custom/..."` / `src="/custom/..."` / `src='/custom/...'`
   （pug 里是单引号）后面紧跟的 ?v=版本，旧版本限定为字母数字，避免误伤别处。
   [为什么 href/src 都要匹配] 最初只写了 href，于是**脚本类**的注入行
   （用的是 src=）永远命中 0 处、版本号悄悄不更新 —— 实测踩到，
   浏览器会一直吃旧缓存。 */
const esc = asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const re = new RegExp('((?:href|src)=["\']' + esc + '\\?v=)([0-9a-zA-Z]+)(["\'])', 'g')
let n = 0
const before = []
for (const file of TARGETS) {
  const src = fs.readFileSync(file, 'utf8')
  let fileHits = 0
  const out = src.replace(re, (all, p1, oldV, p3) => {
    n++
    fileHits++
    before.push(path.basename(file) + ': ' + oldV + ' → ' + ver)
    return p1 + ver + p3
  })
  console.log('资源 ' + asset + '  ←  ' + path.relative(ROOT, file) + '  命中 ' + fileHits + ' 处')
  if (fileHits && WRITE && out !== src) {
    fs.writeFileSync(file, out, 'utf8')
    console.log('  已写入 ' + path.relative(ROOT, file))
  }
}
console.log('合计 ' + n + ' 处' + (n ? '：' + before.join('，') : '（未命中，检查路径与文件）'))
if (!WRITE) console.log('（未写入，加 --write 落盘）')

/* 复核：写入后所有目标文件里该资源都应只剩新版本 */
if (WRITE && n) {
  const checkRe = new RegExp('(?:href|src)=["\']' + esc + '\\?v=([0-9a-zA-Z]+)["\']', 'g')
  let bad = 0
  for (const file of TARGETS) {
    const back = fs.readFileSync(file, 'utf8')
    let m
    while ((m = checkRe.exec(back))) {
      if (m[1] !== ver) { bad++; console.log('  ✗ ' + path.relative(ROOT, file) + ' 仍是 ' + m[1]) }
    }
  }
  console.log('  复核: ' + (bad ? '有 ' + bad + ' 处未更新' : '目标文件里只剩 ' + ver + '  ✓'))
}
