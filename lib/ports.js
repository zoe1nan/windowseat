// 端口选择与端口文件：只监听 127.0.0.1，候选端口依次顺延
import { promises as fs } from 'node:fs'
import path from 'node:path'
import http from 'node:http'

// CONTRACT §1：34281 → 34282 → 34283
export const DEFAULT_PORT_CANDIDATES = [34281, 34282, 34283]
export const DEFAULT_HOST = '127.0.0.1'

/**
 * 在指定端口监听；被占用时以带 code 的错误 reject。
 * @returns {Promise<import('node:http').Server>}
 */
export function listenOnce(handler, port, host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    const onError = (err) => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(server)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * 依次尝试候选端口，返回第一个成功监听的 server 与实际端口。
 * @param {{handler: Function, candidates?: number[], host?: string}} opts
 * @returns {Promise<{server: import('node:http').Server, port: number, candidates: number[]}>}
 */
export async function listenFirstAvailable({ handler, candidates = DEFAULT_PORT_CANDIDATES, host = DEFAULT_HOST }) {
  const tried = []
  for (const port of candidates) {
    tried.push(port)
    try {
      const server = await listenOnce(handler, port, host)
      return { server, port, candidates: [...tried] }
    } catch (err) {
      // 仅“端口被占用”才顺延；其余错误（如端口越权）直接抛出
      if (err && err.code === 'EADDRINUSE') continue
      throw err
    }
  }
  const err = new Error(`端口全部不可用：${tried.join(', ')}`)
  err.code = 'ENOAVAILABLEPORT'
  throw err
}

/**
 * 写端口文件（尽力设置 0600，Windows 上 chmod 实际不生效）。
 * 先写临时文件再 rename，避免扩展读到半截内容。
 */
export async function writePortFile(file, port) {
  const dir = path.dirname(file)
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, `${port}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await fs.chmod(tmp, 0o600)
  } catch {
    // 忽略：部分平台不支持
  }
  await fs.rename(tmp, file)
}

/** 读端口文件，失败返回 null。 */
export async function readPortFile(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const port = Number.parseInt(raw.trim(), 10)
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
  } catch {
    return null
  }
}
