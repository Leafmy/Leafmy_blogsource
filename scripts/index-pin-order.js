/* ============================================================
   首页置顶顺序：sticky 数字**越小越靠前**（1 = 最前），0 = 不置顶
   ------------------------------------------------------------
   为什么要这个文件：
   hexo-generator-index@3 内置排序是 `(b.sticky || 0) - (a.sticky || 0)`，
   即"数字越大越靠前"。站长要求反过来（1 最靠前、0 不置顶），所以在这里用
   **同名 'index' 覆盖**内置生成器：Hexo 先加载 node_modules 插件
   （hexo/lib/hexo/load_plugins.js: loadModules → loadScripts），
   再加载本目录，同名注册会替换掉插件的那个。

   排序规则（稳定排序，保持原有相对顺序）：
   - sticky > 0 → 置顶，整体排在所有普通文章之前，按 sticky **升序**；
   - sticky 相同的置顶文章之间按 date 倒序（沿用 index_generator.order_by）；
   - sticky = 0 / 未设置 → 不置顶，按 index_generator.order_by（默认 -date）。

   注意：主题只在首页用 `article.top || article.sticky > 0` 判断要不要显示图钉，
   /articles/ 列表页不参与置顶，所以这里只覆盖首页 index。
   ============================================================ */
'use strict'

const pagination = require('hexo-pagination')

hexo.extend.generator.register('index', function (locals) {
  const config = this.config
  const indexGen = config.index_generator || {}
  const posts = locals.posts.sort(indexGen.order_by || '-date')

  // 置顶整体前移 + 数字升序；普通文章之间返回 0 → 稳定排序保留日期倒序
  posts.data.sort((a, b) => {
    const sa = Number(a.sticky) || 0
    const sb = Number(b.sticky) || 0
    if (sa > 0 && sb > 0) return sa - sb
    if (sa > 0) return -1
    if (sb > 0) return 1
    return 0
  })

  return pagination(indexGen.path || '', posts, {
    perPage: indexGen.per_page || 10,
    layout: ['index', 'archive'],
    format: (config.pagination_dir || 'page') + '/%d/',
    data: {
      __index: true
    }
  })
})
