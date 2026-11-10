/**
 * 会话定位与身份校验：把「一个会话 id」变成「磁盘上那个目录」，且只在能证明
 * 身份时才认。
 *
 * 这里刻意不依赖 workspace 注册表：会话可能已经被归档、甚至已经从侧栏消失，
 * 但只要磁盘上还有它的日志，回收站就应该能处理它。
 */

import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { rm } from 'node:fs/promises'

/** 规范会话日志文件名：session.jsonl / session.v4.jsonl / 同名 .zstd 压缩变体。 */
export const LOG_FILENAME_RE = /^session(\.v\d+)?\.jsonl(\.zstd)?$/

/** 会话 id 只接受安全字符，杜绝路径穿越。 */
const SESSION_ID_SEGMENT_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * 读一个宿主服务，容忍 provider 的访问器抛异常。
 * @param {object} ctx
 * @param {string} name
 * @param {string} [method]
 * @returns {any | undefined}
 */
export function service(ctx, name, method) {
  let value
  try {
    value = typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch {
    return undefined
  }
  if (value === undefined || value === null) return undefined
  if (method !== undefined && typeof value[method] !== 'function') return undefined
  return value
}

/**
 * 解析 DSH_HOME：跟随宿主自己用的那一份（dshHomePath 函数 → $DSH_HOME → ~/.dsh）。
 * @param {object} ctx
 * @returns {string}
 */
export function resolveHome(ctx) {
  let provided
  try {
    provided = typeof ctx?.get === 'function' ? ctx.get('dshHomePath') : undefined
    if (typeof provided === 'function') provided = provided()
  } catch {
    provided = undefined
  }
  if (typeof provided !== 'string' || provided.trim() === '') {
    try {
      provided = ctx?.dshHomePath
    } catch {
      provided = undefined
    }
  }
  if (typeof provided === 'string' && provided.trim() !== '') return provided
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/**
 * @param {unknown} id
 * @returns {boolean}
 */
export function validSessionId(id) {
  return typeof id === 'string' && SESSION_ID_SEGMENT_RE.test(id)
}

/**
 * 从 persistence 快照里取 id（契约是 header.id，容忍摊平写法）。
 * @param {any} snapshot
 * @returns {string | undefined}
 */
export function snapshotSessionId(snapshot) {
  if (snapshot === null || snapshot === undefined || typeof snapshot !== 'object') return undefined
  const header = snapshot.header
  if (header !== null && header !== undefined && typeof header.id === 'string') return header.id
  return typeof snapshot.id === 'string' ? snapshot.id : undefined
}

/**
 * 从 locate() 给出的日志路径推导会话目录。
 * 只有当日志文件名是规范会话日志名时才接受它的父目录。
 * @param {string} locationPath
 * @returns {string | undefined}
 */
export function sessionDirectoryFromLogPath(locationPath) {
  if (typeof locationPath !== 'string' || locationPath === '' || !isAbsolute(locationPath)) return undefined
  if (!LOG_FILENAME_RE.test(basename(locationPath))) return undefined
  const dir = dirname(locationPath)
  if (dir === '' || dir === '.' || dir === locationPath) return undefined
  if (dir === parse(dir).root || basename(dir) === dir) return undefined
  return dir
}

/**
 * child 是否等于 parent 或位于其下。
 * @param {string} child
 * @param {string} parent
 * @returns {boolean}
 */
export function pathInside(child, parent) {
  if (typeof child !== 'string' || child === '' || typeof parent !== 'string' || parent === '') return false
  let rel
  try {
    rel = relative(resolve(parent), resolve(child))
  } catch {
    return false
  }
  if (rel === '') return true
  if (isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith('..' + '/') && !rel.startsWith('..' + '\\')
}

/**
 * 定位一个会话的日志目录。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<{ok: true, id: string, dir: string, sessionsRoot: string, cwd: string|null}
 *   | {ok: false, code: string}>}
 */
export async function locateSessionDirectory(ctx, sessionId) {
  if (!validSessionId(sessionId)) return { ok: false, code: 'invalid' }
  const persistence = service(ctx, 'sessionPersistence', 'list')
  if (persistence === undefined || typeof persistence.locate !== 'function') {
    return { ok: false, code: 'unavailable' }
  }
  let snapshot
  let location
  let resolvedId
  try {
    const snapshots = await persistence.list()
    snapshot = (Array.isArray(snapshots) ? snapshots : []).find(
      (item) => snapshotSessionId(item) === sessionId,
    )
    if (snapshot === undefined) return { ok: false, code: 'unknown' }
    resolvedId = snapshotSessionId(snapshot)
    location = await persistence.locate(snapshot.header ?? snapshot)
  } catch (error) {
    console.error('[session-delete] persistence lookup failed:', error)
    return { ok: false, code: 'storage' }
  }
  if (location === undefined || location === null || typeof location.path !== 'string') {
    return { ok: false, code: 'unsupported' }
  }
  const dir = sessionDirectoryFromLogPath(location.path)
  if (dir === undefined) {
    console.error('[session-delete] refusing unprovable session directory for', resolvedId ?? sessionId, 'from', location.path)
    return { ok: false, code: 'unsupported' }
  }
  const sessionsRoot = dirname(dirname(dir))
  if (!pathInside(dir, sessionsRoot) || resolve(dir) === resolve(sessionsRoot)) {
    console.error('[session-delete] refusing out-of-root session directory', dir, 'root', sessionsRoot)
    return { ok: false, code: 'unsupported' }
  }
  const cwd = snapshot?.header?.cwd ?? snapshot?.cwd
  return {
    ok: true,
    id: resolvedId ?? sessionId,
    dir,
    sessionsRoot,
    cwd: typeof cwd === 'string' && cwd !== '' ? cwd : null,
  }
}

/**
 * 递归删除，带 Windows 文件锁需要的重试。
 * @param {string} dir
 */
export async function removeDirectoryWithRetry(dir) {
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      await new Promise((done) => setTimeout(done, 150))
    }
  }
  throw lastError
}

/**
 * 这个会话此刻是否**真的在跑**（有进行中的回合 / 子代理 / 工具）。
 *
 * 注意别用 `sessions.get(id)` 判断：那个服务只要会话被**打开过**就会把它 retain
 * 在内存里，直到 DSH 重启 —— 几天前点开看一眼的会话也会命中，于是「删除」永远
 * 报「正在运行」。真正该看的是 agent 的状态机：status 不是 idle、或者 phase 不是
 * idle，才算正在干活。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isRunning(ctx, sessionId) {
  let agent
  try {
    const agents = service(ctx, 'agents')
    if (agents === undefined || typeof agents.get !== 'function') return false
    agent = agents.get(sessionId)
  } catch {
    return false
  }
  if (agent === undefined || agent === null) return false

  if (typeof agent.status === 'string' && agent.status !== 'idle') return true
  const phase = agent.phase
  if (phase !== null && phase !== undefined && typeof phase.kind === 'string' && phase.kind !== 'idle') {
    return true
  }
  return false
}

/**
 * 会话是否被 retain 在内存里（打开过、但可能早就 idle 了）。
 * 删除这种会话要先把挂起的写入刷盘，别让内存里的 writer 继续往已删目录追加。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {any | undefined}
 */
export function residentSession(ctx, sessionId) {
  try {
    const sessions = service(ctx, 'sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    return sessions.get(sessionId)
  } catch {
    return undefined
  }
}
