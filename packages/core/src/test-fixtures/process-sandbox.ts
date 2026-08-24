import { NodeOwnedProcessRunner } from '../environment/process-runner'
import type { ProcessContainmentController } from '../environment/sandbox'

export function passThroughProcessSandbox(): ProcessContainmentController {
  return {
    capability: () => ({
      platform: process.platform,
      backend: 'macos-seatbelt',
      status: 'available',
      filesystem: 'workspace-write',
      network: 'policy-controlled',
      processTree: true,
      reason: 'test-only pass-through containment fixture',
    }),
    prepare: (executable, args, policy) => ({
      executable,
      args: [...args],
      receipt: {
        decision: 'sandboxed',
        backend: 'macos-seatbelt',
        capabilityStatus: 'available',
        filesystem: 'workspace-write',
        network: policy.network === 'deny' ? 'denied' : 'allowed',
        processTree: true,
        policyHash: 'c'.repeat(64),
        reason: 'test-only pass-through containment fixture',
      },
    }),
  }
}

export function passThroughOwnedProcessRunner(): NodeOwnedProcessRunner {
  return new NodeOwnedProcessRunner({ sandbox: passThroughProcessSandbox() })
}
