# Rallar Group Topology Server Structure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for every contract or behavior seam,
> `superpowers:requesting-code-review` at the review points, and
> `superpowers:verification-before-completion` before publication.

**Goal:** Make authoritative group-topology configuration ownership, AppInbox
ingress, mutation phases, persistence, transaction exits, explicit
reconfiguration, and downstream publication boundaries directly navigable by a
human without changing behavior.

**Architecture:** Consolidate group-topology configuration beneath the existing
`packages/shared-server/rallar-system/topology` feature. Keep pure protocol and
mutation decisions behind narrow stateful persistence and AppInbox shells.
Preserve the public `GroupTopologyManagementService` surface as a direct
compatibility facade while canonical internal callers use the named config,
reconfigure, planning, and inbox owners directly. RTC topology algorithms, RTC
RTT ingestion, WS delivery, browser consumption, and API-v1 organization remain
downstream consumers rather than becoming owners in this child.

**Tech Stack:** TypeScript 7.0.2, Deno, Node.js/npm workspaces, Vitest,
PostgreSQL/PGlite, Hono, AppInbox/APP_OUTBOX/WS_OUTBOX, Markdown, the
warning-only repository style checker, and the existing state-write performance
harness.

Date: 2026-08-08

Status: Approved and in execution. The human approved exact planning Git blob
`c9b5e92686ebbc5d4ff136dbea678c93fea1579f`; PR A executes only Tasks 1-2.

## 0. Prerequisite And Planning Publication Evidence

### 0.1 Locked planning base

This plan is drafted from exact `origin/main`
`c2cb79c020bceee7f67e6fbc364ba96ea0d6a530`, tree
`8bdea4402dad08dbd1892f2bd8c95671d615b8ff`.

The authoritative auth server child is `ledger-published` for purposes of Wave
2 sequencing based on this exact existing envelope:

- evidence-ledger PR #93;
- ledger feature head `aeff6435794dd70816789e4794b78e84fdfc89b0`;
- frozen ledger tree `8bdea4402dad08dbd1892f2bd8c95671d615b8ff`;
- the human-approved plan-only build-gate exception;
- resulting main SHA `c2cb79c020bceee7f67e6fbc364ba96ea0d6a530`;
- resulting main tree `8bdea4402dad08dbd1892f2bd8c95671d615b8ff`; and
- **Run Hetzner Supported Distributed Manifests** run `31251480014`, attempt 1,
  failed and is retained only as non-gating external evidence for that
  plan-only publication.

The failed external workflow is neither diagnosed nor rewritten here. It does
not become implementation evidence for this child.

### 0.2 Parent and sibling records

This child is the next bounded Wave 2 child of:

- [Repository Human Traceability Refactoring Program](repo-human-traceability-refactoring-program-plan.md);
- [Repository Human Traceability Program Execution Plan](repo-human-traceability-program-execution-plan.md); and
- [Repository Human Traceability Governance And Checker Plan](repo-human-traceability-governance-and-checker-plan.md).

It follows the completed browser, group-state server, API-v1 group-state,
client-state server, and auth server children. Their evidence remains historical
and is not reopened.

### 0.3 Plan-only publication policy

The planning pull request changes only:

- this plan;
- the master program;
- the execution plan; and
- the auth child plan for exact ledger closure and successor linkage.

Under the repository plan-only publication policy, its gates are Prettier,
`git diff --check`, and the focused repository-governance tests. Build, unit,
CI, Branch Release Gate, and resulting-main deployment workflows are not
required for this plan-only revision. Implementation PRs remain subject to
their full code and publication gates.

## 1. Outcome, Scope, And Review Sizing

### 1.1 Success criterion

The child succeeds when a human can start at any topology configuration HTTP
mutation, AppInbox command, query, startup migration, or downstream recompute
message and find, by filename:

1. construction and registration;
2. protocol decoding and authority verification;
3. stable facts and exact reads;
4. compute and independent validation;
5. the transaction and retry owner;
6. persisted config, override, generation, idempotency, receipt, and outbox
   writes;
7. normal, no-op, replay, conflict, retry, terminal-failure, and cleanup exits;
8. the later caller-result boundary; and
9. the first downstream RTC/WS consumer without following compatibility-only
   wrappers.

The durable navigation owner is
`packages/shared-server/rallar-system/topology/README.md`. It is verified
against live paths and primary symbols; it is navigation evidence, not runtime
truth.

### 1.2 In scope

- The five topology AppInbox operations: put/delete config, put/delete
  override, and explicit reconfigure.
- The authenticated enqueue, durable command, worker authorization, and handler
  boundaries for those operations.
- Topology config defaults, sparse-to-canonical patch translation, resolution,
  mutation contracts, idempotency, computation, validation, read, write, and
  public result reconstruction.
- Topology config persistence namespaces, keys, codecs, exact reads,
  optimistic compare-and-set, generation/invariant state, legacy migration, and
  startup/per-group backfill.
- The group-topology query, planning-authority, explicit reconfigure, and
  topology APP_OUTBOX entry boundaries currently co-owned by
  `GroupTopologyManagementService`.
- The public management service, package exports, and existing direct one-hop
  `AppGroupInboxService` command/type exports as compatibility surfaces.
- Mirrored shared-server semantic, persistence, AppInbox, concurrency, and
  navigation tests.
- API-v1, admin, RTC, WebSocket, browser, and black-box consumers only as
  characterized compatibility evidence and import users.

### 1.3 Explicitly out of scope

- API-v1 route, OpenAPI, request-auth, error, response, or composition
  reorganization.
- RTC star/tree/mesh algorithms, RTC topology snapshot/publication/execution
  repositories, RTT ingestion, debounce/coalescing, scalar-authority migration,
  cluster transport, WS_OUTBOX delivery, or browser RTC behavior.
- Shared-graph algorithms or graph diagnostic APIs.
- New topology behavior, persistence formats, storage keys, security rules,
  compatibility layers, public exports, dependencies, workflows, checker
  behavior, or performance thresholds.
- Cleanup of legacy persisted rows, deprecated HTTP or public methods, receipt
  fields, publication v1, or unscoped RTC keys.
- Another Wave 2 domain, including RTC/RTT, CRDT, admin, or API-v1 topology.

### 1.4 Stacked-PR decision

The direct current scope is 13 production modules with 5,633 physical lines and
13 mirrored test/support modules with 4,580 physical lines: 26 files and 10,213
lines before new semantic tests, README/navigation evidence, wrappers, or
consumer import edits. Mechanical relocation alone predicts more than 20,000
added/deleted lines. The retained 31-file behavior footprint is 32,713 physical
lines. Together with the 26 direct production/test paths, the complete
inspected footprint is 42,926 physical lines across more than six control-flow
families.

That exceeds the pilot threshold of approximately 10,000 changed lines even
though the direct move is currently below 100 files. One implementation PR is
rejected. The approved execution shape is four sequential behavior-neutral
implementation PRs:

1. **PR A — protocol and pure config mutation core**;
2. **PR B — persistence, exact reads, generations, and migration**;
3. **PR C — authoritative AppInbox shell, query, reconfigure, and composition**;
4. **PR D — code-standard alignment, compatibility decisions, and final
   navigation**.

Each PR starts only after the previous exact resulting-main SHA has satisfied
its required default-branch workflow. A separate later evidence ledger follows
all four. Combining PR B with PR C is prohibited. PR C and PR D may not be
combined merely to reduce PR count.

### 1.5 Pre-authorized private target-tree refinement

After exact plan approval, execution may refine a private topology or
mirrored-test split, filename, consolidation, or owner without another prompt
when independent evidence proves the change is behavior-neutral and required
for cohesive ownership, descriptive filename/primary-symbol alignment, acyclic
dependencies, the 400-line module limit, or 60-line general-function limit.

The refinement must remain within the target feature/test roots in Sections 5
and 6, update the plan factually before the affected PR freezes, and add no
observable behavior, public or persisted contract, compatibility hop, state,
lifecycle, authority, transaction, retry, outbox, dependency, workflow,
checker, TypeScript, or performance rule. A new production capability,
cross-domain owner, or semantic change stops for explicit human approval.

## 2. Controlled Baseline And Human Evidence

### 2.1 Code-derived baseline

Before any implementation edit, Task 1 re-resolves every path, import, export,
symbol, case, assertion, call edge, line count, and warning against the exact
implementation base. This planning inspection found:

- 13 direct production modules and 13 direct test/support modules;
- 68 test-case callsites and 281 `expect`/assertion callsites in those tests;
- three production modules over 1,000 physical lines;
- no detected static TypeScript import SCC in the direct core; and
- a temporal construction seam where topology handlers exist before
  `setTopologyManagementService` registers their required service.

The exact Task 1 report is ignored execution evidence under
`tmp/repo-human-traceability/group-topology/`. It is not committed.

### 2.2 Focused warning baseline and human disposition

The planning-time warning-only scan of the 13 production files exits zero and
reports:

| Mode                 | Rows | Notable findings                                                                          |
| -------------------- | ---: | ----------------------------------------------------------------------------------------- |
| default              |   60 | 35 grouped `boundary.unknown`, 3 file-length, 6 input-contract, 15 line-width, 1 filename |
| construction details |   61 | default rows plus `isTopologyRecord` pass-through                                         |
| output contracts     |   62 | plus unnamed outputs from `writeResult` and `readConsistentTopologyConfigPair`            |
| object interfaces    |   60 | no additional finding                                                                     |

The grouped unknown findings represent 47 raw occurrences. The three
over-length files are `GroupTopologyConfigRepository.ts`,
`group-topology-config-mutations.ts`, and
`group-topology-management-service.ts`.

Task 1 reruns all warning modes on the exact implementation base, records every
row once with owner, risk, proposed disposition, and target PR, and requires
explicit human approval of all dispositions before PR A production movement.
Warning-only checker behavior remains unchanged. Checker exit zero never
substitutes for human disposition.

The exact Task 1 report at SHA-256
`06a14055415c46e81957cc776c9435c2c4abd57d571080ca36d649127a0e0093`
contains 63 union rows. The human approved every proposed disposition and owner
mapping with no exception before Task 2 production movement.

### 2.3 Controlled human navigation sample

Before implementation, a human uses the exact implementation base and records,
without AI-filled values, elapsed time, wrong files opened, compatibility hops,
unresolved questions, and named path/owners for:

1. topology config or override put;
2. explicit topology reconfigure;
3. config/override/topology query;
4. startup generation backfill and legacy migration; and
5. topology APP_OUTBOX to RTC/WS/browser handoff.

The same prompts are repeated on PR D's final candidate. The report may compare
only the recorded observations. Missing data is reported as missing; no timing,
productivity, causal, or statistical claim may be fabricated. Waiving the
comparison requires a separate explicit Task 1 evidence-protocol amendment.

The human supplied that explicit amendment for this child: no valid controlled
sample was collected, the comparison is waived, and the independently reviewed
code-derived family traces remain qualitative baseline evidence only. No human
timing, wrong-file count, compatibility-hop count, unresolved-question count,
or productivity claim is inferred.

## 3. Exact Current Trees

### 3.1 Current direct production tree

```text
packages/shared/api/
  graph-topology-management-types.ts
  group-topology-config-canonical.ts

packages/shared-server/rallar-system/
  topology/
    inbox/
      topology-app-inbox-authority.ts
      topology-app-inbox-command.ts
      topology-app-inbox-contracts.ts
      topology-app-inbox-handler.ts

  services/
    group-topology-config-generation-backfill.ts
    group-topology-config-mutation-read.ts
    group-topology-config-mutations.ts
    group-topology-config-service.ts
    group-topology-management-service.ts
    topology-mutation-authority-proof.ts

  repositories/
    GroupTopologyConfigRepository.ts
    group-topology-mutation-exact-read.ts
    group-topology-stored-source-values.ts
```

`packages/shared/api/**` remains in place. The 13 direct shared-server files
are the production movement surface.

### 3.2 Current mirrored test/support tree

```text
packages/tests/shared-server/
  group-topology-config-repository.test.ts
  group-topology-config-service.test.ts
  group-topology-management-service.test.ts
  topology-app-inbox-contract.test.ts
  topology-app-inbox-ownership.test.ts
  postgres-topology-app-inbox-concurrency.test.ts
  postgres-topology-app-outbox-concurrency.test.ts
  postgres-topology-config-override-concurrency.test.ts
  postgres-topology-mutation-worker-concurrency.test.ts
  postgres-topology-concurrency-fixtures.ts
  postgres-topology-mutation-worker-fixtures.ts
  fixtures/
    postgres-topology-app-inbox-worker.ts
    postgres-topology-app-outbox-worker.ts
```

The APP_OUTBOX concurrency test and worker fixture are downstream RTC consumer
evidence and remain at their current paths in this child. The other eleven
paths move or split under the topology test tree.

### 3.3 Retained consumers and evidence, characterized but not reorganized

```text
apps/api-v1/src/
  middleware.ts
  create-rallar-server.ts
  routes/graph-topology-routes.ts
  services/create-api-admin-mutation-gateway.ts
  services/runtime-state-expiry-startup.ts

apps/api-v1/test/
  routes/graph-topology-routes.test.ts
  swagger-routes.test.ts
  rtc-topology-config.test.ts
  db/pglite-rtc-topology-ws-outbox.test.ts
  db/pglite-sql-adapter.test.ts

packages/shared-server/rallar-system/
  services/rtc-topology-outbox-entry.ts
  services/RtcTopologyOutboxWork.ts
  services/RallarRtcTopologyService.ts
  rtc-topology/**
  ws-system-topics.ts
  admin-support/AdminSupportService.ts
  group-state/presence/group-presence-summary-work.ts

packages/shared-web/browser/
  api-integration.ts
  data-caches.ts

packages/shared-test/black-box-runner/tests/api-v1/
  api-v1-openapi-topology-auth.json
  api-v1-rtc-topology-convergence.json
  api-v1-state-topology-churn.json
  api-v1-state-write-convergence.json
  api-v1-state-medium-scale-churn.json
```

`apps/ar-eye-hunter-v1`, `apps/relic-hunters-v1`,
`apps/rallar-black-box`, and shared-test browser runtimes consume the
shared-web topology cache indirectly. No direct topology consumer was found
under `examples/**`.

### 3.4 Exact retained-in-place affected tree

These files may receive import redirects, export-source redirects, navigation
links, or semantic compatibility assertions. They do not move and their
non-import behavior is frozen:

```text
packages/shared-server/
  mod.ts
  rallar-system/
    services/
      AppGroupInboxService.ts
      RtcTopologyOutboxWork.ts
      rtc-topology-outbox-entry.ts
    rtc-topology/inbox/
      rtc-rtt-app-inbox-authority.ts
      rtc-rtt-app-inbox-contracts.ts
    ws-rtc-topology-runtime.ts
    ws-system-topics.ts

packages/shared/
  mod.ts
  api/overlay-topology.ts

apps/api-v1/src/
  middleware.ts
  create-rallar-server.ts
  routes/graph-topology-routes.ts
  services/create-api-admin-mutation-gateway.ts
  services/runtime-state-expiry-startup.ts

apps/api-v1/test/
  db/pglite-sql-adapter.test.ts
  routes/graph-topology-routes.test.ts
  rtc-topology-config.test.ts
  swagger-routes.test.ts

packages/shared-test/black-box-runner/state-write-evidence/
  api-v1-state-write-receipt-evidence.ts

scripts/perf/
  api-v1-state-write-concurrency-bench.ts
  api-v1-state-write-receipt-evidence.ts

packages/tests/shared-server/
  app-inbox-transaction.test.ts
  authoritative-mutation-read-compute-validate-write.test.ts
  guarded-batch-write-contract.test.ts
  mutation-boundary-analysis.ts
  postgres-task8-runtime-evidence.test.ts
  rtc-topology-outbox-work.test.ts
  ws-system-topics-rtc-topology.test.ts
  fixtures/
    postgres-app-inbox-worker-services.ts
    postgres-expiry-worker.ts
  group-state/inbox/
    app-group-inbox-registration-lifecycle.test.ts

packages/tests/repo/
  rallar-group-state-owner-integrity.test.ts
```

Task 1 records any additional exact active consumer discovered on the
implementation base before editing it. A substantive change outside import,
export-source, navigation, or directly owned semantic compatibility evidence
stops for human review.

## 4. Current Construction And Runtime Traces

### 4.1 Construction and registration timeline

```text
apps/api-v1/src/middleware.ts
  → construct runtime-state, queue, transaction, and group-state owners
  → construct AppGroupInboxService
      → construct TopologyAppInboxHandler without topology service
      → register group-state handlers only

apps/api-v1/src/create-rallar-server.ts
  → construct RallarRtcTopologyService
  → construct config/snapshot/RTT repositories
  → construct GroupTopologyManagementService
  → AppGroupInboxService.setTopologyManagementService(...)
      → register put/delete config, put/delete override, reconfigure
  → AppGroupInboxService.setRtcRttAppInboxDependencies(...)
      → register RTC_RTT_SUBMIT separately
  → mount WS topics and HTTP routes
  → finish runtime readiness
  → start queue processing
```

Registration and later invocation are distinct. The setter accepts the same
service idempotently and rejects replacement. PR C must preserve the public
constructor and setter behavior while making the handler's required
capabilities construction-valid before each handler registration.

### 4.2 Config or override mutation

```text
HTTP PUT/DELETE route or admin caller
  → current auth/group authorization + Idempotency-Key check
  → sparse request patch → mandatory canonical patch
  → TopologyAppInboxCommand + semantic command hash
  → issued-session reread + authenticated enqueue/HMAC proof
  → AppInbox enqueueIfAbsent and wait

later queue invocation
  → reservation
  → authority/session/command proof verification on this attempt
  → capture stable timestamp/hash/absolute override expiry once
  → ensure generation readiness/backfill
  → exact config/override/generation/invariant/idempotency/group read
  → probe idempotency
  → compute
  → independent recomputation/validation
  → AppInbox transaction
      → authority-fence compare-and-set
      → config/override compare-and-set
      → invariant-generation compare-and-set
      → target-generation compare-and-set
      → immutable mutation-record insert
      → deterministic RTC_TOPOLOGY_RECOMPUTE APP_OUTBOX insert
      → durable AppInbox result write
      → reservation RESERVED → COMPLETED compare-and-set
  → confirmed commit
  → wake APP_OUTBOX only for a real write
  → waiting caller receives durable result
```

Normal exits are `write`, `claim`, `no-op`, and `replay`. Divergent queue or
domain idempotency is terminal conflict. Authority/state/reservation compare-
and-set conflicts roll back the whole transaction and re-enter proof/read/
compute/validate. Malformed protocol, policy denial, corruption, and
idempotency mismatch become durable failed results. Retry exhaustion becomes a
durable 503 result. The HTTP wait may time out while durable processing
continues.

### 4.3 Explicit reconfigure

```text
HTTP/admin reconfigure
  → same authenticated Topology AppInbox ingress
  → read current group snapshot + authority guard
  → read resolved config and RTT planning authority
  → compute deterministic RTC_TOPOLOGY_RECOMPUTE entry
  → validate actor, lifecycle, group identity, request options, and identity
  → AppInbox transaction
      → authority-fence compare-and-set
      → APP_OUTBOX insert
      → queued durable result
      → reservation completion
  → confirmed commit
  → wake APP_OUTBOX
  → caller receives queued result
```

Explicit reconfigure does not write config, override, config generation,
invariant generation, or config idempotency records.

### 4.4 Query and planning authority

```text
HTTP GET / topology/admin explain
  → current group authorization
  → GroupTopologyManagementService
      → readTopologyView / readConfig / readOverride
      → ensure generation readiness
      → exact or sequentially guarded config/override read
      → server defaults + durable config + live override + request options
      → mandatory effective five-field config
      → persisted RTC snapshot or process-local compatibility snapshot
  → unchanged HTTP/OpenAPI serialization
```

Planning authority reads a current group snapshot, resolved config, raw RTT
measurements, and the RTC service clock. RTC algorithms and derived overlay
ownership remain outside this child.

### 4.5 Maintenance and expiry

```text
startup
  → backfillAllGroupTopologyConfigGenerations
  → bounded legacy-key migration only when oldWritersStopped=true
  → generic runtime-state expiry cleanup

first per-group query/mutation
  → memoized ensureTopologyConfigGenerationReady
  → failure removes the promise so a later call can retry
```

Config, generation, invariant, and idempotency records never expire. An override
becomes observationally absent at its exact expiry and is later physically
removed by generic cleanup. Expiry itself creates no receipt, event, topology
recompute, or wake.

### 4.6 APP_OUTBOX, RTC, WS, and browser handoff

```text
RTC_TOPOLOGY_RECOMPUTE APP_OUTBOX row
  → OutboxQueueReader
  → createRtcTopologyWorkHandler
  → read durable claim/snapshot/planning authority
  → RallarRtcTopologyService computes derived overlay
  → validate shared-graph next-hop invariants
  → one transaction:
      snapshot CAS + execution claim + immutable publication
      + optional WS_OUTBOX + APP_OUTBOX completion
  → after commit: observe cache, metrics, and wake WS delivery
  → QueueBoxPubSubBridge / WS server
  → shared-web overlay cache
  → WebRtcGroupManager
```

This is a downstream trace only. PRs A-D may update imports or tests needed to
prove the handoff, but they do not move or redesign these owners.

## 5. Exact Target Production Tree

```text
packages/shared/api/
  graph-topology-management-types.ts
  group-topology-config-canonical.ts

packages/shared-server/rallar-system/topology/
  README.md
  group-topology-errors.ts
  group-topology-management-service.ts
  group-topology-management-contracts.ts

  inbox/
    topology-app-inbox-authority.ts
    topology-app-inbox-command.ts
    topology-app-inbox-contracts.ts
    topology-app-inbox-handler.ts
    topology-mutation-authority-proof.ts

  config/
    group-topology-config.ts
    group-topology-config-query-service.ts
    group-topology-config-mutation-service.ts

    mutation/
      group-topology-config-mutation-contracts.ts
      topology-config-mutation-idempotency.ts
      compute-topology-config-mutation.ts
      validate-topology-config-mutation.ts
      validate-topology-config-mutation-input.ts
      topology-config-mutation-boundary.ts
      topology-config-mutation-validation-values.ts
      validate-topology-config-records.ts
      validate-topology-config-receipt.ts
      topology-config-mutation-receipt.ts
      to-topology-config-mutation-result.ts
      read-topology-config-mutation.ts
      write-topology-config-mutation.ts

    persistence/
      group-topology-config-repository-contracts.ts
      group-topology-config-repository.ts
      group-topology-config-runtime-namespaces.ts
      group-topology-config-storage-keys.ts
      group-topology-config-persistence-codec.ts
      read-exact-group-topology-config-mutation.ts
      decode-stored-group-topology-config.ts

    maintenance/
      backfill-group-topology-config-generations.ts
      group-topology-config-generation-readiness.ts
      migrate-legacy-group-topology-config-keys.ts

  planning/
    group-topology-planning-contracts.ts
    group-topology-planning-service.ts
    materialize-rtc-overlay-topology-broadcast-message.ts

  reconfigure/
    group-topology-reconfigure-contracts.ts
    group-topology-reconfigure-mutation.ts
```

No new temporary re-export is proposed for the nine mechanically moved private
paths. Each old path is removed in its owning PR only after the exact active
repository consumer scan in Section 8 is empty. Public package symbols remain
stable through `packages/shared-server/mod.ts`; the existing
`AppGroupInboxService` one-hop command/type exports and public management facade
remain the only topology compatibility surfaces changed or verified here. No
second hop, nested barrel, executable shim, hidden default, or new public export
is permitted.

Task 2 applied the Section 1.5 private target-tree refinement shown above. The
canonical mutation-boundary owner contains the six mechanically source-derived
raw operation ingress readers and returns exact named domain contracts only
after complete validation. Eight additional inherited source `unknown`
occurrences are resolved, without transferred capacity, in the typed
`topology-config-mutation-validation-values.ts` continuation. Input,
stored-record, and receipt owners accept named domain contracts and add zero
`unknown` capacity. This direction avoids a runtime cycle and the over-400-line
validator that a single file would create. It adds no public compatibility
surface.

## 6. Exact Target Mirrored-Test Tree

```text
packages/tests/shared-server/topology/
  inbox/
    topology-app-inbox-command.test.ts
    topology-app-inbox-authority.test.ts
    topology-app-inbox-handler.test.ts
    topology-app-inbox-ownership.test.ts

  config/
    group-topology-config-resolution.test.ts
    group-topology-config-query-service.test.ts

    mutation/
      group-topology-config-mutation-boundary.test.ts
      group-topology-config-mutation-compute.test.ts
      group-topology-config-mutation-idempotency.test.ts
      group-topology-config-mutation-validation.test.ts
      group-topology-config-mutation-result.test.ts
      group-topology-config-mutation-test-fixtures.ts
      group-topology-config-mutation-transaction.test.ts

    persistence/
      group-topology-config-repository-keys.test.ts
      group-topology-config-repository-read-write.test.ts
      group-topology-config-repository-corruption.test.ts
      group-topology-config-exact-read.test.ts
      group-topology-config-generation.test.ts
      group-topology-config-legacy-migration.test.ts

    maintenance/
      group-topology-config-generation-readiness.test.ts

  planning/
    group-topology-planning-service.test.ts

  reconfigure/
    group-topology-reconfigure-mutation.test.ts

  concurrency/
    postgres-topology-app-inbox-concurrency.test.ts
    postgres-topology-config-override-concurrency.test.ts
    postgres-topology-mutation-worker-concurrency.test.ts
    postgres-topology-concurrency-fixtures.ts
    postgres-topology-mutation-worker-fixtures.ts
    fixtures/
      postgres-topology-app-inbox-worker.ts

packages/tests/repo/
  group-topology-server-lineage-boundary-bijection.ts
  group-topology-server-lineage-provenance-fixtures.ts
  group-topology-server-lineage-provenance-mutants.ts
  group-topology-server-lineage-provenance.test.ts
  group-topology-server-navigation-map-integrity.test.ts
  group-topology-server-ownership.test.ts
  group-topology-server-pr-a-test-ownership.ts
  group-topology-server-test-ast.ts
  group-topology-server-test-atom-endpoint-declaration.ts
  group-topology-server-test-atom-endpoint-declarations.ts
  group-topology-server-test-atom-endpoints-compute-case.ts
  group-topology-server-test-atom-endpoints-compute-input.ts
  group-topology-server-test-atom-endpoints-compute-support.ts
  group-topology-server-test-atom-endpoints-elapsed-input.ts
  group-topology-server-test-atom-endpoints-elapsed-read.ts
  group-topology-server-test-atom-endpoints-elapsed-validation.ts
  group-topology-server-test-atom-endpoints-exact-authority.ts
  group-topology-server-test-atom-endpoints-exact-command.ts
  group-topology-server-test-atom-endpoints-exact-config-mutation.ts
  group-topology-server-test-atom-endpoints-exact-config-resolution.ts
  group-topology-server-test-atom-endpoints-exact-ownership.ts
  group-topology-server-test-atom-endpoints-fallback.ts
  group-topology-server-test-atom-endpoints-input-command.ts
  group-topology-server-test-atom-endpoints-input-read-values.ts
  group-topology-server-test-atom-endpoints-input-runtime-values.ts
  group-topology-server-test-atom-endpoints-ownership.ts
  group-topology-server-test-atom-endpoints-resolution.ts
  group-topology-server-test-atom-endpoints-snapshot-audit.ts
  group-topology-server-test-atom-endpoints-snapshot-group.ts
  group-topology-server-test-atom-endpoints-snapshot-members.ts
  group-topology-server-test-atom-endpoints-snapshot-revisions.ts
  group-topology-server-test-atom-endpoints-support.ts
  group-topology-server-test-atom-endpoints-validation.ts
  group-topology-server-test-atom-inventory.ts
  group-topology-server-test-atom-ownership-contracts.ts
  group-topology-server-test-atom-ownership-validation.ts
  group-topology-server-test-atom-ownership.test.ts
  group-topology-server-test-atom-ownership.ts
  group-topology-server-test-atom-translations.ts
  group-topology-server-test-ownership.test.ts
  group-topology-server-test-semantic-atoms.ts
```

The retained cross-domain persistent ratchet at
`packages/tests/repo/group-state-server-source-ratchet.test.ts` follows the
same ownership-test move to
`packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts`.
It remains a group-state evidence owner rather than becoming a second topology
ratchet, and all five of its existence/style/size/cycle consumers read the one
canonical moved path.

PR A lineage evidence stays in one namespace under
`plans/repo-style-lineages/`: the checker-owned
`rallar-group-topology-server-pr-a.json`, the human summary
`rallar-group-topology-server-pr-a-provenance.md`, and the test-pinned exact
blob/symbol/span/region evidence
`rallar-group-topology-server-pr-a-provenance.jsonc`. The `.jsonc` suffix keeps
the richer evidence outside the checker manifest schema while its permanent
test parses and verifies it directly. The descriptive
`group-topology-server-lineage-provenance-fixtures.ts` owner holds that frozen
inventory and its fail-closed blob/span/hash/magnitude/derivation verification;
`group-topology-server-lineage-boundary-bijection.ts` independently proves all
fourteen inherited source regions: six bijective raw ingress transfers and
eight exact resolutions into named typed continuation symbols with no target
`unknown`. The behavior-named test and cohesive mutant owner hold the positive
and per-field/row negative cases. All four owners remain below the hard
400-line limit.

Retained downstream RTC consumer evidence stays at:

```text
packages/tests/shared-server/
  postgres-topology-app-outbox-concurrency.test.ts
  fixtures/postgres-topology-app-outbox-worker.ts
  rtc-topology-mutations.test.ts
  rtc-topology-outbox-work.test.ts
  ws-system-topics-rtc-topology.test.ts
```

Every frozen source case, fixture, runtime raw literal, barrier, assertion,
expanded variant, and eligible top-level support declaration maps through a
pinned source/target atom endpoint before its old file is removed. The endpoint
evidence records both AST IDs/fingerprints and validates the exact
710-source-atom and 160-atom additive target partitions. It excludes
TypeScript-only annotation literals and restricts each of the 23 predecessor
support declarations to its exact allowed target-symbol set. The 210 semantic/
shared-fixture endpoints are explicit reviewed source-to-target declarations
with family-specific reasons; the coherent value-only `utf8` mapping is one
separately declared translation, for 211 contextual mappings total. Ambiguous
exact fingerprints are explicit too. Automatic exact matching requires exactly
one eligible target before assignment and never uses score or first-match
selection. Unique targets carry no consolidation metadata; every intentional
duplicate pins its exact case/target-derived identifier and family-specific
reason. Endpoint deletion, replacement, reorder, equal-fingerprint ambiguity,
generic same-value substitution, invented unique/duplicate consolidation,
duplicate claims, unclassified cases/support, and undeclared translations all
fail closed. The cohesive AST, inventory, contracts, endpoint-data, assignment,
translation, and validation owners listed above keep this permanent ratchet
human-navigable and below 400 lines. Aggregate counts remain supplementary
diagnostics only.

Task 2 also added
`packages/tests/shared-server/authoritative-mutation-runtime-source-inventory.ts`
as the descriptive inventory owner used by the retained cross-domain source
boundary test. This keeps that materially changed test below 400 lines without
moving or weakening any assertion.

The shared-test authoritative receipt harness keeps its exact property-order
projection in
`packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-projection.ts`;
the retained receipt-evidence owner performs repository I/O and calls that pure
projection directly. Both paths are included in the performance blob manifest.

## 7. Complete Current-To-Target Move And Symbol Map

### 7.1 Production owners

| Current owner                                                                                                           | Target owner and primary symbols                                                                                                                                                                                                        | PR                |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| `services/group-topology-config-service.ts`                                                                             | `topology/config/group-topology-config.ts`: existing default, validation, expiry, and resolution functions                                                                                                                              | A                 |
| `topology/inbox/topology-app-inbox-contracts.ts`                                                                        | Same path: `TopologyAppInboxOperation`, payload and handler contracts                                                                                                                                                                   | A                 |
| `topology/inbox/topology-app-inbox-command.ts`                                                                          | Same path: authenticated/durable command translators and hashes                                                                                                                                                                         | A                 |
| `topology/inbox/topology-app-inbox-authority.ts`                                                                        | Same path: authenticated enqueue, read/verify authority                                                                                                                                                                                 | A                 |
| `services/topology-mutation-authority-proof.ts`                                                                         | `topology/inbox/topology-mutation-authority-proof.ts`: proof creation/read/equality                                                                                                                                                     | A                 |
| `services/group-topology-config-mutations.ts` types                                                                     | `config/mutation/group-topology-config-mutation-contracts.ts`                                                                                                                                                                           | A                 |
| same, idempotency functions                                                                                             | `config/mutation/topology-config-mutation-idempotency.ts`: probe/validate idempotency                                                                                                                                                   | A                 |
| same, put/delete/patch decisions                                                                                        | `config/mutation/compute-topology-config-mutation.ts`: `computeTopologyConfigMutation`                                                                                                                                                  | A                 |
| same, exact recomputation                                                                                               | `config/mutation/validate-topology-config-mutation.ts`: `validateTopologyConfigMutation`                                                                                                                                                | A                 |
| same, input/attempt, raw ingress, typed values, stored-record, and receipt validation                                   | `config/mutation/validate-topology-config-mutation-input.ts`, `topology-config-mutation-boundary.ts`, `topology-config-mutation-validation-values.ts`, `validate-topology-config-records.ts`, and `validate-topology-config-receipt.ts` | A                 |
| same, receipt creation and `resultFromTopologyConfigReceipt`                                                            | `config/mutation/topology-config-mutation-receipt.ts`: receipt/result reconstruction                                                                                                                                                    | A                 |
| `repositories/GroupTopologyConfigRepository.ts` public types                                                            | `config/persistence/group-topology-config-repository-contracts.ts`                                                                                                                                                                      | B                 |
| same, namespaces                                                                                                        | `config/persistence/group-topology-config-runtime-namespaces.ts`                                                                                                                                                                        | B                 |
| same, key builders/decoders                                                                                             | `config/persistence/group-topology-config-storage-keys.ts`                                                                                                                                                                              | B                 |
| same, stored value/entry decoding and corruption errors                                                                 | `config/persistence/group-topology-config-persistence-codec.ts`                                                                                                                                                                         | B                 |
| same, repository CRUD/CAS/page operations                                                                               | `config/persistence/group-topology-config-repository.ts`                                                                                                                                                                                | B                 |
| `repositories/group-topology-mutation-exact-read.ts`                                                                    | `config/persistence/read-exact-group-topology-config-mutation.ts`                                                                                                                                                                       | B                 |
| `repositories/group-topology-stored-source-values.ts`                                                                   | `config/persistence/decode-stored-group-topology-config.ts`                                                                                                                                                                             | B                 |
| `services/group-topology-config-generation-backfill.ts` canonical backfill                                              | `config/maintenance/backfill-group-topology-config-generations.ts`                                                                                                                                                                      | B                 |
| same, legacy key migration                                                                                              | `config/maintenance/migrate-legacy-group-topology-config-keys.ts`                                                                                                                                                                       | B                 |
| `services/group-topology-config-mutation-read.ts`                                                                       | `config/mutation/read-topology-config-mutation.ts`: `readTopologyConfigMutation`                                                                                                                                                        | B                 |
| config query/readiness methods in management service                                                                    | `config/group-topology-config-query-service.ts`                                                                                                                                                                                         | C                 |
| the single management-service readiness map and `ensureTopologyConfigGenerationReady`                                   | `config/maintenance/group-topology-config-generation-readiness.ts`: `GroupTopologyConfigGenerationReadiness` shared by query and mutation                                                                                               | C                 |
| config mutation phase methods in management service                                                                     | `config/group-topology-config-mutation-service.ts`                                                                                                                                                                                      | C                 |
| standalone `writeTopologyConfigMutation` in management service                                                          | `config/mutation/write-topology-config-mutation.ts`: same primary symbol                                                                                                                                                                | C                 |
| method `toTopologyConfigMutationResult` and helper `topologyConfigExecution`                                            | `config/mutation/to-topology-config-mutation-result.ts`: `toTopologyConfigMutationResult`                                                                                                                                               | C                 |
| explicit reconfigure types                                                                                              | `reconfigure/group-topology-reconfigure-contracts.ts`                                                                                                                                                                                   | C                 |
| explicit reconfigure read/compute/validate/write                                                                        | `reconfigure/group-topology-reconfigure-mutation.ts`                                                                                                                                                                                    | C                 |
| planning authority, topology computation, observation, local compatibility planning                                     | `planning/group-topology-planning-contracts.ts` and `planning/group-topology-planning-service.ts`                                                                                                                                       | C                 |
| broadcast fact type plus `createRtcOverlayTopologyBroadcastMessage` and `materializeRtcOverlayTopologyBroadcastMessage` | `planning/materialize-rtc-overlay-topology-broadcast-message.ts`                                                                                                                                                                        | C                 |
| `GroupTopologyValidationError`, `GroupTopologyCommitConflictError`, `GroupTopologyConfigIdempotencyConflictError`       | `group-topology-errors.ts`: same three public classes                                                                                                                                                                                   | C                 |
| `topology/inbox/topology-app-inbox-handler.ts`                                                                          | Same path: thin operation dispatch to config and reconfigure owners                                                                                                                                                                     | C                 |
| public management contracts                                                                                             | `group-topology-management-contracts.ts`                                                                                                                                                                                                | C                 |
| `services/group-topology-management-service.ts` public class                                                            | `topology/group-topology-management-service.ts`: existing public compatibility facade                                                                                                                                                   | C                 |
| `packages/shared-server/mod.ts` export sources                                                                          | retained in place; point directly to canonical owners while preserving public names/identity                                                                                                                                            | matching owner PR |
| import-only API, RTC, shared-test, and performance consumers in Section 3.4                                             | retained in place; canonical import redirects only                                                                                                                                                                                      | matching owner PR |
| old private service/repository paths                                                                                    | removed only after the exact per-path active-consumer decision in Section 8                                                                                                                                                             | A-C               |
| current flat tests                                                                                                      | behavior-named modules in Section 6, preserving every case/assertion                                                                                                                                                                    | matching owner PR |
| navigation and supplementary ratchets                                                                                   | the 41 exact `packages/tests/repo/group-topology-server-*` owners in Section 6 plus the retained cross-domain `group-state-server-source-ratchet.test.ts` consumer                                                                      | A-D               |

The exact management-service partition must not copy mutable state into multiple
owners. `GroupTopologyConfigGenerationReadiness` is the sole owner of the
readiness map and backfill-promise eviction; the same instance is injected into
query and mutation services. Neither service calls through the other. The
AppInbox handler receives explicit config-mutation and reconfigure
capabilities. Planning owns RTC-service calls but does not absorb RTC
algorithms, repositories, outbox execution, or RTT ingress.

### 7.2 Mirrored tests and fixtures

| Current path                                            | Target path or paths                                                                                                                                                                                                                                                                                                                    | Preserved responsibility                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `group-topology-config-service.test.ts`                 | `topology/config/group-topology-config-resolution.test.ts` and the four exact pure `topology/config/mutation/*.test.ts` owners                                                                                                                                                                                                          | Defaults, patching, expiry, resolution, decisions, receipts, and validation         |
| `group-topology-config-repository.test.ts`              | `topology/config/persistence/group-topology-config-repository-keys.test.ts`, `group-topology-config-repository-read-write.test.ts`, `group-topology-config-repository-corruption.test.ts`, `group-topology-config-exact-read.test.ts`, `group-topology-config-generation.test.ts`, and `group-topology-config-legacy-migration.test.ts` | Keys, scope, CRUD, corruption, exact read, generation, migration, rollback          |
| `group-topology-management-service.test.ts`             | `topology/config/group-topology-config-query-service.test.ts`, `topology/config/maintenance/group-topology-config-generation-readiness.test.ts`, `topology/planning/group-topology-planning-service.test.ts`, and `topology/reconfigure/group-topology-reconfigure-mutation.test.ts`                                                    | Query/view, readiness, planning authority, reconfigure, local compatibility, errors |
| `topology-app-inbox-contract.test.ts`                   | `topology/inbox/topology-app-inbox-command.test.ts`, `topology-app-inbox-authority.test.ts`, and `topology-app-inbox-handler.test.ts`                                                                                                                                                                                                   | Five operations, hashes, proof, durable decode, and handler exits                   |
| `topology-app-inbox-ownership.test.ts`                  | `topology/inbox/topology-app-inbox-ownership.test.ts`                                                                                                                                                                                                                                                                                   | Canonical owners, dependency direction, identity, and registration                  |
| `postgres-topology-app-inbox-concurrency.test.ts`       | `topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts`                                                                                                                                                                                                                                                                  | Cross-client overlap, retry, receipt, outbox, and final state                       |
| `postgres-topology-config-override-concurrency.test.ts` | `topology/concurrency/postgres-topology-config-override-concurrency.test.ts`                                                                                                                                                                                                                                                            | Config/override invariant surface and no lost update                                |
| `postgres-topology-mutation-worker-concurrency.test.ts` | `topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts`                                                                                                                                                                                                                                                            | Independent worker retry, idempotency, and completion                               |
| `postgres-topology-concurrency-fixtures.ts`             | `topology/concurrency/postgres-topology-concurrency-fixtures.ts`                                                                                                                                                                                                                                                                        | Barriers, clients, cleanup, and assertions                                          |
| `postgres-topology-mutation-worker-fixtures.ts`         | `topology/concurrency/postgres-topology-mutation-worker-fixtures.ts`                                                                                                                                                                                                                                                                    | Worker protocol and deterministic fixture construction                              |
| `fixtures/postgres-topology-app-inbox-worker.ts`        | `topology/concurrency/fixtures/postgres-topology-app-inbox-worker.ts`                                                                                                                                                                                                                                                                   | Child-process AppInbox worker runtime                                               |
| `postgres-topology-app-outbox-concurrency.test.ts`      | unchanged                                                                                                                                                                                                                                                                                                                               | Downstream RTC APP_OUTBOX evidence; no ownership move                               |
| `fixtures/postgres-topology-app-outbox-worker.ts`       | unchanged                                                                                                                                                                                                                                                                                                                               | Downstream RTC worker fixture; no ownership move                                    |

The first four one-to-many mappings resolve to these exact paths:

- `group-topology-config-service.test.ts` →
  `topology/config/group-topology-config-resolution.test.ts`,
  `topology/config/mutation/group-topology-config-mutation-compute.test.ts`,
  `topology/config/mutation/group-topology-config-mutation-idempotency.test.ts`,
  `topology/config/mutation/group-topology-config-mutation-validation.test.ts`,
  `topology/config/mutation/group-topology-config-mutation-result.test.ts`.
- `group-topology-config-repository.test.ts` →
  `topology/config/persistence/group-topology-config-repository-keys.test.ts`,
  `topology/config/persistence/group-topology-config-repository-read-write.test.ts`,
  `topology/config/persistence/group-topology-config-repository-corruption.test.ts`,
  `topology/config/persistence/group-topology-config-exact-read.test.ts`,
  `topology/config/persistence/group-topology-config-generation.test.ts`, and
  `topology/config/persistence/group-topology-config-legacy-migration.test.ts`.
- `group-topology-management-service.test.ts` →
  `topology/config/group-topology-config-query-service.test.ts`,
  `topology/config/maintenance/group-topology-config-generation-readiness.test.ts`,
  `topology/planning/group-topology-planning-service.test.ts`, and
  `topology/reconfigure/group-topology-reconfigure-mutation.test.ts`.
- `topology-app-inbox-contract.test.ts` →
  `topology/inbox/topology-app-inbox-command.test.ts`,
  `topology/inbox/topology-app-inbox-authority.test.ts`, and
  `topology/inbox/topology-app-inbox-handler.test.ts`.

Every path in this list is relative to `packages/tests/shared-server/`.
The move report binds every source case and assertion to one target behavior
owner before deleting a source test. New coverage is recorded separately from
moved coverage so it cannot mask a lost case or assertion. In particular,
`group-topology-config-mutation-transaction.test.ts` is new PR C semantic
coverage rather than a moved pure-core test owner.

## 8. Compatibility And Consumer Decisions

| Surface                                                                  | Exact current repository consumers                                                                                                                                    | Decision and removal condition                                                                                                                                                         |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/shared-server/mod.ts` topology exports                         | Published package surface plus ownership/public-boundary tests                                                                                                        | Retarget export sources to canonical files while preserving exact names and identities. Removal requires breaking-release approval and external inventory.                             |
| `services/AppGroupInboxService.ts` one-hop topology command/type exports | graph routes, admin gateway, API tests, PostgreSQL worker and expiry fixtures                                                                                         | Preserve during this child. Canonical internal callers move to `topology/inbox/**`; remove only after supported external inventory and deprecation approval.                           |
| `services/group-topology-config-generation-backfill.ts`                  | API-v1 middleware, current management service, repository test                                                                                                        | Redirect all three in PR B and remove the old private path after the exact active scan is empty. No shim.                                                                              |
| `services/group-topology-config-mutation-read.ts`                        | current management service only                                                                                                                                       | Redirect in PR B and remove after the active scan is empty. No shim.                                                                                                                   |
| `services/group-topology-config-mutations.ts`                            | topology command, repository/exact-read/stored/backfill/management owners, PGlite/semantic tests, shared-test receipt evidence, performance harness/evidence          | Redirect every named consumer in PR A and remove after the active scan is empty. No shim or debt transfer for semantically new code.                                                   |
| `services/group-topology-config-service.ts`                              | package mod, mutation/management owners, transaction/config/concurrency tests, performance harness                                                                    | Retarget the public mod export and all canonical imports in PR A, then remove the old private path after the active scan is empty.                                                     |
| `services/group-topology-management-service.ts`                          | API-v1 composition, AppGroup inbox, RTC outbox work, WS topics, package mod, worker/expiry fixtures, semantic/concurrency/performance tests                           | Retarget each exact consumer in PR C, preserve public symbols through `mod.ts`, and remove the old private path after the active scan is empty.                                        |
| `services/topology-mutation-authority-proof.ts`                          | topology inbox authority/contracts and RTC RTT inbox authority/contracts                                                                                              | Redirect both feature families to the canonical topology inbox owner in PR A, then remove the old shared private path after the active scan is empty.                                  |
| `repositories/GroupTopologyConfigRepository.ts`                          | API-v1 composition/middleware, management/backfill/read owners, WS topology runtime, package mod, shared-test evidence, repo/concurrency/performance/governance tests | Retarget all exact consumers and the public mod source in PR B, then remove the old private path after the active scan is empty.                                                       |
| `repositories/group-topology-mutation-exact-read.ts`                     | `GroupTopologyConfigRepository.ts` only                                                                                                                               | Redirect in PR B and remove immediately after the active scan is empty.                                                                                                                |
| `repositories/group-topology-stored-source-values.ts`                    | `GroupTopologyConfigRepository.ts` only                                                                                                                               | Redirect in PR B and remove immediately after the active scan is empty.                                                                                                                |
| `services/app-group-ws-session-lifecycle.ts` topology requirement export | No direct symbol consumer found; the file has active WS presence imports                                                                                              | Do not remove here. External inventory and WS owner review are required.                                                                                                               |
| Public `GroupTopologyManagementService` methods                          | API-v1 routes/composition, admin support, WS topics, tests, published module                                                                                          | Preserve signatures, errors, identity, timing, and deprecated rejection behavior. Internal AppInbox code uses narrow canonical owners. Any method removal is a separate breaking plan. |
| Deprecated planning/reconfigure/local-publication methods                | Published package surface and compatibility tests; local publication remains live                                                                                     | Preserve. Removal requires RTC/API compatibility work and explicit approval.                                                                                                           |
| `GroupTopologyConfigMutationReceipt.outboxId`                            | shared-web, OpenAPI, route tests, black-box evidence                                                                                                                  | Preserve with canonical `outboxIds`. Remove only in coordinated public/OpenAPI work.                                                                                                   |
| Shared API config/canonical modules                                      | public shared package and HTTP/browser clients                                                                                                                        | Remain in place, byte-compatible. No compatibility layer is added.                                                                                                                     |
| RTC repository/work re-exports and v1 publication/key compatibility      | RTC production, tests, and rolling-deployment paths                                                                                                                   | Characterize only; defer to RTC child.                                                                                                                                                 |
| Legacy config rows without request ID and unscoped keys                  | persistence migration readers                                                                                                                                         | Preserve bounded readers/cutoffs. Cleanup requires row audit, stopped writers, rollback expiry, and separate approval.                                                                 |

### 8.1 Exact moved-private-path consumer inventory

The exact active scan at planning base
`c2cb79c020bceee7f67e6fbc364ba96ea0d6a530` found these consumers. Each owning
PR regenerates this inventory before removing its predecessor path:

- `services/group-topology-config-generation-backfill.ts`:
  `apps/api-v1/src/middleware.ts`,
  `services/group-topology-management-service.ts`, and
  `packages/tests/shared-server/group-topology-config-repository.test.ts`.
- `services/group-topology-config-mutation-read.ts`:
  `services/group-topology-management-service.ts`.
- `services/group-topology-config-mutations.ts`:
  `apps/api-v1/test/db/pglite-sql-adapter.test.ts`,
  `repositories/GroupTopologyConfigRepository.ts`,
  `repositories/group-topology-mutation-exact-read.ts`,
  `repositories/group-topology-stored-source-values.ts`,
  `services/group-topology-config-generation-backfill.ts`,
  `services/group-topology-config-mutation-read.ts`,
  `services/group-topology-management-service.ts`,
  `topology/inbox/topology-app-inbox-command.ts`,
  `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts`,
  `packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts`,
  `packages/tests/shared-server/group-topology-config-service.test.ts`,
  `packages/tests/shared-server/group-topology-management-service.test.ts`,
  `scripts/perf/api-v1-state-write-concurrency-bench.ts`, and
  `scripts/perf/api-v1-state-write-receipt-evidence.ts`.
- `services/group-topology-config-service.ts`:
  `packages/shared-server/mod.ts`,
  `services/group-topology-config-mutations.ts`,
  `services/group-topology-management-service.ts`,
  `packages/tests/shared-server/app-inbox-transaction.test.ts`,
  `packages/tests/shared-server/group-topology-config-service.test.ts`,
  `packages/tests/shared-server/postgres-topology-config-override-concurrency.test.ts`, and
  `scripts/perf/api-v1-state-write-concurrency-bench.ts`.
- `services/group-topology-management-service.ts`:
  `apps/api-v1/src/create-rallar-server.ts`,
  `apps/api-v1/test/db/pglite-sql-adapter.test.ts`,
  `packages/shared-server/mod.ts`,
  `services/AppGroupInboxService.ts`, `services/RtcTopologyOutboxWork.ts`,
  `topology/inbox/topology-app-inbox-handler.ts`, `ws-system-topics.ts`,
  `packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts`,
  `packages/tests/shared-server/fixtures/postgres-app-inbox-worker-services.ts`,
  `packages/tests/shared-server/fixtures/postgres-expiry-worker.ts`,
  `packages/tests/shared-server/fixtures/postgres-topology-app-inbox-worker.ts`,
  `packages/tests/shared-server/fixtures/postgres-topology-app-outbox-worker.ts`,
  `packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts`,
  `packages/tests/shared-server/group-topology-config-service.test.ts`,
  `packages/tests/shared-server/group-topology-management-service.test.ts`,
  `packages/tests/shared-server/guarded-batch-write-contract.test.ts`,
  `packages/tests/shared-server/rtc-topology-outbox-work.test.ts`,
  `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`, and
  `scripts/perf/api-v1-state-write-concurrency-bench.ts`.
- `services/topology-mutation-authority-proof.ts`:
  `rtc-topology/inbox/rtc-rtt-app-inbox-authority.ts`,
  `rtc-topology/inbox/rtc-rtt-app-inbox-contracts.ts`,
  `topology/inbox/topology-app-inbox-authority.ts`, and
  `topology/inbox/topology-app-inbox-contracts.ts`.
- `repositories/GroupTopologyConfigRepository.ts`:
  `apps/api-v1/src/create-rallar-server.ts`, `apps/api-v1/src/middleware.ts`,
  `apps/api-v1/test/db/pglite-sql-adapter.test.ts`,
  `packages/shared-server/mod.ts`,
  `services/group-topology-config-generation-backfill.ts`,
  `services/group-topology-config-mutation-read.ts`,
  `services/group-topology-management-service.ts`, `ws-rtc-topology-runtime.ts`,
  `packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts`,
  `packages/tests/repo/rallar-group-state-owner-integrity.test.ts`,
  `packages/tests/shared-server/fixtures/postgres-app-inbox-worker-services.ts`,
  `packages/tests/shared-server/group-topology-config-repository.test.ts`,
  `packages/tests/shared-server/mutation-boundary-analysis.ts`,
  `packages/tests/shared-server/postgres-task8-runtime-evidence.test.ts`,
  `packages/tests/shared-server/postgres-topology-app-inbox-concurrency.test.ts`,
  `packages/tests/shared-server/postgres-topology-config-override-concurrency.test.ts`,
  `packages/tests/shared-server/postgres-topology-mutation-worker-concurrency.test.ts`, and
  `scripts/perf/api-v1-state-write-concurrency-bench.ts`.
- `repositories/group-topology-mutation-exact-read.ts` and
  `repositories/group-topology-stored-source-values.ts`: each is consumed only
  by `repositories/GroupTopologyConfigRepository.ts`.

Paths shortened to `services/**`, `repositories/**`, `topology/**`, or
`rtc-topology/**` above are relative to
`packages/shared-server/rallar-system/`; all other paths are repository-root
relative. The removal gate uses executable import/reference scanning across
TypeScript and JavaScript plus the source-ownership tests that intentionally
name predecessor paths. It must reach zero without ignoring tests, scripts, or
source-text governance assertions.

Canonical production imports may never route through a compatibility-only
wrapper. Tests prove runtime identity for every retained re-export. Any
compatibility-only module must contain named re-exports and no executable
logic; `AppGroupInboxService` remains an executable facade that separately
exposes the existing direct one-hop command/type exports.

## 9. Locked Behavior, Security, Persistence, And Exit Invariants

### 9.1 Protocol and public contracts

- All five topology AppInbox operations and exact type-to-payload relationships
  remain unchanged.
- Sparse HTTP patches remain distinct from mandatory canonical durable patches.
- Canonical fields remain exactly `topologyKind`, `degreeLimit`, `treeMinSize`,
  `meshMinSize`, and `meshParamK`; each operation remains exactly preserve,
  set, or clear.
- Unknown keys, error classes/messages/timing, request identities, defaults,
  omissions, clone points, property order, raw JSON, public results, OpenAPI,
  route paths, wrappers, enums, required fields, and nullability remain exact.
- `GroupRef` retains `applicationId`, `workspaceId`, and `groupId` everywhere.
- Receipt `eventId` remains null; `outboxIds` remains canonical and `outboxId`
  remains its compatibility mirror.

### 9.2 Authority and AppInbox

- HTTP/admin authorization, issued-session reread, HMAC proof contents,
  constant-time comparison, actor/group/request/operation binding, and
  platform-admin derivation remain exact.
- Authority is checked at enqueue and every attempt.
- AppInbox reservation, duplicate identity, semantic command hash, total
  attempts, backoff/jitter, abandoned-reservation recovery, fairness, durable
  failure, retry exhaustion, caller wait timeout, and later winner read remain
  exact.
- Stable volatile facts are captured once at the existing point; attempt-local
  policy time and authority reads remain per attempt.

### 9.3 Transaction, retry, receipt, and outbox

- A config/override write retains one transaction for authority fence, target
  CAS, invariant and target generation CAS, immutable mutation record,
  deterministic APP_OUTBOX, durable result, and reservation finalization.
- A claim writes only authority/idempotency and generic AppInbox completion. A
  no-op/replay performs no domain write.
- Explicit reconfigure retains authority-fence, APP_OUTBOX, durable queued
  result, and reservation completion in one transaction.
- Any compare-and-set or reservation conflict rolls back and reruns the full
  authority/read/compute/validate path.
- APP_OUTBOX exact collision acceptance, divergence corruption, deterministic
  IDs, expiry, sender, payload, audience, final write, and post-commit wake are
  unchanged.
- No observation, wake, receipt, outbox, or partial state escapes a failed
  transaction.

### 9.4 Persistence and migration

- Persisted namespaces remain exactly:
  - `group-topology:config`;
  - `group-topology:override`;
  - `group-topology:config-mutation`;
  - `group-topology:config-generation`; and
  - `group-topology:config-invariant-generation`.
- Key construction remains based on the canonical scoped group storage key plus
  exact target/request/invariant child identity.
- Stored values, revisions, causal revisions, timestamps, nullable legacy
  request IDs, exact decoding, corruption exits, page ordering, cloning, and
  serialization remain exact.
- Exact reads preserve batch selection and sequential invariant-bracketed
  fallback.
- Config, mutation, and generation records remain permanent. Override physical
  expiry equals its semantic expiry.
- Backfill and migration retain three attempts, `oldWritersStopped: true`,
  exact destination comparison, conditional deletion, failure-retry behavior,
  and operation order.

### 9.5 Downstream topology invariants

- Config remains desired policy; it does not become the owner of derived RTC
  overlays.
- Complete causal tuple authority, active/removed snapshot shape, session
  ordering, complete next-hop maps, connectedness, degree limits, publication
  identity, WS audience, and browser overlay handling remain exact.
- The current RTC-specific `publicationFanout` construction seam is recorded
  but not removed or reinterpreted in this child. Durable WS_OUTBOX and generic
  queue pub/sub behavior remain unchanged.

## 10. Target Family-Level Traces

The final README and semantic tests must make these target traces directly
navigable:

1. **Config/override mutation:** route → canonical command → inbox authority →
   `TopologyAppInboxHandler` → `GroupTopologyConfigMutationService` →
   read/compute/validate → transaction writer → durable result → post-commit
   wake → caller.
2. **Explicit reconfigure:** route/admin → inbox authority → handler →
   `group-topology-reconfigure-mutation.ts` → authority fence + APP_OUTBOX →
   durable queued result → wake → caller.
3. **Query:** route/admin → `GroupTopologyConfigQueryService` or public facade →
   readiness → exact read → resolution → persisted/local topology view →
   serializer.
4. **Maintenance:** startup/per-group readiness →
   backfill/migrate canonical owners → accepted/no-op/conflict/retry/failure →
   generic expiry cleanup.
5. **Downstream publication:** committed topology APP_OUTBOX → retained RTC
   worker → snapshot/publication/WS transaction → post-commit cache/wake →
   browser overlay consumer.

Each trace names construction/registration time separately from invocation
time, callback invocation/retry semantics, normal exit, inactive/no-op exit,
retry re-entry, terminal failure, and cleanup.

## 11. Implementation Tasks

### Task 0: Approve and publish the exact child plan

- [x] Human approved exact plan Git blob
      `c9b5e92686ebbc5d4ff136dbea678c93fea1579f`.
- [x] Human merged planning PR #95 under the plan-only publication policy.
- [x] Resulting main resolved to
      `3fa0c94b748281dc326b814e700c06f6c4dd9d07` before implementation.
- [x] One child-specific goal and PR A branch were created.
- [x] PR B-D, a ledger branch, and other children remain uncreated.

### Task 1: Freeze the implementation baseline and review evidence

- [x] Recreate exact current production, test, consumer, import/export,
      case/assertion, size, and call-edge inventories.
- [x] Record the five code-derived current traces and target traces.
- [x] Record the explicit controlled-navigation-sample waiver from Section 2.3.
- [x] Run every warning-only mode on the exact production set.
- [x] Produce one row-by-row disposition report with exact owner and target PR.
- [x] Obtain human approval of the sample waiver and every warning row.
- [x] Add semantic tests for uncovered command/authority, handler, exact-read,
      transaction collision/exhaustion, concurrent idempotency, and convergence
      boundaries before relying on source ratchets.
- [x] Decide exact per-PR lineage manifests only for mechanical movement; no
      semantically new code receives historical debt capacity.

### Task 2: PR A — protocol and pure config mutation core

- [x] Create the initial durable
      `packages/shared-server/rallar-system/topology/README.md` and
      `packages/tests/repo/group-topology-server-navigation-map-integrity.test.ts`;
      PRs B-D update them as owners and paths move.
- [x] Characterize all five command variants, canonical patch states, command
      hashes, authority proofs, unsupported inputs, and error timing.
- [x] Move proof ownership into `topology/inbox`.
- [x] Move config defaults/resolution into `topology/config`.
- [x] Split mutation contracts, idempotency, compute, validation, and result
      reconstruction along Section 7.
- [x] Use exact type-to-payload relationships and exhaustive discriminants.
- [x] Keep state, clocks, repositories, transactions, and I/O outside the pure
      owners.
- [x] Add direct command and authority semantic tests, including expired,
      revoked, wrong-scope, manager/admin, proof mismatch, and attempt-time
      revalidation cases.
- [x] Redirect every exact Section 8 consumer, prove the moved private paths
      have no active supported consumer, and remove those old paths without
      adding shims.
- [ ] Require scoped independent review, full PR A gates, exact commit/tree,
      Branch Release Gate, human merge, and exact resulting-main workflow.

PR A may claim a performance exemption only if every runtime I/O and benchmark
harness blob is byte-identical to its exact base. Otherwise it uses the fixed
protocol in Section 13.

Task 2 candidate `3529959d841e95b375965692a86a77a4fb170058`, tree
`6606d55f2ac9e00a99a5b599c6fe03ad949bf7cf`, is not exempt. Review-fix round 1
expands the fail-closed scope to 24 paths, including the extracted shared-test
receipt projection: eight are byte-identical and sixteen have required import,
boundary, projection, or brace changes. The Section 13 governed comparison and
publication gates remain pending and the final Task 2 checkbox therefore
remains open.

### Task 3: PR B — persistence, exact reads, generations, and migration

- [ ] Split repository contracts, namespaces, keys, codecs, CRUD/CAS, exact
      reads, stored-source decoding, backfill, and legacy migration.
- [ ] Preserve every namespace, key, value, revision, ordering, corruption,
      expiry, page, migration, and retry rule byte-for-byte.
- [ ] Make persistence depend on mutation contracts/validators, never on the
      application service, inbox, public facade, RTC worker, or compatibility
      wrapper.
- [ ] Split the 1,637-line repository test into behavior-named semantic owners.
- [ ] Add exact key injectivity, complete-scope isolation, malformed row,
      equal-revision/different-content, batch/fallback, generation/invariant
      race, migration, and conditional-delete tests.
- [ ] Redirect every exact Section 8 persistence consumer and remove the old
      private repository/read/decoder paths after their active scans are empty.
- [ ] Require scoped persistence review, PostgreSQL concurrency review, all PR
      B gates, exact commit/tree, Branch Release Gate, human merge, and exact
      resulting-main workflow.

PR B crosses the persistence and concurrency domain and must run the fixed
governed performance protocol in Section 13 after the exact candidate freezes.

### Task 4: PR C — authoritative shell, query, reconfigure, and composition

- [ ] Introduce the config query and config mutation services as cohesive
      stateful owners.
- [ ] Construct one `GroupTopologyConfigGenerationReadiness` instance and pass
      it explicitly to both query and mutation services; preserve memoization,
      per-group keying, promise identity, failure eviction, and backfill order.
- [ ] Move reconfigure read/compute/validate/write into the named mutation
      owner.
- [ ] Move planning-authority and local compatibility planning into the named
      planning service without changing RTC algorithms or publication.
- [ ] Make `TopologyAppInboxHandler` depend on exact config-mutation and
      reconfigure capabilities rather than the broad public facade.
- [ ] Preserve `AppGroupInboxService` constructor/setter signatures, setter
      identity/idempotence/errors, handler registration order, and runtime
      readiness while ensuring mandatory handler dependencies are resolved
      before each registration.
- [ ] Preserve public `GroupTopologyManagementService` as the direct
      compatibility facade and keep canonical callers out of old wrappers.
- [ ] Add direct handler operation-matrix, registration/invocation,
      retry-reentry, durable-failure, collision rollback, 20-attempt
      exhaustion, query, reconfigure, and post-commit wake tests.
- [ ] Run the complete config, AppInbox, API, RTC handoff, memory black-box,
      PostgreSQL concurrency/medium-scale, and performance gates.
- [ ] Require scoped inbox/transaction and whole-PR reviews, exact commit/tree,
      Branch Release Gate, human merge, and exact resulting-main workflow.

PR C crosses the mutation and concurrency domain and must run a new fixed
governed performance protocol against PR B's exact resulting main.

### Task 5: PR D — alignment and final traceability

- [ ] Add the temporary child source/style snapshot test-first with this child
      as owner and the later ledger as its removal/replacement decision point.
- [ ] Align only new/materially rewritten topology production, mirrored tests,
      navigation evidence, ratchets, and compatibility wrappers.
- [ ] Enforce descriptive filename/primary-symbol alignment, named interfaces
      and inputs, direct callback semantics, imports/file order, 100-column
      guidance, 60-line functions, and 400-line modules.
- [ ] Prove canonical imports bypass the retained public compatibility
      surfaces; add no moved-private-path wrapper.
- [ ] Preserve all semantic cases/assertions while completing the exact test
      tree.
- [ ] Finalize the five family traces and repeat the controlled human sample.
- [ ] Record every supplementary ratchet as removed, replaced by semantic
      evidence, or retained with owner/reason/later-ledger decision.
- [ ] Give every remaining focused warning row an explicit human disposition.
- [ ] Require independent whole-child review with Critical 0 and Important 0.
- [ ] Run all final gates on one unchanged tree, freeze commit/tree, publish PR
      D, require Branch Release Gate, and stop for human merge.

PR D may retain PR C's performance evidence only if every production/runtime
and benchmark-harness blob is byte-identical to PR C's exact resulting-main
tree. Any runtime difference requires a fresh fixed protocol before
publication.

### Task 6: Publish the later evidence ledger separately

- [ ] Begin only after all four exact resulting-main workflows succeed.
- [ ] Modify only the child and reciprocal program planning records.
- [ ] Record planning/PR A/PR B/PR C/PR D evidence already existing at that
      time.
- [ ] Record warning dispositions, human-sample outcome or explicit waiver,
      compatibility owners, ratchet decisions, semantic coverage, and accepted
      performance evidence.
- [ ] Preserve rejected/superseded evidence as historical evidence.
- [ ] Keep the ledger's own future tree, commit, PR, release gate, merge, and
      default workflow outside the tree that produces them.
- [ ] Mark the child `ledger-published` only externally after the ledger's own
      publication envelope succeeds.

## 12. Test-First And Review Requirements

### 12.1 Semantic tests are primary

Required permanent semantic owners prove:

- all five type-to-payload command relationships and exact durable decode;
- enqueue and per-attempt authority verification;
- config defaults, patching, resolution, expiry, idempotency, and validation;
- exact persisted keys/values, corruption exits, batch/fallback reads,
  generation/invariant races, and legacy migration;
- handler registration versus invocation and all operation exits;
- atomic authority/config/generation/idempotency/outbox/result/finalization;
- transaction rollback on final outbox collision;
- exact retry classification, 20-attempt exhaustion, durable terminal failure,
  observation, and wake;
- concurrent identical/divergent request identity and no lost updates;
- query and reconfigure results;
- RTC APP_OUTBOX handoff and public/API/black-box compatibility.

Source strings, exact inventories, line totals, case/assertion counts, hashes,
and lineage are supplementary only.

### 12.2 Supplementary ratchets

| Evidence                                                     | Owner                           | Removal/replacement condition                                                                                   |
| ------------------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Focused source/style snapshot                                | Child through PR D/later ledger | Remove after all rows have human disposition and permanent semantic/size checks own the intended rule.          |
| Exact per-PR structural lineage                              | The move PR                     | Remove after exact resulting-main and later ledger are recorded and canonical imports bypass predecessor paths. |
| Test ownership inventory: 13 paths, 68 cases, 281 assertions | Test-moving PR                  | Remove after behavior-named owners prove every case/assertion remains; do not freeze line totals.               |
| Consumer compatibility inventory                             | PR D                            | Replace with permanent direct-import/re-export identity and active-path checks.                                 |
| README path/primary-symbol integrity                         | Topology feature                | Permanent durable navigation governance.                                                                        |

Lineage must fail closed on merge base, source blob, target path, symbol/span,
magnitude, and source derivation. It never remaps layout findings or gives
semantically new code historical style-debt capacity.

### 12.3 Independent review points

- Task 1 baseline/navigation/warning review before production movement.
- PR A protocol/security/pure-core review.
- PR B persistence/migration and concurrency review.
- PR C AppInbox/transaction/composition and whole-runtime review.
- PR D compatibility/ratchet/navigation and final whole-child review.
- Later ledger factual/non-circular review.

Every implementation PR requires Critical 0 and Important 0. Ordinary
behavior-neutral in-scope findings are fixed test-first and every invalidated
gate is rerun. A finding requiring a locked contract change stops for human
approval.

## 13. Correctness, Concurrency, And Performance Protocol

### 13.1 Classification

PR A is a pure protocol/core movement only when runtime I/O blobs remain exact.
PR B crosses persistence and concurrency boundaries. PR C crosses AppInbox
mutation, transaction, retry, and concurrency boundaries. PR D is alignment
only when runtime blobs remain exact.

The existing medium-scale recipe fixes 100 independently authenticated clients,
five groups, three PostgreSQL-backed API processes on ports 18080, 18081, and
18082, ten client lanes, and five control lanes. The state-write harness
includes topology-source operations and exact durable receipt/result evidence.

### 13.2 Freeze before candidate

Before PR B and PR C candidate freeze, record:

- all correctness and security commands;
- exact base/candidate SHA requirements;
- pinned PostgreSQL 16 image and resource/configuration limits;
- autovacuum/analyze, preflight-row, automatic-maintenance, overlap, Deno-LSP,
  warmup, run, and concurrency rules;
- comparator and child evaluator hashes;
- latency, throughput, resource, and correctness thresholds;
- artifact names, environment records, raw-sample preservation, pooling, and
  hash rules;
- zero-baseline, unknown-finding, malformed/incompatible-evidence behavior;
- no-reroll and pre-measurement failure classification; and
- stop behavior.

No threshold, environment rule, comparator, evaluator, harness, or failure rule
may change after candidate freeze without separate human approval.

### 13.3 Governed comparison

Use exactly one non-rerolled A-B-B-A sequence:

1. exact predecessor resulting-main SHA;
2. exact immutable candidate;
3. the same candidate;
4. the same predecessor SHA.

Each position uses a fresh non-overlapping isolated PostgreSQL 16 environment,
identical configuration/resource limits, autovacuum/analyze disabled, zero
preflight rows, zero automatic maintenance, no overlapping benchmark/container
or Deno-LSP process, `warmup=1`, `runs=9`, and `concurrency=10`.

Pool exactly 18 raw samples per workload per side. Preserve source artifacts,
environment records, logs, manifest, hashes, and raw samples. Run the unchanged
global comparator and retain its exact exit/output, then the unchanged 1.5%
child evaluator.

The locked acceptance rules are:

- uncontended p95/p99 adverse latency at most 5%;
- shared throughput adverse movement at most 1.5%;
- hot throughput adverse movement at most 10%;
- SQL statements, rows read, serialized bytes, and transaction duration
  adverse movement at most 1.5%, unless existing artifact-backed measured
  conflict-depth evidence accepts it;
- improvements unrestricted;
- fail-closed zero baselines; and
- zero tolerance for commands, receipts, effects, retries, exhaustion,
  atomicity, idempotency, ordering, audience, required/final outbox, schema,
  environment, and artifact correctness.

Unknown findings, changed hashes, missing samples, incompatible environments,
unsupported metrics, malformed artifacts, or missing conflict evidence fail
closed. A consumed position is never rerolled. A guard failure before warmup,
sample, artifact, or environment record is rejected evidence and still needs
explicit human authorization before replacement.

## 14. Validation Matrix

### 14.1 Planning PR

```bash
npx prettier --check \
  plans/rallar-group-topology-server-structure-plan.md \
  plans/repo-human-traceability-refactoring-program-plan.md \
  plans/repo-human-traceability-program-execution-plan.md \
  plans/rallar-auth-server-structure-plan.md
git diff --check
npx vitest run \
  packages/tests/repo/repo-code-style-authority-integrity.test.ts \
  packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts \
  packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts \
  packages/tests/repo/rallar-group-state-owner-integrity.test.ts \
  packages/tests/repo/repo-style-layout-rules.test.ts
```

No build or Branch Release Gate is required for this plan-only publication.

### 14.2 PR A protocol and pure-core gates

```bash
npx vitest run \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-authority.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts \
  packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-boundary.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts
npx vitest run \
  packages/tests/repo/group-topology-server-lineage-provenance.test.ts \
  packages/tests/repo/group-topology-server-navigation-map-integrity.test.ts \
  packages/tests/repo/group-topology-server-ownership.test.ts \
  packages/tests/repo/group-topology-server-test-atom-ownership.test.ts \
  packages/tests/repo/group-topology-server-test-ownership.test.ts \
  packages/tests/shared/authoritative-state-contracts.test.ts
npx vitest run \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-handler.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
deno check --config apps/api-v1/deno.json \
  scripts/perf/api-v1-state-write-concurrency-bench.ts \
  scripts/perf/api-v1-state-write-receipt-evidence.ts \
  packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts \
  packages/shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-projection.ts
```

### 14.3 PR B persistence and concurrency gates

```bash
npx vitest run \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-keys.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-read-write.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-corruption.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-exact-read.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-generation.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-legacy-migration.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts
npx vitest run \
  packages/tests/repo/group-topology-server-lineage-provenance.test.ts \
  packages/tests/repo/group-topology-server-navigation-map-integrity.test.ts \
  packages/tests/repo/group-topology-server-ownership.test.ts \
  packages/tests/repo/group-topology-server-test-ownership.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/guarded-batch-write-contract.test.ts \
  packages/tests/shared/authoritative-state-contracts.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
RALLAR_POSTGRES_INTEGRATION=1 \
DATABASE_URL="$RALLAR_TOPOLOGY_POSTGRES_URL" \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.0.17 run --no-file-parallelism \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
  packages/tests/shared-server/topology/concurrency/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts
```

Run the PostgreSQL cases under the repository's exact Deno/Vitest integration
protocol with a fresh isolated database URL assigned to
`RALLAR_TOPOLOGY_POSTGRES_URL`.

### 14.4 PR C authoritative-shell and consumer gates

```bash
npx vitest run \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-authority.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-handler.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts \
  packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts \
  packages/tests/shared-server/topology/config/group-topology-config-query-service.test.ts \
  packages/tests/shared-server/topology/config/maintenance/group-topology-config-generation-readiness.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-transaction.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-keys.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-read-write.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-corruption.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-exact-read.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-generation.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-legacy-migration.test.ts \
  packages/tests/shared-server/topology/planning/group-topology-planning-service.test.ts \
  packages/tests/shared-server/topology/reconfigure/group-topology-reconfigure-mutation.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts
npx vitest run \
  packages/tests/repo/group-topology-server-lineage-provenance.test.ts \
  packages/tests/repo/group-topology-server-navigation-map-integrity.test.ts \
  packages/tests/repo/group-topology-server-ownership.test.ts \
  packages/tests/repo/group-topology-server-test-ownership.test.ts \
  packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts \
  packages/tests/shared-server/app-inbox-transaction.test.ts \
  packages/tests/shared-server/authoritative-mutation-read-compute-validate-write.test.ts \
  packages/tests/shared-server/direct-resource-outbox.test.ts \
  packages/tests/shared-server/group-state/inbox/app-group-inbox-registration-lifecycle.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts \
  packages/tests/shared-graph/group-topology-validation.test.ts \
  packages/tests/shared/handler-finalized-rtc-topology.test.ts
(cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  "--allow-run=$(deno eval 'console.log(Deno.execPath())')" \
  test/routes/graph-topology-routes.test.ts \
  test/swagger-routes.test.ts \
  test/rtc-topology-config.test.ts \
  test/db/pglite-rtc-topology-ws-outbox.test.ts \
  test/db/pglite-sql-adapter.test.ts)
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
RALLAR_POSTGRES_INTEGRATION=1 \
DATABASE_URL="$RALLAR_TOPOLOGY_POSTGRES_URL" \
deno run -A --unstable-temporal --node-modules-dir=none --no-lock \
  npm:vitest@4.0.17 run --no-file-parallelism \
  --config packages/tests/shared-server/vitest.deno.config.mjs \
  packages/tests/shared-server/topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts \
  packages/tests/shared-server/postgres-topology-app-outbox-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts
```

Run all four PostgreSQL topology concurrency modules, including the retained
APP_OUTBOX case, under the exact integration protocol.

### 14.5 PR D and final child gates

```bash
npm run test:repo-governance
npx vitest run \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-authority.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-handler.test.ts \
  packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts \
  packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts \
  packages/tests/shared-server/topology/config/group-topology-config-query-service.test.ts \
  packages/tests/shared-server/topology/config/maintenance/group-topology-config-generation-readiness.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts \
  packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-transaction.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-keys.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-read-write.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-corruption.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-exact-read.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-generation.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-legacy-migration.test.ts \
  packages/tests/shared-server/topology/planning/group-topology-planning-service.test.ts \
  packages/tests/shared-server/topology/reconfigure/group-topology-reconfigure-mutation.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-config-override-concurrency.test.ts \
  packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts
npx vitest run \
  packages/tests/repo/group-topology-server-lineage-provenance.test.ts \
  packages/tests/repo/group-topology-server-navigation-map-integrity.test.ts \
  packages/tests/repo/group-topology-server-ownership.test.ts \
  packages/tests/repo/group-topology-server-source-ratchet.test.ts \
  packages/tests/repo/group-topology-server-test-ownership.test.ts \
  packages/tests/shared-server/rtc-topology-mutations.test.ts \
  packages/tests/shared-server/rtc-topology-outbox-work.test.ts \
  packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts \
  packages/tests/shared-graph/group-topology-validation.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
(cd apps/api-v1 && deno task check)
npm run test:api-v1:black-box:memory
npm run test:api-v1:black-box:postgres:medium-scale
npm run check:repo-style
npm run check:repo-style:construction-details
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
node scripts/check-changed-repo-style.mjs "$RALLAR_TOPOLOGY_PR_C_MAIN_SHA"
npx prettier --check \
  packages/shared-server/rallar-system/topology \
  packages/tests/shared-server/topology \
  plans/rallar-group-topology-server-structure-plan.md
git diff --check
test "$(find packages/shared-server/rallar-system/topology -name '*.ts' -type f \
  -print0 | xargs -0 wc -l | awk '$2 != "total" && $1 > 400 { print }' \
  | wc -l | tr -d ' ')" = "0"
npm run test:unit
npm run test:ci
npm run build
```

`RALLAR_TOPOLOGY_PR_C_MAIN_SHA` must resolve to the exact verified PR C
resulting-main SHA from the external merge envelope; a short, missing, or
different value fails the final gate.

Every implementation PR also runs every earlier focused suite invalidated by
its changes, all warning-only modes, Prettier verification, `git diff --check`,
`npm run test:unit`, `npm run test:ci`, and `npm run build` on the final
unchanged tree.

## 15. Human Review And Publication Gates

Human decisions are required at these exact points:

1. approve or revise this exact plan blob;
2. approve Task 1's controlled sample and every warning disposition;
3. approve merging exact PR A;
4. approve merging exact PR B after governed persistence performance evidence;
5. approve merging exact PR C after governed authoritative-shell evidence;
6. approve PR D's compatibility/ratchet decisions and exact merge;
7. separately authorize the later evidence-ledger publication; and
8. approve and close that ledger before RTC/RTT or another Wave 2 child begins.

Implementation PRs remain draft until scoped review, Critical 0/Important 0,
all required local gates, exact tree freeze, current PR evidence, and Branch
Release Gate success for the exact final SHA. No agent merges a PR or operates
on the default branch. After each human merge, verify the exact resulting-main
SHA and required default workflow before creating the next branch.

## 16. Non-Circular Completion Evidence

This planning tree records only existing prerequisite and planning-base facts.
It cannot contain its own future blob, tree, commit, PR, merge, workflow, or
implementation result.

Each implementation PR records only completed local tasks and existing
predecessor envelopes. Its future merge, resulting-main SHA, and default
workflow remain in the PR and Mandatory Completion Handoff external envelope.
The next PR reconciles those facts only after they exist.

The later ledger may record the completed planning/PR A/PR B/PR C/PR D
envelopes but not its own future tree, commit, PR, Branch Release Gate, merge,
or default workflow. Only after that external envelope succeeds may the child
be marked `ledger-published`.

Any content change after validation, independent review, or performance
candidate freeze invalidates the affected evidence. Historical failures and
measurements remain historical and are never relabeled for a changed tree.

## 17. Acceptance Checklist

- [x] Human approved exact plan Git blob
      `c9b5e92686ebbc5d4ff136dbea678c93fea1579f`.
- [x] Planning PR #95 merged under the plan-only policy.
- [x] Task 1 exact baseline and controlled human sample are approved or
      separately waived.
- [x] Every focused warning row has an explicit human owner/rationale
      disposition.
- [ ] Four implementation PRs remain independently reviewable.
- [ ] Exact current-to-target production and test ownership is reconciled.
- [ ] Canonical topology callers bypass compatibility-only wrappers.
- [ ] Every retained old/public path is direct one-hop compatible with owner and
      removal condition.
- [ ] Public, protocol, authority, persistence, AppInbox, transaction, retry,
      receipt, outbox, query, and topology invariants remain exact.
- [ ] Semantic ownership/security/transaction/exit tests remain primary.
- [ ] All temporary ratchets have owner and removal/replacement decisions.
- [ ] PR A review, gates, merge, and resulting-main workflow succeeded.
- [ ] PR B review, governed performance, merge, and resulting-main workflow
      succeeded.
- [ ] PR C review, governed performance, merge, and resulting-main workflow
      succeeded.
- [ ] PR D review, gates, merge, and resulting-main workflow succeeded.
- [ ] Separate evidence ledger independently reached `ledger-published`.
- [ ] API-v1 topology, RTC/RTT, CRDT, admin, and other Wave 2 work remained
      unstarted.

## 18. Risks And Stop Conditions

| Risk                                                                            | Required response                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Split creates generic services or forwarding-only helpers                       | Repartition around protocol, decision, persistence, transaction, query, or planning authority.          |
| Required handler dependency remains temporally optional                         | Resolve before registration while preserving public setter behavior, or stop for architecture approval. |
| Config absorbs RTC algorithms, RTT, publication, or WS delivery                 | Restore the downstream boundary; stop if the owner cannot stay separate.                                |
| Public/deep path needs a second compatibility hop                               | Keep one direct old-to-canonical export and return the exact consumer for review.                       |
| Persisted field/key/expiry/migration changes                                    | Stop for explicit persisted-contract approval.                                                          |
| Authority, AppInbox, transaction, retry, receipt, or outbox changes             | Stop for explicit security/behavior approval.                                                           |
| API-v1/OpenAPI organization or behavior changes                                 | Revert to import-only compatibility or stop for a separate child.                                       |
| Warning is ignored because checker exits zero                                   | Stop until human disposition exists.                                                                    |
| Ratchet replaces semantic behavior evidence                                     | Restore semantic coverage and keep the ratchet supplementary.                                           |
| Performance protocol, environment, threshold, or candidate changes after freeze | Stop; no reroll, threshold change, or evidence relabeling.                                              |
| Required external gate persistently fails                                       | Stop with exact run/job/step; do not diagnose unrelated providers.                                      |
| Unrelated plan, dependency, lockfile, workflow, checker, or TypeScript changes  | Restore exact scope before publication.                                                                 |

## 19. Progress Record

| Milestone                  | State            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth prerequisite          | ledger-published | PR #93 feature `aeff6435794dd70816789e4794b78e84fdfc89b0`, tree `8bdea4402dad08dbd1892f2bd8c95671d615b8ff`, accepted plan-only build-gate exception, resulting main `c2cb79c020bceee7f67e6fbc364ba96ea0d6a530` with the same tree. Hetzner run `31251480014` attempt 1 failed and is retained only as non-gating plan-only external evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Group-topology child plan  | approved         | Planning PR #95, exact approved blob `c9b5e92686ebbc5d4ff136dbea678c93fea1579f`, resulting main `3fa0c94b748281dc326b814e700c06f6c4dd9d07`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| PR A protocol/core         | in progress      | Draft PR #103. Task 1 accepted at head `7c03c1c7b96d6203742e68426a52298d1b05d2d2`, tree `66d48b5def11b813d3889e0ff7a515cc9b817c00`; Branch Release Gate `31264619538`, attempt 1, succeeded. Task 2 local implementation is `3529959d841e95b375965692a86a77a4fb170058`, tree `6606d55f2ac9e00a99a5b599c6fe03ad949bf7cf`; review-fix round 1 implementation is `d5ca20b19031450e5ae461e56cd025242860249b`, tree `d90f1e596d14c915e3b50be36c38be822fdc249d`, and its reconciled candidate is `9771d288aaf530e87469ffe86123a7e7b0a01afc`, tree `3e362c604bdd477a704ed56dd4a4a20aa2ef8574`; review-fix round 2 implementation is `44e851ae3fac500081b25e25343e5260a16ed364`, tree `fa9a498e9663d7565f8622f7bf1d260df942c667`, and its retained cross-domain source-ratchet redirect is `c46bc8aeabee005a90fda9fb55596eabaf681049`, tree `d2190f46238f3939b054df34db46637e3477068d`. Its expanded 24-path blob comparison is non-exempt, so the governed performance comparison, scoped review, publication, Branch Release Gate, human merge, and resulting-main workflow remain pending. |
| PR B persistence           | blocked          | Requires PR A merge and exact resulting-main workflow success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PR C authoritative shell   | blocked          | Requires PR B merge and exact resulting-main workflow success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| PR D alignment/final trace | blocked          | Requires PR C merge and exact resulting-main workflow success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Later topology ledger      | blocked          | Requires all four implementation publication envelopes and separate authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| RTC/RTT and later domains  | blocked          | Remain outside this child.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 20. Self-Review Checklist

- [x] No placeholder, guessed SHA, future evidence, or hidden approval remains.
- [x] Every current and target production/test path has one stated owner.
- [x] Every source partition names matching primary symbols and one target.
- [x] Construction registration and runtime invocation are separate timelines.
- [x] Normal/no-op/replay/retry/terminal/cleanup exits are explicit.
- [x] Config, reconfigure, RTC, WS, browser, and API ownership do not blur.
- [x] Every compatibility surface names consumers and removal conditions.
- [x] Structural movement, alignment, and semantic work are strictly separated.
- [x] Tasks remain independently reviewable and below the chosen stacked scope.
- [x] Public/persisted/security/AppInbox/transaction/outbox invariants are exact.
- [x] Human warning disposition and controlled sample are explicit.
- [x] Performance/failure/no-reroll rules are frozen before candidate.
- [x] Semantic tests remain primary and ratchets supplementary.
- [x] Non-circular planning, implementation, and ledger evidence is preserved.
- [x] No production behavior is authorized without explicit human approval.
