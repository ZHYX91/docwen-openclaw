import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnOwnedMachineProcess } from "./runner.js";
import { runDocWenMachineQuery } from "../docwen/machine-client.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("real POSIX spawn error handoff", () => {
  it.each(["executable", "cwd", "interpreter"])(
    "retains the asynchronous error channel: %s",
    async (failure) => {
      const root = await mkdtemp(join(tmpdir(), "docwen-spawn-failure-"));
      roots.push(root);
      let binary = process.execPath;
      let cwd = root;
      if (failure === "executable") binary = join(root, "missing-executable");
      if (failure === "cwd") cwd = join(root, "missing-directory");
      if (failure === "interpreter") {
        binary = join(root, "bad-interpreter");
        await writeFile(binary, "#!/missing/docwen-test-interpreter\n", { mode: 0o700 });
      }
      const { child, ownership } = spawnOwnedMachineProcess(binary, {
        cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
      });
      const outcome = new Promise<Error>((resolve) => child.once("error", resolve));
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      expect(ownership?.kind).toBe("linux-supervisor");
      if (failure === "cwd") await expect(outcome).resolves.toMatchObject({ code: "ENOENT" });
      else
        await expect(outcome).resolves.toMatchObject({
          message: "Linux Machine owner could not start the configured executable.",
        });
      await closed;
    },
  );

  it("surfaces a missing binary as a bounded session rejection without killing the host", async () => {
    const root = await mkdtemp(join(tmpdir(), "docwen-session-spawn-failure-"));
    roots.push(root);
    await expect(
      runDocWenMachineQuery({
        binaryPath: join(root, "missing"),
        method: "health/check",
        params: {},
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: "docwen_machine_spawn_failed" });
  });
});
