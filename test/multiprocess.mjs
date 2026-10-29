/**
 * multiprocess.mjs —— 模拟"多个会话/多个宿主进程同时写同一份记忆"。
 *
 * 做法：先建好一份记忆文件，然后并发 spawn N 个独立 node 进程，
 * 每个进程各自 new 一个 MemoryStore（相当于各自的宿主），各自写 M 条。
 * 结束后检查：
 *   1. 条数 == N×M（一条都没丢）
 *   2. 每个会话的条目都在
 *   3. 主文件与镜像完全一致
 *   4. 没有残留锁文件
 */
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

import { MemoryStore } from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(here, 'worker-append.mjs')
const SESSIONS = Number(process.argv[2]) || 4
const PER_SESSION = Number(process.argv[3]) || 5

const root = path.join(os.tmpdir(), `dsh-mem-mp-${Date.now()}`)
await fsp.mkdir(root, { recursive: true })
const primary = path.join(root, 'MEMORY.md')
const mirror = path.join(root, 'MIRROR.md')

const seed = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
await seed.init()

const expected = SESSIONS * PER_SESSION
console.log(`准备：${SESSIONS} 个"会话" × 每人 ${PER_SESSION} 条 = 期望 ${expected} 条`)

function runWorker(tag) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, primary, mirror, tag, String(PER_SESSION)], {
      stdio: 'ignore'
    })
    child.on('exit', (code) => resolve({ tag, code }))
    child.on('error', (error) => resolve({ tag, code: -1, error: String(error) }))
  })
}

const started = Date.now()
const results = await Promise.all(Array.from({ length: SESSIONS }, (_, i) => runWorker(`S${i}`)))
const elapsed = Date.now() - started

const failed = results.filter((r) => r.code !== 0)
console.log(`并发写入结束：${elapsed} ms，失败进程 ${failed.length} 个`)
if (failed.length) console.log('失败详情：', JSON.stringify(failed))

const verify = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
await verify.reload(true)
const entries = verify.entriesOf('lessons')
const texts = entries.map((e) => e.text)

const problems = []
if (entries.length !== expected) problems.push(`条数不符：${entries.length} != ${expected}`)
for (let i = 0; i < SESSIONS; i += 1) {
  const mine = texts.filter((t) => t.includes(`会话S${i} `))
  if (mine.length !== PER_SESSION) problems.push(`会话 S${i} 只落盘 ${mine.length}/${PER_SESSION} 条`)
}

const rawPrimary = await fsp.readFile(primary, 'utf8')
const rawMirror = await fsp.readFile(mirror, 'utf8')
const sha = (text) => createHash('sha256').update(text).digest('hex')
if (sha(rawPrimary) !== sha(rawMirror)) problems.push('主文件与镜像不一致')

const lockLeft = await fsp
  .access(`${primary}.lock`)
  .then(() => true)
  .catch(() => false)
if (lockLeft) problems.push('残留锁文件')

const history = await fsp.readdir(path.join(root, '.history')).catch(() => [])

console.log('')
console.log(`实际条数：${entries.length}`)
console.log(`镜像一致：${sha(rawPrimary) === sha(rawMirror) ? '是' : '否'}`)
console.log(`残留锁文件：${lockLeft ? '有（异常）' : '无'}`)
console.log(`历史快照：${history.length} 份`)
console.log(`唯一标题能否保住（不去重误伤）：${new Set(texts).size} 个不同文本`)

await fsp.rm(root, { recursive: true, force: true })

if (problems.length) {
  console.log('')
  console.log('失败：')
  for (const item of problems) console.log(' - ' + item)
  process.exit(1)
}
console.log('')
console.log('多进程并发写入：全部落盘，一条没丢')
