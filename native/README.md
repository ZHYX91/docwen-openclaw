# Native platform helpers

The package contains three small, platform-specific helpers with checked-in source
and provenance. These helpers do not download code, shell out at runtime, perform
an executable-name search, or require a runtime compiler or FFI dependency.

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

The Windows source tests compile a small controlled Win32 pipe peer using the
installed MSVC build tools (also present on the Windows CI runner). This peer
closes the actual inherited read handle before replying, so query, task, and
cancel tests exercise a real broken pipe. It is never included in the package.

## Linux Machine process ownership

`linux-owner-x64` keeps signal authority inside two native subreapers outside
the business session. The inner supervisor starts the configured executable
in its own session. Either surviving supervisor adopts orphaned descendants,
including children that call `setsid()` or double-fork. Node retains a control
channel and completion promise, never reusable numeric signal authority.

The group leader starts the configured executable after both supervisors
release all business stdio descriptors. This preserves real stdin EPIPE and
the direct executable's normal exit status. A lost Node control channel
triggers cleanup. If the outer supervisor dies, a parent-death notification
starts the inner supervisor's cleanup. If the inner supervisor dies, the outer
subreaper adopts its descendants and performs the same cleanup.

Cleanup enumerates only the supervisor's own direct-child candidates, confirms
kernel wait-parenthood without reaping, then signals through a pidfd. It never
signals an unrelated process based on a name or a historical PID/start-time
snapshot. Repeated adoption, termination and reaping end only when `waitpid`
reports `ECHILD`; an empty procfs candidate listing is not completion. The
supported kernel must provide pidfds and mounted procfs; failure remains
unconfirmed rather than falling back to unowned numeric signals.

The package stores the ELF as ordinary data. On Linux x64 the launcher verifies
its SHA-256, creates a private executable copy, waits for native readiness,
and removes the copy and directory before permitting any Machine process to
start. A missing, altered, non-executable or unremovable image fails closed.
There is no install script, runtime compiler or package-directory chmod.
Rebuild with `node scripts/build-native-linux-owner.mjs /absolute/owned/build-directory`;
update the source, binary, `LINUX-OWNER-BUILD.json` and runtime digest together.

The native owner allows two seconds for termination and reaping. An owner
crash, control failure or incomplete reap is reported as unconfirmed cleanup.
This is not a sandbox: simultaneous destruction of both supervisors and
uninterruptible kernel tasks are outside its guarantee.
Controlled Linux tests cover normal exit, real EPIPE, each supervisor's
separate crash, descendant exit and survival of an unrelated sentinel.
`node scripts/check-linux-owner-topology.mjs /absolute/owned/build-directory/linux-owner-x64 /absolute/owned/diagnostics` exercises cross-session children,
double-fork, root exit/crash and both supervisor crashes with real Linux
process states and heartbeats. CI rebuilds the payload twice and compares both
results with the checked-in ELF before running these cases. Metadata and owner-close
waits each retain a six-second deadline. Normal exit and root-crash peers wait for
an explicit release after the live baseline has been persisted; owned heartbeats
and unrelated sentinels do not self-expire. Double-fork metadata becomes visible
only after closing the complete file and atomically renaming it in the same directory.
Per-case JSON and the exact generated peer source retain stage snapshots, bounded
stdout/stderr/control, exit events, PID lifetimes/states, metadata/heartbeat bytes
and original/cleanup errors. CI uploads these diagnostics even on failure.

These helpers are packaging/runtime implementation details. The controlled
process tests that exercise them are not substitutes for real DocWen, OpenClaw
Gateway, LLM, or release-candidate acceptance.

## Statically linked musl notices

The lifetime owner is built with Ubuntu 24.04 `musl-tools` using `-static`. It has
no dynamic interpreter, libc dependency or GLIBC symbol-version floor. Runtime
requirements remain Linux x64, procfs and pidfd support; no runtime compiler is used.
The build receipt records the musl package version, libc archive hash and notice hash.
The following upstream notices accompany the statically linked library.

```text
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: musl
Source: https://musl.libc.org/releases/

Files: *
Copyright: 2005-2020 Rich Felker <dalias@aerifal.cx>
           2005-2020 Many other contributors
License: MIT

Files: debian/*
Copyright: 2013-2015 Kevin Bortis <pkgs@bortis.ch>
           2016-2023 Reiner Herrmann <reiner@reiner-h.de>
License: MIT

Files: arch/mips64/*
       src/*/mips64/*
Copyright: 2016 Mahesh Bodapati
           2016 Jaydeep Patil
           2016 Imagination Technologies
License: MIT

Files: arch/riscv64/*
       src/*/riscv64/*
Copyright: Alex Suykov <alex.suykov@gmail.com>
           Aric Belsito <lluixhi@gmail.com>
           Drew DeVault <sir@cmpwn.com>
           Michael Clark <mjc@sifive.com>
           Michael Forney <mforney@mforney.org>
           Stefan O'Rear <sorear2@gmail.com>
           Rich Felker <dalias@aerifal.cx>
License: MIT

Files: include/*
       arch/*/bits/*
       arch/*/crt_arch.h
       crt/*
       ldso/dlstart.c
Copyright: 2005-2014 Rich Felker <dalias@aerifal.cx>
License: public-domain
 In addition, permission is hereby granted for all public header files
 (include/* and arch/*/bits/*) and crt files intended to be linked into
 applications (crt/*, ldso/dlstart.c, and arch/*/crt_arch.h) to omit
 the copyright notice and permission notice otherwise required by the
 license, and to use these files without any requirement of
 attribution. These files include substantial contributions from:
 .
 Bobby Bingham
 John Spencer
 Nicholas J. Kain
 Rich Felker
 Richard Pennington
 Stefan Kristiansson
 Szabolcs Nagy
 .
 all of whom have explicitly granted such permission.

Files: src/regex/reg*
       src/regex/tre*
Copyright: 2001-2008 Ville Laurikari <vl@iki.fi>
           2012 Rich Felker <dalias@aerifal.cx>
License: BSD-2-clause

Files: src/math/tgammal.c
       src/math/lgammal.c
       src/math/powl.c
       src/math/logl.c
       src/math/log2l.c
       src/math/log1pl.c
       src/math/log10l.c
       src/math/erfl.c
       src/math/expm1l.c
       src/math/expl.c
       src/math/__polevll.c
Copyright: 2008 Stephen L. Moshier <steve@moshier.net>
           1993 Sun Microsystems, Inc.
License: ISC

Files: src/math/fmal.c
       src/math/fmaf.c
       src/math/fma.c
       src/math/exp2l.c
Copyright: 2005-2011 David Schultz <das@freebsd.org>
           1993 Sun Microsystems, Inc.
License: BSD-2-clause

Files: src/math/tanf.c
       src/math/tan.c
       src/math/sinf.c
       src/math/sincosf.c
       src/math/sincos.c
       src/math/sin.c
       src/math/scalbf.c
       src/math/scalb.c
       src/math/log1pf.c
       src/math/log1p.c
       src/math/log10f.c
       src/math/log10.c
       src/math/lgammaf_r.c
       src/math/lgamma_r.c
       src/math/j*.c
       src/math/expm1f.c
       src/math/expm1.c
       src/math/erf.c
       src/math/erff.c
       src/math/cosf.c
       src/math/cos.c
       src/math/cbrt*.c
       src/math/atanl.c
       src/math/atanf.c
       src/math/atan2*.c
       src/math/atan.c
       src/math/asinl.c
       src/math/asinf.c
       src/math/asin.c
       src/math/acosl.c
       src/math/acosf.c
       src/math/acos.c
       src/math/__tan*.c
       src/math/__sin*.c
       src/math/__rem*.c
       src/math/__cos*.c
Copyright: 1993, 2004 Sun Microsystems, Inc.
           2008, 2009-2011 Bruce D. Evans
           2008, 2009-2011 Steven G. Kargl
           2008, 2009-2011 David Schultz
License: permissive
 Developed at SunPro, a Sun Microsystems, Inc. business.
 Permission to use, copy, modify, and distribute this
 software is freely granted, provided that this notice
 is preserved.

Files: src/math/logf.c
       src/math/logf_data.*
       src/math/log2.c
       src/math/log2_data.*
       src/math/log2f.c
       src/math/log2f_data.*
       src/math/log.c
       src/math/log_data.*
       src/math/exp.c
       src/math/exp_data.*
       src/math/exp2.c
       src/math/expf.c
       src/math/exp2f.c
       src/math/exp2f_data.*
       src/math/pow.c
       src/math/pow_data.c
       src/math/powf.c
       src/math/powf_data.*
       src/string/aarch64/*
Copyright: 2012-2018 Arm Limited.
License: MIT

Files: src/crypt/crypt_blowfish.c
Copyright: 1998-2014 Solar Designer <solar@openwall.com>
           2012 Rich Felker <dalias@aerifal.cx>
License: public-domain
 Written by Solar Designer <solar at openwall.com> in 1998-2012.
 No copyright is claimed, and the software is hereby placed in the public
 domain.  In case this attempt to disclaim copyright and place the software
 in the public domain is deemed null and void, then the software is
 Copyright (c) 1998-2012 Solar Designer and it is hereby released to the
 general public under the following terms:
 .
 Redistribution and use in source and binary forms, with or without
 modification, are permitted.
 .
 There's ABSOLUTELY NO WARRANTY, express or implied.
 .
 It is my intent that you should be able to use this on your system,
 as part of a software package, or anywhere else to improve security,
 ensure compatibility, or for any other purpose.  I would appreciate
 it if you give credit where it is due and keep your modifications in
 the public domain as well, but I don't require that in order to let
 you place this code and any modifications you make under a license
 of your choice.

Files: src/crypt/crypt_des.c
Copyright: 1994 David Burren
           2000,2002,2010,2012 Solar Designer <solar@openwall.com>
           2012 Rich Felker <dalias@aerifal.cx>
License: BSD-3-clause

Files: src/stdlib/qsort.c
Copyright: 2011 Valentin Ochs
License: MIT

Files: src/setjmp/x32/longjmp.s
       src/setjmp/x32/setjmp.s
       src/setjmp/x86_64/longjmp.s
       src/setjmp/x86_64/setjmp.s
       src/thread/x32/__set_thread_area.s
       src/thread/x32/__unmapself.s
       src/thread/x86_64/__set_thread_area.s
       src/thread/x86_64/__unmapself.s
Copyright: 2011-2012 Nicholas J. Kain
License: MIT

Files: src/string/arm/memcpy.S
Copyright: 2008 The Android Open Source Project
License: BSD-2-clause

Files: debian/musl-fts/fts.*
Copyright: 1989, 1990, 1993, 1994 The Regents of the University of California
License: BSD-3-clause
Comment: imported from https://github.com/void-linux/musl-fts tag v1.2.7

License: MIT
 Permission is hereby granted, free of charge, to any person obtaining a
 copy of this software and associated documentation files (the "Software"),
 to deal in the Software without restriction, including without limitation
 the rights to use, copy, modify, merge, publish, distribute, sublicense,
 and/or sell copies of the Software, and to permit persons to whom the
 Software is furnished to do so, subject to the following conditions:
 .
 The above copyright notice and this permission notice shall be included
 in all copies or substantial portions of the Software.
 .
 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

License: ISC
 Permission to use, copy, modify, and distribute this software for any
 purpose with or without fee is hereby granted, provided that the above
 copyright notice and this permission notice appear in all copies.
 .
 THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
 WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
 MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
 ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
 ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
 OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

License: BSD-2-clause
 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions
 are met:
 .
 1. Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
 .
 2. Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
 .
 THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDER AND CONTRIBUTORS
 ``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT
 HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
 LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
 DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
 THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
 (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

License: BSD-3-clause
 Redistribution and use in source and binary forms, with or without
 modification, are permitted provided that the following conditions
 are met:
 1. Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
 2. Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
 3. Neither the name of the author nor the names of other contributors
    may be used to endorse or promote products derived from this software
    without specific prior written permission.
 .
 THIS SOFTWARE IS PROVIDED BY THE AUTHOR AND CONTRIBUTORS ``AS IS'' AND
 ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 ARE DISCLAIMED.  IN NO EVENT SHALL THE AUTHOR OR CONTRIBUTORS BE LIABLE
 FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS
 OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT
 LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY
 OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF
 SUCH DAMAGE.
```
