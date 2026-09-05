/* ============================================================
   hexo generator: 构建时生成 /search.json 轻量检索索引
   (无需第三方插件; scripts/*.js 会被 hexo 自动加载)
   每条: { t:标题, u:链接, d:日期, tags:[], cats:[], s:摘要 }
   ============================================================ */
'use strict'

function stripHtml(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

hexo.extend.generator.register('search-json', function (locals) {
  var posts = locals.posts.sort('-date').filter(function (p) { return p.published !== false })
  var list = posts.map(function (p) {
    var tags = (p.tags && p.tags.toArray ? p.tags.toArray() : []).map(function (t) { return t.name })
    var cats = (p.categories && p.categories.toArray ? p.categories.toArray() : []).map(function (c) { return c.name })
    // 摘要: 优先 front-matter description, 否则正文去 HTML 后截断
    var summary = p.description || stripHtml(p.content).slice(0, 260)
    return {
      t: p.title,
      u: '/' + p.path,
      d: (p.date ? p.date.format('YYYY-MM-DD') : ''),
      tags: tags,
      cats: cats,
      s: summary
    }
  })
  return {
    path: 'search.json',
    data: JSON.stringify(list)
  }
})
