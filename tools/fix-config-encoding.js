'use strict'
/* ============================================================
   修复 _config.yml 的编码损坏 (tools/fix-config-encoding.js)
   ------------------------------------------------------------
   [事故是怎么发生的]
   用 PowerShell `(Get-Content -Raw) -replace ... | Set-Content -Encoding UTF8`
   改版本号。WinPS 5.1 这条管线的往返按**本地代码页(936/GBK)**解释，
   于是 UTF-8 中文被当 GBK 解码再以 UTF-8 写出 —— 一次往返即变 mojibake；
   我又用同样方式"修复"了一次，部分字节退化成 U+FFFD（不可逆）。
   **教训：本仓库任何含中文的文件，只能用 write/edit 工具或 Node 的 fs 写。**

   [第二次事故 —— 2026-09，本次]
   同一份文件再次损坏：工作区 112 个 U+FFFD / 58 行，HEAD 干净。
   这一次**没有 mojibake**，丢的全是标点与连接词（。、→ ； （） 与少量实词），
   形态是"一个字符 → U+FFFD"，其后若原本是空格则空格也变成字面 '?'。
   危害面：52 行注释 + 6 行实际内容。其中页脚那一行（footer.custom_text）
   会在**每个生成页面**上显示成一个 '�'——已随本次修复消除。
   排查手法：对 public/*.html 全量扫 U+FFFD，命中数即为可见症状数。
   **本文件的 CJK_RE 已按这次损坏扩充；若再遇到同类，先跑本脚本的只读模式看命中行数。**

   [为什么不能从 git HEAD 整份还原]
   HEAD 里没有工作区里有意的改动（display_mode: dark、translate.button: false、
   注入行的 ?v= 版本标记等）。整份还原会把用户设置一起回退。

   [本脚本策略：定向拼接，不整行替换]
   对每一行，取"中文字符串"（连续的非 ASCII 段）集合：
     · HEAD 里有、而当前行里**不存在**的那些段 → 就是被毁掉的中文，插回原位；
       mojibake 段与 U+FFFD 段从当前行里删掉。
     · 只存在于当前行的非 ASCII 段 → 保留（那是用户写的，HEAD 里没有）。
       —— 当前行剩下的 mojibake（HEAD 无对应）无法还原，如实报告，不猜。
   位置：被插回的中文按 HEAD 里的顺序，放在该行第一个非 ASCII 段原来出现的位置。
   本工具只动"含中文或 U+FFFD"的行；纯 ASCII 行（版本号、开关）一律不碰。

   用法:
     node tools/fix-config-encoding.js            # 只报告
     node tools/fix-config-encoding.js --write    # 落盘（UTF-8 无 BOM）
   ============================================================ */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const REL = 'themes/hexo-theme-butterfly/_config.yml'
const FILE = path.join(ROOT, REL)
const WRITE = process.argv.includes('--write')
const REPL = '\uFFFD'
/* [别往里加常用字]
   这里放的是 GBK 误读 UTF-8 才会产生、正常中文里几乎不出现的字。
   原本还含一个「负」—— 那是常用字，于是 "负责内容层叠放" 这种正常行
   被误判成损坏行（实测 1098 / 1134 稳定误报）。已移除：剩下这 20 个
   在 mojibake 里总是成串出现，漏掉一个不影响判定。 */
const MOJI = /[鍏鎺鐢鍚瑙鎬鏈笉鏄庢槸鍜屼濡備粠鑰岃繛锟]/

/* 逐字符级的"缺哪些中文"：把 HEAD 行里的 CJK 字符按顺序取出，
   当前行里已存在的（同样按顺序）跳过 —— 剩下的就是被毁掉、需要补回的。
   [为什么不用"连续段"比较] mojibake 会把整段中文变成**一整段**非 ASCII，
   段级比较时它既不等于 HEAD 的段、也不被当"干净中文"，于是永远匹配不上
   （实测逻辑写成段比较时 61 行全部报"无法还原"）。 */
/* [第二次事故后扩充的字符集]
   原实现只认 \u3400-\u9fff + \u3040-\u30ff（汉字与假名），漏掉了标点区段。
   2026-09 这次损坏丢的**全是标点与连接词**（。、→ ； （） 等），于是
   本脚本对同一份损坏报「58 行 / 0 行可修」—— 一律判成"无法还原"。
   补上标点与符号区段后这类损坏才进得了比较。
   注意 isCleanSeg 早就带了 \uFF00-\uFFEF 而 cjkChars 漏了 —— 两边从此共用
   一份区间常量，不要再各写各的。 */
const CJK_RE = /[\u2000-\u206f\u2190-\u21ff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

function cjkChars (s) {
  const out = []
  for (const ch of s) {
    if (CJK_RE.test(ch)) out.push(ch)
  }
  return out
}
function isCleanSeg (seg) {
  if (seg.indexOf(REPL) >= 0) return false
  if (MOJI.test(seg)) return false
  return CJK_RE.test(seg)
}

function repairLine (line, headCand) {
  const dirty = line.indexOf(REPL) >= 0 || MOJI.test(line)
  if (!dirty) return { line, changed: false }
  if (!headCand) return { line, changed: false, lost: true }

  /* [做法：以 HEAD 那一行为模板，只把**当前行里用户改过的值**搬过去]
     不能整行替换 HEAD —— HEAD 里没有用户后来改的 display_mode / translate.button
     等设置；也不能只做"缺字符拼接"，因为 YAML 的引号成对性很容易被破坏
     （实测 msgToTraditionalChinese: '繁' 被毁成 '�? 后引号不闭合，
     整个主题配置解析失败、站点生成不出来，报的是行号 400 但根因在这一行）。
     所以：HEAD 行提供**结构 + 正确中文**，当前行只贡献它自己独有的 ASCII 值。 */
  const keysOf = (s) => {
    const m = /^(\s*(?:-\s+)?)([^:#\s][^:]*):(.*)$/.exec(s)
    return m ? { indent: m[1], key: m[2], rest: m[3] } : null
  }
  const a = keysOf(headCand)
  const b = keysOf(line)
  if (a && b && a.key === b.key) {
    /* 同键：保留当前行的值（用户可能有改），值里的非 ASCII 一律换成 HEAD 的 */
    const headVals = cjkChars(headCand)
    let val = b.rest
    if (val.indexOf(REPL) >= 0 || MOJI.test(val)) {
      val = headVals.length ? (' ' + headVals.join('')) : val
    }
    const out = a.indent + b.key + ':' + val
    return { line: out, changed: out !== line }
  }
  /* 非键值行（注释、markdown/html 片段）：用 cjkChars 补回缺失的中文 */
  const want = cjkChars(headCand)
  if (!want.length) return { line, changed: false, lost: true }
  const have = cjkChars(line)
  const missing = want.filter((c) => have.indexOf(c) < 0)
  if (!missing.length) return { line, changed: false, lost: true }
  let outStr = ''
  let placed = false
  const parts = line.split(/([^\x00-\x7F]+)/)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (i % 2 === 0) { outStr += p; continue }
    if (!placed) {
      placed = true
      outStr += missing.join('')
      if (isCleanSeg(p)) outStr += p
    } else if (isCleanSeg(p)) {
      outStr += p
    }
  }
  if (!placed) outStr += ' ' + missing.join('')
  return { line: outStr, changed: outStr !== line }
}

function main () {
  const cur = fs.readFileSync(FILE, 'utf8')
  let head = ''
  try {
    head = execFileSync('git', ['-C', ROOT, 'show', 'HEAD:' + REL], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) { console.error('取不到 HEAD 版本，停止'); process.exit(1) }

  const curLines = cur.split('\n')
  const headLines = head.split('\n')
  let fixed = 0, lost = 0
  const lostLines = []
  const preview = []
  const out = curLines.map((line, i) => {
    if (line.indexOf(REPL) < 0 && !MOJI.test(line)) return line
    /* [候选行怎么找：不能靠行号]
       损坏过程中部分字符被吞，行数从 HEAD 的 1199 变成 1243，序号已经错位。
       所以按"内容可识别性"找候选：
         ① 键值行 → 用**键名**在 HEAD 里找唯一一条同键行
         ② 注释/片段行 → 用最长的 ASCII 片段（`0x` 与 `#` 之外的实词）
            在 HEAD 里找唯一一条包含它的行
       两者都要求唯一，多解就不猜（如实报告）。 */
    const keyOf = (s) => { const m = /^\s*(?:-\s+)?([^:#\s][^:]*):/.exec(s); return m ? m[1] : null }
    const longestAscii = (s) => {
      const parts = s.split(/[^\x21-\x7E]+/).filter((p) => p.length >= 7 && p.indexOf('0x') !== 0)
      parts.sort((a, b) => b.length - a.length)
      return parts[0] || null
    }
    let cand = null
    const key = keyOf(line)
    if (key) {
      const hits = headLines.filter((h) => keyOf(h) === key)
      if (hits.length === 1) cand = hits[0]
      else if (hits.length > 1) {
        /* 同键多解：再用最长 ASCII 片段收窄 */
        const tok = longestAscii(line)
        const narrow = tok ? hits.filter((h) => h.indexOf(tok) >= 0) : []
        cand = narrow.length === 1 ? narrow[0] : null
      }
    }
    if (!cand) {
      const tok = longestAscii(line)
      if (tok) {
        const hits = headLines.filter((h) => h.indexOf(tok) >= 0)
        cand = hits.length === 1 ? hits[0] : null
      }
    }
    const r = repairLine(line, cand)
    if (r.changed) {
      fixed++
      if (preview.length < 8) preview.push({ old: line, neu: r.line, cand: cand })
      return r.line
    }
    lost++; lostLines.push(i + 1)
    return line
  })

  console.log('含损坏的行: ' + (fixed + lost) + '   已修复: ' + fixed + '   仍无法还原: ' + lost)
  if (lostLines.length) console.log('  无法还原的行号: ' + lostLines.slice(0, 24).join(',') + (lostLines.length > 24 ? ' …' : ''))
  console.log('\n预览（最多 6 处）:')
  preview.forEach((p) => {
    console.log('  - ' + p.old.slice(0, 110))
    console.log('  + ' + p.neu.slice(0, 110))
  })
  if (!WRITE) { console.log('\n（未写入。加 --write 落盘）'); return }
  fs.writeFileSync(FILE, out.join('\n'), 'utf8')
  console.log('\n已写入 ' + REL + '（UTF-8 无 BOM）')
}

main()
