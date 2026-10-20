// DSH 宿主插件入口：windowseat-bridge
// 在 DSH 进程内自起 127.0.0.1 HTTP server，供 Edge 扩展侧边栏调用。
// 0.1.2 起新增 @本地文件检索：/windowseat/files/* 由 lib/files.js 处理；
// 0.1.2（与 @本地文件同版本）起新增历史会话元数据：/windowseat/sessions* 由 lib/sessions.js 处理，
// 并在 /windowseat/chat 上嗅探 sessionId / 文本，维护标题与消息计数。
// 这里在 bridge server 启动后把请求分发给它们，其余路径原样交回 bridge（不改 lib/bridge.js）。
import { PLUGIN_NAME, PLUGIN_VERSION, createBridge } from './lib/bridge.js'
import { FILES_PREFIX, createFilesService } from './lib/files.js'
import { SESSIONS_PREFIX, createSessionsService } from './lib/sessions.js'

export { createBridge, PLUGIN_NAME, PLUGIN_VERSION }
export { FILES_PREFIX, FILES_ROUTES, createFilesService } from './lib/files.js'
export { SESSIONS_PREFIX, SESSIONS_ROUTES, createSessionsService } from './lib/sessions.js'

export const name = PLUGIN_NAME
export const version = PLUGIN_VERSION

// 不声明 inject：服务通过 ctx.get('sessionController') 晚绑定，
// 避免 sessionController 尚未就绪时插件被延迟加载。
export const inject = []

const CHAT_PATH = '/windowseat/chat'
const MAX_TRACK_BODY = 1024 * 1024 // 与 readJsonBody 的上限保持一致

function pathnameOf(reqUrl) {
  return String(reqUrl || '/').split('?')[0]
}

/** 判断请求是否属于 @本地文件检索的路径。 */
function isFilesRequest(reqUrl) {
  return pathnameOf(reqUrl).startsWith(FILES_PREFIX)
}

/** 判断请求是否属于历史会话元数据的路径。 */
function isSessionsRequest(reqUrl) {
  return pathnameOf(reqUrl).startsWith(SESSIONS_PREFIX)
}

/**
 * 嗅探一次聊天请求，把 sessionId / 用户文本交给会话元数据服务。
 *
 * 为什么要在 HTTP 层嗅探：lib/bridge.js 的聊天逻辑不允许改动，而它内部会创建
 * 会话（sessionId 只出现在 SSE 的 meta 帧里）。这里同时监听请求体的数据与响应
 * 写入，拿到 body.text 和 meta.sessionId 后调用 sessions.recordChat()。
 *
 * 注意：Node 的 IncomingMessage 支持多个 'data' 监听器，bridge 自己的 readJsonBody
 * 同样能收到完整 body，所以这里只是旁路观察，不消费流、不改写任何字节。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {ReturnType<typeof createSessionsService>} sessions
 */
function trackChat(req, res, sessions) {
  let raw = ''
  let tooLarge = false
  let body = null
  let sessionId = ''
  let recorded = false
  let sniffTail = ''
  let finished = false

  function maybeRecord() {
    if (recorded || finished || !sessionId || !body) return
    recorded = true
    finished = true
    const text = typeof body.text === 'string' ? body.text : ''
    Promise.resolve(sessions.recordChat({ sessionId, text, cwd: process.cwd() })).catch((err) => {
      console.error('[windowseat-sessions] 记录聊天失败：', (err && err.message) || err)
    })
  }

  req.on('data', (chunk) => {
    if (tooLarge) return
    if (raw.length + chunk.length > MAX_TRACK_BODY) {
      tooLarge = true
      raw = ''
      return
    }
    raw += chunk
  })

  req.on('end', () => {
    if (tooLarge) return
    try {
      const parsed = JSON.parse(raw || '{}')
      body = parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      body = null
    }
    maybeRecord()
  })

  req.on('error', () => {
    finished = true
  })

  // SSE 帧形如 `data: {"type":"meta","sessionId":"..."}\n\n`，meta 帧很小，
  // 这里按块嗅探；万一分块切开，保留最多 2KB 尾巴拼接一次。
  const sniff = (text) => {
    if (sessionId || !text) return
    const sample = sniffTail + text
    const match =
      /"type"\s*:\s*"meta"[^}]*?"sessionId"\s*:\s*"([^"]+)"/.exec(sample) ||
      /"sessionId"\s*:\s*"([^"]+)"[^}]*?"type"\s*:\s*"meta"/.exec(sample)
    if (match) {
      sessionId = match[1]
      sniffTail = ''
      maybeRecord()
      return
    }
    sniffTail = sample.slice(-2048)
  }

  const originalWrite = res.write
  res.write = function patchedWrite(chunk, encoding, callback) {
    try {
      if (chunk) {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        sniff(text)
      }
    } catch {
      // 嗅探失败不影响正常响应
    }
    return originalWrite.call(this, chunk, encoding, callback)
  }
}

/**
 * 在 bridge 已启动的 http server 上挂扩展路由。
 *
 * bridge 的 request 监听器是 start() 内部的闭包，无法从外部按方法覆盖；
 * 这里把监听器整体替换成「files / sessions 请求交给对应服务，聊天请求先挂嗅探器，
 * 其余请求交回 bridge.handleRequest」。handleRequest 是 bridge 暴露的公开入口，
 * 行为与原来完全一致。
 *
 * @returns {(() => void) | null} 还原函数（dispose 时调用）
 */
function mountExtraRoutes(bridge, files, sessions) {
  const server = bridge.server
  if (!server) return null
  const original = server.listeners('request')
  server.removeAllListeners('request')

  const handler = (req, res) => {
    const pathname = pathnameOf(req.url)
    if (pathname.startsWith(FILES_PREFIX)) {
      void files.handleRequest(req, res)
      return
    }
    if (pathname.startsWith(SESSIONS_PREFIX)) {
      void sessions.handleRequest(req, res)
      return
    }
    if (pathname === CHAT_PATH && req.method === 'POST') {
      try {
        trackChat(req, res, sessions)
      } catch (err) {
        console.error('[windowseat-sessions] 挂载聊天嗅探失败：', (err && err.message) || err)
      }
    }
    // 健康检查 / 会话 / 聊天 / 停止 / 调试：仍然交给 bridge 原本的处理器
    void bridge.handleRequest(req, res)
  }
  server.on('request', handler)

  return () => {
    server.removeListener('request', handler)
    // 还原 bridge 自己的监听器（正常情况下 dispose 紧接着会关掉 server，这里只是保险）
    for (const listener of original) server.on('request', listener)
  }
}

/**
 * 插件装配。server 生命周期挂在 ctx.effect 上：
 * effect 回调返回 disposer，插件卸载/HMR 重载时关闭 server 并清理 SSE 流。
 */
export function apply(ctx, config) {
  const options = config || {}
  const bridge = createBridge({ ctx, ...options })
  const files = createFilesService({
    ctx,
    getPort: () => bridge.port,
    configFile: options.filesConfigFile,
    whitelist: options.filesWhitelist,
  })
  const sessions = createSessionsService({
    ctx,
    getPort: () => bridge.port,
    configFile: options.sessionsConfigFile,
  })

  ctx.effect(() => {
    let detachRoutes = null
    let disposed = false

    bridge
      .start()
      .then(() => {
        if (disposed) return
        detachRoutes = mountExtraRoutes(bridge, files, sessions)
      })
      .catch((err) => {
        console.error('[windowseat-bridge] 启动失败：', (err && err.message) || err)
      })

    return () => {
      disposed = true
      if (detachRoutes) {
        try {
          detachRoutes()
        } catch {
          // 忽略：server 可能已经关闭
        }
        detachRoutes = null
      }
      // 尽量把防抖中的会话元数据落盘（不阻塞卸载）
      try {
        void sessions.flush()
      } catch {
        // 忽略
      }
      bridge.dispose()
    }
  }, 'windowseat-bridge')

  return bridge
}

export default { name, version, inject, apply }
