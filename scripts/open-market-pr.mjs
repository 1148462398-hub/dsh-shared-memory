/**
 * scripts/open-market-pr.mjs
 *
 * 把 market/ 下的条目 YAML 提交到 awesome-dsh-plugin 仓库（fork → 建文件 → 开 PR）。
 *
 *   $env:GITHUB_TOKEN = 'ghp_xxx'
 *   node scripts/open-market-pr.mjs
 *
 * 只用经典 token 的 repo scope 就够。
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOKEN = process.env.GITHUB_TOKEN || ''
const UPSTREAM_OWNER = 'awesome-dsh-plugin'
const UPSTREAM_REPO = 'awesome-dsh-plugin'
const ME = process.env.GH_OWNER || '1148462398-hub'
const ENTRY_FILE = '1148462398-hub__dsh-shared-memory.yml'
const BRANCH = 'add-dsh-shared-memory'

if (!TOKEN) {
  console.error('缺少 GITHUB_TOKEN')
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const localEntry = path.resolve(here, '..', 'market', ENTRY_FILE)

async function api(method, route, body) {
  const res = await fetch('https://api.github.com' + route, {
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
    const error = new Error(`${method} ${route} -> ${res.status} ${json?.message || text.slice(0, 160)}`)
    error.status = res.status
    throw error
  }
  return json
}

async function ensureFork() {
  try {
    const fork = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}`)
    console.log(`已存在 fork：${fork.full_name}`)
    return fork
  } catch (error) {
    if (error.status !== 404) throw error
    console.log(`创建 fork：${UPSTREAM_OWNER}/${UPSTREAM_REPO} → ${ME}/${UPSTREAM_REPO}`)
    await api('POST', `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/forks`, { default_branch_only: true })
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000))
      try {
        const fork = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}`)
        console.log(`fork 就绪：${fork.full_name}（默认分支 ${fork.default_branch}）`)
        return fork
      } catch {
        /* 继续等 */
      }
    }
    throw new Error('fork 创建超时')
  }
}

async function main() {
  const yamlText = await fsp.readFile(localEntry, 'utf8')
  console.log(`条目文件：${localEntry}（${yamlText.length} 字符）`)

  const fork = await ensureFork()
  const branch = fork.default_branch

  // 分支上是否已有这个文件（重复执行时更新它）
  let existingSha
  try {
    const exists = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}/contents/data/plugins/${ENTRY_FILE}?ref=${branch}`)
    existingSha = exists.sha
    console.log(`分支上已有该文件，将覆盖（sha ${existingSha.slice(0, 8)}）`)
  } catch (error) {
    if (error.status !== 404) throw error
  }

  let branchName = branch
  if (branch !== BRANCH) {
    // 在 fork 里建一个工作分支
    const ref = await api('GET', `/repos/${ME}/${UPSTREAM_REPO}/git/ref/heads/${branch}`)
    try {
      await api('POST', `/repos/${ME}/${UPSTREAM_REPO}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: ref.object.sha })
      console.log(`已创建分支 ${BRANCH}`)
    } catch (error) {
      if (error.status !== 422) throw error
      console.log(`分支 ${BRANCH} 已存在`)
    }
    branchName = BRANCH
  }

  const put = await api('PUT', `/repos/${ME}/${UPSTREAM_REPO}/contents/data/plugins/${ENTRY_FILE}`, {
    message: `Add ${ENTRY_FILE}`,
    content: Buffer.from(yamlText, 'utf8').toString('base64'),
    branch: branchName,
    ...(existingSha ? { sha: existingSha } : {})
  })
  console.log(`已提交条目：${put.commit.sha.slice(0, 8)} → 分支 ${branchName}`)

  const pr = await api('POST', `/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls`, {
    title: 'Add dsh-shared-memory (memory)',
    head: `${ME}:${branchName}`,
    base: 'main',
    body: [
      'Adds **dsh-shared-memory** to the memory category.',
      '',
      '- repo: https://github.com/1148462398-hub/dsh-shared-memory',
      '- `package.json` declares `dsh.bundle.patch` → `./dsh/cordis.patch.yml`',
      '- installs with `dsh plugin --profile web add dsh-shared-memory`',
      '- no network calls, no credentials; memory lives in plain Markdown on two disks with history snapshots',
      '',
      'Note: the repository was created today, so the age gate may need to refresh on its own.'
    ].join('\n')
  })
  console.log('')
  console.log(`PR #${pr.number}：${pr.html_url}`)
}

main().catch((error) => {
  console.error('开 PR 失败：' + error.message)
  process.exit(1)
})
