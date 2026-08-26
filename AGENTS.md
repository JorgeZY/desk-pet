# Repository Guidelines

## Project Structure & Module Organization

`src/main/` owns Electron lifecycle, runtimes, storage, and privileged IPC. `src/preload/` exposes the narrow `contextBridge` API; keep system access out of the sandboxed React code in `src/renderer/`. Shared IPC types and helpers live in `src/shared/`. Tests are colocated as `*.test.ts(x)`. Use `assets/` for source artwork/icons, `src/renderer/public/` for served media, `scripts/` for model helpers, and `docs/` for design notes. Build outputs and local `models/` contents are not source.

## Build, Test, and Development Commands

- `npm ci` installs the locked Node dependencies (Node 22.12+).
- `npm run dev` starts the TypeScript/Vite watchers and Electron.
- `npm run typecheck` checks the strict main and renderer TypeScript projects.
- `npm test` runs the Vitest suite once.
- `npm run build` type-checks and builds main and renderer outputs.
- `npm run check` runs the full pre-PR validation sequence.
- `npm run dist:win` creates the Windows x64 NSIS installer in `release/`.

## Coding Style & Naming Conventions

Use strict TypeScript/TSX, two-space indentation, semicolons, double quotes, and existing trailing-comma patterns. Use `PascalCase` for components/types, `camelCase` for functions/variables, and kebab-case filenames (`live-caption-runtime.ts`). Type IPC payloads through `src/shared/types.ts`. No formatter or linter is configured; match nearby code.

## Testing Guidelines

Use Vitest and `vi` for mocks. Place tests beside the unit and name behavior explicitly. Add regression coverage for IPC validation, migrations, runtime states, and UI accessibility. There is no numeric coverage gate; behavior changes should include relevant tests. Run `npm run check` before a PR.

## Commit & Pull Request Guidelines

Follow Conventional Commits: `feat: add Windows live captions`, `fix: preserve live caption preferences`, or `chore: document release workflow`. Keep commits scoped and imperative. PRs must explain impact and validation, link issues when applicable, and include screenshots for visual changes. Windows CI must pass; use a merge commit.

## Security, Configuration & Releases

Bind llama.cpp to `127.0.0.1` and expose privileges only through validated preload IPC. Do not commit models, generated `.codex/` state, secrets, or machine-specific paths. Development models belong in `models/`; packaged models live beside the executable.

For releases, work on `codex/<version>-<topic>`, run `npm run check`, open a PR, request `@codex review`, and fix all P0/P1 findings before merge. Build from merged `main`. Windows releases are intentionally unsigned (`forceCodeSigning: false`): report that status honestly, verify Authenticode, publish SHA-256 hashes, and never replace an existing tag or asset without explicit approval.
