/**
 * 生成 npm 发布用的 JSON 载荷（不负责发送）。
 *
 * 为什么分两步：npm 的 publish 接口要一个「带 base64 附件的 JSON」PUT 上去。
 * Node 这边生成最稳（JSON.stringify 天然 UTF-8），发送交给 PowerShell ——
 * 它这边走代理已经验证可用，而 Node 的 fetch 不读系统代理。
 *
 * 用法：node tools/publish-npm.mjs
 * 产物：dist/npm-publish.json
 */

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const tarball = join(root, 'dist', `${pkg.name}-${pkg.version}.tgz`)
if (!existsSync(tarball)) {
  console.error('找不到 tarball，先跑 node tools/pack.mjs：' + tarball)
  process.exit(1)
}

const bytes = readFileSync(tarball)
const shasum = createHash('sha1').update(bytes).digest('hex')
const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')

// 发布清单：package.json 原样 + npm 要求的 _id / dist
const manifest = {
  ...pkg,
  _id: `${pkg.name}@${pkg.version}`,
  dist: {
    shasum,
    integrity,
    tarball: `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`,
  },
}

const payload = {
  _id: pkg.name,
  name: pkg.name,
  description: pkg.description,
  'dist-tags': { latest: pkg.version },
  versions: { [pkg.version]: manifest },
  _attachments: {
    [`${pkg.name}-${pkg.version}.tgz`]: {
      content_type: 'application/octet-stream',
      data: bytes.toString('base64'),
      length: bytes.length,
    },
  },
}

const out = join(root, 'dist', 'npm-publish.json')
writeFileSync(out, JSON.stringify(payload), 'utf8')

console.log(`包名   : ${pkg.name}`)
console.log(`版本   : ${pkg.version}`)
console.log(`tarball: ${bytes.length} 字节`)
console.log(`shasum : ${shasum}`)
console.log(`载荷   : ${out} (${(Buffer.byteLength(JSON.stringify(payload)) / 1024).toFixed(1)} KB)`)
console.log('下一步：tools/publish-npm.ps1 -TokenFile <含 token 的文件>')
