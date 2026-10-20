// HTTP 工具：CORS、Host / Origin 校验、JSON 读写
const EXTENSION_ORIGIN_PREFIX = 'chrome-extension://'
// 请求体上限：聊天可带最多 4 张截图（每张 base64 ≤4MB），留出 JSON 包装余量
const MAX_BODY_BYTES = 24 * 1024 * 1024
const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost'])

/**
 * 扩展来源白名单：默认只信任钉了 manifest.key 的本扩展（ID 固定，见 extension/manifest.json）。
 * 其它扩展一律拒绝；可用 config.allowedOrigins / env WINDOWSEAT_ALLOWED_ORIGINS 追加（开发用）。
 */
const DEFAULT_ALLOWED_ORIGINS = ['chrome-extension://dkbhbbgajakmcgphebiallphkacekbhh']
let allowedOrigins = new Set(DEFAULT_ALLOWED_ORIGINS)

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

export function setAllowedOrigins(origins) {
  const list = (Array.isArray(origins) ? origins : [])
    .filter((o) => typeof o === 'string' && o.startsWith(EXTENSION_ORIGIN_PREFIX))
    .map((o) => o.trim().replace(/\/$/, ''))
  allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...list])
}

export function getAllowedOrigins() {
  return [...allowedOrigins]
}

/** 只有白名单里的扩展页面才算合法来源。 */
export function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return false
  return allowedOrigins.has(origin.trim().replace(/\/$/, ''))
}

/** 依据请求 Origin 构造 CORS 头；只回显白名单来源。 */
export function corsHeaders(req) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  }
  const origin = req.headers?.origin
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}

/**
 * Host 头必须是 127.0.0.1:<监听端口> 或 localhost:<监听端口>，防 DNS rebinding。
 */
export function isAllowedHost(hostHeader, port) {
  if (typeof hostHeader !== 'string' || !hostHeader) return false
  const host = hostHeader.trim().toLowerCase()
  if (host === `127.0.0.1:${port}` || host === `localhost:${port}`) return true
  return ALLOWED_HOSTNAMES.has(host) ? port === 80 : false
}

/**
 * 统一请求门禁：Host + Origin 校验。
 * - 有 Origin：必须是白名单扩展来源（拦跨站 CSRF / 其它恶意扩展）。
 * - 无 Origin：只放行本机进程（无 Sec-Fetch-Site）；浏览器发起的无 Origin 请求（如 <img>/表单 GET）拒绝。
 * 所有 handler（bridge / files / sessions）都必须先调用它。
 */
export function assertRequestAllowed(req, port) {
  if (!isAllowedHost(req.headers.host, port)) {
    throw new HttpError(403, 'forbidden_host', 'Host 不可用')
  }
  const origin = req.headers.origin
  const fetchSite = req.headers['sec-fetch-site']
  if (origin) {
    if (!isAllowedOrigin(origin)) throw new HttpError(403, 'forbidden_origin', '来源不可信')
    return
  }
  // 无 Origin 时用 Sec-Fetch-Site 分辨发起方：
  // - none / 缺省：本机进程，或扩展页的 GET（Chrome 对简单 GET 不带 Origin）→ 放行；
  // - same-origin / same-site / cross-site：浏览器页面发起 → 拒绝，挡住 CSRF 读取。
  if (fetchSite && fetchSite !== 'none') {
    throw new HttpError(403, 'forbidden_origin', '来源不可信')
  }
}

/** 发送 JSON 响应（自动附带 CORS）。 */
export function sendJson(req, res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...corsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

/** 发送统一错误结构 {ok:false,error:{code,message}}。 */
export function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { ok: false, error: { code, message } })
}

/** 读取并解析 JSON 请求体；空体视为 {}。 */
export async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase()
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'payload_too_large', '请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  // 强制 JSON：挡住 text/plain 表单式 CSRF，也避免歧义解析
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', '仅接受 application/json')
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'invalid_body', '请求体必须是 JSON 对象')
    }
    return parsed
  } catch (err) {
    if (err instanceof HttpError) throw err
    throw new HttpError(400, 'invalid_json', '请求体不是合法 JSON')
  }
}
