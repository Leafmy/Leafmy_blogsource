/* ============================================================
   Announcement card: hover/click reveal (custom inject)
   - 桌面：CSS :hover 已处理（见 announce-hover.css）
   - 触屏/无 hover 设备：点击公告卡 toggle .open 显示/收起全文
   - 点击卡片外部区域自动收起
   ============================================================ */
(function () {
  'use strict'

  const card = document.querySelector('.card-announcement')
  if (!card) return

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

  // 移出卡片时收掉 .open（触屏滚动离开等场景兜底）
  card.addEventListener('mouseleave', () => {
    if (card.classList.contains('open') && !hasHover) {
      // 触屏下点其它位置已由 document 处理；这里保持 open 以便阅读
    }
  })
})()
