# Project instructions

## Release workflow

Use this workflow for every desk-pet release unless the user explicitly requests a different scope.

1. Start from an up-to-date `main` and create a `codex/<version>-<topic>` branch. Do not release from a dirty working tree.
2. Update `package.json` and `package-lock.json` to the requested version with `npm version <version> --no-git-tag-version`.
3. Run `npm run check`. For Windows/Electron changes, also verify the relevant unpacked or packaged runtime path.
4. Commit and push the branch, create a PR against `main`, and comment `@codex review`.
5. Fix every P0 and P1 Codex finding. Fix lower-severity findings when the change is small and release-safe. Re-run `npm run check` after review fixes.
6. Require the Windows CI job to pass on the final commit before merging. Use a merge commit, matching the repository's existing history.
7. Build the Windows NSIS installer from the merged `main` with `npm run dist:win`.
8. This project currently permits unsigned Windows releases: `build.win.forceCodeSigning` is `false`. Verify the final installer with `Get-AuthenticodeSignature`; it must report the observed status honestly in release notes. Never claim an unsigned binary is signed.
9. Compute SHA-256 for every uploaded installer with `Get-FileHash -Algorithm SHA256`.
10. Create and push annotated tag `v<version>` at the verified `main` commit. Create a non-draft GitHub Release, upload the installer, blockmap, and `latest.yml`, and include features, fixes, unsigned-publisher warning, and installer SHA-256.
11. Verify through the GitHub API that the tag, release target, asset names, sizes, and digests are correct. Confirm `main` CI passes after merge and leave the local worktree clean.

Never overwrite an existing tag or Release asset silently. If a version already exists, stop and ask for a new version or explicit replacement authority.
