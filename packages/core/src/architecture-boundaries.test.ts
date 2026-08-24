import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = path.dirname(fileURLToPath(import.meta.url))

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

describe('source architecture boundaries', () => {
  it('keeps the production source tree free of versioned implementation roots', async () => {
    const files = await sourceFiles(SOURCE_ROOT)
    const versioned = files
      .map((file) => path.relative(SOURCE_ROOT, file))
      .filter((file) => /(^|[\\/])v\d+([\\/]|$)/i.test(file))

    expect(versioned).toEqual([])
  })

  it('keeps production imports free of versioned implementation paths', async () => {
    const violations: string[] = []
    for (const file of await sourceFiles(SOURCE_ROOT)) {
      const source = await readFile(file, 'utf8')
      if (/from\s+['"][^'"]*[\\/]v\d+[\\/]/i.test(source))
        violations.push(path.relative(SOURCE_ROOT, file))
    }

    expect(violations).toEqual([])
  })
})
