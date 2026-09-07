/* ============================================================
   文章翻译按钮 - 双模式版
   ------------------------------------------------------------
   功能：
   1. 在文章标题旁显示翻译按钮 + 设置齿轮（与搜索栏同款毛玻璃）
   2. 优先读取预生成的 /translations/[slug].json（构建时 DeepL / 兼容）
   3. 若无预翻译数据，则运行时调用 DeepSeek API 即时翻译
   4. 翻译结果缓存到 localStorage
   5. API Key 以「编码 + XOR 混淆 + CRC 校验」形式存 localStorage，
      不落明文（说明：纯哈希不可逆无法调用 API，此为可逆混淆，防源码/落盘明文）

   翻译流程：
   ① loading（跑马灯+流光字 → 运行时翻译请求中）→ ② UI放大 → ③ 文字变更
   → ④ 内容替换

   回退流程：
   ① 文字变更 → ② 内容替换 → ③ UI缩小
   ============================================================ */
(function () {
  'use strict'

  // ==================== 通用工具 ====================
  function utf8ToBytes(str) {
    return new TextEncoder().encode(str)
  }
  function bytesToString(bytes) {
    return new TextDecoder().decode(new Uint8Array(bytes))
  }
  // CRC32 校验（用于检测 key 是否被篡改/损坏）
  var crcTable = (function () {
    var table = []
    for (var n = 0; n < 256; n++) {
      var c = n
      for (var k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      }
      table[n] = c >>> 0
    }
    return table
  })()
  function crc32(str) {
    var bytes = utf8ToBytes(str)
    var crc = 0xFFFFFFFF
    for (var i = 0; i < bytes.length; i++) {
      crc = (crc >>> 8) ^ crcTable[(crc ^ bytes[i]) & 0xFF]
    }
    return (crc ^ 0xFFFFFFFF) >>> 0
  }

  // ==================== Key 混淆编码 ====================
  // 纯哈希不可逆无法用于 API 调用，这里用「可逆混淆」：
  // UTF-8 字节 -> XOR(轮换 mask) -> base64，附加 CRC 校验。
  // 浏览器 localStorage 中不出现明文 key。
  var XORMASK = [0x5a, 0x2f, 0x7c, 0x1b, 0x4d, 0x6e]
  function maskKey(bytes) {
    var out = new Uint8Array(bytes.length)
    for (var i = 0; i < bytes.length; i++) {
      out[i] = bytes[i] ^ XORMASK[i % XORMASK.length]
    }
    return out
  }
  function encodeKey(raw) {
    try {
      var ob = maskKey(utf8ToBytes(raw))
      var b64 = btoa(String.fromCharCode.apply(null, ob))
      return 'WBSK1.' + b64 + '.' + crc32(raw).toString(16)
    } catch (e) {
      return ''
    }
  }
  function decodeKey(stored) {
    if (!stored || stored.indexOf('WBSK1.') !== 0) return ''
    var parts = stored.split('.')
    if (parts.length < 3) return ''
    var b64 = parts[1]
    var crcHex = parts[2]
    var ob
    try {
      ob = atob(b64).split('').map(function (c) {
        return c.charCodeAt(0) & 0xFF
      })
    } catch (e) {
      return ''
    }
    var obArr = new Uint8Array(ob.length)
    for (var i = 0; i < ob.length; i++) obArr[i] = ob[i]
    var ob2 = maskKey(obArr) // XOR 对称，再掩一次还原
    var raw = bytesToString(ob2)
    if (crc32(raw).toString(16) !== crcHex) return '' // 校验失败视为无效
    return raw
  }

  // 只在文章页生效
  var postContent = document.querySelector('#post-content') || document.querySelector('.post-content')
  if (!postContent) return

  // 获取文章元信息
  var titleEl = document.querySelector('.post-title')
  var slug = window.location.pathname.replace(/\/$/, '').split('/').pop()

  // 检查是否已有翻译按钮
  if (document.querySelector('.translate-btn-wrap')) return

  // 存储 key 的 localStorage 键
  var KEY_STORE = 'deepseek_translate_key'
  // 翻译缓存键
  var cacheKey = 'translate_' + slug

  // ==================== 创建按钮组 ====================
  var btnWrap = document.createElement('span')
  btnWrap.className = 'translate-btn-wrap'
  btnWrap.innerHTML =
    '<button class="translate-btn" title="翻译本文">' +
      '<i class="fas fa-language"></i>' +
      '<span class="translate-text">翻译</span>' +
    '</button>' +
    '<button class="translate-settings-btn" title="设置 DeepSeek API">' +
      '<i class="fas fa-cog"></i>' +
    '</button>'

  if (titleEl) {
    titleEl.appendChild(btnWrap)
  }

  var btn = btnWrap.querySelector('.translate-btn')
  var translateText = btnWrap.querySelector('.translate-text')
  var settingsBtn = btnWrap.querySelector('.translate-settings-btn')

  var isTranslated = false
  var isAnimating = false
  var translationData = null
  // 当前生效的明文 key（运行时从 localStorage 解析得到）
  var deepseekKey = decodeKey(localStorage.getItem(KEY_STORE))

  // ==================== 目标语言检测 ====================
  function isMainlyChinese(text) {
    var clean = text.replace(/[\s\d.,;:?\-()[\]{}]/g, '')
    if (clean.length === 0) return true
    var chinese = 0
    for (var i = 0; i < clean.length; i++) {
      if (/[\u4e00-\u9fff]/.test(clean[i])) chinese++
    }
    return chinese / clean.length > 0.3
  }

  // ==================== 设置弹窗 ====================
  var modal = null
  function ensureModal() {
    if (modal) return modal
    var overlay = document.createElement('div')
    overlay.className = 'translate-modal-overlay'
    overlay.innerHTML =
      '<div class="translate-modal">' +
        '<div class="translate-modal-title">设置 DeepSeek API Key</div>' +
        '<div class="translate-modal-desc">' +
          '填入你自己的 DeepSeek API Key（在 platform.deepseek.com 申请）。' +
          'Key 经混淆编码后只存入你浏览器的 localStorage，不会写入源码或上传服务器。' +
        '</div>' +
        '<input type="password" class="translate-key-input" placeholder="sk-..." spellcheck="false" autocomplete="off">' +
        '<div class="translate-modal-status"></div>' +
        '<div class="translate-modal-actions">' +
          '<button class="tm-btn tm-save" type="button">保存</button>' +
          '<button class="tm-btn tm-clear" type="button">清除</button>' +
          '<button class="tm-btn tm-cancel" type="button">取消</button>' +
        '</div>' +
      '</div>'
    document.body.appendChild(overlay)
    modal = overlay

    var input = overlay.querySelector('.translate-key-input')
    var status = overlay.querySelector('.translate-modal-status')
    var saveBtn = overlay.querySelector('.tm-save')
    var clearBtn = overlay.querySelector('.tm-clear')
    var cancelBtn = overlay.querySelector('.tm-cancel')

    function close() {
      overlay.classList.remove('show')
    }

    // 展示当前状态（是否已存 key）
    function refreshStatus() {
      if (deepseekKey) {
        status.className = 'translate-modal-status ok'
        status.textContent = '已保存（sk-****' + deepseekKey.slice(-4) + '）'
        input.value = deepseekKey
      } else {
        status.className = 'translate-modal-status'
        status.textContent = '尚未配置'
        input.value = ''
      }
    }

    saveBtn.addEventListener('click', function () {
      var val = input.value && input.value.trim()
      if (!val) {
        status.className = 'translate-modal-status err'
        status.textContent = '请输入 API Key'
        return
      }
      var enc = encodeKey(val)
      if (!enc) {
        status.className = 'translate-modal-status err'
        status.textContent = '编码失败'
        return
      }
      localStorage.setItem(KEY_STORE, enc)
      deepseekKey = decodeKey(localStorage.getItem(KEY_STORE))
      status.className = 'translate-modal-status ok'
      status.textContent = '已保存'
      setTimeout(close, 800)
    })

    clearBtn.addEventListener('click', function () {
      localStorage.removeItem(KEY_STORE)
      deepseekKey = ''
      refreshStatus()
      status.className = 'translate-modal-status'
      status.textContent = '已清除'
    })

    cancelBtn.addEventListener('click', close)

    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) close()
    })

    refreshStatus()
    return modal
  }

  function openModal() {
    var m = ensureModal()
    m.classList.add('show')
    var input = m.querySelector('.translate-key-input')
    setTimeout(function () { input && input.focus() }, 50)
  }

  settingsBtn.addEventListener('click', openModal)

  // ==================== 预加载翻译数据（兼容构建时 JSON）====================
  function preloadTranslation() {
    // 先检查 localStorage 缓存
    var cached = localStorage.getItem(cacheKey)
    if (cached) {
      try {
        var data = JSON.parse(cached)
        if (data.segments && Object.keys(data.segments).length > 0) {
          translationData = data
          translateText.textContent = '显示原文'
          btn.classList.add('expanded')
          isTranslated = true
          return
        }
      } catch (e) {
        localStorage.removeItem(cacheKey)
      }
    }

    // 从服务器加载预翻译的 JSON
    fetch('/translations/' + slug + '.json', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('No translation')
        return res.json()
      })
      .then(function (data) {
        if (data.segments && Object.keys(data.segments).length > 0) {
          translationData = data
          localStorage.setItem(cacheKey, JSON.stringify(data))
          translateText.textContent = '显示原文'
          btn.classList.add('expanded')
          isTranslated = true
        }
      })
      .catch(function () {
        translationData = null
      })
  }

  preloadTranslation()

  // 翻译按钮点击事件
  btn.addEventListener('click', function () {
    if (isAnimating) return
    if (isTranslated) {
      doRevert()
    } else {
      doTranslate()
    }
  })

  // ==================== 翻译流程 ====================
  function doTranslate() {
    // 有预翻译数据：直接走原有动画
    if (translationData && translationData.segments) {
      runTranslateAnimation(function () { applyTranslation() })
      return
    }

    // 无预翻译数据：尝试运行时 DeepSeek
    if (!deepseekKey) {
      openModal()
      return
    }

    // 运行时翻译：先 loading，再调 API
    btn.classList.add('loading')
    runApiTranslate().then(function (segments) {
      btn.classList.remove('loading')
      if (!segments || Object.keys(segments).length === 0) {
        translateText.style.opacity = '0'
        setTimeout(function () {
          translateText.textContent = '翻译'
          translateText.style.opacity = '1'
        }, 100)
        return
      }
      translationData = { segments: segments }
      localStorage.setItem(cacheKey, JSON.stringify(translationData))
      runTranslateAnimation(function () { applyTranslation() })
    }).catch(function (err) {
      btn.classList.remove('loading')
      showFatal(err && err.message ? err.message : '翻译失败')
    })
  }

  // 动画主流程（含 UI 放大 + 文字变更 + 内容替换）
  function runTranslateAnimation(fn) {
    isAnimating = true
    // ① loading 状态：跑马灯 + 流光字
    btn.classList.add('loading')
    setTimeout(function () {
      // ② 移除 loading → UI 放大 + 文字变更同步开始
      btn.classList.remove('loading')
      btn.classList.add('expanded')
      translateText.style.opacity = '0'
      setTimeout(function () {
        translateText.textContent = '显示原文'
        translateText.style.opacity = '1'
        // ③ 内容渐隐 → 替换 → 渐显
        setTimeout(function () {
          postContent.style.opacity = '0'
          postContent.style.transition = 'opacity 0.3s ease'
          setTimeout(function () {
            fn()
            postContent.style.opacity = '1'
            isTranslated = true
            isAnimating = false
          }, 300)
        }, 100)
      }, 100)
    }, 1500)
  }

  // ==================== 运行时 DeepSeek 翻译 ====================
  var DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions'
  var DEEPSEEK_MODEL = 'deepseek-v4-pro'
  var CONCURRENCY = 3 // 并发请求数，避免触发速率限制

  // 提取文本段（跳过 code/pre/script/style/svg/math），返回 {original, placeholder}
  function extractTextSegments(html) {
    var segments = []
    var skip = false
    var parts = html.split(/(<[^>]+>)/)
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i]
      if (!part) continue
      if (part.match(/^<(code|pre|script|style|svg|math)/i)) { skip = true; continue }
      if (part.match(/^<\/(code|pre|script|style|svg|math)/i)) { skip = false; continue }
      if (skip) continue
      if (part.match(/^<[^>]+>$/)) continue
      var trimmed = part.trim()
      if (trimmed.length > 1 && !/^[\s\d.,;:?\-()]+$/.test(trimmed)) {
        // 去重：若相同原文已存在则复用
        var existing = segments.filter(function (s) { return s.original === trimmed })[0]
        if (existing) continue
        segments.push({ original: trimmed, placeholder: '%%SEG_' + segments.length + '%%' })
      }
    }
    return segments
  }

  // 调用 DeepSeek 翻译单段
  function deepseekTranslate(text, targetLang) {
    var langName = targetLang === 'zh' ? 'Simplified Chinese' : 'English'
    var system =
      'You are a professional translator. Translate the user text into ' + langName +
      '. Output ONLY the translation. Keep numbers, units, variable names and code identifiers unchanged. Do not add explanations, quotes or notes.'
    return fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + deepseekKey
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: text }
        ],
        temperature: 0.2,
        stream: false,
        max_tokens: 2000
      })
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 401) throw new Error('API Key 无效或已过期')
        if (res.status === 429) throw new Error('请求过频，请稍后再试')
        throw new Error('DeepSeek HTTP ' + res.status)
      }
      return res.json()
    }).then(function (data) {
      var choice = data && data.choices && data.choices[0]
      var content = choice && choice.message ? choice.message.content : ''
      return (content || '').trim()
    })
  }

  // 并发池：限制同时发起的请求数
  function pMap(items, worker, concurrency) {
    return new Promise(function (resolve) {
      var results = new Array(items.length)
      var idx = 0
      var done = 0
      var active = 0
      function finish(i, r) {
        results[i] = r
        active--
        done++
        if (done === items.length) resolve(results)
        else pump()
      }
      function pump() {
        while (active < concurrency && idx < items.length) {
          ;(function (i) {
            active++
            Promise.resolve(worker(items[i], i)).then(function (r) {
              finish(i, r)
            }, function () {
              finish(i, null)
            })
          })(idx++)
        }
      }
      pump()
    })
  }

  function runApiTranslate() {
    var html = postContent.dataset.original || postContent.innerHTML
    var segments = extractTextSegments(html)
    // 缓存原 HTML，供回退
    if (!postContent.dataset.original) postContent.dataset.original = postContent.innerHTML

    // 目标语言：文章主要中文则译英，否则译中
    var targetLang = isMainlyChinese(postContent.textContent) ? 'zh' : 'en'

    if (segments.length === 0) return Promise.resolve({})

    return pMap(segments, function (seg) {
      return deepseekTranslate(seg.original, targetLang).catch(function () {
        return seg.original // 单段失败保留原文
      })
    }, CONCURRENCY).then(function (translations) {
      var map = {}
      for (var j = 0; j < segments.length; j++) {
        if (translations[j] && translations[j].length > 0) {
          map[segments[j].original] = translations[j]
        }
      }
      return map
    })
  }

  function showFatal(msg) {
    // 轻提示
    translateText.style.opacity = '0'
    translateText.textContent = '重试'
    translateText.style.opacity = '1'
    setTimeout(function () { translateText.textContent = '翻译' }, 2200)
    console.warn('[translate] ' + msg)
  }

  // ==================== 应用翻译到页面（保留 HTML 结构）====================
  function applyTranslation() {
    if (!translationData || !translationData.segments) return

    if (!postContent.dataset.original) {
      postContent.dataset.original = postContent.innerHTML
    }

    // 优先使用 translatedHTML（完整翻译后的 HTML）
    if (translationData.translatedHTML) {
      postContent.innerHTML = translationData.translatedHTML
    } else {
      // 回退：按段落替换
      var segments = translationData.segments
      var keys = Object.keys(segments).sort(function (a, b) { return b.length - a.length })
      var html = postContent.dataset.original
      keys.forEach(function (original) {
        var translated = segments[original]
        var escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        var regex = new RegExp('(?<=>)' + escaped + '(?=<)', 'g')
        html = html.replace(regex, translated)
      })
      postContent.innerHTML = html
    }

    postContent.classList.add('translated-content')
  }

  // ==================== 回退流程 ====================
  function doRevert() {
    isAnimating = true

    translateText.style.opacity = '0'
    btn.classList.remove('expanded')

    void translateText.offsetWidth
    translateText.textContent = '翻译'
    translateText.style.opacity = '1'

    postContent.style.opacity = '0'
    postContent.style.transition = 'opacity 0.15s ease'
    setTimeout(function () {
      if (postContent.dataset.original) {
        postContent.innerHTML = postContent.dataset.original
      }
      postContent.classList.remove('translated-content')
      postContent.style.opacity = '1'
      isTranslated = false
      isAnimating = false
    }, 150)
  }
})()
