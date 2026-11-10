/**
 * dsh-session-delete —— 宿主（Host）半侧。
 *
 * 「删除会话」不再是不可逆的一刀，而是先移进回收站：
 *   POST /session-delete/trash     {sessionId, title}  → 移入回收站
 *   GET  /session-delete/trash                          → 列出回收站
 *   POST /session-delete/restore   {trashId}            → 复原
 *   POST /session-delete/purge     {trashId}            → 永久删除（含独占附件）
 *   GET  /session-delete/settings                       → 自动清理设置 + 用量
 *   POST /session-delete/settings                       → 保存自动清理设置
 *   POST /session-delete/sweep                          → 立刻按保留期清理一次
 *
 * 附件是内容寻址、可能被多个会话共用的，所以「永久删除」会先扫描所有现存会话
 * 与回收站里其他条目，只清掉没有任何其他地方再引用的对象。
 *
 * 自动清理：启动 8 秒后扫一次，之后每小时一次；每次清理都走和手动删除完全相同的
 * purge 路径，所以引用计数保护一样生效。
 */

import { settingsReport, sweepTrash, writeSettings } from './settings.js'
import {
  isTrashId,
  listTrash,
  purgeSession,
  restoreSession,
  syncTrashedSessions,
  trashSession,
} from './trash.js'
import { validSessionId } from './session.js'

/** 请求体上限：都只是收一个 id / 标题。 */
const MAX_BODY_BYTES = 64 * 1024

/** 启动后延迟多久做第一次自动清理（给持久层留出就绪时间）。 */
const BOOT_SWEEP_DELAY_MS = 8_000

/** 自动清理周期：每小时检查一次。 */
const SWEEP_INTERVAL_MS = 3_600_000

const LOG_PREFIX = '[session-delete]'

/**
 * 一次 JSON 响应。
 * @param {import('node:http').ServerResponse} response
 * @param {number} status
 * @param {unknown} value
 */
function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/**
 * 有 Origin 头时必须与 Host 同源；没有 Origin 的本机请求照常放行。
 * @param {import('node:http').IncomingMessage} request
 * @returns {boolean}
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  try {
    const host = request.headers.host
    return host !== undefined && new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * 读 JSON 请求体；超限与格式错误分别带 code。
 * @param {import('node:http').IncomingMessage} request
 * @returns {Promise<any>}
 */
function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      if (tooLarge) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) {
        const error = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
        error.code = 'too-large'
        rejectBody(error)
        return
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        resolveBody(raw === '' ? null : JSON.parse(raw))
      } catch (error) {
        rejectBody(error)
      }
    })
    request.on('error', rejectBody)
  })
}

/**
 * 结果码 → HTTP 状态。
 * @param {any} result
 * @returns {number}
 */
function statusFor(result) {
  if (result.ok === true) return 200
  if (result.code === 'invalid' || result.code === 'bad-request' || result.code === 'too-large') return 400
  if (result.code === 'storage' || result.code === 'rm' || result.code === 'move') return 503
  return 409
}

/**
 * 包一层：方法检查、同源检查、JSON 读写、错误兜底。
 * @param {(body: any) => Promise<any>} handle
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
function postRoute(handle) {
  return async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' })
      response.end()
      return
    }
    if (!sameOrigin(request)) {
      sendJson(response, 403, { ok: false, code: 'origin' })
      return
    }
    let body
    try {
      body = await readJsonBody(request)
    } catch (error) {
      sendJson(response, error?.code === 'too-large' ? 413 : 400, {
        ok: false,
        code: error?.code === 'too-large' ? 'too-large' : 'bad-request',
        error: String(error?.message ?? error),
      })
      return
    }
    try {
      const result = await handle(body ?? {})
      sendJson(response, statusFor(result), result)
    } catch (error) {
      console.error(LOG_PREFIX, 'route failed:', error)
      sendJson(response, 503, { ok: false, code: 'storage', error: String(error?.message ?? error) })
    }
  }
}

/**
 * 宿主插件入口。
 * @param {object} ctx
 */
export function apply(ctx) {
  ctx.inject(['webServer'], (host) => {
    host.effect(() => {
      const disposers = []

      // GET 列表 + POST 移入共用同一个 path：webServer 按 exact path 路由，
      // 同一路径注册两次会互相遮蔽。
      disposers.push(
        host.webServer.register({
          kind: 'exact',
          path: '/session-delete/trash',
          handler: async (request, response) => {
            if (request.method === 'GET') {
              if (!sameOrigin(request)) {
                sendJson(response, 403, { ok: false, code: 'origin' })
                return
              }
              try {
                const { entries, totalBytes } = await listTrash(ctx)
                sendJson(response, 200, { ok: true, entries, totalBytes })
              } catch (error) {
                console.error(LOG_PREFIX, 'list failed:', error)
                sendJson(response, 503, { ok: false, code: 'storage', error: String(error?.message ?? error) })
              }
              return
            }
            await postRoute(async (body) => {
              if (!validSessionId(body.sessionId)) return { ok: false, code: 'invalid' }
              return trashSession(ctx, body.sessionId, { title: body.title })
            })(request, response)
          },
        }),
      )

      disposers.push(
        host.webServer.register({
          kind: 'exact',
          path: '/session-delete/restore',
          handler: postRoute(async (body) => {
            if (!isTrashId(body.trashId)) return { ok: false, code: 'invalid' }
            return restoreSession(ctx, body.trashId)
          }),
        }),
      )

      disposers.push(
        host.webServer.register({
          kind: 'exact',
          path: '/session-delete/purge',
          handler: postRoute(async (body) => {
            if (!isTrashId(body.trashId)) return { ok: false, code: 'invalid' }
            return purgeSession(ctx, body.trashId)
          }),
        }),
      )

      // GET 状态 + POST 保存共用同一个 path
      disposers.push(
        host.webServer.register({
          kind: 'exact',
          path: '/session-delete/settings',
          handler: async (request, response) => {
            if (request.method === 'GET') {
              if (!sameOrigin(request)) {
                sendJson(response, 403, { ok: false, code: 'origin' })
                return
              }
              try {
                sendJson(response, 200, await settingsReport(ctx))
              } catch (error) {
                console.error(LOG_PREFIX, 'settings report failed:', error)
                sendJson(response, 503, { ok: false, code: 'storage', error: String(error?.message ?? error) })
              }
              return
            }
            await postRoute(async (body) => writeSettings(ctx, body))(request, response)
          },
        }),
      )

      disposers.push(
        host.webServer.register({
          kind: 'exact',
          path: '/session-delete/sweep',
          handler: postRoute(async () => sweepTrash(ctx, { reason: 'manual' })),
        }),
      )

      return () => {
        for (const dispose of disposers) {
          if (typeof dispose === 'function') dispose()
        }
      }
    }, 'dsh-session-delete: http routes')
  })

  // 自动清理：等持久层就绪后先扫一次，之后每小时一次。
  // 走和手动删除完全相同的 purge 路径，附件引用计数保护同样生效。
  ctx.inject(['sessionPersistence'], (boot) => {
    boot.effect(() => {
      let interval
      const bootTimer = setTimeout(() => {
        // 先把「老版本移入回收站时没通知工作区」的僵尸行摘掉，再跑清理
        syncTrashedSessions(ctx).catch((error) => {
          console.warn(LOG_PREFIX, '回收站与工作区同步失败：', error)
        })
        sweepTrash(ctx, { reason: 'boot' }).catch((error) => {
          console.warn(LOG_PREFIX, '启动清理失败：', error)
        })
        interval = setInterval(() => {
          sweepTrash(ctx, { reason: 'interval' }).catch((error) => {
            console.warn(LOG_PREFIX, '定期清理失败：', error)
          })
        }, SWEEP_INTERVAL_MS)
        if (typeof interval.unref === 'function') interval.unref()
      }, BOOT_SWEEP_DELAY_MS)
      if (typeof bootTimer.unref === 'function') bootTimer.unref()
      return () => {
        clearTimeout(bootTimer)
        if (interval !== undefined) clearInterval(interval)
      }
    }, 'dsh-session-delete: sweep scheduler')
  })
}
