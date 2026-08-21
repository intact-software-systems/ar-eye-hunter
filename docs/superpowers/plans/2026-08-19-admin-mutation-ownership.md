# Mutating Admin Operations Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan
> task by task. Use `superpowers:test-driven-development` for behavior changes,
> `rallar-repo:adaptive-plan-execution` for plan amendments,
> `rallar-repo:rallar-code-writing` for every human-authored code change,
> `rallar-repo:organizing-repository-structure` for moves and splits,
> `rallar-repo:rallar-platform` and `rallar-repo:rallar-realtime` for package/AppInbox boundaries,
> `rallar-repo:rallar-testing` for validation, and
> `rallar-repo:publishing-plan-progress` for delivery.

**Goal:** Finish Wave 2 of the human-traceability program by making the remaining admin-owned
authoritative mutation—expired-data pruning—directly navigable from HTTP entry through AppInbox,
APP_OUTBOX page execution, PostgreSQL effects, and durable result, while preserving current public,
idempotency, authorization, transaction, retry, persistence, and queue behavior.

**Architecture:** Preserve admin operations as a public facade and transport boundary, not a second
owner of topology or CRDT policy. Keep the completed AppInbox owner in
`rallar-system/admin-operations/inbox`. Recover the unfinished page protocol, page worker,
aggregate/progress, and PostgreSQL repository under a cohesive prune feature. Then colocate API-v1
admin route registration and mutation composition under one `admin-operations` feature boundary,
with separate read and canonical mutation route installers behind one feature entry.

**Tech stack:** TypeScript with `erasableSyntaxOnly`, Deno, Hono, Vitest, ResourceInbox/AppInbox,
QueueBox APP_OUTBOX work, PostgreSQL/PGlite, Rallar black-box recipes, OpenAPI, and repository style,
structure, coupling, legacy, and performance checks.

**Spec:**
[`plans/repo-human-traceability-refactoring-program-plan.md`](../../../plans/repo-human-traceability-refactoring-program-plan.md),
Wave 2 item 6. Preserve CRDT delegation constraints from
[`docs/superpowers/specs/2026-08-17-crdt-mutation-and-administration-ownership-design.md`](../specs/2026-08-17-crdt-mutation-and-administration-ownership-design.md).

**Refreshed planning base:** `6704f5b8c12218991a53ac9536db6cacee5f82ae` (`origin/main` on
2026-08-21). At implementation start, fetch `origin/main`, create the implementation branch from
that exact current head, and derive all changed-range evidence from its merge base. If production
ownership or the locked contracts below have changed, stop and amend this plan before editing code;
an advanced base alone is not a reason to redesign the work.

## Current-Main Production Truth

The earlier plan was partially implemented before this refresh. The following work is complete on
`main` and is a constraint, not an executable task:

- `packages/shared-server/rallar-system/admin-operations/inbox/app-admin-inbox-service.ts` owns the
  incoming prune mutation and its AppInbox transaction/retry boundary.
- The public mutation URL is
  `/api/admin/operations/maintenance/prune-expired/requests/:requestId`. The request ID is mandatory,
  path-only, case-sensitive, 20–128 characters, and matches `^[A-Za-z0-9_-]+$`; the old route is
  absent and header/body request IDs are rejected.
- Authentication and current administrator authorization run before replay disclosure. Renewed
  sessions for the same authenticated caller can replay; a different administrator is isolated.
- AppInbox identity includes the authenticated caller and app-data scope. The operation topic stays
  independent from other mutation topics. Job, page, aggregate, receipt, and outbox identities are
  derived from the full scoped identity rather than the raw request ID.
- Prune categories are canonicalized before semantic comparison. Volatile time, expiry, job ID,
  retry facts, and audit facts are captured only by the atomic winner and excluded from equality.
- An equal replay returns or waits for the exact durable result. Changed semantic intent for an
  existing scoped key returns canonical `409 idempotency-conflict` with no additional effects.
  Wait-budget exhaustion remains a retryable canonical 503.
- The shared `ApiMutationFailure` envelope and strict durable-result decoding cover admin mutation
  success and failure. Route-specific string parsing and message-based status inference are not
  permitted.
- The five-minute AppInbox reservation timeout, current 20-attempt lifetime, result retention, and
  database schema are unchanged.
- Low-level direct prune deletion was removed. `AdminOperationsPruner` and
  `PSqlAdminOperationsPruner` retain only the expired-row counting capability required by the
  AppInbox read phase. Authoritative deletion occurs only in the fenced page worker transaction.
- Historical AppInbox rows remain untouched. The exact named
  `LEGACY_ADMIN_APP_INBOX_TOPIC = 'app-inbox.admin-operations'` decode branch is a persisted
  compatibility boundary. Do not broaden it or silently remove it.

The current runtime path is:

```text
HTTP admin mutation route
  -> authenticate and authorize current administrator
  -> decode path request ID and normalized semantic request
  -> AdminOperationsService facade
  -> API admin mutation gateway
  -> AppAdminInboxService
  -> AppInbox reserve/read/compute/validate/write/complete transaction
  -> initial APP_OUTBOX page entries
  -> AdminPruneExpiredWork
  -> page read/compute/validate/write transaction
  -> aggregate compare-and-swap + conditional deletes + successor page + reservation completion
  -> post-commit queue wake
  -> exact durable AppInbox result
  -> canonical HTTP response
```

Topology recomputation continues to delegate to the topology AppInbox owner. CRDT compact,
lifecycle, and erase continue to delegate to the CRDT owner. Process-local metrics reset is not an
authoritative persisted mutation. Read-only admin support, statistics, integrity/debug exports, and
CRDT catch-up stay outside AppInbox and outside this plan.

## Remaining Problem

Current behavior is substantially complete, but the remaining owner is still hard to follow:

- `AdminPruneExpiredWork.ts`, `admin-prune-work-codec.ts`, and `admin-prune-progress.ts` are flat,
  mutually coupled, and mix initial AppInbox command protocol with later APP_OUTBOX page protocol.
- `PSqlAdminPruneExpiredRepository.ts` uses historical filename/class vocabulary and does not sit
  beside a visibly named page-worker contract.
- shared-server tests remain flat; names such as `admin-prune-correction-3` and
  `admin-prune-task9-correction` communicate migration history instead of behavior.
- `AdminOperationsService.ts` still has a PascalCase filename, and its public facade contract mixes
  broad request/result types that must be made exact without breaking the package surface.
- `apps/api-v1/src/routes/admin-operations-routes.ts` mixes read/non-AppInbox routes with canonical
  AppInbox mutation routes and exports a generic `init` entry.
- API admin inbox construction and mutation gateway live in `src/services`, separated from the
  routes and composition they own.
- mutation-routing and state-write-evidence analyzers still point at predecessor paths.

## Locked Behavioral And Compatibility Constraints

- Preserve all public HTTP paths, OpenAPI request/response schemas, status codes, application-owned
  response headers, authorization timing, canonical failure mapping, and strict request-ID rules.
- Preserve public package exports and canonical exported type/class names unless repository evidence
  proves they are private. A path move may update a package export target; it must not silently
  delete or rename a public symbol.
- Preserve AppInbox and APP_OUTBOX topics, key normalization, persisted command/page/aggregate/result
  JSON, table/key identities, queue reservation semantics, retry limits, page size, cutoff rules,
  completion ordering, and result-wait behavior.
- Preserve exact old-row compatibility only through the existing named legacy-topic branch. Do not
  add a general fallback, duplicate receipt store, lease, token, schema, or migration.
- Preserve full-request idempotency isolation across operation, administrator, app-data scope, and
  target. Case-distinct request IDs remain distinct.
- Equal concurrent contenders produce one durable command, one volatile-fact set, one result, and
  one effect/outbox set. Different concurrent intents with one scoped key produce one winner; every
  loser receives canonical 409 and produces no effect.
- Initial AppInbox work owns immutable command construction and the initial aggregate/page enqueue.
  Only a validated durable miss captures time, expiry, job ID, or other volatile facts.
- Each page attempt rereads the page, aggregate predecessor, and current administrator authority.
  A classified conflict retries the complete read/compute/validate/write flow; it never retries a
  stale write alone.
- The page worker owns exactly one fenced transaction per reserved page. Keep the semantic order:
  read; pure compute; pure validate; aggregate compare-and-swap; conditional delete; optional
  successor insert; reservation completion; commit; post-commit wake.
- An outbox identity collision, aggregate conflict, lost reservation, failed write, or failed commit
  rolls back every effect from that attempt. A denied/failed attempt does not wake the queue.
- Preserve the current APP_OUTBOX exhaustion/pending-aggregate behavior and the shorter synchronous
  result wait unless a focused RED test proves a correctness defect and the maintainer approves the
  behavioral change.
- Topology and CRDT admin mutations remain thin domain delegations. Do not copy their authorization,
  policy, transaction, retry, or result logic into the admin facade or API route.
- Keep process-local metrics reset visibly separate from authoritative persisted mutations. Do not
  send it through AppInbox for structural symmetry.
- All verified repository consumers move atomically. Delete obsolete private paths; do not retain
  wrappers or re-export shims for migrated in-repo imports.
- Every changed human-authored file receives full-file standards closure. Remediation support files
  recursively enter closure. Independent untouched code remains out of scope.
- Classify affected legacy as `removed`, `minimized-boundary`, `resolved`, or `retained`. Retention
  of production legacy beyond the already approved persisted-topic decoder requires explicit
  maintainer approval and a focused registry entry.
- Semantic execution tests are primary evidence. Source inventories and structure checks supplement
  them; they do not replace runtime behavior coverage.

## Locked Target Structure

Use the smallest structure that exposes real lifecycle and protocol boundaries. Do not create a
pass-through file per phase.

### Shared-server

```text
packages/shared-server/rallar-system/admin-operations/
  README.md
  admin-operations-service.ts
  admin-operations-mutation-gateway.ts
  admin-operations-request-reading.ts
  admin-prune-options.ts
  crdt-admin-validation.ts
  inbox/
    app-admin-inbox-service.ts
    admin-prune-inbox-codec.ts
    admin-prune-inbox-identity.ts
    admin-prune-inbox-validation.ts
    admin-prune-command-codec.ts
  prune/
    admin-prune-page-worker.ts
    admin-prune-page-codec.ts
    admin-prune-progress.ts

packages/shared-server/postgres/admin-operations/
  p-sql-admin-prune-repository.ts
  ...unchanged read/statistics owners...
```

- Move `AdminOperationsService.ts` to `admin-operations-service.ts` while keeping
  `AdminOperationsService` as the canonical public class.
- Move `AdminPruneExpiredWork.ts` to `prune/admin-prune-page-worker.ts` and rename its private owner
  vocabulary to `AdminPrunePageWorker`. Keep protocol/domain names stable where they are public or
  persisted.
- Split `admin-prune-work-codec.ts` by durable protocol: the initial AppInbox command codec belongs
  in `inbox/admin-prune-command-codec.ts`; APP_OUTBOX page decoding/encoding belongs in
  `prune/admin-prune-page-codec.ts`.
- Move `admin-prune-progress.ts` into `prune` because aggregate progress is read and advanced by the
  page lifecycle. The AppInbox owner may import its aggregate initializer directly.
- Move `PSqlAdminPruneExpiredRepository.ts` to `p-sql-admin-prune-repository.ts`. Rename the class
  only if the consumer/public-export scan proves that name is private; otherwise keep the exported
  class name as a minimized compatibility boundary and document why.
- Keep the existing inbox request/result codec cohesive unless implementation evidence reveals two
  independent protocols. Do not split it merely to reduce line count.

### API-v1

```text
apps/api-v1/src/admin-operations/
  register-admin-operations-routes.ts
  register-admin-operation-read-routes.ts
  register-admin-operation-mutation-routes.ts
  create-api-admin-inbox-service.ts
  create-api-admin-mutation-gateway.ts
```

- `register-admin-operations-routes.ts` is the one feature entry and contains only explicit
  composition of the two route families.
- The read installer owns read-only and process-local routes and their response contracts.
- The mutation installer owns strict request-ID ingress, current auth/authorization ordering,
  semantic request decoding, canonical failure mapping, and calls to the admin facade.
- The split is justified by distinct ingress/failure/idempotency contracts. Do not introduce a
  generic route helper or a pass-through-only layer.
- Move the API inbox and gateway constructors from `src/services`; keep their concrete dependency
  wiring visible to `src/composition`.
- Leave `apps/api-v1/src/routes/admin-support-routes.ts` and independent admin-support ownership in
  place.

### Mirrored tests

```text
packages/tests/shared-server/admin-operations/
  admin-operations-service.test.ts
  inbox/app-admin-inbox-service.test.ts
  prune/admin-prune-page-worker.test.ts
  prune/admin-prune-command-and-progress-invariants.test.ts
  prune/admin-prune-page-persistence-invariants.test.ts
  prune/admin-prune-retry-lifetime.test.ts

apps/api-v1/test/admin-operations/
  routes/...
  persistence/...
```

Rename correction/task-history tests by the invariant they execute. Preserve each semantic scenario
exactly once; do not copy tests into new paths and leave predecessors behind.

## Working Horizon

The implementation has exactly two reviewable slices:

1. **Shared-server prune owner.** Characterize current page behavior, split the protocols, recover
   page-worker/PostgreSQL ownership, move behavior-named tests, and close shared-server navigation.
2. **API entry and complete closure.** Colocate API owners, split read and canonical mutation route
   contracts behind one entry, migrate every consumer/analyzer/recipe reference, and run full
   correctness, database, black-box, style, structure, and performance validation.

Do not activate a third slice. New evidence that changes an authority boundary, public contract,
persisted format, key, retry policy, or acceptance threshold requires a plan amendment and explicit
maintainer review before implementation continues.

---

## Slice 1 — Shared-Server Prune Ownership

### Task 1: Authenticate the implementation base and freeze the current contracts

**Read:**

- `AGENTS.md`
- this plan and its two governing specifications
- all files under `packages/shared-server/rallar-system/admin-operations`
- all files under `packages/shared-server/postgres/admin-operations`
- all matching shared-server and PGlite/PostgreSQL tests

**Steps:**

- [ ] Fetch `origin/main`, create `codex/admin-mutation-ownership` from current `origin/main`, and
      record `ADMIN_MUTATION_BASE=$(git merge-base HEAD origin/main)` before editing.
- [ ] Run `npm run pr:delivery -- status`. Repair a real conflict first; do not rebase solely for a
      `BEHIND` report while GitHub still reports mergeable.
- [ ] Record two code-derived traces: construction/registration and runtime invocation. Include
      transaction ownership, authority rereads, reservation fencing, queue wakes, failure mapping,
      and durable result completion.
- [ ] Inventory every import/export/fixture/analyzer/recipe reference to each path that will move.
      Classify it as `path-update`, `semantic-review`, or `verified-unchanged`.
- [ ] Snapshot public package exports, strict admin OpenAPI paths, persisted JSON fixtures, topic
      strings, default page/retry values, and the named historical-topic decoder.
- [ ] Run the focused shared-server/API/PGlite tests before edits. If current `main` is red, record
      the exact failure and distinguish baseline failure from implementation work.

**Stop conditions:** Stop and amend the plan if current code adds a second admin-owned authoritative
mutation, changes the page transaction owner, removes historical rows through a migration, or
changes any strict idempotency contract listed above.

**Checkpoint:** Commit only evidence/test-harness changes that are independently reviewable; do not
commit generated artifacts.

### Task 2: Establish behavior-named RED coverage for the page lifecycle

**Modify/move tests:**

- `packages/tests/shared-server/admin-prune-expired-work.test.ts`
- `packages/tests/shared-server/admin-operations-app-admin-inbox-service.test.ts`
- `packages/tests/shared-server/admin-prune-correction-3.test.ts`
- `packages/tests/shared-server/admin-prune-task9-correction.test.ts`
- `packages/tests/shared-server/admin-prune-retry-lifetime.test.ts`
- `packages/tests/shared-server/integration/postgres/admin-prune-page-delete.test.ts`
- affected `apps/api-v1/test/db/pglite-admin-prune-*.test.ts`

**Required scenarios:**

- [ ] A reserved page executes read → compute → validate → write and completes exactly once.
- [ ] Every retry rereads current admin authority and the current aggregate predecessor.
- [ ] Aggregate compare-and-swap conflict retries the complete attempt; stale computed state is not
      reused.
- [ ] Reservation loss, authority denial, malformed page/aggregate, outbox collision, write error,
      and commit failure produce no partial delete, aggregate advance, successor, or wake.
- [ ] Conditional deletes use the captured cutoff, page size, category, and exact selected keys.
- [ ] A successor page is inserted with the current retry lifetime, then woken only after commit.
- [ ] Dry-run and no-op commands preserve their exact durable result and create no deletion effects.
- [ ] Retry exhaustion and the pending aggregate/result-wait relationship are explicitly
      characterized without sleeping for the five-minute reservation timeout.
- [ ] Command/page/progress decoders accept every current persisted fixture and reject malformed
      durable data deterministically.
- [ ] The strict current topic and exact legacy topic decode independently; no broader legacy
      fallback is accepted.
- [ ] Existing AppInbox first-use, equal-replay, changed-intent, current-authority, atomic enqueue,
      exact durable success/failure, and volatile-winner coverage remains green after protocol
      moves.

Write assertions against observable domain state, repository calls, transaction state, queue rows,
and durable results. Source-string assertions may prove a path inventory but never substitute for a
behavior scenario.

Run the smallest test after each RED addition, confirm it fails for the intended missing ownership
or contract reason, then implement only enough in Task 3 to make it green.

### Task 3: Recover page protocol, worker, progress, and PostgreSQL ownership

**Move/split:**

- `AdminPruneExpiredWork.ts` → `prune/admin-prune-page-worker.ts`
- `admin-prune-work-codec.ts` → `inbox/admin-prune-command-codec.ts` and
  `prune/admin-prune-page-codec.ts`
- `admin-prune-progress.ts` → `prune/admin-prune-progress.ts`
- `PSqlAdminPruneExpiredRepository.ts` → `p-sql-admin-prune-repository.ts`
- `AdminOperationsService.ts` → `admin-operations-service.ts`

**Steps:**

- [ ] Define exact named input, computed, write, result, repository, and dependency contracts at the
      owner that uses them. Eliminate boundary `unknown`, double assertions, and locally renamed
      aliases throughout every touched file.
- [ ] Keep a functional core behind the stateful page-worker shell: visible `read`, pure `compute`,
      pure `validate`, and one transaction-owned `write` path.
- [ ] Keep the PostgreSQL repository responsible for deterministic reads and persistence mechanics;
      keep domain decisions, authority policy, retry classification, and result construction out of
      SQL code.
- [ ] Remove the unused PostgreSQL repository constructor dependency if the consumer scan proves it
      has no lifecycle purpose. Do not preserve an argument solely because old tests pass it.
- [ ] Keep AppInbox command materialization in the inbox owner and page materialization in the page
      codec/worker. Do not reintroduce a generic work codec.
- [ ] Update `packages/shared-server/mod.ts` and every in-repo import atomically. Delete predecessor
      files after the last consumer moves; add no compatibility re-export for private paths.
- [ ] Retain canonical public symbols where required. For any proposed public rename, stop and
      request explicit compatibility approval with the exact export and verified consumers.
- [ ] Make each focused RED scenario green, then run the complete shared-server admin and PostgreSQL
      prune suites.

**Expected result:** A reader can start at `app-admin-inbox-service.ts`, distinguish initial command
from page protocol immediately, follow one page into its fenced PostgreSQL effects, and locate every
retry/failure/result decision without entering a generic service directory.

### Task 4: Close Slice 1 tests, navigation, and legacy

**Create/modify:**

- `packages/shared-server/rallar-system/admin-operations/README.md`
- behavior-named mirrored test paths listed above
- mutation route/owner/phase-order analyzers under `packages/tests/shared-server`
- `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-command-codecs.ts`
- every package export or docs link that referenced a moved shared-server path

**Steps:**

- [ ] Move tests into the mirrored feature tree and delete historical correction/task filenames.
- [ ] Document construction, registration, request identity, initial AppInbox transaction, page
      transaction, post-commit wake, replay/conflict, failure, and final-result paths.
- [ ] Update analyzers only after runtime tests pass. Remove stale path markers instead of teaching
      analyzers to accept both old and new owners.
- [ ] Run a cold navigation probe without consulting this plan. From `packages/shared-server/mod.ts`
      and from the AppInbox owner, locate the public facade, command codec, page worker, repository,
      writes, failure classification, and exact result. Record any wrong-file guess and fix the
      navigation cause before closing the slice.
- [ ] Classify low-level direct deletion as `removed`, historical correction test vocabulary as
      `removed`, moved private paths as `removed`, canonical public facade names as
      `minimized-boundary` where necessary, and the legacy persisted-topic decoder as the one
      pre-approved `retained` compatibility boundary.
- [ ] Run focused tests, typechecks, changed-style, structure, coupling, legacy, formatting, and
      `git diff --check` before publishing the slice commit.

**Slice checkpoint:** Commit and push the shared-server slice as one reviewable milestone. Update the
PR body with the final runtime trace and exact validation results; do not add a plan ledger,
ownership reservation, or generated lineage manifest.

---

## Slice 2 — API Entry And Complete Consumer Closure

### Task 5: Lock API route, gateway, and idempotency behavior with focused tests

**Modify/move tests:**

- `apps/api-v1/test/routes/admin-operations-routes.test.ts`
- `apps/api-v1/test/routes/admin-crdt-idempotency-route-contract.test.ts`
- `apps/api-v1/test/composition/create-api-v1-admin-services.test.ts`
- relevant PGlite admin-prune tests
- `apps/api-v1/test/routes/api-mutation-openapi-contract.test.ts`
- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json`
- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-idempotency-contract.json`

**Required focused contract cases:**

- [ ] Read and process-local routes register once through the read installer; canonical AppInbox
      mutations register once through the mutation installer.
- [ ] All existing admin paths and OpenAPI operation IDs remain exact; predecessor URLs remain 404.
- [ ] Request IDs at 19, 20, 128, and 129 characters, illegal characters, case distinction, URL
      encoding, header rejection, and body rejection keep the shared strict contract.
- [ ] Authentication and current authorization run before a stored success or terminal failure is
      disclosed.
- [ ] First request, exact replay, normalized replay, changed-intent 409, wait-exhaustion 503, and
      exact terminal-failure replay decode through `ApiMutationFailure` without string inference.
- [ ] Same request ID remains isolated across operation, administrator, app-data scope, topology
      target, and CRDT document.
- [ ] Topology and CRDT calls reach their existing domain owners exactly once; admin code does not
      interpret their domain result or retry policy.
- [ ] Exact decoded response status, JSON body, and application-owned headers are preserved on
      replay. Transport-owned headers are excluded from equality.

Add a failing focused test before changing route/gateway composition. A path-only move that leaves
behavior unchanged may start with a passing characterization test and use delete-old-path/import
failure as its structural RED.

### Task 6: Colocate the API admin owner and split real route contracts

**Move/split:**

- `apps/api-v1/src/routes/admin-operations-routes.ts` →
  `apps/api-v1/src/admin-operations/register-admin-operations-routes.ts`,
  `register-admin-operation-read-routes.ts`, and
  `register-admin-operation-mutation-routes.ts`
- `apps/api-v1/src/services/create-api-admin-inbox-service.ts` →
  `apps/api-v1/src/admin-operations/create-api-admin-inbox-service.ts`
- `apps/api-v1/src/services/create-api-admin-mutation-gateway.ts` →
  `apps/api-v1/src/admin-operations/create-api-admin-mutation-gateway.ts`

**Modify consumers:**

- `apps/api-v1/src/composition/create-api-v1-admin-services.ts`
- `apps/api-v1/src/composition/create-api-v1-route-installers.ts`
- `apps/api-v1/src/services/create-api-mutation-inbox-factories.ts`
- any additional consumer found by Task 1's inventory

**Steps:**

- [ ] Replace generic `init` and broad route-local `unknown` contracts with behavior-named
      installers and exact named inputs/results owned by the relevant route family.
- [ ] Keep one feature registration entry so application composition has one obvious import.
- [ ] Keep authentication, authorization, path-ID decoding, semantic body decoding, canonical error
      mapping, and HTTP response translation visible in the mutation route owner.
- [ ] Keep database/runtime construction visible in the API inbox factory and domain delegation
      visible in the mutation gateway. Do not introduce a service locator or generic mutation bus.
- [ ] Preserve the `AdminOperationsService` facade/public surface while tightening internal ports.
      Compact/erase/topology types come from their canonical domain contracts; do not use `unknown`
      as a permanent cross-domain DTO.
- [ ] Update every source, test, mock, example, analyzer, and recipe import in one atomic move and
      delete old route/service paths.
- [ ] Move API tests under `test/admin-operations/routes` and
      `test/admin-operations/persistence`, using behavior names and closing full-file style findings.
- [ ] Make all Task 5 focused tests green before broad validation.

### Task 7: Thoroughly exercise admin idempotency with Rallar black-box recipes

Use existing recipe, parallel-request, three-node, and state-write-evidence infrastructure. Do not
redesign the runner.

**Required recipe coverage:**

- [ ] Admin prune first success, exact replay, category-order/default normalization replay, changed
      intent 409, no-op replay, dry-run replay, and durable terminal-failure replay.
- [ ] Concurrent equal requests through primary, secondary, and tertiary nodes yield identical
      responses, one completed AppInbox result, one aggregate/effect set, and one outbox set.
- [ ] Concurrent different intents with one scoped request ID yield one winner; all losers receive
      canonical 409 and produce no losing effect.
- [ ] Different administrators may reuse a request ID without job/page/aggregate/outbox collisions.
- [ ] Same request ID across prune, topology recompute, and CRDT administration succeeds
      independently.
- [ ] Current authorization is checked before replay; redacted artifacts never contain bearer
      tokens, passwords, access tokens, or tickets.
- [ ] Evidence distinguishes completed and failed AppInbox rows, domain receipts/events, aggregate
      progress, conditional deletes, outbox rows, and atomic completion.
- [ ] The existing 100-client/five-group/three-node PostgreSQL medium-scale churn includes bounded
      duplicate request waves without unbounded waiting.
- [ ] The topology restart replay gate still succeeds after API owner moves.

No black-box scenario sleeps for the five-minute reservation timeout. Use deterministic clocks in
focused integration tests for reservation recovery and retry exhaustion.

### Task 8: Complete consumer, compatibility, navigation, and validation closure

**Consumer closure:**

- [ ] Search the full repository for every predecessor filename, class vocabulary, generic `init`
      alias, old route path, body/header request ID, raw prune job identity, and duplicate prune
      decision. No old private path or obsolete behavior remains.
- [ ] Verify OpenAPI inventories every covered admin mutation path and documents neither
      `Idempotency-Key` nor body `requestId`.
- [ ] Update public docs/examples only where they point at moved owners or old HTTP contracts.
- [ ] Run a cold API navigation probe from route installation: locate read vs mutation ingress,
      authorization, normalized intent, domain gateway, AppInbox owner, page transaction, durable
      failure/result, and HTTP response without a wrong-directory guess.
- [ ] Review every touched-file warning and legacy candidate. Fix in-scope defects under RED tests.
      For a confirmed out-of-horizon weakness, search existing issues before creating one focused
      issue; do not create speculative follow-up work.

**Focused correctness:**

```sh
npx vitest run packages/tests/shared-server/admin-operations
npx vitest run packages/tests/shared-server/integration/postgres/admin-prune-page-delete.test.ts
npx vitest run \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/mutation-route-owner-analysis.test.ts

cd apps/api-v1
deno test -A test/admin-operations
deno test -A test/routes/api-mutation-openapi-contract.test.ts
```

**Types, formatting, and application checks:**

```sh
npm run typecheck
npm run typecheck:tests
npx tsc -p packages/shared-server/tsconfig.json --noEmit

cd apps/api-v1
deno task check
deno lint src/admin-operations test/admin-operations
deno fmt --check src/admin-operations test/admin-operations
```

**Database and black-box behavior:**

```sh
npm run db:test:up
npm run test:postgres:integration
npm run test:api-v1:black-box:recipes
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres
npm run test:api-v1:black-box:postgres:crdt
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:api-v1:black-box:postgres:topology-replay
```

If a service is unavailable, record the exact environment-only skip and run every compatible local
gate. Do not report an environment skip as a pass.

**Fresh performance comparison:**

Create compatible, separately migrated baseline and candidate databases. Run the repository's
documented state-write procedure for both commits with identical host/configuration inputs:

```sh
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-admin-baseline.json

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
Never compare with stale or differently configured artifacts, and do not commit `tmp/perf` output.

**Style, structure, coupling, legacy, and diff checks:**

```sh
ADMIN_MUTATION_BASE=$(git merge-base HEAD origin/main)

npm run check:repo-style
npm run check:repo-style:changed -- "$ADMIN_MUTATION_BASE"
npm run check:repo-structure -- --base "$ADMIN_MUTATION_BASE"
npm run test:repo-structure
npm run test:repo-governance
npm run check:test-structure-coupling -- --changed "$ADMIN_MUTATION_BASE" HEAD
node scripts/review-legacy.mjs \
  "$ADMIN_MUTATION_BASE" HEAD \
  --registry docs/production-legacy-exceptions.md

git diff --name-only --diff-filter=ACMR "$ADMIN_MUTATION_BASE"...HEAD -- \
  '*.ts' '*.mts' '*.js' '*.mjs' '*.json' '*.md' \
  | rg -v '^apps/api-v1/' \
  | xargs npx prettier --check

git diff --check "$ADMIN_MUTATION_BASE"...HEAD
```

Inspect command usage if an option has changed; fix this plan rather than silently substituting an
unrecorded gate.

**Review and delivery:**

- [ ] Run `npm run pr:delivery -- status` before broad final validation. Repair a real merge
      conflict; do not refresh a mergeable branch solely because it is behind.
- [ ] Obtain independent code review with zero unresolved Critical, Important, or Minor findings.
- [ ] Commit and push the API/closure slice as a reviewable milestone and update the existing PR
      with exact pass/fail/skip results.
- [ ] Run `npm run pr:delivery -- ready` once at handoff. The ordinary PR is the delivery entity; do
      not create a governance ledger, receipt, digest, or post-merge task.
- [ ] When GitHub reports the PR merged, stop.

## Acceptance Criteria

The child is complete only when:

- the AppInbox command owner, page protocol/worker, aggregate progress, PostgreSQL persistence, and
  durable result are directly navigable under the admin feature;
- API route entry, mutation composition, and strict failure/idempotency handling are directly
  navigable under `apps/api-v1/src/admin-operations`;
- public HTTP/package behavior, persisted rows/formats, topics, keys, retries, reservation timeout,
  and domain delegation remain compatible;
- behavior tests and black-box evidence prove sequential and concurrent replay/conflict/isolation,
  exact terminal failure, no-op/dry-run, three-node atomicity, and no duplicate effects;
- old private paths, correction/task test names, generic route initialization, duplicate protocol
  ownership, and direct low-level deletion are absent;
- every affected legacy item and touched-file warning has a recorded disposition;
- focused, type, PostgreSQL, black-box, OpenAPI, style, structure, coupling, legacy, diff, and fresh
  performance gates pass or have a truthful environment-only skip;
- cold construction/runtime navigation probes pass, the final head merges cleanly with live
  `origin/main`, independent review is clean, and PR delivery is ready.

## Explicit Non-Goals

- No read-only `AdminSupportService` decomposition or admin/statistics reorganization.
- No topology or CRDT domain rewrite.
- No new pruning algorithm, queue, reservation, receipt, lease, retry, schema, table, migration, or
  index policy.
- No API, request-ID, OpenAPI, wire, persisted-format, retention, or reservation-timeout change.
- No compatibility shim for old private paths after verified consumers move.
- No black-box runner redesign or tests that sleep through production timeouts.
- No global repository cleanup outside recursive touched-file closure.
- No third concrete slice or post-merge governance artifact.

## Completion Handoff

Report:

1. exact implementation base, final head, tree, clean status, PR URL, and delivery state;
2. changed files and the final construction/runtime owner-to-result traces;
3. preserved behavior, any separately approved behavior changes, and compatibility decisions;
4. idempotency evidence for sequential replay, concurrent equal/different contenders, scope
   isolation, durable failures, and one-effect atomicity;
5. validation commands and exact pass/fail/environment-skip results, including performance artifact
   paths and comparison;
6. touched-file style, structure, coupling, legacy, and navigation dispositions;
7. issues created or reused with URLs, or an explicit statement that no follow-up was needed.

End the handoff with the repository-required `### Commands executed and what they taught us`
section.
