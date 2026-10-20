#!/usr/bin/env node
/**
 * 临窗 Windowseat · M0 演示启动器
 *
 * 用法：node scripts/start-demo.mjs [--port 9228] [--demo-url http://127.0.0.1:8799/]
 *
 * 为什么需要它：Edge 稳定版会把「命令行/开发者模式加载」的扩展判为
 * DISABLE_UNSUPPORTED_DEVELOPER_EXTENSION（developer mode 关闭时），且 dev mode
 * 开关不会随强杀进程持久化。这个脚本做三件事：
 *   1) 用独立 profile + 命令行加载扩展启动 Edge；
 *   2) 通过 CDP 打开 edge://extensions 调 chrome.developerPrivate 把开发者模式打开
 *      （扩展随即变为 ENABLED）；
 *   3) 用扩展页里的可信点击触发 chrome.sidePanel.open，真实侧栏打开。
 * 上架商店后这些步骤都会消失，用户只需安装扩展。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const EXT = path.join(REPO, 'extension')
const PROFILE = path.join(os.homedir(), '.dsh', 'windowseat-edge-profile')
const PORT = Number(arg('port', '9228'))
const DEMO_URL = arg('demo-url', 'http://127.0.0.1:8799/')
const EXT_ID = 'dkbhbbgajakmcgphebiallphkacekbhh'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function cdpJson(pathname) {
  const r = await fetch(`http://127.0.0.1:${PORT}${pathname}`)
  if (!r.ok) throw new Error(`CDP ${pathname} ${r.status}`)
  return r.json()
}

async function waitCdp(timeoutMs = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      await cdpJson('/json/version')
      return
    } catch {
      await sleep(400)
    }
  }
  throw new Error('等待 Edge 调试端口超时')
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) rej(new Error(msg.error.message))
      else res(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const mid = ++id
      pending.set(mid, { res, rej })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  return { ws, send }
}

async function evaluate(conn, expression) {
  const r = await conn.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed')
  return r.result && r.result.value
}

async function findTarget(pred, timeoutMs = 15000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const list = await cdpJson('/json/list')
    const hit = list.find(pred)
    if (hit) return hit
    await sleep(300)
  }
  return null
}

function launchEdge() {
  if (!fs.existsSync(EDGE)) throw new Error(`找不到 Edge：${EDGE}`)
  if (!fs.existsSync(EXT)) throw new Error(`找不到扩展目录：${EXT}`)
  const argv = [
    `--user-data-dir=${PROFILE}`,
    `--load-extension=${EXT}`,
    `--disable-extensions-except=${EXT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    '--window-size=1600,900',
    DEMO_URL,
  ]
  const child = spawn(EDGE, argv, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
}

async function enableDeveloperModeAndExtension() {
  const tab = await cdpJson(`/json/new?edge://extensions`).catch(() => null)
  // /json/new 需要 PUT，回退到手动新标签
  let target = tab
  if (!target) {
    const conn0 = await connect((await cdpJson('/json/list')).find((t) => t.type === 'page').webSocketDebuggerUrl)
    await conn0.send('Target.createTarget', { url: 'edge://extensions' })
    conn0.ws.close()
    target = await findTarget((t) => t.type === 'page' && (t.url || '').startsWith('edge://extensions'))
  }
  if (!target) throw new Error('打不开 edge://extensions')
  await sleep(1200)
  const conn = await connect(target.webSocketDebuggerUrl)
  const info = await evaluate(
    conn,
    `new Promise((resolve) => {
      try {
        chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () => {
          chrome.developerPrivate.getExtensionsInfo({ includeDisabled: true }, (list) => {
            const me = list.find((e) => e.id === '${EXT_ID}')
            resolve(me ? { state: me.state, disabled: me.state !== 'ENABLED' } : { state: 'missing' })
          })
        })
      } catch (e) {
        resolve({ state: 'error', message: String(e && e.message) })
      }
    })`,
  )
  conn.ws.close()
  return info
}

async function closeTab(target) {
  try {
    const conn = await connect(target.webSocketDebuggerUrl)
    await conn.send('Page.close').catch(() => conn.send('Target.closeTarget', { targetId: target.id }))
    conn.ws.close()
  } catch {
    /* ignore */
  }
}

async function openSidePanel() {
  const pageInfo = (await cdpJson('/json/list')).find((t) => t.type === 'page' && (t.url || '').startsWith('http'))
  if (!pageInfo) throw new Error('演示页未打开')
  // 用扩展页面里的可信点击打开侧边栏（浏览器要求 user gesture）
  const conn0 = await connect(pageInfo.webSocketDebuggerUrl)
  await conn0.send('Target.createTarget', { url: `chrome-extension://${EXT_ID}/sidepanel.html?open=1` })
  conn0.ws.close()
  const extPage = await findTarget(
    (t) => t.type === 'page' && (t.url || '').startsWith(`chrome-extension://${EXT_ID}/sidepanel.html`),
  )
  if (!extPage) throw new Error('扩展页未打开')
  await sleep(800)
  const conn = await connect(extPage.webSocketDebuggerUrl)
  try {
    const rect = await evaluate(
      conn,
      `(() => {
        const b = document.createElement('button');
        b.id = '__ws_open_panel__';
        b.textContent = 'open';
        b.style.cssText = 'position:fixed;left:0;top:0;width:220px;height:64px;z-index:2147483647;background:#4D6BFE;color:#fff;font-size:20px;border:0';
        b.addEventListener('click', () => {
          chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).then(
            () => { window.__wsOpened = 'opened' },
            (e) => { window.__wsOpened = 'error: ' + e.message },
          );
        });
        document.body.appendChild(b);
        const r = b.getBoundingClientRect();
        return { x: 0, y: 0, w: r.width, h: r.height };
      })()`,
    )
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 8, y: 8, button: 'left', clickCount: 1 })
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 8, y: 8, button: 'left', clickCount: 1 })
    await sleep(1200)
    const opened = await evaluate(conn, 'window.__wsOpened || "pending"')
    conn.ws.close()
    await closeTab(extPage)
    return { opened, rect }
  } catch (e) {
    conn.ws.close().catch?.(() => {})
    throw e
  }
}

async function extensionServiceWorkerPresent() {
  try {
    const list = await cdpJson('/json/list')
    return list.some((t) => (t.url || '').startsWith(`chrome-extension://${EXT_ID}/`))
  } catch {
    return false
  }
}

function killProfileEdge() {
  try {
    const ps = [
      "$procs = Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\"",
      '| Where-Object { $_.CommandLine -like ' + "''*windowseat-edge-profile*''" + ' }',
      '| ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      '"killed=" + ($procs | Measure-Object).Count',
    ].join(' ')
    const out = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', timeout: 20000 })
    return (out.stdout || '').trim()
  } catch (e) {
    return 'kill failed: ' + e.message
  }
}

async function launchAndEnableExtension() {
  launchEdge()
  await waitCdp()
  await sleep(1500)
  let info = await enableDeveloperModeAndExtension()
  // 命令行加载的扩展开启开发者模式后，有时要重启一次才变 ENABLED
  if (info.state === 'missing' && !(await extensionServiceWorkerPresent())) {
    console.log('[windowseat] 扩展未就绪，重启一次…')
    killProfileEdge()
    await sleep(1200)
    launchEdge()
    await waitCdp()
    await sleep(1500)
    info = await enableDeveloperModeAndExtension()
  }
  if (info.state === 'missing' && (await extensionServiceWorkerPresent())) {
    info = { state: 'loaded', note: 'service worker 已就绪' }
  }
  return info
}

async function main() {
  console.log('[windowseat] 启动演示 Edge…')
  const info = await launchAndEnableExtension()
  console.log('[windowseat] 扩展状态：', info)
  // 关掉扩展管理页，只留演示页
  const managers = (await cdpJson('/json/list')).filter(
    (t) => t.type === 'page' && (t.url || '').startsWith('edge://extensions'),
  )
  for (const t of managers) await closeTab(t)
  // 演示页重新加载一次，确保 content script 注入
  const demo = (await cdpJson('/json/list')).find((t) => t.type === 'page' && (t.url || '').startsWith('http'))
  if (demo) {
    const c = await connect(demo.webSocketDebuggerUrl)
    await c.send('Page.reload')
    c.ws.close()
    await sleep(1500)
  }
  try {
    const r = await openSidePanel()
    console.log('[windowseat] 侧边栏：', r.opened)
  } catch (e) {
    console.log('[windowseat] 侧边栏自动打开失败（可在页面上点扩展图标）：', e.message)
  }
  console.log('[windowseat] 就绪。演示页：', DEMO_URL)
}

main().catch((e) => {
  console.error('[windowseat] 启动失败：', e.message)
  process.exitCode = 1
})
