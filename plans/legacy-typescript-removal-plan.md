# Legacy TypeScript Removal Implementation Plan

Planning-only deliverable. No deletion has been performed. This plan was authored against
default-branch base `main@1e5f5e55e6ff94c016bfe2cc11af92952a30e32f` ("Refactor authoritative
group-topology persistence ownership (#151)"). Re-validate against the current `main` SHA before
each executed batch per the plan-revalidation procedure in
`.agents/skills/publishing-plan-progress/SKILL.md`.

## Global Constraints

- **Definition of legacy (user-approved, evidence-based):** a file is legacy only when reference
  evidence proves it — class A (unreferenced anywhere), class B (referenced only by other A/B
  files), class C (reachable only through test code). Superseded-but-consumed or
  doctrine-documented surfaces are class D decision items, never scheduled deletions.
- **Breaking-change authorization (user-approved):** removing exported symbols that nothing
  references is in scope. Every shared-web surface removal updates
  `packages/tests/shared-web/shared-web-public-api-snapshots.test.ts` fixtures in the same commit —
  that test pins public files by explicit relative-path lists.
- Deletion scope is `packages/**` and `apps/api-v1/**`; the green-tree obligation covers **every
  app in both runtimes**, because `packages/**` is shared by all of them.
- Never weaken governance or scale gates to make a batch pass: navigation-map integrity tests,
  lineage/ratchet inventories, `test:api-v1:black-box:postgres:medium-scale` constants, and
  public-API snapshot semantics may only be edited to remove entries for files deleted in the same
  commit.
- The mutation doctrine is untouched: no batch changes any AppInbox path, transaction shape, or
  route behavior. Every scheduled file is unreferenced by production code at the recorded base.
- Dedicated tests of deleted code are deleted in the same commit (class C); shared test files that
  merely mention a deleted file are trimmed, not deleted.
- One-off sweep tooling stays in the session scratchpad; no dead-code tooling is added to the repo.
- Per `AGENTS.md`: no commit to or push of `main` without explicit per-operation approval; execution
  happens on a feature branch with the draft-PR lifecycle from `publishing-plan-progress`.

## 1. Scope, Authorization, And Success Boundary

### 1.1 Success boundary

The plan is complete when every batch in section 5 whose disposition is DELETE (or
DELETE-AFTER-VERIFY with a delete outcome) has landed, every class D item in section 7 has a
recorded user decision (deleted, kept, or deferred to a follow-up issue), and the completion gates
in section 8 pass on the final tree.

### 1.2 What this plan does not do

- It does not remove or migrate any file with live production consumers.
- It does not touch REST routes, recipes, or `resources/api-v1-openapi.yaml` (no scheduled file is
  route-reachable; the one API-surface legacy marker found, `unsafeLegacyCollectionCompaction`, is
  recorded as an observation in 7.6, not scheduled).
- It does not delete the `packages/shared/ontology/**` tree (see 7.5 — staged feature, not legacy).

## 2. Inventory Method And Evidence

### 2.1 Method

A file-level import graph was built over every tracked `*.ts/*.tsx/*.mts/*.mjs/*.js` file (3,000+
files), with edges from static imports, `export ... from`, dynamic `import()`, `require()`, and
`new URL(...)` references, plus root edges from: all four alias maps (root `tsconfig.json`, root
`deno.json`, `vitest.config.ts`, per-app `deno.json` including `@/` self-aliases), `index.html`
script tags, every workspace `package.json` script body, `deno.json` tasks, and
`.github/workflows/**` file-path tokens. Production reachability was computed from app entry
points, Deno task entries, Vite HTML entries, invoked `scripts/**`, and tool configs — excluding
test files; test reachability from `packages/tests/**`, `tests/**`, `apps/*/test/**`, and
`*.test.ts`/`*.spec.ts` files.

Classification: in production reach → alive; reachable only via tests → C; unreachable with zero
importers → A; unreachable with only dead importers → B. Every candidate then passed a second pass:
repo-wide string search for its basename across all tracked text files (catches string-keyed and
config-keyed usage), `git log -1` dating, and an `@deprecated`/legacy-marker sweep.

### 2.2 Re-run pitfalls (authoritative for execution sessions)

Execution must re-run the sweep at its own base SHA and must reproduce these lessons:

1. **`deno fmt` wraps long import specifiers with a backslash-newline inside the string literal**
   (see `apps/api-v1/src/middleware.ts:37-40`). A naive regex misses these edges; two files were
   false-classified dead until fixed. Strip `\`-newline from specifiers before resolving.
2. **Convention-loaded files have no importers**: `prisma.config.ts` (Prisma CLI), `*.d.ts` ambient
   declarations (tsconfig `include`), `*.typecheck.ts` compile-only assertions (root `typecheck`
   runs `tsc -p packages/shared/tsconfig.json`, whose `include` is `**/*.ts`).
3. **String-pinned files**: governance ratchet inventories and evidence-source lists reference
   files by path string (e.g. `group-state-server-source-ratchet-inventory.ts`).
4. **Class C splits in two**: dedicated coverage of a dead feature (delete both) versus live test
   infrastructure consumed by suites that test alive behavior (keep). The recipe-console fixtures
   are the canonical example of the second kind.

### 2.3 Result summary at the recorded base

989 in-scope production files; 45 raw candidates (~5.0k lines) after the parser fix. Dispositions
after the verification passes: 9 confirmed-keep false positives, 17 scheduled deletions (with 8
dedicated test files), 3 delete-after-verify, 16 class D decision files. The repo is well-kept;
this is a bounded cleanup, not a purge.

## 3. Confirmed Keeps (False Positives — Do Not Delete)

| File                                                                                                                       | Why it is alive despite zero import edges                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api-v1/prisma.config.ts`                                                                                             | Prisma CLI convention file; filename governance-pinned in `packages/tests/repo/repo-style-layout-rules.test.ts`.                                                                                 |
| `apps/api-v1/src/db/read-pglite-black-box-evidence.ts`                                                                     | String-pinned in `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-source.ts:304` and the source-ratchet inventory.                                        |
| `packages/shared/rallar-match/results.typecheck.ts`                                                                        | Compile-only type assertion; loaded by root `npm run typecheck` via `packages/shared/tsconfig.json` include.                                                                                     |
| `packages/shared-test/deno-globals.d.ts`                                                                                   | Ambient Deno globals for `npm run check:shared-test` (`tsc -p packages/shared-test/tsconfig.json`, include `**/*.d.ts`).                                                                         |
| `packages/shared-test/rallar-bb-test/recipe-console-control-scale-fixture.ts` (+`-retention.ts`, `-tune-scale-fixture.ts`) | Live test infrastructure: consumed by running Playwright specs (`tests/playwright/rallar-black-box/recipe-console-*.spec.ts`) and vitest suites that test the recipe-console UI, which is alive. |
| `packages/shared-server/rallar-system/topology/config/maintenance/backfill-group-topology-config-generations.ts`           | Alive: imported by `apps/api-v1/src/middleware.ts:39` and `group-topology-management-service.ts` via wrapped specifiers (pitfall 2.2.1).                                                         |
| `packages/shared-server/rallar-system/topology/config/mutation/read-topology-config-mutation.ts`                           | Alive: same wrapped-specifier imports.                                                                                                                                                           |

## 4. Exact Current And Target Trees (Scheduled Batches)

Only affected directories are shown; `[D]` marks a file deleted by the batch, `[T]` a trimmed file.

### 4.1 Batch 1 — api-v1, shared-server, shared mechanical dead code

```text
apps/api-v1/src/
  utils.ts                                          [D] 33L, class A
  services/state-sync-service.ts                    [D-after-verify] 22L, class C
  db/api-v1-rtc-topology-cluster-transport.ts       [D] 60L, class C
packages/shared-server/rallar-system/
  admin-operations/crdt-admin-validation.ts         [D] 29L, class A (superseded per 2026-07-10 hardening history)
  services/IdempotentService.ts                     [D] 59L, class A (pre-style-migration PascalCase filename)
  services/in-process-mutation-lane.ts              [D] 58L, class C
packages/shared/cache/
  RepositoryTokens.ts                               [D-after-verify] 25L, class C
packages/tests/
  api-v1/rtc-topology-cluster-transport.test.ts     [D] dedicated coverage
  shared-server/in-process-mutation-lane.test.ts    [D] dedicated coverage
  shared/repository-layer.test.ts                   [T] remove RepositoryTokens usage
apps/api-v1/test/services/
  client-state-service.test.ts                      [T] replace state-sync-service test usage
  group-state-service.test.ts                       [T] replace state-sync-service test usage
```

Verify-first steps: (a) `state-sync-service.ts` — inspect how the two api-v1 service tests use it;
if it is only test scaffolding, inline a local stub in those tests and delete the file; if it turns
out to be a compatibility shim documented anywhere, move it to batch 5. (b) `RepositoryTokens.ts` —
confirm `repository-layer.test.ts` tests it directly (legacy twin → delete both parts) rather than
using it as infrastructure for alive repository code.

### 4.2 Batch 2 — shared-graph dead cluster

```text
packages/shared-graph/
  mod.ts                                            [D] 39L, class A (barrel with zero importers; apps deep-import)
  crdt/graph-crdt.ts                                [D] 408L, class C
  mesh/remove-mesh-algs.ts                          [D] 207L, class C
  remove/remove-dynamics-main.ts                    [D] 62L, class C
packages/tests/shared-graph/
  graph-crdt.test.ts                                [D] dedicated coverage
  remove-mesh-algs.test.ts                          [D] dedicated coverage
  remove-dynamics-main.test.ts                      [D] dedicated coverage
```

Doc updates in the same commit: `packages/shared-graph/architecture.md` and the `CLAUDE.md` /
`AGENTS.md` sentence listing "graph CRDT" as a shared-graph responsibility. Historical `plans/*`
references stay untouched (plans are records).

### 4.3 Batch 3 — shared-test dead harness code

```text
packages/shared-test/
  black-box-runner/browser/rallar-browser-spike.mts          [D] 794L, class A (2026-05 spike)
  black-box-runner/browser/rallar-browser-spike.example.json [D] companion config
  black-box-runner/docs/black-box-rtc-implementation-plan.md [T] remove spike rows
  json-compare/json-compare.ts                               [D] 82L, class C (canonical CompareJson.ts stays)
  rallar-bb-test/distributed-artifact-envelope.ts            [D-after-verify] 21L, class C
packages/tests/shared-test/
  CompareJson.test.ts                                        [T] drop json-compare.ts parity cases
packages/tests/rallar-black-box/
  distributed-artifact-pipeline.test.ts                      [T] if envelope deleted
  distributed-artifact-workspace-pipeline.test.ts            [T] if envelope deleted
```

Verify-first: `distributed-artifact-envelope.ts` — if the two pipeline tests exercise alive
pipeline code and merely use the envelope as a helper contract, keep it (reclassify as
infrastructure); delete only if it is a superseded twin of a contract owned elsewhere.
`rallar-browser-spike.mts` is safe against the `check:deno` entry list (it is not in it).

### 4.4 Batch 4 — shared-web dead provider

```text
packages/shared-web/browser/rallar-ai-providers/
  webllm.ts                                         [D] 195L, class C
packages/tests/shared-web/
  rallar-ai.test.ts                                 [T] drop webllm provider cases
  shared-web-public-api-snapshots.test.ts           [T] only if a fixture references the provider
```

Evidence: `apps/ar-eye-hunter-v1` implements its own `webLlmProvider.ts`; the deploy-time
`VITE_RALLAR_BROWSER_AI: webllm` mode resolves to the app-local provider, not this file. No
template-literal dynamic imports of `rallar-ai-providers/` exist.

### 4.5 Batch 5 — class D retirements (only items approved in section 7)

```text
packages/shared-server/rallar-system/
  client-presence-state.ts                          [D3] 2L compat shim
  services/client-expired-state-authority.ts        [D3] 5L compat shim
  services/client-mutation-authority.ts             [D3] 5L compat shim
  services/client-state-semantic-equality.ts        [D3] 8L compat shim
  services/group-snapshot-validation.ts             [D3] 4L lineage-pinned shim
  topology/config/maintenance/migrate-legacy-group-topology-config-keys.ts [D4] 185L
packages/shared-web/browser/
  rallar-rooms-facade.ts                            [D3] 35L old-location re-export shim
  rtc-message-router.ts                             [D2] 24L
  ws-message-router.ts                              [D2] 25L
  mod.ts / rallar-core.ts / rallar-realtime.ts / rallar-media-calls.ts   [D1 — recommend keep]
```

Every D3/D4 deletion carries its governance updates in the same commit: the relevant `README.md`
navigation maps (`client-state/README.md`, `topology/README.md`), the navigation-map integrity and
ownership tests that pin these paths (`client-state-navigation-map-integrity.test.ts`,
`client-state-server-mutation-lineage-inventory.ts`, `repo-style-structural-lineage-provenance.test.ts`,
`group-topology-server-navigation-map-integrity.test.ts`, `group-topology-server-ownership.test.ts`),
and — for D2 — the shared-web snapshot entry lists plus `packages/shared-web/mod.ts` and the
`performance-analysis` skill reference lists.

## 5. Batch Sequence And Per-Batch Validation Matrix

Batches are independent (no candidate imports a candidate in another batch); ordering is by
governance blast radius, smallest first. Each batch is one commit (or two where a verify-first step
splits naturally) and must leave the entire tree green before the next starts.

| Gate                                                                                                                                                      | B1                                             | B2                                  | B3                                              | B4                          | B5                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------- | ----------------------------------------------- | --------------------------- | --------------------------- |
| `npm run typecheck`                                                                                                                                       | ✔                                              | ✔                                   | ✔                                               | ✔                           | ✔                           |
| `npm run check:repo-style:changed -- origin/main HEAD`                                                                                                    | ✔                                              | ✔                                   | ✔                                               | ✔                           | ✔                           |
| Focused vitest mirrors of touched areas                                                                                                                   | `packages/tests/{api-v1,shared-server,shared}` | `packages/tests/shared-graph`       | `packages/tests/{shared-test,rallar-black-box}` | `packages/tests/shared-web` | all touched mirrors         |
| `cd apps/api-v1 && deno task check && deno task test`                                                                                                     | ✔                                              | —                                   | —                                               | —                           | ✔                           |
| `npm run test:api-v1:black-box:memory`                                                                                                                    | ✔                                              | —                                   | —                                               | —                           | ✔                           |
| `npm run check:shared-test`                                                                                                                               | —                                              | —                                   | ✔                                               | —                           | —                           |
| `npm run test:deno`                                                                                                                                       | —                                              | —                                   | ✔                                               | —                           | ✔                           |
| `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`                                                                                     | ✔ (shared touched)                             | ✔ (shared-web imports shared-graph) | —                                               | ✔                           | ✔                           |
| `npx vitest run packages/tests/shared-web/shared-web-public-api-snapshots.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts` | —                                              | ✔                                   | —                                               | ✔                           | ✔                           |
| `npm run build:rallar-black-box-headless` (196 KiB shared-bundle ratchet)                                                                                 | ✔                                              | ✔                                   | —                                               | ✔                           | ✔                           |
| `npm run test:repo-governance`                                                                                                                            | —                                              | —                                   | —                                               | —                           | ✔ (governance tests edited) |
| `npm run test:api-v1:black-box:postgres:medium-scale`                                                                                                     | not triggered¹                                 | —                                   | —                                               | —                           | ✔ once, as evidence²        |

¹ No batch alters any mutation path, transaction, or concurrency behavior — scheduled api-v1 files
are production-unreachable at the recorded base, so the medium-scale trigger in `CLAUDE.md`
("mutation-path / concurrency changes") does not fire. If review disputes reachability for any
api-v1 file, run the gate rather than arguing.
² Batch 5 deletes maintenance-adjacent topology code and edits governance pins; one full
postgres-backed run (`npm run db:test:up` first) is the honesty evidence that convergence is
untouched.

REST surface: no batch changes routes or DTOs, so no black-box recipe additions are required; the
memory-backend recipe runs in B1/B5 exist to prove absence of accidental coupling, not to cover new
behavior.

## 6. Review-Pressure And Stacked-Versus-Single Decision

Projected totals if every recommended deletion (including approved D2–D4) lands: roughly 30–40
changed files and ~4–6k deleted lines — below every review-pressure threshold in
`publishing-plan-progress` (100 files / 10,000 lines / 20 production modules / 3 control-flow
families). **Decision: single lifecycle draft PR**, one commit per batch in section 5 order, D
batches appended only after their section 7 answers are recorded in the PR. If D answers lag more
than the mechanical batches, split exactly once: PR-A = batches 1–4 (evidence-complete deletions),
PR-B = batch 5 (decision-gated retirements), PR-B based on PR-A.

## 7. Class D Decision Items (User Answers Required Before Batch 5)

| #  | Item                                                                                                                                  | Evidence                                                                                                                                                                            | Recommendation                                                                                                         |
| -- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1 | shared-web narrow entry points `rallar-core.ts`, `rallar-realtime.ts`, `rallar-media-calls.ts`, `mod.ts`                              | Zero app importers today, but they are the documented product doctrine ("preferred for new app code" — `CLAUDE.md`, `architecture.md` bundle budgets, skills, `examples/README.md`) | **Keep** — intended future surface, not legacy. Deleting would contradict repo doctrine.                               |
| D2 | `rtc-message-router.ts`, `ws-message-router.ts`                                                                                       | 2026-05 vintage; only importer is the unused `mod.ts`; snapshot-pinned                                                                                                              | **Delete** with snapshot + `mod.ts` + perf-skill list updates.                                                         |
| D3 | Client-state/rooms compatibility shims (six files, 4.5)                                                                               | `client-state/README.md` explicitly labels them "legacy" compatibility paths; pinned by navigation-map/lineage governance tests                                                     | **Delete** together with their governance pins and README rows; they exist only to be retired.                         |
| D4 | `migrate-legacy-group-topology-config-keys.ts`                                                                                        | Bounded legacy-key migration tool; test-only reachable; README-tabled                                                                                                               | **Delete after you confirm the production key migration has completed**; otherwise defer with a dated follow-up issue. |
| D5 | `packages/shared/ontology/**` (11 files, ~1.6k lines)                                                                                 | Landed 2026-08-05..08 as a deliberately not-yet-wired staged feature (its own plan states runtime must not import it yet)                                                           | **Keep — explicitly out of scope**; it is new staging, not legacy. Revisit only if the ontology program is cancelled.  |
| D6 | Observation only: `apps/api-v1/scripts/migrate-rtc-persisted-state.ts` family and the `unsafeLegacyCollectionCompaction` OpenAPI flag | Alive (task-wired / API surface); both are migration-era artifacts                                                                                                                  | No action in this plan; candidates for a post-cutover follow-up issue.                                                 |

## 8. Completion Gates

Per `CLAUDE.md` and `publishing-plan-progress`, this plan may be marked complete only when, on the
final working tree: `npm run test:unit`, `npm run test:ci`, and `npm run build` all pass; the
**Branch Release Gate** workflow is green for the exact final feature-branch commit; and **Run
Hetzner Supported Distributed Manifests** is green for the resulting default-branch commit — with
each verified SHA recorded in the draft PR. Any change after a passing gate invalidates it. All
section 7 answers must be recorded (a deferred D item needs its follow-up issue URL). Local
`test:e2e`/`test:full-stack` bind loopback ports and fail with `listen EPERM` in sandboxes that
block that; record the sandbox condition and rely on the workflow evidence when it occurs.
