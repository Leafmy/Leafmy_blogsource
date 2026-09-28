/* ============================================================
   管理控制台 /admin/
   ------------------------------------------------------------
   进入方式：
   1) 在站点搜索栏输入管理员密钥后**按回车** → 自动跳转
   2) 直接访问 /admin/，在门禁里输入密钥

   数据写入：GitHub Contents API（站长自己的细粒度 PAT，只存本机浏览器）
   - 文章 / 页面：source/_posts/*.md、source/**.md 增删改
   - 站点文字 + 字形/位置规则 + 侧栏公告正文：source/_data/site_text.yml
     （「文字」页改文字，提交时连 styles 段一起写；「可视化」页所见即所得）
   - 标签/分类：改写所有相关文章的 front-matter
   - 管理员密钥：提交 source/custom/admin/admin-key.js

   注意：静态站无后端，密钥哈希只是"门帘"；真正的权限由 PAT 决定。
   ============================================================ */
(function () {
  'use strict'

  // ==================== 小工具 ====================
  var $ = function (sel) { return document.querySelector(sel) }
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)) }

  function toast(msg, kind) {
    var el = $('#admin-toast')
    if (!el) return
    el.textContent = msg
    el.className = 'admin-toast show' + (kind ? ' ' + kind : '')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { el.className = 'admin-toast' + (kind ? ' ' + kind : '') }, 3800)
  }

  function sha256hex(str) {
    if (!window.crypto || !crypto.subtle) return Promise.reject(new Error('当前环境不支持 WebCrypto（需 HTTPS 或 localhost）'))
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return ('0' + b.toString(16)).slice(-2)
      }).join('')
    })
  }

  // ---- UTF-8 安全的 base64 ----
  function b64Encode(str) {
    var bytes = new TextEncoder().encode(str)
    var CHUNK = 0x8000, out = ''
    for (var i = 0; i < bytes.length; i += CHUNK) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK))
    }
    return btoa(out)
  }
  function b64Decode(b64) {
    var bin = atob(String(b64 || '').replace(/\s/g, ''))
    var bytes = new Uint8Array(bin.length)
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  }

  // ---- Token 可逆混淆（与翻译按钮同款：XOR + base64 + CRC32）----
  var XOR = [0x5a, 0x2f, 0x7c, 0x1b, 0x4d, 0x6e]
  var crcTable = (function () {
    var t = []
    for (var n = 0; n < 256; n++) {
      var c = n
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
      t[n] = c >>> 0
    }
    return t
  })()
  function crc32(str) {
    var b = new TextEncoder().encode(str), crc = 0xFFFFFFFF
    for (var i = 0; i < b.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ b[i]) & 0xFF]
    return (crc ^ 0xFFFFFFFF) >>> 0
  }
  function xorBytes(bytes) {
    var out = new Uint8Array(bytes.length)
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ XOR[i % XOR.length]
    return out
  }
  function encToken(raw) {
    try {
      var ob = xorBytes(new TextEncoder().encode(raw))
      return 'WBGH1.' + btoa(String.fromCharCode.apply(null, ob)) + '.' + crc32(raw).toString(16)
    } catch (e) { return '' }
  }
  function decToken(stored) {
    if (!stored || stored.indexOf('WBGH1.') !== 0) return ''
    var parts = stored.split('.')
    if (parts.length < 3) return ''
    var arr
    try {
      arr = atob(parts[1]).split('').map(function (c) { return c.charCodeAt(0) & 0xFF })
    } catch (e) { return '' }
    var raw = new TextDecoder().decode(xorBytes(new Uint8Array(arr)))
    return crc32(raw).toString(16) === parts[2] ? raw : ''
  }

  // ---- YAML front-matter（够用子集：标量 + 列表）----
  function unquote(v) {
    v = String(v).trim()
    if ((v[0] === '"' && v[v.length - 1] === '"') || (v[0] === "'" && v[v.length - 1] === "'")) {
      return v.slice(1, -1).replace(/\\"/g, '"')
    }
    return v
  }
  function parseFrontMatter(raw) {
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw || '')
    if (!m) return { data: {}, body: raw || '', hasFM: false }
    var lines = m[1].split(/\r?\n/)
    var data = {}, i = 0
    while (i < lines.length) {
      var line = lines[i]
      if (!line.trim() || /^\s*#/.test(line)) { i++; continue }
      var kv = /^([A-Za-z0-9_\u4e00-\u9fa5-]+)\s*:\s*(.*)$/.exec(line)
      if (!kv) { i++; continue }
      var key = kv[1], rest = kv[2].trim()
      if (rest === '') {
        var items = [], j = i + 1
        while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
          items.push(unquote(lines[j].replace(/^\s*-\s+/, '')))
          j++
        }
        data[key] = items
        i = items.length ? j : i + 1
        continue
      }
      if (/^\[.*\]$/.test(rest)) {
        data[key] = rest.slice(1, -1).split(',').map(function (s) { return unquote(s) }).filter(Boolean)
      } else {
        data[key] = unquote(rest)
      }
      i++
    }
    return { data: data, body: raw.slice(m[0].length), hasFM: true }
  }
  function yamlValue(v) {
    var s = String(v == null ? '' : v)
    if (s === '') return '""'
    // 布尔 / 空值照原样输出：写 "false" 会变成真值字符串（comments: "false" 和 comments: false 不是一个意思）
    if (/^(true|false|null)$/i.test(s)) return s.toLowerCase()
    // 时间戳（2026-09-08 18:40:00）也照原样：加引号会在每次保存时制造无谓的 diff
    if (/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(s)) return s
    if (/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 ._+\-/]*$/.test(s) && !/^(yes|no|on|off)$/i.test(s)) return s
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  var FM_ORDER = ['title', 'date', 'updated', 'categories', 'tags', 'description', 'sticky', 'top', 'comments', 'cover', 'permalink']
  function buildFrontMatter(data) {
    var lines = ['---']
    var done = {}
    function emit(key) {
      if (done[key] || data[key] === undefined || data[key] === null || data[key] === '') return
      done[key] = 1
      var v = data[key]
      if (Array.isArray(v)) {
        if (!v.length) return
        lines.push(key + ':')
        v.forEach(function (it) { lines.push('  - ' + yamlValue(it)) })
      } else {
        lines.push(key + ': ' + yamlValue(v))
      }
    }
    FM_ORDER.forEach(emit)
    Object.keys(data).forEach(emit)
    lines.push('---')
    return lines.join('\n') + '\n'
  }
  function splitList(str) {
    return String(str || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
  }
  function slugify(title) {
    var t = String(title || '').toLowerCase().trim()
      .replace(/[\s_]+/g, '-')
      .replace(/[^a-z0-9\u4e00-\u9fa5-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    // 含中文的文件名会让 URL 出现百分号编码，改用时间戳更干净
    if (!t || /[\u4e00-\u9fa5]/.test(t)) t = 'post-' + Date.now().toString(36)
    return t
  }
  function fmtDate(d) {
    var p = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    })
  }

  // ==================== 状态 ====================
  var TOKEN_STORE = 'admin_github_token'
  var CFG_STORE = 'admin_github_cfg'
  var UNLOCK_STORE = 'admin_unlocked'
  var ADMIN_HASH = String(window.ADMIN_KEY_SHA256 || '').toLowerCase()

  var state = {
    meta: null,
    posts: [],
    pages: [],
    gh: { owner: 'Leafmy', name: 'Leafmy_blogsource', branch: 'main', token: '', check: null },
    editing: null,
    filter: ''
  }

  // ==================== GitHub API ====================
  var GH_API = 'https://api.github.com'

  function ghPath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/')
  }

  function ghAuthHeaders(hasBody) {
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + state.gh.token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (hasBody) headers['Content-Type'] = 'application/json'
    return headers
  }

  /* 底层请求：不抛错、不吞状态码，把 status / headers / data 原样交回调用方。
     （体检要靠状态码区分 401/403/404 与限流，不能提前被"友好文案"盖掉。）*/
  function ghSend(url, opts) {
    opts = opts || {}
    if (!state.gh.token) return Promise.reject(new Error('未配置 GitHub Token（设置 → GitHub 写入凭证）'))
    return fetch(url, {
      method: opts.method || 'GET',
      headers: ghAuthHeaders(!!opts.body),
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null
        if (txt) { try { data = JSON.parse(txt) } catch (e) { data = null } }
        return { status: res.status, ok: res.ok, headers: res.headers, data: data, url: url }
      })
    }).catch(function (e) {
      // 网络层失败：断网 / 代理 / 被扩展或广告拦截插件拦掉
      throw new Error('网络请求失败：' + ((e && e.message) || e) + '（检查网络、代理或广告拦截插件）')
    })
  }

  /* 仓库内的 API（自动补 /repos/<owner>/<name> 前缀）*/
  function ghRequest(apiPath, opts) {
    return ghSend(GH_API + '/repos/' + state.gh.owner + '/' + state.gh.name + (apiPath || ''), opts)
  }

  /* 仓库外的 API（/user、/rate_limit 等）*/
  function ghApiGet(apiPath) {
    return ghSend(GH_API + apiPath)
  }

  function ghErrorMessage(res) {
    var d = res.data || {}
    var raw = d.message || ''
    var tail = raw ? ' ' + raw : ''
    if (res.status === 401) return 'Token 无效、已过期或已被撤销（HTTP 401' + tail + '）'
    if (res.status === 403) {
      var remain = res.headers.get('x-ratelimit-remaining')
      if (remain === '0') {
        var reset = Number(res.headers.get('x-ratelimit-reset') || 0) * 1000
        return '触发 GitHub 限流' + (reset ? '，约 ' + new Date(reset).toLocaleTimeString() + ' 后恢复' : '') + '（HTTP 403）'
      }
      return 'Token 权限不足：需要 Contents: Read and write；细粒度 PAT 还必须把 ' +
        state.gh.owner + '/' + state.gh.name + ' 加进 Repository access（HTTP 403' + tail + '）'
    }
    if (res.status === 404) {
      return '仓库不存在，或这个 Token 看不到它（细粒度 PAT 最常见：Repository access 没勾选本仓库；' +
        '其次检查 owner / 仓库名拼写与分支）（HTTP 404）'
    }
    if (res.status === 409) return '文件已变化（sha 冲突），请刷新后重试（HTTP 409）'
    if (res.status === 422) return '请求被拒绝：' + (raw || '参数不合法') + '（HTTP 422）'
    return (raw || 'GitHub 返回异常') + '（HTTP ' + res.status + '）'
  }

  /* 业务层：404 视作"文件不存在"（返回 null），其余非 2xx 抛出可读错误 */
  function ghFetch(apiPath, opts) {
    return ghRequest(apiPath, opts).then(function (res) {
      if (res.status === 404) return null
      if (!res.ok) throw new Error(ghErrorMessage(res))
      return res.data
    })
  }

  function ghGetFile(path) {
    return ghFetch('/contents/' + ghPath(path) + '?ref=' + encodeURIComponent(state.gh.branch)).then(function (d) {
      if (!d || d.type !== 'file') return null
      return { sha: d.sha, path: d.path, text: b64Decode(d.content) }
    })
  }

  function ghPutFile(path, text, message, sha) {
    var body = { message: message, content: b64Encode(text), branch: state.gh.branch }
    if (sha) body.sha = sha
    return ghFetch('/contents/' + ghPath(path), { method: 'PUT', body: body })
  }

  function ghDeleteFile(path, sha, message) {
    return ghFetch('/contents/' + ghPath(path), {
      method: 'DELETE',
      body: { message: message, sha: sha, branch: state.gh.branch }
    })
  }

  // ==================== 卡片光效（一个光源照亮范围内所有卡片）====================
  // 指针是一个"光源"：范围内每张卡片按到指针的距离衰减发光，
  // 近的更亮、远的更淡；卡片内的光斑位置仍跟随指针。
  // CSS 侧用 --glow(0~1) 控制 ::before/::after 的透明度，--gx/--gy 控制光心。
  var GLOW_RADIUS = 280          // 影响半径（px）
  var glowCards = []
  var pointerX = -9999, pointerY = -9999
  var glowRaf = 0
  /* 矩形缓存失效计数：滚动/缩放/窗口变化后重新测量 */
  var adminRectEpoch = 0
  var glowRectEpoch = -1
  function invalidateAdminRects() { adminRectEpoch++ }
  window.addEventListener('scroll', invalidateAdminRects, { passive: true })
  window.addEventListener('resize', invalidateAdminRects, { passive: true })

  function refreshGlowCards() {
    glowCards = Array.prototype.slice.call(document.querySelectorAll('.adm-card'))
  }

  function updateGlow() {
    glowRaf = 0
    if (!glowCards.length) refreshGlowCards()

    // [性能] 两阶段：先把所有卡片的矩形一次读完，再做写入。
    // 原实现在同一个循环里 getBoundingClientRect()(读) 与
    // el.style.setProperty / style.transform(写) 交替 —— "读-写-读"
    // 会让每次 getBoundingClientRect 都强制一次同步布局(layout flush)，
    // 卡片多时单个指针帧就能变成主线程长任务。
    // 矩形只在滚动/尺寸变化后失效，记一个 epoch 即可复用缓存。
    if (glowRectEpoch !== adminRectEpoch) {
      for (var m = 0; m < glowCards.length; m++) {
        var card = glowCards[m]
        if (card.__rect) card.__rect = card.getBoundingClientRect()
      }
      glowRectEpoch = adminRectEpoch
    }

    for (var i = 0; i < glowCards.length; i++) {
      var el = glowCards[i]
      if (!el.__rect) el.__rect = el.getBoundingClientRect()
      var r = el.__rect
      // 指针到卡片矩形的最近点距离（指针在卡片内 → 0）
      var nx = pointerX < r.left ? r.left : (pointerX > r.right ? r.right : pointerX)
      var ny = pointerY < r.top ? r.top : (pointerY > r.bottom ? r.bottom : pointerY)
      var dx = pointerX - nx, dy = pointerY - ny
      var d = Math.sqrt(dx * dx + dy * dy)
      var s = 1 - d / GLOW_RADIUS
      if (s < 0) s = 0
      else if (s > 1) s = 1
      s = s * s                                  // 二次衰减：近处亮得明显

      // 已熄灭且仍在范围外 → 连位置都不用更新
      if (s <= 0 && el.__glow === 0) continue

      // 光心：每帧用 transform 平移（合成器，不触发重绘）。
      // 注意：位置更新**不能**跟强度一起跳过 —— 指针进入卡片后距离恒为 0、
      // 强度锁死在 1，若同时跳过位置，光斑就会卡在进入点（用户报的"卡住"）。
      var lx = pointerX - r.left
      var ly = pointerY - r.top
      // 光斑 420×420（正圆）、环高光 380×380（正圆）→ 位移偏移取各自半径
      if (el.__blob) {
        el.__blob.style.transform = 'translate3d(' + (lx - 210).toFixed(1) + 'px,' + (ly - 210).toFixed(1) + 'px,0)'
      }
      if (el.__light) {
        el.__light.style.transform = 'translate3d(' + (lx - 190).toFixed(1) + 'px,' + (ly - 190).toFixed(1) + 'px,0)'
      }

      // 强度：只在变化超过阈值时写（避免无谓的样式重算）
      if (el.__glow === undefined || Math.abs(s - el.__glow) >= 0.004) {
        el.__glow = s
        el.style.setProperty('--glow', s.toFixed(3))
      }
    }
  }

  function scheduleGlow() {
    if (!glowRaf) glowRaf = requestAnimationFrame(updateGlow)
  }

  document.addEventListener('pointermove', function (e) {
    pointerX = e.clientX
    pointerY = e.clientY
    scheduleGlow()
  }, { passive: true })

  // 指针离开文档/窗口失焦 → 全部熄灭
  function killGlow() {
    pointerX = -9999
    pointerY = -9999
    scheduleGlow()
  }
  document.addEventListener('pointerleave', killGlow)
  document.addEventListener('mouseleave', killGlow)
  window.addEventListener('blur', killGlow)

  // 给卡片挂 .adm-card（光效）并注入光层元素
  var CARD_SEL = '.admin-top, .admin-panel, .admin-stat, .admin-item, .admin-tab, .admin-gate-card'
  function decorateCards(scope) {
    var host = scope || document
    var cards = host.querySelectorAll(CARD_SEL)
    Array.prototype.forEach.call(cards, function (el) {
      el.classList.add('adm-card')
      if (el.querySelector(':scope > .adm-glow-blob')) return
      var blob = document.createElement('i')
      blob.className = 'adm-glow-blob'
      el.appendChild(blob)
      var edge = document.createElement('i')
      edge.className = 'adm-edge'
      var light = document.createElement('i')
      light.className = 'adm-edge-light'
      edge.appendChild(light)
      el.appendChild(edge)
      el.__blob = blob
      el.__light = light
      // 矩形缓存：下次 updateGlow 时按需测量（见 updateGlow 的两阶段写法）
      el.__rect = null
    })
    refreshGlowCards()
    scheduleGlow()
  }

  // 列表是动态渲染的，用 MutationObserver 兜住所有新增卡片（防抖 60ms）
  function observeCards() {
    if (!window.MutationObserver) return
    var timer = 0
    var mo = new MutationObserver(function () {
      clearTimeout(timer)
      timer = setTimeout(function () { decorateCards() }, 60)
    })
    mo.observe($('#admin-app'), { childList: true, subtree: true })
  }

  // ==================== 写作页（编辑器）====================
  // 目标：像一个真正的写作页 —— Markdown 工具栏、实时预览、字数统计、
  // 快捷键、本地草稿、未保存提醒。
  var DRAFT_STORE = 'admin_draft_v1'
  var editorMode = 'edit'
  var editorDirty = false
  var draftTimer = 0
  var previewTimer = 0

  // 当前草稿归属：新文章 / 具体文件路径
  function draftKey() {
    var ed = state.editing
    if (!ed) return ''
    return ed.mode === 'new' ? 'new' : ed.path
  }

  // ---- 未保存状态 ----
  function markDirty(v, label) {
    editorDirty = !!v
    var el = $('#editor-state')
    if (!el) return
    if (!editorDirty) { el.className = 'admin-editor-state'; el.textContent = label || ''; return }
    el.className = 'admin-editor-state is-dirty'
    el.textContent = '● 有未保存的修改'
  }

  // ---- 本地草稿（刷新 / 误关页面后还能捡回来）----
  function snapshotEditor() {
    return {
      key: draftKey(),
      title: $('#ed-title').value,
      date: $('#ed-date').value,
      categories: $('#ed-categories').value,
      tags: $('#ed-tags').value,
      desc: $('#ed-desc').value,
      sticky: $('#ed-sticky').value,
      body: $('#ed-body').value,
      ts: Date.now()
    }
  }

  function scheduleDraft() {
    clearTimeout(draftTimer)
    draftTimer = setTimeout(function () {
      try { localStorage.setItem(DRAFT_STORE, JSON.stringify(snapshotEditor())) } catch (e) {}
    }, 700)
  }

  function clearDraft() {
    clearTimeout(draftTimer)
    try { localStorage.removeItem(DRAFT_STORE) } catch (e) {}
    var banner = $('#editor-draft')
    if (banner) banner.style.display = 'none'
  }

  function relTime(ts) {
    var m = Math.floor(Math.max(0, Date.now() - Number(ts || 0)) / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return m + ' 分钟前'
    var h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    return Math.floor(h / 24) + ' 天前'
  }

  // 打开编辑器后，检查有没有同一篇文章的本地草稿
  function checkDraft() {
    var banner = $('#editor-draft')
    if (!banner) return
    var raw = null
    try { raw = JSON.parse(localStorage.getItem(DRAFT_STORE) || 'null') } catch (e) {}
    if (!raw || raw.key !== draftKey()) { banner.style.display = 'none'; return }
    // 与当前内容一致 → 没有可恢复的东西
    if (String(raw.body || '') === $('#ed-body').value &&
      String(raw.title || '') === $('#ed-title').value) {
      banner.style.display = 'none'
      return
    }
    banner.__draft = raw
    banner.style.display = ''
    $('#editor-draft-text').textContent = '发现本地草稿（' + relTime(raw.ts) + '自动保存）'
  }

  function restoreDraft() {
    var banner = $('#editor-draft')
    var raw = banner && banner.__draft
    if (!raw) return
    $('#ed-title').value = raw.title || ''
    $('#ed-date').value = raw.date || ''
    $('#ed-categories').value = raw.categories || ''
    $('#ed-tags').value = raw.tags || ''
    $('#ed-desc').value = raw.desc || ''
    $('#ed-sticky').value = raw.sticky || '0'
    $('#ed-body').value = raw.body || ''
    banner.style.display = 'none'
    markDirty(true)
    syncEditorUI()
    toast('已恢复本地草稿', 'ok')
  }

  // ---- 字数统计 ----
  function updateStats() {
    var v = $('#ed-body').value
    var cn = (v.match(/[\u4e00-\u9fa5]/g) || []).length
    var words = (v.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length
    var lines = v ? v.split('\n').length : 0
    var count = cn + words
    var minutes = Math.max(1, Math.round(count / 400))
    $('#ed-stats').textContent = count + ' 字 · ' + lines + ' 行 · 约 ' + minutes + ' 分钟'
  }

  // ---- 置顶权重：把"当前效果"直接写在旁边，不再云里雾里 ----
  function updateStickyState() {
    var el = $('#sticky-state')
    if (!el) return
    var n = Number($('#ed-sticky').value || 0)
    var legacyTop = !!(state.editing && state.editing.data && state.editing.data.top)
    if (n > 0) {
      el.className = 'admin-sticky-state is-on'
      el.textContent = '置顶 · 权重 ' + n
    } else if (legacyTop) {
      el.className = 'admin-sticky-state is-on'
      el.textContent = '置顶（旧字段 top）'
    } else {
      el.className = 'admin-sticky-state'
      el.textContent = '不置顶'
    }
  }

  // ---- Markdown 预览（够用子集：先转义再替换，天然安全）----
  function mdEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    })
  }

  function mdInline(text) {
    return text
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1">')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1<em>$2</em>')
  }

  /* 每个顶层块都记一份它在 Markdown 源里的起始行号（0 基），渲染时写成
     data-src-line —— 分栏预览的滚动同步就靠它把「源码行」和「预览块」对起来。 */
  function mdToHtml(src) {
    var blocks = []
    var text = String(src || '').replace(/\r\n?/g, '\n')
    // 1) 先摘出围栏代码块（内容整体转义，不再参与后面的行内替换）
    //    占位符**必须与原文换行数一致**（少了就补空行），否则后面数的行号会整体漂移。
    //    顺便把围栏自己的行号记在 blocks[i].line 上（它在被抽走的那段里，后面数不到）。
    var scanPos = 0, scanLine = 0
    text = text.replace(/```[^\n`]*\n([\s\S]*?)(?:\n?```|$)/g, function (m, code, offset, whole) {
      var nl = (m.match(/\n/g) || []).length
      var lineNo = scanLine + (whole.slice(scanPos, offset).match(/\n/g) || []).length
      scanPos = offset + m.length
      scanLine = lineNo + nl
      // 围栏不在行首时补一个换行，让占位符独占一行（换行总数保持不变）
      var head = offset > 0 && whole.charAt(offset - 1) !== '\n' ? '\n' : ''
      blocks.push({
        html: '<pre><code>' + mdEscape(code.replace(/\n$/, '')) + '</code></pre>',
        line: lineNo + (head ? 1 : 0)
      })
      return head + '\u0000B' + (blocks.length - 1) + '\u0000' +
        new Array(nl - (head ? 1 : 0) + 1).join('\n')
    })
    // 2) 其余内容统一转义（后面只做受控替换）
    text = mdEscape(text)

    var lines = text.split('\n')
    var out = []
    var outLine = []      // 与 out 一一对应：该块的源码起始行号
    var para = []
    var paraLine = 0
    function emit(html, line) { out.push(html); outLine.push(line) }
    function flush() {
      if (para.length) { emit('<p>' + para.map(mdInline).join('<br>') + '</p>', paraLine); para = [] }
    }
    function splitRow(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
        .map(function (c) { return c.trim() })
    }
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var bm = /^\u0000B(\d+)\u0000$/.exec(line.trim())
      if (bm) {
        flush()
        var blk = blocks[Number(bm[1])]
        emit(blk ? blk.html : '', blk ? blk.line : i)
        i++; continue
      }
      if (!line.trim()) { flush(); i++; continue }

      var h = /^(#{1,4})\s+(.*)$/.exec(line)
      if (h) {
        flush()
        var lv = h[1].length
        emit('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>', i)
        i++; continue
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); emit('<hr>', i); i++; continue }

      // 引用行：'&gt;' 是转义后的 '>'（转义发生在块级解析之前）
      if (/^&gt;\s?/.test(line)) {
        flush()
        var qs = []
        var qLine = i
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          qs.push(lines[i].replace(/^&gt;\s?/, '')); i++
        }
        emit('<blockquote>' + qs.map(mdInline).join('<br>') + '</blockquote>', qLine)
        continue
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        flush()
        var ul = []
        var ulLine = i
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          ul.push('<li>' + mdInline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++
        }
        emit('<ul>' + ul.join('') + '</ul>', ulLine)
        continue
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        flush()
        var ol = []
        var olLine = i
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol.push('<li>' + mdInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++
        }
        emit('<ol>' + ol.join('') + '</ol>', olLine)
        continue
      }

      // 表格：本行有 |，下一行是 |---| 分隔行
      if (line.indexOf('|') > -1 && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(lines[i + 1])) {
        flush()
        var head = splitRow(line)
        var tbLine = i
        i += 2
        var rows = []
        while (i < lines.length && lines[i].indexOf('|') > -1 && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++
        }
        emit('<table><thead><tr>' +
          head.map(function (c) { return '<th>' + mdInline(c) + '</th>' }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>' }).join('') + '</tr>'
          }).join('') +
          '</tbody></table>', tbLine)
        continue
      }

      if (!para.length) paraLine = i
      para.push(line)
      i++
    }
    flush()
    return out.map(function (html, idx) {
      /* 只往块的首个标签里塞属性，不额外包一层 div —— 免得 .editor-preview
         里那些 :first-child / 直接子元素样式失效 */
      return html.replace(/^<([a-zA-Z][a-zA-Z0-9]*)/,
        '<$1 data-src-line="' + outLine[idx] + '"')
    }).join('\n')
  }

  function updatePreview() {
    var host = previewHost()
    if (!host) return
    /* 重绘会换掉整块预览 DOM，位置得找回来：
       分栏时**以左侧为准**（用户在写、在看的就是它）重新对齐；
       只看预览时没有"另一侧"可依，就保持预览自己原来的位置。 */
    var keepRow = editorMode === 'preview' ? lineAtPreviewTop() : null
    host.innerHTML = mdToHtml($('#ed-body').value)
    previewAnchors = null
    if (editorMode === 'split') syncFromEditor()
    else if (keepRow !== null) scrollPreviewToLine(keepRow)
  }

  function schedulePreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(updatePreview, 180)
  }

  /* ============================================================
     分栏预览的滚动同步
     ------------------------------------------------------------
     目标是"左右两边看到的是同一段文字"，所以不能按滚动百分比对齐
     （预览与源码的行高、块高完全不同，一遇到长代码块/图片就跑飞）。
     做法：mdToHtml 给每个顶层块写了 data-src-line，于是

       textarea.scrollTop ──[每行占几个视觉行]──> 源码行号（可带小数）
       源码行号 ──[预览块的 content 偏移做线性插值]──> 预览 scrollTop

     反方向同理。每行占几个视觉行没法从 textarea 直接读（软折行），
     所以用一个隐藏的镜像元素把每行照原宽度排一遍来量。
     ============================================================ */
  var previewAnchors = null   // {el, line:[], top:[]}：源码行 ↔ 预览内容偏移（单调）
  var editorRows = null       // {rows:[累计视觉行], lineCount, total}
  var editorRowsKey = ''      // 量的时候的正文/宽度指纹，变了就重量
  var edMirror = null
  var edSyncTarget = { e: null, p: null }   // 刚由代码设的 scrollTop，用来吃掉回声
  var editorObservedW = 0

  function previewHost() { return $('#editor-preview') }

  /* ---- 行高 / 内边距（textarea 是等宽字体，行高固定，尺寸全靠它们换算）---- */
  function editorMetrics(ta) {
    var cs = getComputedStyle(ta)
    var lh = parseFloat(cs.lineHeight)
    if (!isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 13) * 1.7
    return {
      lh: lh,
      padTop: parseFloat(cs.paddingTop) || 0,
      padBottom: parseFloat(cs.paddingBottom) || 0,
      contentW: Math.max(0, ta.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0))
    }
  }

  /* ---- 隐藏镜像：量出"每一源码行实际占几个视觉行" ----
     量不到（宽度为 0 / 行数过多）就返回 null，调用方退化成按字符宽度估算。 */
  function measureEditorRows(ta, met) {
    var text = String(ta.value || '').replace(/\r\n?/g, '\n')
    var srcLines = text.split('\n')
    if (srcLines.length > 4000 || met.contentW <= 0) return null

    if (!edMirror) {
      edMirror = document.createElement('div')
      edMirror.className = 'ed-mirror'
      edMirror.setAttribute('aria-hidden', 'true')
      document.body.appendChild(edMirror)
    }
    var m = edMirror
    var cs = getComputedStyle(ta)
    /* 把影响折行的样式原样抄过去（autosize 那套老办法），
       宽度用 textarea 的**内容宽度**（已扣掉滚动条与内边距）。 */
    ;['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant', 'fontStretch',
      'letterSpacing', 'wordSpacing', 'lineHeight', 'textIndent', 'textTransform',
      'tabSize', 'mozTabSize', 'webkitTextSizeAdjust'].forEach(function (k) {
        if (cs[k]) m.style[k] = cs[k]
      })
    m.style.width = met.contentW + 'px'
    m.style.whiteSpace = 'pre-wrap'
    m.style.overflowWrap = 'break-word'
    m.style.wordBreak = 'normal'
    m.style.padding = '0'
    m.style.border = '0'
    m.style.boxSizing = 'content-box'

    var html = ''
    for (var i = 0; i < srcLines.length; i++) {
      html += '<div>' + (srcLines[i] ? mdEscape(srcLines[i]) : '<br>') + '</div>'
    }
    m.innerHTML = html

    var divs = m.children
    var rows = [0]
    var acc = 0
    for (var j = 0; j < divs.length; j++) {
      var hgt = divs[j].getBoundingClientRect().height
      acc += Math.max(1, Math.round(hgt / met.lh))
      rows.push(acc)
    }
    return { rows: rows, lineCount: srcLines.length, total: acc }
  }

  /* 量不到镜像时的兜底：等宽字体 + CJK 视作两个字符宽 */
  function estimateEditorRows(ta, met) {
    var srcLines = String(ta.value || '').replace(/\r\n?/g, '\n').split('\n')
    var cs = getComputedStyle(ta)
    var probe = document.createElement('span')
    probe.style.cssText = 'position:absolute;left:-99999px;top:0;white-space:pre;visibility:hidden'
    probe.style.fontFamily = cs.fontFamily
    probe.style.fontSize = cs.fontSize
    probe.style.fontWeight = cs.fontWeight
    probe.style.letterSpacing = cs.letterSpacing
    probe.textContent = new Array(51).join('0')
    document.body.appendChild(probe)
    var cw = probe.getBoundingClientRect().width / 50
    document.body.removeChild(probe)
    var perRow = cw > 0 ? Math.max(4, Math.floor(met.contentW / cw)) : 60
    var rows = [0]
    var acc = 0
    for (var i = 0; i < srcLines.length; i++) {
      var l = srcLines[i]
      var cols = 0
      for (var k = 0; k < l.length; k++) {
        var c = l.charCodeAt(k)
        cols += (c > 0x1100 && (c <= 0x115f || (c >= 0x2e80 && c <= 0xa4cf) ||
          (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) ||
          (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
          (c >= 0xffe0 && c <= 0xffe6))) ? 2 : 1
      }
      acc += Math.max(1, Math.ceil(cols / perRow))
      rows.push(acc)
    }
    return { rows: rows, lineCount: srcLines.length, total: acc }
  }

  function editorRowMap(ta) {
    var met = editorMetrics(ta)
    var key = met.contentW + '|' + met.lh + '|' + ta.value.length + '|' + ta.value
    if (editorRows && editorRowsKey === key) return { map: editorRows, met: met }
    var map = null
    try { map = measureEditorRows(ta, met) } catch (e) { map = null }
    if (!map) map = estimateEditorRows(ta, met)
    editorRows = map
    editorRowsKey = key
    return { map: map, met: met }
  }

  /* ---- 预览锚点：每个块的源码起始行 → 它在预览内容里的偏移 ---- */
  function anchorsOf() {
    var host = previewHost()
    if (!host) return null
    if (previewAnchors && previewAnchors.el === host) return previewAnchors
    var ta = $('#ed-body')
    var em = ta ? editorRowMap(ta) : null
    var base = host.getBoundingClientRect().top - host.scrollTop
    var list = [{ line: 0, top: 0 }]
    var kids = host.children
    for (var i = 0; i < kids.length; i++) {
      var raw = kids[i].getAttribute('data-src-line')
      if (raw === null) continue
      list.push({ line: Number(raw), top: kids[i].getBoundingClientRect().top - base })
    }
    /* 末锚点：源码最后一行 ↔ 预览内容末尾，避免尾部只能靠外插 */
    list.push({ line: em ? em.map.lineCount : 0, top: host.scrollHeight })
    /* 同一行可能有多个块（比如紧邻的两段），保留最后一个即可，保证 top 单调 */
    var clean = []
    for (var j = 0; j < list.length; j++) {
      var it = list[j]
      if (clean.length && it.top < clean[clean.length - 1].top) continue
      if (clean.length && it.line === clean[clean.length - 1].line && j < list.length - 1) {
        clean[clean.length - 1] = it
        continue
      }
      clean.push(it)
    }
    previewAnchors = { el: host, line: clean.map(function (a) { return a.line }), top: clean.map(function (a) { return a.top }) }
    return previewAnchors
  }

  function invalidateEditorScroll() {
    editorRows = null
    editorRowsKey = ''
    previewAnchors = null
  }

  /* 在 [{line},{top}] 上按 line 找位置，返回对应的 top（线性插值） */
  function topForLine(an, line) {
    var ls = an.line, ts = an.top
    var n = ls.length
    if (n < 2) return 0
    var lo = 0, hi = n - 1
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1
      if (ls[mid] <= line) lo = mid; else hi = mid
    }
    if (line <= ls[0]) return ts[0]
    if (line >= ls[n - 1]) {
      /* 尾部之外：按最后一段的斜率外插，但别越过内容末尾 */
      var dL = ls[n - 1] - ls[n - 2]
      var dT = ts[n - 1] - ts[n - 2]
      if (dL <= 0) return ts[n - 1]
      return ts[n - 1] + (line - ls[n - 1]) * (dT / dL)
    }
    var span = ls[hi] - ls[lo]
    var t = span > 0 ? (line - ls[lo]) / span : 0
    return ts[lo] + t * (ts[hi] - ts[lo])
  }

  /* 反过来：预览内容偏移 → 源码行（可带小数） */
  function lineForTop(an, top) {
    var ls = an.line, ts = an.top
    var n = ts.length
    if (n < 2) return 0
    var lo = 0, hi = n - 1
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1
      if (ts[mid] <= top) lo = mid; else hi = mid
    }
    if (top <= ts[0]) return ls[0]
    if (top >= ts[n - 1]) {
      var dT2 = ts[n - 1] - ts[n - 2]
      var dL2 = ls[n - 1] - ls[n - 2]
      if (dT2 <= 0) return ls[n - 1]
      return ls[n - 1] + (top - ts[n - 1]) * (dL2 / dT2)
    }
    var span = ts[hi] - ts[lo]
    var t = span > 0 ? (top - ts[lo]) / span : 0
    return ls[lo] + t * (ls[hi] - ls[lo])
  }

  function clampScroll(el, top) {
    var max = Math.max(0, el.scrollHeight - el.clientHeight)
    return Math.max(0, Math.min(top, max))
  }

  /* ---- 视觉行 ↔ 源码行：软折行让两者不再是 1:1，必须过这一层 ----
     rows[i] 是"第 i 行之前累计占了多少视觉行"，长度为 lineCount+1。
     行内有折行时只能按比例摊开（视觉上再没有更细的锚点）。 */
  function sourceLineToRow(map, line) {
    var rows = map.rows
    var n = rows.length - 1
    if (!n) return 0
    var L = Math.max(0, Math.min(line, n))
    if (L >= n) return rows[n]
    var i = Math.floor(L)
    return rows[i] + (L - i) * (rows[i + 1] - rows[i])
  }

  function rowToSourceLine(map, row) {
    var rows = map.rows
    var n = rows.length - 1
    if (!n) return 0
    var R = Math.max(0, Math.min(row, rows[n]))
    var lo = 0, hi = n
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1
      if (rows[mid] <= R) lo = mid; else hi = mid
    }
    var span = rows[hi] - rows[lo]
    return lo + (span > 0 ? (R - rows[lo]) / span : 0)
  }

  /* 预览顶端此刻对应哪一源码行（只看预览时重绘前后用来"钉住"位置） */
  function lineAtPreviewTop() {
    var host = previewHost()
    if (!host) return null
    var an = anchorsOf()
    if (!an) return null
    return lineForTop(an, host.scrollTop + (parseFloat(getComputedStyle(host).paddingTop) || 0))
  }

  function scrollPreviewToLine(line) {
    var host = previewHost()
    if (!host || line === null) return
    var an = anchorsOf()
    if (!an) return
    var top = clampScroll(host, topForLine(an, line) - (parseFloat(getComputedStyle(host).paddingTop) || 0))
    edSyncTarget.p = top
    host.scrollTop = top
  }

  /* ---- 两个方向 ---- */
  function syncFromEditor() {
    var ta = $('#ed-body'), host = previewHost()
    if (!ta || !host) return
    var em = editorRowMap(ta)
    /* scrollTop 是从内容原点上算的，行 0 的顶边在 padTop 处；
       "贴顶"坐标扣掉 padTop，预览那边同样扣，两边才是同一把尺子 */
    var row = (ta.scrollTop - em.met.padTop) / em.met.lh        // 视觉行
    var line = rowToSourceLine(em.map, row)                     // → 源码行（可带小数）
    var an = anchorsOf()
    if (!an) return
    var hostPad = parseFloat(getComputedStyle(host).paddingTop) || 0
    var top = clampScroll(host, topForLine(an, line) - hostPad)
    edSyncTarget.p = top
    host.scrollTop = top
  }

  function syncFromPreview() {
    var ta = $('#ed-body'), host = previewHost()
    if (!ta || !host) return
    var an = anchorsOf()
    if (!an) return
    var hostPad = parseFloat(getComputedStyle(host).paddingTop) || 0
    var line = lineForTop(an, host.scrollTop + hostPad)         // 源码行（可带小数）
    var em = editorRowMap(ta)
    var row = sourceLineToRow(em.map, line)                     // → 视觉行
    var top = clampScroll(ta, row * em.met.lh)
    edSyncTarget.e = top
    ta.scrollTop = top
  }

  /* 代码设的 scrollTop 会回弹一个 scroll 事件 —— 只吃掉"正好等于我刚设的值"那一个 */
  function onPaneScroll(which) {
    var el = which === 'e' ? $('#ed-body') : previewHost()
    if (!el) return
    var want = edSyncTarget[which]
    edSyncTarget[which] = null
    if (want !== null && Math.abs(el.scrollTop - want) <= 1) return
    if (editorMode !== 'split') return
    if (which === 'e') syncFromEditor(); else syncFromPreview()
  }

  function initEditorScrollSync() {
    var ta = $('#ed-body'), host = previewHost()
    if (!ta || !host) return
    if (ta.__scrollSyncBound) return      // boot() 万一跑两遍也不重复挂监听
    ta.__scrollSyncBound = true
    /* 只读探针：给 .perf/cdp-editor-split-scroll.js 这类验证脚本用
       （折行行数没法从 DOM 直接读，脚本要和浏览器给的 scrollHeight 对账） */
    window.__adminEditorSync = {
      probe: function () {
        var el = $('#ed-body')
        if (!el) return null
        var em = editorRowMap(el)
        var cs = getComputedStyle(el)
        return {
          totalRows: em.map.total,
          lineCount: em.map.lineCount,
          lh: em.met.lh,
          padTop: em.met.padTop,
          contentW: em.met.contentW,
          browserRows: (el.scrollHeight - (parseFloat(cs.paddingTop) || 0) -
            (parseFloat(cs.paddingBottom) || 0)) / em.met.lh,
          scrollTop: el.scrollTop,
          previewScrollTop: host.scrollTop
        }
      },
      rowOfLine: function (line) {
        var el = $('#ed-body')
        return el ? sourceLineToRow(editorRowMap(el).map, line) : null
      },
      lineAtTop: function () {
        var el = $('#ed-body')
        if (!el) return null
        var em = editorRowMap(el)
        return rowToSourceLine(em.map, (el.scrollTop - em.met.padTop) / em.met.lh)
      },
      invalidate: invalidateEditorScroll
    }
    ta.addEventListener('scroll', function () { onPaneScroll('e') }, { passive: true })
    host.addEventListener('scroll', function () { onPaneScroll('p') }, { passive: true })
    /* 图片解码完会撑高预览，锚点得重量，顺手把左侧的进度找回来 */
    host.addEventListener('load', function () {
      invalidateEditorScroll()
      if (editorMode === 'split') syncFromEditor()
    }, true)
    window.addEventListener('resize', function () {
      editorObservedW = ta.clientWidth
      invalidateEditorScroll()
      if (editorMode === 'split') syncFromEditor()   // 折行变了，位置跟着重算
    })
    if (window.ResizeObserver) {
      /* 拖动窗口宽度会改变折行数，量出来的行映射就失效了 */
      editorObservedW = ta.clientWidth
      try {
        new ResizeObserver(function () {
          if (ta.clientWidth === editorObservedW) return
          editorObservedW = ta.clientWidth
          invalidateEditorScroll()
          if (editorMode === 'split') syncFromEditor()
        }).observe(ta)
      } catch (e) {}
    }
  }

  function setEditorMode(mode) {
    var prev = editorMode
    editorMode = mode
    var body = $('#editor-body')
    if (body) body.className = 'editor-body mode-' + mode
    $$('.editor-mode').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-mode') === mode)
    })
    /* textarea 允许用户拖高；分栏/预览时两侧（或整块）必须听 CSS 的，
       行内高度会压过 CSS，所以离开「编辑」时收起来、回到「编辑」时还回去。 */
    var ta = $('#ed-body')
    if (ta) {
      if (mode === 'edit') {
        if (ta.__draggedH !== undefined) { ta.style.height = ta.__draggedH; ta.__draggedH = undefined }
      } else {
        if (prev === 'edit') ta.__draggedH = ta.style.height
        ta.style.height = ''
      }
    }
    if (mode === 'split') invalidateEditorScroll()
    if (mode !== 'edit') updatePreview()
  }

  // 编辑器内容变化后的统一收尾
  function afterEdit() {
    markDirty(true)
    scheduleDraft()
    updateStats()
    updateStickyState()
    if (editorMode !== 'edit') {
      editorRows = null              // 正文改了，行映射失效
      schedulePreview()
    }
  }

  // 打开文章 / 新建文章后同步整块 UI
  function syncEditorUI() {
    updateStats()
    updateStickyState()
    invalidateEditorScroll()
    if (editorMode !== 'edit') updatePreview()
  }

  // ---- Markdown 工具栏：在光标处插入 / 包裹选区 ----
  function insertMarkdown(kind) {
    var ta = $('#ed-body')
    var val = ta.value
    var start = ta.selectionStart
    var end = ta.selectionEnd
    var sel = val.slice(start, end)
    var out = null, selStart = 0, selEnd = 0

    function wrap(prefix, suffix, placeholder) {
      var text = sel || placeholder || ''
      out = val.slice(0, start) + prefix + text + suffix + val.slice(end)
      selStart = start + prefix.length
      selEnd = selStart + text.length
    }
    // 按行加/去前缀（列表、引用、标题）
    function linePrefix(prefix, numbered) {
      var ls = val.lastIndexOf('\n', start - 1) + 1
      var le = val.indexOf('\n', end)
      if (le < 0) le = val.length
      var lines = val.slice(ls, le).split('\n')
      var allHave = lines.every(function (l) {
        return numbered ? /^\s*\d+\.\s/.test(l) : l.indexOf(prefix) === 0
      })
      var next = lines.map(function (l, i) {
        if (allHave) return numbered ? l.replace(/^\s*\d+\.\s/, '') : l.slice(prefix.length)
        return numbered ? (i + 1) + '. ' + l : prefix + l
      })
      out = val.slice(0, ls) + next.join('\n') + val.slice(le)
      selStart = ls
      selEnd = ls + next.join('\n').length
    }

    if (kind === 'bold') wrap('**', '**', '粗体文字')
    else if (kind === 'italic') wrap('*', '*', '斜体文字')
    else if (kind === 'strike') wrap('~~', '~~', '删除线')
    else if (kind === 'code') wrap('`', '`', 'code')
    else if (kind === 'h2') linePrefix('## ')
    else if (kind === 'quote') linePrefix('> ')
    else if (kind === 'ul') linePrefix('- ')
    else if (kind === 'ol') linePrefix('', true)
    else if (kind === 'hr') {
      var pre = (start > 0 && val[start - 1] !== '\n') ? '\n\n' : ''
      var post = (end < val.length && val[end] !== '\n') ? '\n\n' : ''
      out = val.slice(0, start) + pre + '---' + post + val.slice(end)
      selStart = selEnd = start + pre.length + 3
    } else if (kind === 'codeblock') {
      var pre2 = (start > 0 && val[start - 1] !== '\n') ? '\n' : ''
      var text2 = sel || 'code'
      out = val.slice(0, start) + pre2 + '```\n' + text2 + '\n```\n' + val.slice(end)
      selStart = start + pre2.length + 4
      selEnd = selStart + text2.length
    } else if (kind === 'link' || kind === 'image') {
      var label = sel || (kind === 'link' ? '链接文字' : '图片描述')
      var s = (kind === 'link' ? '[' : '![') + label + ']()'
      out = val.slice(0, start) + s + val.slice(end)
      selStart = selEnd = start + s.length - 1
    } else if (kind === 'table') {
      var pre3 = (start > 0 && val[start - 1] !== '\n') ? '\n\n' : ''
      var t = '| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |'
      out = val.slice(0, start) + pre3 + t + val.slice(end)
      selStart = selEnd = start + pre3.length + t.length
    }

    if (out === null) return
    ta.value = out
    ta.focus()
    ta.setSelectionRange(selStart, selEnd)
    afterEdit()
  }

  // 光标是否落在围栏代码块里（代码块内不做列表续行）
  function insideFence(val, pos) {
    var n = 0, idx = 0
    for (;;) {
      var i = val.indexOf('```', idx)
      if (i < 0 || i >= pos) break
      n++
      idx = i + 3
    }
    return n % 2 === 1
  }

  // ---- 正文键盘行为：Tab 缩进 / Enter 续行 / 选区自动包裹 ----
  function onBodyKeydown(e) {
    var ta = $('#ed-body')
    var val = ta.value
    var start = ta.selectionStart
    var end = ta.selectionEnd

    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      var k = (e.key || '').toLowerCase()
      if (k === 'b') { e.preventDefault(); insertMarkdown('bold'); return }
      if (k === 'i') { e.preventDefault(); insertMarkdown('italic'); return }
      if (k === 'k') { e.preventDefault(); insertMarkdown('link'); return }
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      if (start === end) {
        if (e.shiftKey) {
          var ls = val.lastIndexOf('\n', start - 1) + 1
          if (val.slice(ls, ls + 2) === '  ') {
            ta.value = val.slice(0, ls) + val.slice(ls + 2)
            ta.setSelectionRange(Math.max(ls, start - 2), Math.max(ls, start - 2))
          }
        } else {
          ta.value = val.slice(0, start) + '  ' + val.slice(end)
          ta.setSelectionRange(start + 2, start + 2)
        }
      } else {
        var ls2 = val.lastIndexOf('\n', start - 1) + 1
        var block = val.slice(ls2, end)
        var shifted = block.split('\n').map(function (l) {
          return e.shiftKey ? l.replace(/^ {1,2}/, '') : '  ' + l
        }).join('\n')
        ta.value = val.slice(0, ls2) + shifted + val.slice(end)
        ta.setSelectionRange(ls2, ls2 + shifted.length)
      }
      afterEdit()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && start === end && !insideFence(val, start)) {
      var lsE = val.lastIndexOf('\n', start - 1) + 1
      var line = val.slice(lsE, start)
      var m = /^(\s*)([-*+]|\d+\.|>)\s+(.*)$/.exec(line)
      if (m) {
        e.preventDefault()
        if (!m[3].trim()) {
          // 空项回车 → 结束列表/引用，去掉标记
          ta.value = val.slice(0, lsE) + val.slice(start)
          ta.setSelectionRange(lsE, lsE)
        } else {
          var marker = /^\d+\.$/.test(m[2]) ? (parseInt(m[2], 10) + 1) + '.' : m[2]
          var ins = '\n' + m[1] + marker + ' '
          ta.value = val.slice(0, start) + ins + val.slice(end)
          ta.setSelectionRange(start + ins.length, start + ins.length)
        }
        afterEdit()
        return
      }
    }

    // 选中文字后输入成对符号 → 直接包裹
    if (!e.ctrlKey && !e.metaKey && !e.altKey && (e.key || '').length === 1 && end > start) {
      var pair = { '*': '*', _: '_', '`': '`', '~': '~', '[': ']', '(': ')' }[e.key]
      if (pair) {
        e.preventDefault()
        var selected = val.slice(start, end)
        var rep = e.key + selected + pair
        ta.value = val.slice(0, start) + rep + val.slice(end)
        ta.setSelectionRange(start + 1, start + 1 + selected.length)
        afterEdit()
      }
    }
  }

  function initEditorUI() {
    var fields = ['#ed-title', '#ed-date', '#ed-sticky', '#ed-categories', '#ed-tags', '#ed-desc']
    fields.forEach(function (sel) {
      var el = $(sel)
      if (el) el.addEventListener('input', afterEdit)
    })
    $('#ed-body').addEventListener('input', afterEdit)
    $('#ed-body').addEventListener('keydown', onBodyKeydown)
    initEditorScrollSync()

    $$('.editor-tool').forEach(function (b) {
      b.addEventListener('click', function () { insertMarkdown(b.getAttribute('data-md')) })
    })
    $$('.editor-mode').forEach(function (b) {
      b.addEventListener('click', function () { setEditorMode(b.getAttribute('data-mode')) })
    })
    $('#btn-restore-draft').addEventListener('click', restoreDraft)
    $('#btn-drop-draft').addEventListener('click', function () {
      clearDraft()
      toast('已忽略本地草稿')
    })

    // Ctrl/Cmd+S 保存（编辑器打开时）
    document.addEventListener('keydown', function (e) {
      if (!(e.ctrlKey || e.metaKey) || (e.key || '').toLowerCase() !== 's') return
      var view = $('#post-editor-view')
      if (!view || view.style.display === 'none') return
      e.preventDefault()
      savePost()
    })
    // 有未保存修改时，关页面/刷新给一次确认
    window.addEventListener('beforeunload', function (e) {
      if (!editorDirty) return
      e.preventDefault()
      e.returnValue = ''
    })
  }

  // ==================== 门禁 ====================
  function unlocked() {
    try { return sessionStorage.getItem(UNLOCK_STORE) === ADMIN_HASH } catch (e) { return false }
  }
  function unlock() {
    try { sessionStorage.setItem(UNLOCK_STORE, ADMIN_HASH) } catch (e) {}
    $('#admin-gate').style.display = 'none'
    $('#admin-app').style.display = ''
    boot()
  }

  function initGate() {
    var input = $('#gate-key'), btn = $('#gate-btn'), msg = $('#gate-msg')
    function tryUnlock() {
      // 密钥=普通密码：大小写敏感，不做大写化、不做格式裁剪
      var v = input.value.trim()
      if (!v) { msg.textContent = '请输入密钥'; return }
      msg.textContent = '校验中…'
      sha256hex(v).then(function (hex) {
        if (hex === ADMIN_HASH) { unlock() }
        else { msg.textContent = '密钥不正确'; input.select() }
      }).catch(function (e) { msg.textContent = e.message })
    }
    btn.addEventListener('click', tryUnlock)
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') tryUnlock() })
    input.focus()
  }

  // ==================== 设置读取 ====================
  // GitHub Token 的合法形态（经典 PAT = ghp_…，细粒度 PAT = github_pat_…）
  var TOKEN_RE = /^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/

  /* 读本机 Token：把「没存 / 存了但解不开 / 存的是旧明文 / 本机存储被禁」分开报。
     以前这里只 return ''，页面就只剩一句红色的"未配置 Token"，
     完全看不出是没填还是存坏了 —— 报错信息必须能自证。 */
  function readStoredToken() {
    var raw = null
    try { raw = localStorage.getItem(TOKEN_STORE) } catch (e) {
      return { state: 'blocked', token: '', reason: (e && e.message) || '本机存储不可用' }
    }
    if (!raw) return { state: 'empty', token: '' }
    var tok = decToken(raw)
    if (tok) return { state: 'ok', token: tok }
    var plain = String(raw).trim()
    if (TOKEN_RE.test(plain)) return { state: 'legacy', token: plain }
    return { state: 'broken', token: '', reason: '前缀或 CRC 校验不符' }
  }

  function loadGhConfig() {
    try {
      var cfg = JSON.parse(localStorage.getItem(CFG_STORE) || 'null')
      if (cfg) {
        state.gh.owner = cfg.owner || state.gh.owner
        state.gh.name = cfg.name || state.gh.name
        state.gh.branch = cfg.branch || state.gh.branch
      }
    } catch (e) {}
    // localStorage 本身也可能抛（浏览器禁用站点数据），单独兜住，别让 boot() 挂掉
    var st = readStoredToken()
    state.gh.token = st.token || ''
    // 旧格式（明文）顺手升级成混淆编码，免得下次又被当成"没配置"
    if (st.state === 'legacy' && st.token) {
      try { localStorage.setItem(TOKEN_STORE, encToken(st.token)) } catch (e) {}
    }
  }

  function saveGhConfig() {
    var owner = $('#gh-owner').value.trim() || 'Leafmy'
    var name = $('#gh-name').value.trim() || 'Leafmy_blogsource'
    var branch = $('#gh-branch').value.trim() || 'main'
    var token = $('#gh-token').value.trim()
    if (!token) { toast('请填入 GitHub Token', 'err'); return }
    if (!TOKEN_RE.test(token) &&
      !confirm('这串字符不像 GitHub Token（经典 PAT 形如 ghp_…，细粒度 PAT 形如 github_pat_…）。仍然保存吗？')) return
    state.gh.owner = owner; state.gh.name = name; state.gh.branch = branch; state.gh.token = token
    try {
      localStorage.setItem(CFG_STORE, JSON.stringify({ owner: owner, name: name, branch: branch }))
      localStorage.setItem(TOKEN_STORE, encToken(token))
      if (!localStorage.getItem(TOKEN_STORE)) throw new Error('编码后为空')
    } catch (e) {
      toast('本机存储写入失败：' + ((e && e.message) || e), 'err')
      return
    }
    renderRepoStatus()
    toast('凭证已保存，正在体检…', 'ok')
    diagnose()
  }

  function renderRepoStatus() {
    var el = $('#admin-repo')
    if (!el) return
    var st = readStoredToken()
    var label = ' · 未配置 Token', bad = true
    if (st.state === 'ok' || st.state === 'legacy') {
      bad = false
      // 体检结果也写进顶栏：Token 存着但已经失效时，顶栏不能继续显示"已授权"
      if (state.gh.check === 'ok') label = ' · 已连接'
      else if (state.gh.check === 'fail') { label = ' · Token 校验失败（看「设置」）'; bad = true }
      else label = ' · 已授权'
    } else if (st.state === 'broken') label = ' · Token 解不开，请重新填写'
    else if (st.state === 'blocked') label = ' · 本机存储不可用'
    el.textContent = state.gh.owner + '/' + state.gh.name + ' @' + state.gh.branch + label
    el.style.color = bad ? '#ffb4ae' : ''
  }

  // ==================== 数据加载 ====================
  function fetchJSON(url) {
    return fetch(url + '?t=' + Date.now(), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' 加载失败（HTTP ' + r.status + '）')
      return r.json()
    })
  }

  function reloadManifest(silent) {
    return Promise.all([
      fetchJSON('/admin/posts.json'),
      fetchJSON('/admin/meta.json'),
      fetchJSON('/admin/pages.json').catch(function () { return { pages: [] } })
    ]).then(function (res) {
      state.posts = (res[0] && res[0].posts) || []
      state.meta = res[1] || null
      state.pages = (res[2] && res[2].pages) || []
      // 清单变了（文字条目/默认值可能跟着变），下次进「文字」页重新拉一遍
      textState.loaded = false
      renderOverview()
      renderPages()
      renderPosts()
      renderTaxonomy()
      renderArchives()
      if ($('#tab-texts') && $('#tab-texts').classList.contains('is-active')) loadTexts(true)
      if ($('#tab-visual') && $('#tab-visual').classList.contains('is-active')) {
        visualState.announceApplied = ''
        if (textState.loaded) {
          visualClearHits()
          visualMarkHits()
        }
        visualApplyStyle()
        visualRefreshRules()
      }
      if (!silent) toast('清单已刷新（数据来自最近一次站点构建）', 'ok')
    }).catch(function (e) {
      toast('清单加载失败：' + e.message, 'err')
    })
  }

  // ==================== 概览 ====================
  function renderOverview() {
    var m = state.meta
    if (!m) return
    $('#stat-posts').textContent = m.totals.posts
    $('#stat-tags').textContent = m.totals.tags
    $('#stat-cats').textContent = m.totals.categories
    $('#stat-months').textContent = m.archives.length
    var recent = state.posts.slice(0, 6)
    $('#overview-recent').innerHTML = recent.length ? recent.map(function (p) {
      return '<div class="admin-item" data-open="' + esc(p.source) + '">' +
        '<div class="admin-item-main">' +
        '<div class="admin-item-title">' + esc(p.title || '(无标题)') + '</div>' +
        '<div class="admin-item-meta">' + esc(p.date) + ' · ' + esc((p.categories || []).join(' / ') || '未分类') + '</div>' +
        '</div></div>'
    }).join('') : '<div class="admin-empty">还没有文章</div>'
    $$('#overview-recent .admin-item').forEach(function (el) {
      el.addEventListener('click', function () { openEditor(el.getAttribute('data-open')) })
    })
  }

  // ==================== 文章 ====================
  function renderPosts() {
    var kw = state.filter.toLowerCase()
    var list = state.posts.filter(function (p) {
      if (!kw) return true
      return (p.title + ' ' + (p.tags || []).join(' ') + ' ' + (p.categories || []).join(' ')).toLowerCase().indexOf(kw) > -1
    }).slice()
    // 置顶的排在最前（和首页一致：数字越小越靠前，0 = 不置顶，同号按日期倒序）
    list.sort(function (a, b) {
      var sa = Number(a.sticky || 0), sb = Number(b.sticky || 0)
      if (sa > 0 && sb > 0) {
        return (sa - sb) || String(b.date || '').localeCompare(String(a.date || ''))
      }
      if (sa > 0) return -1
      if (sb > 0) return 1
      return String(b.date || '').localeCompare(String(a.date || ''))
    })
    var host = $('#posts-list')
    host.innerHTML = list.length ? list.map(function (p) {
      return '<div class="admin-item" data-open="' + esc(p.source) + '">' +
        '<div class="admin-item-main">' +
        '<div class="admin-item-title">' + esc(p.title || '(无标题)') +
        (p.sticky ? ' <span class="admin-pill">置顶 ' + Number(p.sticky) + '</span>' : '') + '</div>' +
        '<div class="admin-item-meta">' + esc(p.date) + ' · ' +
        (p.categories || []).map(function (c) { return esc(c) }).join(' / ') + '</div>' +
        '</div>' +
        '<div class="admin-item-actions">' +
        '<button class="admin-btn" data-edit="' + esc(p.source) + '">编辑</button>' +
        '</div></div>'
    }).join('') : '<div class="admin-empty">没有匹配的文章</div>'

    $$('#posts-list .admin-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        var src = (e.target.getAttribute && e.target.getAttribute('data-edit')) || el.getAttribute('data-open')
        openEditor(src)
      })
    })
  }

  /* 写作页比别的标签页更吃宽度：1200px 的壳在分栏下把每侧压到 ~530px，
     正文一行放不下几个字。只在「打开编辑器」时把壳放宽（CSS 里 .is-editing），
     列表面板与其它标签页维持原样。 */
  function setEditorWide(on) {
    var app = $('#admin-app')
    if (app) app.classList.toggle('is-editing', !!on)
  }

  function showListView() {
    $('#posts-list-view').style.display = ''
    $('#post-editor-view').style.display = 'none'
    setEditorWide(false)
  }

  // 文章用全套字段；页面（关于之类）只有标题 / 日期 / 正文
  function setEditorKind(kind) {
    var isPage = kind === 'page'
    ;['#field-sticky', '#field-categories', '#field-tags', '#field-desc'].forEach(function (sel) {
      var el = $(sel)
      if (el) el.style.display = isPage ? 'none' : ''
    })
    $('#btn-delete-post').style.display = isPage ? 'none' : ''
  }

  function newPost() {
    state.editing = { mode: 'new', kind: 'post', path: '', sha: null, data: {}, body: '' }
    $('#editor-file').textContent = '新文章（保存后写入 ' + (state.meta ? state.meta.postsDir : 'source/_posts') + '/）'
    $('#ed-title').value = ''
    $('#ed-date').value = fmtDate(new Date())
    $('#ed-sticky').value = '0'
    $('#ed-categories').value = ''
    $('#ed-tags').value = ''
    $('#ed-desc').value = ''
    $('#ed-body').value = ''
    setEditorKind('post')
    $('#btn-delete-post').style.display = 'none'
    $('#posts-list-view').style.display = 'none'
    $('#post-editor-view').style.display = ''
    setEditorWide(true)
    markDirty(false)
    setEditorMode('edit')
    syncEditorUI()
    checkDraft()
    $('#ed-title').focus()
  }

  // kind: 'post'（默认）| 'page'
  function openEditor(source, kind) {
    if (!source) return
    kind = kind === 'page' ? 'page' : 'post'
    var isPage = kind === 'page'
    var meta = (isPage ? state.pages : state.posts).filter(function (p) { return p.source === source })[0]
    var fullPath = 'source/' + source
    $('#editor-file').textContent = fullPath + ' · 读取中…'
    $('#posts-list-view').style.display = 'none'
    $('#post-editor-view').style.display = ''
    setEditorWide(true)      // 写作页放宽容器（见 setEditorWide 注释）
    setEditorKind(kind)

    ghGetFile(fullPath).then(function (file) {
      if (!file) { toast('仓库里找不到该文件：' + fullPath, 'err'); showListView(); return }
      var fm = parseFrontMatter(file.text)
      state.editing = { mode: isPage ? 'page' : 'edit', kind: kind, path: fullPath, sha: file.sha, data: fm.data, body: fm.body }
      $('#editor-file').textContent = fullPath + (isPage ? ' · 页面' : '')
      $('#ed-title').value = fm.data.title || (meta && meta.title) || ''
      $('#ed-date').value = fm.data.date || (meta && meta.date) || ''
      // 页面用不到这几个字段，但也清干净，免得残留上一篇的值
      $('#ed-sticky').value = String(fm.data.sticky || 0)
      $('#ed-categories').value = Array.isArray(fm.data.categories) ? fm.data.categories.join(', ') : (fm.data.categories || '')
      $('#ed-tags').value = Array.isArray(fm.data.tags) ? fm.data.tags.join(', ') : (fm.data.tags || '')
      $('#ed-desc').value = fm.data.description || ''
      $('#ed-body').value = fm.body
      markDirty(false)
      syncEditorUI()
      checkDraft()
    }).catch(function (e) {
      $('#editor-file').textContent = fullPath + ' · 读取失败'
      toast('读取失败：' + e.message, 'err')
    })
  }

  // ==================== 页面 ====================
  function renderPages() {
    var host = $('#pages-list')
    var panel = $('#pages-panel')
    if (!host || !panel) return
    var list = state.pages || []
    panel.style.display = list.length ? '' : 'none'
    host.innerHTML = list.length ? list.map(function (p) {
      return '<div class="admin-item" data-page="' + esc(p.source) + '">' +
        '<div class="admin-item-main">' +
        '<div class="admin-item-title">' + esc(p.title || '(无标题)') + '</div>' +
        '<div class="admin-item-meta">' + esc(p.source) + (p.updated ? ' · ' + esc(p.updated) : '') + '</div>' +
        '</div>' +
        '<div class="admin-item-actions">' +
        '<button class="admin-btn" data-page-edit="' + esc(p.source) + '">编辑</button>' +
        '</div></div>'
    }).join('') : ''
    $$('#pages-list .admin-item').forEach(function (el) {
      el.addEventListener('click', function (e) {
        var src = (e.target.getAttribute && e.target.getAttribute('data-page-edit')) || el.getAttribute('data-page')
        openEditor(src, 'page')
      })
    })
  }

  function collectEditor() {
    var ed = state.editing || {}
    var data = Object.assign({}, ed.data || {})
    data.title = $('#ed-title').value.trim()
    data.date = $('#ed-date').value.trim() || fmtDate(new Date())
    if (ed.kind === 'page') {
      // 页面不动分类/标签/置顶/摘要：保留 front-matter 里原有的那些键，不新增
      return { data: data, body: $('#ed-body').value }
    }
    data.categories = splitList($('#ed-categories').value)
    data.tags = splitList($('#ed-tags').value)
    var desc = $('#ed-desc').value.trim()
    if (desc) data.description = desc; else delete data.description
    // 置顶：统一用 sticky 表达（scripts/index-pin-order.js 按数字**升序**排，
    // 1 = 最前、0 = 不置顶），顺手清掉旧的 top 布尔字段，避免两个字段打架
    var sticky = Number($('#ed-sticky').value || 0)
    if (sticky > 0) data.sticky = sticky; else delete data.sticky
    delete data.top
    return { data: data, body: $('#ed-body').value }
  }

  function savePost() {
    var ed = state.editing
    if (!ed) return
    var got = collectEditor()
    if (!got.data.title) { toast('请填写标题', 'err'); return }
    var btn = $('#btn-save-post')
    btn.disabled = true
    var content = buildFrontMatter(got.data) + '\n' + got.body.replace(/^\n+/, '')
    var isNew = ed.mode === 'new'
    var isPage = ed.kind === 'page'
    var path = isNew
      ? (state.meta ? state.meta.postsDir : 'source/_posts') + '/' + slugify(got.data.title) + '.md'
      : ed.path
    var msg = (isNew ? 'admin: 新建文章 ' : (isPage ? 'admin: 更新页面 ' : 'admin: 更新文章 ')) + got.data.title
    ghPutFile(path, content, msg, isNew ? null : ed.sha).then(function (res) {
      btn.disabled = false
      toast('已提交到仓库：' + path + '（站点重新构建后生效）', 'ok')
      clearDraft()
      markDirty(false, '✓ 已提交')
      if (res && res.content) {
        ed.mode = isPage ? 'page' : 'edit'; ed.path = path; ed.sha = res.content.sha
        $('#editor-file').textContent = path + (isPage ? ' · 页面' : '')
        $('#btn-delete-post').style.display = isPage ? 'none' : ''
      }
      // 本地清单先打补丁，避免"看不到刚改的"
      var src = path.replace(/^source\//, '')
      if (isPage) {
        var pg = state.pages.filter(function (p) { return p.source === src })[0]
        if (pg) { pg.title = got.data.title; pg.date = got.data.date; pg.updated = fmtDate(new Date()) }
        renderPages()
        return
      }
      var existing = state.posts.filter(function (p) { return p.source === src })[0]
      if (existing) {
        existing.title = got.data.title
        existing.date = got.data.date
        existing.categories = got.data.categories
        existing.tags = got.data.tags
        existing.sticky = Number(got.data.sticky || 0)
      } else {
        state.posts.unshift({
          source: src, path: '', title: got.data.title, date: got.data.date,
          updated: '', categories: got.data.categories, tags: got.data.tags,
          sticky: Number(got.data.sticky || 0), top: false, excerpt: ''
        })
      }
      renderPosts()
    }).catch(function (e) {
      btn.disabled = false
      toast('保存失败：' + e.message, 'err')
    })
  }

  function deletePost() {
    var ed = state.editing
    if (!ed || ed.mode !== 'edit') return
    if (!confirm('确定删除这篇文章？\n' + ed.path + '\n\n（会直接提交到仓库）')) return
    ghDeleteFile(ed.path, ed.sha, 'admin: 删除文章 ' + ed.path).then(function () {
      state.posts = state.posts.filter(function (p) { return 'source/' + p.source !== ed.path })
      toast('已删除：' + ed.path, 'ok')
      showListView()
      renderPosts()
    }).catch(function (e) { toast('删除失败：' + e.message, 'err') })
  }

  // ==================== 可视化（短文本就地改 + 字形 / 位置）====================
  /* ------------------------------------------------------------
     [为什么是 iframe 画布]
     本站是静态站，管理页没有后端渲染能力。把**真实站点页面**塞进同源 iframe，
     画布里跑的就是线上那份 HTML/CSS/字体 —— 所见即所得不需要"模拟样式"这层，
     也不会出现"管理页预览好看、线上歪掉"。父页面与 iframe 同源，可以直接读它的
     DOM，所以不用往站点里塞任何编辑器脚本（线上保持零侵入）。

     [三件事]
      ① 改文字：点元素 → 认出它对应 scripts/site-text-catalog.js 里的哪个键
         → 改键的"当前值"（保存后由构建期写进配置 / i18n / 模板）
      ② 改字形/位置：点元素 → 生成一条 CSS 规则（写进 site_text.yml 的 styles 段）
      ③ 改公告：点侧栏公告卡 → contenteditable 富文本；值同样进文字表
         （aside.announcement.content，模板里 st() 优先取它）

     [预览与线上用同一份算法]
     styles 段的注入方式见 scripts/site-text.js（<style id="site-text-style"> 在
     head 末尾）；这里把草稿规则注进 <style id="st-live">，位置同样在 head 末尾。
     声明串的 !important 规则两边一致：只有 font-family 强制，其它看规则上的开关。
     ------------------------------------------------------------ */

  var VISUAL_FILE_FALLBACK = 'source/_data/site_text.yml'
  var ANNOUNCE_KEY = 'aside.announcement.content'

  var visualState = {
    ready: false,
    page: '',
    width: 0,
    freeze: true,
    outline: true,
    rules: [],        // 草稿规则 [{sel, note, css, important, decls:[{prop,value}]}]
    savedRules: [],   // 上次保存时的快照（JSON 比较）
    sel: null,        // 当前选中元素的"只这一处"选择器
    ruleSel: null,    // 当前编辑的规则选择器（可能是"同类全部"那个）
    info: null,
    textKey: '',
    announceEditing: false,
    announceApplied: '',
    lastRange: null,
    loading: false
  }

  var VISUAL_FONT_OPTS = [
    { v: '', label: '跟随站点' },
    { v: "'PingFangMedium', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', 'PingFang SC', 'Microsoft YaHei', sans-serif", label: '苹方（站点默认）' },
    { v: 'var(--serif-cjk)', label: '衬线（站名同款）' },
    { v: "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', STSong, SimSun, serif", label: '宋体 / 思源衬线' },
    { v: "'Fira Code', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", label: '等宽（代码字体）' },
    { v: 'Georgia, "Times New Roman", serif', label: '西文衬线' }
  ]

  var VISUAL_TEXT_FIELDS = [
    { prop: 'font-family', kind: 'select', label: '字体', opts: VISUAL_FONT_OPTS },
    { prop: 'font-size', kind: 'num', label: '字号', unit: 'px', min: 8, max: 120, step: 1 },
    {
      prop: 'font-weight',
      kind: 'select',
      label: '字重',
      opts: [
        { v: '', label: '跟随' }, { v: '300', label: '300 细' }, { v: '400', label: '400 常规' },
        { v: '500', label: '500 中黑' }, { v: '600', label: '600 半粗' }, { v: '700', label: '700 粗' }, { v: '800', label: '800 特粗' }
      ]
    },
    { prop: 'letter-spacing', kind: 'num', label: '字距', unit: 'px', min: -6, max: 24, step: 0.2 },
    { prop: 'line-height', kind: 'num', label: '行高', unit: '', min: 0.8, max: 3, step: 0.05 },
    { prop: 'color', kind: 'color', label: '颜色' },
    { prop: 'text-shadow', kind: 'glow', label: '光晕' },
    {
      prop: 'text-align',
      kind: 'select',
      label: '对齐',
      opts: [{ v: '', label: '跟随' }, { v: 'left', label: '左对齐' }, { v: 'center', label: '居中' }, { v: 'right', label: '右对齐' }, { v: 'justify', label: '两端对齐' }]
    },
    { prop: 'opacity', kind: 'num', label: '透明度', unit: '', min: 0, max: 1, step: 0.05 },
    { prop: 'font-style', kind: 'toggle', label: '斜体', on: 'italic' },
    {
      prop: 'white-space',
      kind: 'select',
      label: '换行',
      opts: [{ v: '', label: '跟随' }, { v: 'normal', label: '可换行' }, { v: 'nowrap', label: '不换行' }]
    }
  ]

  var VISUAL_POS_FIELDS = [
    { prop: 'left', kind: 'num', label: '左右偏移', unit: 'px', min: -300, max: 300, step: 1, hint: '相对原位置平移，不挤动别的元素' },
    { prop: 'top', kind: 'num', label: '上下偏移', unit: 'px', min: -300, max: 300, step: 1 },
    { prop: 'margin-top', kind: 'num', label: '上间距', unit: 'px', min: -40, max: 200, step: 1, hint: '会影响排版（把下面的内容推开）' },
    { prop: 'margin-bottom', kind: 'num', label: '下间距', unit: 'px', min: -40, max: 200, step: 1 },
    { prop: 'width', kind: 'text', label: '宽度', ph: 'auto / 120px / 60%' },
    { prop: 'max-width', kind: 'text', label: '最大宽度', ph: 'none / 240px' }
  ]

  var VISUAL_COMPUTED_PROPS = [
    'font-family', 'font-size', 'font-weight', 'letter-spacing', 'line-height', 'color',
    'text-align', 'text-shadow', 'opacity', 'font-style', 'white-space',
    'position', 'left', 'top', 'margin-top', 'margin-bottom', 'width', 'max-width'
  ]

  function visualWin () { var f = $('#visual-frame'); return f ? f.contentWindow : null }
  function visualDoc () { var w = visualWin(); return w ? w.document : null }
  function visualFile () { return (state.meta && state.meta.texts && state.meta.texts.file) || VISUAL_FILE_FALLBACK }

  function visualStatus (msg, bad) {
    var el = $('#visual-status')
    if (!el) return
    el.textContent = msg
    el.classList.toggle('is-bad', !!bad)
  }

  function visualCssEscape (win, s) {
    if (win && win.CSS && typeof win.CSS.escape === 'function') return win.CSS.escape(String(s))
    return String(s).replace(/[^a-zA-Z0-9_\u00a0-\uffff-]/g, function (c) { return '\\' + c })
  }

  /* 元素自己的类名列表 —— 必须剔掉编辑器画上去的 st-* 类，
     否则生成的选择器里会带上 .st-selected 这种只在编辑期存在的类，
     线上永远匹配不到（这个坑踩过一次：规则看着生效，重新构建后全失效）。 */
  var VISUAL_OWN_CLASSES = /^st-(hit|hover|selected|flash)$/
  function visualClasses (el) {
    return String((el && el.getAttribute && el.getAttribute('class')) || '')
      .trim().split(/\s+/).filter(function (c) { return c && !VISUAL_OWN_CLASSES.test(c) })
  }

  function visualCount (win, sel) {
    if (!sel) return 0
    try { return win.document.querySelectorAll(sel).length } catch (e) { return -1 }
  }

  /* 只命中这一个元素的选择器：优先 id，其次"最近的 id 祖先 > 带类的路径"，
     同类兄弟多于一个时补 nth-child。生成的选择器不含伪类、不含引号，
     服务端 scripts/site-text-lib.js 的 sanitizeSel() 会原样放行。 */
  function visualUniqueSel (win, el) {
    var doc = win.document
    if (!el || el.nodeType !== 1) return ''
    var tag = el.tagName.toLowerCase()
    if (tag === 'html' || tag === 'body') return tag
    if (el.id) {
      var idOnly = '#' + visualCssEscape(win, el.id)
      if (visualCount(win, idOnly) === 1) return idOnly
    }
    var parts = []
    var cur = el
    var guard = 0
    while (cur && cur.nodeType === 1 && guard++ < 14) {
      var t = cur.tagName.toLowerCase()
      if (t === 'html' || t === 'body') { parts.unshift(t); break }
      if (cur.id) {
        var idSel = '#' + visualCssEscape(win, cur.id)
        if (visualCount(win, idSel) === 1) { parts.unshift(idSel); break }
      }
      var part = t
      var cls = visualClasses(cur).slice(0, 2)
      if (cls.length) part += '.' + cls.map(function (c) { return visualCssEscape(win, c) }).join('.')
      var parent = cur.parentNode
      if (parent && parent.children && parent.children.length > 1) {
        var idx = 1, same = 0
        for (var i = 0; i < parent.children.length; i++) {
          var sib = parent.children[i]
          if (sib === cur) idx = i + 1
          if (sib.tagName === cur.tagName && visualClasses(sib).join(' ') === visualClasses(cur).join(' ')) same++
        }
        if (same > 1) part += ':nth-child(' + idx + ')'
      }
      parts.unshift(part)
      cur = cur.parentNode
    }
    return parts.join(' > ')
  }

  /* "同类全部"的选择器：最近的 id 祖先 + 标签.第一个类
     —— 例如公告正文里所有段落 → #aside-content .card-announcement p */
  function visualGroupSel (win, el) {
    if (!el || el.nodeType !== 1) return ''
    if (el.id) {
      var idOnly = '#' + visualCssEscape(win, el.id)
      if (visualCount(win, idOnly) === 1) return idOnly
    }
    var tag = el.tagName.toLowerCase()
    var cls = visualClasses(el)
    var anchor = null, cur = el.parentNode
    while (cur && cur.nodeType === 1) {
      if (cur.id) { anchor = cur; break }
      cur = cur.parentNode
    }
    var scope = anchor ? ('#' + visualCssEscape(win, anchor.id) + ' ') : ''
    if (cls.length) return scope + tag + '.' + visualCssEscape(win, cls[0])
    return scope + tag
  }

  function visualParseCss (css) {
    var out = []
    String(css == null ? '' : css).split(';').forEach(function (part) {
      var m = /^\s*([a-zA-Z-]+)\s*:\s*([\s\S]+?)\s*$/.exec(part)
      if (!m) return
      var imp = false
      var value = m[2].replace(/!\s*important\s*$/i, function () { imp = true; return '' }).trim()
      if (!value) return
      out.push({ prop: m[1].toLowerCase(), value: value, important: imp })
    })
    return out
  }

  function visualJoinCss (decls, important) {
    return (decls || []).map(function (d) {
      var imp = important || d.important || d.prop === 'font-family'
      return d.prop + ': ' + d.value + (imp ? ' !important' : '')
    }).join('; ')
  }

  // 写进文件的形态：不带 !important（服务端按同样的规则重新加）
  function visualFileCss (rule) {
    return (rule.decls || []).map(function (d) {
      return d.prop + ': ' + d.value + (d.important ? ' !important' : '')
    }).join('; ')
  }

  function visualRulesSnapshot (rules) {
    return JSON.stringify((rules || []).map(function (r) {
      return { sel: r.sel, note: r.note || '', css: visualFileCss(r), important: !!r.important }
    }))
  }

  /* ---------- 规则读写 ---------- */
  function visualRule (sel, create) {
    if (!sel) return null
    for (var i = 0; i < visualState.rules.length; i++) {
      if (visualState.rules[i].sel === sel) return visualState.rules[i]
    }
    if (!create) return null
    var r = { sel: sel, note: '', important: false, decls: [], relAuto: false, css: '' }
    visualState.rules.push(r)
    return r
  }

  function visualDecl (sel, prop) {
    var r = visualRule(sel, false)
    if (!r) return null
    for (var i = 0; i < r.decls.length; i++) if (r.decls[i].prop === prop) return r.decls[i]
    return null
  }

  function visualSetDecl (sel, prop, value) {
    var r = visualRule(sel, true)
    if (!r) return
    if (!r.note && visualState.info && visualState.ruleSel === sel) r.note = visualState.info.label
    r.decls = r.decls.filter(function (d) { return d.prop !== prop })
    if (value !== '' && value !== null && value !== undefined) {
      r.decls.push({ prop: prop, value: String(value), important: false })
    }
    // 相对偏移需要 position:relative 才生效；原来就是 relative/absolute 的元素别动它
    if (prop === 'left' || prop === 'top') {
      var hasOffset = r.decls.some(function (d) { return d.prop === 'left' || d.prop === 'top' })
      var hasPos = r.decls.some(function (d) { return d.prop === 'position' })
      var computedPos = (visualState.info && visualState.info.computed && visualState.info.computed.position) || ''
      if (hasOffset && !hasPos && computedPos === 'static') {
        r.decls.push({ prop: 'position', value: 'relative', important: false })
        r.relAuto = true
      }
      if (!hasOffset && hasPos && r.relAuto) {
        r.decls = r.decls.filter(function (d) { return d.prop !== 'position' })
        r.relAuto = false
      }
    }
    r.css = visualFileCss(r)
    visualApplyStyle()
    visualRefreshRules()
  }

  /* ---------- 画布：样式注入 ---------- */
  function visualFrameCss () {
    return [
      '.st-hover{outline:2px dashed rgba(120,240,255,.9) !important;outline-offset:2px !important}',
      '.st-selected{outline:2px solid #5ce1ff !important;outline-offset:3px !important;box-shadow:0 0 0 4px rgba(92,225,255,.16) !important}',
      '.st-hit{outline:1px dashed rgba(120,240,255,.34);outline-offset:2px}',
      '.st-flash{animation:stFlash 1.1s ease-out 1 !important}',
      '@keyframes stFlash{0%{box-shadow:0 0 0 0 rgba(92,225,255,.65)}100%{box-shadow:0 0 0 14px rgba(92,225,255,0)}}',
      'html.st-editing .card-announcement .announcement_body{max-height:1200px !important;opacity:1 !important;margin-top:6px !important;padding:2px !important}',
      'html.st-editing [contenteditable="true"]{outline:1px solid rgba(92,225,255,.55) !important;outline-offset:4px !important;cursor:text !important}'
    ].join('\n')
  }

  var VISUAL_FREEZE_CSS = '*,*::before,*::after{animation-delay:-99s !important}'

  function visualEnsureHead (doc, id, tag) {
    var el = doc.getElementById(id)
    if (!el) {
      el = doc.createElement(tag || 'style')
      el.id = id
      doc.head.appendChild(el)
    }
    // 始终挪到 head 末尾：与线上 <style id="site-text-style"> 的位置一致
    doc.head.appendChild(el)
    return el
  }

  function visualApplyStyle () {
    var doc = visualDoc()
    if (!doc || !doc.head) return
    var host = visualEnsureHead(doc, 'st-live')
    host.textContent = visualState.rules.map(function (r) {
      return r.sel + '{' + visualJoinCss(r.decls, r.important) + '}'
    }).join('\n')
  }

  function visualApplyFrameCss () {
    var doc = visualDoc()
    if (!doc || !doc.head) return
    var host = visualEnsureHead(doc, 'st-frame')
    host.textContent = visualFrameCss() + '\n' + (visualState.freeze ? VISUAL_FREEZE_CSS : '')
    doc.documentElement.classList.add('st-editing')
  }

  function visualClearHits () {
    var doc = visualDoc()
    if (!doc) return
    Array.prototype.slice.call(doc.querySelectorAll('.st-hit')).forEach(function (el) { el.classList.remove('st-hit') })
  }

  /* "值 → 条目"索引：同时收**生效值**与**默认值**。
     为什么要收默认值：仓库里的覆盖要等下次构建才反映到画布上
     （画布跑的是上一次构建的产物），只认 val 的话，刚在文件里改过的条目
     在画布上就点不中了。两边的字符串不同，所以不会互相干扰。 */
  function visualIndexEntries () {
    var out = []
    textState.items.forEach(function (it) {
      var seen = {}
      ;[['val', it.val], ['def', it.def]].forEach(function (p) {
        var v = String(p[1] == null ? '' : p[1]).trim()
        if (!v || seen[v] || v.length > 60 || /[\r\n]/.test(v)) return
        seen[v] = 1
        out.push({ text: v, item: it, how: p[0] })
      })
    })
    return out
  }

  /* 标出"清单里能改的文字"：走一遍文本节点，用上面那张索引对上，
     顺手把命中的条目键记在元素上（点选时就不用再猜了）。 */
  function visualMarkHits () {
    var win = visualWin(), doc = visualDoc()
    if (!win || !doc || !doc.body) return 0
    var map = {}
    visualIndexEntries().forEach(function (e) {
      if (e.text.length > 40) return
      if (!map[e.text]) map[e.text] = []
      if (!map[e.text].some(function (x) { return x.item.key === e.item.key })) map[e.text].push(e)
    })
    var walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT, null)
    var marks = 0, node
    while ((node = walker.nextNode())) {
      var t = String(node.nodeValue || '').replace(/\s+/g, ' ').trim()
      if (!t || !map[t]) continue
      var el = node.parentElement
      if (!el || el === doc.body || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue
      // 往上爬到"整段文字仍然正好是这句"的最高一层，点选范围更大（最多 3 层）
      var up = el, i = 0
      while (up.parentElement && i < 3) {
        var p = up.parentElement
        if (!p || p === doc.body || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(p.tagName)) break
        if (String(p.textContent || '').replace(/\s+/g, ' ').trim() !== t) break
        up = p; i++
      }
      var keys = up.__stKeys || []
      map[t].forEach(function (e) { if (keys.indexOf(e.item.key) === -1) keys.push(e.item.key) })
      up.__stKeys = keys
      if (visualState.outline) up.classList.add('st-hit')
      marks++
    }
    return marks
  }

  /* 把"文件里已改、但还没构建上线"的文字先画到画布上。
     为什么需要它：画布跑的是**上一次构建的产物**，而 site_text.yml 里可能已经有
     这次会话之前保存的覆盖（要等 Cloudflare 重新构建才会出现在线上）。
     不补这一步，用户会看到"文件里写着 A、画布上是 B"的分裂状态。
     做法保守：只认「可改文字」标记过的元素（__stKeys，即精确匹配上的那些），
     把默认值文字换成生效值 —— 不做任何模糊猜测。 */
  function visualApplyFileOverrides () {
    var win = visualWin(), doc = visualDoc()
    if (!win || !doc || !doc.body) return 0
    var byKey = {}
    Array.prototype.slice.call(doc.body.querySelectorAll('*')).forEach(function (el) {
      if (!el.__stKeys) return
      el.__stKeys.forEach(function (k) {
        if (!byKey[k]) byKey[k] = []
        byKey[k].push(el)
      })
    })
    var n = 0
    textState.items.forEach(function (it) {
      var els = byKey[it.key]
      if (!els || !els.length) return
      var to = String(it.val == null ? '' : it.val)
      var from = String(it.def == null ? '' : it.def)
      if (!to || !from || to === from || to.length > 60 || from.length > 60) return
      if (/[\r\n]/.test(to) || /[\r\n]/.test(from)) return
      els.forEach(function (el) {
        var w = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT, null)
        var node
        while ((node = w.nextNode())) {
          if (node.nodeValue && node.nodeValue.indexOf(from) > -1) {
            node.nodeValue = node.nodeValue.replace(from, to)
            n++
            break
          }
        }
      })
    })
    return n
  }

  /* ---------- 公告：把草稿 HTML 灌回卡片（复刻 announce-hover.js 的重组） ---------- */
  function visualNormalizeAnnounce (contentEl) {
    var doc = visualDoc()
    if (!doc || !contentEl) return
    if (contentEl.querySelector(':scope > .announcement_body')) return
    var kids = Array.prototype.slice.call(contentEl.children)
    if (!kids.length) return
    kids[0].classList.add('announcement_title')
    var wrap = doc.createElement('div')
    wrap.className = 'announcement_body'
    kids.slice(1).forEach(function (n) { wrap.appendChild(n) })
    if (wrap.children.length) contentEl.appendChild(wrap)
  }

  function visualApplyAnnounce () {
    var doc = visualDoc()
    if (!doc) return
    var contentEl = doc.querySelector('.card-announcement .announcement_content')
    if (!contentEl) return
    var item = textState.byKey[ANNOUNCE_KEY]
    if (!item) return
    var html = String(item.val == null ? '' : item.val)
    if (visualState.announceApplied === html) return
    visualState.announceApplied = html
    contentEl.innerHTML = html
    visualNormalizeAnnounce(contentEl)
  }

  // 卡片里的内容 → 干净 HTML（拆掉 announce-hover.js 加的壳与编辑属性）
  function visualAnnounceSerialized () {
    var doc = visualDoc()
    var c = doc && doc.querySelector('.card-announcement .announcement_content')
    if (!c) return ''
    var clone = c.cloneNode(true)
    Array.prototype.slice.call(clone.querySelectorAll('.announcement_body')).forEach(function (wrap) {
      var parent = wrap.parentNode
      if (!parent) return
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap)
      parent.removeChild(wrap)
    })
    Array.prototype.slice.call(clone.querySelectorAll('.announcement_title')).forEach(function (el) { el.classList.remove('announcement_title') })
    Array.prototype.slice.call(clone.querySelectorAll('.st-hit,.st-hover,.st-selected')).forEach(function (el) {
      el.classList.remove('st-hit'); el.classList.remove('st-hover'); el.classList.remove('st-selected')
    })
    Array.prototype.slice.call(clone.querySelectorAll('[contenteditable]')).forEach(function (el) { el.removeAttribute('contenteditable') })
    clone.removeAttribute('contenteditable')
    // 上面摘类名可能留下空 class=""（announce-hover.js 给首段加的类被摘掉后就是这种）
    Array.prototype.slice.call(clone.querySelectorAll('[class]')).forEach(function (el) {
      if (!String(el.getAttribute('class') || '').trim()) el.removeAttribute('class')
    })
    if (!String(clone.getAttribute('class') || '').trim()) clone.removeAttribute('class')
    return clone.innerHTML.replace(/^\s+|\s+$/g, '')
  }

  function visualAnnounceSync () {
    var item = textState.byKey[ANNOUNCE_KEY]
    if (!item) return
    item.val = visualAnnounceSerialized()
    visualState.announceApplied = item.val
    updateTextSummary()
    visualUpdateDirtyLabel()
    var src = $('#visual-rt-source')
    if (src) src.value = item.val
    if (textState.loaded && $('#texts-groups') && textRowEl(item.key)) {
      var input = textInputEl(item.key)
      if (input) input.value = item.val
      updateRowState(item)
    }
  }

  /* ---------- 面板：选中元素信息 ---------- */
  function visualColorHex (rgb) {
    var m = /rgba?\(([^)]+)\)/.exec(String(rgb || ''))
    if (!m) return '#ffffff'
    var p = m[1].split(',').map(function (x) { return parseFloat(x) })
    if (p.length < 3) return '#ffffff'
    return '#' + p.slice(0, 3).map(function (n) {
      var h = Math.max(0, Math.min(255, Math.round(n))).toString(16)
      return h.length === 1 ? '0' + h : h
    }).join('')
  }

  function visualComputed (win, el) {
    var out = {}
    try {
      var cs = win.getComputedStyle(el)
      VISUAL_COMPUTED_PROPS.forEach(function (p) { out[p] = cs.getPropertyValue(p) })
    } catch (e) { /* ignore */ }
    return out
  }

  function visualTextCandidates (el) {
    var out = [], seen = {}
    var raw = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    function add (it, how) {
      if (!it || seen[it.key]) return
      seen[it.key] = true
      out.push({ key: it.key, label: it.label, hint: it.hint || '', val: it.val, def: it.def, how: how })
    }
    if (el.__stKeys) el.__stKeys.forEach(function (k) { add(textState.byKey[k], 'hit') })
    if (raw) {
      var entries = visualIndexEntries()
      entries.forEach(function (e) { if (e.text === raw) add(e.item, e.how === 'val' ? 'exact' : 'exact-def') })
      // "包含"只在**短元素**上兜底（如「文章数目 :」含「文章数目」）。
      // 大块容器（整张卡片、整个公告正文）绝不能这么猜：公告正文里有「启明」
      // 两个字，就会把"左上角站名"当成候选，点公告时右侧显示的目标名全错。
      if (out.length < 6 && raw.length <= 80) {
        entries
          .filter(function (e) { return e.text.length >= 2 && e.text.length <= 40 })
          .sort(function (a, b) { return b.text.length - a.text.length })
          .forEach(function (e) {
            if (raw.length > e.text.length && raw.indexOf(e.text) > -1) add(e.item, 'part')
          })
      }
    }
    return out.slice(0, 8)
  }

  function visualLabelOf (el, keys) {
    if (keys && keys.length) return keys[0].label
    var t = String(el.textContent || '').replace(/\s+/g, ' ').trim()
    if (t) return '「' + (t.length > 22 ? t.slice(0, 22) + '…' : t) + '」'
    return '<' + el.tagName.toLowerCase() + '>'
  }

  function visualSelect (el) {
    var win = visualWin(), doc = visualDoc()
    if (!win || !doc || !el || el.nodeType !== 1) return
    var prev = doc.querySelector('.st-selected')
    if (prev) prev.classList.remove('st-selected')
    el.classList.add('st-selected')

    var unique = visualUniqueSel(win, el)
    var group = visualGroupSel(win, el)
    var isAnnounce = !!(el.closest && el.closest('.announcement_content'))
    var keys = isAnnounce ? [] : visualTextCandidates(el)
    var hasUnique = !!visualRule(unique, false)
    var hasGroup = group && group !== unique && !!visualRule(group, false)

    visualState.sel = unique
    visualState.ruleSel = hasGroup ? group : unique
    visualState.info = {
      tag: el.tagName.toLowerCase(),
      label: isAnnounce ? '侧栏公告正文' : visualLabelOf(el, keys),
      unique: unique,
      group: group,
      uniqueCount: visualCount(win, unique),
      groupCount: group ? visualCount(win, group) : 0,
      keys: keys,
      computed: visualComputed(win, el),
      announce: isAnnounce,
      scope: hasGroup ? 'group' : 'unique',
      useUnique: hasUnique,
      useGroup: hasGroup
    }
    visualState.textKey = keys.length ? keys[0].key : ''
    visualState.announceEditing = false
    visualBuildInspector()
    visualRefreshRules()
  }

  function visualClearSelection () {
    var doc = visualDoc()
    if (doc) {
      var prev = doc.querySelector('.st-selected')
      if (prev) prev.classList.remove('st-selected')
    }
    visualState.sel = null
    visualState.ruleSel = null
    visualState.info = null
    visualState.textKey = ''
    visualState.announceEditing = false
    visualBuildInspector()
  }

  function visualFieldValue (prop) {
    var d = visualDecl(visualState.ruleSel, prop)
    return d ? d.value : ''
  }

  function visualFieldHtml (f) {
    var sel = visualState.ruleSel
    var over = visualFieldValue(f.prop)
    var computed = (visualState.info && visualState.info.computed[f.prop]) || ''
    var cur = computed ? '<span class="visual-cur" title="当前生效值">' + esc(String(computed).slice(0, 40)) + '</span>' : ''
    var head = '<div class="visual-field-head">' +
      '<span class="visual-field-label">' + esc(f.label) + '</span>' +
      cur +
      '<button class="visual-field-x' + (over ? '' : ' is-off') + '" type="button" data-clear-prop="' + esc(f.prop) + '" title="去掉这条设置">✕</button>' +
      '</div>'
    var body = ''
    var raw = ' data-prop="' + esc(f.prop) + '"'
    if (f.kind === 'select') {
      body = '<select class="admin-input visual-input"' + raw + '>' + (f.opts || []).map(function (o) {
        return '<option value="' + esc(o.v) + '"' + (over === o.v ? ' selected' : '') + '>' + esc(o.label) + '</option>'
      }).join('') + '</select>'
    } else if (f.kind === 'color') {
      var hex = over || visualColorHex(computed)
      body = '<div class="visual-color">' +
        '<input type="color" class="visual-color-pick"' + raw + ' value="' + esc(hex) + '">' +
        '<input type="text" class="admin-input visual-color-hex"' + raw + ' value="' + esc(over || '') + '" placeholder="' + esc(hex) + '">' +
        '</div>'
    } else if (f.kind === 'glow') {
      var g = /^0 0 (\d+(?:\.\d+)?)px/.exec(over || '')
      var gv = g ? Number(g[1]) : 0
      body = '<div class="visual-num">' +
        '<input type="range" class="visual-range"' + raw + ' min="0" max="40" step="1" value="' + gv + '">' +
        '<input type="number" class="visual-num-input"' + raw + ' min="0" max="40" step="1" value="' + (g ? gv : '') + '" placeholder="0">' +
        '<span class="visual-unit">px</span>' +
        '</div>'
    } else if (f.kind === 'toggle') {
      body = '<button type="button" class="admin-btn visual-toggle' + (over === f.on ? ' is-on' : '') + '"' + raw + '>' + esc(f.label) + '</button>'
    } else if (f.kind === 'text') {
      body = '<input type="text" class="admin-input visual-input"' + raw + ' value="' + esc(over) + '" placeholder="' + esc(f.ph || '') + '">'
    } else {
      var nv = ''
      if (over !== '') {
        var pv = parseFloat(over)
        nv = isNaN(pv) ? '' : String(pv)
      } else {
        var pc = parseFloat(computed)
        nv = isNaN(pc) ? '' : String(Math.round(pc * 100) / 100)
      }
      body = '<div class="visual-num">' +
        '<input type="range" class="visual-range"' + raw + ' min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + esc(nv) + '">' +
        '<input type="number" class="visual-num-input"' + raw + ' min="' + f.min + '" max="' + f.max + '" step="' + f.step + '" value="' + esc(nv) + '">' +
        (f.unit ? '<span class="visual-unit">' + esc(f.unit) + '</span>' : '') +
        '</div>'
    }
    return '<div class="visual-field" data-field="' + esc(f.prop) + '">' + head + body +
      (f.hint && over ? '<div class="visual-field-hint">' + esc(f.hint) + '</div>' : '') +
      '</div>'
  }

  function visualBuildInspector () {
    var host = $('#visual-inspect')
    if (!host) return
    var info = visualState.info
    if (!info) {
      host.innerHTML = '<div class="visual-empty">还没有选中元素。<br>左边真实页面上点一下要改的文字。</div>'
      return
    }
    var html = ''

    // ---- 目标 ----
    html += '<div class="visual-card">' +
      '<div class="visual-card-title">目标</div>' +
      '<div class="visual-target">' + esc(info.label) +
      '<span class="visual-tag">&lt;' + esc(info.tag) + '&gt;</span></div>' +
      '<div class="visual-scope">' +
      '<label class="visual-radio"><input type="radio" name="visual-scope" value="unique"' + (info.scope === 'unique' ? ' checked' : '') + '>' +
      '<span>只这一处 <b>' + info.uniqueCount + '</b></span></label>' +
      (info.group && info.group !== info.unique
        ? '<label class="visual-radio"><input type="radio" name="visual-scope" value="group"' + (info.scope === 'group' ? ' checked' : '') + '>' +
          '<span>同类全部 <b>' + (info.groupCount < 0 ? '?' : info.groupCount) + '</b></span></label>'
        : '') +
      '</div>' +
      '<code class="visual-sel">' + esc(visualState.ruleSel || '') + '</code>' +
      (info.group && info.group !== info.unique ? '<div class="visual-field-hint">「同类全部」= ' + esc(info.group) + '</div>' : '') +
      '</div>'

    // ---- 公告（富文本） ----
    if (info.announce) {
      var item = textState.byKey[ANNOUNCE_KEY]
      html += '<div class="visual-card is-announce">' +
        '<div class="visual-card-title">侧栏公告正文（所见即所得）</div>' +
        '<div class="visual-rt">' +
        [['bold', 'B', '加粗'], ['italic', 'I', '斜体'], ['underline', 'U', '下划线'],
          ['h3', '小标题', '小标题'], ['p', '正文段', '正文段落'], ['ul', '列表', '无序列表'],
          ['quote', '引用', '引用块'], ['link', '链接', '插入链接'], ['unlink', '去链接', '去掉链接'],
          ['clear', '清格式', '清除格式']].map(function (b) {
          return '<button type="button" class="admin-btn visual-rt-btn" data-rt="' + b[0] + '" title="' + esc(b[2]) + '">' + esc(b[1]) + '</button>'
        }).join('') +
        '<button type="button" class="admin-btn visual-rt-btn is-ghost" data-rt="source" title="改 HTML 源码">源码</button>' +
        '</div>' +
        '<textarea id="visual-rt-source" class="admin-textarea visual-rt-source" rows="8" spellcheck="false" style="display:none"></textarea>' +
        '<div class="visual-field-hint">直接点左边公告卡里的字就能改；这里只是工具条。' +
        (item && item.val !== item.def ? ' <b>已改过</b>' : '') +
        '</div>' +
        '<button type="button" class="admin-btn visual-mini" data-rt-reset="1">恢复默认公告</button>' +
        '</div>'
    }

    // ---- 文字内容（公告正文走上面那块富文本卡，这里不重复给输入框） ----
    if (!info.announce) {
      html += '<div class="visual-card">' +
        '<div class="visual-card-title">文字内容</div>'
      if (info.keys.length) {
        var key = visualState.textKey && textState.byKey[visualState.textKey] ? visualState.textKey : info.keys[0].key
        var it = textState.byKey[key]
        if (info.keys.length > 1) {
          html += '<select id="visual-text-key" class="admin-input visual-input">' + info.keys.map(function (k) {
            return '<option value="' + esc(k.key) + '"' + (k.key === key ? ' selected' : '') + '>' + esc(k.label) + ' · ' + esc(k.key) + '</option>'
          }).join('') + '</select>'
        } else {
          html += '<div class="visual-key">' + esc(it.label) + ' <code>' + esc(it.key) + '</code></div>'
        }
        var isLong = it.type === 'textarea' || it.type === 'html' || String(it.val || '').length > 60
        html += isLong
          ? '<textarea id="visual-text-input" class="admin-textarea" rows="3" spellcheck="false" data-vtext="1">' + esc(it.val) + '</textarea>'
          : '<input id="visual-text-input" class="admin-input" type="text" spellcheck="false" data-vtext="1" value="' + esc(it.val) + '">'
        html += '<div class="visual-field-hint">' + esc(it.hint || '') + '</div>' +
          '<div class="visual-text-foot">' +
          '<span class="visual-def">默认：' + esc(String(it.def || '').slice(0, 60) || '（空）') + '</span>' +
          '<button type="button" class="admin-btn visual-mini" id="visual-text-reset">恢复默认</button>' +
          '</div>'
      } else {
        html += '<div class="visual-field-hint">这段文字不在清单里（可能是文章标题、分类名之类的动态内容）—— 改不了它的字，但可以调下面的字形 / 位置。</div>'
      }
      html += '</div>'
    }

    // ---- 字形 / 位置 ----
    html += '<div class="visual-card">' +
      '<div class="visual-card-title">字形 <button type="button" class="admin-btn visual-mini" id="visual-clear-all">清空本元素设置</button></div>' +
      VISUAL_TEXT_FIELDS.map(visualFieldHtml).join('') +
      '</div>'
    html += '<div class="visual-card">' +
      '<div class="visual-card-title">位置</div>' +
      VISUAL_POS_FIELDS.map(visualFieldHtml).join('') +
      '</div>'

    host.innerHTML = html
    visualBindInspector()
  }

  function visualBindInspector () {
    var host = $('#visual-inspect')
    if (!host) return

    // 作用范围
    $$('#visual-inspect input[name="visual-scope"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        var info = visualState.info
        if (!info || !radio.checked) return
        var next = radio.value === 'group' ? info.group : info.unique
        if (!next || next === visualState.ruleSel) return
        // 把已写在这处的规则搬到新作用范围（目标上已存在规则则合并）
        var old = visualRule(visualState.ruleSel, false)
        if (old) {
          var tgt = visualRule(next, true)
          tgt.note = tgt.note || old.note
          old.decls.forEach(function (d) {
            if (!tgt.decls.some(function (x) { return x.prop === d.prop })) tgt.decls.push(d)
          })
          tgt.important = tgt.important || old.important
          visualState.rules = visualState.rules.filter(function (r) { return r !== old })
          tgt.css = visualFileCss(tgt)
        }
        info.scope = radio.value
        visualState.ruleSel = next
        visualApplyStyle()
        visualBuildInspector()
        visualRefreshRules()
      })
    })

    // 控件
    function setFromControl (prop, value) {
      visualSetDecl(visualState.ruleSel, prop, value)
      var f = VISUAL_TEXT_FIELDS.concat(VISUAL_POS_FIELDS).filter(function (x) { return x.prop === prop })[0]
      // 范围控件要回填数字框，反之亦然
      $$('#visual-inspect [data-prop="' + prop + '"]').forEach(function (el) {
        if (el.type === 'range' || el.type === 'number' || el.type === 'text' || el.type === 'color') {
          if (el.type === 'color' && /^#/.test(String(value))) el.value = value
          else if (el.type !== 'color' && document.activeElement !== el) el.value = value
        }
      })
      var xs = $$('#visual-inspect [data-clear-prop="' + prop + '"]')
      xs.forEach(function (b) { b.classList.toggle('is-off', !value) })
      if (f && f.kind === 'toggle') {
        $$('#visual-inspect [data-prop="' + prop + '"]').forEach(function (b) {
          b.classList.toggle('is-on', b.tagName === 'BUTTON' && value === f.on)
        })
      }
    }

    function bindOne (el) {
      var prop = el.getAttribute('data-prop')
      if (!prop) return
      if (el.tagName === 'BUTTON' && el.classList.contains('visual-toggle')) {
        var f = VISUAL_TEXT_FIELDS.filter(function (x) { return x.prop === prop })[0]
        el.addEventListener('click', function () {
          var cur = visualFieldValue(prop)
          setFromControl(prop, cur === f.on ? '' : f.on)
        })
        return
      }
      if (el.type === 'range') {
        el.addEventListener('input', function () {
          var unit = (VISUAL_TEXT_FIELDS.concat(VISUAL_POS_FIELDS).filter(function (x) { return x.prop === prop })[0] || {}).unit || ''
          setFromControl(prop, el.value + unit)
        })
        return
      }
      if (el.type === 'number') {
        el.addEventListener('input', function () {
          var unit = (VISUAL_TEXT_FIELDS.concat(VISUAL_POS_FIELDS).filter(function (x) { return x.prop === prop })[0] || {}).unit || ''
          var v = el.value === '' ? '' : el.value + unit
          setFromControl(prop, v)
        })
        return
      }
      if (prop === 'text-shadow') return
      if (el.classList.contains('visual-color-pick') || el.classList.contains('visual-color-hex')) {
        el.addEventListener('input', function () { setFromControl('color', el.value) })
        return
      }
      el.addEventListener('change', function () { setFromControl(prop, el.value) })
      if (el.tagName === 'INPUT' && el.type === 'text') {
        el.addEventListener('input', function () { setFromControl(prop, el.value) })
      }
    }
    $$('#visual-inspect [data-prop]').forEach(bindOne)

    // 光晕：滑块 / 数字框 → "0 0 Npx currentColor"
    $$('#visual-inspect [data-prop="text-shadow"]').forEach(function (el) {
      el.addEventListener('input', function () {
        var n = parseFloat(el.value)
        setFromControl('text-shadow', (!n || n <= 0) ? '' : ('0 0 ' + n + 'px currentColor'))
      })
    })

    // 单条清除
    $$('#visual-inspect [data-clear-prop]').forEach(function (b) {
      b.addEventListener('click', function () {
        visualSetDecl(visualState.ruleSel, b.getAttribute('data-clear-prop'), '')
        visualBuildInspector()
      })
    })
    var all = $('#visual-clear-all')
    if (all) {
      all.addEventListener('click', function () {
        var r = visualRule(visualState.ruleSel, false)
        if (!r) return
        visualState.rules = visualState.rules.filter(function (x) { return x !== r })
        visualApplyStyle()
        visualBuildInspector()
        visualRefreshRules()
      })
    }

    // 文字内容
    var vtext = $('#visual-text-input')
    if (vtext) {
      vtext.addEventListener('input', function () {
        var key = visualState.textKey || (visualState.info.keys[0] && visualState.info.keys[0].key)
        var it = textState.byKey[key]
        if (!it) return
        var before = it.val
        it.val = vtext.value
        visualApplyTextToElement([before, it.def], it.val)
        updateTextSummary()
        visualUpdateDirtyLabel()
        if (textState.loaded && textRowEl(it.key)) {
          var input = textInputEl(it.key)
          if (input) input.value = it.val
          updateRowState(it)
        }
      })
    }
    var vkey = $('#visual-text-key')
    if (vkey) {
      vkey.addEventListener('change', function () {
        visualState.textKey = vkey.value
        var it = textState.byKey[vkey.value]
        if (it && $('#visual-text-input')) $('#visual-text-input').value = it.val
        visualBuildInspector()
      })
    }
    var vreset = $('#visual-text-reset')
    if (vreset) {
      vreset.addEventListener('click', function () {
        var key = visualState.textKey || (visualState.info.keys[0] && visualState.info.keys[0].key)
        var it = textState.byKey[key]
        if (!it) return
        var before = it.val
        it.val = it.def
        visualApplyTextToElement([before], it.val)
        var input = $('#visual-text-input')
        if (input) input.value = it.val
        if (textState.loaded && textRowEl(it.key)) {
          var ti = textInputEl(it.key)
          if (ti) ti.value = it.val
          updateRowState(it)
        }
        updateTextSummary()
      })
    }

    // 富文本工具条
    $$('#visual-inspect [data-rt]').forEach(function (b) {
      b.addEventListener('click', function () { visualRtCommand(b.getAttribute('data-rt')) })
    })
    var rreset = $('#visual-inspect [data-rt-reset]')
    if (rreset) {
      rreset.addEventListener('click', function () {
        var it = textState.byKey[ANNOUNCE_KEY]
        if (!it) return
        it.val = it.def
        visualState.announceApplied = ''
        visualApplyAnnounce()
        visualAnnounceSync()
        updateTextSummary()
        toast('公告已恢复为默认内容（还没保存）', 'ok')
      })
    }
    var rsrc = $('#visual-rt-source')
    if (rsrc) {
      rsrc.addEventListener('input', function () {
        var it = textState.byKey[ANNOUNCE_KEY]
        if (!it) return
        it.val = rsrc.value
        visualState.announceApplied = ''
        visualApplyAnnounce()
        updateTextSummary()
      })
    }
  }

  // 把某个键的新值就地画到元素上（保住图标：只在文本节点里替换）
  // fromList：按优先级给几个"旧字符串"候选 —— 文件里的旧值、默认值、
  //           元素当前的实际文字（画布是上次构建的产物，可能落后于文件）
  function visualApplyTextToElement (fromList, to) {
    var win = visualWin(), doc = visualDoc()
    if (!win || !doc || !visualState.sel) return
    var el = null
    try { el = doc.querySelector(visualState.sel) } catch (e) { el = null }
    if (!el) return
    var t = String(to == null ? '' : to)
    var list = (Array.isArray(fromList) ? fromList : [fromList])
      .map(function (x) { return String(x == null ? '' : x).trim() })
      .filter(function (x, i, arr) { return x && arr.indexOf(x) === i })
    list.push(String(el.textContent || '').replace(/\s+/g, ' ').trim())
    var done = false
    for (var k = 0; k < list.length && !done; k++) {
      var walker = doc.createTreeWalker(el, win.NodeFilter.SHOW_TEXT, null)
      var node
      while ((node = walker.nextNode())) {
        if (node.nodeValue && list[k] && node.nodeValue.indexOf(list[k]) > -1) {
          node.nodeValue = node.nodeValue.replace(list[k], t)
          done = true
          break
        }
      }
    }
    if (!done) el.textContent = t
    visualClearHits()
    visualMarkHits()
  }

  /* ---------- 公告富文本命令 ---------- */
  function visualRtCommand (cmd) {
    var doc = visualDoc(), win = visualWin()
    if (!doc || !win) return
    var c = doc.querySelector('.card-announcement .announcement_content')
    if (!c) return
    if (cmd === 'source') {
      var ta = $('#visual-rt-source')
      if (!ta) return
      var show = ta.style.display === 'none'
      if (show) {
        visualAnnounceSync()
        ta.value = (textState.byKey[ANNOUNCE_KEY] || {}).val || ''
        ta.style.display = ''
      } else {
        ta.style.display = 'none'
      }
      return
    }
    try { win.focus() } catch (e) { /* ignore */ }
    c.setAttribute('contenteditable', 'true')
    try { c.focus() } catch (e) { /* ignore */ }
    var sel = doc.getSelection()
    if (sel && visualState.lastRange && sel.rangeCount === 0) {
      try { sel.addRange(visualState.lastRange) } catch (e) { /* ignore */ }
    }
    try {
      if (cmd === 'link') {
        var url = window.prompt('链接地址（https://…）', 'https://')
        if (!url) return
        doc.execCommand('createLink', false, url)
      } else if (cmd === 'unlink') doc.execCommand('unlink', false, null)
      else if (cmd === 'h3') doc.execCommand('formatBlock', false, 'h3')
      else if (cmd === 'p') doc.execCommand('formatBlock', false, 'p')
      else if (cmd === 'quote') doc.execCommand('formatBlock', false, 'blockquote')
      else if (cmd === 'ul') doc.execCommand('insertUnorderedList', false, null)
      else if (cmd === 'clear') doc.execCommand('removeFormat', false, null)
      else doc.execCommand(cmd, false, null)
    } catch (e) { toast('这条命令在当前浏览器里不可用：' + cmd, 'err') }
    visualAnnounceSync()
  }

  /* ---------- 规则列表 ---------- */
  function visualDirtyRules () {
    return visualRulesSnapshot(visualState.rules) !== visualRulesSnapshot(visualState.savedRules)
  }

  // 只更新保存按钮上的未保存计数（每敲一个字都会走这里，所以别重建整个规则列表）
  function visualUpdateDirtyLabel () {
    var label = $('#btn-visual-save-label')
    if (!label) return
    var dirty = textCounts().unsaved + (visualDirtyRules() ? visualState.rules.length : 0)
    label.textContent = dirty ? ('保存到仓库（' + dirty + '）') : '保存到仓库'
  }

  function visualRefreshRules () {
    var count = $('#visual-rules-count')
    visualUpdateDirtyLabel()
    if (count) count.textContent = String(visualState.rules.length)
    var host = $('#visual-rules')
    if (!host) return
    if (!visualState.rules.length) {
      host.innerHTML = '<div class="visual-empty">还没有任何字形 / 位置规则。</div>'
      return
    }
    host.innerHTML = visualState.rules.map(function (r) {
      return '<div class="visual-rule" data-rule="' + esc(r.sel) + '">' +
        '<div class="visual-rule-head"><span class="visual-rule-note">' + esc(r.note || r.sel) + '</span>' +
        '<button class="admin-btn visual-mini" type="button" data-rule-locate="' + esc(r.sel) + '">定位</button>' +
        '<button class="admin-btn visual-mini admin-btn-danger" type="button" data-rule-del="' + esc(r.sel) + '">删除</button></div>' +
        '<code class="visual-rule-sel">' + esc(r.sel) + '</code>' +
        '<div class="visual-rule-css">' + esc(visualFileCss(r) || '（空）') + '</div>' +
        '</div>'
    }).join('')
    $$('#visual-rules [data-rule-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sel = b.getAttribute('data-rule-del')
        visualState.rules = visualState.rules.filter(function (r) { return r.sel !== sel })
        visualApplyStyle()
        if (visualState.ruleSel === sel) visualClearSelection()
        visualRefreshRules()
      })
    })
    $$('#visual-rules [data-rule-locate]').forEach(function (b) {
      b.addEventListener('click', function () { visualLocate(b.getAttribute('data-rule-locate')) })
    })
  }

  function visualLocate (sel) {
    var doc = visualDoc()
    if (!doc) return
    var el = null
    try { el = doc.querySelector(sel) } catch (e) { el = null }
    if (!el) { toast('这个选择器在当前页面上找不到元素', 'err'); return }
    try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }) } catch (e) { el.scrollIntoView() }
    el.classList.add('st-flash')
    setTimeout(function () { el.classList.remove('st-flash') }, 1300)
    visualSelect(el)
  }

  /* ---------- 画布装载 ---------- */
  function visualFrameWidth () {
    var f = $('#visual-frame')
    var wrap = f && f.parentNode
    if (!f) return
    if (!visualState.width) {
      f.style.width = '100%'
      if (wrap) wrap.classList.remove('is-fixed')
    } else {
      f.style.width = visualState.width + 'px'
      if (wrap) wrap.classList.add('is-fixed')
    }
  }

  function visualLoadPage () {
    var frame = $('#visual-frame')
    if (!frame) return
    visualState.loading = true
    visualClearSelection()
    visualStatus('载入 ' + visualState.page + ' …')
    frame.src = visualState.page
  }

  function visualOnLoad () {
    var win = visualWin(), doc = visualDoc()
    if (!win || !doc) { visualStatus('画布不可用（请检查是否同源打开 /admin/）', true); return }
    visualState.loading = false
    // 站点脚本可能把 body 缩起来；编辑期保证公告卡能展开
    doc.documentElement.classList.add('st-editing')
    visualApplyFrameCss()

    // 页面内脚本会重组公告卡 DOM，等一拍再灌最终结构
    var settle = function () {
      visualApplyAnnounce()
      visualApplyStyle()
      visualClearHits()
      visualMarkHits()              // 先标一遍：拿到"这个元素对应哪个键"（__stKeys）
      visualClearHits()
      visualApplyFileOverrides()    // 再把"文件里已改、还没构建"的文字补上
      var marks = visualMarkHits()  // 按最终文字重新标可改范围
      visualStatus('已载入：可改文字约 ' + marks + ' 处 · 样式规则 ' + visualState.rules.length + ' 条')
    }
    setTimeout(settle, 60)
    setTimeout(settle, 600)

    if (!doc.__stBound) {
      doc.__stBound = true
      doc.addEventListener('mouseover', function (e) {
        var el = e.target
        if (!el || el.nodeType !== 1) return
        if (visualState.hoverEl && visualState.hoverEl !== el) visualState.hoverEl.classList.remove('st-hover')
        if (el === doc.body || el === doc.documentElement) return
        el.classList.add('st-hover')
        visualState.hoverEl = el
      }, true)
      doc.addEventListener('mouseleave', function () {
        if (visualState.hoverEl) visualState.hoverEl.classList.remove('st-hover')
        visualState.hoverEl = null
      }, true)
      doc.addEventListener('click', function (e) {
        var el = e.target
        if (!el || el.nodeType !== 1) return
        e.preventDefault()
        e.stopPropagation()
        var ann = el.closest ? el.closest('.card-announcement .announcement_content') : null
        if (ann) {
          visualSelect(ann)
          visualState.announceEditing = true
          try { win.focus() } catch (err) { /* ignore */ }
          ann.setAttribute('contenteditable', 'true')
          try { ann.focus() } catch (err) { /* ignore */ }
          return
        }
        visualSelect(el)
      }, true)
      doc.addEventListener('selectionchange', function () {
        try {
          var s = doc.getSelection()
          if (s && s.rangeCount) visualState.lastRange = s.getRangeAt(0).cloneRange()
        } catch (e) { /* ignore */ }
      })
      doc.addEventListener('submit', function (e) { e.preventDefault() }, true)
      // 站内链接一律不跳转（编辑期）
      doc.addEventListener('auxclick', function (e) { e.preventDefault() }, true)
      // 公告卡里打字 → 同步回文字表（contenteditable 的 input 会冒泡）
      doc.addEventListener('input', function (e) {
        var t = e.target
        if (!visualState.announceEditing || !t || !t.closest) return
        if (t.closest('.card-announcement .announcement_content')) visualAnnounceSync()
      }, true)
      doc.addEventListener('blur', function (e) {
        var t = e.target
        if (!visualState.announceEditing || !t || !t.closest) return
        if (t.closest('.card-announcement .announcement_content')) visualAnnounceSync()
      }, true)
    }
  }

  /* ---------- 保存 / 放弃 ---------- */
  function visualPageList () {
    var list = (state.meta && state.meta.preview) || []
    if (list.length) return list
    return [{ label: '首页', url: '/', kind: 'core' }]
  }

  /* 放弃未保存的改动：状态回滚 + **重新载入画布**。
     光把状态改回去不够 —— 画布上的文字/样式是刚才就地改的，
     不重新装载的话屏幕上是"改了又没保存"的假象（这个坑踩过一次）。 */
  function visualRevert () {
    textState.items.forEach(function (it) {
      it.val = it.saved
      if (textState.loaded && textRowEl(it.key)) {
        var input = textInputEl(it.key)
        if (input) input.value = it.val
        updateRowState(it)
      }
    })
    if (textState.loaded) renderTextsSafe()
    visualState.rules = visualState.savedRules.map(function (r) {
      return { sel: r.sel, note: r.note, important: !!r.important, decls: (r.decls || []).map(function (d) { return { prop: d.prop, value: d.value, important: !!d.important } }), relAuto: !!r.relAuto, css: '' }
    })
    visualState.rules.forEach(function (r) { r.css = visualFileCss(r) })
    visualState.announceApplied = ''
    updateTextSummary()
    visualApplyStyle()
    visualBuildInspector()
    visualRefreshRules()
    visualLoadPage()
    toast('已放弃未保存的改动，画布已重新载入', 'ok')
  }

  function renderTextsSafe () {
    if (typeof renderTexts === 'function' && $('#texts-groups')) renderTexts()
  }

  function visualInit () {
    if (visualState.ready) return
    var pageSel = $('#visual-page')
    if (!pageSel) return
    visualState.ready = true
    var list = visualPageList()
    var groups = [
      { kind: 'core', label: '站点页面' },
      { kind: 'page', label: '独立页面' },
      { kind: 'post', label: '文章' }
    ]
    pageSel.innerHTML = groups.map(function (g) {
      var items = list.filter(function (p) { return (p.kind || 'core') === g.kind })
      if (!items.length) return ''
      return '<optgroup label="' + esc(g.label) + '">' + items.map(function (p) {
        return '<option value="' + esc(p.url) + '">' + esc(p.label) + '</option>'
      }).join('') + '</optgroup>'
    }).join('')
    visualState.page = pageSel.value || '/'

    pageSel.addEventListener('change', function () {
      visualState.page = pageSel.value
      visualLoadPage()
    })
    var wsel = $('#visual-width')
    if (wsel) {
      wsel.addEventListener('change', function () {
        visualState.width = Number(wsel.value) || 0
        visualFrameWidth()
      })
    }
    var freeze = $('#visual-freeze')
    if (freeze) {
      visualState.freeze = freeze.checked
      freeze.addEventListener('change', function () {
        visualState.freeze = freeze.checked
        visualApplyFrameCss()
      })
    }
    var outline = $('#visual-outline')
    if (outline) {
      visualState.outline = outline.checked
      outline.addEventListener('change', function () {
        visualState.outline = outline.checked
        visualClearHits()
        if (visualState.outline) visualMarkHits()
      })
    }
    var reload = $('#visual-reload')
    if (reload) reload.addEventListener('click', visualLoadPage)
    var frame = $('#visual-frame')
    if (frame) {
      frame.addEventListener('load', visualOnLoad)
    }
    var save = $('#btn-visual-save')
    if (save) save.addEventListener('click', saveSiteText)
    var revert = $('#btn-visual-revert')
    if (revert) revert.addEventListener('click', function () {
      if (visualDirtyRules() || textCounts().unsaved) {
        if (!confirm('放弃所有未保存的改动（文字 + 字形 / 位置 + 公告）？')) return
      }
      visualRevert()
    })
    var clearSel = $('#visual-clear-sel')
    if (clearSel) clearSel.addEventListener('click', visualClearSelection)
    $$('.visual-side-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.visual-side-tab').forEach(function (x) { x.classList.toggle('is-active', x === b) })
        $$('.visual-side-pane').forEach(function (p) {
          p.classList.toggle('is-active', p.id === 'visual-' + b.getAttribute('data-visual-side'))
        })
        if (b.getAttribute('data-visual-side') === 'rules') visualRefreshRules()
      })
    })
    visualFrameWidth()
    visualRefreshRules()
    visualLoadPage()
  }

  // ==================== 标签 / 分类 ====================
  function renderTaxonomy() {
    var m = state.meta
    if (!m) return
    function render(host, list, kind) {
      host.innerHTML = list.length ? list.map(function (t) {
        return '<div class="admin-tax-row">' +
          '<span class="admin-tax-name">' + esc(t.name) + '</span>' +
          '<span class="admin-tax-count">' + t.count + ' 篇</span>' +
          '<button class="admin-btn" data-rename="' + esc(t.name) + '" data-kind="' + kind + '">重命名</button>' +
          '<button class="admin-btn admin-btn-danger" data-remove="' + esc(t.name) + '" data-kind="' + kind + '">移除</button>' +
          '</div>'
      }).join('') : '<div class="admin-empty">暂无</div>'
      $$('#' + host.id + ' [data-rename]').forEach(function (b) {
        b.addEventListener('click', function () {
          var oldName = b.getAttribute('data-rename')
          var nv = prompt('把「' + oldName + '」重命名为：', oldName)
          if (!nv || nv.trim() === oldName) return
          rewriteTerm(kind, oldName, nv.trim())
        })
      })
      $$('#' + host.id + ' [data-remove]').forEach(function (b) {
        b.addEventListener('click', function () {
          var name = b.getAttribute('data-remove')
          if (!confirm('从所有文章中移除「' + name + '」？')) return
          rewriteTerm(kind, name, null)
        })
      })
    }
    render($('#tax-tags'), m.tags, 'tags')
    render($('#tax-cats'), m.categories, 'categories')
  }

  // 批量改写文章 front-matter 里的标签/分类
  function rewriteTerm(kind, oldName, newName) {
    var field = kind === 'tags' ? 'tags' : 'categories'
    var affected = state.posts.filter(function (p) { return (p[field] || []).indexOf(oldName) > -1 })
    if (!affected.length) { toast('没有文章使用「' + oldName + '」', 'err'); return }
    if (!confirm('将影响 ' + affected.length + ' 篇文章，逐篇提交到仓库。继续？')) return
    var done = 0, failed = 0
    function next(i) {
      if (i >= affected.length) {
        toast('完成：成功 ' + done + ' 篇' + (failed ? '，失败 ' + failed + ' 篇' : ''), failed ? 'err' : 'ok')
        reloadManifest(true)
        return
      }
      var p = affected[i]
      var path = 'source/' + p.source
      ghGetFile(path).then(function (f) {
        if (!f) throw new Error('文件不存在')
        var fm = parseFrontMatter(f.text)
        var arr = Array.isArray(fm.data[field]) ? fm.data[field].slice() : []
        if (newName) {
          arr = arr.map(function (x) { return x === oldName ? newName : x })
        } else {
          arr = arr.filter(function (x) { return x !== oldName })
        }
        fm.data[field] = arr
        var out = buildFrontMatter(fm.data) + '\n' + fm.body.replace(/^\n+/, '')
        return ghPutFile(path, out, 'admin: ' + (newName ? '重命名' : '移除') + ' ' + (kind === 'tags' ? '标签' : '分类') + ' ' + oldName, f.sha)
      }).then(function () {
        done++
      }).catch(function (e) {
        failed++
        console.warn('[admin] ' + p.source + ' 失败：' + e.message)
      }).then(function () { next(i + 1) })
    }
    toast('开始处理 ' + affected.length + ' 篇…')
    next(0)
  }

  // ==================== 归档 ====================
  function renderArchives() {
    var m = state.meta
    if (!m) return
    var zh = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月']
    $('#archives-view').innerHTML = m.archives.length ? m.archives.map(function (a) {
      var label = (zh[a.month - 1] || a.month) + ' ' + a.year
      var items = state.posts.filter(function (p) { return (p.date || '').slice(0, 7) === a.key })
      return '<div class="admin-panel" style="margin-bottom:10px">' +
        '<div class="admin-panel-title">' + esc(label) + ' · ' + a.count + ' 篇</div>' +
        '<div class="admin-list">' + items.map(function (p) {
          return '<div class="admin-item" data-open="' + esc(p.source) + '">' +
            '<div class="admin-item-main"><div class="admin-item-title">' + esc(p.title) + '</div>' +
            '<div class="admin-item-meta">' + esc(p.date) + '</div></div></div>'
        }).join('') + '</div></div>'
    }).join('') : '<div class="admin-empty">还没有归档</div>'
    $$('#archives-view .admin-item').forEach(function (el) {
      el.addEventListener('click', function () {
        switchTab('posts')
        openEditor(el.getAttribute('data-open'))
      })
    })
  }

  // ==================== 文字 ====================
  /* 「文字」标签页：
     清单（分组 / 标题 / 说明 / 默认值）来自 /admin/meta.json —— 构建期由
     scripts/site-text-catalog.js 生成，所以加条目只改那一个文件。
     当前值优先从仓库里的 source/_data/site_text.yml 读（手工改过也不丢），
     读不到就退回 meta 里那份。保存时把「和默认值不同」的条目合成 YAML 一次提交：
     一次提交 = 一次 Cloudflare 构建。
     语义：没写进文件的键继续跟着站点/主题配置走（配置以后改了这里自动跟上）。 */
  var TEXT_FILE_FALLBACK = 'source/_data/site_text.yml'
  var TEXT_HEADER = [
    '# ============================================================',
    '# 站点文字（由管理页 /admin/ 的「文字」「可视化」标签页读写）',
    '# ------------------------------------------------------------',
    '# texts:  这里只放「被改过」的文字：没出现的键就用站点/主题配置或主题语言文件里的原值。',
    '#         想恢复某一条为默认：在管理页点该项的「恢复默认」再保存（键会从本文件消失）。',
    '#         值统一写成双引号字符串（换行用 \\n 转义），方便机器读写、也方便 git diff。',
    '# styles: 字形/位置规则（「可视化」页写的）：sel = 作用目标(选择器)，css = 声明串。',
    '#         构建时注入 <style id="site-text-style">，只有 font-family 强制 !important。',
    '# 键名清单见 scripts/site-text-catalog.js；手改本文件也可以，格式照下面来。',
    '# ============================================================'
  ]

  var textState = {
    loaded: false,
    groups: [],
    items: [],
    byKey: {},
    order: [],
    extras: [],      // 文件里存在、但不在清单里的键（保存时原样保留）
    styles: [],      // 字形/位置规则（{sel,note,css,important,decls}）
    savedStyles: [],
    fileSha: null,
    fileMissing: false,
    filter: ''
  }

  function textFile() {
    return (state.meta && state.meta.texts && state.meta.texts.file) || TEXT_FILE_FALLBACK
  }

  function resetTextState() {
    var t = (state.meta && state.meta.texts) || null
    if (!t || !t.groups || !t.groups.length) {
      toast('文字清单没生成出来（/admin/meta.json 里没有 texts）——先让站点构建一次', 'err')
      return false
    }
    textState.groups = []
    textState.items = []
    textState.byKey = {}
    t.groups.forEach(function (g) {
      var group = { id: g.id, title: g.title, hint: g.hint || '', items: [] }
      g.items.forEach(function (it) {
        var item = {
          key: it.key,
          label: it.label,
          hint: it.hint || '',
          type: it.type === 'textarea' ? 'textarea' : 'text',
          def: it.def === undefined ? '' : String(it.def),
          val: it.val === undefined ? '' : String(it.val),
          group: g.id
        }
        item.saved = item.val
        textState.items.push(item)
        textState.byKey[item.key] = item
        group.items.push(item)
      })
      textState.groups.push(group)
    })
    textState.order = textState.items.map(function (it) { return it.key })
    textState.extras = []
    textState.styles = textStylesFromMeta(t)
    textState.savedStyles = textStylesFromMeta(t)
    visualState.savedRules = textStylesFromMeta(t)
    visualState.rules = textStylesFromMeta(t)
    textState.fileSha = null
    textState.fileMissing = false
    textState.loaded = true
    return true
  }

  /* 把服务端 meta 里的 styles 段转成编辑器内部结构（decls 直接可用） */
  function textStylesFromMeta (t) {
    var arr = (t && t.styles) || []
    return arr.map(function (r) {
      return {
        sel: r.sel,
        note: r.note || '',
        css: r.css || '',
        important: !!r.important,
        relAuto: false,
        decls: (r.decls || []).map(function (d) { return { prop: d.prop, value: d.value, important: !!d.important } })
      }
    })
  }

  /* 只看我们自己的格式（一行一个 `键: "JSON 字符串"`），所以按行解析就够，
     不用在浏览器里塞一个 YAML 解析器。
     注意：取某一"段"必须停在下一个顶层键（texts / styles 都是顶层），
     否则 styles 那几行会被当成文字键。 */
  function yamlSection (text, name) {
    var re = new RegExp('(?:^|\\n)' + name + ':([\\s\\S]*?)(?=\\n[A-Za-z_][A-Za-z0-9_-]*:|$)')
    var m = re.exec(String(text || ''))
    return m ? m[1] : ''
  }

  function parseTextYaml(text) {
    var map = {}, order = []
    var body = yamlSection(text, 'texts')
    if (/^\s*\{\s*\}\s*$/.test(body)) body = ''
    body.split(/\r?\n/).forEach(function (line) {
      if (!line.trim() || /^\s*#/.test(line)) return
      var kv = /^\s+([^\s:][^:]*):\s?(.*)$/.exec(line)
      if (!kv) return
      var key = kv[1].trim()
      var raw = kv[2]
      if (raw === '') return
      var val
      try { val = JSON.parse(raw) } catch (e) { val = raw.replace(/^["']|["']$/g, '') }
      if (typeof val !== 'string') val = String(val)
      if (map[key] === undefined) order.push(key)
      map[key] = val
    })
    return { map: map, order: order }
  }

  /* styles 段是 YAML 列表：一行的 `- sel: "…"` 起一条，后面缩进的行是它的字段 */
  function parseStylesYaml (text) {
    var out = []
    var body = yamlSection(text, 'styles')
    if (/^\s*(\[\]|\{\})\s*$/.test(body.trim())) body = ''
    var cur = null
    body.split(/\r?\n/).forEach(function (line) {
      if (!line.trim() || /^\s*#/.test(line)) return
      var item = /^\s*-\s*(.*)$/.exec(line)
      if (item) {
        cur = {}
        out.push(cur)
        line = item[1]
        if (!line.trim()) return
      }
      if (!cur) return
      var kv = /^\s*([a-zA-Z_-]+)\s*:\s?(.*)$/.exec(line)
      if (!kv) return
      var raw = kv[2]
      if (raw === '') return
      var val
      try { val = JSON.parse(raw) } catch (e) { val = raw.replace(/^["']|["']$/g, '') }
      cur[kv[1]] = val
    })
    return out.map(function (r) {
      return {
        sel: String(r.sel || ''),
        note: String(r.note || ''),
        css: String(r.css || ''),
        important: r.important === true || r.important === 'true',
        relAuto: false,
        decls: visualParseCss(r.css)
      }
    }).filter(function (r) { return r.sel })
  }

  function applyTextFile(text) {
    var parsed = parseTextYaml(text)
    textState.items.forEach(function (it) {
      var v = parsed.map[it.key]
      it.val = (v === undefined) ? it.def : v
      it.saved = it.val
    })
    textState.extras = parsed.order.filter(function (k) { return !textState.byKey[k] })
      .map(function (k) { return { key: k, value: parsed.map[k] } })
    var styles = parseStylesYaml(text)
    if (/(?:^|\n)styles:/.test(String(text || ''))) {
      textState.styles = styles
      textState.savedStyles = JSON.parse(JSON.stringify(styles))
      visualState.rules = JSON.parse(JSON.stringify(styles))
      visualState.savedRules = JSON.parse(JSON.stringify(styles))
    }
    // 公告草稿跟着文件走（重新拉取后要重画）
    visualState.announceApplied = ''
  }

  function textPh(def) {
    var s = String(def || '')
    if (s.length > 140) s = s.slice(0, 140) + '…'
    return s ? '默认：' + s : '（默认：空）'
  }

  function textRowHtml(it) {
    var control = it.type === 'textarea'
      ? '<textarea class="admin-textarea admin-text-input" rows="3" spellcheck="false" data-text="' + esc(it.key) + '" placeholder="' + esc(textPh(it.def)) + '"></textarea>'
      : '<input class="admin-input admin-text-input" type="text" spellcheck="false" data-text="' + esc(it.key) + '" placeholder="' + esc(textPh(it.def)) + '">'
    return '<div class="admin-text-row" data-row="' + esc(it.key) + '">' +
      '<div class="admin-text-head">' +
        '<span class="admin-text-label">' + esc(it.label) + '</span>' +
        '<code class="admin-text-key">' + esc(it.key) + '</code>' +
        '<span class="admin-text-badge"></span>' +
        '<button class="admin-btn admin-text-reset" type="button" data-reset="' + esc(it.key) + '">恢复默认</button>' +
      '</div>' +
      control +
      (it.hint ? '<div class="admin-text-hint">' + esc(it.hint) + '</div>' : '') +
      '</div>'
  }

  function matchText(it, kw) {
    if (!kw) return true
    return (it.label + ' ' + it.key + ' ' + it.val + ' ' + it.hint + ' ' + it.def).toLowerCase().indexOf(kw) > -1
  }

  function renderTexts() {
    var host = $('#texts-groups')
    if (!host) return
    var kw = textState.filter
    var html = textState.groups.map(function (g) {
      var rows = g.items.filter(function (it) { return matchText(it, kw) })
      if (!rows.length) return ''
      return '<div class="admin-panel admin-text-group">' +
        '<div class="admin-panel-title">' + esc(g.title) + '</div>' +
        (g.hint ? '<div class="admin-group-hint">' + esc(g.hint) + '</div>' : '') +
        rows.map(textRowHtml).join('') +
        '</div>'
    }).join('')
    host.innerHTML = html || '<div class="admin-empty">没有匹配的文字条目</div>'
    bindTextRows()
    updateTextSummary()
  }

  function textRowEl(key) {
    return $('#texts-groups .admin-text-row[data-row="' + key + '"]')
  }
  function textInputEl(key) {
    return $('#texts-groups [data-text="' + key + '"]')
  }

  function updateRowState(it) {
    var row = textRowEl(it.key)
    if (!row) return
    var over = it.val !== it.def
    var unsaved = it.val !== it.saved
    row.classList.toggle('is-overridden', over)
    row.classList.toggle('is-unsaved', unsaved)
    var badge = row.querySelector('.admin-text-badge')
    if (badge) {
      badge.textContent = unsaved ? '未保存' : (over ? '已覆盖' : '')
      badge.className = 'admin-text-badge' + (unsaved ? ' is-unsaved' : (over ? ' is-overridden' : ''))
    }
  }

  function textCounts() {
    var over = 0, unsaved = 0
    textState.items.forEach(function (it) {
      if (it.val !== it.def) over++
      if (it.val !== it.saved) unsaved++
    })
    return { over: over, unsaved: unsaved }
  }

  function updateTextSummary() {
    var c = textCounts()
    var label = $('#btn-save-texts-label')
    if (label) label.textContent = c.unsaved ? ('保存修改（' + c.unsaved + '）') : '保存修改'
    var el = $('#texts-summary')
    if (!el) return
    if (!textState.items.length) { el.textContent = '清单为空'; return }
    var rules = (visualState.rules || []).length
    el.innerHTML = '共 <b>' + textState.items.length + '</b> 条文字' +
      ' · 已覆盖 <b>' + c.over + '</b> 条（会写进 <code>' + esc(textFile()) + '</code>）' +
      ' · 未保存 <b>' + c.unsaved + '</b> 条' +
      (rules ? ' · 字形/位置规则 <b>' + rules + '</b> 条' : '') +
      (textState.extras.length ? ' · 文件里另有 ' + textState.extras.length + ' 个不在清单里的键（保存时原样保留）' : '') +
      (textState.fileMissing ? ' · 仓库里还没有这个文件，首次保存会自动创建' : '')
  }

  function bindTextRows() {
    $$('#texts-groups [data-text]').forEach(function (el) {
      var it = textState.byKey[el.getAttribute('data-text')]
      if (!it) return
      el.value = it.val
      el.addEventListener('input', function () {
        it.val = el.value
        updateRowState(it)
        updateTextSummary()
      })
    })
    $$('#texts-groups [data-reset]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = textState.byKey[b.getAttribute('data-reset')]
        if (!it) return
        it.val = it.def
        var input = textInputEl(it.key)
        if (input) input.value = it.val
        updateRowState(it)
        updateTextSummary()
      })
    })
    textState.items.forEach(function (it) {
      if (textRowEl(it.key)) updateRowState(it)
    })
  }

  function collectTexts() {
    var map = {}
    textState.items.forEach(function (it) { if (it.val !== it.def) map[it.key] = it.val })
    textState.extras.forEach(function (e) { if (map[e.key] === undefined) map[e.key] = e.value })
    return map
  }

  /* 保存文件 = texts 段 + styles 段（两个标签页共用同一份拼装逻辑，
     所以从「文字」页保存不会把「可视化」页的规则弄丢，反之亦然）。 */
  function buildSiteTextYaml (map) {
    var keys = textState.order.filter(function (k) { return map[k] !== undefined })
    textState.extras.forEach(function (e) { if (map[e.key] !== undefined && keys.indexOf(e.key) === -1) keys.push(e.key) })
    Object.keys(map).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k) })
    var lines = TEXT_HEADER.slice()
    if (!keys.length) {
      lines.push('texts: {}')
    } else {
      lines.push('texts:')
      keys.forEach(function (k) { lines.push('  ' + k + ': ' + JSON.stringify(String(map[k]))) })
    }
    var rules = visualState.rules || []
    if (!rules.length) {
      lines.push('styles: []')
    } else {
      lines.push('styles:')
      rules.forEach(function (r) {
        lines.push('  - sel: ' + JSON.stringify(r.sel))
        lines.push('    note: ' + JSON.stringify(r.note || ''))
        lines.push('    css: ' + JSON.stringify(visualFileCss(r)))
        if (r.important) lines.push('    important: true')
      })
    }
    return lines.join('\n') + '\n'
  }

  function ensureTextsLoaded () {
    if (textState.loaded) return Promise.resolve()
    return loadTexts(true)
  }

  function loadTexts(silent) {
    if (!resetTextState()) return Promise.resolve()
    renderTexts() // 先用 meta.json 里那份画出来，网络慢也马上能看到
    var file = textFile()
    return ghGetFile(file).then(function (f) {
      if (f) {
        textState.fileSha = f.sha
        applyTextFile(f.text)
        textState.fileMissing = false
      } else {
        textState.fileMissing = true
        applyTextFile('')
      }
      renderTexts()
      visualRefreshRules()
      if (!silent) toast('已从仓库拉取文字（' + textState.items.filter(function (it) { return it.val !== it.def }).length + ' 条覆盖）', 'ok')
    }).catch(function (e) {
      if (!silent) toast('读取 ' + file + ' 失败（显示的是最近一次构建的值）：' + e.message, 'err')
    })
  }

  function saveSiteText() {
    if (!textState.loaded) { toast('文字清单还没准备好，稍等一下再保存', 'err'); return }
    var c = textCounts()
    var rulesDirty = visualRulesSnapshot(visualState.rules) !== visualRulesSnapshot(visualState.savedRules)
    if (!c.unsaved && !rulesDirty) { toast('没有未保存的修改', 'err'); return }
    var map = collectTexts()
    var text = buildSiteTextYaml(map)
    var file = textFile()
    var btn = $('#btn-save-texts')
    var btn2 = $('#btn-visual-save')
    if (btn) btn.disabled = true
    if (btn2) btn2.disabled = true
    var msg = 'admin: 更新站点文字（' + Object.keys(map).length + ' 条文字' +
      (visualState.rules.length ? ' / ' + visualState.rules.length + ' 条字形·位置规则' : '') + '）'
    ghGetFile(file).then(function (f) {
      return ghPutFile(file, text, msg, f ? f.sha : null)
    }).then(function () {
      if (btn) btn.disabled = false
      if (btn2) btn2.disabled = false
      textState.items.forEach(function (it) {
        it.saved = it.val
        if (textRowEl(it.key)) updateRowState(it)
      })
      textState.savedStyles = JSON.parse(JSON.stringify(visualState.rules.map(function (r) {
        return { sel: r.sel, note: r.note, css: visualFileCss(r), important: !!r.important, decls: r.decls }
      })))
      visualState.savedRules = JSON.parse(JSON.stringify(visualState.rules))
      textState.fileMissing = false
      updateTextSummary()
      visualRefreshRules()
      toast('已提交 ' + file + '（' + Object.keys(map).length + ' 条文字 · ' + visualState.rules.length +
        ' 条规则）· 站点重新构建后生效', 'ok')
    }).catch(function (e) {
      if (btn) btn.disabled = false
      if (btn2) btn2.disabled = false
      toast('保存失败：' + e.message, 'err')
    })
  }

  // ==================== 设置 ====================
  // 凭证体检：把「哪一步不通」逐条摆出来。
  // 原来只有一句 "连接失败：xxx"，401/403/404 全被压成同一类文案，
  // 站长根本分不清是 Token 过期、没给仓库权限，还是分支写错了。
  function diagnose() {
    var el = $('#gh-status')
    if (!el) return Promise.resolve()
    var lines = [], bad = false
    function line(text, isBad) {
      if (isBad) bad = true
      lines.push('<span' + (isBad ? ' class="is-bad"' : '') + '>' + esc(text) + '</span>')
      flush()
    }
    function flush() { el.innerHTML = lines.join('<br>') }

    // 0) 本机存储状态
    var st = readStoredToken()
    if (st.state === 'ok') line('① 本机已存 Token（混淆编码，' + state.gh.token.length + ' 字符）')
    else if (st.state === 'legacy') line('① 本机存的是旧明文格式，已自动升级为混淆编码')
    else if (st.state === 'broken') line('① 本机存的 Token 解不开（' + st.reason + '）→ 重新粘贴一枚并保存', true)
    else if (st.state === 'blocked') line('① 本机存储不可用：' + st.reason + '（浏览器禁用了本站站点数据？）', true)
    else line('① 本机还没存 Token → 粘贴 PAT 后点「保存凭证」', true)

    if (!state.gh.token) {
      line('② 没有可用 Token，跳过 GitHub 探测', true)
      return Promise.resolve()
    }
    line('② 目标仓库：' + state.gh.owner + '/' + state.gh.name + ' @' + state.gh.branch)

    return ghApiGet('/user').then(function (res) {
      if (res.status === 401) { line('③ Token 认证失败：无效 / 已过期 / 已撤销（HTTP 401）', true); return }
      if (!res.ok) {
        line('③ Token 身份接口异常：' + ghErrorMessage(res) + '（继续探测仓库）', true)
      } else {
        var u = res.data || {}
        line('③ Token 身份：@' + (u.login || '?') + (u.name ? '（' + u.name + '）' : ''))
        var scopes = res.headers.get('x-oauth-scopes')
        line(scopes === null
          ? '④ 类型：细粒度 PAT（按「仓库 + 权限」授权，必须勾选本仓库的 Contents: Read and write）'
          : '④ 类型：经典 PAT，授权范围「' + (scopes || '空（仅公共只读）') + '」')
      }
      return ghRequest('').then(function (repo) {
        if (!repo.ok) { line('⑤ 仓库不可访问：' + ghErrorMessage(repo), true); return }
        var d = repo.data || {}
        line('⑤ 仓库可访问：' + (d.full_name || '') + '（' + (d.private ? '私有' : '公开') + '，默认分支 ' + (d.default_branch || '?') + '）')
        if (d.default_branch && d.default_branch !== state.gh.branch) {
          line('⑥ 分支不一致：设置里写的是 ' + state.gh.branch + '，仓库默认是 ' + d.default_branch + ' → 读文件会 404', true)
        } else {
          line('⑥ 分支一致：' + state.gh.branch)
        }
        var perm = d.permissions || {}
        if (perm.push === true) line('⑦ 写入权限：有（Contents: write），保存文章可用')
        else if (perm.push === false) line('⑦ 写入权限：没有 → 保存文章会 403，请把 Contents 改成 Read and write', true)
        else line('⑦ 写入权限：接口没返回 permissions 字段，保存文章时才能确认')

        var remain = repo.headers.get('x-ratelimit-remaining')
        if (remain !== null) line('⑧ API 配额剩余：' + remain + ' 次/小时')

        // 读一份"管理页一定会写的文件"来验证 Contents: read（文字层是首选：
        // 它同时被「文字」与「可视化」两页写；老站在还没有这个文件时会 404，
        // 那时退回读公告文件，同样能证明读权限）
        var probe = textFile()
        return ghGetFile(probe).then(function (f) {
          if (f) { line('⑨ 读取测试通过：' + probe + '（Contents: read 正常）'); return }
          var alt = (state.meta && state.meta.announceFile) || 'source/_data/announcement.yml'
          return ghGetFile(alt).then(function (f2) {
            if (f2) line('⑨ 读取测试通过：' + alt + '（Contents: read 正常；' + probe + ' 还没创建）')
            else line('⑨ 读取测试失败：' + probe + ' 读不到（文件不在该分支，或 Contents: read 没给）', true)
            line(bad ? '结论：还有问题，见上面标红的条目' : '结论：一切正常，管理页可以正常读写仓库')
          })
        })
      })
    }).catch(function (e) {
      line('体检中断：' + ((e && e.message) || e), true)
    }).then(function () {
      // 结果回写顶栏状态，并让"最后一条结论"留在最下面
      state.gh.check = bad ? 'fail' : 'ok'
      renderRepoStatus()
      flush()
    })
  }

  function clearCredentials() {
    if (!confirm('清除本机保存的 GitHub Token？')) return
    try { localStorage.removeItem(TOKEN_STORE); localStorage.removeItem(CFG_STORE) } catch (e) {}
    state.gh.token = ''
    $('#gh-token').value = ''
    renderRepoStatus()
    $('#gh-status').innerHTML = esc('凭证已清除')
  }

  // 密钥=普通密码：8–64 位、大小写敏感、字母/数字/符号都行，不要求固定格式
  // （旧版是 XXXXX-XXXXX-XXXXX-XXXXX 激活码样式 + 强制大写，已废弃）
  var KEY_MIN = 8
  var KEY_MAX = 64
  function changeAdminKey() {
    var raw = $('#new-admin-key').value.trim()
    if (raw.length < KEY_MIN) { toast('密钥太短：至少 ' + KEY_MIN + ' 位', 'err'); return }
    if (raw.length > KEY_MAX) { toast('密钥太长：最多 ' + KEY_MAX + ' 位', 'err'); return }
    if (/^[0-9]+$/.test(raw) || /^[A-Za-z]+$/.test(raw)) {
      toast('密钥太弱：纯数字或纯字母容易被猜到，掺上另一类字符', 'err'); return
    }
    var keyFile = (state.meta && state.meta.keyFile) || 'source/custom/admin/admin-key.js'
    sha256hex(raw).then(function (hex) {
      return ghGetFile(keyFile).then(function (f) {
        if (!f) throw new Error('找不到 ' + keyFile)
        var text = f.text.replace(/window\.ADMIN_KEY_SHA256\s*=\s*'[0-9a-f]*'/, "window.ADMIN_KEY_SHA256 = '" + hex + "'")
        if (text.indexOf(hex) === -1) throw new Error('替换失败：文件结构与预期不符')
        return ghPutFile(keyFile, text, 'admin: 更新管理员密钥', f.sha).then(function () {
          try { sessionStorage.setItem(UNLOCK_STORE, hex) } catch (e) {}
          toast('新密钥已提交（哈希 ' + hex.slice(0, 8) + '…），请牢记明文密钥', 'ok')
          $('#new-admin-key').value = ''
        })
      })
    }).catch(function (e) { toast('修改失败：' + e.message, 'err') })
  }

  // ==================== 标签页 ====================
  // 选中态只靠文字变亮（CSS 负责），这里只切类名与面板
  function switchTab(name) {
    $$('.admin-tab').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-tab') === name) })
    $$('.admin-pane').forEach(function (p) { p.classList.toggle('is-active', p.id === 'tab-' + name) })
    var app = $('#admin-app')
    if (app) app.classList.toggle('is-visual', name === 'visual')
    if (name === 'posts') showListView()
    if (name !== 'posts') setEditorWide(false)   // 别的标签页不需要写作页那点宽度
    if (name === 'texts' && !textState.loaded) loadTexts(false)
    if (name === 'visual') {
      visualInit()
      ensureTextsLoaded().then(function () {
        visualClearHits()
        visualMarkHits()
        if (visualState.sel) visualBuildInspector()
        visualRefreshRules()
      })
    }
  }

  // ==================== 启动 ====================
  function boot() {
    loadGhConfig()
    renderRepoStatus()
    // 有 Token 就自动体检一次：打开页面就能看到「哪一步不通」，
    // 不用站长自己去猜、也不用先点按钮
    if (state.gh.token) diagnose()
    decorateCards()
    $('#gh-owner').value = state.gh.owner
    $('#gh-name').value = state.gh.name
    $('#gh-branch').value = state.gh.branch
    $('#gh-token').value = state.gh.token

    $('#btn-home').addEventListener('click', function () { location.href = '/' })
    $$('.admin-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')) })
    })
    $('#btn-reload').addEventListener('click', function () { reloadManifest(false) })
    $('#btn-logout').addEventListener('click', function () {
      try { sessionStorage.removeItem(UNLOCK_STORE) } catch (e) {}
      location.reload()
    })
    $('#posts-filter').addEventListener('input', function (e) {
      state.filter = e.target.value.trim()
      renderPosts()
    })
    $('#btn-new-post').addEventListener('click', newPost)
    $('#btn-back-list').addEventListener('click', showListView)
    $('#btn-cancel-edit').addEventListener('click', showListView)
    $('#btn-save-post').addEventListener('click', savePost)
    $('#btn-delete-post').addEventListener('click', deletePost)
    $('#btn-texts-reload').addEventListener('click', function () { loadTexts(false) })
    $('#btn-save-texts').addEventListener('click', saveSiteText)
    $('#texts-filter').addEventListener('input', function (e) {
      textState.filter = e.target.value.trim().toLowerCase()
      if (textState.loaded) renderTexts()
    })
    $('#btn-save-gh').addEventListener('click', saveGhConfig)
    $('#btn-test-gh').addEventListener('click', diagnose)
    $('#btn-clear-gh').addEventListener('click', clearCredentials)
    $('#btn-save-admin-key').addEventListener('click', changeAdminKey)

    initEditorUI()
    decorateCards()
    observeCards()
    reloadManifest(true)
  }

  // ==================== 入口 ====================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
  function start() {
    if (!ADMIN_HASH) { toast('未配置管理员密钥哈希', 'err'); return }
    initGate()
    if (unlocked()) unlock()
  }
})()
