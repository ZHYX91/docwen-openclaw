---
name: docwen
description: Use DocWen Machine Protocol v2 through typed OpenClaw tools.
metadata: { "openclaw": { "requires": { "config": ["plugins.entries.docwen.enabled"] } } }
---

# DocWen

Use the registered `docwen_*` tools. Never construct a shell command for DocWen.

## Read first

1. Call `docwen_info` to verify Machine Protocol v2, Artifact Bundle v3, capability availability, and health.
2. Use `docwen_inspect` before choosing an operation for an unfamiliar input.
3. Use `docwen_resources` when a format, template, optimization, or numbering scheme must be selected.
4. When a template is required, call `docwen_resources` with `kind="templates"` and pass the returned canonical resource `id` to `docwen_convert.template`. Never pass a file path or display name.
5. `docwen_validate_markdown` is read-only: it returns the structured report and removes its request-owned staging area.

## Write safety

The following tools are optional because they persist or replace files:

- `docwen_convert`
- `docwen_number_markdown`
- `docwen_merge_pdfs`
- `docwen_split_pdf`
- `docwen_merge_tables`
- `docwen_merge_images_to_tiff`

Before calling a write tool:

- confirm every input and `outputDir` is an exact absolute path on the OpenClaw Gateway host;
- for typed `inputs`, provide every `file`, `kind`, `role`, and `logicalPath` explicitly. `logicalPath` is a unique case-sensitive relative POSIX path in the request virtual root; never infer it from a physical parent directory, CWD, or sibling file;
- use `source` for a primary document or standalone resource. Use `linked_resource`, `bibliography`, and `citation_style` only with `kind="resource"`;
- for Markdown-to-DOCX, pass exactly one `neutral_document` with `kind="document"` and one `numbering_export_plan` with `kind="resource"`; do not add a `source` or any legacy sidecar role;
- treat `outputDir` as one complete Artifact Bundle, not as a single output filename;
- do not set `overwrite=true` unless the user explicitly authorized replacement of that exact directory;
- preserve the caller's input order for merge operations;
- do not retry a write automatically after it starts;
- report the preferred artifact and every committed artifact from the structured result.

`docwen_number_markdown` requires exactly one of an explicit `outputDir` or explicit `inPlace=true`. Never infer in-place modification. An in-place operation is bound to the source version read at task start; if the source changes while DocWen is preparing the result, report the conflict and leave the newer file untouched.

Read `status` and `publication.state` before reporting a write result. `published` results include valid output paths even when `status="warning"`; report `publication.warnings` without repeating the write. `unconfirmed` means publication or restoration could not be confirmed: preserve and report `publication.recovery`, and do not retry or delete its paths automatically. `not_published` means no new output was committed; review the reported failure before another attempt. Always honor `publication.retry`; cleanup failures never authorize another write.

When the user needs to preview, copy or share diagnostics, show only the returned `diagnostic_summary` as JSON and use exactly that object for copying. Do not add raw errors, full tool results, reports, paths, configuration, document text or command lines. Operational output and recovery paths remain available separately for the current task; they are not part of the shareable diagnostic summary.

Use `diagnostic_summary.recovery_action` to explain the next step. Reprepare a changed source before a new attempt and invalidate old report locations or repairs. Review a changed destination, choose another output directory for an existing target, inspect missing dependencies, or wait for an active writer as applicable. These actions and the producer's `reported_retryable` flag do not authorize automatic writes, overwrites or deletion. A read failure has no output publication and returns a structured failed result.

## Artifact semantics

The Bundle's `document`, `fragment`, and `resource` kinds and its relations describe output semantics. They do not authorize another product's page, node, or workspace structure. Preserve the complete committed Bundle directory unless the user explicitly requests a later import or cleanup operation. Use the returned Bundle for hashes and relationships; the output contains only declared logical artifacts, with no hidden consumer manifest.

A DocWen template is a resource identity, not a host path. Treat `origin`, `is_default`, and other template metadata returned by newer DocWen builds as descriptive facts; the canonical `id` remains the only value sent back in conversion requests.

## Availability

This plugin requires an operator-configured absolute `binaryPath`. It does not download or install DocWen. If the executable, protocol, capability, integrity check, or transaction fails, return the actionable error and stop.
