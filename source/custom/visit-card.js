/* ============================================================
   Visit card — swap text (custom inject, v9)
   个人信息卡（.card-info）双人切换：
   - 默认显示站主 l3AFovxs（蓝发侦探头像）
   - 鼠标移入：名字+简介先模糊淡出 -> 换成 HexShane（斗篷头像）+ 简介「卡密」-> 清晰浮现
   - 鼠标移出：换回站主
   - 头像去掉 hover 旋转；文字切换带模糊遮罩过渡，无整卡动画。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const card = document.querySelector('.card-info')
  if (!card) return
  if (card.querySelector('.swap-text')) return

  // ---------- 两人信息 ----------
  const config = {
    owner: {
      name: 'l3AFovxs',
      avatar: '/img/l3afovxs.jpg',
      desc: ''   // 站主默认不显示额外简介（用主题默认 description）
    },
    visit: {
      name: 'HexShane',
      avatar: '/img/hexshane.jpg',
      desc: '卡密'   // 名片简介
    }
  }

  const avatarImg = card.querySelector('.avatar-img img')
  const ownerNameEl = card.querySelector('.author-info-name')
  const descriptionEl = card.querySelector('.author-info-description')

  // 单一容器，包住名字/简介切换区（头像单独处理，site-data 留在原处）
  const swap = document.createElement('div')
  swap.className = 'swap-text'

  const moveEl = function (el) { if (el && el.parentNode === card) swap.appendChild(el) }
  moveEl(ownerNameEl)
  moveEl(descriptionEl)

  avatarImg && avatarImg.closest('.avatar-img')
    ? avatarImg.closest('.avatar-img').insertAdjacentElement('afterend', swap)
    : card.appendChild(swap)

  // 存档站主态完整 HTML（名字+简介），名片态 HTML
  const ownerHTML = swap.innerHTML
  const visitHTML =
    '<div class="author-info-name">' + config.visit.name + '</div>' +
    '<div class="author-info-description">' + config.visit.desc + '</div>'

  // ---------- 切换逻辑：先模糊 -> 换字 -> 再清晰（柔和，硬变） ----------
  let state = 'owner'   // owner | visit
  let timer = null

  const applyWithBlur = function (html, avatar, nextState) {
    clearTimeout(timer)
    // ① 文字先模糊淡出
    swap.classList.add('swapping')
    timer = setTimeout(function () {
      // ② 模糊到看不清时换字 + 换头像
      swap.innerHTML = html
      if (avatarImg) avatarImg.src = avatar
      state = nextState
      // ③ 去模糊，文字清晰浮现
      swap.classList.remove('swapping')
    }, 220)
  }

  card.addEventListener('mouseenter', function () {
    if (state !== 'visit') applyWithBlur(visitHTML, config.visit.avatar, 'visit')
  })
  card.addEventListener('mouseleave', function () {
    if (state !== 'owner') applyWithBlur(ownerHTML, config.owner.avatar, 'owner')
  })
})()
