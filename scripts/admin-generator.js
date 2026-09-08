/* ============================================================
   管理后台静态资源生成器
   ------------------------------------------------------------
   产出三样东西：
   1. /admin/index.html  —— 管理页（独立布局，无站点头尾，noindex）
   2. /admin/posts.json  —— 文章清单（标题/日期/分类/标签/源文件路径）
   3. /admin/meta.json   —— 站点元数据（标签、分类、月度归档、公告内容、仓库默认值）
   说明：静态站没有后端，管理页的所有写操作都通过 GitHub Contents API
   由站长自己浏览器里的 Token 完成；这里只负责生成只读的"索引"。
   ============================================================ */
'use strict'

const pad2 = n => String(n).padStart(2, '0')

hexo.extend.generator.register('admin', function (locals) {
  const posts = locals.posts.sort('-date')
  const themeCfg = (this.theme && this.theme.config) || {}
  const dataAnnounce = (locals.data && locals.data.announcement) || {}
  const announcement = dataAnnounce.content ||
    (themeCfg.aside && themeCfg.aside.card_announcement && themeCfg.aside.card_announcement.content) || ''

  const manifest = posts.map(post => {
    const cats = post.categories ? post.categories.toArray().map(c => c.name) : []
    const tags = post.tags ? post.tags.toArray().map(t => t.name) : []
    let excerpt = ''
    try {
      const raw = post.excerpt || post.content || ''
      excerpt = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140)
    } catch (e) { excerpt = '' }
    return {
      // Hexo 的 source 形如 "_posts/xxx.md"，GitHub 上的路径是 "source/" + source
      source: post.source || '',
      path: post.path || '',
      title: post.title || '',
      date: post.date ? post.date.format('YYYY-MM-DD HH:mm:ss') : '',
      updated: post.updated ? post.updated.format('YYYY-MM-DD HH:mm:ss') : '',
      categories: cats,
      tags,
      sticky: Number(post.sticky || 0),
      top: !!post.top,
      comments: post.comments !== false,
      excerpt
    }
  })

  // 月度归档统计
  const monthMap = {}
  posts.forEach(post => {
    if (!post.date) return
    const key = post.date.format('YYYY-MM')
    monthMap[key] = (monthMap[key] || 0) + 1
  })
  const archives = Object.keys(monthMap).sort().reverse().map(k => {
    const [year, month] = k.split('-')
    return { year: Number(year), month: Number(month), key: k, count: monthMap[k] }
  })

  const tags = (locals.tags ? locals.tags.toArray() : []).map(t => ({ name: t.name, count: t.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  const categories = (locals.categories ? locals.categories.toArray() : []).map(c => ({ name: c.name, count: c.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))

  const meta = {
    generatedAt: new Date().toISOString(),
    repo: { owner: 'Leafmy', name: 'Leafmy_blogsource', branch: 'main' },
    postsDir: 'source/_posts',
    announceFile: 'source/_data/announcement.yml',
    keyFile: 'source/custom/admin/admin-key.js',
    totals: { posts: posts.length, tags: tags.length, categories: categories.length },
    tags,
    categories,
    archives,
    announcement,
    site: { title: this.config.title, url: this.config.url, author: this.config.author }
  }

  return [
    {
      path: 'admin/index.html',
      layout: ['admin'],
      data: {
        title: '管理控制台',
        type: 'admin',
        __admin: true
      }
    },
    {
      path: 'admin/posts.json',
      data: JSON.stringify({ generatedAt: meta.generatedAt, posts: manifest })
    },
    {
      path: 'admin/meta.json',
      data: JSON.stringify(meta)
    }
  ]
})

// 月度归档的可读标签（供管理页展示，如 2026-09 → 九月 2026）
hexo.extend.helper.register('adminMonthLabel', function (year, month) {
  const zh = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
  return `${zh[Number(month) - 1] || pad2(month)} ${year}`
})
