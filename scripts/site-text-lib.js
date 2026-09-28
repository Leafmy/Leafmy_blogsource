/* ============================================================
   站点文字覆盖层 —— 纯函数库（无副作用）
   ------------------------------------------------------------
   谁在用：
     scripts/site-text.js        —— 插件：before_generate 应用覆盖 + st() helper + 注入浏览器
     scripts/admin-generator.js  —— 管理页元数据（清单 + 当前值 + 默认值 + 样式规则）
     scripts/articles-generator.js —— 取单个键的生效值

   数据文件 source/_data/site_text.yml 两段：
     texts:   键 → 值（只存"被改过"的文字）
     styles:  字形/位置规则列表（由管理页「可视化」标签页生成）
              - sel: CSS 选择器（作用目标）
                note: 人看的名字
                css: "font-size: 18px; letter-spacing: .06em"
                important: true   # 可选：整条声明都加 !important（默认只有 font-family 加）
   ============================================================ */
'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const catalog = require('./site-text-catalog')

const FILE = catalog.file

const HEADER = [
  '# ============================================================',
  '# 站点文字（由管理页 /admin/ 的「文字」「可视化」标签页读写）',
  '# ------------------------------------------------------------',
  '# texts:  这里只放「被改过」的文字：没出现的键就用站点/主题配置或主题语言文件里的原值。',
  '#         想恢复某一条为默认：在管理页点该项的「恢复默认」再保存（键会从本文件消失）。',
  '#         值统一写成双引号字符串（换行用 \\n 转义），方便机器读写、也方便 git diff。',
  '# styles: 字形/位置规则（可视化页写的）：sel = 作用目标(选择器)，css = 声明串。',
  '#         构建时注入 <style id="site-text-style">，只有 font-family 强制 !important。',
  '# 键名清单见 scripts/site-text-catalog.js；手改本文件也可以，格式照下面来。',
  '# ============================================================'
]

/* ============================================================
   样式规则：允许的 CSS 属性（白名单）
   ------------------------------------------------------------
   站点文字是"内容"，样式是"装修"。这里挡的不是安全（同源静态站没有攻击面），
   而是"手滑写坏整页"：只让与字形/位置有关的属性进来，
   并且把 url()/expression/@/花括号/尖括号 一律清掉，
   保证注进 <style> 的东西不可能提前闭合标签或引入外部资源。
   ============================================================ */
const STYLE_PROPS = [
  /* 字形 */
  'font-family', 'font-size', 'font-weight', 'font-style', 'letter-spacing',
  'line-height', 'word-spacing', 'text-align', 'text-shadow', 'text-transform',
  'color', 'opacity', 'white-space', 'word-break', 'text-decoration',
  /* 位置 / 盒子 */
  'position', 'left', 'top', 'right', 'bottom', 'z-index',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'display', 'vertical-align', 'box-sizing', 'transform', 'transform-origin',
  /* 装饰（少数场景用得上） */
  'background-color', 'border-radius', 'filter', 'text-indent'
]
const STYLE_PROP_SET = new Set(STYLE_PROPS)

function cleanValue (v) {
  return String(v == null ? '' : v)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')          // 注释
    .replace(/[\u0000-\u001f]/g, ' ')            // 控制字符（含换行）
    .replace(/[{}<>]/g, ' ')                     // 能提前闭合 <style> 的字符
    .replace(/@/g, ' ')                          // @import / @media 之类
    .replace(/\burl\s*\(/gi, ' ')                // 外部资源
    .replace(/\bexpression\s*\(/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* 选择器：允许 > + ~ . # [] : 空格（可视化页生成的就是 "#a > .b:nth-child(2)" 这种），
   禁掉能提前闭合 <style> 或另起规则的字符。< */
function sanitizeSel (sel) {
  const s = String(sel == null ? '' : sel).replace(/\s+/g, ' ').trim()
  if (!s || s.length > 300) return ''
  if (/[{}<@;\\]/.test(s)) return ''
  return s
}

/* 声明串 → [{prop, value, important}]（不在白名单的属性直接丢掉） */
function parseCss (css) {
  const out = []
  String(css == null ? '' : css).split(';').forEach(part => {
    const m = /^\s*([a-zA-Z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part)
    if (!m) return
    const prop = m[1].toLowerCase()
    if (!STYLE_PROP_SET.has(prop)) return
    let imp = false
    let value = m[2].replace(/!\s*important\s*$/i, function () { imp = true; return '' })
    value = cleanValue(value)
    if (!value) return
    out.push({ prop: prop, value: value, important: imp })
  })
  return out
}

/* 拼回声明串；forceImportant = 整条规则都加 !important。
   font-family 永远加 !important —— /custom/theme/custom-font.css 用 !important
   把全站字体钉成 PingFangMedium，不加这一条，用户在可视化页换字体看不到变化。 */
function joinCss (decls, forceImportant) {
  return decls.map(function (d) {
    const imp = forceImportant || d.important || d.prop === 'font-family'
    return d.prop + ': ' + d.value + (imp ? ' !important' : '')
  }).join('; ')
}

/* 落盘用的声明串：一律不带 !important（谁加由注入层按 decls 上的标记决定，
   这样手写的 "font-size: 12px !important; color: red" 不会被摊平成"整条都强制"） */
function plainCss (decls) {
  return (decls || []).map(function (d) { return d.prop + ': ' + d.value }).join('; ')
}

/* 读进来的原始 styles 段 → 规范化后的规则数组 */
function normalizeStyles (raw) {
  const out = []
  ;(Array.isArray(raw) ? raw : []).forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return
    const sel = sanitizeSel(entry.sel)
    if (!sel) return
    const decls = parseCss(entry.css)
    if (!decls.length) return
    out.push({
      sel: sel,
      note: String(entry.note == null ? '' : entry.note).slice(0, 80),
      css: plainCss(decls),
      important: entry.important === true,
      decls: decls
    })
  })
  return out
}

/* ============================================================
   点号路径读写
   ============================================================ */
function getPath (obj, dotted) {
  if (!obj) return undefined
  const parts = String(dotted).split('.')
  let cur = obj
  for (let i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[parts[i]]
  }
  return cur
}

function setPath (obj, dotted, value) {
  const parts = String(dotted).split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  cur[parts[parts.length - 1]] = value
}

// 数值字段（如 footer.owner.since = 2025）保持数值类型，别变成字符串
function coerce (oldValue, value) {
  if (typeof oldValue === 'number' && value !== '' && !isNaN(Number(value))) return Number(value)
  return value
}

/* ============================================================
   读 site_text.yml
   ============================================================ */
function readOverrides (baseDir) {
  const file = path.join(baseDir, FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { values: {}, styles: [], exists: false, error: null }
  }
  try {
    const doc = yaml.load(raw) || {}
    const texts = (doc && doc.texts) || {}
    const values = {}
    Object.keys(texts).forEach(key => {
      const v = texts[key]
      if (v === null || v === undefined) return
      const s = String(v)
      if (s === '') return // 空 = 用默认值
      values[key] = s
    })
    return { values, styles: normalizeStyles(doc && doc.styles), exists: true, error: null }
  } catch (e) {
    return { values: {}, styles: [], exists: true, error: (e && e.message) || String(e) }
  }
}

function dumpOverrides (state) {
  const values = (state && state.overrides) || {}
  const styles = (state && state.styles) || []
  const lines = HEADER.slice()
  const ordered = []
  catalog.groups.forEach(g => g.items.forEach(it => { ordered.push(it.key) }))
  const extra = Object.keys(values).filter(k => ordered.indexOf(k) === -1).sort()
  const all = ordered.concat(extra).filter(k => values[k] !== undefined)
  if (!all.length) {
    lines.push('texts: {}')
  } else {
    lines.push('texts:')
    all.forEach(k => {
      lines.push('  ' + k + ': ' + JSON.stringify(values[k]))
    })
  }
  if (!styles.length) {
    lines.push('styles: []')
  } else {
    lines.push('styles:')
    styles.forEach(r => {
      lines.push('  - sel: ' + JSON.stringify(r.sel))
      lines.push('    note: ' + JSON.stringify(r.note || ''))
      lines.push('    css: ' + JSON.stringify(r.css || ''))
      if (r.important) lines.push('    important: true')
    })
  }
  return lines.join('\n') + '\n'
}

/* ============================================================
   读某个条目"没被覆盖时"的原值
   ============================================================ */
function str (v) { return (v === null || v === undefined) ? '' : String(v) }

function readSource (hexo, item) {
  const target = item.source ? item.source.target : item.target
  const p = item.source ? item.source.path : (item.path || item.key)
  if (target === 'i18n') {
    const i18n = hexo.theme && hexo.theme.i18n
    const data = (i18n && i18n.data) || {}
    const langs = ((i18n && i18n.languages) || []).concat(Object.keys(data))
    for (let i = 0; i < langs.length; i++) {
      const lang = langs[i]
      const bucket = data[lang]
      if (!bucket) continue
      const v = bucket[p]
      if (v !== undefined && v !== null && v !== '') return String(v)
    }
    return str(item.default)
  }
  if (target === 'config') {
    const v = getPath(hexo.config, p)
    return (v === undefined || v === null) ? str(item.default) : str(v)
  }
  if (target === 'theme') {
    const v = getPath(hexo.theme.config, p)
    return (v === undefined || v === null) ? str(item.default) : str(v)
  }
  // source/_data/*.yml（如公告正文：announcement.content）
  // 只有 target='text' 会走到这里；末尾空白去掉，方便和"用户改过的值"比对。
  if (target === 'data') {
    const data = (hexo.locals && typeof hexo.locals.get === 'function') ? hexo.locals.get('data') : null
    const v = getPath(data, p)
    if (v === undefined || v === null || v === '') return str(item.default)
    return String(v).replace(/\s+$/, '')
  }
  // menu / text / browser：默认值就是清单里写的那一份
  return str(item.default)
}

/* ============================================================
   菜单键改名（键名就是显示名，顺序要保住）
   ============================================================ */
function renameMenuKey (themeConfig, oldName, newName) {
  const menu = themeConfig && themeConfig.menu
  if (!menu || !newName || oldName === newName) return
  if (!Object.prototype.hasOwnProperty.call(menu, oldName)) return
  const out = {}
  Object.keys(menu).forEach(k => {
    if (k === oldName) out[newName] = menu[k]
    else if (k !== newName) out[k] = menu[k]
  })
  Object.keys(menu).forEach(k => { delete menu[k] })
  Object.keys(out).forEach(k => { menu[k] = out[k] })
}

function writeTarget (hexo, item, value) {
  const p = item.path || item.key
  if (item.target === 'i18n') {
    const i18n = hexo.theme && hexo.theme.i18n
    if (!i18n) return
    const langs = (i18n.languages || []).concat(Object.keys(i18n.data || {}))
    const uniq = []
    langs.forEach(l => { if (l && uniq.indexOf(l) === -1) uniq.push(l) })
    uniq.forEach(lang => {
      if (!i18n.data[lang]) i18n.data[lang] = {}
      i18n.data[lang][p] = value
    })
    return
  }
  if (item.target === 'theme') {
    setPath(hexo.theme.config, p, coerce(getPath(hexo.theme.config, p), value))
    return
  }
  if (item.target === 'config') {
    setPath(hexo.config, p, coerce(getPath(hexo.config, p), value))
    return
  }
  if (item.target === 'menu') {
    renameMenuKey(hexo.theme.config, item.default, value)
  }
}

/* ============================================================
   应用（幂等：同一进程内只算一次）
   ============================================================ */
function applyAll (hexo) {
  if (hexo._siteText && hexo._siteText.applied) return hexo._siteText
  const read = readOverrides(hexo.base_dir)
  const overrides = read.values
  const defs = {}
  const resolved = {}
  const unknown = []
  const known = {}
  catalog.groups.forEach(g => g.items.forEach(it => { known[it.key] = it }))
  Object.keys(overrides).forEach(k => { if (!known[k]) unknown.push(k) })

  catalog.groups.forEach(g => g.items.forEach(item => {
    const def = readSource(hexo, item)
    defs[item.key] = def
    const ov = overrides[item.key]
    resolved[item.key] = (ov === undefined) ? def : ov
    if (ov === undefined) return
    try {
      writeTarget(hexo, item, ov)
    } catch (e) {
      hexo.log.warn('[site-text] 应用 %s 失败：%s', item.key, (e && e.message) || e)
    }
  }))

  if (read.error) hexo.log.warn('[site-text] %s 解析失败：%s（本次全部用默认值）', FILE, read.error)
  if (unknown.length) hexo.log.warn('[site-text] %s 里有 %d 个不在清单里的键（已忽略）：%s', FILE, unknown.length, unknown.join(', '))

  hexo._siteText = {
    applied: true,
    overrides,
    defs,
    resolved,
    unknown,
    styles: read.styles,
    fileExists: read.exists,
    fileError: read.error
  }
  return hexo._siteText
}

function ensure (hexo) {
  return (hexo._siteText && hexo._siteText.applied) ? hexo._siteText : applyAll(hexo)
}

/* ============================================================
   取单个键的生效值（给生成器用）
   ============================================================ */
function value (hexo, key, fallback) {
  const state = ensure(hexo)
  const v = state.resolved[key]
  if (v === undefined || v === null || v === '') return fallback === undefined ? '' : fallback
  return v
}

/* ============================================================
   管理页元数据
   ============================================================ */
function meta (hexo) {
  const state = ensure(hexo)
  return {
    file: FILE,
    fileExists: state.fileExists,
    fileError: state.fileError,
    unknown: state.unknown,
    changed: Object.keys(state.overrides).length,
    styleProps: STYLE_PROPS,
    styles: (state.styles || []).map(r => ({
      sel: r.sel,
      note: r.note,
      css: r.css,
      important: !!r.important,
      decls: r.decls || []
    })),
    groups: catalog.groups.map(g => ({
      id: g.id,
      title: g.title,
      hint: g.hint || '',
      items: g.items.map(it => ({
        key: it.key,
        label: it.label,
        hint: it.hint || '',
        type: it.type || 'text',
        target: it.target,
        def: state.defs[it.key] === undefined ? (it.default || '') : state.defs[it.key],
        val: state.resolved[it.key] === undefined ? (it.default || '') : state.resolved[it.key]
      }))
    }))
  }
}

/* ============================================================
   浏览器端注入的脚本
   ============================================================ */
function browserKeys () {
  const keys = []
  catalog.groups.forEach(g => g.items.forEach(it => {
    if (it.target === 'menu' || it.browser) keys.push(it.key)
  }))
  return keys
}

function browserScript (hexo) {
  const state = ensure(hexo)
  const payload = {}
  browserKeys().forEach(k => {
    const v = state.resolved[k]
    if (v !== undefined && v !== null && v !== '') payload[k] = v
  })
  const json = JSON.stringify(payload).replace(/</g, '\\u003c')
  return '<script id="site-text-data">window.__SITE_TEXT__=' + json + ';' +
    'window.st=function(k,d,v){var t=window.__SITE_TEXT__||{};var s=t[k];' +
    'if(s===undefined||s===null||s==="")s=d;' +
    'if(s===undefined||s===null)return "";' +
    'if(v)s=String(s).replace(/\\{(\\w+)\\}/g,function(m,n){return v[n]===undefined?m:v[n]});' +
    'return s};</script>'
}

/* 样式块：head 末尾注入（排在主题 inject 的样式之后 → 同特异性下后者胜） */
function styleCss (hexo) {
  const state = ensure(hexo)
  return (state.styles || []).map(function (r) {
    const body = r.decls ? joinCss(r.decls, r.important) : r.css
    return r.sel + '{' + body + '}'
  }).join('\n')
}

function styleScript (hexo) {
  const css = styleCss(hexo)
  if (!css) return ''
  return '<style id="site-text-style">\n' + css + '\n</style>'
}

module.exports = {
  FILE,
  HEADER,
  STYLE_PROPS,
  getPath,
  setPath,
  readOverrides,
  dumpOverrides,
  readSource,
  normalizeStyles,
  parseCss,
  joinCss,
  sanitizeSel,
  applyAll,
  ensure,
  value,
  meta,
  browserScript,
  styleCss,
  styleScript
}
