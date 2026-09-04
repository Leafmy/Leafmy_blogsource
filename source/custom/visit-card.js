/* ============================================================
   Visit card — blur to reveal business card (custom inject, v3)
   个人信息卡（.card-info，站主 Leaf 卡）：
   - 默认：正常显示站主卡（头像、名字、描述、数据、Follow）和名片信息
   - 鼠标移入：原站主卡内容"变模糊"，同时名片卡淡入浮现
   - 鼠标移出：名片卡淡出，站主卡恢复清晰
   原卡片内容保留不动，名片卡作为覆盖层注入，纯 CSS :hover 触发。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const card = document.querySelector('.card-info')
  if (!card) return
  if (card.querySelector('.visit-card')) return

  // ---------- 名片信息（可按需修改） ----------
  const config = {
    email: 'leaf@example.com',
    wechat: '微信：Leaf-dev',
    github: 'https://github.com/xxxxxx',
    btnText: 'Follow Me'
  }

  const avatar = card.querySelector('.avatar-img img')
  const avatarSrc = avatar ? avatar.getAttribute('src') : ''
  const nameEl = card.querySelector('.author-info-name')
  const name = nameEl ? nameEl.textContent : 'Leaf'
  const followBtn = card.querySelector('#card-info-btn')
  const followHref = followBtn ? followBtn.getAttribute('href') : ''

  // ---------- 构造名片覆盖层 ----------
  const visit = document.createElement('div')
  visit.className = 'visit-card'
  visit.innerHTML = [
    '<div class="visit-card-inner">',
    '  <div class="visit-avatar"><img src="' + avatarSrc + '" alt="avatar"></div>',
    '  <div class="visit-name">' + name + '</div>',
    '  <div class="visit-contacts">',
    '    <a class="visit-contact" href="mailto:' + config.email + '"><i class="fas fa-envelope"></i><span>' + config.email + '</span></a>',
    '    <div class="visit-contact"><i class="fab fa-weixin"></i><span>' + config.wechat + '</span></div>',
    '  </div>',
    '  <a class="visit-follow" target="_blank" rel="noopener" href="' + (followHref || config.github) + '"><i class="fab fa-github"></i><span>' + config.btnText + '</span></a>',
    '</div>'
  ].join('')

  card.appendChild(visit)
})()
