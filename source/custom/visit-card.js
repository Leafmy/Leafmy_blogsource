/* ============================================================
   Visit card — swap text in place (custom inject, v5)
   个人信息卡（.card-info，站主 Leaf 卡）：
   - 只改变"文字信息区"，头像与卡片背景/布局完全不动
   - 默认：显示站主原文字（名字、描述、文章/标签/分类、Follow）
   - 鼠标移入：原文字高斯模糊淡出，名片文字原位淡入
     （名字→名字、描述→邮箱、数据→联系方式、按钮→Follow）
   - 鼠标移出：恢复原文字
   头像(.avatar-img)不参与变换，纯 CSS :hover，无整卡遮罩。
   ============================================================ */
(function () {
  'use strict'

  document.documentElement.classList.add('js')

  const card = document.querySelector('.card-info')
  if (!card) return
  if (card.querySelector('.text-swap')) return

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

  // 把原卡的"文字信息区"打包成一层（不含头像）
  const textLayer = document.createElement('div')
  textLayer.className = 'owner-text'
  // 依次移动：名字、描述、数据、按钮
  ;['.author-info-name', '.author-info-description', '.site-data', '#card-info-btn'].forEach(function (sel) {
    const el = card.querySelector(sel)
    if (el) textLayer.appendChild(el)
  })

  // 名片文字层（与原文字层同位置叠放）
  const visitLayer = document.createElement('div')
  visitLayer.className = 'visit-text'
  visitLayer.innerHTML = [
    '<div class="vt-name">' + name + '</div>',
    '<div class="vt-desc">' + config.email + '</div>',
    '<div class="vt-data">' + config.wechat + '</div>',
    '<a class="vt-follow" target="_blank" rel="noopener" href="' + btnHref + '"><i class="fab fa-github"></i><span>Follow Me</span></a>'
  ].join('')

  // 组装：两层叠放进 swap 容器，头像保持在上方
  const swap = document.createElement('div')
  swap.className = 'text-swap'
  swap.appendChild(textLayer)
  swap.appendChild(visitLayer)

  // 把 swap 插到头像之后（头像不动），其余不动
  avatar ? avatar.insertAdjacentElement('afterend', swap) : card.appendChild(swap)
})()
