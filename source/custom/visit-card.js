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

  // ---------- 换字逻辑：先模糊 → 换字 → 再清晰，高度走非线性曲线 ----------
  let state = 'owner'   // owner | visit
  let timer = null

  // 离屏测量某套文案的自然高度（用于高度过渡）
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

  const swapTo = function (nextHTML, nextState) {
    clearTimeout(timer)
    // ① 锁住当前高度，开始模糊淡出
    swap.style.height = swap.offsetHeight + 'px'
    swap.classList.add('swapping')
    timer = setTimeout(function () {
      // ② 模糊到看不清时，同一位置换字
      swap.innerHTML = nextHTML
      // ③ 高度平滑过渡到新文案的自然高度（非线性曲线）
      swap.style.height = measureHeight(nextHTML) + 'px'
      swap.classList.remove('swapping')
      state = nextState
      // ④ 过渡结束后释放锁定高度（回到 auto，避免挤压残留）
      clearTimeout(timer)
      timer = setTimeout(function () {
        swap.style.height = ''
      }, 360)
    }, 320)
  }

  card.addEventListener('mouseenter', function () {
    if (state !== 'visit') swapTo(visitHTML, 'visit')
  })
  card.addEventListener('mouseleave', function () {
    if (state !== 'owner') swapTo(ownerHTML, 'owner')
  })
})()
