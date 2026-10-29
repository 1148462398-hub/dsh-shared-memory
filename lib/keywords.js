/**
 * dsh-shared-memory / keywords.js
 *
 * 给每条记忆打「关键词索引标签」。零依赖、纯函数，两个目的：
 *  1. 写入时就算好关键词，检索时不必每次重新分词
 *  2. 命中频率按关键词统计，用来决定这条记忆留在主文件还是进归档
 *
 * 中文没有内置分词器，这里用最稳的 2-gram（相邻两字）兜底：
 *   "双硬盘分区镜像" → 双硬 / 硬盘 / 盘分 / 分区 / 镜像
 * 召回够用，误命中靠"所有关键词都要命中"的检索规则压住。
 */

/** 只过滤高频虚词，不碰"中/时/用/内"这类在技术词里有意义的字 */
const STOP_CHARS = new Set('的了是在和与就也都而及或把被让从到对为以这那我你他它们个之其又再很更吧呢吗啊呀哦'.split(''))

const MAX_KEYWORDS = 12

/** ASCII 词、标识符、命令名、路径片段 */
const ASCII_RE = /[a-z][a-z0-9_#.@/-]{1,}/g
/** 连续中文 */
const CJK_RUN_RE = /[\u4e00-\u9fa5]+/g

function pushUnique(list, seen, word, weight) {
  if (!word || seen.has(word)) return
  seen.add(word)
  list.push({ word, weight })
}

/**
 * 抽关键词。权重：ASCII 词 2 分（通常是专有名词/命令），中文 2-gram 1 分。
 * 同分时保留"先出现"的，因为一条记忆通常先给主题、后给细节。
 */
export function extractKeywords(text, max = MAX_KEYWORDS) {
  const source = String(text ?? '').toLowerCase()
  if (!source) return []
  const list = []
  const seen = new Set()

  for (const match of source.matchAll(ASCII_RE)) {
    const word = match[0].replace(/[./-]+$/, '')
    if (word.length >= 2) pushUnique(list, seen, word, 2)
  }

  for (const run of source.matchAll(CJK_RUN_RE)) {
    const chunk = run[0]
    if (chunk.length === 1) {
      if (!STOP_CHARS.has(chunk)) pushUnique(list, seen, chunk, 1)
      continue
    }
    for (let i = 0; i + 2 <= chunk.length; i += 1) {
      const bigram = chunk.slice(i, i + 2)
      if (STOP_CHARS.has(bigram[0]) || STOP_CHARS.has(bigram[1])) continue
      pushUnique(list, seen, bigram, 1)
    }
  }

  return list
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .slice(0, Math.max(1, max))
    .map((item) => item.word)
}

/** 查询串 → 检索词（不做 2-gram 展开，按用户/模型给的原词匹配） */
export function queryTokens(rawQuery) {
  return String(rawQuery ?? '')
    .toLowerCase()
    .split(/[\s,，、;；/\\|]+/)
    .map((t) => t.trim())
    .filter(Boolean)
}

/** 一条记忆的关键词是否覆盖查询（全部命中才算） */
export function matchesAll(keywords, tokens) {
  if (!tokens.length) return true
  const hay = keywords.join(' ')
  return tokens.every((token) => hay.includes(token))
}

/* ------------------------------------------------------------------ */
/* 模糊匹配 / 联想匹配 / 相似度                                         */
/* ------------------------------------------------------------------ */

function grams(text) {
  const out = new Set()
  const s = String(text ?? '')
  for (let i = 0; i + 2 <= s.length; i += 1) out.add(s.slice(i, i + 2))
  return out
}

function isAscii(word) {
  return /^[a-z0-9_.@/#-]+$/i.test(String(word ?? ''))
}

/** ASCII 词编辑距离 ≤1（只对长度 ≥4 的词做，短词误配太多） */
function withinOneEdit(a, b) {
  if (!a || !b) return false
  if (Math.abs(a.length - b.length) > 1) return false
  let i = 0
  let j = 0
  let diff = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1
      j += 1
      continue
    }
    diff += 1
    if (diff > 1) return false
    if (a.length > b.length) i += 1
    else if (a.length < b.length) j += 1
    else {
      i += 1
      j += 1
    }
  }
  return diff + (a.length - i) + (b.length - j) <= 1
}

/** 中文部分重叠：查询词与任一关键词共享 2-gram，或互为子串；ASCII 只做子串（避免 'as' 这种 2 字噪声） */
export function partialOverlap(keywords, token) {
  const t = String(token ?? '')
  if (t.length < 2) return false
  const hasCjk = /[\u4e00-\u9fa5]/.test(t)
  const tg = hasCjk ? grams(t) : null
  for (const kw of keywords ?? []) {
    const word = String(kw ?? '')
    if (word.length < 2) continue
    if (word.includes(t) || t.includes(word)) return true
    if (!tg) continue
    for (const g of grams(word)) if (tg.has(g)) return true
  }
  return false
}

/** 拼写近似（只对 ASCII 词生效） */
export function nearKeyword(keywords, token) {
  const t = String(token ?? '')
  if (!isAscii(t) || t.length < 4) return ''
  for (const kw of keywords ?? []) {
    const word = String(kw ?? '')
    if (!isAscii(word) || word.length < 4) continue
    if (withinOneEdit(word, t)) return word
  }
  return ''
}

/**
 * 打分：不再要求“所有查询词都命中”，而是每个词尽力匹配一次。
 * exact 3 / partial 2 / near 2 / associated 1；完全没命中的词不加分、也不否决。
 */
export function scoreEntry(keywords, text, tokens, associations = []) {
  const kws = Array.isArray(keywords) ? keywords.filter(Boolean) : []
  const hay = String(text ?? '').toLowerCase()
  const reasons = []
  let score = 0
  for (const raw of tokens ?? []) {
    const token = String(raw ?? '').toLowerCase()
    if (!token) continue
    if (hay.includes(token) || kws.some((kw) => kw.includes(token))) {
      score += 3
      reasons.push(`exact:${token}`)
      continue
    }
    if (partialOverlap(kws, token)) {
      score += 2
      reasons.push(`partial:${token}`)
      continue
    }
    const near = nearKeyword(kws, token)
    if (near) {
      score += 2
      reasons.push(`near:${token}~${near}`)
      continue
    }
    const assoc = associations.find((item) => item?.term && kws.includes(item.term))
    if (assoc) {
      score += 1
      reasons.push(`assoc:${token}~${assoc.term}`)
    }
  }
  return { score, reasons }
}

/** 关键词集合相似度（整合候选扫描用） */
export function jaccard(a, b) {
  const setA = new Set((a ?? []).map((x) => String(x)))
  const setB = new Set((b ?? []).map((x) => String(x)))
  if (!setA.size && !setB.size) return 0
  let inter = 0
  for (const x of setA) if (setB.has(x)) inter += 1
  const union = setA.size + setB.size - inter
  return union > 0 ? inter / union : 0
}

export function sharedKeywords(a, b) {
  const setB = new Set((b ?? []).map((x) => String(x)))
  return (a ?? []).map(String).filter((x) => setB.has(x))
}

/* ------------------------------------------------------------------ */
/* BM25 排序（纯统计，不需要任何模型）                                  */
/* ------------------------------------------------------------------ */

/** 文档分词：ASCII 词 + 中文 2-gram（与关键词抽取同一套切法） */
export function tokenize(text) {
  const source = String(text ?? '').toLowerCase()
  const out = []
  for (const match of source.matchAll(/[a-z][a-z0-9_#.@/-]{1,}/g)) out.push(match[0])
  for (const run of source.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const chunk = run[0]
    if (chunk.length === 1) out.push(chunk)
    for (let i = 0; i + 2 <= chunk.length; i += 1) out.push(chunk.slice(i, i + 2))
  }
  return out
}

/**
 * BM25 打分：词频饱和（k1）+ 文档长度归一（b）+ 逆文档频率。
 * 纯本地统计函数，不联网、不调模型。
 * @param {Array<{id: string, text: string}>} docs
 * @param {string[]} queryTokens
 * @returns {Map<string, number>} id → 分数
 */
export function bm25(docs, queryTokens, options = {}) {
  const k1 = Number.isFinite(options.k1) ? Number(options.k1) : 1.2
  const b = Number.isFinite(options.b) ? Number(options.b) : 0.75
  const tokens = (queryTokens ?? []).map((t) => String(t).toLowerCase()).filter(Boolean)
  const scores = new Map()
  if (!Array.isArray(docs) || !docs.length || !tokens.length) return scores

  const docTokens = docs.map((doc) => tokenize(doc.text))
  const total = docTokens.reduce((sum, list) => sum + list.length, 0)
  const avgLen = total / docs.length || 1

  const df = new Map()
  for (const list of docTokens) {
    for (const term of new Set(list)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  const n = docs.length

  docs.forEach((doc, index) => {
    const list = docTokens[index]
    const len = list.length || 1
    const tf = new Map()
    for (const term of list) tf.set(term, (tf.get(term) ?? 0) + 1)
    let score = 0
    for (const term of tokens) {
      const freq = tf.get(term) ?? 0
      if (!freq) continue
      const docsWith = df.get(term) ?? 0
      const idf = Math.log(1 + (n - docsWith + 0.5) / (docsWith + 0.5))
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (len / avgLen))))
    }
    if (score > 0) scores.set(doc.id, score)
  })
  return scores
}

export { MAX_KEYWORDS, STOP_CHARS }
