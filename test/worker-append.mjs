/**
 * worker-append.mjs —— multiprocess.mjs 的子进程，模拟"另一个会话所在的宿主"。
 * 参数：primary mirror tag count
 */
import { MemoryStore } from '../lib/store.js'

const [primary, mirror, tag, countRaw] = process.argv.slice(2)
const count = Number(countRaw) || 5

const store = new MemoryStore({
  primaryPath: primary,
  mirrorPath: mirror,
  entryCap: 500,
  graceDays: 3
})

// 父进程已经建好文件，这里只读不建，模拟"后来的会话"
await store.reload(true)
if (!store.raw) {
  console.error('记忆文件不存在')
  process.exit(2)
}

for (let i = 0; i < count; i += 1) {
  // tag 以 FIXED 开头时，所有会话写同一句话：用来验证并发下的去重 + 强调计数
  const line =
    tag === 'FIXED'
      ? '- [2026-10-08 10:00] 所有会话都写这一条（必须保持唯一）'
      : `- [2026-10-08 10:00] 会话${tag} 写入第 ${i} 条：${tag}-${i}`
  await store.appendEntry('lessons', line)
}

process.exit(0)
