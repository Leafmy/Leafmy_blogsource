'use strict'

hexo.extend.helper.register('inject_head_js', function () {
  const { darkmode, aside, pjax } = this.theme
  // [本站定制] darkmode.start / darkmode.end（按小时自动切换）已不再使用：
  // 亮色模式取消后启动主题恒为 dark，无需时段判断。
  const { theme_color: themeColor } = hexo.theme.config
  const themeColorLight = themeColor && themeColor.enable ? themeColor.meta_theme_color_light : '#ffffff'
  const themeColorDark = themeColor && themeColor.enable ? themeColor.meta_theme_color_dark : '#0d0d0d'

  const createCustomJs = () => `
    const saveToLocal = {
      set: (key, value, ttl) => {
        const data = { value }

        if (ttl != null) {
          data.expiry = Date.now() + ttl * 86400000
        }

        localStorage.setItem(key, JSON.stringify(data))
      },
      get: key => {
        const itemStr = localStorage.getItem(key)
        if (!itemStr) return

        try {
          const data = JSON.parse(itemStr)

          if (data.expiry && Date.now() > data.expiry) {
            localStorage.removeItem(key)
            return
          }

          return data.value
        } catch {
          localStorage.removeItem(key)
        }
      }
    }

    const scriptCache = new Map()
    const cssCache = new Map()
    window.btf = {
      saveToLocal,
      getScript: (url, attr = {}) => {
        if (scriptCache.has(url)) {
          return scriptCache.get(url)
        }

        const promise = new Promise((resolve, reject) => {
          const script = document.createElement('script')

          script.src = url
          script.async = true

          for (const key in attr) {
            script.setAttribute(key, attr[key])
          }

          script.onload = resolve
          script.onerror = reject

          document.head.appendChild(script)
        })

        scriptCache.set(url, promise)

        return promise
      },
      getCSS: (url, id) => {
        if (cssCache.has(url)) {
          return cssCache.get(url)
        }

        const promise = new Promise((resolve, reject) => {
          const link = document.createElement('link')

          link.rel = 'stylesheet'
          link.href = url

          if (id) {
            link.id = id
          }

          link.onload = resolve
          link.onerror = reject

          document.head.appendChild(link)
        })

        cssCache.set(url, promise)

        return promise
      },
      addGlobalFn: (key, fn, name = false, parent = window) => {
        if (!${pjax.enable} && key.startsWith('pjax')) return
        const globalFn = parent.globalFn || {}
        globalFn[key] = globalFn[key] || {}
        globalFn[key][name || Object.keys(globalFn[key]).length] = fn
        parent.globalFn = globalFn
      }
    }
  `

  const createDarkmodeJs = () => {
    if (!darkmode.enable) return ''

    let darkmodeJs = `
      const metaThemeColor = document.querySelector('meta[name="theme-color"]')
      const activateDarkMode = () => {
        document.documentElement.dataset.theme = 'dark'
        if (metaThemeColor !== null) {
          metaThemeColor.setAttribute('content', '${themeColorDark}')
        }
      }
      const activateLightMode = () => {
        document.documentElement.dataset.theme = 'light'
        if (metaThemeColor !== null) {
          metaThemeColor.setAttribute('content', '${themeColorLight}')
        }
      }

      btf.activateDarkMode = activateDarkMode
      btf.activateLightMode = activateLightMode

      /* [本站定制] 亮色模式已取消：背景是太空场景（木星 + 木星环 + 流星），
         毛玻璃只作用在文字面板上，这两种外观都只对深色成立。
         因此这里不再读 saveToLocal 里的 'theme'，也不再跟随系统/时段，
         永远激活 dark —— 老旧浏览器里残留的 'theme: light' 不会再让页面
         闪一下亮色。activateLightMode 仍保留（第三方部件可能引用），
         但站点内已无任何调用路径。 */
      activateDarkMode()
    `

    return darkmodeJs
  }

  const createAsideStatusJs = () => {
    if (!aside.enable || !aside.button) return ''
    return `
      const asideStatus = saveToLocal.get('aside-status')
      if (asideStatus !== undefined) {
        document.documentElement.classList.toggle('hide-aside', asideStatus === 'hide')
      }
    `
  }

  const createDetectAppleJs = () => `
    const detectApple = () => {
      if (/iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent)) {
        document.documentElement.classList.add('apple')
      }
    }
    detectApple()
  `

  /* [本站定制] hero 站名的"组装期间先藏住"标记
     ------------------------------------------------------------
     这是 <head> 里最早能执行的位置，必须在这里打标记：<h1> 的文字在文档解析到
     hero 时就存在，而 split-title.js 要等它自己被加载才执行。中间那段时间
     custom-font.css 里 `#site-title:not([data-qm])` 的兜底动画会立刻跑起来
     （0% = 填充透明 + 2.6px 描边），用户看到"完整轮廓亮一下再重来"。
     标记一打，CSS 就把 hero 站名 visibility:hidden；split-title.js 组装完
     （成功或兜底）在同一个任务里摘掉它，因此纯文字一帧都不会上屏。

     setTimeout 是保命用的：拆分脚本万一 404 或抛错，标记会一直挂着、首页
     连站名都没有。3 秒后无条件放出来 —— 那时宁可让它闪一下，也不能空着。 */
  const createTitlePendingJs = () => `
    document.documentElement.classList.add('qm-pending')
    setTimeout(() => {
      document.documentElement.classList.remove('qm-pending')
    }, 3000)
  `

  return `<script>
    (() => {
      ${createCustomJs()}
      ${createDarkmodeJs()}
      ${createAsideStatusJs()}
      ${createDetectAppleJs()}
      ${createTitlePendingJs()}
    })()
  </script>`
})
