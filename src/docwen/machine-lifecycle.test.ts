import { spawn, type ChildProcess } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

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
function spawnHelper(cooperative = false) {
  const helper = spawn(
    process.execPath,
    ['-e', cooperative
      ? "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0))"
      : 'setInterval(() => {}, 1000)'],
    {
      stdio: [cooperative ? 'pipe' : 'ignore', 'inherit', 'inherit'],
      windowsHide: true,
    },
  );
  record('helper_started', { helperPid: helper.pid, cooperative });
  return helper;
}
function send(message) {
  const data = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: ' + data.length + '\r\n\r\n'), data]));
}
function reply(message, result) {
  send({ jsonrpc: '2.0', id: message.id, result });
}
function closeInput(afterClose) {
  hold();
  process.stdin.pause();
  process.stdin.on('error', () => {});
  const handle = process.stdin._handle;
  if (!handle || typeof handle.close !== 'function') throw new Error('controlled stdin pipe handle missing');
  handle.close(() => {
    record('stdin_closed');
    afterClose();
  });
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
      if (mode === 'rpc_descendant') {
        spawnHelper();
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
    default:
      throw new Error('Unexpected request: ' + message.method);
  }
}
process.stdin.on('data', chunk => {
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
});
process.stdin.on('end', () => {
  record('stdin_end');
  if (mode === 'close_descendant') {
    spawnHelper();
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
`;

const roots: string[] = [];

afterEach(async () => {
  try {
    const rows = await readTrace();
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
    try {
      await link(process.execPath, state.binary);
    } catch {
      await copyFile(process.execPath, state.binary);
    }
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
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
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
    return true;
  } catch (error) {
    return !(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ESRCH"
    );
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
  });

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
