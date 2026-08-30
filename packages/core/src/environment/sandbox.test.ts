import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OsSandboxController, type ProcessContainmentPolicy } from './sandbox'
import { NodeOwnedProcessRunner } from './process-runner'

const cleanup: string[] = []

afterEach(() => {
  for (const path of cleanup.splice(0)) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // no-op
    }
  }
})

function policy(workspaceRoot = '/workspace'): ProcessContainmentPolicy {
  return {
    mode: 'required',
    workspaceRoot,
    stateRoot: posix.join(workspaceRoot, '.cairn'),
    tempRoot: posix.join(workspaceRoot, '.tmp'),
    readOnlyRoots: ['/runtime/bin'],
    network: 'deny',
  }
}

describe('OsSandboxController capability and preparation', () => {
  it('prepares a macOS Seatbelt profile without exposing arbitrary outside paths', () => {
    const controller = new OsSandboxController({
      platform: 'darwin',
      pathExists: (path) => path === '/usr/bin/sandbox-exec',
      probeProcess: () => ({ ok: true, detail: 'seatbelt probe passed' }),
    })

    expect(controller.capability()).toMatchObject({
      platform: 'darwin',
      backend: 'macos-seatbelt',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
    })
    const prepared = controller.prepare('/bin/sh', ['-c', 'pwd'], policy())
    expect(prepared.receipt).toMatchObject({
      decision: 'sandboxed',
      backend: 'macos-seatbelt',
      network: 'denied',
      filesystem: 'workspace-write',
    })
    expect(prepared.executable).toBe('/usr/bin/sandbox-exec')
    expect(prepared.args.slice(0, 2)).toEqual(['-p', expect.any(String)])
    const profile = prepared.args[1]!
    expect(profile).toContain('(deny default)')
    expect(profile).toContain('/workspace')
    expect(profile).toContain('/workspace/.cairn')
    expect(profile).toContain('(deny network*)')
    expect(profile).not.toContain('/Users/example/private')
    expect(prepared.args.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd'])
  })

  it('prepares Linux bwrap without a read-only bind of the whole host root', () => {
    const controller = new OsSandboxController({
      platform: 'linux',
      pathExists: (path) => path === '/usr/bin/bwrap',
      probeProcess: () => ({ ok: true, detail: 'user namespaces enabled' }),
    })
    const prepared = controller.prepare('/bin/sh', ['-c', 'pwd'], policy())

    expect(prepared.receipt).toMatchObject({
      decision: 'sandboxed',
      backend: 'linux-bwrap',
      network: 'denied',
    })
    expect(prepared.executable).toBe('/usr/bin/bwrap')
    expect(prepared.args).toContain('--unshare-net')
    expect(prepared.args).toContain('--die-with-parent')
    expect(prepared.args.join(' ')).not.toContain('--ro-bind / /')
    expect(prepared.args.slice(-3)).toEqual(['/bin/sh', '-c', 'pwd'])
  })

  it('reports unavailable and unsupported backends as typed decisions', () => {
    const missing = new OsSandboxController({
      platform: 'linux',
      pathExists: () => false,
    })
    expect(missing.capability()).toMatchObject({
      backend: 'linux-bwrap',
      status: 'unavailable',
    })
    expect(
      missing.prepare('/bin/sh', ['-c', 'pwd'], policy()).receipt,
    ).toMatchObject({ decision: 'denied', backend: 'linux-bwrap' })
    expect(
      missing.prepare('/bin/sh', ['-c', 'pwd'], {
        ...policy(),
        mode: 'preferred',
      }).receipt,
    ).toMatchObject({ decision: 'unsandboxed', backend: 'none' })

    const windows = new OsSandboxController({
      platform: 'win32',
      windowsHelperPath: 'C:\\missing\\cairn-windows-sandbox.exe',
      pathExists: () => false,
    })
    expect(windows.capability()).toMatchObject({
      backend: 'windows-native',
      status: 'unavailable',
    })
  })

  it('prepares the verified Windows helper without shell interpolation', () => {
    const helper = 'C:\\Cairn\\cairn-windows-sandbox.exe'
    const controller = new OsSandboxController({
      platform: 'win32',
      windowsHelperPath: helper,
      pathExists: (path) => path === helper,
      probeProcess: (executable, args) => ({
        ok: executable === helper && args[0] === '--self-test',
        detail: 'negative self-test passed',
      }),
    })
    expect(controller.capability()).toMatchObject({
      backend: 'windows-native',
      status: 'available',
      network: 'deny-only',
      processTree: true,
    })
    const prepared = controller.prepare(
      'C:\\Windows\\System32\\cmd.exe',
      ['/d', '/s', '/c', 'echo "hello world"'],
      {
        mode: 'required',
        workspaceRoot: 'C:\\workspace',
        stateRoot: 'C:\\workspace\\.cairn',
        tempRoot: 'C:\\workspace\\.tmp',
        readOnlyRoots: ['C:\\runtime\\bin'],
        network: 'deny',
      },
    )
    expect(prepared).toMatchObject({
      executable: helper,
      receipt: {
        decision: 'sandboxed',
        backend: 'windows-native',
        network: 'denied',
      },
    })
    expect(prepared.args.slice(-5)).toEqual(
      [
        '--',
        'C:\\Windows\\System32\\cmd.exe',
        '/d',
        '/s',
        '/c',
        'echo "hello world"',
      ].slice(-5),
    )
    expect(prepared.args).toContain('--deny')
    expect(prepared.args).toContain('--read-only')
  })

  it('does not silently weaken network-allowed Windows requests', () => {
    const helper = 'C:\\Cairn\\cairn-windows-sandbox.exe'
    const controller = new OsSandboxController({
      platform: 'win32',
      windowsHelperPath: helper,
      pathExists: () => true,
      probeProcess: () => ({ ok: true, detail: 'passed' }),
    })
    const required = controller.prepare('tool.exe', [], {
      ...policy('C:\\workspace'),
      mode: 'required',
      network: 'allow',
    })
    expect(required.receipt).toMatchObject({
      decision: 'denied',
      backend: 'windows-native',
      network: 'unavailable',
    })
    const preferred = controller.prepare('tool.exe', [], {
      ...policy('C:\\workspace'),
      mode: 'preferred',
      network: 'allow',
    })
    expect(preferred.receipt).toMatchObject({
      decision: 'unsandboxed',
      backend: 'none',
      network: 'unrestricted',
    })
  })
})

describe('NodeOwnedProcessRunner containment', () => {
  const realController = new OsSandboxController()
  const runnable =
    process.platform !== 'win32' &&
    realController.capability().status === 'available'

  it.runIf(runnable)(
    'blocks outside read/write, state-root access, symlink escape, child escape, and network while allowing workspace writes',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'cairn-sandbox-workspace-'))
      const outside = mkdtempSync(join(tmpdir(), 'cairn-sandbox-outside-'))
      cleanup.push(workspace, outside)
      const stateRoot = join(workspace, '.cairn')
      const tempRoot = join(workspace, '.sandbox-tmp')
      const outsideSecret = join(outside, 'secret.txt')
      const outsideWrite = join(outside, 'escaped.txt')
      const workspaceWrite = join(workspace, 'inside.txt')
      const stateSecret = join(stateRoot, 'secret.txt')
      const link = join(workspace, 'outside-link')
      mkdirSync(stateRoot, { recursive: true })
      mkdirSync(tempRoot, { recursive: true })
      writeFileSync(outsideSecret, 'outside-secret', 'utf8')
      writeFileSync(stateSecret, 'state-secret', {
        encoding: 'utf8',
        flag: 'w',
      })
      symlinkSync(outside, link)
      const runner = new NodeOwnedProcessRunner({ sandbox: realController })
      const common = {
        cwd: workspace,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: workspace,
        },
        timeoutMs: 5_000,
        containment: {
          mode: 'required' as const,
          workspaceRoot: workspace,
          stateRoot,
          tempRoot,
          readOnlyRoots: [dirname(process.execPath)],
          network: 'deny' as const,
        },
      }

      const inside = await runner.run({
        ...common,
        executable: '/bin/sh',
        args: ['-c', `printf inside > "${workspaceWrite}"`],
      })
      expect(inside).toMatchObject({
        status: 'completed',
        exitCode: 0,
        containment: { decision: 'sandboxed' },
      })
      expect(readFileSync(workspaceWrite, 'utf8')).toBe('inside')

      for (const command of [
        `cat "${outsideSecret}"`,
        `printf escaped > "${outsideWrite}"`,
        `cat "${stateSecret}"`,
        `printf escaped > "${join(link, 'symlink-escaped.txt')}"`,
        `/bin/sh -c 'printf escaped > "${join(outside, 'child-escaped.txt')}"'`,
      ]) {
        const result = await runner.run({
          ...common,
          executable: '/bin/sh',
          args: ['-c', command],
        })
        expect(result.exitCode, command).not.toBe(0)
        expect(result.containment.decision, command).toBe('sandboxed')
      }
      expect(existsSync(outsideWrite)).toBe(false)
      expect(existsSync(join(outside, 'symlink-escaped.txt'))).toBe(false)
      expect(existsSync(join(outside, 'child-escaped.txt'))).toBe(false)

      const server = createServer()
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('no port')
        const network = await runner.run({
          ...common,
          executable: process.execPath,
          args: [
            '-e',
            `require('node:net').connect(${address.port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(7))`,
          ],
          timeoutMs: 2_000,
        })
        expect(network).toMatchObject({
          status: 'completed',
          exitCode: 7,
          containment: { decision: 'sandboxed', network: 'denied' },
        })
      } finally {
        server.close()
      }

      const timed = await runner.run({
        ...common,
        executable: process.execPath,
        args: [
          '-e',
          `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)`,
        ],
        timeoutMs: 750,
      })
      expect(timed.status).toBe('timeout')
      const descendantPid = Number(timed.stdout.trim().split(/\s+/)[0])
      expect(Number.isInteger(descendantPid)).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      let descendantAlive = true
      try {
        process.kill(descendantPid, 0)
      } catch {
        descendantAlive = false
      }
      expect(descendantAlive).toBe(false)
    },
    20_000,
  )

  const windowsRunnable =
    process.platform === 'win32' &&
    realController.capability().status === 'available'

  it.runIf(windowsRunnable)(
    'enforces Windows workspace, state, descendant, and network boundaries through the real helper',
    async () => {
      const workspace = mkdtempSync(join(tmpdir(), 'cairn-win-workspace-'))
      const outside = mkdtempSync(join(tmpdir(), 'cairn-win-outside-'))
      cleanup.push(workspace, outside)
      const stateRoot = join(workspace, '.cairn')
      const tempRoot = join(workspace, '.sandbox-tmp')
      const nestedRoot = join(workspace, 'nested')
      mkdirSync(stateRoot, { recursive: true })
      mkdirSync(tempRoot, { recursive: true })
      mkdirSync(nestedRoot, { recursive: true })
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret', 'utf8')
      writeFileSync(join(stateRoot, 'secret.txt'), 'state-secret', 'utf8')
      const junction = join(workspace, 'outside-junction')
      symlinkSync(outside, junction, 'junction')
      const runner = new NodeOwnedProcessRunner({ sandbox: realController })
      const cmd = join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'cmd.exe',
      )
      const common = {
        cwd: workspace,
        env: { ...process.env, TMP: tempRoot, TEMP: tempRoot },
        timeoutMs: 15_000,
        containment: {
          mode: 'required' as const,
          workspaceRoot: workspace,
          stateRoot,
          tempRoot,
          readOnlyRoots: [dirname(process.execPath)],
          network: 'deny' as const,
        },
      }
      const inside = await runner.run({
        ...common,
        env: {},
        executable: cmd,
        args: ['/d', '/s', '/c', 'echo inside>inside.txt'],
      })
      expect(inside).toMatchObject({
        status: 'completed',
        exitCode: 0,
        containment: { decision: 'sandboxed', backend: 'windows-native' },
      })
      expect(readFileSync(join(workspace, 'inside.txt'), 'utf8')).toContain(
        'inside',
      )

      const nested = await runner.run({
        ...common,
        cwd: nestedRoot,
        executable: cmd,
        args: ['/d', '/s', '/c', 'echo nested>from-nested.txt'],
      })
      expect(nested).toMatchObject({ status: 'completed', exitCode: 0 })
      expect(
        readFileSync(join(nestedRoot, 'from-nested.txt'), 'utf8'),
      ).toContain('nested')

      for (const command of [
        `type "${join(outside, 'secret.txt')}"`,
        `echo escaped>"${join(outside, 'escaped.txt')}"`,
        `type "${join(stateRoot, 'secret.txt')}"`,
        `echo escaped>"${join(junction, 'junction-escaped.txt')}"`,
        `cmd /d /s /c echo escaped>"${join(outside, 'child-escaped.txt')}"`,
      ]) {
        const result = await runner.run({
          ...common,
          executable: cmd,
          args: ['/d', '/s', '/c', command],
        })
        expect(result.exitCode, command).not.toBe(0)
        expect(result.containment.decision, command).toBe('sandboxed')
      }
      expect(existsSync(join(outside, 'escaped.txt'))).toBe(false)
      expect(existsSync(join(outside, 'child-escaped.txt'))).toBe(false)
      expect(existsSync(join(outside, 'junction-escaped.txt'))).toBe(false)

      const server = createServer()
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      )
      try {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('no port')
        const network = await runner.run({
          ...common,
          executable: process.execPath,
          args: [
            '-e',
            `require('node:net').connect(${address.port},'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(7))`,
          ],
          timeoutMs: 5_000,
        })
        expect(network).toMatchObject({
          status: 'completed',
          exitCode: 7,
          containment: { decision: 'sandboxed', network: 'denied' },
        })
      } finally {
        server.close()
      }
    },
    60_000,
  )
})
