/* ============================================================
   Visit card — swap text (custom inject, v8)
   个人信息卡（.card-info）双人切换，无动画：
   - 默认显示站主 l3AFovxs（蓝发侦探头像）
   - 鼠标移入：直接换成 HexShane（斗篷头像）+ 简介「卡密」
   - 鼠标移出：直接换回站主
   头像/名字/简介瞬间切换，无 Follow 按钮，无动画。
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

  // ---------- 切换逻辑：瞬间切换，无动画 ----------
  let state = 'owner'   // owner | visit

  const apply = function (html, avatar, nextState) {
    swap.innerHTML = html
    if (avatarImg) avatarImg.src = avatar
    state = nextState
  }

  card.addEventListener('mouseenter', function () {
    if (state !== 'visit') apply(visitHTML, config.visit.avatar, 'visit')
  })
  card.addEventListener('mouseleave', function () {
    if (state !== 'owner') apply(ownerHTML, config.owner.avatar, 'owner')
  })
})()
