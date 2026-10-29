/**
 * dsh-shared-memory / selftest-worker.js
 *
 * 安装自检用的子进程：模拟"另一个会话"往同一个记忆文件里写 N 条。
 * 参数：primary mirror tag count
 *
 * 只写临时目录，永远不碰真实记忆文件。
 */
import { MemoryStore } from './store.js'

const [primary, mirror, tag, countRaw] = process.argv.slice(2)
const count = Number(countRaw) || 3

const store = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
await store.reload(true)
if (!store.raw) process.exit(2)
for (let i = 0; i < count; i += 1) {
  await store.appendEntry('lessons', `- [2026-10-09 10:00] 自检${tag} 第 ${i} 条`)
}
process.exit(0)
