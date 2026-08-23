import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import { describe, expect, it } from 'vitest'
import { defaultHooksConfigV2 } from './schema'
import { ExecutionEnvironment } from '../environment/snapshot'

type Dict = Record<string, unknown>
type Result = {
  outcome: 'completed' | 'failed' | 'timeout' | 'cancelled'
  output: Dict | null
  reason: string
  stdout: string
  stdoutBytes: number
  stdoutTruncated: boolean
}
type HttpExecutor = {
  execute(handler: Dict, input: Dict, context: Dict): Promise<Result>
}
type Lookup = (hostname: string) => Promise<string[]>

async function httpExecutor(lookup?: Lookup): Promise<HttpExecutor> {
  const module = (await import('./executor')) as unknown as Record<
    string,
    new (...args: unknown[]) => unknown
  >
  expect(module.HttpHookExecutor).toBeTypeOf('function')
  const HttpHookExecutor = module.HttpHookExecutor!
  return new HttpHookExecutor({ lookup }) as HttpExecutor
}

function handler(url: string, overrides: Dict = {}): Dict {
  return {
    id: 'http-test',
    type: 'http',
    enabled: true,
    url,
    timeoutMs: 1_000,
    statusMessage: '',
    once: false,
    headers: {},
    allowedEnv: [],
    ...overrides,
  }
}

function input(): Dict {
  return {
    hook_event_name: 'PreToolUse',
    session_id: 's1',
    cwd: '/repo',
    state_root: '/state',
    tool_name: 'write_file',
    tool_input: { path: 'README.md' },
    tool_use_id: 'call-1',
  }
}

function context(overrides: Dict = {}): Dict {
  return {
    eventName: 'PreToolUse',
    cwd: '/repo',
    policy: defaultHooksConfigV2().policy,
    ...overrides,
  }
}

async function server(
  listener: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ port: number; close(): Promise<void> }> {
  const instance = createServer(listener)
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve))
  const address = instance.address()
  if (!address || typeof address === 'string')
    throw new Error('missing server address')
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        instance.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

describe('hooks v2 HTTP executor', () => {
  it('disables HTTP when the global URL allowlist is empty', async () => {
    const executor = await httpExecutor()
    const result = await executor.execute(
      handler('https://hooks.example.test/run'),
      input(),
      context(),
    )

    expect(result).toMatchObject({ outcome: 'failed', output: null })
    expect(result.reason).toMatch(/allowlist.*empty/i)
  })

  it('posts event JSON to a pinned allowed target and preserves the Host header', async () => {
    const local = await server((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += String(chunk)
      })
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tool_name: string }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            decision: 'allow',
            reason: `${req.headers.host}:${parsed.tool_name}`,
          }),
        )
      })
    })
    try {
      const url = `http://hooks.example.test:${local.port}/run`
      const policy = defaultHooksConfigV2().policy
      policy.http.allowedUrlPatterns = ['http://hooks.example.test:*/run']
      policy.http.allowLoopback = true
      const executor = await httpExecutor(async () => ['127.0.0.1'])
      const result = await executor.execute(
        handler(url),
        input(),
        context({ policy }),
      )

      expect(result).toMatchObject({
        outcome: 'completed',
        output: { decision: 'allow' },
      })
      expect(String(result.output?.reason)).toContain(
        `hooks.example.test:${local.port}:write_file`,
      )
    } finally {
      await local.close()
    }
  })

  it('requires explicit loopback policy even when the URL pattern matches', async () => {
    const policy = defaultHooksConfigV2().policy
    policy.http.allowedUrlPatterns = ['http://127.0.0.1:*/*']
    const executor = await httpExecutor()
    const denied = await executor.execute(
      handler('http://127.0.0.1:9/run'),
      input(),
      context({ policy }),
    )
    policy.http.allowLoopback = true
    const allowedPastPolicy = await executor.execute(
      handler('http://127.0.0.1:9/run'),
      input(),
      context({ policy }),
    )

    expect(denied.reason).toMatch(/loopback/i)
    expect(allowedPastPolicy.reason).not.toMatch(/loopback.*denied/i)
  })

  it('rejects private and mixed DNS answers before opening a socket', async () => {
    const policy = defaultHooksConfigV2().policy
    policy.http.allowedUrlPatterns = ['http://hooks.example.test/*']
    const privateExecutor = await httpExecutor(async () => ['10.1.2.3'])
    const mixedExecutor = await httpExecutor(async () => [
      '93.184.216.34',
      '169.254.169.254',
    ])

    const privateResult = await privateExecutor.execute(
      handler('http://hooks.example.test/run'),
      input(),
      context({ policy }),
    )
    const mixedResult = await mixedExecutor.execute(
      handler('http://hooks.example.test/run'),
      input(),
      context({ policy }),
    )

    expect(privateResult.reason).toMatch(/private|blocked/i)
    expect(mixedResult.reason).toMatch(/blocked/i)
  })

  it('does not follow redirects', async () => {
    let targetHits = 0
    const local = await server((req, res) => {
      if (req.url === '/target') {
        targetHits += 1
        res.writeHead(200)
        res.end('{}')
        return
      }
      res.writeHead(302, { location: '/target' })
      res.end()
    })
    try {
      const policy = defaultHooksConfigV2().policy
      policy.http.allowedUrlPatterns = ['http://127.0.0.1:*/*']
      policy.http.allowLoopback = true
      const executor = await httpExecutor()
      const result = await executor.execute(
        handler(`http://127.0.0.1:${local.port}/redirect`),
        input(),
        context({ policy }),
      )

      expect(result.outcome).toBe('failed')
      expect(result.reason).toContain('HTTP 302')
      expect(targetHits).toBe(0)
    } finally {
      await local.close()
    }
  })

  it('intersects header environment allowlists and strips control characters', async () => {
    const previous = process.env.HOOK_HTTP_SECRET
    const executionEnvironment = new ExecutionEnvironment(
      {
        revision: 'a'.repeat(64),
        catalogRevision: 'b'.repeat(64),
        projectFingerprint: 'c'.repeat(64),
        createdAt: '2026-07-11T02:00:00.000Z',
        platform: 'darwin',
        pathEntries: ['/usr/bin'],
        env: { PATH: '/usr/bin' },
        toolPaths: {},
      },
      { HOOK_HTTP_SECRET: 'captured' },
    )
    process.env.HOOK_HTTP_SECRET = 'changed-after-snapshot'
    const local = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          reason: `${req.headers['x-secret'] ?? 'missing'}:${req.headers['x-denied'] ?? 'missing'}:${req.headers['x-injected'] ?? 'clean'}`,
        }),
      )
    })
    try {
      const policy = defaultHooksConfigV2().policy
      policy.http.allowedUrlPatterns = ['http://127.0.0.1:*/*']
      policy.http.allowedEnv = ['HOOK_HTTP_SECRET']
      policy.http.allowLoopback = true
      const executor = await httpExecutor()
      const result = await executor.execute(
        handler(`http://127.0.0.1:${local.port}/headers`, {
          allowedEnv: ['HOOK_HTTP_SECRET'],
          headers: {
            'x-secret': '${HOOK_HTTP_SECRET}\r\nx-injected: bad',
            'x-denied': '${NOT_ALLOWED}',
          },
        }),
        input(),
        context({ policy, executionEnvironment }),
      )

      expect(result.output?.reason).toBe(
        'capturedx-injected: bad:missing:clean',
      )
    } finally {
      if (previous === undefined) delete process.env.HOOK_HTTP_SECRET
      else process.env.HOOK_HTTP_SECRET = previous
      await local.close()
    }
  })

  it('accepts empty 2xx, rejects non-2xx, and bounds response bytes', async () => {
    const local = await server((req, res) => {
      if (req.url === '/empty') {
        res.writeHead(204)
        res.end()
        return
      }
      if (req.url === '/large') {
        res.writeHead(200)
        res.end('x'.repeat(1_000))
        return
      }
      res.writeHead(500)
      res.end('{"decision":"allow"}')
    })
    try {
      const policy = defaultHooksConfigV2().policy
      policy.http.allowedUrlPatterns = ['http://127.0.0.1:*/*']
      policy.http.allowLoopback = true
      policy.http.maxResponseBytes = 64
      const executor = await httpExecutor()
      const empty = await executor.execute(
        handler(`http://127.0.0.1:${local.port}/empty`),
        input(),
        context({ policy }),
      )
      const failed = await executor.execute(
        handler(`http://127.0.0.1:${local.port}/failed`),
        input(),
        context({ policy }),
      )
      const large = await executor.execute(
        handler(`http://127.0.0.1:${local.port}/large`),
        input(),
        context({ policy }),
      )

      expect(empty).toMatchObject({ outcome: 'completed', output: {} })
      expect(failed).toMatchObject({ outcome: 'failed', output: null })
      expect(large).toMatchObject({
        outcome: 'failed',
        output: null,
        stdoutTruncated: true,
      })
      expect(large.stdoutBytes).toBeGreaterThan(64)
    } finally {
      await local.close()
    }
  })

  it('distinguishes HTTP timeout from parent cancellation', async () => {
    const local = await server(() => {})
    try {
      const policy = defaultHooksConfigV2().policy
      policy.http.allowedUrlPatterns = ['http://127.0.0.1:*/*']
      policy.http.allowLoopback = true
      const executor = await httpExecutor()
      const timedOut = await executor.execute(
        handler(`http://127.0.0.1:${local.port}/hang`, { timeoutMs: 20 }),
        input(),
        context({ policy }),
      )
      const controller = new AbortController()
      const running = executor.execute(
        handler(`http://127.0.0.1:${local.port}/hang`, { timeoutMs: 5_000 }),
        input(),
        context({ policy, signal: controller.signal }),
      )
      controller.abort()
      const cancelled = await running

      expect(timedOut.outcome).toBe('timeout')
      expect(cancelled.outcome).toBe('cancelled')
    } finally {
      await local.close()
    }
  })
})
