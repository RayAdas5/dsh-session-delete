/**
 * 回收站：把会话目录挪进 `<DSH_HOME>/session-delete/trash/`，配上一条元数据，
 * 于是「删除」变成可逆动作；真正占用的磁盘要等「永久删除」或自动清理才释放。
 *
 * 布局：
 *   <home>/session-delete/trash/<trashId>/        会话目录，原样
 *   <home>/session-delete/trash/<trashId>.json    元数据（原路径、标题、附件清单…）
 *
 * 附件不动：它们是内容寻址的，可能被别的会话共用；只在永久删除时按引用计数清理。
 */

import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  collectAttachments,
  collectDeliverables,
  deleteAttachmentFiles,
  directorySize,
  hashesInText,
} from './attachments.js'
import {
  isRunning,
  locateSessionDirectory,
  LOG_FILENAME_RE,
  removeDirectoryWithRetry,
  residentSession,
  resolveHome,
  service,
} from './session.js'
import { logLines, readSessionLogText } from './zstd.js'

/** 回收站 id：t-<UTC yyyyMMddTHHmmss>-<6 hex>。 */
const TRASH_ID_RE = /^t-\d{8}T\d{6}-[0-9a-f]{6}$/

/** 元数据 schema 版本。 */
const SCHEMA = 1

/**
 * 回收站的路径集合。
 * @param {object} ctx
 * @returns {{base: string, trash: string}}
 */
export function trashPaths(ctx) {
  const base = join(resolveHome(ctx), 'session-delete')
  return { base, trash: join(base, 'trash') }
}

/**
 * 生成一个回收站 id。
 * @returns {string}
 */
export function makeTrashId() {
  const at = new Date()
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  const stamp =
    `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`
  return `t-${stamp}-${randomBytes(3).toString('hex')}`
}

/**
 * 是否是合法回收站 id（也就意味着是安全路径段）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isTrashId(value) {
  return typeof value === 'string' && TRASH_ID_RE.test(value)
}

/**
 * 读一条元数据；文件不存在或坏了就返回 null。
 * @param {string} file
 * @returns {Promise<any | null>}
 */
async function readMeta(file) {
  try {
    const raw = await readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 原子写一条元数据。
 * @param {string} file
 * @param {any} meta
 */
async function writeMeta(file, meta) {
  const tmp = `${file}.tmp`
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/**
 * 把一个会话目录挪进回收站。同盘 rename 是瞬时的；跨盘时退回复制再删。
 * @param {string} from
 * @param {string} to
 */
async function moveDirectory(from, to) {
  try {
    await rename(from, to)
    return
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(from, to, { recursive: true, errorOnExist: false })
    await removeDirectoryWithRetry(from)
  }
}

/**
 * 读一个会话目录里的日志，收集附件与交付物清单。失败一律返回空 —— 列不出来，
 * 不该阻止用户把会话移进回收站。
 * @param {string} dir
 * @returns {Promise<{attachments: import('./attachments.js').AttachmentRecord[],
 *   deliverables: Array<object>}>}
 */
export async function scanSessionDir(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch {
    return { attachments: [], deliverables: [] }
  }
  const attachments = []
  const deliverables = []
  for (const name of names) {
    if (!LOG_FILENAME_RE.test(name)) continue
    try {
      const lines = logLines(await readSessionLogText(join(dir, name)))
      for (const record of collectAttachments(lines)) attachments.push(record)
      for (const record of collectDeliverables(lines)) deliverables.push(record)
    } catch (error) {
      console.error('[session-delete] 读取会话日志失败：', name, error)
    }
  }
  return { attachments, deliverables }
}

/**
 * 把仍被 retain 的会话挂起写入刷盘。
 *
 * 会话只要打开过就会被 session controller 留在内存里，即使早就不动了。删目录前
 * 先 flush，能把还没落盘的批次写完；失败也无所谓 —— 后面删的本来就是不要的东西。
 * @param {object} ctx
 * @param {string} sessionId
 */
async function flushResident(ctx, sessionId) {
  const session = residentSession(ctx, sessionId)
  if (session === undefined) return
  const sessions = service(ctx, 'sessions')
  if (sessions === undefined || typeof sessions.flush !== 'function') return
  try {
    await sessions.flush(session)
  } catch (error) {
    console.warn('[session-delete] flush resident session failed (ignored):', error?.message ?? error)
  }
}

/**
 * 把一个会话移入回收站。
 * @param {object} ctx
 * @param {string} sessionId
 * @param {{title?: string}} [hints]
 * @returns {Promise<{ok: boolean, code?: string, trashId?: string, title?: string,
 *   attachments?: number, sizeBytes?: number}>}
 */
export async function trashSession(ctx, sessionId, hints = {}) {
  // 只看「真的在跑」；打开过但早 idle 的会话照样能删
  if (isRunning(ctx, sessionId)) return { ok: false, code: 'live' }
  const located = await locateSessionDirectory(ctx, sessionId)
  if (located.ok !== true) return located

  await flushResident(ctx, located.id)

  const scanned = await scanSessionDir(located.dir)
  const attachments = scanned.attachments
  const deliverables = scanned.deliverables
  const sizeBytes = await directorySize(located.dir)

  const { trash } = trashPaths(ctx)
  await mkdir(trash, { recursive: true })

  const trashId = makeTrashId()
  const payload = join(trash, trashId)
  try {
    await moveDirectory(located.dir, payload)
  } catch (error) {
    console.error('[session-delete] 移入回收站失败：', error)
    return { ok: false, code: 'move' }
  }

  const title =
    typeof hints.title === 'string' && hints.title.trim() !== ''
      ? hints.title.trim()
      : '未命名会话'
  const meta = {
    schema: SCHEMA,
    trashId,
    sessionId: located.id,
    title,
    originalDir: located.dir,
    sessionsRoot: located.sessionsRoot,
    cwd: located.cwd,
    deletedAt: Date.now(),
    sizeBytes,
    attachments,
    deliverables,
  }
  try {
    await writeMeta(join(trash, `${trashId}.json`), meta)
  } catch (error) {
    // 元数据写不进去就把目录挪回去，别留下一个认不出的孤儿
    console.error('[session-delete] 写回收站元数据失败，回滚：', error)
    try {
      await moveDirectory(payload, located.dir)
    } catch (rollbackError) {
      console.error('[session-delete] 回滚失败：', rollbackError)
    }
    return { ok: false, code: 'storage' }
  }

  // 目录已经不在原处了，必须同步告诉工作区：侧栏是按工作区的 sessionIds 记账
  // 渲染的，光挪目录的话它会继续显示成一条点不开的僵尸行。
  await detachFromWorkspace(ctx, located.id)

  console.log(
    '[session-delete] trashed', located.id, '->', trashId,
    `(${attachments.length} 个附件, ${deliverables.length} 个交付物)`,
  )
  return {
    ok: true,
    trashId,
    title,
    attachments: attachments.length,
    deliverables: deliverables.length,
    sizeBytes,
  }
}

/**
 * 把一个已经不在原处的会话从侧栏分组里摘掉。
 *
 * 两条路都走一遍：
 *   - `archiveSession`：把它记进归档集合，侧栏默认就隐藏（和 session-purge 的
 *     永久删除用的是同一招）；
 *   - `sessionKnown`：让注册表重新验证一次存在性，有的版本只认这个。
 * 两条都失败也不阻断删除本身 —— 文件已经挪走了，刷新页面就会消失。
 * @param {object} ctx
 * @param {string} sessionId
 * @returns {Promise<boolean>} 是否至少有一项生效
 */
export async function detachFromWorkspace(ctx, sessionId) {
  const workspaces = service(ctx, 'workspaceRegistry')
  if (workspaces === undefined) return false
  let changed = false
  if (typeof workspaces.archiveSession === 'function') {
    try {
      await workspaces.archiveSession(sessionId)
      changed = true
    } catch (error) {
      console.warn('[session-delete] archiveSession failed:', error?.message ?? error)
    }
  }
  if (typeof workspaces.sessionKnown === 'function') {
    try {
      await workspaces.sessionKnown(sessionId)
      changed = true
    } catch {
      /* 目录都没了，注册表认不出它很正常 */
    }
  }
  return changed
}

/**
 * 把已经在回收站里的会话同步进归档集合。
 *
 * 老版本移入回收站时只挪了目录、没通知工作区，侧栏里会留一批点不开的僵尸行。
 * 启动时跑一次，把这些历史遗留也摘掉；对已经归档过的会话是幂等的。
 * @param {object} ctx
 * @returns {Promise<number>} 处理过的条目数
 */
export async function syncTrashedSessions(ctx) {
  const { entries } = await listTrash(ctx)
  let changed = 0
  for (const entry of entries) {
    if (typeof entry.sessionId !== 'string' || entry.sessionId === '') continue
    if (await detachFromWorkspace(ctx, entry.sessionId)) changed += 1
  }
  if (changed > 0) {
    console.log('[session-delete] 已把', changed, '个回收站会话从工作区分组里摘掉')
  }
  return changed
}

/**
 * 列出回收站条目（不含内部字段）。
 * @param {object} ctx
 * @returns {Promise<{entries: any[], totalBytes: number}>}
 */
export async function listTrash(ctx) {
  const { trash } = trashPaths(ctx)
  let names
  try {
    names = await readdir(trash)
  } catch {
    return { entries: [], totalBytes: 0 }
  }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const meta = await readMeta(join(trash, name))
    if (meta === null || !isTrashId(meta.trashId)) continue
    const payload = join(trash, meta.trashId)
    let exists = true
    try {
      await stat(payload)
    } catch {
      exists = false
    }
    let attachments = Array.isArray(meta.attachments) ? meta.attachments : []
    let deliverables = Array.isArray(meta.deliverables) ? meta.deliverables : []

    // 老版本只存了 attachments（还没有 deliverables 概念）：现场补扫一次并回写，
    // 否则已经躺在回收站里的条目永远显示「没有记录到附件」。
    if (exists && meta.deliverables === undefined) {
      try {
        const scanned = await scanSessionDir(payload)
        deliverables = scanned.deliverables
        if (attachments.length === 0 && scanned.attachments.length > 0) {
          attachments = scanned.attachments
        }
        meta.attachments = attachments
        meta.deliverables = deliverables
        await writeMeta(join(trash, name), meta)
      } catch (error) {
        console.warn('[session-delete] 补扫回收站条目失败：', name, error?.message ?? error)
      }
    }

    entries.push({
      trashId: meta.trashId,
      sessionId: meta.sessionId,
      title: meta.title,
      originalDir: meta.originalDir,
      cwd: meta.cwd ?? null,
      deletedAt: meta.deletedAt,
      sizeBytes: meta.sizeBytes ?? 0,
      attachments,
      deliverables,
      payloadExists: exists,
    })
  }
  entries.sort((a, b) => b.deletedAt - a.deletedAt)
  const totalBytes = entries.reduce((sum, entry) => sum + (entry.sizeBytes || 0), 0)
  return { entries, totalBytes }
}

/**
 * 恢复一条回收站条目：把会话目录挪回原处。
 * @param {object} ctx
 * @param {string} trashId
 * @returns {Promise<{ok: boolean, code?: string, sessionId?: string, dir?: string}>}
 */
export async function restoreSession(ctx, trashId) {
  if (!isTrashId(trashId)) return { ok: false, code: 'invalid' }
  const { trash } = trashPaths(ctx)
  const metaFile = join(trash, `${trashId}.json`)
  const meta = await readMeta(metaFile)
  if (meta === null) return { ok: false, code: 'unknown' }
  const payload = join(trash, trashId)

  let targetExists = true
  try {
    await stat(meta.originalDir)
  } catch {
    targetExists = false
  }
  if (targetExists) return { ok: false, code: 'conflict' }

  try {
    await mkdir(join(meta.originalDir, '..'), { recursive: true })
    await moveDirectory(payload, meta.originalDir)
  } catch (error) {
    console.error('[session-delete] 恢复失败：', error)
    return { ok: false, code: 'move' }
  }
  await rm(metaFile, { force: true })

  // 让工作区重新认识这个会话（尽力而为；失败只是刷新页面后才会归位）
  try {
    const workspaces = service(ctx, 'workspaceRegistry')
    if (workspaces !== undefined) {
      // 删的时候归档过，复原时得先取消归档，否则侧栏还是隐藏的
      if (typeof workspaces.unarchiveSession === 'function') {
        try {
          await workspaces.unarchiveSession(meta.sessionId)
        } catch (error) {
          console.warn('[session-delete] 取消归档失败（不影响文件复原）：', error?.message ?? error)
        }
      }
      if (typeof workspaces.sessionKnown === 'function') await workspaces.sessionKnown(meta.sessionId)
      if (typeof workspaces.readSessionHeader === 'function') await workspaces.readSessionHeader(meta.sessionId)
    }
  } catch (error) {
    console.warn('[session-delete] 恢复后重新登记工作区失败：', error)
  }

  console.log('[session-delete] restored', meta.sessionId, '->', meta.originalDir)
  return { ok: true, sessionId: meta.sessionId, dir: meta.originalDir }
}

/**
 * 扫描「除某条回收站记录之外」还活着的一切，收集它们引用到的附件哈希。
 *
 * 范围：所有现存会话日志 + 回收站里其他条目的日志。这是保守做法 —— 只要某个
 * 哈希在别处出现过，就绝不为本次删除动它。
 * @param {object} ctx
 * @param {string} excludeTrashId
 * @returns {Promise<Set<string>>}
 */
export async function referencedHashes(ctx, excludeTrashId) {
  const found = new Set()
  const { trash } = trashPaths(ctx)
  const home = resolveHome(ctx)

  /** @param {string} dir */
  async function scanSessionDir(dir) {
    let names
    try {
      names = await readdir(dir)
    } catch {
      return
    }
    for (const name of names) {
      if (!LOG_FILENAME_RE.test(name)) continue
      try {
        const lines = logLines(await readSessionLogText(join(dir, name)))
        for (const hash of hashesInText(lines.join('\n'))) found.add(hash)
      } catch {
        /* 读不动就当没引用，交给上层的人工确认兜底 */
      }
    }
  }

  // 1) 现存的会话
  const sessionsRoot = join(home, 'sessions')
  let projects = []
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    projects = []
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const projectDir = join(sessionsRoot, project.name)
    let sessionDirs = []
    try {
      sessionDirs = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      if (!sessionDir.isDirectory()) continue
      await scanSessionDir(join(projectDir, sessionDir.name))
    }
  }

  // 2) 回收站里其他条目
  let names = []
  try {
    names = await readdir(trash)
  } catch {
    names = []
  }
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    const meta = await readMeta(join(trash, name))
    if (meta === null || meta.trashId === excludeTrashId) continue
    await scanSessionDir(join(trash, meta.trashId))
  }

  return found
}

/**
 * 永久删除一条回收站条目，连同「只有它引用」的附件。
 * @param {object} ctx
 * @param {string} trashId
 * @returns {Promise<{ok: boolean, code?: string, sessionId?: string,
 *   removedAttachments?: number, freedBytes?: number}>}
 */
export async function purgeSession(ctx, trashId) {
  if (!isTrashId(trashId)) return { ok: false, code: 'invalid' }
  const { trash } = trashPaths(ctx)
  const metaFile = join(trash, `${trashId}.json`)
  const meta = await readMeta(metaFile)
  if (meta === null) return { ok: false, code: 'unknown' }
  const payload = join(trash, trashId)

  // 先算引用：日志删除之后就再也算不出来了
  let shared = new Set()
  try {
    shared = await referencedHashes(ctx, trashId)
  } catch (error) {
    console.error('[session-delete] 附件引用扫描失败：', error)
    shared = new Set()
  }

  let freedBytes = 0
  try {
    freedBytes += await directorySize(payload)
    await removeDirectoryWithRetry(payload)
  } catch (error) {
    console.error('[session-delete] 永久删除会话目录失败：', error)
    return { ok: false, code: 'rm' }
  }

  const home = resolveHome(ctx)
  const unique = (Array.isArray(meta.attachments) ? meta.attachments : []).filter(
    (item) => typeof item?.hash === 'string' && item.hash !== '' && !shared.has(item.hash),
  )
  let removedAttachments = 0
  for (const item of unique) {
    try {
      const result = await deleteAttachmentFiles(home, item.hash)
      if (result.removed > 0) {
        removedAttachments += 1
        freedBytes += result.bytes
      }
    } catch (error) {
      console.warn('[session-delete] 删除附件失败：', item.hash, error)
    }
  }

  await rm(metaFile, { force: true })
  console.log(
    '[session-delete] purged', meta.sessionId, trashId,
    `附件 ${removedAttachments}/${(meta.attachments ?? []).length}，释放 ${freedBytes} 字节`,
  )
  return {
    ok: true,
    sessionId: meta.sessionId,
    removedAttachments,
    totalAttachments: (meta.attachments ?? []).length,
    freedBytes,
  }
}
