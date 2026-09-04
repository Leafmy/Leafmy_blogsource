/* ============================================================
   Visit card — swap text in place (custom inject, v6)
   个人信息卡（.card-info，站主 Leaf 卡）：
   - 只改变"文字信息区"，头像与卡片背景/布局完全不动
   - 单一文本元素原位变换：默认显示站主文字；鼠标移入时
     文字先高斯模糊淡出 → 同一位置换成名片文字 → 再清晰浮现
   - 鼠标移出：同样先模糊 → 换回站主文字 → 清晰浮现
   全程只有一段文字在变，无两层叠放、无整卡遮罩。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const card = document.querySelector('.card-info')
  if (!card) return
  if (card.querySelector('.swap-text')) return

  // ---------- 名片信息（可按需修改） ----------
  const config = {
    email: 'leaf@example.com',
    wechat: '微信：Leaf-dev',
    github: 'https://github.com/xxxxxx'
  }

  const avatar = card.querySelector('.avatar-img')
  const name = (card.querySelector('.author-info-name') || {}).textContent || 'Leaf'
  const btn = card.querySelector('#card-info-btn')
  const btnHref = btn ? btn.getAttribute('href') : (config.github || '')

  // 单一文本容器，包住文字信息区（不含头像）
  const swap = document.createElement('div')
  swap.className = 'swap-text'
  ;['.author-info-name', '.author-info-description', '.site-data', '#card-info-btn'].forEach(function (sel) {
    const el = card.querySelector(sel)
    if (el) swap.appendChild(el)
  })

  // 存档"站主"与"名片"两套文案（换字用）
  const ownerHTML = swap.innerHTML
  const visitHTML = [
    '<div class="vt-name">' + name + '</div>',
    '<div class="vt-desc">' + config.email + '</div>',
    '<div class="vt-data">' + config.wechat + '</div>',
    '<a class="vt-follow" target="_blank" rel="noopener" href="' + btnHref + '"><i class="fab fa-github"></i><span>Follow Me</span></a>'
  ].join('')

  // 把 swap 插到头像之后（头像不动）
  avatar ? avatar.insertAdjacentElement('afterend', swap) : card.appendChild(swap)

  // ---------- 换字逻辑：先模糊 → 换字 → 再清晰 ----------
  let state = 'owner'   // owner | visit
  let timer = null

  const swapTo = function (nextHTML, nextState) {
    swap.classList.add('swapping')            // ① 开始模糊淡出
    clearTimeout(timer)
    timer = setTimeout(function () {
      swap.innerHTML = nextHTML              // ② 模糊到看不清时，同一位置换字
      swap.classList.remove('swapping')      // ③ 文字清晰浮现
      state = nextState
    }, 320)
  }

  card.addEventListener('mouseenter', function () {
    if (state !== 'visit') swapTo(visitHTML, 'visit')
  })
  card.addEventListener('mouseleave', function () {
    if (state !== 'owner') swapTo(ownerHTML, 'owner')
  })
})()
