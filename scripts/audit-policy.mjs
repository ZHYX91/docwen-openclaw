import { createHash } from "node:crypto";

// See docs/dependency-audit.md. This is a reviewed snapshot, not a severity bypass.
const LOCK_SHA256 = "46bc6c31c831c0502424cd41e225b0006540f28a7680de7c92f844c3ef29de67";
const EXPIRES = Date.parse("2026-12-10T00:00:00Z");
const EXCEPTIONS = {
  glob: {
    url: "https://github.com/advisories/GHSA-3g3m-2fjr-6pw4",
    nodes: { "node_modules/npm/node_modules/glob": "13.0.6" },
  },
  minimatch: {
    url: "https://github.com/advisories/GHSA-g3hv-75wg-m249",
    nodes: {
      "node_modules/minimatch": "10.2.6",
      "node_modules/npm/node_modules/minimatch": "10.2.5",
    },
  },
};

function fail(reason) {
  throw new Error(`dependency_audit_rejected:${reason}`);
}

export function assessDevelopmentAudit(report, lock, now = Date.now()) {
  if (
    !report ||
    report.error ||
    report.auditReportVersion !== 2 ||
    !report.vulnerabilities ||
    Array.isArray(report.vulnerabilities) ||
    typeof report.vulnerabilities !== "object"
  )
    fail("report_invalid");
  const findings = report.vulnerabilities;
  const entries = Object.entries(findings);
  const counts = report.metadata?.vulnerabilities;
  if (!counts || counts.total !== entries.length) fail("counts_invalid");
  for (const severity of ["info", "low", "moderate", "high", "critical"]) {
    if (counts[severity] !== entries.filter(([, v]) => v?.severity === severity).length)
      fail("severity_counts_invalid");
  }
  if (entries.length === 0) return { accepted: 0, advisories: [] };
  if (!Number.isFinite(now) || now >= EXPIRES) fail("exception_expired");
  const hash = createHash("sha256").update(JSON.stringify(lock)).digest("hex");
  if (hash !== LOCK_SHA256) fail("lock_changed");
  const proven = new Set();
  const active = new Set();
  const advisories = new Set();
  function visit(name) {
    if (proven.has(name)) return;
    if (active.has(name)) fail("cyclic_dependency");
    const v = findings[name];
    if (
      !v ||
      v.name !== name ||
      v.severity !== "moderate" ||
      !Array.isArray(v.nodes) ||
      v.nodes.length === 0 ||
      !Array.isArray(v.via) ||
      v.via.length === 0
    )
      fail(`finding_invalid:${name}`);
    for (const node of v.nodes) {
      if (lock.packages?.[node]?.dev !== true) fail(`not_development:${node}`);
    }
    active.add(name);
    for (const via of v.via) {
      if (typeof via === "string") {
        visit(via);
      } else {
        const exception = EXCEPTIONS[name];
        if (
          !exception ||
          !via ||
          via.name !== name ||
          via.url !== exception.url ||
          via.severity !== "moderate"
        )
          fail(`advisory_unknown:${name}`);
        for (const node of v.nodes) {
          if (exception.nodes[node] !== lock.packages[node]?.version) fail(`node_changed:${node}`);
        }
        advisories.add(exception.url);
      }
    }
    active.delete(name);
    proven.add(name);
  }
  for (const [name] of entries) visit(name);
  return { accepted: entries.length, advisories: [...advisories].sort() };
}
