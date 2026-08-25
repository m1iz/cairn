import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  chmodSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type {
  LoadedToolCatalog,
  ToolCatalogEntry,
  ToolCatalogStrategy,
} from './catalog'
import { NodeHttpsAssetDownloader, type AssetDownloader } from './download'
import { EnvironmentError } from './errors'
import type {
  EnvironmentStepExecutionContext,
  EnvironmentStepExecutionResult,
  EnvironmentStepExecutor,
} from './jobs'
import type { EnvironmentArch } from './models'
import { buildEffectivePath } from './path'
import {
  NodeEnvironmentProcessRunner,
  type EnvironmentProcessRequest,
  type EnvironmentProcessResult,
  type EnvironmentProcessRunner,
} from './process-runner'
import { extractBoundedTarGz } from './tar'

const INSTALL_TIMEOUT_MS = 30 * 60 * 1_000
const MAX_INSTALL_OUTPUT_BYTES = 1024 * 1024
const MAX_OS_RELEASE_BYTES = 64 * 1024
const SUPPORTED_UBUNTU = new Set(['22.04', '24.04'])
const RUSTUP_INIT_ARGS = [
  '-y',
  '--no-modify-path',
  '--profile',
  'minimal',
  '--default-toolchain',
  '1.97.0',
] as const

export interface SupportedUbuntu {
  id: 'ubuntu'
  versionId: '22.04' | '24.04'
}

export interface LinuxEnvironmentAdapterOptions {
  catalog: LoadedToolCatalog
  arch: EnvironmentArch
  runner?: EnvironmentProcessRunner
  env?: Record<string, string | undefined>
  homeDir?: string
  executableExists?: (path: string) => boolean
  downloader?: AssetDownloader | null
  downloadsDir?: string | null
  installRoot?: string | null
  osReleasePath?: string
}

export class LinuxEnvironmentAdapter implements EnvironmentStepExecutor {
  private readonly catalog: LoadedToolCatalog
  private readonly arch: EnvironmentArch
  private readonly runner: EnvironmentProcessRunner
  private readonly env: Record<string, string | undefined>
  private readonly homeDir: string
  private readonly executableExists: (path: string) => boolean
  private readonly downloader: AssetDownloader
  private readonly downloadsDir: string
  private readonly installRoot: string
  private readonly osReleasePath: string

  constructor(opts: LinuxEnvironmentAdapterOptions) {
    this.catalog = opts.catalog
    this.arch = opts.arch
    this.runner = opts.runner ?? new NodeEnvironmentProcessRunner()
    this.env = { ...(opts.env ?? process.env) }
    this.homeDir = opts.homeDir ?? this.env.HOME ?? ''
    this.executableExists = opts.executableExists ?? isExecutable
    this.downloader = opts.downloader ?? new NodeHttpsAssetDownloader()
    this.downloadsDir =
      opts.downloadsDir ??
      posix.join(this.homeDir, '.cache', 'cairn', 'environment', 'downloads')
    this.installRoot =
      opts.installRoot ??
      posix.join(
        this.homeDir,
        '.local',
        'share',
        'cairn',
        'environment',
        'tools',
      )
    this.osReleasePath = opts.osReleasePath ?? '/etc/os-release'
  }

  async execute(
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (this.arch !== 'x64')
      return failed(new EnvironmentError('unsupported_arch'))
    try {
      this.platform()
    } catch (error) {
      return failed(
        error instanceof EnvironmentError
          ? error
          : new EnvironmentError('unsupported_platform', { cause: error }),
      )
    }
    const resolved = this.resolveStep(context)
    if (!resolved)
      return failed(new EnvironmentError('unsupported_requirement'))
    const { tool, strategy } = resolved
    if (strategy.kind === 'package_manager')
      return await this.runApt(tool, strategy, context)
    if (strategy.kind === 'direct_archive')
      return await this.installArchive(tool, strategy, context)
    if (strategy.kind === 'direct_binary')
      return await this.runVerifiedBinary(strategy, context)
    if (strategy.kind === 'version_manager' || strategy.kind === 'bundled')
      return await this.runCatalogCommand(strategy, context)
    if (strategy.kind === 'system_prompt') {
      await context.log({
        level: 'info',
        kind: 'official_install_required',
        message: `${tool.id} requires installation from its official source.`,
        details: {
          source: strategy.source.url,
          publisher: strategy.source.publisher,
        },
      })
      return { status: 'awaiting_user' }
    }
    return failed(new EnvironmentError('unsupported_requirement'))
  }

  private platform(): SupportedUbuntu {
    const configuredStat = lstatSync(this.osReleasePath)
    let sourcePath = this.osReleasePath
    if (configuredStat.isSymbolicLink()) {
      if (this.osReleasePath !== '/etc/os-release')
        throw new EnvironmentError('unsupported_platform')
      sourcePath = realpathSync(this.osReleasePath)
      if (sourcePath !== '/usr/lib/os-release')
        throw new EnvironmentError('unsupported_platform')
    }
    const stat = lstatSync(sourcePath)
    if (
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size > MAX_OS_RELEASE_BYTES
    )
      throw new EnvironmentError('unsupported_platform')
    return detectSupportedUbuntu(readFileSync(sourcePath, 'utf8'))
  }

  private resolveStep(
    context: EnvironmentStepExecutionContext,
  ): { tool: ToolCatalogEntry; strategy: ToolCatalogStrategy } | null {
    const tool = this.catalog.catalog.tools.find(
      (candidate) => candidate.id === context.step.toolId,
    )
    const strategy = tool?.strategies.find(
      (candidate) =>
        candidate.id === context.step.strategyId &&
        candidate.targets.some(
          (target) => target.platform === 'linux' && target.arch === this.arch,
        ),
    )
    return tool && strategy ? { tool, strategy } : null
  }

  private async runApt(
    tool: ToolCatalogEntry,
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (tool.id !== 'git' && tool.id !== 'ripgrep')
      return failed(new EnvironmentError('unsupported_requirement'))
    const expectedPackage = tool.id
    if (
      strategy.id !== 'apt' ||
      strategy.executable !== 'pkexec' ||
      !strategy.requiresElevation ||
      strategy.args.join('\u0000') !==
        ['apt-get', 'install', '-y', expectedPackage].join('\u0000')
    )
      return failed(new EnvironmentError('unsupported_requirement'))
    if (!context.step.requiresElevation)
      return failed(new EnvironmentError('confirmation_required'))
    const executable = '/usr/bin/pkexec'
    if (!this.executableExists(executable)) {
      await context.log({
        level: 'warn',
        kind: 'pkexec_required',
        message:
          'PolicyKit pkexec is unavailable; install the package manually with the system package manager.',
        details: { package: expectedPackage },
      })
      return { status: 'awaiting_user' }
    }
    return await this.runProcess(
      {
        executable,
        args: [...strategy.args],
        env: this.processEnvironment(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
        signal: context.signal,
      },
      context,
      true,
    )
  }

  private async runCatalogCommand(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const executable = this.resolveExecutable(strategy.executable)
    if (!executable)
      return failed(new EnvironmentError('post_install_probe_failed'))
    return await this.runProcess(
      {
        executable,
        args: [...strategy.args],
        env: this.processEnvironment(),
        timeoutMs: INSTALL_TIMEOUT_MS,
        maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
        signal: context.signal,
      },
      context,
      false,
    )
  }

  private async runVerifiedBinary(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (
      strategy.id !== 'official-binary' ||
      strategy.executable !== 'rustup-init' ||
      strategy.args.join('\u0000') !== RUSTUP_INIT_ARGS.join('\u0000')
    )
      return failed(new EnvironmentError('unsupported_requirement'))
    const downloaded = await this.downloadVerified(
      strategy,
      context,
      '-rustup-init',
    )
    if (typeof downloaded !== 'string') return downloaded
    try {
      chmodSync(downloaded, 0o700)
      return await this.runProcess(
        {
          executable: downloaded,
          args: [...strategy.args],
          env: this.processEnvironment(),
          timeoutMs: INSTALL_TIMEOUT_MS,
          maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
          signal: context.signal,
        },
        context,
        false,
      )
    } finally {
      await rm(downloaded, { force: true })
    }
  }

  private async installArchive(
    tool: ToolCatalogEntry,
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (!new URL(strategy.source.url).pathname.endsWith('.tar.gz'))
      return failed(new EnvironmentError('unsupported_requirement'))
    if (tool.id !== 'go' && tool.id !== 'uv' && tool.id !== 'volta')
      return failed(new EnvironmentError('unsupported_requirement'))
    if (tool.id === 'go') {
      const currentGo = this.resolveExecutable('go')
      if (currentGo) {
        await context.log({
          level: 'warn',
          kind: 'go_conflict',
          message:
            'An existing Go installation was detected and will not be replaced automatically.',
          details: {},
        })
        return { status: 'awaiting_user' }
      }
    }
    const downloaded = await this.downloadVerified(strategy, context, '.tar.gz')
    if (typeof downloaded !== 'string') return downloaded
    const toolRoot = join(this.installRoot, context.step.toolId)
    const destination = join(toolRoot, 'current')
    const candidate = join(
      toolRoot,
      `.candidate-${process.pid}-${randomBytes(5).toString('hex')}`,
    )
    const backup = join(
      toolRoot,
      `.previous-${process.pid}-${randomBytes(5).toString('hex')}`,
    )
    let replacedExisting = false
    let activatedCandidate = false
    const createdLinks: string[] = []
    try {
      ensureManagedDirectory(this.installRoot, 'Linux tool install root', true)
      ensureManagedDirectory(toolRoot, 'Linux tool directory', false)
      ensureReplaceableDirectory(destination)
      await extractBoundedTarGz({
        archive: downloaded,
        destination: candidate,
        maxArchiveBytes: boundedDownloadBytes(strategy.estimatedBytes),
        maxFiles: 50_000,
        maxFileBytes: 512 * 1024 * 1024,
        maxTotalBytes: 1024 * 1024 * 1024,
      })
      const executableNames = activationNames(tool)
      const candidateExecutables = findInstalledExecutables(
        candidate,
        executableNames,
      )
      if (!candidateExecutables)
        throw new EnvironmentError('post_install_probe_failed')
      const finalExecutables = new Map(
        [...candidateExecutables].map(([name, path]) => [
          name,
          `${destination}${path.slice(candidate.length)}`,
        ]),
      )
      const binDir =
        tool.id === 'volta'
          ? posix.join(this.homeDir, '.volta', 'bin')
          : posix.join(this.homeDir, '.local', 'bin')
      ensureManagedDirectory(binDir, 'Linux user bin directory', true)
      ensureContainedDirectory(this.homeDir, binDir)
      preflightActivationLinks(binDir, finalExecutables)
      if (existsSync(destination)) {
        renameSync(destination, backup)
        replacedExisting = true
      }
      renameSync(candidate, destination)
      activatedCandidate = true
      for (const [name, target] of finalExecutables) {
        const link = join(binDir, name)
        if (pathEntryExists(link)) continue
        symlinkSync(target, link)
        createdLinks.push(link)
      }
      if (replacedExisting) rmSync(backup, { recursive: true, force: true })
      return { status: 'completed' }
    } catch (cause) {
      for (const link of createdLinks.reverse()) rmSync(link, { force: true })
      rmSync(candidate, { recursive: true, force: true })
      if (activatedCandidate && existsSync(destination))
        rmSync(destination, { recursive: true })
      if (replacedExisting && existsSync(backup))
        renameSync(backup, destination)
      if (cause instanceof EnvironmentError) {
        if (cause.environmentCode === 'cancelled')
          return { status: 'cancelled' }
        return failed(cause)
      }
      return failed(new EnvironmentError('integrity_failed', { cause }))
    } finally {
      await rm(downloaded, { force: true })
    }
  }

  private async downloadVerified(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
    extension: string,
  ): Promise<string | EnvironmentStepExecutionResult> {
    if (!strategy.source.sha256)
      return failed(new EnvironmentError('integrity_failed'))
    try {
      ensureManagedDirectory(
        this.downloadsDir,
        'Linux download directory',
        true,
      )
    } catch (cause) {
      return failed(new EnvironmentError('integrity_failed', { cause }))
    }
    const destination = join(
      this.downloadsDir,
      `${context.step.stepId}-${strategy.source.sha256.slice(0, 16)}${extension}`,
    )
    await rm(destination, { force: true })
    try {
      await this.downloader.download({
        url: strategy.source.url,
        destination,
        maxBytes: boundedDownloadBytes(strategy.estimatedBytes),
        signal: context.signal,
      })
    } catch (cause) {
      if (context.signal.aborted) return { status: 'cancelled' }
      if (
        cause instanceof EnvironmentError &&
        cause.environmentCode === 'cancelled'
      )
        return { status: 'cancelled' }
      return failed(
        cause instanceof EnvironmentError
          ? cause
          : new EnvironmentError('download_failed', { cause }),
      )
    }
    if (!safeRegularFile(destination)) {
      await rm(destination, { force: true })
      return failed(new EnvironmentError('integrity_failed'))
    }
    if ((await sha256File(destination)) !== strategy.source.sha256) {
      await rm(destination, { force: true })
      return failed(new EnvironmentError('integrity_failed'))
    }
    return destination
  }

  private async runProcess(
    request: EnvironmentProcessRequest,
    context: EnvironmentStepExecutionContext,
    elevated: boolean,
  ): Promise<EnvironmentStepExecutionResult> {
    const result = await this.runner.run(request)
    await logProcessResult(context, result)
    if (result.status === 'cancelled') return { status: 'cancelled' }
    if (elevated && (result.exitCode === 126 || result.exitCode === 127))
      return failed(new EnvironmentError('elevation_declined'))
    if (result.status !== 'completed' || result.exitCode !== 0)
      return failed(new EnvironmentError('installer_failed'))
    return { status: 'completed' }
  }

  private resolveExecutable(executable: string): string | null {
    if (posix.isAbsolute(executable))
      return this.executableExists(executable) ? executable : null
    for (const directory of this.effectivePath().entries) {
      const candidate = posix.join(directory, executable)
      if (this.executableExists(candidate)) return candidate
    }
    return null
  }

  private effectivePath(): { entries: string[]; value: string } {
    return buildEffectivePath({
      platform: 'linux',
      envPath: this.env.PATH,
      homeDir: this.homeDir,
      windowsEnv: this.env,
    })
  }

  private processEnvironment(): Record<string, string> {
    const output: Record<string, string> = {
      HOME: this.homeDir,
      PATH: this.effectivePath().value,
      CARGO_HOME: this.env.CARGO_HOME ?? posix.join(this.homeDir, '.cargo'),
      RUSTUP_HOME: this.env.RUSTUP_HOME ?? posix.join(this.homeDir, '.rustup'),
      VOLTA_HOME: this.env.VOLTA_HOME ?? posix.join(this.homeDir, '.volta'),
    }
    for (const name of [
      'LANG',
      'LC_ALL',
      'LC_CTYPE',
      'TMPDIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
    ]) {
      const value = this.env[name]
      if (value !== undefined) output[name] = value
    }
    return output
  }
}

export function detectSupportedUbuntu(content: string): SupportedUbuntu {
  if (Buffer.byteLength(content, 'utf8') > MAX_OS_RELEASE_BYTES)
    throw new EnvironmentError('unsupported_platform')
  const values: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(trimmed)
    if (!match) continue
    let value = match[2]!
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1)
    if (!/^[A-Za-z0-9._-]+$/.test(value)) continue
    values[match[1]!] = value
  }
  if (values.ID !== 'ubuntu' || !SUPPORTED_UBUNTU.has(values.VERSION_ID ?? ''))
    throw new EnvironmentError('unsupported_platform')
  return {
    id: 'ubuntu',
    versionId: values.VERSION_ID as SupportedUbuntu['versionId'],
  }
}

export function linuxAppImageDiagnostics(opts: {
  env: Record<string, string | undefined>
  pathExists?: (path: string) => boolean
}): string[] {
  const pathExists = opts.pathExists ?? existsSync
  return opts.env.APPIMAGE && !pathExists('/dev/fuse')
    ? ['appimage_fuse_unavailable']
    : []
}

function activationNames(tool: ToolCatalogEntry): string[] {
  if (tool.id === 'go') return ['go', 'gofmt']
  if (tool.id === 'uv') return ['uv', 'uvx']
  if (tool.id === 'volta') return ['volta', 'volta-shim', 'volta-migrate']
  return tool.probe.executables.map((name) => posix.basename(name))
}

function findInstalledExecutables(
  root: string,
  names: readonly string[],
): Map<string, string> | null {
  const expected = new Set(names)
  const found = new Map<string, string>()
  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ]
  let visited = 0
  while (pending.length) {
    const current = pending.shift()!
    if (current.depth > 6) continue
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      visited += 1
      if (visited > 50_000) return null
      const path = join(current.path, entry.name)
      if (entry.isSymbolicLink()) return null
      if (entry.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 })
        continue
      }
      if (
        entry.isFile() &&
        isExecutable(path) &&
        expected.has(entry.name) &&
        !found.has(entry.name)
      )
        found.set(entry.name, path)
    }
  }
  return names.every((name) => found.has(name)) ? found : null
}

function preflightActivationLinks(
  binDir: string,
  executables: ReadonlyMap<string, string>,
): void {
  for (const [name, target] of executables) {
    const link = join(binDir, name)
    if (!pathEntryExists(link)) continue
    const stat = lstatSync(link)
    if (!stat.isSymbolicLink() || readlinkSync(link) !== target)
      throw new EnvironmentError('confirmation_required')
  }
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

function ensureManagedDirectory(
  path: string,
  label: string,
  recursive: boolean,
): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error(`unsafe ${label}`)
    return
  }
  mkdirSync(path, { recursive, mode: 0o700 })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`unsafe ${label}`)
}

function ensureReplaceableDirectory(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('unsafe Linux current tool directory')
}

function ensureContainedDirectory(root: string, path: string): void {
  const canonicalRoot = realpathSync(root)
  const canonicalPath = realpathSync(path)
  const child = posix.relative(canonicalRoot, canonicalPath)
  if (child === '..' || child.startsWith('../') || posix.isAbsolute(child))
    throw new Error('Linux activation directory escapes the user home')
}

function safeRegularFile(path: string): boolean {
  if (!existsSync(path)) return false
  const stat = lstatSync(path)
  return stat.isFile() && !stat.isSymbolicLink()
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function boundedDownloadBytes(estimatedBytes: number): number {
  return Math.min(
    20_000_000_000,
    Math.max(20 * 1024 * 1024, estimatedBytes + 10 * 1024 * 1024),
  )
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function failed(error: EnvironmentError): EnvironmentStepExecutionResult {
  return { status: 'failed', error }
}

async function logProcessResult(
  context: EnvironmentStepExecutionContext,
  result: EnvironmentProcessResult,
): Promise<void> {
  await context.log({
    level:
      result.status === 'completed' && result.exitCode === 0 ? 'info' : 'error',
    kind: 'installer_process',
    message: `Installer process ${result.status}.`,
    details: {
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  })
}
