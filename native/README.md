# Native platform helpers

The package contains two small, platform-specific helpers with checked-in source
and provenance. Neither helper downloads code, shells out at runtime, performs
an executable-name search, or requires a runtime compiler or FFI dependency.

## Linux directory publication

`linux-x64.node` exposes one Node-API 8 function: Linux `renameat2` with
`RENAME_NOREPLACE`. It returns the syscall errno and never falls back to a
check followed by an ordinary rename. Windows uses native directory rename
semantics instead. Files use Node's exclusive hard-link operation on both
platforms.

To rebuild on Linux x64, use the pinned Node distribution (including its
`include/node` headers), a C compiler, and an existing owned output directory:

```sh
node scripts/build-native.mjs /absolute/owned/build-directory
```

Review the generated build record, test the result on Linux, then replace
`linux-x64.node` and `BUILD.json` together.

## Windows Machine process ownership

`windows-x64.exe` is a minimal x64 controller used only for the supported
Windows host. It creates a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, creates the configured DocWen binary
suspended, assigns that process to the job, and only then resumes it. This gives
the plugin owned-tree cleanup that remains valid after the direct DocWen process
exits, without process-name scans or stale-PID termination.

The controller inherits the Machine stdio handles only long enough to pass them
to DocWen. It then closes its own stdin handle so a DocWen peer that closes its
read side still produces a real broken-pipe condition in the Node parent.
After the direct DocWen process exits, the controller terminates any remaining
job members before releasing its stdout/stderr handles. Killing the controller
also closes its last job handle and therefore terminates the owned job.

`windows-job.c`, `windows-job.def`, and `WINDOWS-BUILD.json` record the
source, imported Win32 API surface, toolchain, deterministic timestamp, and
SHA-256 values for the checked-in executable. The recorded build used Clang/LLD
17 targeting x86-64 Windows with no CRT and `/timestamp:0`; two independent
builds from the recorded source produced identical bytes. Replace the source,
definition, executable, and provenance together when rebuilding.

These helpers are packaging/runtime implementation details. The controlled
process tests that exercise them are not substitutes for real DocWen, OpenClaw
Gateway, LLM, or release-candidate acceptance.
