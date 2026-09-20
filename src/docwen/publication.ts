import { rm } from "node:fs/promises";

import { DocWenMachineError, type JsonObject } from "./machine-client.js";

export type PublicationWarning = {
  code: "backup_cleanup_failed" | "staging_cleanup_failed" | "lock_cleanup_failed";
  message: string;
  path?: string;
};

export type Publication = {
  state: "not_published" | "published" | "unconfirmed";
  retry: "review_before_retry" | "do_not_retry";
  warnings: PublicationWarning[];
  recovery?: { destination: string; backup?: string; staging: string };
};

export function newPublication(): Publication {
  return { state: "not_published", retry: "review_before_retry", warnings: [] };
}

export class OutputPublicationError extends DocWenMachineError {
  constructor(
    error: DocWenMachineError,
    readonly publication: Publication,
  ) {
    super(error.code, error.message, { ...error.details, publication });
  }
}

export function publicationFailure(error: unknown, publication: Publication): DocWenMachineError {
  const failure =
    error instanceof DocWenMachineError
      ? error
      : new DocWenMachineError(
          error instanceof Error && error.name === "AbortError"
            ? "docwen_machine_cancelled"
            : "docwen_output_failed",
          errorMessage(error),
          { system_code: error && typeof error === "object" && "code" in error ? error.code : undefined },
        );
  return new OutputPublicationError(failure, publication);
}

export function publicationResult(publication: Publication): JsonObject {
  return {
    status:
      publication.state === "unconfirmed"
        ? "unconfirmed"
        : publication.state === "not_published"
          ? "failed"
          : publication.warnings.length > 0
            ? "warning"
            : "success",
    publication,
  };
}

export async function cleanupPublicationPath(
  target: string,
  publication: Publication,
  code: PublicationWarning["code"],
  cleanup: (target: string) => Promise<void> = (target) => rm(target, { recursive: true, force: true }),
): Promise<void> {
  try {
    await cleanup(target);
  } catch (error) {
    publication.warnings.push({ code, message: errorMessage(error), path: target });
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
