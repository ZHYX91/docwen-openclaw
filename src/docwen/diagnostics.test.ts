import { describe, expect, it } from "vitest";
import { diagnosticSummary } from "./diagnostics.js";
import { DocWenMachineError } from "./machine-client.js";
import { newPublication, publicationFailure } from "./publication.js";

describe("shareable diagnostic snapshot", () => {
  it("excludes arbitrary codes, nested data, paths and messages while retaining reported facts", () => {
    const secret = "PRIVATE-TOKEN-CONTENT-C:/Users/person/document.md";
    const error = new DocWenMachineError(`docwen_machine_remote:${secret}`, secret, {
      category: "internal",
      retryable: true,
      system_code: "EPERM",
      details: { content: secret, command: secret, token: secret, publication: { state: "published" } },
    });
    const publication = newPublication();
    const summary = diagnosticSummary({ error, publication });
    expect(summary).toMatchObject({
      outcome: "failed",
      publication_state: "not_published",
      retry: "review_before_retry",
      error_code: "remote_error",
      error_category: "internal",
      reported_retryable: true,
      recovery_action: "review_failure",
    });
    expect(summary).not.toHaveProperty("system_code");
    expect(JSON.stringify(summary)).not.toContain(secret);
    error.details.category = secret;
    publication.state = "published";
    expect(summary.error_category).toBe("internal");
    expect(summary.publication_state).toBe("not_published");
  });

  it("uses unknown for unsupported labels and rejects malformed values instead of serializing them", () => {
    const summary = diagnosticSummary({
      error: new DocWenMachineError("docwen_machine_remote:secret", "secret", {
        category: ["secret"],
        retryable: "yes",
        timeoutMs: "secret",
      }),
      outputCount: Number.POSITIVE_INFINITY,
      diagnosticCount: -1,
    });
    expect(summary).toMatchObject({ error_category: "unknown", output_count: 0, diagnostic_count: 0 });
    expect(summary).not.toHaveProperty("reported_retryable");
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(diagnosticSummary({ error: new DocWenMachineError("__proto__", "secret") }).error_code).toBe(
      "unknown",
    );
    expect(diagnosticSummary({ outputCount: 2_000_000 }).output_count).toBe(1_000_000);
  });

  it("preserves system failure facts through nested output wrappers without exporting the raw error", () => {
    const publication = newPublication();
    const error = Object.assign(new Error("secret filename and body"), { code: "ENOSPC", path: "secret" });
    const wrapped = publicationFailure(publicationFailure(error, publication), publication);
    const summary = diagnosticSummary({ error: wrapped, publication });
    expect(summary).toMatchObject({
      system_code: "ENOSPC",
      error_category: "resource_exhausted",
      recovery_action: "check_storage_space",
    });
    expect(JSON.stringify(summary)).not.toContain("secret");
  });

  it("gives publication facts precedence over error and retry claims, and snapshots cleanup codes", () => {
    const publication = newPublication();
    publication.state = "published";
    publication.warnings.push({ code: "backup_cleanup_failed", message: "secret", path: "secret" });
    const summary = diagnosticSummary({
      error: new DocWenMachineError("docwen_machine_timeout", "secret", { timeoutMs: 1200 }),
      publication,
      outputCount: 2,
    });
    expect(summary).toMatchObject({
      outcome: "warning",
      retry: "do_not_retry",
      output_count: 2,
      recovery_action: "review_cleanup_keep_outputs",
      warning_codes: ["backup_cleanup_failed"],
      timeout_ms: 1200,
    });
    publication.warnings[0]!.code = "staging_cleanup_failed";
    expect(summary.warning_codes).toEqual(["backup_cleanup_failed"]);
    publication.state = "unconfirmed";
    publication.recovery = { destination: "secret", backup: "secret", staging: "secret" };
    const uncertain = diagnosticSummary({ publication });
    expect(uncertain).toMatchObject({
      outcome: "unconfirmed",
      retry: "do_not_retry",
      recovery_action: "review_recovery_paths",
    });
    expect(JSON.stringify([summary, uncertain])).not.toContain("secret");
  });

  it.each([
    ["docwen_source_changed", "prepare_current_source"],
    ["docwen_output_changed", "review_current_destination"],
    ["docwen_output_exists", "choose_new_output_directory"],
    ["docwen_output_busy", "wait_for_active_writer"],
    ["docwen_binary_path_required", "check_binary_configuration"],
    ["docwen_machine_incompatible_version", "check_compatibility"],
  ])("provides a cause-specific recovery action for %s", (code, action) => {
    const error =
      code === "docwen_binary_path_required" ? new Error(code) : new DocWenMachineError(code, "secret");
    expect(diagnosticSummary({ error }).recovery_action).toBe(action);
  });

  it("preserves cancellation classification through publication failure", () => {
    const publication = newPublication();
    const error = publicationFailure(new DOMException("secret", "AbortError"), publication);
    expect(diagnosticSummary({ error, publication })).toMatchObject({
      error_category: "cancelled",
      publication_state: "not_published",
    });
  });
});
