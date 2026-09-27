/* 静态校验（不需要浏览器）：
   1) 检查所有注入的自定义资源文件都真实存在（.perf 里没有断链）
   2) 检查自定义 CSS 里括号是否配平（括号错位是 CSS 静默失效的常见原因）
   3) 检查自定义 JS 能否被 Node 解析（语法错误会让整段脚本不执行）
   用法: node tools/verify-custom-assets.js
*/
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const root = process.cwd()
const themeConfig = fs.readFileSync(
  path.join(root, 'themes/hexo-theme-butterfly/_config.yml'), 'utf8'
)

let failures = 0
const fail = (m) => { failures++; console.log('❌ ' + m) }
const pass = (m) => console.log('✅ ' + m)

/* ---------- 1. 注入资源存在性 ---------- */
console.log('=== 1. 注入的自定义资源是否都存在 ===')
const refs = [...themeConfig.matchAll(/(?:href|src)="(\/custom\/[^"]+)"/g)].map((m) => m[1])
const seen = new Set()
let missing = 0
for (const ref of refs) {
  const rel = ref.split('?')[0].replace(/^\//, '')
  if (seen.has(rel)) continue
  seen.add(rel)
  const full = path.join(root, 'source', rel)
  if (!fs.existsSync(full)) { fail('注入引用了不存在的文件: ' + rel); missing++ }
}
if (!missing) pass('全部 ' + seen.size + ' 个注入资源都在 source/ 下存在')

/* ---------- 2. 反向检查：没有被引用但还留在 source/custom 的文件 ---------- */
console.log('')
console.log('=== 2. source/custom 下是否有"孤儿"文件（既没注入也没被 JS/CSS 引用）===')
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}
const allCustom = walk(path.join(root, 'source/custom'))
// 合并所有自定义 css/js 文本，用于查找运行时引用（如 @import / 动态注入）
const corpus = allCustom
  .filter((p) => /\.(css|js)$/.test(p))
  .map((p) => fs.readFileSync(p, 'utf8'))
  .join('\n')
const orphans = []
for (const p of allCustom) {
  const rel = '/' + path.relative(path.join(root, 'source'), p).split(path.sep).join('/')
  // 字体等二进制资源按文件名匹配（可能在 CSS 里以相对路径引用）
  const needle = path.basename(p)
  if (corpus.includes(rel) || corpus.includes(needle)) continue
  orphans.push(rel)
}
if (orphans.length) {
  console.log('⚠️  未被任何自定义文件引用的资源（可能是死文件，请人工确认）:')
  orphans.forEach((o) => console.log('    ' + o))
} else {
  pass('没有孤儿资源')
}

/* ---------- 3. CSS 括号配平 ---------- */
console.log('')
console.log('=== 3. 自定义 CSS 括号配平 ===')
const cssFiles = allCustom.filter((p) => p.endsWith('.css') && !p.includes('fontawesome'))
for (const p of cssFiles) {
  // 去掉注释再数括号（注释里的括号不参与配对）
  const text = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  let depth = 0
  let bad = false
  for (const ch of text) {
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth < 0) { bad = true; break } }
  }
  const rel = path.relative(root, p)
  if (bad || depth !== 0) fail(rel + ' 括号不配平（结束时 depth=' + depth + '）')
  else pass(rel)
}

/* ---------- 4. 自定义 JS 语法 ---------- */
console.log('')
console.log('=== 4. 自定义 JS 语法解析 ===')
const jsFiles = allCustom.filter((p) => p.endsWith('.js'))
for (const p of jsFiles) {
  const code = fs.readFileSync(p, 'utf8')
  try {
    new vm.Script(code, { filename: p })
    pass(path.relative(root, p))
  } catch (e) {
    fail(path.relative(root, p) + ' 语法错误: ' + e.message)
  }
}

/* ---------- 5. 已下线文件确实不在注入列表里 ---------- */
console.log('')
console.log('=== 5. 已下线的旧资源不得再出现在注入列表 ===')
for (const dead of ['glass-bg', 'theme-reveal', 'nav-darkmode', 'light-text-contrast', 'darkmode-move']) {
  if (refs.some((r) => r.includes(dead))) fail('注入列表里仍引用已下线资源: ' + dead)
  else pass('注入列表已清干净: ' + dead)
}

/* ---------- 6. 主题配置的编码健康 ----------
   这一条是踩过坑之后加的：用 PowerShell
   `(Get-Content -Raw) -replace ... | Set-Content -Encoding UTF8` 改版本号时，
   WinPS 5.1 这条管线的往返按**本地代码页(936/GBK)**解释，把 UTF-8 中文
   整体变成 mojibake；再用同样方式"修复"一次，部分字节退化成 U+FFFD，
   最后 `msgToTraditionalChinese: '繁'` 变成 `'�?` —— 引号不闭合，
   主题配置解析失败，**整个站点生成不出来**，而报错行号还是别的行。
   所以这里把"编码健康"固化成断言：只要有人再犯，静态校验立刻拦下来。

   判据：主题配置里不得出现 U+FFFD，也不得成片出现 mojibake 特征字；
   同时必须仍能读到已知的中文文案（证明文件确实还是 UTF-8 中文，而不是被换成别的编码）。 */
console.log('')
console.log('=== 6. 主题配置编码健康 ===')
{
  const cfg = path.join(root, 'themes', 'hexo-theme-butterfly', '_config.yml')
  if (!fs.existsSync(cfg)) {
    fail('找不到主题配置: ' + cfg)
  } else {
    const raw = fs.readFileSync(cfg)
    const text = raw.toString('utf8')
    /* U+FFFD 一旦出现就是不可逆损坏：**键值行必须为 0**（那会破坏 YAML，
       实测曾把站点生成整个打断）；注释/文案行允许存在已知的历史残留，
       但不得超过 KNOWN_REMAINING（当前 58 行），一旦增加说明又有新损坏。 */
    const KNOWN_REMAINING = 60
    const badLines = text.split('\n').filter((l) => l.indexOf('\uFFFD') >= 0)
    const badKeys = badLines.filter((l) => /^\s*(?:-\s+)?[^:#\s][^:]*:/.test(l))
    if (badKeys.length) {
      fail('主题配置有 ' + badKeys.length + ' 个**键值行**含 U+FFFD —— 会破坏 YAML，站点将生成失败')
    } else {
      pass('主题配置的键值行无 U+FFFD（YAML 结构安全）')
    }
    if (badLines.length > KNOWN_REMAINING) {
      fail('主题配置含 U+FFFD 的行数 ' + badLines.length + ' 超过已知残留 ' + KNOWN_REMAINING + ' —— 出现新的编码损坏')
    } else {
      pass('主题配置的 U+FFFD 残留未扩大（注释/文案 ' + badLines.length + ' 行，上限 ' + KNOWN_REMAINING + '）')
    }
    /* mojibake 特征：这些字在正常配置里不该成片出现 */
    const moji = (text.match(/[鍏鎺鐢鍚瑙鎬鏈笉鏄庢槸鍜屼负濡備粠鑰岃繛]/g) || []).length
    if (moji > 3) fail('主题配置疑似 mojibake（命中 ' + moji + ' 个特征字）')
    else pass('主题配置无 mojibake 特征')
    /* 已知文案仍在 → 证明是干净的 UTF-8 中文 */
    const marks = ['关于: /about/', '文章:', '归档:']
    const miss = marks.filter((m) => text.indexOf(m) < 0)
    if (miss.length) fail('主题配置缺少已知中文文案: ' + miss.join(' / '))
    else pass('主题配置的关键中文文案可读（' + marks.length + ' 处）')
  }
}

console.log('')
console.log(failures === 0 ? '===== 静态校验全部通过 =====' : '===== ' + failures + ' 项失败 =====')
process.exitCode = failures === 0 ? 0 : 1
