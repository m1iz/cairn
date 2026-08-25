import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateLegacyStateRoot } from './migrate-state-root'
import { ensureRuntimeStateDirs, resolveRuntimePaths } from './paths'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('migrateLegacyStateRoot', () => {
  it('copies legacy memory, sessions, and team state into .cairn once without deleting old data', () => {
    const root = tmp('cairn-legacy-state-')
    const paths = resolveRuntimePaths(root, {
      stateRoot: join(root, '.cairn'),
    })
    mkdirSync(join(root, 'memory'), { recursive: true })
    mkdirSync(join(root, 'sessions', 'legacy-session'), { recursive: true })
    mkdirSync(join(root, '.team'), { recursive: true })
    writeFileSync(
      join(root, 'memory', 'MEMORY.local.md'),
      '# Legacy memory\n',
      'utf8',
    )
    writeFileSync(
      join(root, 'sessions', 'legacy-session', 'history.jsonl'),
      '{"role":"user","content":"old"}\n',
      'utf8',
    )
    writeFileSync(
      join(root, '.team', 'config.json'),
      '{"members":[]}\n',
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    const first = migrateLegacyStateRoot(paths)
    const second = migrateLegacyStateRoot(paths)

    expect(first.copied).toBe(3)
    expect(second.copied).toBe(0)
    expect(
      readFileSync(join(paths.memoryRoot, 'MEMORY.local.md'), 'utf8'),
    ).toContain('Legacy memory')
    expect(
      readFileSync(
        join(paths.sessionsRoot, 'legacy-session', 'history.jsonl'),
        'utf8',
      ),
    ).toContain('old')
    expect(readFileSync(join(paths.teamRoot, 'config.json'), 'utf8')).toContain(
      'members',
    )
    expect(existsSync(join(root, 'memory', 'MEMORY.local.md'))).toBe(true)
    expect(
      existsSync(join(root, 'sessions', 'legacy-session', 'history.jsonl')),
    ).toBe(true)
    expect(existsSync(join(root, '.team', 'config.json'))).toBe(true)
    expect(
      readFileSync(join(paths.stateRoot, 'migration-log.jsonl'), 'utf8')
        .trim()
        .split('\n'),
    ).toHaveLength(3)
    expect(first.reportPath).toBe(
      join(paths.stateRoot, 'migrations', 'state-root-migration.json'),
    )
    const report = JSON.parse(readFileSync(first.reportPath, 'utf8'))
    expect(report).toMatchObject({
      copied: 3,
      skipped: 0,
      logPath: join(paths.stateRoot, 'migration-log.jsonl'),
    })
    expect(report.legacyStateRoots).toEqual(first.legacyStateRoots)
  })

  it('copies ancient bare runtime state for control, scheduler, tasks, external, and tokens', () => {
    const runtimeRoot = tmp('cairn-legacy-bare-runtime-')
    const stateRoot = tmp('cairn-legacy-bare-state-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    mkdirSync(join(runtimeRoot, 'control'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'scheduler'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'tasks'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'external'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'tokens'), { recursive: true })
    writeFileSync(
      join(runtimeRoot, 'control', 'state.json'),
      '{"pending":null}\n',
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, 'scheduler', 'jobs.json'),
      '{"jobs":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, 'tasks', 'index.json'),
      '{"tasks":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, 'external', 'inbound.json'),
      '{"queue":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, 'tokens', 'tokens.jsonl'),
      '{"model":"x"}\n',
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(result.copied).toBe(4)
    expect(
      readFileSync(join(paths.controlRoot, 'state.json'), 'utf8'),
    ).toContain('pending')
    expect(
      readFileSync(join(paths.schedulerRoot, 'jobs.json'), 'utf8'),
    ).toContain('jobs')
    expect(readFileSync(join(paths.tasksRoot, 'index.json'), 'utf8')).toContain(
      'tasks',
    )
    expect(existsSync(join(stateRoot, 'external', 'inbound.json'))).toBe(false)
    expect(existsSync(join(runtimeRoot, 'external', 'inbound.json'))).toBe(true)
    expect(
      readFileSync(join(stateRoot, 'tokens', 'tokens.jsonl'), 'utf8'),
    ).toContain('model')
    expect(existsSync(join(runtimeRoot, 'control', 'state.json'))).toBe(true)
  })

  it('copies supported memory-scoped state while leaving retired bridge data untouched', () => {
    const runtimeRoot = tmp('cairn-legacy-memory-subdirs-runtime-')
    const stateRoot = tmp('cairn-legacy-memory-subdirs-state-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    const previous = join(runtimeRoot, '.cairn')
    mkdirSync(join(previous, 'memory', 'control'), { recursive: true })
    mkdirSync(join(previous, 'memory', 'scheduler'), { recursive: true })
    mkdirSync(join(previous, 'memory', 'tasks', 'task_1'), { recursive: true })
    mkdirSync(join(previous, 'memory', 'external'), { recursive: true })
    writeFileSync(
      join(previous, 'memory', 'control', 'state.json'),
      '{"pending":{"id":"ask_1"}}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'memory', 'scheduler', 'jobs.json'),
      '{"jobs":[{"id":"job_1"}]}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'memory', 'tasks', 'index.json'),
      '{"task_1":{"id":"task_1"}}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'memory', 'tasks', 'task_1', 'transcript.jsonl'),
      '{"task_id":"task_1"}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'memory', 'external', 'state.json'),
      '{"outbox":[]}\n',
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(
      readFileSync(join(paths.controlRoot, 'state.json'), 'utf8'),
    ).toContain('ask_1')
    expect(
      readFileSync(join(paths.schedulerRoot, 'jobs.json'), 'utf8'),
    ).toContain('job_1')
    expect(readFileSync(join(paths.tasksRoot, 'index.json'), 'utf8')).toContain(
      'task_1',
    )
    expect(
      readFileSync(join(paths.tasksRoot, 'task_1', 'transcript.jsonl'), 'utf8'),
    ).toContain('task_1')
    expect(result.entries.map((entry) => entry.legacy)).toEqual(
      expect.arrayContaining([
        'memory-control',
        'memory-scheduler',
        'memory-tasks',
      ]),
    )
    expect(existsSync(join(stateRoot, 'memory', 'control', 'state.json'))).toBe(
      false,
    )
    expect(
      existsSync(join(stateRoot, 'memory', 'scheduler', 'jobs.json')),
    ).toBe(false)
    expect(existsSync(join(stateRoot, 'memory', 'tasks', 'index.json'))).toBe(
      false,
    )
    expect(
      existsSync(join(stateRoot, 'memory', 'external', 'state.json')),
    ).toBe(false)
    expect(existsSync(join(previous, 'memory', 'external', 'state.json'))).toBe(
      true,
    )
    expect(existsSync(join(previous, 'memory', 'control', 'state.json'))).toBe(
      true,
    )
  })

  it('copies legacy top-level config files into stateRoot without overwriting existing config', () => {
    const runtimeRoot = tmp('cairn-legacy-config-runtime-')
    const stateRoot = tmp('cairn-legacy-config-state-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    writeFileSync(
      join(runtimeRoot, 'model_config.json'),
      '{"models":[{"name":"legacy"}]}\n',
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, 'mcp_config.json'),
      '{"servers":{}}\n',
      'utf8',
    )
    writeFileSync(
      join(runtimeRoot, 'cairn.local.json'),
      '{"prompt":{"profile":"classic"}}\n',
      'utf8',
    )
    mkdirSync(stateRoot, { recursive: true })
    writeFileSync(
      join(stateRoot, 'mcp_config.json'),
      '{"servers":{"kept":{}}}\n',
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(
      readFileSync(join(stateRoot, 'model_config.json'), 'utf8'),
    ).toContain('legacy')
    expect(readFileSync(join(stateRoot, 'cairn.local.json'), 'utf8')).toContain(
      'classic',
    )
    expect(readFileSync(join(stateRoot, 'mcp_config.json'), 'utf8')).toContain(
      'kept',
    )
    expect(existsSync(join(runtimeRoot, 'model_config.json'))).toBe(true)
    expect(
      result.entries.filter((entry) => entry.legacy === 'config'),
    ).toHaveLength(2)
  })

  it('skips corrupt legacy json indexes and records the reason', () => {
    const root = tmp('cairn-legacy-state-corrupt-')
    const paths = resolveRuntimePaths(root, {
      stateRoot: join(root, '.cairn'),
    })
    mkdirSync(join(root, 'sessions'), { recursive: true })
    writeFileSync(join(root, 'sessions', 'index.json'), '{bad json\n', 'utf8')

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(result.skipped).toBe(1)
    expect(existsSync(join(paths.sessionsRoot, 'index.json'))).toBe(false)
    const log = readFileSync(
      join(paths.stateRoot, 'migration-log.jsonl'),
      'utf8',
    )
    expect(log).toContain('skipped_corrupt_json')
    expect(log).toContain('sessions/index.json')
  })

  it('migrates supported previous state while leaving retired bridge files in place', () => {
    const runtimeRoot = tmp('cairn-legacy-dotcairn-runtime-')
    const stateRoot = tmp('cairn-legacy-dotcairn-newstate-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    const previous = join(runtimeRoot, '.cairn')

    mkdirSync(join(previous, 'memory'), { recursive: true })
    mkdirSync(join(previous, 'sessions', 's1'), { recursive: true })
    mkdirSync(join(previous, 'control'), { recursive: true })
    mkdirSync(join(previous, 'scheduler'), { recursive: true })
    mkdirSync(join(previous, 'tasks'), { recursive: true })
    mkdirSync(join(previous, 'external'), { recursive: true })
    mkdirSync(join(previous, 'tokens'), { recursive: true })
    writeFileSync(
      join(previous, 'memory', 'MEMORY.local.md'),
      '# Previous default memory\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'sessions', 's1', 'history.jsonl'),
      '{"role":"user","content":"prev"}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'control', 'state.json'),
      '{"pending":null}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'scheduler', 'jobs.json'),
      '{"jobs":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'tasks', 'index.json'),
      '{"tasks":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'external', 'inbound.json'),
      '{"queue":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'external_config.json'),
      '{"enabled":true}\n',
      'utf8',
    )
    writeFileSync(
      join(previous, 'tokens', 'tokens.jsonl'),
      '{"model":"x"}\n',
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(
      readFileSync(join(stateRoot, 'memory', 'MEMORY.local.md'), 'utf8'),
    ).toContain('Previous default memory')
    expect(
      readFileSync(join(stateRoot, 'sessions', 's1', 'history.jsonl'), 'utf8'),
    ).toContain('prev')
    expect(
      readFileSync(join(stateRoot, 'control', 'state.json'), 'utf8'),
    ).toContain('pending')
    expect(
      readFileSync(join(stateRoot, 'scheduler', 'jobs.json'), 'utf8'),
    ).toContain('jobs')
    expect(
      readFileSync(join(stateRoot, 'tasks', 'index.json'), 'utf8'),
    ).toContain('tasks')
    expect(existsSync(join(stateRoot, 'external', 'inbound.json'))).toBe(false)
    expect(existsSync(join(previous, 'external', 'inbound.json'))).toBe(true)
    expect(existsSync(join(stateRoot, 'external_config.json'))).toBe(false)
    expect(existsSync(join(previous, 'external_config.json'))).toBe(true)
    expect(
      readFileSync(join(stateRoot, 'tokens', 'tokens.jsonl'), 'utf8'),
    ).toContain('model')
    // Old data is never deleted.
    expect(existsSync(join(previous, 'memory', 'MEMORY.local.md'))).toBe(true)
    expect(existsSync(join(previous, 'control', 'state.json'))).toBe(true)

    const cairnEntries = result.entries.filter(
      (entry) => entry.legacy === 'cairn-state-root',
    )
    expect(cairnEntries.length).toBeGreaterThanOrEqual(6)

    // Re-running does not re-copy or duplicate log entries.
    const second = migrateLegacyStateRoot(paths)
    expect(
      second.entries.filter((entry) => entry.legacy === 'cairn-state-root'),
    ).toHaveLength(0)
  })

  it('moves USER.local.md from the previous templates/ path to the new memory/profile/ path, without a straight tree copy landing a stale duplicate', () => {
    const runtimeRoot = tmp('cairn-legacy-userprofile-runtime-')
    const stateRoot = tmp('cairn-legacy-userprofile-newstate-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    const previous = join(runtimeRoot, '.cairn')
    mkdirSync(join(previous, 'templates'), { recursive: true })
    writeFileSync(
      join(previous, 'templates', 'USER.local.md'),
      '# customized profile\n',
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    migrateLegacyStateRoot(paths)

    expect(
      readFileSync(
        join(stateRoot, 'memory', 'profile', 'USER.local.md'),
        'utf8',
      ),
    ).toContain('customized profile')
    // The old relative path (templates/USER.local.md) must not also get a stale copy under
    // the new stateRoot — copyTree excludes `templates/` precisely to avoid this duplicate.
    expect(existsSync(join(stateRoot, 'templates', 'USER.local.md'))).toBe(
      false,
    )
    // Old data is never deleted.
    expect(existsSync(join(previous, 'templates', 'USER.local.md'))).toBe(true)
  })

  it('reports which legacy state roots were detected, whether or not they had anything to copy', () => {
    const runtimeRoot = tmp('cairn-legacy-detect-runtime-')
    const stateRoot = tmp('cairn-legacy-detect-newstate-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    mkdirSync(join(runtimeRoot, '.cairn'), { recursive: true })
    // No ancient bare-runtimeRoot memory/sessions/.team dirs exist in this fixture.

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    const byPath = new Map(
      result.legacyStateRoots.map((entry) => [entry.path, entry]),
    )
    expect(byPath.get(join(runtimeRoot, 'memory'))).toMatchObject({
      kind: 'ancient-bare-runtime-root',
      existed: false,
    })
    expect(byPath.get(join(runtimeRoot, '.cairn'))).toMatchObject({
      kind: 'previous-dotcairn-root',
      existed: true,
    })
  })

  it('skips and records legacy state symlinks without reading outside runtimeRoot', () => {
    const runtimeRoot = tmp('cairn-legacy-symlink-runtime-')
    const stateRoot = tmp('cairn-legacy-symlink-state-')
    const outside = tmp('cairn-legacy-symlink-outside-')
    const paths = resolveRuntimePaths(runtimeRoot, { stateRoot })
    mkdirSync(join(runtimeRoot, 'memory'), { recursive: true })
    writeFileSync(join(outside, 'secret.txt'), 'outside secret', 'utf8')
    symlinkSync(
      outside,
      join(runtimeRoot, 'memory', 'outside-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    if (process.platform !== 'win32') {
      writeFileSync(join(outside, 'model.json'), '{"secret":true}\n', 'utf8')
      symlinkSync(
        join(outside, 'secret.txt'),
        join(runtimeRoot, 'memory', 'secret-link.txt'),
        'file',
      )
      symlinkSync(
        join(runtimeRoot, 'memory'),
        join(runtimeRoot, 'memory', 'cycle'),
        'dir',
      )
      symlinkSync(
        join(outside, 'model.json'),
        join(runtimeRoot, 'model_config.json'),
        'file',
      )
    }

    ensureRuntimeStateDirs(paths)
    const result = migrateLegacyStateRoot(paths)

    expect(existsSync(join(stateRoot, 'memory', 'outside-link'))).toBe(false)
    expect(existsSync(join(stateRoot, 'memory', 'secret-link.txt'))).toBe(false)
    expect(existsSync(join(stateRoot, 'model_config.json'))).toBe(false)
    expect(result.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'skipped_unsafe_path',
          source: join(runtimeRoot, 'memory', 'outside-link'),
        }),
        ...(process.platform === 'win32'
          ? []
          : [
              expect.objectContaining({
                action: 'skipped_unsafe_path',
                source: join(runtimeRoot, 'memory', 'cycle'),
              }),
              expect.objectContaining({
                action: 'skipped_unsafe_path',
                source: join(runtimeRoot, 'memory', 'secret-link.txt'),
              }),
              expect.objectContaining({
                action: 'skipped_unsafe_path',
                source: join(runtimeRoot, 'model_config.json'),
              }),
            ]),
      ]),
    )
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe(
      'outside secret',
    )
    expect(JSON.parse(readFileSync(result.reportPath, 'utf8'))).toMatchObject({
      skipped: expect.any(Number),
    })
    expect(
      Number(JSON.parse(readFileSync(result.reportPath, 'utf8')).skipped),
    ).toBeGreaterThanOrEqual(1)
  })

  it('copies the previous product state once, preserves its backup, and skips retired desktop state', () => {
    const runtimeRoot = tmp('cairn-runtime-')
    const stateRoot = tmp('cairn-state-')
    const previousRoot = tmp('cairn-previous-product-')
    const paths = {
      ...resolveRuntimePaths(runtimeRoot, { stateRoot }),
      stateRootSource: 'default' as const,
    }
    const retiredDir = `desktop_${String.fromCharCode(112, 101, 116)}`
    const retiredKey = String.fromCharCode(
      100,
      101,
      115,
      107,
      116,
      111,
      112,
      80,
      101,
      116,
    )
    const previousConfigName = String.fromCharCode(
      101,
      109,
      112,
      101,
      114,
      111,
      114,
      46,
      108,
      111,
      99,
      97,
      108,
      46,
      106,
      115,
      111,
      110,
    )

    mkdirSync(join(previousRoot, 'memory', retiredDir), { recursive: true })
    mkdirSync(join(previousRoot, 'sessions', 'session_1'), { recursive: true })
    writeFileSync(
      join(previousRoot, 'memory', 'MEMORY.local.md'),
      '# Existing memory\n',
      'utf8',
    )
    writeFileSync(
      join(previousRoot, 'memory', retiredDir, 'state.json'),
      '{"running":true}\n',
      'utf8',
    )
    writeFileSync(
      join(previousRoot, 'sessions', 'session_1', 'history.jsonl'),
      '{"role":"user","content":"keep"}\n',
      'utf8',
    )
    mkdirSync(join(previousRoot, 'goals'), { recursive: true })
    const previousSchemaPrefix = String.fromCharCode(
      101,
      109,
      112,
      101,
      114,
      111,
      114,
    )
    const previousProductName = `${previousSchemaPrefix} Agent`
    writeFileSync(
      join(previousRoot, 'memory', 'MEMORY.local.md'),
      `# ${previousProductName}\n`,
      'utf8',
    )
    writeFileSync(
      join(previousRoot, 'goals', 'index.json'),
      JSON.stringify({
        schemaVersion: `${previousSchemaPrefix}.goal.index.v1`,
        goals: [],
      }),
      'utf8',
    )
    writeFileSync(
      join(previousRoot, 'model_config.json'),
      '{"schemaVersion":2,"models":[]}\n',
      'utf8',
    )
    writeFileSync(
      join(previousRoot, previousConfigName),
      JSON.stringify({ prompt: { profile: 'technical' }, [retiredKey]: {} }),
      'utf8',
    )

    ensureRuntimeStateDirs(paths)
    const first = migrateLegacyStateRoot(paths, {
      previousProductStateRoot: previousRoot,
    })
    const second = migrateLegacyStateRoot(paths, {
      previousProductStateRoot: previousRoot,
    })

    expect(first.copied).toBe(5)
    expect(second.copied).toBe(0)
    expect(
      readFileSync(join(stateRoot, 'model_config.json'), 'utf8'),
    ).toContain('schemaVersion')
    expect(
      readFileSync(
        join(stateRoot, 'sessions', 'session_1', 'history.jsonl'),
        'utf8',
      ),
    ).toContain('keep')
    expect(
      JSON.parse(readFileSync(join(stateRoot, 'goals', 'index.json'), 'utf8'))
        .schemaVersion,
    ).toBe('cairn.goal.index.v1')
    expect(
      readFileSync(join(stateRoot, 'memory', 'MEMORY.local.md'), 'utf8'),
    ).toBe('# Cairn Agent\n')
    expect(existsSync(join(stateRoot, 'memory', retiredDir))).toBe(false)
    const migratedConfig = JSON.parse(
      readFileSync(join(stateRoot, 'cairn.local.json'), 'utf8'),
    )
    expect(migratedConfig.prompt).toEqual({ profile: 'technical' })
    expect(migratedConfig).not.toHaveProperty(retiredKey)
    expect(existsSync(join(previousRoot, 'model_config.json'))).toBe(true)
  })
})
