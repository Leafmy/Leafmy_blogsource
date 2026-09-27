/* ============================================================
   管理控制台 /admin/
   ------------------------------------------------------------
   进入方式：
   1) 在站点搜索栏输入管理员密钥后**按回车** → 自动跳转
   2) 直接访问 /admin/，在门禁里输入密钥

   数据写入：GitHub Contents API（站长自己的细粒度 PAT，只存本机浏览器）
   - 文章：source/_posts/*.md 增删改
   - 公告：source/_data/announcement.yml
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
      var v = input.value.trim().toUpperCase()
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

  // ==================== 公告 ====================
  function loadAnnouncement() {
    var file = (state.meta && state.meta.announceFile) || 'source/_data/announcement.yml'
    $('#announce-body').value = '读取中…'
    ghGetFile(file).then(function (f) {
      if (f) {
        var m = /content:\s*\|([\s\S]*)$/.exec(f.text)
        var body = m ? m[1].split('\n').map(function (l) { return l.replace(/^ {2}/, '') }).join('\n').replace(/^\n+/, '').replace(/\s+$/, '') : f.text
        $('#announce-body').value = body
      } else {
        $('#announce-body').value = (state.meta && state.meta.announcement) || ''
      }
    }).catch(function (e) {
      $('#announce-body').value = (state.meta && state.meta.announcement) || ''
      toast('公告读取失败（已用本地缓存）：' + e.message, 'err')
    })
  }

  function saveAnnouncement() {
    var file = (state.meta && state.meta.announceFile) || 'source/_data/announcement.yml'
    var body = $('#announce-body').value
    var indented = body.split('\n').map(function (l) { return l ? '  ' + l : '' }).join('\n')
    var text = '# 公告内容（由管理页 /admin/ 的「公告」标签页读写）\n' +
      '# 优先级：本文件 > 主题 _config.yml 的 aside.card_announcement.content\n' +
      'content: |\n' + indented + '\n'
    ghGetFile(file).then(function (f) {
      return ghPutFile(file, text, 'admin: 更新侧栏公告', f ? f.sha : null)
    }).then(function () {
      toast('公告已提交，站点重新构建后生效', 'ok')
    }).catch(function (e) { toast('公告保存失败：' + e.message, 'err') })
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
    '# 站点文字（由管理页 /admin/ 的「文字」标签页读写）',
    '# ------------------------------------------------------------',
    '# 这里只放「被改过」的文字：没出现的键就用站点/主题配置或主题语言文件里的原值。',
    '# 想恢复某一条为默认：在管理页点该项的「恢复默认」再保存（键会从本文件消失）。',
    '# 值统一写成双引号字符串（换行用 \\n 转义），方便机器读写、也方便 git diff。',
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
    textState.fileSha = null
    textState.fileMissing = false
    textState.loaded = true
    return true
  }

  /* 只看我们自己的格式（一行一个 `键: "JSON 字符串"`），所以按行解析就够，
     不用在浏览器里塞一个 YAML 解析器。 */
  function parseTextYaml(text) {
    var map = {}, order = []
    var m = /(?:^|\n)texts:([\s\S]*)$/.exec(String(text || ''))
    var body = m ? m[1] : ''
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

  function applyTextFile(text) {
    var parsed = parseTextYaml(text)
    textState.items.forEach(function (it) {
      var v = parsed.map[it.key]
      it.val = (v === undefined) ? it.def : v
      it.saved = it.val
    })
    textState.extras = parsed.order.filter(function (k) { return !textState.byKey[k] })
      .map(function (k) { return { key: k, value: parsed.map[k] } })
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
    el.innerHTML = '共 <b>' + textState.items.length + '</b> 条文字' +
      ' · 已覆盖 <b>' + c.over + '</b> 条（会写进 <code>' + esc(textFile()) + '</code>）' +
      ' · 未保存 <b>' + c.unsaved + '</b> 条' +
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

  function buildTextYaml(map) {
    var keys = textState.order.filter(function (k) { return map[k] !== undefined })
    textState.extras.forEach(function (e) { if (map[e.key] !== undefined && keys.indexOf(e.key) === -1) keys.push(e.key) })
    Object.keys(map).forEach(function (k) { if (keys.indexOf(k) === -1) keys.push(k) })
    if (!keys.length) return TEXT_HEADER.join('\n') + '\ntexts: {}\n'
    return TEXT_HEADER.join('\n') + '\ntexts:\n' + keys.map(function (k) {
      return '  ' + k + ': ' + JSON.stringify(String(map[k]))
    }).join('\n') + '\n'
  }

  function loadTexts(silent) {
    if (!resetTextState()) return
    renderTexts() // 先用 meta.json 里那份画出来，网络慢也马上能看到
    var file = textFile()
    ghGetFile(file).then(function (f) {
      if (f) {
        textState.fileSha = f.sha
        applyTextFile(f.text)
        textState.fileMissing = false
      } else {
        textState.fileMissing = true
        applyTextFile('')
      }
      renderTexts()
      if (!silent) toast('已从仓库拉取文字（' + textState.items.filter(function (it) { return it.val !== it.def }).length + ' 条覆盖）', 'ok')
    }).catch(function (e) {
      if (!silent) toast('读取 ' + file + ' 失败（显示的是最近一次构建的值）：' + e.message, 'err')
    })
  }

  function saveTexts() {
    if (!textState.loaded) return
    var c = textCounts()
    if (!c.unsaved) { toast('没有未保存的修改', 'err'); return }
    var map = collectTexts()
    var text = buildTextYaml(map)
    var file = textFile()
    var btn = $('#btn-save-texts')
    btn.disabled = true
    ghGetFile(file).then(function (f) {
      return ghPutFile(file, text, 'admin: 更新站点文字（' + Object.keys(map).length + ' 条）', f ? f.sha : null)
    }).then(function () {
      btn.disabled = false
      textState.items.forEach(function (it) { it.saved = it.val })
      textState.items.forEach(function (it) { if (textRowEl(it.key)) updateRowState(it) })
      textState.fileMissing = false
      updateTextSummary()
      toast('已提交 ' + file + '（' + Object.keys(map).length + ' 条覆盖）· 站点重新构建后生效', 'ok')
    }).catch(function (e) {
      btn.disabled = false
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

        var probe = (state.meta && state.meta.announceFile) || 'source/_data/announcement.yml'
        return ghGetFile(probe).then(function (f) {
          if (f) line('⑨ 读取测试通过：' + probe + '（Contents: read 正常）')
          else line('⑨ 读取测试失败：' + probe + ' 读不到（文件不在该分支，或 Contents: read 没给）', true)
          line(bad ? '结论：还有问题，见上面标红的条目' : '结论：一切正常，管理页可以正常读写仓库')
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

  function changeAdminKey() {
    var raw = $('#new-admin-key').value.trim().toUpperCase()
    if (raw.length < 12) { toast('密钥太短，建议至少 12 位', 'err'); return }
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
    if (name === 'posts') showListView()
    if (name !== 'posts') setEditorWide(false)   // 别的标签页不需要写作页那点宽度
    if (name === 'announce') loadAnnouncement()
    if (name === 'texts' && !textState.loaded) loadTexts(false)
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
    $('#btn-save-announce').addEventListener('click', saveAnnouncement)
    $('#btn-reload-announce').addEventListener('click', loadAnnouncement)
    $('#btn-texts-reload').addEventListener('click', function () { loadTexts(false) })
    $('#btn-save-texts').addEventListener('click', saveTexts)
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
