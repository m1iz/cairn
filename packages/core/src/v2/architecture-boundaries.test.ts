import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const V2_ROOT = path.dirname(fileURLToPath(import.meta.url))
const CONTRACTS_ROOT = path.join(V2_ROOT, 'contracts')
const APPLICATION_ROOT = path.join(V2_ROOT, 'application')

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(root, entry.name)
      if (entry.isDirectory()) return sourceFiles(target)
      return entry.isFile() &&
        target.endsWith('.ts') &&
        !target.endsWith('.test.ts')
        ? [target]
        : []
    }),
  )
  return nested.flat()
}

describe('v2 architecture boundaries', () => {
  it('keeps contracts independent from infrastructure and legacy engines', async () => {
    const forbidden = [
      /from\s+['"]node:/,
      /from\s+['"]electron['"]/,
      /from\s+['"]\.\.\/\.\.\/(?:agent|api|providers|store)\//,
    ]
    const violations: string[] = []

    for (const file of await sourceFiles(CONTRACTS_ROOT)) {
      const source = await readFile(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(source)) {
          violations.push(`${path.relative(V2_ROOT, file)} matches ${pattern}`)
        }
      }
    }

    expect(violations).toEqual([])
  })

  it('keeps application code independent from concrete infrastructure', async () => {
    const violations: string[] = []
    const forbidden = [
      /from\s+['"]node:/,
      /from\s+['"]electron['"]/,
      /from\s+['"]\.\.\/\.\.\/(?:agent|api|providers|store)\//,
    ]

    for (const file of await sourceFiles(APPLICATION_ROOT)) {
      const source = await readFile(file, 'utf8')
      for (const pattern of forbidden) {
        if (pattern.test(source))
          violations.push(`${path.relative(V2_ROOT, file)} matches ${pattern}`)
      }
    }

    expect(violations).toEqual([])
  })
})
