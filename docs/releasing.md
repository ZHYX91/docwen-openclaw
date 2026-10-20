# Building and publishing releases

## Release assets

Maintainers can create a local package in an explicit directory outside the repository; the command compiles once in an owned temporary directory, runs actual `npm pack`, verifies the complete archive, and writes a stable checksum manifest. Successful work is removed; failed work retains a process-bound lease under the workspace temp directory (or `build` in a standalone clone). CI and release share `check:source` and then this single package build. Build artifacts transfer by exact ID with digest mismatch rejection; reproducibility comparisons are optional engineering checks.

```bash
npm run release:build -- /absolute/path/to/new-output-directory
```

The source gate and package producer check both build version fields against the resolved OpenClaw lock entry and the installed SDK before compilation. Archive verification uses that locked version, so a stale declaration cannot pass by agreeing with another declaration.

The local command creates exactly these release-build outputs:

- `openclaw-docwen-X.Y.Z.tgz`
- `SHA256SUMS`

The workflow adds `CANDIDATE.json`, which binds the version, tarball size and SHA-256 to its original repository, commit, full tree, ref, run and attempt. The tarball and this record receive provenance at build time. The immutable GitHub Release also publishes `DOCWEN-CORE.json`, pinning one supported numeric DocWen tag and the exact Linux and Windows asset identities, sizes and SHA-256 digests used by both packaged acceptance jobs. Published `SHA256SUMS` covers the other three assets.

Ordinary releases use a numeric `x.y.z` tag matching `package.json`: the workflow checks source, builds once, verifies both platforms, publishes and independently reads back the result. When Gateway integration, process/cancellation behavior, installation or shared runtime behavior changes, run representative real Gateway operations with the exact package and Core pair. Pure documentation or host-independent changes may omit Gateway execution with a recorded reason. Confirmed serious product defects affecting a release block that release. Missing host/tool evidence stays unverified and is assessed by risk; it does not automatically block publication or add a separate approval step. Claim acceptance only for observed passing scope. Package protocol checks do not prove Gateway behavior. Choose one suitable environment per affected platform, and expand only for distinct risks. Selected host acceptance uses this handoff:

1. Dispatch `Release` on the candidate branch with mode `candidate` and no artifact inputs. This checks source and retains one plugin package with its original provenance, without requiring an already published Core release. Save the artifact ID and digest from the run summary and use these exact bytes for the selected host checks.
2. Once the required Core release is public, dispatch mode `verify` with that `candidate_artifact_id` and `candidate_artifact_digest`. Both platform checks use the retained plugin bytes and one Core pin. Save the resulting publication artifact ID and digest. Omitting the artifact inputs in `verify` builds a fresh candidate first.
3. After the default branch accepts the candidate source, dispatch mode `publish` on that branch with the verified publication ID and digest. This reuses the archive and Core pin without recompiling or rerunning completed package tests. Source acceptance requires the original commit, its ancestry, or an identical full tree after squash/rebase; the numeric tag always points to the original candidate commit.

Artifact reuse verifies the exact ID, digest, repository, workflow attempt and successful producer job, then checks the original source provenance. A publication artifact remains usable if a later publishing job failed. Resume with that same publication artifact; an existing Core pin cannot silently resolve to a newer release. These modes support checks selected for the current change and do not add a standing manual approval requirement.

Publication requires GitHub Immutable Releases and an active repository ruleset that prevents updates or
deletion of numeric `x.y.z` tags. Final release state is read back through the REST `immutable: true` field.

Publication creates a draft first and resumes matching drafts by uploading only missing assets. Existing names with different bytes, incomplete uploads, or unexpected assets stop publication; nothing is overwritten or deleted. After a write loses its response, the publisher reads the release again before deciding whether the operation completed. A complete matching immutable release is a read-only no-op. One independent post-verification job downloads the public assets and checks their bytes and provenance.

After obtaining that exact tarball, install it with OpenClaw:

```bash
openclaw plugins install ./openclaw-docwen-X.Y.Z.tgz
```
