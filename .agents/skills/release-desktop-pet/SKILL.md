---
name: release-desktop-pet
description: Prepare, review, build, verify, and publish a desk-pet Windows release. Use for version bumps, release PRs, NSIS packaging, GitHub tags, release assets, or release verification in this repository.
---

# Release Desktop Pet

Release the requested desk-pet version using the repository root `AGENTS.md` as the authoritative workflow. Read its complete **Release workflow** before taking release actions; if this skill and `AGENTS.md` differ, follow `AGENTS.md`.

## Execution

- Establish the requested version and scope from the user. Do not silently add unrelated changes.
- Inspect the current branch, worktree, version, existing tags and releases, and relevant signing configuration before mutating anything.
- Follow the branch, PR, `@codex review`, P0/P1 remediation, Windows CI, merge, packaging, checksum, tag, upload, and API-verification sequence in `AGENTS.md`.
- Treat pushes, PR changes, merges, tags, and GitHub Releases as external mutations. Perform only actions authorized by the user's release request and stop when new or replacement authority is required.
- Never overwrite an existing tag or Release asset unless the user explicitly authorizes replacement.
- Preserve unrelated user changes and do not release from a dirty worktree.

## Verification and handoff

Report the release URL, exact tag and commit, CI and review result, installer filename, observed Authenticode status, SHA-256, uploaded assets, and any verification that could not be completed. Never describe an unsigned binary as signed or infer success from a build log alone.
