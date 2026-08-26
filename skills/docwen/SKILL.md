---
name: docwen
description: Use DocWen Machine Protocol v1 through typed OpenClaw tools.
metadata: { "openclaw": { "requires": { "config": ["plugins.entries.docwen.enabled"] } } }
---

# DocWen

Use the registered `docwen_*` tools. Never construct a shell command for DocWen.

## Read first

1. Call `docwen_info` to verify Machine Protocol v1, Artifact Bundle v2, capability availability, and health.
2. Use `docwen_inspect` before choosing an operation for an unfamiliar input.
3. Use `docwen_resources` when a format, template, or numbering scheme must be selected.
4. `docwen_validate_markdown` is read-only: it returns the structured report and removes its request-owned staging area.

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

`docwen_number_markdown` requires exactly one of an explicit `outputDir` or explicit `inPlace=true`. Never infer in-place modification.

## Artifact semantics

The Bundle's `document`, `fragment`, and `resource` kinds and its relations describe output semantics. They do not authorize another product's page, node, or workspace structure. Preserve the complete committed Bundle directory unless the user explicitly requests a later import or cleanup operation.

## Availability

This plugin requires an operator-configured absolute `binaryPath`. It does not download or install DocWen. If the executable, protocol, capability, integrity check, or transaction fails, return the actionable error and stop.
