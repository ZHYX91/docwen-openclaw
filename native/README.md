# Native platform helpers

The package contains three small, platform-specific helpers with checked-in source
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
suspended with `PROC_THREAD_ATTRIBUTE_JOB_LIST`, so job membership is atomic
with creation, and only then resumes it. Windows 10 or newer is required.
A failed attribute setup or creation fails closed without a legacy assignment fallback. This gives
the plugin owned-tree cleanup that remains valid after the direct DocWen process
exits, without process-name scans or stale-PID termination.

The controller inherits the Machine stdio handles only long enough to pass them
to DocWen. Before resuming DocWen, it closes its own stdin handle so a DocWen peer that closes its
read side still produces a real broken-pipe condition in the Node parent.
After the direct DocWen process exits, the controller terminates any remaining
job members before releasing its stdout/stderr handles. Killing the controller
also closes its last job handle and therefore terminates the owned job.

`windows-job.c`, `windows-job.def`, and `WINDOWS-BUILD.json` record the
source, imported Win32 API surface, toolchain, deterministic timestamp, and
SHA-256 values for the checked-in executable. In an x64 MSVC developer prompt,
run `node scripts/build-native-windows.mjs /absolute/owned/build-directory`.
The recorded MSVC build uses no CRT and deterministic linking, then zeros the
PE COFF timestamp. Two independent builds produced identical bytes. Replace the
source, definition, executable, and provenance together when rebuilding.

## Linux Machine process ownership

`linux-owner-x64` keeps signal authority inside a native lifetime owner. A
subreaper outside the owned group is the sole parent of its group leader.
That leader remains alive, or an unreaped child, until the parent's last
group signal. Only then does the parent reap it and permanently stop sending
numeric signals. Node retains a control channel and completion promise, not
a process-group number that could identify a later unrelated process.

The group leader starts the configured executable after both supervisors
release all business stdio descriptors. This preserves real stdin EPIPE and
the direct executable's normal exit status. A lost Node control channel
triggers cleanup. If the outer supervisor dies, the group leader's parent-death
signal kills its own group. If the leader dies first, its unreaped identity
still pins the group until the outer supervisor's final signal.

The package stores the ELF as ordinary data. On Linux x64 the launcher verifies
its SHA-256, creates a private executable copy, waits for native readiness,
and removes the copy and directory before permitting any Machine process to
start. A missing, altered, non-executable or unremovable image fails closed.
There is no install script, runtime compiler or package-directory chmod.
Rebuild with `node scripts/build-native-linux-owner.mjs /absolute/owned/build-directory`;
update the source, binary, `LINUX-OWNER-BUILD.json` and runtime digest together.

The native owner allows two seconds to reap after its final signal. An owner
crash, control failure or incomplete reap is reported as unconfirmed cleanup.
This is not a sandbox: deliberate group escape, simultaneous destruction of
both supervisors and uninterruptible kernel tasks are outside its guarantee.
Controlled Linux tests cover normal exit, real EPIPE, each supervisor's
separate crash, descendant exit and survival of an unrelated sentinel.

The Windows source tests compile a small controlled Win32 pipe peer using the
installed MSVC build tools (also present on the Windows CI runner). This peer
closes the actual inherited read handle before replying, so query, task, and
cancel tests exercise a real broken pipe. It is never included in the package.

These helpers are packaging/runtime implementation details. The controlled
process tests that exercise them are not substitutes for real DocWen, OpenClaw
Gateway, LLM, or release-candidate acceptance.
