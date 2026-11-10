/**
 * 自测：在不启动 DSH 的情况下驱动 lib/client.js。
 *
 * 模拟宿主那两样东西 —— `window.__ModuleLoader__.load()` 和 `require()` ——
 * 把 factory 跑一遍，再调 apply()，检查：
 *   1. 三个注册点（会话菜单 / 侧栏面板行 / 整页）的 name、id/key、order 对不对；
 *   2. 面板行 id 与整页 key 必须一致（不一致 selectPanel 会拒绝打开）；
 *   3. 快捷键 id 与各平台默认键位齐不齐；
 *   4. 菜单项、面板图标、回收站页面在正常与降级 props 下都不抛错。
 *
 * 跑法：node tests/smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

// ---- 假的 React -----------------------------------------------------------

const created = []
const React = {
  createElement(type, props, ...children) {
    const node = { type, props: { ...(props || {}), children } }
    created.push(node)
    return node
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect() {},
  useRef(value) {
    return { current: value }
  },
}

const fakePrimitives = {
  MenuItemButton: function MenuItemButton() {},
  IconTrashOutlineRegular: function IconTrashOutlineRegular() {},
}

function requireModule(name) {
  if (name === 'react') return React
  if (name === 'react-dom/client') return { createRoot: () => ({ render() {} }) }
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives
  throw new Error('unexpected require: ' + name)
}

// ---- 假的 DOM / window / fetch -------------------------------------------

function fakeElement(tag) {
  return {
    tagName: tag,
    id: '',
    className: '',
    textContent: '',
    parentNode: null,
    children: [],
    appendChild(child) {
      this.children.push(child)
      child.parentNode = this
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((item) => item !== child)
      child.parentNode = null
      return child
    },
    remove() {},
    isConnected: true,
    setAttribute() {},
    getAttribute() {
      return null
    },
    querySelectorAll() {
      return []
    },
    closest() {
      return null
    },
    getClientRects() {
      return [1]
    },
  }
}

const styleTags = []
const head = fakeElement('head')
const body = fakeElement('body')

globalThis.document = {
  head,
  body,
  documentElement: fakeElement('html'),
  getElementById(id) {
    return styleTags.find((tag) => tag.id === id) || null
  },
  createElement: fakeElement,
  querySelectorAll() {
    return []
  },
  addEventListener() {},
  removeEventListener() {},
}

globalThis.fetch = () =>
  Promise.resolve({
    status: 200,
    text: () => Promise.resolve('{"ok":true,"entries":[],"totalBytes":0}'),
  })

let captured = null
globalThis.__capture__ = {
  load(spec) {
    captured = spec
  },
}
globalThis.window = {
  __ModuleLoader__: globalThis.__capture__,
  document: globalThis.document,
  addEventListener() {},
  removeEventListener() {},
  setTimeout(fn) {
    return setTimeout(fn, 0)
  },
  clearTimeout(id) {
    clearTimeout(id)
  },
}

// ---- 执行 bundle ----------------------------------------------------------

new Function(source.replace(/^window\.__ModuleLoader__\.load\(/, 'globalThis.__capture__.load('))()

assert.ok(captured !== null, 'bundle 没有调用 __ModuleLoader__.load')
assert.equal(captured.id, 'dsh-session-delete', 'bundle id 不对')

const mod = captured.factory(requireModule)
assert.equal(mod.name, 'session-delete')
assert.deepEqual(mod.inject, ['slots'])
assert.equal(typeof mod.apply, 'function')

// ---- 假的 cordis ctx ------------------------------------------------------

const registeredSlots = []
const registeredShortcuts = []
const effects = []

const fakeShortcuts = {
  register(command) {
    registeredShortcuts.push(command)
    return () => {}
  },
}

const ctx = {
  get(name) {
    if (name === 'shortcuts') return fakeShortcuts
    if (name === 'sessions') {
      return {
        list: {
          getSnapshot() {
            return {
              byId: {
                abc: { id: 'abc', displayTitle: '测试会话', retainedBy: { mainView: 1 } },
                idle: { id: 'idle', displayTitle: '没打开的会话', retainedBy: { mainView: 0 } },
              },
            }
          },
        },
      }
    }
    return undefined
  },
  effect(fn, label) {
    effects.push(label)
    return fn()
  },
  inject(deps, callback) {
    assert.deepEqual(deps, ['shortcuts'], '注入声明不对')
    return callback({ effect: ctx.effect, get: ctx.get, shortcuts: fakeShortcuts })
  },
  slots: {
    inject(name, factory) {
      assert.ok(
        ['sidebar.workspaces.session.menu.item', 'sidebar.panellist', 'main', 'settings.section'].includes(name),
        '未知 slot：' + name,
      )
      return factory()
    },
    register(spec, component) {
      registeredSlots.push({ spec, component })
      return () => {}
    },
  },
}

mod.apply(ctx)

// ---- 断言 ----------------------------------------------------------------

// 1) 四个注册点
assert.equal(registeredSlots.length, 4, '应该注册四个 slot')
const menu = registeredSlots.find((entry) => entry.spec.name === 'sidebar.workspaces.session.menu.item')
const panel = registeredSlots.find((entry) => entry.spec.name === 'sidebar.panellist')
const page = registeredSlots.find((entry) => entry.spec.name === 'main')
const settings = registeredSlots.find((entry) => entry.spec.name === 'settings.section')

assert.ok(menu, '缺少会话菜单项')
assert.equal(menu.spec.id, 'session-delete')
assert.equal(menu.spec.order, 420, 'order 必须是 420（归档 400 之后、复制 ID 450 之前）')
assert.equal(typeof menu.component, 'function')

assert.ok(panel, '缺少侧栏面板行')
assert.equal(panel.spec.id, 'session-delete-trash')
assert.equal(typeof panel.spec.label, 'function')
assert.equal(panel.spec.label(), '会话回收站')

assert.ok(page, '缺少整页')
assert.equal(page.spec.key, 'session-delete-trash', '整页 key 必须与面板行 id 一致')
assert.equal(page.spec.key, panel.spec.id, '整页 key 与面板行 id 必须相等')
assert.equal(typeof page.component, 'function')

assert.ok(settings, '缺少设置页')
assert.equal(settings.spec.id, 'session-delete')
assert.equal(settings.spec.order, 47)
assert.equal(typeof settings.spec.label, 'function')
assert.equal(settings.spec.label(), '删除与回收站')
assert.equal(typeof settings.spec.inject, 'function', '设置页需要 inject face 拿快捷键服务')
const settingsFace = settings.spec.inject()
assert.equal(typeof settingsFace.getShortcuts, 'function')

// 2) 快捷键
assert.equal(registeredShortcuts.length, 1, '应该注册一个快捷键命令')
const command = registeredShortcuts[0]
assert.equal(command.id, 'session.delete')
assert.equal(command.label(), '删除会话')
for (const platform of [
  'desktop:macos',
  'desktop:windows',
  'desktop:linux',
  'web:macos',
  'web:windows',
]) {
  const binding = command.defaults[platform]
  assert.ok(binding, `缺少 ${platform} 的默认键位`)
  assert.equal(binding.code, 'KeyD')
  assert.deepEqual(binding.modifiers, ['primary', 'alt'])
}
assert.equal(command.resolve({ region: 'page', modal: null }).status, 'handled', '有当前会话时应 handled')

// 3) 菜单项组件
const menuProps = {
  sessionId: 'abc',
  displayTitle: '测试会话',
  useMenuOpenState: () => [false, () => {}],
  useShortcuts: (selector) =>
    selector([{ id: 'session.delete', keys: ['Ctrl', 'Alt', 'D'], aria: 'Control+Alt+D' }]),
}
fakePrimitives.MenuItemButton = function fakeMenuItem() {}
fakePrimitives.MenuItemButton.tag = 'menu'
assert.doesNotThrow(() => menu.component(menuProps), '菜单组件渲染抛错了')
let lastNode = created[created.length - 1]
assert.equal(lastNode.props.children[0], '删除会话', '菜单项文案不对')
assert.equal(lastNode.props.danger, true)
assert.ok(lastNode.props.shortcut && lastNode.props.shortcut.id === 'session.delete', '没把快捷键挂到菜单项上')

// 4) 没有 MenuItemButton 的旧宿主
fakePrimitives.MenuItemButton = undefined
assert.doesNotThrow(() => menu.component(menuProps), '没有 MenuItemButton 时渲染抛错了')
lastNode = created[created.length - 1]
assert.equal(lastNode.type, 'button')
assert.equal(lastNode.props.role, 'menuitem')
fakePrimitives.MenuItemButton = function fakeMenuItem() {}

// 5) 面板图标
assert.doesNotThrow(() => panel.component({ size: 16, active: true }), '面板图标渲染抛错了')
lastNode = created[created.length - 1]
assert.equal(lastNode.type, fakePrimitives.IconTrashOutlineRegular, '面板图标应该用宿主垃圾桶图标')

// 6) 整页能渲染（fetch 是假的，异步结果不参与断言）
assert.doesNotThrow(() => page.component({}), '回收站页面渲染抛错了')
lastNode = created[created.length - 1]
assert.equal(lastNode.props.className, 'dsd-page', '回收站页面根节点 class 不对')

// 7) 没有 shortcuts 服务时（延迟注入不回调）不能崩
const noShortcutCtx = {
  ...ctx,
  get(name) {
    return name === 'shortcuts' ? undefined : ctx.get(name)
  },
  inject() {},
  slots: { inject: (name, factory) => factory(), register: () => () => {} },
}
assert.doesNotThrow(() => mod.apply(noShortcutCtx), '没有快捷键服务时 apply 抛错了')

// 8) 服务晚到时仍能注册
const lateCommands = []
const lateCtx = {
  ...ctx,
  inject(deps, callback) {
    lateCtx.lateCallback = callback
  },
  slots: { inject: (name, factory) => factory(), register: () => () => {} },
}
mod.apply(lateCtx)
assert.equal(typeof lateCtx.lateCallback, 'function', 'deps 注入没有被登记')
lateCtx.lateCallback({
  effect: ctx.effect,
  get: ctx.get,
  shortcuts: { register(cmd) { lateCommands.push(cmd); return () => {} } },
})
assert.equal(lateCommands.length, 1, '服务晚到时也应该注册快捷键')

console.log(
  'smoke ok: 菜单 order=' + menu.spec.order +
  '，面板 ' + panel.spec.id +
  '，整页 key=' + page.spec.key +
  '，快捷键 ' + command.id,
)
