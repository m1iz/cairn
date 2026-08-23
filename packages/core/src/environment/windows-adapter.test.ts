import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  loadBundledToolCatalog,
  type LoadedToolCatalog,
  type ToolCatalogStrategy,
} from './catalog'
import type { AssetDownloader } from './download'
import type { EnvironmentStepExecutionContext } from './jobs'
import type { EnvironmentToolId } from './models'
import type {
  EnvironmentProcessRequest,
  EnvironmentProcessResult,
  EnvironmentProcessRunner,
} from './process-runner'
import { WindowsEnvironmentAdapter } from './windows-adapter'

class FakeRunner implements EnvironmentProcessRunner {
  readonly calls: EnvironmentProcessRequest[] = []
  result: EnvironmentProcessResult = {
    status: 'completed',
    exitCode: 0,
    stdout: '',
    stderr: '',
    durationMs: 1,
    error: null,
  }
  handler:
    ((request: EnvironmentProcessRequest) => EnvironmentProcessResult) | null =
    null

  async run(
    request: EnvironmentProcessRequest,
  ): Promise<EnvironmentProcessResult> {
    this.calls.push(request)
    return this.handler?.(request) ?? this.result
  }
}

function context(
  toolId: EnvironmentToolId,
  strategyId: string,
  opts: { separate?: boolean; elevation?: boolean } = {},
): EnvironmentStepExecutionContext & {
  logs: Array<{ kind: string; message: string }>
} {
  const logs: Array<{ kind: string; message: string }> = []
  return {
    step: {
      stepId: `step_${toolId}`,
      toolId,
      strategyId,
      dependsOn: [],
      status: 'planned',
      requiresElevation: opts.elevation ?? false,
      requiresSeparateConfirmation: opts.separate ?? false,
    },
    signal: new AbortController().signal,
    log: async (entry) => {
      logs.push({ kind: entry.kind, message: entry.message })
    },
    logs,
  }
}

function adapter(
  opts: {
    runner?: EnvironmentProcessRunner
    exists?: (path: string) => boolean
    catalog?: LoadedToolCatalog
    downloader?: AssetDownloader
    downloadsDir?: string
    installRoot?: string
  } = {},
): WindowsEnvironmentAdapter {
  return new WindowsEnvironmentAdapter({
    catalog: opts.catalog ?? loadBundledToolCatalog(),
    arch: 'x64',
    runner: opts.runner,
    executableExists: opts.exists,
    env: {
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\Tester',
      LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local',
      PATH: 'C:\\Windows\\System32',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      API_TOKEN: 'must-not-leak',
    },
    homeDir: 'C:\\Users\\Tester',
    downloader: opts.downloader,
    downloadsDir: opts.downloadsDir,
    installRoot: opts.installRoot,
  })
}

describe('WindowsEnvironmentAdapter', () => {
  it('runs exact winget package/source/agreement args from the catalog', async () => {
    const runner = new FakeRunner()
    const winget =
      'C:\\Users\\Tester\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe'
    const windows = adapter({
      runner,
      exists: (path) => path === winget,
    })

    await expect(windows.execute(context('git', 'winget'))).resolves.toEqual({
      status: 'completed',
    })
    expect(runner.calls[0]).toMatchObject({
      executable: winget,
      args: [
        'install',
        '--exact',
        '--id',
        'Git.Git',
        '--source',
        'winget',
        '--accept-package-agreements',
        '--accept-source-agreements',
        '--disable-interactivity',
      ],
      timeoutMs: 30 * 60 * 1_000,
    })
    expect(runner.calls[0]!.env).not.toHaveProperty('API_TOKEN')
  })

  it('does not bootstrap winget when App Installer is unavailable', async () => {
    const runner = new FakeRunner()
    const windows = adapter({ runner, exists: () => false })
    const execution = context('ripgrep', 'winget')

    await expect(windows.execute(execution)).resolves.toEqual({
      status: 'awaiting_user',
    })
    expect(runner.calls).toEqual([])
    expect(execution.logs[0]).toMatchObject({ kind: 'winget_required' })
  })

  it('does not resolve winget from an arbitrary PATH entry', async () => {
    const runner = new FakeRunner()
    const injected = 'C:\\Windows\\System32\\winget.exe'
    const windows = adapter({
      runner,
      exists: (path) => path === injected,
    })

    await expect(windows.execute(context('git', 'winget'))).resolves.toEqual({
      status: 'awaiting_user',
    })
    expect(runner.calls).toEqual([])
  })

  it('refuses MSVC outside a separately confirmed elevated step', async () => {
    const winget =
      'C:\\Users\\Tester\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe'
    const windows = adapter({ exists: (path) => path === winget })

    await expect(
      windows.execute(context('msvc-build-tools', 'winget')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'confirmation_required' },
    })
  })

  it('maps Windows user-cancelled installer exit codes to elevation_declined', async () => {
    const runner = new FakeRunner()
    runner.result = { ...runner.result, exitCode: 1223 }
    const winget =
      'C:\\Users\\Tester\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe'
    const windows = adapter({ runner, exists: (path) => path === winget })

    await expect(
      windows.execute(
        context('msvc-build-tools', 'winget', {
          separate: true,
          elevation: true,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'elevation_declined' },
    })
  })

  it('resolves and runs exact version-manager commands from user PATH additions', async () => {
    const runner = new FakeRunner()
    const volta = 'C:\\Users\\Tester\\AppData\\Local\\Volta\\bin\\volta.exe'
    const windows = adapter({ runner, exists: (path) => path === volta })

    await expect(windows.execute(context('node', 'volta'))).resolves.toEqual({
      status: 'completed',
    })
    expect(runner.calls[0]).toMatchObject({
      executable: volta,
      args: ['install', 'node@24.18.0'],
    })
  })

  it('rejects an installer digest mismatch before Authenticode validation', async () => {
    const bytes = Buffer.from('tampered installer')
    const fixture = assetFixture({
      kind: 'windows_installer',
      url: 'https://downloads.example.test/tool.msi',
      sha256: createHash('sha256').update('expected').digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(bytes),
      downloadsDir: fixture.downloads,
    })

    await expect(
      windows.execute(context('git', 'official-installer')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(runner.calls).toEqual([])
  })

  it('requires Valid Authenticode and exact publisher before running MSI', async () => {
    const bytes = Buffer.from('signed installer')
    const fixture = assetFixture({
      kind: 'windows_installer',
      url: 'https://downloads.example.test/tool.msi',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    runner.handler = (request) =>
      request.executable.toLowerCase().endsWith('powershell.exe')
        ? {
            ...runner.result,
            stdout: `\uFEFF${JSON.stringify({
              Status: 'Valid',
              Publisher: 'Example Corporation',
            })}`,
          }
        : runner.result
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(bytes),
      downloadsDir: fixture.downloads,
    })

    await expect(
      windows.execute(context('git', 'official-installer')),
    ).resolves.toEqual({ status: 'completed' })
    expect(runner.calls[0]!.executable).toMatch(/powershell\.exe$/i)
    expect(runner.calls[1]).toMatchObject({
      executable: 'C:\\Windows\\System32\\msiexec.exe',
      args: [
        '/i',
        expect.stringMatching(/step_git-.+\.msi$/),
        '/passive',
        '/norestart',
      ],
    })
  })

  it('blocks a mismatched Authenticode publisher without running the installer', async () => {
    const bytes = Buffer.from('signed installer')
    const fixture = assetFixture({
      kind: 'windows_installer',
      url: 'https://downloads.example.test/tool.exe',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      publisher: 'Expected Corporation',
    })
    const runner = new FakeRunner()
    runner.result = {
      ...runner.result,
      stdout: JSON.stringify({
        Status: 'Valid',
        Publisher: 'Unexpected Corporation',
      }),
    }
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(bytes),
      downloadsDir: fixture.downloads,
    })

    await expect(
      windows.execute(context('git', 'official-installer')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'publisher_mismatch' },
    })
    expect(runner.calls).toHaveLength(1)
  })

  it('preserves cancellation during Authenticode verification', async () => {
    const bytes = Buffer.from('signed installer')
    const fixture = assetFixture({
      kind: 'windows_installer',
      url: 'https://downloads.example.test/tool.exe',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      publisher: 'Expected Corporation',
    })
    const runner = new FakeRunner()
    runner.result = { ...runner.result, status: 'cancelled', exitCode: null }
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(bytes),
      downloadsDir: fixture.downloads,
    })

    await expect(
      windows.execute(context('git', 'official-installer')),
    ).resolves.toEqual({ status: 'cancelled' })
  })

  it('extracts a digest-verified ZIP and appends its bin directory to User PATH', async () => {
    const archive = storedZip('bin/rg.exe', Buffer.from('binary'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    runner.handler = (request) =>
      request.args[0] === 'query'
        ? {
            ...runner.result,
            stdout:
              '    Path    REG_EXPAND_SZ    C:\\Windows\\System32;%LOCALAPPDATA%\\Programs',
          }
        : runner.result
    const installRoot = join(fixture.root, 'tools')
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot,
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toEqual({ status: 'completed' })
    const installedBin = join(installRoot, 'ripgrep', 'current', 'bin')
    expect(readFileSync(join(installedBin, 'rg.exe'), 'utf8')).toBe('binary')
    expect(runner.calls.at(-1)).toMatchObject({
      executable: 'C:\\Windows\\System32\\reg.exe',
      args: expect.arrayContaining([
        'add',
        'HKCU\\Environment',
        '/d',
        expect.stringContaining(installedBin),
      ]),
    })
  })

  it('rejects a traversal ZIP before extracting or updating PATH', async () => {
    const archive = storedZip('../escape.exe', Buffer.from('bad'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot: join(fixture.root, 'tools'),
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(existsSync(join(fixture.root, 'escape.exe'))).toBe(false)
    expect(runner.calls).toEqual([])
  })

  it('does not update PATH when the ZIP lacks the declared executable', async () => {
    const archive = storedZip('bin/other.exe', Buffer.from('binary'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot: join(fixture.root, 'tools'),
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'post_install_probe_failed' },
    })
    expect(runner.calls).toEqual([])
  })

  it('fails closed when User PATH cannot be read', async () => {
    const archive = storedZip('bin/rg.exe', Buffer.from('binary'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    runner.result = { ...runner.result, status: 'spawn_error', exitCode: null }
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot: join(fixture.root, 'tools'),
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'installer_failed' },
    })
    expect(runner.calls).toHaveLength(1)
    expect(runner.calls[0]!.args[0]).toBe('query')
  })

  it('fails closed when User PATH output cannot be parsed', async () => {
    const archive = storedZip('bin/rg.exe', Buffer.from('binary'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const runner = new FakeRunner()
    runner.result = { ...runner.result, stdout: 'unexpected output' }
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot: join(fixture.root, 'tools'),
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'installer_failed' },
    })
    expect(runner.calls).toHaveLength(1)
  })

  it('restores the previous archive installation when PATH update fails', async () => {
    const archive = storedZip('bin/rg.exe', Buffer.from('new'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const installRoot = join(fixture.root, 'tools')
    const currentBin = join(installRoot, 'ripgrep', 'current', 'bin')
    mkdirSync(currentBin, { recursive: true })
    writeFileSync(join(currentBin, 'rg.exe'), 'old', 'utf8')
    const runner = new FakeRunner()
    runner.result = { ...runner.result, status: 'spawn_error', exitCode: null }
    const windows = adapter({
      catalog: fixture.catalog,
      runner,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot,
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'installer_failed' },
    })
    expect(readFileSync(join(currentBin, 'rg.exe'), 'utf8')).toBe('old')
  })

  it('rejects a symlinked download directory before invoking the downloader', async () => {
    const archive = storedZip('bin/rg.exe', Buffer.from('binary'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const outside = mkdtempSync(join(tmpdir(), 'cairn-windows-download-'))
    const downloads = join(fixture.root, 'downloads-link')
    symlinkSync(outside, downloads)
    let called = false
    const windows = adapter({
      catalog: fixture.catalog,
      downloader: {
        download: async () => {
          called = true
        },
      },
      downloadsDir: downloads,
      installRoot: join(fixture.root, 'tools'),
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(called).toBe(false)
  })

  it('rejects a symlinked managed tool directory before deleting external data', async () => {
    const archive = storedZip('bin/rg.exe', Buffer.from('binary'))
    const fixture = assetFixture({
      kind: 'direct_archive',
      url: 'https://downloads.example.test/tool.zip',
      sha256: createHash('sha256').update(archive).digest('hex'),
      publisher: 'Example Corporation',
    })
    const installRoot = join(fixture.root, 'tools')
    const outside = mkdtempSync(join(tmpdir(), 'cairn-windows-outside-'))
    mkdirSync(installRoot, { recursive: true })
    mkdirSync(join(outside, 'current'), { recursive: true })
    writeFileSync(join(outside, 'current', 'sentinel'), 'keep', 'utf8')
    symlinkSync(outside, join(installRoot, 'ripgrep'))
    const windows = adapter({
      catalog: fixture.catalog,
      downloader: downloader(archive),
      downloadsDir: fixture.downloads,
      installRoot,
    })

    await expect(
      windows.execute(context('ripgrep', 'official-archive')),
    ).resolves.toMatchObject({
      status: 'failed',
      error: { environmentCode: 'integrity_failed' },
    })
    expect(readFileSync(join(outside, 'current', 'sentinel'), 'utf8')).toBe(
      'keep',
    )
  })
})

function downloader(bytes: Buffer): AssetDownloader {
  return {
    download: async ({ destination }) => {
      writeFileSync(destination, bytes)
    },
  }
}

function assetFixture(opts: {
  kind: 'windows_installer' | 'direct_archive'
  url: string
  sha256: string
  publisher: string
}): { catalog: LoadedToolCatalog; root: string; downloads: string } {
  const root = mkdtempSync(join(tmpdir(), 'cairn-windows-adapter-'))
  const catalog = structuredClone(loadBundledToolCatalog())
  const tool = catalog.catalog.tools.find((entry) =>
    opts.kind === 'direct_archive'
      ? entry.id === 'ripgrep'
      : entry.id === 'git',
  )!
  const strategy: ToolCatalogStrategy = {
    id:
      opts.kind === 'windows_installer'
        ? 'official-installer'
        : 'official-archive',
    kind: opts.kind,
    targets: [{ platform: 'win32', arch: 'x64' }],
    executable: opts.kind === 'windows_installer' ? 'msiexec.exe' : 'rg.exe',
    args: opts.kind === 'windows_installer' ? ['/passive', '/norestart'] : [],
    source: {
      url: opts.url,
      publisher: opts.publisher,
      sha256: opts.sha256,
    },
    estimatedBytes: 1024,
    requiresElevation: opts.kind === 'windows_installer',
    requiresSeparateConfirmation: opts.kind === 'windows_installer',
  }
  tool.strategies = [strategy]
  const downloads = join(root, 'downloads')
  return { catalog, root, downloads }
}

function storedZip(nameValue: string, data: Buffer): Buffer {
  const name = Buffer.from(nameValue, 'utf8')
  const crc = crc32(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x0800, 6)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(data.byteLength, 18)
  local.writeUInt32LE(data.byteLength, 22)
  local.writeUInt16LE(name.byteLength, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(0x031e, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(0x0800, 8)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(data.byteLength, 20)
  central.writeUInt32LE(data.byteLength, 24)
  central.writeUInt16LE(name.byteLength, 28)
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.byteLength + name.byteLength, 12)
  end.writeUInt32LE(local.byteLength + name.byteLength + data.byteLength, 16)
  return Buffer.concat([local, name, data, central, name, end])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}
