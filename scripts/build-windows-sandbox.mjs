import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') process.exit(0)

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const crateRoot = join(repoRoot, 'native', 'windows-sandbox')
const localCargo = join(repoRoot, '.tools', 'cargo', 'bin', 'cargo.exe')
const cargo =
  process.env.CARGO || (existsSync(localCargo) ? localCargo : 'cargo')
const env = { ...process.env }
if (existsSync(join(repoRoot, '.tools', 'rustup')))
  env.RUSTUP_HOME = join(repoRoot, '.tools', 'rustup')
if (existsSync(join(repoRoot, '.tools', 'cargo')))
  env.CARGO_HOME = join(repoRoot, '.tools', 'cargo')

const built = spawnSync(cargo, ['build', '--release', '--locked'], {
  cwd: crateRoot,
  env,
  encoding: 'utf8',
  stdio: 'inherit',
  windowsHide: true,
})
if (built.error) throw built.error
if (built.status !== 0)
  throw new Error(
    `Windows sandbox helper build failed with exit ${built.status}`,
  )

const source = join(crateRoot, 'target', 'release', 'cairn-windows-sandbox.exe')
const destination = join(
  repoRoot,
  'desktop',
  'build',
  'cairn-windows-sandbox.exe',
)
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(source, destination)
