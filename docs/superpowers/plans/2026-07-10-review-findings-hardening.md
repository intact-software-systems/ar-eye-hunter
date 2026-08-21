# Review Findings Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all thirteen confirmed review findings on `codex/fix-main-review-findings` without changing the dirty `main` checkout.

**Architecture:** Implement four repair tracks on one isolated branch: admin/CRDT boundary safety, match identity and result contracts, operational statistics and managed API readiness, and workflow/headless reliability. Deterministic validation, normalization, polling, and redaction live in narrow helpers; existing services, repositories, and workflows remain the public integration points.

**Tech Stack:** TypeScript, Vitest 4, Deno, PGlite/Postgres SQL templates, Playwright, GitHub Actions YAML, npm workspaces.

## Global Constraints

- Preserve existing public exports and import paths.
- Generic Rallar Game callers that omit `matchId` retain their current wire shape.
- Browser match support always supplies and enforces its required `matchId`.
- Omitted CRDT erase mode retains the documented `destroy-document` default; supplied unknown modes fail before side effects.
- Operational statistics response shapes do not change.
- Secret-consuming GitHub jobs run only through the `production` environment and trusted workflow SHA.
- Every behavior change must have a regression test observed failing before implementation.
- Do not modify `/Users/knut-helgevik/ProjectLocker/ar-eye-hunter`; all work happens in `/private/tmp/rallar-fix-review-findings`.

## File Structure

- Create `packages/shared-server/rallar-system/admin-operations/crdt-admin-validation.ts`: canonical runtime enum readers shared by the admin service and Postgres repository.
- Modify `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`: validate lifecycle and erase mode before side effects.
- Modify `packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts`: defensively validate lifecycle before persistence.
- Modify `packages/shared/rallar-match/results.ts`: expose the union overload and canonical workspace key.
- Create `packages/shared/rallar-match/results.typecheck.ts`: compile-only consumer of the exported union input.
- Modify `packages/shared-web/game/types.ts`, `envelopes.ts`, `match.ts`, and `match-support.ts`: carry and enforce optional generic match identity.
- Modify `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`: event window and logical-expiry predicates.
- Modify `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`: child-owned startup readiness.
- Create `apps/rallar-black-box/src/headless-worker-runtime.ts`: deterministic redaction and distributed terminal polling.
- Modify `apps/rallar-black-box/scripts/headless-worker.ts`: delegate logging and polling to the runtime helper.
- Modify the three production caller workflows and the reusable runner: trusted checkout, protected environment, unique principals, complete-run concurrency, and prepare failure propagation.
- Add or update the focused tests named in each task.

---

### Task 1: Reject Invalid CRDT Lifecycle And Erasure Enums

**Files:**

- Create: `packages/shared-server/rallar-system/admin-operations/crdt-admin-validation.ts`
- Modify: `packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts`
- Modify: `packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts`
- Test: `packages/tests/shared-server/admin-operations-service.test.ts`
- Test: `apps/api-v1/test/db/pglite-sql-adapter.test.ts`
- Test: `packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json`

**Interfaces:**

- Produces: `readAdminCrdtLifecycle(value: unknown): RallarCrdtDocumentLifecycleState`
- Produces: `readAdminCrdtErasureMode(value: unknown): RallarCrdtErasureRequest['mode']`
- Invariant: invalid values throw before audit, document creation, or lifecycle update.

- [ ] **Step 1: Add failing service tests for both invalid values and no side effects**

Add a shared document fixture and tests equivalent to:

```ts
const document: RallarCrdtDocumentRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    documentScope: 'group',
    documentType: 'map',
    documentId: 'doc-1'
};

it('rejects invalid CRDT lifecycle and erase mode before repository calls', async () => {
    const lifecycleCalls: unknown[] = [];
    const auditCalls: unknown[] = [];
    const service = createService({
        crdtAdminRepository: {
            updateDocumentLifecycle: (input) => {
                lifecycleCalls.push(input);
                return Promise.resolve({} as never);
            },
            exportDebugBundle: () => Promise.resolve({})
        },
        crdtAuditSink: {
            record: (event) => {
                auditCalls.push(event);
            }
        }
    });

    await expect(service.updateCrdtLifecycle({
        adminSession: createAdminSession(),
        request: { document, lifecycle: 'destroy' } as never
    })).rejects.toThrow('Unsupported CRDT lifecycle: destroy');

    await expect(service.eraseCrdt({
        adminSession: createAdminSession(),
        request: { document, mode: 'redact-payload' }
    })).rejects.toThrow('Unsupported CRDT erasure mode: redact-payload');

    expect(lifecycleCalls).toEqual([]);
    expect(auditCalls).toEqual([]);
});
```

Also add authenticated API-v1 recipe steps posting the same invalid values to
`/api/admin/operations/crdt/lifecycle` and
`/api/admin/operations/crdt/erase`. Each step must expect status `400` and the
exact corresponding `Unsupported CRDT ...` error body.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
npx vitest run packages/tests/shared-server/admin-operations-service.test.ts
npm run test:api-v1:black-box:memory
```

Expected: FAIL because `destroy` reaches `updateDocumentLifecycle`,
`redact-payload` selects destruction, and the API recipe receives success
instead of `400`.

- [ ] **Step 3: Add the canonical validation helper and use it in the service**

Create the helper with these complete functions:

```ts
import type {
    RallarCrdtDocumentLifecycleState,
    RallarCrdtErasureRequest
} from '@shared/crdt/mod.ts';

const LIFECYCLES = new Set<RallarCrdtDocumentLifecycleState>([
    'active',
    'archived',
    'destroyed',
    'quarantined'
]);

export function readAdminCrdtLifecycle(
    value: unknown
): RallarCrdtDocumentLifecycleState {
    if (typeof value === 'string' && LIFECYCLES.has(value as RallarCrdtDocumentLifecycleState)) {
        return value as RallarCrdtDocumentLifecycleState;
    }
    throw new Error(`Unsupported CRDT lifecycle: ${String(value)}`);
}

export function readAdminCrdtErasureMode(
    value: unknown
): RallarCrdtErasureRequest['mode'] {
    if (value === undefined) {
        return 'destroy-document';
    }
    if (value === 'destroy-document' || value === 'redact-payloads') {
        return value;
    }
    throw new Error(`Unsupported CRDT erasure mode: ${String(value)}`);
}
```

In `updateCrdtLifecycle`, parse `input.request` as an unknown record, replace its lifecycle with `readAdminCrdtLifecycle(body.lifecycle)`, and only then call the repository. In `eraseCrdt`, replace the fallback ternary with `readAdminCrdtErasureMode(body.mode)` before creating the audit event.

- [ ] **Step 4: Run the service test and verify GREEN**

Run: `npx vitest run packages/tests/shared-server/admin-operations-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Add a failing direct-repository lifecycle test**

In the PGlite adapter test, call `updateDocumentLifecycle({ document, lifecycle: 'destroy' } as never)`, assert rejection with the same message, then assert `readDocumentMetadata(document)` is `undefined`.

- [ ] **Step 6: Run the PGlite test and verify RED**

Run: `cd apps/api-v1 && deno test --allow-env --allow-read --allow-write --allow-net test/db/pglite-sql-adapter.test.ts`

Expected: FAIL because the repository persists the invalid lifecycle and creates metadata.

- [ ] **Step 7: Defensively validate in the repository and verify GREEN**

At the start of `updateDocumentLifecycle`, call `readAdminCrdtLifecycle(input.lifecycle)` and use the returned value in timestamp derivation, SQL persistence, and audit-kind selection.

Run both commands from Steps 4 and 6, then run
`npm run test:api-v1:black-box:memory`. Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add packages/shared-server/rallar-system/admin-operations/crdt-admin-validation.ts packages/shared-server/rallar-system/admin-operations/AdminOperationsService.ts packages/shared-server/postgres/crdt/PSqlCrdtLogRepository.ts packages/tests/shared-server/admin-operations-service.test.ts apps/api-v1/test/db/pglite-sql-adapter.test.ts packages/shared-test/black-box-runner/tests/api-v1/api-v1-admin-operations.json
git commit -m "fix: validate admin crdt mutations"
```

### Task 2: Repair Match Result Public Typing And Canonical Keys

**Files:**

- Modify: `packages/shared/rallar-match/results.ts`
- Create: `packages/shared/rallar-match/results.typecheck.ts`
- Modify: `packages/tests/shared/rallar-match.test.ts`

**Interfaces:**

- Produces: callable overload `createRallarMatchResult<TSummary>(input: RallarMatchResultInput<TSummary>)`.
- Invariant: omitted and empty workspace IDs generate the same collision-safe idempotency key.

- [ ] **Step 1: Add the failing external union compile fixture**

```ts
import { createRallarMatchResult } from './results.ts';
import type { RallarMatchResultInput } from './types.ts';

declare const input: RallarMatchResultInput<{ readonly reason: string; }>;
const result = createRallarMatchResult(input);
void result;
```

- [ ] **Step 2: Run shared typecheck and verify RED**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`

Expected: FAIL with `TS2769: No overload matches this call` in `results.typecheck.ts`.

- [ ] **Step 3: Add the public union overload and verify GREEN**

Insert this declaration before the implementation signature:

```ts
export function createRallarMatchResult<TSummary>(
    input: RallarMatchResultInput<TSummary>
): RallarLocalMatchResult<TSummary> | RallarRoomTrustedMatchResult<TSummary>;
```

Run the command from Step 2. Expected: PASS.

- [ ] **Step 4: Change the existing workspace identity test to require canonical equality**

Rename the test to `scopes result idempotency keys by canonical room identity` and change its final assertions to:

```ts
expect(roomOneKey).not.toBe(roomTwoKey);
expect(roomOneKey).toBe(emptyWorkspaceKey);
```

- [ ] **Step 5: Run match tests and verify RED**

Run: `npx vitest run packages/tests/shared/rallar-match.test.ts`

Expected: FAIL because `workspace:absent` and `workspace:present:` differ.

- [ ] **Step 6: Canonicalize the workspace key and verify GREEN**

Replace the workspace branch with:

```ts
const workspace = `workspace:${input.roomRef.workspaceId ?? ''}`;
```

Retain `encodeURIComponent` over every part. Run the commands from Steps 2 and 5. Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add packages/shared/rallar-match/results.ts packages/shared/rallar-match/results.typecheck.ts packages/tests/shared/rallar-match.test.ts
git commit -m "fix: align match result contracts"
```

### Task 3: Isolate Browser Traffic By Match Identity

**Files:**

- Modify: `packages/shared-web/game/types.ts`
- Modify: `packages/shared-web/game/envelopes.ts`
- Modify: `packages/shared-web/game/match.ts`
- Modify: `packages/shared-web/game/match-support.ts`
- Modify: `packages/tests/shared-web/rallar-game-envelopes.test.ts`
- Modify: `packages/tests/shared-web/rallar-game-match.test.ts`
- Modify: `packages/tests/shared-web/rallar-browser-match-support.test.ts`

**Interfaces:**

- Adds optional `matchId?: string` to generic config and envelopes.
- Adds optional acceptance constraint `matchId?: string` and rejection reason `wrong-match`.
- Browser match configuration remains source-compatible and always enables the constraint.

- [ ] **Step 1: Add failing envelope identity tests**

Create an envelope with `matchId: 'match-a'`; assert it retains the property. Assert accepting it with `{ matchId: 'match-b' }` returns `{ accepted: false, reason: 'wrong-match' }`. Then accept sequence `10` for `match-a` and sequence `1` for `match-b` under their matching constraints and assert both are accepted.

- [ ] **Step 2: Run envelope tests and verify RED**

Run: `npx vitest run packages/tests/shared-web/rallar-game-envelopes.test.ts`

Expected: typecheck/transformation or assertion failure because envelopes and constraints do not carry match identity.

- [ ] **Step 3: Extend envelope types and deterministic acceptance**

Add `matchId?: string` to `RallarGameEnvelope`, `RallarGameEnvelopeCreateInput`, and `RallarGameMatchConfig`; add `'wrong-match'` to the reject union and `matchId?: string` to constraints. In `createRallarGameEnvelope`, include `...(input.matchId === undefined ? {} : { matchId: input.matchId })`. In `rejectByConstraints`, reject when a configured constraint differs, including absent envelope identity. Include `envelope.matchId ?? ''` in `sequenceKey`.

- [ ] **Step 4: Run envelope tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Add failing runtime and browser-wrapper tests**

In `rallar-game-match.test.ts`, create a match with `matchId: 'match-b'`, inject otherwise-valid realtime input and relay snapshot envelopes with `matchId: 'match-a'`, and assert neither handler runs. In `rallar-browser-match-support.test.ts`, send a command and assert the captured outbound envelope contains the wrapper's `matchId`.

- [ ] **Step 6: Run runtime tests and verify RED**

Run: `npx vitest run packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-browser-match-support.test.ts`

Expected: FAIL because runtime creation omits match identity and inbound acceptance ignores it.

- [ ] **Step 7: Thread identity through runtime creation and acceptance**

In `match.ts`, pass `matchId: config.matchId` to `createRallarGameEnvelope` and `sequenceTracker.accept`. In `match-support.ts`, add `matchId: config.matchId` to `gameConfig`. Do not require `matchId` for direct generic callers.

- [ ] **Step 8: Run focused tests, typecheck, and game builds**

Run:

```bash
npx vitest run packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-browser-match-support.test.ts packages/tests/shared-web/rallar-authority-match-support.test.ts
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
```

Expected: all PASS; build chunk warnings are acceptable when exit status is zero.

- [ ] **Step 9: Commit Task 3**

```bash
git add packages/shared-web/game/types.ts packages/shared-web/game/envelopes.ts packages/shared-web/game/match.ts packages/shared-web/game/match-support.ts packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-browser-match-support.test.ts
git commit -m "fix: isolate browser matches by identity"
```

### Task 4: Make Operational Statistics Time-Accurate

**Files:**

- Modify: `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`
- Modify: `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`

**Interfaces:**

- Adds option `recentEventWindowMs?: number`, default `900_000`.
- `readState` recent event fields count only events at or after `now() - window`.
- `readSystem.stateEvents` remains an all-time total.
- Active groups exclude logical expiries at or before `now()` in scoped and global reads.

- [ ] **Step 1: Add failing recent-window and group-expiry tests**

Seed one client and group event at `1_699_999_099_999` and one at
`1_699_999_100_000` with `now = 1_700_000_000_000`; assert only the boundary
event is counted by scoped and global `readState`, while `readSystem` still
counts both rows. Seed active groups with no expiry, future expiry, and
`expiresAtEpochMs: 1_700_000_000_000`; assert counts are `2` in both scoped and
global reads.

- [ ] **Step 2: Run the reader test and verify RED**

Run: `cd apps/api-v1 && deno test --allow-env --allow-read --allow-write --allow-net test/db/admin-operations-postgres-reader.test.ts`

Expected: FAIL because event counts include all rows and active status ignores logical expiry.

- [ ] **Step 3: Implement window and expiry predicates**

Add:

```ts
const DEFAULT_RECENT_EVENT_WINDOW_MS = 15 * 60 * 1_000;
```

Add `countRecentClientEvents` and `countRecentGroupEvents`; compute
`const recentSinceEpochMs = this.options.now() - (this.options.recentEventWindowMs ?? DEFAULT_RECENT_EVENT_WINDOW_MS)`
inside them and add `occurred_at_epoch_ms >= ${recentSinceEpochMs}` to scoped
and global queries. Use those helpers only in `readState`; keep the existing
unbounded count helpers in `readSystem`. Change scoped filtering to
`isActiveGroupRow(row, nowEpochMs)`. Replace the global group status count with
a dedicated query containing:

```sql
and store_value::jsonb ->> 'status' = 'active'
and (
  store_value::jsonb ->> 'expiresAtEpochMs' is null
  or (store_value::jsonb ->> 'expiresAtEpochMs')::double precision > ${this.options.now()}
)
```

Implement `isActiveGroupRow` as status active plus absent-or-future expiry.

- [ ] **Step 4: Run focused Deno tests and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Run API typecheck and commit Task 4**

Run: `cd apps/api-v1 && deno task check`

Expected: PASS.

```bash
git add packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts apps/api-v1/test/db/admin-operations-postgres-reader.test.ts
git commit -m "fix: bound admin operational statistics"
```

### Task 5: Tie API Black-Box Readiness To Its Spawned Child

**Files:**

- Modify: `packages/shared-test/black-box-runner/api-v1-black-box-run.mts`
- Modify: `packages/tests/shared-test/api-v1-black-box-run.test.ts`

**Interfaces:**

- Produces exported `waitForManagedApiReady(input)` with injected fetch, clock, sleep, and log reader for unit coverage.
- Readiness requires both the child startup marker and a successful `/api/config` response while racing child exit.

- [ ] **Step 1: Add a failing managed-readiness unit test**

Use a child-status promise resolving `{ success: false, code: 1, signal: null }`, a log reader returning `AddrInUse`, and a fetch stub returning `200`. Assert `waitForManagedApiReady` rejects with `API-v1 child exited before readiness (code 1)` and does not accept the unrelated response.

- [ ] **Step 2: Run the helper test and verify RED**

Run: `npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts`

Expected: FAIL because `waitForManagedApiReady` is not exported and readiness does not observe the child.

- [ ] **Step 3: Implement child-owned readiness**

Export an input type containing `baseUrl`, `logPath`, `childStatus`, and optional `timeoutMs`, `fetchImpl`, `readTextFile`, `now`, and `sleep`. Race a child-exit promise against a loop that first observes `/Server started on port \d+\./` in `logPath`, then requires an OK `/api/config` response. Include the latest bounded log tail in child-exit and timeout errors. In `main`, call it with `server.status` immediately after `startServer`.

- [ ] **Step 4: Run unit test and shared-test checks**

Run:

```bash
npx vitest run packages/tests/shared-test/api-v1-black-box-run.test.ts
npm --workspace @ar-eye-hunter/shared-test run check
```

Expected: PASS.

- [ ] **Step 5: Reproduce occupied-port ownership**

Add a process-level test that starts a small Node HTTP server returning `200` for `/api/config`, invokes the managed Deno runner on that occupied port, and asserts stderr contains `API-v1 child exited before readiness` rather than a recipe result. Run the focused Vitest file and verify PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add packages/shared-test/black-box-runner/api-v1-black-box-run.mts packages/tests/shared-test/api-v1-black-box-run.test.ts
git commit -m "fix: verify managed api process readiness"
```

### Task 6: Redact Every Headless Log And Retry Poll Transport Failures

**Files:**

- Create: `apps/rallar-black-box/src/headless-worker-runtime.ts`
- Modify: `apps/rallar-black-box/scripts/headless-worker.ts`
- Create: `packages/tests/rallar-black-box/headless-worker-runtime.test.ts`
- Modify: `packages/tests/rallar-black-box/headless-worker-script.test.ts`

**Interfaces:**

- Produces `redactHeadlessWorkerLogText(message, secrets)`.
- Produces `waitForDistributedRunTerminal(input)` with injected `fetch`, `sleep`, `now`, and logger.
- Network rejection is retryable; HTTP 401/403 and three consecutive malformed payloads remain fatal.

- [ ] **Step 1: Extract current URL redaction and terminal polling without changing behavior**

Move the existing URL masking and polling loop into `headless-worker-runtime.ts`, inject side effects, update the script to delegate, and run existing headless script/config tests. Expected: PASS before behavior changes.

- [ ] **Step 2: Add failing behavior tests**

Test a Playwright-style message containing a credential-bearing URL and literal configured password/token; assert neither secret appears and sensitive query values equal `[REDACTED]`. Test a fetch function that rejects once and returns `{ state: 'passed' }` on its second call; assert polling resolves and two calls occurred.

- [ ] **Step 3: Run runtime tests and verify RED**

Run: `npx vitest run packages/tests/rallar-black-box/headless-worker-runtime.test.ts`

Expected: FAIL because whole-message secret replacement and rejected-fetch retry are absent.

- [ ] **Step 4: Implement centralized redaction and retry**

`redactHeadlessWorkerLogText` must replace every non-empty known secret before applying URL/query masking. Wrap the distributed `fetch` in `try/catch`; log a state-changing `network-error` message, sleep for the configured interval, and continue until the existing deadline. Route both `log()` and the top-level `console.error` through the redactor using passwords, per-agent control tokens, control read token, and fallback control token from config.

- [ ] **Step 5: Run focused tests and worker typecheck**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/headless-worker-runtime.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts packages/tests/rallar-black-box/headless-worker-config.test.ts
npm --workspace rallar-black-box run typecheck
```

Expected: PASS.

- [ ] **Step 6: Re-run the navigation-error probe**

Launch a one-page Playwright probe against an unreachable credential-bearing URL through the redaction helper and assert captured output contains neither the control token nor password. Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```bash
git add apps/rallar-black-box/src/headless-worker-runtime.ts apps/rallar-black-box/scripts/headless-worker.ts packages/tests/rallar-black-box/headless-worker-runtime.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts
git commit -m "fix: harden headless worker runtime"
```

### Task 7: Trust GitHub-Free Code And Provision Unique Principals

**Files:**

- Modify: `.github/workflows/github-free-distributed-recipe.yml`
- Modify: `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`
- Modify: `plans/github-actions-rallar-black-box-headless-runbook.md`

**Interfaces:**

- GitHub-free checkout uses `${{ github.sha }}` and has no secondary `ref` input.
- `github-agents` targets `environment: production`.
- Multi-agent runs require registration and export explicit per-agent username/password variables.

- [ ] **Step 1: Add failing workflow contract tests**

Assert the workflow does not define `inputs.ref`, every checkout uses `${{ github.sha }}`, the `github-agents` job contains `environment: production`, registration defaults true, plan rejects multi-agent registration false, and the shard setup writes `RALLAR_BLACK_BOX_AGENT_${local_index}_USERNAME` from the global `agent_id` plus a per-agent password.

- [ ] **Step 2: Run workflow tests and verify RED**

Run: `npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`

Expected: FAIL on the free-form ref, absent environment, false registration default, and generic credentials.

- [ ] **Step 3: Implement trusted checkout and per-agent credentials**

Remove the dispatch `ref` input; use `${{ github.sha }}` for plan, prepare, agents, and operator refs. Add `environment: production` to `github-agents`. Set registration default true and fail planning when `target_agent_count > 1 && !inputs.register_before_login`. During the existing token-mint loop, write shell-quoted per-agent username and password entries to a `0600` shard env file, source it for the worker step, and remove generic `RALLAR_BLACK_BOX_USERNAME` from the worker environment.

- [ ] **Step 4: Update the runbook contract**

Document that the workflow commit is immutable for the run, the production environment must restrict deployment branches, and principal-scale runs register one username per agent ID.

- [ ] **Step 5: Run focused workflow tests and YAML parsing**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts packages/tests/hetzner/distributed-recipe-workflow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 7**

```bash
git add .github/workflows/github-free-distributed-recipe.yml packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts plans/github-actions-rallar-black-box-headless-runbook.md
git commit -m "fix: protect github hosted agent runs"
```

### Task 8: Propagate Prepare Failures And Lock Complete Runs

**Files:**

- Modify: `.github/workflows/hetzner-distributed-recipe-runner.yml`
- Modify: `.github/workflows/hetzner-distributed-recipe.yml`
- Modify: `.github/workflows/hetzner-supported-distributed-manifests.yml`
- Modify: `.github/workflows/github-free-distributed-recipe.yml`
- Modify: `packages/tests/hetzner/distributed-recipe-workflow.test.ts`
- Modify: `packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts`

**Interfaces:**

- The reusable phase runner owns no workflow-level concurrency group.
- Every complete production caller owns the shared group `hetzner-production-distributed-recipe`, `cancel-in-progress: false`, and `queue: max`.
- Any non-successful remote recipe step fails prepare, run, and full phases after applicable artifacts are handled.

- [ ] **Step 1: Add failing concurrency and failure-propagation tests**

Assert the reusable runner has no top-level `concurrency`, all three callers contain the exact shared queued group, and the final failure step condition is `always() && steps.run_recipe.outcome != 'success'` without excluding prepare.

- [ ] **Step 2: Run workflow tests and verify RED**

Run:

```bash
npx vitest run packages/tests/hetzner/distributed-recipe-workflow.test.ts packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
```

Expected: FAIL because the reusable runner owns the fixed lock, callers do not share a full-run lock, and prepare is excluded from failure propagation.

- [ ] **Step 3: Move the lock and propagate every phase failure**

Remove `concurrency` from the reusable runner. Add this block after `permissions` in each caller:

```yaml
concurrency:
  group: hetzner-production-distributed-recipe
  cancel-in-progress: false
  queue: max
```

Change the final runner step to:

```yaml
- name: Fail if distributed recipe operation failed
  if: always() && steps.run_recipe.outcome != 'success'
  run: |
    echo "Distributed recipe operation failed. Artifacts and analysis were uploaded when applicable." >&2
    exit 1
```

- [ ] **Step 4: Run workflow tests and verify GREEN**

Run the commands from Step 2. Expected: PASS, including repository YAML parse checks.

- [ ] **Step 5: Commit Task 8**

```bash
git add .github/workflows/hetzner-distributed-recipe-runner.yml .github/workflows/hetzner-distributed-recipe.yml .github/workflows/hetzner-supported-distributed-manifests.yml .github/workflows/github-free-distributed-recipe.yml packages/tests/hetzner/distributed-recipe-workflow.test.ts packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts
git commit -m "fix: serialize complete distributed runs"
```

### Task 9: Full Verification And Finding-By-Finding Audit

**Files:**

- Verify all files changed in Tasks 1-8.
- Modify documentation only if an executable contract changed and is not already represented.

**Interfaces:**

- Produces evidence for every completion criterion in the approved design.

- [ ] **Step 1: Run the complete focused regression set**

```bash
npx vitest run packages/tests/shared/rallar-match.test.ts packages/tests/shared/admin-operations-types.test.ts packages/tests/shared-web/rallar-browser-match-support.test.ts packages/tests/shared-web/rallar-authority-match-support.test.ts packages/tests/shared-web/rallar-game-match.test.ts packages/tests/shared-web/rallar-game-envelopes.test.ts packages/tests/shared-server/rallar-match-result.test.ts packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-test/api-v1-black-box-run.test.ts packages/tests/rallar-black-box/github-actions-headless-pool-workflow.test.ts packages/tests/rallar-black-box/headless-worker-runtime.test.ts packages/tests/rallar-black-box/headless-worker-script.test.ts packages/tests/rallar-black-box/headless-worker-config.test.ts packages/tests/hetzner/distributed-recipe-workflow.test.ts
```

Expected: all files and tests PASS.

- [ ] **Step 2: Run focused Deno/PGlite tests**

```bash
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write --allow-net test/routes/admin-operations-routes.test.ts test/db/admin-operations-postgres-reader.test.ts test/db/pglite-sql-adapter.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run all affected typechecks and browser boundaries**

```bash
npx tsc -p packages/shared/tsconfig.json --noEmit
npx tsc -p packages/shared-web/tsconfig.json --noEmit
npx tsc -p packages/shared-server/tsconfig.json --noEmit
npm --workspace @ar-eye-hunter/shared-test run check
npm --workspace rallar-black-box run typecheck
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
cd apps/api-v1 && deno task check
```

Expected: PASS.

- [ ] **Step 4: Build affected game and black-box apps**

```bash
npm --workspace ar-eye-hunter-v1 run build
npm --workspace relic-hunters-v1 run build
npm --workspace rallar-black-box run build
```

Expected: PASS; report any large-chunk warnings separately.

- [ ] **Step 5: Run broader suites**

Run `npm run test:unit` and `npm run test:deno`. If an external service prevents a suite, record the exact skipped command and reason; do not substitute a narrower success claim.

- [ ] **Step 6: Audit all thirteen findings against authoritative evidence**

For each numbered item in `docs/superpowers/specs/2026-07-10-review-findings-hardening-design.md`, identify the exact production line, regression test, and passing command. Re-run the credential-log, invalid-lifecycle, union-compile, occupied-port, and cross-match probes independently.

- [ ] **Step 7: Verify worktree isolation and diff quality**

```bash
git diff --check main...HEAD
git status --short --branch
git log --oneline --decorate main..HEAD
```

Also run `git status --short --branch` in `/Users/knut-helgevik/ProjectLocker/ar-eye-hunter` and confirm only the user's pre-existing plan/playground changes remain.

- [ ] **Step 8: Request code review before integration**

Invoke `superpowers:requesting-code-review`, address confirmed findings, and repeat affected verification before declaring completion.
