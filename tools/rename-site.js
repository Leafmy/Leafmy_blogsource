'use strict'
/* ============================================================
   改站名：受命于天，既寿永昌 → 启明 (tools/rename-site.js)
   ------------------------------------------------------------
   [为什么用一个 Node 脚本，而不是逐个用 edit 工具]
   涉及的两处文件里有中文字串，其中 themes/hexo-theme-butterfly/_config.yml
   第 312 行还带着上一轮编码事故留下的 U+FFFD。**绝不能用 PowerShell 写**
   （`Set-Content -Encoding UTF8` 会按 GBK 往返，二次损坏，本项目已踩过一次，
   代价是主题配置解析失败、整站生成不出来）。
   Node 的 fs 写 UTF-8 在本仓库已实测回环正确，所以统一走这里。

   策略：精确替换「受命于天，既寿永昌」这 9 个字，其余一律不动 ——
   不做行级替换，避免碰坏同行的其它内容（尤其是含 U+FFFD 的那行）。

   用法:
     node tools/rename-site.js           # 只报告
     node tools/rename-site.js --write   # 落盘
   ============================================================ */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const OLD = '受命于天，既寿永昌'
const NEW = '启明'
const WRITE = process.argv.includes('--write')

const FILES = [
  '_config.yml',
  'source/about/index.md',
  'source/_data/announcement.yml',
  'source/_data/site_text.yml',
  'themes/hexo-theme-butterfly/_config.yml'
]

let total = 0
for (const rel of FILES) {
  const p = path.join(ROOT, rel)
  if (!fs.existsSync(p)) { console.log('缺文件 ' + rel); continue }
  const src = fs.readFileSync(p, 'utf8')
  const n = src.split(OLD).length - 1
  if (!n) { console.log('  —  ' + rel + '：无旧站名'); continue }
  const out = src.split(OLD).join(NEW)
  console.log('  ✓  ' + rel + '：替换 ' + n + ' 处')
  if (WRITE) fs.writeFileSync(p, out, 'utf8')
  total += n
}
console.log('\n共 ' + total + ' 处' + (WRITE ? '，已写入' : '（未写入，加 --write 落盘）'))

/* 复核：写入后旧名不得再出现 */
if (WRITE) {
  let left = 0
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    left += src.split(OLD).length - 1
  }
  console.log('复核：全站剩余旧名 ' + left + ' 处' + (left === 0 ? '  ✓' : '  ✗'))
}
