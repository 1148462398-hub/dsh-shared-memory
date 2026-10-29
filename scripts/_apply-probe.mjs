/**
 * scripts/_apply-probe.mjs —— 用假 ctx 跑一遍 apply()，看哪个 effect 抛错、注册了什么。
 * 用临时目录，绝不碰真实记忆文件。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-apply-probe-'))
const primary = path.join(tmp, 'MEMORY.md')
const mirror = path.join(tmp, 'MIRROR.md')

const logged = []
const log = (level) => (...args) => logged.push(`${level}: ${args.join(' ')}`)

const registered = { tools: [], sections: [], pages: [], listeners: [] }

const server = {
  register(opts) {
    registered.pages.push(opts.path)
    return () => {}
  },
  getOrigin: () => 'http://127.0.0.1:1'
}

const ctx = {
  logger: () => ({ info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') }),
  get(name) {
    if (name === 'webServer') return server
    return undefined
  },
  effect(fn) {
    try {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    } catch (error) {
      logged.push('EFFECT ERROR: ' + (error?.message ?? error))
      throw error
    }
  },
  on(name) {
    registered.listeners.push(name)
  },
  interval(fn, ms) {
    return () => {}
  },
  systemPrompt: {
    section(options) {
      registered.sections.push(options.name)
      return () => {}
    }
  },
  tools: {
    register(tool) {
      registered.tools.push(tool.name)
      return () => {}
    }
  }
}

const mod = await import('../lib/index.js')
console.log('export name =', mod.name, ' inject =', JSON.stringify(mod.inject))

try {
  mod.apply(ctx, { primaryPath: primary, mirrorPath: mirror, entryCap: 50 })
  console.log('apply() 返回正常')
} catch (error) {
  console.log('apply() 抛错：' + (error?.message ?? error))
  console.log(error?.stack?.split('\n').slice(0, 6).join('\n'))
}

await new Promise((resolve) => setTimeout(resolve, 1500))

console.log('--- 注册结果 ---')
console.log('prompt sections:', JSON.stringify(registered.sections))
console.log('tools(' + registered.tools.length + '):', JSON.stringify(registered.tools))
console.log('pages:', JSON.stringify(registered.pages))
console.log('listeners:', JSON.stringify(registered.listeners))
console.log('--- 日志 ---')
for (const line of logged) console.log('  ' + line)

await fsp.rm(tmp, { recursive: true, force: true })
