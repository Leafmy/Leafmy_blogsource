/* ============================================================
   站点文字覆盖层（插件入口）
   ------------------------------------------------------------
   一份数据源：source/_data/site_text.yml（管理页 /admin/「文字」标签页写它）
   三处生效：
     ① 站点/主题配置、主题语言表（i18n）—— 构建期直接改对象，模板无感
     ② 模板里取自定义文字 —— st('key', 默认值) helper
     ③ 浏览器端脚本 —— 往 <head> 注入 window.__SITE_TEXT__ / window.st()
   清单与字段说明见 scripts/site-text-catalog.js。
   ============================================================ */
'use strict'

const lib = require('./site-text-lib')

/* ① 生成前把覆盖值写进 config / theme.config / i18n（幂等） */
hexo.extend.filter.register('before_generate', function () {
  lib.applyAll(hexo)
}, 5)

/* ② 模板取自定义文字：st('nav.title', config.title) */
hexo.extend.helper.register('st', function (key, fallback) {
  const state = lib.ensure(hexo)
  const v = state.resolved[key]
  if (v === undefined || v === null || v === '') {
    return fallback === undefined ? '' : fallback
  }
  return v
})

/* ③ 浏览器端：<head> 里注入文字表 + 格式化取值函数（自定义脚本用 window.st） */
hexo.extend.filter.register('after_render:html', function (str, data) {
  // 注意：这个 filter 拿到的是「模板渲染出的 HTML」，data.path 是模板/源文件路径。
  // 片段渲染（partial、Markdown 正文）也会经过这里 —— 用 id 去重，够用且便宜。
  const src = (data && data.path) || ''
  if (src === 'layout/admin.pug' || /(^|\/)admin\//.test(src)) return str
  if (typeof str !== 'string' || str.indexOf('</head>') === -1) return str
  if (str.indexOf('id="site-text-data"') !== -1) return str
  return str.replace(/<head([^>]*)>/i, function (m) { return m + lib.browserScript(hexo) })
}, 20)
