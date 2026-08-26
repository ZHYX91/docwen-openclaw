# Changelog

## Unreleased

- Changed post-publication verification to use GitHub's REST `immutable: true` field instead of the removed GraphQL field and added a manual CI recovery trigger.

## 2.0.0 - 2026-08-26

- Replaced CLI argument adapters with DocWen Machine Protocol v1 over framed stdio.
- Added strict capability discovery, task lifecycle, cancellation, and Artifact Bundle v2 validation.
- Added typed OpenClaw tools with explicit logical input paths and transactional output commits.
- Added Windows and Ubuntu packaged-DocWen acceptance gates.
- Added deterministic package construction, clean-build byte comparison, provenance attestations, and immutable GitHub Release verification.
- Bound both platform gates to one resolved immutable DocWen release and publish its exact tag, asset identities, sizes, and SHA-256 digests with the plugin.
