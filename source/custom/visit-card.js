/* ============================================================
   Visit card — swap text in place (custom inject, v7)
   个人信息卡（.card-info）双人切换：
   - 默认显示站主 l3AFovxs（蓝发侦探头像）
   - 鼠标移入：头像+名字平滑模糊淡出 → 换成 HexShane（斗篷头像）+
     简介「卡密」→ 再清晰浮现
   - 鼠标移出：换回站主
   名字/头像/简介一起换，无 Follow 按钮，无整卡遮罩。
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

  // 主题默认站主名/简介/头像（作为游标存档）
  const ownerName = config.owner.name || (ownerNameEl ? ownerNameEl.textContent : '')
  const avatarPath = config.owner.avatar || ''

  // 单一容器，包住名字/简介/头像切换区（不含 .site-data 数据行）
  const swap = document.createElement('div')
  swap.className = 'swap-text'

  // 把名字和简介移进 swap（头像单独处理，site-data 留在原处）
  const moveEl = function (el) { if (el && el.parentNode === card) swap.appendChild(el) }
  moveEl(ownerNameEl)
  moveEl(descriptionEl)

  // 把 swap 插到头像之后
  avatarImg && avatarImg.closest('.avatar-img')
    ? avatarImg.closest('.avatar-img').insertAdjacentElement('afterend', swap)
    : card.appendChild(swap)

  // 存档站主态完整 HTML（名字+简介），名片态 HTML
  const ownerHTML = swap.innerHTML
  const visitHTML =
    '<div class="author-info-name">' + config.visit.name + '</div>' +
    '<div class="author-info-description">' + config.visit.desc + '</div>'

  // ---------- 换字逻辑：先模糊 → 换字+换头像 → 再清晰 ----------
  let state = 'owner'   // owner | visit
  let timer = null

  // 离屏测量某套文案的自然高度
  const measureHeight = function (html) {
    const clone = document.createElement('div')
    clone.className = 'swap-text'
    clone.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:-9999px;top:0;'
    clone.style.width = swap.offsetWidth + 'px'
    clone.innerHTML = html
    document.body.appendChild(clone)
    const h = clone.offsetHeight
    document.body.removeChild(clone)
    return h
  }

  const swapTo = function (nextHTML, nextName, nextAvatar, nextState) {
    clearTimeout(timer)
    swap.style.height = swap.offsetHeight + 'px'
    swap.classList.add('swapping')
    timer = setTimeout(function () {
      // 换字 + 换头像
      swap.innerHTML = nextHTML
      // 头像切到对应的人
      const img = avatarImg
      if (img) {
        img.style.opacity = '0'
        setTimeout(function () {
          img.src = nextAvatar
          img.style.opacity = '1'
        }, 200)
      }
      // 高度平滑过渡到新文案自然高度
      swap.style.height = measureHeight(nextHTML) + 'px'
      swap.classList.remove('swapping')
      state = nextState
      clearTimeout(timer)
      timer = setTimeout(function () { swap.style.height = '' }, 360)
    }, 320)
  }

  card.addEventListener('mouseenter', function () {
    if (state !== 'visit') {
      swapTo(visitHTML, config.visit.name, config.visit.avatar, 'visit')
    }
  })
  card.addEventListener('mouseleave', function () {
    if (state !== 'owner') {
      swapTo(ownerHTML, config.owner.name, config.owner.avatar, 'owner')
    }
  })
})()
