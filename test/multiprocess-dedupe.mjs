/**
 * multiprocess-dedupe.mjs —— 多会话同时写"同一句话"。
 * 期望：只落 1 条，其余全部转成权重（reinforce），不会变成 N 条重复。
 */
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

import { MemoryStore } from '../lib/store.js'
import { entryKey } from '../lib/entryindex.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(here, 'worker-append.mjs')
const SESSIONS = Number(process.argv[2]) || 4
const PER_SESSION = Number(process.argv[3]) || 5

const root = path.join(os.tmpdir(), `dsh-mem-mpd-${Date.now()}`)
await fsp.mkdir(root, { recursive: true })
const primary = path.join(root, 'MEMORY.md')
const mirror = path.join(root, 'MIRROR.md')

const seed = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
await seed.init()

const total = SESSIONS * PER_SESSION
console.log(`准备：${SESSIONS} 个会话 × ${PER_SESSION} 次，全部写同一句话（共 ${total} 次）`)

const runWorker = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, primary, mirror, 'FIXED', String(PER_SESSION)], { stdio: 'ignore' })
    child.on('exit', (code) => resolve(code))
    child.on('error', () => resolve(-1))
  })

const codes = await Promise.all(Array.from({ length: SESSIONS }, runWorker))
const verify = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
await verify.reload(true)
const entries = verify.entriesOf('lessons')
const key = entryKey('lessons', '所有会话都写这一条（必须保持唯一）')
const rec = verify.index.get(key)

console.log('')
console.log(`失败进程：${codes.filter((c) => c !== 0).length}`)
console.log(`实际条数：${entries.length}（期望 1）`)
console.log(`重复计数 reinforce：${rec?.reinforce ?? 0}（期望 ${total - 1}）`)
console.log(`强调词计数 emphasis：${rec?.emphasis ?? 0}（同一条里 1 个"必须"，每写一次 +1）`)
console.log(`权重：${verify.weightOf(rec)}`)

await fsp.rm(root, { recursive: true, force: true })

const ok = entries.length === 1 && (rec?.reinforce ?? 0) === total - 1
console.log('')
console.log(ok ? '并发去重 + 强调计数：正确' : '并发去重结果不符合预期')
process.exit(ok ? 0 : 1)
