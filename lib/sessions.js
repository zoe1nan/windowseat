// 历史会话元数据：bridge 只保存会话的「标题 / 消息数 / 时间」等轻量信息，
// 不保存消息正文（正文留在 DSH 自己的会话存储里，由 DSH 负责）。
//
// 端点（由 index.js 挂到现有 bridge HTTP server 上，不改 lib/bridge.js 的路由表）：
//   GET    /windowseat/sessions?query=&limit=&before=   历史会话列表（按 updatedAt 倒序，可搜索/分页）
//   POST   /windowseat/sessions/rename                  重命名 { sessionId, title }
//   DELETE /windowseat/sessions/:sessionId              删除单个会话
//
// 写入来源：index.js 在 /windowseat/chat 请求上嗅探 sessionId 与用户文本，
// 调用 recordChat() 累加 messageCount，并在首条消息时写入标题。
//
// 持久化：~/.dsh/windowseat-sessions.json（可用 env WINDOWSEAT_SESSIONS_CONFIG 覆盖），
// 写盘防抖 500ms，先写临时文件再 rename，避免进程中断留下半截 JSON。
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  HttpError,
  corsHeaders,
  readJsonBody,
  sendError,
  sendJson,
  assertRequestAllowed,
} from './http.js'

/** 本模块负责的路径前缀（index.js 据此把请求转进来）。 */
export const SESSIONS_PREFIX = '/windowseat/sessions'

export const SESSIONS_ROUTES = {
  list: '/windowseat/sessions',
  rename: '/windowseat/sessions/rename',
}

/** 默认持久化文件：与 bridge 的端口文件放在同一个 ~/.dsh 目录下。 */
function defaultConfigFile() {
  return process.env.WINDOWSEAT_SESSIONS_CONFIG
    ? path.resolve(process.env.WINDOWSEAT_SESSIONS_CONFIG)
    : path.join(os.homedir(), '.dsh', 'windowseat-sessions.json')
}

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
const MAX_SESSIONS = 500 // 最多保留 500 个会话元数据，超出时丢最旧的
const TITLE_MAX = 30 // 标题 = 首条用户消息前 30 字
const TITLE_MAX_INPUT = 80 // 手动重命名允许的长度
const PERSIST_DEBOUNCE_MS = 500
const FILE_VERSION = 1

/** 相对时间（给日志用，接口本身返回时间戳，格式化交给扩展）。 */
function logDefault(...args) {
  console.log('[windowseat-sessions]', ...args)
}

/**
 * 从用户消息里提炼标题。
 * 扩展的 @本地文件会把「文件上下文」拼在正文前面（末尾带【用户问题】标记），
 * 这里优先取标记之后的内容，并去掉开头的 @文件名 引用。
 * @param {string} raw
 * @returns {string}
 */
export function titleFromText(raw) {
  let text = String(raw || '').trim()
  const marker = text.lastIndexOf('【用户问题】')
  if (marker >= 0) text = text.slice(marker + '【用户问题】'.length)
  text = text.replace(/\s+/g, ' ').trim()
  text = text.replace(/^(?:@\S+\s+)+/, '')
  if (!text) return '（无标题）'
  const chars = Array.from(text)
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX).join('')}…` : text
}

/**
 * 创建会话元数据服务。
 *
 * @param {object} options
 * @param {() => number} options.getPort        当前 bridge 监听端口（Host 校验用）
 * @param {string} [options.configFile]         持久化文件路径
 * @param {(...args: any[]) => void} [options.logger]
 */
export function createSessionsService(options = {}) {
  const getPort = typeof options.getPort === 'function' ? options.getPort : () => 0
  const configFile = options.configFile ? path.resolve(options.configFile) : defaultConfigFile()
  const log = options.logger || ((...args) => logDefault(...args))

  /** @type {Map<string, {sessionId:string,cwd:string,title:string,createdAt:number,updatedAt:number,messageCount:number}>} */
  const sessions = new Map()
  let loaded = false
  let loadPromise = null
  let persistTimer = null
  let writeChain = Promise.resolve()

  /* ---------- 持久化 ---------- */

  function normalizeRecord(item) {
    if (!item || typeof item !== 'object') return null
    const sessionId = typeof item.sessionId === 'string' ? item.sessionId.trim() : ''
    if (!sessionId) return null
    const createdAt = Number(item.createdAt) || Date.now()
    const updatedAt = Number(item.updatedAt) || createdAt
    return {
      sessionId,
      cwd: typeof item.cwd === 'string' ? item.cwd : '',
      title: String(item.title || '').trim().slice(0, TITLE_MAX_INPUT) || '（无标题）',
      createdAt,
      updatedAt,
      messageCount: Math.max(0, Number(item.messageCount) || 0),
    }
  }

  async function loadState() {
    if (loaded) return
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        const content = await fs.readFile(configFile, 'utf8')
        const data = JSON.parse(content)
        const list = data && Array.isArray(data.sessions) ? data.sessions : []
        for (const item of list) {
          const record = normalizeRecord(item)
          if (record) sessions.set(record.sessionId, record)
        }
        log(`已加载 ${sessions.size} 个历史会话（${configFile}）`)
      } catch (err) {
        // 文件不存在 / JSON 损坏：从空状态开始，不阻塞服务
        if (err && err.code !== 'ENOENT') {
          log('读取会话文件失败，按空历史处理：', (err && err.message) || err)
        }
      } finally {
        loaded = true
        loadPromise = null
      }
    })()
    return loadPromise
  }

  /** 防抖落盘：1 次写盘覆盖 500ms 内的多次变更。 */
  function schedulePersist() {
    clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistNow()
    }, PERSIST_DEBOUNCE_MS)
    if (persistTimer.unref) persistTimer.unref()
  }

  async function persistNow() {
    // 串行化，避免两次写盘交错
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        const dir = path.dirname(configFile)
        await fs.mkdir(dir, { recursive: true })
        // 超出上限时丢最久未更新的
        const list = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
        if (list.length > MAX_SESSIONS) {
          for (const record of list.slice(MAX_SESSIONS)) sessions.delete(record.sessionId)
        }
        const payload = {
          version: FILE_VERSION,
          updatedAt: Date.now(),
          sessions: list.slice(0, MAX_SESSIONS),
        }
        const tmp = `${configFile}.${process.pid}.${Date.now()}.tmp`
        await fs.writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 })
        await fs.rename(tmp, configFile)
      })
      .catch((err) => {
        log('写入会话文件失败：', (err && err.message) || err)
      })
    return writeChain
  }

  /** 进程退出前尽力落盘（dispose 时调用）。 */
  async function flush() {
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    await persistNow()
  }

  /* ---------- 写：聊天时记录 ---------- */

  /**
   * 记录一次聊天。sessionId 从 SSE meta 帧里嗅探得到；
   * 首次出现时创建记录并写入标题，之后累加 messageCount。
   *
   * @param {{sessionId?:string,text?:string,cwd?:string}} info
   */
  async function recordChat(info = {}) {
    const sessionId = typeof info.sessionId === 'string' ? info.sessionId.trim() : ''
    if (!sessionId) return null
    await loadState()
    const now = Date.now()
    let record = sessions.get(sessionId)
    if (!record) {
      record = {
        sessionId,
        cwd: typeof info.cwd === 'string' && info.cwd ? info.cwd : process.cwd(),
        title: titleFromText(info.text),
        createdAt: now,
        updatedAt: now,
        messageCount: 1,
      }
      sessions.set(sessionId, record)
      log(`新会话 ${sessionId} 标题=「${record.title}」`)
    } else {
      record.messageCount += 1
      record.updatedAt = now
      // 之前标题是空的（或者首轮没有正文），补上标题
      if ((!record.title || record.title === '（无标题）') && String(info.text || '').trim()) {
        record.title = titleFromText(info.text)
      }
    }
    schedulePersist()
    return { ...record }
  }

  /* ---------- 读：列表 / 重命名 / 删除 ---------- */

  async function listSessions(query, limit, before) {
    await loadState()
    const q = String(query || '').trim().toLowerCase()
    const max = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT))
    const cursor = Number(before) || 0
    const all = [...sessions.values()]
      .filter((item) => (q ? item.title.toLowerCase().includes(q) : true))
      .filter((item) => (cursor ? item.updatedAt < cursor : true))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const page = all.slice(0, max)
    return {
      sessions: page,
      hasMore: all.length > page.length,
      nextBefore: page.length ? page[page.length - 1].updatedAt : null,
      total: sessions.size,
    }
  }

  async function renameSession(sessionId, title) {
    const id = String(sessionId || '').trim()
    if (!id) throw new HttpError(400, 'invalid_session', 'sessionId 不能为空')
    const nextTitle = String(title || '').replace(/\s+/g, ' ').trim()
    if (!nextTitle) throw new HttpError(400, 'invalid_title', '标题不能为空')
    await loadState()
    const record = sessions.get(id)
    if (!record) throw new HttpError(404, 'session_not_found', '会话不存在（可能已被清理）')
    record.title = Array.from(nextTitle).slice(0, TITLE_MAX_INPUT).join('')
    record.updatedAt = Date.now()
    schedulePersist()
    return { ...record }
  }

  async function removeSession(sessionId) {
    const id = String(sessionId || '').trim()
    if (!id) throw new HttpError(400, 'invalid_session', 'sessionId 不能为空')
    await loadState()
    const record = sessions.get(id)
    if (!record) throw new HttpError(404, 'session_not_found', '会话不存在（可能已被清理）')
    sessions.delete(id)
    schedulePersist()
    return { sessionId: id }
  }

  /* ---------- HTTP ---------- */

  async function handleList(req, res, url) {
    const result = await listSessions(
      url.searchParams.get('query'),
      url.searchParams.get('limit'),
      url.searchParams.get('before'),
    )
    sendJson(req, res, 200, { ok: true, ...result })
  }

  async function handleRename(req, res) {
    const body = await readJsonBody(req)
    const record = await renameSession(body.sessionId, body.title)
    sendJson(req, res, 200, { ok: true, session: record })
  }

  async function handleDelete(req, res, url) {
    let id = ''
    try {
      id = decodeURIComponent(url.pathname.slice(`${SESSIONS_PREFIX}/`.length))
    } catch {
      throw new HttpError(400, 'invalid_session_id', '会话 ID 不合法')
    }
    const removed = await removeSession(id)
    sendJson(req, res, 200, { ok: true, ...removed })
  }

  async function dispatch(req, res) {
    // 统一门禁：Host + Origin（与 bridge 同一套规则）
    assertRequestAllowed(req, Number(getPort()) || 0)
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders(req))
      res.end()
      return
    }
    const pathname = url.pathname
    if (pathname === SESSIONS_ROUTES.list && req.method === 'GET') {
      return handleList(req, res, url)
    }
    if (pathname === SESSIONS_ROUTES.rename && req.method === 'POST') {
      return handleRename(req, res)
    }
    if (pathname.startsWith(`${SESSIONS_PREFIX}/`) && req.method === 'DELETE') {
      return handleDelete(req, res, url)
    }
    throw new HttpError(404, 'not_found', `未知路径：${pathname}`)
  }

  async function handleRequest(req, res) {
    try {
      await dispatch(req, res)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const code = err instanceof HttpError ? err.code : 'internal_error'
      if (!(err instanceof HttpError)) log('会话端点异常：', (err && err.message) || err)
      const message = err instanceof HttpError ? err.message : '会话操作失败'
      if (status >= 500) log('请求失败', req.method, req.url, message)
      if (res.headersSent) {
        if (!res.writableEnded) res.end()
        return
      }
      sendError(req, res, status, code, message)
    }
  }

  return {
    configFile,
    handleRequest,
    // 供 index.js 的聊天嗅探器调用
    recordChat,
    // 便于调试 / 测试
    listSessions,
    renameSession,
    removeSession,
    flush,
  }
}
