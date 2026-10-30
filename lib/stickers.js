/**
 * dsh-shared-memory / stickers.js
 *
 * 「表情包」：用户自己导入图片，插件负责**扫描 / 分类 / 挑选 / 记账**。
 * 插件不带任何内置图片，也不生成图片——只做"什么时候该发哪张"的决策支持。
 *
 * 目录：<memoryDir>/stickers/（可用 config.stickerDir 覆盖）
 * 索引：<stickers>/index.json —— 记住每张图的情绪标签、用过几次、上次什么时候用
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { oneLine, clip } from './store.js'

export const IMAGE_EXT = ['.webp', '.png', '.gif', '.jpg', '.jpeg']
export const MAX_STICKERS = 500

/** 情绪关键词 → 命中就算这个标签（中英都收） */
const MOOD_RULES = [
  ['shy', /害羞|捂脸|脸红|羞|羞耻|shy|blush/i],
  ['angry', /气|怒|哼|不爽|生气|气鼓鼓|炸毛|抗议|angry|mad|pout/i],
  ['sad', /哭|委屈|崩溃|难过|破防|泪|sad|cry/i],
  ['happy', /开心|笑|高兴|嘿嘿|happy|laugh|smile/i],
  ['proud', /夸|得意|牛|骄傲|棒|求夸|proud/i],
  ['sleepy', /困|睡|打盹|晚安|哈欠|sleep|tired|nap/i],
  ['tease', /撩|勾引|色|涩|诱惑|亲|抱|tease|flirt|kiss/i],
  ['hungry', /饿|吃|饭|干饭|白饭|rice|food|eat/i],
  ['lazy', /摸鱼|偷懒|躺|懒|lazy/i],
  ['love', /爱|喜欢|心|love|heart/i],
  ['confused', /问号|疑惑|不懂|confus|\?/i],
  ['speechless', /无语|尴尬|扶额|speechless/i],
  ['money', /钱|穷|破产|money|poor/i]
]

export function stickersDir(options = {}) {
  if (options.stickerDir) return path.resolve(String(options.stickerDir))
  if (process.env.DSH_STICKERS_DIR) return path.resolve(process.env.DSH_STICKERS_DIR)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'dsh-shared-memory', 'stickers')
}

export function ensureStickersDir(options = {}) {
  const dir = stickersDir(options)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 只读目录下也能继续跑 */
  }
  return dir
}

/** 从文件名猜情绪标签（用户自己的命名越清楚，分类越准） */
export function classifyByFilename(name) {
  const base = String(name ?? '')
  const moods = []
  for (const [mood, re] of MOOD_RULES) {
    if (re.test(base)) moods.push(mood)
  }
  return moods
}

function indexPath(dir) {
  return path.join(dir, 'index.json')
}

export function readIndex(options = {}) {
  const dir = stickersDir(options)
  try {
    const raw = JSON.parse(readFileSync(indexPath(dir), 'utf8'))
    return raw && typeof raw === 'object' && raw.files && typeof raw.files === 'object' ? raw : { version: 1, files: {} }
  } catch {
    return { version: 1, files: {} }
  }
}

function writeIndex(index, options = {}) {
  const dir = ensureStickersDir(options)
  const file = indexPath(dir)
  try {
    writeFileSync(file, JSON.stringify(index, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 扫描目录 + 合并用户标签（用户 label 优先于文件名启发式） */
export function scanStickers(options = {}) {
  const dir = stickersDir(options)
  if (!existsSync(dir)) return []
  const index = readIndex(options)
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const ext = path.extname(entry.name).toLowerCase()
    if (!IMAGE_EXT.includes(ext)) continue
    if (entry.name.startsWith('_')) continue
    const record = index.files[entry.name] ?? {}
    const guessed = classifyByFilename(entry.name)
    const moods = Array.isArray(record.moods) && record.moods.length ? record.moods : guessed
    let bytes = 0
    try {
      bytes = statSync(path.join(dir, entry.name)).size
    } catch {
      /* 忽略 */
    }
    out.push({
      file: entry.name,
      path: path.join(dir, entry.name),
      bytes,
      moods: moods.map((m) => String(m).toLowerCase()),
      guessed,
      used: Number(record.used) || 0,
      lastUsed: record.lastUsed ?? null
    })
    if (out.length >= MAX_STICKERS) break
  }
  // 小图（webp）优先，避免每次发大 png
  return out.sort((a, b) => a.bytes - b.bytes)
}

/** 把「害羞」「被夸」这类词归一到规范情绪（shy…），匹配时才不会中英对不上 */
export function normalizeMood(word) {
  const value = String(word ?? '')
    .trim()
    .toLowerCase()
  if (!value) return ''
  for (const [mood, re] of MOOD_RULES) {
    if (mood === value || re.test(value)) return mood
  }
  return value
}

/** 按情绪挑一张：命中越多越靠前；刚用过的同表情降权，避免连发同一张 */
export function matchSticker(mood, options = {}) {
  const wanted = String(mood ?? '')
    .split(/[\s,，、/+]+/)
    .map(normalizeMood)
    .filter(Boolean)
  const list = scanStickers(options)
  if (!list.length) return null
  const excluded = new Set((options.exclude ?? []).map((v) => String(v).toLowerCase()))
  const scored = []
  for (const item of list) {
    let score = 0
    for (const w of wanted) {
      if (item.moods.includes(w)) score += 3
      else if (item.moods.some((m) => m.includes(w) || w.includes(m))) score += 1
    }
    if (!score) continue
    if (item.lastUsed && Date.now() - Date.parse(item.lastUsed) < 1000 * 60 * 30) score -= 1
    if (excluded.has(item.file.toLowerCase())) score -= 100
    scored.push({ ...item, score })
  }
  if (!scored.length) return null
  scored.sort((a, b) => b.score - a.score || a.bytes - b.bytes)
  return scored[0].score > 0 ? scored[0] : null
}

/** 记一次使用（防连发、算使用频率） */
export function recordUsage(file, options = {}) {
  const name = path.basename(String(file ?? ''))
  if (!name) return null
  const index = readIndex(options)
  const record = index.files[name] ?? {}
  record.used = (Number(record.used) || 0) + 1
  record.lastUsed = new Date().toISOString()
  if (!Array.isArray(record.moods) || !record.moods.length) record.moods = classifyByFilename(name)
  index.files[name] = record
  writeIndex(index, options)
  return record
}

/** 覆盖某张图的情绪标签（模型看过图之后可以纠正分类） */
export function setTags(file, moods, options = {}) {
  const name = path.basename(String(file ?? ''))
  if (!name) throw new Error('需要文件名')
  const index = readIndex(options)
  const record = index.files[name] ?? {}
  record.moods = (Array.isArray(moods) ? moods : String(moods ?? '').split(/[\s,，、/]+/))
    .map((m) => oneLine(m).toLowerCase())
    .filter(Boolean)
    .slice(0, 12)
  index.files[name] = record
  writeIndex(index, options)
  return record
}

/** 提示词用的摘要 */
export function stickersSummary(options = {}) {
  const list = scanStickers(options)
  const moods = new Map()
  for (const item of list) for (const m of item.moods) moods.set(m, (moods.get(m) ?? 0) + 1)
  return {
    count: list.length,
    dir: stickersDir(options),
    moods: [...moods.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m).slice(0, 12),
    sample: list.slice(0, 3).map((item) => ({ file: item.file, moods: item.moods }))
  }
}
