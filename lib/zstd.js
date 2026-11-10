/**
 * 会话日志读取：DSH 的 `session[.vN].jsonl[.zstd]` 是「一行一个 zstd frame」的
 * 追加式文件，不是单个 frame。Node 的流式解压只认第一个 frame，会报
 * `Unknown frame descriptor`，所以这里按 magic 切帧、逐帧解压再拼接。
 *
 * 非压缩的 .jsonl 直接读。任何单帧解压失败都跳过，不影响其余行 —— 回收站宁可
 * 少列一个附件，也不能因为一行坏帧就整个打不开。
 */

import { readFile } from 'node:fs/promises'
import zlib from 'node:zlib'

/**
 * 原生 zstd 解压。用默认导入而不是具名导入：旧 Node 上 `zstdDecompressSync`
 * 这个具名导出根本不存在，具名导入会让整个模块直接语法失败、插件加载不了；
 * 默认导入拿到的是 undefined，可以优雅降级。
 */
const zstdDecompressSync =
  typeof zlib.zstdDecompressSync === 'function' ? zlib.zstdDecompressSync.bind(zlib) : null

/** zstd frame magic：28 B5 2F FD。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 找出一段 buffer 里所有 zstd frame 的起始偏移。
 * 压缩数据内部理论上也可能出现这 4 个字节，但逐帧解压会失败并被跳过，
 * 最坏情况是丢掉一行日志 —— 对回收站展示足够安全。
 * @param {Buffer} buf
 * @returns {number[]}
 */
function frameStarts(buf) {
  const starts = []
  const last = buf.length - 4
  for (let i = 0; i <= last; i += 1) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i)
    }
  }
  return starts
}

/**
 * 读一个会话日志文件，返回解压后的整段文本。
 * @param {string} file
 * @returns {Promise<string>}
 */
export async function readSessionLogText(file) {
  const raw = await readFile(file)
  if (!file.endsWith('.zstd')) return raw.toString('utf8')

  if (zstdDecompressSync === null) {
    // 宿主 Node 太旧、没有原生 zstd：附件解析降级为空清单，但绝不能因此让插件崩掉
    console.warn('[session-delete] 当前 Node 没有原生 zstd，无法解析压缩日志里的附件')
    return ''
  }

  const starts = frameStarts(raw)
  if (starts.length === 0) {
    // 没有 magic 说明不是 zstd（或者文件被截断成空）：当作纯文本兜底
    return raw.toString('utf8')
  }
  const parts = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : raw.length
    try {
      parts.push(zstdDecompressSync(raw.subarray(from, to)).toString('utf8'))
    } catch {
      /* 单帧坏了就跳过，别的行照常读 */
    }
  }
  return parts.join('')
}

/**
 * 把日志切成行。
 * @param {string} text
 * @returns {string[]}
 */
export function logLines(text) {
  return text.split('\n').filter((line) => line !== '')
}
