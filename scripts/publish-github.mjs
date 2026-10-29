/**
 * scripts/publish-github.mjs
 *
 * 没有 git 的环境里把插件目录发布到 GitHub：全程走 Git Data API。
 *
 *   $env:GITHUB_TOKEN = 'github_pat_xxx'
 *   node scripts/publish-github.mjs
 *
 * 可选环境变量：GH_OWNER（默认 1148462398-hub）、GH_REPO（默认 dsh-shared-memory）、
 *              GH_PRIVATE=1（默认公开）
 *
 * 做的事：没有仓库就建 → 逐个文件建 blob → 建 tree → 建 commit → 更新 main 分支 → 打 topic。
 * 只推白名单目录，永远不会推 MEMORY.md / .history / node_modules。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

const OWNER = process.env.GH_OWNER || '1148462398-hub'
const REPO = process.env.GH_REPO || 'dsh-shared-memory'
const TOKEN = process.env.GITHUB_TOKEN || ''
const BRANCH = process.env.GH_BRANCH || 'main'
const PRIVATE = process.env.GH_PRIVATE === '1'
const ROOT = path.resolve(process.argv[2] || '.')
/** 推到仓库里的子目录（monorepo 用，例如 packages/dsh-shared-memory） */
const PREFIX = String(process.env.GH_PREFIX || '').replace(/^\/+|\/+$/g, '')

const API = 'https://api.github.com'
const KEEP = ['package.json', 'README.md', 'AGENTS.md', 'LICENSE', '.gitignore', 'lib', 'dsh', 'scripts', 'test', 'market']
const SKIP_DIRS = new Set(['node_modules', '.git', '.history', 'dist'])

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN 环境变量（GitHub 不允许用密码调用 API，必须用 Personal Access Token）')
  process.exit(2)
}

async function api(method, route, body) {
  const res = await fetch(API + route, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-shared-memory-publisher',
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const detail = json?.message || text.slice(0, 200)
    const error = new Error(`${method} ${route} -> ${res.status} ${detail}`)
    error.status = res.status
    throw error
  }
  return json
}

async function ensureRepo() {
  try {
    const repo = await api('GET', `/repos/${OWNER}/${REPO}`)
    console.log(`仓库已存在：${repo.full_name}（${repo.private ? '私有' : '公开'}）`)
    return repo
  } catch (error) {
    if (error.status !== 404) throw error
    console.log(`仓库不存在，创建 ${OWNER}/${REPO} …`)
    try {
      const created = await api('POST', '/user/repos', {
        name: REPO,
        private: PRIVATE,
        description: 'Shared Markdown memory for all DSH sessions: two-disk mirror, hit-frequency tiering, co-occurrence + BM25 retrieval, skepticism-driven method library.',
        has_issues: true,
        has_wiki: false,
        auto_init: false
      })
      console.log(`已创建：${created.html_url}`)
      return created
    } catch (createError) {
      // 细粒度 token 不允许建仓库（403）：此时改为推进一个已存在的仓库/子目录
      throw new Error(
        `建仓库失败（${createError.message}）。细粒度 token 没有"创建仓库"权限，` +
          `请在网页上先建空仓库，或用 GH_REPO=<已有仓库> + GH_PREFIX=<子目录> 推成 monorepo。`
      )
    }
  }
}

async function collectFiles(dir, prefix = '') {
  const out = []
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      out.push(...(await collectFiles(path.join(dir, entry.name), rel)))
    } else if (entry.isFile()) {
      if (/\.(log|lock)$/.test(entry.name)) continue
      if (/^(MEMORY\.|\.conflict-)/.test(entry.name)) continue
      out.push(rel)
    }
  }
  return out
}

function keep(rel) {
  return KEEP.some((entry) => rel === entry || rel.startsWith(entry + '/'))
}

function withPrefix(rel) {
  return PREFIX ? `${PREFIX}/${rel}` : rel
}

async function main() {
  console.log(`发布目录：${ROOT}${PREFIX ? ` → 仓库子目录 ${PREFIX}/` : ''}`)
  await ensureRepo()

  /*
   * 空仓库（刚建、零提交）调 git/blobs 会返回 409 "Git Repository is empty"。
   * 先用 Contents API 建第一个提交，把仓库变成"非空"，后面的 Git Data API 才可用。
   */
  try {
    await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
  } catch (error) {
    if (error.status === 404 || error.status === 409) {
      console.log('仓库是空的，先建一个初始提交…')
      await api('PUT', `/repos/${OWNER}/${REPO}/contents/README.md`, {
        message: 'chore: init',
        content: Buffer.from('# dsh-shared-memory\n').toString('base64')
      })
      console.log('初始提交完成')
    } else {
      throw error
    }
  }

  const all = (await collectFiles(ROOT)).filter(keep).sort()
  if (!all.length) throw new Error('没有可发布的文件（检查 KEEP 白名单）')
  console.log(`待发布文件 ${all.length} 个`)

  const blobs = []
  for (const rel of all) {
    const buffer = await fsp.readFile(path.join(ROOT, rel))
    const blob = await api('POST', `/repos/${OWNER}/${REPO}/git/blobs`, {
      content: buffer.toString('base64'),
      encoding: 'base64'
    })
    blobs.push({ path: withPrefix(rel), mode: '100644', type: 'blob', sha: blob.sha })
    process.stdout.write(`  + ${withPrefix(rel)}\n`)
  }

  let baseTree
  let parents = []
  try {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)
    parents = [ref.object.sha]
    const commit = await api('GET', `/repos/${OWNER}/${REPO}/git/commits/${ref.object.sha}`)
    baseTree = commit.tree.sha
    console.log(`在已有 ${BRANCH} 之上提交（父提交 ${ref.object.sha.slice(0, 8)}）`)
  } catch (error) {
    if (error.status !== 409 && error.status !== 404) throw error
    console.log(`${BRANCH} 还不存在，本次是第一个提交`)
  }

  const tree = await api('POST', `/repos/${OWNER}/${REPO}/git/trees`, {
    tree: blobs,
    ...(baseTree ? { base_tree: baseTree } : {})
  })

  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  const commit = await api('POST', `/repos/${OWNER}/${REPO}/git/commits`, {
    message: `release: ${pkg.name} v${pkg.version}`,
    tree: tree.sha,
    parents
  })

  if (parents.length) {
    await api('PATCH', `/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: true })
  } else {
    await api('POST', `/repos/${OWNER}/${REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha })
  }

  try {
    await api('PUT', `/repos/${OWNER}/${REPO}/topics`, { names: ['dsh-plugin', 'deepseek-harness', 'memory'] })
    console.log('已设置 topic：dsh-plugin / deepseek-harness / memory')
  } catch (error) {
    console.log(`设置 topic 失败（可手动加）：${error.message}`)
  }

  console.log('')
  console.log(`完成：https://github.com/${OWNER}/${REPO}/commit/${commit.sha}`)
  console.log(`仓库地址：https://github.com/${OWNER}/${REPO}`)
}

main().catch((error) => {
  console.error('发布失败：' + error.message)
  process.exit(1)
})
