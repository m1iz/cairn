import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const cwd = resolve(args.cwd ?? '.')
const vitest = resolve(cwd, args.vitest ?? 'node_modules/vitest/vitest.mjs')
const result = spawnSync(process.execPath, [vitest, 'run', '--reporter=json'], {
  cwd,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  windowsHide: true,
})

if (result.error) throw result.error

let report
try {
  report = JSON.parse(result.stdout)
} catch (error) {
  process.stderr.write(result.stderr)
  throw new Error(`Vitest did not produce a JSON report: ${error.message}`)
}

const actual = {
  passed: number(report.numPassedTests),
  failed: number(report.numFailedTests),
  skipped: number(report.numPendingTests),
  runtimeErrors: Math.max(
    number(report.numRuntimeErrorTestSuites),
    countRuntimeErrors(result.stderr),
  ),
}
const limits = {
  minPassed: integer(args['min-passed'], 'min-passed'),
  maxFailed: integer(args['max-failed'], 'max-failed'),
  maxSkipped: integer(args['max-skipped'], 'max-skipped'),
  maxRuntimeErrors: integer(
    args['max-runtime-errors'] ?? '0',
    'max-runtime-errors',
  ),
}

const failures = []
if (actual.passed < limits.minPassed)
  failures.push(`passed ${actual.passed} < ${limits.minPassed}`)
if (actual.failed > limits.maxFailed)
  failures.push(`failed ${actual.failed} > ${limits.maxFailed}`)
if (actual.skipped > limits.maxSkipped)
  failures.push(`skipped ${actual.skipped} > ${limits.maxSkipped}`)
if (actual.runtimeErrors > limits.maxRuntimeErrors)
  failures.push(
    `runtime errors ${actual.runtimeErrors} > ${limits.maxRuntimeErrors}`,
  )

const summary = `Vitest ratchet: ${actual.passed} passed, ${actual.failed} failed, ${actual.skipped} skipped, ${actual.runtimeErrors} runtime errors`
process.stdout.write(`${summary}\n`)

if (failures.length) {
  for (const failure of failures) process.stderr.write(`- ${failure}\n`)
  for (const suite of report.testResults ?? []) {
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status === 'failed')
        process.stderr.write(`FAILED ${suite.name}: ${assertion.fullName}\n`)
    }
  }
  process.exit(1)
}

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined)
      throw new Error(`Invalid argument near '${key ?? ''}'`)
    parsed[key.slice(2)] = value
  }
  return parsed
}

function integer(value, name) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw new Error(`--${name} must be a non-negative integer`)
  return parsed
}

function number(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

function countRuntimeErrors(stderr) {
  return (stderr.match(/Unhandled Rejection|Uncaught Exception/g) ?? []).length
}
