/* ============================================================
   代码块行号对齐（配合"长行自动换行"）
   ------------------------------------------------------------
   背景：为了让代码"完整显示"，v15 起代码行改为 pre-wrap 自动换行。
   但 Shiki 的行号在独立的 .gutter 列里，每行高度固定，一旦代码行
   换成多行，行号就会整体错位（1 号行占 4 行时，2/3/4 号挤在上面）。

   做法：读取每条代码行的实际高度，重建 gutter 为等高块 ——
   每个行号的高度 = 该代码行的视觉行数 × computed line-height(22.4px)。
   注意不能直接用 inline 元素的 rect 高度：那只是字体内容盒(17px)，
   比真实行高小 5.4px，会导致行号逐行上漂 + 行号块内容溢出画滚动条。
   字体加载完成 / 窗口尺寸变化 / 图片懒加载后都会重算。
   ============================================================ */
(function () {
  'use strict'

  // 一条代码行实际占用的"视觉行数"（长行换行后可能 >1）
  // 用 Range.getClientRects() 取每段文本的行盒，按 top 聚类去重：
  // 同一视觉行上的多个 token 片段 top 相同 → 只算一行。
  function visualLines(el, lh) {
    var range = document.createRange()
    range.selectNodeContents(el)
    var rects = range.getClientRects()
    var tops = []
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i]
      if (!r.width && !r.height) continue
      tops.push(r.top)
    }
    if (!tops.length) return 1
    tops.sort(function (a, b) { return a - b })
    var count = 1
    for (var k = 1; k < tops.length; k++) {
      if (tops[k] - tops[k - 1] > lh * 0.5) count++
    }
    return count
  }

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
    if (!n) return
    // 行高必须取 computed line-height（22.4px），不能用 inline 元素的
    // getBoundingClientRect().height —— 后者只是字体内容盒高度（17px），
    // 比真实行高小 5.4px，会让行号逐行向上漂移，并让行号块内容溢出
    // 触发迷你滚动条。
    var lh = parseFloat(getComputedStyle(codeLines[0]).lineHeight)
    for (var j = 0; j < n; j++) {
      var h = lh
        ? visualLines(codeLines[j], lh) * lh
        : codeLines[j].getBoundingClientRect().height
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
