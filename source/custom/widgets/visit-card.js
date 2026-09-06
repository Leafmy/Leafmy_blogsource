/* ============================================================
   Visit card — swap text (custom inject, v10)
   个人信息卡（.card-info）双人切换，桌面与移动端行为一致：
   - 默认显示站主 l3AFovxs（蓝发侦探头像）
   - 桌面（hover 设备）：鼠标移入换成 HexShane（斗篷头像）+ 简介「卡密」，
     移出换回站主——天然的"进/出"双向切换。
   - 移动（触屏/无 hover 设备）：点击整卡在「站主 <-> 我」之间反复切换
     （问题4：支持双向切换，点一次换、再点一次换回）；
     点击头像直接切到「我的头像」（问题7）。
     —— 因为触屏没有 mouseenter/mouseleave，之前这套逻辑在手机上完全失效，
        点一下能换、再点无法换回。现在用 click 双向 toggle 实现等价交互。
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
  let state = 'owner'   // owner | visit（当前实际显示者）
  let desired = 'owner' // 用户当前期望显示者（enter=visit, leave=owner）
  let timer = null
  let imgTimer = null

  const applyWithBlur = function (html, avatar, nextState) {
    clearTimeout(timer)
    // ① 文字先模糊淡出
    swap.classList.add('swapping')
    timer = setTimeout(function () {
      // 竞态保护：延迟 220ms 后，若用户期望的目标已经变了（例如快速移出），
      // 则放弃这次换字，改为按新的期望重新切换，避免卡在 visit 不回站主。
      if (desired !== nextState) {
        const reHtml = desired === 'visit' ? visitHTML : ownerHTML
        const reAvatar = desired === 'visit' ? config.visit.avatar : config.owner.avatar
        applyWithBlur(reHtml, reAvatar, desired)
        return
      }
      // ② 模糊到看不清时换字 + 换头像（头像变化时旋转一下）
      swap.innerHTML = html
      if (avatarImg) {
        // 触发头像旋转动画（@keyframes 0.6s，播完自动定格，无逆时针回退）
        avatarImg.classList.add('spin')
        clearTimeout(imgTimer)
        // 旋转进行到约半程时切换新图（旧图转半圈变新图）
        imgTimer = setTimeout(function () {
          avatarImg.src = avatar
        }, 260)
        // 动画结束后移除类（无 transition，瞬间复位，不会倒转）
        setTimeout(function () {
          avatarImg.classList.remove('spin')
          avatarImg.style.transform = ''
        }, 640)
      }
      state = nextState
      // ③ 去模糊，文字清晰浮现
      swap.classList.remove('swapping')
    }, 220)
  }

  // ---------- 事件：桌面 hover 进出 / 移动点击双向切换 ----------
  const hasHover = window.matchMedia('(hover: hover)').matches
  const isCoarse = window.matchMedia('(pointer: coarse)').matches

  // 统一：把当前期望指向某个状态并触发切换（防抖/竞态由 applyWithBlur 处理）
  const setDesired = function (next) {
    desired = next
    if (state !== next) {
      applyWithBlur(
        next === 'visit' ? visitHTML : ownerHTML,
        next === 'visit' ? config.visit.avatar : config.owner.avatar,
        next
      )
    }
  }

  // 桌面 / 精确指针设备：沿用 hover 进出（已是双向：进=visit，出=owner）
  // 与触屏 click 分支互斥，避免混合设备重复绑定
  if (hasHover && !isCoarse) {
    card.addEventListener('mouseenter', function () { setDesired('visit') })
    card.addEventListener('mouseleave', function () { setDesired('owner') })
  }

  // 触屏 / 无 hover 设备：click 双向 toggle（点一下换另一人，再点一次换回）
  // —— 修复"点开换过去后，再点无法切回"的问题（问题4）
  // —— 同时支持点头像直接切到「我」（问题7）
  // toggle 基于 desired 翻转：即使处于 220ms 模糊过渡中，快速连点也会正确换向
  // 注意: 纯鼠标(hasHover && !isCoarse)走上面 hover 分支; 触屏(含支持触屏的
  // 混合笔记本, 因其 isCoarse=true)都走这里——保证任何设备都能双向切换。
  if (!hasHover || isCoarse) {
    card.addEventListener('click', function (e) {
      e.stopPropagation()
      setDesired(desired === 'visit' ? 'owner' : 'visit')
    })

    // 头像点击：直接切换成"我的头像"（切换到我侧）
    if (avatarImg && avatarImg.closest('.avatar-img')) {
      const avatarWrap = avatarImg.closest('.avatar-img')
      avatarWrap.addEventListener('click', function (e) {
        e.stopPropagation()
        setDesired('visit')
      })
    }

    // 点击卡片外部时，回到站主默认态
    document.addEventListener('click', function (e) {
      if (!card.contains(e.target)) setDesired('owner')
    })
  }
})()
