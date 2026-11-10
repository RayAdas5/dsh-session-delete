/**
 * 升版本号 + 补 CHANGELOG，一条命令搞定。
 *
 * 用法：
 *   node tools/bump.mjs patch "修复 xxx"          修 bug / 文案 / 样式
 *   node tools/bump.mjs minor "新增 xxx"          新增功能、设置项、入口
 *   node tools/bump.mjs major "重做 xxx"          破坏兼容（数据格式 / 接口 / 卸载方式）
 *
 * 只改 package.json 的 version（唯一来源）和 CHANGELOG.md 的顶部条目。
 * 改完记得 `node tools/install.mjs` 同步到 DSH 安装目录，再重启。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkgPath = join(root, 'package.json')
const changelogPath = join(root, 'CHANGELOG.md')
const dryRun = process.argv.includes('--dry-run')

const level = process.argv[2]
const note = process.argv[3] || ''
const LEVELS = ['patch', 'minor', 'major']

if (!LEVELS.includes(level)) {
  console.error('用法：node tools/bump.mjs <patch|minor|major> "这次改了什么" [--dry-run]')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const parts = String(pkg.version).split('.').map(Number)
if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value) || value < 0)) {
  console.error('package.json 的 version 不是 x.y.z：' + pkg.version)
  process.exit(1)
}
const [major, minor, patch] = parts

let next
if (level === 'major') next = `${major + 1}.0.0`
else if (level === 'minor') next = `${major}.${minor + 1}.0`
else next = `${major}.${minor}.${patch + 1}`

// 用本地日期，别用 toISOString()：那是 UTC，凌晨跑会写成前一天
const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
const body = note.trim() === '' ? '- （待补）' : '- ' + note.trim()
const entry = `## ${next} — ${date}\n\n${body}\n\n`

const previous = pkg.version

if (dryRun) {
  console.log(`[dry-run] ${previous} → ${next}（${level}）`)
  console.log(entry)
  process.exit(0)
}

pkg.version = next
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

const changelog = readFileSync(changelogPath, 'utf8')
// 插到第一条版本标题之前，保持「最新的在最上面」
const marker = '\n## '
const at = changelog.indexOf(marker)
const updated = at === -1
  ? changelog.replace(/\s*$/, '') + '\n\n' + entry
  : changelog.slice(0, at + 1) + entry + changelog.slice(at + 1)
writeFileSync(changelogPath, updated, 'utf8')

console.log(`版本 ${previous} → ${next}（${level}）`)
console.log('CHANGELOG 已更新到顶部。')
console.log('下一步：node tools/install.mjs，然后重启 DSH。')
