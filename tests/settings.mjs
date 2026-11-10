/**
 * 自测：设置与自动清理（不启动 DSH）。
 *
 * 覆盖：
 *   1. 没有设置文件时用默认值（自动清理开、保留 30 天）；
 *   2. 写入 → 读回；
 *   3. 非法值被拒绝（400 语义）；
 *   4. 保留期到点的会被 sweep 清掉，未到点的留着；
 *   5. 关掉自动清理后 sweep 一律不动；
 *   6. 保留期选「永久」时 sweep 不动；
 *   7. 损坏的设置文件回退默认值而不是抛错。
 *
 * 跑法：node tests/settings.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { trashSession, listTrash } = await import('../lib/trash.js')
const { readSettings, writeSettings, sweepTrash, normalizeSettings, settingsPath, pluginVersion } = await import('../lib/settings.js')

// 版本号从 package.json 读，唯一来源
const version = await pluginVersion()
assert.match(version, /^\d+\.\d+\.\d+$/, '版本号应来自 package.json：' + version)

const home = await mkdtemp(join(tmpdir(), 'dsh-sd-settings-'))
const sessionsRoot = join(home, 'sessions')
const snapshot = []

function logLine() {
  return JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } })
}

async function makeSession(id) {
  const dir = join(sessionsRoot, 'proj', id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), logLine() + '\n', 'utf8')
  return dir
}

const ctx = {
  get(name) {
    if (name === 'dshHomePath') return () => home
    if (name === 'sessionPersistence') {
      return {
        async list() {
          return snapshot.map((item) => ({ header: { id: item.id }, revision: 'r' }))
        },
        locate(header) {
          const found = snapshot.find((item) => item.id === header.id)
          return found === undefined ? undefined : { path: join(found.dir, 'session.v4.jsonl') }
        },
      }
    }
    if (name === 'workspaceRegistry') return { async sessionKnown() {}, async readSessionHeader() {} }
    if (name === 'agents' || name === 'sessions') return { get: () => undefined }
    return undefined
  },
}

try {
  // 1) 默认值
  const initial = await readSettings(ctx)
  assert.equal(initial.status, 'default')
  assert.equal(initial.settings.autoClean, true)
  assert.equal(initial.settings.retentionDays, 30)

  // 2) 写入 → 读回
  const saved = await writeSettings(ctx, { autoClean: false, retentionDays: 7 })
  assert.equal(saved.ok, true, '写设置应成功：' + JSON.stringify(saved))
  const reread = await readSettings(ctx)
  assert.equal(reread.status, 'ready')
  assert.equal(reread.settings.autoClean, false)
  assert.equal(reread.settings.retentionDays, 7)

  // 3) 非法值
  for (const bad of [{}, { autoClean: 'yes', retentionDays: 7 }, { autoClean: true, retentionDays: 13 }, null]) {
    const result = await writeSettings(ctx, bad)
    assert.equal(result.ok, false, '非法设置应被拒绝：' + JSON.stringify(bad))
    assert.equal(result.code, 'bad-request')
  }

  // 4) 到点清理 + 未到点保留
  await writeSettings(ctx, { autoClean: true, retentionDays: 30 })
  const oldDir = await makeSession('session-old')
  const freshDir = await makeSession('session-fresh')
  snapshot.push({ id: 'session-old', dir: oldDir }, { id: 'session-fresh', dir: freshDir })
  const oldTrashed = await trashSession(ctx, 'session-old', { title: '老会话' })
  const freshTrashed = await trashSession(ctx, 'session-fresh', { title: '新会话' })
  assert.equal(oldTrashed.ok, true)
  assert.equal(freshTrashed.ok, true)

  // 把老条目的删除时间改成 40 天前
  const oldMetaFile = join(home, 'session-delete', 'trash', oldTrashed.trashId + '.json')
  const oldMeta = JSON.parse(await readFile(oldMetaFile, 'utf8'))
  oldMeta.deletedAt = Date.now() - 40 * 86400000
  await writeFile(oldMetaFile, JSON.stringify(oldMeta, null, 2) + '\n', 'utf8')

  const swept = await sweepTrash(ctx, { reason: 'test' })
  assert.equal(swept.ok, true)
  assert.equal(swept.removed, 1, '应只清理 40 天前那一条')
  const remaining = await listTrash(ctx)
  assert.equal(remaining.entries.length, 1)
  assert.equal(remaining.entries[0].trashId, freshTrashed.trashId, '新会话应保留')
  assert.equal(existsSync(join(home, 'session-delete', 'trash', oldTrashed.trashId)), false)

  // 5) 关掉自动清理：不清理
  await writeSettings(ctx, { autoClean: false, retentionDays: 7 })
  const oldMeta2File = join(home, 'session-delete', 'trash', freshTrashed.trashId + '.json')
  const oldMeta2 = JSON.parse(await readFile(oldMeta2File, 'utf8'))
  oldMeta2.deletedAt = Date.now() - 100 * 86400000
  await writeFile(oldMeta2File, JSON.stringify(oldMeta2, null, 2) + '\n', 'utf8')
  const noSweep = await sweepTrash(ctx)
  assert.equal(noSweep.removed, 0, '自动清理关闭时不该删任何东西')
  assert.equal((await listTrash(ctx)).entries.length, 1)

  // 6) 永久保留：不清理
  await writeSettings(ctx, { autoClean: true, retentionDays: 0 })
  const forever = await sweepTrash(ctx)
  assert.equal(forever.removed, 0, '永久保留时不该删任何东西')
  assert.equal((await listTrash(ctx)).entries.length, 1)

  // 7) 损坏的设置文件 → 回退默认值
  await writeFile(settingsPath(ctx), '{ not json', 'utf8')
  const corrupt = await readSettings(ctx)
  assert.equal(corrupt.status, 'corrupt')
  assert.equal(corrupt.settings.retentionDays, 30)
  assert.equal(normalizeSettings({ retentionDays: 999 }).retentionDays, 30, '超范围的值应回默认')

  console.log(`settings ok (v${version}): 默认值/读写/非法值/到点清理/关闭清理/永久保留/损坏回退 七组通过`)
} finally {
  await rm(home, { recursive: true, force: true })
}
