import { spawn } from "node:child_process";
import type * as ChildProcessModule from "node:child_process";
import { copyFile, link, readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MachineFrameDecoder } from "./machine-framing.js";
import { defineDocWenTools } from "../tools/definitions.js";

const state = vi.hoisted(() => ({
  script: "",
  binary: "",
  trace: "",
  phase: "",
  reached: () => {},
  child: undefined as ChildProcessModule.ChildProcess | undefined,
  closed: Promise.resolve(),
}));

vi.mock("./path.js", () => ({ resolveDocWenBinary: async () => state.binary }));
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
        const decoder = new MachineFrameDecoder();
        child.stdout!.on("data", (data: Buffer) => {
          for (const message of decoder.feed(data)) {
            const result = message.result as { state?: string } | undefined;
            const phase = currentPhase();
            if (
              (phase !== "running" && result?.state === "accepted") ||
              (phase === "running" && message.method === "task/progress")
            ) {
              setImmediate(() => state.reached());
            }
          }
        });
      }
      return child;
    },
  };
});

function currentPhase(): string {
  return state.phase;
}

// Controlled producer fixture, not a substitute for real DocWen/Gateway acceptance.
// The plugin adapter, consumer, framing, process teardown and temporary cleanup are real.
const producer = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.DOCWEN_DATA_DIR;
if (!root) throw new Error('missing controlled fixture root');
const phase = fs.readFileSync(path.join(root, 'mode.txt'), 'utf8').trim();
const trace = path.join(root, 'trace.jsonl');
let buffer = Buffer.alloc(0), sequence = 0;
function send(message) {
  fs.appendFileSync(trace, JSON.stringify({direction:'out', message})+'\n');
  const data = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+data.length+'\r\n\r\n'),data]));
}
function closeInput(afterClose) {
  setInterval(()=>{},1000);
  process.stdin.pause();
  process.stdin.on('error',()=>{});
  const handle = process.stdin._handle;
  if (!handle || typeof handle.close !== 'function') throw new Error('controlled stdin pipe handle missing');
  handle.close(() => {
    fs.appendFileSync(trace, JSON.stringify({direction:'event', event:'stdin_closed'})+'\n');
    afterClose();
  });
}
function handle(message) {
  fs.appendFileSync(trace, JSON.stringify({direction:'in', message})+'\n');
  const reply = result => send({jsonrpc:'2.0',id:message.id,result});
  const notify = method => send({jsonrpc:'2.0',method,params:{task_id:'task.1',sequence:++sequence,state:'running'}});
  switch(message.method) {
    case 'initialize': reply({protocol:{name:'docwen.machine',major:2,minor:0},server:{name:'DocWen',version:'0.12.1'},artifact_bundle_schema:'docwen.artifact_bundle.v3'}); break;
    case 'capability/list': reply({capabilities:[{capability_id:'transform.markdown.heading_numbering',operation:'transform',input_shape:{slots:[{role:'source',kind:'document',media_types:['text/markdown'],min_items:1,max_items:1}],undeclared_roles:'reject'},output_media_types:['text/markdown'],output_shape:{cardinality:'one',artifact_kinds:['document'],relation_types:[],atomic_bundle:true},options_schema:{},availability:'available',dependencies:[],limitations:[]}]}); break;
    case 'task/plan': reply({plan_id:'plan.1'}); break;
    case 'task/execute': {
      const accepted = () => {
        reply({task_id:'task.1',state:'accepted'});
        if(phase==='running' || phase==='stdin_closed') notify('task/progress');
      };
      if(phase==='stdin_closed') closeInput(accepted);
      else accepted();
      break;
    }
    case 'task/cancel':
      if(phase==='ignore') break;
      if(phase==='disconnect') { process.exit(0); break; }
      reply({task_id:'task.1',state:'cancellation_requested'});
      if(phase!=='ack_only') notify('task/cancelled');
      break;
    default: throw Error('Unexpected request: '+message.method);
  }
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer,chunk]);
  while(true) {
    const end = buffer.indexOf('\r\n\r\n'); if(end<0) return;
    const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0,end).toString())[1]);
    if(buffer.length<end+4+length) return;
    const message=JSON.parse(buffer.subarray(end+4,end+4+length));
    buffer=buffer.subarray(end+4+length); handle(message);
  }
});
`;

const roots: string[] = [];

afterEach(async () => {
  try {
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

async function setup(phase: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "docwen-cancel-boundary-"));
  roots.push(root);
  state.script = join(root, "serve");
  state.trace = join(root, "trace.jsonl");
  state.phase = phase;
  await writeFile(state.script, producer);
  await writeFile(join(root, "mode.txt"), phase);
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
  return root;
}

describe("Gateway tool adapter cancellation with a controlled real subprocess", () => {
  it.each(["accepted", "running", "ack_only", "ignore", "disconnect", "stdin_closed"])(
    "cancels exactly at %s without publication or retained task work",
    async (phase) => {
      const root = await setup(phase);
      const source = join(root, "source.md");
      await writeFile(source, "# Original\n");
      const controller = new AbortController();
      const reached = new Promise<void>((resolve) => {
        state.reached = resolve;
      });
      const definitions = defineDocWenTools(
        ((definition: object) => definition) as never,
      ) as unknown as Array<{
        name: string;
        execute: (params: object, config: object, context: { signal: AbortSignal }) => Promise<unknown>;
      }>;
      const tool = definitions.find((definition) => definition.name === "docwen_number_markdown")!;
      const operation = tool.execute(
        { file: source, operation: "add", inPlace: true },
        { writeTimeoutMs: 30000 },
        { signal: controller.signal },
      );
      await Promise.race([
        reached,
        operation.then((result) => {
          throw new Error(`Ended before boundary: ${JSON.stringify(result)}`);
        }),
      ]);
      const cancelledAt = performance.now();
      controller.abort();
      expect(await operation).toMatchObject({
        status: "failed",
        error: { code: "docwen_machine_cancelled" },
        publication: { state: "not_published" },
      });
      await state.closed;
      expect(performance.now() - cancelledAt).toBeLessThan(10000);
      expect(state.child!.exitCode !== null || state.child!.signalCode !== null).toBe(true);
      expect(await readFile(source, "utf8")).toBe("# Original\n");
      const trace = (await readFile(state.trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const requests = trace.filter((row) => row.direction === "in").map((row) => row.message);
      expect(requests.filter((request) => request.method === "task/cancel")).toHaveLength(
        phase === "stdin_closed" ? 0 : 1,
      );
      expect(requests.filter((request) => request.method === "task/execute")).toHaveLength(1);
      const progress = trace.filter(
        (row) => row.direction === "out" && row.message.method === "task/progress",
      );
      expect(progress).toHaveLength(phase === "running" || phase === "stdin_closed" ? 1 : 0);
      if (phase === "stdin_closed") {
        expect(trace.some((row) => row.direction === "event" && row.event === "stdin_closed")).toBe(true);
      }
      const staging = requests.find((request) => request.method === "task/plan").params.output.staging_root
        .path;
      await expect(stat(dirname(staging))).rejects.toMatchObject({ code: "ENOENT" });
    },
    15000,
  );
});
