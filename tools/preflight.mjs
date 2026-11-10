/**
 * 安装后预检：确认 DSH 下次启动时「解析得到、加载得动」本插件。
 *
 * 只读，不改任何东西：
 *   1. profile 的 package.json 里 dependencies / bundles 两行都在；
 *   2. 从 profile 目录能解析到包的 package.json；
 *   3. host 入口能真的 import 进来，并且导出了 apply；
 *   4. client 入口能被当作 ModuleLoader bundle 看待（文件存在 + 有 load 调用）；
 *   5. cordis.patch.yml 声明的 id / name 与本包一致。
 *
 * 跑法：node tools/preflight.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME || resolve(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const pluginName = 'dsh-session-delete'
const profileDir = join(home, 'profiles', 'desktop')
const linkDir = join(profileDir, 'node_modules', pluginName)
const sourceDir = join(home, 'plugins', pluginName)

function ok(message) {
  console.log('  ok  ' + message)
}

// 1) profile 声明
const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
assert.ok(profile.dependencies && profile.dependencies[pluginName], 'profile.dependencies 缺少 ' + pluginName)
assert.ok(Array.isArray(profile.dsh?.profile?.bundles), 'profile.dsh.profile.bundles 缺失')
assert.ok(profile.dsh.profile.bundles.includes(pluginName), 'profile.dsh.profile.bundles 缺少 ' + pluginName)
ok('profile 两处声明都在')

// 2) 解析到包
assert.ok(existsSync(linkDir), 'node_modules 里没有 ' + pluginName)
const pkg = JSON.parse(readFileSync(join(linkDir, 'package.json'), 'utf8'))
assert.equal(pkg.name, pluginName)
assert.equal(pkg.type, 'module')
assert.equal(pkg.main, 'lib/index.js')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.dsh?.client?.platform, 'web')
assert.ok(Array.isArray(pkg.dsh.client.inject), 'dsh.client.inject 应该是数组')
ok('package.json 的 dsh 字段齐全（bundle.patch / client.platform / client.inject）')

// 3) host 入口真的能 import，且所有子模块都能加载
const hostEntry = join(linkDir, 'lib', 'index.js')
assert.ok(existsSync(hostEntry), '缺少 lib/index.js')
const hostModule = await import(pathToFileURL(hostEntry).href)
assert.equal(typeof hostModule.apply, 'function', 'host 入口没有导出 apply')
const hostModules = {}
for (const name of ['session', 'trash', 'attachments', 'zstd', 'settings']) {
  const modulePath = join(linkDir, 'lib', name + '.js')
  assert.ok(existsSync(modulePath), '缺少 lib/' + name + '.js')
  hostModules[name] = await import(pathToFileURL(modulePath).href)
}
assert.equal(typeof hostModules.trash.trashSession, 'function', 'trash.js 缺少 trashSession')
assert.equal(typeof hostModules.trash.listTrash, 'function', 'trash.js 缺少 listTrash')
assert.equal(typeof hostModules.trash.restoreSession, 'function', 'trash.js 缺少 restoreSession')
assert.equal(typeof hostModules.trash.purgeSession, 'function', 'trash.js 缺少 purgeSession')
assert.equal(typeof hostModules.attachments.collectAttachments, 'function', 'attachments.js 缺少 collectAttachments')
assert.equal(typeof hostModules.settings.sweepTrash, 'function', 'settings.js 缺少 sweepTrash')
assert.equal(typeof hostModules.settings.readSettings, 'function', 'settings.js 缺少 readSettings')
ok('host 入口与 5 个子模块都能 import（apply / trash / restore / purge / 附件解析 / 自动清理）')

// 4) client 入口
const clientEntry = join(linkDir, 'lib', 'client.js')
assert.ok(existsSync(clientEntry), '缺少 lib/client.js')
const clientSource = readFileSync(clientEntry, 'utf8')
assert.ok(clientSource.includes('window.__ModuleLoader__.load('), 'client 入口不是 ModuleLoader bundle')
assert.ok(clientSource.includes("id: 'dsh-session-delete'"), 'client bundle id 不对')
ok('client 入口是合法 ModuleLoader bundle')

// 5) 补丁层
const patch = readFileSync(join(linkDir, 'cordis.patch.yml'), 'utf8')
assert.ok(patch.includes('name: ' + pluginName), 'cordis.patch.yml 里的 name 不是裸包名')
assert.ok(patch.includes('id: session-delete'), 'cordis.patch.yml 里的 id 不对')
ok('cordis.patch.yml 声明正确')

// 6) 源码目录与链接目录一致
assert.ok(existsSync(join(sourceDir, 'lib', 'client.js')), '源码目录不完整')
ok('源码目录 ' + sourceDir)

console.log('\npreflight 全部通过：重启 DSH 后应当能加载。')
