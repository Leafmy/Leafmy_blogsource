/* ============================================================
   Visit card — card stack (custom inject)
   个人信息卡（.card-info，站主 Leaf 卡）做成"卡片堆叠"：
   - 默认显示站主卡（底层）
   - 鼠标悬浮时，克隆出的「名片卡」从上方滑下盖住站主卡
   - 鼠标移出 -> 名片卡缩回上方隐藏
   名片卡基于站主卡信息自动生成（头像 + 名字 + 联系方式 + Follow），
   内容可在下方 config 对象自定义。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const card = document.querySelector('.card-info')
  if (!card) return
  if (card.querySelector('.visit-card')) return

  // ---------- 名片卡配置（可按需修改） ----------
  const config = {
    contact: {                       // 联系方式（`<i>` 用 FontAwesome）
      email: 'leaf@example.com',
      github: 'https://github.com/xxxxxx',
      wechat: '微信：Leaf-dev'       // 可换成微信号文本
    },
    btnText: 'Follow Me'
  }

  // 取站主头像与名字
  const avatar = card.querySelector('.avatar-img img')
  const avatarSrc = avatar ? avatar.getAttribute('src') : ''
  const name = (card.querySelector('.author-info-name') || {}).textContent || 'Leaf'
  const followHref = card.querySelector('#card-info-btn')
    ? card.querySelector('#card-info-btn').getAttribute('href') : ''

  // ---------- 构造名片卡（absolute 覆盖在站主卡上） ----------
  const visit = document.createElement('div')
  visit.className = 'visit-card'
  visit.innerHTML = [
    '<div class="visit-card-avatar"><img src="' + avatarSrc + '" alt="avatar"></div>',
    '<div class="visit-card-name">' + name + '</div>',
    '<div class="visit-card-contacts">',
    '  <a class="visit-contact" href="mailto:' + config.contact.email + '"><i class="fas fa-envelope"></i><span>' + config.contact.email + '</span></a>',
    '  <div class="visit-contact"><i class="fab fa-weixin"></i><span>' + config.contact.wechat + '</span></div>',
    '</div>',
    '<a id="card-info-btn" class="visit-follow" target="_blank" rel="noopener" href="' + (followHref || config.contact.github) + '"><i class="fab fa-github"></i><span>' + config.btnText + '</span></a>'
  ].join('')

  // 使站主卡成为定位上下文
  card.style.position = 'relative'
  card.appendChild(visit)
})()
