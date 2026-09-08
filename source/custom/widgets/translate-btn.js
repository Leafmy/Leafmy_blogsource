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
  var CACHE_VERSION = 'v3'
  var cacheKey = 'translate_' + CACHE_VERSION + '_' + slug
  // 旧版缓存键清理：无版本键 + v2 键
  // （v2 会把"分隔符错位"的半吊子译文当成功结果缓存，必须废弃）
  var oldCacheKeys = ['translate_' + slug, 'translate_v2_' + slug]
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
  // 忙碌锁：API 请求期间禁止重复点击（否则会并发发多次请求、状态互相打架）
  var isBusy = false
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
  // 数据形态统一为：translationData.segments = [{ original, translated }]
  // 健康校验：译文是否真的有效（非空、非原文照抄、无占位符残留）
  function isHealthySegments(segments) {
    if (!segments || !segments.length) return false
    var bad = 0
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i]
      var val = s && s.translated
      var orig = s && s.original
      // 无效：缺字段、译文非字符串为空、译文含占位符、或译文等于原文(照抄)
      if (!s || typeof val !== 'string' || !val || val.indexOf('%%SEG') !== -1 || val === orig) {
        bad++
      }
    }
    // 无效段超过 15% → 判定整体无效（宁可让用户重试，也不缓存半吊子译文）
    return bad / segments.length < 0.85
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
      // 命中缓存且未替换过：立即把正文翻成中文，刷新后直接是中文，无需再调 AI
      if (!postContent.classList.contains('translated-content')) {
        applyTranslation()
      }
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
          localStorage.setItem(cacheKey, JSON.stringify({ segments: data.segments }))
          translateText.textContent = '显示原文'
          btn.classList.add('expanded')
          isTranslated = true
          if (!postContent.classList.contains('translated-content')) {
            applyTranslation()
          }
        }
      })
      .catch(function () {
        // 竞态保护：若运行时翻译已抢先完成，不要把它清空
      })
  }

  preloadTranslation()

  // 翻译按钮点击事件
  btn.addEventListener('click', function () {
    if (isAnimating || isBusy) return
    if (isTranslated) {
      doRevert()
    } else {
      doTranslate()
    }
  })

  // ==================== 翻译流程 ====================
  function doTranslate() {
    // 有预翻译数据：直接走原有动画
    if (translationData && translationData.segments && isHealthySegments(translationData.segments)) {
      runTranslateAnimation(function () { applyTranslation() })
      return
    }

    // 无预翻译数据：尝试运行时 DeepSeek
    if (!deepseekKey) {
      openModal()
      return
    }

    // 运行时翻译：先 loading，再调 API
    isBusy = true
    btn.classList.add('loading')
    btn.classList.add('busy')

    runApiTranslate().then(function (out) {
      var segResults = out && out.segments
      var stats = (out && out.stats) || { total: 0, ok: 0 }
      if (!segResults || !segResults.length) {
        throw new Error('没有可翻译的内容')
      }
      // 健康门禁：译文达标才允许切换状态/写缓存，绝不"假装翻译完成"
      var ratio = stats.total ? stats.ok / stats.total : 0
      if (ratio < HEALTH_MIN_RATIO) {
        throw new Error('模型返回异常（有效译文 ' + stats.ok + '/' + stats.total + '）')
      }
      translationData = { segments: segResults }
      writeTranslationCache(segResults)
      btn.classList.remove('loading')
      btn.classList.remove('busy')
      isBusy = false
      runTranslateAnimation(function () { applyTranslation() })
    }).catch(function (err) {
      btn.classList.remove('loading')
      btn.classList.remove('busy')
      isBusy = false
      showError(err && err.message ? err.message : '翻译失败')
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
            try {
              fn()
              isTranslated = true
            } catch (e) {
              // 替换失败：恢复原文并解除动画锁，避免按钮永久卡死
              if (postContent.dataset.original) postContent.innerHTML = postContent.dataset.original
              postContent.classList.remove('translated-content')
              isTranslated = false
              showError('翻译应用失败：' + (e && e.message ? e.message : e))
            }
            postContent.style.opacity = '1'
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
  // 旧版分隔符协议（仅作解析兜底保留，不再作为主协议）
  var SEG_DELIM = '\n<<<SEG___>>\n'
  // 单请求可承载的最大文本长度（字符）。超长文章拆成多个批次请求，
  // 每个批次仍是一次请求一次 system prompt。
  var MAX_BATCH_CHARS = 4000
  // 输出 token 上限（超模型上限会被直接 400 拒绝）
  var MAX_TOKENS_CAP = 8192
  // 批次里没拿到译文的段，逐段单独重试（不依赖任何结构，最稳）
  var SINGLE_RETRY_CONCURRENCY = 3
  // 缺失段过多时不逐段重试（避免几十次请求），直接判定失败让用户重试
  var MAX_SINGLE_RETRY = 30
  // 有效译文占比低于此值 → 判定翻译失败，绝不切换状态/写缓存
  var HEALTH_MIN_RATIO = 0.85

  // 提取文本段（跳过 code/pre/script/style/svg/math）。
  // 只收集段列表，不对 HTML 做任何就地替换 —— 避免"短段(如 'In')是长段子串"
  // 时替换污染原文，导致后续长段匹配失败、残留脏文本。
  // 返回 segments: [{ original, placeholder }]，placeholder 仅作去重/顺序标识。
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
        // 去重：相同原文只保留一个段（后续翻译结果可复用）
        var existingIndex = -1
        for (var q = 0; q < segments.length; q++) {
          if (segments[q].original === trimmed) { existingIndex = q; break }
        }
        if (existingIndex < 0) {
          segments.push({ original: trimmed, placeholder: '%%SEG_' + segments.length + '%%' })
        }
      }
    }
    return { segments: segments }
  }

  // 构造请求体。
  // 批次模式：user 是 JSON 数组，要求模型返回 { "0": 译文, "1": 译文, ... }
  //   —— 用「索引键」对齐，模型即使换行/加符号/吃掉分隔符也不会错位。
  // 单段模式：user 是纯文本，返回纯译文，不依赖任何结构（兜底重试用）。
  function buildRequestBody(texts, single) {
    var system = single
      ? 'You are a professional translator. Translate the user text from English into Simplified Chinese (简体中文). ' +
        'Output ONLY the translation. No quotes, no explanations, no notes. ' +
        'Keep numbers, units, code identifiers, URLs and proper nouns unchanged.'
      : 'You are a professional translator. The user message is a JSON array of English text segments. ' +
        'Translate EVERY segment into Simplified Chinese (简体中文). ' +
        'Return ONLY a JSON object whose keys are the segment indexes as strings ("0","1","2",...) and whose values are the Chinese translations. ' +
        'Return exactly one entry per input segment, same order, never merge or split segments. ' +
        'Keep numbers, units, code identifiers, URLs and proper nouns unchanged. ' +
        'No markdown fences, no explanations.'
    var user = single ? texts[0] : JSON.stringify(texts)
    return {
      model: DEEPSEEK_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      stream: false,
      max_tokens: Math.min(MAX_TOKENS_CAP, Math.max(1024, Math.ceil(user.length * 2.2)))
    }
  }

  // 单次请求，返回 { content, truncated }
  function callDeepSeek(body) {
    return fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + deepseekKey
      },
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 401) throw new Error('API Key 无效或已过期')
        if (res.status === 402) throw new Error('账户余额不足')
        if (res.status === 429) throw new Error('请求过频，请稍后再试')
        if (res.status === 400) throw new Error('请求被拒绝（HTTP 400，可能文本过长）')
        throw new Error('DeepSeek HTTP ' + res.status)
      }
      return res.json()
    }).then(function (data) {
      var choice = data && data.choices && data.choices[0]
      var msg = choice && choice.message
      return {
        content: (msg && msg.content) || '',
        truncated: !!(choice && choice.finish_reason === 'length')
      }
    })
  }

  // 宽松解析「索引 → 译文」映射：
  // 容忍 ```json 包裹、首尾多余文字、1-based 键（"1".."n"）、数组形式返回值。
  function parseTranslations(content, expected) {
    var out = new Array(expected).fill(null)
    if (!content) return out
    var txt = String(content).trim()
      .replace(/^```[a-zA-Z]*\s*/, '')
      .replace(/```\s*$/, '')
      .trim()
    var obj = null
    try {
      obj = JSON.parse(txt)
    } catch (e) {
      var s = txt.indexOf('{'), e2 = txt.lastIndexOf('}')
      if (s > -1 && e2 > s) {
        try { obj = JSON.parse(txt.slice(s, e2 + 1)) } catch (e3) { obj = null }
      }
    }
    if (!obj) return out

    function put(idx, val) {
      if (typeof val === 'number') val = String(val)
      if (typeof val !== 'string') return
      var t = val.trim()
      if (idx >= 0 && idx < expected && t) out[idx] = t
    }

    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length && i < expected; i++) put(i, obj[i])
      return out
    }
    var keys = Object.keys(obj)
    // 键从 1 开始时（无 "0" 且有 "1"）按 1-based 映射
    var oneBased = keys.length > 0 && keys.indexOf('0') === -1 && keys.indexOf('1') > -1
    keys.forEach(function (k) {
      var idx = parseInt(k, 10)
      if (isNaN(idx)) return
      put(oneBased ? idx - 1 : idx, obj[k])
    })
    return out
  }

  // 批次翻译：一次请求翻多段，返回与输入等长的数组（失败段为 null）
  function deepseekTranslateBatch(texts) {
    return callDeepSeek(buildRequestBody(texts, false)).then(function (r) {
      var arr = parseTranslations(r.content, texts.length)
      var got = arr.filter(function (v) { return v }).length
      // 兜底：模型偶尔仍按旧分隔符协议返回
      if (got === 0 && r.content.indexOf(SEG_DELIM) !== -1) {
        var parts = r.content.split(SEG_DELIM).map(function (p) { return p.trim() }).filter(function (p) { return p })
        if (parts.length === texts.length) arr = parts
      }
      return arr
    })
  }

  // 单段翻译：不依赖任何结构，用于批次缺失段的兜底重试
  function deepseekTranslateOne(text) {
    return callDeepSeek(buildRequestBody([text], true)).then(function (r) {
      var t = String(r.content || '').trim().replace(/^["“]([\s\S]*)["”]$/, '$1').trim()
      return t || null
    }).catch(function () { return null })
  }

  // 简单并发池：对 items 并发执行 worker，全部完成后 resolve
  function runPool(items, concurrency, worker) {
    return new Promise(function (resolve) {
      var total = items.length
      if (total === 0) return resolve()
      var next = 0, active = 0, finished = 0
      function pump() {
        while (active < concurrency && next < total) {
          (function (item) {
            active++
            Promise.resolve().then(function () { return worker(item) })
              .catch(function () {})
              .then(function () {
                active--; finished++
                if (finished === total) resolve(); else pump()
              })
          })(items[next++])
        }
      }
      pump()
    })
  }

  // 致命错误（鉴权/余额/限流/请求被拒）：重试也没意义，直接放弃
  function isFatalError(err) {
    var m = err && err.message ? err.message : ''
    return m.indexOf('API Key') > -1 || m.indexOf('余额') > -1 ||
           m.indexOf('过频') > -1 || m.indexOf('HTTP 400') > -1
  }

  // 运行时翻译主流程。返回 { segments: [{original, translated}], stats: {total, ok} }
  // stats.ok = 真正拿到译文的段数（未变的段不计），供上层健康门禁判断。
  function runApiTranslate() {
    var html = postContent.dataset.original || postContent.innerHTML
    var extracted = extractTextSegments(html)
    var segments = extracted.segments
    // 缓存原 HTML，供回退 + 作为翻译替换的未污染底稿
    if (!postContent.dataset.original) postContent.dataset.original = postContent.innerHTML

    // 翻译方向固定英译中（见 buildRequestBody 的 system prompt）

    if (segments.length === 0) return Promise.resolve({ segments: [], stats: { total: 0, ok: 0 } })

    // 把段落按字符量分桶，每桶一次请求（一次 system prompt），极省 token
    var batches = bucketSegments(segments, MAX_BATCH_CHARS)
    var allTexts = segments.map(function (s) { return s.original })
    var results = new Array(segments.length).fill(null)
    var firstError = null

    if (batches.length === 0) return Promise.resolve({ segments: [], stats: { total: 0, ok: 0 } })

    var runBatch = function (indices) {
      var texts = indices.map(function (i) { return allTexts[i] })
      return deepseekTranslateBatch(texts).then(function (trans) {
        for (var k = 0; k < indices.length; k++) {
          var v = trans[k]
          // 只收真译文；缺失的留给兜底逐段重试
          if (v && v.length) results[indices[k]] = v
        }
      }).catch(function (err) {
        if (!firstError) firstError = err
      })
    }

    // 并行处理各桶（限并发，避免触发限流）
    return runPool(batches, 2, runBatch).then(function () {
      // 致命错误直接终止，不做无意义的兜底重试
      if (isFatalError(firstError)) return null
      // 兜底第 1 层：缺失段改用更小的桶重试（请求越短，模型越不容易跑偏）
      var missing = []
      for (var i = 0; i < results.length; i++) if (!results[i]) missing.push(i)
      if (!missing.length) return null
      var retryBatches = bucketSegments(missing.map(function (idx) { return segments[idx] }), 800)
        .map(function (grp) { return grp.map(function (localIdx) { return missing[localIdx] }) })
      return runPool(retryBatches, 2, runBatch)
    }).then(function () {
      // 兜底第 2 层：仍缺的段逐段单独请求（不依赖任何结构）
      if (isFatalError(firstError)) return null
      var missing = []
      for (var i = 0; i < results.length; i++) if (!results[i]) missing.push(i)
      if (!missing.length || missing.length > MAX_SINGLE_RETRY) return null
      return runPool(missing, SINGLE_RETRY_CONCURRENCY, function (idx) {
        return deepseekTranslateOne(allTexts[idx]).then(function (t) {
          if (t) results[idx] = t
        })
      })
    }).then(function () {
      var segResults = []
      var ok = 0
      for (var j = 0; j < segments.length; j++) {
        var orig = segments[j].original
        var tr = results[j] && results[j].length > 0 ? results[j] : orig
        if (tr !== orig) ok++
        segResults.push({ original: orig, translated: tr })
      }
      // 全军覆没时抛出具体错误（401/429 等），而不是假装成功
      if (ok === 0 && firstError) throw firstError
      return { segments: segResults, stats: { total: segments.length, ok: ok } }
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

  // 失败提示：按钮下方弹一条毛玻璃 toast，并短暂把按钮文字改成「重试」
  // 挂在 body 上 + position:fixed：标题容器有 overflow 裁剪，挂在按钮旁边会被裁掉
  function showError(msg) {
    console.warn('[translate] ' + msg)
    var old = document.querySelector('.translate-toast')
    if (old && old.parentNode) old.parentNode.removeChild(old)

    var t = document.createElement('span')
    t.className = 'translate-toast'
    t.textContent = msg
    document.body.appendChild(t)

    // 定位到按钮下方，且不超出视口
    var r = btnWrap.getBoundingClientRect()
    var left = Math.max(8, Math.min(r.left, window.innerWidth - t.offsetWidth - 8))
    t.style.left = left + 'px'
    t.style.top = (r.bottom + 8) + 'px'
    t.style.maxWidth = Math.min(300, window.innerWidth - 16) + 'px'

    void t.offsetWidth
    t.classList.add('show')

    translateText.textContent = '重试'
    setTimeout(function () {
      t.classList.remove('show')
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t) }, 300)
      if (!isTranslated) translateText.textContent = '翻译'
    }, 4200)
  }

  // ==================== 应用翻译到页面（保留 HTML 结构）====================
  // 采用"提取不污染 + 回填从长到短"：
  //  - 底稿用 dataset.original（未做任何就地替换的原始 HTML）
  //  - 遍历 segments（数组 [{original, translated}]），按 original 长度从长到短，
  //    把原文全局替换为译文。短段(如 'In')是长段子串时，因"从长到短"先替换长段，
  //    再替换短段时短段原文已随长段消失，不会污染。
  function applyTranslation() {
    if (!translationData || !translationData.segments) return

    if (!postContent.dataset.original) {
      postContent.dataset.original = postContent.innerHTML
    }

    var segments = translationData.segments

    // 优先使用 translatedHTML（完整翻译后的 HTML，构建时 DeepL 产物）
    if (translationData.translatedHTML) {
      postContent.innerHTML = translationData.translatedHTML
    } else {
      // 运行时翻译：基于未污染的 original HTML，从长到短做原文→译文全局替换。
      // segments 为 [{original, translated}] 数组。
      var html = postContent.dataset.original
      // 按 original 长度从长到短排序，避免短段早于长段替换造成子串污染
      var sorted = segments.slice().sort(function (a, b) { return b.original.length - a.original.length })
      sorted.forEach(function (s) {
        if (!s.original || !s.translated) return
        if (s.translated === s.original) return // 代码/未变段跳过
        var escaped = s.original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        var regex = new RegExp(escaped, 'g')
        html = html.replace(regex, function () { return s.translated })
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
