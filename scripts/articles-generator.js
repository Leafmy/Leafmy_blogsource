/* ============================================================
   生成「文章」列表页 /articles/
   ------------------------------------------------------------
   导航栏「文章」原来的指向是首页 `/`，这里给它一个独立页面：
   - 与首页共用主题的 indexPostUI 卡片（同一套玻璃卡片样式，零重复 CSS）
   - 分页参数沿用 index_generator（per_page / order_by），分页路径 /articles/page/2/
   - data.type = 'articles' 让主题的 getPageType() 判定为 'page'
     （从而渲染「文章」页头，而不是走 post 的 header 分支）
     —— 注意**不要**设 __index，否则 is_home() 为真会渲染成首页 hero
   ============================================================ */
'use strict'

const pagination = require('hexo-pagination')

hexo.extend.generator.register('articles', function (locals) {
  const config = this.config
  const indexGen = config.index_generator || {}
  const posts = locals.posts.sort(indexGen.order_by || '-date')
  const paginationDir = config.pagination_dir || 'page'

  if (!posts.length) return

  return pagination('articles', posts, {
    perPage: indexGen.per_page || 10,
    layout: ['articles'],
    format: paginationDir + '/%d/',
    data: {
      title: '文章',
      type: 'articles'
    }
  })
})
