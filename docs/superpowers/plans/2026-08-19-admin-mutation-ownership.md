# Mutating Admin Operations Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this
> plan task-by-task. Use `rallar-repo:adaptive-plan-execution` for plan amendments,
> `rallar-repo:rallar-code-writing` for every human-authored code change,
> `rallar-repo:organizing-repository-structure` for every move or split, and
> `rallar-repo:rallar-testing` for proportional validation.

**Goal:** Complete Wave 2 of the human-traceability program by making mutating administration
directly navigable, with expired-data pruning owned beside its AppInbox phases and page worker,
while preserving every observable API, authorization, transaction, retry, persistence, and queue
behavior.

**Architecture:** Treat admin operations as a routing facade, not a second owner of topology or CRDT
behavior. Topology recomputation continues to delegate to topology, CRDT compact/lifecycle/erase
continues to delegate to CRDT, and process-local metric reset remains explicitly non-authoritative.
Move the one remaining admin-owned authoritative mutation—expired-data pruning—out of the generic
services folder into `admin-operations/inbox` and `admin-operations/prune`. Keep the initial command
under AppInbox's transaction/retry boundary; keep bounded page deletion under the APP_OUTBOX page
worker's fenced transaction. Then colocate API route, gateway, and inbox construction under one
`apps/api-v1/src/admin-operations` feature boundary and migrate all repository consumers atomically.

**Tech Stack:** TypeScript 7 with `erasableSyntaxOnly`, Deno 2, Vitest, Hono, ResourceInbox/AppInbox,
QueueBox APP_OUTBOX work, PostgreSQL/PGlite, Prettier, Deno formatter/linter, and the repository
style, structure, coupling, lineage, and legacy checkers.

**Program:**
[`plans/repo-human-traceability-refactoring-program-plan.md`](../../../plans/repo-human-traceability-refactoring-program-plan.md),
Wave 2 item 6.

**Exact planning base:** `607751a32b47a625ecf15ace01ff328c4835986e` (`origin/main` on
2026-08-19). Before implementation, fetch `origin/main`. If it moved, rebase this planning branch,
repeat the code-only owner trace, and amend paths or acceptance only when current code materially
changes the design.

## Current Production Truth

The current admin mutation path is:

1. `apps/api-v1/src/routes/admin-operations-routes.ts` authenticates the administrator and accepts
   the request body.
2. `AdminOperationsService.pruneExpired` delegates through
   `apps/api-v1/src/services/create-api-admin-mutation-gateway.ts`.
3. `packages/shared-server/rallar-system/services/AppAdminInboxService.ts` captures immutable
   command time/identity, rereads current administrator authority, counts expired rows, computes
   dry-run or page work, validates it, and writes the durable result plus initial APP_OUTBOX entries
   inside the AppInbox transaction.
4. `AdminPruneExpiredWork` consumes each reserved APP_OUTBOX page, rereads current authority and the
   aggregate predecessor, computes/validates a bounded page, compare-and-swaps aggregate progress,
   deletes rows under the captured cutoff, fences the reservation, commits, and only then wakes the
   queue for a successor page.
5. `PSqlAdminPruneExpiredRepository` owns deterministic PostgreSQL page reads, conditional deletes,
   aggregate compare-and-swap, successor outbox insertion, and reservation completion.

This is behaviorally sound enough to preserve, but ownership is fragmented:

- the AppInbox owner is in the generic `rallar-system/services` directory;
- the page owner, codecs, aggregate, and facade share one flat admin directory;
- API construction, gateway, and route registration live in three unrelated technical folders;
- the main AppInbox owner has cognitive load 56 and combines request decoding, phase orchestration,
  result waiting, and command/page construction;
- one codec owns both the initial AppInbox command and the later APP_OUTBOX page protocol;
- direct semantic coverage for the initial `AppAdminInboxService` phase sequence is missing;
- test names such as `admin-prune-correction-3` and `admin-prune-task9-correction` preserve migration
  history instead of behavior;
- current mutation-route and phase-order analyzers still navigate to the generic service path.

No open GitHub issue currently describes this ownership child. Do not create an issue merely for
the planned work. During implementation, fix an in-scope correctness bug only after a focused RED
test. For a confirmed code or performance weakness outside this two-slice horizon, search open
issues and create or reuse one accurate issue before handoff.

## Global Constraints

- Preserve every REST path, OpenAPI request/response shape, WebSocket behavior, AppInbox type and
  topic, APP_OUTBOX topic, queue key, command/page/aggregate JSON shape, database schema, table/key
  identity, default, error class/status, retry horizon, page size, cutoff, and result-wait behavior.
- Preserve authorization order and timing. Initial prune and every page retry reread the current
  session/admin allowlist; no captured administrator decision becomes durable authority.
- AppInbox remains the sole owner of the incoming prune transaction and retry. The admin mutation
  code exposes visible `read`, pure `compute`, pure `validate`, and
  `write(transaction, computed)` phases and never opens or retries that transaction.
- A conflict or classified retry re-enters the complete read/compute/validate/write flow. Never
  retry only a stale write.
- Keep command defaults visible before domain computation: generated job ID, captured time,
  retry-horizon expiry, default dry-run, default categories, and app-data scope validation.
- Initial non-dry-run work writes the exact aggregate and category page entries in the AppInbox
  transaction. Wake the queue only after successful commit. Dry-run, denial, collision, rollback,
  and failed commit never wake it.
- The page worker owns one fenced transaction per reserved page. Preserve the current semantic
  order: read page + aggregate + current authority; compute; validate; compare-and-swap progress;
  conditional delete; optional successor APP_OUTBOX insert; reservation completion; commit; wake.
- Preserve the current 20-attempt ResourceInbox lifetime for the initial command, every successor,
  and the pending aggregate result.
- Topology recomputation and CRDT administration remain direct delegations to their canonical
  domain owners. Do not copy their policy, mutation phases, or result construction into admin code.
- Process-local metric reset remains outside AppInbox because it does not mutate authoritative
  persisted state. Make that boundary obvious; do not route it through a fake database workflow.
- Read-only admin support, admin statistics, SPA statistics, and their routes are characterized but
  out of scope. Touch them only when a required import/composition edit enters closure.
- All verified consumers are in this Git repository. Migrate them atomically and delete old private
  paths; do not retain a compatibility re-export or wrapper for a consumer that no longer exists.
- Public package exports, REST/API contracts, persisted formats, and protocols are compatibility
  decisions. If implementation evidence requires changing one, stop and request explicit
  maintainer approval instead of inferring permission from repository-local consumer ownership.
- Every changed human-authored file is reviewed and remediated in full.
- Every support file modified by remediation enters closure recursively until closure.
- Independent untouched code remains outside closure.
- Classify every affected legacy item as `removed`, `minimized-boundary`, `resolved`, or `retained`.
  A retained item requires explicit maintainer approval and a focused registry entry; an issue,
  passing checker, or prior existence is not authority.
- Use semantic behavior tests as primary evidence. Source-path inventories and structural-lineage
  manifests are supplementary navigation/governance evidence only.
- Current main scans changed tests and enforces `line.width`, `boundary.unknown`, and
  `construction.forward-capture`. Every moved or edited test must close those findings; do not treat
  the move as exemption or use assertions/fakes to mask a contract mismatch.
- Keep only the two slices below concrete. New evidence that changes ownership, behavior,
  compatibility, or validation risk amends this plan before more production work.

## Working Horizon

1. **Slice 1 — shared-server prune ownership.** Establish direct semantic coverage, move the
   AppInbox owner, separate the initial-command and page-work protocols, recover the page worker and
   PostgreSQL repository under truthful names, move historical tests to behavior names, and update
   shared-server mutation analyzers.
2. **Slice 2 — API entry and complete consumer closure.** Colocate the API route, gateway, and inbox
   construction; replace generic route/gateway contracts with named exact contracts; migrate every
   in-repo consumer without a shim; add durable navigation; run complete correctness, PostgreSQL,
   black-box, and performance validation.

Do not activate read-only admin-support decomposition, statistics reorganization, configuration
work, a new pruning algorithm, a schema/index change, or a new performance benchmark in this plan.

## Locked Target Structure

### Shared-server admin ownership

- Move/modify:
  `packages/shared-server/rallar-system/services/AppAdminInboxService.ts` ->
  `packages/shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts`.
- Move/rename:
  `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts` ->
  `packages/shared-server/rallar-system/admin-operations/admin-operations-service.ts`.
- Move/rename:
  `packages/shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts` ->
  `packages/shared-server/rallar-system/admin-operations/prune/admin-prune-page-worker.ts`.
- Split:
  `packages/shared-server/rallar-system/admin-operations/admin-prune-work-codec.ts` into
  `prune/admin-prune-command-codec.ts` and `prune/admin-prune-page-codec.ts`.
- Move/modify:
  `packages/shared-server/rallar-system/admin-operations/admin-prune-progress.ts` ->
  `packages/shared-server/rallar-system/admin-operations/prune/admin-prune-progress.ts`.
- Modify:
  `packages/shared-server/rallar-system/admin-operations/admin-operations-mutation-gateway.ts` to
  use named exact result contracts and explicit domain mutation ports.
- Move/rename:
  `packages/shared-server/postgres/admin-operations/PSqlAdminPruneExpiredRepository.ts` ->
  `packages/shared-server/postgres/admin-operations/p-sql-admin-prune-repository.ts`.
- Create:
  `packages/shared-server/rallar-system/admin-operations/README.md` with the construction,
  registration, invocation, transaction, page-work, failure, and result paths.
- Delete the predecessor paths after all consumers move. Do not leave re-export shims.

The initial AppInbox class stays the stateful shell. It may colocate small phase contracts and pure
functions when that makes the command-to-result path easier to read. Do not create one pass-through
file per phase. The command and page codecs split because they guard different durable protocols
and have different invokers, not to satisfy a size number.

### API-v1 admin ownership

- Move/modify:
  `apps/api-v1/src/services/create-api-admin-inbox-service.ts` ->
  `apps/api-v1/src/admin-operations/create-api-admin-inbox-service.ts`.
- Move/modify:
  `apps/api-v1/src/services/create-api-admin-mutation-gateway.ts` ->
  `apps/api-v1/src/admin-operations/create-api-admin-mutation-gateway.ts`.
- Move/rename:
  `apps/api-v1/src/routes/admin-operations-routes.ts` ->
  `apps/api-v1/src/admin-operations/register-admin-operations-routes.ts`.
- Modify only as consumers:
  `apps/api-v1/src/services/create-api-mutation-inbox-factories.ts`,
  `apps/api-v1/src/composition/create-api-v1-mutation-runtime.ts`,
  `apps/api-v1/src/composition/create-api-v1-runtime.ts`,
  `apps/api-v1/src/composition/create-api-v1-admin-services.ts`, and
  `apps/api-v1/src/composition/create-api-v1-route-installers.ts`.
- Modify package middleware options and exports to point directly to the canonical shared-server
  owner. Do not preserve `services/AppAdminInboxService.ts`.
- Keep `apps/api-v1/src/routes/admin-support-routes.ts` and the read-only support owner in place.

### Mirrored semantic tests

- Create:
  `packages/tests/shared-server/admin-operations/inbox/app-admin-inbox-service.test.ts`.
- Move/rename:
  `packages/tests/shared-server/admin-prune-expired-work.test.ts` ->
  `packages/tests/shared-server/admin-operations/prune/admin-prune-page-worker.test.ts`.
- Move/rename:
  `packages/tests/shared-server/admin-prune-correction-3.test.ts` ->
  `packages/tests/shared-server/admin-operations/prune/admin-prune-command-and-progress-invariants.test.ts`.
- Move/rename:
  `packages/tests/shared-server/admin-prune-task9-correction.test.ts` ->
  `packages/tests/shared-server/admin-operations/prune/admin-prune-page-persistence-invariants.test.ts`.
- Move:
  `packages/tests/shared-server/admin-prune-retry-lifetime.test.ts` ->
  `packages/tests/shared-server/admin-operations/prune/admin-prune-retry-lifetime.test.ts`.
- Move:
  `packages/tests/shared-server/admin-operations-service.test.ts` ->
  `packages/tests/shared-server/admin-operations/admin-operations-service.test.ts`.
- Move API route and PGlite tests under
  `apps/api-v1/test/admin-operations/routes` and
  `apps/api-v1/test/admin-operations/persistence`, preserving each semantic scenario exactly once.
- Update mutation-route, phase-order, structure-coupling, and source-inventory support only after
  semantic tests prove the new owners.

### Structural lineage

Create `plans/repo-style-lineages/admin-mutation-ownership.json` at implementation time. Anchor it
to the actual immutable merge base, authenticate each source blob, and list every one-to-many target.
At the planning base, the principal source blobs are:

- `services/AppAdminInboxService.ts`: `1d5e77955a8003f55fb957eb55903d6bbc379043`;
- `admin-operations/AdminPruneExpiredWork.ts`:
  `5933ccb75f916bbe0fbbe3b2dd0e6e7f0267dd12`;
- `admin-operations/admin-prune-work-codec.ts`:
  `8e0fb1f0b88e608ee500a39d1b6ca2e794bc51c4`;
- `admin-operations/admin-prune-progress.ts`:
  `7bd187c483058dcf0fbad038a5aec4ed80347129`;
- API inbox/gateway/route sources: `0050ceca74ace90f07be62ad6d95935a5640a762`,
  `d96eece107596654cf312dc2353f2cf8e2bb6eaf`, and
  `eb6ac2106a896a7127a0c40a7a34fc4050dddcdc`.

If `origin/main` advances, recompute the blobs. Never copy these hashes into a manifest whose merge
base does not contain them.

---

## Slice 1 — Shared-Server Prune Ownership

### Task 1: Authenticate the base and capture the two code-derived timelines

**Files:**

- Read: all files in the current production truth path.
- Create: local ignored implementation report under `.superpowers/` only when execution starts.
- Modify: this plan only if the trace changes an assumption.

- [ ] Fetch `origin/main`, verify the merge base, clean status, and `npm run pr:delivery -- status`.
- [ ] Trace construction/registration without using this plan as the map: factory creation,
      AppInbox handler registration, APP_OUTBOX handler registration, and first possible invocation.
- [ ] Trace runtime invocation: HTTP entry, auth, request normalization, command capture, AppInbox
      enqueue, retry invocation count, read/compute/validate/write, first conditional write, final
      result, commit return, after-commit wake, aggregate wait, page reservation, page transaction,
      successor wake, failures, and final caller-visible result.
- [ ] Record variants: dry run; each of four categories; scoped app-data; multi-page; denial;
      identity/cursor corruption; aggregate conflict; reservation loss; retry exhaustion.
- [ ] Search all repository consumers and public exports. If a consumer exists outside the listed
      tree, amend the plan before moving files.

Run:

```sh
git fetch origin main
git merge-base HEAD origin/main
npm run pr:delivery -- status
rg -n "AppAdminInboxService|AdminPruneExpiredWork|ADMIN_PRUNE_EXPIRED|admin-prune" apps packages
```

Expected: exact current main or a consciously amended base; no unidentified consumer.

### Task 2: Add direct RED coverage for initial AppInbox mutation semantics

**Files:**

- Create: `packages/tests/shared-server/admin-operations/inbox/app-admin-inbox-service.test.ts`
- Reference: `packages/tests/shared-server/app-inbox-transaction.test.ts`
- Reference: `apps/api-v1/test/db/pglite-admin-prune-wake-transaction.test.ts`
- Reference: current `AppAdminInboxService.ts`

- [ ] Import the future canonical owner so RED first fails on the missing module.
- [ ] Prove exact request defaults and one-time volatile reads: generated ID, captured time,
      retry-horizon expiry, default dry-run, default categories, and app-data validation.
- [ ] Prove registration and phase order for one accepted dry run and one accepted durable prune:
      current authority/count read -> compute -> validate -> AppInbox transaction -> result and
      aggregate/page writes -> commit return -> queue wake.
- [ ] Force an initial outbox-key collision and prove state/result/page work rolls back, no winner is
      loaded, and the queue is not woken.
- [ ] Force an optimistic conflict/retry and prove current authority and expired counts are reread
      and the full computation is repeated.
- [ ] Prove denial, malformed input, expired command, and result-wait exhaustion preserve current
      error/failure classification and never invoke an unauthorized write.

Run RED:

```sh
npx vitest run \
  packages/tests/shared-server/admin-operations/inbox/app-admin-inbox-service.test.ts
```

Expected: FAIL because the canonical module is absent; after the import exists, any semantic RED
must fail on the named behavior rather than source text.

### Task 3: Move the AppInbox owner and expose the phase sequence

**Files:**

- Move/modify: `services/AppAdminInboxService.ts` ->
  `admin-operations/inbox/app-admin-inbox-service.ts`
- Modify: `admin-operations/admin-operations-mutation-gateway.ts`
- Modify: `rallar-system/middleware/rallar-middleware-options.ts`
- Modify: `rallar-system/middleware/RallarMiddleware.ts`
- Modify: `packages/shared-server/mod.ts` only if its intentional public surface requires it
- Test: direct AppInbox test from Task 2

- [ ] Preserve `AppAdminInboxService` as the narrow AppInbox stateful shell; use required named
      dependencies/config rather than the current ten positional constructor arguments.
- [ ] Keep request normalization and immutable fact capture visible before enqueue.
- [ ] Keep handler flow visibly `decode -> read -> compute -> validate -> writeMutation`.
- [ ] Use immutable stage contracts with direct predecessor provenance; make validation pure and
      all-issues when invalid computed data can be represented without throwing. Preserve current
      boundary exception classes/statuses.
- [ ] Give the gateway exact prune input/result types. For topology and CRDT methods, reference the
      existing canonical domain result contracts; if none is named, add the narrowest truthful
      union beside the owning domain instead of returning `unknown` through admin code.
- [ ] Remove request-decoding assertions and double assertions. Runtime-decode every untrusted
      value exactly once at its boundary.
- [ ] Migrate all direct imports and delete the old generic service file. Do not add a shim.

Run GREEN:

```sh
npx vitest run \
  packages/tests/shared-server/admin-operations/inbox/app-admin-inbox-service.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: direct semantics and cross-domain phase order pass from the canonical path.

### Task 4: Separate the command/page protocols and recover page-worker ownership

**Files:**

- Split/move the command codec, page codec, progress, page worker, and PostgreSQL repository listed
  in the locked target.
- Move/rename all four historical shared-server prune tests into behavior paths.
- Modify: `apps/api-v1/test/db/pglite-admin-prune-pages.test.ts`
- Modify: `packages/tests/shared-server/integration/postgres/admin-prune-page-delete.test.ts`

- [ ] First change test imports to the future canonical paths and run RED on missing modules.
- [ ] Keep the command codec responsible only for the initial AppInbox command and its hash,
      categories, app-data, capture/expiry, authority, and job identity invariants.
- [ ] Keep the page codec responsible only for the APP_OUTBOX envelope, reservation binding,
      single-category cursor/page identity, and page expiry invariants.
- [ ] Rename the worker to `AdminPrunePageWorker`; keep its public operation explicit and its
      complete read/compute/validate/transaction/wake flow visible.
- [ ] Preserve aggregate compare-and-swap, delete cutoff, reservation fencing, successor insert,
      commit, and wake order. Add semantic tests for every throwable boundary whose evaluation
      order could change during extraction.
- [ ] Give the PostgreSQL adapter a truthful kebab-case path and canonical class name. Preserve SQL,
      ordering, page limits, app-data scope, and conditional predicates unless a failing test proves
      a bug.
- [ ] Preserve every predecessor scenario exactly once, but delete historical task/correction
      filenames and any assertion that protects only a path or helper name.

Run GREEN:

```sh
npx vitest run packages/tests/shared-server/admin-operations
cd apps/api-v1 && deno test -A \
  test/db/pglite-admin-prune-pages.test.ts \
  test/db/pglite-admin-prune-cutoff-and-expiry.test.ts \
  test/db/pglite-admin-prune-wake-transaction.test.ts \
  test/db/pglite-admin-prune-authority-correction.test.ts
```

Expected: every initial/page/aggregate/persistence behavior passes under behavior-named ownership.

### Task 5: Close Slice 1 navigation, structure, and legacy

**Files:**

- Create: `packages/shared-server/rallar-system/admin-operations/README.md`
- Create: `plans/repo-style-lineages/admin-mutation-ownership.json`
- Modify: authoritative mutation source/inventory/analyzer support under
  `packages/tests/shared-server`
- Modify: coupling registry only for current, individually reviewed source reads

- [ ] Document the canonical entry, decisions, side effects, failures, result, initial AppInbox
      transaction, page-worker transaction, and the explicit topology/CRDT delegation boundary.
- [ ] Update semantic analyzer paths after production and direct tests pass. Do not use an exact-file
      inventory as the only proof of ownership.
- [ ] Authenticate exact structural lineage and prove one-to-many deletion works without retaining
      the source path.
- [ ] Run the complete changed-file manual review: <=100 columns, braces, imports, canonical names,
      no rename-only aliases, no >3 positional parameters, readonly object contracts, function
      separation, construction order, unknown normalization, assertions, and affected legacy.
- [ ] Run `npm run check:repo-structure` and disposition every finding as keep/split/move/consolidate.
- [ ] Run exact changed style against the immutable merge base and close every new or worsened fact.
- [ ] Stop for review before Slice 2. Do not begin API moves while a shared-owner finding remains.

---

## Slice 2 — API Entry And Complete Consumer Closure

### Task 6: Add API route/gateway RED coverage before moving owners

**Files:**

- Move/test: `apps/api-v1/test/routes/admin-operations-routes.test.ts` ->
  `apps/api-v1/test/admin-operations/routes/admin-operations-routes.test.ts`
- Create: `apps/api-v1/test/admin-operations/create-api-admin-mutation-gateway.test.ts`
- Reference: current API route, gateway, and inbox factory

- [ ] Import the future canonical API modules so RED fails on missing paths.
- [ ] Preserve administrator authentication before body decoding and before all mutation work.
- [ ] Prove exact route-to-domain mapping for metrics reset, topology recompute, prune, and the three
      CRDT operations. Assert the same administrator session and exact normalized request reaches
      the correct canonical owner once.
- [ ] Prove typed AppInbox left results retain code/status/message mapping and missing results fail
      closed.
- [ ] Prove malformed JSON, malformed prune input, denial, conflict, pending completion, and domain
      rejection preserve current HTTP statuses and response bodies.
- [ ] Prove process-local metric reset does not call AppInbox, while every authoritative route does.

Run RED:

```sh
cd apps/api-v1 && deno test -A \
  test/admin-operations/routes/admin-operations-routes.test.ts \
  test/admin-operations/create-api-admin-mutation-gateway.test.ts
```

Expected: FAIL on absent canonical modules, then on any named semantic mismatch.

### Task 7: Colocate API owners and remove generic route/gateway contracts

**Files:**

- Move/modify the three API modules in the locked target.
- Modify the five listed API composition/factory consumers.
- Modify relevant OpenAPI/black-box files only if verification finds a real contract omission;
  otherwise leave them byte-unchanged.

- [ ] Rename `init` to `registerAdminOperationsRoutes` and make the feature entry obvious.
- [ ] Replace duplicate route-local service/input aliases with canonical named interfaces or direct
      qualified types. Use interfaces for concrete object contracts.
- [ ] Keep `unknown` only at Hono JSON/error boundaries. Decode once, then pass typed values through
      gateway and service methods.
- [ ] Keep topology and CRDT result mapping owned by their domain gateways. The admin route only
      translates HTTP/auth and chooses the operation.
- [ ] Construct the page worker, current-authority reader, AppInbox service, gateway, and routes in
      visible acyclic order. No setter, forward capture, service locator, optional hidden default, or
      test-only construction path.
- [ ] Migrate every in-repo consumer atomically. Delete old `services` and `routes` paths with no
      compatibility re-export.
- [ ] Apply touched-file standards closure recursively to every composition or test support file
      changed by the migration.

Run GREEN:

```sh
cd apps/api-v1 && deno test -A test/admin-operations
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno lint
cd apps/api-v1 && deno fmt --check
```

Expected: canonical API ownership, unchanged route behavior, and complete app type/lint/format pass.

### Task 8: Complete consumer, test, navigation, and issue closure

**Files:**

- Move API PGlite tests under `apps/api-v1/test/admin-operations/persistence`.
- Modify: `apps/api-v1/src/composition/README.md`
- Modify: shared-server admin README from Slice 1
- Modify: mutation-route and phase-order semantic analyzer support
- Modify: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json`
  only if a semantic assertion needs strengthening, never for a path-only ratchet

- [ ] Prove no old production/test path, old class/file vocabulary, direct authoritative mutator,
      or duplicate admin-prune decision remains.
- [ ] Cold-trace from `packages/shared-server/mod.ts` and API route registration without using the
      plan: locate entry, owner, decisions, writes, failures, final result, and both retry boundaries
      without a wrong-file guess or pass-through hop.
- [ ] Update durable navigation with the exact current owners and explain the process-local metrics,
      topology delegation, CRDT delegation, initial prune, and page-worker families.
- [ ] Reconcile structure-coupling entries individually; remove stale entries and avoid new raw
      source-text assertions where semantic execution can prove the boundary.
- [ ] Review every warning and legacy candidate in the changed production call path. Fix actual
      bugs under RED tests. Search GitHub before recording any out-of-horizon weakness; create or
      reuse a focused issue with evidence, impact, safe next step, and acceptance.

### Task 9: Run final proportional validation and prepare review

Run focused correctness first:

```sh
npx vitest run packages/tests/shared-server/admin-operations
npx vitest run \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/mutation-route-owner-*.test.ts
cd apps/api-v1 && deno test -A test/admin-operations
```

Run affected type/application gates:

```sh
npm run typecheck:tests
npm run typecheck
npx tsc -p packages/shared-server/tsconfig.json --noEmit
cd apps/api-v1 && deno task check
cd apps/api-v1 && deno lint
cd apps/api-v1 && deno fmt --check
```

Run PostgreSQL and REST behavior:

```sh
npm run db:test:up
npm run test:postgres:integration
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:medium-scale
```

Because this changes an authoritative mutation path, capture and compare a fresh state-write
candidate against a fresh compatible baseline, using separately migrated databases:

```sh
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-admin-candidate.json

node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-admin-baseline.json \
  tmp/perf/api-v1-state-write-admin-candidate.json
```

If the host is noisy, use the documented A-B-B-A pooled protocol before classifying a regression.
Do not claim performance preservation from unrelated or stale artifacts.

Run governance and human-closure gates:

```sh
npm run check:repo-style
npm run check:repo-style:changed -- 607751a32b47a625ecf15ace01ff328c4835986e
npm run check:repo-structure -- --base 607751a32b47a625ecf15ace01ff328c4835986e
npm run test:repo-structure
npm run test:repo-governance
node scripts/check-test-structure-coupling.mjs \
  --changed 607751a32b47a625ecf15ace01ff328c4835986e HEAD
npm run check:production-legacy:review -- \
  607751a32b47a625ecf15ace01ff328c4835986e HEAD
git diff --name-only --diff-filter=ACMR \
  607751a32b47a625ecf15ace01ff328c4835986e HEAD -- \
  '*.ts' '*.mts' '*.js' '*.mjs' '*.json' '*.md' \
  | rg -v '^apps/api-v1/' \
  | xargs npx prettier --check
git diff --check 607751a32b47a625ecf15ace01ff328c4835986e...HEAD
```

If implementation rebases onto a newer `origin/main`, amend this plan's exact base and every
base-sensitive command before continuing. Do not mix bases within one evidence set.

Acceptance requires:

- all direct, package, API, PostgreSQL, black-box, type, format, style, structure, coupling, and
  legacy gates pass or have a truthful environment-only skip classification;
- every construction warning has a path/rule/symbol disposition;
- every affected legacy item has a final classification;
- no confirmed in-scope weakness is silent;
- the exact final head merges cleanly with live `origin/main`;
- an independent code review reports zero Critical, Important, and Minor findings.

At implementation handoff, run `npm run pr:delivery -- ready` once only after local completion. The
ordinary PR is the delivery entity; do not create a plan ledger, receipt, digest, or post-merge
close-out task.

## Explicit Non-Goals

- No read-only `AdminSupportService` decomposition.
- No admin statistics or SPA statistics reorganization.
- No topology or CRDT algorithm/persistence rewrite.
- No new queue, lock, retry, transaction, schema, or index policy.
- No API path, OpenAPI, wire, persisted-format, or database migration.
- No compatibility shim for an old private path whose consumers were migrated in this repository.
- No global repository cleanup outside recursive touched-file closure.
- No third concrete slice.

## Completion Handoff

Report:

1. exact base, final head, tree, and clean status;
2. changed paths and the final owner-to-result path;
3. construction/registration and runtime invocation timelines;
4. behavior preserved, bugs fixed, and every issue created/reused—or explicitly none;
5. validation commands with pass/fail/skip results and artifact paths;
6. structure, construction-warning, coupling, legacy, and compatibility dispositions;
7. live-main merge compatibility and PR delivery status.
