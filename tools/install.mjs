/**
 * 把插件装进 DSH profile（本地 link 方式）。
 *
 * 做四件事，任何一步失败都立刻停下并打印原因：
 *   1. 备份 profiles/desktop/package.json；
 *   2. 把源码复制到 <DSH_HOME>/plugins/dsh-session-delete；
 *   3. 在 profiles/desktop/node_modules 建 junction 指向源码目录；
 *   4. 在 profile 的 dependencies 与 dsh.profile.bundles 里各补一行。
 *
 * 跑法：node tools/install.mjs [--dry-run]
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = resolve(here, '..')
const home = process.env.DSH_HOME || resolve(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
const pluginName = 'dsh-session-delete'
const target = join(home, 'plugins', pluginName)
const profileDir = join(home, 'profiles', 'desktop')
const profileJsonPath = join(profileDir, 'package.json')
const backupPath = join(profileDir, 'package.json.bak-' + pluginName)
const linkPath = join(profileDir, 'node_modules', pluginName)
const dryRun = process.argv.includes('--dry-run')

function log(message) {
  console.log('[install] ' + message)
}

function fail(message) {
  console.error('[install] 失败：' + message)
  process.exit(1)
}

if (!existsSync(profileJsonPath)) fail('找不到 profile：' + profileJsonPath)

// 1) 备份
if (!dryRun) {
  copyFileSync(profileJsonPath, backupPath)
  log('已备份 package.json → ' + backupPath)
}

// 2) 复制源码（覆盖写，不删目录：DSH 可能正握着里面的文件句柄）
if (!dryRun) {
  mkdirSync(target, { recursive: true })
  for (const name of readdirSync(source)) {
    if (name === 'node_modules' || name === 'tests' || name === 'tools') continue
    const from = join(source, name)
    const to = join(target, name)
    const info = statSync(from)
    if (info.isDirectory()) {
      copyDir(from, to)
    } else {
      copyFileSync(from, to)
    }
  }
  log('已复制源码 → ' + target)
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const f = join(from, name)
    const t = join(to, name)
    if (statSync(f).isDirectory()) copyDir(f, t)
    else copyFileSync(f, t)
  }
}

// 3) junction
if (!dryRun) {
  if (existsSync(linkPath) || isJunction(linkPath)) {
    try {
      unlinkSync(linkPath)
    } catch {
      rmSync(linkPath, { recursive: true, force: true })
    }
  }
  symlinkSync(target, linkPath, 'junction')
  log('已建立 junction → ' + linkPath)
}

function isJunction(path) {
  try {
    const info = statSync(path, { throwIfNoEntry: false })
    return info !== undefined && info.isSymbolicLink()
  } catch {
    return false
  }
}

// 4) 改 profile package.json
const profile = JSON.parse(readFileSync(profileJsonPath, 'utf8'))
if (profile.dependencies === undefined || profile.dependencies === null) profile.dependencies = {}
profile.dependencies[pluginName] = 'link:../../plugins/' + pluginName

const bundles = profile.dsh?.profile?.bundles
if (!Array.isArray(bundles)) fail('profile 里没有 dsh.profile.bundles 数组')
if (!bundles.includes(pluginName)) bundles.push(pluginName)

if (!dryRun) {
  writeFileSync(profileJsonPath, JSON.stringify(profile, null, 2) + '\n', 'utf8')
  log('已更新 package.json（dependencies + dsh.profile.bundles）')
}

log('完成。请完全退出 DSH 再启动。')
