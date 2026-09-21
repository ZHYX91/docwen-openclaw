import type * as ChildProcessModule from "node:child_process";
import { readFile, writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineFrameDecoder } from "./machine-framing.js";
import { defineDocWenTools } from "../tools/definitions.js";
import { terminateProcessTree } from "../process/runner.js";

const state = vi.hoisted(() => ({
  script: "",
  phase: "accepted",
  trace: "",
  reached: () => {},
  child: undefined as ChildProcessModule.ChildProcess | undefined,
  closed: Promise.resolve(),
}));
vi.mock("./path.js", () => ({ resolveDocWenBinary: async () => process.execPath }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn(binary: string, args: string[], options: ChildProcessModule.SpawnOptions) {
      if (binary !== process.execPath) return actual.spawn(binary, args, options);
      const child = actual.spawn(binary, [state.script, state.phase, state.trace], options);
      state.child = child;
      state.closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const decoder = new MachineFrameDecoder();
      child.stdout!.on("data", (data: Buffer) => {
        for (const message of decoder.feed(data)) {
          const result = message.result as { state?: string } | undefined;
          if (
            (state.phase === "accepted" && result?.state === "accepted") ||
            (state.phase === "running" && message.method === "task/progress")
          ) {
            // Let the real client consume this exact frame before releasing the test barrier.
            setImmediate(() => state.reached());
          }
        }
      });
      return child;
    },
  };
});

// Controlled producer fixture, not a substitute for real DocWen/Gateway acceptance.
// The plugin adapter, consumer, framing, process teardown and temporary cleanup are real.
const producer = String.raw`
const fs = require('node:fs');
const phase = process.argv[2], trace = process.argv[3];
let buffer = Buffer.alloc(0), sequence = 0;
function send(message) {
  fs.appendFileSync(trace, JSON.stringify({direction:'out', message})+'\n');
  const data = Buffer.from(JSON.stringify(message));
  process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+data.length+'\r\n\r\n'),data]));
}
function handle(message) {
  fs.appendFileSync(trace, JSON.stringify({direction:'in', message})+'\n');
  const reply = result => send({jsonrpc:'2.0',id:message.id,result});
  const notify = method => send({jsonrpc:'2.0',method,params:{task_id:'task.1',sequence:++sequence,state:'running'}});
  switch(message.method) {
    case 'initialize': reply({protocol:{name:'docwen.machine',major:2,minor:0},server:{name:'DocWen',version:'0.12.1'},artifact_bundle_schema:'docwen.artifact_bundle.v3'}); break;
    case 'capability/list': reply({capabilities:[{capability_id:'transform.markdown.heading_numbering',operation:'transform',input_shape:{slots:[{role:'source',kind:'document',media_types:['text/markdown'],min_items:1,max_items:1}],undeclared_roles:'reject'},output_media_types:['text/markdown'],output_shape:{cardinality:'one',artifact_kinds:['document'],relation_types:[],atomic_bundle:true},options_schema:{},availability:'available',dependencies:[],limitations:[]}]}); break;
    case 'task/plan': reply({plan_id:'plan.1'}); break;
    case 'task/execute': reply({task_id:'task.1',state:'accepted'}); if(phase==='running') notify('task/progress'); break;
    case 'task/cancel': reply({task_id:'task.1',state:'cancellation_requested'}); notify('task/cancelled'); break;
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
  if (state.child) {
    await terminateProcessTree(state.child);
    await state.closed;
    state.child = undefined;
  }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("Gateway tool adapter cancellation with a controlled real subprocess", () => {
  it.each(["accepted", "running"])(
    "cancels exactly at %s without publication or retained task work",
    async (phase) => {
      const root = await mkdtemp(join(tmpdir(), "docwen-cancel-boundary-"));
      roots.push(root);
      state.script = join(root, "producer.cjs");
      state.trace = join(root, "trace.jsonl");
      state.phase = phase;
      await writeFile(state.script, producer);
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
        { writeTimeoutMs: 5000 },
        { signal: controller.signal },
      );
      await Promise.race([
        reached,
        operation.then((result) => {
          throw new Error(`Ended before boundary: ${JSON.stringify(result)}`);
        }),
      ]);
      controller.abort();
      expect(await operation).toMatchObject({
        status: "failed",
        error: { code: "docwen_machine_cancelled" },
        publication: { state: "not_published" },
      });
      await state.closed;
      expect(state.child!.exitCode !== null || state.child!.signalCode !== null).toBe(true);
      expect(await readFile(source, "utf8")).toBe("# Original\n");
      const trace = (await readFile(state.trace, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const requests = trace.filter((row) => row.direction === "in").map((row) => row.message);
      expect(requests.filter((request) => request.method === "task/cancel")).toHaveLength(1);
      expect(requests.filter((request) => request.method === "task/execute")).toHaveLength(1);
      const progress = trace.filter(
        (row) => row.direction === "out" && row.message.method === "task/progress",
      );
      expect(progress).toHaveLength(phase === "running" ? 1 : 0);
      const staging = requests.find((request) => request.method === "task/plan").params.output.staging_root
        .path;
      await expect(stat(dirname(staging))).rejects.toMatchObject({ code: "ENOENT" });
    },
    15000,
  );
});
