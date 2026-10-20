// bridge 核心：HTTP server + 路由 + SSE 流 + 会话/取消 + 生命周期
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { appendFileSync, readFileSync, promises as fs, existsSync } from 'node:fs'
import {
  HttpError,
  assertRequestAllowed,
  corsHeaders,
  readJsonBody,
  sendError,
  sendJson,
  setAllowedOrigins,
} from './http.js'
import { DEFAULT_HOST, DEFAULT_PORT_CANDIDATES, listenFirstAvailable, writePortFile } from './ports.js'
import { composeMessage } from './message.js'

export const PLUGIN_NAME = 'windowseat-bridge'
export const PLUGIN_VERSION = '0.6.0'

const HEARTBEAT_MS = 15000 // SSE 心跳间隔
const IDLE_STREAM_MS = 120000 // 多久没有新输出就判超时（流式回答期间每收到一帧都会重置）
const MAX_STREAM_MS = 600000 // 单条消息绝对上限（防止无限挂起）
const FAST_REASONING_EFFORT = 'low' // 侧栏默认用低思考强度：首字/整体更快，日常解释足够
const MAX_IMAGES = 4 // 每条消息最多附几张截图
const MAX_IMAGE_B64 = 4 * 1024 * 1024 // 单张截图 base64 上限（约 3MB 原图）
const IMAGE_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
const DEFAULT_CWD_CANDIDATES = [process.cwd(), os.homedir()]
const DEBUG_LAST_MAX = 50 // 调试端点保留的最近帧数
const DEBUG_SESSION_FRAME_MAX = 200 // 调试端点保留的本桥会话逐帧记录
const DEBUG_EVENT_MAX = 100 // 调试端点保留的生命周期事件
const DEBUG_HISTORY_MAX = 10 // 调试端点保留的最近结束流
const RECENT_SESSION_MAX = 20 // 记住最近会话，便于观察流结束后才到达的帧
const ROUTES = {
  health: '/windowseat/health',
  session: '/windowseat/session',
  chat: '/windowseat/chat',
  stop: '/windowseat/stop',
  team: '/windowseat/team',
  settings: '/windowseat/settings',
  debug: '/windowseat/debug', // 仅 WINDOWSEAT_DEBUG=1 时启用
}

// debug 模式下日志同时落盘，便于在 GUI/无终端环境 grep
let debugLogFile = null

function writeLog(level, args) {
  const text = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ')
  const line = `[windowseat-bridge] ${text}`
  if (level === 'warn') console.warn(line)
  else if (level === 'error') console.error(line)
  else console.log(line)
  if (!debugLogFile) return
  try {
    appendFileSync(debugLogFile, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // 落盘失败不影响主流程
  }
}

const log = {
  info: (...args) => writeLog('info', args),
  warn: (...args) => writeLog('warn', args),
}

function envPorts() {
  const raw = process.env.WINDOWSEAT_BRIDGE_PORTS
  if (!raw) return undefined
  const ports = raw
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
  return ports.length ? ports : undefined
}

/** 归一化 reasoning effort：合法值才返回，否则空串（跳过 fast 选择）。 */
function normalizeEffort(value) {
  const v = String(value || '').trim().toLowerCase()
  return ['off', 'low', 'high', 'max'].includes(v) ? v : ''
}

/** 毫秒类 env 覆盖：正整数才算数，非法值返回 undefined。 */
function envMs(name) {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number.parseInt(String(raw).trim(), 10)
  return Number.isFinite(value) && value > 0 ? value : undefined
}

function defaultPortFile() {
  return process.env.WINDOWSEAT_BRIDGE_PORT_FILE || path.join(os.homedir(), '.dsh', 'windowseat-port')
}

/** 调试开关：env WINDOWSEAT_DEBUG=1，或存在 ~/.dsh/windowseat-debug 标记文件（便于 HMR 后开启，无需重启 DSH）。 */
function debugMarkerExists() {
  try {
    return existsSync(path.join(os.homedir(), '.dsh', 'windowseat-debug'))
  } catch {
    return false
  }
}

/** 从 agent 事件 payload 里取会话 id；不同事件的 payload 形状略有差异。 */
function sessionIdOfAgentPayload(payload) {
  const agent = payload && payload.agent
  if (!agent) return ''
  const session = agent.session
  if (session && typeof session.id === 'string') return session.id
  if (typeof agent.id === 'string') return agent.id
  return ''
}

/**
 * @param {{
 *   ctx: any,
 *   host?: string,
 *   portCandidates?: number[],
 *   portFile?: string,
 *   cwdCandidates?: string[],
 *   heartbeatMs?: number,
 *   idleMs?: number,
 *   reasoningEffort?: string,
 *   maxStreamMs?: number,
 *   settingsFile?: string,
 *   debug?: boolean,
 * }} options
 */
export function createBridge(options) {
  const ctx = options?.ctx
  if (!ctx) throw new Error('createBridge 需要 ctx')
  const host = options.host || DEFAULT_HOST
  // 只信任钉了 manifest.key 的本扩展来源；可用配置/环境变量追加开发来源
  const allowedOrigins = [
    ...(Array.isArray(options.allowedOrigins) ? options.allowedOrigins : []),
    ...String(process.env.WINDOWSEAT_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ]
  setAllowedOrigins(allowedOrigins)
  const portCandidates = options.portCandidates || envPorts() || DEFAULT_PORT_CANDIDATES
  const portFile = options.portFile || defaultPortFile()
  const cwdCandidates = options.cwdCandidates || [process.env.WINDOWSEAT_CWD, ...DEFAULT_CWD_CANDIDATES, process.cwd()].filter(Boolean)
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS
  const idleMs = options.idleMs ?? envMs('WINDOWSEAT_IDLE_MS') ?? IDLE_STREAM_MS
  const maxStreamMs = options.maxStreamMs ?? envMs('WINDOWSEAT_MAX_MS') ?? MAX_STREAM_MS
  const settingsFile =
    options.settingsFile ||
    process.env.WINDOWSEAT_SETTINGS_FILE ||
    path.join(os.homedir(), '.dsh', 'windowseat-settings.json')
  let persistedSettings = {}
  try {
    persistedSettings = JSON.parse(readFileSync(settingsFile, 'utf8')) || {}
  } catch {
    persistedSettings = {}
  }
  let reasoningEffortDefault =
    normalizeEffort(options.reasoningEffort ?? persistedSettings.reasoningEffort) ||
    normalizeEffort(process.env.WINDOWSEAT_REASONING_EFFORT) ||
    FAST_REASONING_EFFORT
  const debugEnabled =
    options.debug !== undefined ? Boolean(options.debug) : process.env.WINDOWSEAT_DEBUG === '1' || debugMarkerExists()
  // debug 模式下把日志写文件（默认 ~/.dsh/windowseat-bridge.log），便于 grep
  debugLogFile = debugEnabled
    ? process.env.WINDOWSEAT_LOG_FILE || path.join(os.homedir(), '.dsh', 'windowseat-bridge.log')
    : null

  /** 调试统计：确认事件订阅、帧匹配与轮次边界是否真的收到。 */
  const debugState = {
    framesSeen: 0,
    framesMatched: 0,
    framesUnmatched: 0,
    agentStatusSeen: 0,
    sessionEventsSeen: 0,
    apiStatusSeen: 0,
    errorsSeen: 0,
    last: [],
    sessionFrames: [],
    events: [],
    history: [],
    recentSessions: [],
  }

  function rememberList(list, entry, max) {
    if (!debugEnabled) return
    list.push({ at: Date.now(), ...entry })
    while (list.length > max) list.shift()
  }

  /** 记住本桥使用过的会话（结束也保留，便于调试结束后到达的帧）。 */
  function rememberSession(sessionId) {
    if (!debugEnabled || !sessionId) return
    const list = debugState.recentSessions
    const index = list.indexOf(sessionId)
    if (index !== -1) list.splice(index, 1)
    list.push(sessionId)
    while (list.length > RECENT_SESSION_MAX) list.shift()
  }

  function isKnownSessionAttempt(attemptId) {
    for (const sessionId of debugState.recentSessions) {
      if (attemptId.startsWith(`${sessionId}:`)) return true
    }
    return false
  }

  function describeFrame(frame, matched) {
    const chunk = frame.type === 'chunk' ? frame.chunk : null
    const text = chunk && typeof chunk.text === 'string' ? chunk.text.slice(0, 80) : undefined
    return {
      type: frame.type,
      attemptId: frame.attemptId,
      chunkType: chunk ? chunk.type : undefined,
      text,
      outcomeKind: frame.type === 'end' && frame.outcome ? frame.outcome.kind : undefined,
      eventType: frame.type === 'end' && frame.outcome ? frame.outcome.eventType : undefined,
      matched,
    }
  }

  function rememberFrame(frame, matched) {
    if (!debugEnabled) return
    rememberList(debugState.last, describeFrame(frame, matched), DEBUG_LAST_MAX)
  }

  function rememberSessionFrame(frame, matched) {
    if (!debugEnabled) return
    const attemptId = frame.attemptId
    const cut = attemptId.lastIndexOf(':')
    rememberList(
      debugState.sessionFrames,
      { ...describeFrame(frame, matched), sessionId: cut > 0 ? attemptId.slice(0, cut) : attemptId },
      DEBUG_SESSION_FRAME_MAX,
    )
  }

  function rememberEvent(kind, detail) {
    if (!debugEnabled) return
    rememberList(debugState.events, { kind, ...detail }, DEBUG_EVENT_MAX)
  }

  /** @type {import('node:http').Server | null} */
  let server = null
  let port = 0
  let triedPorts = []
  let offStreamListener = null
  let offAgentStatusListener = null
  let offSessionEventListener = null
  let offApiStatusListener = null
  let offErrorListener = null
  let disposed = false
  let starting = null
  let cwdPromise = null
  /** sessionId -> collector */
  const collectors = new Map()
  /** 已经为哪些 session 安装过快速思考强度（避免每次提问都写配置）。 */
  const fastSelectionApplied = new Set()

  //#region 服务与目录
  function sessionController() {
    const sc = ctx.get('sessionController')
    return sc && typeof sc.prompt === 'function' ? sc : null
  }

  function requireSessionController() {
    const sc = sessionController()
    if (!sc) throw new HttpError(503, 'service_unavailable', 'sessionController 不可用')
    return sc
  }

  async function resolveCwd() {
    if (!cwdPromise) {
      cwdPromise = (async () => {
        for (const candidate of cwdCandidates) {
          try {
            const stat = await fs.stat(candidate)
            if (stat.isDirectory()) return candidate
          } catch {
            // 候选目录不存在，继续
          }
        }
        return process.cwd()
      })()
    }
    return cwdPromise
  }
  //#endregion

  //#region SSE
  function startStream(req, res, sessionId, requestId) {
    const collector = {
      res,
      sessionId,
      requestId,
      startedAt: Date.now(),
      deltas: 0,
      chars: 0,
      chunkTypes: {},
      finished: false,
      stopRequested: false,
      abortedByClient: false,
      sawRunning: false, // 是否见过该 agent 进入 running（避免上一轮 idle 误判为本轮完成）
      turnStarted: false, // 是否见过本轮 turn/start
      lastEnd: null,
      heartbeat: null,
      idleTimer: null,
      hardTimer: null,
      lastActivityAt: 0,
      ac: new AbortController(),
    }
    res.writeHead(200, {
      ...corsHeaders(req),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    if (typeof res.flushHeaders === 'function') res.flushHeaders()

    collector.heartbeat = setInterval(() => {
      if (!collector.finished) res.write(': ping\n\n')
    }, heartbeatMs)
    collector.heartbeat.unref?.()

    // 空闲超时：收到任何本会话的流式帧都会重置；只有「长时间完全没有新内容」才判超时。
    // 绝对上限：防止模型卡在无输出又不报错的极端情况下无限挂起。
    collector.lastActivityAt = Date.now()
    armIdleTimer(collector)
    collector.hardTimer = setTimeout(() => {
      if (collector.finished) return
      void abortStream(collector, 'hard')
    }, maxStreamMs)
    collector.hardTimer.unref?.()

    // 客户端断开（或响应已结束）：清理并中止后端请求。
    // 用 res 的 close 而非 req 的：POST body 读完时 req 可能提前 close。
    res.on('close', () => {
      if (collector.finished) return
      collector.abortedByClient = true
      collector.ac.abort()
      void cancelQuietly(collector.sessionId, collector.requestId)
      finish(collector, null)
    })

    collectors.set(sessionId, collector)
    rememberSession(sessionId)
    writeFrame(collector, { type: 'meta', sessionId })
    return collector
  }

  function writeFrame(collector, frame) {
    if (collector.finished) return
    try {
      collector.res.write(`data: ${JSON.stringify(frame)}\n\n`)
    } catch {
      // 连接已断，交给 close/end 清理
    }
  }

  /** 重置空闲计时器（每收到一帧本会话的流式输出或工具事件都调用）。 */
  function touchStream(collector) {
    if (!collector || collector.finished) return
    collector.lastActivityAt = Date.now()
    armIdleTimer(collector)
  }

  function armIdleTimer(collector) {
    if (collector.finished) return
    if (collector.idleTimer) clearTimeout(collector.idleTimer)
    collector.idleTimer = setTimeout(() => {
      if (collector.finished) return
      void abortStream(collector, 'idle')
    }, idleMs)
    collector.idleTimer.unref?.()
  }

  /** 超时收尾：区分「空闲超时」和「绝对上限」，给出可操作的文案。 */
  async function abortStream(collector, reason) {
    if (collector.finished) return
    const idleSeconds = Math.round(idleMs / 1000)
    const totalSeconds = Math.round((Date.now() - collector.startedAt) / 1000)
    collector.ac.abort()
    void cancelQuietly(collector.sessionId, collector.requestId)
    const message =
      reason === 'idle'
        ? `等待回复超时（${idleSeconds} 秒没有新内容，已停止本轮；可重试或换个更具体的问法）`
        : `等待回复超时（本轮已持续 ${totalSeconds} 秒，达到单条消息上限；可重试或拆成更小的问题）`
    log.warn(`chat timeout reason=${reason} session=${collector.sessionId} 用时=${totalSeconds}s deltas=${collector.deltas}`)
    finish(collector, { type: 'error', code: 'timeout', message, reason })
  }

  /** 收尾一条 SSE 流；frame 为 null 表示连接已断、只清理不发帧。 */
  function finish(collector, frame) {
    if (collector.finished) return
    collector.finished = true
    if (collector.heartbeat) clearInterval(collector.heartbeat)
    if (collector.idleTimer) clearTimeout(collector.idleTimer)
    if (collector.hardTimer) clearTimeout(collector.hardTimer)
    if (collectors.get(collector.sessionId) === collector) collectors.delete(collector.sessionId)
    const cost = Date.now() - collector.startedAt
    rememberList(
      debugState.history,
      {
        sessionId: collector.sessionId,
        requestId: collector.requestId,
        deltas: collector.deltas,
        chars: collector.chars,
        chunkTypes: { ...collector.chunkTypes },
        closeFrame: frame ? frame.type : 'disconnect',
        closeCode: frame && frame.code,
        sawRunning: collector.sawRunning,
        turnStarted: collector.turnStarted,
        lastEnd: collector.lastEnd,
        startedAt: collector.startedAt,
        finishedAt: Date.now(),
      },
      DEBUG_HISTORY_MAX,
    )
    if (!frame) {
      log.info(`chat abort session=${collector.sessionId} deltas=${collector.deltas} chars=${collector.chars} 用时=${cost}ms`)
      return
    }
    log.info(
      `chat ${frame.type} session=${collector.sessionId} deltas=${collector.deltas} chars=${collector.chars} 用时=${cost}ms` +
        (frame.type === 'error' ? ` code=${frame.code}` : ''),
    )
    try {
      if (!collector.res.writableEnded) {
        collector.res.write(`data: ${JSON.stringify(frame)}\n\n`)
        collector.res.end()
      }
    } catch {
      // 忽略：连接已断
    }
  }

  function finishError(collector, code, message) {
    finish(collector, { type: 'error', code, message })
  }

  /** attemptId = `${sessionId}:${attempt}`；sessionId 不含冒号，用前缀匹配。 */
  function findCollectorByAttempt(attemptId) {
    for (const collector of collectors.values()) {
      if (attemptId.startsWith(`${collector.sessionId}:`)) return collector
    }
    return null
  }
  //#endregion

  //#region 事件订阅
  function onAssistantStream(payload) {
    const frame = payload && typeof payload === 'object' ? payload.frame : null
    if (!frame || typeof frame !== 'object' || typeof frame.attemptId !== 'string') return
    debugState.framesSeen += 1
    const collector = findCollectorByAttempt(frame.attemptId)
    const known = isKnownSessionAttempt(frame.attemptId)
    if (!collector || collector.finished) {
      // 不是本桥活动会话的帧（别的会话/已结束的流），忽略但记录供调试
      debugState.framesUnmatched += 1
      rememberFrame(frame, false)
      if (known) rememberSessionFrame(frame, false)
      return
    }
    debugState.framesMatched += 1
    rememberFrame(frame, true)
    if (known) rememberSessionFrame(frame, true)
    // 任何本会话的流式帧都算「有进展」：思考/工具调用期间不应触发空闲超时。
    touchStream(collector)

    if (frame.type === 'chunk') {
      const chunk = frame.chunk
      if (chunk && typeof chunk.type === 'string') {
        collector.chunkTypes[chunk.type] = (collector.chunkTypes[chunk.type] || 0) + 1
      }
      if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
        collector.deltas += 1
        collector.chars += chunk.text.length
        writeFrame(collector, { type: 'delta', text: chunk.text })
      }
      // reasoning-delta / tool-call-delta 等其余 chunk 类型 M0 忽略
      return
    }
    if (frame.type !== 'end') return

    // end 只是一个 assistant attempt 的结束，一个 turn 可能包含多个 attempt
    //（多步/tool call），不能当作整轮完成；只记录，等 turn/end 或 agent idle。
    const kind = frame.outcome && frame.outcome.kind
    collector.lastEnd = {
      attemptId: frame.attemptId,
      outcomeKind: kind,
      eventType: frame.outcome && frame.outcome.eventType,
    }
    rememberEvent('end', { sessionId: collector.sessionId, ...collector.lastEnd })
    if (kind === 'error') {
      const message = (frame.outcome.error && (frame.outcome.error.message || frame.outcome.error.code)) || 'agent 出错'
      finishError(collector, 'agent_error', String(message))
    }
    // committed / abandoned：继续等整轮结束信号（turn/end 或 agent idle）
  }

  /** agent 生命周期状态（调试用；完成判断主要走 api-session/status）。 */
  function onAgentStatus(payload) {
    debugState.agentStatusSeen += 1
    const sessionId = sessionIdOfAgentPayload(payload)
    if (!sessionId) return
    const collector = collectors.get(sessionId)
    if (collector) {
      if (payload.status === 'running') collector.sawRunning = true
    }
    if (debugEnabled && (collector || debugState.recentSessions.includes(sessionId))) {
      rememberEvent('agent-status', { sessionId, status: payload.status })
    }
  }

  /** 持久化会话事件：turn/start / turn/end 是整轮边界（turn/end 才代表完成）。 */
  function onSessionEvent(session, event) {
    debugState.sessionEventsSeen += 1
    const sessionId =
      (session && typeof session.id === 'string' && session.id) ||
      (session && session.header && typeof session.header.id === 'string' && session.header.id) ||
      ''
    if (!sessionId || !event || typeof event.type !== 'string') return
    const collector = collectors.get(sessionId)
    const interesting = event.type === 'turn/start' || event.type === 'turn/end'
    if (debugEnabled && interesting && (collector || debugState.recentSessions.includes(sessionId))) {
      rememberEvent('session-event', {
        sessionId,
        eventType: event.type,
        turn: event.data && event.data.turn,
        reason: event.data && event.data.reason,
      })
    }
    if (!collector) return
    if (event.type === 'turn/start') {
      collector.turnStarted = true
    } else if (event.type === 'turn/end' && collector.turnStarted) {
      finish(collector, { type: 'done', ok: true })
    }
  }

  /** session-controller 广播的会话状态：running=false 表示该 agent 整轮结束。 */
  function onApiSessionStatus(sessionId, running) {
    debugState.apiStatusSeen += 1
    if (typeof sessionId !== 'string' || !sessionId) return
    const collector = collectors.get(sessionId)
    if (!collector) return
    if (running === true) {
      collector.sawRunning = true
      if (debugEnabled) rememberEvent('api-status', { sessionId, running: true })
      return
    }
    if (debugEnabled) rememberEvent('api-status', { sessionId, running: false })
    // 必须先见过 running，避免上一轮结束的 idle 迟到时误判
    if (collector.sawRunning) finish(collector, { type: 'done', ok: true })
  }

  /** agent 运行错误：直接以 SSE error 结束本轮。 */
  function onAgentError(payload) {
    debugState.errorsSeen += 1
    const sessionId = sessionIdOfAgentPayload(payload)
    if (!sessionId) return
    const collector = collectors.get(sessionId)
    if (!collector) return
    const error = payload && payload.error
    const message = String(
      (error && (error.message || error.code)) || (typeof error === 'string' ? error : '') || 'agent 出错',
    )
    if (debugEnabled) rememberEvent('agent-error', { sessionId, message })
    finishError(collector, 'agent_error', message)
  }

  /** session-controller 广播的会话错误（通常与 agent/error 同时出现，先到先结束）。 */
  function onApiSessionError(sessionId, error) {
    debugState.errorsSeen += 1
    if (typeof sessionId !== 'string' || !sessionId) return
    const collector = collectors.get(sessionId)
    if (!collector) return
    const message = String(
      (error && (error.message || error.code)) ||
        (Array.isArray(error) ? error.map((e) => (e && (e.message || e.code)) || String(e)).join('; ') : '') ||
        (typeof error === 'string' ? error : '') ||
        'agent 出错',
    )
    if (debugEnabled) rememberEvent('api-error', { sessionId, message })
    finishError(collector, 'agent_error', message)
  }
  //#endregion

  //#region 取消
  async function cancelQuietly(sessionId, requestId) {
    const sc = sessionController()
    if (!sc || typeof sc.cancel !== 'function') return
    try {
      await sc.cancel({ sessionId })
      return
    } catch {
      // 兜底：个别实现要求带 requestId
    }
    if (requestId) {
      try {
        await sc.cancel({ sessionId, requestId })
      } catch {
        // 会话可能已结束，忽略
      }
    }
  }
  //#endregion

  //#region 路由处理
  async function handleHealth(req, res) {
    sendJson(req, res, 200, {
      ok: true,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      pid: process.pid,
      at: Date.now(),
      idleMs,
      maxStreamMs,
      reasoningEffort: reasoningEffortDefault,
    })
  }

  /**
   * 侧栏默认用更快的思考强度（默认 low）：创建 Session 后为下一轮安装该选择，
   * 再把全局默认还原，避免影响用户在 DSH 主界面的默认模型设置。
   * 可用 WINDOWSEAT_REASONING_EFFORT=off|low|high|max 覆盖。
   */
  async function preferFastReasoning(sessionId) {
    if (fastSelectionApplied.has(sessionId)) return
    const wanted = reasoningEffortDefault
    if (!wanted) return
    const defaults = ctx.get('agentDefaultModel')
    const original =
      defaults && typeof defaults.currentSelection === 'function' ? defaults.currentSelection() : null
    if (!original || !original.provider || !original.model) return
    const current = original.reasoningEffort || 'high'
    if (current === wanted) return
    const sc = requireSessionController()
    try {
      await sc.selectModel({
        sessionId,
        provider: original.provider,
        model: original.model,
        reasoningEffort: wanted,
      })
      fastSelectionApplied.add(sessionId)
      log.info(`fast reasoning session=${sessionId} ${current}→${wanted}`)
    } catch (error) {
      log.warn(`fast reasoning skipped session=${sessionId}: ${(error && error.message) || String(error)}`)
      return
    }
    // selectModel 会把选择异步写成全局默认；这里退避重试还原，主界面默认保持原样。
    if (typeof defaults.saveSelection !== 'function') return
    for (const delay of [600, 1500, 3000]) {
      try {
        await new Promise((resolve) => setTimeout(resolve, delay))
        await defaults.saveSelection(original)
        log.info(`fast reasoning restored default (${delay}ms): ${current}`)
        return
      } catch (error) {
        const msg = (error && error.message) || String(error)
        if (!/nested/i.test(msg)) log.warn(`fast reasoning restore failed: ${msg}`)
      }
    }
    log.warn('fast reasoning restore gave up; 用户可在 profile cordis.patch.yml 检查 agent-default-model')
  }

  async function handleSession(req, res) {
    const sc = requireSessionController()
    const created = await sc.create({ cwd: await resolveCwd() })
    const sessionId = created && created.sessionId
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new HttpError(502, 'create_failed', 'sessionController.create 未返回 sessionId')
    }
    await preferFastReasoning(sessionId)
    sendJson(req, res, 200, { ok: true, sessionId })
  }

  /**
   * 归一化侧栏附带的截图：只接受纯 base64（不含 data: 前缀），
   * 单张上限约 3MB 原图，最多 4 张，mediaType 白名单。
   */
  function normalizeImages(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return []
    const out = []
    for (const item of raw.slice(0, MAX_IMAGES)) {
      if (!item || typeof item !== 'object') continue
      const data = typeof item.data === 'string' ? item.data.replace(/\s+/g, '') : ''
      if (!data) continue
      if (data.length > MAX_IMAGE_B64) {
        throw new HttpError(413, 'image_too_large', '截图过大（单张上限约 3MB）')
      }
      const mediaType =
        typeof item.mediaType === 'string' && IMAGE_MEDIA_TYPES.has(item.mediaType)
          ? item.mediaType
          : 'image/png'
      const name =
        typeof item.name === 'string' && item.name.trim()
          ? item.name.trim().slice(0, 80)
          : 'screenshot.png'
      out.push({ mediaType, data, name })
    }
    return out
  }

  async function handleChat(req, res) {
    const body = await readJsonBody(req)
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) throw new HttpError(400, 'invalid_text', 'text 不能为空')
    const page = body.page && typeof body.page === 'object' ? body.page : null
    const images = normalizeImages(body.images)
    const requestId = randomUUID()
    const sc = requireSessionController()

    let sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (sessionId) {
      if (collectors.has(sessionId)) throw new HttpError(409, 'session_busy', '该会话已有进行中的消息')
      await preferFastReasoning(sessionId)
    } else {
      // 未指定会话时先建会话，再开 SSE（meta 需要带上 sessionId）
      const created = await sc.create({ cwd: await resolveCwd() })
      sessionId = created && created.sessionId
      if (typeof sessionId !== 'string' || !sessionId) {
        throw new HttpError(502, 'create_failed', 'sessionController.create 未返回 sessionId')
      }
      await preferFastReasoning(sessionId)
    }

    const collector = startStream(req, res, sessionId, requestId)
    log.info(`chat start session=${sessionId} requestId=${requestId} 文本长度=${text.length} 截图=${images.length} 页面=${page ? `${page.title || ''} | text=${(page.text || '').length} sel=${(page.selection || '').length}` : 'null'}`)
    const content = composeMessage(text, page)
    const parts = [{ type: 'text', text: content }]
    for (const image of images) {
      parts.push({ type: 'image', mediaType: image.mediaType, data: image.data, name: image.name })
    }
    try {
      // prompt 只代表「已入队」，返回后不能当作本轮完成；
      // 完成由整轮边界（session/event 的 turn/end 或 api-session/status 的 idle）决定。
      await sc.prompt({ sessionId, content: parts, requestId }, collector.ac.signal)
    } catch (err) {
      if (collector.finished) return
      if (collector.stopRequested) {
        finish(collector, { type: 'stopped' })
      } else if (collector.abortedByClient) {
        finish(collector, null)
      } else if (err && err.name === 'AbortError') {
        finish(collector, { type: 'stopped' })
      } else {
        finishError(collector, 'prompt_failed', (err && err.message) || 'prompt 调用失败')
      }
    }
  }

  async function handleStop(req, res) {
    const body = await readJsonBody(req)
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
    if (!sessionId) throw new HttpError(400, 'invalid_session', 'sessionId 不能为空')
    const requestId = typeof body.requestId === 'string' ? body.requestId : ''

    const collector = collectors.get(sessionId)
    if (collector && (!requestId || collector.requestId === requestId)) {
      collector.stopRequested = true
      finish(collector, { type: 'stopped' })
      collector.ac.abort()
      void cancelQuietly(sessionId, collector.requestId)
    } else {
      // 没有本地活动的流也尝试取消，兼容重载后残留的会话
      void cancelQuietly(sessionId, requestId)
    }
    sendJson(req, res, 200, { ok: true })
  }

  /** 侧栏设置：目前只有「思考强度」，写入 ~/.dsh/windowseat-settings.json 后立即对新建会话生效。 */
  async function saveSettings(patch) {
    const next = { ...persistedSettings, ...patch, updatedAt: new Date().toISOString() }
    persistedSettings = next
    const tmp = `${settingsFile}.${process.pid}.tmp`
    await fs.mkdir(path.dirname(settingsFile), { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    await fs.rename(tmp, settingsFile)
    return next
  }

  async function handleSettings(req, res) {
    if (req.method === 'GET') {
      sendJson(req, res, 200, {
        ok: true,
        reasoningEffort: reasoningEffortDefault,
        efforts: ['off', 'low', 'high', 'max'],
        idleMs,
        maxStreamMs,
        settingsFile,
        version: PLUGIN_VERSION,
      })
      return
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '仅支持 GET / POST')
    const body = await readJsonBody(req)
    if (body.reasoningEffort !== undefined) {
      const effort = normalizeEffort(body.reasoningEffort)
      if (!effort) throw new HttpError(400, 'invalid_effort', 'reasoningEffort 只能是 off / low / high / max')
      reasoningEffortDefault = effort
      fastSelectionApplied.clear()
      await saveSettings({ reasoningEffort: effort })
      log.info(`settings reasoningEffort=${effort}（已持久化，下一轮会话生效）`)
    }
    sendJson(req, res, 200, {
      ok: true,
      reasoningEffort: reasoningEffortDefault,
      idleMs,
      maxStreamMs,
      settingsFile,
    })
  }

  /**
   * 读取某会话的协同小队投影（agentTeam）：成员 phase + 共享任务板。
   * 侧栏只读展示；会话未挂 Team 时返回 lead 单成员与空任务板。
   */
  async function handleTeam(req, res) {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port || 34281}`)
    const sessionId = (url.searchParams.get('sessionId') || '').trim()
    if (!sessionId) throw new HttpError(400, 'invalid_session', 'sessionId 不能为空')
    const sc = requireSessionController()
    if (typeof sc.projections !== 'function') {
      throw new HttpError(501, 'unsupported', '当前 DSH 版本不支持 session projections')
    }
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 5000)
    let snapshot = null
    try {
      snapshot = await sc.projections({ sessionId }, ac.signal)
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new HttpError(504, 'team_timeout', '读取协同小队状态超时')
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    const values = snapshot && snapshot.values ? snapshot.values : {}
    const team = values.agentTeam && typeof values.agentTeam === 'object' ? values.agentTeam : null
    sendJson(req, res, 200, {
      ok: true,
      sessionId,
      kind: snapshot && snapshot.kind ? snapshot.kind : null,
      asOfSeq: snapshot && typeof snapshot.asOfSeq === 'number' ? snapshot.asOfSeq : null,
      team: team || {
        members: [{ id: 'lead', name: 'lead', role: 'lead', phase: 'active' }],
        tasks: [],
        note: '当前会话未启用协同小队',
      },
    })
  }

  /** 调试端点：仅 WINDOWSEAT_DEBUG=1 时启用，用于确认事件订阅、帧匹配与整轮边界。 */
  async function handleDebug(req, res) {
    if (!debugEnabled) throw new HttpError(404, 'not_found', '调试端点未启用（需 WINDOWSEAT_DEBUG=1）')
    sendJson(req, res, 200, {
      ok: true,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      pid: process.pid,
      listening: port,
      subscription: {
        assistantStream: Boolean(offStreamListener),
        agentStatus: Boolean(offAgentStatusListener),
        sessionEvent: Boolean(offSessionEventListener),
        apiSessionStatus: Boolean(offApiStatusListener),
        error: Boolean(offErrorListener),
      },
      framesSeen: debugState.framesSeen,
      framesMatched: debugState.framesMatched,
      framesUnmatched: debugState.framesUnmatched,
      agentStatusSeen: debugState.agentStatusSeen,
      sessionEventsSeen: debugState.sessionEventsSeen,
      apiStatusSeen: debugState.apiStatusSeen,
      errorsSeen: debugState.errorsSeen,
      collectors: [...collectors.values()].map((c) => ({
        sessionId: c.sessionId,
        requestId: c.requestId,
        deltas: c.deltas,
        chars: c.chars,
        chunkTypes: c.chunkTypes,
        sawRunning: c.sawRunning,
        turnStarted: c.turnStarted,
        lastEnd: c.lastEnd,
        stopRequested: c.stopRequested,
        ageMs: Date.now() - c.startedAt,
      })),
      recentSessions: debugState.recentSessions,
      history: debugState.history,
      events: debugState.events,
      sessionFrames: debugState.sessionFrames,
      last: debugState.last,
      logFile: debugLogFile,
    })
  }
  //#endregion

  /** 统一的请求入口（也便于测试直接调用）。 */
  async function handleRequest(req, res) {
    try {
      // 统一门禁：Host + Origin（拦截跨站 CSRF 与非白名单扩展）
      assertRequestAllowed(req, port)
      const pathname = (req.url || '/').split('?')[0]

      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req))
        res.end()
        return
      }
      if (pathname === ROUTES.health) {
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '仅支持 GET')
        log.info(
          `health 探测：origin=${req.headers.origin || '-'} sec-fetch-site=${req.headers['sec-fetch-site'] || '-'} ua=${String(req.headers['user-agent'] || '').slice(0, 80)}`
        )
        await handleHealth(req, res)
      } else if (pathname === ROUTES.session) {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '仅支持 POST')
        await handleSession(req, res)
      } else if (pathname === ROUTES.chat) {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '仅支持 POST')
        await handleChat(req, res)
      } else if (pathname === ROUTES.stop) {
        if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '仅支持 POST')
        await handleStop(req, res)
      } else if (pathname === ROUTES.team) {
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '仅支持 GET')
        await handleTeam(req, res)
      } else if (pathname === ROUTES.settings) {
        await handleSettings(req, res)
      } else if (pathname === ROUTES.debug) {
        if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '仅支持 GET')
        await handleDebug(req, res)
      } else {
        throw new HttpError(404, 'not_found', `未知路径：${pathname}`)
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const code = err instanceof HttpError ? err.code : 'internal_error'
      const message = err instanceof HttpError ? err.message : '服务器内部错误'
      if (res.headersSent) {
        // SSE 已开始：只能结束流
        if (!res.writableEnded) res.end()
        return
      }
      if (status >= 500) log.warn('请求失败', req.method, req.url, message)
      sendError(req, res, status, code, message)
    }
  }

  /** 监听端口、写端口文件、订阅事件。可重复调用（幂等）。 */
  async function start() {
    if (disposed) throw new Error('bridge 已销毁')
    if (server) return { port, candidates: triedPorts }
    if (starting) return starting
    starting = (async () => {
      const result = await listenFirstAvailable({
        handler: (req, res) => {
          void handleRequest(req, res)
        },
        candidates: portCandidates,
        host,
      })
      server = result.server
      port = result.port
      triedPorts = result.candidates
      server.on('error', (err) => log.warn('http server error:', err && err.message))
      if (!offStreamListener) offStreamListener = ctx.on('agent/assistant-stream', onAssistantStream)
      if (!offAgentStatusListener) offAgentStatusListener = ctx.on('agent/status', onAgentStatus)
      if (!offSessionEventListener) offSessionEventListener = ctx.on('session/event', onSessionEvent)
      if (!offApiStatusListener) offApiStatusListener = ctx.on('api-session/status', onApiSessionStatus)
      if (!offErrorListener) {
        offErrorListener = ctx.on('agent/error', onAgentError)
        const offApiError = ctx.on('api-session/error', onApiSessionError)
        const offAgentError = offErrorListener
        offErrorListener = () => {
          try {
            offAgentError && offAgentError()
          } catch {
            // 忽略
          }
          try {
            offApiError && offApiError()
          } catch {
            // 忽略
          }
        }
      }
      try {
        await writePortFile(portFile, port)
      } catch (err) {
        log.warn('写端口文件失败：', err && err.message)
      }
      log.info(`listening on http://${host}:${port}（尝试端口：${triedPorts.join(', ')}）`)
      log.info(`事件订阅已注册：assistant-stream/session-event/api-session-status/error，debug=${debugEnabled}，日志文件=${debugLogFile || '(未启用)'}`)
      return { port, candidates: triedPorts }
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  /** 关闭 server 并清理所有流；幂等。 */
  async function dispose() {
    if (disposed) return
    disposed = true
    for (const off of [offStreamListener, offAgentStatusListener, offSessionEventListener, offApiStatusListener, offErrorListener]) {
      if (!off) continue
      try {
        off()
      } catch {
        // 忽略
      }
    }
    offStreamListener = null
    offAgentStatusListener = null
    offSessionEventListener = null
    offApiStatusListener = null
    offErrorListener = null
    for (const collector of [...collectors.values()]) {
      collector.stopRequested = true
      collector.ac.abort()
      finish(collector, { type: 'stopped' })
    }
    if (server) {
      const closing = server
      await new Promise((resolve) => {
        const done = () => resolve()
        closing.close(done)
        closing.closeAllConnections?.()
        setTimeout(done, 1000).unref?.()
      })
      server = null
      port = 0
      log.info('http server 已关闭')
    }
  }

  return {
    get port() {
      return port
    },
    get portFile() {
      return portFile
    },
    get triedPorts() {
      return [...triedPorts]
    },
    get server() {
      return server
    },
    get activeStreams() {
      return [...collectors.values()].filter((c) => !c.finished)
    },
    handleRequest,
    start,
    dispose,
  }
}

