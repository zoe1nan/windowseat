/* 临窗 Windowseat · background service worker
 * 职责：
 *  1) 工具栏图标点击打开侧边栏（setPanelBehavior）
 *  2) 端口探测 34281 → 34282 → 34283（GET /windowseat/health），结果写 chrome.storage.local
 *  3) content script ↔ 侧边栏面板 的消息路由
 *  4) 快捷键 Alt+Shift+P、右键菜单「存到临窗」
 * 约束：MV3，无远程代码；仅访问 http://127.0.0.1/*
 */

'use strict';

const CANDIDATE_PORTS = [34281, 34282, 34283];
const HEALTH_TIMEOUT = 1200;

// 版本号：未打包扩展不会热重载，e2e 用它判断 service worker 是否已更新
const BG_VERSION = '1.4.0';

const STORE_KEYS = {
  port: 'wsPort',
  connected: 'wsConnected',
  lastOkAt: 'wsLastOkAt',
  checkedAt: 'wsCheckedAt',
  bridgeName: 'wsBridgeName',
  bridgeVersion: 'wsBridgeVersion',
};

const SESSION_PENDING = 'wsPendingContext';

/* ---------- 连接状态（内存 + chrome.storage.local 持久化） ---------- */

const conn = {
  port: null,
  connected: false,
  lastOkAt: 0,
};

let probePromise = null;
let lastProbeAt = 0;

async function loadConn() {
  try {
    const got = await chrome.storage.local.get([
      STORE_KEYS.port,
      STORE_KEYS.connected,
      STORE_KEYS.lastOkAt,
    ]);
    conn.port = got[STORE_KEYS.port] || null;
    conn.connected = !!got[STORE_KEYS.connected];
    conn.lastOkAt = got[STORE_KEYS.lastOkAt] || 0;
  } catch (e) {
    /* ignore */
  }
  return conn;
}

async function saveConn() {
  try {
    await chrome.storage.local.set({
      [STORE_KEYS.port]: conn.port,
      [STORE_KEYS.connected]: conn.connected,
      [STORE_KEYS.lastOkAt]: conn.lastOkAt,
      [STORE_KEYS.checkedAt]: Date.now(),
    });
  } catch (e) {
    /* ignore */
  }
}

async function probeOne(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HEALTH_TIMEOUT);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/windowseat/health`, {
      method: 'GET',
      signal: ac.signal,
      cache: 'no-store',
      credentials: 'omit',
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || data.ok !== true) return null;
    return { port, data };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 依次探测候选端口。成功则记录 port + lastOkAt，失败标记 disconnected。
 * 1 秒内重复调用复用同一个 Promise，避免面板刷新打爆本机端口。
 */
async function probePorts(force) {
  const now = Date.now();
  if (!force && now - lastProbeAt < 1000) {
    if (probePromise) return probePromise;
    return { ...conn };
  }
  if (probePromise) return probePromise;
  lastProbeAt = now;

  probePromise = (async () => {
    for (const port of CANDIDATE_PORTS) {
      const hit = await probeOne(port);
      if (hit) {
        conn.port = port;
        conn.connected = true;
        conn.lastOkAt = Date.now();
        try {
          await chrome.storage.local.set({
            [STORE_KEYS.bridgeName]: hit.data.name || 'windowseat-bridge',
            [STORE_KEYS.bridgeVersion]: hit.data.version || '',
          });
        } catch (e) {
          /* ignore */
        }
        await saveConn();
        broadcastStatus();
        return { ...conn };
      }
    }
    conn.port = null;
    conn.connected = false;
    await saveConn();
    broadcastStatus();
    return { ...conn };
  })();

  try {
    return await probePromise;
  } finally {
    probePromise = null;
  }
}

function statusPayload() {
  return {
    connected: conn.connected,
    port: conn.port,
    lastOkAt: conn.lastOkAt,
    baseUrl: conn.port ? `http://127.0.0.1:${conn.port}` : null,
  };
}

function broadcastStatus() {
  // 面板没开时 sendMessage 会 reject，这里只是尽力通知。
  chrome.runtime
    .sendMessage({ type: 'ws/status', status: statusPayload() })
    .catch(() => {});
}

/**
 * 页面切换（激活标签 / URL 变化）时通知面板刷新页面上下文 chip。
 * 只广播页面标题与 URL，不传正文；正文由面板自己按需调用 ws/page-context 获取。
 */
function broadcastPageChanged(tab) {
  if (!tab || !/^https?:/i.test(tab.url || '')) return;
  chrome.runtime
    .sendMessage({
      type: 'ws/page-changed',
      page: { title: tab.title || '', url: tab.url },
      tabId: typeof tab.id === 'number' ? tab.id : null,
    })
    .catch(() => {});
}

/* ---------- 侧边栏打开 ---------- */

async function openPanelForWindow(windowId) {
  if (typeof chrome.sidePanel === 'undefined') return false;
  try {
    if (typeof windowId === 'number') {
      await chrome.sidePanel.open({ windowId });
    } else {
      await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
    }
    return true;
  } catch (e) {
    console.warn('[windowseat] sidePanel.open 失败：', e && e.message ? e.message : e);
    return false;
  }
}

async function resolveSenderWindow(sender) {
  if (sender && sender.tab && typeof sender.tab.windowId === 'number') {
    return sender.tab.windowId;
  }
  try {
    const win = await chrome.windows.getLastFocused({ populate: false });
    if (win && typeof win.id === 'number') return win.id;
  } catch (e) {
    /* ignore */
  }
  return null;
}

/* ---------- 待发送上下文（content → 面板） ---------- */

async function readPending() {
  try {
    const got = await chrome.storage.session.get(SESSION_PENDING);
    return Array.isArray(got[SESSION_PENDING]) ? got[SESSION_PENDING] : [];
  } catch (e) {
    return [];
  }
}

async function writePending(list) {
  try {
    await chrome.storage.session.set({ [SESSION_PENDING]: list });
  } catch (e) {
    /* ignore */
  }
}

async function pushPending(item) {
  const list = await readPending();
  list.push(item);
  // 最多保留 8 条，避免无限堆积
  await writePending(list.slice(-8));
}

/**
 * 面板可能还没加载完，所以先打开面板，短暂等待后再推送；
 * 推送失败也没关系：面板初始化时会自己 takePending。
 */
async function flushPendingToPanel() {
  const list = await readPending();
  if (!list.length) return;
  await new Promise((r) => setTimeout(r, 260));
  try {
    await chrome.runtime.sendMessage({ type: 'ws/context', items: list });
    await writePending([]);
  } catch (e) {
    // 面板未就绪，保留 pending 等它来取
  }
}

/* ---------- 页面上下文 ---------- */

const PAGE_INFO_FN = () => {
  const meta = (sel) => {
    const el = document.querySelector(sel);
    return el && el.content ? String(el.content).trim() : '';
  };
  const sel = window.getSelection ? window.getSelection() : null;
  const excerpt = (max) => {
    if (!document.body) return '';
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg, nav, header, footer, aside, form, button, iframe')
      .forEach((n) => n.remove());
    const main = clone.querySelector('main, article, [role="main"]') || clone;
    let t = String(main.innerText || main.textContent || '')
      .replace(/\h+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (t.length > max) t = t.slice(0, max) + '\n…（正文已截断）';
    return t;
  };
  return {
    title: document.title || '',
    url: location.href,
    description:
      meta('meta[name="description"]') ||
      meta('meta[property="og:description"]') ||
      meta('meta[name="twitter:description"]') ||
      '',
    selection: sel ? String(sel).trim().slice(0, 4000) : '',
    text: excerpt(8000),
  };
};

async function getActivePageContext() {
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    /* ignore */
  }
  if (!tab) {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs && tabs[0];
    } catch (e) {
      /* ignore */
    }
  }
  if (!tab || typeof tab.id !== 'number') return null;
  if (/^(chrome|edge|about|devtools|view-source):/i.test(tab.url || '')) {
    return { title: tab.title || '', url: tab.url || '', description: '', selection: '' };
  }

  // 优先问已经注入的 content script（不需要额外权限）
  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'ws/get-page' });
    if (resp && typeof resp === 'object' && resp.url) return resp;
  } catch (e) {
    /* 页面未注入或受限，继续回退 */
  }
  // 回退：用 activeTab/scripting 直接读 DOM
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: PAGE_INFO_FN,
    });
    const value = results && results[0] && results[0].result;
    if (value && value.url) return value;
  } catch (e) {
    /* ignore */
  }
  return { title: tab.title || '', url: tab.url || '', description: '', selection: '' };
}

/* ---------- 消息路由 ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  (async () => {
    switch (msg.type) {
      case 'ws/probe': {
        const status = await probePorts(!!msg.force);
        sendResponse({ ok: true, status });
        break;
      }
      case 'ws/get-status': {
        if (!conn.port && !conn.connected) await loadConn();
        sendResponse({ ok: true, status: statusPayload() });
        break;
      }
      case 'ws/page-context': {
        const page = await getActivePageContext();
        sendResponse({ ok: true, page });
        break;
      }
      case 'ws/open-panel': {
        const windowId = await resolveSenderWindow(sender);
        const opened = await openPanelForWindow(windowId);
        if (msg.context) {
          await pushPending({ ...msg.context, at: Date.now() });
          await flushPendingToPanel();
        }
        sendResponse({ ok: opened });
        break;
      }
      case 'ws/action': {
        // content script 的浮条动作：缓存上下文 + 打开面板 + 推送
        const item = {
          id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          action: msg.action || 'ask',
          page: msg.page || null,
          at: Date.now(),
        };
        await pushPending(item);
        const windowId = await resolveSenderWindow(sender);
        const opened = await openPanelForWindow(windowId);
        await flushPendingToPanel();
        sendResponse({ ok: true, opened });
        break;
      }
      case 'ws/take-pending': {
        const items = await readPending();
        await writePending([]);
        sendResponse({ ok: true, items });
        break;
      }
      case 'ws/ping': {
        sendResponse({ ok: true, at: Date.now(), bgVersion: BG_VERSION });
        break;
      }
      case 'ws/capture': {
        // 截当前可视区域（窗口的活动标签页），JPEG 82 控制在 100–300KB
        const windowId = await resolveSenderWindow(sender);
        const targetWindow = typeof windowId === 'number' ? windowId : undefined;
        const dataUrl = await chrome.tabs.captureVisibleTab(targetWindow, {
          format: 'jpeg',
          quality: 82,
        });
        let tab = sender && sender.tab ? sender.tab : null;
        if (!tab) {
          try {
            const [active] = await chrome.tabs.query({
              active: true,
              windowId: typeof windowId === 'number' ? windowId : undefined,
            });
            tab = active || null;
          } catch (e) {
            tab = null;
          }
        }
        sendResponse({
          ok: true,
          dataUrl,
          tab: tab ? { title: tab.title || '', url: tab.url || '' } : null,
        });
        break;
      }
      default:
        sendResponse({ ok: false, error: { code: 'unknown_message', message: `未知消息：${msg.type}` } });
    }
  })().catch((err) => {
    try {
      sendResponse({ ok: false, error: { code: 'internal', message: String(err && err.message ? err.message : err) } });
    } catch (e) {
      /* ignore */
    }
  });

  return true; // 异步 sendResponse
});

/* ---------- 生命周期 ---------- */

async function ensurePanelBehavior() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch (e) {
    console.warn('[windowseat] setPanelBehavior 失败：', e && e.message ? e.message : e);
  }
}

function ensureContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'ws-save-selection',
        title: '存到临窗',
        contexts: ['selection'],
      });
      chrome.contextMenus.create({
        id: 'ws-open-panel',
        title: '打开临窗侧边栏',
        contexts: ['page', 'selection'],
      });
    });
  } catch (e) {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensurePanelBehavior();
  ensureContextMenu();
  await loadConn();
  await probePorts(true);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensurePanelBehavior();
  await loadConn();
  await probePorts(true);
  await injectIntoOpenTabs();
});

// 扩展启动较晚时，已在加载的页面会错过静态 content script；这里补注入一次（content.js 自带幂等守卫）。
async function injectIntoOpenTabs(retry = true) {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (!tab || typeof tab.id !== 'number') continue;
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      } catch (e) {
        /* ignore */
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e) {
        /* ignore */
      }
    }
  } catch (e) {
    /* ignore */
  }
  // 页面可能比 SW 更晚完成加载，2.5s 后再补一轮。
  if (retry) setTimeout(() => void injectIntoOpenTabs(false), 2500);
}

// service worker 冷启动时也做一次轻量恢复；探测失败不阻塞。
loadConn().then(() => {
  if (!conn.connected) probePorts(true);
  ensurePanelBehavior();
  injectIntoOpenTabs();
});

// 兜底：标签页加载完成时再补注入一次。扩展启动比页面晚时，静态 content script 会错过；
// content.js 自带 window.__windowseatContentLoaded 幂等守卫，重复注入安全。
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo || changeInfo.status !== 'complete') return;
    if (!tab || !/^https?:/i.test(tab.url || '')) return;
    // 加载完成时标题才是最终标题，再广播一次让面板 chip 显示页面标题（URL 变化时标题往往还是地址）
    broadcastPageChanged(tab);
    chrome.scripting
      .insertCSS({ target: { tabId }, files: ['content.css'] })
      .catch(() => {});
    chrome.scripting
      .executeScript({ target: { tabId }, files: ['content.js'] })
      .catch(() => {});
  });
}

// 页面上下文自动刷新：切换激活标签时广播一次页面变化
if (chrome.tabs && chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(async (info) => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      broadcastPageChanged(tab);
    } catch (e) {
      /* ignore */
    }
  });
}

// 页面 URL 变化（单页应用路由切换）时也广播
if (chrome.tabs && chrome.tabs.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (!changeInfo || !changeInfo.url) return;
    broadcastPageChanged(tab);
  });
}

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    await openPanelForWindow(tab && tab.windowId);
  });
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'open-windowseat') return;
    const windowId = await resolveSenderWindow(null);
    await openPanelForWindow(windowId);
    // 若面板已打开，让它把焦点放到输入框
    chrome.runtime.sendMessage({ type: 'ws/focus-composer' }).catch(() => {});
  });
}

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const windowId = tab && typeof tab.windowId === 'number' ? tab.windowId : await resolveSenderWindow(null);
    if (info.menuItemId === 'ws-open-panel') {
      await openPanelForWindow(windowId);
      return;
    }
    if (info.menuItemId !== 'ws-save-selection') return;
    const page = {
      title: (tab && tab.title) || '',
      url: (tab && tab.url) || '',
      selection: String(info.selectionText || '').slice(0, 4000),
      description: '',
    };
    await pushPending({
      id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      action: 'save',
      page,
      at: Date.now(),
    });
    await openPanelForWindow(windowId);
    await flushPendingToPanel();
  });
}

// 面板打开/关闭时刷新一次连接状态
if (chrome.sidePanel && chrome.sidePanel.onOpened) {
  chrome.sidePanel.onOpened.addListener(() => {
    probePorts(true);
  });
}
