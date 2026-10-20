/* 临窗 Windowseat · side panel
 * - 探测本机 DSH 桥（background 负责端口 34281→34283）
 * - 通过 /windowseat/session 取会话、/windowseat/chat 流式对话（SSE）
 * - 支持 停止 / 重试 / 复制、上下文 chips、恢复上次会话、未连接三步引导
 * - 线路 A：历史会话抽屉（/windowseat/sessions*）、页面上下文自动刷新、断连重连提示
 * - sidepanel.html?mock=1 时使用内置假数据（无需 chrome API，便于截图与调试）
 */

(() => {
  'use strict';

  /** 历史会话 / 页面刷新这一批的版本号：e2e 用它判断 Edge 里加载的是否旧版扩展。 */
  const HISTORY_VERSION = '1.1.0';
  window.__wsHistoryVersion = HISTORY_VERSION;

  const params = new URLSearchParams(location.search);
  const HAS_CHROME = typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id);
  const MOCK = params.get('mock') === '1' || !HAS_CHROME;
  const SCENARIO = params.get('scenario') || 'chat';
  // 调试用：sidepanel.html?port=34282 强制指定桥端口（不影响正常探测逻辑）
  const FORCE_PORT = (() => {
    const raw = Number(params.get('port'));
    return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : null;
  })();

  const $ = (sel, root) => (root || document).querySelector(sel);

  const els = {
    app: $('#app'),
    status: $('#status'),
    statusDot: $('#statusDot'),
    statusText: $('#statusText'),
    histBtn: $('#histBtn'),
    newBtn: $('#newBtn'),
    ctxRow: $('#ctxRow'),
    restoreBar: $('#restoreBar'),
    restoreText: $('#restoreText'),
    restoreContinue: $('#restoreContinue'),
    restoreClear: $('#restoreClear'),
    connBanner: $('#connBanner'),
    connText: $('#connText'),
    connRetry: $('#connRetry'),
    scroll: $('#scroll'),
    thread: $('#thread'),
    empty: $('#empty'),
    composer: $('#composer'),
    input: $('#input'),
    sendBtn: $('#sendBtn'),
    histMask: $('#histMask'),
    histDrawer: $('#histDrawer'),
    histClose: $('#histClose'),
    histSearch: $('#histSearch'),
    histList: $('#histList'),
    histEmpty: $('#histEmpty'),
    histFoot: $('#histFoot'),
    histCount: $('#histCount'),
    shots: $('#shots'),
    shotBtn: $('#shotBtn'),
    teamDock: $('#teamDock'),
    teamToggle: $('#teamToggle'),
    teamSum: $('#teamSum'),
    teamBody: $('#teamBody'),
    setBtn: $('#setBtn'),
    setMask: $('#setMask'),
    setDrawer: $('#setDrawer'),
    setClose: $('#setClose'),
    setEfforts: $('#setEfforts'),
    setEffortNote: $('#setEffortNote'),
    setDirs: $('#setDirs'),
    setDirInput: $('#setDirInput'),
    setDirAdd: $('#setDirAdd'),
    setVersion: $('#setVersion'),
  };

  const STATUS_TEXT = {
    connecting: '连接中…',
    connected: '已连接',
    disconnected: '未连接',
  };

  const ACTION_PROMPTS = {
    explain: '请解释选中的这段内容，说清楚它在讲什么。',
    translate: '请把选中的这段内容翻译成中文；如果原文就是中文，请翻译成英文。',
    summarize: '请总结选中的这段内容，给出要点。',
    ask: '',
    save: '',
  };

  const STORE = {
    messages: 'wsMessages',
    session: 'wsSessionId',
    sessionTitle: 'wsSessionTitle',
    page: 'wsContextPage',
    selections: 'wsSelections',
  };

  const MAX_MESSAGES = 40;

  // 断连后的自动重试：最多 5 次，间隔逐渐拉长
  const RECONNECT_MAX = 5;
  const RECONNECT_BASE_MS = 1200;

  const state = {
    mock: MOCK,
    connected: false,
    connecting: true,
    port: null,
    sessionId: null,
    // 当前会话的元数据（切换历史会话 / 继续会话时用于空态展示；正文不在本地桥保存）
    currentSession: null,
    messages: [],
    context: { page: null, selections: [] },
    // 待发送的截图（最多 4 张，发送后清空）
    shots: [],
    // 用户手动 × 掉的页面 chip：同一 URL 在本次会话内不再自动加回
    pageDismissedUrl: null,
    streaming: false,
    stopping: false,
    abort: null,
    lastPrompt: null,
    restored: false,
    seenContext: new Set(),
    // 协同小队（只读投影：成员 + 共享任务板）
    team: {
      open: false,
      loading: false,
      data: null,
      timer: null,
    },
    // 设置抽屉状态（思考强度 / 本地文件白名单）
    settings: { open: false, effort: '', loading: false, dirs: [] },
    // 断连重连状态
    connAttempt: 0,
    connTimer: null,
    // 历史会话抽屉状态
    history: {
      open: false,
      loading: false,
      items: [],
      total: 0,
      query: '',
      before: null,
      nextBefore: null,
      hasMore: false,
      seq: 0,
      renameId: null,
      confirmId: null,
      confirmTimer: null,
      searchTimer: null,
    },
  };

  let activeBotId = null;
  let streamRaf = null;
  let persistTimer = null;
  let restoreTimer = null;
  let statusTimer = null;
  let pinToBottom = true;
  let mockAborted = false;

  /* ============================================================
     工具
     ============================================================ */

  function uid(prefix) {
    return `${prefix || 'id'}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => {
      switch (c) {
        case '&':
          return '&amp;';
        case '<':
          return '&lt;';
        case '>':
          return '&gt;';
        case '"':
          return '&quot;';
        default:
          return '&#39;';
      }
    });
  }

  function fmtTime(ts) {
    const d = ts ? new Date(ts) : new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  function hostOf(url) {
    try {
      return new URL(url).host || url;
    } catch (e) {
      return String(url || '').replace(/^https?:\/\//, '').split('/')[0] || '当前页面';
    }
  }

  function pageLabel(page) {
    if (!page) return '当前页面';
    return page.title || hostOf(page.url);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function icon(id) {
    return `<svg class="ic"><use href="#${id}" /></svg>`;
  }

  /* ============================================================
     持久化（chrome.storage.local）
     ============================================================ */

  function schedulePersist() {
    if (MOCK || !HAS_CHROME) return;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 280);
  }

  async function persist() {
    if (MOCK || !HAS_CHROME) return;
    try {
      await chrome.storage.local.set({
        [STORE.messages]: state.messages.slice(-MAX_MESSAGES).map((m) => ({
          id: m.id,
          role: m.role,
          text: m.text,
          time: m.time,
          status: m.status,
          error: m.error || '',
          page: m.page || null,
          selections: m.selections || [],
          request: m.request || null,
        })),
        [STORE.session]: state.sessionId,
        // 当前会话标题（历史会话切换后，恢复时仍能在空态里显示「继续这个会话」）
        [STORE.sessionTitle]: state.currentSession ? state.currentSession.title : null,
        [STORE.page]: state.context.page,
        [STORE.selections]: state.context.selections.slice(0, 3),
      });
    } catch (e) {
      /* ignore */
    }
  }

  async function restorePersisted() {
    if (MOCK || !HAS_CHROME) return;
    try {
      const got = await chrome.storage.local.get([
        STORE.messages,
        STORE.session,
        STORE.sessionTitle,
        STORE.page,
        STORE.selections,
      ]);
      const messages = got[STORE.messages];
      if (Array.isArray(messages) && messages.length) {
        state.messages = messages.slice(-MAX_MESSAGES).map((m) => ({
          ...m,
          // 上次没跑完的流，恢复后视为已停止
          status: m.status === 'streaming' ? 'stopped' : m.status || 'ok',
        }));
        state.restored = true;
      }
      if (typeof got[STORE.session] === 'string' && got[STORE.session]) {
        state.sessionId = got[STORE.session];
      }
      if (state.sessionId && typeof got[STORE.sessionTitle] === 'string' && got[STORE.sessionTitle]) {
        state.currentSession = { sessionId: state.sessionId, title: got[STORE.sessionTitle] };
      }
      if (got[STORE.page] && typeof got[STORE.page] === 'object') {
        state.context.page = normalizePage(got[STORE.page]);
      }
      if (Array.isArray(got[STORE.selections])) {
        state.context.selections = got[STORE.selections].slice(0, 3);
      }
    } catch (e) {
      /* ignore */
    }
  }

  async function clearPersistedSession() {
    if (MOCK || !HAS_CHROME) return;
    try {
      await chrome.storage.local.remove([
        STORE.messages,
        STORE.session,
        STORE.sessionTitle,
        STORE.selections,
      ]);
    } catch (e) {
      /* ignore */
    }
  }

  function normalizePage(page) {
    if (!page || typeof page !== 'object') return null;
    return {
      title: String(page.title || ''),
      url: String(page.url || ''),
      description: String(page.description || ''),
      // 页面正文摘录：供「总结此页」等动作直接阅读，避免模型改用工具抓取
      text: String(page.text || '').slice(0, 8000),
    };
  }

  /* ============================================================
     与 background 通信
     ============================================================ */

  function sendToBackground(message) {
    return new Promise((resolve) => {
      if (!HAS_CHROME || MOCK) return resolve(null);
      try {
        chrome.runtime.sendMessage(message, (resp) => {
          // 读取 lastError，避免控制台出现 unchecked runtime.lastError
          void chrome.runtime.lastError;
          resolve(resp || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* ============================================================
     截图提问（0.3.0）
     ============================================================ */

  let toastTimer = null;

  function toast(message) {
    let el = $('.ws-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'ws-toast';
      els.app.appendChild(el);
    }
    el.textContent = String(message || '');
    requestAnimationFrame(() => el.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function splitDataUrl(dataUrl) {
    const match = /^data:(image\/[a-z+]+);base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!match) return null;
    return { mediaType: match[1], data: match[2] };
  }

  async function onShotButton() {
    if (state.streaming || state.shotBusy) return;
    if (MOCK || !HAS_CHROME) {
      toast('演示模式不支持截图');
      return;
    }
    state.shotBusy = true;
    els.shotBtn.classList.add('busy');
    els.shotBtn.disabled = true;
    try {
      const resp = await sendToBackground({ type: 'ws/capture' });
      if (!resp || !resp.ok || !resp.dataUrl) {
        const detail = resp && resp.error && resp.error.message ? resp.error.message : '';
        toast(detail ? `截图失败：${detail}` : '截图失败，请确认当前是普通网页（而非 edge:// 页面）');
        return;
      }
      const media = splitDataUrl(resp.dataUrl);
      if (!media) {
        toast('截图格式无法识别');
        return;
      }
      if (state.shots.length >= 4) {
        toast('最多附 4 张截图，先移除一张再截');
        return;
      }
      state.shots.push({
        id: `shot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        dataUrl: resp.dataUrl,
        mediaType: media.mediaType,
        data: media.data,
        name: (resp.tab && resp.tab.title ? String(resp.tab.title).slice(0, 40) : '当前页面截图') + '.jpg',
        tab: resp.tab || null,
      });
      renderShots();
      focusInput();
    } finally {
      state.shotBusy = false;
      els.shotBtn.classList.remove('busy');
      els.shotBtn.disabled = false;
    }
  }

  function renderShots() {
    if (!els.shots) return;
    els.shots.hidden = state.shots.length === 0;
    els.shots.textContent = '';
    for (const shot of state.shots) {
      const item = document.createElement('div');
      item.className = 'shot';
      item.dataset.id = shot.id;
      const img = document.createElement('img');
      img.src = shot.dataUrl;
      img.alt = '待发送截图';
      const tag = document.createElement('span');
      tag.className = 'shot-tag';
      tag.textContent = '截图';
      const del = document.createElement('button');
      del.className = 'shot-x';
      del.type = 'button';
      del.title = '移除截图';
      del.setAttribute('aria-label', '移除截图');
      del.textContent = '×';
      del.addEventListener('click', () => {
        state.shots = state.shots.filter((s) => s.id !== shot.id);
        renderShots();
      });
      item.append(img, tag, del);
      els.shots.appendChild(item);
    }
  }

  function clearShots() {
    state.shots = [];
    renderShots();
  }

  async function directProbe() {
    const ports = FORCE_PORT ? [FORCE_PORT] : [34281, 34282, 34283];
    for (const port of ports) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 900);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/windowseat/health`, {
          cache: 'no-store',
          signal: ac.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (data && data.ok) return { connected: true, port };
        }
      } catch (e) {
        /* try next */
      } finally {
        clearTimeout(timer);
      }
    }
    return { connected: false, port: null };
  }

  async function refreshStatus(force) {
    if (FORCE_PORT && !MOCK) {
      applyStatus({ connected: true, port: FORCE_PORT });
      return;
    }
    if (MOCK) {
      applyStatus({ connected: state.connected, port: state.port || 34281 });
      return;
    }
    const resp = await sendToBackground({ type: 'ws/probe', force: !!force });
    if (resp && resp.ok && resp.status) {
      applyStatus(resp.status);
      return;
    }
    // background 没响应时面板自己探测（扩展页有 host_permissions，可直接请求 loopback）
    const status = await directProbe();
    applyStatus(status);
  }

  function applyStatus(status) {
    if (!status) return;
    const was = state.connected;
    state.connecting = false;
    state.connected = !!status.connected;
    state.port = status.port || null;
    renderStatus();
    if (state.connected) {
      // 连上了：清空重试计数、收起断连提示
      state.connAttempt = 0;
      clearReconnectTimer();
      updateConnBanner();
    }
    if (state.connected && !was) onConnected();
    if (!state.connected && was) onDisconnected();
    if (!state.messages.length) renderEmpty();
    // 断连（或本就没连上）时安排自动重连；正在生成时等请求自己失败回来再排
    if (!state.connected && !state.streaming) scheduleReconnect();
  }

  /* ============================================================
     断连提示条 + 自动重连（线路 A）
     ============================================================ */

  function clearReconnectTimer() {
    if (state.connTimer) {
      clearTimeout(state.connTimer);
      state.connTimer = null;
    }
  }

  function updateConnBanner() {
    if (!els.connBanner) return;
    if (state.connected || state.connecting) {
      els.connBanner.hidden = true;
      return;
    }
    els.connBanner.hidden = false;
    if (state.connAttempt > 0 && state.connAttempt <= RECONNECT_MAX) {
      els.connText.textContent = `本地 DSH 桥未连接 · 正在重试（${state.connAttempt}/${RECONNECT_MAX}）…`;
      els.connRetry.textContent = '立即重试';
    } else if (state.connAttempt > RECONNECT_MAX) {
      els.connText.textContent = '本地 DSH 桥未连接 · 自动重试已停止，请检查 DSH 是否在运行';
      els.connRetry.textContent = '重新连接';
    } else {
      els.connText.textContent = '本地 DSH 桥未连接 · 正在重试…';
      els.connRetry.textContent = '立即重试';
    }
    els.connRetry.disabled = false;
  }

  function scheduleReconnect() {
    if (MOCK || FORCE_PORT) return;
    clearReconnectTimer();
    if (state.connAttempt >= RECONNECT_MAX) {
      updateConnBanner();
      return;
    }
    const delay = RECONNECT_BASE_MS * Math.pow(1.6, state.connAttempt);
    state.connTimer = setTimeout(async () => {
      state.connTimer = null;
      if (state.connected) return;
      state.connAttempt += 1;
      updateConnBanner();
      await refreshStatus(true);
      // 成功时 applyStatus 会清零；失败时 applyStatus 会继续排下一次
    }, delay);
  }

  async function retryConnect() {
    clearReconnectTimer();
    state.connAttempt = 0;
    state.connecting = true;
    renderStatus();
    updateConnBanner();
    els.connRetry.disabled = true;
    await refreshStatus(true);
    els.connRetry.disabled = false;
    if (!state.connected) {
      state.connAttempt = 1;
      updateConnBanner();
      scheduleReconnect();
    }
  }

  function renderStatus() {
    els.status.classList.remove('is-on', 'is-off');
    if (state.connecting) {
      els.statusText.textContent = STATUS_TEXT.connecting;
      els.status.title = '正在探测本机 DSH';
      return;
    }
    if (state.connected) {
      els.status.classList.add('is-on');
      els.statusText.textContent = STATUS_TEXT.connected;
      els.status.title = `已连接本机 DSH${state.port ? ` · 127.0.0.1:${state.port}` : ''}`;
    } else {
      els.status.classList.add('is-off');
      els.statusText.textContent = STATUS_TEXT.disconnected;
      els.status.title = '未连接，请先启动 DSH';
    }
  }

  async function onConnected() {
    if (!MOCK) {
      await fetchPageContext();
      await takePending();
    }
    renderEmpty();
    renderChips();
  }

  function onDisconnected() {
    if (state.streaming) {
      /* 正在生成的请求会在 fetch 失败时自行收尾 */
    }
  }

  async function fetchPageContext() {
    if (MOCK) {
      state.context.page = normalizePage(MOCK_PAGE);
      renderChips();
      return;
    }
    const resp = await sendToBackground({ type: 'ws/page-context' });
    const page = resp && resp.ok ? normalizePage(resp.page) : null;
    // 拿不到有效页面信息时（例如侧栏焦点窗格），不要覆盖已知上下文
    if (page && (page.title || page.url) && !/^chrome-extension:\/\//i.test(page.url)) {
      // 用户手动 × 掉的页面，本次会话内不再自动加回
      if (state.pageDismissedUrl && page.url && page.url === state.pageDismissedUrl) return;
      state.context.page = page;
      renderChips();
      schedulePersist();
    }
  }

  async function takePending() {
    if (MOCK) return;
    const resp = await sendToBackground({ type: 'ws/take-pending' });
    if (resp && resp.ok && Array.isArray(resp.items)) {
      resp.items.forEach(consumeContextItem);
    }
  }

  function consumeContextItem(item) {
    if (!item || typeof item !== 'object') return;
    const id = item.id || uid('ctx');
    if (state.seenContext.has(id)) return;
    state.seenContext.add(id);

    const page = item.page || {};
    if (page.title || page.url) {
      state.context.page = normalizePage({
        title: page.title,
        url: page.url,
        description: page.description,
      });
    }
    const text = String(page.selection || page.text || '').replace(/\s+/g, ' ').trim();
    if (text) addSelection(text, page);
    renderChips();
    schedulePersist();

    const prompt = ACTION_PROMPTS[item.action] || '';
    if (prompt) {
      if (state.connected && !state.streaming) {
        if (state.messages.length || state.context.selections.length) {
          els.scroll.scrollTop = 0;
        }
        sendPrompt(prompt);
      } else {
        els.input.value = prompt;
        autoGrow();
        focusInput();
      }
    } else {
      focusInput();
    }
  }

  /* ============================================================
     上下文 chips
     ============================================================ */

  function addSelection(text, page) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (state.context.selections.some((s) => s.text === clean)) return;
    state.context.selections.push({
      id: uid('sel'),
      text: clean,
      title: (page && page.title) || '',
      url: (page && page.url) || '',
    });
    while (state.context.selections.length > 3) state.context.selections.shift();
  }

  function renderChips() {
    const chips = [];
    const page = state.context.page;
    if (page && (page.title || page.url)) {
      chips.push(
        `<span class="chip">${icon('i-page')}` +
          `<span class="chip-txt" title="${esc(page.title || page.url)}">${esc(
            page.title || hostOf(page.url),
          )}</span>` +
          `<button class="chip-x" type="button" data-remove="page" title="移除页面上下文" aria-label="移除页面上下文">${icon(
            'i-x',
          )}</button></span>`,
      );
    }
    if (state.context.selections.length) {
      chips.push(
        `<span class="chip">${icon('i-text')}选中 <b class="chip-num">${
          state.context.selections.length
        }</b> 处` +
          `<button class="chip-x" type="button" data-remove="selections" title="移除选中文本" aria-label="移除选中文本">${icon(
            'i-x',
          )}</button></span>`,
      );
    }
    els.ctxRow.innerHTML = chips.join('');
    els.ctxRow.hidden = chips.length === 0;
  }

  function removeContext(kind) {
    if (kind === 'page') {
      // 记住被手动移除的页面：同一 URL 本次会话内不再自动加回
      state.pageDismissedUrl = (state.context.page && state.context.page.url) || state.pageDismissedUrl;
      state.context.page = null;
    } else if (kind === 'selections') {
      state.context.selections = [];
    }
    renderChips();
    schedulePersist();
  }

  /* ============================================================
     空状态
     ============================================================ */

  /** 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / 日期 */
  function fmtRel(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return '';
    const diff = Date.now() - t;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    if (diff < 2 * 24 * 60 * 60 * 1000) return '昨天';
    if (diff < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(diff / 86400000)} 天前`;
    const d = new Date(t);
    return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  }

  /** 切换到一个没有正文的旧会话时显示的空态：说明可以继续聊 */
  function sessionIntroHTML(cs) {
    const title = (cs && cs.title) || '（无标题）';
    const meta = [];
    if (cs && cs.updatedAt) meta.push(fmtRel(cs.updatedAt));
    if (cs && cs.messageCount) meta.push(`${cs.messageCount} 条消息`);
    return `
      <div class="session-intro">
        <img class="hero-mark" src="assets/brand-mark.svg" alt="" width="40" height="40" />
        <span class="si-badge">继续这个会话</span>
        <h2 class="si-title" title="${esc(title)}">${esc(title)}</h2>
        ${meta.length ? `<p class="si-meta">${esc(meta.join(' · '))}</p>` : ''}
        <p class="si-note">本机桥只保存会话标题与时间，不保存历史正文。直接提问即可接着这个会话继续聊。</p>
        <div class="si-actions">
          <button class="primary-btn" type="button" data-si="continue">${icon('i-send')}继续提问</button>
          <button class="mini-btn" type="button" data-si="new">开新对话</button>
        </div>
      </div>`;
  }

  function welcomeHTML() {
    return `
      <div class="welcome">
        <img class="hero-mark" src="assets/brand-mark.svg" alt="" width="52" height="52" />
        <h1>读你眼前的页面。</h1>
        <p class="lede">选中网页里的任意一段文字，临窗可以解释、翻译、总结，或者接着你正在读的内容往下聊。</p>
        <div class="q-grid">
          <button class="q-card" type="button" data-quick="summarize">
            <span class="qt">总结此页</span><span class="qs">提取当前页面要点</span>
          </button>
          <button class="q-card" type="button" data-quick="explain">
            <span class="qt">解释选中</span><span class="qs">选中文字后即可解释</span>
          </button>
          <button class="q-card" type="button" data-quick="translate">
            <span class="qt">翻译成中文</span><span class="qs">把选中的外文段落译过来</span>
          </button>
          <button class="q-card" type="button" data-quick="ask">
            <span class="qt">接着追问</span><span class="qs">就当前页面继续提问</span>
          </button>
        </div>
        <p class="empty-foot">按 <span class="kbd">Alt</span>+<span class="kbd">Shift</span>+<span class="kbd">P</span> 随时打开侧边栏</p>
      </div>`;
  }

  function onboardHTML() {
    return `
      <div class="onboard">
        <div class="hero">
          <img class="hero-mark" src="assets/brand-mark.svg" alt="" width="44" height="44" />
          <h1>连接本机 DeepSeek Harness</h1>
          <p>未连接。请先启动 DSH，再点「重新检测」。页面内容与对话只经过本机 loopback 交给 DSH；扩展自身不会上传。</p>
        </div>
        <div class="steps">
          <div class="step">
            <span class="step-num">1</span>
            <div class="step-main">
              <div class="step-h"><h3>启动 DeepSeek Harness</h3><span class="step-state">未检测</span></div>
              <p>打开 DSH 桌面端，或在终端运行 <code>dsh serve</code>。</p>
            </div>
          </div>
          <div class="step">
            <span class="step-num">2</span>
            <div class="step-main">
              <div class="step-h"><h3>允许本机 127.0.0.1</h3><span class="step-state wait">待确认</span></div>
              <p>首次连接需要允许 <code>127.0.0.1:34281</code> 的本地回环通信。</p>
            </div>
          </div>
          <div class="step">
            <span class="step-num">3</span>
            <div class="step-main">
              <div class="step-h"><h3>开始提问</h3><span class="step-state">未开始</span></div>
              <p>选中网页里的任意文字，或直接在下方输入问题。</p>
            </div>
          </div>
        </div>
        <button class="primary-btn" id="recheckBtn" type="button">
          ${icon('i-refresh')}重新检测
        </button>
        <div class="onboard-foot">
          ${icon('i-lock')}本地桥接<span class="sep">·</span>由本机 DSH 处理<span class="sep">·</span>Powered by <b>DeepSeek Harness</b>
        </div>
      </div>`;
  }

  function renderEmpty() {
    const hasMessages = state.messages.length > 0;
    els.empty.hidden = hasMessages;
    els.thread.hidden = !hasMessages;
    if (hasMessages) return;

    // 切到历史会话且本地没有正文：显示「继续这个会话」空态
    if (state.currentSession && state.sessionId) {
      els.empty.innerHTML = sessionIntroHTML(state.currentSession);
      bindSessionIntro();
      return;
    }

    els.empty.innerHTML = state.connected ? welcomeHTML() : onboardHTML();

    const recheck = $('#recheckBtn', els.empty);
    if (recheck) {
      recheck.addEventListener('click', async () => {
        const original = recheck.innerHTML;
        recheck.disabled = true;
        recheck.innerHTML = `${icon('i-refresh')}正在检测…`;
        await refreshStatus(true);
        recheck.disabled = false;
        recheck.innerHTML = original;
        renderEmpty();
      });
    }

    els.empty.querySelectorAll('[data-quick]').forEach((btn) => {
      btn.addEventListener('click', () => onQuick(btn.dataset.quick));
    });
  }

  function bindSessionIntro() {
    els.empty.querySelectorAll('[data-si]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.si === 'new') {
          newSession();
        } else {
          focusInput();
        }
      });
    });
  }

  async function onQuick(kind) {
    if (kind === 'summarize') {
      // 每次总结都重新抓一次页面正文，避免用旧的/空的上下文
      if (!MOCK) await fetchPageContext();
      sendPrompt('请总结当前这个网页的主要内容，给出 3-5 个要点。');
      return;
    }
    if (kind === 'explain') {
      if (state.context.selections.length) {
        sendPrompt('请解释选中的这段内容，说清楚它在讲什么。');
      } else {
        els.input.value = '请解释这段内容：';
        autoGrow();
        focusInput();
      }
      return;
    }
    if (kind === 'translate') {
      if (state.context.selections.length) {
        sendPrompt('请把选中的这段内容翻译成中文；如果原文就是中文，请翻译成英文。');
      } else {
        els.input.value = '请翻译这段内容：';
        autoGrow();
        focusInput();
      }
      return;
    }
    focusInput();
  }

  /* ============================================================
     消息渲染
     ============================================================ */

  function threadNode(id) {
    return els.thread.querySelector(`.msg[data-id="${id}"]`);
  }

  function quoteHTML(msg) {
    if (!msg.selections || !msg.selections.length) return '';
    const text = msg.selections.map((s) => s.text).join('\n');
    const page = msg.page || msg.selections[0] || {};
    const label = pageLabel(page);
    return (
      `<div class="quote"><div class="qtext">${esc(text)}</div>` +
      `<div class="qmeta">${icon('i-globe')}<span>${esc(label)}</span></div></div>`
    );
  }

  function botHeadHTML(msg) {
    return (
      `<div class="bot-head"><b>临窗</b><span class="tag">本机 DSH</span>` +
      `<span class="tm">${fmtTime(msg.time)}</span></div>`
    );
  }

  function footHTML(msg) {
    const streaming = msg.status === 'streaming';
    return (
      `<button class="act-btn ${streaming ? 'is-stop' : ''}" type="button" data-act="stop" ${
        streaming ? '' : 'disabled'
      } title="停止生成">${icon('i-stop')}停止</button>` +
      `<button class="act-btn" type="button" data-act="retry" ${
        streaming ? 'disabled' : ''
      } title="重新生成">${icon('i-retry')}重试</button>` +
      `<button class="act-btn" type="button" data-act="copy" title="复制回答">${icon('i-copy')}复制</button>`
    );
  }

  function extraHTML(msg) {
    if (msg.status === 'error') {
      return `<div class="err-box">${icon('i-alert')}<span>${esc(
        msg.error || '出了点问题，请点「重试」再试一次。',
      )}</span></div>`;
    }
    if (msg.status === 'stopped') {
      return `<div class="stopped-note">${icon('i-stop')}已停止 · 可以重试，或继续追问</div>`;
    }
    return '';
  }

  function fillAssistantNode(node, msg) {
    if (!node) return;
    const body = node.querySelector('.a-body');
    const extra = node.querySelector('.a-extra');
    const foot = node.querySelector('.a-foot');
    if (!body || !extra || !foot) return;

    body.innerHTML = renderRich(msg.text || '');
    if (msg.status === 'streaming') {
      const caret = document.createElement('span');
      caret.className = 'caret';
      const last = body.lastElementChild;
      if (last && last.tagName !== 'PRE') last.appendChild(caret);
      else body.appendChild(caret);
    }
    extra.innerHTML = extraHTML(msg);
    foot.innerHTML = footHTML(msg);
  }

  function updateAssistantNode(msg) {
    fillAssistantNode(threadNode(msg.id), msg);
  }

  function createMessageNode(msg) {
    const wrap = document.createElement('div');
    wrap.className = `msg ${msg.role === 'user' ? 'user' : 'bot'}`;
    wrap.dataset.id = msg.id;

    if (msg.role === 'user') {
      wrap.innerHTML = quoteHTML(msg) + `<div class="bubble">${esc(msg.text)}</div>`;
    } else {
      wrap.innerHTML =
        botHeadHTML(msg) +
        '<div class="a-body"></div>' +
        '<div class="a-extra"></div>' +
        '<div class="a-foot"></div>';
      fillAssistantNode(wrap, msg);
    }
    return wrap;
  }

  function appendMessage(msg) {
    els.empty.hidden = true;
    els.thread.hidden = false;
    els.thread.appendChild(createMessageNode(msg));
  }

  function renderThread() {
    els.thread.innerHTML = '';
    state.messages.forEach((msg) => els.thread.appendChild(createMessageNode(msg)));
    els.empty.hidden = state.messages.length > 0;
    els.thread.hidden = state.messages.length === 0;
    if (!state.messages.length) {
      renderEmpty();
    } else {
      scrollToEnd(true);
    }
  }

  function renderRestoreBar() {
    if (!state.restored || !state.messages.length) {
      els.restoreBar.hidden = true;
      return;
    }
    els.restoreText.textContent = `已恢复上次会话 · ${state.messages.length} 条消息`;
    els.restoreBar.hidden = false;
  }

  function scrollToEnd(force) {
    if (force) pinToBottom = true;
    if (!pinToBottom) return;
    els.scroll.scrollTop = els.scroll.scrollHeight;
  }

  /* ---------- 轻量 Markdown：段落 / 标题 / 列表 / 代码块 / 行内代码 / 加粗 ---------- */

  function inlineMd(text) {
    return esc(text)
      .replace(/`([^`\n]+)`/g, '<code class="il">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
      .replace(/\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
  }

  function renderRich(text) {
    const src = String(text || '');
    if (!src.trim()) return '';
    const lines = src.split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (/^\s*```/.test(line)) {
        const lang = line.replace(/^\s*```/, '').trim().slice(0, 20);
        i += 1;
        const buf = [];
        while (i < lines.length && !/^\s*```/.test(lines[i])) {
          buf.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        out.push(
          `<div class="code-block"><div class="code-head"><span class="code-lang">${esc(lang || 'code')}</span><button class="code-copy" type="button" data-act="copy-code" title="复制代码">复制</button></div><pre class="code"><code>${esc(buf.join('\n'))}</code></pre></div>`
        );
        continue;
      }

      if (/^\s*$/.test(line)) {
        i += 1;
        continue;
      }

      if (/^\s*#{1,4}\s+/.test(line)) {
        out.push(`<h4>${inlineMd(line.replace(/^\s*#{1,4}\s+/, ''))}</h4>`);
        i += 1;
        continue;
      }

      if (
        /^\s*\|.*\|\s*$/.test(line) &&
        i + 1 < lines.length &&
        /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
      ) {
        const parseRow = (l) =>
          l
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim());
        const head = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
          rows.push(parseRow(lines[i]));
          i += 1;
        }
        const headHtml = head.map((cell) => `<th>${inlineMd(cell)}</th>`).join('');
        const rowsHtml = rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inlineMd(cell)}</td>`).join('')}</tr>`)
          .join('');
        out.push(
          `<div class="md-table"><table><thead><tr>${headHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`
        );
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(`<li>${inlineMd(lines[i].replace(/^\s*[-*+]\s+/, ''))}</li>`);
          i += 1;
        }
        out.push(`<ul>${items.join('')}</ul>`);
        continue;
      }

      if (/^\s*\d+[.)、]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+[.)、]\s+/.test(lines[i])) {
          items.push(`<li>${inlineMd(lines[i].replace(/^\s*\d+[.)、]\s+/, ''))}</li>`);
          i += 1;
        }
        out.push(`<ol>${items.join('')}</ol>`);
        continue;
      }

      const buf = [];
      while (
        i < lines.length &&
        !/^\s*$/.test(lines[i]) &&
        !/^\s*```/.test(lines[i]) &&
        !/^\s*#{1,4}\s+/.test(lines[i]) &&
        !/^\s*[-*+]\s+/.test(lines[i]) &&
        !/^\s*\d+[.)、]\s+/.test(lines[i])
      ) {
        buf.push(lines[i]);
        i += 1;
      }
      out.push(`<p>${inlineMd(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
    }
    return out.join('');
  }

  /* ============================================================
     消息动作：停止 / 重试 / 复制
     ============================================================ */

  async function stopStreaming() {
    if (!state.streaming) return;
    state.stopping = true;
    updateSendBtn();

    if (MOCK) {
      mockAborted = true;
      const bot = state.messages.find((m) => m.id === activeBotId);
      if (bot && bot.status === 'streaming') finishBot(bot, 'stopped');
      else endStreaming();
      return;
    }

    if (state.port && state.sessionId) {
      try {
        fetch(`http://127.0.0.1:${state.port}/windowseat/stop`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: state.sessionId }),
          cache: 'no-store',
        }).catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }
    if (state.abort) {
      try {
        state.abort.abort();
      } catch (e) {
        /* ignore */
      }
    }
  }

  async function retryMessage(msg) {
    if (state.streaming || !msg || !msg.request) return;
    const idx = state.messages.indexOf(msg);
    if (idx >= 0) state.messages.splice(idx, 1);
    const node = threadNode(msg.id);
    if (node) node.remove();

    const bot = {
      id: uid('a'),
      role: 'assistant',
      text: '',
      status: 'streaming',
      time: Date.now(),
      request: msg.request,
    };
    state.messages.push(bot);
    appendMessage(bot);
    scrollToEnd(true);
    schedulePersist();
    await runStream(bot);
  }

  async function copyPlainText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      /* fallback */
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (err) {
      /* ignore */
    }
  }

  async function copyMessage(msg) {
    const text = msg && msg.text ? msg.text : '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch (err) {
        /* ignore */
      }
    }
    const node = threadNode(msg.id);
    const btn = node && node.querySelector('[data-act="copy"]');
    if (btn) {
      const original = btn.innerHTML;
      btn.classList.add('is-done');
      btn.innerHTML = `${icon('i-check')}已复制`;
      setTimeout(() => {
        btn.classList.remove('is-done');
        btn.innerHTML = original;
      }, 1600);
    }
  }

  /* ============================================================
     会话 & 流式对话
     ============================================================ */

  function baseUrl() {
    return state.port ? `http://127.0.0.1:${state.port}` : '';
  }

  async function ensureSession() {
    if (MOCK) return 'mock-session';
    if (state.sessionId) return state.sessionId;
    const base = baseUrl();
    if (!base) {
      const err = new Error('未连接本机 DSH');
      err.code = 'network';
      throw err;
    }
    const res = await fetch(`${base}/windowseat/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      cache: 'no-store',
    });
    if (!res.ok) {
      const err = new Error(`创建会话失败（HTTP ${res.status}）`);
      err.code = 'bridge';
      throw err;
    }
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    if (!data || data.ok === false || !data.sessionId) {
      const message = data && data.error && data.error.message ? data.error.message : '创建会话失败';
      const err = new Error(message);
      err.code = 'bridge';
      throw err;
    }
    state.sessionId = data.sessionId;
    schedulePersist();
    void refreshTeam(true);
    return data.sessionId;
  }

  function buildPagePayload(request) {
    const page = (request && request.page) || state.context.page;
    const selections = (request && request.selections) || [];
    const payload = {};
    if (page && (page.title || page.url)) {
      payload.title = page.title || '';
      payload.url = page.url || '';
      payload.description = page.description || '';
      // 正文摘录：让模型直接阅读页面，而不是去调用工具抓取
      if (typeof page.text === 'string' && page.text.trim()) {
        payload.text = page.text.slice(0, 8000);
      }
    }
    const selText = selections
      .map((s) => s.text)
      .join('\n\n———\n\n')
      .trim();
    if (selText) payload.selection = selText.slice(0, 6000);
    if (!payload.title && !payload.url && !payload.selection) return null;
    return payload;
  }

  async function sendPrompt(text) {
    const prompt = String(text || '').trim();
    if (!prompt || state.streaming) return;

    if (!state.connected) {
      await refreshStatus(true);
      if (!state.connected) {
        renderEmpty();
        renderStatus();
        return;
      }
    }

    if (!MOCK && els.input.value.trim() === prompt) {
      els.input.value = '';
      autoGrow();
    }

    // 发送前刷新页面上下文（页面可能已经切换）
    if (!MOCK) await fetchPageContext();

    const selections = state.context.selections.map((s) => ({
      text: s.text,
      title: s.title,
      url: s.url,
    }));
    const page = state.context.page ? { ...state.context.page } : null;

    const userMsg = {
      id: uid('u'),
      role: 'user',
      text: prompt,
      time: Date.now(),
      selections,
      page,
    };
    state.messages.push(userMsg);
    appendMessage(userMsg);
    state.restored = false;
    els.restoreBar.hidden = true;
    scrollToEnd(true);
    schedulePersist();

    const bot = {
      id: uid('a'),
      role: 'assistant',
      text: '',
      status: 'streaming',
      time: Date.now(),
      request: {
        text: prompt,
        page,
        selections,
      },
    };
    state.messages.push(bot);
    appendMessage(bot);
    activeBotId = bot.id;
    scrollToEnd(true);

    await runStream(bot);
  }

  function handleFrame(bot, rawFrame) {
    const lines = String(rawFrame).split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue; // 心跳
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let ev = null;
      try {
        ev = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      if (!ev || typeof ev !== 'object') continue;

      const type = ev.type || (ev.ok === true ? 'done' : '');
      if (type === 'meta') {
        if (ev.sessionId) {
          state.sessionId = ev.sessionId;
          schedulePersist();
        }
      } else if (type === 'delta') {
        const delta = typeof ev.text === 'string' ? ev.text : typeof ev.delta === 'string' ? ev.delta : '';
        if (delta) {
          bot.text += delta;
          scheduleStreamUpdate(bot);
        }
      } else if (type === 'done') {
        finishOk(bot);
        return;
      } else if (type === 'error') {
        const errorObj = ev.error && typeof ev.error === 'object' ? ev.error : ev;
        finishBot(bot, 'error', friendlyError(errorObj));
        if (errorObj && errorObj.code === 'network') markDisconnected();
        return;
      } else if (type === 'stopped') {
        finishBot(bot, 'stopped');
        return;
      }
    }
  }

  function scheduleStreamUpdate(bot) {
    if (streamRaf) return;
    streamRaf = requestAnimationFrame(() => {
      streamRaf = null;
      updateAssistantNode(bot);
      scrollToEnd();
    });
  }

  async function runStream(bot) {
    state.streaming = true;
    state.stopping = false;
    mockAborted = false;
    updateSendBtn();

    if (MOCK) {
      clearShots();
      try {
        await mockStream(bot);
      } finally {
        endStreaming();
      }
      return;
    }

    const ac = new AbortController();
    state.abort = ac;

    try {
      const sessionId = await ensureSession();
      const payload = {
        text: bot.request.text,
        sessionId,
      };
      const pagePayload = buildPagePayload(bot.request);
      if (pagePayload) payload.page = pagePayload;
      if (state.shots.length > 0) {
        payload.images = state.shots.map((shot) => ({
          mediaType: shot.mediaType,
          data: shot.data,
          name: shot.name,
        }));
        clearShots();
      }

      const res = await fetch(`${baseUrl()}/windowseat/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
        cache: 'no-store',
      });

      if (!res.ok) {
        let detail = '';
        try {
          const data = await res.json();
          detail = data && data.error && data.error.message ? data.error.message : '';
        } catch (e) {
          /* ignore */
        }
        const err = new Error(detail || `本机 DSH 返回 HTTP ${res.status}`);
        err.code = 'bridge';
        throw err;
      }
      if (!res.body) {
        const err = new Error('本机 DSH 没有返回流式内容');
        err.code = 'bridge';
        throw err;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';

      while (bot.status === 'streaming') {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          handleFrame(bot, frame);
          if (bot.status !== 'streaming') break;
          idx = buf.indexOf('\n\n');
        }
      }
      if (buf.trim()) handleFrame(bot, buf);
      if (bot.status === 'streaming') finishOk(bot);
    } catch (err) {
      if (err && err.name === 'AbortError') {
        if (bot.status === 'streaming') finishBot(bot, 'stopped');
      } else {
        const isNetwork =
          err &&
          (err.code === 'network' ||
            /Failed to fetch|NetworkError|Load failed/i.test(String(err.message || '')));
        // 会话失效（例如 DSH 重启）时下次自动重建
        if (err && /session|会话/i.test(String(err.message || ''))) {
          state.sessionId = null;
          schedulePersist();
        }
        if (bot.status === 'streaming') {
          finishBot(bot, 'error', friendlyError(err));
        }
        if (isNetwork) markDisconnected();
      }
    } finally {
      endStreaming();
      activeBotId = null;
      schedulePersist();
    }
  }

  function friendlyError(err) {
    if (!err) return '出了点问题，请点「重试」再试一次。';
    const message = String((err && err.message) || err);
    if (
      (err && err.code === 'network') ||
      /Failed to fetch|NetworkError|Load failed|ECONNREFUSED/i.test(message)
    ) {
      return '连不上本机 DSH（127.0.0.1）。请确认 DSH 正在运行，然后点「重试」。';
    }
    return `本机 DSH 返回错误：${message}`;
  }

  function markDisconnected() {
    state.connected = false;
    state.connecting = false;
    renderStatus();
    // 消息流顶部显示断连条，并开始自动重连
    updateConnBanner();
    if (!state.streaming) scheduleReconnect();
    if (!state.messages.length) renderEmpty();
  }

  function finishOk(bot) {
    if (!String(bot.text || '').trim()) {
      finishBot(bot, 'error', '本机 DSH 返回了空内容，请点「重试」再试一次。');
      return;
    }
    finishBot(bot, 'ok');
    // 记录当前会话标题 / 消息数（历史抽屉里能看到）
    noteActiveSession(bot);
  }

  function finishBot(bot, status, error) {
    if (!bot) return;
    bot.status = status;
    if (error) bot.error = error;
    endStreaming();
    updateAssistantNode(bot);
    scrollToEnd();
    schedulePersist();
  }

  function endStreaming() {
    state.streaming = false;
    state.stopping = false;
    state.abort = null;
    if (streamRaf) {
      cancelAnimationFrame(streamRaf);
      streamRaf = null;
    }
    updateSendBtn();
    void refreshTeam(true);
  }

  function updateSendBtn() {
    const streaming = state.streaming;
    els.sendBtn.classList.toggle('is-stop', streaming);
    els.sendBtn.title = streaming ? '停止生成' : '发送（Enter）';
    els.sendBtn.setAttribute('aria-label', streaming ? '停止生成' : '发送');
    els.sendBtn.innerHTML = streaming ? icon('i-stop') : icon('i-send');
    els.sendBtn.disabled = !!state.stopping;
  }

  /* ============================================================
     输入区
     ============================================================ */

  function autoGrow() {
    els.input.style.height = 'auto';
    const next = Math.min(els.input.scrollHeight, 150);
    els.input.style.height = `${Math.max(next, 40)}px`;
  }

  function focusInput() {
    try {
      els.input.focus({ preventScroll: false });
    } catch (e) {
      /* ignore */
    }
  }

  function onSendButton() {
    if (state.streaming) {
      stopStreaming();
      return;
    }
    const text = els.input.value.trim();
    if (!text) {
      focusInput();
      return;
    }
    els.input.value = '';
    autoGrow();
    sendPrompt(text);
  }

  function onInputKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      onSendButton();
    }
  }

  /* ============================================================
     历史会话（线路 A：/windowseat/sessions*）
     ============================================================ */

  /**
   * 请求桥上的 JSON 接口。
   * @returns {Promise<{ok:boolean,status:number,data:any}>}
   */
  async function apiJson(pathname, init) {
    const base = baseUrl();
    if (!base) throw new Error('not_connected');
    const res = await fetch(`${base}${pathname}`, {
      cache: 'no-store',
      ...init,
    });
    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  }

  /* ============================================================
     协同小队（只读投影：/windowseat/team）
     ============================================================ */

  const TEAM_PHASE_TEXT = {
    active: '运行中',
    idle: '待命',
    waiting: '等待',
    stopped: '已停止',
    failed: '失败',
  };

  const TEAM_TASK_TEXT = {
    pending: '待处理',
    in_progress: '进行中',
    completed: '完成',
    deleted: '已删除',
  };

  function teamCounts(team) {
    const members = Array.isArray(team && team.members) ? team.members : [];
    const tasks = Array.isArray(team && team.tasks) ? team.tasks : [];
    return {
      members,
      tasks,
      done: tasks.filter((t) => t && t.status === 'completed').length,
      doing: tasks.filter((t) => t && t.status === 'in_progress').length,
    };
  }

  function renderTeam() {
    if (!els.teamDock) return;
    const team = state.team.data;
    if (!team || (MOCK && !(team.members || []).length)) {
      els.teamDock.hidden = true;
      return;
    }
    const { members, tasks, done, doing } = teamCounts(team);
    els.teamDock.hidden = false;
    els.teamDock.classList.toggle('open', state.team.open);
    els.teamToggle.setAttribute('aria-expanded', state.team.open ? 'true' : 'false');
    els.teamSum.innerHTML =
      `<span class="team-pill">${members.length} 名成员</span>` +
      (tasks.length
        ? `<span class="team-pill${doing ? ' doing' : ''}">任务 ${done}/${tasks.length}</span>`
        : '');
    if (!state.team.open) {
      els.teamBody.hidden = true;
      return;
    }
    const parts = [];
    for (const member of members) {
      const phase = member.phase || 'idle';
      const label = TEAM_PHASE_TEXT[phase] || phase;
      const dotCls = phase === 'failed' ? ' failed' : phase === 'active' ? '' : ' idle';
      parts.push(
        `<div class="tm-row"><span class="tm-dot${dotCls}"></span><span class="tm-name">${esc(member.name || 'member')}</span><span class="tm-role">${esc(member.role === 'lead' ? '主控' : label)}</span></div>`
      );
    }
    if (!tasks.length) {
      parts.push('<div class="team-note">共享任务板为空 · 让主控创建一个队员或任务试试</div>');
    } else {
      for (const task of tasks.slice(0, 20)) {
        const status = task.status || 'pending';
        const label = TEAM_TASK_TEXT[status] || status;
        parts.push(
          `<div class="tt-row"><span class="tt-status ${esc(status)}">${esc(label)}</span><span class="tt-subject">${esc(task.subject || '(无标题任务)')}</span></div>`
        );
      }
      if (tasks.length > 20) parts.push(`<div class="team-note">还有 ${tasks.length - 20} 个任务…</div>`);
    }
    if (team.note) parts.push(`<div class="team-note">${esc(team.note)}</div>`);
    els.teamBody.innerHTML = parts.join('');
    els.teamBody.hidden = false;
  }

  async function refreshTeam(force) {
    if (MOCK) return;
    if (!state.connected || !state.port || !state.sessionId) {
      state.team.data = null;
      renderTeam();
      return;
    }
    if (state.team.loading) return;
    state.team.loading = true;
    try {
      const out = await apiJson(`/windowseat/team?sessionId=${encodeURIComponent(state.sessionId)}`);
      if (out.ok && out.data && out.data.team) {
        state.team.data = out.data.team;
        renderTeam();
      } else if (force) {
        state.team.data = null;
        renderTeam();
      }
    } catch (e) {
      // 链路抖动时保留上次小队状态，不打扰用户
    } finally {
      state.team.loading = false;
    }
  }

  function resetTeam() {
    state.team.data = null;
    state.team.open = false;
    renderTeam();
  }

  function startTeamTimer() {
    if (state.team.timer) return;
    state.team.timer = setInterval(() => {
      if (state.team.open && document.visibilityState === 'visible') void refreshTeam(false);
    }, 8000);
  }


  /** 让历史列表与当前会话标题保持同步（发送消息后调用） */
  function titleOfPrompt(text) {
    const raw = String(text || '')
      .replace(/【[\s\S]*?】/g, ' ')
      .replace(/(^|\s)@[^\s@]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw) return '（无标题）';
    const chars = Array.from(raw);
    return chars.length > 30 ? chars.slice(0, 30).join('') + '…' : raw;
  }

  function noteActiveSession(bot) {
    if (!state.sessionId || MOCK) return;
    const request = bot && bot.request;
    const text = request ? request.text || '' : '';
    const same = state.currentSession && state.currentSession.sessionId === state.sessionId;
    const times = same ? (state.currentSession.messageCount || 0) + 1 : 1;
    state.currentSession = {
      sessionId: state.sessionId,
      title: same && state.currentSession.title ? state.currentSession.title : titleOfPrompt(text),
      updatedAt: Date.now(),
      messageCount: times,
      createdAt: same ? state.currentSession.createdAt : Date.now(),
    };
    schedulePersist();
  }

  function mockHistory() {
    const now = Date.now();
    return [
      { sessionId: 'mock-session-a', title: '调度器的双缓冲与切面回放要点', updatedAt: now - 5 * 60000, messageCount: 4 },
      { sessionId: 'mock-session-b', title: '给发布说明写一段变更摘要', updatedAt: now - 3 * 3600000, messageCount: 2 },
    ];
  }

  function historyItemHTML(item) {
    const active = item.sessionId === state.sessionId;
    const renaming = state.history.renameId === item.sessionId;
    const confirming = state.history.confirmId === item.sessionId;
    const meta = [fmtRel(item.updatedAt)].filter(Boolean);
    if (item.messageCount) meta.push(`${item.messageCount} 条消息`);
    return `
      <div class="hist-item${active ? ' is-active' : ''}" data-sid="${esc(item.sessionId)}" role="listitem" tabindex="0">
        <div class="hist-item-main">
          ${
            renaming
              ? `<input class="hist-rename-input" type="text" maxlength="80" value="${esc(item.title || '')}" aria-label="会话标题" />`
              : `<div class="hist-item-title" title="${esc(item.title || '（无标题）')}">${esc(
                  item.title || '（无标题）',
                )}</div>`
          }
          <div class="hist-item-meta">${esc(meta.join(' · '))}</div>
        </div>
        <div class="hist-actions">
          <button class="hist-act" type="button" data-hact="rename" title="重命名" aria-label="重命名">${icon(
            'i-edit',
          )}</button>
          <button class="hist-act${confirming ? ' is-danger' : ''}" type="button" data-hact="delete" title="${
            confirming ? '再点一次确认删除' : '删除会话'
          }" aria-label="删除会话">${icon('i-trash')}</button>
        </div>
      </div>`;
  }

  function renderHistory() {
    const h = state.history;
    if (!els.histList) return;
    els.histList.innerHTML = h.items.map(historyItemHTML).join('');
    const total = h.total || h.items.length;
    if (els.histCount) {
      els.histCount.textContent = total ? `${total} 个会话` : '';
    }
    if (els.histEmpty) {
      els.histEmpty.hidden = h.items.length > 0 || h.loading;
      if (!h.items.length && !h.loading) {
        els.histEmpty.innerHTML = h.query
          ? `没有匹配「${esc(h.query)}」的会话`
          : '还没有历史会话<br /><b>发起一轮对话后这里会出现记录</b>';
      }
    }
    if (els.histFoot) els.histFoot.hidden = !h.hasMore || h.loading;
    // 重命名输入框：自动聚焦并全选
    const renameInput = els.histList.querySelector('.hist-rename-input');
    if (renameInput && h.renameId) {
      renameInput.focus();
      renameInput.select();
    }
  }

  async function refreshHistory(reset) {
    const h = state.history;
    if (MOCK) {
      const all = mockHistory();
      const q = h.query.toLowerCase();
      h.items = all.filter((it) => (it.title || '').toLowerCase().includes(q));
      h.total = h.items.length;
      h.hasMore = false;
      h.loading = false;
      renderHistory();
      return;
    }
    const seq = ++h.seq;
    h.loading = true;
    h.confirmId = null;
    if (reset) {
      h.before = null;
      h.items = [];
    }
    renderHistory();
    try {
      const params = new URLSearchParams();
      params.set('limit', '20');
      if (h.query) params.set('query', h.query);
      if (!reset && h.before) params.set('before', String(h.before));
      const out = await apiJson(`/windowseat/sessions?${params.toString()}`);
      if (seq !== h.seq) return; // 丢弃过期响应
      if (!out.ok || !out.data || !out.data.ok) throw new Error('history_request_failed');
      const data = out.data;
      const incoming = Array.isArray(data.sessions) ? data.sessions : [];
      h.items = reset ? incoming : h.items.concat(incoming);
      h.hasMore = !!data.hasMore;
      h.nextBefore = data.nextBefore || null;
      h.total = Number(data.total) || h.items.length;
    } catch (e) {
      if (seq !== h.seq) return;
      h.items = reset ? [] : h.items;
      h.hasMore = false;
      h.total = h.items.length;
    } finally {
      if (seq === h.seq) {
        h.loading = false;
        renderHistory();
      }
    }
  }

  async function loadMoreHistory() {
    const h = state.history;
    if (h.loading || !h.hasMore) return;
    const last = h.items[h.items.length - 1];
    if (!last) return;
    h.before = last.updatedAt;
    await refreshHistory(false);
  }

  function openHistory() {
    if (!els.histDrawer) return;
    const h = state.history;
    h.open = true;
    els.histMask.hidden = false;
    els.histDrawer.hidden = false;
    els.histSearch.value = h.query;
    renderHistory();
    refreshHistory(true);
  }

  function closeHistory() {
    const h = state.history;
    if (!h.open && !els.histDrawer) return;
    h.open = false;
    h.renameId = null;
    h.confirmId = null;
    if (h.confirmTimer) {
      clearTimeout(h.confirmTimer);
      h.confirmTimer = null;
    }
    if (els.histMask) els.histMask.hidden = true;
    if (els.histDrawer) els.histDrawer.hidden = true;
  }

  function toggleHistory() {
    if (state.history.open) closeHistory();
    else openHistory();
  }

  /* ---------------- 设置抽屉：思考强度 / 本地文件白名单 / 快捷键 ---------------- */

  const EFFORT_LABEL = {
    off: '关（最快，不思考）',
    low: '快（日常，少量思考）',
    high: '深（质量优先）',
    max: '极深（最慢）',
  };

  async function openSettings() {
    if (!els.setDrawer) return;
    state.settings.open = true;
    els.setMask.hidden = false;
    els.setDrawer.hidden = false;
    if (els.setVersion) {
      try {
        els.setVersion.textContent = chrome.runtime.getManifest().version;
      } catch (error) {
        els.setVersion.textContent = '—';
      }
    }
    renderEfforts();
    await Promise.all([loadSettings(), loadDirs()]);
  }

  function closeSettings() {
    state.settings.open = false;
    if (els.setMask) els.setMask.hidden = true;
    if (els.setDrawer) els.setDrawer.hidden = true;
  }

  function toggleSettings() {
    if (state.settings.open) closeSettings();
    else openSettings();
  }

  function renderEfforts() {
    if (!els.setEfforts) return;
    const effort = state.settings.effort;
    els.setEfforts.querySelectorAll('button').forEach((btn) => {
      const on = btn.dataset.effort === effort;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (els.setEffortNote) {
      els.setEffortNote.textContent = effort
        ? `当前：${EFFORT_LABEL[effort] || effort}（对新会话生效）`
        : '读取中…';
    }
  }

  async function loadSettings() {
    const port = state.port;
    if (!port) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/windowseat/settings`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.settings.effort = data.reasoningEffort || '';
      renderEfforts();
    } catch (error) {
      if (els.setEffortNote) els.setEffortNote.textContent = `读取失败：${error.message}`;
    }
  }

  async function saveEffort(effort) {
    const port = state.port;
    if (!port || !effort || state.settings.loading) return;
    state.settings.loading = true;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/windowseat/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reasoningEffort: effort }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      state.settings.effort = data.reasoningEffort || effort;
      renderEfforts();
      toast('已保存，下一轮生效');
    } catch (error) {
      toast(`保存失败：${error.message}`);
    } finally {
      state.settings.loading = false;
    }
  }

  async function loadDirs() {
    if (!els.setDirs) return;
    const port = state.port;
    if (!port) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/windowseat/files/config`, { cache: 'no-store' });
      const data = await res.json();
      state.settings.dirs = Array.isArray(data.dirs) ? data.dirs : [];
      renderDirs();
    } catch (error) {
      els.setDirs.innerHTML = `<div class="set-note">读取失败：${esc(error.message)}</div>`;
    }
  }

  function renderDirs() {
    if (!els.setDirs) return;
    const dirs = state.settings.dirs;
    if (!dirs.length) {
      els.setDirs.innerHTML = '<div class="set-note">还没有白名单目录</div>';
      return;
    }
    els.setDirs.innerHTML = dirs
      .map(
        (dir) =>
          `<div class="set-dir"><span class="set-dir-path" title="${esc(dir)}">${esc(dir)}</span><button class="set-dir-x" type="button" data-dir="${esc(dir)}" title="移除">×</button></div>`
      )
      .join('');
  }

  async function mutateDirs(payload) {
    const port = state.port;
    if (!port) return;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/windowseat/files/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      state.settings.dirs = Array.isArray(data.dirs) ? data.dirs : state.settings.dirs;
      renderDirs();
      toast('白名单已更新');
    } catch (error) {
      toast(`更新失败：${error.message}`);
    }
  }

  async function switchSession(item) {
    if (!item || !item.sessionId) return;
    const target = {
      sessionId: item.sessionId,
      title: item.title || '（无标题）',
      updatedAt: item.updatedAt || Date.now(),
      messageCount: Number(item.messageCount) || 0,
    };
    // 借「新对话」把消息 / 选中 / 文件引用全部清掉（@本地文件的文件 chip 由 files.js 监听 newBtn 清理）
    if (els.newBtn) els.newBtn.click();
    state.sessionId = target.sessionId;
    state.currentSession = target;
    resetTeam();
    void refreshTeam(true);
    state.restored = false;
    state.pageDismissedUrl = null;
    state.messages = [];
    state.context.selections = [];
    renderThread();
    renderChips();
    renderEmpty();
    renderRestoreBar();
    closeHistory();
    schedulePersist();
    if (state.connected && !MOCK) fetchPageContext();
    focusInput();
  }

  function startRename(item) {
    state.history.renameId = item.sessionId;
    renderHistory();
  }

  async function commitRename(item, inputEl) {
    const value = String((inputEl && inputEl.value) || '').replace(/\s+/g, ' ').trim();
    state.history.renameId = null;
    if (!value) {
      renderHistory();
      return;
    }
    if (MOCK) {
      item.title = value;
      item.updatedAt = Date.now();
      if (state.currentSession && state.currentSession.sessionId === item.sessionId) {
        state.currentSession.title = value;
      }
      renderHistory();
      renderEmpty();
      return;
    }
    try {
      const out = await apiJson('/windowseat/sessions/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: item.sessionId, title: value }),
      });
      if (out.ok && out.data && out.data.ok && out.data.session) {
        item.title = out.data.session.title;
        item.updatedAt = out.data.session.updatedAt;
      } else {
        item.title = value;
      }
      if (state.currentSession && state.currentSession.sessionId === item.sessionId) {
        state.currentSession.title = item.title;
        schedulePersist();
        renderEmpty();
      }
    } catch (e) {
      item.title = value;
    }
    renderHistory();
  }

  async function requestDelete(item) {
    const h = state.history;
    // 第一次点：进入待确认态（3 秒内再点一次才真正删除）
    if (h.confirmId !== item.sessionId) {
      h.confirmId = item.sessionId;
      if (h.confirmTimer) clearTimeout(h.confirmTimer);
      h.confirmTimer = setTimeout(() => {
        h.confirmId = null;
        h.confirmTimer = null;
        renderHistory();
      }, 3000);
      renderHistory();
      return;
    }
    h.confirmId = null;
    if (h.confirmTimer) {
      clearTimeout(h.confirmTimer);
      h.confirmTimer = null;
    }
    h.items = h.items.filter((it) => it.sessionId !== item.sessionId);
    h.total = Math.max(0, (h.total || 0) - 1);
    renderHistory();
    if (state.currentSession && state.currentSession.sessionId === item.sessionId) {
      await newSession();
      state.currentSession = null;
      renderEmpty();
    }
    if (MOCK) return;
    try {
      await apiJson(`/windowseat/sessions/${encodeURIComponent(item.sessionId)}`, { method: 'DELETE' });
    } catch (e) {
      /* 删除失败不阻塞 UI */
    }
  }

  function onPageChanged(page) {
    const next = normalizePage(page);
    if (!next || (!next.title && !next.url)) return;
    const prev = state.context.page;
    const changed = !prev || prev.url !== next.url;
    // 页面切换：之前页面的选中文本已经失效
    if (changed) state.context.selections = [];
    // 用户手动 × 掉的页面，本次会话内不再自动加回（离开后返回、同页刷新都不加回）
    const dismissed = !!(state.pageDismissedUrl && next.url && next.url === state.pageDismissedUrl);
    state.context.page = dismissed ? null : next;
    renderChips();
    schedulePersist();
    if (changed && state.connected && !MOCK) fetchPageContext();
  }

  /* ============================================================
     新会话
     ============================================================ */

  async function newSession() {
    if (state.streaming) await stopStreaming();
    state.messages = [];
    state.context.selections = [];
    state.sessionId = null;
    state.currentSession = null;
    state.pageDismissedUrl = null;
    state.restored = false;
    state.seenContext.clear();
    resetTeam();
    els.restoreBar.hidden = true;
    els.input.value = '';
    clearShots();
    autoGrow();
    renderThread();
    renderChips();
    renderEmpty();
    await clearPersistedSession();
    if (state.connected && !MOCK) {
      fetchPageContext();
    }
    focusInput();
  }

  /* ============================================================
     事件绑定
     ============================================================ */

  function bindEvents() {
    els.sendBtn.addEventListener('click', onSendButton);
    els.shotBtn.addEventListener('click', onShotButton);
    els.newBtn.addEventListener('click', newSession);
    els.input.addEventListener('keydown', onInputKeydown);
    els.input.addEventListener('input', autoGrow);

    els.teamToggle.addEventListener('click', () => {
      state.team.open = !state.team.open;
      renderTeam();
      if (state.team.open) {
        startTeamTimer();
        void refreshTeam(true);
      }
    });

    els.thread.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.disabled) return;
      const wrap = btn.closest('.msg');
      if (!wrap) return;
      const msg = state.messages.find((m) => m.id === wrap.dataset.id);
      if (!msg) return;
      const act = btn.dataset.act;
      if (act === 'copy-code') {
        const pre = btn.closest('.code-block') && btn.closest('.code-block').querySelector('pre');
        const text = pre ? pre.textContent : '';
        if (text) {
          copyPlainText(text);
          toast('代码已复制');
        }
      } else if (act === 'stop') stopStreaming();
      else if (act === 'retry') retryMessage(msg);
      else if (act === 'copy') copyMessage(msg);
    });

    els.ctxRow.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (!btn) return;
      removeContext(btn.dataset.remove);
    });

    els.scroll.addEventListener('scroll', () => {
      pinToBottom = els.scroll.scrollHeight - els.scroll.scrollTop - els.scroll.clientHeight < 48;
    });

    els.restoreContinue.addEventListener('click', () => {
      state.restored = false;
      els.restoreBar.hidden = true;
      scrollToEnd(true);
      focusInput();
    });

    els.restoreClear.addEventListener('click', () => {
      newSession();
    });

    /* ---- 历史会话抽屉 ---- */
    if (els.histBtn) els.histBtn.addEventListener('click', toggleHistory);
    if (els.histClose) els.histClose.addEventListener('click', closeHistory);
    if (els.histMask) els.histMask.addEventListener('click', closeHistory);
    if (els.setBtn) els.setBtn.addEventListener('click', toggleSettings);
    if (els.setClose) els.setClose.addEventListener('click', closeSettings);
    if (els.setMask) els.setMask.addEventListener('click', closeSettings);
    if (els.setEfforts) {
      els.setEfforts.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-effort]');
        if (btn) saveEffort(btn.dataset.effort);
      });
    }
    if (els.setDirs) {
      els.setDirs.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-dir]');
        if (btn && btn.dataset.dir) mutateDirs({ remove: btn.dataset.dir });
      });
    }
    if (els.setDirAdd && els.setDirInput) {
      els.setDirAdd.addEventListener('click', () => {
        const value = els.setDirInput.value.trim();
        if (!value) return;
        mutateDirs({ add: value }).then(() => {
          els.setDirInput.value = '';
        });
      });
      els.setDirInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          els.setDirAdd.click();
        }
      });
    }
    if (els.connRetry) els.connRetry.addEventListener('click', retryConnect);

    if (els.histSearch) {
      els.histSearch.addEventListener('input', () => {
        const h = state.history;
        clearTimeout(h.searchTimer);
        h.searchTimer = setTimeout(() => {
          h.query = els.histSearch.value.trim();
          refreshHistory(true);
        }, 150);
      });
      els.histSearch.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeHistory();
        }
      });
    }

    if (els.histList) {
      const findItem = (el) => {
        const itemEl = el && el.closest ? el.closest('.hist-item') : null;
        if (!itemEl) return null;
        return state.history.items.find((it) => it.sessionId === itemEl.dataset.sid) || null;
      };
      els.histList.addEventListener('click', (e) => {
        const actBtn = e.target.closest('[data-hact]');
        const itemEl = e.target.closest('.hist-item');
        if (!itemEl) return;
        const item = findItem(itemEl);
        if (!item) return;
        if (actBtn) {
          if (actBtn.dataset.hact === 'rename') startRename(item);
          else if (actBtn.dataset.hact === 'delete') requestDelete(item);
          return;
        }
        if (e.target.closest('.hist-rename-input')) return;
        switchSession(item);
      });
      els.histList.addEventListener('keydown', (e) => {
        const input = e.target.closest('.hist-rename-input');
        if (!input) {
          // 条目上按 Enter / 空格 = 切换会话
          if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('hist-item')) {
            e.preventDefault();
            const item = findItem(e.target);
            if (item) switchSession(item);
          }
          return;
        }
        const item = findItem(input);
        if (!item) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          commitRename(item, input);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          state.history.renameId = null;
          renderHistory();
        }
      });
      els.histList.addEventListener('focusout', (e) => {
        const input = e.target.closest && e.target.closest('.hist-rename-input');
        if (!input) return;
        const item = findItem(input);
        // 等一拍：若焦点只是移到了同一行的操作按钮，不提交
        setTimeout(() => {
          if (!state.history.renameId || !item) return;
          if (els.histList.contains(document.activeElement)) return;
          commitRename(item, input);
        }, 120);
      });
      els.histList.addEventListener('scroll', () => {
        const nearBottom =
          els.histList.scrollHeight - els.histList.scrollTop - els.histList.clientHeight < 40;
        if (nearBottom) loadMoreHistory();
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.history.open) closeHistory();
    });

    if (HAS_CHROME && !MOCK) {
      chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || typeof msg.type !== 'string') return;
        if (msg.type === 'ws/status' && msg.status) applyStatus(msg.status);
        else if (msg.type === 'ws/context' && Array.isArray(msg.items)) {
          msg.items.forEach(consumeContextItem);
          sendToBackground({ type: 'ws/take-pending' }); // 幂等清空，避免重复
        } else if (msg.type === 'ws/focus-composer') {
          focusInput();
        } else if (msg.type === 'ws/page-changed' && msg.page) {
          // 页面切换后自动刷新页面 chip（用户手动 × 掉的不会自动加回）
          onPageChanged(msg.page);
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          refreshStatus(true);
          fetchPageContext();
        }
      });
    }
  }

  /* ============================================================
     Mock 模式：内置假对话（用于 headless 截图与无扩展环境调试）
     ============================================================ */

  const MOCK_PAGE = {
    title: '双缓冲与切面回放 · 调度器文档',
    url: 'https://docs.example.dev/scheduler/double-buffer',
    description: '玄武调度器文档：双缓冲与切面回放。切换成本从 O(n) 降到 O(1)。',
  };

  const MOCK_FIRST_ANSWER = [
    '先说结论：**双缓冲不是省掉切换，而是把切换从「关键路径」挪到「空闲路径」**。切面回放负责在指针交换前把新缓冲区的热点切片预热好，所以切换后的第一个 tick 不会撞上冷页。',
    '',
    '#### 三个关键点',
    '- 指针交换是单次 `fetch_xor`，耗时恒定',
    '- 回放按 256 tick 切片，在 `idle` 里增量执行',
    '- 首次命中率 71% → 98%，切换后只剩 1 tick 的预热窗口',
    '',
    '对应到本页的示例代码：',
    '',
    '```rust',
    '// 交换指针后，standby 变为新的 active',
    'pub fn commit(&self, next: &Plan) -> Slot {',
    '    let slot = self.active.fetch_xor(1, AcqRel);',
    '    self.standby[slot].replay_slices(next, 256);',
    '    slot',
    '}',
    '```',
    '',
    '所以延迟差异不在交换本身，而在预热窗口——把预热放进空闲时间，切换就只剩一次原子操作。',
  ].join('\n');

  const MOCK_SECOND_ANSWER = [
    '可以，把 256 tick 再切成 32 tick 的小片，按空闲周期分批写入，用完成水位线决定何时交换。',
    '',
    '代价是切换窗口变长、预热完成度需要额外校验，适合内存吃紧但能接受延迟抖动的场景。',
  ].join('\n');

  const MOCK_FOLLOW_UP = '如果内存吃紧，能改成增量回放吗？';

  function mockMessages() {
    return [
      {
        id: uid('u'),
        role: 'user',
        text: '这段里的「切面回放」具体怎么实现？和直接切换相比延迟差多少？',
        time: Date.now() - 1000 * 60 * 12,
        selections: [
          {
            text: '双缓冲把切换成本从 O(n) 降到了 O(1)，代价是内存占用翻倍。我们的做法是把切面回放（slice replay）提前到空闲窗口里完成。',
            title: MOCK_PAGE.title,
            url: MOCK_PAGE.url,
          },
        ],
        page: MOCK_PAGE,
      },
      {
        id: uid('a'),
        role: 'assistant',
        text: MOCK_FIRST_ANSWER,
        status: 'ok',
        time: Date.now() - 1000 * 60 * 12,
        request: null,
      },
      {
        id: uid('u'),
        role: 'user',
        text: MOCK_FOLLOW_UP,
        time: Date.now() - 1000 * 60 * 2,
        selections: [],
        page: MOCK_PAGE,
      },
      {
        id: uid('a'),
        role: 'assistant',
        text: MOCK_SECOND_ANSWER,
        status: 'ok',
        time: Date.now() - 1000 * 60 * 2,
        request: null,
      },
    ];
  }

  function setupMock() {
    state.connecting = false;
    if (SCENARIO === 'onboard') {
      state.connected = false;
      state.port = null;
      state.messages = [];
      state.context = { page: null, selections: [] };
      return;
    }
    state.connected = true;
    state.port = 34281;
    state.context = {
      page: normalizePage(MOCK_PAGE),
      selections: [
        {
          id: uid('sel'),
          text: '双缓冲把切换成本从 O(n) 降到了 O(1)，代价是内存占用翻倍。我们的做法是把切面回放（slice replay）提前到空闲窗口里完成。',
          title: MOCK_PAGE.title,
          url: MOCK_PAGE.url,
        },
      ],
    };

    if (SCENARIO === 'empty') {
      state.messages = [];
      return;
    }
    if (SCENARIO === 'error') {
      state.messages = [
        {
          id: uid('u'),
          role: 'user',
          text: '帮我总结这一页。',
          time: Date.now() - 60000,
          selections: [],
          page: MOCK_PAGE,
        },
        {
          id: uid('a'),
          role: 'assistant',
          text: '',
          status: 'error',
          error: '连不上本机 DSH（127.0.0.1）。请确认 DSH 正在运行，然后点「重试」。',
          time: Date.now() - 60000,
          request: null,
        },
      ];
      return;
    }
    if (SCENARIO === 'streaming') {
      const list = mockMessages().slice(0, 3);
      list.push({
        id: uid('a'),
        role: 'assistant',
        text: '可以，把 256 tick 再切成 32 tick 的小片，在空闲周期分批写入，并用完成水位线决定何时交换',
        status: 'streaming',
        time: Date.now() - 5000,
        request: null,
      });
      state.messages = list;
      state.streaming = true;
      activeBotId = list[list.length - 1].id;
      return;
    }
    state.messages = SCENARIO === 'long' ? mockMessages() : mockMessages().slice(0, 2);
  }

  async function mockStream(bot) {
    const first = bot.request && bot.request.text ? String(bot.request.text) : '';
    let answer;
    if (/增量|内存/.test(first)) {
      answer = MOCK_SECOND_ANSWER;
    } else if (/总结/.test(first)) {
      answer = [
        '这一页讲的是双缓冲与切面回放：',
        '',
        '1. 切换成本从 O(n) 降到 O(1)，代价是内存占用翻倍',
        '2. 切面回放把预热提前到空闲窗口，切换后第一个 tick 不撞冷页',
        '3. 首次命中率从 71% 提升到 98%',
      ].join('\n');
    } else {
      answer = MOCK_FIRST_ANSWER;
    }

    const chars = Array.from(answer);
    let index = 0;
    while (index < chars.length) {
      if (mockAborted) break;
      await sleep(14);
      bot.text += chars.slice(index, index + 2).join('');
      index += 2;
      updateAssistantNode(bot);
      scrollToEnd();
    }
    if (mockAborted) return;
    bot.time = Date.now();
    finishBot(bot, 'ok');
  }

  /* ============================================================
     启动
     ============================================================ */

  function renderAll() {
    renderStatus();
    renderChips();
    renderThread();
    renderEmpty();
    renderRestoreBar();
    updateSendBtn();
    autoGrow();
  }

  async function init() {
    bindEvents();

    if (MOCK) {
      setupMock();
      renderAll();
      if (state.connected && state.messages.length === 0) renderEmpty();
      if (params.get('scroll') === 'bottom' || SCENARIO === 'streaming') scrollToEnd(true);
      else els.scroll.scrollTop = 0;
      return;
    }

    await restorePersisted();
    renderAll();

    els.restoreBar.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (btn) schedulePersist();
    });
    renderRestoreBar();

    await refreshStatus(true);
    if (state.messages.length) {
      scrollToEnd(true);
    } else {
      renderEmpty();
    }

    statusTimer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshStatus(false);
    }, 8000);

    window.addEventListener('beforeunload', () => {
      schedulePersist();
      if (statusTimer) clearInterval(statusTimer);
    });
  }

  init().catch((err) => {
    // 初始化失败也要给出可用的 UI，而不是白屏
    console.error('[windowseat] init failed', err);
    renderAll();
  });
})();
