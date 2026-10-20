// @本地文件检索（M1）——侧边栏 composer 的 @ 浮层 + 文件上下文注入
//
// 设计说明（很重要，改之前先读）：
// 1. sidepanel.js 不允许改动，因此这里通过两处「外挂」接入它：
//    a) composer 的 keydown 用 capture 阶段抢在 sidepanel.js 的 onInputKeydown 之前
//       处理 ↑↓ / Enter / Tab / Esc（sidepanel.js 的监听是 bubble 阶段）；
//    b) patch window.fetch，在它 POST /windowseat/chat 时把文件上下文并入正文
//       （bridge 的 /chat 只读 text/page，attachments 字段会被忽略但不报错），
//       同时仍带上 attachments 字段，方便后续版本使用。
// 2. 上下文 chip：sidepanel.js 的 renderChips() 会整体重写 #ctxRow.innerHTML，
//    因此用 MutationObserver 监听后在末尾重新补上文件 chip。
// 3. 文件内容由 bridge 的 GET /windowseat/files/read 读取（只读、白名单 realpath 校验）。
(() => {
  'use strict'

  /* ============================================================
     常量与元素
     ============================================================ */

  const SEARCH_LIMIT = 8      // 与 bridge 默认 limit 一致
  const DEBOUNCE_MS = 150     // 输入防抖
  const MAX_ATTACHMENTS = 6   // 同时引用的文件数上限
  const MAX_TOTAL_BYTES = 600 * 1024 // 全部附件文本总量上限（bridge 单文件上限 200KB）
  const MAX_TEXT_BYTES = 200 * 1024
  const PANEL_ID = 'wsFilePanel'
  // 版本标记：真机验收脚本用它判断当前 Edge 里加载的是不是最新版 files.js
  // （未打包扩展不会热重载，改了文件必须重开 Edge 或到 edge://extensions 点刷新）。
  const FILES_VERSION = '1.1.0'

  const els = {
    input: document.getElementById('input'),
    ctxRow: document.getElementById('ctxRow'),
    composer: document.getElementById('composer'),
    newBtn: document.getElementById('newBtn'),
    sendBtn: document.getElementById('sendBtn'),
  }
  // 不在侧边栏页面（例如被误注入到别处）就直接退出
  if (!els.input || !els.ctxRow) return

  const HAS_CHROME = typeof chrome !== 'undefined' && Boolean(chrome.runtime && chrome.runtime.id)
  // 暴露版本号，供 e2e 判断扩展是否需要重载
  window.__wsFilesVersion = FILES_VERSION

  /* ============================================================
     状态
     ============================================================ */

  const state = {
    open: false,        // 浮层是否打开
    token: null,        // { query, start, end }：@ 之后的关键词与在输入框中的区间
    results: [],        // 当前搜索结果
    active: 0,          // 键盘高亮下标
    loading: false,     // 是否正在检索
    error: '',          // 检索错误信息
    base: '',           // bridge baseURL 缓存
    seq: 0,             // 检索序号，丢弃过期响应
    lastQuery: null,    // 上一次检索的关键词（避免光标移动重复请求）
    dismissed: null,    // Esc 关闭时的 {start,query}，关键词不变则不重新弹
    attachments: [],    // 已引用的文件 [{name,path,size,kind,text,truncated,reason}]
  }

  let panel = null
  let listEl = null
  let footEl = null
  let debounceTimer = 0
  let blurTimer = 0
  let searching = false

  /* ============================================================
     小工具
     ============================================================ */

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ))
  }

  function formatSize(bytes) {
    const n = Number(bytes) || 0
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    return `${(n / 1024 / 1024).toFixed(1)} MB`
  }

  function iconX() {
    return '<svg class="ic chip-x-ic" aria-hidden="true"><use href="#i-x" /></svg>'
  }

  /* ============================================================
     bridge 连接（先问 background 端口，失败再自己探测）
     ============================================================ */

  function viaBackground(message) {
    return new Promise((resolve) => {
      if (!HAS_CHROME) {
        resolve(null)
        return
      }
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          // eslint-disable-next-line no-unused-expressions
          void chrome.runtime.lastError
          resolve(resp || null)
        })
      } catch {
        resolve(null)
      }
    })
  }

  async function probePort(port) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 900)
    try {
      const res = await fetch(`http://127.0.0.1:${port}/windowseat/health`, { cache: 'no-store', signal: ac.signal })
      if (!res.ok) return ''
      const data = await res.json().catch(() => null)
      return data && data.ok ? `http://127.0.0.1:${port}` : ''
    } catch {
      return ''
    } finally {
      clearTimeout(timer)
    }
  }

  async function resolveBase() {
    if (state.base) return state.base
    const resp = await viaBackground({ type: 'ws/probe' })
    if (resp && resp.ok && resp.status && resp.status.port) {
      state.base = `http://127.0.0.1:${resp.status.port}`
      return state.base
    }
    for (const port of [34281, 34282, 34283]) {
      const base = await probePort(port)
      if (base) {
        state.base = base
        return base
      }
    }
    return ''
  }

  /** 调 bridge 的 JSON 接口；失败抛 Error（message 可直接展示给用户）。 */
  async function bridgeJson(path, init) {
    const base = await resolveBase()
    if (!base) throw new Error('bridge 未连接，请确认 DSH 桌面端在运行')
    const res = await fetch(`${base}${path}`, { cache: 'no-store', ...(init || {}) })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data || data.ok === false) {
      const msg = (data && data.error && data.error.message) || `请求失败（HTTP ${res.status}）`
      // 端口缓存失效时清掉，下次重新探测
      if (!res.ok) state.base = ''
      throw new Error(msg)
    }
    return data
  }

  /* ============================================================
     浮层 UI
     ============================================================ */

  const PANEL_CSS = `
#${PANEL_ID} {
  position: fixed;
  z-index: 2147483000;
  max-height: 300px;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #d9e2f2;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(28, 52, 96, .18), 0 2px 8px rgba(28, 52, 96, .08);
  font-size: 12px;
  color: #26364f;
  overflow: hidden;
}
#${PANEL_ID}[hidden] { display: none; }
#${PANEL_ID} .ws-fp-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 10px; background: #f5f8ff; border-bottom: 1px solid #e7eefb;
  color: #4a5f85; font-size: 11px; line-height: 1.4;
}
#${PANEL_ID} .ws-fp-title { font-weight: 600; }
#${PANEL_ID} .ws-fp-hint { color: #8e9cb5; white-space: nowrap; }
#${PANEL_ID} .ws-fp-list { overflow-y: auto; padding: 4px; min-height: 34px; }
#${PANEL_ID} .ws-fp-item {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 6px 8px; border: 0; border-radius: 8px; background: transparent;
  text-align: left; cursor: pointer; color: inherit; font: inherit;
}
#${PANEL_ID} .ws-fp-item:hover { background: #f2f6ff; }
#${PANEL_ID} .ws-fp-item.is-active { background: #e8f0ff; }
#${PANEL_ID} .ws-fp-ic { flex: none; width: 14px; height: 14px; color: #4d7fe0; }
#${PANEL_ID} .ws-fp-main { min-width: 0; flex: 1; }
#${PANEL_ID} .ws-fp-name {
  display: block; font-weight: 600; font-size: 12px; color: #1f2f4b;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#${PANEL_ID} .ws-fp-name em { font-style: normal; background: #ffe9a8; border-radius: 3px; }
#${PANEL_ID} .ws-fp-dir {
  display: block; color: #8e9cb5; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
#${PANEL_ID} .ws-fp-size { flex: none; color: #8e9cb5; font-size: 11px; }
#${PANEL_ID} .ws-fp-empty { padding: 10px 12px 12px; color: #8e9cb5; line-height: 1.6; }
#${PANEL_ID} .ws-fp-empty b { color: #4a5f85; font-weight: 600; }
#${PANEL_ID} .ws-fp-foot {
  border-top: 1px solid #eef3fc; padding: 5px 10px; color: #93a1b8; font-size: 11px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
`

  function injectStyle() {
    const style = document.createElement('style')
    style.id = 'wsFilePanelStyle'
    style.textContent = PANEL_CSS
    document.head.appendChild(style)
  }

  function ensurePanel() {
    if (panel) return panel
    injectStyle()
    panel = document.createElement('div')
    panel.id = PANEL_ID
    panel.hidden = true
    panel.setAttribute('role', 'listbox')
    panel.setAttribute('aria-label', '本地文件检索结果')
    panel.innerHTML = [
      '<div class="ws-fp-head"><span class="ws-fp-title">@ 本地文件</span>',
      '<span class="ws-fp-hint">↑↓ 选择 · Enter 引用 · Esc 关闭</span></div>',
      '<div class="ws-fp-list" role="presentation"></div>',
      '<div class="ws-fp-foot"></div>',
    ].join('')
    listEl = panel.querySelector('.ws-fp-list')
    footEl = panel.querySelector('.ws-fp-foot')
    // 点击浮层时不要让输入框失焦（否则 blur 会先关闭浮层）
    panel.addEventListener('mousedown', (e) => { e.preventDefault() })
    document.body.appendChild(panel)
    return panel
  }

  /** 浮层贴着 composer 上沿显示（侧边栏可能被拉伸，所以用 fixed + 实时位置）。 */
  function positionPanel() {
    if (!panel || panel.hidden) return
    const rect = els.input.getBoundingClientRect()
    const maxWidth = Math.max(180, rect.width)
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - maxWidth - 8))
    panel.style.left = `${left}px`
    panel.style.width = `${Math.min(maxWidth, window.innerWidth - 16)}px`
    panel.style.top = 'auto'
    panel.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`
  }

  function highlightMatch(name, query) {
    const safeName = esc(name)
    const tokens = String(query || '').split(/\s+/).filter(Boolean)
    if (!tokens.length) return safeName
    let out = safeName
    for (const token of tokens) {
      const re = new RegExp(`(${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
      out = out.replace(re, '<em>$1</em>')
    }
    return out
  }

  function renderList() {
    if (!panel || panel.hidden) return
    const query = state.token ? state.token.query : ''
    if (state.loading && state.results.length === 0) {
      listEl.innerHTML = '<div class="ws-fp-empty">检索中…</div>'
      footEl.textContent = '正在本机白名单目录内查找'
      return
    }
    if (state.error) {
      listEl.innerHTML = `<div class="ws-fp-empty"><b>检索失败</b><br>${esc(state.error)}</div>`
      footEl.textContent = '可以重新输入关键词重试'
      return
    }
    if (!state.results.length) {
      listEl.innerHTML = '<div class="ws-fp-empty"><b>没找到</b>，试试文件名/路径关键词<br>例如 @scheduler、@windowseat-demo</div>'
      footEl.textContent = '只在这些目录里找：Documents、F:\\work'
      return
    }
    listEl.innerHTML = state.results.map((item, index) => {
      const active = index === state.active ? ' is-active' : ''
      const dir = String(item.dir || '').replace(/\\/g, ' / ')
      return `<button type="button" role="option" aria-selected="${index === state.active}" data-index="${index}" class="ws-fp-item${active}">` +
        '<svg class="ic ws-fp-ic" aria-hidden="true"><use href="#i-page" /></svg>' +
        `<span class="ws-fp-main"><span class="ws-fp-name">${highlightMatch(item.name, query)}</span>` +
        `<span class="ws-fp-dir">${esc(dir)}</span></span>` +
        `<span class="ws-fp-size">${formatSize(item.size)}</span></button>`
    }).join('')
    footEl.textContent = `${state.results.length} 个文件 · 只读引用，内容不会上传`
    const activeEl = listEl.querySelector('.ws-fp-item.is-active')
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
  }

  function openPanel() {
    ensurePanel()
    if (state.open) return
    state.open = true
    panel.hidden = false
    positionPanel()
  }

  function closePanel() {
    if (!state.open) return
    state.open = false
    clearTimeout(debounceTimer)
    state.seq += 1 // 丢弃在途响应
    if (panel) panel.hidden = true
  }

  /* ============================================================
     检索（防抖 150ms，丢弃过期响应）
     ============================================================ */

  async function runSearch(query) {
    const seq = ++state.seq
    state.loading = true
    state.error = ''
    if (state.open) renderList()
    try {
      const data = await bridgeJson(`/windowseat/files/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`)
      if (seq !== state.seq || !state.open) return
      state.results = data.results || []
      state.active = 0
      state.loading = false
      renderList()
    } catch (err) {
      if (seq !== state.seq || !state.open) return
      state.results = []
      state.loading = false
      state.error = (err && err.message) || String(err)
      renderList()
    }
  }

  function scheduleSearch(query) {
    clearTimeout(debounceTimer)
    state.loading = true
    if (state.open) renderList()
    debounceTimer = setTimeout(() => { void runSearch(query) }, DEBOUNCE_MS)
  }

  /* ============================================================
     输入框里 @ 的识别
     ============================================================ */

  /** 取光标前最后一个 `@` 关键词；不在 @ 语境时返回 null。 */
  function currentToken() {
    if (els.input.selectionStart !== els.input.selectionEnd) return null // 有选区时不触发
    const value = els.input.value
    const caret = els.input.selectionStart
    if (caret == null || caret < 0) return null
    const before = value.slice(0, caret)
    const match = /(?:^|[\s\n])@([^\s@]{0,64})$/.exec(before)
    if (!match) return null
    const query = match[1]
    return { query, start: caret - query.length - 1, end: caret }
  }

  function syncTokenFromInput(immediate) {
    const token = currentToken()
    state.token = token
    if (!token) {
      closePanel()
      return
    }
    // Esc 主动关掉浮层后，光标在同一条 @ 里挪动不应重新弹出；关键词变了才恢复
    if (state.dismissed && state.dismissed.start === token.start && state.dismissed.query === token.query) {
      closePanel()
      return
    }
    state.dismissed = null
    openPanel()
    positionPanel()
    // @ 之后关键词变化才重新检索；同一关键词（光标移动）不重复请求
    if (immediate) {
      scheduleSearch(token.query)
      return
    }
    const lastQuery = state.lastQuery
    if (lastQuery === token.query) return
    state.lastQuery = token.query
    scheduleSearch(token.query)
  }

  /* ============================================================
     选择文件 → 插入 @文件名 + 读取内容 + 生成 chip
     ============================================================ */

  function existingAttachment(path) {
    return state.attachments.find((item) => item.path === path) || null
  }

  function totalAttachmentBytes() {
    return state.attachments.reduce((sum, item) => sum + (item.text ? item.text.length : 0), 0)
  }

  function addAttachment(file) {
    const att = {
      name: file.name,
      path: file.path,
      size: Number(file.size) || 0,
      kind: file.kind || 'metadata',
      text: file.kind === 'text' && typeof file.text === 'string' ? file.text.slice(0, MAX_TEXT_BYTES) : null,
      truncated: Boolean(file.truncated),
      reason: file.reason || '',
    }
    const previous = existingAttachment(att.path)
    if (previous) state.attachments = state.attachments.filter((item) => item.path !== att.path)
    state.attachments.push(att)
    // 超量：优先丢掉最旧的附件，保证请求体不会无限大
    while (state.attachments.length > MAX_ATTACHMENTS) state.attachments.shift()
    while (state.attachments.length > 1 && totalAttachmentBytes() > MAX_TOTAL_BYTES) state.attachments.shift()
    syncFileChips()
  }

  function removeAttachment(path) {
    state.attachments = state.attachments.filter((item) => item.path !== path)
    syncFileChips()
  }

  async function chooseFile(item) {
    if (!item) return
    const token = state.token
    if (!token) return
    closePanel()
    // 1) 输入框里把 `@关键词` 替换成 `@文件名 `
    const value = els.input.value
    const insert = `@${item.name} `
    const next = value.slice(0, token.start) + insert + value.slice(token.end)
    els.input.value = next
    const pos = token.start + insert.length
    els.input.setSelectionRange(pos, pos)
    els.input.focus()
    els.input.dispatchEvent(new Event('input', { bubbles: true })) // 让 sidepanel.js 重新 autoGrow
    state.lastQuery = null
    state.dismissed = null
    // 2) 读文件内容（read 失败也把元信息挂上，发送时说明读不到正文）
    try {
      const data = await bridgeJson(`/windowseat/files/read?path=${encodeURIComponent(item.path)}`)
      addAttachment(data.file || item)
    } catch (err) {
      addAttachment({ ...item, kind: 'metadata', reason: `读取失败：${(err && err.message) || err}` })
    }
  }

  /* ============================================================
     上下文 chip（与 sidepanel.js 的 renderChips 共存）
     ============================================================ */

  function buildFileChip(att) {
    const chip = document.createElement('span')
    chip.className = 'chip ws-file-chip'
    chip.dataset.wsFile = att.path
    const label = `文件 · ${att.name}`
    chip.innerHTML = '<svg class="ic chip-ic" aria-hidden="true"><use href="#i-page" /></svg>' +
      `<span class="chip-txt"></span>` +
      `<button class="chip-x" type="button" title="移除文件上下文">${iconX()}</button>`
    const textEl = chip.querySelector('.chip-txt')
    textEl.textContent = label
    textEl.title = att.kind === 'text' ? `${att.path}\n${formatSize(att.size)}（文本，发送时自动带上内容）` : `${att.path}\n${formatSize(att.size)}（${att.reason || '非文本文件，仅元信息'}）`
    chip.querySelector('.chip-x').addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation() // 阻止冒泡到 sidepanel.js 的 ctxRow 委托
      removeAttachment(att.path)
    })
    return chip
  }

  let syncingChips = false
  let syncScheduled = false

  /** 把文件 chip 补到 #ctxRow 末尾；只增删文件 chip，不动页面/选区 chip。 */
  function syncFileChips() {
    if (syncingChips) return
    syncingChips = true
    try {
      const row = els.ctxRow
      const paths = new Set(state.attachments.map((item) => item.path))
      for (const node of Array.from(row.querySelectorAll('[data-ws-file]'))) {
        if (!paths.has(node.dataset.wsFile)) node.remove()
      }
      if (state.attachments.length > 0) {
        row.hidden = false
        for (const att of state.attachments) {
          if (!row.querySelector(`[data-ws-file="${cssAttr(att.path)}"]`)) row.appendChild(buildFileChip(att))
        }
      } else if (!row.children.length) {
        row.hidden = true
      }
    } finally {
      syncingChips = false
    }
  }

  function cssAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  }

  function scheduleChipSync() {
    if (syncScheduled) return
    syncScheduled = true
    queueMicrotask(() => {
      syncScheduled = false
      syncFileChips()
    })
  }

  function observeChips() {
    const observer = new MutationObserver(() => {
      if (syncingChips) return
      scheduleChipSync()
    })
    observer.observe(els.ctxRow, { childList: true })
  }

  /* ============================================================
     发送钩子：把文件上下文并入 /windowseat/chat 的正文
     ============================================================ */

  function composeAttachmentText(text, attachments) {
    const blocks = attachments.map((att, index) => {
      const head = `文件 ${index + 1}：${att.name}\n路径：${att.path}\n大小：${formatSize(att.size)}`
      if (att.kind === 'text' && att.text) {
        return `${head}${att.truncated ? '（内容超长，已截断）' : ''}\n--- 文件内容开始 ---\n${att.text}\n--- 文件内容结束 ---`
      }
      return `${head}\n（${att.reason || '二进制或非文本文件，仅提供元信息，无法读取正文'}）`
    })
    return [
      '【本地文件上下文（用户本机只读文件，由 @ 引用）】',
      blocks.join('\n\n'),
      '',
      '【用户问题】',
      text,
    ].join('\n')
  }

  function toWireAttachment(att) {
    return {
      path: att.path,
      name: att.name,
      size: att.size,
      kind: att.kind,
      mtimeIso: att.mtimeIso || null,
      truncated: Boolean(att.truncated),
      text: att.kind === 'text' && att.text ? att.text.slice(0, MAX_TEXT_BYTES) : null,
    }
  }

  let fetchPatched = false
  function installSendHook() {
    if (fetchPatched) return
    fetchPatched = true
    const originalFetch = window.fetch.bind(window)
    window.fetch = function windowseatPatchedFetch(input, init) {
      let nextInit = init
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        const isChat = /\/windowseat\/chat(?:\?|$)/.test(String(url))
        if (isChat && state.attachments.length > 0 && init && typeof init.body === 'string') {
          const payload = JSON.parse(init.body)
          if (payload && typeof payload.text === 'string') {
            payload.text = composeAttachmentText(payload.text, state.attachments)
            payload.attachments = state.attachments.map(toWireAttachment)
            nextInit = { ...init, body: JSON.stringify(payload) }
          }
        }
      } catch (err) {
        console.warn('[windowseat] 文件上下文注入失败：', err)
      }
      return originalFetch(input, nextInit)
    }
  }

  /* ============================================================
     事件绑定
     ============================================================ */

  function moveActive(delta) {
    if (!state.results.length) return
    state.active = (state.active + delta + state.results.length) % state.results.length
    renderList()
  }

  function onInputKeyDown(e) {
    // 绑在 window capture 阶段：必须比 sidepanel.js 在 input 上的 Enter 发送监听更早，
    // 只在自己的浮层打开且焦点在输入框时接管按键
    if (e.target !== els.input) return
    if (!state.open) return
    if (e.isComposing || e.keyCode === 229) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      state.dismissed = state.token ? { start: state.token.start, query: state.token.query } : null
      closePanel()
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      moveActive(e.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (e.shiftKey && e.key === 'Enter') return // Shift+Enter 保留换行
      e.preventDefault()
      e.stopPropagation()
      void chooseFile(state.results[state.active])
    }
  }

  function onInputChanged() {
    if (blurTimer) {
      clearTimeout(blurTimer)
      blurTimer = 0
    }
    syncTokenFromInput(false)
  }

  function onCaretMoved() {
    if (!state.open) return
    syncTokenFromInput(false)
  }

  function onInputBlur() {
    if (!state.open) return
    blurTimer = setTimeout(() => closePanel(), 120)
  }

  function onPanelClick(e) {
    const itemEl = e.target.closest('.ws-fp-item')
    if (!itemEl) return
    const index = Number(itemEl.dataset.index)
    const item = state.results[index]
    if (item) void chooseFile(item)
  }

  function bindEvents() {
    // 绑在 window 的 capture 阶段：必须抢在 sidepanel.js 的 Enter 发送监听之前，
    // 否则 Enter 会先把消息发出去（同节点上的 bubble 监听无法被 stopPropagation 拦住）
    window.addEventListener('keydown', onInputKeyDown, true)
    els.input.addEventListener('input', onInputChanged)
    els.input.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape'].includes(e.key)) return
      onCaretMoved()
    })
    els.input.addEventListener('click', onCaretMoved)
    els.input.addEventListener('focus', () => {
      if (state.token && !state.open) {
        openPanel()
        renderList()
      }
    })
    els.input.addEventListener('blur', onInputBlur)
    els.composer?.addEventListener('click', () => {
      // 点 composer 空白处时把焦点交还输入框（保持 @ 浮层的锚点位置）
      if (state.open) positionPanel()
    })
    const p = ensurePanel()
    p.addEventListener('click', onPanelClick)
    window.addEventListener('resize', () => { if (state.open) positionPanel() })
    document.addEventListener('scroll', () => { if (state.open) positionPanel() }, true)
    // 「新对话」会清空 sidepanel 的上下文，文件引用也一起清掉
    els.newBtn?.addEventListener('click', () => {
      state.attachments = []
      syncFileChips()
    }, true)
  }

  /* ============================================================
     启动
     ============================================================ */

  function start() {
    ensurePanel()
    observeChips()
    installSendHook()
    bindEvents()
    console.info('[windowseat] @本地文件检索已就绪')
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true })
  else start()
})()
