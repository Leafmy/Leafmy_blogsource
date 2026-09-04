/* ============================================================
   Visit card — POKER STACK (custom inject, v2)
   个人信息卡（.card-info，站主 Leaf 卡）做成"扑克牌堆叠"：
   - 默认：一叠牌错落叠放，能看到 3 层牌的边缘（站主卡在最上，
     下有 2 张牌错开微转，像一叠扑克牌）
   - 鼠标悬浮：最上面那张"站主牌"被翻开抽走（上移+旋转），
     露出下面那张「名片卡」
   - 鼠标移出：站主牌翻回原位，恢复成叠牌
   纯 CSS :hover 触发，与滚动/页面跳转无关。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const card = document.querySelector('.card-info')
  if (!card) return
  if (card.querySelector('.poker-deck')) return

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

  // 站主卡内容（克隆到顶牌，去掉重复的按钮 id，避免 id 冲突）
  const ownerHTML = card.innerHTML.replace(/\sid="card-info-btn"/g, '')

  // ---------- 构造扑克牌堆 ----------
  const deck = document.createElement('div')
  deck.className = 'poker-deck'
  deck.innerHTML = [
    // 顶层：站主牌（默认可见）
    '<div class="poker-card pc-owner">' + ownerHTML + '</div>',
    // 中层：名片牌
    '<div class="poker-card pc-visit">' +
      '<div class="visit-avatar"><img src="' + avatarSrc + '" alt="avatar"></div>' +
      '<div class="visit-name">' + name + '</div>' +
      '<div class="visit-contacts">' +
        '<a class="visit-contact" href="mailto:' + config.email + '"><i class="fas fa-envelope"></i><span>' + config.email + '</span></a>' +
        '<div class="visit-contact"><i class="fab fa-weixin"></i><span>' + config.wechat + '</span></div>' +
      '</div>' +
      '<a class="visit-follow" target="_blank" rel="noopener" href="' + (followHref || config.github) + '"><i class="fab fa-github"></i><span>' + config.btnText + '</span></a>' +
    '</div>',
    // 底层：牌背（露出边缘，强化"一叠牌"的立体感）
    '<div class="poker-card pc-back"></div>'
  ].join('')

  // 清空卡片原有内容，只保留牌堆（否则原站主内容和克隆内容会叠加）
  card.innerHTML = ''
  card.appendChild(deck)
})()
