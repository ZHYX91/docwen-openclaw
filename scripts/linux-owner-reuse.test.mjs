import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import ts from "typescript";
import { expect, it } from "vitest";
const isolation =
  process.platform === "linux"
    ? spawnSync("unshare", ["--user", "--map-root-user", "--pid", "--fork", "--mount-proc", "true"], {
        timeout: 3000,
      })
    : undefined;
it.skipIf(isolation?.status !== 0)(
  "pins a real guardian PID until the final signal and cannot signal its later reuse",
  () => {
    const repo = process.cwd();
    const work = { root: mkdtempSync(join(tmpdir(), "docwen-owner-reuse-")) };
    try {
      mkdirSync(join(work.root, "dist/process"), { recursive: true });
      mkdirSync(join(work.root, "native"));
      mkdirSync(join(work.root, "tmp"));
      writeFileSync(join(work.root, "package.json"), '{"type":"module"}');
      const transpile = (s) =>
        ts.transpileModule(s, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText;
      for (const name of ["runner", "linux-owner"])
        writeFileSync(
          join(work.root, "dist/process/" + name + ".js"),
          transpile(readFileSync(join(repo, "src/process/" + name + ".ts"), "utf8")),
        );
      copyFileSync(join(repo, "native/linux-owner-x64"), join(work.root, "native/linux-owner-x64"));
      writeFileSync(
        join(work.root, "peer.py"),
        [
          "#!/usr/bin/python3",
          "import os,json,time",
          "print(json.dumps({'root':os.getpid(),'guard':os.getppid()}),flush=True)",
          "while True: time.sleep(10)",
          "",
        ].join("\n"),
        { mode: 0o700 },
      );
      writeFileSync(
        join(work.root, "clone.py"),
        [
          "import ctypes,errno,json,os,signal,sys,time",
          "class Args(ctypes.Structure):",
          " _fields_=[(s,ctypes.c_uint64) for s in ('flags','pidfd','child_tid','parent_tid','exit_signal','stack','stack_size','tls','set_tid','set_tid_size','cgroup')]",
          "libc=ctypes.CDLL(None,use_errno=True);libc.syscall.restype=ctypes.c_long",
          "pid=ctypes.c_int(int(sys.argv[1]))",
          "args=Args(exit_signal=signal.SIGCHLD,set_tid=ctypes.addressof(pid),set_tid_size=1)",
          "result=libc.syscall(435,ctypes.byref(args),ctypes.sizeof(args));code=ctypes.get_errno()",
          "if result==0:",
          " os.setsid()",
          " while True:time.sleep(10)",
          "print(json.dumps({'pid':result,'errno':code}),flush=True)",
          "if result>0:",
          " try:sys.stdin.readline()",
          " finally:",
          "  try:os.kill(result,signal.SIGKILL)",
          "  except ProcessLookupError:pass",
          "  os.waitpid(result,0)",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(work.root, "probe.mjs"),
        String.raw`
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {spawnOwnedMachineProcess,terminateProcessTree} from './dist/process/runner.js';
const here=new URL('.',import.meta.url).pathname;
const bounded=p=>Promise.race([p,new Promise((_,reject)=>{const t=setTimeout(()=>reject(new Error('timeout')),5000);t.unref();})]);
const first=child=>bounded(new Promise((resolve,reject)=>{let s='';child.stdout.on('data',b=>{s+=b;if(s.includes('\n')){try{resolve(JSON.parse(s.split('\n')[0]));}catch(e){reject(e);}}});child.once('error',reject);}));
async function state(pid){try{const s=await readFile('/proc/'+pid+'/stat','utf8');return s.slice(s.lastIndexOf(')')+2).split(' ')[0];}catch(e){if(e.code==='ENOENT')return 'gone';throw e;}}
const owned=spawnOwnedMachineProcess(here+'peer.py',{cwd:here,env:process.env,shell:false,windowsHide:true});
owned.child.on('error',()=>{});
const closed=new Promise(resolve=>owned.child.once('close',resolve));
let clone;
try {
 const meta=await first(owned.child);
 owned.child.kill('SIGSTOP');
 for(let i=0;i<100&&await state(owned.child.pid)!=='T';i++)await delay(5);
 if(await state(owned.child.pid)!=='T')throw Error('owner not frozen');
 process.kill(meta.guard,'SIGKILL');
 for(let i=0;i<100&&await state(meta.guard)!=='Z';i++)await delay(5);
 if(await state(meta.guard)!=='Z')throw Error('guardian not held zombie');
 const held=spawn('/usr/bin/python3',[here+'clone.py',String(meta.guard)],{stdio:['pipe','pipe','inherit']});
 const before=await first(held);
 if(before.pid!==-1||before.errno!==17)throw Error('held identity not pinned '+JSON.stringify(before));
 owned.child.kill('SIGCONT');await bounded(closed);
 await terminateProcessTree(owned.child,owned.ownership).catch(()=>{});
 if(await state(meta.root)!=='gone')throw Error('root not reaped');
 clone=spawn('/usr/bin/python3',[here+'clone.py',String(meta.guard)],{stdio:['pipe','pipe','inherit']});
 const after=await first(clone);
 if(after.pid!==meta.guard)throw Error('reuse not established '+JSON.stringify(after));
 let grouped=false;
 for(let i=0;i<100;i++){const s=await readFile('/proc/'+after.pid+'/stat','utf8');if(Number(s.slice(s.lastIndexOf(')')+2).split(' ')[2])===after.pid){grouped=true;break;}await delay(5);}
 if(!grouped)throw Error('reused group not ready');
 await terminateProcessTree(owned.child,owned.ownership).catch(()=>{});
 const survived=await state(after.pid);
 if(['gone','Z','X'].includes(survived))throw Error('new owner killed reused group');
 console.log(JSON.stringify({whileHeld:before,afterRelease:after,newOwnerSurvival:survived,result:'passed'}));
} finally {
 if(owned.child.exitCode===null&&owned.child.signalCode===null)owned.child.kill('SIGCONT');
 await terminateProcessTree(owned.child,owned.ownership).catch(()=>{});
 if(clone)clone.stdin.end('reap\n');
}
`,
      );
      const result = spawnSync(
        "unshare",
        [
          "--user",
          "--map-root-user",
          "--pid",
          "--fork",
          "--mount-proc",
          "--kill-child",
          process.execPath,
          join(work.root, "probe.mjs"),
        ],
        { env: { ...process.env, TMPDIR: join(work.root, "tmp") }, encoding: "utf8", timeout: 12000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        whileHeld: { pid: -1, errno: 17 },
        result: "passed",
      });
    } finally {
      rmSync(work.root, { recursive: true, force: true });
    }
  },
  15000,
);
