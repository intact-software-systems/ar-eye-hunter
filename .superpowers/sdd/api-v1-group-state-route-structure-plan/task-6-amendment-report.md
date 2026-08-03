# Task 6 Amendment Report

## Scope and starting point

- Branch: `codex/api-v1-group-state-route-structure`
- Starting head: `073d3493e4708b77c6403bc54b035f7dc8ef1dfa`
- Starting tree: `b836c8a8b85f7f311212cc8e66092c35381962c2`
- Exact changed-style base: `0a52ecee39181c7784fa6b777270f8a59bc33c00`
- Remote `origin/codex/api-v1-group-state-route-structure` matched the starting
  head; the starting worktree was clean.

The amendment changes only the authorized lineage/provenance governance,
governance-test registration, named translator output contract, and directly
affected plan evidence. It makes no checker, parser, schema, rule, severity,
dependency, workflow, HTTP, authentication, AppInbox, server, persistence, or
canonical-ordering change.

## RED evidence

`npm run check:repo-style:changed -- 0a52ecee39181c7784fa6b777270f8a59bc33c00`
exited 1 before implementation with exactly 27 findings: seven
`boundary.unknown`, three `route.handler-length`, and seventeen
`function.output-contract` findings. The latter named all seventeen command
helpers in `to-group-state-command.ts`.

The new focused provenance test was then added before lineage artifacts. Its
first run exited 1: two assertions failed with missing manifest file errors and
one assertion failed because the provenance document was absent. Its fail-closed
fixture also exercises missing, additional, reordered, duplicated, and changed
lineage data.

## Implemented reconciliation

- The version-1 manifest has exactly the two authorized, ordered lineage rows:
  `group-state-routes.ts` blob `aced85e681666edde414be27b68278ddff53fc42`
  targets only the request reader and presence registrar; the route-error blob
  `cd58fb90d1836c33be35f417a6a04376150a2327` targets only the canonical error
  owner.
- The provenance audit independently checks the manifest's exact inventory and
  source blobs with Git, target existence, ordering, duplicate exclusion,
  compatibility files, and no capacity for translator/contracts/composition or
  navigation/analysis tests. It names predecessor and target source spans and
  records one human disposition for each of the ten inherited warnings.
- `GroupStateCommand<TType>` now names the output relationship between each
  `AppInboxType` discriminant and the corresponding
  `AuthenticatedGroupMutationEnqueue` member. All seventeen helpers use it;
  fields, field order, validation sequence, actor/session overrides, request
  identity, and runtime behavior remain unchanged.
- The plan records the temporary-ratchet owner/removal condition, the amendment,
  the focused test/format scope, and a future PR B search that restricts itself
  to executable module specifiers rather than historical Markdown prose.

## Source-span and behavior evidence

- Request reader: predecessor `readRequestWithRequestId<T>` lines 1036-1051
  maps to `GroupStateRouteRequestContext` and
  `readGroupStateRouteRequest<T>` lines 3-20; only its inherited JSON-boundary
  warning receives capacity.
- Presence routes: predecessor callbacks lines 778-913 map to canonical callback
  lines 47-171; all three 35-line handler warnings are individually recorded.
- Error owner: predecessor and target both cover lines 1-136; the six inherited
  `unknown` positions (35, 37, 63, 81, 106, 134) are individually recorded.
- Semantically new code, including `to-group-state-command.ts`, never appears
  in the manifest and receives no inherited capacity.

## GREEN validation

- Focused provenance test: 4 passed.
- Routing/navigation batch: 26 files and 364 tests passed.
- API-v1 focused Deno route/runtime/OpenAPI batch: 74 passed.
- `deno fmt --check` and `deno task check`: passed.
- `npm run test:repo-governance`: 16 files and 201 tests passed.
- Exact-base changed-style comparison: passed with no new or worsened findings.
- Prettier and `git diff --check`: passed.
- Protected plan SHA-256 remained
  `0eea5bdfae06aa25005790220b9331ad721eaf5c917b50c8693cef4d5b185189`.
- A direct `tsc` check of the new Vitest file passed with explicit
  `--ignoreConfig`; the initial attempt without that flag stopped with TS5112
  because TypeScript refuses command-line files while a repository config is
  present. It did not indicate a source failure.

`npm run check:repo-style -- --root apps/api-v1/src/group-state` remained
warning-only and reported only the ten inherited findings. Their audit
dispositions are: accepted for PR A because they are mechanical predecessors;
Task 7 owns any alignment. The output-contract checker reported none.

Final Task 6 completion gates, black-box gates, push, PR update, workflow
dispatch, and publication were intentionally not run.

## Candidate tree and commit status

The staged candidate tree and local commit are recorded immediately after this
report is finalized. The exact commit cannot be embedded in its own committed
content without a self-referential Git hash; the task handoff supplies it.

## Changed paths

- `apps/api-v1/src/group-state/to-group-state-command.ts`
- `package.json`
- `packages/tests/repo/api-v1-group-state-route-lineage-provenance.test.ts`
- `plans/repo-style-lineages/api-v1-group-state-route-structure.json`
- `plans/repo-style-lineages/api-v1-group-state-route-structure-provenance.md`
- `plans/api-v1-group-state-route-structure-plan.md`
- `.superpowers/sdd/api-v1-group-state-route-structure-plan/task-6-amendment-report.md`
