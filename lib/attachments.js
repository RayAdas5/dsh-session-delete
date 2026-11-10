/**
 * 附件：从会话日志里认出「这个会话用过哪些附件」，以及永久删除时把没人再引用的
 * 对象从磁盘上清掉。
 *
 * 存储布局（见 @deepseek-ai/dsh-attachment-local）：
 *   图片      <DSH_HOME>/attachments/v1/objects/<hash前2位>/<sha256>
 *   文件对象  <DSH_HOME>/attachments/v1/file-objects/<hash前2位>/<sha256>
 *   文件引用  <DSH_HOME>/attachments/v1/files/<hash前2位>/<sha256>/<name>   （指向对象）
 *
 * 关键约束：附件是**内容寻址**的，同一份字节只存一次，fork 出来的会话、重复上传
 * 同一张图都会共享同一个对象。所以永久删除前必须确认「除了这个会话，没人再引用」，
 * 否则会删掉别的会话还在用的图。
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** 日志里出现的内容地址：sha256:<64 hex>。 */
const HASH_RE = /sha256:([0-9a-f]{64})/g

/**
 * 一条附件记录的定义：只保留展示和删除需要的字段。
 * @typedef {{
 *   id: string,
 *   hash: string,
 *   name: string,
 *   mediaType: string,
 *   bytes: number,
 *   kind: 'image' | 'file',
 * }} AttachmentRecord
 */

/**
 * 深度遍历一个 JSON 值，收集所有带 `attachmentId` 的对象。
 * 图片和通用文件在日志里的形态不同，但都带 attachmentId，所以按字段认，不按事件类型认。
 * @param {unknown} value
 * @param {AttachmentRecord[]} out
 * @param {Set<string>} seen
 */
function walk(value, out, seen) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out, seen)
    return
  }
  const attachmentId = value.attachmentId
  if (typeof attachmentId === 'string') {
    const match = /^sha256:([0-9a-f]{64})$/.exec(attachmentId)
    if (match !== null && !seen.has(match[1])) {
      seen.add(match[1])
      out.push({
        id: attachmentId,
        hash: match[1],
        name: typeof value.name === 'string' && value.name !== '' ? value.name : '',
        mediaType: typeof value.mediaType === 'string' ? value.mediaType : '',
        bytes: Number.isFinite(value.bytes) ? value.bytes : 0,
        kind: typeof value.mediaType === 'string' && value.mediaType.startsWith('image/') ? 'image' : 'file',
      })
    }
  }
  for (const key of Object.keys(value)) walk(value[key], out, seen)
}

/**
 * 从会话日志的行里收集附件（去重，保持首次出现顺序）。
 * @param {string[]} lines
 * @returns {AttachmentRecord[]}
 */
export function collectAttachments(lines) {
  const out = []
  const seen = new Set()
  for (const line of lines) {
    // 先做字符串预筛：绝大多数行不含 attachmentId，不必 JSON.parse
    if (!line.includes('attachmentId')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    walk(event, out, seen)
  }
  return out
}

/**
 * 一段日志文本里出现过的所有内容地址。
 * @param {string} text
 * @returns {Set<string>}
 */
export function hashesInText(text) {
  const found = new Set()
  HASH_RE.lastIndex = 0
  let match = HASH_RE.exec(text)
  while (match !== null) {
    found.add(match[1])
    match = HASH_RE.exec(text)
  }
  return found
}

/**
 * 从会话日志里收集「交付物」（agent 用 present 工具展示过的文件）。
 *
 * 这跟 sha256 附件是两套东西：交付物只是**工作区里某个文件的路径引用**，
 * 不会进 attachments 存储。所以：
 *   - 删除会话时**绝不能**顺手删这些文件（它们属于用户的工程目录）；
 *   - 但回收站里应该列出来，用户才知道这个会话产出过什么。
 * @param {string[]} lines
 * @returns {Array<{path: string, name: string, description: string,
 *   turn: number | null, presentedAt: number | null}>}
 */
export function collectDeliverables(lines) {
  const out = []
  const seen = new Set()
  for (const line of lines) {
    if (!line.includes('deliverables/presented')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event === null || event.type !== 'deliverables/presented') continue
    const files = event.data !== null && event.data !== undefined ? event.data.files : undefined
    if (!Array.isArray(files)) continue
    for (const file of files) {
      if (file === null || typeof file !== 'object') continue
      const path = typeof file.path === 'string' ? file.path : ''
      if (path === '' || seen.has(path)) continue
      seen.add(path)
      const segments = path.split(/[\\/]/).filter((part) => part !== '')
      out.push({
        path,
        name: segments.length > 0 ? segments[segments.length - 1] : path,
        description: typeof file.description === 'string' ? file.description : '',
        turn: Number.isFinite(event.data.turn) ? event.data.turn : null,
        presentedAt: Number.isFinite(event.time) ? event.time : null,
      })
    }
  }
  return out
}

/**
 * 一个附件在磁盘上可能占的所有路径。
 * @param {string} home DSH_HOME
 * @param {string} hash
 * @returns {string[]}
 */
export function attachmentPaths(home, hash) {
  const prefix = hash.slice(0, 2)
  const base = join(home, 'attachments', 'v1')
  return [
    join(base, 'objects', prefix, hash),
    join(base, 'file-objects', prefix, hash),
    join(base, 'files', prefix, hash),
  ]
}

/**
 * 删除一个附件的全部落盘形态；不存在的路径静默跳过。
 * @param {string} home
 * @param {string} hash
 * @returns {Promise<{removed: number, bytes: number}>}
 */
export async function deleteAttachmentFiles(home, hash) {
  let removed = 0
  let bytes = 0
  for (const path of attachmentPaths(home, hash)) {
    try {
      const info = await stat(path)
      if (info.isDirectory()) {
        const size = await directorySize(path)
        await rm(path, { recursive: true, force: true })
        bytes += size
      } else {
        await rm(path, { force: true })
        bytes += info.size
      }
      removed += 1
    } catch {
      /* ENOENT 或占用：跳过，删除是尽力而为 */
    }
  }
  return { removed, bytes }
}

/**
 * 目录总字节数（用于展示回收站占用）。
 * @param {string} dir
 * @returns {Promise<number>}
 */
export async function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    try {
      if (entry.isDirectory()) total += await directorySize(path)
      else total += (await stat(path)).size
    } catch {
      /* 单个文件读不到不影响总量估算 */
    }
  }
  return total
}

/**
 * 展示用的媒体类型归类。
 * @param {string} mediaType
 * @returns {string}
 */
export function mediaLabel(mediaType) {
  if (typeof mediaType !== 'string' || mediaType === '') return '文件'
  if (mediaType.startsWith('image/')) return '图片'
  if (mediaType.startsWith('video/')) return '视频'
  if (mediaType.startsWith('audio/')) return '音频'
  if (mediaType.startsWith('text/')) return '文本'
  return '文件'
}
