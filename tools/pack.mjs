/**
 * 把插件打成可以分发的 npm 包（`<name>-<version>.tgz`）。
 *
 * npm 包本体就是「gzip 压缩的 tar，顶层目录叫 package/」，所以没有 npm 也能构造。
 * 这里用系统自带的 tar（Windows 10+ / macOS / Linux 都有），只把 `files` 里声明的
 * 东西装进去，测试和本地工具不进包。
 *
 * 用法：node tools/pack.mjs [--out <目录>]
 * 产物：<项目>/dist/dsh-session-delete-<version>.tgz
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const outArg = process.argv.indexOf('--out')
const distDir = outArg > -1 && process.argv[outArg + 1] !== undefined
  ? resolve(process.argv[outArg + 1])
  : join(root, 'dist')

const stageRoot = join(distDir, '.stage')
const stagePackage = join(stageRoot, 'package')
const tarball = join(distDir, `${pkg.name}-${pkg.version}.tgz`)

rmSync(stageRoot, { recursive: true, force: true })
mkdirSync(stagePackage, { recursive: true })

const wanted = Array.isArray(pkg.files) && pkg.files.length > 0
  ? pkg.files
  : ['lib', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md']

/** 记录进包的文件，打完包用它显示清单（不靠捕获 tar 的输出）。 */
const packed = []

/**
 * @param {string} from
 * @param {string} to
 * @param {string} label 包内路径
 */
function stage(from, to, label) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) stage(join(from, name), join(to, name), label + '/' + name)
    return
  }
  cpSync(from, to)
  packed.push('package/' + label)
}

for (const entry of wanted) {
  const from = join(root, entry)
  if (!existsSync(from)) {
    console.error('files 里声明了但不存在：' + entry)
    process.exit(1)
  }
  stage(from, join(stagePackage, entry), entry)
}
// package.json 必须进包，且必须是这一份
stage(join(root, 'package.json'), join(stagePackage, 'package.json'), 'package.json')

try {
  // stdio: 'inherit' —— 沙箱不允许通过管道捕获外部程序输出（spawn EPERM）
  execFileSync('tar', ['-czf', tarball, '-C', stageRoot, 'package'], { stdio: 'inherit' })
} catch (error) {
  console.error('打包失败（需要系统自带 tar）：', error.message)
  process.exit(1)
}

rmSync(stageRoot, { recursive: true, force: true })

console.log(`\n已生成 ${tarball}`)
console.log(`版本 ${pkg.version}，共 ${packed.length} 个文件：`)
for (const file of packed) console.log('  ' + file)
