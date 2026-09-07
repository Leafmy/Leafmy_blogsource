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
  // 翻译缓存键：带版本号，避免旧版(方向错误/原文照抄)缓存被复用
  var CACHE_VERSION = 'v2'
  var cacheKey = 'translate_' + CACHE_VERSION + '_' + slug
  // 旧版缓存键（无版本），供迁移清理
  var oldCacheKeys = ['translate_' + slug]
  oldCacheKeys.forEach(function (k) { localStorage.removeItem(k) })

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

  // ==================== 缓存读写 + 健康校验 ====================
  // 健康校验：一首 segments 里的"译文"是否真的不同于原文。
  // 若大多数 key===value（原文照抄），说明该缓存是假翻译/失败结果，判定无效。
  function isHealthySegments(segments) {
    if (!segments) return false
    var keys = Object.keys(segments)
    if (keys.length === 0) return false
    var unchanged = 0
    for (var i = 0; i < keys.length; i++) {
      if (segments[keys[i]] === keys[i]) unchanged++
    }
    // 超过 60% 段原文照抄 → 视为无效
    return unchanged / keys.length < 0.6
  }

  // 读取缓存，带健康校验；无效则清除并返回 null
  function readTranslationCache() {
    var cached = localStorage.getItem(cacheKey)
    if (!cached) return null
    try {
      var data = JSON.parse(cached)
      if (data.segments && isHealthySegments(data.segments)) {
        return data
      }
      // 无效缓存，清除
      localStorage.removeItem(cacheKey)
      return null
    } catch (e) {
      localStorage.removeItem(cacheKey)
      return null
    }
  }

  // 写入缓存，带健康校验；无效结果不写（避免缓存坏数据）
  function writeTranslationCache(segments) {
    if (!segments || !isHealthySegments(segments)) {
      // 无效结果不缓存
      return false
    }
    localStorage.setItem(cacheKey, JSON.stringify({ segments: segments }))
    return true
  }

  // ==================== 预加载翻译数据（兼容构建时 JSON）====================
  function preloadTranslation() {
    // 先检查 localStorage 缓存（带健康校验）
    var cached = readTranslationCache()
    if (cached) {
      translationData = cached
      translateText.textContent = '显示原文'
      btn.classList.add('expanded')
      isTranslated = true
      return
    }

    // 从服务器加载预翻译的 JSON
    fetch('/translations/' + slug + '.json', { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) throw new Error('No translation')
        return res.json()
      })
      .then(function (data) {
        if (data.segments && isHealthySegments(data.segments)) {
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
      // 仅当翻译结果健康(非原文照抄)时写缓存，避免缓存坏数据
      writeTranslationCache(segments)
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
  // 翻译任务用轻量 flash 即可，成本更低、速度更快
  var DEEPSEEK_MODEL = 'deepseek-v4-flash'
  // 全篇一次打包请求：段间用分隔符拼接，模型按相同分隔符逐段返回。
  // 只发一次 system prompt → 极省 token。
  var SEG_DELIM = '\n<<<SEG___>>\n'
  // 单请求可承载的最大文本长度（字符）。超长文章拆成多个批次请求，
  // 每个批次仍是一次请求一次 system prompt。
  var MAX_BATCH_CHARS = 8000

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

  // 调用 DeepSeek 翻译一个批次（含多段，用 SEG_DELIM 分隔）
  // 返回逐段译文数组（长度与输入段数一致），失败段为 null
  function deepseekTranslateBatch(texts) {
    // 用户明确要【英译中】: 原文为英文, 输出简体中文。方向写死避免歧义。
    var system =
      'The user text is in English. Translate each text segment into Simplified Chinese (简体中文). ' +
      'Output THE SAME number of results, each on its own line, in the same order. ' +
      'Keep numbers, units, variable names and code identifiers unchanged. ' +
      'Do not add explanations, quotes or notes. ' +
      'Separate your results by the delimiter "' + SEG_DELIM + '".'

    var joined = texts.join(SEG_DELIM)

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
          { role: 'user', content: joined }
        ],
        temperature: 0.2,
        stream: false,
        // 按目标语言估算最大长度；给足余量避免截断
        max_tokens: Math.max(1024, Math.ceil(joined.length * 1.6))
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
      return splitResults(content, texts.length)
    })
  }

  // 把模型返回的连续文本按分隔符拆成逐段结果，与输入段数对齐
  function splitResults(content, expected) {
    if (!content) return new Array(expected).fill(null)
    var parts = content.split(SEG_DELIM)
    // 去掉首尾空行，且只保留 expected 段
    var results = parts.map(function (p) { return p.trim() }).filter(function (p, i) {
      return p.length > 0
    })
    // 若模型返回段数比预期多或少，做对齐处理
    if (results.length >= expected) {
      return results.slice(0, expected)
    }
    // 段数不足：填充 null，避免错位
    var out = new Array(expected).fill(null)
    for (var i = 0; i < results.length; i++) out[i] = results[i]
    return out
  }

  function runApiTranslate() {
    var html = postContent.dataset.original || postContent.innerHTML
    var segments = extractTextSegments(html)
    // 缓存原 HTML，供回退
    if (!postContent.dataset.original) postContent.dataset.original = postContent.innerHTML

    // 翻译方向固定英译中（见 deepseekTranslateBatch 的 system prompt）

    if (segments.length === 0) return Promise.resolve({})

    // 把段落按字符量分桶，每桶一次请求（一次 system prompt），极省 token
    var batches = bucketSegments(segments, MAX_BATCH_CHARS)
    var allTexts = segments.map(function (s) { return s.original })
    var results = new Array(segments.length).fill(null)

    if (batches.length === 0) return Promise.resolve({})

    // 并行处理各桶，提升翻译速度（限制并发，避免触发限流）
    var BATCH_CONCURRENCY = 2
    var idx = 0

    var runBatch = function (indices) {
      var texts = indices.map(function (i) { return allTexts[i] })
      return deepseekTranslateBatch(texts).then(function (trans) {
        for (var k = 0; k < indices.length; k++) {
          // 单段失败保留原文
          results[indices[k]] = (trans[k] && trans[k].length > 0) ? trans[k] : allTexts[indices[k]]
        }
      }).catch(function () {
        // 桶级失败：该桶内所有段保留原文
        indices.forEach(function (i) { results[i] = allTexts[i] })
      })
    }

    // 简单的并行池
    function pool() {
      var arr = []
      var active = 0
      var taskIndex = 0
      return {
        run: function () {
          var resolveAll
          var done = new Promise(function (r) { resolveAll = r })
          var finished = 0
          var total = batches.length
          function pump() {
            while (active < BATCH_CONCURRENCY && taskIndex < total) {
              (function (indices) {
                active++
                runBatch(indices).then(function () {
                  active--
                  finished++
                  if (finished === total) resolveAll()
                  else pump()
                })
              })(batches[taskIndex++])
            }
            if (total === 0) resolveAll()
          }
          pump()
          return done
        }
      }
    }

    return pool().run().then(function () {
      var map = {}
      for (var j = 0; j < segments.length; j++) {
        if (results[j] && results[j].length > 0) {
          map[segments[j].original] = results[j]
        }
      }
      return map
    })
  }

  // 按最大字符量把段落索引分桶（保持原顺序）
  function bucketSegments(segments, maxChars) {
    var batches = []
    var cur = []
    var curLen = 0
    for (var i = 0; i < segments.length; i++) {
      var len = segments[i].original.length
      if (cur.length > 0 && curLen + len > maxChars) {
        batches.push(cur)
        cur = []
        curLen = 0
      }
      cur.push(i)
      curLen += len
    }
    if (cur.length > 0) batches.push(cur)
    return batches
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
