# Linux directory publication

`linux-x64.node` exposes one Node-API 8 function: Linux `renameat2` with
`RENAME_NOREPLACE`. It returns the syscall errno and never falls back to a
check followed by an ordinary rename. The shipped Linux Core is x64; Windows
uses its native directory rename semantics and does not load this component.
Files use Node's exclusive hard-link operation on both platforms.

This component adds no runtime compiler, shell, executable search, download, or
FFI dependency. An unsupported filesystem reports its error before a new
directory is committed. Node-API keeps the binary independent of V8's ABI.

To rebuild on Linux x64, use the pinned Node distribution (including its
`include/node` headers), a C compiler, and an existing owned output directory:

```sh
node scripts/build-native.mjs /absolute/owned/build-directory
```

Review `build.json`, test the result on Linux, then replace the checked-in
binary and update `BUILD.json` together. The package includes the binary; the
C source, build script and provenance stay in the repository. Checks compare
the recorded source and binary digests to prevent an accidental stale pair.
