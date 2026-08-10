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

Status: Approved child in execution. PR A resulting main
`cd69565936d881c960dbe151cfe48917a4a2e1bb` is an ancestor of the exact PR B
base. PR A's preserved failed performance results, publication reconciliation,
and exact-candidate human disposition remain historical evidence and are not
rewritten by the prospective PR B schema-v5 reconciliation below. The human
approved original planning Git blob
`c9b5e92686ebbc5d4ff136dbea678c93fea1579f`, performance-amendment blob
`f83cc311369fff2bf255116253ec0f4fe911a43f`, and pooler-order correction blob
`ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc`, and gate-disposition amendment
blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9`, and artifact-owner target-path
correction blob `cf4d92db310c928b2e020f926efa4f731a2fd3b6`. No new measurement is
authorized until the exact candidate, tools, conflict-reason input, and
environment envelope receive their separate human approval.

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

The original planning pull request changed only:

- this plan;
- the master program;
- the execution plan; and
- the auth child plan for exact ledger closure and successor linkage.

The performance amendment, pooler-order correction, and this gate-disposition
amendment each change only this plan. None reconciles the master program,
execution plan, implementation branch, or any future implementation/publication
fact before its exact blob is approved.

Under the repository plan-only publication policy, its gates are Prettier,
`git diff --check`, and the focused repository-governance tests. Build, unit,
CI, Branch Release Gate, and resulting-main deployment workflows are not
required for this plan-only revision. Implementation PRs remain subject to
their full code and publication gates.

### 0.4 Approved performance-protocol amendment evidence

This amendment starts from freshly fetched `origin/main`
`9ff4b7422c8124acf4bce0c46d1d1bf7cddbab6a`, tree
`833a3e22103ea51f5838ae05e4e4640acfa15c65`, on isolated branch
`codex/rallar-group-topology-performance-protocol-amendment`. It carries
forward the already authorized factual Task 1 and Task 2 reconciliation from
PR A's plan file at Git blob `749ac5fb3796523f4bd6906220ba4664d7fb34a2`
without changing PR A.

The human approved exact amendment blob
`f83cc311369fff2bf255116253ec0f4fe911a43f`. Plan-only PR #125 published it at
feature head `cf67bc313584b7183780990e8a51c787ab5c3bd2`, frozen tree
`e1077b7d303315438998da349bb12959cc1b1f2a`, then merged as resulting main
`fccda1c6d3dd3114b50775a78b83c4e788bb7043`, tree
`19c0cd37d6f5e1b9dda9eeb73367f01b965d7558`. No local build or Branch Release
Gate was required under the repository plan-only policy.

The immutable production candidate remains exact commit
`74a62eb22583216e8c6651de069209d7e1a8ca67`, tree
`7f971bcf84aa494265992d17e3c9b99227bd8122`. The exact tooling-integrated PR A
candidate `ed7e77cd560a701ec41bc544769c60a715f68744`, tree
`161e125131adb87dcd90bba737dfe91cb8d624b7`, was pushed to draft PR #103 only
after the human accepted its exact-candidate performance disposition.

The completed governed A-B-B-A sequence is retained permanently as failed
historical evidence:

- A1 artifact SHA-256
  `a0e162f3d9cdbb2b9bf831852c09946c3368f2ab2fc51e9980929ca968226d5d`;
- B1 artifact SHA-256
  `f87f2e9aa2e8021241f532057f05ba9e3d06634ae8bf0d2b358468ac1d8c3b8c`;
- B2 artifact SHA-256
  `e03beb6eab9e97ce8b46f5172987227ae4bd92e666a97efb590fe1e163751f11`;
- A2 artifact SHA-256
  `bc104a374a1109232ff5f61830653179dcdebd1c7598a9477eca9dfdbf8daf40`;
- normalized environment-record SHA-256
  `e28a21d1a8dd8f5a98c5b3a75d1c1c8a52ebf4896ec9a3a64b42b1385de481c9`;
- pooled-base SHA-256
  `d2d8a28e5760f933d5d522030cda1d1025ffa264f56dc7e1f6049b1b125b6e85`;
- pooled-candidate SHA-256
  `e6ff1d9dadcdcbc255a985794bb2bda0f194b451a634af6605fc0164674673f4`;
- manifest SHA-256
  `8f0db39534e5f8292a4f6c4c7d3d944be0d8c6e7de83b06a358072431978d391`;
- unchanged global-comparator log SHA-256
  `ffa4d800ddcb4240441431450065940e4a55618ce0aa070e5b3494359e2b36a6`;
- unchanged child-evaluator log SHA-256
  `f45e6a30a396f83f24e33d998ffb9175ecf2c19a338f1d4f1012e5d215af649f`;
  and
- the first default-heap pooling OOM log SHA-256
  `5374f35d818135b0df2eca0460ad91f1f6e260eba6e306a3731eaca1841b0fef`.

The four positions, environments, raw correctness evidence, and later
human-authorized high-heap pooling invocation were valid. The governed result
failed because shared throughput moved adversely by `5.068999%`, beyond the
unconditional `1.5%` child limit, and shared PostgreSQL transaction duration
moved adversely by `3.088188%` without the pre-recorded conflict-reason link
required by the existing evaluator. It is not accepted evidence and no part of
this amendment relabels, replaces, discards, or reruns it.

Read-only artifact and static-path diagnosis found a position-correlated
performance regime and an early-B2 `RuntimeStateWriteConflictError` burst, not
an evidenced stable candidate-caused regression. A1/B1 and late B2/A2 were
within the child band; candidate per-attempt transaction, SQL, row, and byte
costs improved; and most additional conflicts occurred in unchanged mutation
families. Transaction, retry, SQL, CAS, AppInbox, and outbox owners were
byte-identical. This evidence supports a prospective order-control amendment
but authorizes no speculative production remediation.

The global comparator's sentence that shared throughput should improve after
presence is split from the group aggregate is retained as historical
group-state wording, not a topology invariant. The existing child evaluator
was the correct evaluator selected by the approved plan for the failed v1
sequence; correcting future protocol ownership does not invalidate that result.

### 0.5 Approved pooler-order correction evidence

This follow-up correction starts from exact `origin/main`
`fccda1c6d3dd3114b50775a78b83c4e788bb7043`, tree
`19c0cd37d6f5e1b9dda9eeb73367f01b965d7558`, on isolated branch
`codex/rallar-group-topology-performance-pooler-order-plan`. Its baseline plan
blob is the approved amendment `f83cc311369fff2bf255116253ec0f4fe911a43f`.

Pre-implementation review found one mechanical contradiction. The v1 pooler
reads its inputs in descriptor order and requires `generatedAt` to increase in
that order, with the existing public entry fixed to `A-B-B-A`. The approved
second-block mapping `A3, B3, B4, A4` refers to chronological positions
`6, 5, 8, 7`, so it must fail before pooling. Reordering timestamps, rewriting
artifacts, relabeling roles, or duplicating the numerical pooler is forbidden.

The human approved exact correction blob
`ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc`. Plan-only PR #127 published it at
feature head `8e36fe1c303f695f0a6ec3d99be30eda12c96b11`, frozen tree
`3d6cdf6abb46866e74895fe49150a4a9a4bde77c`, then merged as resulting main
`df8346aaf39e8d8730e73a530da3e6f182aa071b`, tree
`3d6cdf6abb46866e74895fe49150a4a9a4bde77c`. No local build or Branch Release
Gate was required under the repository plan-only policy.

The correction preserves the fixed `A-B-B-A-B-A-A-B` chronology and permits a
pure explicit-position entry point inside the v1 pooler. Its existing public
API, behavior, outputs, errors, thresholds, comparator, evaluator, and ordinary
`A-B-B-A` protocol remain unchanged.

### 0.6 Approved prospective tooling gate-disposition evidence

This gate-disposition amendment starts from freshly fetched `origin/main`
`6f6f9767eab300229d549f06a98a3ce7bd3e37f2`, tree
`e3dcb724cef8463d05041e8e2c6e68e96c447aef`, on isolated branch
`codex/rallar-group-topology-performance-tooling-gate-plan`. Current-main plan
blob `fd2b8520462d18ebe3a8352f18d1741a12676667` includes later unrelated path
reconciliations, which this amendment preserves.

The immutable production candidate remains commit
`74a62eb22583216e8c6651de069209d7e1a8ca67`, tree
`7f971bcf84aa494265992d17e3c9b99227bd8122`. Draft PR #103, the unstaged
prospective tooling candidate, failed historical benchmark evidence, global
comparator, child evaluator, thresholds, and production behavior remain
unchanged. No benchmark, implementation staging, implementation commit,
candidate push, or PR #103 update is part of this amendment.

Independent corrected-tooling review reported Critical 0 and Important 0.
That review confirmed the exact base cross-binding, cross-block raw-command-ID
replay rejection, real-parent output alias rejection, exact role/source sample
partition and order, missing-field and duplicate-position failures, and exact
supplied/omitted `regressionReasons` artifact output. The only remaining issue
is repository gate disposition:

- the inherited benchmark predecessor is 1,763 physical lines and formats to
  1,945 lines under repository Prettier 3.9.5;
- the current prospective benchmark is 1,826 physical lines and formats to
  2,012 lines;
- exact-base changed style fails only on worsened `file.length`;
- the inherited `main` function remains above 60 lines; and
- every other approved tooling, test, and plan path passes Prettier, while
  every newly introduced general function is at most 60 lines.

The human approved exact gate-disposition blob
`b6fd5aebfa77ee489e65fa30fbee165e033c14f9`. Plan-only PR #129 published it at
feature head `05c75cf2ad52589901e6983a687d28aa5b910582`, frozen tree
`e3b309e9b913395e28645f1355400d380697c658`, then merged as resulting main
`c7d6d4ec017edb23de239bba18c6d79f2ebb5dac`, tree
`e3b309e9b913395e28645f1355400d380697c658`. No local build or Branch Release
Gate was required under the repository plan-only policy.

The behavior-neutral disposition in Sections 13.3 and 14.2.1 now authorizes
only the artifact-owner extraction and the exact two code-style exception
entries. It authorizes no benchmark, production behavior, threshold,
comparator, evaluator, dependency, workflow, TypeScript, or PR #103 publication
change.

### 0.7 Approved artifact-owner target-path correction evidence

The target-path correction started from exact `origin/main`
`661e497597587e3803c0760a90b0a124df8af075`, tree
`dfc45f287ecfd39b10acb399c42d7a6214f5353f`, on isolated branch
`codex/rallar-group-topology-performance-artifact-path-plan`. PR #129 resulting
main was an ancestor, and the plan at that base remained exact approved blob
`b6fd5aebfa77ee489e65fa30fbee165e033c14f9`.

Independent review reported Critical 0 and Important 0 for the implementation
itself and one Important governance blocker. The original direct artifact-owner
path necessarily increased `scripts/perf` direct TypeScript files from 29 to 30
and the direct `state` prefix cluster from 6 to 7, so exact-base changed style
failed only `layout.directory-density` and `layout.feature-prefix-cluster`.
The approved benchmark file/`main` exceptions neither cover nor suppress those
directory-layout findings.

The human approved exact correction blob
`cf4d92db310c928b2e020f926efa4f731a2fd3b6`. Plan-only PR #131 published it at
feature head `42eb663177d731f3759fc2a2664db2ad3297f149`, frozen tree
`3560eaa0677f219e109f3cad86b169145658cb7e`, then merged as resulting main
`5e892aaff06cce0d994fbf79cfbcc12b235c7e48`, tree
`3560eaa0677f219e109f3cad86b169145658cb7e`. No local build or Branch Release
Gate was required under the repository plan-only policy.

The correction authorizes only moving the artifact owner to
`scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts` and the
directly required benchmark import, focused-test import, validation-command,
exact-tree, ownership, and factual plan references. The old direct path is
removed without a compatibility re-export. The artifact API, schema, property
order, values, errors, timing, optional reason-file behavior, JSON formatting,
trailing newline, exact 2,571-byte regression output, benchmark line cap,
code-style exceptions, both pooling protocols, immutable production candidate,
comparator, evaluator, thresholds, dependencies, workflows, TypeScript,
checker behavior, and failed historical evidence remain unchanged.

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
      group-topology-config-source-repository.ts
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
      group-topology-config-repository-scope-isolation.test.ts
      group-topology-config-mutation-record-corruption.test.ts
      group-topology-config-exact-read.test.ts
      group-topology-config-generation.test.ts
      group-topology-config-legacy-migration.test.ts
      group-topology-config-persistence-test-fixtures.ts

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
  group-topology-server-pr-b-test-ownership.ts
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

PR B adds the checker-owned structural lineage manifest
`plans/repo-style-lineages/rallar-group-topology-server-pr-b.json`. It pins
the exact PR B base, predecessor blobs, and genuine canonical primary targets
for the five deleted private persistence/read/maintenance owners. The
behavior-named PR B test-ownership inventory independently maps every frozen
repository and exact-read case to one target case; four new semantic cases are
tracked outside that moved inventory.

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
| same, repository CRUD/CAS operations                                                                                    | `config/persistence/group-topology-config-repository.ts`                                                                                                                                                                                | B                 |
| same, source/page and legacy-source lookup                                                                              | `config/persistence/group-topology-config-source-repository.ts`                                                                                                                                                                         | B                 |
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

| Current path                                            | Target path or paths                                                                                                                                                                                                                                                                                                                                                                                                                                            | Preserved responsibility                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `group-topology-config-service.test.ts`                 | `topology/config/group-topology-config-resolution.test.ts` and the four exact pure `topology/config/mutation/*.test.ts` owners                                                                                                                                                                                                                                                                                                                                  | Defaults, patching, expiry, resolution, decisions, receipts, and validation         |
| `group-topology-config-repository.test.ts`              | `topology/config/persistence/group-topology-config-repository-keys.test.ts`, `group-topology-config-repository-read-write.test.ts`, `group-topology-config-repository-corruption.test.ts`, `group-topology-config-repository-scope-isolation.test.ts`, `group-topology-config-mutation-record-corruption.test.ts`, `group-topology-config-exact-read.test.ts`, `group-topology-config-generation.test.ts`, and `group-topology-config-legacy-migration.test.ts` | Keys, scope, CRUD, corruption, exact read, generation, migration, rollback          |
| `group-topology-management-service.test.ts`             | `topology/config/group-topology-config-query-service.test.ts`, `topology/config/maintenance/group-topology-config-generation-readiness.test.ts`, `topology/planning/group-topology-planning-service.test.ts`, and `topology/reconfigure/group-topology-reconfigure-mutation.test.ts`                                                                                                                                                                            | Query/view, readiness, planning authority, reconfigure, local compatibility, errors |
| `topology-app-inbox-contract.test.ts`                   | `topology/inbox/topology-app-inbox-command.test.ts`, `topology-app-inbox-authority.test.ts`, and `topology-app-inbox-handler.test.ts`                                                                                                                                                                                                                                                                                                                           | Five operations, hashes, proof, durable decode, and handler exits                   |
| `topology-app-inbox-ownership.test.ts`                  | `topology/inbox/topology-app-inbox-ownership.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                           | Canonical owners, dependency direction, identity, and registration                  |
| `postgres-topology-app-inbox-concurrency.test.ts`       | `topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts`                                                                                                                                                                                                                                                                                                                                                                                          | Cross-client overlap, retry, receipt, outbox, and final state                       |
| `postgres-topology-config-override-concurrency.test.ts` | `topology/concurrency/postgres-topology-config-override-concurrency.test.ts`                                                                                                                                                                                                                                                                                                                                                                                    | Config/override invariant surface and no lost update                                |
| `postgres-topology-mutation-worker-concurrency.test.ts` | `topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts`                                                                                                                                                                                                                                                                                                                                                                                    | Independent worker retry, idempotency, and completion                               |
| `postgres-topology-concurrency-fixtures.ts`             | `topology/concurrency/postgres-topology-concurrency-fixtures.ts`                                                                                                                                                                                                                                                                                                                                                                                                | Barriers, clients, cleanup, and assertions                                          |
| `postgres-topology-mutation-worker-fixtures.ts`         | `topology/concurrency/postgres-topology-mutation-worker-fixtures.ts`                                                                                                                                                                                                                                                                                                                                                                                            | Worker protocol and deterministic fixture construction                              |
| `fixtures/postgres-topology-app-inbox-worker.ts`        | `topology/concurrency/fixtures/postgres-topology-app-inbox-worker.ts`                                                                                                                                                                                                                                                                                                                                                                                           | Child-process AppInbox worker runtime                                               |
| `postgres-topology-app-outbox-concurrency.test.ts`      | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Downstream RTC APP_OUTBOX evidence; no ownership move                               |
| `fixtures/postgres-topology-app-outbox-worker.ts`       | unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Downstream RTC worker fixture; no ownership move                                    |

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
  `topology/config/persistence/group-topology-config-repository-scope-isolation.test.ts`,
  `topology/config/persistence/group-topology-config-mutation-record-corruption.test.ts`,
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
  `packages/tests/shared-server/integration/postgres/topology-config-override-concurrency.test.ts`, and
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
  `packages/tests/shared-server/integration/postgres/topology-app-inbox-concurrency.test.ts`,
  `packages/tests/shared-server/integration/postgres/topology-config-override-concurrency.test.ts`,
  `packages/tests/shared-server/integration/postgres/topology-mutation-worker-concurrency.test.ts`, and
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

Final pre-measurement Task 2 candidate
`74a62eb22583216e8c6651de069209d7e1a8ca67`, tree
`7f971bcf84aa494265992d17e3c9b99227bd8122`, is not exempt. Its 24-path
fail-closed comparison contains eight byte-identical and sixteen changed/added
paths. Independent final review reported Critical 0 and Important 0, and every
required correctness/completion gate passed on that frozen tree.

Its first governed v1 A-B-B-A comparison then failed exactly as recorded in
Sections 0.4 and 13.2. The candidate remains local, draft PR #103 remains on an
older remote head, and no Branch Release Gate exists for the candidate. The
final Task 2 checkbox remains open.

#### Task 2 prospective performance-protocol amendment

- [x] Preserve the complete v1 sequence, comparator/evaluator failures, and
      diagnosis as immutable historical evidence.
- [x] Keep PR #103 and candidate `74a62eb22583216e8c6651de069209d7e1a8ca67`
      unchanged while drafting this amendment.
- [x] Obtain human approval of amendment blob
      `f83cc311369fff2bf255116253ec0f4fe911a43f` and merge plan-only PR #125.
- [x] Stop before implementation when the mirrored block proved incompatible
      with the existing v1 pooler's fixed descriptor order.
- [x] Obtain human approval of pooler-order correction blob
      `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc` and merge plan-only PR #127.
- [x] Implement the corrected prospective tooling scope without staging,
      committing, pushing, changing production/runtime blobs, or running a new
      benchmark.
- [x] Obtain independent corrected-tooling review with Critical 0 and Important
      0; retain the remaining size/formatting disposition as a separate human
      decision.
- [x] Obtain human approval of gate-disposition amendment Git blob
      `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` and merge plan-only PR #129.
- [x] Extract benchmark Git-identity and artifact-construction ownership and
      add only the exact Section 13.3 exception-registry entries test-first.
- [x] Obtain human approval of target-path correction blob
      `cf4d92db310c928b2e020f926efa4f731a2fd3b6`, merge plan-only PR #131, and
      move only the artifact owner and its direct evidence references.
- [x] Rerun every tooling-invalidated focused and repository completion gate,
      then obtain final independent tooling and whole-PR review with Critical 0
      and Important 0.
- [x] Freeze exact candidate `ed7e77cd560a701ec41bc544769c60a715f68744`,
      tree `161e125131adb87dcd90bba737dfe91cb8d624b7`, its complete environment, tool,
      and conflict-reason envelope, and obtain explicit human authorization.
- [x] Preserve the non-rerolled eight-position attempt: seven positions passed;
      B4 failed its continuous isolation guard and remains failed evidence.
- [x] Record the human exact-candidate disposition accepting balanced block 1
      plus the seven-successful-position diagnostic without relabeling B4.
- [ ] Reconcile the exact concurrent-main merge and lineage base, require Branch
      Release Gate success for the resulting exact head, and mark PR #103 ready.

### Task 3: PR B — persistence, exact reads, generations, and migration

PR B applies the Section 1.5 private refinement by separating source/page and
legacy-source lookup into
`config/persistence/group-topology-config-source-repository.ts`. It also
separates scope-isolation and mutation-record-corruption tests from the general
corruption owner and shares only deterministic fixture construction through
`group-topology-config-persistence-test-fixtures.ts`. These refinements keep
each owner behavior-named and below 400 lines without adding a public
compatibility path.

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

### 13.2 Immutable failed v1 comparison

The first PR A comparison used the approved v1 A-B-B-A protocol and remains a
governed failure. Its exact evidence is recorded in Section 0.4. The raw
positions, environment records, pooled artifacts, global-comparator exit 1,
and child-evaluator exit 1 remain immutable. They are never inputs to, samples
for, or acceptance evidence in a later protocol.

Offline diagnosis is explanatory only. It may justify drafting this amendment,
but it may not delete an outlier, change a threshold, repair an artifact,
populate a missing regression reason after measurement, or turn the v1 result
into a pass. No code correction is authorized because no candidate-caused
runtime regression was established.

### 13.3 Prospective PR A tooling boundary

With both the gate-disposition amendment and target-path correction approved,
PR A may finish the following performance-tooling changes test-first:

- modify `scripts/perf/api-v1-state-write-concurrency-bench.ts` only to accept
  and validate an optional `--regression-reasons-file=<relative-path>` input,
  then delegate Git-identity resolution and artifact construction to the named
  owner below;
- create
  `scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts` as the
  sole owner of `BenchmarkGitIdentity`, `StateWriteBenchmarkArtifactInput`,
  `StateWriteBenchmarkArtifact`, `readBenchmarkGitIdentity`, and
  `createStateWriteBenchmarkArtifact`;
- keep general state-write artifact validation in
  `packages/tests/shared-server/state-write-performance-harness.test.ts`, and
  colocate topology reason-file parsing, commit/tree binding, canonical order,
  supplied/omitted emission, and fail-closed evidence in
  `packages/tests/shared-server/state-write-performance-topology-reasons.test.ts`;
- modify `scripts/perf/pool-api-v1-state-write-results.mjs` only to export the
  pure `poolApiV1StateWriteResultsForPositions(input, sourcePositions)` entry
  described below while preserving the existing
  `poolApiV1StateWriteResults(input)` entry exactly;
- modify `packages/tests/shared-server/state-write-performance-pooling.test.ts`
  to prove the existing entry's valid outputs and malformed-input errors are
  unchanged, and to prove explicit `B-A-A-B` descriptor behavior/failures;
- create
  `scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs`
  as the pure eight-position protocol and outer-manifest owner;
- create
  `scripts/perf/write-group-topology-state-write-position-balanced-results.mjs`
  as its CLI/file-I/O owner;
- create
  `packages/tests/shared-server/group-topology-state-write-position-balanced-pooling.test.ts`
  as the positive, corruption, ordering, environment, source-identity, and
  no-masking evidence owner; and
- modify `docs/repo-code-style-exceptions.md` only to add the two exact
  exception entries defined below.

The extraction is an ownership move, not an artifact change. The benchmark
must call `readBenchmarkGitIdentity` at the same point as the existing Git
identity read and call `createStateWriteBenchmarkArtifact` after all measured
workloads finish but before the existing output write. The extracted owner must
preserve the artifact schema, property order, values, errors, optional
reason-file behavior, measurement timing, workload, JSON formatting, trailing
newline, and output bytes exactly. It must stay at or below 400 physical lines,
and every general function it introduces must stay at or below 60 physical
lines.

After extraction,
`scripts/perf/api-v1-state-write-concurrency-bench.ts` must be at or below its
exact 1,763-line predecessor magnitude. Exact-base changed style must pass with
no `file.length` increase. The benchmark's inherited formatting and inherited
over-60-line `main` receive only these exact `cohesive algorithm` registry
entries:

| Path                                                   | Symbol      | Category           | Cohesion rationale                                                                                                                                         | Approval                                                                                   | Review or removal condition                                                                                                                                                                        |
| ------------------------------------------------------ | ----------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/perf/api-v1-state-write-concurrency-bench.ts` | Entire file | cohesive algorithm | Keep the unchanged measured orchestration together for this tooling wave while the named artifact owner is extracted; the file may not exceed 1,763 lines. | Human approval on 2026-08-09 of exact plan blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` | Remove in a separately approved benchmark-architecture child that splits measurement orchestration into cohesive owners without changing benchmark behavior, artifacts, timing, or governance.     |
| `scripts/perf/api-v1-state-write-concurrency-bench.ts` | `main`      | cohesive algorithm | Preserve the inherited end-to-end measurement lifecycle and cleanup order during this tooling wave; no newly introduced general function may exceed 60.    | Human approval on 2026-08-09 of exact plan blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` | Remove in the same separately approved benchmark-architecture child after `main` is split along genuine lifecycle ownership without changing benchmark behavior, artifacts, timing, or governance. |

The group-topology child owns both entries. They do not suppress checker
warnings, authorize further file or symbol growth, apply to another file or
symbol, waive independent review, or authorize the later benchmark-architecture
child. Whole-file Prettier is waived only for
`scripts/perf/api-v1-state-write-concurrency-bench.ts` during this tooling wave.
Every extracted owner and every other changed path remains subject to Prettier.

The approved implementation realized this ownership boundary test-first. The
new artifact owner is 116 physical lines, every introduced general function is
at most 60 lines, and the benchmark is 1,733 physical lines. A fixed artifact
fixture serializes to 2,571 bytes with SHA-256
`70a977c657cd1d0ae850b291d19872a73932c6e46050855acfed3131741f70dd`, proving
that schema, property order, values, JSON formatting, trailing newline, and
optional reason emission remain exact. The registry contains only the approved
file-level and `main` entries, with the group-topology child as owner and the
separately approved benchmark-architecture child as their removal condition.

The existing global comparator,
`scripts/perf/compare-api-v1-state-write-results.mjs`, and existing 1.5% child
evaluator,
`scripts/perf/compare-group-state-server-structure-performance.mjs`, remain
byte-identical. The v1 pooler's existing public entry, constant, output schema,
artifact validation, numerical aggregation, error ordering/messages, and
ordinary `A-B-B-A` behavior remain unchanged. The new outer pooler calls the
existing entry for block 1 and the explicit-position entry for block 2; it does
not duplicate or reinterpret validation or numerical policy.

`poolApiV1StateWriteResultsForPositions` accepts the same pooling input plus one
dense four-entry descriptor array. Each descriptor contains exactly:

```ts
interface StateWritePoolingSourcePosition {
  readonly key: string;
  readonly position: 1 | 2 | 3 | 4;
  readonly role: 'approved-base' | 'candidate';
}
```

The function requires four unique non-empty keys, positions `1, 2, 3, 4` in
that order, exactly two descriptors per role, and one complete source for each
key. It performs the existing unique-artifact, environment, increasing
`generatedAt`, commit, compatible-metadata, raw-command-ID, correctness, and
pooled-artifact checks against descriptor order. It calls the same existing
role-pooling and summary implementation and emits the same v1 artifact and
manifest schema.

`poolApiV1StateWriteResults(input)` remains a wrapper over the frozen existing
descriptor list:

```ts
[
  { key: 'approvedBaseFirst', position: 1, role: 'approved-base' },
  { key: 'candidateFirst', position: 2, role: 'candidate' },
  { key: 'candidateSecond', position: 3, role: 'candidate' },
  { key: 'approvedBaseSecond', position: 4, role: 'approved-base' },
];
```

Tests run every existing positive and negative fixture through that public
entry and retain all exact expected outputs/errors. Direct equivalence tests
also call the explicit-position entry with the frozen descriptors. New negative
fixtures reject missing/extra fields, sparse arrays, duplicate/empty keys,
duplicate/out-of-order positions, wrong role counts, unsupported roles,
missing keyed sources, and non-increasing chronological timestamps. A new entry
must never weaken or bypass an existing source/artifact check.

No production/runtime module may change from commit
`74a62eb22583216e8c6651de069209d7e1a8ca67`. No benchmark workload, operation
mix, receipt/correctness query, comparator, evaluator, threshold, dependency,
lockfile, workflow, TypeScript setting, checker, or unrelated test may change.
After tooling implementation, a blob manifest must prove every production and
runtime path is byte-identical to that commit and must identify only the
approved plan, eight performance-tooling/test paths including the extracted
artifact owner, and code-style exception registry change. The registry diff
must contain only the two exact benchmark entries above. For the historical PR
A tooling boundary, the global comparator and child evaluator remained
byte-identical at SHA-256
`00f40ac8450f0077b6978a1f8c27a8352586a92ca7b6754845156f02065d3150` and
`5a317fc492a8cfd94770baee74fcda8fb0072b5ccf5928cb66b5899899e3e418`,
respectively.

For prospective PR B measurement only, the human-approved comparison base is
commit `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`, tree
`31671a750ec84577a9b94898c61cc49ec0c91c00`. That base already contains the
schema-v5 production-vs-production toolchain introduced by ancestor
`8a42574d2347b4dc883a362d9d3015b293016c5d`: global comparator SHA-256
`3d83f1acedb9bcb84de2a00094c7f4d3606d2e5c2eb58da725ddfa7e1a8fbf4c` and
child evaluator SHA-256
`d1271a152615cbdbcf973a28223b0acc131827a2027f06fb62d3d7ee0b63948a`.
PR B must keep both tool files byte-identical to that base.

The schema-v5 global protocol validates both comparison roles symmetrically as
`rallar.api-v1.state-write.v5` artifacts against the production durable
contract. It has no retired presence-split feature declaration, no legacy
baseline or DBW-linked durable-evidence leniency, and no strict shared
throughput-improvement requirement. Equal throughput is valid; the global
comparator's shared and hot throughput tolerance is 5%. The unchanged child
evaluator remains the governing topology structure-equivalence policy: its
shared and hot throughput bands stay 1.5% and 10%, respectively, its resource
band stays 1.5% with only the exact precommitted conflict-depth evidence path,
and all existing correctness, latency, zero-baseline, unknown-finding, and
fail-closed behavior remains in force. The fixed two-block order, conflict
reasons, environment controls, thresholds, and no-reroll rules below are not
changed by this toolchain reconciliation.

### 13.4 Prospective conflict-reason evidence

The harness currently emits `regressionReasons: []`, which means valid measured
conflict counters alone cannot satisfy the existing evaluator. The amended
protocol fixes that evidence link before measurement rather than adding prose
after a result is known.

After the new exact candidate freezes and before the first position preflight,
create one ignored JSON input at a fresh relative path under `tmp/perf/` with
this exact schema:

```ts
interface GroupTopologyConflictReasonInput {
  readonly schemaVersion: 'rallar.group-topology.state-write-conflict-reasons.v1';
  readonly baseCommit: string;
  readonly candidateCommit: string;
  readonly candidateTree: string;
  readonly reasons: readonly {
    readonly workload: 'uncontended' | 'shared' | 'hot';
    readonly metric:
      | 'sql.statements'
      | 'sql.rowsRead'
      | 'sql.serializedResultBytes'
      | 'postgres.transactionDurationMs';
    readonly reason: string;
  }[];
}
```

The array contains exactly the twelve workload/metric combinations in workload
order `uncontended`, `shared`, `hot` and metric order shown above. Every entry
uses exactly this reason:

> Precommitted conflict hypothesis: accept this resource movement only when
> measured candidate attempts and RuntimeStateWriteConflictError depth increase
> and the unchanged evaluator proves normalized cost is no worse.

The input must bind the exact base commit, candidate commit, and candidate tree;
contain no extra field, duplicate, or unsupported metric; and pass the global
artifact validator's substantive-reason rules. The CLI path must be relative
and contain no traversal. Its exact bytes and SHA-256 are frozen in the
external PR evidence before the first preflight.
All four candidate positions consume that same file and must emit exactly those
twelve reasons. All four base positions omit the flag and must emit an empty
reason array. The outer pooler verifies these rules against every raw artifact.

This file does not grant a resource exception by itself. The unchanged child
evaluator still requires higher measured conflict and attempt depth plus no
worse normalized per-attempt cost for the exact workload and metric. Shared
throughput never has a conflict-depth exception.

### 13.5 Freeze before a prospective measurement

The prior PR A comparison base `20020977507c3104949da07d27b95e89d3b91c96`,
production candidate `74a62eb22583216e8c6651de069209d7e1a8ca67`, and
the original comparator/evaluator hashes recorded in Section 13.3 remain
historical PR A evidence. They are not prospective PR B inputs.

Before any new PR B position, record and independently review:

- the exact human-approved comparison base
  `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4` and tree
  `31671a750ec84577a9b94898c61cc49ec0c91c00`;
- the exact new PR B candidate commit/tree and proof that its production/runtime
  diff from that base is exactly the reviewed Task 3 persistence movement;
- all correctness and security commands and their final-tree results;
- the exact eight approved tooling/test files and their blobs;
- the pinned PostgreSQL 16 image and resource/configuration limits;
- autovacuum/analyze, preflight-row, automatic-maintenance, overlap, Deno-LSP,
  warmup, run, concurrency, transfer, and controlled-host rules;
- the unchanged schema-v5 global-comparator SHA-256
  `3d83f1acedb9bcb84de2a00094c7f4d3606d2e5c2eb58da725ddfa7e1a8fbf4c`
  and child-evaluator SHA-256
  `d1271a152615cbdbcf973a28223b0acc131827a2027f06fb62d3d7ee0b63948a`,
  plus proof that both files equal the exact comparison-base blobs;
- the schema-v5 production-vs-production protocol stated in Section 13.3,
  including symmetric durable-contract validation, the global 5% throughput
  tolerance, and the unchanged child-specific thresholds and fail-closed
  rules;
- the exact extended v1-pooler hash plus regression evidence that its existing
  public entry is behavior-identical;
- the new outer-pooler/CLI hashes;
- the exact conflict-reason input bytes and SHA-256;
- all latency, throughput, resource, and correctness thresholds;
- fresh position, artifact, environment, output, manifest, and log names;
- zero-baseline, unknown-finding, malformed/incompatible-evidence behavior;
- no-reroll and pre-measurement failure classification; and
- stop behavior for every position, pooling step, comparator, and evaluator.

Human authorization must bind that exact envelope before A1. No candidate,
tool, reason input, threshold, environment rule, comparison rule, or failure
rule may change afterward.

### 13.6 Position-balanced governed sequence

Run exactly one non-rerolled eight-position sequence:

1. A1 — exact base;
2. B1 — exact candidate;
3. B2 — the same candidate;
4. A2 — the same base;
5. B3 — the same candidate;
6. A3 — the same base;
7. A4 — the same base; and
8. B4 — the same candidate.

The fixed order is `A-B-B-A-B-A-A-B`: one ordinary A-B-B-A block followed by
its mirrored B-A-A-B block. Each side occupies four positions with the same
mean chronological position, `4.5`. The four adjacent comparison pairs are
A1/B1, A2/B2, A3/B3, and A4/B4; two run base-first and two candidate-first.
The order is fixed here and is neither randomized nor selected after observing
a sample.

Each position uses a fresh, non-overlapping PostgreSQL 16 environment with the
same pinned image, configuration, resource limits, autovacuum/analyze disabled,
zero preflight rows, zero automatic maintenance, and no overlapping benchmark,
container, editor language server, or Deno process. Every position uses
`warmup=1`, `runs=9`, and `concurrency=10`. Each position is consumed at most
once. All eight normalized environment records must be byte-identical.

### 13.7 Two-block pooling and evaluation

The outer pooler validates the eight chronological positions, then creates two
ordinary v1 evidence blocks through the two v1 pooler entry points:

- block 1 calls the existing `poolApiV1StateWriteResults` entry with A1, B1,
  B2, A2 in its unchanged A-B-B-A descriptor order; and
- block 2 calls `poolApiV1StateWriteResultsForPositions` with the sources keyed
  `candidateThird=B3`, `approvedBaseThird=A3`, `approvedBaseFourth=A4`, and
  `candidateFourth=B4`, plus these descriptors in actual chronological order:

```ts
[
  { key: 'candidateThird', position: 1, role: 'candidate' },
  { key: 'approvedBaseThird', position: 2, role: 'approved-base' },
  { key: 'approvedBaseFourth', position: 3, role: 'approved-base' },
  { key: 'candidateFourth', position: 4, role: 'candidate' },
];
```

The explicit-position entry validates timestamps in the actual B-A-A-B order
and then pools the two sources for each declared role with the unchanged v1
numerical aggregation. Its inner manifest therefore records local positions
1-4 as B-A-A-B while its pooled artifacts retain the exact
`approved-base`/`candidate` aggregation roles required by the unchanged child
evaluator. The outer manifest maps those local positions to global
chronological positions 5-8. Neither pooler entry may rewrite artifact
timestamps, reorder samples within a raw artifact, or infer a role from call
order.

The outer manifest uses schema
`rallar.group-topology.state-write-position-balanced-abba-baab.v1` and records:

- all eight chronological positions, roles, source commit/tree identities,
  artifact SHA-256 values, environment-record SHA-256 values, and relative
  paths;
- the exact entry point, descriptor, and local-to-global chronological mapping
  used for both v1 pooler calls;
- eight unique raw-artifact hashes and one common environment-record hash;
- the two inner v1 manifest hashes;
- each block's pooled base and candidate hashes; and
- the outer pooler, v1 pooler, global comparator, child evaluator, and
  conflict-reason input hashes.

Each inner block contains exactly 18 samples per workload per side. No 36-sample
combined comparison is permitted because it could hide disagreement between
the ordinary and mirrored orders. Preserve every raw artifact, environment
record, inner and outer manifest, pooled output, transfer log, comparator log,
evaluator log, and SHA-256.

For block 1 and then block 2, run the unchanged global comparator and retain its
exact exit/output, followed by the unchanged 1.5% child evaluator against the
matching inner manifest and expected manifest hash. Both child evaluations
must pass. One passing block can never supersede or average away the other.

The historical global-comparator sentence about presence being split from the
group aggregate is recognized only as the existing finding that the unchanged
child evaluator already governs. It is not a topology requirement. Any new or
unknown global finding fails closed.

### 13.8 Unchanged acceptance thresholds

Each block independently applies the existing thresholds:

- uncontended p95/p99 adverse latency at most 5%;
- shared throughput adverse movement at most 1.5%;
- hot throughput adverse movement at most 10%;
- SQL statements, rows read, serialized bytes, and transaction duration
  adverse movement at most 1.5%, unless the unchanged evaluator accepts the
  exact precommitted artifact-backed measured conflict-depth evidence;
- improvements unrestricted;
- fail-closed zero baselines; and
- zero tolerance for commands, receipts, effects, retries, exhaustion,
  atomicity, idempotency, ordering, audience, required/final outbox, schema,
  environment, and artifact correctness.

No threshold, tolerance, comparator rule, or evaluator rule changes. The
approved amendment and this correction change only prospective position
control, explicit chronological descriptor ownership, and the timing of the
already-required conflict-reason link.

### 13.9 Failure and no-reroll rules

Unknown findings, changed hashes, missing samples, incompatible environments,
unsupported metrics, malformed artifacts, missing conflict evidence, a block
disagreement, or any correctness failure fails the complete sequence. No raw
sample or position may be deleted, winsorized, reordered, replaced, or rerun.

A guard failure before any warmup, measured sample, artifact, or environment
record is non-consuming rejected evidence but still requires separate explicit
human replacement authority. Any failure after a position is consumed stops
the sequence permanently. A post-measurement pooling or evaluation tooling
failure preserves all immutable raw evidence and may be corrected or reinvoked
only with separate narrow human authorization; measurements are never rerun.

If either child evaluation fails, PR B remains blocked with the exact evidence,
and PR C remains unstarted. Do not optimize speculatively, change a threshold,
run a third block, or start PR C. If both pass, later separately authorized
publication may push only the exact measured PR B candidate through PR B's
eventual pull request without predicting its number, require Branch Release
Gate for that exact SHA, mark it ready, and stop for the human merge decision.

## 14. Validation Matrix

### 14.1 Planning PR

```bash
npx prettier --check \
  plans/rallar-group-topology-server-structure-plan.md
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

### 14.2.1 Prospective PR A performance-tooling gates

After exact gate-disposition and target-path-correction approval and before a
new candidate freezes, run:

```bash
npx vitest run \
  packages/tests/shared-server/state-write-performance-harness.test.ts \
  packages/tests/shared-server/state-write-performance-topology-reasons.test.ts \
  packages/tests/shared-server/state-write-performance-pooling.test.ts \
  packages/tests/shared-server/group-state-server-structure-performance-policy.test.ts \
  packages/tests/shared-server/group-topology-state-write-position-balanced-pooling.test.ts
node --check \
  scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs \
  scripts/perf/write-group-topology-state-write-position-balanced-results.mjs \
  scripts/perf/pool-api-v1-state-write-results.mjs \
  scripts/perf/compare-api-v1-state-write-results.mjs \
  scripts/perf/compare-group-state-server-structure-performance.mjs
deno check --config apps/api-v1/deno.json \
  scripts/perf/api-v1-state-write-concurrency-bench.ts \
  scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts
npx vitest run \
  packages/tests/repo/repo-code-style-authority-integrity.test.ts
npm run check:repo-style
npm run check:repo-style:construction-details
npm run check:repo-style:layout
npm run check:repo-style:layout-details
npm run check:repo-style:output-contracts
npm run check:repo-style:object-interfaces
node scripts/check-changed-repo-style.mjs \
  108933a97c7a40ee0831ecd185725aea243122bd
test "$(wc -l < scripts/perf/api-v1-state-write-concurrency-bench.ts | tr -d ' ')" -le 1763
npx prettier --check \
  scripts/perf/state-write/api-v1-state-write-benchmark-artifact.ts \
  scripts/perf/pool-api-v1-state-write-results.mjs \
  scripts/perf/pool-group-topology-state-write-position-balanced-results.mjs \
  scripts/perf/write-group-topology-state-write-position-balanced-results.mjs \
  packages/tests/shared-server/state-write-performance-harness.test.ts \
  packages/tests/shared-server/state-write-performance-topology-reasons.test.ts \
  packages/tests/shared-server/state-write-performance-pooling.test.ts \
  packages/tests/shared-server/group-topology-state-write-position-balanced-pooling.test.ts \
  plans/rallar-group-topology-server-structure-plan.md \
  docs/repo-code-style-exceptions.md
git diff --check
npm run test:unit
npm run test:ci
npm run build
```

Do not run whole-file Prettier on
`scripts/perf/api-v1-state-write-concurrency-bench.ts` during this tooling wave.
That is the sole formatting exemption. The explicit line-count ratchet,
exact-base changed-style comparison, all warning-only modes, exception-registry
integrity test, diff check, independent review, and all other formatting gates
remain mandatory and fail closed.

Rerun every Section 14.2 semantic, type, compatibility, black-box, and
repository gate invalidated by the final tooling diff. The exact-base changed-
style comparison uses the PR A implementation base. Any content change after a
successful gate invalidates that evidence.

### 14.3 PR B persistence and concurrency gates

```bash
npx vitest run \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-keys.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-read-write.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-corruption.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-scope-isolation.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-mutation-record-corruption.test.ts \
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
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-scope-isolation.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-mutation-record-corruption.test.ts \
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
  packages/tests/shared-server/integration/postgres/topology-app-outbox-concurrency.test.ts \
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
  packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-scope-isolation.test.ts \
  packages/tests/shared-server/topology/config/persistence/group-topology-config-mutation-record-corruption.test.ts \
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

1. the completed approval of original plan blob
   `c9b5e92686ebbc5d4ff136dbea678c93fea1579f`;
2. the completed approval of Task 1's sample waiver and every warning
   disposition;
3. the completed approval of performance-protocol amendment blob
   `f83cc311369fff2bf255116253ec0f4fe911a43f`;
4. the completed approval of pooler-order correction blob
   `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc`;
5. the completed approval of gate-disposition amendment blob
   `b6fd5aebfa77ee489e65fa30fbee165e033c14f9`;
6. the completed approval of artifact-owner target-path correction blob
   `cf4d92db310c928b2e020f926efa4f731a2fd3b6`;
7. after tooling implementation, authorize the exact new candidate, tools,
   conflict-reason input, environment, and measurement envelope;
8. approve merging exact PR A only after both position blocks pass;
9. approve merging exact PR B after governed persistence performance evidence;
10. approve merging exact PR C after governed authoritative-shell evidence;
11. approve PR D's compatibility/ratchet decisions and exact merge;
12. separately authorize the later evidence-ledger publication; and
13. approve and close that ledger before RTC/RTT or another Wave 2 child begins.

Implementation PRs remain draft until scoped review, Critical 0/Important 0,
all required local gates, exact tree freeze, current PR evidence, and Branch
Release Gate success for the exact final SHA. No agent merges a PR or operates
on the default branch. After each human merge, verify the exact resulting-main
SHA and required default workflow before creating the next branch.

## 16. Non-Circular Completion Evidence

This implementation tree records only existing prerequisite, original-plan,
approved performance amendment, approved pooler correction, approved
gate-disposition amendment, approved target-path correction,
implementation-candidate, failed-performance, diagnosis, corrected-tooling
review, and current-main facts. It cannot contain its own future implementation
commit/tree, publication result, measurement, Branch Release Gate, merge,
default-workflow, or ledger evidence.

Planning PR #125 with approved amendment blob
`f83cc311369fff2bf255116253ec0f4fe911a43f` and planning PR #127 with approved
correction blob `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc` are existing evidence. The
gate-disposition amendment blob
`b6fd5aebfa77ee489e65fa30fbee165e033c14f9`, planning PR #129 feature
`05c75cf2ad52589901e6983a687d28aa5b910582`, frozen/resulting tree
`e3b309e9b913395e28645f1355400d380697c658`, and resulting main
`c7d6d4ec017edb23de239bba18c6d79f2ebb5dac` are also existing evidence. PR A
may also record correction blob
`cf4d92db310c928b2e020f926efa4f731a2fd3b6`, planning PR #131 feature
`42eb663177d731f3759fc2a2664db2ad3297f149`, frozen/resulting tree
`3560eaa0677f219e109f3cad86b169145658cb7e`, and resulting main
`5e892aaff06cce0d994fbf79cfbcc12b235c7e48` as existing evidence. PR A may
record only facts already produced by the authorized tooling phase. It may
never predict a future passing measurement or Branch Release Gate.

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
- [x] The first governed A-B-B-A result remains preserved and classified as
      failed evidence.
- [x] Human approved performance-protocol amendment Git blob
      `f83cc311369fff2bf255116253ec0f4fe911a43f`.
- [x] Human approved pooler-order correction Git blob
      `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc`.
- [x] Corrected prospective tooling review reported Critical 0 and Important 0.
- [x] Human approved gate-disposition amendment Git blob
      `b6fd5aebfa77ee489e65fa30fbee165e033c14f9`.
- [x] Human approved artifact-owner target-path correction Git blob
      `cf4d92db310c928b2e020f926efa4f731a2fd3b6`.
- [x] Benchmark artifact and Git-identity ownership is extracted while the
      benchmark returns to at most 1,763 lines and preserves exact output bytes.
- [x] The exception registry contains only the authorized benchmark-file and
      `main` entries, with the separately approved architecture-child removal
      condition.
- [x] The Section 13.3 tooling implementation preserves every production and
      runtime blob from `74a62eb22583216e8c6651de069209d7e1a8ca67`.
- [x] The existing v1 pooler entry retains exact API, behavior, output, error,
      and A-B-B-A compatibility evidence.
- [x] The explicit-position entry proves chronological B-A-A-B validation and
      true-role pooling without changing numerical aggregation.
- [x] Balanced block 1 and the seven successful positions are human-accepted
      exact-candidate evidence; B4 remains failed historical evidence and is
      excluded without rerun, outlier removal, threshold change, or rewrite.
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

| Risk                                                                                                                                                                 | Required response                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Split creates generic services or forwarding-only helpers                                                                                                            | Repartition around protocol, decision, persistence, transaction, query, or planning authority.           |
| Required handler dependency remains temporally optional                                                                                                              | Resolve before registration while preserving public setter behavior, or stop for architecture approval.  |
| Config absorbs RTC algorithms, RTT, publication, or WS delivery                                                                                                      | Restore the downstream boundary; stop if the owner cannot stay separate.                                 |
| Public/deep path needs a second compatibility hop                                                                                                                    | Keep one direct old-to-canonical export and return the exact consumer for review.                        |
| Persisted field/key/expiry/migration changes                                                                                                                         | Stop for explicit persisted-contract approval.                                                           |
| Authority, AppInbox, transaction, retry, receipt, or outbox changes                                                                                                  | Stop for explicit security/behavior approval.                                                            |
| API-v1/OpenAPI organization or behavior changes                                                                                                                      | Revert to import-only compatibility or stop for a separate child.                                        |
| Warning is ignored because checker exits zero                                                                                                                        | Stop until human disposition exists.                                                                     |
| Ratchet replaces semantic behavior evidence                                                                                                                          | Restore semantic coverage and keep the ratchet supplementary.                                            |
| Historical v1 failure is treated as accepted, replaced, or discarded                                                                                                 | Restore it as immutable failed evidence; this amendment is prospective only.                             |
| Existing comparator, child evaluator, or v1 public-entry behavior changes                                                                                            | Revert; only the additive outer pooler, explicit-position entry, and reason-file ingress are authorized. |
| Artifact extraction changes schema, property order, values, errors, timing, workload, or output bytes                                                                | Revert; the new owner is a behavior-neutral responsibility extraction only.                              |
| Benchmark remains above 1,763 lines or exact-base `file.length` worsens                                                                                              | Stop; the narrow exception does not authorize file growth.                                               |
| Whole-file Prettier exemption reaches another path or suppresses checker output                                                                                      | Revert; only the inherited benchmark file is exempt during this tooling wave.                            |
| Exception registry omits owner/removal condition or broadens future authority                                                                                        | Stop; the two exact entries authorize no architecture-child implementation.                              |
| Explicit-position entry bypasses v1 checks or changes numerical aggregation                                                                                          | Revert; it must reuse the same validation and role-pooling owners after descriptor validation.           |
| Mirrored artifacts use the legacy wrapper or have timestamps/roles rewritten                                                                                         | Fail closed; use the explicit B-A-A-B descriptors and preserve raw evidence exactly.                     |
| Conflict reasons are created or changed after the first preflight                                                                                                    | Fail the sequence; never edit raw or pooled artifacts to add a reason.                                   |
| One mirrored block is discarded, averaged away, or used as a replacement rerun                                                                                       | Fail the complete sequence and preserve both blocks.                                                     |
| A 36-sample combined result is used to mask block disagreement                                                                                                       | Reject it; both independent 18-sample-per-side v1 blocks must pass.                                      |
| Historical PR A production/runtime content differs from candidate `74a62eb`, or prospective PR B content exceeds the exact reviewed Task 3 diff from base `0b1fa13e` | Stop for a separate code-remediation decision and a new protocol envelope.                               |
| Performance protocol, environment, threshold, or candidate changes after freeze                                                                                      | Stop; no reroll, threshold change, or evidence relabeling.                                               |
| Required external gate persistently fails                                                                                                                            | Stop with exact run/job/step; do not diagnose unrelated providers.                                       |
| Unrelated plan, dependency, lockfile, workflow, checker, or TypeScript changes                                                                                       | Restore exact scope before publication.                                                                  |

## 19. Progress Record

| Milestone                  | State                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth prerequisite          | ledger-published           | PR #93 feature `aeff6435794dd70816789e4794b78e84fdfc89b0`, tree `8bdea4402dad08dbd1892f2bd8c95671d615b8ff`, accepted plan-only build-gate exception, resulting main `c2cb79c020bceee7f67e6fbc364ba96ea0d6a530` with the same tree. Hetzner run `31251480014` attempt 1 failed and is retained only as non-gating plan-only external evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Group-topology child plan  | approved/in execution      | Planning PR #95 and original approved blob `c9b5e92686ebbc5d4ff136dbea678c93fea1579f` remain authoritative. Planning PR #125 merged approved amendment blob `f83cc311369fff2bf255116253ec0f4fe911a43f`. Planning PR #127 merged approved correction blob `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc` as feature `8e36fe1c303f695f0a6ec3d99be30eda12c96b11`, frozen/resulting tree `3d6cdf6abb46866e74895fe49150a4a9a4bde77c`, resulting main `df8346aaf39e8d8730e73a530da3e6f182aa071b`. Planning PR #129 merged approved gate-disposition blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9` as feature `05c75cf2ad52589901e6983a687d28aa5b910582`, frozen/resulting tree `e3b309e9b913395e28645f1355400d380697c658`, resulting main `c7d6d4ec017edb23de239bba18c6d79f2ebb5dac`. Planning PR #131 merged approved target-path correction blob `cf4d92db310c928b2e020f926efa4f731a2fd3b6` as feature `42eb663177d731f3759fc2a2664db2ad3297f149`, frozen/resulting tree `3560eaa0677f219e109f3cad86b169145658cb7e`, resulting main `5e892aaff06cce0d994fbf79cfbcc12b235c7e48`.                                                                                                                                                                                                                                                 |
| PR A protocol/core         | publication reconciliation | Exact candidate `ed7e77cd560a701ec41bc544769c60a715f68744`, tree `161e125131adb87dcd90bba737dfe91cb8d624b7`, preserves production candidate `74a62eb22583216e8c6651de069209d7e1a8ca67` and completed correctness plus Critical 0/Important 0 review. The v1 A-B-B-A failure and B4 isolation-guard failure remain historical evidence. The human accepted balanced block 1 and the seven-successful-position diagnostic for this exact candidate. Draft PR #103 was pushed, but Branch Release Gate run `31334618112`, attempt 1, failed only because the lineage manifest named Task 1 head `8b1ebf542d12c05a5ac226d3d07e543a171a2626` while the workflow resolved merge base `20020977507c3104949da07d27b95e89d3b91c96`; their three predecessor blobs are identical. Concurrent-main and exact-lineage-base reconciliation is in progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| PR B persistence           | implementation validated   | Exact base `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`, tree `31671a750ec84577a9b94898c61cc49ec0c91c00`, contains PR A resulting main `cd69565936d881c960dbe151cfe48917a4a2e1bb` as an ancestor. The uncommitted Task 3 persistence movement completed semantic, ownership, type, unit (740 files passed, 2 skipped; 7,112 tests passed, 3 skipped), full CI, build, warning-only style, changed-style, Prettier, diff, and fresh isolated PostgreSQL 16 gates; the live concurrency gate passed 2 files/3 tests and its owned container was removed. Persistence and concurrency re-reviews are Critical 0/Important 0. The human approved prospective schema-v5 reconciliation to this base with comparator SHA-256 `3d83f1acedb9bcb84de2a00094c7f4d3606d2e5c2eb58da725ddfa7e1a8fbf4c` and child evaluator SHA-256 `d1271a152615cbdbcf973a28223b0acc131827a2027f06fb62d3d7ee0b63948a`; historical PR A evidence remains immutable. Final-review fix round 1 corrected only the prospective terminal subjects: failed evaluation blocks PR B while PR C remains unstarted, and passing evidence permits later separately authorized publication through PR B's eventual unnumbered pull request. Final corrected-tree gates and whole-PR re-review precede staging and commit. No benchmark or publication is authorized. |
| PR C authoritative shell   | blocked                    | Requires PR B merge and exact resulting-main workflow success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| PR D alignment/final trace | blocked                    | Requires PR C merge and exact resulting-main workflow success.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Later topology ledger      | blocked                    | Requires all four implementation publication envelopes and separate authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| RTC/RTT and later domains  | blocked                    | Remain outside this child.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

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
- [x] The failed v1 result remains immutable and is never a v2 input.
- [x] The prospective A-B-B-A-B-A-A-B order balances both role and mean
      chronological position without choosing an order after measurement.
- [x] The existing v1 pooler entry remains the exact ordinary A-B-B-A owner;
      only a pure explicit-position entry is authorized for the mirrored block.
- [x] Corrected prospective tooling has Critical 0/Important 0 code review and
      the explicit inherited benchmark gate disposition is approved at blob
      `b6fd5aebfa77ee489e65fa30fbee165e033c14f9`.
- [x] The proposed artifact extraction names one direct owner without changing
      measurement timing, artifact bytes, or the benchmark's public behavior.
- [x] The artifact owner lives in cohesive `scripts/perf/state-write/` without
      an old-path compatibility hop or worsened direct-directory layout debt.
- [x] The two proposed exceptions are file/symbol specific, preserve checker
      output, forbid growth, and require a separately approved removal child.
- [x] The mirrored entry receives B3/A3/A4/B4 in chronological B-A-A-B order,
      preserves raw timestamps, and pools by declared role.
- [x] Both independent v1 blocks must pass; no combined pool can mask a block.
- [x] Conflict reasons are exact, candidate-only, hash-frozen, and present
      before measurement rather than inserted into retained artifacts.
- [x] Numerical thresholds and existing comparator/evaluator behavior remain
      unchanged.
- [x] Prospective PR B measurement binds exact base `0b1fa13e`, tree
      `31671a75`, and the unchanged schema-v5 comparator/evaluator hashes;
      historical PR A hashes remain historical evidence only.
- [x] Semantic tests remain primary and ratchets supplementary.
- [x] Non-circular planning, implementation, and ledger evidence is preserved.
- [x] No production behavior is authorized without explicit human approval.
