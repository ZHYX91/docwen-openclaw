# Changelog

## Unreleased

## 3.0.0 - 2026-09-20

- Update the build/acceptance SDK to OpenClaw 2026.9.5 and the test framework to Vitest 4.1.11; refresh vulnerable development dependencies.

- Require DocWen 0.12.0 or later, Machine Protocol v2 and Artifact Bundle v3; reject older protocols instead of falling back.
- Validate canonical template IDs, origin, defaults, capability-selected options and document optimizations. Preserve the selected profile when starting DocWen.
- Reuse one initialized process for each operation's discovery, planning and execution, with per-query deadlines and the overall task budget intact.
- Validate malformed framing, UTF-8, task ownership and Bundle topology against shared, provenance-bound conformance fixtures.
- Commit complete output directories without hidden manifests. Use OS-owned IPC locks and atomic no-replace publication on Windows and Linux; preserve published outputs on cleanup warnings and expose recovery paths for unconfirmed results.
- Provide bounded diagnostic summaries and cause-specific recovery advice without document text, paths or raw remote errors.
- Build one package per release, reuse exact candidates across verification and publication, pin one Core release, and resume matching drafts without replacing assets. Verify public bytes and provenance independently.
- Changed post-publication verification to use GitHub's REST `immutable: true` field instead of the removed GraphQL field and added a manual CI recovery trigger.

## 2.0.0 - 2026-08-26

- Replaced CLI argument adapters with DocWen Machine Protocol v1 over framed stdio.
- Added strict capability discovery, task lifecycle, cancellation, and Artifact Bundle v2 validation.
- Added typed OpenClaw tools with explicit logical input paths and transactional output commits.
- Added Windows and Ubuntu packaged-DocWen acceptance gates.
- Added deterministic package construction, clean-build byte comparison, provenance attestations, and immutable GitHub Release verification.
- Bound both platform gates to one resolved immutable DocWen release and publish its exact tag, asset identities, sizes, and SHA-256 digests with the plugin.
