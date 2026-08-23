import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { WatchlistDecision } from './models'

export const DEFAULT_WATCHLIST = `# Watchlist

记录希望 Cairn 主动定期检查的事项。每行写一个明确目标，暂不需要的项可用 HTML 注释包住。

- 示例：每天下午检查是否有需要整理的项目跟进事项。
`

export class WatchlistStore {
  readonly root: string
  readonly path: string
  readonly statePath: string

  constructor(root: string) {
    this.root = root
    this.path = join(root, 'memory', 'watchlist.md')
    this.statePath = join(root, 'memory', 'watchlist_state.json')
    this.ensure()
  }

  read(): string {
    this.ensure()
    return readFileSync(this.path, 'utf8')
  }

  write(content: string): string {
    atomicWriteText(this.path, String(content || '').trimEnd() + '\n')
    return this.read()
  }

  readState(): Record<string, unknown> {
    if (!existsSync(this.statePath)) return {}
    try {
      const raw = JSON.parse(readFileSync(this.statePath, 'utf8') || '{}')
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {}
    } catch {
      // 审计 P1-5：先隔离损坏文件再回退默认，不能静默丢弃。
      const backup = `${this.statePath}.corrupt-${Math.trunc(Date.now() / 1000)}-${randomUUID().replace(/-/g, '').slice(0, 8)}`
      try {
        renameSync(this.statePath, backup)
      } catch {
        /* ignore */
      }
      return {}
    }
  }

  writeDecision(decision: WatchlistDecision): void {
    atomicWriteText(
      this.statePath,
      JSON.stringify({ lastDecision: decision.toDict() }, null, 2) + '\n',
    )
  }

  payload(): Record<string, unknown> {
    const state = this.readState()
    return {
      content: this.read(),
      lastDecision:
        state.lastDecision &&
        typeof state.lastDecision === 'object' &&
        !Array.isArray(state.lastDecision)
          ? state.lastDecision
          : null,
    }
  }

  activeItems(): string[] {
    const items: string[] = []
    for (const line of this.read().split(/\r?\n/)) {
      let stripped = line.trim()
      if (!stripped || stripped.startsWith('#') || stripped.startsWith('<!--'))
        continue
      if (stripped.startsWith('- [ ]')) stripped = stripped.slice(5).trim()
      else if (stripped.startsWith('-')) stripped = stripped.slice(1).trim()
      else continue
      if (stripped && !stripped.startsWith('示例：')) items.push(stripped)
    }
    return items
  }

  private ensure(): void {
    mkdirSync(join(this.root, 'memory'), { recursive: true })
    if (!existsSync(this.path)) atomicWriteText(this.path, DEFAULT_WATCHLIST)
  }
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID().replace(/-/g, '')}.tmp`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw error
  }
}
