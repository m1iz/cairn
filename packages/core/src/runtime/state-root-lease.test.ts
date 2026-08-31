import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreApi } from '../api/core-api'
import { StateRootLease, StateRootLeaseError } from './state-root-lease'

const leases: StateRootLease[] = []
const children: ChildProcess[] = []

afterEach(async () => {
  for (const lease of leases.splice(0).reverse()) lease.release()
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    if (child.exitCode === null && child.signalCode === null)
      await once(child, 'exit')
  }
})

describe('StateRootLease', () => {
  it('shares one process-owned lease by reference and releases it once', () => {
    const stateRoot = temp()
    const first = hold(StateRootLease.acquire(stateRoot, 'desktop'))
    const second = hold(StateRootLease.acquire(stateRoot, 'acp'))
    const path = join(stateRoot, '.state-root.lease')

    expect(first.snapshot()).toMatchObject({
      status: 'active',
      hostKind: 'desktop',
      sharedReferences: 2,
    })
    expect(second.snapshot().hostKind).toBe('desktop')
    first.release()
    expect(existsSync(path)).toBe(true)
    expect(second.snapshot().sharedReferences).toBe(1)
    second.release()
    expect(existsSync(path)).toBe(false)
  })

  it('rejects a live ACP process and reclaims its lease only after exit', async () => {
    const stateRoot = temp()
    const child = spawnLeaseOwner(stateRoot, 'acp')
    children.push(child)
    await waitForReady(child)

    expect(() => StateRootLease.acquire(stateRoot, 'desktop')).toThrowError(
      expect.objectContaining({
        code: 'state_root_in_use',
        ownerKind: 'acp',
      }),
    )

    child.kill()
    await once(child, 'exit')
    const recovered = hold(StateRootLease.acquire(stateRoot, 'desktop'))
    expect(recovered.snapshot().hostKind).toBe('desktop')
  })

  it('fails closed on a corrupt lease instead of deleting it', () => {
    const stateRoot = temp()
    const path = join(stateRoot, '.state-root.lease')
    writeFileSync(path, '{not-json', 'utf8')

    expect(() => StateRootLease.acquire(stateRoot, 'desktop')).toThrowError(
      expect.objectContaining({ code: 'state_root_lease_corrupt' }),
    )
    expect(readFileSync(path, 'utf8')).toBe('{not-json')
  })

  it('does not expose paths or process ids through the safe error payload', async () => {
    const stateRoot = temp()
    const child = spawnLeaseOwner(stateRoot, 'core')
    children.push(child)
    await waitForReady(child)

    let error: StateRootLeaseError | null = null
    try {
      StateRootLease.acquire(stateRoot, 'desktop')
    } catch (caught) {
      error = caught as StateRootLeaseError
    }
    expect(error?.toSafe()).toEqual({
      code: 'state_root_in_use',
      message: 'Cairn 状态目录正由另一个 Cairn 进程使用。请关闭该实例后重试。',
      action: 'close_other_cairn_host',
    })
    expect(JSON.stringify(error?.toSafe())).not.toContain(stateRoot)
    expect(JSON.stringify(error?.toSafe())).not.toContain(String(child.pid))
  })

  it('blocks CoreApi before migrations or stores can mutate the state root', async () => {
    const stateRoot = temp()
    const child = spawnLeaseOwner(stateRoot, 'acp')
    children.push(child)
    await waitForReady(child)

    await expect(
      CoreApi.create({ root: temp(), stateRoot, hostKind: 'desktop' }),
    ).rejects.toMatchObject({ code: 'state_root_in_use' })
    expect(existsSync(join(stateRoot, 'memory'))).toBe(false)
    expect(existsSync(join(stateRoot, 'sessions'))).toBe(false)
    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(false)
  })
})

function temp(): string {
  return mkdtempSync(join(tmpdir(), 'cairn-state-root-lease-'))
}

function hold(lease: StateRootLease): StateRootLease {
  leases.push(lease)
  return lease
}

function spawnLeaseOwner(
  stateRoot: string,
  hostKind: 'core' | 'desktop' | 'acp',
): ChildProcess {
  const script = String.raw`
    const { writeFileSync } = require('node:fs');
    const { hostname } = require('node:os');
    const { join } = require('node:path');
    const owner = {
      schemaVersion: 'cairn.state-root-lease.v1',
      nonce: 'child-' + process.pid,
      hostKind: process.env.CAIRN_TEST_HOST_KIND,
      pid: process.pid,
      hostname: hostname(),
      acquiredAt: new Date().toISOString(),
      bootMarker: null,
      processStartIdentity: null,
    };
    writeFileSync(join(process.env.CAIRN_TEST_STATE_ROOT, '.state-root.lease'), JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write('ready\n');
    setInterval(() => {}, 1000);
  `
  return spawn(process.execPath, ['-e', script], {
    env: {
      ...process.env,
      CAIRN_TEST_STATE_ROOT: stateRoot,
      CAIRN_TEST_HOST_KIND: hostKind,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

async function waitForReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout
  if (!stdout) throw new Error('child stdout unavailable')
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (!chunk.toString('utf8').includes('ready')) return
      cleanup()
      resolve()
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error('lease owner exited before ready'))
    }
    const cleanup = (): void => {
      stdout.off('data', onData)
      child.off('exit', onExit)
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
  })
}
