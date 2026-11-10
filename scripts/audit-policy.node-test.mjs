import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { assessDevelopmentAudit } from "./audit-policy.mjs";

const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
const now = Date.parse("2026-11-10T00:00:00Z");
function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      glob: {
        name: "glob",
        severity: "moderate",
        nodes: ["node_modules/npm/node_modules/glob"],
        via: [
          { name: "glob", severity: "moderate", url: "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4" },
        ],
      },
      npm: { name: "npm", severity: "moderate", nodes: ["node_modules/npm"], via: ["glob"] },
    },
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 2, high: 0, critical: 0, total: 2 } },
  };
}
test("allows only reviewed development findings and their parent propagation", () => {
  assert.equal(assessDevelopmentAudit(report(), lock, now).accepted, 2);
});
test("rejects unknown advisory even with unchanged package and severity", () => {
  const r = report();
  r.vulnerabilities.glob.via[0].url += "-new";
  assert.throws(() => assessDevelopmentAudit(r, lock, now), /advisory_unknown/);
});
test("rejects expiry, dependency drift and production reclassification", () => {
  assert.throws(() => assessDevelopmentAudit(report(), lock, Date.parse("2026-12-10")), /expired/);
  for (const field of ["version", "dev"]) {
    const changed = structuredClone(lock);
    changed.packages["node_modules/npm/node_modules/glob"][field] = field === "dev" ? false : "13.0.7";
    assert.throws(() => assessDevelopmentAudit(report(), changed, now), /lock_changed/);
  }
});
test("rejects malformed, incomplete, cyclic and network-error reports", () => {
  for (const r of [null, {}, { ...report(), error: { code: "EACCES" } }])
    assert.throws(() => assessDevelopmentAudit(r, lock, now));
  const missing = report();
  missing.vulnerabilities.npm.via = ["missing"];
  assert.throws(() => assessDevelopmentAudit(missing, lock, now), /finding_invalid/);
  const cycle = report();
  cycle.vulnerabilities.npm.via = ["npm"];
  assert.throws(() => assessDevelopmentAudit(cycle, lock, now), /cyclic/);
  const counts = report();
  counts.metadata.vulnerabilities.total = 0;
  assert.throws(() => assessDevelopmentAudit(counts, lock, now), /counts_invalid/);
});
test("rejects an unexpected path or an elevated severity", () => {
  const r = report();
  r.vulnerabilities.glob.nodes = ["node_modules/minimatch"];
  assert.throws(() => assessDevelopmentAudit(r, lock, now), /node_changed/);
  const high = report();
  high.vulnerabilities.glob.via[0].severity = "high";
  assert.throws(() => assessDevelopmentAudit(high, lock, now), /advisory_unknown/);
});
test("clean audit needs no exception, including after expiry", () => {
  const clean = {
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } },
  };
  assert.equal(assessDevelopmentAudit(clean, lock, Date.parse("2027-01-01")).accepted, 0);
});
