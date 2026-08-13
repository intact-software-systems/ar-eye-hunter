# Rallar Group Topology Server Structure Implementation Plan

> **For agentic workers:** Use `rallar-repo:adaptive-plan-execution` for the
> checkpoint lifecycle, `rallar-repo:publishing-plan-progress` for publication,
> `rallar-repo:rallar-code-writing` for authored code, and
> `rallar-repo:rallar-testing` for affected validation. The adaptive record at
> the end of this plan is canonical; do not execute beyond its current slice.

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
repository style checker with failing changed-file cognitive metrics and
warning-only report modes, and the existing state-write performance harness.

Date: 2026-08-08

Status: Active adaptive child, revalidated against exact current main
`dc44ab029dd415b356833d3b72e0207f79c4bc88`, tree
`6048a6891d819dd1c32647cdf4def27027b360f3`. PRs A, B, and C are integrated,
but the child is not complete. PR B remains the only fully accepted governed
performance record. PR A's exact resulting-main Hetzner workflow failed. PR C
merged with an exact tree match, and its correctness and resulting-main gates
provide substantial evidence, but its Branch Release Gate and exact-SHA human
review record failed and governed performance never began. Those deviations
remain historical rather than being relabeled as success. Section 0.8 preserves
PR B closure, Section 0.9 freezes the PR C integration evidence, and Section
0.10 records the human decision to skip all remaining PR C/PR D performance
measurement. PR D is replaced by one adaptive consolidation slice that first
activates an honest topology capability declaration; the later ledger remains
separate and unstarted. Concurrent RTC benchmark and other sibling work remains
outside this child and is compatibility input, not topology-child evidence.
No further performance envelope or measurement is required or authorized for
this child.
The human approved original planning Git blob
`c9b5e92686ebbc5d4ff136dbea678c93fea1579f`, performance-amendment blob
`f83cc311369fff2bf255116253ec0f4fe911a43f`, and pooler-order correction blob
`ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc`, and gate-disposition amendment
blob `b6fd5aebfa77ee489e65fa30fbee165e033c14f9`, and artifact-owner target-path
correction blob `cf4d92db310c928b2e020f926efa4f731a2fd3b6`. No new measurement is
authorized without the task-specific candidate and environment envelope.

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

### 0.8 Task 3 / PR B merge-closure evidence

PR #151 was manually squash-merged. Its exact approved feature head is
`17f9c237afd9fb006776aaa0335b86e1cb650c88`, with frozen feature tree
`7199b061bf1a6fe3abb9c83c02313f5a676a6a5b`. The measured comparison base is
`cc98414867f22cc28f0137ef40a1887ab862f87d`, tree
`6c071954df939b7dea9ba59aa5116fe7922a6cab`. The approved measurement envelope
SHA-256 is
`27a9c8e8acdcaa8f1d737ced31a46708a973c0f92e586526b3c7369467f12ae6`.
The accepted one-candidate performance disposition remains exact, including
the honestly retained block-2 child-evaluator failure; it is not extended to
PR C or unrelated current-main changes.

The squash-merge commit is `1e5f5e55e6ff94c016bfe2cc11af92952a30e32f`,
tree `324b2108c3a6754c2e9d85a4e00c5b8b936a67ea`, with parent
`f43c1881e684fd2a423b0993c4389d969c264311`. The exact squash-integration audit
proved that every measured PR-B persistence, lineage, compatibility, and
prospective-tooling behavior was integrated unchanged; differences from the
frozen feature tree were attributed to the advanced main parent or squash
integration without lost PR-B behavior.

Branch Release Gate run `31431692263`, attempt 1, concluded `success` on exact
feature head `17f9c237afd9fb006776aaa0335b86e1cb650c88`. API v1 Topology Replay Gate
run `31431791238`, attempt 1, and API v1 Medium-Scale Gate run `31431791252`,
attempt 1, succeeded on that head. CodeQL workflow run `31431790976` completed
both analysis jobs successfully. Separate CodeQL check `93596864919` failed as
an application finding and remains tracked in issue #153; it was not a failed
required feature-branch workflow gate. Run Hetzner Supported Distributed
Manifests run `31432113008`, attempt 1, concluded `success` on exact resulting
main `1e5f5e55e6ff94c016bfe2cc11af92952a30e32f`. The merge-closure comment is
<https://github.com/intact-software-systems/ar-eye-hunter/pull/151#issuecomment-5246277664>.

### 0.9 Task 4 / PR C integration and current-main reconciliation

PR #155 was manually integrated from exact final feature head
`8ec6b8150850d1b7a653d7e6552cb81528e5090a`, tree
`a272104e0c7638165867e8431cec9afa21870c30`, against exact final comparison
base `39ad65b499c4bf944acfe48446ad1c334d97d37d`, tree
`f11d95321e7bbd241d816f303f888945352160d7`. The resulting-main commit is
`bbcec6b9413678d85d0c97f63b18bb4216b5d767`, tree
`a272104e0c7638165867e8431cec9afa21870c30`, with parent
`e03c703bd9a59194e495a05894a2f516db5cffbe`. The identical feature and merge
trees prove that the reviewed PR C source content was integrated without a
squash or merge-tree rewrite. The remote feature branch was deleted after
merge; its absence is expected historical state, not authorization to recreate
or rewrite it.

API v1 Medium-Scale Gate run `31576056918`, attempt 1, and API v1 Topology
Replay Gate run `31576056919`, attempt 1, succeeded on the final feature head.
The retained memory gate passed 13 recipes and 853 steps, and the four
PostgreSQL topology concurrency modules passed six tests under the canonical
repository-root invocation. Run Hetzner Supported Distributed Manifests run
`31580601865`, attempt 1, succeeded on exact resulting main
`bbcec6b9413678d85d0c97f63b18bb4216b5d767`. These are positive correctness
and integration facts; they do not supersede a failed required feature gate.

Branch Release Gate run `31576055172`, attempt 1, failed on the final feature
head with two new or worsened findings: the 110-column import at line 10 of
`planning/select-group-topology-planning-snapshot.ts` and the 403-physical-line
`replay/create-rtc-topology-work-handler.ts`. Exact-SHA human-review validation
runs `31576055103` and `31580589561`, attempt 1, both failed because PR #155
did not contain exactly one valid `PR Human Review Record v1` metadata fence.
PR #155 has no GitHub review approval. These are retained publication failures,
not provider noise and not passing evidence.

No PR C warmup, measured sample, pooling, comparison, or child evaluation
began. Envelope
`tmp/perf/pr-c-984c66e20e48-performance-v1/performance-envelope.json`,
SHA-256 `6e2d2378e413d6ef184475b96d22203f243d37d600bdc3a1349280bf29278376`,
and envelope
`tmp/perf/pr-c-bc0cd5d7967b-performance-v1/performance-envelope.json`, 47,319
bytes, SHA-256
`7930f763a9b1e18c8a2c07769e7d0e9a6e1351bf7c92a5820d05f05183dd6c1c`,
with conflict-reason input 4,077 bytes, SHA-256
`97bbfba96b2478a823b306649c369ef0f9925a747de249e04875200ec26dc8ba`,
are superseded historical preparation. The recorded A1 guard rejection was
non-consuming because no warmup or measurement began. None of these files or
hashes may be reused, edited, or relabeled for the final feature or merge tree.

Freshly fetched current main is
`dc44ab029dd415b356833d3b72e0207f79c4bc88`, tree
`6048a6891d819dd1c32647cdf4def27027b360f3`. From PR C resulting main through
current main, no topology production owner or topology semantic test changed.
PR #198 moved the shared RTC benchmark ownership and regression-reason control,
PR #197 introduced adaptive execution governance, PR #199 refreshed RTC
benchmark Deno locks, and PR #201 corrected the prospective PR C pooler/oracle
base binding. PRs #204-#206 then added authenticated adaptive-plan closure
receipts and preserved repository navigation through last-plan closeout. Those
changes remain sibling compatibility and publication input; none is
topology-child progress. The adaptive slice below retains the architecture and
behavior plan while applying the stricter current governance.

### 0.10 Adaptive replan and performance disposition

On 2026-08-13 the human explicitly authorized this child to skip the remaining
performance test and replan under the adaptive planning tools now on main. This
is a prospective workflow disposition, not a performance pass:

- no PR C position was consumed, so there is no benchmark result to accept;
- every rejected or superseded PR C envelope and preflight remains immutable
  historical evidence and must not be reused or relabeled;
- the failed PR C Branch Release Gate and exact-SHA review runs remain failed
  historical publication evidence;
- the successful PR C correctness and resulting-main evidence remains valid;
- Sections 13.3 through 13.9 remain a historical description of the retired
  protocol only and must not be executed for PR C or PR D; and
- the skip is local to this child and does not weaken repository performance or
  publication policy for other work.

The adaptive migration closes the completed
`adaptive-agent-execution-governance` record through the PR #206 final review
and the canonical authenticated receipt
`plans/adaptive-agent-execution-governance.closure.json`, then makes this plan
the sole active adaptive plan. The current checkpoint chooses `consolidate`
because the implemented topology owner lives at
`packages/shared-server/rallar-system/topology` while its tests still live at
the pre-governance path `packages/tests/shared-server/topology` and no exact
focused capability command exists. The single current slice activates the
topology capability by aligning that mirror, command, navigation, and the two
retained PR C style findings without changing behavior. A new checkpoint is
required before any final child-close or ledger slice.

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
    group-topology-planning-authority.ts
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
the exact concurrent-main merge parent
`cc98414867f22cc28f0137ef40a1887ab862f87d`, byte-identical predecessor blobs,
and genuine canonical primary targets for the two deleted private persistence
and maintenance owners whose movement is not represented by Git-native rename
detection. Git-native rename lineage owns the other three one-to-one moves:
exact read, stored-source decoding, and mutation read. Together, the two
structural-manifest rows and three detected renames cover all five deleted
private persistence/read/maintenance owners.
The behavior-named PR B test-ownership inventory independently maps every
frozen repository and exact-read case to one target case; four new semantic
cases are tracked outside that moved inventory.

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
| planning authority, topology computation, observation, local compatibility planning                                     | `planning/group-topology-planning-authority.ts` and `planning/group-topology-planning-service.ts`                                                                                                                                       | C                 |
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
- [x] Require scoped independent review, full PR A gates, exact commit/tree,
      Branch Release Gate, and human merge.
- [ ] Close the failed exact resulting-main Hetzner workflow through explicit
      human disposition without relabeling it as success.

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
Sections 0.4 and 13.2. Later approved tooling and the accepted non-rerolled
disposition produced final PR #103 feature head
`d86524adc051ab0b64cae160eb3a847f75d59d7a`, tree
`fd8069eddc01f6a4784bc9a7a06b3e808f3aed5d`. Branch Release Gate run
`31337007511` succeeded. Human merge
`cd69565936d881c960dbe151cfe48917a4a2e1bb` has the same tree, but exact
resulting-main Hetzner run `31358158337` failed and has no successful exact-SHA
rerun. Task 2 is integrated with that closure deviation still open.

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
- [x] Reconcile the exact concurrent-main merge and lineage base, require Branch
      Release Gate success for the resulting exact head, and mark PR #103 ready.
- [ ] Obtain explicit human disposition of exact resulting-main Hetzner run
      `31358158337`, attempt 1, which failed in the RTC stability recipe.

### Task 3: PR B — persistence, exact reads, generations, and migration

PR B applies the Section 1.5 private refinement by separating source/page and
legacy-source lookup into
`config/persistence/group-topology-config-source-repository.ts`. It also
separates scope-isolation and mutation-record-corruption tests from the general
corruption owner and shares only deterministic fixture construction through
`group-topology-config-persistence-test-fixtures.ts`. These refinements keep
each owner behavior-named and below 400 lines without adding a public
compatibility path.

- [x] Split repository contracts, namespaces, keys, codecs, CRUD/CAS, exact
      reads, stored-source decoding, backfill, and legacy migration.
- [x] Preserve every namespace, key, value, revision, ordering, corruption,
      expiry, page, migration, and retry rule byte-for-byte.
- [x] Make persistence depend on mutation contracts/validators, never on the
      application service, inbox, public facade, RTC worker, or compatibility
      wrapper.
- [x] Split the 1,637-line repository test into behavior-named semantic owners.
- [x] Add exact key injectivity, complete-scope isolation, malformed row,
      equal-revision/different-content, batch/fallback, generation/invariant
      race, migration, and conditional-delete tests.
- [x] Redirect every exact Section 8 persistence consumer and remove the old
      private repository/read/decoder paths after their active scans are empty.
- [x] Require scoped persistence review, PostgreSQL concurrency review, all PR
      B gates, exact commit/tree, Branch Release Gate, human merge, and exact
      resulting-main workflow.

PR B crosses the persistence and concurrency domain and must run the fixed
governed performance protocol in Section 13 after the exact candidate freezes.

### Task 4: PR C — authoritative shell, query, reconfigure, and composition

PR C applies one private refinement by extracting deterministic snapshot
selection into
`planning/select-group-topology-planning-snapshot.ts`. The planning service
still owns planning authority and lifecycle; the helper owns only the pure
persisted/local/previous snapshot precedence decision. This keeps the planning
owner below the hard file/function limits without changing RTC algorithms,
publication, or adding a compatibility path.

- [x] Introduce the config query and config mutation services as cohesive
      stateful owners.
- [x] Construct one `GroupTopologyConfigGenerationReadiness` instance and pass
      it explicitly to both query and mutation services; preserve memoization,
      per-group keying, promise identity, failure eviction, and backfill order.
- [x] Move reconfigure read/compute/validate/write into the named mutation
      owner.
- [x] Move planning-authority and local compatibility planning into the named
      planning service without changing RTC algorithms or publication.
- [x] Make `TopologyAppInboxHandler` depend on exact config-mutation and
      reconfigure capabilities rather than the broad public facade.
- [x] Preserve `AppGroupInboxService` constructor/setter signatures, setter
      identity/idempotence/errors, handler registration order, and runtime
      readiness while ensuring mandatory handler dependencies are resolved
      before each registration.
- [x] Preserve public `GroupTopologyManagementService` as the direct
      compatibility facade and keep canonical callers out of old wrappers.
- [x] Add direct handler operation-matrix, registration/invocation,
      retry-reentry, durable-failure, collision rollback, 20-attempt
      exhaustion, query, reconfigure, and post-commit wake tests.
- [x] Run the complete config, AppInbox, API, RTC handoff, memory black-box,
      PostgreSQL concurrency/medium-scale, and topology-replay correctness
      gates recorded in Section 0.9.
- [x] Preserve the fact that no governed PR C position was consumed and apply
      the 2026-08-13 human disposition to skip the remaining performance test;
      do not claim a performance pass.
- [x] Preserve the exact feature/merge tree identity, human merge, and
      successful exact resulting-main workflow.
- [x] Retain the failed Branch Release Gate and exact-SHA review evidence as
      historical publication deviations; neither failure is relabeled as
      success or used as current PR D evidence.

PR C crossed the mutation and concurrency domain, but its prospective
post-merge performance protocol is retired by the explicit Section 0.10 human
disposition. The missing measurement remains a declared closure deviation. It
does not retroactively make the failed feature gate or missing review record
successful and does not weaken another child's performance requirements.

The first PR C milestone is commit
`db629f5ba7be38d3848c376a47b546e3cd02b1ff`, tree
`ad8a9748d0a7834d66d7ca50f4b9948bff36c3ed`, published in draft PR #155. Its
first full API-v1 PGlite run exposed a direct-core capture that bypassed the
public facade's per-attempt virtual method dispatch: the stale-read count was
zero and lifecycle revalidation did not re-enter. A registration-level test
reproduced that exact bypass before the boundary-only correction. The handler
still receives narrow capabilities, while the captured adapter now invokes the
preserved facade methods on each attempt. The two exact failed API cases then
passed, followed by the complete 84-test API-v1 matrix.

The retry-dispatch correction is commit
`589a80ca9ebc8af5a4df99c6d555774ad22d3515`, tree
`04f148d877eab3bb1977e75c0082f3efd22d4a9c`. The first complete repository
unit run then found one retained direct-handler transaction test still passing
the broad management facade instead of the new explicit mutation-owner bundle;
it failed before reaching its intended APP_OUTBOX collision. The test harness
now supplies the same narrow facade-dispatched capabilities as production,
without changing its rollback or invariant-corruption assertions, and all
three cases in that module pass. The former source-text ownership assertion was
removed by the updated main branch's semantic-test policy and is not restored.

Branch Release Gate run `31442602663`, attempt 1, then failed in the root CI
step after 439.58 seconds because the retained concurrent-identical group
request test exhausted its production-default 10-second completion wait before
the test's manual dequeue. The result was the explicit unavailable left side,
not a topology behavior mismatch. The test now injects a longer deterministic
completion wait through its existing in-memory AppInbox harness; production
defaults and the coalescing assertions remain unchanged. The failed run and its
consequential missing-artifact upload remain historical evidence.

The memory black-box gate passed all 13 recipes with 853 successful steps and
zero failures. The three-server PostgreSQL medium-scale recipe passed with
2,748 successful steps and zero failures. All four PostgreSQL topology
concurrency modules passed six tests. The initial fresh-database invocation
failed before behavior execution because migrations had not been applied; a
second invocation from the API workspace applied all 20 migrations but used
the wrong Vitest workspace for `--node-modules-dir=none`. The canonical
repository-root invocation then passed. The missing fourth test in that run
revealed the approved mirrored-test move was not yet implemented, so the
AppInbox concurrency test moved to its planned canonical path and its two cases
passed there. These setup failures remain retained honestly and are not counted
as behavioral evidence. Governed performance remains unrun by design under
Section 0.10. The final feature and merge trees remain immutable historical
evidence; no replacement envelope is required or authorized.

### Task 5: PR D — alignment and final traceability

- [x] Begin planning from the Section 0.10 performance skip while retaining the
      failed PR C Branch Release and exact-SHA review evidence as historical
      deviations rather than current passing evidence.
- [x] Reconcile the current-main RTC benchmark, black-box assertion, and style
      governance changes; record no material topology impact or the smallest
      exact plan delta before implementation.
- [x] Add the temporary child source/style snapshot test-first with this child
      as owner and the later ledger as its removal/replacement decision point.
- [x] Correct the retained PR C style findings in
      `planning/select-group-topology-planning-snapshot.ts` and
      `replay/create-rtc-topology-work-handler.ts` without changing topology
      behavior or adding a new exception.
- [x] Align only new/materially rewritten topology production, mirrored tests,
      navigation evidence, ratchets, and compatibility wrappers.
- [x] Enforce descriptive filename/primary-symbol alignment, named interfaces
      and inputs, direct callback semantics, imports/file order, 100-column
      guidance, 60-line functions, and 400-line modules.
- [x] Prove canonical imports bypass the retained public compatibility
      surfaces; add no moved-private-path wrapper.
- [x] Preserve all semantic cases/assertions while completing the exact test
      tree.
- [x] Finalize the five family traces and repeat the controlled human sample.
- [x] Record every supplementary ratchet as removed, replaced by semantic
      evidence, or retained with owner/reason/later-ledger decision.
- [x] Give every remaining focused warning row an explicit human disposition.
- [ ] Require independent whole-child review with Critical 0 and Important 0.
- [ ] Run all final gates on one unchanged tree, freeze commit/tree, publish PR
      D, require Branch Release Gate, and stop for human merge.

PR D does not inherit or create PR C performance evidence. Its acceptance is
behavior preservation, direct navigation, semantic coverage, current local
validation, independent review, and current publication gates on one unchanged
tree. No performance protocol is part of this child's remaining horizon.

#### Task 5 capability-activation evidence

Current main advanced during execution from the observed
`20f0bd8ce8a905054feb8d60d61c6a169d149b1b` tree
`50c5c2c16a2ee0264c4bd3263e9ff629a8d524a0` to merge base
`aa124e03775492f9e37882bb9ed02b03dfe0dad6` tree
`7fdefc3d98f875298c95a65d716de88a3741c00a`. The compatibility result is
**Compatible — no plan delta**. The later commit refreshes only this plan's
PR #203 sibling-facts checkpoint, and `aa124e03` removes contaminated
uncommitted TypeScript paths from that older fact refresh. The wider reconciled
current-main changes add RTC benchmark consumers of canonical replay owners,
generic black-box assertions with no topology ownership, and governance that
requires the recognized test mirror, focused command, and navigation contract.
They change no topology behavior, owner, public/persisted contract, integration,
or Task 5 acceptance criterion.

The durable README now records construction/registration and runtime timelines
for all five families: config/override mutation, explicit reconfigure, query,
maintenance/expiry, and downstream RTC publication. Each trace names the
invoker and retry owner, transaction or read phases, confirmed commit and
after-commit effects, normal and inactive exits, retry re-entry, terminal
failure, cleanup, caller-visible result, and canonical versus compatibility
path. The controlled human comparison remains explicitly waived because no
valid Task 1 sample exists. The traces are qualitative evidence only; no
elapsed time, wrong-file count, compatibility-hop count, unresolved-question
count, productivity, causal, or statistical claim is inferred.

The complete current move baseline is 31 tracked predecessor files, 26 test
modules, 85 `it`/`test` callsites, and 356 `expect` callsites. The historical
13/68/281 row remains unchanged historical PR evidence. The focused capability
suite executes all moved modules and preserves every semantic case, assertion,
fixture, opt-in concurrency condition, Deno configuration, worker path, and
process working directory. The recognized Postgres integration configuration
and shared compatibility-consumer inventory now point to the canonical mirror.

##### Focused warning dispositions

On the final aligned production root, default/construction/layout/layout-
details/output-contract/object-interface modes report respectively
43/44/0/0/39/40 warning rows. The union is 49 displayed row instances; the two
identical grouped `topology-app-inbox-command.ts` unknown-summary rows are
counted separately. Every remaining row has this explicit disposition:

| Path                                                              | Rule and rows                                                                          | Disposition                                                                                                                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/maintenance/migrate-legacy-group-topology-config-keys.ts` | `boundary.unknown` × 2                                                                 | Accepted existing boundary evidence: raw legacy JSON is normalized and compared inside the migration owner before typed persistence. No row changed or worsened.                                  |
| `config/mutation/group-topology-config-mutation-contracts.ts`     | `types.rename-alias` × 1                                                               | Accepted existing contract debt. Removing the exported domain-role name is outside this behavior/API-preserving slice; the later ledger owns the decision.                                        |
| `config/mutation/topology-config-mutation-boundary.ts`            | `boundary.unknown` × 6                                                                 | Accepted existing untrusted-boundary evidence. Each raw value is narrowed before domain computation; no row changed or worsened.                                                                  |
| `config/persistence/decode-stored-group-topology-config.ts`       | `boundary.unknown` × 6                                                                 | Accepted existing persistence-decoder evidence. Stored JSON remains untrusted until this owner validates it; no row changed or worsened.                                                          |
| `config/persistence/group-topology-config-persistence-codec.ts`   | `boundary.unknown` × 5; `function.input-contract` × 2; `file.responsibility-count` × 1 | Accepted existing codec debt. Unknowns are owned at parse/decode boundaries; signatures and cohesive persisted-value exports are unchanged. Later ledger decides any API-neutral split.           |
| `config/persistence/group-topology-config-storage-keys.ts`        | `file.responsibility-count` × 1; `abstraction.pass-through` × 3                        | Accepted existing cohesive storage vocabulary. The three apparent pass-throughs deliberately preserve topology slot meaning over shared group-state key encoding; no new hop or export was added. |
| `config/persistence/read-exact-group-topology-config-mutation.ts` | `boundary.unknown` × 7; `function.input-contract` × 1                                  | Accepted existing exact-read boundary debt. Runtime-state values remain untrusted until injected decoders/validators narrow them; changing the existing read port is outside this slice.          |
| `inbox/topology-app-inbox-authority.ts`                           | `boundary.unknown` × 2                                                                 | Accepted existing authenticated-proof boundary evidence. Durable values are decoded and verified before authority use; no row changed or worsened.                                                |
| `inbox/topology-app-inbox-command.ts`                             | `boundary.unknown` × 7; `abstraction.pass-through` × 1                                 | Accepted existing durable-command boundary evidence. `isTopologyRecord` is the named raw-record narrowing boundary used by exact-key validation; no new wrapper was added.                        |
| `rallar-rtc-topology-metrics.ts`                                  | `contract.object-interface` × 1                                                        | Accepted existing untouched RTC metrics contract debt; unrelated type-surface work is deferred to its owner, not absorbed here.                                                                   |
| `replay/rtc-topology-reconnect-hydrator.ts`                       | `file.cognitive-load` × 1                                                              | Accepted existing untouched RTC lifecycle debt at score 80, below the review tier; no magnitude growth occurred.                                                                                  |
| `replay/rtc-topology-replay-service.ts`                           | `file.cognitive-load` × 1                                                              | Accepted existing untouched replay lifecycle debt at score 80, below the review tier; no magnitude growth occurred.                                                                               |
| `replay/rtc-topology-work-codec.ts`                               | `abstraction.pass-through` × 1                                                         | Demonstrated protocol boundary: the named conversion owns the canonical QueueBox context identity and its decode equality check.                                                                  |

The materially changed planning and replay files now contribute zero focused
warning rows. The snapshot test permanently checks the planning file's
100-column bound and temporarily checks the replay file's 400-line bound; the
replay module has 398 physical lines. No compatibility exception or new style
exception was added.

##### Supplementary-ratchet dispositions

| Ratchet                              | Task 5 disposition                                                                                                                                                                                                                     |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused source/style snapshot        | Retained through PR D with this child as owner. The later evidence ledger decides removal only after permanent semantic/size evidence owns every protected loss risk.                                                                  |
| Exact per-PR structural lineage      | Retained unchanged as historical PR A/B/C evidence. This Git-native mirror move and its exact base/blob/path snapshot add no replacement private-path manifest; the later ledger decides removal after resulting-main evidence exists. |
| Test ownership inventory             | Historical 13/68/281 evidence remains exact. Current 31-file/26-module/85-case/356-assertion preservation is bound by the temporary snapshot while behavior-named tests remain primary; the later ledger decides removal.              |
| Consumer compatibility inventory     | Replaced for topology execution by permanent runtime export-identity, direct-import, API-composition, and deleted-private-path tests. The shared repository consumer inventory is updated only to the new worker path.                 |
| README path/primary-symbol integrity | Retained permanently as the durable `repository-navigation-v1` owner and repository-structure governance input.                                                                                                                        |

Issue [#207](https://github.com/intact-software-systems/ar-eye-hunter/issues/207)
remains an existing plan-only follow-up. Its authenticated closure-receipt
policy neither applies to this build-affecting PR nor blocks a Task 5 criterion,
so no policy change is absorbed here.

### Task 6: Publish the later evidence ledger separately

- [ ] Begin only after all four implementation slices have exact closure
      records: required successes where still runnable and explicit human
      dispositions for immutable historical deviations.
- [ ] Modify only the child and reciprocal program planning records.
- [ ] Record planning/PR A/PR B/PR C/PR D evidence already existing at that
      time.
- [ ] Record warning dispositions, human-sample outcome or explicit waiver,
      compatibility owners, ratchet decisions, semantic coverage, and the
      explicit skipped-performance disposition.
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

**Retired prospective protocol:** Section 0.10 supersedes every unexecuted PR C
and PR D measurement instruction below. Sections 13.3 through 13.9 are retained
only so historical envelopes, hashes, thresholds, and no-reroll decisions stay
auditable. They authorize no envelope, preflight, warmup, measurement, pooling,
comparison, evaluation, or rerun. Correctness and concurrency validation remain
mandatory.

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

The completed pre-reconciliation PR B measurement used human-approved base
commit `0b1fa13e07f7a8e4540d389cd5e25dfa95270da4`, tree
`31671a750ec84577a9b94898c61cc49ec0c91c00`. That base already contains the
schema-v5 production-vs-production toolchain introduced by ancestor
`8a42574d2347b4dc883a362d9d3015b293016c5d`: global comparator SHA-256
`3d83f1acedb9bcb84de2a00094c7f4d3606d2e5c2eb58da725ddfa7e1a8fbf4c` and
child evaluator SHA-256
`d1271a152615cbdbcf973a28223b0acc131827a2027f06fb62d3d7ee0b63948a`.
PR B must keep both tool files byte-identical to that base.

That comparison and the governed A-B-B-A-B-A-A-B result apply only to the
pre-reconciliation candidate
`546f70deade1abe4f66b0262e5a9698a830527ea`, tree
`2443467b0023ead540a5a4a1666f916b607deb1f`. Current-main merge parent
`cc98414867f22cc28f0137ef40a1887ab862f87d` changes the state-write benchmark,
its options and focused tests, API composition and middleware, and durable RTC
topology replay/reconnect runtime. The comparator and child evaluator remain
byte-identical, but the changed measured runtime, workload entry point, and
artifact-producing harness make the accepted result historical after the
merge. A reconciled candidate requires a separately frozen and approved
prospective envelope against the exact merge parent; no measurement is
authorized by this factual reconciliation.

For prospective measurement of the reconciled candidate, the human-approved
comparison base is exact current-main merge parent
`cc98414867f22cc28f0137ef40a1887ab862f87d`, tree
`6c071954df939b7dea9ba59aa5116fe7922a6cab`. The schema-v5 comparator and child
evaluator are byte-identical at the hashes above. This prospective-base
correction changes only the outer pooler's precommitted base identity, its
independent semantic oracle, and these factual plan records. It does not alter
pooling arithmetic, position order, artifacts, thresholds, scoring, or the
historical evidence.

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

### 13.5 Freeze before any prospective measurement

The prior PR A comparison base `20020977507c3104949da07d27b95e89d3b91c96`,
production candidate `74a62eb22583216e8c6651de069209d7e1a8ca67`, and
the original comparator/evaluator hashes recorded in Section 13.3 remain
historical PR A evidence. They are not prospective PR B inputs.

The completed PR B freeze recorded and independently reviewed:

- the exact human-approved comparison base
  `cc98414867f22cc28f0137ef40a1887ab862f87d` and tree
  `6c071954df939b7dea9ba59aa5116fe7922a6cab`;
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

Any post-merge PR C closure envelope must instead bind:

- exact approved base `39ad65b499c4bf944acfe48446ad1c334d97d37d`,
  tree `f11d95321e7bbd241d816f303f888945352160d7`;
- exact candidate `8ec6b8150850d1b7a653d7e6552cb81528e5090a`,
  tree `a272104e0c7638165867e8431cec9afa21870c30`, plus proof that resulting-main
  commit `bbcec6b9413678d85d0c97f63b18bb4216b5d767` has the same tree;
- benchmark harness blob `8c10e9454141fe476cad56bd2116cc9bd0a80106`,
  60,027 bytes, SHA-256
  `9bb24eba171403e62aec83e5fc92aeb55a7631ed201f437300cd6146908a7a5d`;
- benchmark option control blob `1dee01b73ad4b36a4e6aea8a9fa214f97c8ee9bb`,
  3,495 bytes, SHA-256
  `9d2bdefabcc37e446e491b8fb4fd6c68c734c0ac5fc882841529dc1390bcafae`;
- regression-reason control blob `43c6c382f821f8da21c473be6d1105176bb7f1c3`,
  2,304 bytes, SHA-256
  `daca2b1437aa65e3491e6cd23cef20ebdb2645dc75ac6d649d244bdcd2588263`;
- position-balanced pooler blob
  `a7e94e2d371b82dbb9ff2171679a4f489e0fbdbf`, 14,651 bytes, SHA-256
  `3692dc93cc4553e931e817dad358725db76ce7bf515e19e48e49c6cfe877618f`;
- position-balanced pooling oracle blob
  `88fdec2424c619198f338a9e14226bdfadfb6ebc`, 16,908 bytes, SHA-256
  `6cc314915b723302a9301e648301211813e6cf7157c3da24dce44b1456bc1189`;
- conflict-reason/base-binding oracle blob
  `93c4d444d81f59cb9ca9af8e3c52c31c40887846`, 5,680 bytes, SHA-256
  `703be8b319811e2260e182821e464498dcbff315ffc45842d5d252916f53ead9`;
- formatted harness test blob `ccfdea7671e4b09340735c4ca68cb1bf16336b23`,
  15,352 bytes, SHA-256
  `1d159e57defd7925cd2da458a5855b1e60a1915f99f75c4ae564364da8de92fb`;
- global comparator blob `227a1a2b30f5cf36747a2a6aae6c1898858e9fd2`,
  52,048 bytes, SHA-256
  `3d83f1acedb9bcb84de2a00094c7f4d3606d2e5c2eb58da725ddfa7e1a8fbf4c`;
- child evaluator blob `220f314fd8b4be602209572971a974fc5b64f856`,
  13,803 bytes, SHA-256
  `d1271a152615cbdbcf973a28223b0acc131827a2027f06fb62d3d7ee0b63948a`;
- proof that the global comparator and child evaluator blobs remain identical
  on current main; that the benchmark harness, option/reason controls, and
  formatted harness test changed only for the PR #198 ownership move without
  changing workload or reason-selection behavior; and that the corrected
  pooler and oracle identities above plus every other supporting control named
  by the envelope are freshly derived;
- a fresh conflict-reason input bound to the exact base, candidate, and tree;
  neither superseded PR C input may be copied or edited; and
- all PostgreSQL 16, environment, resource, position, artifact, environment
  record, log, transfer, hashing, guard, stop, consumption, and no-reroll rules
  from Sections 13.3 through 13.9 without reduction or reinterpretation.

The base versions of the harness, pooler, and formatted harness test have
different formatting blobs. The approved candidate-side control files must be
transferred as external measurement tooling with source and destination bytes
and SHA-256 proven equal; they must not be written into either Git tree. This
keeps the compared production commits immutable while using one exact control
implementation for all eight positions.

Any later PR D candidate starts from its own freshly fetched main base. It may
reuse the accepted PR C result only when all production/runtime and benchmark
blobs in scope remain byte-identical. Otherwise it requires a fresh envelope
that isolates the exact PR D base and candidate and preserves the same fixed
eight-position protocol.

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

The accepted PR B disposition remains immutable historical evidence. The PR C
sequence never began and is now explicitly skipped; no position may be started
or manufactured after this disposition. PR D has no measurement sequence in
this child. Its behavior-neutral claim must instead be proved by semantic,
concurrency, full-suite, review, and current publication evidence. No historical
or skipped performance record may be presented as a pass.

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

Updated main removed the source-coupled group-topology ownership inventories.
Use repository governance plus semantic ownership and behavior tests for PR C;
do not recreate deleted source-shape assertions.

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
7. the completed 2026-08-13 decision to skip PR C/PR D performance while
   retaining the missing result and failed PR C publication evidence honestly;
8. review the adaptive topology capability activation and approve its exact
   merge only after current review and publication gates pass;
9. separately authorize the later evidence-ledger publication; and
10. approve and close that ledger before this child authorizes, resumes, or
    claims RTC/RTT or another Wave 2 child as its successor work.

Implementation PRs remain draft until scoped review, Critical 0/Important 0,
all required local gates, exact tree freeze, current PR evidence, and Branch
Release Gate success for the exact final SHA. No agent merges a PR or operates
on the default branch. After each human merge, verify the exact resulting-main
SHA and required default workflow before creating the next branch.

PRs A and C were merged despite immutable evidence that did not satisfy this
rule. Their human merges and the Section 0.10 continuation decision are
historical facts, not evidence that the failed gates passed. The later ledger
must preserve every failed workflow, missing review record, and skipped
measurement without rewriting any of them as successful.

## 16. Non-Circular Completion Evidence

This plan revision records only existing prerequisite, original-plan, approved
amendment, implementation, merge, workflow, failure, diagnosis, tooling, and
current-main facts. It cannot contain its own future plan commit/tree,
publication result, measurement, review disposition, PR D evidence, ledger
evidence, or future default-workflow result.

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
- [x] The group-topology measurement exemption rows remain the authorized
      benchmark-file and `main` entries, with the separately approved
      architecture-child removal condition.
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
- [x] PR A's final feature gate and exact-tree merge succeeded.
- [ ] PR A's failed exact resulting-main Hetzner workflow has an explicit human
      closure disposition.
- [x] PR B review, governed performance, merge, and resulting-main workflow
      succeeded.
- [x] PR C's exact feature tree was integrated unchanged and its exact
      resulting-main Hetzner workflow succeeded.
- [x] PR C performance is explicitly skipped with no pass claimed; the failed
      Branch Release and exact-SHA review records remain historical deviations.
- [ ] PR D review, gates, merge, and resulting-main workflow succeeded.
- [ ] Separate evidence ledger independently reached `ledger-published`.
- [ ] Concurrent RTC/RTT and other Wave 2 work is reconciled as sibling work
      without being claimed as this child's evidence or broadening PR D.

## 18. Risks And Stop Conditions

| Risk                                                                                                                                                                            | Required response                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Split creates generic services or forwarding-only helpers                                                                                                                       | Repartition around protocol, decision, persistence, transaction, query, or planning authority.           |
| Required handler dependency remains temporally optional                                                                                                                         | Resolve before registration while preserving public setter behavior, or stop for architecture approval.  |
| Config absorbs RTC algorithms, RTT, publication, or WS delivery                                                                                                                 | Restore the downstream boundary; stop if the owner cannot stay separate.                                 |
| Public/deep path needs a second compatibility hop                                                                                                                               | Keep one direct old-to-canonical export and return the exact consumer for review.                        |
| Persisted field/key/expiry/migration changes                                                                                                                                    | Stop for explicit persisted-contract approval.                                                           |
| Authority, AppInbox, transaction, retry, receipt, or outbox changes                                                                                                             | Stop for explicit security/behavior approval.                                                            |
| API-v1/OpenAPI organization or behavior changes                                                                                                                                 | Revert to import-only compatibility or stop for a separate child.                                        |
| Warning is ignored because checker exits zero                                                                                                                                   | Stop until human disposition exists.                                                                     |
| Ratchet replaces semantic behavior evidence                                                                                                                                     | Restore semantic coverage and keep the ratchet supplementary.                                            |
| Historical v1 failure is treated as accepted, replaced, or discarded                                                                                                            | Restore it as immutable failed evidence; this amendment is prospective only.                             |
| Existing comparator, child evaluator, or v1 public-entry behavior changes                                                                                                       | Revert; only the additive outer pooler, explicit-position entry, and reason-file ingress are authorized. |
| Artifact extraction changes schema, property order, values, errors, timing, workload, or output bytes                                                                           | Revert; the new owner is a behavior-neutral responsibility extraction only.                              |
| Benchmark remains above 1,763 lines or exact-base `file.length` worsens                                                                                                         | Stop; the narrow exception does not authorize file growth.                                               |
| Whole-file Prettier exemption reaches another path or suppresses checker output                                                                                                 | Revert; only the inherited benchmark file is exempt during this tooling wave.                            |
| Exception registry omits owner/removal condition or broadens future authority                                                                                                   | Stop; the two exact entries authorize no architecture-child implementation.                              |
| Explicit-position entry bypasses v1 checks or changes numerical aggregation                                                                                                     | Revert; it must reuse the same validation and role-pooling owners after descriptor validation.           |
| Mirrored artifacts use the legacy wrapper or have timestamps/roles rewritten                                                                                                    | Fail closed; use the explicit B-A-A-B descriptors and preserve raw evidence exactly.                     |
| Conflict reasons are created or changed after the first preflight                                                                                                               | Fail the sequence; never edit raw or pooled artifacts to add a reason.                                   |
| One mirrored block is discarded, averaged away, or used as a replacement rerun                                                                                                  | Fail the complete sequence and preserve both blocks.                                                     |
| A 36-sample combined result is used to mask block disagreement                                                                                                                  | Reject it; both independent 18-sample-per-side v1 blocks must pass.                                      |
| Historical PR A production/runtime content differs from candidate `74a62eb`, or reconciled prospective PR B content exceeds the exact reviewed Task 3 diff from base `cc984148` | Stop for a separate code-remediation decision and a new protocol envelope.                               |
| Performance protocol, environment, threshold, or candidate changes after freeze                                                                                                 | Stop; no reroll, threshold change, or evidence relabeling.                                               |
| A human merge is treated as proof that a failed required workflow or missing review passed                                                                                      | Preserve the exact failure and require a separate explicit closure disposition.                          |
| Post-merge PR C measurement is described as pre-merge publication evidence                                                                                                      | Reject the claim; it is closure evidence only and cannot rewrite the publication record.                 |
| Concurrent RTC, black-box, or governance work is assumed absent or absorbed into PR D                                                                                           | Fetch current main and record the exact compatibility impact before PR D changes begin.                  |
| Required external gate persistently fails                                                                                                                                       | Stop with exact run/job/step; do not diagnose unrelated providers.                                       |
| Unrelated plan, dependency, lockfile, workflow, checker, or TypeScript changes                                                                                                  | Restore exact scope before publication.                                                                  |

## 19. Progress Record

| Milestone                         | State                          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth prerequisite                 | ledger-published               | PR #93 feature `aeff6435794dd70816789e4794b78e84fdfc89b0`, tree `8bdea4402dad08dbd1892f2bd8c95671d615b8ff`, accepted plan-only build-gate exception, resulting main `c2cb79c020bceee7f67e6fbc364ba96ea0d6a530` with the same tree. Hetzner run `31251480014` attempt 1 failed and remains non-gating plan-only external evidence.                                                                                                                                                                                                                                                |
| Group-topology child plan         | adaptive consolidation         | Planning PR #95 and approved blobs `c9b5e92686ebbc5d4ff136dbea678c93fea1579f`, `f83cc311369fff2bf255116253ec0f4fe911a43f`, `ef3cb7c7faeb9757a03ef6c39ca589cacdffa9cc`, `b6fd5aebfa77ee489e65fa30fbee165e033c14f9`, and `cf4d92db310c928b2e020f926efa4f731a2fd3b6` remain historical authority. The active adaptive checkpoint uses current main `dc44ab029dd415b356833d3b72e0207f79c4bc88`, tree `6048a6891d819dd1c32647cdf4def27027b360f3`, and selects one topology capability-activation slice.                                                                               |
| PR A protocol/core                | integrated/closure deviation   | PR #103 final feature `d86524adc051ab0b64cae160eb3a847f75d59d7a`, tree `fd8069eddc01f6a4784bc9a7a06b3e808f3aed5d`, passed Branch Release Gate `31337007511`. Merge `cd69565936d881c960dbe151cfe48917a4a2e1bb` has the same tree. Exact resulting-main Hetzner run `31358158337` failed during the `05a-rtc-realtime-stability-2-agent-5s` recipe and has no successful exact-SHA rerun. The accepted historical performance disposition remains unchanged; explicit closure disposition is pending.                                                                              |
| PR B persistence                  | complete                       | PR #151 feature `17f9c237afd9fb006776aaa0335b86e1cb650c88`, tree `7199b061bf1a6fe3abb9c83c02313f5a676a6a5b`, measured base `cc98414867f22cc28f0137ef40a1887ab862f87d`, approved envelope SHA-256 `27a9c8e8acdcaa8f1d737ced31a46708a973c0f92e586526b3c7369467f12ae6`, and accepted one-candidate disposition retain the failed block-2 child evaluation honestly. Merge `1e5f5e55e6ff94c016bfe2cc11af92952a30e32f`, Branch Release Gate `31431692263`, and resulting-main Hetzner run `31432113008` succeeded. Open security classification issue #153 remains separately scoped. |
| PR C authoritative shell          | integrated/closure deviation   | PR #155 final feature `8ec6b8150850d1b7a653d7e6552cb81528e5090a` and merge `bbcec6b9413678d85d0c97f63b18bb4216b5d767` share tree `a272104e0c7638165867e8431cec9afa21870c30`. Medium-scale `31576056918`, topology replay `31576056919`, and resulting-main Hetzner `31580601865` succeeded. Branch Release `31576055172` and review-record runs `31576055103`/`31580589561` remain failed. No governed performance position was consumed; the human explicitly skipped further measurement on 2026-08-13 without claiming a pass.                                                |
| Current-main compatibility        | compatible with recorded delta | No topology production owner or topology semantic test changed from PR C resulting main through `dc44ab029dd415b356833d3b72e0207f79c4bc88`. PRs #197-#199, #201, and #204-#206 changed adaptive governance, RTC benchmark ownership/locks, historical performance-tooling controls, and authenticated plan closeout only. The successor record includes the new closeout verifier under repository-structure ownership. Sibling work remains compatibility input, not topology-child evidence.                                                                                   |
| PR D alignment/final trace        | current adaptive slice         | Activate the topology capability by aligning the test mirror, exact focused command, durable navigation, and two retained style findings without changing behavior. Stop for a new checkpoint after this slice; child close and the later ledger are not in the current horizon.                                                                                                                                                                                                                                                                                                 |
| Later topology ledger             | blocked                        | Requires all four implementation closure records and separate authorization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| RTC/RTT and other sibling domains | active outside this child      | B01/B02/B03 RTC benchmark work and PR #196 are already on main. They remain outside this child's authority and cannot be claimed as its completion evidence.                                                                                                                                                                                                                                                                                                                                                                                                                     |

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
- [x] Performance/failure/no-reroll rules are frozen before any position; a
      candidate identity alone never authorizes measurement.
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
- [x] Historical PR B measurement binds exact base `cc984148`, tree `6c071954`,
      and the unchanged schema-v5 comparator/evaluator hashes; historical PR A
      hashes remain historical evidence only.
- [x] Prospective PR C closure binds exact base `39ad65b4`, candidate
      `8ec6b815`, tree `a272104e`, and the current unchanged tooling identities;
      superseded PR C envelopes remain historical only.
- [x] Current-main RTC, black-box, and checker changes are explicit
      compatibility inputs and are not relabeled as topology-child progress.
- [x] Semantic tests remain primary and ratchets supplementary.
- [x] Non-circular planning, implementation, and ledger evidence is preserved.
- [x] No production behavior is authorized without explicit human approval.

### 20.1 Authorized governance interruption: closure-receipt publication

Issue [#207](https://github.com/intact-software-systems/ar-eye-hunter/issues/207)
records that PR #202 merged the authenticated adaptive-plan closure receipt while
PR Human Review Record v2 rejected that exact data-only path. On 2026-08-13 the
human explicitly authorized interrupting and amending this plan without removing
or rewriting the existing group-topology consolidation slice.

**Owner:** `scripts/pr-human-review/`

**Mirrored tests:** `packages/tests/repo/pr-human-review/`

- [x] Capture RED proving that `plan-only` rejects a canonical direct
      `plans/<plan-id>.closure.json` receipt.
- [x] Reuse plan adaptation's canonical receipt-path predicate without moving
      receipt content, digest, base-transition, or registry authentication out
      of the plan-adaptation owner.
- [x] Prove canonical receipt plus implementation-plan Markdown acceptance and
      reject arbitrary JSON, nested, traversal, noncanonical raw, mismatched,
      and mixed code paths.
- [ ] Complete focused and broad governance, independent review, publication,
      and merge before closing issue #207.

**Legacy impact:** Extend the existing v2 exemption grammar directly. Add no
receipt parser, compatibility scope, second validator, or group-topology change.

## 21. Adaptive Execution Record

The record below is the canonical current horizon. Historical task lists remain
evidence and acceptance context; they do not authorize work outside this
record's current next slice.

```plan-adaptation-v1
{
  "version": 1,
  "planId": "rallar-group-topology-server-structure",
  "status": "active",
  "goal": "Complete group-topology human traceability by activating one directly navigable topology capability without changing runtime behavior or rewriting historical evidence.",
  "acceptanceCriteria": [
    "A human can trace topology configuration ingress, authority, persistence, transaction and retry exits, reconfiguration, planning, and downstream publication from one durable navigation owner.",
    "The topology production root, canonical entry, mirrored test root, focused command, and navigation map satisfy current repository-structure governance.",
    "The two retained PR C style findings are corrected without changing topology behavior, public APIs, persisted contracts, authority, transaction, retry, receipt, outbox, or publication semantics.",
    "Canonical callers bypass compatibility-only wrappers while every retained public compatibility surface remains one direct hop with an explicit owner and removal condition.",
    "Semantic and concurrency tests remain primary, all affected and final repository gates pass on one unchanged tree, and independent review has zero unresolved Critical or Important findings.",
    "PR A and PR C failed publication evidence, PR B's accepted one-candidate performance disposition, and every rejected or superseded PR C performance artifact remain historically exact.",
    "The 2026-08-13 skipped-performance decision is reported as a closure deviation and never as a performance pass.",
    "The later evidence ledger remains a separately authorized slice after a fresh adaptive checkpoint."
  ],
  "distributedValidation": {
    "required": true,
    "reason": "The activation slice moves and validates tests for authoritative realtime topology ownership; its final implementation tree requires the repository's risk-selected distributed validation policy."
  },
  "capabilities": [
    {
      "owner": "plan adaptation",
      "root": "scripts/plan-adaptation",
      "entry": "scripts/plan-adaptation.mjs",
      "testRoot": "packages/tests/repo/plan-adaptation",
      "focusedCommand": "npm run test:plan-adaptation",
      "navigationMap": "scripts/plan-adaptation/README.md",
      "factContracts": [],
      "contractPaths": [
        "docs/superpowers/specs/2026-08-12-adaptive-agent-execution-governance-design.md"
      ],
      "controlFlowFamilies": [
        "lifecycle mutation",
        "read-only validation",
        "close-out"
      ]
    },
    {
      "owner": "repository structure",
      "root": "scripts/repo-structure-check",
      "entry": "scripts/repo-structure-check.mjs",
      "testRoot": "packages/tests/repo/repo-structure-check",
      "focusedCommand": "npm run test:repo-structure",
      "navigationMap": "scripts/repo-structure-check/README.md",
      "factContracts": [
        "scripts/plan-adaptation/active-plan-registry.mjs",
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-closure-receipt.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/repo-style-check/structural-facts.mjs"
      ],
      "controlFlowFamilies": [
        "authored inventory and material-change classification",
        "topology and structural-disposition evaluation",
        "capability and cold-navigation validation",
        "authenticated last-plan close-out validation",
        "authenticated singleton-exception verification"
      ]
    },
    {
      "kind": "guidance",
      "owner": "adaptive plan execution guidance",
      "skillRoot": ".agents/skills/adaptive-plan-execution",
      "skillEntry": ".agents/skills/adaptive-plan-execution/SKILL.md",
      "contractTestRoot": "packages/tests/repo/adaptive-agent-execution",
      "focusedCommand": "npm run test:adaptive-plan-execution",
      "evaluationRoot": ".agents/evaluations/adaptive-agent-execution/v1",
      "contractPaths": [
        "packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts"
      ]
    },
    {
      "kind": "guidance",
      "owner": "repository structure guidance",
      "skillRoot": ".agents/skills/organizing-repository-structure",
      "skillEntry": ".agents/skills/organizing-repository-structure/SKILL.md",
      "contractTestRoot": "packages/tests/repo/organizing-repository-structure",
      "focusedCommand": "npm run test:organizing-repository-structure",
      "evaluationRoot": ".agents/evaluations/organizing-repository-structure/v1",
      "contractPaths": [
        ".agents/evaluations/adaptive-agent-execution/v1/validate-result.mjs",
        "packages/tests/repo/rallar-skill-plugin-publication-integrity.test.ts"
      ]
    },
    {
      "kind": "guidance",
      "guidanceRole": "router",
      "owner": "general agent guidance",
      "routingEntry": "AGENTS.md",
      "contractTestRoot": "packages/tests/repo/general-agent-guidance",
      "focusedCommand": "npm run test:general-agent-guidance",
      "evaluationRoot": null,
      "contractPaths": [
        ".agents/skills/adaptive-plan-execution/SKILL.md",
        ".agents/skills/organizing-repository-structure/SKILL.md",
        ".agents/skills/publishing-plan-progress/SKILL.md",
        ".agents/skills/rallar-code-writing/SKILL.md",
        ".agents/skills/rallar-testing/SKILL.md",
        ".agents/skills/rallar-testing/references/test-commands.md",
        "packages/tests/repo/rallar-authoritative-mutation-guidance-integrity.test.ts",
        "packages/tests/repo/repo-code-style-authority-integrity.test.ts",
        "packages/tests/repo/repo-code-style-review-evidence-integrity.test.ts"
      ]
    },
    {
      "owner": "PR human review",
      "root": "scripts/pr-human-review",
      "entry": "scripts/pr-human-review.mjs",
      "testRoot": "packages/tests/repo/pr-human-review",
      "focusedCommand": "npm run test:pr-human-review",
      "navigationMap": "scripts/pr-human-review/README.md",
      "factContracts": [
        "scripts/check-pr-human-review-legacy-stages.mjs",
        "scripts/legacy-review/candidate-report.mjs",
        "scripts/legacy-review/validate-supplied-evidence.mjs",
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "scripts/plan-adaptation/plan-closure-receipt.mjs",
        "scripts/plan-adaptation/plan-change-facts.mjs",
        "scripts/review-legacy.mjs",
        "packages/tests/repo/legacy-review.test.ts"
      ],
      "contractPaths": [
        ".github/PULL_REQUEST_TEMPLATE.md",
        ".github/workflows/pr-human-review-record.yml",
        "docs/README.md",
        "docs/pr-human-review-record.md",
        "docs/production-legacy-exceptions.md",
        "docs/repo-human-style-guide.md"
      ],
      "controlFlowFamilies": [
        "review input and evidence decoding",
        "initial checkpoint and final freshness validation",
        "trusted retained-legacy approval",
        "legacy candidate-stage integration"
      ]
    },
    {
      "owner": "governance gate",
      "root": "scripts/governance-gate",
      "entry": "scripts/governance-gate.mjs",
      "testRoot": "packages/tests/repo/governance-gate",
      "focusedCommand": "npm run test:governance-gate",
      "navigationMap": "scripts/governance-gate/README.md",
      "factContracts": [
        "packages/tests/repo/github-actions-runtime-governance.test.ts"
      ],
      "contractPaths": [
        ".github/workflows/governance-gate.yml"
      ],
      "controlFlowFamilies": [
        "local phase orchestration",
        "focused contract validation",
        "GitHub early-gate integration"
      ]
    },
    {
      "owner": "validation evidence",
      "root": "scripts/validation-evidence",
      "entry": "scripts/validation-evidence.mjs",
      "testRoot": "packages/tests/repo/validation-evidence",
      "focusedCommand": "npm run test:validation-evidence",
      "navigationMap": "scripts/validation-evidence/README.md",
      "factContracts": [
        "scripts/pr-human-review/review-freshness.mjs"
      ],
      "contractPaths": [
        ".github/workflows/branch-release-gate.yml",
        ".github/workflows/release-gate.yml",
        "apps/relic-hunter-server-v1/deno.lock"
      ],
      "controlFlowFamilies": [
        "build-tree digest computation",
        "trusted prior-run evidence validation",
        "evidence production and branch-workflow reuse"
      ]
    },
    {
      "owner": "distributed validation risk",
      "root": "scripts/distributed-validation-risk",
      "entry": "scripts/distributed-validation-risk.mjs",
      "testRoot": "packages/tests/repo/distributed-validation-risk",
      "focusedCommand": "npm run test:distributed-validation-risk",
      "navigationMap": "scripts/distributed-validation-risk/README.md",
      "factContracts": [
        "scripts/plan-adaptation/adaptive-plan-record.mjs",
        "packages/tests/hetzner/distributed-recipe-workflow.test.ts"
      ],
      "contractPaths": [
        ".github/workflows/hetzner-supported-distributed-manifests.yml",
        "apps/api-v1/deno.json",
        "apps/api-v1/deno.lock",
        "deno.json",
        "deno.lock"
      ],
      "controlFlowFamilies": [
        "changed-path risk classification",
        "structured plan requirement and manual override",
        "main-push Hetzner workflow selection"
      ]
    },
    {
      "owner": "group topology authority",
      "root": "packages/shared-server/rallar-system/topology",
      "entry": "packages/shared-server/rallar-system/topology/group-topology-management-service.ts",
      "testRoot": "packages/tests/shared-server/rallar-system/topology",
      "focusedCommand": "npm run test:group-topology",
      "navigationMap": "packages/shared-server/rallar-system/topology/README.md",
      "factContracts": [
        "packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts",
        "packages/tests/repo/auth-server-compatibility-consumer-inventory.ts",
        "packages/tests/shared-server/integration/postgres/rtc-topology-delivery-concurrency.test.ts",
        "packages/tests/shared-server/integration/postgres/rtc-topology-replay-consumer.test.ts",
        "packages/tests/shared-server/integration/postgres/rtt-runtime-concurrency.test.ts",
        "packages/tests/shared-server/integration/postgres/topology-app-outbox-concurrency.test.ts",
        "packages/tests/shared-server/rallar-system/group-topology-capability-source-style-snapshot.ts"
      ],
      "contractPaths": [
        "docs/test-structure-coupling-exceptions.md",
        "packages/tests/shared-server/vitest.postgres-integration.config.mjs"
      ],
      "controlFlowFamilies": [
        "configuration ingress and authority",
        "persistence and exact reads",
        "AppInbox transaction, retry, and outbox exits",
        "reconfiguration and planning",
        "downstream RTC replay and publication"
      ]
    }
  ],
  "architecture": {
    "currentHypothesis": "The implemented production ownership is coherent, but the pre-governance test mirror and lack of one exact focused command prevent an honest active capability declaration.",
    "intendedHypothesis": "One consolidation slice aligns the existing tests and validation entry with the existing topology owner, fixes the two known style findings, and leaves runtime behavior unchanged.",
    "invalidatedAssumptions": [
      "A post-merge PR C performance result is required before final traceability work can continue.",
      "The pre-governance packages/tests/shared-server/topology path is an acceptable declared mirror for packages/shared-server/rallar-system/topology.",
      "Canonical authenticated closure receipts were assumed to qualify for the PR Human Review Record v2 plan-only exemption. PR #202 proved the validator rejects that required data-only publication path."
    ],
    "freshInitialReview": {
      "status": "passed",
      "base": "20f0bd8ce8a905054feb8d60d61c6a169d149b1b",
      "criticalFindings": 0,
      "importantFindings": 4,
      "disposition": "Resolved within activate-group-topology-capability: refresh adaptive facts through the checkpoint; add the README navigation contract and symbol anchors; correct depth-sensitive cross-root test paths after the mirror move; and extend permanent canonical-import and compatibility evidence.",
      "issue207": "Existing follow-up only; authenticated plan-only closure-receipt policy does not block this build-affecting slice or a declared Task 5 acceptance criterion."
    },
    "compatibilityReview": {
      "initialBase": "20f0bd8ce8a905054feb8d60d61c6a169d149b1b",
      "base": "939d63d28a1cf8dac0f3610415152074aa941db0",
      "tree": "bc5720b20811cd047b58f7233ab9657fce321621",
      "result": "Compatible — no plan delta",
      "topologyImpact": "RTC benchmark ownership adds direct canonical replay consumers, generic black-box assertions do not own topology contracts, and repository/adaptive governance requires the mirrored test root, exact focused command, and machine-verifiable navigation contract. The later 49adc91c movement refreshes this plan's PR #203 sibling facts; aa124e03 removes contaminated uncommitted TypeScript paths from that older fact refresh; 939d63d2 publishes the already-recorded closure-receipt correction. No topology production behavior, ownership, semantic test, integration boundary, or acceptance criterion changed."
    }
  },
  "completedSlicesSinceCheckpoint": [],
  "facts": {
    "diffBase": "aa124e03775492f9e37882bb9ed02b03dfe0dad6",
    "affectedCodeDigest": "27261391232b696929a9e808d6464f84b3eaab9d19c9849b2833d0876d82c572",
    "computedTriggers": [
      "folder-change",
      "ownership-change",
      "public-contract-change",
      "invalid-assumption",
      "scope-growth"
    ],
    "undeclaredChangedPaths": [
      "packages/tests/shared-server/topology/concurrency/fixtures/postgres-topology-app-inbox-worker.ts",
      "packages/tests/shared-server/topology/concurrency/postgres-topology-app-inbox-concurrency.test.ts",
      "packages/tests/shared-server/topology/concurrency/postgres-topology-concurrency-fixtures.ts",
      "packages/tests/shared-server/topology/concurrency/postgres-topology-config-override-concurrency.test.ts",
      "packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-concurrency.test.ts",
      "packages/tests/shared-server/topology/concurrency/postgres-topology-mutation-worker-fixtures.ts",
      "packages/tests/shared-server/topology/config/group-topology-config-query-service.test.ts",
      "packages/tests/shared-server/topology/config/group-topology-config-resolution.test.ts",
      "packages/tests/shared-server/topology/config/maintenance/group-topology-config-generation-readiness.test.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-boundary.test.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-compute.test.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-idempotency.test.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-result.test.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-test-fixtures.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-transaction.test.ts",
      "packages/tests/shared-server/topology/config/mutation/group-topology-config-mutation-validation.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-exact-read.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-generation.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-legacy-migration.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-mutation-record-corruption.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-persistence-test-fixtures.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-corruption.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-keys.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-read-write.test.ts",
      "packages/tests/shared-server/topology/config/persistence/group-topology-config-repository-scope-isolation.test.ts",
      "packages/tests/shared-server/topology/inbox/topology-app-inbox-authority.test.ts",
      "packages/tests/shared-server/topology/inbox/topology-app-inbox-command.test.ts",
      "packages/tests/shared-server/topology/inbox/topology-app-inbox-handler.test.ts",
      "packages/tests/shared-server/topology/inbox/topology-app-inbox-ownership.test.ts",
      "packages/tests/shared-server/topology/planning/group-topology-planning-service.test.ts",
      "packages/tests/shared-server/topology/reconfigure/group-topology-reconfigure-mutation.test.ts"
    ]
  },
  "checkpoint": {
    "outcome": "The final-review replay import correction and six individually reviewed structure-coupling dispositions pass focused tests and governance, and the global coupling registry is declared as the capability's exact non-code review contract.",
    "learning": "A changed global governance registry should be attached to the capability that requires its entries through contractPaths, while the management public entry remains distinct from the narrower planning owner selected by canonical replay.",
    "structure": "Keep the activated capability root, public management entry, direct replay planning import, mirrored test root, focused command, README navigation owner, declared coupling-registry and Postgres-config contracts, completed one-slice boundary, and empty next horizon.",
    "decision": "amend",
    "nextSlices": []
  },
  "structuralDispositions": [
    {
      "kind": "predecessor-path",
      "path": "packages/tests/shared-server/topology",
      "disposition": "move",
      "destination": "packages/tests/shared-server/rallar-system/topology",
      "owner": "group topology authority",
      "rationale": "Current adaptive governance requires the test hierarchy to mirror the authoritative production root; the move preserves semantic test ownership and behavior rather than adding a compatibility test path."
    },
    {
      "kind": "ownership-contract",
      "target": "packages/shared-server/rallar-system/topology/group-topology-management-service.ts",
      "disposition": "keep",
      "rationale": "The public management service remains the direct compatibility facade while narrower config, reconfigure, planning, and inbox owners remain canonical internally."
    },
    {
      "kind": "ownership-contract",
      "target": "plans/rallar-group-topology-server-structure-plan.md#section-13",
      "disposition": "keep",
      "rationale": "Retain the old performance protocol only as historical evidence under the explicit retirement banner; it owns no future execution."
    }
  ],
  "freshStructuralReview": {
    "status": "complete",
    "failures": []
  },
  "coldNavigationEvidence": {
    "status": "passed",
    "summary": "A cold code-derived navigation pass located the canonical owner for each of the five Task 5 families from the durable README without a private compatibility wrapper.",
    "consolidationDecisionIndex": 2,
    "probes": [
      {
        "capabilityOwner": "group topology authority",
        "path": "packages/shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts",
        "symbol": "GroupTopologyConfigMutationService"
      },
      {
        "capabilityOwner": "group topology authority",
        "path": "packages/shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-mutation.ts",
        "symbol": "GroupTopologyReconfigureMutation"
      },
      {
        "capabilityOwner": "group topology authority",
        "path": "packages/shared-server/rallar-system/topology/config/group-topology-config-query-service.ts",
        "symbol": "GroupTopologyConfigQueryService"
      },
      {
        "capabilityOwner": "group topology authority",
        "path": "packages/shared-server/rallar-system/topology/config/maintenance/backfill-group-topology-config-generations.ts",
        "symbol": "backfillAllGroupTopologyConfigGenerations"
      },
      {
        "capabilityOwner": "group topology authority",
        "path": "packages/shared-server/rallar-system/topology/replay/create-rtc-topology-work-handler.ts",
        "symbol": "createRtcTopologyWorkHandler"
      }
    ]
  },
  "materialDecisions": [
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The human explicitly skipped the unconsumed PR C performance workflow and requested replanning under the adaptive tools now on main; the skip is retained as a closure deviation, not a pass."
    },
    {
      "date": "2026-08-13",
      "decision": "consolidate",
      "summary": "PR #203's RTC plan and roadmap updates landed after this plan's facts were prepared. They are concurrent sibling evidence and do not change group-topology behavior or ownership.",
      "checkpointDigest": "d3059a7d620520177f63440f8e56b28d121535c893670e068cc48d0af1a1cdcd"
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The prior fact refresh captured two uncommitted TypeScript configuration paths. Current clean main contains only the merged sibling RTC plan and roadmap changes plus authenticated adaptive-governance closure evidence."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The human explicitly authorized interrupting the single group-topology consolidation horizon to include the independently implemented and reviewed closure-receipt publication correction recorded by issue #207."
    },
    {
      "date": "2026-08-13",
      "decision": "consolidate",
      "summary": "The existing group-topology production owner is now paired with the recognized mirrored test root, exact focused command, machine-verifiable navigation contract, temporary child source/style snapshot, corrected retained style rows, and expanded canonical-import evidence. Focused semantic tests pass without a topology behavior or contract change.",
      "checkpointDigest": "cc61a93c3e645cae7a530634febbe139d5d8a6739bdfe270d8e8a7ddaa5dd4ee"
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The activated capability now passes both its exact focused suite and the repository structure checker after the recognized test mirror was aligned with its internal ownership boundaries."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The formatted capability activation still passes its exact focused suite and repository structure checker, with the temporary snapshot and navigation map normalized to repository formatting."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The capability activation is rebased onto main 49adc91cbcf00e97560716fc91ae4f4a31a291c1 after a compatibility review found no product, ownership, integration, or acceptance-contract change."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The activated capability now includes the five durable family traces, controlled-sample waiver, all focused warning dispositions, supplementary-ratchet decisions, and canonical Postgres/compatibility consumer paths; focused semantic and repository-structure checks pass."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The sole adaptive consolidation slice activate-group-topology-capability is complete. Cold navigation locates all five family owners from the durable README and machine-readable capability declaration; no second slice is exposed."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The completed activate-group-topology-capability slice preserves all moved semantic and concurrency behavior; the focused suite, isolated Postgres integration suite, exact topology Postgres modules, API black-box recipes, repository governance, and slice-relative style ratchet pass."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The completed activate-group-topology-capability slice preserves all moved semantic and concurrency behavior; after final formatting, the focused suite and all four affected downstream Postgres modules pass on the same source tree."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "Main advanced to aa124e03775492f9e37882bb9ed02b03dfe0dad6 through a plan-only fact cleanup; the rebased capability source remains behaviorally identical and all production, test, ownership, integration, and acceptance contracts remain valid."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "Independent final review found RTC replay importing planning-owned message materialization symbols through the public management facade; replay now imports the declaration owner directly, the ownership test rejects that facade hop, and the release gate's six structural candidates have individual compatibility-boundary dispositions."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "The final-review replay import correction and six individually reviewed structure-coupling dispositions pass focused tests and governance, and the global coupling registry is declared as the capability's exact non-code review contract."
    },
    {
      "date": "2026-08-13",
      "decision": "amend",
      "summary": "PR #210 advanced main to 939d63d28a1cf8dac0f3610415152074aa941db0 with the already-recorded closure-receipt publication correction. Conflict resolution preserves that material decision before the completed group-topology activation checkpoint, retains the empty horizon, and changes no topology behavior, ownership, integration, or acceptance contract."
    }
  ]
}
```
