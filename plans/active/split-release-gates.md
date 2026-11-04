# Split the release gates

The branch release gate is too expensive in both billed minutes and wall-clock
latency. `release-gate.yml` fans out into 9 parallel lanes (~19 runners), and
`deploy.yml` calls the whole gate on every push to `main`, so the entire game
suite re-runs on every merge even when only platform code changed.

The split keeps the **games** (`ar-eye-hunter-v1`, `relic-hunters-v1`, and their
servers `ar-eye-hunter-server-v1` + `relic-hunter-server-v1`) in their own
pipeline: still required on branch pull requests, but not part of the deploy
gate.

Decisions already made (accepting the residual risk):

- **Depth is minimal.** Only browser lanes, game builds, and game-server checks
  move. `typecheck` and `unit` stay monolithic in the platform gate.
- **`relic-hunter-server-v1` is pure game.** It moves fully to the game gate,
  so its Deno check/test no longer runs on the deploy path. `deploy-relic-api`
  still runs `prisma validate/migrate` + `deno deploy`, so syntax/graph errors
  are caught, but runtime regressions are caught only on the PR. A cheap
  mitigation (keep its `deno task check` in the platform `checks` lane) is
  deliberately deferred; see "Later".

Deploy-surface finding that shapes the partition: `deploy.yml` deploys exactly
three Deno apps — `api-v1` (rallar-server), `rallar-black-box-control-server`
(rallar-bb-server), and `relic-hunter-server-v1` (relic-hunters). The game
browser apps and `ar-eye-hunter-server-v1` are not deployed by GitHub Actions,
so most game validation serves zero deploy purpose.

## Slice 1 — extract the games gate and slim the platform gate

Add `.github/workflows/games-release-gate.yml` with three jobs, all using
`./.github/actions/release-gate-setup` and obeying the runtime governance rules
(checkout@v7 first, no direct `actions/cache@v6`, pinned action versions):

- `checks-games` — `npm run build:ar-eye-hunter-v1`, `npm run build:relic-hunters-v1`,
  `(cd apps/ar-eye-hunter-server-v1 && deno task check)`,
  `(cd apps/relic-hunter-server-v1 && deno task check)`.
- `deno-games` — `npm run test:deno:games` (new script, below).
- `e2e-game-rooms` — the 7-lane matrix moved verbatim from `release-gate.yml`.

Slim `.github/workflows/release-gate.yml`:

- `checks`: drop `build:ar-eye-hunter-v1` and `build:relic-hunters-v1`; drop
  the two game-server lines from the "Check Deno apps" step, keeping shared-test,
  `api-v1`, and `rallar-black-box-control-server`.
- `deno`: replace `npm run test:deno` with `npm run test:deno:platform`.

Add package.json scripts, keeping `test:deno` as the full local convenience:

- `test:deno:platform` — api-v1 + control-server tests + the shared-test
  scenario files (`scenario-black-box-rtc-config`, `rtc-client-provider`,
  `hosted-rallar/controller/authenticated-ws-smoke`).
- `test:deno:games` — relic-hunter-server-v1 `check`+`test` +
  ar-eye-hunter-server-v1 `check`+`test`.

Update `packages/tests/repo/release-gate-lanes.test.ts` to assert the union of
both gate files covers `test:ci`, and add a sibling
`games-release-gate-lanes.test.ts` for the game gate's lanes (blocking only,
in-memory profile, no credential secret).

Direct check: `npx vitest run packages/tests/repo/release-gate-lanes.test.ts packages/tests/repo/github-actions-runtime-governance.test.ts`.
Affected validation: `npm run test:unit` and `npm run check:test-reachability`.

## Slice 2 — require both gates on branches, path-aware skip

In `.github/workflows/branch-release-gate.yml`:

- Add a `game-changes` job that computes the changed-path set against the PR
  base and outputs `run_games`. Because the games depend on `packages/shared*`,
  the game gate runs on any diff touching game paths **or** shared packages; it
  skips only when the diff is exclusively platform (`apps/api-v1`,
  `apps/rallar-black-box*`, `scripts/`, `.github/`, `docs/`, lockfiles).
- Add a `games-release-gate` job that calls `games-release-gate.yml` under
  `if: needs.game-changes.outputs.run_games == 'true'`.
- Add a `games-release-result` job (`if: always()`) that reports success when
  the gate was skipped, so the required status check always resolves.
- Extend `branch-release-result` to depend on and aggregate the games result.

Extend `scripts/validation-evidence.mjs` `conclude` (and
`scripts/validation-evidence/branch-release-result.mjs`) to accept a second
gate's result plus a `skipped` state. Update
`packages/tests/repo/validation-evidence/validation-evidence-workflow.test.ts`,
`packages/tests/repo/alm-observation-workflow.test.ts`, and
`packages/tests/repo/github-actions-runtime-governance.test.ts` for the new
composition. Update `scripts/check-test-reachability.mjs` /
`tests/manual-suites.json` so the game browser specs are owned by the new gate.

Update `CLAUDE.md`'s Git/lane table so the blocking-lane description stays
truthful after the split.

Direct check: `npx vitest run packages/tests/repo/validation-evidence packages/tests/repo/alm-observation-workflow.test.ts`.
Affected validation: `npm run test:unit` and `npm run check:test-reachability`.

## Later, not in the next two slices

- Split `unit` and `typecheck` by surface (full-depth split) once slices 1–2
  prove out and only if the residual deploy cost warrants it.
- Keep `(cd apps/relic-hunter-server-v1 && deno task check)` in the platform
  `checks` lane as a deploy safety net (the deferred mitigation).
- Review `docs/production-deployment.md` and other docs that name the gate
  composition for a one-line note that games no longer run on the deploy path.
- Narrow path-skip so a shared-web-only change does not always trigger the game
  gate (YAGNI until the skip is demonstrably under-firing).

## Closure

Each slice reviews every touched workflow, script, and test file in full;
remediation that pulls in a support file enters the same closure recursively.
Untouched product code stays outside closure. Report each validation command as
passed, failed, or skipped.
