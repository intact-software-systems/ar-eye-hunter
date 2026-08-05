# Rallar Client-State Server Structure Implementation Plan

**Status:** Approved at exact Git blob
`71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`. PR A Tasks 1-3 are complete,
published, merged, and default-workflow verified. PR B Tasks 4A-4E reached
their local milestone commits; the Task 5 whole-PR review-fix remains in
progress. PR C and the later ledger have not begun, and this tree records no
future PR B publication or later evidence.

**Program:**
[Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md)

**Execution protocol:**
[Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md)

**Pilot basis:** The human approved the 2026-08-04 pilot conclusions at master
blob `4172437a6ca3ef6008446a1797582b4e4b9406a9` and execution-plan blob
`3dc5495f5ee21b615a44f4e65c92deee8b42a940`. This plan applies all seven
approved migration-method corrections. It does not reopen or rewrite the
completed room/group-state evidence.

## Global Constraints

- This child is limited to authoritative shared-server client-state entry,
  mutation, persistence, snapshot/cache ownership, mirrored tests, and durable
  navigation evidence.
- API-v1 callers are characterized and may receive canonical import-path-only
  updates when required to bypass compatibility wrappers. Their routes,
  composition, OpenAPI, authentication, defaults, serialization, and file
  organization are not reorganized by this child.
- Preserve every public package export and direct import path, persisted JSON
  format, storage namespace and key, property order, default, omission, clone,
  error, timing event, return value, and volatile-value invocation point.
- AppInbox remains the only production entry for client-state mutations. Keep
  reservation, command identity, transaction ownership, retry classification,
  total attempts, backoff, fairness, optimistic compare-and-set, idempotency,
  receipts, events, required outbox intents, final outbox writes, atomicity,
  observation, wake, and completion behavior exact.
- Preserve issued-session and system authority, authorized WebSocket generation
  lifecycle, session expiry, canonical instance/session ordering, and stable
  snapshot-read behavior.
- Preserve TypeScript `7.0.2`, dependencies, lockfiles, workflow definitions,
  warning-only checker behavior, and every existing performance threshold.
- Preserve
  `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`
  unchanged.
- No auth, group topology, RTC/RTT, CRDT, admin, browser, or API-v1 organization
  child begins here.

## 1. Scope, Success Boundary, And Review-Size Decision

### 1.1 Success boundary

The child succeeds only when a human can start at any client-state mutation or
query entry, find its canonical owner by filename, and follow the relevant
read, compute, validate, transaction/write, durable result, after-commit effect,
retry, early exit, failure, cleanup, and caller-result boundaries without using
a compatibility module as the implementation map.

The durable navigation owner will be
`packages/shared-server/rallar-system/client-state/README.md`. It must be
derived from production symbols and kept current by semantic path/symbol tests;
it is navigation evidence, not runtime truth.

### 1.2 Explicit stacked-PR decision

The current concentrated production owners contain 5,716 physical lines. The
principal mirrored tests and fixtures contain more than 8,900 lines. Moving and
splitting those owners is expected to exceed 10,000 additions plus deletions,
even though the final path count is expected to remain below approximately 100
files. The feature also has more than three materially different control-flow
families: ordinary authenticated mutations, authorized WebSocket generation
lifecycle, expiry maintenance, queries/snapshots, and event/cache observation.

One implementation PR is therefore rejected. After the planning PR, use three
sequential implementation PRs:

1. **PR A — mutation protocol and functional core:** contracts, command
   translation, request/command validation, compute families, result
   validation, and the first durable navigation map.
2. **PR B — authoritative shell and persistence:** stable reads, persistence,
   transaction writes, service construction, AppInbox registration/handling,
   authorized WebSocket and expiry paths, snapshot/cache owners, and all
   runtime/concurrency evidence.
3. **PR C — code-standard alignment and final traceability:** align only the new
   or materially rewritten client-state owners and tests, reconcile temporary
   compatibility use, finalize navigation, and decide supplementary ratchets.

Each PR starts only after the preceding PR's exact resulting-main SHA passes
Run Hetzner Supported Distributed Manifests. Each PR receives a separate
independent whole-PR review, Branch Release Gate, and human merge decision.
The child-specific goal is created only after exact plan-blob approval and is
reused across all three implementation PRs.

### 1.3 Pre-authorized private target-tree refinement

During execution, the exact private target tree in Section 4 may be refined
without another approval when implementation or independent review proves a
different private split, move, rename, consolidation, or test owner is needed
for cohesive ownership, acyclic dependencies, descriptive filename/primary-
symbol alignment, a direct call path, the 400-line module limit, or the 60-line
general-function limit.

That authority is behavior-neutral only. It may not add or alter a public or
persisted contract, compatibility hop, dependency, state, lifecycle,
transaction, retry, authority, storage-key, timing, outbox, or performance
rule. The executor records the factual refinement in this plan before the
affected PR freezes, reruns invalidated gates, and stops if any locked rule
would change.

Task 2 used this authority for two private, behavior-neutral refinements. The
shared entity, event, audit, actor, and runtime-entry validators moved to
`client-state/client-state-contract-validation.ts`; receipt and idempotency-record
validators moved to `client-state/client-mutation-receipt-validation.ts`. The
two lower-level owners remain below both the transitional persisted wrappers and
canonical result validation. This
avoids a legacy-to-canonical runtime cycle and duplicate validators without
moving persistence normalization, persisted identity checks, codecs, keys, or
repositories. Shared closed operation, entity, and event inventories moved to
`mutation/client-mutation-contracts.ts`, below both shared contract validation
and command validation; the former deep command-validation exports remain direct
named compatibility exports of those same Set objects. Shared pure
audit/actor/default-principal/revision/candidate state
construction moved to `mutation/compute/compute-client-mutation-state.ts`; this
keeps `compute-client-mutation-result.ts` cohesive and below 400 lines while the
six family owners retain direct named call paths. Both refinements are private,
acyclic, and behavior-neutral.

Independent Task 4D review uses the same authority for one expiry-only private
fixture owner: `client-state/app-client-inbox-expiry-fixtures.ts`. It owns the
AppInbox expiry queue, results, parser, and issued-authority fixtures directly
used only by `app-client-inbox-expiry.test.ts`; it adds no production dependency
or behavior. It does not replace the reserved
`client-state/client-state-test-runtime.ts` target, which remains exclusively
the later `client-state-phase-test-driver.ts` move.

Task 4E uses the same authority to keep that 549-line driver cohesive and under
the hard limits after its move. `client-state/client-state-test-runtime.ts`
retains the exact canonical driver factory and exports;
`client-state/client-state-test-driver-contracts.ts` owns its operation
contract; `client-state/client-state-test-operations.ts` owns request-to-command
projection for its principal, instance, session, authorised-WebSocket, expiry,
and query operations; and `client-state/client-state-test-transaction.ts` owns
the in-memory SQL transaction, event rollback, and outbox fixtures. These are
direct test owners, not a generic runtime, dependency bag, compatibility layer,
or production hop. They preserve the prior test-driver behavior and exported
API while making every module at most 400 lines and every general function or
callback at most 60 lines.

Task 5 uses the same authority to finish the predecessor test moves without
retaining three mixed root owners. AppInbox authentication, operation,
transaction, rollback, and public-compatibility cases use directly owned
fixtures; concurrency, persistence-validation, lifecycle-validation, replay,
authorized-WebSocket generation, and transaction-convergence cases use
behavior-named owners. The 542-line lineage test is split into a test owner, an
evidence helper, and an immutable inventory owner. These are test/evidence
ownership refinements only: all predecessor cases, fixtures, literals,
mutations, expectations, and assertion sites remain, and production is
unchanged from the pre-review-fix Task 4E candidate.

## 2. Current Evidence And Human Navigation Baseline

### 2.1 Current concentrated ownership

At approved planning base `44d1c9ff74f2d1a837f49c3a6ed696491788cd8c`:

| Current owner                           | Lines | Responsibilities currently mixed                                                                                                                                                                              |
| --------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/client-state-mutations.ts`    | 2,822 | contracts, request/command/persisted validation, normalization, authority, six compute families, result construction, idempotency, and computed-result validation                                             |
| `repositories/ClientStateRepository.ts` |   835 | namespaces, keys, persistence decoding, aggregate/child reads and writes, list/snapshot assembly, idempotency, events, and corruption errors                                                                  |
| `services/AppClientInboxService.ts`     |   782 | eight registrations, ingress authentication, command translation, ordinary mutations, authorized WebSocket lifecycle, expiry batching, transaction selection, observation, and public enqueue/completion APIs |
| `services/client-state-service.ts`      |   694 | public service contract, composition, read/compute/validate/write phases, command input projection, result projection, session lookup, and timing                                                             |

Smaller client owners are dispersed across `rallar-system/`, `services/`, and
`repositories/`, so a reader cannot identify the feature boundary from one
directory.

### 2.2 Current focused warning disposition

The repository checker is warning-only. The broad current `services` scan
reports 290 default findings and 301 construction-detail findings; the broad
`repositories` scan reports 89 default findings. Those totals include unrelated
features and are not a client-state score. Task 1 captured the focused findings
on exact base `39b2b7e6312507addfb4629c9d84ab476e83c362` as 78 warning rows.
The human approved the evidence-backed disposition and owner/rationale mapping
for every row with no exceptions. The approved disposition categories are:

- inherited and mechanically moved, with symbol/span provenance;
- fixed behavior-neutrally in its owning PR;
- retained boundary evidence, with rationale and owner; or
- blocked because a behavior/public/persisted decision is required.

The approved map assigns each row to its mechanically moved PR A or PR B owner,
or to the existing owner of a retained boundary or compatibility constraint.
It does not invent a code fix, behavior decision, or exception. An exit-zero
checker result without the recorded mapping remains insufficient. No finding
becomes globally blocking and no checker behavior changes in this child.

### 2.3 Navigation evidence protocol amendment

No valid controlled human navigation-time sample was collected on exact base
`39b2b7e6312507addfb4629c9d84ab476e83c362`. The human explicitly waives the
before/after timing comparison for this client-state child. No executor,
reviewer, PR, handoff, or later ledger may fabricate elapsed times, wrong-file
counts, compatibility-hop observations, unresolved-question counts, or human
productivity/navigation-time claims for that base or a later tree.

The independently reviewed, source-derived traces for ordinary mutations,
authorized WebSocket lifecycle, expiry maintenance, and query/snapshot/cache
remain the qualitative baseline. PR A and final PR C review still require
code-derived family traces and human review of the actual code and diff. Those
qualitative traces are not a timing sample and must not be presented as one.

## 3. Current Production, Consumer, And Test Trees

### 3.1 Current production tree in scope

```text
packages/shared-server/
  mod.ts
  rallar-system/
    client-presence-state.ts
    client-state-storage-keys.ts
    middleware/RallarMiddleware.ts
    repositories/ClientStateRepository.ts
    services/
      AppClientInboxService.ts
      authorised-ws-client-app-inbox.ts
      cached-client-state-service.ts
      client-expired-state-authority.ts
      client-mutation-authority.ts
      client-state-mutations.ts
      client-state-semantic-equality.ts
      client-state-service.ts
      client-state-snapshot-read-through-cache.ts
      AppInboxService.ts                       # retained transaction/retry owner
      app-inbox-transaction-writer.ts          # retained transaction writer
      ws-session-generation-lifecycle.ts       # retained generation owner
    state-sync-cache-hydration.ts
```

`AppInboxService.ts`, `app-inbox-transaction-writer.ts`, and
`ws-session-generation-lifecycle.ts` are characterized dependencies, not move
targets. `RallarMiddleware.ts`, `state-sync-cache-hydration.ts`, and `mod.ts`
may receive canonical import/export-only updates.

### 3.2 Current callers characterized but not reorganized

```text
apps/api-v1/src/
  middleware.ts
  middleware-contract.ts
  create-rallar-server.ts
  repository/createStateRepositories.ts
  routes/client-state-routes.ts
  routes/spa-statistics-routes.ts
  routes/ws-routes.ts
  services/client-state-service.ts
  services/create-api-crdt-document-authorizer.ts
packages/shared-server/rallar-system/
  admin-support/AdminSupportService.ts
  spa-statistics/SpaStatisticsService.ts
  group-state/presence/reconcile-expired-group-presence.ts
  group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts
```

These callers retain behavior. Direct import-path-only changes are permitted
only where the caller is an internal canonical consumer. API-v1's service
compatibility module and route organization remain for a future API-v1
client-state child.

### 3.3 Current primary mirrored tests and evidence

```text
packages/tests/shared-server/
  app-client-inbox-service.test.ts
  client-state-concurrency.test.ts
  client-state-phase-test-driver.ts
  client-state-service-idempotency.test.ts
  client-state-snapshot-read-through-cache.test.ts
  postgres-client-phase-driver.ts
  postgres-presence-expiry-concurrency.test.ts
  app-inbox-ws-close-convergence.test.ts
  app-inbox-ws-close-expiry.test.ts
  app-inbox-ws-close-test-harness.ts
  authoritative-mutation-read-compute-validate-write.test.ts
  cached-state-services.test.ts
  state-sync-event-replay-characterization.test.ts
packages/tests/repo/
  rallar-group-state-owner-integrity.test.ts
packages/tests/api-v1/
  client-and-group-state-repositories.test.ts
apps/api-v1/test/
  client-state/client-state-mutation-routes.test.ts
  client-state/client-state-read-routes.test.ts
  client-state/client-state-route-test-runtime.ts
  services/client-state-service.test.ts
  db/pglite-app-inbox-ws-close-convergence.test.ts
  db/pglite-app-inbox-ws-close-test-harness.ts
```

Mixed client/group and API-v1 tests remain in place unless Section 5 assigns an
exact client-only successor. API-v1 test behavior is compatibility evidence,
not authority to reorganize API-v1.

### 3.4 Retained black-box and performance evidence

```text
packages/shared-test/black-box-runner/
  tests/api-v1/api-v1-client-state.json
  tests/api-v1/api-v1-state-medium-scale-churn.json
  state-write-evidence/api-v1-state-write-command-codecs.ts
  state-write-evidence/api-v1-state-write-evidence-derivation.ts
  state-write-evidence/api-v1-state-write-receipt-evidence.ts
scripts/perf/
  api-v1-state-write-concurrency-bench.ts
  compare-api-v1-state-write-results.mjs
  compare-group-state-server-structure-performance.mjs
  write-api-v1-state-write-pooled-results.mjs
```

These files are retained behavior/evidence consumers. Import-only updates are
permitted where a canonical client-state symbol moved. Recipe steps, evidence
contracts, measurement harness behavior, comparators, evaluators, and
thresholds remain unchanged.

### 3.5 Exact active compatibility-import inventory

The approved planning base has these 49 TypeScript/MJS files naming at least
one current client-state implementation or compatibility path. This is the
known-consumer inventory for Section 7.2; execution must rerun the AST-based
active-import scan rather than treating this prose as live truth.

```text
apps/api-v1/src/middleware-contract.ts
apps/api-v1/src/middleware.ts
apps/api-v1/src/repository/createStateRepositories.ts
apps/api-v1/src/routes/client-state-routes.ts
apps/api-v1/src/routes/ws-routes.ts
apps/api-v1/src/services/client-state-service.ts
apps/api-v1/src/services/create-api-crdt-document-authorizer.ts
apps/api-v1/test/client-state/client-state-mutation-routes.test.ts
apps/api-v1/test/client-state/client-state-route-test-runtime.ts
apps/api-v1/test/db/pglite-app-inbox-ws-close-convergence.test.ts
apps/api-v1/test/db/pglite-app-inbox-ws-close-test-harness.ts
apps/api-v1/test/db/pglite-sql-adapter.test.ts
apps/api-v1/test/services/client-state-service.test.ts
packages/shared-server/mod.ts
packages/shared-server/postgres/rallar-system/PSqlStateEventRepository.ts
packages/shared-server/postgres/rallar-system/createStateRepositories.ts
packages/shared-server/rallar-system/repositories/ClientStateRepository.ts
packages/shared-server/rallar-system/services/AppClientInboxService.ts
packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts
packages/tests/api-v1/client-and-group-state-repositories.test.ts
packages/tests/repo/rallar-group-state-owner-integrity.test.ts
packages/tests/shared-server/app-client-inbox-service.test.ts
packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts
packages/tests/shared-server/app-inbox-service.test.ts
packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts
packages/tests/shared-server/app-inbox-ws-close-expiry.test.ts
packages/tests/shared-server/app-inbox-ws-close-test-harness.ts
packages/tests/shared-server/cached-state-services.test.ts
packages/tests/shared-server/client-state-concurrency.test.ts
packages/tests/shared-server/client-state-phase-test-driver.ts
packages/tests/shared-server/client-state-service-idempotency.test.ts
packages/tests/shared-server/client-state-snapshot-read-through-cache.test.ts
packages/tests/shared-server/fixtures/postgres-app-inbox-worker-runtime.ts
packages/tests/shared-server/fixtures/postgres-app-inbox-worker-services.ts
packages/tests/shared-server/fixtures/postgres-expiry-worker.ts
packages/tests/shared-server/mutation-boundary-analysis.ts
packages/tests/shared-server/mutation-boundary-traversal.ts
packages/tests/shared-server/mutation-route-owner-analysis.test.ts
packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts
packages/tests/shared-server/mutation-routing-owner-inventory.ts
packages/tests/shared-server/postgres-client-phase-driver.ts
packages/tests/shared-server/rallar-middleware-crdt-principal-correction-4.test.ts
packages/tests/shared-server/rallar-middleware.test.ts
packages/tests/shared-server/runtime-state-hierarchical-prefix.test.ts
packages/tests/shared-server/state-sync-event-replay-characterization.test.ts
packages/tests/shared/authoritative-state-contracts.test.ts
scripts/perf/api-v1-state-write-concurrency-bench.ts
scripts/perf/api-v1-state-write-receipt-evidence.ts
scripts/perf/client-list-fanout-bench.ts
```

Package/public and application consumers may remain on compatibility paths when
their removal condition is outside this child. Canonical client-state and
shared-server implementation owners must move to direct canonical imports.

## 4. Exact Target Production Tree And Ownership

### 4.1 Final target tree

```text
packages/shared-server/rallar-system/
  client-state/
    README.md
    client-state-contract-validation.ts
    client-mutation-receipt-validation.ts
    client-presence-state.ts
    client-state-semantic-equality.ts
    client-state-service-contracts.ts
    client-state-service-timing.ts
    client-state-service.ts
    client-state-validation-primitives.ts
    inbox/
      app-client-inbox-contracts.ts
      app-client-inbox-service.ts
      authenticated-client-mutation-ingress.ts
      authorised-ws-client-app-inbox.ts
      client-state-inbox-handler.ts
    mutation/
      validate-client-expired-session-authority.ts
      client-mutation-authority.ts
      client-mutation-command.ts
      client-mutation-contracts.ts
      command-validation/
        validate-client-mutation-command.ts
        validate-client-mutation-operation-input.ts
        validate-client-mutation-request.ts
      compute/
        compute-client-instance-mutation.ts
        compute-client-mutation-result.ts
        compute-client-mutation-state.ts
        compute-client-mutation.ts
        compute-client-principal-mutation.ts
        compute-client-session-connect.ts
        compute-client-session-disconnect.ts
        compute-client-session-expiry.ts
        compute-client-session-heartbeat.ts
      read/
        read-client-mutation.ts
      result-validation/
        validate-client-mutation-authority-policy.ts
        validate-client-mutation-read.ts
        validate-client-mutation-result.ts
        validate-client-mutation.ts
      write/
        write-client-mutation.ts
    persistence/
      assemble-client-state-snapshot.ts
      client-state-persistence-codec.ts
      client-state-persistence-contracts.ts
      client-state-repository-reads.ts
      client-state-repository.ts
      client-state-runtime-namespaces.ts
      client-state-snapshot-repository.ts
      client-state-storage-keys.ts
      validate-persisted-client-state.ts
    snapshot/
      cached-client-state-service.ts
      client-state-snapshot-read-through-cache.ts
```

The feature has more than 20 production modules, so `README.md` is mandatory.
No `mod.ts` barrel is added. Canonical internal modules import their owning file
directly.

The exact final compatibility tree retained outside the canonical feature is:

```text
packages/shared-server/
  mod.ts                                      # exports canonical owners directly
  rallar-system/
    client-presence-state.ts                  # named one-hop compatibility exports
    client-state-storage-keys.ts              # named one-hop compatibility exports
    repositories/ClientStateRepository.ts     # named one-hop compatibility exports
    services/
      AppClientInboxService.ts
      authorised-ws-client-app-inbox.ts
      cached-client-state-service.ts
      client-expired-state-authority.ts
      client-mutation-authority.ts
      client-state-mutations.ts
      client-state-semantic-equality.ts
      client-state-service.ts
      client-state-snapshot-read-through-cache.ts
```

Every file except `mod.ts` is re-export-only under Section 7.2. `mod.ts`
preserves the package export names by exporting canonical owners directly; it
does not route the package surface through a compatibility file.

### 4.2 Filename and primary-symbol contract

| Target file                                | Primary symbol or responsibility                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `client-state-service-contracts.ts`        | `ClientStateService`, its public input/result contracts, and cohesive narrow phase capabilities         |
| `client-state-service.ts`                  | `createClientStateService` and visible service composition                                              |
| `client-state-service-timing.ts`           | `createTimedClientStateService` with a closed operation-name inventory                                  |
| `client-state-validation-primitives.ts`    | generic record/key/scalar/JSON/principal-ref/digest validation shared downward                          |
| `client-state-contract-validation.ts`      | shared client entity/event/audit/actor/runtime-entry validation below persistence and mutation callers  |
| `client-mutation-receipt-validation.ts`    | shared receipt and idempotency-record validation below persisted wrappers and result validation         |
| `app-client-inbox-service.ts`              | public `AppClientInboxService`, constructor registration, and public enqueue/completion methods         |
| `client-state-inbox-handler.ts`            | later runtime ordinary, authorized-WS, and expiry processing with transaction/exit ownership visible    |
| `authenticated-client-mutation-ingress.ts` | ingress read and durable issued-session/system authority checks                                         |
| `client-mutation-command.ts`               | request/payload-to-command projection and canonical command hashing                                     |
| `client-mutation-contracts.ts`             | exact command, read, computed, receipt, idempotency, and fact types plus shared closed enum inventories |
| `compute-client-mutation.ts`               | exhaustive operation-family dispatcher                                                                  |
| `compute-client-mutation-state.ts`         | shared pure audit, actor, default-principal, revision, required-state, and child-candidate construction |
| family compute files                       | the named principal, instance, connect, heartbeat, disconnect, or expiry decision                       |
| `read-client-mutation.ts`                  | stable authority/idempotency/aggregate/child read phase                                                 |
| `validate-client-mutation.ts`              | top-level post-compute invariant validation                                                             |
| `write-client-mutation.ts`                 | ordered conditional persistence, idempotency, event, and outbox writes                                  |
| `client-state-repository.ts`               | canonical public repository owner and transaction-bound construction                                    |
| `client-state-repository-reads.ts`         | aggregate/child/event/idempotency read ownership                                                        |
| `client-state-snapshot-repository.ts`      | list and stable snapshot assembly reads                                                                 |
| `client-state-persistence-codec.ts`        | stored defaults and normalization only                                                                  |
| `validate-persisted-client-state.ts`       | corruption-failing persisted contract validation only                                                   |
| `client-state-storage-keys.ts`             | exact namespaces, key construction, comparison, and decoding                                            |
| snapshot files                             | current cache/read-through capabilities with unchanged identities                                       |

No general function or callback may exceed 60 physical lines after material
rewrite, and no module may exceed 400 physical lines. Cohesion and direct call
paths decide splits; limits do not authorize pass-through helpers or generic
dependency bags.

### 4.3 Exact current-to-target production map

| Current source                                         | Target owner(s)                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/client-state-mutations.ts`                   | `mutation/client-mutation-contracts.ts`; `client-state-validation-primitives.ts`; `client-state-contract-validation.ts`; `client-mutation-receipt-validation.ts`; command-validation; compute (including private compute-state refinement); result-validation; persistence codec/validation; semantic equality |
| `services/client-state-service.ts`                     | service contracts/factory/timing; mutation command/read/write; exact result projection                                                                                                                                                                                                                         |
| `services/AppClientInboxService.ts`                    | inbox contracts, public service, authenticated ingress, and runtime handler                                                                                                                                                                                                                                    |
| `repositories/ClientStateRepository.ts`                | persistence contracts, repository, reads, snapshot repository, snapshot assembly, codec/validation, namespaces, and storage keys                                                                                                                                                                               |
| `services/authorised-ws-client-app-inbox.ts`           | `inbox/authorised-ws-client-app-inbox.ts`                                                                                                                                                                                                                                                                      |
| `services/client-expired-state-authority.ts`           | `mutation/validate-client-expired-session-authority.ts`                                                                                                                                                                                                                                                        |
| `services/client-mutation-authority.ts`                | `mutation/client-mutation-authority.ts`                                                                                                                                                                                                                                                                        |
| `services/client-state-semantic-equality.ts`           | `client-state/client-state-semantic-equality.ts`                                                                                                                                                                                                                                                               |
| `client-presence-state.ts`                             | `client-state/client-presence-state.ts`                                                                                                                                                                                                                                                                        |
| `client-state-storage-keys.ts`                         | `client-state/persistence/client-state-storage-keys.ts`                                                                                                                                                                                                                                                        |
| `services/cached-client-state-service.ts`              | `client-state/snapshot/cached-client-state-service.ts`                                                                                                                                                                                                                                                         |
| `services/client-state-snapshot-read-through-cache.ts` | `client-state/snapshot/client-state-snapshot-read-through-cache.ts`                                                                                                                                                                                                                                            |

Each old path contains only direct named re-export statements to the exact
canonical owner or owners listed above. It contains no executable logic,
wildcard barrel, default, callback, state, or second hop.

### 4.4 Acyclic dependency direction

The final feature dependency direction is:

```text
shared API/runtime contracts
  -> client-state-validation-primitives
  -> persistence contracts/codec/validation/keys/repositories
  -> mutation contracts and read/compute/validate/write owners
  -> service contracts/factory/timing and snapshot/cache owners
  -> inbox contracts/translation/handler/public AppClientInboxService
  -> middleware and application consumers
```

During PR A, shared closed enum inventories live with the mutation contracts,
so shared contract validation and command validation import a lower cohesive
contract owner rather than importing through a command-validation stage. The
legacy persistence wrappers remain independent from command validation. PR B
moves persistence-owned contracts to their final lower owner without reversing
that dependency direction.

`ClientMutationIdempotencyRecord` is canonically owned by
`client-state-persistence-contracts.ts` and re-exported where the existing
mutation surface requires it. Persistence never imports mutation, service,
inbox, middleware, or compatibility modules. Mutation read/write may import
canonical persistence owners. No canonical owner imports an old compatibility
path.

## 5. Exact Target Test And Evidence Tree

### 5.1 Final client-owned test tree

```text
packages/tests/shared-server/client-state/
  app-client-inbox-authentication.test.ts
  app-client-inbox-authorised-ws.test.ts
  app-client-inbox-expiry-fixtures.ts
  app-client-inbox-expiry.test.ts
  app-client-inbox-mutation-test-harness.ts
  app-client-inbox-operation-matrix.test.ts
  client-mutation-authorised-ws-generation.test.ts
  client-mutation-command-and-request.test.ts
  client-mutation-compute-test-fixtures.ts
  client-mutation-concurrency.test.ts
  client-mutation-concurrency-test-runtime.ts
  client-mutation-idempotency.test.ts
  client-mutation-lifecycle-validation.test.ts
  client-mutation-persisted-state-validation.test.ts
  client-mutation-principal-and-instance.test.ts
  client-mutation-result-validation.test.ts
  client-mutation-rollback-test-harness.ts
  client-mutation-session-lifecycle.test.ts
  client-mutation-session-replay.test.ts
  client-mutation-transaction-and-outbox.test.ts
  client-mutation-transaction-boundary-fixture.ts
  client-mutation-transaction-convergence.test.ts
  client-mutation-validation-test-fixtures.ts
  client-mutation-validation.test.ts
  client-state-public-compatibility.test.ts
  client-state-semantic-equality.test.ts
  client-state-service-test-fixtures.ts
  client-state-service-timing.test.ts
  client-state-snapshot-read-through-cache.test.ts
  client-state-test-driver-contracts.ts
  client-state-test-operations.ts
  client-state-test-runtime.ts
  client-state-test-transaction.ts
  postgres-client-mutation-test-driver.ts
packages/tests/repo/
  client-state-navigation-map-integrity.test.ts
  client-state-server-export-surface-evidence.ts
  client-state-server-lineage-evidence.ts
  client-state-server-lineage-provenance.test.ts
  client-state-server-mutation-lineage-inventory.ts
  client-state-server-ordinary-transaction-lineage-provenance.test.ts
  client-state-server-ownership.test.ts
  client-state-server-persistence-lineage-provenance.test.ts
  client-state-server-source-ratchet.test.ts
  client-state-server-test-ownership.test.ts
package.json                                  # register persistent repo-governance tests
plans/repo-style-lineages/
  client-state-server-structure.json
  client-state-server-structure-provenance.md
```

The exact retained mixed/consumer test tree relevant to final compatibility is:

```text
packages/tests/shared-server/
  app-inbox-expired-row-replacement.test.ts
  app-inbox-service.test.ts
  app-inbox-ws-close-convergence.test.ts
  app-inbox-ws-close-expiry.test.ts
  app-inbox-ws-close-test-harness.ts
  authoritative-mutation-read-compute-validate-write.test.ts
  cached-state-services.test.ts
  postgres-presence-expiry-concurrency.test.ts
  state-sync-event-replay-characterization.test.ts
packages/tests/api-v1/client-and-group-state-repositories.test.ts
packages/tests/shared/authoritative-state-contracts.test.ts
apps/api-v1/test/
  client-state/client-state-mutation-routes.test.ts
  client-state/client-state-read-routes.test.ts
  client-state/client-state-route-test-runtime.ts
  db/pglite-app-inbox-ws-close-convergence.test.ts
  db/pglite-app-inbox-ws-close-test-harness.ts
  services/client-state-service.test.ts
```

They stay at these paths and receive import-only updates when needed.

The exact case inventory is frozen before PR A. Every predecessor case,
fixture, independently written JSON literal, mutation, expectation, and
assertion site remains. Tests may move only to the named cohesive owner; they
may not be merged away, replaced by source-text checks, or weakened.

### 5.2 Test move map

| Current test owner                                     | Target ownership                                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app-client-inbox-service.test.ts`                     | authentication, operation matrix, authorized-WS, expiry, transaction/outbox, and public compatibility owners plus directly owned test harnesses   |
| `client-state-concurrency.test.ts`                     | command/request, validation, principal/instance, session lifecycle, concurrency, persistence/lifecycle validation, and transaction/convergence    |
| `client-state-service-idempotency.test.ts`             | idempotency, session replay/lifecycle, authorized-WebSocket generation, timing, and expiry owners plus directly owned fixtures                    |
| Task 4D expiry-only queue/results/parser/auth fixtures | `client-state/app-client-inbox-expiry-fixtures.ts`, directly owned only by `app-client-inbox-expiry.test.ts`                                      |
| `client-state-phase-test-driver.ts`                    | `client-state/client-state-test-runtime.ts` plus its direct contract, operation-projection, and transaction/outbox owners recorded in Section 1.3 |
| `postgres-client-phase-driver.ts`                      | `client-state/postgres-client-mutation-test-driver.ts`                                                                                            |
| `client-state-snapshot-read-through-cache.test.ts`     | same-named client-state owner                                                                                                                     |

The mixed PostgreSQL presence-expiry and AppInbox WebSocket-close suites stay at
their current paths. They are persistent cross-family concurrency evidence and
must update imports only. API-v1 route, PGlite, repository, and black-box tests
also stay at their current paths.

### 5.3 Semantic evidence and supplementary ratchets

Primary evidence must prove:

- each AppInbox type reaches exactly one canonical registration and handler;
- every operation reaches its exact command, read, compute, validate,
  transaction/write, durable-result, observation/wake, and failure exits;
- canonical shared-server modules never import compatibility-only paths;
- compatibility files are re-export-only and acyclic;
- persistence namespaces, keys, JSON, validation, and canonical ordering are
  unchanged; and
- the README's linked paths and named primary symbols exist.

The source inventory, exact case/assertion inventory, and structural-lineage
manifest are temporary supplementary evidence owned by this child. PR C must
decide, row by row, whether each is removed, replaced by semantic coverage, or
retained with a new owner and reason. The separate later ledger records that
already-made PR C decision. Historical debt capacity is allowed only for
mechanically moved source with exact approved-base blob and source-symbol/span
provenance. Semantically new code receives no allowance.

## 6. Current And Target Timelines And Family Traces

### 6.1 Current construction and registration

```text
apps/api-v1/src/middleware.ts initialise
  -> create runtime-state repository, event store, and snapshot cache
  -> createClientStateService
  -> createCachedClientStateService
  -> new AppClientInboxService(... nine positional dependencies ...)
  -> AppInboxService creates AppInboxTransactionWriter
  -> AppClientInboxService constructor registers eight onStateMessage callbacks
  -> RallarMiddleware returns runtime
  -> API route, WebSocket close, and expiry reconciliation retain the service
```

`onStateMessage` is registration, not runtime processing. The earliest later
invocation occurs only when the queue reader dispatches a reserved entry.

### 6.2 Target construction and registration

```text
API-v1 middleware composition (organization unchanged)
  -> create runtime repository, event store, lifecycle, cache, and timing
  -> createClientStateService(named input)
  -> createClientStateInboxHandler(named cohesive capabilities)
  -> new AppClientInboxService(existing public constructor preserved)
  -> register the same eight AppInbox types in predecessor order
  -> expose the same public service/enqueue/completion surface
```

Every mandatory dependency exists before registration. No setter, mutable
closure, service locator, optional processing dependency, or partially
constructed handler is permitted.

### 6.3 Ordinary authenticated mutation: complete current and target trace

Current:

```text
API-v1 client route
  -> processClientAppInbox
  -> AppClientInboxService.processAuthenticatedEntryUntilCompletion
  -> readAuthenticatedClientMutationIngress
  -> validateIssuedClientMutationIngress
  -> AppInboxService enqueue and wait
  -> later InboxQueueReader invokes registered callback
  -> AppClientInboxService.processCommand
  -> toClientMutationCommand
  -> clientStateService.read
  -> computeClientMutation
  -> validateClientMutation
  -> AppInboxService.writeMutation
  -> AppInboxTransactionWriter transaction/finalization
  -> clientStateService.write
  -> ClientStateRepository principal first, child CAS, idempotency, event,
     APP_OUTBOX/WS_OUTBOX writes
  -> confirmed commit
  -> observeSnapshot
  -> durable AppInbox result
  -> waiting API-v1 route serializes the existing response
```

Target:

```text
same HTTP caller and AppInbox public method
  -> authenticated-client-mutation-ingress.ts
  -> same AppInbox enqueue/wait and later queue invocation
  -> ClientStateInboxHandler.processClientStateMutation
  -> client-mutation-command.ts
  -> read-client-mutation.ts
  -> compute-client-mutation.ts -> one named operation-family compute owner
  -> validate-client-mutation.ts
  -> AppInboxTransactionWriter
  -> write-client-mutation.ts -> canonical persistence owners
  -> durable result after confirmed commit
  -> snapshot observation in predecessor order
  -> same caller-visible result and HTTP serialization
```

The queue wake remains at the inherited enqueue boundary. This child must not
invent an after-commit wake for client state.

AppInbox/queue retry re-enters stable read, compute, validate, and
transaction/write. Expected optimistic conflicts remain retryable. Invalid
ingress/authority/command/read/
computed state, idempotency conflict, conditional-write failure, event/outbox
failure, missing finalization, exhausted retry, and observation/wake failure
retain their exact existing classification and visibility.

### 6.4 Authorized WebSocket family

```text
HTTP WebSocket upgrade or server close callback
  -> toAuthorisedWsClientConnect/DisconnectEnqueue
  -> AppClientInboxService enqueue/process method
  -> later client AppInbox handler
  -> generation lifecycle read
  -> inactive connect or missing-session disconnect early durable transaction
     OR command -> read -> compute -> validate
  -> one transaction owns lifecycle guard/write and client mutation write
  -> confirmed commit -> snapshot observation -> result
```

The target handler keeps active versus inactive transaction selection visible.
Generation identity, high-water ordering, stale close behavior, rollback, and
no-orphan convergence remain exact.

### 6.5 Expiry maintenance family

```text
initPresenceExpiryReconciliation timer
  -> enqueuePresenceExpiryReconciliation
  -> AppClientInboxService.enqueueExpiredSessions
  -> later CLIENT_EXPIRED_SESSIONS handler
  -> listExpiredSessionCandidates
  -> candidate command/read/compute/validate in canonical list order
  -> one AppInbox transaction writes every required successor
  -> confirmed commit -> observe each applied snapshot in order
  -> durable result; enqueue-time queue wake and completion remain owned by AppInbox
```

At-most-one active waiting expiry entry, expiry authority, stale generation,
late heartbeat/disconnect, retention, cleanup, and failure atomicity stay exact.

### 6.6 Query, snapshot, event, and cache family

```text
API-v1/admin/statistics/cache-hydration caller
  -> ClientStateService named query
  -> ClientStateRepository stable aggregate/list/event read
  -> persistence decode and validation
  -> snapshot assembly and canonical instance/session ordering
  -> optional read-through/cache observation
  -> unchanged snapshot/event/caller result
```

No query becomes a mutation, no cache becomes authority, and no API-v1
response/default changes.

### 6.7 Representative black-box path

```text
api-v1-client-state.json or medium-scale churn recipe
  -> HTTP client-state mutation route
  -> authenticated AppInbox enqueue and later queue processing
  -> client mutation read/compute/validate/transaction/write
  -> durable receipt, event, and final outbox evidence
  -> HTTP completion and subsequent snapshot/event read assertion
  -> state-write evidence derivation verifies command, receipt, effect,
     atomic-completion, and canonical identity linkage
```

The child may update a moved import in the evidence derivation but may not
change the recipe, accepted evidence, or black-box meaning.

## 7. Ownership, Compatibility, And Locked Invariants

### 7.1 Exact ownership decisions

| Responsibility                            | Canonical target owner                                                                       |
| ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| public service contract and composition   | `client-state-service-contracts.ts` and `client-state-service.ts`                            |
| AppInbox registrations/public methods     | `inbox/app-client-inbox-service.ts`                                                          |
| later queue mutation/lifecycle processing | `inbox/client-state-inbox-handler.ts`                                                        |
| issued-session/system ingress             | `inbox/authenticated-client-mutation-ingress.ts` and `mutation/client-mutation-authority.ts` |
| command/request translation               | `mutation/client-mutation-command.ts` plus command-validation files                          |
| mutation read/compute/validate/write      | matching phase directories/files                                                             |
| persistent decode/defaults/validation     | persistence codec and validator                                                              |
| namespaces, keys, comparison, decoding    | `persistence/client-state-storage-keys.ts`                                                   |
| stable snapshot assembly                  | snapshot repository and assembly owner                                                       |
| transaction and retry semantics           | unchanged `AppInboxTransactionWriter` and `AppInboxService`                                  |
| WebSocket generation lifecycle            | unchanged `WsSessionGenerationLifecycleService`                                              |
| cached latest-value view                  | `snapshot/*` owners; durable state remains authoritative                                     |

The internal capabilities are fixed as cohesive responsibility views, not as a
new public surface:

```ts
type ClientStateMutationService = Pick<
  ClientStateService,
  'read' | 'compute' | 'validate' | 'write'
>;

interface ClientStateInboxHandlerDependencies {
  readonly mutationService: ClientStateMutationService;
  readonly sessionGenerationLifecycle: WsSessionGenerationLifecycleService;
  readonly expiryCandidates: Pick<ClientStateService, 'listExpiredSessionCandidates'>;
  readonly snapshotObserver: Pick<ClientStateService, 'observeSnapshot'>;
  readonly transactionWriter: AppInboxMutationTransactionWriter;
  readonly serviceId: string;
}

interface ClientStateInboxAfterCommitResult {
  readonly committedSnapshots: readonly ClientSnapshot[];
}
```

`AppClientInboxService.clientStateService` and its constructor/public methods
remain unchanged for consumers. The handler receives the existing writer object
directly; it does not duplicate an anonymous transaction signature. No wake
callback is passed to the handler because the predecessor client path wakes the
owning queue at enqueue, not after commit. Transaction callbacks return the
existing durable result separately from `ClientStateInboxAfterCommitResult` by
using `writeMutationWithAfterCommitResult`; the handler observes the exact same
snapshot object or ordered snapshot objects only after confirmed commit. The
private result never changes persisted AppInbox JSON.

### 7.2 Compatibility inventory and removal conditions

The following old paths remain direct one-hop named compatibility exports:

| Compatibility path                                     | Known consumers                                                                                                  | Removal condition                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `services/client-state-service.ts`                     | package `mod.ts`, API-v1 service/routes/ws/middleware, admin/statistics/state-sync, tests, external deep imports | breaking release or separately approved consumer migration proving no active import      |
| `services/AppClientInboxService.ts`                    | package `mod.ts`, API-v1 middleware/routes, Rallar middleware, group cleanup contract, tests                     | breaking release or separately approved consumer migration                               |
| `services/client-state-mutations.ts`                   | API-v1 routes, persistence/service predecessor imports, tests, possible deep imports                             | all internal canonical imports moved plus separately approved API/public removal         |
| `repositories/ClientStateRepository.ts`                | package `mod.ts`, API-v1 repository, middleware, tests/fixtures, deep imports                                    | breaking release or separately approved public migration                                 |
| `client-state-storage-keys.ts`                         | expiry authority, mutation/repository code, possible deep imports                                                | internal imports moved; external/deep consumer inventory proves none or breaking release |
| `client-presence-state.ts`                             | repository and possible deep imports                                                                             | same direct-import proof or breaking release                                             |
| `services/authorised-ws-client-app-inbox.ts`           | API-v1 WebSocket route and tests                                                                                 | future API-v1 client-state route child migrates caller and proves no other import        |
| `services/client-mutation-authority.ts`                | authorized-WS/service/tests                                                                                      | all internal callers canonical and active-import scan proves no external consumer        |
| `services/client-expired-state-authority.ts`           | mutation validation                                                                                              | canonical internal import moved and active-import scan proves no external consumer       |
| `services/client-state-semantic-equality.ts`           | mutation compute/tests                                                                                           | canonical internal import moved and active-import scan proves no external consumer       |
| `services/cached-client-state-service.ts`              | package `mod.ts`, API-v1 middleware/contracts, tests                                                             | breaking release or separately approved consumer migration                               |
| `services/client-state-snapshot-read-through-cache.ts` | package `mod.ts`, API-v1 middleware/CRDT authorizer, tests                                                       | breaking release or separately approved consumer migration                               |

Canonical code under `client-state/**` and other shared-server internal owners
must import canonical files, never these wrappers. API-v1 may remain a named
legacy consumer where changing organization or ownership is out of scope.

### 7.3 Persisted and transaction invariants

- Namespaces remain exactly `client-state:principals`,
  `client-state:instances`, `client-state:sessions`, and
  `client-state:idempotent`.
- Key encoding/decoding and canonical key comparison remain byte-for-byte.
- Aggregate principal ownership remains the first database statement.
- Instance and session conditional writes, idempotency insert, event append,
  and outbox writes retain exact order and rollback.
- Stable snapshot reads retain before/after principal guard semantics and
  corruption failure behavior.
- Receipt command/request/hash/revision/snapshot/event/outbox correlations stay
  exact. Replay and semantic no-op behavior stay exact.
- Canonical instance and active-session ordering and presence projection remain
  exact.
- Transaction callback invocation/retry/commit/failure semantics remain visible
  through the existing named AppInbox writer port; mutable callback state may
  not escape.

## 8. Structural, Alignment, And Semantic Boundaries

### 8.1 PR A permitted work

Behavior-preserving movement and naming of mutation contracts, validation,
pure compute families, result construction, and semantic equality; direct
canonical imports; characterization/semantic tests; initial README; exact
lineage provenance. No persistence or AppInbox behavior changes.

### 8.2 PR B permitted work

Behavior-preserving movement of stable read, persistence, write, service,
AppInbox, authorized WebSocket, expiry, snapshot, and cache ownership. Preserve
the public `AppClientInboxService` constructor and methods and the broad
`ClientStateService` surface. Narrow internal capabilities are permitted only
when cohesive and behavior-identical.

### 8.3 PR C permitted work

Code-standard alignment only in new or materially rewritten client-state files
and directly owned tests: descriptive names, named inputs, contract kinds,
imports, file order, spacing, 100-column guidance, 60-line functions, and
400-line modules. It may remove an internal compatibility wrapper only when the
Section 7.2 condition is proven; public/deep paths remain unless separately
approved.

### 8.4 Not approved

No semantic cleanup, request/default change, new validation, altered error
timing/text, API/OpenAPI/auth change, AppInbox or retry redesign, repository
format/key change, cache-authority change, direct database mutation, new
compatibility hop, checker/tool strictness change, performance threshold change,
or unrelated refactor is authorized.

## 9. Implementation Tasks

### Task 0: Publish And Approve This Plan

**Status:** complete. The human approved exact plan blob
`71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`. Planning PR #71 feature
`73bda0999be39248f486f038cccb06e99be39d1f` / tree
`930c866e5adab6544f1cf263f5bfd674696f555d` passed Branch Release Gate
`30869481618` attempt 1, merged as
`39b2b7e6312507addfb4629c9d84ab476e83c362`, and passed Run Hetzner Supported
Distributed Manifests `30871724277` attempt 1 for that exact main SHA.

- Publish only this plan and reciprocal master/execution updates.
- Require exact-blob human approval after planning Branch Release Gate.
- After approval, create one child goal and PR A branch from the planning PR's
  exact resulting-main SHA.

### Task 1: Characterize Before Editing

**Status:** complete. The human explicitly waived the missing controlled timing
sample and approved the evidence-backed disposition and owner mapping for all
78 warning rows. The independently reviewed source-derived traces remain
qualitative evidence only. Review finished with Critical 0 and Important 0.

- Freeze exact production/test/consumer inventories, named cases, literals, and
  assertion sites.
- Record all four current source-derived family traces as the qualitative
  baseline. Record the Section 2.3 sample waiver without invented values.
- Capture focused warning-only findings by exact file and attach the human-
  approved disposition and owner/rationale mapping for all 78 rows.
- Freeze persistence JSON/key/ordering, AppInbox operation matrix, transaction,
  retry, idempotency, receipt/outbox, WebSocket generation, expiry, snapshot,
  error, timing, and public-return characterization tests.
- Independently review the exact PR stack and predicted per-PR scope before the
  first production edit. Stop if a cohort is no longer independently reviewable.

### Task 2: Implement PR A Test-First

**Status:** implemented and independently accepted. The command/validation
cohort was accepted at commit `383a762c4cf2ff4361953ff594973ceb2b29546a` /
tree `bdbafb06edb44d52f13d009a92f79c72ade25ae0`; the compute/result cohort and
its behavior-restoring review fix were accepted at commit
`0058cb238d07c24cd30d10be1fff97a07dbe710b` / tree
`4a425ffa1073faefa67239ad3bbd724baad1db4d`. Both scoped reviews finished with
Critical 0 and Important 0. These are milestone facts, not the future final PR
A tree or publication envelope.

- Add semantic protocol/owner tests first and observe the expected failures.
- Register the new persistent repository-governance owners in
  `npm run test:repo-governance`; the temporary source ratchet remains directly
  runnable and is not allowed to become permanent by script registration.
- Establish mutation contracts, command translation, command/request
  validation, compute family owners, result validation, and semantic equality.
- Make `computeClientMutation` exhaustive and direct to one named family owner.
- Keep normalization, validation order, exact errors, defaults, omissions,
  cloning, command hashing, and volatile IDs unchanged.
- Add the first code-derived README timelines and exact file/symbol links.
- Add fail-closed lineage provenance only for mechanically moved findings.
- Run scoped reviews after command/validation and compute/result cohorts.

### Task 3: Freeze, Review, And Publish PR A

**Status:** complete. The sole Task 3 blocker—the stale temporary API-v1
group-state exact-base protected-path ratchet—was resolved by its separately
reviewed, human-authorized removal after PR #70 reached `ledger-published`.
PR #72 published exact feature head
`1e90c412855ea942a8b678aedde3b1c975efd5e8` and frozen tree
`e957db303770864fad04e6bb02b98cc03bcdc335`; Branch Release Gate run
`30997710887`, attempt 1, succeeded. The resulting main SHA is
`2fdba024bb347622727d337eb06fc13d2fe129fc` with the same tree, and Run Hetzner
Supported Distributed Manifests run `31008375282`, attempt 1, succeeded for
that exact SHA.

- Run every PR A focused and completion gate in Section 11.
- Require independent whole-PR review: Critical 0, Important 0.
- Freeze exact tree/commit, push non-forced, update the draft PR, and require
  Branch Release Gate for the exact SHA.
- Mark ready and stop for human merge. Do not begin PR B until resulting-main
  workflow success is externally verified.

### Task 4: Implement PR B Test-First

**Status:** local implementation milestones complete; Task 5 review-fix in
progress. Accepted cohort milestones are Task 4A
`8eab34026ee275dde4820e6cbb85c13ab2ecf4ac` / tree
`126c31aa57c2ad9387177035170bdcbc39470bab`, Task 4B
`e43ea59ac148572dede088e88bbc04cdfb05727c` / tree
`16b39e73fcfaf31ddd5c12328ade2d980e56ee17`, Task 4C
`48036c76b6a2b1243b3104a60b8551af7d7ae8ef` / tree
`a8527d4664da4170efc6331feb2108f61ae0c7e0`, and Task 4D
`e5d6b31ff1fedbb1e91b00ff6a06974b760a2a8a` / tree
`77e4f21c44c4040f2307f5ed0db02356ed030bd1`. Task 4E review/fix rounds reached
candidate `03beaefd22750243a1b03900ba98e776b70aa501` / tree
`f772137e6776ae5dba38880e17bce5f277b8e740`. These are local milestone facts,
not final PR B publication evidence.

- Start from PR A's verified resulting-main SHA on a new non-default branch.
- Establish persistence codec/validation, repository read/snapshot owners,
  mutation read/write, service construction/timing, AppInbox contracts/service/
  handler, authorized-WS ingress, expiry, and snapshot/cache owners.
- Preserve construction order and register the same eight AppInbox types in the
  same order with every required dependency valid before registration.
- Keep ordinary, inactive authorized-WS, active authorized-WS, missing-session
  disconnect, and expiry transaction selection visible in the handler.
- Migrate canonical shared-server imports away from compatibility paths.
- Split mirrored tests only by the exact ownership in Section 5.
- Review persistence, ordinary transaction, WebSocket lifecycle, expiry, and
  query/cache cohorts independently.

### Task 5: Freeze, Measure, Review, And Publish PR B

**Status:** in progress. Whole-PR review of the Task 4E candidate reported the
stale PR A/PR B plan record, three unfinished mixed test owners plus the
oversized lineage owner, and circular ratchet-removal wording. The current
review-fix is plan/test/evidence-only: it preserves the frozen predecessor case
and assertion inventory—38 moved named cases / 171 `expect(...)` sites, and 84
named cases / 346 sites in the complete client-state tree before and after—
removes the three obsolete roots, keeps every changed module at most 400 lines
and every general function/callback at most 60 lines, and makes PR C the ratchet
decision point. Final review, completion gates, candidate freeze, performance,
publication, and Branch Release Gate remain pending; this plan records none of
those future facts.

- Finish every content, plan-evidence, review-fix, and validation change before
  candidate freeze.
- Require scoped reviews plus whole-PR Critical 0 / Important 0.
- Run the fixed performance protocol in Section 10 once, without rerolls.
- If accepted, push the exact measured candidate, update the PR, require Branch
  Release Gate, mark ready, and stop for human merge.
- PR C waits for PR B's exact resulting-main workflow.

### Task 6: Implement PR C Alignment Test-First

- Add the temporary source/style ratchet before alignment.
- Align only new/materially rewritten client-state production and test files.
- Remove pass-through seams created only to satisfy size limits; keep real
  protocol, transaction, lifecycle, persistence, compatibility, and public
  boundaries.
- Re-run canonical-import scans and reconcile every compatibility path.
- Finalize the code-derived README family traces; do not create or imply a
  repeat navigation-time sample.
- Reconcile each focused warning's implementation outcome against the approved
  78-row mapping. Stop for a new human decision only if a row becomes blocked,
  a new warning appears, or behavior/public/persisted scope would change.
- Decide whether each supplementary ratchet is removed, replaced, or retained,
  and name the retained owner; the later ledger records that prior decision.

### Task 7: Freeze, Review, And Publish PR C

- Run all Section 11 final gates on the unchanged tree.
- Reconfirm that PR C is alignment-only and does not invalidate the PR B
  performance comparison. Apply Section 10.3: prove exact runtime blobs are
  unchanged or run its already-fixed second comparison. If runtime call
  topology or mutation/concurrency classification changed, stop for human
  review.
- Require independent whole-child trace review and PR review with Critical 0
  and Important 0.
- Freeze, push, update the PR, require Branch Release Gate, mark ready, and stop
  for human merge.

### Task 8: Publish The Later Ledger Separately

Only after PR C's exact resulting-main workflow succeeds may a separately
authorized ledger branch update this plan, the master, and execution plan. The
ledger records the planning and three implementation envelopes, the Section 2.3
sample waiver, the final code-derived trace review, and the reconciled warning
outcomes and the supplementary-ratchet decisions already made in PR C. It does
not publish a navigation-time comparison or make a new ratchet decision. It
does not begin auth or another Wave 2 child.

## 10. Fixed Correctness And Performance Protocol

### 10.1 Classification

PR A moves pure mutation decisions and does not change an I/O boundary; exact
semantic equivalence, deterministic compute, source lineage, TypeScript, and
completion gates are sufficient if that classification remains true.

PR B crosses both the mutation path and concurrency domain structurally because
it moves stable reads, transaction writes, AppInbox runtime dispatch, authorized
WebSocket generation guards, and expiry batching. It therefore requires the
governed comparison below. PR C is exempt only if its final diff changes no
production/runtime or benchmark-harness blob; otherwise Section 10.3 requires
its own already-fixed comparison.

### 10.2 Governed comparison fixed before candidate freeze

Use exactly one non-rerolled order-balanced A-B-B-A sequence:

1. the planning PR's exact resulting-main SHA, before any client-state
   implementation;
2. exact final PR B candidate;
3. the same exact PR B candidate;
4. the same exact planning resulting-main SHA.

Use the established pinned PostgreSQL 16 image and normalized isolated-host
protocol: fresh non-overlapping container per position, identical configuration
and resource limits, autovacuum/analyze disabled, zero preflight rows, zero
automatic maintenance, no other benchmark/container/Deno-LSP overlap,
`warmup=1`, `runs=9`, and `concurrency=10`. A position runs once. A
pre-measurement guard failure that produces no warmup/sample/artifact is
retained as rejected evidence and needs explicit human authorization before a
replacement sequence; a consumed or failed measurement is never rerolled.

Pool exactly 18 raw samples per workload per side with the existing fail-closed
pooler. Preserve source artifacts, environment records, logs, manifest, hashes,
and raw samples. Run the unchanged global comparator and retain its exact exit
and output, then run the existing unchanged 1.5% server-structure child
evaluator. Its historical filename remains visible; this plan reuses its
already-approved mathematical contract rather than duplicating or changing it.

The existing contract remains fixed:

- uncontended p95/p99 adverse latency at most 5%;
- shared throughput adverse movement at most 1.5%;
- hot throughput adverse movement at most 10%;
- SQL statements, rows read, serialized bytes, and transaction duration adverse
  movement at most 1.5%, unless the existing artifact-backed conflict-depth
  contract accepts an above-band resource movement;
- improvements unrestricted;
- zero baseline fails closed unless candidate is also zero; and
- zero tolerance for command counts, receipts, effects, retries, exhaustion,
  atomic completion, idempotency, ordering, audience, required/final outbox,
  schema, environment, artifact, and other correctness invariants.

Unknown findings, changed hashes, missing samples, incompatible environments,
malformed artifacts, or unsupported metrics fail closed. No result authorizes
optimization, threshold changes, rerolls, or a different candidate.

### 10.3 PR C exact-runtime applicability

PR B's comparison validates only its exact candidate runtime. Before PR C
freezes, compare every production/runtime and benchmark-harness blob with PR
B's exact resulting-main tree:

- If they are byte-identical, record the exact blob comparison and apply the
  PR B result without rerunning measurements.
- If any production/runtime blob differs, run one new non-rerolled A-B-B-A
  sequence under the exact Section 10.2 environment and thresholds, using PR
  B's exact resulting-main SHA as A1/A2 and the exact final PR C candidate as
  B1/B2.

This second sequence is pre-authorized here so alignment does not depend on a
late performance decision. If PR C changes the mutation/concurrency
classification, benchmark harness, environment, comparator, evaluator, or
threshold rather than only behavior-neutral source, stop for human review.

## 11. Validation Matrix

### 11.1 Planning PR

```bash
npx prettier --write \
  plans/rallar-client-state-server-structure-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md
git diff --check
npm run test:repo-governance
npm run test:unit
npm run test:ci
npm run build
```

### 11.2 PR A mutation-core gates

```bash
npx vitest run \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/client-state
npx vitest run \
  packages/tests/repo/client-state-navigation-map-integrity.test.ts \
  packages/tests/repo/client-state-server-lineage-provenance.test.ts \
  packages/tests/repo/client-state-server-ownership.test.ts \
  packages/tests/repo/client-state-server-persistence-lineage-provenance.test.ts \
  packages/tests/repo/client-state-server-ordinary-transaction-lineage-provenance.test.ts \
  packages/tests/repo/client-state-server-test-ownership.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm run test:repo-governance
npm run check:repo-style
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:construction-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
npm run check:repo-style:changed -- 2fdba024bb347622727d337eb06fc13d2fe129fc
npx prettier --check packages/shared-server/rallar-system/client-state packages/tests/shared-server/client-state packages/tests/repo/client-state-* plans/rallar-client-state-server-structure-plan.md
git diff --check
npm run test:unit
npm run test:ci
npm run build
```

The changed-style base is PR A's verified resulting-main SHA. Historical PR A
validation used its then-current owners; PR B reruns their complete semantic
coverage from the final behavior-named client-state tree above.

### 11.3 PR B authoritative-shell and concurrency gates

Run every PR A command against PR A's exact resulting-main base, plus:

```bash
npx vitest run \
  packages/tests/shared-server/app-inbox-ws-close-convergence.test.ts \
  packages/tests/shared-server/app-inbox-ws-close-expiry.test.ts \
  packages/tests/shared-server/cached-state-services.test.ts \
  packages/tests/shared-server/state-sync-event-replay-characterization.test.ts \
  packages/tests/shared-server/client-state
npm run test:rallar-server-hardening
(cd apps/api-v1 && deno task check)
npm run test:api-v1:black-box:memory
npm run test:postgres:presence-expiry
npm run test:api-v1:black-box:postgres:medium-scale
```

Then run the fixed Section 10 comparison. If required PostgreSQL infrastructure
is unavailable, stop with exact evidence; do not skip or silently substitute.

### 11.4 PR C and final child gates

Run all PR A and PR B commands against PR B's exact resulting-main base, plus:

```bash
npx vitest run packages/tests/repo/client-state-server-source-ratchet.test.ts
test "$(find packages/shared-server/rallar-system/client-state -name '*.ts' -type f -print0 | xargs -0 wc -l | awk '$2 != "total" && $1 > 400 { print }' | wc -l | tr -d ' ')" = "0"
if rg -n "rallar-system/(services/(AppClientInboxService|client-state-service|client-state-mutations|authorised-ws-client-app-inbox|client-mutation-authority|client-expired-state-authority|client-state-semantic-equality|cached-client-state-service|client-state-snapshot-read-through-cache)|repositories/ClientStateRepository|client-state-storage-keys|client-presence-state)" packages/shared-server/rallar-system/client-state; then exit 1; fi
```

The active-import check is supplemented by an AST-based semantic ownership
test; raw text alone is not removal evidence. Final PR C gates also include the
independent full family traces and human review of the actual code and diff. No
repeat navigation-time sample is required or permitted as completion evidence.

## 12. Human Review And Publication Gates

Required human decisions are:

1. approve or revise the exact planning blob;
2. review the qualitative source-derived baseline traces, the Section 2.3
   sample waiver, the approved 78-row warning map, and stacked-PR scope before
   first code;
3. approve or reject exact PR A head/tree after its Branch Release Gate;
4. verify PR A resulting-main workflow before PR B;
5. approve or reject exact PR B head/tree and governed performance evidence;
6. verify PR B resulting-main workflow before PR C;
7. approve or reject exact PR C head/tree, final code-derived traces, warning-
   outcome reconciliation, and performance applicability;
8. verify PR C resulting-main workflow; and
9. separately authorize, then merge and close, the non-circular ledger.

Each independent review reads the actual diff and code-derived traces, not only
the plan. Critical 0 and Important 0 are required. Ordinary in-scope findings
may be fixed autonomously; behavior, public/persisted, authority, transaction,
dependency, workflow, checker, threshold, or scope changes require a new human
decision.

## 13. Non-Circular Completion Evidence

This planning tree records only existing base/approval facts. It cannot record
its future tree, commit, PR, Branch Release Gate, merge SHA, or default workflow.

Each implementation PR may record already-existing predecessor publication
facts and its completed local tasks. Its future merge, resulting-main SHA, and
default workflow remain in the PR and Mandatory Completion Handoff external
envelope. A later PR may record a prior PR's completed external envelope only
after it exists.

The later ledger records the completed planning and three implementation
envelopes but cannot record its own future tree, commit, PR, Branch Release
Gate, merge, or default workflow. Only after that external envelope succeeds
may this child be marked `ledger-published`.

Any content change after a review, validation, or candidate freeze invalidates
the affected evidence. Historical measurements remain historical and are never
claimed for a changed runtime.

## 14. Acceptance Checklist

- [x] Human approved this exact plan Git blob.
- [x] Planning PR merged and its exact resulting-main workflow succeeded.
- [x] Before source-derived family traces and the Section 2.3 sample waiver were
      recorded without invented navigation-time values.
- [x] The three-PR stacked decision remained independently reviewable through
      PR A's two scoped implementation cohorts.
- [ ] Every predecessor public/deep path and package export remains compatible.
- [ ] Canonical internal callers bypass compatibility-only wrappers.
- [ ] Every request/command field, default, omission, clone, property order,
      error, and volatile invocation is exact.
- [ ] AppInbox, transaction, retry, idempotency, receipt, event, outbox,
      observation, wake, and completion semantics are exact.
- [ ] Persisted JSON, namespaces, keys, validation, snapshots, and ordering are
      exact.
- [ ] Authorized WebSocket and expiry behavior and concurrency are exact.
- [ ] Semantic tests remain primary; every ratchet has owner/removal decision.
- [x] The approved disposition and owner/rationale mapping covers all 78
      focused warning rows with no exceptions.
- [x] PR A review/gates and resulting-main workflow succeeded.
- [ ] PR B review/gates, governed performance, and resulting-main workflow
      succeeded.
- [ ] PR C review/gates, final code-derived family traces, human merge review,
      and resulting-main workflow succeeded.
- [ ] The later ledger independently reached `ledger-published`.
- [ ] API-v1 organization and every other Wave 2 domain remained unstarted.

## 15. Risks And Stop Conditions

| Risk                                                            | Required response                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| A target split creates forwarding layers or hides decisions     | Repartition by real command, phase, persistence, or lifecycle owner; do not satisfy line limits mechanically. |
| A move changes validation/error/default/serialization order     | Restore predecessor behavior test-first; stop if an intentional semantic change is required.                  |
| AppInbox or transaction/retry ownership becomes indirect        | Restore the named existing owner and direct trace; stop for any redesign.                                     |
| Authorized-WS generation or expiry convergence changes          | Restore exact lifecycle/authority/barrier evidence; stop for behavior change.                                 |
| Public/deep import needs a second compatibility hop             | Keep one direct old-to-canonical export and return the exact consumer for human review.                       |
| API-v1 route/composition work appears necessary                 | Stop; characterize or update a direct import only. Reserve organization for its later child.                  |
| Persistence namespace, key, JSON, or canonical ordering changes | Stop for separate persisted-contract approval.                                                                |
| A ratchet replaces semantic evidence                            | Restore semantic tests; ratchets remain supplementary and temporary.                                          |
| A warning is silently ignored because the checker exits zero    | Stop publication until a human disposition is recorded.                                                       |
| Performance protocol or environment changes after freeze        | Stop; do not reroll, change thresholds, or relabel evidence.                                                  |
| Protected unrelated plan changes                                | Stop and restore it before publication.                                                                       |
| Required external gate persistently fails                       | Stop with exact run/job/step; do not diagnose unrelated deployment systems.                                   |

## 16. Progress Record

| Milestone                  | State                  | Evidence                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pilot conclusions          | approved               | Human approval binds master blob `4172437a6ca3ef6008446a1797582b4e4b9406a9` and execution blob `3dc5495f5ee21b615a44f4e65c92deee8b42a940`.                                                                                                                                                                                                                        |
| Client-state child plan    | approved               | Human approval binds exact blob `71d2a48fa74f8eb03a2fea71c5adb6ab2ba3eb12`; planning PR #71 and its exact main workflow succeeded.                                                                                                                                                                                                                                |
| PR A mutation core         | complete               | PR #72 feature `1e90c412855ea942a8b678aedde3b1c975efd5e8` / tree `e957db303770864fad04e6bb02b98cc03bcdc335`; Branch Release Gate `30997710887` attempt 1 success; resulting main `2fdba024bb347622727d337eb06fc13d2fe129fc` / same tree; Run Hetzner Supported Distributed Manifests `31008375282` attempt 1 success.                                             |
| PR B authoritative shell   | review-fix in progress | Tasks 4A-4D are independently accepted at the exact milestone commits above. Task 4E reached candidate `03beaefd22750243a1b03900ba98e776b70aa501` / tree `f772137e6776ae5dba38880e17bce5f277b8e740`; Task 5 plan/test/evidence review-fix remains pending. No final candidate, performance, publication, merge, or default-workflow evidence exists in this tree. |
| PR C alignment/final trace | not started            | Requires PR B merge and exact resulting-main workflow.                                                                                                                                                                                                                                                                                                            |
| Later evidence ledger      | not authorized         | Requires PR C merge and exact resulting-main workflow, then separate authorization. PR C makes each supplementary-ratchet decision; the later ledger records that prior decision.                                                                                                                                                                                 |
| Other Wave 2 domains       | blocked                | Auth, topology, RTC, CRDT, and admin remain outside this child.                                                                                                                                                                                                                                                                                                   |

## 17. Planning Self-Review Record

Before publishing the planning PR, review the complete plan for:

- missing production, consumer, compatibility, and test owners;
- placeholders other than future facts that cannot yet exist;
- inconsistent filenames and primary symbols;
- generic ownership, pass-through modules, duplicate validation/defaults, hidden
  dependencies, callbacks, cycles, or extra hops;
- construction/registration confused with later runtime invocation;
- incomplete ordinary, authorized-WS, expiry, query, retry, early-exit, failure,
  cleanup, and result traces;
- hidden API-v1, public, persisted, authority, AppInbox, transaction, retry,
  storage, cache, timing, or performance changes;
- review cohorts likely to exceed the stated pressure thresholds;
- a supplementary ratchet without owner/removal decision;
- warning output without explicit human disposition; and
- any production behavior lacking exact human approval.

The self-review may correct planning facts and names. It may not implement or
pre-approve a semantic change.
