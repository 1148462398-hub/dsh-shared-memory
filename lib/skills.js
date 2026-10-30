/**
 * dsh-shared-memory / skills.js
 *
 * 「技能」= DSH 原生技能目录里的一个 SKILL.md（`~/.dsh/skills/<name>/SKILL.md`）。
 * 这里只做读写、匹配、统计，**不执行任何代码**：
 * 技能正文是操作手册，脚本只作为文档保存，运行必须另走「用户确认 → 执行」的流程。
 *
 * 目录与格式跟 DSH 自己的技能一致（frontmatter: name / description / user-invocable），
 * 所以写进去的技能下次会话就能出现在技能目录里。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { oneLine, clip } from './store.js'
import { tokenize } from './keywords.js'

export const MAX_BODY_CHARS = 20000

/** 技能根目录（每次调用时读环境变量，便于测试与迁移） */
export function skillsDir() {
  if (process.env.DSH_SKILLS_DIR) return path.resolve(process.env.DSH_SKILLS_DIR)
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'skills')
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,40}$/

export function assertSkillName(name) {
  const value = String(name ?? '').trim().toLowerCase()
  if (!NAME_RE.test(value)) {
    throw new Error(`技能名只能用小写字母/数字/连字符，2-41 个字：${name}`)
  }
  return value
}

/** 技能目录；带越界检查，任何情况下都不会指到技能根目录之外 */
export function skillDir(name) {
  const safe = assertSkillName(name)
  const root = path.resolve(skillsDir())
  const dir = path.resolve(path.join(root, safe))
  if (dir !== path.join(root, safe) || !dir.startsWith(root + path.sep)) {
    throw new Error('技能路径越界，已拒绝')
  }
  return dir
}

/** 极简 frontmatter 解析：只认 `key: value` 与 `key: [a, b]`，不引 yaml 依赖 */
export function parseSkillFile(text) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!match) return { meta: {}, body: raw.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const m = /^([a-zA-Z-]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    let value = m[2].trim()
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value
        .slice(1, -1)
        .split(',')
        .map((item) => item.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
    } else {
      value = value.replace(/^["']|["']$/g, '')
    }
    meta[key] = value
  }
  return { meta, body: raw.slice(match[0].length).trim() }
}

export function readSkill(name) {
  const dir = skillDir(name)
  const file = path.join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  const { meta, body } = parseSkillFile(readFileSync(file, 'utf8'))
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    /* 忽略 */
  }
  return { name: assertSkillName(name), meta, body, path: file, bytes: size }
}

/** 列出所有技能（读 frontmatter，不读正文） */
export function listSkills() {
  const root = skillsDir()
  if (!existsSync(root)) return []
  const out = []
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (!NAME_RE.test(entry.name)) continue
    const skill = (() => {
      try {
        return readSkill(entry.name)
      } catch {
        return null
      }
    })()
    if (!skill) continue
    out.push({
      name: skill.name,
      description: String(skill.meta.description ?? ''),
      triggers: Array.isArray(skill.meta.triggers) ? skill.meta.triggers : [],
      bytes: skill.bytes,
      ok: Number(readStats(entry.name).ok) || 0,
      fail: Number(readStats(entry.name).fail) || 0,
      path: skill.path
    })
  }
  return out.sort((a, b) => (b.ok + b.fail) - (a.ok + a.fail) || a.name.localeCompare(b.name))
}

function statsPath(name) {
  return path.join(skillDir(name), 'stats.json')
}

export function readStats(name) {
  try {
    return JSON.parse(readFileSync(statsPath(name), 'utf8'))
  } catch {
    return {}
  }
}

export function bumpStats(name, ok) {
  const dir = skillDir(name)
  if (!existsSync(dir)) throw new Error(`技能不存在：${name}`)
  const stats = readStats(name)
  const key = ok ? 'ok' : 'fail'
  stats[key] = (Number(stats[key]) || 0) + 1
  stats.lastRunAt = new Date().toISOString()
  writeFileSync(statsPath(name), JSON.stringify(stats, null, 2), 'utf8')
  return stats
}

/** 写技能：正文超限直接拒绝；原子替换 */
export function saveSkill({ name, description, triggers = [], body, userInvocable = true }) {
  const safe = assertSkillName(name)
  const dir = skillDir(safe)
  const text = String(body ?? '').trim()
  if (!text) throw new Error('技能正文不能为空')
  if (text.length > MAX_BODY_CHARS) throw new Error(`技能正文过长（>${MAX_BODY_CHARS} 字符）`)
  const desc = oneLine(description).slice(0, 300)
  if (!desc) throw new Error('需要 description（一句话说明什么时候用这个技能）')
  const triggerList = (Array.isArray(triggers) ? triggers : String(triggers ?? '').split(','))
    .map((item) => oneLine(item))
    .filter(Boolean)
    .slice(0, 20)

  mkdirSync(dir, { recursive: true })
  const lines = [
    '---',
    `name: ${safe}`,
    `description: ${JSON.stringify(desc)}`,
    ...(triggerList.length ? [`triggers: [${triggerList.map((t) => JSON.stringify(t)).join(', ')}]`] : []),
    `user-invocable: ${userInvocable ? 'true' : 'false'}`,
    'created-by: dsh-shared-memory',
    `updated-at: ${new Date().toISOString()}`,
    '---',
    '',
    text,
    ''
  ]
  const file = path.join(dir, 'SKILL.md')
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, lines.join('\n'), 'utf8')
  renameSync(tmp, file)
  return { name: safe, path: file, bytes: Buffer.byteLength(lines.join('\n')) }
}

export function removeSkill(name) {
  const dir = skillDir(name)
  if (!existsSync(dir)) throw new Error(`技能不存在：${name}`)
  rmSync(dir, { recursive: true, force: true })
  return true
}

/**
 * 按任务匹配自有技能：任务分词后与 name/description/triggers 求交，
 * 命中越多的越靠前；完全没命中不算候选。
 */
export function matchSkills(task, options = {}) {
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 3))
  const tokens = tokenize(task)
  if (!tokens.length) return []
  const scored = []
  for (const skill of listSkills()) {
    const hay = `${skill.name} ${skill.description} ${skill.triggers.join(' ')}`.toLowerCase()
    let score = 0
    const hits = []
    for (const token of new Set(tokens)) {
      if (!token) continue
      if (hay.includes(token)) {
        score += 1
        hits.push(token)
      }
    }
    if (!score) continue
    // 触发词整串命中额外加分（triggers 是"什么时候用"的强信号）
    for (const trigger of skill.triggers) {
      if (trigger && String(task).toLowerCase().includes(String(trigger).toLowerCase())) score += 2
    }
    const total = skill.ok + skill.fail
    const successRate = total ? skill.ok / total : null
    scored.push({ ...skill, score, hits, successRate })
  }
  return scored.sort((a, b) => b.score - a.score || (b.successRate ?? 0) - (a.successRate ?? 0)).slice(0, limit)
}

/** 给提示词的一句话摘要 */
export function skillsSummary() {
  const skills = listSkills()
  return {
    count: skills.length,
    names: skills.slice(0, 8).map((s) => s.name),
    top: skills.slice(0, 3).map((s) => ({ name: s.name, description: clip(s.description, 60) }))
  }
}
