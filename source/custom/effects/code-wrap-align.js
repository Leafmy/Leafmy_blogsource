/* ============================================================
   代码块行号对齐（配合"长行自动换行"）
   ------------------------------------------------------------
   背景：为了让代码"完整显示"，v15 起代码行改为 pre-wrap 自动换行。
   但 Shiki 的行号在独立的 .gutter 列里，每行高度固定，一旦代码行
   换成多行，行号就会整体错位（1 号行占 4 行时，2/3/4 号挤在上面）。

   做法：读取每条代码行的实际高度，重建 gutter 为等高块 ——
   每个行号的高度 = 对应代码行的高度，数字顶部对齐首行。
   字体加载完成 / 窗口尺寸变化 / 图片懒加载后都会重算。
   ============================================================ */
(function () {
  'use strict'

  function alignOne(fig) {
    var gutterPre = fig.querySelector('.gutter pre')
    var codeLines = fig.querySelectorAll('.code .line')
    if (!gutterPre || !codeLines.length) return

    // 首次：把 <span class="line">N</span><br> 结构重建成块级行号
    if (gutterPre.getAttribute('data-wrapped') !== '1') {
      var nums = Array.prototype.map.call(gutterPre.querySelectorAll('.line'), function (el) {
        return el.textContent
      })
      if (!nums.length) return
      gutterPre.textContent = ''
      for (var i = 0; i < nums.length; i++) {
        var d = document.createElement('span')
        d.className = 'line-num'
        d.textContent = nums[i]
        gutterPre.appendChild(d)
      }
      gutterPre.setAttribute('data-wrapped', '1')
    }

    var rows = gutterPre.children
    var n = Math.min(rows.length, codeLines.length)
    for (var j = 0; j < n; j++) {
      var h = codeLines[j].getBoundingClientRect().height
      rows[j].style.height = h + 'px'
    }
  }

  function alignAll() {
    var figs = document.querySelectorAll('figure.shiki')
    for (var i = 0; i < figs.length; i++) alignOne(figs[i])
  }

  var timer = 0
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(alignAll, 120)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule)
  } else {
    schedule()
  }
  window.addEventListener('load', schedule)
  window.addEventListener('resize', schedule)
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule)
})()
