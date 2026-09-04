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
  // 内联 GitHub SVG 图标，规避个别上下文 Font Awesome 渲染问题，确保始终可见
  const githubIcon = '<svg class="vt-github-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path></svg>'
  const visitHTML = [
    '<div class="vt-name">' + name + '</div>',
    '<div class="vt-desc">' + config.email + '</div>',
    '<div class="vt-data">' + config.wechat + '</div>',
    '<a class="vt-follow" target="_blank" rel="noopener" href="' + btnHref + '">' + githubIcon + '<span>Follow Me</span></a>'
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
