export class CoreMutationGuardError extends Error {
  readonly status: 403 | 409

  constructor(status: 403 | 409, message: string) {
    super(message)
    this.name = 'CoreMutationGuardError'
    this.status = status
  }
}

export function assertCoreMutationAllowed(
  control: Record<string, unknown>,
  opts: { area: string; action: string },
): void {
  const pending = isRecord(control.pending) ? control.pending : null
  if (pending) {
    throw new CoreMutationGuardError(
      409,
      `Cannot ${opts.action} ${opts.area} while Ask / Plan is pending; answer, approve or cancel the pending interaction first.`,
    )
  }
  if (String(control.mode || '') === 'plan') {
    throw new CoreMutationGuardError(
      403,
      `Cannot ${opts.action} ${opts.area} in plan mode; approve or leave Plan mode before executing mutations.`,
    )
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
