import { chmod, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')
const outfile = resolve(root, 'packages/core/dist/bin/cairn-acp.mjs')

await mkdir(dirname(outfile), { recursive: true })
await build({
  entryPoints: [resolve(root, 'packages/core/src/acp/stdio-entry.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  legalComments: 'none',
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __cairnCreateRequire } from 'node:module';\nconst require = __cairnCreateRequire(import.meta.url);",
  },
})
await chmod(outfile, 0o755)
