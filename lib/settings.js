/**
 * 插件设置：回收站自动清理策略，存在 `<DSH_HOME>/session-delete/settings.json`。
 *
 * 不放进 DSH 的插件配置体系，是为了让「改完立即生效、不用重启」和「文件坏了
 * 也能回退默认值」这两件事都简单可靠。读写都是原子的（tmp + rename）。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { resolveHome } from './session.js'
import { listTrash, purgeSession, trashPaths } from './trash.js'

/** 插件版本号，唯一来源是包自己的 package.json（读一次就缓存）。 */
const PACKAGE_JSON_URL = new URL('../package.json', import.meta.url)
let cachedVersion = null

/**
 * 读插件版本，给设置页页脚显示用。
 * @returns {Promise<string>}
 */
export async function pluginVersion() {
  if (cachedVersion !== null) return cachedVersion
  try {
    const parsed = JSON.parse(await readFile(PACKAGE_JSON_URL, 'utf8'))
    cachedVersion = typeof parsed.version === 'string' ? parsed.version : '0.0.0'
  } catch {
    cachedVersion = '0.0.0'
  }
  return cachedVersion
}

/** 设置默认值。 */
export const SETTINGS_DEFAULTS = Object.freeze({
  schema: 1,
  autoClean: true,
  retentionDays: 30,
})

/** 保留时长的可选项；0 表示永久保留。 */
export const RETENTION_CHOICES = Object.freeze([0, 7, 30, 90, 365])

/** 单次自动清理最多处理多少条，避免一次卡太久。 */
const SWEEP_BATCH_LIMIT = 50

const DAY_MS = 86_400_000

/**
 * 设置文件路径。
 * @param {object} ctx
 * @returns {string}
 */
export function settingsPath(ctx) {
  return join(trashPaths(ctx).base, 'settings.json')
}

/**
 * 把任意输入折叠成合法设置：读路径宽容（clamp 不抛），写路径严格。
 * @param {any} raw
 * @returns {{schema: number, autoClean: boolean, retentionDays: number}}
 */
export function normalizeSettings(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  return {
    schema: 1,
    autoClean: typeof source.autoClean === 'boolean' ? source.autoClean : SETTINGS_DEFAULTS.autoClean,
    retentionDays: RETENTION_CHOICES.includes(source.retentionDays)
      ? source.retentionDays
      : SETTINGS_DEFAULTS.retentionDays,
  }
}

/**
 * 读设置；文件不存在或坏了都回默认值。
 * @param {object} ctx
 * @returns {Promise<{settings: any, status: 'ready'|'default'|'corrupt'}>}
 */
export async function readSettings(ctx) {
  const file = settingsPath(ctx)
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { settings: { ...SETTINGS_DEFAULTS }, status: 'default' }
  }
  try {
    return { settings: normalizeSettings(JSON.parse(raw)), status: 'ready' }
  } catch {
    return { settings: { ...SETTINGS_DEFAULTS }, status: 'corrupt' }
  }
}

/**
 * 校验并写设置。
 * @param {object} ctx
 * @param {any} input
 * @returns {Promise<{ok: boolean, code?: string, settings?: any}>}
 */
export async function writeSettings(ctx, input) {
  if (input === null || typeof input !== 'object') return { ok: false, code: 'bad-request' }
  if (typeof input.autoClean !== 'boolean') return { ok: false, code: 'bad-request' }
  if (!RETENTION_CHOICES.includes(input.retentionDays)) return { ok: false, code: 'bad-request' }

  const settings = normalizeSettings(input)
  const file = settingsPath(ctx)
  try {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
    return { ok: true, settings }
  } catch (error) {
    console.error('[session-delete] 写设置失败：', error)
    return { ok: false, code: 'storage' }
  }
}

/**
 * 按保留期清理回收站。
 *
 * 每条过期条目走 `purgeSession`，所以附件的引用计数保护与手动删除完全一致 ——
 * 自动清理不会比手动删得更狠。
 * @param {object} ctx
 * @param {{reason?: string, now?: number}} [options]
 * @returns {Promise<{ok: boolean, removed: number, removedAttachments: number,
 *   freedBytes: number, kept: number, code?: string}>}
 */
export async function sweepTrash(ctx, options = {}) {
  const { settings, status } = await readSettings(ctx)
  if (status === 'corrupt') {
    console.warn('[session-delete] settings.json 损坏，已按默认值处理')
  }
  const now = typeof options.now === 'number' ? options.now : Date.now()

  const { entries } = await listTrash(ctx)
  if (settings.autoClean !== true || settings.retentionDays <= 0) {
    return { ok: true, removed: 0, removedAttachments: 0, freedBytes: 0, kept: entries.length }
  }

  const cutoff = now - settings.retentionDays * DAY_MS
  const expired = entries.filter((entry) => entry.deletedAt < cutoff).slice(0, SWEEP_BATCH_LIMIT)
  let removed = 0
  let removedAttachments = 0
  let freedBytes = 0
  for (const entry of expired) {
    const result = await purgeSession(ctx, entry.trashId)
    if (result.ok === true) {
      removed += 1
      removedAttachments += result.removedAttachments ?? 0
      freedBytes += result.freedBytes ?? 0
    } else {
      console.warn('[session-delete] 自动清理跳过', entry.trashId, result.code)
    }
  }
  if (removed > 0) {
    console.log(
      '[session-delete] 自动清理完成：', removed, '个会话，',
      removedAttachments, '个附件，释放', freedBytes, '字节',
      options.reason !== undefined ? `（${options.reason}）` : '',
    )
  }
  return {
    ok: true,
    removed,
    removedAttachments,
    freedBytes,
    kept: entries.length - removed,
  }
}

/**
 * 给设置页用的状态汇总。
 * @param {object} ctx
 * @returns {Promise<any>}
 */
export async function settingsReport(ctx) {
  const { settings, status } = await readSettings(ctx)
  const { entries, totalBytes } = await listTrash(ctx)
  return {
    ok: true,
    version: await pluginVersion(),
    settings,
    settingsStatus: status,
    retentionChoices: RETENTION_CHOICES,
    entries: entries.length,
    totalBytes,
  }
}
