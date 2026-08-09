# Client-State Workspace Key Injectivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every valid client workspace map to one distinct runtime and SQL
persistence identity, with no missing-workspace compatibility or data migration.

**Architecture:** The canonical client-state persistence module owns one pure
workspace encoder. Runtime key builders and PostgreSQL client-event/admin
adapters consume it directly. Persisted-value decoding requires complete
workspace identity and fails closed on omission or disagreement.

**Tech Stack:** TypeScript, Vitest, Deno test, PGlite, PostgreSQL, repository
black-box runners.

## Global Constraints

- Existing client-state persistence is disposable pre-production/test data.
- Update every in-repository consumer atomically in one PR.
- Do not add legacy reads, dual writes, backfill, inventory, compatibility
  windows, schema migrations, or persisted-data repair.
- Preserve current public client-state REST and mutation contracts.
- Keep `workspaceId` mandatory and nonempty at authoritative boundaries.
- Reset affected development/test databases instead of transforming old rows.

---

### Task 1: Prove canonical runtime key injectivity

**Files:**
- Create: `packages/tests/shared-server/client-state/client-state-storage-key-injectivity.test.ts`
- Modify: `packages/tests/shared-server/client-state/client-mutation-command-and-request.test.ts`
- Modify: `packages/shared-server/rallar-system/client-state/persistence/client-state-storage-keys.ts`
- Modify: `packages/shared-server/rallar-system/client-state-storage-keys.ts`

**Interfaces:**
- Produces: `clientStateWorkspaceStorageKey(workspaceId: string): string`.
- Preserves: principal, instance, session, idempotency, comparison, and decoder
  function names.

- [ ] **Step 1: Write the failing key tests**

Add literal expectations for `_ -> %5F`, `%5F -> %255F`, `a:b -> a%3Ab`,
`a%b -> a%25b`, `a/b -> a%2Fb`, and ordinary values. Assert pairwise distinct
principal, instance, session, and idempotency keys and exact decode round trips.
Call the public helper through an unsafe test cast with missing and empty
workspace values and expect `TypeError`.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run \
  packages/tests/shared-server/client-state/client-state-storage-key-injectivity.test.ts \
  packages/tests/shared-server/client-state/client-mutation-command-and-request.test.ts
```

Expected: failure because `_` is still stored as `_` and missing workspace still
uses that same slot.

- [ ] **Step 3: Implement the canonical encoder**

Implement the pure encoder beside the key builders:

```ts
export function clientStateWorkspaceStorageKey(workspaceId: string): string {
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new TypeError('Client-state workspaceId must be a nonempty string');
  }
  return workspaceId === '_' ? '%5F' : encodeURIComponent(workspaceId);
}
```

Use it for the `ws` component and canonical decoder comparison. Export it only
through the existing client storage-key compatibility path needed by current
repository consumers.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command and the complete client-state Vitest directory. Expected:
all pass.

### Task 2: Reject omitted persisted workspace identities

**Files:**
- Modify: `packages/tests/shared-server/client-state/client-mutation-persisted-state-validation.test.ts`
- Modify: `packages/shared-server/rallar-system/client-state/persistence/client-state-persistence-codec.ts`
- Modify: `packages/shared-server/rallar-system/client-state/README.md`

**Interfaces:**
- Consumes: canonical workspace keys from Task 1.
- Preserves: the four `normalizePersistedClient*` function names.

- [ ] **Step 1: Write failing persisted-value tests**

Directly seed principal, instance, session, and event values without
`workspaceId`. Assert direct, list, snapshot, and event reads fail as
`ClientStateRepositoryInvariantCorruptionError` rather than filling the requested
workspace.

- [ ] **Step 2: Verify RED**

Run:

```bash
npx vitest run packages/tests/shared-server/client-state/client-mutation-persisted-state-validation.test.ts
```

Expected: the omission cases currently succeed because the codec fills the
workspace from the expected slot.

- [ ] **Step 3: Require persisted workspace identity**

For principal, instance, session, and event persisted records, require
`workspaceId` in `requireAllowedKeys` and pass the stored value through to the
existing complete-contract validator. Keep unrelated current defaults unchanged.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command and all client-state Vitest tests. Expected: all pass.

### Task 3: Align SQL event and admin persistence

**Files:**
- Create: `apps/api-v1/test/db/pglite-client-state-workspace-isolation.test.ts`
- Modify: `apps/api-v1/test/db/admin-operations-postgres-reader.test.ts`
- Modify: `packages/tests/shared-server/integration/postgres/runtime-state-prefix.test.ts`
- Modify: `packages/shared-server/postgres/rallar-system/PSqlStateEventRepository.ts`
- Modify: `packages/shared-server/postgres/admin-operations/PSqlAdminOperationsStatsReader.ts`

**Interfaces:**
- Consumes: `clientStateWorkspaceStorageKey(workspaceId: string): string`.
- Preserves: `ClientStateEventStore` and admin response contracts.

- [ ] **Step 1: Write failing SQL tests**

Use the real PGlite schema to append equal event IDs for `_`, `%5F`, `a:b`, and
`a%3Ab`; assert separate physical `workspace_key` values and isolated direct,
recent, and paged reads. Assert scoped admin totals select the same encoded
workspace. In the opt-in PostgreSQL suite, prove runtime prefixes for the same
lookalike workspaces remain isolated.

- [ ] **Step 2: Verify RED**

Run:

```bash
cd apps/api-v1 && deno test --allow-env --allow-read --allow-write \
  "--allow-run=$(deno eval 'console.log(Deno.execPath())')" \
  test/db/pglite-client-state-workspace-isolation.test.ts \
  test/db/admin-operations-postgres-reader.test.ts
```

Expected: physical SQL keys and scoped admin counts still use raw workspace IDs.

- [ ] **Step 3: Use the canonical SQL workspace component**

Remove `DEFAULT_WORKSPACE_KEY` and `toWorkspaceKey`. Use
`clientStateWorkspaceStorageKey` for client event insert, collision lookup,
direct/list/recent/page reads, exact-row validation, and admin scoped counts.
Remove SQL `coalesce(..., '_')` for client session workspace identity and require
the persisted field to be present.

- [ ] **Step 4: Verify PGlite and live PostgreSQL**

Run the Step 2 command, API-v1 `deno task check`, and:

```bash
npm run test:postgres:integration
```

Expected: all enabled tests pass with literal isolated keys.

### Task 4: Reconcile active documentation and deferred-work records

**Files:**
- Modify: `packages/shared-server/rallar-system/client-state/README.md`
- Modify: `plans/rallar-rest-snapshot-read-convergence-implementation-plan.md`

**Interfaces:**
- Documents the one current persistence contract; introduces no runtime API.

- [ ] **Step 1: Update active guidance**

Document the mandatory client workspace and canonical physical encoding. State
that affected disposable development/test stores are reset. Remove persisted
client-key migration from deferred work and record #120 as a direct repository
correction.

- [ ] **Step 2: Search for stale #120 migration guidance**

Run:

```bash
rg -n "persisted client-key migration|client-key migration|#120" \
  plans docs packages .agents --glob '!docs/superpowers/**'
```

Expected: no active guidance prescribes a client-key migration or compatibility
window.

- [ ] **Step 3: Run documentation governance**

Run `npm run test:repo-governance`. Expected: pass.

### Task 5: Final verification and publication

**Files:**
- Verify all changed files.

**Interfaces:**
- Proves the final tree; produces no new product contract.

- [ ] **Step 1: Run focused correctness checks**

Run all client-state Vitest tests, focused PGlite tests, API-v1 Deno check,
shared-server TypeScript, repository governance, changed-style checking, and
`git diff --check`.

- [ ] **Step 2: Run production-representative gates**

Run:

```bash
npm run test:api-v1:black-box:postgres:medium-scale
npm run perf:api-v1:state-write -- \
  --backend=postgres \
  --warmup=1 \
  --runs=3 \
  --concurrency=10 \
  --out=tmp/perf/api-v1-state-write-candidate.json
node scripts/perf/compare-api-v1-state-write-results.mjs \
  tmp/perf/api-v1-state-write-baseline.json \
  tmp/perf/api-v1-state-write-candidate.json
```

The workload remains 100 clients, five groups, three API processes, 10 client
lanes, and five control lanes. The state-write comparison remains required
because key construction is on the client mutation path; do not weaken its
artifact-integrity or performance assertions.

- [ ] **Step 3: Run final-tree completion gates**

From the unchanged final working tree, run:

```bash
npm run check:repo-style
npm run test:unit
npm run test:ci
npm run build
git diff --check
```

- [ ] **Step 4: Publish exact evidence**

Commit and push the non-default feature branch, keep the draft PR current, and
require Branch Release Gate on the exact final feature SHA. After separately
authorized merge, require resulting-main Hetzner manifest evidence before the
parent convergence follow-up can claim publication completion.
