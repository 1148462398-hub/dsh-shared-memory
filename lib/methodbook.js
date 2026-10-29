/**
 * dsh-shared-memory / methodbook.js
 *
 * 「质疑度（skepticism）+ 最佳方法库（按作用分级索引）」的数据层。
 *
 * 规则（用户定义）：
 *  - 质疑度 0–10。0 = 已知最佳方法直接照用，不再试错。
 *  - N > 0 = 遇到已有最佳方法的任务时，**不许直接照抄**：把最佳方法当候选，
 *    强制再尝试 N 种不同做法；成功后与原最佳方法比 token / 耗时，更优则替换。
 *  - 动态降档：连续 `decayAfter`（默认 3）次汇报都没有找到更优方法，自动降一档，直到 0。
 *  - 方法库按「作用（领域）→ 子类 → 任务」分级建立索引；下次遇到相同/相似问题，
 *    先用索引检索（memory_file_method action=query），命中后按质疑度决定是直接复用还是换方法。
 *
 * 数据存在记忆文件的 `methodbook` 分类里：人读索引 + 一段 ```json 权威数据。
 * 手改索引不会被保存，手改 JSON 必须保持合法；解析失败则回退到上一个可用状态。
 */

import { oneLine, clip, stamp } from './store.js'

export const DEFAULT_SKEPTICISM = 5
export const MAX_SKEPTICISM = 10
export const DEFAULT_DECAY_AFTER = 3
export const DEFAULT_CATEGORY = '通用'

const MAX_ATTEMPTS_KEPT = 6
const MAX_TASKS = 80
const MAX_TAGS = 8
/** 综合分数低于它才算"更优"（避免把 1% 的噪声当成改进） */
const BETTER_THRESHOLD = 0.98
/** token 与耗时的权重（都归一化成"相对原最佳方法的倍数"再加权） */
const TOKEN_WEIGHT = 0.6
const TIME_WEIGHT = 0.4

/* ------------------------------------------------------------------ */
/* 分类（作用）推断                                                     */
/* ------------------------------------------------------------------ */

/** 关键词 → 作用分类。模型没给 category 时用它兜底，保证索引不会全挤在"通用"里。 */
const CATEGORY_RULES = [
  ['构建与编译', /(编译|构建|build|ninja|cmake|make|链接|linker|toolchain|工具链|msvc|mingw|gcc|clang)/i],
  ['依赖与安装', /(安装|install|依赖|depend|pnpm|npm|yarn|pip|包管理|下载|download|registry|node_modules)/i],
  ['插件与扩展', /(插件|plugin|cordis|bundle|profile|预设|preset|扩展)/i],
  ['前端与界面', /(ui|界面|页面|前端|frontend|css|样式|组件|component|react|浏览器|browser|html)/i],
  ['记忆与上下文', /(记忆|memory|上下文|context|压缩|compact|检索|search|索引|index)/i],
  ['数据与解析', /(json|yaml|parse|解析|格式|format|正则|regex|csv|xml|markdown)/i],
  ['网络与请求', /(网络|http|https|api|请求|request|端口|port|代理|proxy|curl|fetch|post|get|websocket)/i],
  ['文件与路径', /(文件|file|目录|路径|path|权限|permission|备份|backup|镜像|mirror)/i],
  ['测试与校验', /(测试|test|校验|验证|validate|断言|assert|smoke)/i],
  ['调试与排错', /(调试|debug|报错|error|异常|exception|日志|log|崩溃|crash|失败)/i]
]

const MAX_CATEGORY_CHARS = 24

export function normalizeCategory(value) {
  const text = oneLine(value)
  if (!text) return ''
  return clip(text, MAX_CATEGORY_CHARS)
}

export function inferCategory(task, approach) {
  const hay = `${oneLine(task)} ${oneLine(approach)}`
  for (const [category, re] of CATEGORY_RULES) {
    if (re.test(hay)) return category
  }
  return DEFAULT_CATEGORY
}

/* ------------------------------------------------------------------ */
/* 基础工具                                                             */
/* ------------------------------------------------------------------ */

export function clampLevel(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_SKEPTICISM
  return Math.max(0, Math.min(MAX_SKEPTICISM, n))
}

function finiteOrNull(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n)
}

function clampDecay(value) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_DECAY_AFTER
  return Math.max(1, Math.min(MAX_SKEPTICISM, n))
}

/** 公开版：给工具层校验 decayAfter 入参 */
export function clampDecayAfter(value) {
  return clampDecay(value)
}

function normalizeTags(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，\s]+/)
  const out = []
  for (const item of raw) {
    const tag = clip(oneLine(item), 20)
    if (tag && !out.includes(tag) && out.length < MAX_TAGS) out.push(tag)
  }
  return out
}

/** 任务名 → 稳定 key（小写、去标点、限长），同一个任务多次调用要能对上 */
export function taskKey(task) {
  return oneLine(task)
    .toLowerCase()
    .replace(/[。！？，、；：“”‘’"'`（）()【】\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

export function defaultMethodbook(options = {}) {
  return {
    skepticism: {
      level: clampLevel(options.level ?? DEFAULT_SKEPTICISM),
      auto: options.auto !== false,
      decayAfter: clampDecay(options.decayAfter ?? DEFAULT_DECAY_AFTER),
      noGainStreak: 0,
      lastChange: null
    },
    tasks: {}
  }
}

function sanitizeAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return null
  const approach = oneLine(attempt.approach)
  if (!approach) return null
  return {
    at: String(attempt.at ?? stamp()),
    approach: clip(approach, 300),
    ok: attempt.ok !== false,
    tokens: finiteOrNull(attempt.tokens),
    ms: finiteOrNull(attempt.ms),
    note: clip(oneLine(attempt.note), 200)
  }
}

function normalize(obj) {
  const sk = obj?.skepticism && typeof obj.skepticism === 'object' ? obj.skepticism : {}
  const out = {
    skepticism: {
      level: clampLevel(sk.level ?? DEFAULT_SKEPTICISM),
      auto: sk.auto !== false,
      decayAfter: clampDecay(sk.decayAfter ?? DEFAULT_DECAY_AFTER),
      noGainStreak: Math.max(0, Math.floor(Number(sk.noGainStreak) || 0)),
      lastChange: sk.lastChange && typeof sk.lastChange === 'object'
        ? {
            at: String(sk.lastChange.at ?? ''),
            from: clampLevel(sk.lastChange.from),
            to: clampLevel(sk.lastChange.to),
            reason: clip(oneLine(sk.lastChange.reason), 120)
          }
        : null
    },
    tasks: {}
  }
  const tasks = obj?.tasks && typeof obj.tasks === 'object' ? obj.tasks : {}
  for (const [key, raw] of Object.entries(tasks)) {
    if (!raw || typeof raw !== 'object') continue
    const approach = oneLine(raw.best?.approach)
    if (!approach) continue
    const task = oneLine(raw.task) || key
    out.tasks[key] = {
      key,
      task,
      category: normalizeCategory(raw.category) || inferCategory(task, approach),
      subcategory: normalizeCategory(raw.subcategory),
      tags: normalizeTags(raw.tags),
      scope: String(raw.scope ?? 'global') || 'global',
      best: {
        approach: clip(approach, 400),
        tokens: finiteOrNull(raw.best?.tokens),
        ms: finiteOrNull(raw.best?.ms),
        at: String(raw.best?.at ?? ''),
        runs: Math.max(1, Math.floor(Number(raw.best?.runs) || 1))
      },
      updatedAt: String(raw.updatedAt ?? ''),
      attempts: Array.isArray(raw.attempts)
        ? raw.attempts.slice(-MAX_ATTEMPTS_KEPT).map(sanitizeAttempt).filter(Boolean)
        : []
    }
  }
  return out
}

/** 从 methodbook 分区正文里解析状态；没有 JSON 或 JSON 不合法时返回 null */
export function parseMethodbook(body) {
  const text = String(body ?? '')
  const m = /```json\s*\r?\n([\s\S]*?)\r?\n```/.exec(text)
  if (!m) return null
  try {
    const obj = JSON.parse(m[1])
    if (!obj || typeof obj !== 'object') return null
    return normalize(obj)
  } catch {
    return null
  }
}

function costText(best) {
  const parts = []
  if (best?.tokens !== null && best?.tokens !== undefined) parts.push(`${best.tokens} tokens`)
  if (best?.ms !== null && best?.ms !== undefined) parts.push(`${(best.ms / 1000).toFixed(1)}s`)
  return parts.join(' / ')
}

/* ------------------------------------------------------------------ */
/* 分级索引                                                             */
/* ------------------------------------------------------------------ */

function byRecent(a, b) {
  return String(b.updatedAt).localeCompare(String(a.updatedAt))
}

/**
 * 作用分级：分类 → 子类 → 任务。
 * 子类为空时归到分类下的"（未分类）"桶，保证索引层次稳定。
 */
export function indexTree(state) {
  const buckets = new Map()
  for (const entry of Object.values(state.tasks)) {
    const category = normalizeCategory(entry.category) || inferCategory(entry.task, entry.best?.approach)
    const subcategory = normalizeCategory(entry.subcategory) || ''
    if (!buckets.has(category)) buckets.set(category, { category, count: 0, subs: new Map() })
    const bucket = buckets.get(category)
    bucket.count += 1
    if (!bucket.subs.has(subcategory)) bucket.subs.set(subcategory, [])
    bucket.subs.get(subcategory).push(entry)
  }
  return [...buckets.values()]
    .map((bucket) => ({
      category: bucket.category,
      count: bucket.count,
      subs: [...bucket.subs.entries()]
        .map(([sub, tasks]) => ({ subcategory: sub, tasks: tasks.slice().sort(byRecent) }))
        .sort((a, b) => b.tasks.length - a.tasks.length)
    }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category))
}

/** 索引的纯文本树（给人看、给模型看都用它） */
export function renderIndexTree(state, options = {}) {
  const maxCategories = Number.isFinite(options.maxCategories) ? Number(options.maxCategories) : 40
  const maxTasksPerSub = Number.isFinite(options.maxTasksPerSub) ? Number(options.maxTasksPerSub) : 40
  const tree = indexTree(state)
  const total = Object.keys(state.tasks).length
  if (!tree.length) return ['（还没有记录最佳方法）']
  const lines = [`共 ${total} 个任务，${tree.length} 个作用分类：`]
  for (const bucket of tree.slice(0, maxCategories)) {
    lines.push(`#### ${bucket.category}（${bucket.count}）`)
    for (const sub of bucket.subs) {
      const subLabel = sub.subcategory ? `**${sub.subcategory}**` : ''
      if (subLabel) lines.push(`- ${subLabel}`)
      for (const t of sub.tasks.slice(0, maxTasksPerSub)) {
        const cost = costText(t.best)
        const prefix = subLabel ? '  - ' : '- '
        lines.push(
          `${prefix}\`${t.key}\` ${clip(t.task, 70)} → ${clip(t.best.approach, 90)}` +
          `（${cost ? `${cost}，` : ''}用过 ${t.best.runs} 次）`
        )
      }
    }
  }
  return lines
}

/**
 * 按作用索引检索：先把查询对到分类/子类/任务/做法/tags 上，
 * 命中越多分越高；完全相同的任务名直接置顶。
 */
export function lookupMethods(state, query, options = {}) {
  const rawQuery = oneLine(query)
  const key = taskKey(rawQuery)
  const limit = Math.max(1, Math.min(20, Number(options.limit) || 3))
  const categoryFilter = normalizeCategory(options.category)
  const exact = key ? state.tasks[key] : undefined
  if (exact) return { exact, hits: [{ entry: exact, score: 999, path: pathOf(exact) }], total: 1 }

  const tokens = rawQuery
    .toLowerCase()
    .split(/[\s,，、;；/\\|]+/)
    .map((t) => t.trim())
    .filter(Boolean)
  if (!tokens.length && !categoryFilter) return { exact: null, hits: [], total: 0 }

  const hits = []
  for (const entry of Object.values(state.tasks)) {
    if (categoryFilter && entry.category !== categoryFilter) continue
    const hay = [
      entry.task,
      entry.category,
      entry.subcategory,
      entry.best?.approach,
      ...(entry.tags ?? []),
      entry.key
    ]
      .join(' ')
      .toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (!token) continue
      if (entry.key.includes(token)) score += 3
      if (String(entry.category).toLowerCase().includes(token)) score += 3
      if (String(entry.subcategory).toLowerCase().includes(token)) score += 2
      if (String(entry.task).toLowerCase().includes(token)) score += 2
      if (String(entry.best?.approach).toLowerCase().includes(token)) score += 1
      if ((entry.tags ?? []).some((tag) => String(tag).toLowerCase().includes(token))) score += 2
    }
    if (score > 0) hits.push({ entry, score, path: pathOf(entry) })
  }
  const sorted = hits.sort((a, b) => b.score - a.score || byRecent(a.entry, b.entry))
  return { exact: null, hits: sorted.slice(0, limit), total: sorted.length }
}

function pathOf(entry) {
  const parts = [entry.category || DEFAULT_CATEGORY]
  if (entry.subcategory) parts.push(entry.subcategory)
  parts.push(entry.task)
  return parts.join(' › ')
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

export function renderMethodbook(state) {
  const sk = state.skepticism
  const lines = []
  lines.push('> 自动维护：质疑度 + 最佳方法库（按作用分级索引）。下方 JSON 是权威数据；要手改请保持 JSON 合法。')
  lines.push('')
  const streak = sk.noGainStreak > 0
    ? `，连续 ${sk.noGainStreak}/${sk.decayAfter} 次未找到更优方法（达到即降一档）`
    : ''
  lines.push(`**质疑度：${sk.level} / ${MAX_SKEPTICISM}**${sk.auto ? `（自动衰减${streak}）` : '（自动衰减已关闭）'}`)
  if (sk.lastChange) {
    lines.push(`最近调整：${sk.lastChange.from} → ${sk.lastChange.to}（${sk.lastChange.reason}，${sk.lastChange.at}）`)
  }
  lines.push('')
  lines.push('### 索引（作用 → 子类 → 任务）')
  lines.push('')
  lines.push(...renderIndexTree(state))
  lines.push('')
  lines.push('```json')
  lines.push(JSON.stringify({ skepticism: sk, tasks: state.tasks }, null, 2))
  lines.push('```')
  return lines.join('\n')
}

/* ------------------------------------------------------------------ */
/* 比较与汇报                                                           */
/* ------------------------------------------------------------------ */

/** 新候选 vs 原最佳：按 token/耗时加权比较，缺数据时退化为只比有数据的那一项 */
export function compareCandidate(candidate, best) {
  const hasTokens =
    Number.isFinite(candidate?.tokens) && Number.isFinite(best?.tokens) && Number(best.tokens) > 0
  const hasTime = Number.isFinite(candidate?.ms) && Number.isFinite(best?.ms) && Number(best.ms) > 0
  if (!hasTokens && !hasTime) {
    return {
      comparable: false,
      better: false,
      score: null,
      why: '两次尝试都没有可比的 token/耗时，无法判定更优，保留原最佳方法'
    }
  }
  let weighted = 0
  let weight = 0
  const parts = []
  if (hasTokens) {
    const r = candidate.tokens / best.tokens
    weighted += TOKEN_WEIGHT * r
    weight += TOKEN_WEIGHT
    parts.push(`token ${candidate.tokens} vs ${best.tokens}（${r.toFixed(2)}×）`)
  }
  if (hasTime) {
    const r = candidate.ms / best.ms
    weighted += TIME_WEIGHT * r
    weight += TIME_WEIGHT
    parts.push(`耗时 ${Math.round(candidate.ms)}ms vs ${Math.round(best.ms)}ms（${r.toFixed(2)}×）`)
  }
  const score = weighted / weight
  return {
    comparable: true,
    better: score < BETTER_THRESHOLD,
    score: Number(score.toFixed(3)),
    why: `${parts.join('；')} ⇒ 综合 ${score.toFixed(2)}×${score < BETTER_THRESHOLD ? '（更优）' : '（未更优）'}`
  }
}

function pickChosen(chose, okAttempts) {
  const want = oneLine(chose).toLowerCase()
  if (want) {
    const exact = okAttempts.find((a) => a.approach.toLowerCase() === want)
    if (exact) return exact
    const partial = okAttempts.find(
      (a) => a.approach.toLowerCase().includes(want) || want.includes(a.approach.toLowerCase())
    )
    if (partial) return partial
  }
  return okAttempts[0] ?? null
}

/**
 * 汇报一次「换方法 → 对比」的结果。
 * @returns {{state: object, decision: object}} 就地修改 state 并返回
 */
export function applyReport(state, payload = {}) {
  const key = taskKey(payload.task)
  if (!key) throw new Error('task 不能为空')
  const nowAt = stamp()
  const scope = String(payload.scope ?? 'global') || 'global'
  const attempts = (Array.isArray(payload.attempts) ? payload.attempts : [])
    .slice(0, 10)
    .map(sanitizeAttempt)
    .filter(Boolean)
  const okAttempts = attempts.filter((a) => a.ok)

  let entry = state.tasks[key]
  const created = !entry
  if (!entry) {
    entry = {
      key,
      task: clip(oneLine(payload.task), 300),
      category: '',
      subcategory: '',
      tags: [],
      scope,
      best: null,
      updatedAt: nowAt,
      attempts: []
    }
    state.tasks[key] = entry
  }
  entry.task = entry.task || clip(oneLine(payload.task), 300)
  if (payload.category !== undefined || !entry.category) {
    entry.category =
      normalizeCategory(payload.category) || entry.category || inferCategory(entry.task, payload.chose)
  }
  if (payload.subcategory !== undefined) entry.subcategory = normalizeCategory(payload.subcategory)
  if (payload.tags !== undefined) entry.tags = normalizeTags(payload.tags)
  entry.scope = scope
  entry.updatedAt = nowAt

  const chosen = pickChosen(payload.chose, okAttempts)
  const decision = {
    key,
    task: entry.task,
    category: entry.category,
    subcategory: entry.subcategory,
    indexPath: pathOf(entry),
    created,
    improved: 'none',
    why: '',
    compare: null,
    level: state.skepticism.level,
    streak: state.skepticism.noGainStreak,
    decayed: false
  }

  if (!entry.best) {
    if (chosen) {
      entry.best = {
        approach: clip(chosen.approach, 400),
        tokens: chosen.tokens,
        ms: chosen.ms,
        at: nowAt,
        runs: 1
      }
      if (!normalizeCategory(payload.category)) {
        entry.category = inferCategory(entry.task, entry.best.approach)
      }
      decision.indexPath = pathOf(entry)
      decision.improved = 'initialized'
      decision.why = `这是该任务记录下来的第一个成功方法，已设为最佳方法（索引：${decision.indexPath}）`
      state.skepticism.noGainStreak = 0
    } else {
      decision.improved = 'failed-only'
      decision.why = '本次没有成功的方法，未记录最佳方法'
    }
  } else if (chosen) {
    const cmp = compareCandidate(chosen, entry.best)
    decision.compare = cmp
    if (cmp.better) {
      const previous = clip(entry.best.approach, 200)
      entry.best = {
        approach: clip(chosen.approach, 400),
        tokens: chosen.tokens,
        ms: chosen.ms,
        at: nowAt,
        runs: 1
      }
      decision.improved = 'replaced'
      decision.why = `新方法更优（${cmp.why}），已替换最佳方法；原方法：${previous}`
      state.skepticism.noGainStreak = 0
    } else {
      decision.improved = 'no-gain'
      decision.why = `新方法没有更优（${cmp.why}），保留原最佳方法`
      entry.best.runs += 1
      state.skepticism.noGainStreak += 1
    }
  } else {
    decision.improved = 'no-success'
    decision.why = '这次换的方式都没成功，保留原最佳方法'
    state.skepticism.noGainStreak += 1
  }

  /* 动态降档：连续 decayAfter 次没找到更优，降一档（到 0 为止） */
  const sk = state.skepticism
  if (sk.auto && sk.noGainStreak >= sk.decayAfter && sk.level > 0) {
    const from = sk.level
    sk.level = Math.max(0, from - 1)
    sk.noGainStreak = 0
    sk.lastChange = { at: nowAt, from, to: sk.level, reason: `连续 ${sk.decayAfter} 次未找到更优方法` }
    decision.decayed = true
  }
  decision.level = sk.level
  decision.streak = sk.noGainStreak

  entry.attempts = [...entry.attempts, ...attempts].slice(-MAX_ATTEMPTS_KEPT)

  /* 任务数上限：按最近使用时间淘汰 */
  const keys = Object.keys(state.tasks)
  if (keys.length > MAX_TASKS) {
    const stale = keys
      .sort((a, b) => String(state.tasks[a].updatedAt).localeCompare(String(state.tasks[b].updatedAt)))
      .slice(0, keys.length - MAX_TASKS)
    for (const k of stale) delete state.tasks[k]
  }
  return { state, decision }
}

/** 给模型的"这次该怎么做"说明：先给索引命中，再给质疑度要求 */
export function queryBrief(state, task, options = {}) {
  const sk = state.skepticism
  const found = lookupMethods(state, task, { limit: 3, category: options.category })
  const lines = []
  lines.push(`任务：${oneLine(task) || '（空）'}`)
  lines.push(`质疑度：${sk.level} / ${MAX_SKEPTICISM}${sk.auto ? '（自动衰减）' : '（手动设定）'}`)
  lines.push('')

  if (!found.exact && !found.hits.length) {
    lines.push('索引命中：无（这是新任务）。')
    lines.push(
      sk.level > 0
        ? '要求：正常按你的判断做；完成后用 memory_file_method({action:"report"}) 把最终成功的方法（附 category 作用分类、token/耗时估算）记一次，插件会建索引。'
        : '质疑度 0：直接做，不用额外试错；完成后 report 一次即可，插件会建索引。'
    )
    return lines.join('\n')
  }

  const primary = found.exact
    ? { entry: found.exact, score: 999, path: pathOf(found.exact) }
    : found.hits[0]
  const entry = primary.entry
  lines.push('索引命中：')
  lines.push(`- 索引路径：${primary.path}`)
  const cost = costText(entry.best)
  lines.push(`- 最佳方法：${entry.best.approach}${cost ? `（${cost}，用过 ${entry.best.runs} 次）` : `（用过 ${entry.best.runs} 次）`}`)
  if (found.hits.length > 1 || (!found.exact && found.total > 1)) {
    const others = found.hits.slice(1, 3).map((h) => h.path)
    if (others.length) lines.push(`- 同索引下的相关条目：${others.join('；')}`)
  }
  lines.push('')

  if (sk.level === 0) {
    lines.push('要求：质疑度 0，直接用上面这个方法，不再额外试错。')
    lines.push(`完成后如需登记使用次数，可用 memory_file_method({action:"report", task:"${oneLine(task).slice(0, 60)}", chose:"${entry.best.approach.slice(0, 40)}", attempts:[{approach:"${entry.best.approach.slice(0, 40)}", ok:true, tokens:0, ms:0}]})`)
    return lines.join('\n')
  }
  lines.push(`要求：**不要直接照搬上面这个方法**。把它当候选，强制自己再设计并实际执行 ${sk.level} 种与它明显不同的做法（换工具、换顺序、换粒度都算）。`)
  lines.push('每种都记录 token 估算和耗时（毫秒），做完用 memory_file_method({action:"report", task:"…", category:"…", attempts:[…], chose:"…"}) 汇报，插件会对比择优并更新索引里的最佳方法。')
  lines.push('如果换完都不如原方法，report 时把 chose 写成原方法的做法即可，插件会记一次"未更优"并累计降档计数。')
  return lines.join('\n')
}

/** 汇总成结构，给工具回执 / 网页用 */
export function summarizeSkepticism(state) {
  const sk = state.skepticism
  const tree = indexTree(state)
  return {
    level: sk.level,
    max: MAX_SKEPTICISM,
    auto: sk.auto,
    decayAfter: sk.decayAfter,
    noGainStreak: sk.noGainStreak,
    lastChange: sk.lastChange,
    taskCount: Object.keys(state.tasks).length,
    categories: tree.map((bucket) => ({
      category: bucket.category,
      count: bucket.count,
      subs: bucket.subs.map((sub) => ({
        subcategory: sub.subcategory,
        tasks: sub.tasks.map((t) => ({
          key: t.key,
          task: t.task,
          best: t.best.approach,
          tokens: t.best.tokens,
          ms: t.best.ms,
          runs: t.best.runs
        }))
      }))
    }))
  }
}
