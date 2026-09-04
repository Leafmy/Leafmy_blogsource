/* ============================================================
   Announcement card: title always visible + body expand on hover
   - 把公告内容「首段」提升为常驻标题 .announcement_title
     （默认状态下直接可见），其余正文包进 .announcement_body
     默认折叠；桌面 hover / 触屏点击 toggle .open 展开。
   - 点击卡片外部区域自动收起
   依赖 announce-hover.css 中的样式（结构必须匹配）。
   ============================================================ */
(function () {
  'use strict'

  const card = document.querySelector('.card-announcement')
  if (!card) return

  const content = card.querySelector('.announcement_content')

  // 重组 DOM：首段 -> .announcement_title，其余 -> .announcement_body
  if (content) {
    const children = Array.from(content.children)
    if (children.length > 0) {
      const titleEl = children[0]
      titleEl.classList.add('announcement_title')

      const bodyWrap = document.createElement('div')
      bodyWrap.className = 'announcement_body'
      children.slice(1).forEach((node) => bodyWrap.appendChild(node))

      // 若还有正文，插入 bodyWrap；只剩标题则无需额外包裹
      if (bodyWrap.children.length > 0) {
        content.appendChild(bodyWrap)
      }
    }
  }

  const hasHover = window.matchMedia('(hover: hover)').matches

  // 触屏或指针不精确的设备：点击切换
  if (!hasHover) {
    card.addEventListener('click', (e) => {
      e.stopPropagation()
      card.classList.toggle('open')
    })

    document.addEventListener('click', (e) => {
      if (!card.contains(e.target)) card.classList.remove('open')
    })
  }
})()
