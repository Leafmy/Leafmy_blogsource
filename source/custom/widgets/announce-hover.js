/* ============================================================
   Announcement card: title always visible + body expand on hover
   - 把公告内容「首段」提升为常驻标题 .announcement_title
     （默认状态下直接可见），其余正文包进 .announcement_body
     默认折叠；桌面 hover / 触屏点击 toggle .open 展开。
   - 点击卡片外部区域自动收起
   - 喇叭标识：默认静止，仅"新公告"（localStorage 无已读记录）时播一次 shake
   依赖 announce-hover.css 中的样式（结构必须匹配）。
   ============================================================ */
(function () {
  'use strict'

  const card = document.querySelector('.card-announcement')
  if (!card) return

  const contentEl = card.querySelector('.announcement_content')

  // ---- 重组 DOM：首段 -> .announcement_title，其余 -> .announcement_body ----
  // 注意：必须在重组完成后，用最终稳定的 textContent 计算公告哈希，
  // 否则每次 hash 不一致会导致"新公告"状态不稳定。
  if (contentEl) {
    const children = Array.from(contentEl.children)
    if (children.length > 0) {
      const titleEl = children[0]
      titleEl.classList.add('announcement_title')

      const bodyWrap = document.createElement('div')
      bodyWrap.className = 'announcement_body'
      children.slice(1).forEach((node) => bodyWrap.appendChild(node))

      if (bodyWrap.children.length > 0) {
        contentEl.appendChild(bodyWrap)
      }
    }
  }

  // ---- 喇叭标识：默认静止，仅"新公告"时播 shake ---- 
  // 基于重组后稳定内容计算哈希；内容变更 = 新公告 -> 播一次
  const horn = card.querySelector('.item-headline i.fa-bullhorn')
  if (contentEl && horn) {
    // 兜底：确保脚本在内容就绪后执行（若 DOM 尚未渲染完整）
    const run = function () {
      const text = card.querySelector('.announcement_content').textContent || ''
      let hash = 0
      for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0
      const key = 'butterfly_announce_horn_' + hash

      let seen = false
      try { seen = !!localStorage.getItem(key) } catch (e) { /* 无痕模式忽略 */ }

      if (!seen) {
        horn.classList.add('is-new')
        setTimeout(function () {
          horn.classList.remove('is-new')
          try { localStorage.setItem(key, '1') } catch (e) { /* ignore */ }
        }, 1100)
      }
    }
    run()
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
