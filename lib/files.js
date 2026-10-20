// @本地文件检索：白名单目录内的只读文件搜索 / 内容读取 / 白名单管理。
//
// 端点（由 index.js 挂到现有 bridge HTTP server 上，不改 lib/bridge.js 的路由表）：
//   GET  /windowseat/files/search?q=&limit=   文件名 / 相对路径模糊搜索
//   GET  /windowseat/files/read?path=         读取单个文件（文本 ≤200KB；二进制只给元信息）
//   GET  /windowseat/files/config             查看白名单
//   POST /windowseat/files/config             增删白名单（add / remove / dirs）
//
// 安全边界：只读；所有返回路径都来自白名单目录的真实遍历（跳过符号链接），
// read 端点还会对目标做 realpath 校验，确保没有跑到白名单之外。
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
export const FILES_PREFIX = '/windowseat/files/'

export const FILES_ROUTES = {
  search: '/windowseat/files/search',
  read: '/windowseat/files/read',
  config: '/windowseat/files/config',
}

/** 默认白名单：仅用户的文档目录；其它目录由用户在设置抽屉里显式添加。 */
const DEFAULT_WHITELIST = [path.join(os.homedir(), 'Documents')]

const DEFAULT_LIMIT = 8
const MAX_LIMIT = 20
const MAX_WHITELIST = 20

// 单次搜索的扫描预算：避免用户家目录过大时把请求拖死
const MAX_SCAN_ENTRIES = 30000
const MAX_SCAN_MS = 1500
const MAX_DEPTH = 10
const RECENT_SCAN_LIMIT = 400 // q 为空时按最近修改列文件，最多收集这么多

// 不做递归的目录名（小写比较）。隐藏目录（. 开头）另外统一跳过。
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '__pycache__',
  '.cache',
  '.next',
  '.nuxt',
  '.turbo',
  '.pnpm-store',
  '.yarn',
  'appdata',
  'system volume information',
  '$recycle.bin',
  'windows',
])

// 明确按二进制处理（只返回元信息，不读取正文）的扩展名
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.tif', '.tiff', '.psd', '.ai', '.sketch',
  '.pdf', '.zip', '.7z', '.rar', '.gz', '.tar', '.bz2', '.xz', '.cab', '.iso',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.jar', '.pyc', '.wasm', '.db', '.sqlite',
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.vsd', '.vsdx', '.numbers', '.pages', '.key',
])

const MAX_FILE_BYTES = 200 * 1024 // 文本内容读取上限 200KB
const MAX_TEXT_BYTES = MAX_FILE_BYTES

/** 统一 Windows 路径比较：大小写不敏感。 */
function normalizeCase(p) {
  const s = String(p || '')
  return process.platform === 'win32' ? s.toLowerCase() : s
}

/** 规范化白名单条目：去空白、绝对化、去掉末尾分隔符。 */
function normalizeDir(value) {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return path.resolve(raw).replace(/[\\/]+$/, '') || path.resolve(raw)
}

function normalizeDirList(list) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const item of list) {
    const dir = normalizeDir(item)
    if (!dir) continue
    const key = normalizeCase(dir)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
    if (out.length >= MAX_WHITELIST) break
  }
  return out
}

function defaultConfigFile() {
  return process.env.WINDOWSEAT_FILES_CONFIG || path.join(os.homedir(), '.dsh', 'windowseat-files.json')
}

function pickOptions(options) {
  const opts = options || {}
  return {
    configFile: opts.configFile || defaultConfigFile(),
    whitelist: Array.isArray(opts.whitelist) ? opts.whitelist : DEFAULT_WHITELIST,
    getPort: typeof opts.getPort === 'function' ? opts.getPort : () => Number(opts.port) || 0,
    maxFileBytes: Number.isFinite(opts.maxFileBytes) && opts.maxFileBytes > 0 ? opts.maxFileBytes : MAX_FILE_BYTES,
    logger: typeof opts.logger === 'function' ? opts.logger : null,
  }
}

/** 读文件前面的若干字节（不一次性读大文件）。 */
async function readHead(file, maxBytes) {
  const fh = await fs.open(file, 'r')
  try {
    const size = Math.min(maxBytes, 1 << 20)
    const buf = Buffer.alloc(size)
    const { bytesRead } = await fh.read(buf, 0, size, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** 文本 / 二进制判别：UTF-16 BOM、NUL 字节、UTF-8 非法序列。 */
function looksBinary(buf) {
  if (!buf || buf.length === 0) return false
  if (buf.length >= 2) {
    if ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff)) return false // UTF-16 文本
  }
  if (buf.includes(0)) return true
  // 非 fatal 解码后统计替换字符：合法 UTF-8 只会因为尾部截断产生个别 '\uFFFD'，
  // 二进制数据则会出现大量非法序列。不能按字节硬切尾部（会把中文切坏而误判）。
  const text = new TextDecoder('utf-8').decode(buf)
  let bad = 0
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0xfffd) bad += 1
  }
  const allowed = buf.length > 4096 ? 2 : 1
  return bad > allowed
}

/** 把缓冲区解成文本（支持 UTF-16 BOM）。 */
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE → 转成小端再解
    const body = Buffer.from(buf.subarray(2))
    body.swap16()
    return body.toString('utf16le')
  }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/** realpath，失败返回 null。 */
async function safeRealpath(target) {
  try {
    return await fs.realpath(target)
  } catch {
    return null
  }
}

/** 判断 realPath 是否位于任一台白名单目录内（两边都先 realpath）。 */
async function isInsideWhitelist(realPath, dirs) {
  const target = normalizeCase(realPath)
  for (const dir of dirs) {
    const rootReal = await safeRealpath(dir)
    if (!rootReal) continue
    const root = normalizeCase(rootReal)
    if (target === root) return true
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
    if (target.startsWith(prefix)) return true
  }
  return false
}

/**
 * 遍历白名单目录，对每个文件调用 onFile(entry)；onFile 返回 false 时提前结束。
 * @param {{entries:number, startedAt:number, truncated:boolean}} state
 */
async function scanDir(root, state, onFile) {
  const queue = [{ dir: root, depth: 0 }]
  for (let i = 0; i < queue.length; i++) {
    if (Date.now() - state.startedAt > MAX_SCAN_MS || state.entries > MAX_SCAN_ENTRIES) {
      state.truncated = true
      return
    }
    const { dir, depth } = queue[i]
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue // 权限不足 / 目录消失：跳过
    }
    for (const ent of entries) {
      state.entries += 1
      if (state.entries > MAX_SCAN_ENTRIES) {
        state.truncated = true
        return
      }
      if (ent.isSymbolicLink()) continue // 不跟随符号链接，防止越界 / 成环
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        if (depth >= MAX_DEPTH) continue
        if (ent.name.startsWith('.')) continue
        if (SKIP_DIR_NAMES.has(ent.name.toLowerCase())) continue
        queue.push({ dir: full, depth: depth + 1 })
      } else if (ent.isFile()) {
        const entry = { name: ent.name, path: full, dir, rel: path.relative(root, full) }
        if (onFile(entry) === false) return
      }
    }
  }
}

/** 计算匹配得分；返回 -1 表示不匹配。得分越高越靠前。 */
function scoreEntry(entry, tokens) {
  const name = entry.name.toLowerCase()
  const rel = entry.rel.toLowerCase()
  let score = 0
  for (const token of tokens) {
    let hit = -1
    if (name.includes(token)) {
      hit = name.indexOf(token)
      score += 50
    } else if (rel.includes(token)) {
      hit = rel.indexOf(token)
      score += 18
    } else {
      return -1
    }
    // 文件名开头命中 / 词边界命中额外加权
    if (name.includes(token)) {
      if (hit === 0) score += 30
      else if (hit > 0 && '-_. '.includes(name[hit - 1])) score += 12
    }
  }
  const depth = entry.rel.split(/[\\/]/).length - 1
  score -= depth * 2
  score -= Math.min(entry.name.length, 80) * 0.1
  return score
}

/** 取文件元信息（size / mtime / ext）。 */
async function statEntry(filePath) {
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) return null
    return {
      size: stat.size,
      mtime: stat.mtimeMs,
      mtimeIso: stat.mtime.toISOString(),
      ext: path.extname(filePath).toLowerCase(),
    }
  } catch {
    return null
  }
}

/**
 * 创建 @本地文件检索 服务。
 * @param {{
 *   ctx?: any,
 *   getPort?: () => number,
 *   port?: number,
 *   configFile?: string,
 *   whitelist?: string[],
 *   maxFileBytes?: number,
 *   logger?: (level: string, ...args: any[]) => void,
 * }} options
 */
export function createFilesService(options = {}) {
  const { ctx: _ctx, configFile, whitelist, getPort, maxFileBytes, logger } = pickOptions(options)
  const log = logger || ((...args) => console.log('[windowseat-files]', ...args))

  // 白名单状态：首次访问时从配置文件加载；POST 修改后原子落盘
  let statePromise = null
  let writeChain = Promise.resolve()

  async function loadState() {
    try {
      const raw = await fs.readFile(configFile, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && Array.isArray(parsed.dirs)) {
        // 配置文件存在就完全以它为准（允许用户删掉默认目录）
        return { dirs: normalizeDirList(parsed.dirs) }
      }
      log('配置文件格式不对，回退默认白名单：', configFile)
    } catch (err) {
      if (err && err.code !== 'ENOENT') log('读取白名单配置失败，回退默认值：', (err && err.message) || err)
    }
    return { dirs: normalizeDirList(whitelist) }
  }

  function getState() {
    if (!statePromise) statePromise = loadState()
    return statePromise
  }

  async function saveState(state) {
    const payload = `${JSON.stringify({ dirs: state.dirs, updatedAt: new Date().toISOString() }, null, 2)}\n`
    await fs.mkdir(path.dirname(configFile), { recursive: true })
    const tmp = `${configFile}.tmp-${process.pid}`
    await fs.writeFile(tmp, payload, { encoding: 'utf8' })
    await fs.rename(tmp, configFile)
  }

  /** 串行化白名单写操作，避免并发 POST 互相覆盖。 */
  function updateWhitelist(mutate) {
    const run = async () => {
      const state = await getState()
      const next = await mutate({ dirs: [...state.dirs] })
      state.dirs = normalizeDirList(next.dirs)
      await saveState(state)
      return state
    }
    const task = writeChain.then(run, run)
    writeChain = task.catch(() => {})
    return task
  }

  /** 禁止把系统目录 / 凭据目录及其祖先目录加入白名单。 */
  function assertNotSystemDir(real) {
    const root = path.parse(real).root
    if (real.toLowerCase() === root.toLowerCase()) throw new HttpError(400, 'dir_not_allowed', '不能选择盘符根目录')
    const lower = real.toLowerCase()
    const sep = path.sep
    const home = os.homedir().toLowerCase()
    const sensitive = [
      path.join(root, 'Windows'),
      path.join(root, 'Program Files'),
      path.join(root, 'Program Files (x86)'),
      path.join(root, 'ProgramData'),
      path.join(root, 'Users'),
      path.join(root, '$Recycle.Bin'),
      path.join(root, 'System Volume Information'),
      path.join(root, 'Recovery'),
      path.join(root, 'PerfLogs'),
      ...['AppData', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.dsh', '.claude', '.codex', '.docker', '.npm', '.config'].map((n) => path.join(home, n)),
    ].map((p) => p.toLowerCase())

    const isSameOrInside = (candidate, target) => candidate === target || candidate.startsWith(target + sep)
    if (sensitive.some((p) => isSameOrInside(lower, p))) {
      throw new HttpError(400, 'dir_not_allowed', '不能选择系统目录或含凭据/配置的目录')
    }
    // 反向：候选目录是敏感目录的祖先（例如 Documents\.. 等于用户根、C:\Users 等）也不允许
    if (sensitive.some((p) => p.startsWith(lower + sep))) {
      throw new HttpError(400, 'dir_not_allowed', '所选目录范围过大，请选择更具体的子目录')
    }
    // 用户根目录本身不做白名单（范围过大，且包含 AppData 等敏感目录）
    if (lower === home) {
      throw new HttpError(400, 'dir_not_allowed', '请选择用户目录下的具体子目录')
    }
  }

  /** 校验并加入一个白名单目录；目录必须存在。 */
  async function resolveNewDir(value) {
    const dir = normalizeDir(value)
    if (!dir) throw new HttpError(400, 'invalid_dir', '目录不能为空')
    if (!path.isAbsolute(dir)) throw new HttpError(400, 'invalid_dir', '需要绝对路径')
    const real = await safeRealpath(dir)
    if (!real) throw new HttpError(400, 'dir_not_found', '目录不存在')
    const stat = await fs.stat(real)
    if (!stat.isDirectory()) throw new HttpError(400, 'not_a_directory', '目标不是目录')
    assertNotSystemDir(real)
    return real
  }

  /* ---------------- 搜索 ---------------- */

  async function searchFiles(query, limit, dirs) {
    const startedAt = Date.now()
    const tokens = String(query || '')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 6)
    const scan = { entries: 0, startedAt, truncated: false, dirsMissing: 0 }
    const matches = []
    const onFile = (entry) => {
      if (tokens.length === 0) {
        matches.push({ ...entry, score: 0 })
        return matches.length < RECENT_SCAN_LIMIT
      }
      const score = scoreEntry(entry, tokens)
      if (score >= 0) matches.push({ ...entry, score })
      return true
    }
    for (const dir of dirs) {
      if (Date.now() - startedAt > MAX_SCAN_MS) {
        scan.truncated = true
        break
      }
      const root = await safeRealpath(dir)
      if (!root) {
        scan.dirsMissing += 1
        continue
      }
      await scanDir(root, scan, onFile)
      if (scan.truncated || (tokens.length === 0 && matches.length >= RECENT_SCAN_LIMIT)) break
    }

    // 只对候选做 stat：空查询需要 mtime 排序，所以全部候选都要；关键词查询同理会截断前的候选
    const detailed = []
    for (const item of matches) {
      const info = await statEntry(item.path)
      if (!info) continue
      detailed.push({
        name: item.name,
        path: item.path,
        dir: item.dir,
        rel: item.rel,
        size: info.size,
        mtime: info.mtime,
        mtimeIso: info.mtimeIso,
        ext: info.ext,
        score: item.score,
      })
    }
    detailed.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      if (b.mtime !== a.mtime) return b.mtime - a.mtime
      return a.name.localeCompare(b.name)
    })
    const results = detailed.slice(0, limit).map(({ score: _score, ...rest }) => rest)
    return { results, scanned: scan.entries, truncated: scan.truncated, dirsMissing: scan.dirsMissing }
  }

  async function handleSearch(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '仅支持 GET')
    const rawLimit = Number.parseInt(url.searchParams.get('limit') || '', 10)
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT
    const query = (url.searchParams.get('q') || '').trim().slice(0, 120)
    const state = await getState()
    const startedAt = Date.now()
    const found = await searchFiles(query, limit, state.dirs)
    sendJson(req, res, 200, {
      ok: true,
      query,
      limit,
      results: found.results,
      elapsedMs: Date.now() - startedAt,
      scanned: found.scanned,
      truncated: found.truncated,
      whitelist: state.dirs,
      missingDirs: found.dirsMissing,
    })
  }

  /* ---------------- 读取 ---------------- */

  async function readFile(filePath) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
      throw new HttpError(400, 'missing_path', '缺少 path 参数')
    }
    const requested = filePath.trim()
    if (!path.isAbsolute(requested)) {
      throw new HttpError(400, 'relative_path', `path 必须是绝对路径：${requested}`)
    }
    const real = await safeRealpath(path.resolve(requested))
    if (!real) throw new HttpError(404, 'file_not_found', `文件不存在：${requested}`)
    const state = await getState()
    if (!(await isInsideWhitelist(real, state.dirs))) {
      throw new HttpError(403, 'path_not_allowed', '路径不在白名单目录内')
    }
    const stat = await fs.stat(real)
    if (!stat.isFile()) throw new HttpError(400, 'not_a_file', `不是文件：${requested}`)

    const base = {
      name: path.basename(real),
      path: real,
      dir: path.dirname(real),
      size: stat.size,
      mtime: stat.mtimeMs,
      mtimeIso: stat.mtime.toISOString(),
      ext: path.extname(real).toLowerCase(),
    }
    const ext = base.ext
    if (BINARY_EXTENSIONS.has(ext)) {
      return { ...base, kind: 'binary', text: null, reason: '二进制 / Office 文件，仅提供元信息' }
    }
    const readBytes = Math.min(stat.size, maxFileBytes)
    let buf
    try {
      buf = await readHead(real, readBytes)
    } catch (err) {
      log('读取文件失败：', (err && err.message) || err)
      throw new HttpError(400, 'read_failed', '读取失败（文件可能被占用、无权限或不是文本文件）')
    }
    if (looksBinary(buf)) {
      return { ...base, kind: 'binary', text: null, reason: '二进制文件，仅提供元信息' }
    }
    let text
    try {
      text = decodeText(buf)
    } catch (err) {
      return { ...base, kind: 'binary', text: null, reason: '无法按 UTF-8 / UTF-16 解码，按二进制处理' }
    }
    const truncated = stat.size > readBytes
    return {
      ...base,
      kind: 'text',
      text,
      truncated,
      textBytes: readBytes,
      ...(truncated ? { reason: `文件 ${stat.size} 字节，仅读取前 ${readBytes} 字节` } : {}),
    }
  }

  async function handleRead(req, res, url) {
    if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed', '仅支持 GET')
    const file = await readFile(url.searchParams.get('path') || '')
    sendJson(req, res, 200, { ok: true, file })
  }

  /* ---------------- 白名单 ---------------- */

  async function configDetails(dirs) {
    const details = []
    for (const dir of dirs) {
      const real = await safeRealpath(dir)
      details.push({ path: dir, exists: Boolean(real), realPath: real || null })
    }
    return details
  }

  async function handleConfig(req, res, url) {
    if (req.method === 'GET') {
      const state = await getState()
      sendJson(req, res, 200, {
        ok: true,
        dirs: state.dirs,
        details: await configDetails(state.dirs),
        configFile,
        maxFileBytes,
      })
      return
    }
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed', '仅支持 GET / POST')

    const body = await readJsonBody(req)
    // add / remove / dirs 既接受字符串数组，也接受单个字符串（curl、扩展配置面板都方便）
    const toList = (value) => {
      if (Array.isArray(value)) return value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
      if (typeof value === 'string' && value.trim()) return [value.trim()]
      return []
    }
    const replaceList = toList(body.dirs)
    const hasReplace = body.dirs !== undefined
    const addList = toList(body.add)
    const removeList = toList(body.remove)
    if (!hasReplace && addList.length === 0 && removeList.length === 0) {
      throw new HttpError(400, 'empty_config', '需要提供 add / remove / dirs 之一')
    }

    const added = []
    const removed = []
    const resolvedAdd = []
    for (const item of addList) resolvedAdd.push(await resolveNewDir(item))

    const state = await updateWhitelist(async ({ dirs }) => {
      let next = dirs
      if (hasReplace) {
        // 整表替换：逐个校验存在性
        next = []
        for (const item of replaceList) {
          const real = await resolveNewDir(item)
          if (!next.some((d) => normalizeCase(d) === normalizeCase(real))) next.push(real)
        }
        for (const dir of dirs) {
          if (!next.some((d) => normalizeCase(d) === normalizeCase(dir))) removed.push(dir)
        }
        for (const dir of next) {
          if (!dirs.some((d) => normalizeCase(d) === normalizeCase(dir))) added.push(dir)
        }
        return { dirs: next }
      }
      next = [...dirs]
      for (const real of resolvedAdd) {
        if (next.some((d) => normalizeCase(d) === normalizeCase(real))) continue
        next.push(real)
        added.push(real)
      }
      for (const item of removeList) {
        const target = normalizeDir(item)
        if (!target) continue
        const before = next.length
        next = next.filter((d) => normalizeCase(d) !== normalizeCase(target))
        if (next.length !== before) removed.push(target)
      }
      return { dirs: next }
    })

    if (added.length || removed.length) {
      log('白名单已更新：', JSON.stringify({ added, removed }))
    }
    sendJson(req, res, 200, {
      ok: true,
      dirs: state.dirs,
      details: await configDetails(state.dirs),
      added,
      removed,
      configFile,
    })
  }

  /* ---------------- 请求入口 ---------------- */

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
    if (pathname === FILES_ROUTES.search) return handleSearch(req, res, url)
    if (pathname === FILES_ROUTES.read) return handleRead(req, res, url)
    if (pathname === FILES_ROUTES.config) return handleConfig(req, res, url)
    throw new HttpError(404, 'not_found', `未知路径：${pathname}`)
  }

  async function handleRequest(req, res) {
    try {
      await dispatch(req, res)
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      const code = err instanceof HttpError ? err.code : 'internal_error'
      if (!(err instanceof HttpError)) log('文件端点异常：', (err && err.message) || err)
      const message = err instanceof HttpError ? err.message : '文件检索失败'
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
    // 便于调试 / 测试
    searchFiles,
    readFile,
    getState,
  }
}
