/* ============================================================
   修复 hexo-shiki-plugin-butterfly 代码围栏正则的贪心 bug
   ------------------------------------------------------------
   插件 index.js 里的 codeMatch:
     /(?<quote>[> ]*)(?<ul>(-|\d+\.)?)(?<start>\s*)(?<tick>~{3,}|`{3,}) *(?<args>.*)\n
      (?<code>[\s\S]*?)\k<quote>\s*\k<tick>(?<end>\s*)$/gm

   问题出在 (?<quote>[> ]*)：它除了匹配引用/缩进前缀，还会把
   「围栏前一行行尾的空格」一起吃进去；而闭合围栏又要求同样的
   \k<quote> 前缀。于是只要某个 ``` 的上一行有行尾空格，
   正则就跳过本该闭合的那个 ```，一路吞到后面某个「上一行也以
   空格结尾」的 ``` 为止 —— 多个代码块被合并成一个超长代码块，
   中间所有正文都变成代码。

   实测（修复前）：
     tmodloader-basic-modprojectile.md  源码 22 个代码块 -> 只渲染 6 个（其中一个吞了 318 行）
     tmodloader-basic-recipe.md         源码 20 个代码块 -> 只渲染 18 个

   修法：在插件之前把「紧邻代码围栏的那一行」的行尾空白去掉，
   quote 恒为空串，闭合围栏就能在第一个 ``` 处正常结束。
   - 优先级 5 < 插件默认的 10，所以本过滤器先于插件执行；
   - 只影响紧邻围栏的那一行，正文里的 markdown 硬换行（行尾两空格）不受影响。
   ============================================================ */
'use strict'

hexo.extend.filter.register(
  'before_post_render',
  function (post) {
    var content = post && post.content
    if (!content) return
    if (content.indexOf('```') === -1 && content.indexOf('~~~') === -1) return
    post.content = content.replace(/[ \t]+(?=\r?\n[ \t]*(?:`{3,}|~{3,}))/g, '')
  },
  5
)
