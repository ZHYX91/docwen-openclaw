import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  script: "",
  binary: "",
  trace: "",
  child: undefined as ChildProcessModule.ChildProcess | undefined,
  closed: Promise.resolve(),
  sentinels: [] as ChildProcessModule.ChildProcess[],
}));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn(binary: string, args: string[], options: ChildProcessModule.SpawnOptions) {
      const isPosixMachine =
        process.platform !== "win32" && binary === process.execPath && args[0] === "serve";
      const isWindowsMachine =
        process.platform === "win32" && /[\\/]native[\\/]windows-x64\.exe$/iu.test(binary);
      const child = isPosixMachine
        ? actual.spawn(binary, [state.script], options)
        : actual.spawn(binary, args, options);
      if (isPosixMachine || isWindowsMachine) {
        state.child = child;
        state.closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      }
      return child;
    },
  };
});

import { runDocWenMachineQuery, runDocWenMachineTask } from "./machine-client.js";
import { MachineFrameDecoder } from "./machine-framing.js";

// Controlled process/transport fixture only. It is not DocWen, Gateway, LLM, or packaged acceptance.
const producer = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = process.env.DOCWEN_DATA_DIR;
if (!root) throw new Error('missing controlled fixture root');
const mode = fs.readFileSync(path.join(root, 'mode.txt'), 'utf8').trim();
const trace = path.join(root, 'trace.jsonl');
let buffer = Buffer.alloc(0), cooperativeHelper;
function record(event, extra = {}) {
  fs.appendFileSync(trace, JSON.stringify({event, pid: process.pid, ...extra}) + '\n');
}
function hold() { setInterval(() => {}, 1000); }
function spawnHelper(cooperative = false, independent = false) {
  const helper = spawn(
    process.execPath,
    ['-e', cooperative
      ? "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0))"
      : 'setInterval(() => {}, 1000)'],
    {
      stdio: independent ? 'ignore' : [cooperative ? 'pipe' : 'ignore', 'inherit', 'inherit'],
      windowsHide: true,
    },
  );
  record('helper_started', { helperPid: helper.pid, cooperative });
  return helper;
}
function send(message) {
  const data = Buffer.from(JSON.stringify(message));
  fs.writeSync(1, Buffer.concat([Buffer.from('Content-Length: ' + data.length + '\r\n\r\n'), data]));
  record('reply_sent', { id: message.id });
}
function reply(message, result) {
  send({ jsonrpc: '2.0', id: message.id, result });
}
let inputClosed = false;
function closeInput(afterClose) {
  // This mode never creates process.stdin: one synchronous owner of fd 0.
  fs.closeSync(0);
  inputClosed = true;
  record('stdin_closed');
  afterClose();
  hold();
}

function handle(message) {
  record('request', { method: message.method });
  switch (message.method) {
    case 'initialize': {
      const initialized = () => reply(message, {
        protocol: { name: 'docwen.machine', major: 2, minor: 0 },
        server: { name: 'DocWen', version: '0.12.1' },
        artifact_bundle_schema: 'docwen.artifact_bundle.v3'
      });
      if (mode === 'stdin_query') closeInput(initialized);
      else initialized();
      break;
    }
    case 'health/check':
      record('health_seen');
      if (mode === 'rpc_descendant' || mode === 'rpc_independent') {
        spawnHelper(false, mode === 'rpc_independent');
        record('root_exit');
        process.exit(0);
      }
      if (mode === 'signal_wait') {
        process.on('SIGTERM', () => record('sigterm_seen'));
        spawnHelper();
        hold();
        return;
      }
      if (mode === 'normal_descendant') cooperativeHelper = spawnHelper(true);
      reply(message, { all_ok: true, checks: [] });
      break;
    case 'task/plan':
      if (mode === 'stdin_task') closeInput(() => reply(message, { plan_id: 'plan.1' }));
      else reply(message, { plan_id: 'plan.1' });
      break;
    case 'task/execute':
      closeInput(() => reply(message, { task_id: 'task.1', state: 'accepted' }));
      break;
    default:
      throw new Error('Unexpected request: ' + message.method);
  }
}
function feed(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const match = /Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString());
    if (!match) throw new Error('missing content length');
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length));
    buffer = buffer.subarray(end + 4 + length);
    handle(message);
  }
}
if (mode !== 'stdin_query' && mode !== 'stdin_task' && mode !== 'stdin_cancel') process.stdin.on('end', () => {
  record('stdin_end');
  if (mode === 'close_descendant' || mode === 'close_independent') {
    spawnHelper(false, mode === 'close_independent');
    record('root_exit');
    process.exit(0);
  }
  if (mode === 'normal_descendant' && cooperativeHelper) {
    cooperativeHelper.once('close', () => {
      record('helper_closed');
      process.exit(0);
    });
    cooperativeHelper.stdin.end();
    return;
  }
  process.exit(0);
});
if (mode === 'stdin_query' || mode === 'stdin_task' || mode === 'stdin_cancel') {
  const chunk = Buffer.alloc(8192);
  while (!inputClosed) {
    const count = fs.readSync(0, chunk, 0, chunk.length, null);
    if (!count) throw new Error('unexpected EOF before close barrier');
    feed(chunk.subarray(0, count));
  }
} else {
  process.stdin.on('data', feed);
}

`;

const roots: string[] = [];
let nativeFixtureRoot: string | undefined;
let nativeFixture: string | undefined;
afterAll(async () => {
  if (nativeFixtureRoot) await rm(nativeFixtureRoot, { recursive: true, force: true });
});

async function windowsPipeFixture(): Promise<string> {
  if (nativeFixture) return nativeFixture;
  nativeFixtureRoot = await mkdtemp(join(tmpdir(), "docwen-native-pipe-"));
  const vswhere = join(
    process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  const found = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (found.status !== 0 || !found.stdout.trim())
    throw new Error("MSVC is required for the real Windows pipe fixture.");
  const source = join(process.cwd(), "src/process/test-fixtures/windows-broken-pipe.c");
  const executable = join(nativeFixtureRoot, "pipe-fixture.exe");
  const script = join(nativeFixtureRoot, "build.cmd");
  await writeFile(
    script,
    [
      `@call "${join(found.stdout.trim(), "VC/Auxiliary/Build/vcvarsall.bat")}" x64 >nul`,
      "@if errorlevel 1 exit /b 1",
      `@cl /nologo /W3 /O1 "${source}" /Fo"${join(nativeFixtureRoot, "fixture.obj")}" /Fe"${executable}"`,
    ].join("\r\n"),
  );
  const built = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", script], {
    cwd: nativeFixtureRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  });
  if (built.status !== 0)
    throw new Error(`Native pipe fixture build failed: ${built.stdout} ${built.stderr}`);
  nativeFixture = executable;
  return executable;
}

afterEach(async ({ task }) => {
  try {
    const rows = await readTrace();
    if (task.result?.state === "fail") console.error("Controlled fixture trace:", rows);
    const helperPids = rows
      .filter((row) => row.event === "helper_started" && typeof row.helperPid === "number")
      .map((row) => row.helperPid as number);
    for (const pid of helperPids) killFixturePid(pid);

    for (const sentinel of state.sentinels.splice(0)) {
      if (sentinel.exitCode === null && sentinel.signalCode === null) sentinel.kill("SIGKILL");
      await Promise.race([
        new Promise<void>((resolve) => sentinel.once("close", () => resolve())),
        delay(1_000),
      ]);
    }
    if (state.child && state.child.exitCode === null && state.child.signalCode === null) {
      state.child.kill("SIGKILL");
    }
    await Promise.race([state.closed, delay(2_000)]);
    for (const pid of new Set(
      rows.map((row) => row.pid).filter((pid): pid is number => typeof pid === "number"),
    )) {
      await waitForPidExit(pid);
    }
  } finally {
    state.child = undefined;
    state.closed = Promise.resolve();
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  }
});

async function setup(mode: string): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "docwen-machine-lifecycle-"));
  roots.push(root);
  state.script = join(root, "serve");
  state.trace = join(root, "trace.jsonl");
  await writeFile(state.script, producer);
  await writeFile(join(root, "mode.txt"), mode);
  vi.stubEnv("DOCWEN_DATA_DIR", root);

  if (process.platform === "win32") {
    state.binary = join(root, "DocWenCLI.exe");
    await copyFile(
      mode === "stdin_query" || mode === "stdin_task" || mode === "stdin_cancel"
        ? await windowsPipeFixture()
        : process.execPath,
      state.binary,
    );
  } else {
    state.binary = process.execPath;
  }
}

async function readTrace(): Promise<Array<Record<string, unknown>>> {
  if (!state.trace) return [];
  try {
    return (await readFile(state.trace, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForEvent(event: string, timeoutMs = 3_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = (await readTrace()).find((candidate) => candidate.event === event);
    if (row) return row;
    await delay(20);
  }
  throw new Error("Timed out waiting for controlled fixture event: " + event);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const status = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
      if (status === "Z" || status === "X" || status === "x") return false;
    }
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

async function waitForPidExit(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return;
    await delay(20);
  }
  throw new Error("Controlled fixture process did not exit.");
}

function killFixturePid(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Exact PIDs come from this test's freshly spawned fixture.
  }
}

function startUnrelatedSentinel(): ChildProcess {
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  state.sentinels.push(sentinel);
  return sentinel;
}

async function taskOptions(timeoutMs = 3_000) {
  const root = roots[roots.length - 1]!;
  const source = join(root, "source.md");
  const staging = join(root, "staging");
  const bytes = Buffer.from("# source\n");
  await writeFile(source, bytes);
  await mkdir(staging);
  return {
    staging,
    options: {
      binaryPath: state.binary,
      timeoutMs,
      request: {
        capability_id: "transform.markdown.heading_numbering",
        inputs: [
          {
            input_id: "input.1",
            locator: { kind: "local_path" as const, path: source },
            kind: "document" as const,
            role: "source" as const,
            logical_path: "source.md",
            media_type: "text/markdown",
            size_bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        output: {
          staging_root: { kind: "local_path" as const, path: staging },
          staging_policy: "require_empty" as const,
        },
        options: {},
      },
    },
  };
}

describe("Machine transport and owned process lifecycle with controlled real subprocesses", () => {
  it("generates executable fixture source with real JSONL and Machine frame delimiters", () => {
    expect(() => new Script(producer)).not.toThrow();
    expect(producer).toContain(String.raw`buffer.indexOf('\r\n\r\n')`);
    expect(producer).not.toContain(String.raw`buffer.indexOf('\\r\\n`);
  });

  it.each(["rpc_independent", "close_independent"])(
    "cleans independent-stdio descendants after direct root close: %s",
    async (mode) => {
      await setup(mode);
      const sentinel = startUnrelatedSentinel();
      const operation = runDocWenMachineQuery({
        binaryPath: state.binary,
        method: "health/check",
        params: {},
        timeoutMs: 3_000,
      });
      if (mode === "rpc_independent") {
        await expect(operation).rejects.toMatchObject({ code: "docwen_machine_protocol_error" });
      } else {
        await expect(operation).resolves.toMatchObject({ result: { all_ok: true } });
      }
      const helper = await waitForEvent("helper_started");
      await waitForPidExit(helper.helperPid as number);
      await state.closed;
      expect(pidAlive(sentinel.pid!)).toBe(true);
    },
    8_000,
  );

  it("settles a normal query and normal child shutdown", async () => {
    await setup("normal");
    await expect(
      runDocWenMachineQuery({
        binaryPath: state.binary,
        method: "health/check",
        params: {},
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ result: { all_ok: true } });
    await state.closed;
    expect((await readTrace()).some((row) => row.event === "helper_started")).toBe(false);
  });

  it("settles a cooperative parent/descendant tree normally", async () => {
    await setup("normal_descendant");
    await expect(
      runDocWenMachineQuery({
        binaryPath: state.binary,
        method: "health/check",
        params: {},
        timeoutMs: 3_000,
      }),
    ).resolves.toMatchObject({ result: { all_ok: true } });
    const helper = await waitForEvent("helper_started");
    await waitForPidExit(helper.helperPid as number);
    await state.closed;
    expect((await readTrace()).some((row) => row.event === "helper_closed")).toBe(true);
  });

  it("turns an actual broken stdin during a query into a bounded session failure", async () => {
    await setup("stdin_query");
    await expect(
      runDocWenMachineQuery({
        binaryPath: state.binary,
        method: "health/check",
        params: {},
        timeoutMs: 3_000,
      }),
    ).rejects.toMatchObject({ code: "docwen_machine_protocol_error" });
    expect((await waitForEvent("stdin_closed")).event).toBe("stdin_closed");
    await state.closed;
  }, 40_000);

  it("turns an actual broken stdin during task RPC into a bounded session failure", async () => {
    await setup("stdin_task");
    const invocation = await taskOptions();
    await expect(runDocWenMachineTask(invocation.options)).rejects.toMatchObject({
      code: "docwen_machine_protocol_error",
    });
    expect((await waitForEvent("stdin_closed")).event).toBe("stdin_closed");
    await state.closed;
    expect(await readdir(invocation.staging)).toEqual([]);
  });

  it("fails a real cancellation write before the cancellation grace expires", async () => {
    await setup("stdin_cancel");
    const invocation = await taskOptions(10_000);
    const controller = new AbortController();
    const operation = runDocWenMachineTask({ ...invocation.options, signal: controller.signal });
    void operation.catch(() => {});
    const accepted = new Promise<void>((resolve) => {
      const decoder = new MachineFrameDecoder();
      state.child!.stdout!.on("data", (chunk: Buffer) => {
        for (const message of decoder.feed(chunk)) {
          if ((message.result as { state?: string } | undefined)?.state === "accepted") {
            setImmediate(resolve);
          }
        }
      });
    });
    await Promise.race([
      accepted,
      delay(3000).then(() => {
        throw new Error("No accepted frame");
      }),
    ]);
    await waitForEvent("stdin_closed");
    const started = performance.now();
    controller.abort();
    await expect(operation).rejects.toMatchObject({ code: "docwen_machine_cancelled" });
    expect(performance.now() - started).toBeLessThan(1500);
    await state.closed;
    expect(await readdir(invocation.staging)).toEqual([]);
  }, 40_000);

  it("cleans an inherited-stdio descendant after the direct child exits during an RPC wait", async () => {
    await setup("rpc_descendant");
    const sentinel = startUnrelatedSentinel();
    const startedAt = performance.now();
    const operation = runDocWenMachineQuery({
      binaryPath: state.binary,
      method: "health/check",
      params: {},
      timeoutMs: process.platform === "win32" ? 3_000 : 200,
    });
    void operation.catch(() => {});
    const helper = await waitForEvent("helper_started");
    const helperPid = helper.helperPid as number;

    if (process.platform === "win32") {
      await expect(operation).rejects.toMatchObject({ code: "docwen_machine_protocol_error" });
    } else {
      await expect(operation).rejects.toMatchObject({
        code: "docwen_machine_timeout",
        details: { timeoutMs: 200 },
      });
    }
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    await waitForPidExit(helperPid);
    await state.closed;
    expect(pidAlive(sentinel.pid!)).toBe(true);
  }, 8_000);

  it("bounds graceful close, cleans the owned descendant, and leaves unrelated processes alone", async () => {
    await setup("close_descendant");
    const sentinel = startUnrelatedSentinel();
    const startedAt = performance.now();
    const operation = runDocWenMachineQuery({
      binaryPath: state.binary,
      method: "health/check",
      params: {},
      timeoutMs: 10_000,
    });
    void operation.catch(() => {});
    const helper = await waitForEvent("helper_started", 5_000);
    const helperPid = helper.helperPid as number;

    await expect(operation).resolves.toMatchObject({ result: { all_ok: true } });
    expect(performance.now() - startedAt).toBeLessThan(5_000);
    await waitForPidExit(helperPid);
    await state.closed;
    expect(pidAlive(sentinel.pid!)).toBe(true);
  }, 8_000);

  it.skipIf(process.platform === "win32")(
    "does not treat a previously sent signal as proof that the owned process group exited",
    async () => {
      await setup("signal_wait");
      const operation = runDocWenMachineQuery({
        binaryPath: state.binary,
        method: "health/check",
        params: {},
        timeoutMs: 400,
      });
      const helper = await waitForEvent("helper_started");
      const helperPid = helper.helperPid as number;
      expect(state.child).toBeDefined();
      state.child!.kill("SIGTERM");
      await waitForEvent("sigterm_seen");
      expect(state.child!.killed).toBe(true);
      expect(state.child!.exitCode).toBeNull();

      await expect(operation).rejects.toMatchObject({
        code: "docwen_machine_timeout",
        details: { timeoutMs: 400 },
      });
      await waitForPidExit(helperPid);
      await state.closed;
    },
    8_000,
  );
});
