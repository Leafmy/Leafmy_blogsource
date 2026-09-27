/* ============================================================
   站点文字覆盖层 —— 纯函数库（无副作用）
   ------------------------------------------------------------
   谁在用：
     scripts/site-text.js        —— 插件：before_generate 应用覆盖 + st() helper + 注入浏览器
     scripts/admin-generator.js  —— 管理页元数据（清单 + 当前值 + 默认值）
     scripts/articles-generator.js —— 取单个键的生效值
   ============================================================ */
'use strict'

const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')
const catalog = require('./site-text-catalog')

const FILE = catalog.file

const HEADER = [
  '# ============================================================',
  '# 站点文字（由管理页 /admin/ 的「文字」标签页读写）',
  '# ------------------------------------------------------------',
  '# 这里只放「被改过」的文字：没出现的键就用站点/主题配置或主题语言文件里的原值。',
  '# 想恢复某一条为默认：在管理页点该项的「恢复默认」再保存（键会从本文件消失）。',
  '# 值统一写成双引号字符串（换行用 \\n 转义），方便机器读写、也方便 git diff。',
  '# 键名清单见 scripts/site-text-catalog.js；手改本文件也可以，格式照下面来。',
  '# ============================================================'
]

/* ---------------- 点号路径读写 ---------------- */
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

/* ---------------- 读 site_text.yml ---------------- */
function readOverrides (baseDir) {
  const file = path.join(baseDir, FILE)
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    return { values: {}, exists: false, error: null }
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
    return { values, exists: true, error: null }
  } catch (e) {
    return { values: {}, exists: true, error: (e && e.message) || String(e) }
  }
}

function dumpOverrides (state) {
  const values = (state && state.overrides) || {}
  const lines = HEADER.slice()
  const ordered = []
  catalog.groups.forEach(g => g.items.forEach(it => { ordered.push(it.key) }))
  const extra = Object.keys(values).filter(k => ordered.indexOf(k) === -1).sort()
  const all = ordered.concat(extra).filter(k => values[k] !== undefined)
  if (!all.length) {
    lines.push('texts: {}')
    return lines.join('\n') + '\n'
  }
  lines.push('texts:')
  all.forEach(k => {
    lines.push('  ' + k + ': ' + JSON.stringify(values[k]))
  })
  return lines.join('\n') + '\n'
}

/* ---------------- 读某个条目"没被覆盖时"的原值 ---------------- */
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
  // menu / text / browser：默认值就是清单里写的那一份
  return str(item.default)
}

/* ---------------- 菜单键改名（键名就是显示名，顺序要保住） ---------------- */
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

/* ---------------- 应用（幂等：同一进程内只算一次） ---------------- */
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
    fileExists: read.exists,
    fileError: read.error
  }
  return hexo._siteText
}

function ensure (hexo) {
  return (hexo._siteText && hexo._siteText.applied) ? hexo._siteText : applyAll(hexo)
}

/* ---------------- 取单个键的生效值（给生成器用） ---------------- */
function value (hexo, key, fallback) {
  const state = ensure(hexo)
  const v = state.resolved[key]
  if (v === undefined || v === null || v === '') return fallback === undefined ? '' : fallback
  return v
}

/* ---------------- 管理页元数据 ---------------- */
function meta (hexo) {
  const state = ensure(hexo)
  return {
    file: FILE,
    fileExists: state.fileExists,
    fileError: state.fileError,
    unknown: state.unknown,
    changed: Object.keys(state.overrides).length,
    groups: catalog.groups.map(g => ({
      id: g.id,
      title: g.title,
      hint: g.hint || '',
      items: g.items.map(it => ({
        key: it.key,
        label: it.label,
        hint: it.hint || '',
        type: it.type || 'text',
        def: state.defs[it.key] === undefined ? (it.default || '') : state.defs[it.key],
        val: state.resolved[it.key] === undefined ? (it.default || '') : state.resolved[it.key]
      }))
    }))
  }
}

/* ---------------- 浏览器端注入的脚本 ---------------- */
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

module.exports = {
  FILE,
  HEADER,
  getPath,
  setPath,
  readOverrides,
  dumpOverrides,
  readSource,
  applyAll,
  ensure,
  value,
  meta,
  browserScript
}
