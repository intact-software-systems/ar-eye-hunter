# API-v1 Convergent Database Writing Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Also use the repo-local `rallar-platform`, `rallar-realtime`, `rallar-code-writing`, and `rallar-testing` skills for every task that touches their surfaces.

**Goal:** Replace api-v1 client, group, and topology lost-update or lock-based database writes with readable `read -> compute -> validate -> write` mutations, convergent compare-and-set commits, transaction-local outboxes, and bounded increasing-backoff retries, while making authoritative shared contracts fully populated by default and preserving or improving write-path speed.

**Architecture:** Each mutation attempt has three data stages, visibly named `read`, `compute`, and `write`, with an explicit pure `validate` call between compute and write. `read` loads the complete decision surface without opening the write transaction. `compute` is a pure function: the same command, read model, and explicit facts (clock, ids, hashes, or other nondeterministic inputs captured before the attempt) produce the same candidate. `validate` is also pure and checks both the read model and candidate. `write` is the only operation allowed to open a database transaction; it performs the aggregate compare-and-set guard first, then writes dependent rows, events, compact idempotency receipts, and mutation-outbox rows atomically, without domain rereads or external effects. A conflict rolls back, waits for the next bounded increasing backoff, and restarts at `read`. Keep `snapshotVersion` as the public semantic version and use storage revisions as compare-and-set tokens. Persisted, replicated, queued, event, snapshot, and response values use mandatory fields or explicit discriminated/nullable alternatives; sparse request and patch types remain separate inputs.

**Tech Stack:** TypeScript, Deno, Node/npm workspaces, Vitest, PostgreSQL, PGlite, Hono, YAML/OpenAPI, runtime-state JSON repositories, Rallar black-box recipes.

## Global Constraints

- Tasks 0A and 0B are hard prerequisites for Tasks 1-10: land the dedicated medium-scale correctness recipe and the state-write performance harness, then record unmodified correctness and performance baselines before changing database-write behavior. A baseline domain/convergence assertion may fail and become remediation evidence, but harness, schema, preflight, authentication, rate-limit, or metrics failures must be fixed before Task 1 begins.
- Do not weaken the prerequisite or final gate below 100 independently authenticated client identities, five shared group aggregates, ten concurrent client lanes, five concurrent group/topology-control lanes, two api-v1 processes sharing PostgreSQL, or the specified final convergence assertions. Scale changes require a separately reviewed plan amendment with recorded evidence; they are not a test-fix option.
- Optimistic compare-and-set with a bounded retry budget is the default for all authoritative shared database state in this plan.
- Create uses conditional insert; update uses expected-revision compare-and-set; delete and expiry use expected-revision conditional delete.
- Every targeted mutating service must make the orchestration readable in this order: `const read = await readX(...)`; `const computed = computeX(...)`; `validateX(...)`; `const written = await writeX(...)`. Use those verbs in implementation names. Do not hide this flow inside a generic mutation-pipeline framework or nested callbacks.
- `computeX` and `validateX` must be deterministic, synchronous domain functions with no repository access, transaction access, current-time lookup, randomness, id generation, environment access, or publication. Capture nondeterministic facts before `compute` and pass them as required immutable input.
- A retry rereads the complete decision surface, recomputes from fresh input, and reruns authorization, policy, capacity, lifecycle, idempotency, and invariant validation. Never retry only the stale final write and never reuse a candidate computed from a stale read.
- `writeX` is the only layer that opens the transaction. It performs no domain reads and no sleep. It first applies the aggregate/row expected-revision or expected-absence guard; only after that succeeds may it insert/update dependent rows, events, compact idempotency receipts, and every required mutation-outbox row. `RETURNING` from writes is allowed. A transaction without a compare-and-set guard is insufficient.
- Default retry delays are the required bounded sequence `[0, 2, 8]` milliseconds for at most three attempts. Delay happens before attempts two and three, outside any transaction. Keep the delay function injectable for deterministic tests and record attempt, backoff, conflict, and transaction duration through `RallarTimingSink`. Changing this policy requires focused contention measurements and a reviewed plan amendment.
- Share only conditional-write errors/assertions, retry/backoff calculation, and timing fields. Prefer operation-local `readX`, `computeX`, `validateX`, and `writeX` functions near the owning service; a small amount of repetition is preferable to indirection that obscures data flow.
- Where one service supports many commands, use at most a shallow discriminated-union `switch` to dispatch to contiguous operation-specific phase functions. Do not use registries, decorators, higher-order phase callbacks, or a generic pipeline executor.
- Domain state, durable event, idempotency receipt, state-sync intent, and downstream recompute intent are one atomic write boundary. Post-commit cache publication, WS QueueBox enqueue, and topology recomputation are outbox-worker responsibilities, never synchronous mutation-transaction work.
- Do not add or retain row, table, or advisory locks in the targeted client, group, topology, publication, or RTT paths. A lock outside this scope remains untouched unless a separate review authorizes its migration.
- PostgreSQL may still acquire short internal tuple/index locks while applying a conditional statement. The rule forbids application-coordination locks and requires short write-only transactions; it does not claim that PostgreSQL commits are physically lock-free.
- Treat stale observations as ignore-or-rebase outcomes, duplicates as no-ops, and equal causal revision with different content as invariant corruption.
- Preserve the public meaning of `snapshotVersion` and topology `version`. Any coordinated change from one group `stateRevision` to a required causal tuple must land atomically across shared contracts, OpenAPI, topology consumers, caches, and tests in Task 7.
- Authoritative persisted, replicated, queued, event, snapshot, and response fields are mandatory. Express genuine absence with a discriminated union or a required `null`; keep optionality only on request, query, patch, builder, and migration input types where omission has documented semantics.
- Make session lifecycle generation explicit so delayed heartbeat, close, or expiry work from an older connection cannot mutate a replacement connection that reuses the same session id.
- Do not serialize routine presence heartbeats through the shared group row. Membership, capacity, governance, and metadata use the group aggregate revision; presence lifecycle uses the targeted session generation/revision. A coalesced outbox worker converges the group presence summary, and topology consumes a required group/presence causal tuple.
- A presence row is a liveness observation, never authorization truth. Group reads, routing, and topology must intersect current active membership/group policy with current presence generations. Therefore a heartbeat computed from a stale membership read cannot restore a banned/removed member's authority; membership mutation outboxes force summary convergence.
- Idempotency ledgers store a required command hash plus a compact `MutationReceipt`; they do not store complete aggregate snapshots. Mutation APIs return the receipt by default. A compatibility caller that needs a full snapshot performs an explicit post-commit read outside the write transaction.
- Preserve existing public exports and import paths unless the contract-hardening task explicitly records a coordinated breaking change.
- Follow TDD: add one focused failing behavior test, confirm the expected failure, make the smallest implementation pass, and run the focused suite before moving to the next behavior.
- Keep generated profiles and disposable Postgres artifacts under `tmp/`; do not commit them.
- Preserve unrelated working-tree changes. Stage only the files listed by the task being committed.

---

## Review Findings Ledger

| ID | Priority | Evidence | Finding | Required outcome |
| --- | --- | --- | --- | --- |
| DBW-01 | High | `packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts:155` | `upsert` is unconditional last-write-wins. It increments `revision` but cannot compare an expected revision. | Add conditional insert, update, and delete primitives backed by SQL predicates and `RETURNING`. |
| DBW-02 | High | `packages/shared-server/runtime-state/RuntimeStateJsonStore.ts:181` | Lazy expiry reads an expired row and then deletes by key without checking that revision. A concurrent refresh can be deleted. | Delete only the observed revision; reread and return a replacement when the compare-and-delete loses. |
| DBW-03 | High | `packages/shared-server/rallar-system/services/client-state-service.ts:181` and `:1228` | Client mutations are transactional but use unconditional row writes. Session advisory locks serialize only one session key and do not coordinate concurrent sessions or principal/instance mutations sharing the principal aggregate. | Guard every client mutation with the principal storage revision and retry the full mutation; remove session locks. |
| DBW-04 | High | `packages/shared-server/rallar-system/repositories/ClientStateRepository.ts:33` | Client idempotency is check-then-unconditional-upsert, so two writers can both mutate and overwrite the ledger. | Insert the ledger claim conditionally inside the mutation transaction; loser rolls back and loads the winner. |
| DBW-05 | High | `packages/shared-server/rallar-system/services/group-state-service.ts:289` and `:2072` | Group, membership, governance, invite, join-code, ownership, and presence mutations use unconditional writes. Presence locks cover one session but not the shared group aggregate. | Guard metadata/membership/governance with the group revision, presence with its session generation/revision, remove presence locks, and make creation/receipts first-writer-wins. |
| DBW-06 | High | `packages/shared-server/rallar-system/services/group-topology-management-service.ts:164` and `:636` | Config/override versions are derived from stale reads and written unconditionally. Reconfigure failure restores a prior value unconditionally, which can clobber or resurrect a newer concurrent change. | CAS config/override state, remove compensating restore, enqueue recompute atomically, and reserve synchronous failure reporting for explicit reconfigure. |
| DBW-07 | High | `RtcTopologySnapshotRepository.ts:134`, `RtcTopologyPublicationRepository.ts:70`, and `RtcTopologyExecutionRepository.ts:60` | Topology causal decisions are sound, but acceptance relies on advisory locks. This creates a lock-based precedent and wait dependency. | Preserve causal comparison while replacing locks with atomic expected-revision and insert-if-absent operations. |
| DBW-08 | Medium | `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts:150` | RTT latest-value and endpoint-cap admission use advisory locks. | CAS the measurement row and use an optimistic endpoint admission revision/index with bounded revalidation. |
| DBW-09 | High | `packages/shared/api/client-types.ts:53`, `group-types.ts:40`, and `api-config.ts:117` | Shared authoritative scope, audit, lifecycle, event, and overlay fields remain optional even where valid persisted or replicated values always supply them. | Make scope and authoritative output fields required; use unions or required nullable values for lifecycle absence; keep sparse input types separate. |
| DBW-10 | Medium | `packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts` and `ws-system-topics-rtc-topology.test.ts:565` | Current concurrency tests prove advisory lock waiting/acquisition instead of compare-and-set conflict, rebase, exhaustion, and final convergence. | Replace lock assertions with independent-client conflict and deterministic convergence proofs. |
| DBW-11 | High | `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-topology-churn.json` and `packages/tests/shared-test/recipe-matrix.test.ts` | The existing two-server churn gate covers only 12 clients and two groups, so it does not provide a medium-scale baseline before the write architecture changes. | Before remediation, add and baseline an opt-in two-server PostgreSQL recipe with 100 independently authenticated clients, five groups, and concurrent client/group/topology churn. |
| DBW-12 | High | `AppClientInboxService.ts:327`, `AppGroupInboxService.ts:546`, and `architecture.md:38` | Domain mutation commits before state-sync and topology outbox enqueue. A process failure can leave durable state without an independently drainable publication/recompute intent. | Write immutable mutation-outbox intents in the same transaction as state, event, and receipt rows; drain them after commit into the existing WS/app outboxes. |
| DBW-13 | High | `client-state-service.ts`, `group-state-service.ts`, and topology repositories | Read/decision/write behavior is interleaved inside broad transactional callbacks, obscuring determinism, extending transaction lifetime, and making conflict retries expensive to reason about. | Use explicit operation-local `read`, pure `compute`, pure `validate`, and write-only `write` phases; retry the whole flow with increasing bounded backoff. |
| DBW-14 | High | `group-state-service.ts:1387-1478` and `GroupStateRepository.ts:384` | A group presence heartbeat rewrites the shared group row and snapshot assembly scans all members/sessions, so 100 clients in one group contend on one guard and amplify read/write cost. | Give presence sessions an independent generation/revision domain, converge summaries asynchronously, and measure uncontended, shared-group, and hot-group throughput before and after. |
| DBW-15 | Medium | `ClientMutationWritten`, `GroupMutationWritten`, and their idempotency ledgers | Full snapshots are stored and returned for accepted mutations, increasing JSON, ledger, response, and reread cost. | Persist and return compact required receipts; make full snapshots explicit post-commit reads or compatibility wrappers. |

### Correct foundations to preserve

- `packages/shared-server/app-data/AppDataRepository.ts` and `postgres/app-data/PSqlAppDataRepository.ts` already demonstrate `insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision`.
- `RallarServerAppData.updateOrCreate(...)` already retries optimistic conflicts from fresh reads.
- `readStableStateSnapshot(...)` and the aggregate/children/aggregate readers correctly avoid read locks and reject torn snapshots.
- Topology tuple comparison, stale suppression, equal-tuple corruption detection, immutable publications, deterministic work ids, and browser monotonic observation are the right convergence semantics; only their durable commit mechanism changes.
- Existing AppInbox and QueueBox machinery remains the delivery layer, but it is not the atomic mutation outbox. Preserve it behind a new transaction-local intent namespace/repository and idempotent drainer.

## File And Responsibility Map

### New files

- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json`: prerequisite two-server, 100-client, five-group client/group/topology churn gate.
- `scripts/perf/api-v1-state-write-concurrency-bench.ts`: state-only uncontended, shared-group, and hot-group service benchmark with before/after JSON artifacts.
- `scripts/perf/compare-api-v1-state-write-results.mjs`: comparative speed gate for latency, throughput, conflicts, SQL work, and transaction duration.
- `packages/shared-server/runtime-state/optimistic-runtime-state-write.ts`: typed write conflict/exhaustion errors, conditional-write assertion, bounded increasing-backoff policy, and injectable delay; it does not own transactions or hide the mutation loop.
- `packages/shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts`: transaction-local client/group/topology mutation intents with immutable payloads and CAS delivery state.
- `packages/shared-server/rallar-system/services/StateMutationOutboxWork.ts`: idempotent post-commit drain into state-sync and coalesced topology work.
- `packages/shared-server/rallar-system/services/client-state-mutations.ts`: explicit client mutation command/read/computed/receipt types plus pure `compute` and `validate` functions.
- `packages/shared-server/rallar-system/services/group-state-mutations.ts`: explicit group mutation command/read/computed/receipt types plus pure `compute` and `validate` functions.
- `packages/shared-server/rallar-system/services/group-topology-config-mutations.ts`: explicit config mutation data and pure compute/validate decisions.
- `packages/shared-server/rallar-system/services/rtc-topology-mutations.ts`: explicit topology/RTT mutation data and pure causal/admission decisions.
- `packages/tests/shared-server/state-mutation-outbox.test.ts`: atomic intent, restart, two-drainer, and idempotent delivery proofs.
- `packages/tests/shared-server/runtime-state-optimistic-write.test.ts`: bounded increasing-backoff and typed exhaustion proofs.
- `packages/tests/shared-server/state-write-performance-harness.test.ts`: artifact schema, workload scale, and metrics guard.
- `packages/tests/shared-server/runtime-state-conditional-writes.test.ts`: in-memory/fake conditional primitive and stale-expiry behavior.
- `packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts`: two-client Postgres CAS, conditional delete, and retry proofs.
- `packages/tests/shared-server/client-state-concurrency.test.ts`: deterministic client aggregate conflict and lifecycle-generation tests.
- `packages/tests/shared-server/group-state-concurrency.test.ts`: deterministic group aggregate conflict, capacity, ownership, and presence tests.
- `packages/tests/shared-server/read-compute-write-contract.test.ts`: structural guard for phase ordering, pure compute/validate modules, transaction ownership, guard-first writes, and outbox insertion.
- `packages/tests/shared/authoritative-state-contracts.test.ts`: type-level required-field assertions and input/output separation.
- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-write-convergence.json`: multi-server client/group/config convergence recipe.

### Existing files with changed responsibility

- `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`, its tests, the recipe matrix, and package scripts: expose an opt-in `api-v1-black-box-medium-scale` two-server profile without adding medium-scale cost to the default cluster profile.
- `RuntimeStateRepository.ts`, `PSqlRuntimeStateRepository.ts`, and `fake-runtime-state-repository.ts`: expose and implement conditional capabilities that authoritative services require at their dependency boundary.
- `RuntimeStateJsonStore.ts`: typed entry-aware conditional JSON helpers and revision-safe lazy expiry.
- `ClientStateRepository.ts` and `GroupStateRepository.ts`: entry-aware aggregate/child/idempotency methods; no hidden unconditional authoritative writes.
- `client-state-service.ts` and `group-state-service.ts`: one-layer, human-readable `read -> compute -> validate -> write` orchestration; no session/presence advisory locks.
- `AppClientInboxService.ts`, `AppGroupInboxService.ts`, and `StateSyncPublisher.ts`: stop publishing directly from mutation results; consume committed outbox intents through the worker.
- `GroupTopologyConfigRepository.ts`, topology snapshot/publication/execution repositories, and `RtcRttRepository.ts`: CAS/insert-if-absent acceptance.
- `client-types.ts`, `group-types.ts`, `state-types.ts`, `api-config.ts`, `overlay-topology.ts`, and `graph-topology-management-types.ts`: mandatory authoritative contracts and explicitly sparse inputs.
- `apps/api-v1/resources/api-v1-openapi.yaml`: required/nullable shapes aligned with TypeScript.
- Current architecture/docs/skills: describe implemented CAS behavior after migration and retain the lock-exception rule.

---

### Task 0A (Prerequisite): Establish the medium-scale two-server correctness gate

**Hard gate:** Do not begin Task 1 until every step in Tasks 0A and 0B is complete. The
recipe and runner support must be committed before implementation so the workload
cannot be retrofitted around the chosen database-write solution.

**Files:**

- Create: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- Modify: `packages/tests/shared-test/api-v1-black-box-run.test.ts`
- Modify: `packages/tests/shared-test/recipe-matrix.test.ts`
- Modify: `packages/shared-test/package.json`
- Modify: `package.json`

**Interfaces:**

- Produces matrix profile `api-v1-black-box-medium-scale` containing exactly the
  `api-v1-state-medium-scale-churn` recipe and requiring primary and secondary
  HTTP services; it must not require Playwright.
- Extends `ApiV1BlackBoxOptions` with required `clusterProfile: string` and
  `clusterOnly: boolean` fields. `--cluster-profile=<profile>` selects the
  secondary/two-server matrix profile, and `--cluster-only` skips the ordinary
  single-server profile. `--cluster-only` requires PostgreSQL and a distinct
  `--secondary-port`; the defaults remain `api-v1-black-box-cluster` and `false`.
- Produces root command
  `npm run test:api-v1:black-box:postgres:medium-scale`, which starts two api-v1
  processes against the same PostgreSQL database and runs only the medium-scale
  profile. Artifacts go under `tmp/api-v1-black-box/postgres-medium-scale/`.
- The workload constants are part of the acceptance contract:
  `CLIENT_COUNT = 100`, `GROUP_COUNT = 5`, `CLIENT_LANE_COUNT = 10`,
  `CLIENTS_PER_LANE = 10`, `GROUP_CONTROL_LANE_COUNT = 5`, and
  `GROUP_CONTROL_ITERATIONS = 10`.

- [ ] **Step 1: Add failing runner-option and matrix-shape tests**

In `api-v1-black-box-run.test.ts`, require this parse result and reject
`--cluster-only` without a secondary Postgres server:

```ts
expect(parseApiV1BlackBoxArgs([
    '--backend=postgres',
    '--secondary-port=18081',
    '--cluster-only',
    '--cluster-profile=api-v1-black-box-medium-scale',
])).toMatchObject({
    backend: 'postgres',
    secondaryPort: 18081,
    clusterOnly: true,
    clusterProfile: 'api-v1-black-box-medium-scale',
});

expect(() => parseApiV1BlackBoxArgs(['--cluster-only']))
    .toThrow(/cluster-only.*secondary-port/i);
```

Add and consume an exported `toRecipeMatrixCommands(options, artifactDir)`
planner. Assert that cluster-only returns exactly one recipe-matrix command,
uses `--profile=api-v1-black-box-medium-scale`, and writes below the `cluster/`
artifact directory. Preserve the existing assertion that the default
two-server run executes the ordinary profile followed by
`api-v1-black-box-cluster`.

In `recipe-matrix.test.ts`, require a matrix entry with:

```ts
expect(entry).toMatchObject({
    id: 'api-v1-state-medium-scale-churn',
    category: 'api-v1-black-box',
    mode: 'run',
    profiles: ['api-v1-black-box-medium-scale'],
    expectedExitCode: 0,
});
expect(entry?.requires?.httpServices).toHaveLength(2);
expect(entry?.requires?.playwright).not.toBe(true);
```

Parse the recipe and assert all of the following structurally rather than only
searching its description:

- the named churn step is `parallel` with `maxConcurrency: 15` and 15 groups;
- ten client groups each contain a loop of count ten, so the computed client
  total is exactly 100;
- five control groups each target a different one of the five declared group
  ids and contain a loop of count ten;
- each client flow contains register/login, principal and instance upsert,
  client-session connect/heartbeat/disconnect/reconnect, membership and group
  presence operations, and a unique synthetic `x-forwarded-for` template;
- all five group ids occur in membership, presence, config/reconfigure, final
  dual-server read, and final topology-source-revision assertions.

- [ ] **Step 2: Confirm the prerequisite tests fail for missing support**

Run:

```bash
npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-test/recipe-matrix.test.ts
```

Expected: FAIL because `clusterOnly`, `clusterProfile`, the command planner, and
the medium-scale matrix entry/recipe do not exist. Do not begin database-write
implementation in response to this failure.

- [ ] **Step 3: Add the opt-in two-server profile runner**

Parse and validate `--cluster-profile` and `--cluster-only`. Reject
`--cluster-profile` or `--cluster-only` when no secondary port is configured,
and retain the existing rejection of a secondary port for PGlite or
`--recipes-only`. Implement the planner as:

```ts
export function toRecipeMatrixCommands(
    options: ApiV1BlackBoxOptions,
    artifactDir: string,
): readonly (readonly string[])[] {
    return [
        ...(options.clusterOnly ? [] : [toRecipeMatrixCommand(options, artifactDir)]),
        ...(options.secondaryPort === undefined
            ? []
            : [toClusterRecipeMatrixCommand(options, artifactDir)]),
    ];
}
```

Make `toClusterRecipeMatrixCommand(...)` use `options.clusterProfile`; make
`runRecipeMatrix(...)` execute the planned commands in order. Do not change the
default cluster profile or add the medium-scale recipe to it.

Add these scripts:

```json
// packages/shared-test/package.json
"bb:api-v1:postgres:medium-scale": "deno run -A black-box-runner/api-v1-black-box-run.mts --backend=postgres --secondary-port=18081 --cluster-only --cluster-profile=api-v1-black-box-medium-scale --artifact-dir=../../tmp/api-v1-black-box/postgres-medium-scale"

// package.json
"test:api-v1:black-box:postgres:medium-scale": "npm --workspace @ar-eye-hunter/shared-test run bb:api-v1:postgres:medium-scale"
```

- [ ] **Step 4: Author the 100-client/five-group recipe**

Use the existing `api-v1-state-topology-churn.json` request shapes, but create a
separate recipe instead of inflating the default 12-client case. Setup logs in
the owner, creates five open groups, activates the owner in each, and connects
the owner presence so each final group contains 101 members/presences.

The main `parallel` step has `maxConcurrency: 15`:

1. Ten named client lanes each loop ten times. Lanes alternate primary and
   secondary API servers. Every iteration registers and logs in a distinct
   identity, writes principal and instance state, connects a client session,
   races a heartbeat against an instance update through opposite servers,
   disconnects, reconnects the same session id as a new lifecycle generation,
   joins and connects presence to all five groups, and disconnects/reconnects
   presence in one lane-rotated group.
2. Give each identity a distinct RFC 1918 address such as
   `10.<lane>.<iteration>.1` in `x-forwarded-for` on register and login. This
   models independent clients and prevents the fixed per-IP auth guard from
   becoming the load target; do not raise or disable production rate-limit
   defaults. Every unexpected `429`, `5xx`, or retry-exhaustion response fails
   the recipe.
3. Stagger the order in which client lanes visit the five groups by lane index,
   so all groups churn concurrently instead of creating an accidental
   single-group thundering herd while retaining real same-row contention.
4. Five owner-authenticated control lanes, one per group, run concurrently with
   the client lanes. Each loops ten times and performs a bounded topology config
   put/delete/put generation plus `topology/reconfigure` through alternating
   servers while membership mutates the group aggregate and presence mutates
   independent session rows.

After the parallel step, use bounded polling through normal read endpoints (30
seconds maximum, increasing client-side poll interval) and assert:

- the last client from each of the ten lanes is readable through the opposite
  API server with an active principal, instance, and reconnected online session;
- each group read through the primary server has exactly `memberCount: 101` and
  `onlineMemberCount: 101`; a secondary-server read of the same group must equal
  the captured primary `GroupStateCausalRevision` and counts;
- one final reconfigure per group returns a topology snapshot whose
  source group/presence causal tuple equals that group's captured final tuple and
  whose config version is the final accepted control-lane generation;
- every effectful receipt includes its required outbox id and its observable
  snapshot/event/topology effect eventually appears; no server returns an older
  causal tuple after observing a newer one;
- all 100 register, client-state, membership, and presence flows completed. The
  recipe artifact summary is the count evidence; the matrix-shape test prevents
  silently reducing loops or lanes.

Use timeouts of at least 15 seconds per HTTP connection and 300 seconds for the
main parallel step. The bounded polling verifies eventual convergence; do not
add fixed sleeps or synchronous publication/reconfigure calls as a correctness
mechanism.

- [ ] **Step 5: Register, schema-check, and type-check the gate**

Register only the `api-v1-black-box-medium-scale` profile and run:

```bash
npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-test/recipe-matrix.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts
npm --workspace @ar-eye-hunter/shared-test run check
```

Expected: PASS; the recipe is schema-valid, the computed scale is 100 clients
and five groups, and the default api-v1 cluster command does not select the
medium-scale profile.

- [ ] **Step 6: Capture the pre-remediation PostgreSQL baseline**

Against a disposable local PostgreSQL database, run:

```bash
npm run test:api-v1:black-box:postgres:medium-scale
```

Keep the generated artifact below
`tmp/api-v1-black-box/postgres-medium-scale/` and record in the implementation
notes: run id, duration, passed/failed step counts, any HTTP status/error class,
and every available final state/config/topology revision. The run must get
through service readiness and auth setup, expand the exact 100-client/five-group
workload, start all 15 lanes, and emit an artifact without schema, harness,
preflight, auth-rate-limit, or infrastructure errors. A domain operation,
convergence, or retry-budget assertion may fail at this baseline; record the
first failing step and any unattempted final assertions against the owning DBW
finding. The failing assertion must not be relaxed or deleted.

- [ ] **Step 7: Commit the prerequisite before database-write work**

```bash
git add package.json packages/shared-test/package.json packages/shared-test/black-box-runner/api-v1-black-box-run.mts packages/shared-test/black-box-runner/recipe-matrix.json packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/shared-test/recipe-matrix.test.ts
git commit -m "test: add medium-scale api state churn gate"
```

Before proceeding, verify the commit contains no database repository or service
implementation changes and that the scale contract remains exactly 100 clients,
five groups, and 15 parallel lanes.

---

### Task 0B (Prerequisite): Measure the unmodified state-write paths

**Hard gate:** Record this baseline from the code as it exists before Task 1. The
correctness recipe in Task 0A proves cross-process behavior; this harness isolates
database mutation speed so setup, authentication, and HTTP routing do not hide a
regression.

**Files:**

- Create: `scripts/perf/api-v1-state-write-concurrency-bench.ts`
- Create: `scripts/perf/compare-api-v1-state-write-results.mjs`
- Create: `packages/tests/shared-server/state-write-performance-harness.test.ts`
- Modify: `scripts/perf/README.md`
- Modify: `package.json`

**Interfaces:**

- Produces JSON artifacts with required metadata, workload, warmup/run counts,
  p50/p95/p99 latency, throughput, accepted/conflicted/exhausted counts, attempts
  per accepted mutation, SQL statement count, rows read, serialized result bytes,
  transaction duration, PostgreSQL lock-wait time, CPU time, shared-buffer hits,
  reads, and WAL bytes.
- Produces three state-only workloads using two independent service/repository
  instances against one PostgreSQL database:
  `uncontended` = 100 clients in 100 groups,
  `shared` = 100 clients across five groups, and
  `hot` = 100 clients in one group.
- Uses one warmup and at least three measured runs per workload. Setup/seed work
  happens before each timed phase. Every generated profile remains under
  `tmp/perf/`.
- Adds root script:
  `"perf:api-v1:state-write": "deno run -A --config apps/api-v1/deno.json scripts/perf/api-v1-state-write-concurrency-bench.ts"`.

- [ ] **Step 1: Add the failing harness-contract test**

Require all three workload names, exact scale, warmup, measured-run count, all
metrics above, a schema version, git commit, backend name, and separate read,
compute, validate, write, transaction, and outbox timing buckets. Reject an
artifact that merges setup/auth time into mutation latency or omits conflicts.

- [ ] **Step 2: Confirm the harness test fails**

```bash
npx vitest run packages/tests/shared-server/state-write-performance-harness.test.ts
```

Expected: FAIL because the harness and artifact schema do not exist.

- [ ] **Step 3: Implement the direct service benchmark**

Construct the real PostgreSQL runtime-state, event, idempotency, and outbox
repositories and two independent service instances. Seed complete required
client/group data before timing. Drive a deterministic mix of profile/instance,
membership, presence connect/heartbeat/disconnect, config, and topology-source
mutations. Use the existing timing sink for phase and attempt observations and a
thin SQL instrumentation wrapper for statement/row counts. Keep benchmark
orchestration outside production services.

Run each workload with concurrency 10. Capture PostgreSQL counters immediately
before and after each measured phase. Store raw samples plus summaries; never
discard tail samples when computing percentiles.

- [ ] **Step 4: Implement the comparative gate**

`compare-api-v1-state-write-results.mjs <baseline> <candidate>` fails unless:

- uncontended p95 and p99 do not regress by more than 5%;
- shared and hot throughput do not regress, and shared throughput improves once
  presence is split from the group aggregate;
- median SQL statements, rows read, result bytes, and transaction duration do
  not increase without a recorded reason;
- retry exhaustion remains zero in uncontended/shared workloads and does not
  exceed the recorded baseline in the hot workload; and
- correctness counters show every accepted command represented by exactly one
  receipt and every effectful command by the required outbox intent(s).

The comparison is relative because machine performance varies. If the baseline
is already failing a correctness counter, preserve the sample and tie the
failure to a DBW finding; do not relax the candidate expectation.

- [ ] **Step 5: Record the pre-remediation baseline**

```bash
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --out=tmp/perf/api-v1-state-write-baseline.json
npx vitest run packages/tests/shared-server/state-write-performance-harness.test.ts
```

Record the artifact path and the three workload summaries in implementation
notes. Keep the artifact uncommitted but available until Task 10 comparison.

- [ ] **Step 6: Commit only the reusable measurement gate**

```bash
git add package.json scripts/perf/README.md scripts/perf/api-v1-state-write-concurrency-bench.ts scripts/perf/compare-api-v1-state-write-results.mjs packages/tests/shared-server/state-write-performance-harness.test.ts
git commit -m "test: measure api state write concurrency"
```

---

### Task 1: Add runtime-state conditional write primitives

**Files:**

- Modify: `packages/shared-server/runtime-state/RuntimeStateRepository.ts:1-59`
- Modify: `packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts:149-210`
- Modify: `packages/tests/shared-server/fake-runtime-state-repository.ts`
- Create: `packages/tests/shared-server/runtime-state-conditional-writes.test.ts`
- Create: `packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts`

**Interfaces:**

- Produces `RuntimeStateConditionalRepositoryLike`, `RuntimeStateOptimisticTransactionalRepositoryLike`, `RuntimeStateConditionalWriteResult`, `insertIfAbsent(...)`, `upsertIfRevision(...)`, and `deleteIfRevision(...)`.
- Later tasks consume the exact method names and `status: 'applied' | 'conflict'` result.

- [ ] **Step 1: Define the failing conditional-write contract tests**

Add focused fake-repository tests that require these exact outcomes:

```ts
expect(await repository.insertIfAbsent('state', 'key', 'v1', NEVER_EXPIRE_AT_TIMESTAMP))
    .toEqual({ status: 'applied', revision: 0 });
expect(await repository.insertIfAbsent('state', 'key', 'v2', NEVER_EXPIRE_AT_TIMESTAMP))
    .toEqual({ status: 'conflict' });
expect(await repository.upsertIfRevision('state', 'key', 'v2', NEVER_EXPIRE_AT_TIMESTAMP, 0))
    .toEqual({ status: 'applied', revision: 1 });
expect(await repository.upsertIfRevision('state', 'key', 'stale', NEVER_EXPIRE_AT_TIMESTAMP, 0))
    .toEqual({ status: 'conflict' });
expect(await repository.deleteIfRevision('state', 'key', 0))
    .toEqual({ status: 'conflict' });
expect(await repository.deleteIfRevision('state', 'key', 1))
    .toEqual({ status: 'applied' });
```

- [ ] **Step 2: Confirm the contract tests fail for missing methods**

Run:

```bash
npx vitest run packages/tests/shared-server/runtime-state-conditional-writes.test.ts
```

Expected: FAIL with `repository.insertIfAbsent is not a function` because the
fake does not implement the three conditional methods.

- [ ] **Step 3: Add the conditional repository capability**

Add these results and a separate capability so explicitly last-write-wins stores
can remain narrow while authoritative services require the intersection:

```ts
export type RuntimeStateConditionalWriteResult =
    | Readonly<{ status: 'applied'; revision: number }>
    | Readonly<{ status: 'conflict' }>;

export type RuntimeStateConditionalDeleteResult =
    | Readonly<{ status: 'applied' }>
    | Readonly<{ status: 'conflict' }>;

export type RuntimeStateConditionalRepositoryLike = Readonly<{
    insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<RuntimeStateConditionalWriteResult>;
    upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalWriteResult>;
    deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number,
    ): Promise<RuntimeStateConditionalDeleteResult>;
}>;

export type RuntimeStateOptimisticTransactionalRepositoryLike =
    & Omit<RuntimeStateTransactionalRepositoryLike, 'begin'>
    & RuntimeStateConditionalRepositoryLike
    & Readonly<{
        begin<T>(
            fn: (
                repository: RuntimeStateOptimisticTransactionalRepositoryLike,
            ) => Promise<T>,
        ): Promise<T>;
    }>;
```

Add `isRuntimeStateConditionalRepositoryLike(...)`. Keep `upsert(...)` on the
base interface only for stores whose contract is explicitly last-write-wins.
Client, group, topology, publication, and RTT constructors/services must require
the optimistic intersection before they migrate; do not silently fall back.

- [ ] **Step 4: Implement atomic Postgres predicates**

Use one SQL statement per primitive:

```sql
-- insertIfAbsent
insert into runtime_state_store (..., revision)
values (..., 0)
on conflict (store_namespace, store_key) do nothing
returning revision;

-- upsertIfRevision
update runtime_state_store
set store_value = $value,
    expire_at_ts = $expiry,
    updated_ts = now(),
    revision = revision + 1
where store_namespace = $namespace
  and store_key = $key
  and revision = $expected_revision
returning revision;

-- deleteIfRevision
delete from runtime_state_store
where store_namespace = $namespace
  and store_key = $key
  and revision = $expected_revision
returning revision;
```

Return `conflict` when `RETURNING` yields no row. Do not pre-read inside the adapter.

- [ ] **Step 5: Implement identical fake-repository semantics**

Make the fake compare the current `revision` synchronously before mutation and increment only successful updates. Add an optional test barrier hook at the repository method boundary rather than weakening the production interface.

- [ ] **Step 6: Prove two independent SQL clients cannot overwrite each other**

In the opt-in Postgres test, insert revision `0`, let two separate `PSqlRuntimeStateRepository` instances read it, update with the same expected revision, and assert exactly one returns `applied`, the other returns `conflict`, and the durable row equals the winner. Repeat for conditional delete after a refresh.

Run:

```bash
RALLAR_POSTGRES_INTEGRATION=1 npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts
```

Expected: PASS against a migrated disposable `DATABASE_URL`; if no disposable database is available, record the command as skipped and keep the fake proof passing.

- [ ] **Step 7: Run focused checks**

```bash
npx vitest run packages/tests/shared-server/runtime-state-conditional-writes.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 8: Commit the primitive**

```bash
git add packages/shared-server/runtime-state/RuntimeStateRepository.ts packages/shared-server/postgres/runtime-state/PSqlRuntimeStateRepository.ts packages/tests/shared-server/fake-runtime-state-repository.ts packages/tests/shared-server/runtime-state-conditional-writes.test.ts packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts
git commit -m "feat: add runtime state conditional writes"
```

---

### Task 2: Add bounded optimistic write support and revision-safe JSON expiry

**Files:**

- Create: `packages/shared-server/runtime-state/optimistic-runtime-state-write.ts`
- Modify: `packages/shared-server/runtime-state/RuntimeStateJsonStore.ts:20-196`
- Modify: `packages/shared-server/mod.ts`
- Modify: `packages/tests/shared-server/runtime-state-conditional-writes.test.ts`
- Create: `packages/tests/shared-server/runtime-state-optimistic-write.test.ts`

**Interfaces:**

- Produces `RuntimeStateWriteConflictError`, `RuntimeStateRetryExhaustedError`,
  `requireConditionalWrite(...)`, `DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS`, and
  `waitForRuntimeStateWriteRetry(...)`.
- Produces protected JSON helpers `putValueIfAbsent`, `putValueIfRevision`, and
  `deleteValueIfRevision`.
- Deliberately does not produce a generic transaction runner or generic mutation
  pipeline. Owning services keep their retry loops and phase calls visible.

- [ ] **Step 1: Write failing backoff and error-contract tests**

Assert `DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS` is exactly `[0, 2, 8]`, attempt
zero does not sleep, attempts one and two inject sleeps of 2 ms and 8 ms, and an
out-of-budget attempt throws. Exhaustion has HTTP status `503`, code
`runtime-state-write-conflict`, required `attempts: 3`, and the last conflict as
its cause. `requireConditionalWrite` throws only for a conditional conflict.

- [ ] **Step 2: Write the stale-expiry replacement test**

Use a test subclass exposing `getValue`. Arrange an expired revision `0`;
immediately before conditional delete, replace it with a live revision `1`.
Assert the read returns the live replacement and revision `1` remains durable.

- [ ] **Step 3: Confirm both tests fail for missing behavior**

```bash
npx vitest run packages/tests/shared-server/runtime-state-optimistic-write.test.ts packages/tests/shared-server/runtime-state-conditional-writes.test.ts
```

Expected: FAIL because the backoff/error helper and conditional JSON methods do
not exist and lazy expiry still deletes by key.

- [ ] **Step 4: Implement the small write-retry vocabulary**

Use this public shape:

```ts
export const DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS = 3;
export const DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS = [0, 2, 8] as const;

export class RuntimeStateWriteConflictError extends Error {}

export class RuntimeStateRetryExhaustedError extends Error {
    readonly status = 503;
    readonly code = 'runtime-state-write-conflict';
    readonly attempts = DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS;
}

export async function waitForRuntimeStateWriteRetry(
    attempt: 0 | 1 | 2,
    options?: Readonly<{ sleep?: (delayMs: number) => Promise<void> }>,
): Promise<number>;
```

The helper calculates/waits only; it never opens a transaction and never calls
an operation callback. Do not route this through the broad `TryWith`
abstraction: database mutation retries must restart at an explicit `read`, and
the fixed policy must remain obvious at each service call site.
`requireConditionalWrite` remains usable inside `writeX` so a failed guard rolls
back dependent rows.

- [ ] **Step 5: Implement entry-aware JSON helpers**

Serialize once and delegate to the conditional repository methods. Change lazy
expiry to conditional delete. On conflict, reread the exact key; return the live
replacement, repeat conditional cleanup for another expired revision within the
same three-attempt budget, or return absent if the row disappeared.

The base JSON store may still wrap an explicitly last-write-wins repository.
Conditional helpers must narrow with `isRuntimeStateConditionalRepositoryLike`
and fail fast when a targeted caller was wired without the capability; never
fall back to `upsert` or `deleteByKey`.

- [ ] **Step 6: Run focused checks**

```bash
npx vitest run packages/tests/shared-server/runtime-state-optimistic-write.test.ts packages/tests/shared-server/runtime-state-conditional-writes.test.ts packages/tests/shared-server/runtime-state-expiry-eviction.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit the retry foundation**

```bash
git add packages/shared-server/runtime-state/optimistic-runtime-state-write.ts packages/shared-server/runtime-state/RuntimeStateJsonStore.ts packages/shared-server/mod.ts packages/tests/shared-server/runtime-state-optimistic-write.test.ts packages/tests/shared-server/runtime-state-conditional-writes.test.ts
git commit -m "feat: add optimistic runtime state write support"
```

---

### Task 2B: Add the transaction-local mutation outbox

**Files:**

- Create: `packages/shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts`
- Create: `packages/shared-server/rallar-system/services/StateMutationOutboxWork.ts`
- Modify: `packages/shared-server/rallar-system/services/AppOutboxService.ts`
- Modify: `packages/shared-server/rallar-system/middleware/RallarMiddleware.ts`
- Modify: `packages/shared-server/rallar-system/ws-system-topics.ts`
- Modify: `packages/shared-server/mod.ts`
- Create: `packages/tests/shared-server/state-mutation-outbox.test.ts`
- Modify: `packages/tests/shared-server/app-client-inbox-service.test.ts`
- Modify: `packages/tests/shared-server/app-inbox-service.test.ts`

**Interfaces:**

- Stores a required `StateMutationOutboxRecord` in a dedicated
  `runtime_state_store` namespace through the same transactional repository as
  the domain mutation. The record contains `outboxId`, `commandHash`, kind,
  aggregate ref, accepted causal revision/tuple, exact event when present,
  required effect list, creation time, attempt metadata, and a required delivery
  state union.
- Requires every builder, delivery, and stored-record value to be JSON-roundtrip
  safe before property access, hashing, canonicalization, or persistence:
  primitives are null/string/boolean/finite numbers other than negative zero, arrays
  are dense, and objects are Object/null-prototype plain objects with enumerable
  string-keyed data properties. Reject accessors, symbols, non-enumerable
  properties, custom prototypes, cycles, and values JSON would erase or change.
- Exposes an async complete-command helper that validates JSON-safe content,
  orders object keys deterministically, and returns a lowercase
  `sha256:<64 hex>` Web Crypto digest. Outbox records accept only that tagged
  shape; finite FNV command identity is obsolete.
- Effect kinds are explicit: `client-state-sync`, `group-state-sync`,
  `group-presence-summary`, and `rtc-topology-recompute`. Add another union
  member only when a mutation has a distinct durable downstream effect.
- `StateMutationOutboxWork` reads pending intents, performs deterministic
  idempotent cache/WS/app-outbox delivery after commit, and marks delivery with
  expected-revision CAS. It never calls a domain mutation service.

- [ ] **Step 1: Write failing atomicity and delivery tests**

Cover domain-write success plus outbox-insert failure rolling back all rows;
domain guard conflict writing no outbox; duplicate `outboxId` with equal content
loading the winner; equal id with different content raising invariant corruption;
process failure after commit leaving a drainable intent; two drainers racing the
same intent; downstream enqueue failure retaining retryable state; and repeated
drain producing one deterministic WS/app outbox key.
Also cover prototype-bearing wrappers, accessors without invocation, symbol and
non-enumerable keys, Map/Set/Date, cycles, sparse arrays, bigint/function/
undefined/non-finite/negative-zero values, accepted JSON roundtrips, canonical
SHA-256 shape, reordered-key equality, semantic inequality, and equal outbox id
with a different valid digest raising invariant corruption.

- [ ] **Step 2: Confirm the outbox contract is missing**

```bash
npx vitest run packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/app-inbox-service.test.ts
```

Expected: FAIL because no transaction-local intent repository/drainer exists.
Keep the current direct AppInbox publication characterization green until its
owning client/group mutation is migrated in Tasks 3 and 4.

- [ ] **Step 3: Implement the repository without a new lock protocol**

Use conditional insert for a deterministic `outboxId` derived from command id,
aggregate ref, and accepted causal revision. Page pending rows by namespace.
Workers may observe the same row; downstream `enqueueIfAbsent` and expected-
revision delivery-state updates make duplicate processing harmless. Do not add
`FOR UPDATE`, `SKIP LOCKED`, advisory locks, or a reservation framework here.

Validate the complete plain JSON-safe graph before deriving `outboxId`,
canonicalizing effects, comparing immutable intent, or writing storage. Derive
command identity only from complete canonical command content through the async
SHA-256 helper; never accept FNV or an untagged/malformed digest.

Keep the record payload immutable across status transitions. The worker may
publish the latest causally compatible snapshot by ref/revision and the exact
event carried by the intent; it must never publish a snapshot older than the
intent. A superseding snapshot is allowed and records the delivered revision.

Keep worker delivery state readable too:
`readStateMutationOutboxDelivery`, pure
`computeStateMutationOutboxDelivery`, pure
`validateStateMutationOutboxDelivery`, idempotent downstream enqueue, then
`writeStateMutationOutboxDelivery` with expected revision. Only the final write
opens a transaction. If the delivery-state CAS conflicts after enqueue, reread;
the deterministic downstream key makes re-enqueue harmless.

- [ ] **Step 4: Wire the drainer into existing middleware work**

Reuse the current `StateSyncPublisher` and coalesced topology outbox only as
post-commit adapters. Draining must be safe after process restart and safe in two
API processes sharing PostgreSQL. Do not remove the legacy direct client/group
publish calls in this foundation commit: Task 3 removes the client path only
after client mutations write intents, and Task 4 does the same for groups. Add a
temporary characterization assertion that makes this handoff explicit and is
deleted by the owning migration rather than leaving a dual-publish path.

- [ ] **Step 5: Run focused checks**

```bash
npx vitest run packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit the outbox boundary**

```bash
git add packages/shared-server/rallar-system/repositories/StateMutationOutboxRepository.ts packages/shared-server/rallar-system/services/StateMutationOutboxWork.ts packages/shared-server/rallar-system/services/AppOutboxService.ts packages/shared-server/rallar-system/middleware/RallarMiddleware.ts packages/shared-server/rallar-system/ws-system-topics.ts packages/shared-server/mod.ts packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/app-inbox-service.test.ts
git commit -m "feat: add transactional state mutation outbox"
```

---

### Task 3: Migrate client state to principal-revision compare-and-set

**Files:**

- Modify: `packages/shared-server/rallar-system/repositories/ClientStateRepository.ts:27-386`
- Modify: `packages/shared-server/rallar-system/services/client-state-service.ts:36-1406`
- Create: `packages/shared-server/rallar-system/services/client-state-mutations.ts`
- Modify: `packages/shared-server/rallar-system/repositories/session-expiry.ts`
- Modify: `packages/shared-server/rallar-system/services/AppClientInboxService.ts`
- Modify: `packages/shared/api/client-types.ts`
- Modify: `packages/shared/api/state-types.ts`
- Modify: `packages/tests/shared-server/client-state-service-idempotency.test.ts`
- Modify: `packages/tests/shared-server/app-client-inbox-service.test.ts`
- Modify: `packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts`
- Modify: `apps/api-v1/test/services/client-state-service.test.ts`
- Create: `packages/tests/shared-server/client-state-concurrency.test.ts`

**Interfaces:**

- Consumes conditional JSON helpers, the small Task 2 backoff/error vocabulary,
  and `StateMutationOutboxRepository`.
- Produces entry-aware principal reads, conditional principal create/update,
  immutable compact idempotency receipts, atomic state-sync outbox intents, and
  generation-aware client session lifecycle.
- Produces required `ClientMutationCommand`, `ClientMutationRead`,
  `ClientMutationComputed`, `ClientMutationFacts`, and `ClientMutationReceipt`
  types. These are operation data, not a framework.
- Before legacy direct publication can be removed, each producer must construct
  and validate the complete command once, await its internally derived canonical
  SHA-256 digest before the retry loop, and carry that exact digest into both
  compact receipt and transaction-local outbox intent. No request or caller may
  supply `commandHash`.

- [ ] **Step 1: Write failing aggregate-conflict tests**

Add deterministic barriers so two service instances read the same principal revision. Cover these exact interleavings:

1. principal profile update versus instance registration;
2. two different session heartbeats on one principal;
3. heartbeat versus disconnect on one session;
4. expiry versus reconnect of the same session id;
5. two identical `requestId` mutations racing.

Assert no accepted field update disappears, `stateRevision` increases once per
accepted aggregate transition, terminal lifecycle wins over delayed work from
its generation, both idempotent callers return the same compact receipt, and
every effectful winner writes exactly one state-sync outbox intent.
Add a reordered-object-key replay that returns the same receipt/digest, and a
same-`requestId`/different-semantic-command race that returns the explicit
idempotency conflict. Assert receipt and outbox persist the identical lowercase
`sha256:<64 hex>` digest and that public mutation inputs expose no `commandHash`.

- [ ] **Step 2: Confirm the tests expose current behavior**

```bash
npx vitest run packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts
```

Expected: FAIL because principal writes are unconditional, session locking does
not guard the aggregate, generation is absent, the idempotency ledger overwrites,
and the mutation result/publication boundary is not atomic.

- [ ] **Step 3: Add entry-aware client repository operations**

Expose exact aggregate methods:

```ts
findPrincipalEntry(ref): Promise<RuntimeStateEntryValue<ClientPrincipal> | undefined>;
insertPrincipal(principal): Promise<RuntimeStateConditionalWriteResult>;
updatePrincipal(principal, expectedRevision): Promise<RuntimeStateConditionalWriteResult>;
insertIdempotentClientStateWritten(...): Promise<RuntimeStateConditionalWriteResult>;
```

Add entry-aware child and idempotency reads, but do not let repository helpers
silently start transactions. `writeClientMutation` receives a transaction-bound
repository explicitly. For update, its first statement is the principal
expected-revision CAS; for create, its first statement is the conditional
principal insert. Only a successful guard permits child, event, receipt, and
outbox inserts.

- [ ] **Step 4: Extract pure client compute and validation**

In `client-state-mutations.ts`, implement operation-local branches for
`upsertPrincipal`, `upsertInstance`, `connectSession`, `heartbeatSession`,
`disconnectSession`, authorized-WS registration/disconnect, and expiry
reconciliation. Each branch receives only a command, `ClientMutationRead`, and
required `ClientMutationFacts`. `computeClientMutation(...)` returns the exact
principal/child/event/receipt/outbox candidates or a typed no-op/replay outcome.
`validateClientMutation(...)` checks authorization, lifecycle, generation,
request hash, and invariants on both read and computed data.

Both functions are synchronous and must pass tests that call them twice with a
deep-frozen equal input and assert deep-equal output/no input mutation. Ban
repository mocks, `Date.now`, `Temporal.Now`, `crypto.randomUUID`, `Math.random`,
environment reads, and publisher calls from this module. Capture ids, timestamps,
and the complete command once as required facts. Validate/canonicalize that
command and await its internally derived SHA-256 digest before attempt zero.
Never accept a digest from request data or another caller, and never re-hash
inside a retry.

- [ ] **Step 5: Make the client service read, compute, validate, then write**

Keep one visible orchestration layer in `client-state-service.ts`:

```ts
for (let attempt = 0; attempt < DEFAULT_RUNTIME_STATE_WRITE_ATTEMPTS; attempt++) {
    const backoffMs = await waitForRuntimeStateWriteRetry(attempt, { sleep });
    const read = await readClientMutation(command);
    const computed = computeClientMutation({ command, read, facts });
    validateClientMutation({ command, read, computed });

    try {
        return await writeClientMutation({ command, read, computed });
    } catch (error) {
        if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
        timing.record({ operation, attempt, backoffMs, conflict: true });
    }
}
throw new RuntimeStateRetryExhaustedError(lastConflict);
```

`readClientMutation` loads the idempotency entry, principal entry, and only the
instance/session rows required by the command, without a transaction.
`writeClientMutation` is the only function that calls `begin`. It performs no
domain read and no snapshot reread. After its guard succeeds it writes children,
one event when effectful, the command-hash/receipt ledger, and the deterministic
state-sync outbox row. A replay/no-op may return its validated receipt without
opening a transaction.

Delete `CLIENT_SESSION_LOCK_NAMESPACE` and `lockClientSession(...)`. Record read,
compute, validate, write, transaction, conflict, attempt, and backoff timings.
After every effectful client branch writes its intent atomically, remove the
direct `AppClientInboxService.publishClientStateWritten(...)` path so the outbox
drainer is the single publication owner. Prove no dual publication and that a
committed intent survives a simulated process stop before drain.
The removal test must also prove receipt/outbox digest identity, reordered-key
replay equality, same request id/different complete canonical content conflict,
and absence of an externally supplied hash.

- [ ] **Step 6: Make connection generations causal**

Give each accepted connection a required `generationId` and required
`generationVersion`. `ConnectClientSessionRequest.generationId` identifies the
connection generation; authorized WS registration uses its concrete
`connectionId`. Heartbeat and disconnect requests carry the same required
`generationId`; expiry candidates retain the value read from the session.
The service assigns `generationVersion = (previous?.generationVersion ?? 0) + 1`
when it accepts a different generation. A request for an older generation
returns a duplicate/stale no-op and never updates timestamps or aggregate
revisions. Reconnect creates a new generation even when `sessionId` is reused.

- [ ] **Step 7: Make idempotency compact and first-writer-wins**

Store the required canonical command hash and `ClientMutationReceipt`, never a
full `ClientSnapshot`. Insert the ledger after the aggregate guard and before
commit. If insertion conflicts, throw the optimistic conflict so local writes
roll back; the next `read` loads the winner. Equal request key with a different
SHA-256 digest is an idempotency conflict. Equality is over the internally
canonicalized complete command: reordered keys compare equal while different
semantic content cannot replay. Preserve public methods that promise a snapshot
through an explicit post-commit `readClientSnapshot(...)` compatibility wrapper;
the core mutation path returns the receipt and does not reread inside the
transaction.

- [ ] **Step 8: Replace the Postgres lock-wait proof**

Rewrite the client half of `postgres-presence-expiry-concurrency.test.ts` to start two independent workers at a barrier without acquiring an advisory lock. Assert one CAS wins, the other rebases to a no-op, exactly one terminal event is durable, and a concurrent reconnect survives stale expiry.

- [ ] **Step 9: Run client validation**

```bash
npx vitest run packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/cached-state-services.test.ts
npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
deno test -A apps/api-v1/test/services/client-state-service.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit client convergence**

```bash
git add packages/shared-server/rallar-system/repositories/ClientStateRepository.ts packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/services/client-state-mutations.ts packages/shared-server/rallar-system/repositories/session-expiry.ts packages/shared-server/rallar-system/services/AppClientInboxService.ts packages/shared/api/client-types.ts packages/shared/api/state-types.ts packages/tests/shared-server/client-state-concurrency.test.ts packages/tests/shared-server/client-state-service-idempotency.test.ts packages/tests/shared-server/app-client-inbox-service.test.ts packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts apps/api-v1/test/services/client-state-service.test.ts
git commit -m "fix: make client state writes convergent"
```

---

### Task 4: Migrate group state and split the presence concurrency domain

**Files:**

- Modify: `packages/shared-server/rallar-system/repositories/GroupStateRepository.ts:27-500`
- Modify: `packages/shared-server/rallar-system/services/group-state-service.ts:54-2425`
- Create: `packages/shared-server/rallar-system/services/group-state-mutations.ts`
- Modify: `packages/shared-server/rallar-system/services/AppGroupInboxService.ts`
- Modify: `packages/shared/api/group-types.ts`
- Modify: `packages/shared/api/state-types.ts`
- Modify: `packages/tests/shared-server/group-state-service-idempotency.test.ts`
- Modify: `packages/tests/shared-server/app-inbox-service.test.ts`
- Modify: `packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts`
- Modify: `apps/api-v1/test/services/group-state-service.test.ts`
- Create: `packages/tests/shared-server/group-state-concurrency.test.ts`

**Interfaces:**

- Consumes Task 2 write support and the Task 2B mutation outbox.
- Produces conditional group creation/update for metadata, membership, capacity,
  governance, and join-code decisions; per-session generation/revision CAS for
  presence lifecycle; compact immutable receipts; and atomic outbox intents.
- Produces required `GroupMutationCommand`, `GroupMutationRead`,
  `GroupMutationComputed`, `GroupMutationFacts`, `GroupMutationReceipt`,
  `GroupPresenceSummary`, and `GroupStateCausalRevision` types.
- Before legacy direct publication/topology enqueue can be removed, each
  producer must validate/canonicalize the complete command once, await its
  internally derived SHA-256 digest before retry, and persist that exact digest
  in compact receipt and every outbox intent. No request or caller may supply
  `commandHash`.

- [ ] **Step 1: Write failing group conflict tests**

Cover simultaneous create, two joins at `maxMembers - 1`, join versus ban,
transfer ownership versus owner removal, two different presence sessions,
heartbeat versus disconnect, expiry versus reconnect, metadata/join-code
rotation, and identical request-id races. Assert all authorization/capacity
decisions use the winning predecessor, routine heartbeats never update the group
aggregate row, summaries eventually converge, receipts are compact, and every
effectful winner has the required outbox intent.
Add reordered-object-key replay equality, same-`requestId`/different-semantic-
content conflict, exact receipt/outbox digest equality, lowercase SHA-256 shape,
and a public-command assertion that no `commandHash` input is accepted.

- [ ] **Step 2: Confirm current lost-update/idempotency behavior fails**

```bash
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts
```

Expected: FAIL because group/member/session writes are unconditional, presence
rewrites the group aggregate, snapshots scan broadly, and the idempotency ledger
is last-write-wins.

- [ ] **Step 3: Add entry-aware group repository operations**

Expose `findGroupEntry`, `insertGroup`, `updateGroup(expectedRevision)`,
`findPresenceEntry`, `insertPresence`, `updatePresence(expectedRevision)`,
`deletePresence(expectedRevision)`, `findPresenceSummaryEntry`,
`updatePresenceSummary(expectedRevision)`, and conditional receipt insertion.
The group row guards metadata, membership, capacity, governance, and join-code
mutations. The targeted presence row guards connect, heartbeat, disconnect, and
expiry. Do not make presence acquire or update the group guard merely to advance
a shared revision.

- [ ] **Step 4: Extract pure group compute and validation**

In `group-state-mutations.ts`, implement explicit branches for creation,
metadata/status, director appointment, join/invite/revoke/accept, join-code
rotation, remove/ban/unban, role, ownership, member upsert, presence lifecycle,
expiry, and presence-summary convergence. `computeGroupMutation(...)` and
`validateGroupMutation(...)` are synchronous and deterministic. Test deep-frozen
inputs twice for equal output and no mutation. Ban repository/time/random/id/
publisher access. Construct the complete command, validate/canonicalize it, and
await its internal SHA-256 digest once before attempt zero. Facts carry that
digest unchanged; no request/external caller supplies it and no retry re-hashes.

- [ ] **Step 5: Make the group service read, compute, validate, then write**

Use the same visible loop shape as Task 3, named
`readGroupMutation`, `computeGroupMutation`, `validateGroupMutation`, and
`writeGroupMutation`. `read` runs outside a transaction and loads only the group,
policy-relevant members, target presence/summary, and receipt needed by the
command. `write` alone opens the transaction and performs no domain read.

For group-guarded commands, the first statement is conditional group insert/CAS;
for presence commands, it is conditional target-session insert/CAS/delete. After
the guard succeeds, write dependent member/join-code rows, one event, compact
command-hash/receipt record, and all state-sync/presence-summary/topology outbox
intents. No full snapshot reread occurs inside `write`.

For creation, group insert is the first statement, followed by owner/member,
event, receipt, and outbox rows. A losing create rolls back and restarts at
`read`. Record phase, transaction, attempt, conflict, and backoff timings.
After all group branches write intents, remove direct
`AppGroupInboxService.publishGroupMutation(...)` publication and topology
enqueue. The transaction-local outbox drainer becomes the single owner; tests
must fail on duplicate direct-plus-drained delivery.
The removal gate also proves identical internally derived receipt/outbox
digests, reordered-key replay equality, same request id/different complete
canonical content conflict, and absence of an externally supplied hash.

- [ ] **Step 6: Make presence generations causal and independently writable**

Persist required `generationId` and `generationVersion` on
`GroupPresenceSession`. Connect, heartbeat, and disconnect requests carry the
required client connection `generationId`; accepted connect assigns the next
generation version. Pass both fields through app-inbox state and expiry work.
Ignore delayed work for older generations. Delete
`GROUP_PRESENCE_SESSION_LOCK_NAMESPACE` and `lockGroupPresenceSession(...)`.

`GroupPresenceSession` has required storage and lifecycle generations. A
heartbeat that changes only expiry/last-seen conditionally updates this session
row and emits a coalescible `group-presence-summary` intent; it does not rewrite
the group row, member row, or a full snapshot ledger value.

Treat the session as liveness only. Compute/validate against the member/group
state read for the attempt, carry their observed revisions in the receipt and
intent, and have every snapshot/routing/topology read filter sessions through
the latest active membership and group policy. A concurrent ban/removal may win
immediately after a heartbeat read, but the heartbeat cannot grant authority or
survive the next summary; the membership mutation also enqueues summary work.

- [ ] **Step 7: Converge the group presence summary asynchronously**

The outbox worker reads the latest group aggregate and active generation from
all relevant presence rows outside a transaction, computes a deterministic
`GroupPresenceSummary`, validates it, then opens a short transaction to CAS only
the summary row and write a topology-recompute outbox intent. On conflict it
backs off and restarts at `read`. The summary carries required active principal
ids/counts plus `GroupStateCausalRevision = { groupRevision, presenceRevision }`.
Membership changes also enqueue summary work so the tuple eventually reflects
both domains.

Group/topology reads are permissive and optimistic: they may temporarily observe
an older valid summary, but never publish a tuple older than an already observed
tuple. Equal tuple/different content is invariant corruption. Task 0A final
assertions poll boundedly for convergence instead of assuming read-your-write
for asynchronous presence summaries.

- [ ] **Step 8: Make receipts compact and first-writer-wins**

Store canonical command hash plus `GroupMutationReceipt`, never a full
`GroupSnapshot`. Equal request id/different digest is an idempotency conflict.
The digest is internally derived canonical SHA-256: reordered object keys match,
different semantic content conflicts, and producer inputs expose no
caller-controlled `commandHash`.
Compatibility APIs needing a snapshot perform an explicit post-commit read.

- [ ] **Step 9: Replace the group Postgres lock proof**

Rewrite the group half of `postgres-presence-expiry-concurrency.test.ts` to
assert CAS conflict/rebase and one terminal event without advisory-lock
orchestration. Add a capacity race proving two servers cannot both accept the
last membership slot and a 100-client heartbeat case proving presence sessions
advance without conflicts on the group aggregate.

- [ ] **Step 10: Run group validation**

```bash
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/group-state-snapshot-read-through-cache.test.ts packages/tests/shared-server/cached-state-services.test.ts
npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
deno test -A apps/api-v1/test/services/group-state-service.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit group convergence**

```bash
git add packages/shared-server/rallar-system/repositories/GroupStateRepository.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/services/group-state-mutations.ts packages/shared-server/rallar-system/services/AppGroupInboxService.ts packages/shared/api/group-types.ts packages/shared/api/state-types.ts packages/tests/shared-server/group-state-concurrency.test.ts packages/tests/shared-server/group-state-service-idempotency.test.ts packages/tests/shared-server/app-inbox-service.test.ts packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts apps/api-v1/test/services/group-state-service.test.ts
git commit -m "fix: make group state writes convergent"
```

---

### Task 5: Make topology config and override updates monotonic without compensation

**Files:**

- Modify: `packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts:1-85`
- Modify: `packages/shared-server/rallar-system/services/group-topology-management-service.ts:164-665`
- Create: `packages/shared-server/rallar-system/services/group-topology-config-mutations.ts`
- Modify: `packages/tests/shared-server/group-topology-config-repository.test.ts`
- Modify: `packages/tests/shared-server/group-topology-management-service.test.ts`

**Interfaces:**

- Produces `commitConfig`, `deleteConfig(expectedRevision)`, `commitOverride`, and `deleteOverride(expectedRevision)` with accepted/conflict results.
- Produces immutable `GroupTopologyConfigMutationRecord` claims keyed by scoped
  group and `requestId`, covering put and delete for both durable config and
  temporary override.
- Produces compact `GroupTopologyConfigMutationReceipt` and a deterministic
  `rtc-topology-recompute` mutation-outbox intent in the same transaction.
- Config put/delete/override mutations return after commit. The explicit
  `/topology/reconfigure` operation remains synchronous and is the only caller
  that waits for a topology result.

- [ ] **Step 1: Write failing concurrent config tests**

Use two management services sharing a fake repository and a barrier. Assert
concurrent puts receive distinct monotonic versions, a stale delete cannot
remove a newer put, expired override cleanup cannot delete a refreshed override,
two callers with one `requestId` load one receipt, accepted mutations write a
recompute intent, and downstream reconfigure failure cannot restore or clobber
an accepted config.

- [ ] **Step 2: Confirm the current restore behavior fails**

```bash
npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
```

Expected: FAIL on stale version overwrite or compensating restore clobber.

- [ ] **Step 3: Implement explicit config read, compute, validate, and write**

Add `readTopologyConfigMutation`, pure `computeTopologyConfigMutation`, pure
`validateTopologyConfigMutation`, and `writeTopologyConfigMutation`. The read
loads config/override entries and idempotency receipt without a transaction.
Compute derives `version = current.version + 1`, normalized effective config,
receipt, and recompute intent from explicit facts. Validation checks scope,
expiry, command hash, and configuration invariants. Write alone opens the
transaction, applies conditional insert/update/delete first, then inserts the
receipt and recompute outbox row without rereading.

Keep the three-attempt `[0, 2, 8]` ms retry loop visible in
`group-topology-management-service.ts`; every conflict restarts at `read`.
Add deterministic purity tests and phase/attempt timing as in Tasks 3-4.

- [ ] **Step 4: Remove compensating restore and synchronous side effects**

Delete `restoreConfig(...)` and `restoreOverride(...)`. Once a config CAS is
accepted, it remains durable. Do not call topology recomputation, cache
publication, or the coalesced AppOutbox from the mutation service. Return the
accepted receipt immediately; `StateMutationOutboxWork` converts the committed
intent into retryable/coalesced recompute work. A worker failure changes only
outbox delivery state and never mutates config again.

- [ ] **Step 5: Make delete and expiry conditional**

Delete only the observed storage revision. A conflict rolls back receipt/outbox
rows and restarts at read: absent becomes idempotent success, while a newer row
is recomputed/revalidated. Exhausted churn returns the typed 503 conflict.

- [ ] **Step 6: Make config request ids immutable**

When `requestId` is present, compute a canonical hash of mutation kind,
`groupRef`, normalized config, and requested expiry. Conditionally insert a
`GroupTopologyConfigMutationRecord` containing the compact receipt in the same
transaction as config and outbox. On conflict, roll back, reload, and return the
winner's accepted version/generation. Equal request id with a different canonical hash
throws `GroupTopologyConfigIdempotencyConflictError`; it never advances config.

- [ ] **Step 7: Run focused checks**

```bash
npx vitest run packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/group-topology-config-service.test.ts packages/tests/shared-server/state-mutation-outbox.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
deno test -A apps/api-v1/test/routes/graph-topology-routes.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit config convergence**

```bash
git add packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts packages/shared-server/rallar-system/services/group-topology-management-service.ts packages/shared-server/rallar-system/services/group-topology-config-mutations.ts packages/tests/shared-server/group-topology-config-repository.test.ts packages/tests/shared-server/group-topology-management-service.test.ts
git commit -m "fix: converge group topology configuration"
```

---

### Task 6: Replace topology, publication, and RTT advisory locks with CAS

**Files:**

- Modify: `packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts:1-183`
- Modify: `packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts:1-140`
- Modify: `packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts:1-130`
- Modify: `packages/shared-server/rallar-system/repositories/RtcRttRepository.ts:1-210`
- Modify: `packages/shared-server/rallar-system/services/group-topology-management-service.ts:520-600`
- Create: `packages/shared-server/rallar-system/services/rtc-topology-mutations.ts`
- Modify: `packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts`
- Modify: `packages/tests/shared-server/rtc-topology-outbox-work.test.ts`
- Modify: `packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts`
- Modify: `packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts`

**Interfaces:**

- Preserves existing topology commit result statuses: `committed`, `loaded`, `retry`, and `superseded`.
- Produces immutable publication/work claims through conditional insert,
  measurement acceptance through expected revision, and transaction-local
  publication/recompute outbox intents.
- Uses explicit topology/RTT `read`, pure `compute`, pure `validate`, and
  write-only `write` operations; repository classes expose data access and do
  not own hidden retry loops.

- [ ] **Step 1: Write failing no-lock topology tests**

Instrument the fake repository so `lockKey` throws if called. Cover two planners with the same predecessor, two publications for the same `workId`, stale topology removal, equal-tuple/different-content corruption, and newer RTT versus stale RTT. Assert the existing causal result statuses and final durable values.

- [ ] **Step 2: Write the endpoint-cap conflict test**

Race two measurements that would jointly exceed the endpoint degree cap. Both initially observe capacity; exactly one conditional endpoint-admission transition wins; the loser rereads the admitted set and returns `accepted: false` without persisting its measurement.

- [ ] **Step 3: Confirm current code calls locks**

```bash
npx vitest run packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts
```

Expected: FAIL because snapshot, publication, execution, and RTT repositories call `lockKey`.

- [ ] **Step 4: CAS topology snapshots**

Implement `readTopologyMutation`, pure `computeTopologyMutation`, pure
`validateTopologyMutation`, and `writeTopologyMutation`. Read the predecessor,
publication/work claims, required config, and required group/presence causal
tuple outside a transaction. Compute uses existing causal decision functions.
Validation rejects equal tuple/different content before write. For absent
predecessor, write conditionally inserts the candidate; otherwise its first
statement updates only the observed storage revision. `conflict` restarts the
whole flow; a newer durable tuple computes `superseded` on the next attempt.

- [ ] **Step 5: Make publication claims immutable**

After the topology guard succeeds, conditionally insert the
`workId -> publicationId` index, deterministic publication record, compact
receipt, and state-sync mutation-outbox intent in the same transaction. A loser
rolls back, waits, restarts at read, validates the indexed winner, and computes
`loaded`. Never overwrite either immutable record.

- [ ] **Step 6: Make execution atomic without locks**

Keep the orchestration loop visible in
`group-topology-management-service.ts`: `readTopologyMutation`,
`computeTopologyMutation`, `validateTopologyMutation`,
`writeTopologyMutation`, with `[0, 2, 8]` ms backoff. `write` alone opens the
transaction, performs no domain read, and throws
`RuntimeStateWriteConflictError` on any conditional conflict so snapshot,
publication, receipt, and outbox rows roll back together. It returns the compact
computed status/receipt directly; it does not reread inside the transaction.

- [ ] **Step 7: CAS RTT latest values and endpoint admission**

Add `readRttMutation`, pure `computeRttMutation`, pure
`validateRttMutation`, and `writeRttMutation` using the same visible retry loop.
For the measurement row, compute rejection when a current version is greater
than or equal to incoming. Add deterministic per-endpoint admission records.
Write conditionally updates both endpoint records in lexical order, then the
measurement, receipt, and recompute outbox intent atomically. Lexical order is
statement order for predictable short transactions, not a lock protocol. A
conflict rolls back, backs off, and rereads all endpoint policy inputs.

Purity tests call every topology/RTT compute and validate branch twice with
deep-frozen inputs. Timing records phase durations, SQL counts, transaction
duration, attempts, conflicts, and backoff.

- [ ] **Step 8: Remove targeted lock methods and assertions**

Delete `withSnapshotLock`, publication work-index locking, topology execution lock sorting, `withMeasurementLock`, and `withEndpointPairLock`. Rename `it('locks RTT endpoints ...')` to assert optimistic endpoint-cap convergence. Leave `RuntimeStateTransactionalRepositoryLike.lockKey` only while out-of-scope auth ticket code still consumes it; record that residual in Task 10.

- [ ] **Step 9: Run topology validation**

```bash
npx vitest run packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts packages/tests/shared-server/group-topology-management-service.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/rtc-topology-cluster-transport.test.ts packages/tests/shared-web/data-caches.test.ts
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
```

Expected: PASS and no targeted repository invokes `lockKey`.

- [ ] **Step 10: Commit topology convergence**

```bash
git add packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts packages/shared-server/rallar-system/repositories/RtcRttRepository.ts packages/shared-server/rallar-system/services/group-topology-management-service.ts packages/shared-server/rallar-system/services/rtc-topology-mutations.ts packages/tests/shared-server/rtc-topology-runtime-state-repositories.test.ts packages/tests/shared-server/rtc-topology-outbox-work.test.ts packages/tests/shared-server/ws-system-topics-rtc-topology.test.ts packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts
git commit -m "fix: replace topology locks with optimistic commits"
```

---

### Task 7: Harden authoritative shared contracts and OpenAPI

**Files:**

- Modify: `packages/shared/api/client-types.ts:1-171`
- Modify: `packages/shared/api/group-types.ts:1-154`
- Modify: `packages/shared/api/state-types.ts:1-211`
- Modify: `packages/shared/api/api-config.ts:117-130`
- Modify: `packages/shared/api/overlay-topology.ts:1-55`
- Modify: `packages/shared/api/graph-topology-management-types.ts:1-138`
- Modify: `packages/shared/al-contracts/al-contract.ts`
- Modify: `apps/api-v1/resources/api-v1-openapi.yaml:3515-4690`
- Create: `packages/tests/shared/authoritative-state-contracts.test.ts`
- Modify: `packages/tests/shared-web/rallar-group-docs-compat.test.ts`
- Modify: affected client/group/topology fixtures under `packages/tests/**` and `apps/api-v1/test/**`

**Interfaces:**

- Produces mandatory `workspaceId`, actor identity, lifecycle generation,
  command hash, mutation receipt, causal revision, outbox effect, and overlay
  fields on authoritative values.
- Defines `GroupStateCausalRevision` with required `groupRevision` and
  `presenceRevision`. Group snapshots and topology source metadata use this same
  tuple. Comparison is componentwise causal dominance; incomparable tuples
  trigger reread/recompute, and equal tuple/different content is corruption.
- Keeps `MutationActorInput`, request/query types,
  `GroupTopologyConfigPatch`, and explicit builders sparse. Optional fields on
  authoritative outputs require an individual documented exception in the
  type-level allowlist.

- [ ] **Step 1: Add failing type-level optional-key assertions**

Use this helper:

```ts
type EmptyObject = Record<never, never>;
type OptionalKeys<T> = {
    [K in keyof T]-?: EmptyObject extends Pick<T, K> ? K : never;
}[keyof T];

expectTypeOf<OptionalKeys<ClientScope>>().toEqualTypeOf<never>();
expectTypeOf<OptionalKeys<GroupScope>>().toEqualTypeOf<never>();
expectTypeOf<OptionalKeys<ClientMutationReceipt>>().toEqualTypeOf<never>();
expectTypeOf<OptionalKeys<GroupMutationReceipt>>().toEqualTypeOf<never>();
expectTypeOf<OptionalKeys<GroupStateCausalRevision>>().toEqualTypeOf<never>();
expectTypeOf<OptionalKeys<RallarOverlayTopologySnapshot>>().toEqualTypeOf<never>();
expectTypeOf<OptionalKeys<OverlayInfo>>().toEqualTypeOf<never>();
```

Add positive assertions that patch/request optionality remains, for example `OptionalKeys<GroupTopologyConfigPatch>` equals its five patch keys.

- [ ] **Step 2: Confirm authoritative assertions fail**

```bash
npx tsc -p packages/tests/tsconfig.json --noEmit
```

Expected: FAIL in `authoritative-state-contracts.test.ts` because
`OptionalKeys<ClientScope>`, `OptionalKeys<GroupScope>`, and
`OptionalKeys<OverlayInfo>` are not `never`.

- [ ] **Step 3: Make scope and actor fields explicit**

Make `workspaceId` required on `ClientScope`, `GroupScope`, AL scoped targets, and stored topology values. Replace optional authoritative actor objects with a discriminated actor:

```ts
export type MutationActor =
    | Readonly<{ kind: 'principal'; principalId: PrincipalId }>
    | Readonly<{ kind: 'session'; sessionId: SessionId; principalId: PrincipalId }>
    | Readonly<{ kind: 'service'; serviceId: string }>;
```

Authoritative `AuditStamp`, `ClientEvent`, and `GroupEvent` require `actor`, `reason`, `traceId`, `requestId`, and `payload`; represent absence as `null`, not omitted fields.

- [ ] **Step 4: Model lifecycle states without partial objects**

Use discriminated unions for active versus terminal client sessions, group presence, principal status, instance status, group status, and member status. Every variant includes the fields needed to interpret it, including required generation identity; fields that truly do not apply are required `null` only when a union would duplicate excessive structure.

- [ ] **Step 5: Make authoritative result fields mandatory**

Change response/event result optionals such as `event?`, `previous?`, `snapshot?`, `durable?`, and `temporary?` to either a discriminated result variant or required nullable field. Make `OverlayInfo.groupRef`, `topology`, and `degreeLimit` required because `toOverlayInfoForSession(...)` always supplies them. Keep `GroupTopologyConfigPatch`, request overrides, query filters, and builder inputs optional by documented omission semantics.

Define compact required client, group, config, topology, and RTT mutation
receipts. Each receipt includes command/request id, command hash, aggregate ref,
accepted/replayed/no-op status, attempt count, accepted causal/storage revision,
event id or required `null`, and outbox id(s). Do not include member/session
arrays or a full snapshot.

- [ ] **Step 6: Coordinate the group/presence causal tuple**

Replace scalar-only assumptions across `GroupSnapshot`, group events, topology
source metadata, browser cache monotonicity, OpenAPI, and fixtures with the
required `GroupStateCausalRevision`. Preserve numeric `snapshotVersion` only for
its existing event-stream semantic version; do not reuse it as a storage CAS
token. Dominance tests cover older, newer, equal, and incomparable tuples.

- [ ] **Step 7: Update every producer before consumers**

Update service constructors, event factories, repository deserializers, AL builders, topology conversion, API route mapping, browser caches/facades, and test fixtures. Do not add `as`, non-null assertions, or fallback defaults merely to satisfy the stricter types; populate the authoritative value at its boundary.

- [ ] **Step 8: Align OpenAPI required and nullable declarations**

For every hardened schema, put mandatory property names in `required`. Use `nullable: true` for required nullable values and `oneOf` with a discriminator for lifecycle variants. Update docs compatibility tests to compare TypeScript-required fields with OpenAPI-required fields for client, group, event, snapshot, and topology schemas.

- [ ] **Step 9: Run contract validation**

```bash
npx vitest run packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/shared-web/rallar-group-docs-compat.test.ts packages/tests/shared-web/data-caches.test.ts packages/tests/shared-web/api-workflows.test.ts
npx tsc -p packages/tests/tsconfig.json --noEmit
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
deno test -A apps/api-v1/test/services/client-state-service.test.ts apps/api-v1/test/services/group-state-service.test.ts apps/api-v1/test/routes/graph-topology-routes.test.ts
```

Expected: PASS with no authoritative optional-key exceptions beyond an explicit test allowlist whose entries each name their semantic absence.

- [ ] **Step 10: Commit contract hardening**

```bash
git add packages/shared/api/client-types.ts packages/shared/api/group-types.ts packages/shared/api/state-types.ts packages/shared/api/api-config.ts packages/shared/api/overlay-topology.ts packages/shared/api/graph-topology-management-types.ts packages/shared/al-contracts/al-contract.ts apps/api-v1/resources/api-v1-openapi.yaml packages/tests/shared/authoritative-state-contracts.test.ts packages/tests/shared-web/rallar-group-docs-compat.test.ts packages/tests apps/api-v1/test
git commit -m "refactor: require authoritative state fields"
```

Before committing, inspect `git diff --cached --name-only` and unstage any file that was not changed for this task; do not stage unrelated test changes.

---

### Task 8: Add multi-process and black-box convergence acceptance

**Files:**

- Modify: `packages/tests/shared-server/fixtures/postgres-expiry-worker.ts`
- Modify: `packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts`
- Modify: `packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts`
- Create: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-write-convergence.json`
- Modify: `packages/shared-test/black-box-runner/recipe-matrix.json`
- Modify: `packages/tests/shared-test/recipe-matrix.test.ts`
- Verify without weakening: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-medium-scale-churn.json`

**Interfaces:**

- Consumes the public REST/WS state APIs and a disposable multi-server Postgres profile.
- Consumes the mandatory Task 0A correctness and Task 0B performance baselines unchanged.
- Produces focused race acceptance plus medium-scale evidence that no lock scheduling assumption is needed.

- [ ] **Step 1: Extend the worker protocol with barrier-controlled commands**

Support client heartbeat/disconnect/reconnect, group join/ban/presence, and
topology config put/delete commands. Every response reports the compact receipt:
request id/hash, attempt count, accepted causal/storage revision, outbox ids,
and domain status; it never exposes database credentials.

- [ ] **Step 2: Add deterministic two-process repository tests**

Run independent Deno workers and release each operation from the same barrier.
Prove one conditional transition wins, the loser backs off then rereads,
recomputes, and revalidates; retry attempts remain at or below three; no sleep
occurs inside a transaction; and final state contains all non-conflicting
accepted changes plus one drainable intent per effectful mutation.

- [ ] **Step 3: Author the black-box recipe**

The recipe creates two clients through different API servers, creates one
bounded-capacity group, races membership and presence transitions, races a
config put/delete/put generation, reconnects one reused session id, lets the old
expiry candidate run, then reads through both servers. Use bounded polling for
eventual presence-summary/outbox convergence. Assertions require identical final
`GroupStateCausalRevision`, membership, active generation, topology config
version, topology source tuple, delivered mutation-outbox effects, and no stale
snapshot after a newer tuple has been observed.

- [ ] **Step 4: Register and schema-check the recipe**

Add the recipe to the api-v1 Postgres matrix beside the existing topology convergence and churn recipes. Validate schema and manifest generation without starting services.

- [ ] **Step 5: Run local and full-stack acceptance**

```bash
npx vitest run packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts
npx vitest run packages/tests/shared-test/recipe-matrix.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:rallar:full-stack:postgres:live-rtc-3
```

Expected: focused tests and the unmodified 100-client/five-group medium-scale
gate PASS with zero `429`, `5xx`, retry-exhaustion, count, revision, or topology
assertion failures. Compare its artifact with the Task 0A baseline and report the
change in duration, failed steps, and final revisions. The full-stack run PASSes
when disposable Postgres, three API nodes, and browser prerequisites are
available; otherwise record it as skipped with the missing prerequisite.

- [ ] **Step 6: Commit acceptance coverage**

```bash
git add packages/tests/shared-server/fixtures/postgres-expiry-worker.ts packages/tests/shared-server/postgres-presence-expiry-concurrency.test.ts packages/tests/shared-server/postgres-runtime-state-concurrency.test.ts packages/shared-test/black-box-runner/tests/api-v1/api-v1-state-write-convergence.json packages/shared-test/black-box-runner/recipe-matrix.json packages/tests/shared-test/recipe-matrix.test.ts
git commit -m "test: prove api state write convergence"
```

Before committing, restrict the staged shared-test files to the recipe registry/matrix changes actually needed.

---

### Task 9: Reconcile implemented architecture, skills, and repository guidance

**Files:**

- Modify: `AGENTS.md`
- Modify: `.agents/skills/rallar-platform/SKILL.md`
- Modify: `.agents/skills/rallar-realtime/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/SKILL.md`
- Modify: `.agents/skills/rallar-code-writing/references/package-code-style.md`
- Modify: `.agents/skills/rallar-testing/SKILL.md`
- Modify: `.agents/skills/rallar-testing/references/test-commands.md`
- Modify: `.agents/skills/performance-analysis/SKILL.md`
- Modify: `docs/rallar-convergent-state-and-rtc-topology.md`
- Modify: `packages/shared-server/architecture.md`
- Modify: `packages/shared-server/rallar-server-repositories.md`
- Modify: `packages/shared-server/rallar-server-repositories-improvements.md`
- Create: `packages/tests/shared-server/read-compute-write-contract.test.ts`
- Modify: `packages/tests/repo/rallar-skill-integrity.test.ts`

**Interfaces:**

- Consumes the prerequisite baselines and implemented method names/test evidence from Tasks 0A-8.
- Produces durable instructions that keep readable read/compute/validate/write,
  deterministic computation, write-only short transactions, atomic outboxes,
  bounded increasing-backoff CAS retries, concurrency-domain selection,
  performance gates, lock exceptions, and mandatory authoritative fields as
  repository invariants.

- [ ] **Step 1: Update the architecture document from target to implemented behavior**

Replace statements that label client/group/topology locks as current migration
debt with the exact implemented phase names, CAS commit path, `[0, 2, 8]` ms
backoff, receipt/outbox boundary, and retry error codes. In
`packages/shared-server/architecture.md`, replace the explicit statement that a
transactional state-sync outbox is deferred: this plan is the reviewed decision
to implement it. Keep the historical note that lock-based implementations and
pre-outbox publication ordering must not be copied. Add measured repository/SQL
call counts and transaction duration from focused tests, not estimates.

- [ ] **Step 2: Update repository inventories**

Document conditional runtime-state capabilities, aggregate versus per-session
guard selection, lifecycle generation, group/presence causal tuple, compact
idempotency receipts, transaction-local mutation outbox, async publication and
recompute, topology publication atomicity, and any residual lock outside this
plan. Clearly separate current implementation from historical status sections.

- [ ] **Step 3: Strengthen integrity assertions with actual symbols**

In addition to existing doctrine assertions, require docs/skills to name
`read`, `compute`, `validate`, `write`, `insertIfAbsent`, `upsertIfRevision`,
`deleteIfRevision`, `DEFAULT_RUNTIME_STATE_WRITE_BACKOFF_MS`,
`waitForRuntimeStateWriteRetry`, `RuntimeStateRetryExhaustedError`,
`StateMutationOutboxRepository`, `MutationReceipt`, and
`GroupStateCausalRevision`. Require explicit statements that compute/validate
are pure; only write opens the transaction; the guard is first; outbox rows are
atomic; conflict restarts at read; presence does not contend on the group row;
and authoritative shared fields are mandatory except documented input or
migration exceptions. Assert no targeted repository contains `.lockKey(`.

Add `read-compute-write-contract.test.ts` as an implementation guard. For every
targeted operation, assert the service orchestration contains one shallow call
sequence in source order: `readX`, `computeX`, `validateX`, `writeX`; only
`writeX` owns `begin`; conditional guard source precedes dependent/event/
receipt/outbox writes; pure modules contain none of the forbidden ambient or
repository APIs; and every effectful computed variant is exhaustively matched to
an outbox insert. Prefer a small explicit operation manifest in the test over a
generic source crawler so failures name the missing operation.

Update `rallar-testing` and its command reference so future api-v1 client,
group, topology, runtime-state, or database-concurrency work must run
`npm run test:api-v1:black-box:postgres:medium-scale` after focused tests. State
that the gate means 100 independently authenticated clients, five groups, two
Postgres-backed API processes, ten client lanes plus five control lanes, and
that an agent must never reduce those constants to make a change pass. Also
require `npm run perf:api-v1:state-write` plus the comparative result gate for a
mutation-path or concurrency-domain change. Extend
`rallar-skill-integrity.test.ts` to require the vocabulary, ordering, purity,
outbox, required-field, scale, and performance doctrines.

- [ ] **Step 4: Run guidance validation**

```bash
npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
npx vitest run packages/tests/shared-server/read-compute-write-contract.test.ts
rg -n "lockKey\(" packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts packages/shared-server/rallar-system/repositories/RtcRttRepository.ts
```

Expected: Vitest PASS; `rg` exits `1` with no matches.

- [ ] **Step 5: Commit durable guidance**

```bash
git add AGENTS.md .agents/skills/rallar-platform/SKILL.md .agents/skills/rallar-realtime/SKILL.md .agents/skills/rallar-code-writing/SKILL.md .agents/skills/rallar-code-writing/references/package-code-style.md .agents/skills/rallar-testing/SKILL.md .agents/skills/rallar-testing/references/test-commands.md .agents/skills/performance-analysis/SKILL.md docs/rallar-convergent-state-and-rtc-topology.md packages/shared-server/architecture.md packages/shared-server/rallar-server-repositories.md packages/shared-server/rallar-server-repositories-improvements.md packages/tests/shared-server/read-compute-write-contract.test.ts packages/tests/repo/rallar-skill-integrity.test.ts
git commit -m "docs: codify convergent database writes"
```

---

### Task 10: Run the final architecture, speed, and regression gates

**Files:**

- Modify only if a gate finds a defect: files already listed in Tasks 0A-9
- Record residual out-of-scope locks in: `packages/shared-server/rallar-server-repositories.md`

**Interfaces:**

- Produces final evidence and an explicit residual-risk list.

- [ ] **Step 1: Audit targeted database writes**

```bash
rg -n "\.upsert\(|deleteByKey\(|lockKey\(" packages/shared-server/rallar-system/services/client-state-service.ts packages/shared-server/rallar-system/services/group-state-service.ts packages/shared-server/rallar-system/repositories/ClientStateRepository.ts packages/shared-server/rallar-system/repositories/GroupStateRepository.ts packages/shared-server/rallar-system/repositories/GroupTopologyConfigRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologySnapshotRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyPublicationRepository.ts packages/shared-server/rallar-system/repositories/RtcTopologyExecutionRepository.ts packages/shared-server/rallar-system/repositories/RtcRttRepository.ts
```

Expected: no unconditional authoritative write or lock call. Explicit last-write-wins methods outside the targeted paths must have a documented contract.

- [ ] **Step 2: Audit all remaining database locks**

```bash
rg -n "FOR UPDATE|SKIP LOCKED|pg_advisory|lockKey\(" packages/shared-server apps/api-v1
```

Expected: queue claiming and auth-ticket consumption may remain as explicitly listed out-of-scope findings; no client, group, topology, publication, or RTT result remains. Create a separate reviewed plan before changing queue coordination semantics.

- [ ] **Step 3: Audit authoritative optional fields**

```bash
rg -n "\?:" packages/shared/api/client-types.ts packages/shared/api/group-types.ts packages/shared/api/overlay-topology.ts packages/shared/api/api-config.ts packages/shared/api/graph-topology-management-types.ts packages/shared/al-contracts/al-contract.ts
```

Expected: every match is an input/query/patch/builder/migration field or appears in the explicit semantic-absence allowlist exercised by `authoritative-state-contracts.test.ts`.

- [ ] **Step 4: Audit phase boundaries, determinism, and outboxes**

```bash
rg -n "read(Client|Group|Topology|Rtt)Mutation|compute(Client|Group|Topology|Rtt)Mutation|validate(Client|Group|Topology|Rtt)Mutation|write(Client|Group|Topology|Rtt)Mutation" packages/shared-server/rallar-system/services
! rg -n "Date\.now|Temporal\.Now|Math\.random|randomUUID|\.begin\(|repository" packages/shared-server/rallar-system/services/client-state-mutations.ts packages/shared-server/rallar-system/services/group-state-mutations.ts packages/shared-server/rallar-system/services/group-topology-config-mutations.ts packages/shared-server/rallar-system/services/rtc-topology-mutations.ts
rg -n "StateMutationOutboxRepository|insert.*Outbox|outboxId" packages/shared-server/rallar-system/services packages/shared-server/rallar-system/repositories
```

Expected: the ordering test/integrity test proves each targeted service visibly
invokes read, compute, validate, write; pure mutation modules contain no ambient
fact, repository, or transaction access; and every effectful `write` branch has
an atomic outbox insert. Manually inspect that `begin(...)` occurs only inside
named `writeX` functions, the conditional guard precedes dependent inserts, and
no retry delay occurs in the transaction.

Task 6 intentionally treats graph planning as attempt-local read preparation:
each attempt first loads all authoritative group, config, RTT, predecessor, and
publication facts and captures time, then derives the graph candidate from only
those frozen facts before recording the read phase. The named database mutation
`computeTopologyMutation` and `validateTopologyMutation` phases remain pure and
synchronous. Future work must not move repository, clock, cache-observation, or
other ambient access into those compute/validate phases. Extracting graph
planner metrics into a separately pure planner is a possible later refactor,
not permission to weaken this boundary.

- [ ] **Step 5: Run focused and package suites**

```bash
npx vitest run packages/tests/shared-server packages/tests/api-v1 packages/tests/shared packages/tests/shared-web packages/tests/repo/rallar-skill-integrity.test.ts
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
deno test -A apps/api-v1/test
```

Expected: PASS with zero failed tests and zero type errors.

- [ ] **Step 6: Run and compare the candidate performance profile**

```bash
npm run perf:api-v1:state-write -- --backend=postgres --warmup=1 --runs=3 --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs tmp/perf/api-v1-state-write-baseline.json tmp/perf/api-v1-state-write-candidate.json
```

Expected: PASS for every Task 0B relative budget. Report p50/p95/p99,
throughput, conflicts, attempts, SQL/row counts, result bytes, transaction
duration, lock wait, CPU/buffers/WAL, and before/after deltas for all three
workloads. A speed regression is a failed gate, not documentation-only debt.

- [ ] **Step 7: Run black-box profiles**

```bash
npm run test:api-v1:black-box:postgres:medium-scale
npm run test:rallar:full-stack:memory:live-rtc-3
npm run test:rallar:full-stack:postgres:live-rtc-3
```

Expected: the medium-scale command is a mandatory PASS against disposable
PostgreSQL, with all 100 clients and five groups retained and no convergence or
retry-exhaustion failure. The browser full-stack profiles PASS when their
additional local services and browsers are available. Record prerequisites and
skipped status explicitly when those browser prerequisites are unavailable; do
not substitute unit tests or the 12-client default churn recipe for the
medium-scale gate.

- [ ] **Step 8: Verify repository hygiene**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only intentional files are modified. Preserve unrelated user changes.

- [ ] **Step 9: Route any gate-driven correction back to its owning task**

If Steps 1-8 find a defect, reopen the task that owns the listed file, add a
failing regression test there, make the minimal correction, rerun that task's
focused command and this final gate, then use that task's exact staging list.
If no correction is required, do not create an empty commit.

---

## Completion Criteria

- Runtime-state exposes atomic conditional insert, expected-revision update, and expected-revision delete in Postgres and test implementations.
- Lazy expiry cannot delete a refreshed replacement.
- Every targeted mutation visibly executes `read -> compute -> validate -> write`; compute/validate are deterministic, and only write opens a short transaction.
- On conflict, the complete flow restarts after the bounded increasing `[0, 2, 8]` ms policy, with no sleep or domain read inside a transaction.
- Client and group aggregate mutations use their aggregate revision; group presence uses its session generation/revision and does not rewrite the group row for routine heartbeats.
- Session and presence generations prevent delayed work from mutating replacement connections.
- Idempotency ledgers are immutable command-hash plus compact-receipt records in the same atomic transaction as state, event, and mutation-outbox rows.
- Every effectful write leaves a transaction-local, independently drainable outbox intent; publication/recompute is post-commit and idempotent.
- Topology config does not use unconditional restoration or synchronous recomputation after an accepted mutation; explicit reconfigure remains synchronous.
- Topology snapshot, publication, execution, and RTT paths contain no advisory-lock call.
- Authoritative shared values have mandatory fields by default; documented sparse inputs and migration-only exceptions remain distinct.
- Group presence summaries and topology converge on the same required group/presence causal tuple across both API servers.
- The dedicated two-server PostgreSQL black-box gate passes unweakened with 100 independently authenticated clients, five converged 101-member groups, ten client lanes, five group/topology-control lanes, equal cross-server causal revisions, delivered outbox effects, and topology source tuples equal to the final group tuples.
- The candidate passes the Task 0B performance comparison with no permitted hidden regression.
- Unit, type, Postgres multi-client, and available black-box checks pass with exact commands reported.
- Skills and docs encode the implemented phase names, purity, guard-first write, atomic outbox, concurrency domains, backoff, performance gate, mandatory-field doctrine, and prohibit treating current or historical locks as precedent.
