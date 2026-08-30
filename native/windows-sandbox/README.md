# Cairn Windows sandbox helper

This Windows-only helper launches a command through the operating system's
AppContainer process sandbox API. Cairn treats the backend as available only
after `--self-test` proves workspace writes, outside-path denial, descendant
containment, and loopback-network denial on the current host.

The helper keeps every launched process in a kill-on-close Job Object. It is a
small execution boundary rather than a second command runner: timeout, output
quota, cancellation, ownership, and durable receipts remain in `@cairn/core`.

The SandboxSpec wire layout follows Microsoft's public MXC schema (MIT):
`external/windows-sdk/BaseContainerSpecification.fbs`.

