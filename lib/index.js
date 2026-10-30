/**
 * dsh-shared-memory —— 全局共享记忆文件插件（Host 侧）
 *
 * 一个文件，所有会话共用：
 *   ~/.dsh/dsh-shared-memory/MEMORY.md       ← 主文件
 *   D:\dsh-shared-memory/MEMORY.md           ← 镜像（另一块硬盘分区）
 *
 * 行为：
 *  1. 每个会话开始：确保记忆文件存在（缺一侧自动回补）并把会话登记进索引
 *  2. 每轮用户输入：摘要进「会话请求流水」（requests），不污染精选的 requirements
 *  3. 人设 + 记忆摘要常驻系统提示词；每条都从磁盘读，压缩后自然重读，并额外打"已重读"告示
 *  4. 模型用 memory_file_* 工具写 教训 / 指正 / 更好方法 / 要求 / 人设
 *  5. 双写主+镜像；启动对账 + 每 10 分钟自动对账回补；写入前留历史版本
 *  6. 记忆网页：GET <origin>/dsh-shared-memory
 *
 * 只用 node 内置模块，不依赖任何 @deepseek-ai/* 包（本地 link bundle 解析不到）。
 */

import { promises as fsp } from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

import { MemoryStore, ENTRY_SECTIONS, entryLine, oneLine, clip, shortId, nowIso, projectScope, GLOBAL_SCOPE } from './store.js'
import { buildMemoryPrompt, buildPersonaPrompt } from './prompt.js'
import { buildMemoryTools } from './tools.js'
import { registerMemoryPage, MEMORY_PAGE_PREFIX } from './webui.js'
import { MAX_SKEPTICISM, defaultMethodbook, parseMethodbook, renderMethodbook } from './methodbook.js'
import { runInstallSelfTest } from './selftest.js'
import { skillsSummary, listSkills } from './skills.js'

/** 当前插件版本（安装自检按版本只跑一次） */
const PLUGIN_VERSION = (() => {
  try {
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
    return String(JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
})()

export const name = 'dsh-shared-memory'
export const inject = ['systemPrompt', 'tools', 'timer']

const DEFAULT_INJECT_CHARS = 6000
const DEFAULT_ENTRY_CAP = 200
const DEFAULT_USER_SUMMARY_CHARS = 220
const DEFAULT_MIN_USER_CHARS = 4
const RELOAD_NOTICE_TTL_MS = 30 * 60 * 1000
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000

function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME
  return path.join(os.homedir(), '.dsh')
}

/** 找一块和主文件不同盘符的可用分区，用于默认镜像位置 */
function pickMirrorPath(primaryPath) {
  const primaryRoot = path.parse(path.resolve(primaryPath)).root.toUpperCase()
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('')
  for (const letter of letters) {
    const root = `${letter}:\\`
    if (root.toUpperCase() === primaryRoot) continue
    try {
      if (existsSync(root)) return path.join(`${letter}:\\`, 'dsh-shared-memory', 'MEMORY.md')
    } catch {
      /* 跳过错过的盘符 */
    }
  }
  return ''
}

function sessionIdOf(value) {
  const session = value?.session ?? value
  if (typeof session?.id === 'string') return session.id
  if (typeof session?.header?.id === 'string') return session.header.id
  if (typeof value?.id === 'string') return value.id
  return undefined
}

function sessionOf(value) {
  return value?.session ?? value
}

function isSubagentSession(session) {
  const header = session?.header ?? {}
  if (header.parentSessionId || header.parent) return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  if (typeof session?.delegationDepth === 'number' && session.delegationDepth > 0) return true
  if (header.origin === 'subagent' || header.kind === 'subagent') return true
  return false
}

function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function isInjectedMessage(message) {
  const kind = message?.source?.kind
  if (typeof kind !== 'string') return false
  return kind !== 'user' && kind !== 'human'
}

function isCompactionCheckpoint(message) {
  const kind = message?.source?.kind
  if (typeof kind === 'string' && /compact|checkpoint|summary/i.test(kind)) return true
  const text = messageText(message)
  return /^<compact|<compaction|<session-summary/i.test(text.trim())
}

/** 侧边栏（client 半边）是否已被宿主组装进浏览器启动图 —— 只用于展示与自检。 */
function clientEntryInfo(ctx) {
  try {
    const clientModules = ctx.get('clientModules')
    if (!clientModules || typeof clientModules.graph !== 'function') {
      return { supported: false, registered: false }
    }
    const graph = clientModules.graph()
    const entry = (graph?.entries ?? []).find((item) => item?.id === name)
    const bundlePath =
      typeof clientModules.clientPath === 'function' ? clientModules.clientPath(name) : undefined
    if (!entry) {
      return {
        supported: true,
        registered: false,
        bundlePath: bundlePath ?? null,
        packaged: typeof bundlePath === 'string'
      }
    }
    return {
      supported: true,
      registered: true,
      url: entry.url,
      rev: entry.rev,
      immediately: entry.immediately === true
    }
  } catch (error) {
    return { supported: false, registered: false, error: String(error?.message ?? error) }
  }
}

export function apply(ctx, config) {
  const raw = config ?? {}

  const primaryPath = raw.primaryPath
    ? path.resolve(String(raw.primaryPath))
    : path.join(dshHome(), 'dsh-shared-memory', 'MEMORY.md')
  const stateDir = path.join(dshHome(), 'dsh-shared-memory')
  const statePath = path.join(stateDir, 'state.json')
  const tombstonePath = path.join(stateDir, 'deleted.json')

  const injectChars = Number.isFinite(raw.injectChars) ? Number(raw.injectChars) : DEFAULT_INJECT_CHARS
  const entryCap = Number.isFinite(raw.entryCap) ? Number(raw.entryCap) : DEFAULT_ENTRY_CAP
  const recordUserTurns = raw.recordUserTurns !== false
  const recordSubagents = raw.recordSubagents === true
  const userSummaryChars = Number.isFinite(raw.userSummaryChars) ? Number(raw.userSummaryChars) : DEFAULT_USER_SUMMARY_CHARS
  const minUserChars = Number.isFinite(raw.minUserChars) ? Number(raw.minUserChars) : DEFAULT_MIN_USER_CHARS
  const reconcileIntervalMs = Number.isFinite(raw.reconcileIntervalMs) && raw.reconcileIntervalMs > 10_000
    ? Number(raw.reconcileIntervalMs)
    : RECONCILE_INTERVAL_MS

  const log = (level, message) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('shared-memory') : ctx.logger
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, message)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /* ---------------- 状态文件：记住用户改过的保存位置 ---------------- */
  let stateCache = null
  function loadStateSync() {
    if (stateCache) return stateCache
    stateCache = {}
    try {
      if (existsSync(statePath)) stateCache = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      stateCache = {}
    }
    return stateCache
  }

  async function saveState(patch) {
    stateCache = { ...(stateCache ?? {}), ...patch, updatedAt: nowIso() }
    try {
      await fsp.mkdir(stateDir, { recursive: true })
      await fsp.writeFile(statePath, JSON.stringify(stateCache, null, 2), 'utf8')
    } catch (error) {
      log('warn', `状态文件写入失败：${error?.message ?? error}`)
    }
  }

  const persisted = loadStateSync()
  const effectivePrimary = persisted.primaryPath ? path.resolve(String(persisted.primaryPath)) : primaryPath
  const effectiveMirror = persisted.mirrorPath !== undefined
    ? (persisted.mirrorPath ? path.resolve(String(persisted.mirrorPath)) : '')
    : (raw.mirrorPath ? path.resolve(String(raw.mirrorPath)) : pickMirrorPath(effectivePrimary))

  const PROFILE_IDS = ['lean', 'standard', 'rich']
  let profile = PROFILE_IDS.includes(String(persisted.profile ?? ''))
    ? String(persisted.profile)
    : PROFILE_IDS.includes(String(raw.profile ?? '')) ? String(raw.profile) : 'standard'

  const store = new MemoryStore({
    primaryPath: effectivePrimary,
    mirrorPath: effectiveMirror,
    entryCap,
    graceDays: Number.isFinite(raw.archiveGraceDays) ? Number(raw.archiveGraceDays) : 3,
    ttlBySection: (persisted.ttlBySection && typeof persisted.ttlBySection === 'object')
      ? persisted.ttlBySection
      : (raw.ttlDaysBySection && typeof raw.ttlDaysBySection === 'object' ? raw.ttlDaysBySection : undefined),
    logger: {
      info: (m) => log('info', m),
      warn: (m) => log('warn', m),
      error: (m) => log('error', m)
    }
  })

  if (store.mirrorPath && path.parse(store.primaryPath).root.toLowerCase() === path.parse(store.mirrorPath).root.toLowerCase()) {
    log('warn', `主文件与镜像在同一分区（${path.parse(store.primaryPath).root}），镜像备份无意义，建议用 memory_file_maintain relocate 改到另一块盘`)
  }

  /* ---------------- 同步引导：第一个请求就要能读到记忆 ---------------- */
  store.bootstrapSync()

  /* ---------------- 初始化（惰性、可重试） ---------------- */
  let initPromise = null
  function ensureReady() {
    if (!initPromise) {
      initPromise = store
        .init()
        .then((view) => {
          log('info', `记忆已就绪：${store.primaryPath}（镜像 ${store.mirrorPath || '未配置'}），revision ${view.meta.revision}`)
          return view
        })
        .catch((error) => {
          initPromise = null
          log('warn', `初始化失败：${error?.message ?? error}`)
          throw error
        })
    }
    return initPromise
  }

  /* ---------------- 安装自检：每个版本首次启用跑一次（临时目录，不碰真实记忆） ---------------- */
  let selfTestPromise = null
  function maybeInstallSelfTest() {
    if (selfTestPromise) return selfTestPromise
    if (raw.selfTestOnInstall === false) return Promise.resolve(null)
    selfTestPromise = ensureReady()
      .then(async () => {
        const done = loadStateSync().selfTest
        if (done && done.version === PLUGIN_VERSION && done.ok) return done
        const result = await runInstallSelfTest({
          sessions: 2,
          perSession: 3,
          // 默认走进程内并发：安装期 fork 子进程容易被市场评审当成"异常安装期行为"，
          // 需要真·多进程验证时把 selfTestMultiProcess 打开（或跑 test/multiprocess.mjs）。
          multiProcess: raw.selfTestMultiProcess === true
        })
        await saveState({ selfTest: { ...result, version: PLUGIN_VERSION } })
        log(
          result.ok ? 'info' : 'warn',
          `安装自检${result.ok ? '通过' : '未通过'}：${result.mode} 模式，${result.entries}/${result.expected} 条，${result.ms}ms` +
            (result.detail ? `｜${result.detail}` : '')
        )
        return result
      })
      .catch((error) => {
        selfTestPromise = null
        log('warn', `安装自检失败：${error?.message ?? error}`)
        return null
      })
    return selfTestPromise
  }


  /* ---------------- 质疑度 / 最佳方法库：首次启动补齐分区 ---------------- */
  let methodbookPromise = null
  function ensureMethodbook() {
    if (!methodbookPromise) {
      methodbookPromise = ensureReady()
        .then(async () => {
          const body = store.view()?.sections?.methodbook ?? ''
          if (parseMethodbook(body)) return null
          const cfgLevel = Number.isFinite(raw.skepticism)
            ? Number(raw.skepticism)
            : Number.isFinite(raw.skepticismLevel) ? Number(raw.skepticismLevel) : undefined
          const state = defaultMethodbook({
            level: cfgLevel,
            auto: raw.autoDecay !== false,
            decayAfter: Number.isFinite(raw.decayAfter) ? Number(raw.decayAfter) : undefined
          })
          await store.setSection('methodbook', renderMethodbook(state))
          log('info', `已初始化最佳方法库（质疑度 ${state.skepticism.level}/${MAX_SKEPTICISM}）`)
          return state
        })
        .catch((error) => {
          methodbookPromise = null
          log('warn', `方法库初始化失败：${error?.message ?? error}`)
          return null
        })
    }
    return methodbookPromise
  }

  /* ---------------- 作用域解析（per-project） ---------------- */
  function cwdOfAgent(agent) {
    try {
      const session = agent?.session ?? (agent?.id ? ctx.agents?.get?.(agent.id)?.session : undefined)
      return String(session?.header?.cwd ?? '')
    } catch {
      return ''
    }
  }

  /** 工具执行上下文 → { scope, cwd } */
  function scopeOfExec(exec) {
    const cwd = cwdOfAgent(exec?.agent)
    return { cwd, scope: projectScope(cwd) || GLOBAL_SCOPE }
  }

  /* ---------------- 压缩后重读标记 ---------------- */
  const reloadPending = new Map()

  /**
   * 压缩上下文之前先把记忆同步写入两块盘：压缩会把会话历史换成摘要，
   * 记忆是压缩后唯一的长期载体，所以这里必须落盘一致。
   */
  async function flushBeforeCompaction(reason) {
    try {
      store.refreshSync(0)
      store.bootstrapSync()
      await store.writeBoth(store.raw)
      log('info', `压缩前已把记忆写入双备份（${reason}）`)
      return true
    } catch (error) {
      log('warn', `压缩前双备份失败（${reason}）：${error?.message ?? error}`)
      return false
    }
  }

  function markReload(sessionId, reason) {
    if (!sessionId) return
    reloadPending.set(sessionId, Date.now())
    log('info', `已标记上下文压缩后重读记忆（${reason}, session=${shortId(sessionId)}）`)
    try {
      store.refreshSync(0)
    } catch {
      /* 忽略 */
    }
    void flushBeforeCompaction(reason)
  }

  function pendingNotice(sessionId) {
    if (!sessionId) return ''
    const at = reloadPending.get(sessionId)
    if (!at) return ''
    if (Date.now() - at > RELOAD_NOTICE_TTL_MS) {
      reloadPending.delete(sessionId)
      return ''
    }
    return '你刚经历过上下文压缩，共享记忆已重新读取。'
  }

  /* ---------------- 技能库摘要（10 秒缓存，避免每轮都扫目录） ---------------- */
  let skillsCache = { at: 0, value: { count: 0, names: [], top: [] } }
  function skillsSummaryCached() {
    const now = Date.now()
    if (now - skillsCache.at < 10_000) return skillsCache.value
    try {
      skillsCache = { at: now, value: skillsSummary() }
    } catch (error) {
      log('warn', `技能目录读取失败：${error?.message ?? error}`)
      skillsCache = { at: now, value: { count: 0, names: [], top: [] } }
    }
    return skillsCache.value
  }

  /* ---------------- 1) 系统提示词 ---------------- */
  // 角色设定单独一段、排在记忆段之前：身份与语气属于指令层，不能混在记忆资料里
  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'shared-memory-persona',
      order: 24,
      text: () => {
        try {
          store.refreshSync()
        } catch {
          /* 读盘失败就用手里的缓存 */
        }
        return buildPersonaPrompt(store.view(), { injectChars })
      }
    })
  )

  ctx.effect(() =>
    ctx.systemPrompt.section({
      name: 'shared-memory',
      order: 25,
      text: (context) => {
        try {
          store.refreshSync()
        } catch {
          /* 读盘失败就用手里的缓存 */
        }
        const agent = context?.scope
        const sessionId = sessionIdOf(agent)
        const scope = projectScope(cwdOfAgent(agent)) || GLOBAL_SCOPE
        return buildMemoryPrompt(store.view(), {
          injectChars,
          scope,
          profile,
          index: store.index,
          skills: skillsSummaryCached(),
          reloadNotice: pendingNotice(sessionId),
          primaryPath: store.primaryPath,
          mirrorPath: store.mirrorPath,
          // 被注入 = 真的被用上了，计入命中频率（决定它留主文件还是进归档）
          onInjected: (entries) => {
            try {
              store.touchEntries(entries, 1)
            } catch {
              /* 索引写失败不影响提示词 */
            }
          }
        })
      }
    })
  )

  /* ---------------- 2) 工具 ---------------- */
  const hooks = {
    scopeOf: scopeOfExec,
    /** 当前质疑度：越高，检索时越容易去翻归档（阈值 = 档位） */
    getSkepticismLevel() {
      try {
        const state = parseMethodbook(store.view()?.sections?.methodbook ?? '') ?? defaultMethodbook()
        return state.skepticism.level
      } catch {
        return 0
      }
    },
    async relocate(primary, mirror) {
      const status = await store.relocate(primary, mirror)
      await saveState({ primaryPath: store.primaryPath, mirrorPath: store.mirrorPath })
      initPromise = Promise.resolve(store.view())
      log('info', `记忆位置已迁移：${store.primaryPath} / ${store.mirrorPath || '未配置'}`)
      return status
    },
    async reset() {
      const tombstone = await store.destroyBoth(tombstonePath)
      await store.init()
      log('warn', `双备份已被显式删除并重建空模板（${tombstone.deletedAt}）`)
      return tombstone
    },
    /** 注入档位（lean / standard / rich），持久化到 state.json */
    async setProfile(next) {
      const id = String(next ?? '').trim()
      if (!PROFILE_IDS.includes(id)) throw new Error(`未知档位：${id}（可选 ${PROFILE_IDS.join(' / ')}）`)
      profile = id
      await saveState({ profile: id })
      return id
    },
    getProfile() {
      return profile
    },
    /** 面板用：一次性拿到所有可调项 */
    getSettings() {
      return {
        profile,
        entryCap: store.entryCap,
        graceDays: store.graceDays,
        ttlBySection: { ...(store.ttlBySection ?? {}) },
        selfTest: loadStateSync().selfTest ?? null,
        version: PLUGIN_VERSION,
        skills: skillsSummaryCached()
      }
    },
    /** 流水分区 TTL（天），持久化到 state.json 并回填老条目 */
    async setTtl(map) {
      const next = {}
      for (const [section, value] of Object.entries(map ?? {})) {
        if (!ENTRY_SECTIONS.includes(section)) continue
        const days = Number(value)
        if (!Number.isFinite(days) || days < 0) continue
        next[section] = Math.round(days)
      }
      store.ttlBySection = { ...(store.ttlBySection ?? {}), ...next }
      await saveState({ ttlBySection: store.ttlBySection })
      try {
        store.backfillTtl()
      } catch {
        /* 回填失败不影响设置生效 */
      }
      return { ...store.ttlBySection }
    }
  }

  ctx.effect(() => {
    const disposers = []
    for (const tool of buildMemoryTools({ store, hooks })) {
      try {
        disposers.push(ctx.tools.register(tool))
      } catch (error) {
        log('warn', `工具注册失败 ${tool.name}：${error?.message ?? error}`)
      }
    }
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 忽略 */
        }
      }
    }
  })

  /* ---------------- 3) 记忆网页 ---------------- */
  ctx.effect(() =>
    registerMemoryPage(ctx, { store, log, hooks, extra: () => ({ client: clientEntryInfo(ctx) }) })
  )

  /* ---------------- 4) 会话开始：登记 + 压缩后重读 ---------------- */
  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    const source = String(payload?.source ?? 'startup')
    const sessionId = sessionIdOf(agent)
    const session = sessionOf(agent)
    const subagent = isSubagentSession(session)
    const cwd = String(session?.header?.cwd ?? '')

    if (source === 'compact') markReload(sessionId, 'agent/created source=compact')

    void ensureReady()
      .then(async () => {
        await store.reload(true)
        if (subagent && !recordSubagents) return
        if (source === 'compact') {
          await store.appendEntry('sessions', entryLine('上下文压缩后重读记忆', `session=${shortId(sessionId)}`))
          return
        }
        await store.appendEntry(
          'sessions',
          entryLine(source, `session=${shortId(sessionId)}｜cwd=${oneLine(cwd)}`)
        )
      })
      .catch((error) => log('warn', `会话登记失败：${error?.message ?? error}`))
  })

  /* ---------------- 5) 用户输入：摘要进「会话请求流水」 ---------------- */
  const turnMarks = new Map()

  ctx.on('session/event', (session, event) => {
    if (!event || typeof event.type !== 'string') return
    const sessionId = sessionIdOf(session)
    const type = event.type

    if (/^compact/i.test(type)) {
      markReload(sessionId, `session/event ${type}`)
      return
    }

    if (type === 'turn/start') {
      turnMarks.set(sessionId, { awaitingUser: true })
      return
    }

    if (type !== 'user/message') return
    if (!recordUserTurns) return

    const mark = turnMarks.get(sessionId)
    if (!mark || !mark.awaitingUser) return
    mark.awaitingUser = false

    const message = event.data
    if (isInjectedMessage(message)) return
    if (isCompactionCheckpoint(message)) return
    if (isSubagentSession(session) && !recordSubagents) return

    const text = messageText(message)
    if (oneLine(text).length < minUserChars) return

    const summary = clip(text, userSummaryChars)
    if (!summary) return

    const cwd = String(session?.header?.cwd ?? '')
    const scope = projectScope(cwd) || GLOBAL_SCOPE

    void ensureReady()
      .then(() => store.appendEntry('requests', entryLine(summary, `自动记录｜session=${shortId(sessionId)}`, scope)))
      .catch((error) => log('warn', `用户输入记录失败：${error?.message ?? error}`))
  })

  /* ---------------- 6) 压缩动作本身（LLM purpose=compaction） ---------------- */
  ctx.on('llm/stream', async function* (options, next) {
    try {
      if (String(options?.purpose ?? '') === 'compaction') {
        markReload(sessionIdOf({ session: { id: options?.sessionId } }), 'llm/stream purpose=compaction')
        await flushBeforeCompaction('llm/stream purpose=compaction')
      }
    } catch {
      /* 探测失败不影响主流程 */
    }
    yield* next()
  })

  /* ---------------- 7) 启动对账 + 定时巡检 ---------------- */
  void ensureReady().catch(() => {
    /* ensureReady 内部已记日志 */
  })
  void ensureMethodbook()
  void maybeInstallSelfTest()
  void ensureReady()
    .then(() => {
      const filled = store.backfillTtl()
      if (filled) log('info', `已给 ${filled} 条流水记忆补上默认过期时间`)
      const emphasized = store.backfillEmphasis()
      if (emphasized) log('info', `已给 ${emphasized} 条历史记忆补上强调权重`)
    })
    .catch(() => {
      /* ensureReady 内部已记日志 */
    })

  const runReconcile = async (reason) => {
    try {
      await ensureReady()
      const result = await store.reconcile()
      if (result.action && result.action !== 'in-sync') {
        log('info', `定时对账（${reason}）：${result.action}`)
        await store.reload(true)
      }
    } catch (error) {
      log('warn', `定时对账失败（${reason}）：${error?.message ?? error}`)
    }
  }

  ctx.effect(() => {
    if (typeof ctx.interval !== 'function') {
      log('info', 'timer 服务不可用，跳过定时对账')
      return () => {}
    }
    return ctx.interval(() => {
      void runReconcile('interval')
    }, reconcileIntervalMs)
  })

  log(
    'info',
    `已加载：主=${store.primaryPath} 镜像=${store.mirrorPath || '（未配置）'}；网页 ${MEMORY_PAGE_PREFIX}；巡检 ${Math.round(reconcileIntervalMs / 60000)} 分钟`
  )
}
