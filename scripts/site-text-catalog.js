/* ============================================================
   站点文字清单（唯一事实来源）
   ------------------------------------------------------------
   目标：网站上除了「按钮」和首页大标题「启明」以外的可见文字，
        全部可以在这个清单里登记，并在管理页 /admin/ 的「文字」标签页里改。

   每个条目 item 的字段：
     key      —— 写进 source/_data/site_text.yml 的键名（也是 i18n 键 / 配置路径）
     label    —— 管理页里的名字
     hint     —— 管理页里的一句说明（这话出现在哪儿）
     type     —— 'text'（单行 input）或 'textarea'（多行）
     target   —— 覆盖方式：
                 'config'  改 hexo.config[...]            （站点 _config.yml）
                 'theme'   改 hexo.theme.config[...]      （主题 _config.yml）
                 'i18n'    改 hexo.theme.i18n.data[...]   （主题 languages/*.yml）
                 'menu'    改主题 menu 的键名（导航/侧栏菜单项显示名）
                 'text'    只进文字表，模板里用 st('key') 取
                 'browser' 只注入 window.__SITE_TEXT__，给自定义脚本取
     path     —— 目标路径，默认等于 key（menu 除外）
     default  —— 兜底默认值（配置/i18n 里读不到时用；管理页也用它算"有没有改过"）
     source   —— 仅 target='text' 用：默认值从哪读（{target,path}），没有就用 default
     browser  —— 额外把"生效值"注入 window.__SITE_TEXT__（menu 项自动注入）

   新增条目只需在这里加一行；scripts/site-text.js 与管理页会自动跟上。
   ============================================================ */
'use strict'

module.exports = {
  file: 'source/_data/site_text.yml',
  groups: [
    /* ---------------- 站点信息 ---------------- */
    {
      id: 'site',
      title: '站点信息',
      hint: '出现在浏览器标签、侧栏作者卡和页脚版权行里。',
      items: [
        {
          key: 'site.subtitle',
          label: '标签页副标题',
          hint: '浏览器标签形如「启明 - 分享技巧与经验」，「 - 」后半段就是它',
          type: 'text',
          target: 'config',
          path: 'subtitle',
          default: '分享技巧与经验'
        },
        {
          key: 'site.description',
          label: '站点描述',
          hint: '侧栏「个人信息卡」里作者名下面那行小字；也是搜索引擎摘要',
          type: 'textarea',
          target: 'config',
          path: 'description',
          default: '一个关于技术、编程和生活的个人博客'
        },
        {
          key: 'site.author',
          label: '作者名',
          hint: '侧栏卡片、页脚「© 2025 - 2026 By …」、文章页「文章作者」都用它',
          type: 'text',
          target: 'config',
          path: 'author',
          default: 'l3AFovxs'
        }
      ]
    },

    /* ---------------- 顶部导航栏 ---------------- */
    {
      id: 'nav',
      title: '顶部导航栏',
      hint: '导航栏、检索浮层、菜单下拉面板。',
      items: [
        {
          key: 'nav.title',
          label: '左上角站名',
          hint: '导航栏左侧的站点名（首页正中的大标题「启明」是逐笔描边动画，单独维护，不在这里改）',
          type: 'text',
          target: 'text',
          source: { target: 'config', path: 'title' },
          default: '启明'
        },
        {
          key: 'nav.menu.articles',
          label: '菜单项①（文章）',
          hint: '导航栏第一个菜单的文字。改的是显示名，链接指向不变',
          type: 'text',
          target: 'menu',
          default: '文章'
        },
        {
          key: 'nav.menu.archives',
          label: '菜单项②（归档）',
          hint: '导航栏第二个菜单的文字',
          type: 'text',
          target: 'menu',
          default: '归档'
        },
        {
          key: 'nav.menu.about',
          label: '菜单项③（关于）',
          hint: '导航栏第三个菜单的文字',
          type: 'text',
          target: 'menu',
          default: '关于'
        },
        {
          key: 'nav.search.placeholder',
          label: '检索框占位文案',
          hint: '检索胶囊里循环滚动的那句提示',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '搜索文章、标签、分类'
        },
        {
          key: 'nav.search.loading',
          label: '检索中',
          hint: '检索索引还没加载完时结果面板里的提示',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '正在搜索…'
        },
        {
          key: 'nav.search.error',
          label: '检索索引失败',
          hint: 'search.json 拉取失败时的提示',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '检索索引加载失败，请刷新后重试'
        },
        {
          key: 'nav.search.empty',
          label: '检索无结果',
          hint: '没有命中时的提示；{query} 会替换成你输入的关键词',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '未找到与「{query}」相关的内容，换个关键词试试'
        },
        {
          key: 'nav.search.adminKeyError',
          label: '管理员密钥错误提示',
          hint: '在检索栏输错管理员密钥时的提示',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '管理员密钥不正确'
        },
        {
          key: 'nav.drop.empty',
          label: '菜单下拉空态',
          hint: '鼠标悬停「文章 / 归档」弹出的下拉面板里，没内容时显示',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '暂无文章'
        },
        {
          key: 'nav.perf.high',
          label: '性能模式：完整画质',
          hint: '导航栏里那个切换按钮在"完整画质"档时显示的文字',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '性能模式'
        },
        {
          key: 'nav.perf.low',
          label: '性能模式：低配',
          hint: '同一个按钮切到"低配"档时显示的文字',
          type: 'text',
          target: 'browser',
          browser: true,
          default: '低配模式'
        }
      ]
    },

    /* ---------------- 首页 ---------------- */
    {
      id: 'home',
      title: '首页',
      hint: '首页 hero 区。大标题「启明」是 SVG 描边动画，不在这里改；侧栏公告请用「公告」标签页。',
      items: [
        {
          key: 'theme.subtitle.sub',
          label: '打字机副标题（每行一条）',
          hint: '注意：主题里首页副标题功能现在是关着的（theme.subtitle.enable = false），填了也不会显示，除非把开关打开',
          type: 'textarea',
          target: 'theme',
          path: 'subtitle.sub',
          default: ''
        },
        {
          key: 'home.subtitleFrom',
          label: '副标题出处前缀',
          hint: '副标题接第三方「一言」接口时，出处前面那个词（当前接口关闭，看不到）',
          type: 'text',
          target: 'text',
          default: '出自 '
        }
      ]
    },

    /* ---------------- 侧栏卡片 ---------------- */
    {
      id: 'aside',
      title: '侧栏卡片',
      hint: '首页与文章页右侧那些卡片上的标题与字段名。',
      items: [
        { key: 'aside.card_announcement', label: '公告卡片标题', hint: '侧栏公告卡的标题', type: 'text', target: 'i18n', default: '公告' },
        { key: 'aside.card_recent_post', label: '最新文章卡片标题', hint: '侧栏最新文章卡', type: 'text', target: 'i18n', default: '最新文章' },
        { key: 'aside.card_categories', label: '分类卡片标题', hint: '侧栏分类卡', type: 'text', target: 'i18n', default: '分类' },
        { key: 'aside.card_tags', label: '标签卡片标题', hint: '侧栏标签卡', type: 'text', target: 'i18n', default: '标签' },
        { key: 'aside.card_archives', label: '归档卡片标题', hint: '侧栏归档卡', type: 'text', target: 'i18n', default: '归档' },
        {
          key: 'aside.card_archives.format',
          label: '归档卡片的日期格式',
          hint: '侧栏归档卡里每条的名字，MMMM YYYY = 「九月 2026」；想换成「2026年9月」就填 YYYY年M月',
          type: 'text',
          target: 'theme',
          path: 'aside.card_archives.format',
          default: 'MMMM YYYY'
        },
        { key: 'aside.card_post_series', label: '系列文章卡片标题', hint: '侧栏系列文章卡', type: 'text', target: 'i18n', default: '系列文章' },
        { key: 'aside.card_toc', label: '目录卡片标题', hint: '文章页侧栏目录卡', type: 'text', target: 'i18n', default: '目录' },
        { key: 'aside.more_button', label: '「查看更多」', hint: '卡片里展开更多用的按钮文字', type: 'text', target: 'i18n', default: '查看更多' },
        { key: 'aside.articles', label: '个人信息卡：文章', hint: '头像下方三个数字的第一个标题', type: 'text', target: 'i18n', default: '文章' },
        { key: 'aside.tags', label: '个人信息卡：标签', hint: '头像下方第二个数字的标题', type: 'text', target: 'i18n', default: '标签' },
        { key: 'aside.categories', label: '个人信息卡：分类', hint: '头像下方第三个数字的标题', type: 'text', target: 'i18n', default: '分类' },
        { key: 'aside.card_webinfo.headline', label: '网站信息卡片标题', hint: '侧栏「网站信息」卡', type: 'text', target: 'i18n', default: '网站信息' },
        { key: 'aside.card_webinfo.article_name', label: '网站信息：文章数目', hint: '「文章数目 :」冒号前的字', type: 'text', target: 'i18n', default: '文章数目' },
        { key: 'aside.card_webinfo.runtime.name', label: '网站信息：运行时间', hint: '「运行时间 :」冒号前的字（需在主题配置里填了建站日期才显示）', type: 'text', target: 'i18n', default: '运行时间' },
        { key: 'aside.card_webinfo.runtime.unit', label: '网站信息：运行时间单位', hint: '运行天数后面的单位', type: 'text', target: 'i18n', default: '天' },
        { key: 'aside.card_webinfo.last_push_date.name', label: '网站信息：最后更新时间', hint: '「最后更新时间 :」冒号前的字', type: 'text', target: 'i18n', default: '最后更新时间' },
        { key: 'aside.card_webinfo.site_wordcount', label: '网站信息：本站总字数', hint: '需在主题配置里开启字数统计才显示', type: 'text', target: 'i18n', default: '本站总字数' },
        { key: 'aside.card_webinfo.site_uv_name', label: '网站信息：本站访客数', hint: '「本站访客数 :」冒号前的字', type: 'text', target: 'i18n', default: '本站访客数' },
        { key: 'aside.card_webinfo.site_pv_name', label: '网站信息：本站总浏览量', hint: '「本站总浏览量 :」冒号前的字', type: 'text', target: 'i18n', default: '本站总浏览量' },
        { key: 'aside.card_newest_comments.headline', label: '最新评论卡片标题', hint: '侧栏最新评论卡（当前未开启）', type: 'text', target: 'i18n', default: '最新评论' },
        { key: 'aside.card_newest_comments.loading_text', label: '最新评论：加载中', hint: '评论加载时的提示', type: 'text', target: 'i18n', default: '加载中...' },
        { key: 'aside.card_newest_comments.error', label: '最新评论：读取失败', hint: '拿不到评论时的提示', type: 'text', target: 'i18n', default: '无法获取评论，请确认相关配置是否正确' },
        { key: 'aside.card_newest_comments.zero', label: '最新评论：暂无评论', hint: '一条评论都没有时的提示', type: 'text', target: 'i18n', default: '暂无评论' },
        { key: 'visit.name', label: '访客名片：名字', hint: '鼠标移入侧栏个人信息卡时切换显示的名字', type: 'text', target: 'browser', browser: true, default: 'HexShane' },
        { key: 'visit.desc', label: '访客名片：简介', hint: '同一张名片里名字下面那行字', type: 'text', target: 'browser', browser: true, default: '卡密' }
      ]
    },

    /* ---------------- 文章页 ---------------- */
    {
      id: 'post',
      title: '文章页',
      hint: '文章信息行、版权块、上下篇、相关推荐、复制提示、翻译按钮。',
      items: [
        { key: 'post.created', label: '发表时间前缀', hint: '文章列表/文章页日期前的「发表于」', type: 'text', target: 'i18n', default: '发表于' },
        { key: 'post.updated', label: '更新时间前缀', hint: '「更新于」', type: 'text', target: 'i18n', default: '更新于' },
        { key: 'post.wordcount', label: '总字数标签', hint: '字数统计前面的字（需开启字数统计）', type: 'text', target: 'i18n', default: '总字数' },
        { key: 'post.min2read', label: '阅读时长标签', hint: '预计阅读时间前面的字', type: 'text', target: 'i18n', default: '阅读时长' },
        { key: 'post.min2read_unit', label: '阅读时长单位', hint: '「分钟」', type: 'text', target: 'i18n', default: '分钟' },
        { key: 'post.page_pv', label: '页面浏览量标签', hint: '浏览量前面的字', type: 'text', target: 'i18n', default: '浏览量' },
        { key: 'post.comments', label: '评论数标签', hint: '评论数前面的字', type: 'text', target: 'i18n', default: '评论数' },
        { key: 'post.recommend', label: '相关推荐标题', hint: '文章末尾推荐区标题', type: 'text', target: 'i18n', default: '相关推荐' },
        { key: 'post.edit', label: '「编辑」链接', hint: '文章标题旁的编辑入口（需在主题配置里开）', type: 'text', target: 'i18n', default: '编辑' },
        { key: 'post.back_to_home', label: '「返回首页」', hint: '文章页导航栏标题右侧的小字', type: 'text', target: 'i18n', default: '返回首页' },
        { key: 'post.copyright.author', label: '版权块：文章作者', hint: '文章末尾版权块里的字段名', type: 'text', target: 'i18n', default: '文章作者' },
        { key: 'post.copyright.link', label: '版权块：文章链接', hint: '同上', type: 'text', target: 'i18n', default: '文章链接' },
        { key: 'post.copyright.copyright_notice', label: '版权块：版权声明', hint: '同上', type: 'text', target: 'i18n', default: '版权声明' },
        {
          key: 'post.copyright.copyright_content',
          label: '版权块：许可声明全文',
          hint: '四个 %s 依次是：协议链接、协议名、文章链接、文章标题。别改乱顺序',
          type: 'textarea',
          target: 'i18n',
          default: '本博客所有文章除特别声明外，均采用 <a href="%s" target="_blank">%s</a> 许可协议。转载请注明来源 <a href="%s" target="_blank">%s</a>！'
        },
        { key: 'pagination.prev', label: '上一篇', hint: '文章底部分页', type: 'text', target: 'i18n', default: '上一篇' },
        { key: 'pagination.next', label: '下一篇', hint: '文章底部分页', type: 'text', target: 'i18n', default: '下一篇' },
        { key: 'pagination.page_info', label: '分页页码信息', hint: '列表页底部「第 X 页 / 共 Y 页」，${current}/${total} 是占位符', type: 'text', target: 'i18n', default: '第 ${current} 页 / 共 ${total} 页' },
        { key: 'comment', label: '「评论」', hint: '评论区标题', type: 'text', target: 'i18n', default: '评论' },
        { key: 'share', label: '「分享」', hint: '分享按钮文字', type: 'text', target: 'i18n', default: '分享' },
        { key: 'donate', label: '「赞助」', hint: '赞赏按钮文字（当前未开启）', type: 'text', target: 'i18n', default: '赞助' },
        { key: 'copy_copyright.author', label: '复制版权：作者', hint: '复制正文时附加的版权行字段', type: 'text', target: 'i18n', default: '作者' },
        { key: 'copy_copyright.link', label: '复制版权：链接', hint: '同上', type: 'text', target: 'i18n', default: '链接' },
        { key: 'copy_copyright.source', label: '复制版权：来源', hint: '同上', type: 'text', target: 'i18n', default: '来源' },
        { key: 'copy_copyright.info', label: '复制版权：声明', hint: '复制正文时附加的那句声明', type: 'textarea', target: 'i18n', default: '著作权归作者所有。商业转载请联系作者获得授权，非商业转载请注明出处。' },
        { key: 'config.shiki.copy.success', label: '代码块复制成功提示', hint: '点代码块复制按钮后的小提示（Shiki 版）', type: 'text', target: 'config', path: 'shiki.copy.success', default: '复制成功' },
        { key: 'config.shiki.copy.error', label: '代码块复制失败提示', hint: '同上（Shiki 版）', type: 'text', target: 'config', path: 'shiki.copy.error', default: '复制失败' },
        { key: 'config.shiki.copy.no_support', label: '代码块复制不支持提示', hint: '浏览器不支持剪贴板时的提示（Shiki 版）', type: 'text', target: 'config', path: 'shiki.copy.no_support', default: '浏览器不支持' },
        { key: 'copy.success', label: '复制提示（主题版）：成功', hint: '主题自带复制按钮的提示，与上面 Shiki 那三条是两套来源，建议一起改', type: 'text', target: 'i18n', default: '复制成功' },
        { key: 'copy.error', label: '复制提示（主题版）：失败', hint: '同上', type: 'text', target: 'i18n', default: '复制失败' },
        { key: 'copy.noSupport', label: '复制提示（主题版）：不支持', hint: '同上', type: 'text', target: 'i18n', default: '浏览器不支持' },
        { key: 'theme.post_copyright.license', label: '文章许可协议名', hint: '文章页版权块里那个协议名，如 CC BY-NC-SA 4.0', type: 'text', target: 'theme', path: 'post_copyright.license', default: 'CC BY-NC-SA 4.0' },
        { key: 'translate.btn', label: '翻译按钮：待翻译', hint: '文章页「翻译」按钮上的字', type: 'text', target: 'browser', browser: true, default: '翻译' },
        { key: 'translate.btnOriginal', label: '翻译按钮：看原文', hint: '译文显示中，按钮变成「显示原文」', type: 'text', target: 'browser', browser: true, default: '显示原文' },
        { key: 'translate.btnRetry', label: '翻译按钮：重试', hint: '翻译出错后按钮临时变成「重试」', type: 'text', target: 'browser', browser: true, default: '重试' },
        { key: 'translate.badge', label: '译文角标', hint: '译文正文左上角那个小角标', type: 'text', target: 'browser', browser: true, default: 'AI 翻译' },
        { key: 'translate.modal.title', label: '翻译设置弹窗标题', hint: '点齿轮打开的设置弹窗', type: 'text', target: 'browser', browser: true, default: '设置 DeepSeek API Key' },
        {
          key: 'translate.modal.desc',
          label: '翻译设置弹窗说明',
          hint: '设置弹窗里的说明文字',
          type: 'textarea',
          target: 'browser',
          browser: true,
          default: '填入你自己的 DeepSeek API Key（在 platform.deepseek.com 申请）。Key 经混淆编码后只存入你浏览器的 localStorage，不会写入源码或上传服务器。'
        },
        { key: 'translate.status.saved', label: '翻译设置：已保存状态', hint: '{tail} 是 Key 的最后 4 位', type: 'text', target: 'browser', browser: true, default: '已保存（sk-****{tail}）' },
        { key: 'translate.status.savedOk', label: '翻译设置：保存成功', hint: '点「保存」成功后的状态行', type: 'text', target: 'browser', browser: true, default: '已保存' },
        { key: 'translate.status.empty', label: '翻译设置：尚未配置', hint: '还没填 Key 时的状态行', type: 'text', target: 'browser', browser: true, default: '尚未配置' },
        { key: 'translate.status.needKey', label: '翻译设置：请输入 Key', hint: '空着点保存时的提示', type: 'text', target: 'browser', browser: true, default: '请输入 API Key' },
        { key: 'translate.status.encodeFail', label: '翻译设置：编码失败', hint: '保存时编码异常', type: 'text', target: 'browser', browser: true, default: '编码失败' },
        { key: 'translate.status.cleared', label: '翻译设置：已清除', hint: '点「清除」后的状态行', type: 'text', target: 'browser', browser: true, default: '已清除' },
        { key: 'translate.error.failed', label: '翻译失败', hint: '翻译出错又没有具体原因时的提示', type: 'text', target: 'browser', browser: true, default: '翻译失败' },
        { key: 'translate.error.noContent', label: '没有可翻译的内容', hint: '页面上没找到可译文本时', type: 'text', target: 'browser', browser: true, default: '没有可翻译的内容' },
        { key: 'translate.error.badModel', label: '译文质量不达标', hint: '有效译文太少时的提示，{ok}/{total} 是段数', type: 'text', target: 'browser', browser: true, default: '模型返回异常（有效译文 {ok}/{total}）' },
        { key: 'translate.error.apply', label: '译文应用失败', hint: '{msg} 是具体错误', type: 'text', target: 'browser', browser: true, default: '翻译应用失败：{msg}' },
        { key: 'translate.error.key', label: '翻译错误：Key 无效', hint: 'DeepSeek 返回 401', type: 'text', target: 'browser', browser: true, default: 'API Key 无效或已过期' },
        { key: 'translate.error.balance', label: '翻译错误：余额不足', hint: 'DeepSeek 返回 402', type: 'text', target: 'browser', browser: true, default: '账户余额不足' },
        { key: 'translate.error.rate', label: '翻译错误：请求过频', hint: 'DeepSeek 返回 429', type: 'text', target: 'browser', browser: true, default: '请求过频，请稍后再试' },
        { key: 'translate.error.badRequest', label: '翻译错误：请求被拒', hint: 'DeepSeek 返回 400', type: 'text', target: 'browser', browser: true, default: '请求被拒绝（HTTP 400，可能文本过长）' }
      ]
    },

    /* ---------------- 性能模式提示条 ---------------- */
    {
      id: 'perf',
      title: '性能模式提示条',
      hint: '首页右下角弹出的那条提示，以及里面的数据片段。{perf} 会替换成下面的三条之一。',
      items: [
        {
          key: 'perf.toastLow',
          label: '切到低配时的提示',
          hint: '可以写 <strong> 之类的 HTML。{perf} 会替换成 GPU 耗时片段',
          type: 'textarea',
          target: 'browser',
          browser: true,
          default: '已开启<strong>低配模式</strong>（{perf}）：关闭了后处理光晕、降低抗锯齿与各向异性，木星贴图用较小档。想恢复完整画质，点导航栏「性能模式」切换。'
        },
        {
          key: 'perf.toastHigh',
          label: '完整画质时的提示',
          hint: '同上',
          type: 'textarea',
          target: 'browser',
          browser: true,
          default: '当前为<strong>完整画质</strong>（{perf}）。若卡顿严重，可点导航栏「性能模式」切换为低配模式。'
        },
        { key: 'perf.gpu', label: '耗时片段：GPU 计时', hint: '{ms} 是毫秒数', type: 'text', target: 'browser', browser: true, default: 'GPU 中位 {ms} ms/帧' },
        { key: 'perf.raf', label: '耗时片段：帧间隔', hint: '{ms} 是毫秒数（拿不到 GPU 计时时的退路）', type: 'text', target: 'browser', browser: true, default: '帧间隔中位 {ms} ms' },
        { key: 'perf.noGpu', label: '耗时片段：无数据', hint: '两种计时都拿不到时', type: 'text', target: 'browser', browser: true, default: '未取到 GPU 计时' }
      ]
    },

    /* ---------------- 页脚 ---------------- */
    {
      id: 'footer',
      title: '页脚',
      hint: '页面最底部。版权行里的年份自动算，作者名取上面的「作者名」。',
      items: [
        { key: 'footer.framework', label: '「框架」', hint: '页脚「框架 | Hexo 7.3.0」里的字', type: 'text', target: 'i18n', default: '框架' },
        { key: 'footer.theme', label: '「主题」', hint: '页脚「主题 | Butterfly 5.7.0」里的字', type: 'text', target: 'i18n', default: '主题' },
        { key: 'footer.by', label: '版权行里的「By」', hint: '「© 2025 - 2026 By l3AFovxs」中间那个词', type: 'text', target: 'i18n', default: 'By' },
        { key: 'footer.since', label: '建站年份', hint: '版权行起始年份，如 2025（留空则只显示今年）', type: 'text', target: 'theme', path: 'footer.owner.since', default: '2025' },
        {
          key: 'footer.custom_text',
          label: '页脚声明',
          hint: '页脚最后那段自定义文字，支持 HTML',
          type: 'textarea',
          target: 'theme',
          path: 'footer.custom_text',
          default: '<div class="footer-site-meta">\n  <span class="footer-statement">本站为个人技术博客，内容仅代表个人观点，欢迎交流指正。</span>\n</div>\n'
        }
      ]
    },

    /* ---------------- 列表页与通用提示 ---------------- */
    {
      id: 'pages',
      title: '列表页与通用提示',
      hint: '归档/标签/分类列表页的标题，以及各种零散提示。',
      items: [
        { key: 'page.articles', label: '「全部文章」', hint: '归档页顶部的标题前缀', type: 'text', target: 'i18n', default: '全部文章' },
        { key: 'page.tag', label: '「标签」页标题', hint: '标签页标题', type: 'text', target: 'i18n', default: '标签' },
        { key: 'page.category', label: '「分类」页标题', hint: '分类页标题', type: 'text', target: 'i18n', default: '分类' },
        { key: 'page.archives', label: '「归档」页标题', hint: '归档页标题', type: 'text', target: 'i18n', default: '归档' },
        { key: 'page.articlesTitle', label: '「文章」列表页标题', hint: '/articles/ 页面顶部的大标题', type: 'text', target: 'text', default: '文章' },
        { key: 'loading', label: '「加载中...」', hint: '页面加载动画里的文字', type: 'text', target: 'i18n', default: '加载中...' },
        { key: 'load_more', label: '「加载更多」', hint: '列表页加载更多按钮', type: 'text', target: 'i18n', default: '加载更多' },
        { key: 'no_title', label: '「无标题」', hint: '文章没写标题时的兜底', type: 'text', target: 'i18n', default: '无标题' },
        { key: 'error404', label: '「页面未找到」', hint: '404 页面', type: 'text', target: 'i18n', default: '页面未找到' },
        { key: 'card_post_count', label: '「条评论」', hint: '卡片上的评论数单位', type: 'text', target: 'i18n', default: '条评论' },
        { key: 'date_suffix.just', label: '相对时间：刚刚', hint: '「刚刚」', type: 'text', target: 'i18n', default: '刚刚' },
        { key: 'date_suffix.min', label: '相对时间：分钟前', hint: '「分钟前」', type: 'text', target: 'i18n', default: '分钟前' },
        { key: 'date_suffix.hour', label: '相对时间：小时前', hint: '「小时前」', type: 'text', target: 'i18n', default: '小时前' },
        { key: 'date_suffix.day', label: '相对时间：天前', hint: '「天前」', type: 'text', target: 'i18n', default: '天前' },
        { key: 'date_suffix.month', label: '相对时间：个月前', hint: '「个月前」', type: 'text', target: 'i18n', default: '个月前' }
      ]
    }
  ]
}
