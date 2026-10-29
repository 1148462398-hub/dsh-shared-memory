/**
 * bench.mjs — 实测「记忆文件读取 + 解析 + 提示词渲染」的耗时，并按规模外推。
 * 只读：不写盘、不触发任何 commit。
 */
import { promises as fsp, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { MemoryStore } from '../lib/store.js'
import { buildMemoryPrompt } from '../lib/prompt.js'

const PRIMARY = 'C:\\Users\\123\\.dsh\\dsh-shared-memory\\MEMORY.md'
const MIRROR = 'D:\\dsh-shared-memory\\MEMORY.md'

function bench(fn, times = 300) {
  const samples = []
  for (let i = 0; i < times; i += 1) {
    const t0 = process.hrtime.bigint()
    fn()
    const t1 = process.hrtime.bigint()
    samples.push(Number(t1 - t0) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const mid = samples[Math.floor(samples.length / 2)]
  return { median: mid, p95: samples[Math.floor(samples.length * 0.95)], min: samples[0], max: samples[samples.length - 1] }
}

const fmt = (ms) => `${ms.toFixed(3)} ms`

const raw = readFileSync(PRIMARY, 'utf8')
const bytes = statSync(PRIMARY).size
console.log(`当前文件：${bytes} 字节 / ${raw.length} 字符`)

const store = new MemoryStore({ primaryPath: PRIMARY, mirrorPath: MIRROR })
await store.reload(true)
const view = store.view()
const entries = Object.fromEntries(
  Object.entries(view.sections).map(([k, v]) => [k, (v.match(/^-\s*\[/gm) ?? []).length])
)
console.log(`分区条数：${JSON.stringify(entries)}`)

/* 1) 每次拼提示词的固定开销（stat + 解析 + 渲染），用真实文件 */
const rStat = bench(() => statSync(PRIMARY))
const rRead = bench(() => readFileSync(PRIMARY, 'utf8'))
const rView = bench(() => store.view())
const rPrompt = bench(() =>
  buildMemoryPrompt(store.view(), {
    injectChars: 6000,
    scope: 'project:default-workspace',
    primaryPath: PRIMARY,
    mirrorPath: MIRROR
  })
)
const rFull = bench(() => {
  statSync(PRIMARY)
  store.view()
  buildMemoryPrompt(store.view(), {
    injectChars: 6000,
    scope: 'project:default-workspace',
    primaryPath: PRIMARY,
    mirrorPath: MIRROR
  })
})
console.log('')
console.log('— 当前规模（9 KB / 18 条）—')
console.log(`statSync            ${fmt(rStat.median)}  (p95 ${fmt(rStat.p95)})`)
console.log(`readFileSync        ${fmt(rRead.median)}`)
console.log(`解析分区(view)      ${fmt(rView.median)}  (p95 ${fmt(rView.p95)})`)
console.log(`渲染提示词          ${fmt(rPrompt.median)}  (p95 ${fmt(rPrompt.p95)})`)
console.log(`压缩后一次重读合计  ${fmt(rFull.median)}  (p95 ${fmt(rFull.p95)})`)

/* 2) 规模外推：把条目分区按 K 倍复制，模拟未来的体积 */
function scaledSections(sections, k) {
  const out = { ...sections }
  for (const key of ['requirements', 'corrections', 'lessons', 'methods', 'requests', 'sessions']) {
    const body = sections[key] ?? ''
    out[key] = body.repeat(k)
  }
  return out
}

console.log('')
console.log('— 规模外推（条目数 × K，注入预算仍固定 6000 字符）—')
for (const k of [5, 20, 50, 100, 200]) {
  const sections = scaledSections(view.sections, k)
  const totalChars = Object.values(sections).reduce((n, s) => n + s.length, 0)
  const entriesK = (totalChars / raw.length) * Object.values(entries).reduce((a, b) => a + b, 0)
  const r = bench(
    () => buildMemoryPrompt({ raw: '', sections, meta: view.meta }, { injectChars: 6000, scope: 'project:default-workspace' }),
    120
  )
  console.log(
    `×${String(k).padStart(3)}  约 ${(totalChars / 1024).toFixed(0).padStart(5)} KB  约 ${Math.round(entriesK).toString().padStart(4)} 条  渲染 ${fmt(r.median)}  (p95 ${fmt(r.p95)})`
  )
}

/* 3) 历史快照目录开销 */
const hist = await fsp.readdir('C:\\Users\\123\\.dsh\\dsh-shared-memory\\.history').catch(() => [])
let histBytes = 0
for (const name of hist) {
  const st = await fsp.stat(`C:\\Users\\123\\.dsh\\dsh-shared-memory\\.history\\${name}`).catch(() => null)
  if (st) histBytes += st.size
}
console.log('')
console.log(`历史快照：${hist.length} 份，合计 ${(histBytes / 1024).toFixed(1)} KB`)
