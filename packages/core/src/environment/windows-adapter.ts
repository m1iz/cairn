import { createHash, randomBytes } from 'node:crypto'
import {
  accessSync,
  constants,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { extname, join, win32 } from 'node:path'
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
import {
  buildEffectivePath,
  parseWindowsRegistryPath,
  windowsEnvValue,
} from './path'
import {
  NodeEnvironmentProcessRunner,
  type EnvironmentProcessRequest,
  type EnvironmentProcessResult,
  type EnvironmentProcessRunner,
} from './process-runner'
import { extractBoundedZip } from './zip'

const INSTALL_TIMEOUT_MS = 30 * 60 * 1_000
const VERIFY_TIMEOUT_MS = 60_000
const MAX_INSTALL_OUTPUT_BYTES = 1024 * 1024
const POWERSHELL_SIGNATURE_SCRIPT = [
  '$s=Get-AuthenticodeSignature -LiteralPath $args[0]',
  '$p=if($s.SignerCertificate){$s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false)}else{""}',
  '[pscustomobject]@{Status=[string]$s.Status;Publisher=[string]$p}|ConvertTo-Json -Compress',
].join(';')

export interface WindowsEnvironmentAdapterOptions {
  catalog: LoadedToolCatalog
  arch: EnvironmentArch
  runner?: EnvironmentProcessRunner
  env?: Record<string, string | undefined>
  homeDir?: string
  executableExists?: (path: string) => boolean
  downloader?: AssetDownloader | null
  downloadsDir?: string | null
  installRoot?: string | null
}

export class WindowsEnvironmentAdapter implements EnvironmentStepExecutor {
  private readonly catalog: LoadedToolCatalog
  private readonly arch: EnvironmentArch
  private readonly runner: EnvironmentProcessRunner
  private readonly env: Record<string, string | undefined>
  private readonly homeDir: string
  private readonly executableExists: (path: string) => boolean
  private readonly downloader: AssetDownloader
  private readonly downloadsDir: string
  private readonly installRoot: string

  constructor(opts: WindowsEnvironmentAdapterOptions) {
    this.catalog = opts.catalog
    this.arch = opts.arch
    this.runner = opts.runner ?? new NodeEnvironmentProcessRunner()
    this.env = { ...(opts.env ?? process.env) }
    this.homeDir =
      opts.homeDir ?? windowsEnvValue(this.env, 'USERPROFILE') ?? ''
    this.executableExists = opts.executableExists ?? isExecutable
    this.downloader = opts.downloader ?? new NodeHttpsAssetDownloader()
    const localAppData =
      windowsEnvValue(this.env, 'LOCALAPPDATA') ??
      win32.join(this.homeDir, 'AppData', 'Local')
    this.downloadsDir =
      opts.downloadsDir ??
      win32.join(localAppData, 'Cairn', 'environment', 'downloads')
    this.installRoot =
      opts.installRoot ??
      win32.join(localAppData, 'Cairn', 'environment', 'tools')
  }

  async execute(
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (this.arch !== 'x64')
      return failed(new EnvironmentError('unsupported_arch'))
    const resolved = this.resolveStep(context)
    if (!resolved)
      return failed(new EnvironmentError('unsupported_requirement'))
    const { tool, strategy } = resolved
    if (
      tool.id === 'msvc-build-tools' &&
      (!context.step.requiresElevation ||
        !context.step.requiresSeparateConfirmation)
    )
      return failed(new EnvironmentError('confirmation_required'))
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
    if (strategy.kind === 'package_manager')
      return await this.runWinget(strategy, context)
    if (strategy.kind === 'windows_installer')
      return await this.runVerifiedInstaller(strategy, context)
    if (strategy.kind === 'direct_archive')
      return await this.installVerifiedArchive(tool, strategy, context)
    if (strategy.kind === 'version_manager' || strategy.kind === 'bundled')
      return await this.runCatalogCommand(strategy, context)
    return failed(new EnvironmentError('unsupported_requirement'))
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
          (target) => target.platform === 'win32' && target.arch === this.arch,
        ),
    )
    return tool && strategy ? { tool, strategy } : null
  }

  private async runWinget(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (
      strategy.id !== 'winget' ||
      strategy.executable !== 'winget.exe' ||
      !validWingetArguments(strategy.args)
    )
      return failed(new EnvironmentError('unsupported_requirement'))
    const executable = this.wingetPath()
    if (!executable) {
      await context.log({
        level: 'warn',
        kind: 'winget_required',
        message:
          'Windows App Installer is unavailable and will not be bootstrapped automatically.',
        details: {},
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
    )
  }

  private async runVerifiedInstaller(
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const extension = installerExtension(strategy.source.url)
    if (!extension)
      return failed(new EnvironmentError('unsupported_requirement'))
    const downloaded = await this.downloadVerified(strategy, context, extension)
    if (typeof downloaded !== 'string') return downloaded
    const signature = await this.verifyAuthenticode(
      downloaded,
      strategy.source.publisher,
      context.signal,
    )
    if (signature) {
      await rm(downloaded, { force: true })
      if (signature.environmentCode === 'cancelled')
        return { status: 'cancelled' }
      return failed(signature)
    }
    const request: EnvironmentProcessRequest =
      extension === '.msi'
        ? {
            executable: win32.join(
              this.systemRoot(),
              'System32',
              'msiexec.exe',
            ),
            args: ['/i', downloaded, ...strategy.args],
            env: this.processEnvironment(),
            timeoutMs: INSTALL_TIMEOUT_MS,
            maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
            signal: context.signal,
          }
        : {
            executable: downloaded,
            args: [...strategy.args],
            env: this.processEnvironment(),
            timeoutMs: INSTALL_TIMEOUT_MS,
            maxOutputBytes: MAX_INSTALL_OUTPUT_BYTES,
            signal: context.signal,
          }
    try {
      return await this.runProcess(request, context)
    } finally {
      await rm(downloaded, { force: true })
    }
  }

  private async installVerifiedArchive(
    tool: ToolCatalogEntry,
    strategy: ToolCatalogStrategy,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    if (!new URL(strategy.source.url).pathname.toLowerCase().endsWith('.zip'))
      return failed(new EnvironmentError('unsupported_requirement'))
    const downloaded = await this.downloadVerified(strategy, context, '.zip')
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
    try {
      ensureManagedInstallRoot(this.installRoot)
      ensureManagedToolRoot(toolRoot)
      ensureReplaceableDirectory(destination)
      extractBoundedZip({
        archive: downloaded,
        destination: candidate,
        maxArchiveBytes: boundedDownloadBytes(strategy.estimatedBytes),
        maxFiles: 1000,
        maxFileBytes: 200 * 1024 * 1024,
        maxTotalBytes: 1024 * 1024 * 1024,
      })
      const candidatePathEntry = findInstalledExecutableDirectory(
        candidate,
        tool.probe.executables,
      )
      if (!candidatePathEntry)
        throw new EnvironmentError('post_install_probe_failed')
      const relativePathEntry = candidatePathEntry.slice(candidate.length)
      if (existsSync(destination)) {
        renameSync(destination, backup)
        replacedExisting = true
      }
      renameSync(candidate, destination)
      activatedCandidate = true
      const pathEntry = `${destination}${relativePathEntry}`
      const pathResult = await new WindowsUserPathManager({
        runner: this.runner,
        env: this.processEnvironment(),
        systemRoot: this.systemRoot(),
      }).add(pathEntry, context.signal)
      if (pathResult) throw pathResult
      if (replacedExisting) rmSync(backup, { recursive: true, force: true })
      return { status: 'completed' }
    } catch (cause) {
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
      ensureManagedDownloadRoot(this.downloadsDir)
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
      return failed(
        cause instanceof EnvironmentError
          ? cause
          : new EnvironmentError('download_failed', { cause }),
      )
    }
    if (!safeRegularFile(destination))
      return failed(new EnvironmentError('integrity_failed'))
    if ((await sha256File(destination)) !== strategy.source.sha256) {
      await rm(destination, { force: true })
      return failed(new EnvironmentError('integrity_failed'))
    }
    return destination
  }

  private async verifyAuthenticode(
    path: string,
    expectedPublisher: string,
    signal: AbortSignal,
  ): Promise<EnvironmentError | null> {
    const executable = win32.join(
      this.systemRoot(),
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    )
    const result = await this.runner.run({
      executable,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        POWERSHELL_SIGNATURE_SCRIPT,
        path,
      ],
      env: this.processEnvironment(),
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal,
    })
    if (result.status === 'cancelled') return new EnvironmentError('cancelled')
    if (result.status !== 'completed' || result.exitCode !== 0)
      return new EnvironmentError('publisher_mismatch')
    try {
      const parsed = JSON.parse(
        result.stdout.replace(/^\uFEFF/, '').trim(),
      ) as {
        Status?: unknown
        Publisher?: unknown
      }
      if (parsed.Status !== 'Valid' || parsed.Publisher !== expectedPublisher)
        return new EnvironmentError('publisher_mismatch')
      return null
    } catch {
      return new EnvironmentError('publisher_mismatch')
    }
  }

  private async runProcess(
    request: EnvironmentProcessRequest,
    context: EnvironmentStepExecutionContext,
  ): Promise<EnvironmentStepExecutionResult> {
    const result = await this.runner.run(request)
    await logProcessResult(context, result)
    if (result.status === 'cancelled') return { status: 'cancelled' }
    if (isElevationDeclined(result.exitCode))
      return failed(new EnvironmentError('elevation_declined'))
    if (
      result.status !== 'completed' ||
      (result.exitCode !== 0 && result.exitCode !== 3010)
    )
      return failed(new EnvironmentError('installer_failed'))
    return { status: 'completed' }
  }

  private wingetPath(): string | null {
    const localAppData = windowsEnvValue(this.env, 'LOCALAPPDATA')
    if (localAppData) {
      const fixed = win32.join(
        localAppData,
        'Microsoft',
        'WindowsApps',
        'winget.exe',
      )
      if (this.executableExists(fixed)) return fixed
    }
    return null
  }

  private resolveExecutable(executable: string): string | null {
    if (win32.isAbsolute(executable))
      return this.executableExists(executable) ? executable : null
    const extensions = executable.includes('.')
      ? ['']
      : pathext(this.env).map((extension) => extension.toLowerCase())
    for (const directory of this.effectivePath().entries) {
      for (const extension of extensions) {
        const candidate = win32.join(directory, `${executable}${extension}`)
        if (this.executableExists(candidate)) return candidate
      }
    }
    return null
  }

  private effectivePath(): { entries: string[]; value: string } {
    return buildEffectivePath({
      platform: 'win32',
      envPath: windowsEnvValue(this.env, 'PATH'),
      homeDir: this.homeDir,
      windowsEnv: this.env,
    })
  }

  private processEnvironment(): Record<string, string> {
    const output: Record<string, string> = {
      PATH: this.effectivePath().value,
      SystemRoot: this.systemRoot(),
      USERPROFILE: this.homeDir,
    }
    for (const name of [
      'ComSpec',
      'PATHEXT',
      'TEMP',
      'TMP',
      'USERNAME',
      'LOCALAPPDATA',
      'LANG',
      'LC_ALL',
    ]) {
      const value = windowsEnvValue(this.env, name)
      if (value !== undefined) output[name] = value
    }
    return output
  }

  private systemRoot(): string {
    return windowsEnvValue(this.env, 'SystemRoot') ?? 'C:\\Windows'
  }
}

class WindowsUserPathManager {
  private readonly runner: EnvironmentProcessRunner
  private readonly env: Record<string, string>
  private readonly executable: string

  constructor(opts: {
    runner: EnvironmentProcessRunner
    env: Record<string, string>
    systemRoot: string
  }) {
    this.runner = opts.runner
    this.env = opts.env
    this.executable = win32.join(opts.systemRoot, 'System32', 'reg.exe')
  }

  async add(
    path: string,
    signal: AbortSignal,
  ): Promise<EnvironmentError | null> {
    if (!path || path.includes('\u0000') || path.length > 4096)
      return new EnvironmentError('installer_failed')
    const query = await this.runner.run({
      executable: this.executable,
      args: ['query', 'HKCU\\Environment', '/v', 'Path'],
      env: this.env,
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal,
    })
    if (query.status === 'cancelled') return new EnvironmentError('cancelled')
    if (query.status !== 'completed' || query.exitCode !== 0)
      return new EnvironmentError('installer_failed')
    const existing = parseWindowsRegistryPath(query.stdout)
    if (!existing) return new EnvironmentError('installer_failed')
    const entries = existing
      .split(';')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (entries.some((entry) => entry.toLowerCase() === path.toLowerCase()))
      return null
    const next = [...entries, path].join(';')
    if (next.length > 32_767) return new EnvironmentError('installer_failed')
    const update = await this.runner.run({
      executable: this.executable,
      args: [
        'add',
        'HKCU\\Environment',
        '/v',
        'Path',
        '/t',
        'REG_EXPAND_SZ',
        '/d',
        next,
        '/f',
      ],
      env: this.env,
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxOutputBytes: 256 * 1024,
      signal,
    })
    if (update.status === 'cancelled') return new EnvironmentError('cancelled')
    return update.status === 'completed' && update.exitCode === 0
      ? null
      : new EnvironmentError('installer_failed')
  }
}

function validWingetArguments(args: readonly string[]): boolean {
  const required = [
    '--exact',
    '--source',
    'winget',
    '--accept-package-agreements',
    '--accept-source-agreements',
    '--disable-interactivity',
  ]
  return (
    args[0] === 'install' &&
    args.includes('--id') &&
    required.every((value) => args.includes(value))
  )
}

function isElevationDeclined(exitCode: number | null): boolean {
  return (
    exitCode === 1223 ||
    exitCode === 1602 ||
    exitCode === 0x800704c7 ||
    exitCode === -2147023673
  )
}

function installerExtension(sourceUrl: string): '.msi' | '.exe' | null {
  const extension = extname(new URL(sourceUrl).pathname).toLowerCase()
  return extension === '.msi' || extension === '.exe' ? extension : null
}

function boundedDownloadBytes(estimatedBytes: number): number {
  return Math.min(
    20_000_000_000,
    Math.max(20 * 1024 * 1024, estimatedBytes + 10 * 1024 * 1024),
  )
}

function ensureManagedInstallRoot(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('unsafe Windows tool install root')
  } else mkdirSync(path, { recursive: true })
}

function ensureManagedDownloadRoot(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('unsafe Windows download root')
    return
  }
  mkdirSync(path, { recursive: true })
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('unsafe Windows download root')
}

function ensureManagedToolRoot(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error('unsafe Windows tool directory')
    return
  }
  mkdirSync(path, { recursive: false })
}

function ensureReplaceableDirectory(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error('unsafe Windows current tool directory')
}

function findInstalledExecutableDirectory(
  root: string,
  executableNames: readonly string[],
): string | null {
  const expected = new Set(
    executableNames.flatMap((name) => {
      const base = win32.basename(name).toLowerCase()
      return base.includes('.') ? [base] : [base, `${base}.exe`]
    }),
  )
  const pending: Array<{ path: string; depth: number }> = [
    { path: root, depth: 0 },
  ]
  let visited = 0
  while (pending.length) {
    const current = pending.shift()!
    if (current.depth > 4) continue
    for (const entry of readdirSync(current.path, { withFileTypes: true })) {
      visited += 1
      if (visited > 1000) return null
      const path = join(current.path, entry.name)
      if (entry.isSymbolicLink()) return null
      if (entry.isDirectory()) {
        pending.push({ path, depth: current.depth + 1 })
        continue
      }
      if (entry.isFile() && expected.has(entry.name.toLowerCase()))
        return current.path
    }
  }
  return null
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

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function pathext(env: Record<string, string | undefined>): string[] {
  const configured = windowsEnvValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  return configured
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => /^\.[A-Za-z0-9]+$/.test(entry))
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
      result.status === 'completed' &&
      (result.exitCode === 0 || result.exitCode === 3010)
        ? 'info'
        : 'error',
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
