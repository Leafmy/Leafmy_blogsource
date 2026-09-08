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
    if (/^[A-Za-z0-9\u4e00-\u9fa5][A-Za-z0-9\u4e00-\u9fa5 ._+\-/]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s)) return s
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
    gh: { owner: 'Leafmy', name: 'Leafmy_blogsource', branch: 'main', token: '' },
    editing: null,
    filter: ''
  }

  // ==================== GitHub API ====================
  var GH_API = 'https://api.github.com'

  function ghPath(p) {
    return String(p).split('/').map(encodeURIComponent).join('/')
  }

  function ghFetch(apiPath, opts) {
    opts = opts || {}
    if (!state.gh.token) return Promise.reject(new Error('未配置 GitHub Token（设置 → GitHub 写入凭证）'))
    var headers = {
      'Accept': 'application/vnd.github+json',
      'Authorization': 'Bearer ' + state.gh.token,
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (opts.body) headers['Content-Type'] = 'application/json'
    var url = GH_API + '/repos/' + state.gh.owner + '/' + state.gh.name + apiPath
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    }).then(function (res) {
      if (res.status === 404) return null
      if (!res.ok) {
        return res.json().catch(function () { return {} }).then(function (d) {
          var msg = (d && d.message) || ('HTTP ' + res.status)
          if (res.status === 401) msg = 'Token 无效或已过期'
          if (res.status === 403) msg = 'Token 权限不足或触发限流（需 Contents: Read and write）'
          if (res.status === 409) msg = '文件已变化（sha 冲突），请刷新后重试'
          throw new Error(msg)
        })
      }
      return res.json()
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

  function refreshGlowCards() {
    glowCards = Array.prototype.slice.call(document.querySelectorAll('.adm-card'))
  }

  function updateGlow() {
    glowRaf = 0
    if (!glowCards.length) refreshGlowCards()
    for (var i = 0; i < glowCards.length; i++) {
      var el = glowCards[i]
      var r = el.getBoundingClientRect()
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

  function mdToHtml(src) {
    var blocks = []
    var text = String(src || '').replace(/\r\n?/g, '\n')
    // 1) 先摘出围栏代码块（内容整体转义，不再参与后面的行内替换）
    text = text.replace(/```[^\n`]*\n([\s\S]*?)(?:\n?```|$)/g, function (m, code) {
      blocks.push('<pre><code>' + mdEscape(code.replace(/\n$/, '')) + '</code></pre>')
      return '\n\u0000B' + (blocks.length - 1) + '\u0000\n'
    })
    // 2) 其余内容统一转义（后面只做受控替换）
    text = mdEscape(text)

    var lines = text.split('\n')
    var out = []
    var para = []
    function flush() {
      if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = [] }
    }
    function splitRow(line) {
      return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
        .map(function (c) { return c.trim() })
    }
    var i = 0
    while (i < lines.length) {
      var line = lines[i]
      var bm = /^\u0000B(\d+)\u0000$/.exec(line.trim())
      if (bm) { flush(); out.push(blocks[Number(bm[1])] || ''); i++; continue }
      if (!line.trim()) { flush(); i++; continue }

      var h = /^(#{1,4})\s+(.*)$/.exec(line)
      if (h) {
        flush()
        var lv = h[1].length
        out.push('<h' + lv + '>' + mdInline(h[2]) + '</h' + lv + '>')
        i++; continue
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); out.push('<hr>'); i++; continue }

      // 引用行：'&gt;' 是转义后的 '>'（转义发生在块级解析之前）
      if (/^&gt;\s?/.test(line)) {
        flush()
        var qs = []
        while (i < lines.length && /^&gt;\s?/.test(lines[i])) {
          qs.push(lines[i].replace(/^&gt;\s?/, '')); i++
        }
        out.push('<blockquote>' + qs.map(mdInline).join('<br>') + '</blockquote>')
        continue
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        flush()
        var ul = []
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          ul.push('<li>' + mdInline(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++
        }
        out.push('<ul>' + ul.join('') + '</ul>')
        continue
      }

      if (/^\s*\d+\.\s+/.test(line)) {
        flush()
        var ol = []
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          ol.push('<li>' + mdInline(lines[i].replace(/^\s*\d+\.\s+/, '')) + '</li>'); i++
        }
        out.push('<ol>' + ol.join('') + '</ol>')
        continue
      }

      // 表格：本行有 |，下一行是 |---| 分隔行
      if (line.indexOf('|') > -1 && i + 1 < lines.length &&
        /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/.test(lines[i + 1])) {
        flush()
        var head = splitRow(line)
        i += 2
        var rows = []
        while (i < lines.length && lines[i].indexOf('|') > -1 && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++
        }
        out.push('<table><thead><tr>' +
          head.map(function (c) { return '<th>' + mdInline(c) + '</th>' }).join('') +
          '</tr></thead><tbody>' +
          rows.map(function (r) {
            return '<tr>' + r.map(function (c) { return '<td>' + mdInline(c) + '</td>' }).join('') + '</tr>'
          }).join('') +
          '</tbody></table>')
        continue
      }

      para.push(line)
      i++
    }
    flush()
    return out.join('\n')
  }

  function updatePreview() {
    var host = $('#editor-preview')
    if (!host) return
    host.innerHTML = mdToHtml($('#ed-body').value)
  }

  function schedulePreview() {
    clearTimeout(previewTimer)
    previewTimer = setTimeout(updatePreview, 180)
  }

  function setEditorMode(mode) {
    editorMode = mode
    var body = $('#editor-body')
    if (body) body.className = 'editor-body mode-' + mode
    $$('.editor-mode').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-mode') === mode)
    })
    if (mode !== 'edit') updatePreview()
  }

  // 编辑器内容变化后的统一收尾
  function afterEdit() {
    markDirty(true)
    scheduleDraft()
    updateStats()
    updateStickyState()
    if (editorMode !== 'edit') schedulePreview()
  }

  // 打开文章 / 新建文章后同步整块 UI
  function syncEditorUI() {
    updateStats()
    updateStickyState()
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
  function loadGhConfig() {
    try {
      var cfg = JSON.parse(localStorage.getItem(CFG_STORE) || 'null')
      if (cfg) {
        state.gh.owner = cfg.owner || state.gh.owner
        state.gh.name = cfg.name || state.gh.name
        state.gh.branch = cfg.branch || state.gh.branch
      }
    } catch (e) {}
    state.gh.token = decToken(localStorage.getItem(TOKEN_STORE))
  }

  function saveGhConfig() {
    var owner = $('#gh-owner').value.trim() || 'Leafmy'
    var name = $('#gh-name').value.trim() || 'Leafmy_blogsource'
    var branch = $('#gh-branch').value.trim() || 'main'
    var token = $('#gh-token').value.trim()
    if (!token) { toast('请填入 GitHub Token', 'err'); return }
    state.gh.owner = owner; state.gh.name = name; state.gh.branch = branch; state.gh.token = token
    try {
      localStorage.setItem(CFG_STORE, JSON.stringify({ owner: owner, name: name, branch: branch }))
      localStorage.setItem(TOKEN_STORE, encToken(token))
    } catch (e) { toast('本机存储写入失败', 'err'); return }
    renderRepoStatus()
    toast('凭证已保存（仅存本机浏览器）', 'ok')
  }

  function renderRepoStatus() {
    var el = $('#admin-repo')
    if (!el) return
    var has = !!state.gh.token
    el.textContent = state.gh.owner + '/' + state.gh.name + ' @' + state.gh.branch + (has ? ' · 已授权' : ' · 未配置 Token')
    el.style.color = has ? '' : '#ffb4ae'
  }

  // ==================== 数据加载 ====================
  function fetchJSON(url) {
    return fetch(url + '?t=' + Date.now(), { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(url + ' 加载失败（HTTP ' + r.status + '）')
      return r.json()
    })
  }

  function reloadManifest(silent) {
    return Promise.all([fetchJSON('/admin/posts.json'), fetchJSON('/admin/meta.json')]).then(function (res) {
      state.posts = (res[0] && res[0].posts) || []
      state.meta = res[1] || null
      renderOverview()
      renderPosts()
      renderTaxonomy()
      renderArchives()
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

  function showListView() {
    $('#posts-list-view').style.display = ''
    $('#post-editor-view').style.display = 'none'
  }

  function newPost() {
    state.editing = { mode: 'new', path: '', sha: null, data: {}, body: '' }
    $('#editor-file').textContent = '新文章（保存后写入 ' + (state.meta ? state.meta.postsDir : 'source/_posts') + '/）'
    $('#ed-title').value = ''
    $('#ed-date').value = fmtDate(new Date())
    $('#ed-sticky').value = '0'
    $('#ed-categories').value = ''
    $('#ed-tags').value = ''
    $('#ed-desc').value = ''
    $('#ed-body').value = ''
    $('#btn-delete-post').style.display = 'none'
    $('#posts-list-view').style.display = 'none'
    $('#post-editor-view').style.display = ''
    markDirty(false)
    setEditorMode('edit')
    syncEditorUI()
    checkDraft()
    $('#ed-title').focus()
  }

  function openEditor(source) {
    if (!source) return
    var meta = state.posts.filter(function (p) { return p.source === source })[0]
    var fullPath = 'source/' + source
    $('#editor-file').textContent = fullPath + ' · 读取中…'
    $('#posts-list-view').style.display = 'none'
    $('#post-editor-view').style.display = ''
    $('#btn-delete-post').style.display = ''

    ghGetFile(fullPath).then(function (file) {
      if (!file) { toast('仓库里找不到该文件：' + fullPath, 'err'); showListView(); return }
      var fm = parseFrontMatter(file.text)
      state.editing = { mode: 'edit', path: fullPath, sha: file.sha, data: fm.data, body: fm.body }
      $('#editor-file').textContent = fullPath
      $('#ed-title').value = fm.data.title || (meta && meta.title) || ''
      $('#ed-date').value = fm.data.date || (meta && meta.date) || ''
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

  function collectEditor() {
    var data = Object.assign({}, (state.editing && state.editing.data) || {})
    data.title = $('#ed-title').value.trim()
    data.date = $('#ed-date').value.trim() || fmtDate(new Date())
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
    var path = isNew
      ? (state.meta ? state.meta.postsDir : 'source/_posts') + '/' + slugify(got.data.title) + '.md'
      : ed.path
    var msg = (isNew ? 'admin: 新建文章 ' : 'admin: 更新文章 ') + got.data.title
    ghPutFile(path, content, msg, isNew ? null : ed.sha).then(function (res) {
      btn.disabled = false
      toast('已提交到仓库：' + path + '（站点重新构建后生效）', 'ok')
      clearDraft()
      markDirty(false, '✓ 已提交')
      if (res && res.content) {
        ed.mode = 'edit'; ed.path = path; ed.sha = res.content.sha
        $('#editor-file').textContent = path
        $('#btn-delete-post').style.display = ''
      }
      // 本地清单先打补丁，避免"看不到刚改的"
      var src = path.replace(/^source\//, '')
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

  // ==================== 设置 ====================
  function testConnection() {
    $('#gh-status').textContent = '测试中…'
    ghFetch('').then(function (d) {
      if (!d) { $('#gh-status').textContent = '仓库不存在或无权限'; return }
      $('#gh-status').textContent = '连接正常：' + d.full_name + '（默认分支 ' + d.default_branch + '）'
    }).catch(function (e) { $('#gh-status').textContent = '连接失败：' + e.message })
  }

  function clearCredentials() {
    if (!confirm('清除本机保存的 GitHub Token？')) return
    localStorage.removeItem(TOKEN_STORE)
    localStorage.removeItem(CFG_STORE)
    state.gh.token = ''
    $('#gh-token').value = ''
    renderRepoStatus()
    $('#gh-status').textContent = '凭证已清除'
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
    if (name === 'announce') loadAnnouncement()
  }

  // ==================== 启动 ====================
  function boot() {
    loadGhConfig()
    renderRepoStatus()
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
    $('#btn-save-gh').addEventListener('click', saveGhConfig)
    $('#btn-test-gh').addEventListener('click', testConnection)
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
