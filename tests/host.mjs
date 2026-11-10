/**
 * 自测：驱动 lib/trash.js 的完整回收站流程（不启动 DSH）。
 *
 * 场景：
 *   1. 移入回收站：会话目录真的挪走了，元数据带上了附件清单；
 *   2. 列表：条目、大小、附件数都对；
 *   3. 复原：目录回到原处，元数据消失；
 *   4. 永久删除：会话目录 + 只有它引用的附件被清掉；
 *   5. 共享附件：别的会话还在引用同一个哈希时，绝不能被删；
 *   6. 边界：运行中的会话拒绝、非法 id 拒绝、不存在的会话 unknown。
 *
 * 跑法：node tests/host.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { trashSession, listTrash, restoreSession, purgeSession } = await import('../lib/trash.js')

const home = await mkdtemp(join(tmpdir(), 'dsh-sd-host-'))
const sessionsRoot = join(home, 'sessions')

/** 两个假的附件哈希（64 hex）。 */
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

function logLine(attachmentId, name = 'image.png', bytes = 100) {
  return JSON.stringify({
    type: 'user/message',
    data: {
      content: [
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:' + attachmentId,
            mediaType: 'image/png',
            name,
            bytes,
          },
        },
      ],
    },
  })
}

/** 一条「交付物」事件：present 工具展示过的文件，只有路径，不是 sha256 附件。 */
function deliverableLine(path, description) {
  return JSON.stringify({
    type: 'deliverables/presented',
    seq: 1,
    time: Date.now(),
    data: { turn: 1, callId: 'call_test', files: [{ path, description }] },
  })
}

async function makeSession(project, id, lines) {
  const dir = join(sessionsRoot, project, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl'), lines.join('\n') + '\n', 'utf8')
  return dir
}

async function makeAttachment(hash, bytes = 1234) {
  const prefix = hash.slice(0, 2)
  const dir = join(home, 'attachments', 'v1', 'objects', prefix)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, hash), Buffer.alloc(bytes, 7))
  return join(dir, hash)
}

const snapshot = []
/** 真正在跑的会话（agent.status !== idle）。 */
const running = new Set()
/** 只是被打开过、仍被 retain 的会话（idle）。 */
const opened = new Set()
/** 工作区记账收到过的归档 / 取消归档调用。 */
const archived = []
const unarchived = []

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
    if (name === 'workspaceRegistry') {
      return {
        async archiveSession(id) { archived.push(id) },
        async unarchiveSession(id) { unarchived.push(id) },
        async sessionKnown() {},
        async readSessionHeader() {},
      }
    }
    if (name === 'agents') {
      // 只有 status/phase 不在 idle 才算「正在运行」
      return {
        get: (id) => (running.has(id)
          ? { id, status: 'running', phase: { kind: 'working' } }
          : undefined),
      }
    }
    if (name === 'sessions') {
      // 打开过就被 retain，但早 idle 了 —— 这种必须允许删除
      return {
        get: (id) => (opened.has(id) ? { id } : undefined),
        async flush() {},
      }
    }
    return undefined
  },
}

try {
  // ---- 1) 移入回收站 ----
  const dir1 = await makeSession('proj-a', 'session-one', [
    logLine(HASH_A, 'shot.png', 2048),
    deliverableLine('C:\\tmp\\测试附件.txt', '一个纯文本小附件'),
  ])
  snapshot.push({ id: 'session-one', dir: dir1 })
  const attachmentPath = await makeAttachment(HASH_A)

  const trashed = await trashSession(ctx, 'session-one', { title: '测试会话一' })
  assert.equal(trashed.ok, true, '移入回收站应成功：' + JSON.stringify(trashed))
  assert.equal(existsSync(dir1), false, '原目录应该已经不在')
  const trashDir = join(home, 'session-delete', 'trash', trashed.trashId)
  assert.equal(existsSync(join(trashDir, 'session.v4.jsonl')), true, '回收站里应该有会话日志')
  assert.equal(existsSync(attachmentPath), true, '附件不该跟着会话一起挪走')
  assert.equal(trashed.attachments, 1, '元数据应记录 1 个附件')
  assert.ok(archived.includes('session-one'), '移入回收站后必须通知工作区归档，否则侧栏还显示')
  assert.equal(trashed.deliverables, 1, '交付物也要记进元数据')

  // ---- 2) 列表 ----
  const listed = await listTrash(ctx)
  assert.equal(listed.entries.length, 1, '回收站应有 1 条')
  assert.equal(listed.entries[0].title, '测试会话一')
  assert.equal(listed.entries[0].attachments.length, 1)
  assert.equal(listed.entries[0].attachments[0].name, 'shot.png')
  assert.equal(listed.entries[0].attachments[0].hash, HASH_A)
  assert.equal(listed.entries[0].deliverables.length, 1, '回收站条目应带上交付物')
  assert.equal(listed.entries[0].deliverables[0].name, '测试附件.txt')
  assert.ok(listed.totalBytes > 0, '总占用应大于 0')

  // ---- 3) 复原 ----
  const restored = await restoreSession(ctx, trashed.trashId)
  assert.equal(restored.ok, true, '复原应成功：' + JSON.stringify(restored))
  assert.equal(existsSync(join(dir1, 'session.v4.jsonl')), true, '日志应回到原目录')
  assert.equal(existsSync(join(trashDir, 'session.v4.jsonl')), false, '回收站里的副本应消失')
  assert.ok(unarchived.includes('session-one'), '复原时必须取消归档，否则侧栏还是隐藏的')
  assert.equal((await listTrash(ctx)).entries.length, 0, '回收站应清空')

  // ---- 4) 永久删除 + 独占附件 ----
  const trashed2 = await trashSession(ctx, 'session-one', { title: '测试会话一' })
  assert.equal(trashed2.ok, true)
  const purged = await purgeSession(ctx, trashed2.trashId)
  assert.equal(purged.ok, true, '永久删除应成功：' + JSON.stringify(purged))
  assert.equal(existsSync(join(home, 'session-delete', 'trash', trashed2.trashId)), false, '回收站目录应删掉')
  assert.equal(existsSync(attachmentPath), false, '独占附件应被删除')
  assert.equal(purged.removedAttachments, 1, '应报告删除 1 个附件')

  // ---- 5) 共享附件不能删 ----
  const dirA = await makeSession('proj-b', 'session-shared', [logLine(HASH_B, 'shared.png', 512)])
  const dirB = await makeSession('proj-b', 'session-other', [logLine(HASH_B, 'shared.png', 512)])
  snapshot.length = 0
  snapshot.push({ id: 'session-shared', dir: dirA }, { id: 'session-other', dir: dirB })
  const sharedPath = await makeAttachment(HASH_B)

  const trashed3 = await trashSession(ctx, 'session-shared', { title: '共享附件的会话' })
  assert.equal(trashed3.ok, true)
  const purged3 = await purgeSession(ctx, trashed3.trashId)
  assert.equal(purged3.ok, true)
  assert.equal(existsSync(sharedPath), true, '别的会话还在引用，附件不能被删')
  assert.equal(purged3.removedAttachments, 0, '不该报告删除任何附件')

  // ---- 6) 边界 ----
  snapshot.length = 0
  snapshot.push({ id: 'session-other', dir: dirB })
  running.add('session-other')
  const live = await trashSession(ctx, 'session-other')
  assert.equal(live.ok, false)
  assert.equal(live.code, 'live', '正在运行的会话应拒绝')
  running.delete('session-other')

  // 只是「打开过」、早就不动了：必须能删（这正是用户踩到的那个坑）
  opened.add('session-other')
  const openedOnly = await trashSession(ctx, 'session-other', { title: '打开过但空闲' })
  assert.equal(openedOnly.ok, true, '打开过但已 idle 的会话应该能删：' + JSON.stringify(openedOnly))
  opened.delete('session-other')
  snapshot.length = 0
  await purgeSession(ctx, openedOnly.trashId)

  for (const bad of ['', '../escape', 'a/b', 'a\\b', 'x'.repeat(200), null, 42]) {
    const result = await trashSession(ctx, bad)
    assert.equal(result.ok, false, `id=${String(bad)} 应被拒绝`)
    assert.equal(result.code, 'invalid')
  }

  const missing = await trashSession(ctx, 'session-does-not-exist')
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'unknown')

  for (const bad of ['', '../x', 't-123', null]) {
    const result = await purgeSession(ctx, bad)
    assert.equal(result.ok, false, `trashId=${String(bad)} 应被拒绝`)
    assert.equal(result.code, 'invalid')
  }

  assert.equal((await listTrash(ctx)).entries.length, 0, '收尾时回收站应为空')

  console.log('host ok: 移入/列表/复原/永久删除/共享附件保护/边界 六组通过')
} finally {
  await rm(home, { recursive: true, force: true })
}
