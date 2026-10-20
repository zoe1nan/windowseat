/* 临窗 Windowseat · content script
 * 划词浮条：解释 / 翻译 / 总结 / 追问 / 存到临窗
 * 全部 UI 放在 Shadow DOM 里，避免影响页面样式；只与 background 通信。
 */

(() => {
  'use strict';
  if (window.__windowseatContentLoaded) return;
  window.__windowseatContentLoaded = true;

  const HOST_ID = 'windowseat-sel-host';
  const MAX_SELECTION = 4000;
  const MAX_PAGE_TEXT = 8000;

  const ACTIONS = [
    { id: 'explain', label: '解释', icon: 'code' },
    { id: 'translate', label: '翻译', icon: 'translate' },
    { id: 'summarize', label: '总结', icon: 'text' },
    { id: 'ask', label: '追问', icon: 'message' },
    { id: 'save', label: '存到临窗', icon: 'whale', accent: true },
  ];

  const ICONS = {
    code: '<path d="M8.5 8.5 5 12l3.5 3.5M15.5 8.5 19 12l-3.5 3.5" />',
    translate:
      '<path d="M3.5 6.5h9M8 4.5v2M10 6.5c-.7 3.6-2.9 6.2-6 8M5.5 10.5c1 2.3 2.6 3.8 4.8 4.7" /><path d="M12.5 19.5 16 10l3.5 9.5M13.7 16.6h4.6" />',
    text: '<path d="M4 6.5h16M4 11h11M4 15.5h16M4 20h8" />',
    message: '<path d="M20 12.2c0 3.8-3.6 6.9-8 6.9-.9 0-1.8-.1-2.6-.4L5 20.5l1.2-3.2C4.8 16 4 14.2 4 12.2 4 8.4 7.6 5.3 12 5.3s8 3.1 8 6.9Z" />',
    whale:
      '<path d="M20.2 8.1c-1.1.1-1.7.6-2.2 1.3-.7-1.6-1.9-2.5-3.6-2.5-1.5 0-2.8.7-3.6 2C9.4 7.9 8 7.4 6.3 8.2 3.9 9.3 2.8 12 3.6 14.6c.8 2.6 3.2 4.2 6 4.2 3.4 0 6-1.9 7.2-4.9.5.4 1 .6 1.8.6 1.4 0 2.4-1 2.4-3.2 0-2-.4-3.2-.8-3.2Z" />',
  };

  let host = null;
  let shadow = null;
  let bar = null;
  let currentRange = null;
  let hideTimer = null;

  /* ---------- 页面信息 ---------- */

  function metaContent(selector) {
    const el = document.querySelector(selector);
    return el && el.content ? String(el.content).trim() : '';
  }

  function pageDescription() {
    return (
      metaContent('meta[name="description"]') ||
      metaContent('meta[property="og:description"]') ||
      metaContent('meta[name="twitter:description"]')
    );
  }

  function selectionText() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
    const text = String(sel).replace(/\s+/g, ' ').trim();
    return text;
  }

  /** 页面正文摘录：优先 main/article，退化为 body；剥掉脚本样式与导航噪音。 */
  function pageExcerpt(maxChars) {
    if (!document.body) return '';
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, svg, nav, header, footer, aside, form, button, iframe')
      .forEach((node) => node.remove());
    const main = clone.querySelector('main, article, [role="main"]') || clone;
    let text = String(main.innerText || main.textContent || '')
      .replace(/\h+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n…（正文已截断）';
  }

  function pageInfo(selection) {
    const text = typeof selection === 'string' ? selection : selectionText();
    return {
      title: document.title || '',
      url: location.href,
      description: pageDescription(),
      selection: text.slice(0, MAX_SELECTION),
      text: pageExcerpt(MAX_PAGE_TEXT),
    };
  }

  /* ---------- Shadow DOM ---------- */

  function icon(name) {
    return (
      '<svg class="ws-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      (ICONS[name] || '') +
      '</svg>'
    );
  }

  function ensureHost() {
    if (host && host.isConnected) return true;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-windowseat', 'selection-toolbar');
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .ws-bar {
        position: absolute; left: 0; top: 0; box-sizing: border-box;
        display: none; align-items: center; gap: 1px;
        padding: 4px; max-width: min(94vw, 460px);
        border-radius: 14px;
        border: 1px solid rgba(77,107,254,.16);
        background: rgba(255,255,255,.96);
        -webkit-backdrop-filter: blur(10px);
        backdrop-filter: blur(10px);
        box-shadow: 0 14px 34px -14px rgba(58,101,194,.42), 0 2px 6px rgba(58,101,194,.10);
        font-family: "Segoe UI","Microsoft YaHei","PingFang SC","Hiragino Sans GB",system-ui,sans-serif;
        font-size: 12px; line-height: 1.6; color: #25324A;
        user-select: none; -webkit-user-select: none;
        pointer-events: auto; /* 宿主是 pointer-events:none，浮条自己接管点击 */
      }
      .ws-bar.ws-show { display: flex; }
      .ws-btn {
        all: unset; box-sizing: border-box; cursor: pointer;
        display: inline-flex; align-items: center; gap: 4px;
        height: 28px; padding: 0 8px; border-radius: 10px;
        color: #25324A; font-size: 12px; font-weight: 500; white-space: nowrap;
        transition: background .12s ease, color .12s ease;
      }
      .ws-btn:hover { background: #EFF4FF; color: #3A65C2; }
      .ws-btn:active { background: #E3ECFF; }
      .ws-btn:focus-visible { outline: 2px solid rgba(77,107,254,.45); outline-offset: 1px; }
      .ws-ic { width: 13px; height: 13px; flex: none; }
      .ws-sep { width: 1px; height: 16px; margin: 0 3px; background: rgba(77,107,254,.16); flex: none; }
      .ws-btn.ws-accent {
        color: #fff; font-weight: 600; padding: 0 10px;
        background: linear-gradient(135deg,#3964FE,#6F8EFF);
        box-shadow: 0 6px 14px -6px rgba(77,107,254,.72);
      }
      .ws-btn.ws-accent:hover { color: #fff; background: linear-gradient(135deg,#3A65C2,#5F82FF); }
      .ws-btn.ws-accent .ws-ic { width: 14px; height: 14px; }
      @media (max-width: 480px) {
        .ws-btn { padding: 0 6px; gap: 3px; }
        .ws-btn.ws-accent { padding: 0 8px; }
      }
    `;

    bar = document.createElement('div');
    bar.className = 'ws-bar';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', '临窗划词操作');
    bar.innerHTML =
      ACTIONS.map(
        (a) =>
          `<button class="ws-btn${a.accent ? ' ws-accent' : ''}" type="button" data-action="${a.id}">` +
          icon(a.icon) +
          `<span>${a.label}</span></button>`,
      ).join('');

    shadow.appendChild(style);
    shadow.appendChild(bar);

    // 浮条内部点击不要穿透到页面
    bar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    bar.addEventListener('mouseup', (e) => {
      e.stopPropagation();
    });
    bar.addEventListener('click', onBarClick);

    (document.body || document.documentElement).appendChild(host);
    return true;
  }

  /* ---------- 位置 ---------- */

  function computeRect() {
    if (!currentRange) return null;
    try {
      const rect = currentRange.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        // 有些页面会给选区返回空矩形，用最后一个 client rect
        const rects = currentRange.getClientRects();
        if (rects && rects.length) return rects[rects.length - 1];
        return null;
      }
      return rect;
    } catch (e) {
      return null;
    }
  }

  function place() {
    if (!bar) return;
    const rect = computeRect();
    if (!rect) {
      hide();
      return;
    }
    const margin = 8;
    const gap = 8;
    const barW = bar.offsetWidth || 320;
    const barH = bar.offsetHeight || 36;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;

    let left = rect.left + rect.width / 2 - barW / 2;
    left = Math.max(margin, Math.min(left, vw - barW - margin));

    let top = rect.top - barH - gap;
    if (top < margin) top = rect.bottom + gap;
    if (top + barH > vh - margin) top = Math.max(margin, vh - barH - margin);

    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
  }

  function show() {
    if (!ensureHost()) return;
    if (!bar.classList.contains('ws-show')) bar.classList.add('ws-show');
    // 先显示再量尺寸，保证首次定位准确
    place();
    requestAnimationFrame(place);
  }

  function hide() {
    if (bar) bar.classList.remove('ws-show');
    currentRange = null;
  }

  function hideSoon() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!selectionText()) hide();
    }, 160);
  }

  /* ---------- 交互 ---------- */

  function captureRange() {
    const sel = window.getSelection();
    const text = selectionText();
    if (!sel || sel.rangeCount === 0 || !text) return false;
    try {
      currentRange = sel.getRangeAt(0).cloneRange();
    } catch (e) {
      return false;
    }
    if (text.length < 2) return false;
    return true;
  }

  function maybeShow() {
    const text = selectionText();
    if (!text || text.length < 2) {
      hide();
      return;
    }
    if (text.length > 20000) return; // 超长选择不弹浮条
    if (!captureRange()) return;
    show();
  }

  function onBarClick(e) {
    const btn = e.target && e.target.closest ? e.target.closest('[data-action]') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.getAttribute('data-action');
    const text = selectionText() || '';
    const page = pageInfo(text);
    hide();
    try {
      chrome.runtime.sendMessage({ type: 'ws/action', action, page }, () => {
        // 读掉 lastError，避免控制台报错
        void chrome.runtime.lastError;
      });
    } catch (err) {
      // 扩展被重载/卸载时 context 失效，静默忽略
    }
  }

  function isInsideToolbar(target) {
    if (!host) return false;
    if (target === host) return true;
    if (target && typeof target.closest === 'function' && target.closest(`#${HOST_ID}`)) return true;
    return false;
  }

  function onMouseUp(e) {
    if (isInsideToolbar(e.target)) return;
    // 等浏览器完成选区更新
    setTimeout(() => {
      if (isInsideToolbar(e.target)) return;
      maybeShow();
    }, 0);
  }

  function onMouseDown(e) {
    if (isInsideToolbar(e.target)) return;
    hideSoon();
  }

  function onKeyUp(e) {
    if (e.key === 'Escape') {
      hide();
      return;
    }
    if (e.shiftKey || e.key === 'Shift' || e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      setTimeout(() => {
        if (selectionText()) maybeShow();
      }, 0);
    }
  }

  function onScrollOrResize() {
    if (bar && bar.classList.contains('ws-show')) place();
  }

  let selectionTimer = null;
  function onSelectionChange() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      if (!selectionText()) hideSoon();
    }, 80);
  }

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keyup', onKeyUp, true);
  document.addEventListener('selectionchange', onSelectionChange, true);
  window.addEventListener('scroll', onScrollOrResize, { capture: true, passive: true });
  window.addEventListener('resize', onScrollOrResize, { passive: true });

  /* ---------- 与 background 通信 ---------- */

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'ws/get-page') {
        sendResponse(pageInfo());
      }
      return false;
    });
  } catch (e) {
    /* 扩展上下文失效时忽略 */
  }
})();
