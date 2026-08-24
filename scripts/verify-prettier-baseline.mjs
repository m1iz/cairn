import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const repoRoot = resolve(import.meta.dirname, '..')
const prettierEntry = require.resolve('prettier')
const prettierBin = resolve(dirname(prettierEntry), 'bin/prettier.cjs')
const baseline = JSON.parse(
  readFileSync(resolve(import.meta.dirname, 'prettier-baseline.json'), 'utf8'),
)
const allowed = new Set(baseline.allowedDifferent ?? [])
const tracked = gitTrackedFiles()
const different = new Set()

for (let index = 0; index < tracked.length; index += 200) {
  const result = spawnSync(
    process.execPath,
    [
      prettierBin,
      '--list-different',
      '--ignore-unknown',
      ...tracked.slice(index, index + 200),
    ],
    { cwd: repoRoot, encoding: 'utf8', windowsHide: true },
  )
  if (result.status !== 0 && result.status !== 1) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  for (const file of result.stdout.split(/\r?\n/).filter(Boolean))
    different.add(file.replaceAll('\\', '/'))
}

const unexpected = [...different].filter((file) => !allowed.has(file)).sort()
if (unexpected.length) {
  process.stderr.write('New files fail the Prettier baseline:\n')
  for (const file of unexpected) process.stderr.write(`- ${file}\n`)
  process.exit(1)
}

process.stdout.write(
  `Prettier ratchet passed; ${different.size} known files remain to converge.\n`,
)

function gitTrackedFiles() {
  const result = spawnSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout.split('\0').filter(Boolean)
}
