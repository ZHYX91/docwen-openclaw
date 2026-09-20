import { DocWenMachineError, type JsonObject } from "./machine-client.js";
import type { Publication, PublicationWarning } from "./publication.js";

const LOCAL_FAILURES: Record<string, { category: string; action: string }> = {};
function register(category: string, action: string, codes: readonly string[]): void {
  for (const code of codes) LOCAL_FAILURES[code] = { category, action };
}

register("invalid_request", "check_inputs", [
  "docwen_invalid_parameter",
  "docwen_invalid_input_role",
  "docwen_invalid_logical_path",
  "docwen_duplicate_input",
  "docwen_duplicate_logical_path",
  "docwen_invalid_pages",
  "docwen_path_not_absolute",
  "docwen_input_not_regular_file",
  "docwen_number_requires_one_output_mode",
  "docwen_number_remove_rejects_scheme",
]);
register("unsupported", "check_capabilities", [
  "docwen_capability_ambiguous",
  "docwen_capability_input_unsupported",
  "docwen_option_unsupported",
  "docwen_target_unsupported",
  "docwen_tool_unsupported",
  "docwen_media_type_unknown",
  "docwen_resource_not_found",
]);
register("unavailable", "check_dependencies", ["docwen_capability_unavailable"]);
register("configuration", "check_binary_configuration", [
  "docwen_binary_name_invalid",
  "docwen_binary_not_executable",
  "docwen_binary_not_file",
  "docwen_binary_not_found",
  "docwen_binary_path_must_be_absolute",
  "docwen_binary_path_required",
  "docwen_machine_spawn_failed",
]);
register("protocol", "check_compatibility", [
  "docwen_machine_incompatible_version",
  "docwen_machine_protocol_error",
  "docwen_machine_invalid_frame_header",
  "docwen_machine_invalid_frame_payload",
  "docwen_machine_truncated_frame",
  "docwen_validation_report_invalid",
  "docwen_bundle_shape_invalid",
]);
register("resource_exhausted", "review_limits", [
  "docwen_machine_output_limit",
  "docwen_machine_frame_too_large",
]);
register("integrity", "review_failure", ["docwen_machine_integrity_error"]);
register("timeout", "review_timeout", ["docwen_machine_timeout"]);
register("cancelled", "review_before_retry", ["docwen_machine_cancelled"]);
register("conflict", "prepare_current_source", ["docwen_source_changed"]);
register("conflict", "review_current_destination", ["docwen_output_changed"]);
register("conflict", "choose_new_output_directory", ["docwen_output_exists"]);
register("conflict", "wait_for_active_writer", ["docwen_output_busy"]);
register("invalid_request", "choose_new_output_directory", [
  "docwen_output_not_directory",
  "docwen_output_too_broad",
]);
register("output_failed", "review_failure", [
  "docwen_output_failed",
  "docwen_output_lock_failed",
  "docwen_commit_rollback_failed",
]);

const SYSTEM_FAILURES: Record<string, { category: string; action: string }> = {
  EACCES: { category: "permission", action: "check_path_permissions" },
  EPERM: { category: "permission", action: "check_path_permissions" },
  EROFS: { category: "permission", action: "choose_writable_destination" },
  ENOENT: { category: "invalid_request", action: "check_input_and_output_paths" },
  ENOSPC: { category: "resource_exhausted", action: "check_storage_space" },
  EDQUOT: { category: "resource_exhausted", action: "check_storage_space" },
  ENOTSUP: { category: "unsupported", action: "choose_supported_filesystem" },
  ENOSYS: { category: "unsupported", action: "choose_supported_filesystem" },
  EXDEV: { category: "unsupported", action: "choose_supported_filesystem" },
  ELOCKLOST: { category: "conflict", action: "review_current_destination" },
  EBUSY: { category: "conflict", action: "review_busy_paths" },
};

const REMOTE_CATEGORIES = new Set([
  "invalid_request",
  "unsupported",
  "unavailable",
  "dependency",
  "security",
  "conflict",
  "timeout",
  "resource_exhausted",
  "conversion_failed",
  "internal",
]);
const REMOTE_ACTIONS: Record<string, string> = {
  invalid_request: "check_inputs",
  unsupported: "check_capabilities",
  unavailable: "check_dependencies",
  dependency: "check_dependencies",
  conflict: "prepare_current_source",
  timeout: "review_timeout",
  resource_exhausted: "review_limits",
};
const WARNING_CODES = new Set(["backup_cleanup_failed", "staging_cleanup_failed", "lock_cleanup_failed"]);

function member(value: unknown, values: Set<string>): string | undefined {
  return typeof value === "string" && values.has(value) ? value : undefined;
}

function boundedCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

/** Shareable snapshot. Never serialize errors, result payloads or arbitrary fields here. */
export function diagnosticSummary({
  error,
  publication,
  warnings = publication?.warnings ?? [],
  outputCount = 0,
  diagnosticCount = 0,
}: {
  error?: unknown;
  publication?: Publication;
  warnings?: PublicationWarning[];
  outputCount?: number;
  diagnosticCount?: number;
} = {}): JsonObject {
  const machineError = error instanceof DocWenMachineError ? error : undefined;
  // Binary resolver errors carry an exact local constant as their message.
  // Matching the complete finite constant does not export arbitrary error text.
  const candidate = machineError?.code ?? (error instanceof Error ? error.message : undefined);
  const local =
    typeof candidate === "string" && Object.hasOwn(LOCAL_FAILURES, candidate)
      ? LOCAL_FAILURES[candidate]
      : undefined;
  const remote = typeof candidate === "string" && candidate.startsWith("docwen_machine_remote:");
  const reportedCategory = remote ? member(machineError?.details.category, REMOTE_CATEGORIES) : undefined;
  const systemCandidate =
    machineError?.details.system_code ??
    (error && typeof error === "object" && "code" in error ? error.code : undefined);
  const system =
    !remote && typeof systemCandidate === "string" && Object.hasOwn(SYSTEM_FAILURES, systemCandidate)
      ? SYSTEM_FAILURES[systemCandidate]
      : undefined;
  const cancelled = error instanceof Error && error.name === "AbortError";
  const category =
    reportedCategory ?? system?.category ?? local?.category ?? (cancelled ? "cancelled" : "unknown");
  const summary: JsonObject = {
    schema: "docwen.openclaw-diagnostic.v1",
    outcome: error !== undefined ? "failed" : warnings.length ? "warning" : "success",
    publication_state: publication?.state ?? "not_applicable",
    retry: publication?.retry ?? "review_before_retry",
    output_count: boundedCount(outputCount),
    diagnostic_count: boundedCount(diagnosticCount),
    warning_count: boundedCount(warnings.length),
    warning_codes: [...new Set(warnings.flatMap(({ code }) => member(code, WARNING_CODES) ?? []))],
    recovery_action:
      error !== undefined
        ? (system?.action ??
          local?.action ??
          (reportedCategory ? REMOTE_ACTIONS[reportedCategory] : undefined) ??
          "review_failure")
        : warnings.length
          ? "review_cleanup"
          : "none",
  };
  if (error !== undefined) {
    summary.error_code = local ? candidate : remote ? "remote_error" : cancelled ? "cancelled" : "unknown";
    summary.error_category = category;
    if (system) summary.system_code = systemCandidate;
    if (remote && typeof machineError?.details.retryable === "boolean") {
      // A producer's claim cannot authorize another local write.
      summary.reported_retryable = machineError.details.retryable;
    }
    const timeout = machineError?.details.timeoutMs;
    if (
      candidate === "docwen_machine_timeout" &&
      typeof timeout === "number" &&
      Number.isSafeInteger(timeout) &&
      timeout >= 0 &&
      timeout <= 86_400_000
    ) {
      summary.timeout_ms = timeout;
    }
  }
  if (publication?.state === "published") {
    summary.outcome = publication.warnings.length ? "warning" : "success";
    summary.retry = "do_not_retry";
    summary.recovery_action = publication.warnings.length ? "review_cleanup_keep_outputs" : "open_result";
  } else if (publication?.state === "unconfirmed") {
    summary.outcome = "unconfirmed";
    summary.retry = "do_not_retry";
    summary.recovery_action = "review_recovery_paths";
  }
  return summary;
}
