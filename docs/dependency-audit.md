# Dependency audit policy

Production auditing remains blocking at high severity. Development auditing retains the complete npm JSON report in the job log and rejects unreviewed findings, invalid reports and process failures. It does not turn off auditing or globally raise the severity threshold.

## Temporary development exceptions

The exceptions in `scripts/audit-policy.mjs` expire at **2026-12-10 00:00 UTC**. They bind the complete parsed lockfile SHA-256, exact affected leaf versions and installed paths, development-only classification, moderate severity, and these advisory URLs:

| Advisory                                                                 | Reviewed copies                         | Impact                                                                               |
| ------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------ |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) | npm-bundled glob 13.0.6                 | Aborted directory walks may continue consuming I/O and CPU.                          |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | minimatch 10.2.6 and npm-bundled 10.2.5 | Attacker-controlled patterns can amplify CPU/memory use with optimizationLevel >= 2. |

Affected parent findings are accepted only when every reported cause recursively resolves to these reviewed advisories. Unknown causes, changed paths or lock inputs, elevated severity, production classification and expiry fail closed. A clean report needs no exception. Do not update the lock fingerprint mechanically: reassess dependency changes first, including host and installer behavior.

## Exposure assessment

The plugin does not accept glob patterns or directly import glob, minimatch or npm. Its nonlocal runtime imports are the OpenClaw tool-plugin SDK and typebox. TypeScript compilation does not bundle dependencies; the archive verifier requires an exact file list without node_modules and an empty npm bundled list.

Published packages for the pinned SDK and lint tooling were checked against their lockfile SHA-512 integrity. The reviewed minimatch implementation defaults to optimization level 1. The checked ESLint/config-array/typescript-estree code does not set optimizationLevel. Direct minimatch calls found in OpenClaw 2026.10.5 use default options or explicit level 0. This does not establish that every indirect npm call is unreachable: npm's bundled glob can still process filesystem patterns during tooling operations.

Build and installation therefore remain bounded, isolated jobs using reviewed source/configuration and the initiating pinned npm CLI. Do not expose these development commands as services accepting untrusted patterns or reuse a failed worker as a successful candidate. The exceptions address availability findings; they do not authorize executing untrusted package lifecycle code with release credentials.

OpenClaw is also an external peer host. Repository dev flags and a zero production audit do **not** audit that host. Static literal-import inspection is limited and does not prove computed imports, external package internals or every supported host version safe. Before release, verify the final archive and the real host/plugin installation graph; confirm the plugin does not introduce an unexpected SDK/npm copy. A different host or dependency graph requires renewed assessment.

All source, native process-ownership, deterministic packaging and exact Core/Gateway acceptance gates still apply. The audit exception alone never authorizes publication. Remove each exception after supported parent repairs and retain the original audit evidence.
