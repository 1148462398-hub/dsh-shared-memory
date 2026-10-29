/**
 * dsh-shared-memory / selftest.js
 *
 * 安装自检：插件第一次启用（或版本变化后第一次启用）时，在**临时目录**里
 * 模拟两个会话同时写记忆，验证"并发写入一条都不丢 + 主镜像一致"。
 *
 * 优先用真·多进程（子进程各自 new 一个 MemoryStore）；宿主不允许 fork 时
 * 退化为同一进程内的并发写。两种都不碰真实记忆文件。
 */

import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

import { MemoryStore } from './store.js'

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'selftest-worker.js')

function spawnWorker(primary, mirror, tag, count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, primary, mirror, tag, String(count)], {
      stdio: 'ignore',
      // 宿主可能是 Electron：让它以 node 身份跑子进程
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    })
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
      reject(new Error('自检子进程超时'))
    }, 15000)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`自检子进程退出码 ${code}`))
    })
  })
}

async function attempt(mode, options) {
  const sessions = options.sessions
  const perSession = options.perSession
  const expected = sessions * perSession
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-mem-selftest-'))
  const primary = path.join(root, 'MEMORY.md')
  const mirror = path.join(root, 'MIRROR.md')
  try {
    const seed = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
    await seed.init()

    if (mode === 'multi-process') {
      await Promise.all(
        Array.from({ length: sessions }, (_, i) => spawnWorker(primary, mirror, `W${i}`, perSession))
      )
    } else {
      const store = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
      await store.reload(true)
      const jobs = []
      for (let i = 0; i < sessions; i += 1) {
        for (let j = 0; j < perSession; j += 1) {
          jobs.push(store.appendEntry('lessons', `- [2026-10-09 10:00] 自检W${i} 第 ${j} 条`))
        }
      }
      await Promise.all(jobs)
    }

    const verify = new MemoryStore({ primaryPath: primary, mirrorPath: mirror, entryCap: 500, graceDays: 3 })
    await verify.reload(true)
    const entries = verify.entriesOf('lessons').length
    const rawPrimary = await fsp.readFile(primary, 'utf8')
    const rawMirror = await fsp.readFile(mirror, 'utf8')
    return {
      ok: entries === expected && rawPrimary === rawMirror,
      mode,
      entries,
      expected,
      mirrorInSync: rawPrimary === rawMirror
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 跑一次安装自检。
 * @returns {Promise<{ok:boolean, mode:string, entries:number, expected:number, ms:number, at:string, detail:string}>}
 */
export async function runInstallSelfTest(options = {}) {
  const sessions = Number(options.sessions) || 2
  const perSession = Number(options.perSession) || 3
  const started = Date.now()
  let last = null
  const modes = options.multiProcess === true ? ['multi-process', 'in-process'] : ['in-process']

  for (const mode of modes) {
    try {
      const result = await attempt(mode, { sessions, perSession })
      last = result
      if (result.ok) {
        return { ...result, ms: Date.now() - started, at: new Date().toISOString(), detail: '' }
      }
    } catch (error) {
      last = { ok: false, mode, entries: 0, expected: sessions * perSession, mirrorInSync: false, detail: String(error?.message ?? error) }
    }
  }

  return {
    ok: false,
    mode: last?.mode ?? 'none',
    entries: last?.entries ?? 0,
    expected: sessions * perSession,
    mirrorInSync: Boolean(last?.mirrorInSync),
    ms: Date.now() - started,
    at: new Date().toISOString(),
    detail: last?.detail || `条数 ${last?.entries ?? 0}/${sessions * perSession}`
  }
}
