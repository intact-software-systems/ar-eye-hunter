# ALM F1 Conformance Lane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every later ALM slice a black-box conformance lane over both carriers, a narrow
`rallar-messages` browser entry point with its own bundle budget, an AL-owned IndexedDB operation
counter, transport fault ports, an agent reload command, and a proper database migration for the
`resource_inbox_ix` index.

**Architecture:** New recipe commands (`messages.send`, `messages.observe`, `messages.cancel`,
`messages.received`, `messages.receipts`, `fault.inject`, `storage.counters`, `agent.reload`) enter
through `rallar-bb-test` types and schema, are executed by the browser adapter, and reach the
production `rallar` facade through the page-side black-box runtime. Two narrow ports, a
`TransportFaultPort` consulted before every WS and RTC send and an `IndexedDbOperationObserver`
consulted by the IndexedDB admission backend and queue box, are required constructor inputs with
pass-through defaults at the composition roots; only the black-box composition supplies live ones.
A baseline `alm-conformance` recipe family is generated from TypeScript, run by a new Playwright
full-stack spec and by new Hetzner manifests.

**Tech Stack:** TypeScript (Node + Deno + browser), Vitest, Playwright, dprint, the existing
`rallar-bb-test` control protocol, IndexedDB, Prisma migrations for PostgreSQL.

**Spec:** [playground/alm/alm-improvement-plan.md](../playground/alm/alm-improvement-plan.md),
section "Release 2, F1: conformance lane and messaging entry point", plus the sections
"Conformance lane" and "Governance and delivery rules". Read the spec before starting.

## Global Constraints

- Decision D8: search `packages/**` for an existing library before writing one; ask the maintainer
  before adding an internal library; never add a third-party dependency.
- No retained legacy: an obsolete path is deleted in the same commit that replaces it.
- Canonical verbs only (`to`, `compute`, `validate`, `read`, `write`, `get`, `set`, `create`,
  `createDefault`, `resolve`, `init`, `start`, `stop`); `handle`, `process`, `execute`, `util`,
  `helper` are banned in new names.
- Required fields by default; an optional field only where absence has domain meaning. Sparse
  external input (recipe JSON, `RallarSetupInput`) is normalized at the boundary.
- Expected failure is an `Either` value; `assertXxx` is reserved for programmer invariants.
- Files are kebab-case and match their primary export. No `utils.ts`, `helpers.ts`, `types.ts` without
  a feature noun (existing `rallar-bb-test/types.ts` is an existing boundary; do not add another).
- Every commit keeps `npx vitest run <touched test files>` green, `npx dprint check <touched files>`
  green, and the package typecheck green. Before pushing: `npm run test:unit`,
  `cd apps/api-v1 && deno task check`, `cd apps/rallar-black-box-control-server && deno task check`,
  `npx dprint check`.
- Tests change in the same commit as the production change they cover. Never an "align tests later"
  commit.
- Bundle: `browser/rallar-messages.ts` gets its own Brotli budget; if the aggregate facade crosses its
  budget, raise it to the next whole KiB with the measured figure recorded in the commit message.
- Branch: `codex/alm-f1-conformance-lane` (or `claude/…`) from merged `main`. PR body sections: Goal,
  Changes, Acceptance, Validation, Risk and rollback, Follow-up.
- Worktree facts: copy `.env` and `apps/api-v1/.env` from the main checkout into a new worktree and
  run `npm ci`; Playwright lanes need `npx playwright install chromium`.

---

## File structure

| Responsibility                                 | File                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IndexedDB operation observer port and counters | Create `packages/shared/persistence/indexed-db-operation-observer.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Count AL admission and work operations         | Modify `packages/shared/alm/indexed-db-admission-backend.ts`, `packages/shared/queuebox/indexed-db-queue-box.ts`, `packages/shared/alm/al-runtime-stores.ts`                                                                                                                                                                                                                                                                                                                                          |
| Transport fault port                           | Create `packages/shared/transport-faults/transport-fault-port.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Consult the fault port before a send           | Modify `packages/shared/websocket/json-web-socket-client.ts`, `packages/shared/webrtc/qrtc-data-channel.ts`                                                                                                                                                                                                                                                                                                                                                                                           |
| Thread diagnostics ports through setup         | Modify `packages/shared-web/browser/rallar.ts` (setup input), `packages/shared-web/browser/connection/initialise-browser-middleware.ts`, `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts`, `packages/shared-web/browser/rtc/initialise-browser-rtc-runtime.ts`                                                                                                                                                                                                                   |
| Narrow messaging entry point                   | Create `packages/shared-web/browser/rallar-messages.ts`; modify `packages/shared-web/scripts/measure-browser-bundles.mjs`, `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`, `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`                                                                                                                                                                                                                               |
| Recipe command contracts                       | Modify `packages/shared-test/rallar-bb-test/types.ts`, `packages/shared-test/rallar-bb-test/schema.ts`, `packages/shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts`                                                                                                                                                                                                                                                                                                               |
| Browser adapter execution                      | Modify `packages/shared-test/rallar-bb-test/browser-adapter.ts`, `packages/shared-test/rallar-bb-test/black-box-runner-adapter.ts`                                                                                                                                                                                                                                                                                                                                                                    |
| Page-side runtime operations                   | Modify `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts`, `black-box-rallar-operation-contracts.ts`, `decode-black-box-rallar-command-input.ts`, `messaging-controller.ts`, `black-box-rallar-runtime.ts`, `browser-rallar-runtime-composition.ts`; `packages/shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts`                                                                                                                  |
| Agent reload                                   | Modify `packages/shared-test/rallar-bb-test/browser-control-agent.ts`, `packages/shared-test/rallar-bb-test/control-client.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| Conformance recipe family                      | Create `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts`, `create-alm-conformance-recipes.ts`                                                                                                                                                                                                                                                                                                                                                                         |
| Playwright lane                                | Create `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Hetzner manifests                              | Modify `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`, regenerate `apps/rallar-black-box/manifests/hetzner/*.json`, modify `.github/workflows/hetzner-supported-distributed-manifests.yml`                                                                                                                                                                                                                                                                                              |
| Migration                                      | Modify `apps/api-v1/prisma/migrations/20260216141946_repository/migration.sql`; create `apps/api-v1/prisma/migrations/20260908120000_resource_inbox_status_type_created_row_index/migration.sql`                                                                                                                                                                                                                                                                                                      |
| Tests                                          | Create `packages/tests/shared/persistence/indexed-db-operation-observer.test.ts`, `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`, `packages/tests/shared/transport-faults/transport-fault-port.test.ts`, `packages/tests/shared/websocket/json-web-socket-client-faults.test.ts`, `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`, `packages/tests/shared-test/alm-conformance-recipes.test.ts`, `packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts` |

---

### Task 1: Restore the base migration and add the index migration

**Files:**

- Modify: `apps/api-v1/prisma/migrations/20260216141946_repository/migration.sql:23`
- Create: `apps/api-v1/prisma/migrations/20260908120000_resource_inbox_status_type_created_row_index/migration.sql`
- Unchanged but verified: `apps/api-v1/prisma/schema.prisma:24`, `apps/api-v1/src/db/in-memory-schema.sql:33-34`

**Interfaces:**

- Consumes: nothing.
- Produces: an additive migration every later PR's Release Gate applies with `migrate deploy`.

- [ ] **Step 1: Confirm the base migration was edited after it was applied**

Run: `git log --oneline -3 -- apps/api-v1/prisma/migrations/20260216141946_repository/migration.sql`
Expected: the newest commit is the #521 squash `a28e61b61`; the line reads
`CREATE INDEX resource_inbox_ix ON resource_inbox (ri_status, ri_type_id, created_ts, ri_row_id);`.

- [ ] **Step 2: Restore the applied migration's original line**

Replace line 23 of `apps/api-v1/prisma/migrations/20260216141946_repository/migration.sql` with:

```sql
CREATE INDEX resource_inbox_ix ON resource_inbox (ri_status, ri_type_id);
```

Run: `git diff c5e068516 -- apps/api-v1/prisma/migrations/20260216141946_repository/migration.sql`
Expected: empty output (byte-identical to the pre-#521 file).

- [ ] **Step 3: Add the new migration**

Create `apps/api-v1/prisma/migrations/20260908120000_resource_inbox_status_type_created_row_index/migration.sql`:

```sql
DROP INDEX IF EXISTS resource_inbox_ix;

CREATE INDEX resource_inbox_ix
    ON resource_inbox (ri_status, ri_type_id, created_ts, ri_row_id);
```

- [ ] **Step 4: Verify the schema mirrors already describe the composite index**

Run: `grep -n "resource_inbox_ix" apps/api-v1/prisma/schema.prisma apps/api-v1/src/db/in-memory-schema.sql`
Expected: `schema.prisma:24: @@index([ri_status, ri_type_id], map: "resource_inbox_ix")` and the
in-memory mirror lines 33-34 with the four-column index. Update `schema.prisma` line 24 to
`@@index([ri_status, ri_type_id, created_ts, ri_row_id], map: "resource_inbox_ix")` so Prisma's
model matches the database (the #521 squash changed this line already; if it already reads that
way, leave it).

- [ ] **Step 5: Type-check api-v1 and, when Docker is available, apply the migration**

Run: `cd apps/api-v1 && deno task check`
Expected: exit 0.

Run (only when Docker is available; otherwise record "skipped" in the PR body):
`npm run db:test:up`
Expected: `prisma migrate deploy` lists `20260908120000_resource_inbox_status_type_created_row_index` as applied.

- [ ] **Step 6: Commit**

```bash
git add apps/api-v1/prisma
git commit -m "fix(api-v1): add the resource_inbox_ix composite index as its own migration"
```

---

### Task 2: IndexedDB operation observer port

**Files:**

- Create: `packages/shared/persistence/indexed-db-operation-observer.ts`
- Test: `packages/tests/shared/persistence/indexed-db-operation-observer.test.ts`

**Interfaces:**

- Produces:
  - `type IndexedDbOperationOwner = 'al-admission' | 'al-work'`
  - `type IndexedDbOperationKind = 'read' | 'list' | 'write' | 'work-read' | 'work-write' | 'work-page' | 'work-reserve' | 'work-release' | 'work-probe' | 'work-cleanup'`
  - `interface IndexedDbOperation { readonly owner: IndexedDbOperationOwner; readonly kind: IndexedDbOperationKind; }`
  - `interface IndexedDbOperationObserver { observe(operation: IndexedDbOperation): void; }`
  - `interface IndexedDbOperationCounts { readonly total: number; readonly byOwner: Readonly<Record<IndexedDbOperationOwner, number>>; readonly byKind: Readonly<Partial<Record<IndexedDbOperationKind, number>>>; }`
  - `function createPassThroughIndexedDbOperationObserver(): IndexedDbOperationObserver`
  - `interface CountingIndexedDbOperationObserver extends IndexedDbOperationObserver { getCounts(): IndexedDbOperationCounts; reset(): void; }`
  - `function createCountingIndexedDbOperationObserver(): CountingIndexedDbOperationObserver`

- [ ] **Step 1: Write the failing test**

Create `packages/tests/shared/persistence/indexed-db-operation-observer.test.ts`:

```ts
import {
    createCountingIndexedDbOperationObserver,
    createPassThroughIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { describe, expect, it } from 'vitest';

describe('IndexedDB operation observer', () => {
    it('counts operations by owner and kind', () => {
        const observer = createCountingIndexedDbOperationObserver();
        observer.observe({ owner: 'al-admission', kind: 'read' });
        observer.observe({ owner: 'al-admission', kind: 'write' });
        observer.observe({ owner: 'al-work', kind: 'work-page' });

        expect(observer.getCounts()).toEqual({
            total: 3,
            byOwner: { 'al-admission': 2, 'al-work': 1 },
            byKind: { read: 1, write: 1, 'work-page': 1 }
        });
    });

    it('resets to zero and keeps counting afterwards', () => {
        const observer = createCountingIndexedDbOperationObserver();
        observer.observe({ owner: 'al-work', kind: 'work-reserve' });
        observer.reset();
        observer.observe({ owner: 'al-work', kind: 'work-release' });

        expect(observer.getCounts()).toEqual({
            total: 1,
            byOwner: { 'al-admission': 0, 'al-work': 1 },
            byKind: { 'work-release': 1 }
        });
    });

    it('pass-through observer accepts operations without state', () => {
        const observer = createPassThroughIndexedDbOperationObserver();
        expect(() => observer.observe({ owner: 'al-admission', kind: 'list' })).not.toThrow();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/persistence/indexed-db-operation-observer.test.ts`
Expected: FAIL, "Cannot find module '@shared/persistence/indexed-db-operation-observer.ts'".

- [ ] **Step 3: Write the port**

Create `packages/shared/persistence/indexed-db-operation-observer.ts`:

```ts
export type IndexedDbOperationOwner = 'al-admission' | 'al-work';

export type IndexedDbOperationKind =
    | 'read'
    | 'list'
    | 'write'
    | 'work-read'
    | 'work-write'
    | 'work-page'
    | 'work-reserve'
    | 'work-release'
    | 'work-probe'
    | 'work-cleanup';

export interface IndexedDbOperation {
    readonly owner: IndexedDbOperationOwner;
    readonly kind: IndexedDbOperationKind;
}

export interface IndexedDbOperationObserver {
    observe(operation: IndexedDbOperation): void;
}

export interface IndexedDbOperationCounts {
    readonly total: number;
    readonly byOwner: Readonly<Record<IndexedDbOperationOwner, number>>;
    readonly byKind: Readonly<Partial<Record<IndexedDbOperationKind, number>>>;
}

export interface CountingIndexedDbOperationObserver extends IndexedDbOperationObserver {
    getCounts(): IndexedDbOperationCounts;
    reset(): void;
}

export function createPassThroughIndexedDbOperationObserver(): IndexedDbOperationObserver {
    return { observe: () => {} };
}

export function createCountingIndexedDbOperationObserver(): CountingIndexedDbOperationObserver {
    let total = 0;
    let byOwner: Record<IndexedDbOperationOwner, number> = { 'al-admission': 0, 'al-work': 0 };
    let byKind: Partial<Record<IndexedDbOperationKind, number>> = {};
    return {
        observe(operation) {
            total += 1;
            byOwner = { ...byOwner, [operation.owner]: byOwner[operation.owner] + 1 };
            byKind = { ...byKind, [operation.kind]: (byKind[operation.kind] ?? 0) + 1 };
        },
        getCounts() {
            return { total, byOwner: { ...byOwner }, byKind: { ...byKind } };
        },
        reset() {
            total = 0;
            byOwner = { 'al-admission': 0, 'al-work': 0 };
            byKind = {};
        }
    };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/tests/shared/persistence/indexed-db-operation-observer.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/persistence/indexed-db-operation-observer.ts packages/tests/shared/persistence/indexed-db-operation-observer.test.ts
git commit -m "feat(persistence): add the IndexedDB operation observer port"
```

---

### Task 3: Count AL-owned IndexedDB operations in the admission backend and queue box

**Files:**

- Modify: `packages/shared/alm/indexed-db-admission-backend.ts:31-36` (Input), `:64-76` (constructor), `:81`, `:109`, `:142` (read, list, write)
- Modify: `packages/shared/queuebox/indexed-db-queue-box.ts:114` (constructor options), plus the bodies of `readWorkPage` (134), `cleanupAsync` (156), `enqueueIfAbsent` (192), `releaseEntries` (254), `reserveTimeoutEntries` (288), `reserveEntries` (338), `isAnyEntryToLock` (477), `getItem` (542)
- Modify: `packages/shared/alm/al-runtime-stores.ts:88-120` (`CreateIndexedDbALRuntimeStoresInput`, the two `createIndexedDbAL*RuntimeStores`, the two `createDefaultIndexedDbAL*RuntimeStores`)
- Test: `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`

**Interfaces:**

- Consumes: Task 2's port.
- Produces:
  - `IndexedDbAdmissionBackend.Input` gains `readonly observer: IndexedDbOperationObserver` (required).
  - `IndexedDbQueueBoxOptions` gains `readonly observer: IndexedDbOperationObserver` (required; the default `{}` argument is removed and every constructor site passes the field).
  - `CreateIndexedDbALRuntimeStoresInput` gains `readonly observer: IndexedDbOperationObserver` (required); `createDefaultIndexedDbALInboundRuntimeStores` and `createDefaultIndexedDbALOutboundRuntimeStores` supply `createPassThroughIndexedDbOperationObserver()` unless their options carry one (`options.observer`, an optional field on the sparse `CreateDefaultALRuntimeStoresInput` only).

- [ ] **Step 1: Find every constructor site that must pass the observer**

Run: `rg -n "new IndexedDbQueueBox\(|new IndexedDbAdmissionBackend\(" packages apps --glob '!**/node_modules/**'`
Expected: hits in `packages/shared/alm/al-runtime-stores.ts` (two), `packages/shared/alm/indexed-db-admission-backend.ts` (one, inside the backend), and test files under `packages/tests/shared/**`. Every hit is edited in this task.

- [ ] **Step 2: Write the failing test**

Create `packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts` (this repository's IndexedDB
tests use `fake-indexeddb/auto`; follow `packages/tests/shared/al-indexeddb-runtime-stores.test.ts`
for the import):

```ts
import 'fake-indexeddb/auto';
import { decodeALAdmissionString } from '@shared/alm/al-admission-value-validation.ts';
import { IndexedDbAdmissionBackend } from '@shared/alm/indexed-db-admission-backend.ts';
import { createCountingIndexedDbOperationObserver } from '@shared/persistence/indexed-db-operation-observer.ts';
import { IndexedDbStringPersistenceProvider } from '@shared/persistence/indexed-db-string-persistence-provider.ts';
import { describe, expect, it } from 'vitest';

describe('AL-owned IndexedDB operation counts', () => {
    it('counts admission reads, writes, and work operations through the backend', async () => {
        const observer = createCountingIndexedDbOperationObserver();
        const backend = new IndexedDbAdmissionBackend({
            dbName: `al-counts-${crypto.randomUUID()}`,
            storeName: IndexedDbStringPersistenceProvider.DEFAULT_STORE_NAME,
            nowMs: () => 1_000,
            newWriteToken: () => crypto.randomUUID(),
            observer
        });
        await backend.ready();

        await backend.read('missing', decodeALAdmissionString);
        await backend.write(async (tx) => {
            await tx.set('present', 'value');
        });
        await backend.workQueue.readWorkPage({
            typeId: 'AL_OUTBOUND:test',
            status: 'NEW',
            maxToRead: 4,
            cursor: null
        });

        const counts = observer.getCounts();
        expect(counts.byOwner['al-admission']).toBe(2);
        expect(counts.byKind.read).toBe(1);
        expect(counts.byKind.write).toBe(1);
        expect(counts.byKind['work-page']).toBe(1);
        expect(counts.byOwner['al-work']).toBe(1);
    });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/alm/al-indexeddb-operation-counts.test.ts`
Expected: FAIL with a TypeScript error that `observer` is not in `IndexedDbAdmissionBackend.Input`
(or a runtime failure that `getCounts` is all zero).

- [ ] **Step 4: Add the observer to the queue box**

In `packages/shared/queuebox/indexed-db-queue-box.ts`, locate the options interface used by the
constructor at line 114 (`constructor(options: IndexedDbQueueBoxOptions = {})`). Add the field and
remove the default argument:

```ts
export interface IndexedDbQueueBoxOptions {
    // existing fields stay (connection, dbName, storeName, now); add:
    readonly observer: IndexedDbOperationObserver;
}
```

```ts
    readonly #observer: IndexedDbOperationObserver;

    constructor(options: IndexedDbQueueBoxOptions) {
        this.#observer = options.observer;
        // existing body unchanged
    }
```

Add the import `import type { IndexedDbOperationObserver } from '../persistence/indexed-db-operation-observer.ts';`.

Add one `this.#observer.observe({ owner: 'al-work', kind: '<kind>' });` as the first statement of each
public method, with these kinds: `readWorkPage` → `'work-page'`, `cleanupAsync` → `'work-cleanup'`,
`enqueueIfAbsent` → `'work-write'`, `releaseEntries` → `'work-release'`, `reserveTimeoutEntries` →
`'work-reserve'`, `reserveEntries` → `'work-reserve'`, `reserveRetryExhaustionFinalizations` →
`'work-reserve'`, `isAnyEntryToLock` → `'work-probe'`, `getItem` → `'work-read'`.

- [ ] **Step 5: Add the observer to the admission backend**

In `packages/shared/alm/indexed-db-admission-backend.ts`:

```ts
export namespace IndexedDbAdmissionBackend {
    export interface Input {
        readonly dbName: string;
        readonly storeName: string;
        readonly nowMs: () => number;
        readonly newWriteToken: () => string;
        readonly observer: IndexedDbOperationObserver;
    }
}
```

In the constructor, store `this.#observer = input.observer;` and pass `observer: input.observer`
into the `new IndexedDbQueueBox({ ... })` construction of `workQueue`. Add as the first statement:
`read` → `this.#observer.observe({ owner: 'al-admission', kind: 'read' });`, `list` → `'list'`,
`write` → `'write'`.

- [ ] **Step 6: Thread the observer through the runtime store factories**

In `packages/shared/alm/al-runtime-stores.ts`:

```ts
export interface CreateIndexedDbALRuntimeStoresInput extends CreateInMemoryALRuntimeStoresInput {
    readonly dbName: string | undefined;
    readonly observer: IndexedDbOperationObserver;
}
```

Pass `observer: input.observer` into both `new IndexedDbAdmissionBackend({...})` calls. In
`toDefaultIndexedDbInput(options)` (the composition helper used by the two `createDefault…`
functions) add `observer: options.observer ?? createPassThroughIndexedDbOperationObserver()`, and
add `readonly observer?: IndexedDbOperationObserver;` to the sparse `CreateDefaultALRuntimeStoresInput`
only.

- [ ] **Step 7: Update every other constructor site found in Step 1**

For each test file from Step 1, pass `observer: createPassThroughIndexedDbOperationObserver()` in the
constructor options.

- [ ] **Step 8: Run the focused tests and the package typecheck**

Run: `npx vitest run packages/tests/shared/alm packages/tests/shared/al-indexeddb-runtime-stores.test.ts packages/tests/shared/indexeddb-queuebox.test.ts packages/tests/shared/indexeddb-queuebox-computed-write.test.ts`
Expected: PASS.

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/shared packages/tests/shared
git commit -m "feat(alm): count AL-owned IndexedDB operations through a required observer port"
```

---

### Task 4: Transport fault port

**Files:**

- Create: `packages/shared/transport-faults/transport-fault-port.ts`
- Test: `packages/tests/shared/transport-faults/transport-fault-port.test.ts`

**Interfaces:**

- Produces:
  - `type TransportFaultCarrier = 'ws' | 'rtc'`
  - `type TransportFaultDecision = { readonly kind: 'pass' } | { readonly kind: 'drop'; readonly faultId: string } | { readonly kind: 'delay'; readonly faultId: string; readonly delayMs: number }`
  - `interface TransportFaultPort { decideSend(carrier: TransportFaultCarrier, serialized: string): TransportFaultDecision; }`
  - `interface TransportFaultMatch { readonly controlType: 'ack' | 'nack' | 'repair' | undefined; readonly typeId: string | undefined; readonly msgId: string | undefined; }`
  - `interface ScriptedTransportFault { readonly faultId: string; readonly carrier: TransportFaultCarrier; readonly match: TransportFaultMatch; readonly action: 'drop' | { readonly delayMs: number }; readonly remaining: number; }`
  - `interface TransportFaultObservation { readonly faultId: string; readonly carrier: TransportFaultCarrier; readonly decision: 'drop' | 'delay'; }`
  - `interface ScriptedTransportFaultPort extends TransportFaultPort { inject(fault: ScriptedTransportFault): void; clear(): void; getObservations(): readonly TransportFaultObservation[]; }`
  - `function createPassThroughTransportFaultPort(): TransportFaultPort`
  - `function createScriptedTransportFaultPort(): ScriptedTransportFaultPort`

Matching reads the serialized AL envelope: `typeId` from `route.typeId`... Note: an AL control message
carries its control type in its `typeId` (`AL_CONTROL_ACK_TYPE_ID` and siblings exported from
`packages/shared/al-contracts/al-control.ts`) and the acknowledged message id in its payload
(`ackedMsgId`); a data message carries `id.msgId` and `typeId`. The matcher parses the JSON once and
compares those fields; a non-JSON frame never matches.

- [ ] **Step 1: Write the failing test**

Create `packages/tests/shared/transport-faults/transport-fault-port.test.ts`:

```ts
import { AL_CONTROL_ACK_TYPE_ID } from '@shared/al-contracts/al-control.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { describe, expect, it } from 'vitest';

const ackFrame = JSON.stringify({
    id: { v: 2, msgId: 'ctl-1', senderId: 'b', ts: 1 },
    typeId: AL_CONTROL_ACK_TYPE_ID,
    payload: { ackedMsgId: 'msg-1', fromPeerId: 'b', toPeerId: 'a' }
});
const dataFrame = JSON.stringify({
    id: { v: 2, msgId: 'msg-1', senderId: 'a', ts: 1 },
    typeId: 'chat',
    payload: {}
});

describe('transport fault port', () => {
    it('passes everything through by default', () => {
        const port = createPassThroughTransportFaultPort();
        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'pass' });
    });

    it('drops a matching ACK the configured number of times and records it', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-ack',
            carrier: 'ws',
            match: { controlType: 'ack', typeId: undefined, msgId: 'msg-1' },
            action: 'drop',
            remaining: 1
        });

        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'drop', faultId: 'drop-ack' });
        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'pass' });
        expect(port.decideSend('rtc', ackFrame)).toEqual({ kind: 'pass' });
        expect(port.getObservations()).toEqual([{
            faultId: 'drop-ack',
            carrier: 'ws',
            decision: 'drop'
        }]);
    });

    it('delays a matching data message and ignores non-JSON frames', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'slow-chat',
            carrier: 'rtc',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: { delayMs: 250 },
            remaining: 2
        });

        expect(port.decideSend('rtc', dataFrame)).toEqual({
            kind: 'delay',
            faultId: 'slow-chat',
            delayMs: 250
        });
        expect(port.decideSend('rtc', 'not json')).toEqual({ kind: 'pass' });
        port.clear();
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'pass' });
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/transport-faults/transport-fault-port.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the port**

Create `packages/shared/transport-faults/transport-fault-port.ts`:

```ts
import {
    AL_CONTROL_ACK_TYPE_ID,
    AL_CONTROL_NACK_TYPE_ID,
    AL_CONTROL_REPAIR_TYPE_ID
} from '../al-contracts/al-control.ts';

export type TransportFaultCarrier = 'ws' | 'rtc';

export type TransportFaultDecision =
    | Readonly<{ kind: 'pass'; }>
    | Readonly<{ kind: 'drop'; faultId: string; }>
    | Readonly<{ kind: 'delay'; faultId: string; delayMs: number; }>;

export interface TransportFaultPort {
    decideSend(carrier: TransportFaultCarrier, serialized: string): TransportFaultDecision;
}

export interface TransportFaultMatch {
    readonly controlType: 'ack' | 'nack' | 'repair' | undefined;
    readonly typeId: string | undefined;
    readonly msgId: string | undefined;
}

export interface ScriptedTransportFault {
    readonly faultId: string;
    readonly carrier: TransportFaultCarrier;
    readonly match: TransportFaultMatch;
    readonly action: 'drop' | Readonly<{ delayMs: number; }>;
    readonly remaining: number;
}

export interface TransportFaultObservation {
    readonly faultId: string;
    readonly carrier: TransportFaultCarrier;
    readonly decision: 'drop' | 'delay';
}

export interface ScriptedTransportFaultPort extends TransportFaultPort {
    inject(fault: ScriptedTransportFault): void;
    clear(): void;
    getObservations(): readonly TransportFaultObservation[];
}

interface SerializedFrameFacts {
    readonly typeId: string | undefined;
    readonly msgId: string | undefined;
    readonly ackedMsgId: string | undefined;
}

const CONTROL_TYPE_IDS = {
    ack: AL_CONTROL_ACK_TYPE_ID,
    nack: AL_CONTROL_NACK_TYPE_ID,
    repair: AL_CONTROL_REPAIR_TYPE_ID
} as const;

export function createPassThroughTransportFaultPort(): TransportFaultPort {
    return { decideSend: () => ({ kind: 'pass' }) };
}

export function createScriptedTransportFaultPort(): ScriptedTransportFaultPort {
    const faults = new Map<string, ScriptedTransportFault>();
    const observations: TransportFaultObservation[] = [];
    return {
        inject(fault) {
            faults.set(fault.faultId, fault);
        },
        clear() {
            faults.clear();
        },
        getObservations() {
            return [...observations];
        },
        decideSend(carrier, serialized) {
            const facts = toSerializedFrameFacts(serialized);
            if (facts === undefined) {
                return { kind: 'pass' };
            }
            for (const fault of faults.values()) {
                if (
                    fault.carrier !== carrier || fault.remaining <= 0 ||
                    !matchesFault(fault.match, facts)
                ) {
                    continue;
                }
                faults.set(fault.faultId, { ...fault, remaining: fault.remaining - 1 });
                if (fault.action === 'drop') {
                    observations.push({ faultId: fault.faultId, carrier, decision: 'drop' });
                    return { kind: 'drop', faultId: fault.faultId };
                }
                observations.push({ faultId: fault.faultId, carrier, decision: 'delay' });
                return { kind: 'delay', faultId: fault.faultId, delayMs: fault.action.delayMs };
            }
            return { kind: 'pass' };
        }
    };
}

function matchesFault(match: TransportFaultMatch, facts: SerializedFrameFacts): boolean {
    if (match.controlType !== undefined && facts.typeId !== CONTROL_TYPE_IDS[match.controlType]) {
        return false;
    }
    if (match.typeId !== undefined && facts.typeId !== match.typeId) {
        return false;
    }
    if (
        match.msgId !== undefined && facts.msgId !== match.msgId && facts.ackedMsgId !== match.msgId
    ) {
        return false;
    }
    return true;
}

function toSerializedFrameFacts(serialized: string): SerializedFrameFacts | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(serialized);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const id = typeof record.id === 'object' && record.id !== null
        ? record.id as Record<string, unknown>
        : {};
    const payload = typeof record.payload === 'object' && record.payload !== null
        ? record.payload as Record<string, unknown>
        : {};
    return {
        typeId: typeof record.typeId === 'string' ? record.typeId : undefined,
        msgId: typeof id.msgId === 'string' ? id.msgId : undefined,
        ackedMsgId: typeof payload.ackedMsgId === 'string' ? payload.ackedMsgId : undefined
    };
}
```

Check the three control type-id constant names first with
`grep -n "export const AL_CONTROL_" packages/shared/al-contracts/al-control.ts`; use the exact
exported names.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/tests/shared/transport-faults/transport-fault-port.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/transport-faults packages/tests/shared/transport-faults
git commit -m "feat(transport): add the scripted transport fault port"
```

---

### Task 5: Consult the fault port in the WS client and the RTC data channel

**Files:**

- Modify: `packages/shared/websocket/json-web-socket-client.ts:24-40` (constructor), `:226` (`sendAsJsonString`)
- Modify: `packages/shared/webrtc/qrtc-data-channel.ts:197` (constructor), the native send site inside the flush path (search `this.channel.send(` or `channel.send(`; there is exactly one native send for JSON payloads)
- Test: `packages/tests/shared/websocket/json-web-socket-client-faults.test.ts`; extend `packages/tests/shared/qrtc-data-channel.test.ts`

**Interfaces:**

- Consumes: Task 4's `TransportFaultPort`.
- Produces: `JsonWebSocketClient` constructor becomes `constructor(url: string | WebSocketUrlProvider, faultPort: TransportFaultPort)`; `QRtcDataChannel` constructor input gains `readonly faultPort: TransportFaultPort` (required). A dropped WS frame is not sent and emits no error; a delayed WS frame is sent after `delayMs` via `setTimeout`; a dropped RTC frame settles as `{ status: 'dropped', submissionAttempted: false }` through the existing `settleSend`; RTC delay is not supported in F1 (decision `delay` on `rtc` is treated as `pass`; documented in the port's test).

- [ ] **Step 1: Find the constructor sites**

Run: `rg -n "new JsonWebSocketClient\(|new QRtcDataChannel\(" packages apps --glob '!**/node_modules/**'`
Expected: production sites in `packages/shared-web/browser/connection/initialise-browser-middleware.ts:234`,
the RTC runtime under `packages/shared/services/` or `packages/shared-web/browser/rtc/`, and tests.
Every hit is edited in this task; production sites receive the port from Task 6's setup threading,
so in this task pass `createPassThroughTransportFaultPort()` at each production site and replace it in
Task 6.

- [ ] **Step 2: Write the failing WS test**

Create `packages/tests/shared/websocket/json-web-socket-client-faults.test.ts` (model the fake socket on
`packages/tests/shared/services/ws-queue-box-client-ingress.test.ts`, which already fakes a WebSocket):

```ts
import { createScriptedTransportFaultPort } from '@shared/transport-faults/transport-fault-port.ts';
import { JsonWebSocketClient } from '@shared/websocket/json-web-socket-client.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
    readonly sent: string[] = [];
    readyState = 1;
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string; }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {
        this.readyState = 3;
        this.onclose?.();
    }
}

describe('JsonWebSocketClient fault port', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('drops a matching frame and delays another before sending', async () => {
        vi.useFakeTimers();
        const socket = new FakeSocket();
        vi.stubGlobal(
            'WebSocket',
            class {
                constructor() {
                    return socket;
                }
            }
        );
        const faults = createScriptedTransportFaultPort();
        faults.inject({
            faultId: 'drop-chat',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: 'drop',
            remaining: 1
        });
        faults.inject({
            faultId: 'slow-status',
            carrier: 'ws',
            match: { controlType: undefined, typeId: 'status', msgId: undefined },
            action: { delayMs: 100 },
            remaining: 1
        });
        const client = new JsonWebSocketClient('ws://test', faults);
        await client.connect({});
        socket.onopen?.();

        client.sendAsJsonString(JSON.stringify({ id: { msgId: '1' }, typeId: 'chat' }));
        client.sendAsJsonString(JSON.stringify({ id: { msgId: '2' }, typeId: 'status' }));
        expect(socket.sent).toEqual([]);

        await vi.advanceTimersByTimeAsync(100);
        expect(socket.sent).toEqual([JSON.stringify({ id: { msgId: '2' }, typeId: 'status' })]);
        expect(faults.getObservations().map((observation) => observation.decision)).toEqual([
            'drop',
            'delay'
        ]);
    });
});
```

Adjust `connect({})` and the open handshake to the client's real API (read lines 33-120 of the
client first; the test must drive the same open path the production client uses).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared/websocket/json-web-socket-client-faults.test.ts`
Expected: FAIL: the constructor rejects a second argument, or both frames are sent immediately.

- [ ] **Step 4: Implement the WS consult**

In `packages/shared/websocket/json-web-socket-client.ts`:

```ts
import type { TransportFaultPort } from '../transport-faults/transport-fault-port.ts';

export class JsonWebSocketClient {
    private readonly faultPort: TransportFaultPort;

    constructor(url: string | WebSocketUrlProvider, faultPort: TransportFaultPort) {
        // existing initialisation unchanged
        this.faultPort = faultPort;
    }

    sendAsJsonString(data: string): void {
        const decision = this.faultPort.decideSend('ws', data);
        if (decision.kind === 'drop') {
            return;
        }
        if (decision.kind === 'delay') {
            setTimeout(() => this.writeToSocket(data), decision.delayMs);
            return;
        }
        this.writeToSocket(data);
    }

    private writeToSocket(data: string): void {
        // the existing body of sendAsJsonString moves here unchanged
    }
}
```

- [ ] **Step 5: Implement the RTC consult**

In `packages/shared/webrtc/qrtc-data-channel.ts` add `readonly faultPort: TransportFaultPort;` to the
constructor input interface used at line 197 and store it. At the one native JSON send site (the
call `channel.send(serialized)` reached from the flush of a queued JSON payload, near line 304), wrap:

```ts
const decision = this.faultPort.decideSend('rtc', serialized);
if (decision.kind === 'drop') {
    this.settleSend(options.onSettled, {
        status: 'dropped',
        key: options.key,
        submissionAttempted: false
    });
    return;
}
// 'pass' and 'delay' both continue to the native send in F1
```

Use the exact settlement shape the file already builds for a `dropped` outcome (search
`status: 'dropped'` in the file and reuse its fields).

- [ ] **Step 6: Extend the data-channel test**

In `packages/tests/shared/qrtc-data-channel.test.ts`, add a test that injects a scripted port with a
`drop` fault matching `typeId: 'chat'`, sends one JSON frame, and asserts `onSettled` received
`status: 'dropped'` with `submissionAttempted: false` and the fake native channel's `send` was not
called. Update every `new QRtcDataChannel({...})` in the file to pass
`faultPort: createPassThroughTransportFaultPort()`.

- [ ] **Step 7: Update the remaining constructor sites from Step 1 with the pass-through port**

- [ ] **Step 8: Run tests and typechecks**

Run: `npx vitest run packages/tests/shared/websocket packages/tests/shared/qrtc-data-channel.test.ts packages/tests/shared/services packages/tests/shared-web/rtc`
Expected: PASS.

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit && npm --workspace @ar-eye-hunter/shared-web run typecheck && npm --workspace @ar-eye-hunter/shared-server run typecheck`
Expected: exit 0 for all three.

- [ ] **Step 9: Commit**

```bash
git add packages/shared packages/shared-web packages/tests
git commit -m "feat(transport): consult the fault port before WS and RTC sends"
```

---

### Task 6: Thread the diagnostics ports through the browser facade setup

**Files:**

- Modify: `packages/shared-web/browser/rallar.ts` (the `RallarSetupInput` type it exports; find its definition with `rg -n "interface RallarSetupInput" packages/shared-web`)
- Modify: `packages/shared-web/browser/connection/initialise-browser-middleware.ts:198` (`configureBrowserALRuntimeStores(sessionId)`), `:234` (`new JsonWebSocketClient(...)`)
- Modify: `packages/shared-web/browser/al-runtime/browser-al-runtime-stores.ts` (`configureBrowserALRuntimeStores` options)
- Modify: the RTC runtime file that constructs `QRtcDataChannel` (found in Task 5 Step 1)
- Test: extend `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts` with one case

**Interfaces:**

- Produces: `RallarSetupInput` gains the sparse boundary field
  `readonly diagnosticsPorts?: { readonly transportFaultPort?: TransportFaultPort; readonly indexedDbOperationObserver?: IndexedDbOperationObserver; }`.
  Setup normalizes it once into a required `RallarDiagnosticsPorts { readonly transportFaultPort: TransportFaultPort; readonly indexedDbOperationObserver: IndexedDbOperationObserver; }` with pass-through defaults, and every downstream input (`initialiseBrowserMiddleware`, `configureBrowserALRuntimeStores`, the RTC runtime input) carries the required object.

- [ ] **Step 1: Locate the setup boundary and the middleware input**

Run: `rg -n "interface RallarSetupInput|initialiseBrowserMiddleware\(|configureBrowserALRuntimeStores\(" packages/shared-web/browser`
Expected: the setup type definition, one call of `initialiseBrowserMiddleware`, and one call of
`configureBrowserALRuntimeStores` (line 198 of the middleware).

- [ ] **Step 2: Write the failing test**

Add to `packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`:

```ts
it('routes IndexedDB operations to the configured observer', async () => {
    const observer = createCountingIndexedDbOperationObserver();
    configureBrowserALRuntimeStores('session-observer', {
        diagnosticsPorts: {
            transportFaultPort: createPassThroughTransportFaultPort(),
            indexedDbOperationObserver: observer
        }
    });
    const stores = resolveBrowserWsClientALOutboundRuntimeStores('session-observer');
    await stores.admissionStore.ready();

    expect(observer.getCounts().total).toBeGreaterThan(0);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared-web/al-runtime/browser-al-runtime-stores.test.ts`
Expected: FAIL, `diagnosticsPorts` is not an accepted option.

- [ ] **Step 4: Define the normalized ports contract and thread it**

Create the contract beside the setup owner (in the file that defines `RallarSetupInput`):

```ts
export interface RallarDiagnosticsPorts {
    readonly transportFaultPort: TransportFaultPort;
    readonly indexedDbOperationObserver: IndexedDbOperationObserver;
}

export function toRallarDiagnosticsPorts(
    input: RallarSetupInput['diagnosticsPorts']
): RallarDiagnosticsPorts {
    return {
        transportFaultPort: input?.transportFaultPort ?? createPassThroughTransportFaultPort(),
        indexedDbOperationObserver: input?.indexedDbOperationObserver ??
            createPassThroughIndexedDbOperationObserver()
    };
}
```

Call `toRallarDiagnosticsPorts` once where setup input is normalized, store the result in the same
config object that already reaches `initialiseBrowserMiddleware`, then:

- `initialiseBrowserMiddleware`: replace `configureBrowserALRuntimeStores(sessionId)` with
  `configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts })` and
  `new JsonWebSocketClient(async (connectOptions) => {...})` with
  `new JsonWebSocketClient(async (connectOptions) => {...}, diagnosticsPorts.transportFaultPort)`.
- `configureBrowserALRuntimeStores(sessionId, options)`: accept `diagnosticsPorts: RallarDiagnosticsPorts`
  on the options (make `BrowserALRuntimeOptions` carry it as a required field of a new
  `ConfigureBrowserALRuntimeStoresInput`), pass `observer: options.diagnosticsPorts.indexedDbOperationObserver`
  into the persistent store options.
- RTC runtime: pass `faultPort: diagnosticsPorts.transportFaultPort` to every `new QRtcDataChannel({...})`.

- [ ] **Step 5: Run the test to verify it passes, then the shared-web suites**

Run: `npx vitest run packages/tests/shared-web/al-runtime packages/tests/shared-web/rtc packages/tests/shared-web/shared-web-public-api-snapshots.test.ts`
Expected: PASS. If the public API snapshot changes because `RallarSetupInput` gained a field, update
the snapshot in the same commit and mention it in the PR body.

Run: `npm --workspace @ar-eye-hunter/shared-web run typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-web packages/tests/shared-web
git commit -m "feat(shared-web): thread transport fault and IndexedDB observer ports through setup"
```

---

### Task 7: Narrow `rallar-messages` entry point with its own budget

**Files:**

- Create: `packages/shared-web/browser/rallar-messages.ts`
- Modify: `packages/shared-web/scripts/measure-browser-bundles.mjs:30-70`
- Modify: `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts:13-75`
- Modify: `packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts:39-75`

**Interfaces:**

- Produces: `@shared-web/browser/rallar-messages.ts` re-exporting `rallar-core.ts` plus the runtime
  exports `createRallarMessageSelector`-style functions that already live in
  `packages/shared-web/browser/messages/rallar-message-selectors.ts`, and the message contract types.
  It must not import `rallar.ts`, `createRallarFacade`, or any facade factory.

- [ ] **Step 1: Write the failing entrypoint test entry**

Add to `BROWSER_ENTRYPOINTS` in `packages/tests/shared-web/shared-web-browser-entrypoints.test.ts`:

```ts
{
    moduleId: '@shared-web/browser/rallar-messages.ts',
    sourcePath: 'packages/shared-web/browser/rallar-messages.ts',
    expectedRuntimeExports: [
        'configureApiClient',
        'matchesRallarMessageSelector',
        'normalizeRallarMessageSelector',
        'normalizeApiBaseUrl',
        'readApiBaseUrl',
        'toRoomFormationDenial'
    ],
    forbiddenRuntimeExports: [
        'createRallarCrdtFacade',
        'createRallarDataFacade',
        'createRallarFacade',
        'createRallarMediaFacade',
        'createRallarCallsFacade',
        'createRallarRealtimeFacade',
        'createRallarRtcFacade',
        'rallar'
    ]
},
```

Add to `budgetedEntries` in `shared-web-browser-bundle-boundaries.test.ts` and to `entries` in
`measure-browser-bundles.mjs` (same shape as the `rallar-realtime.ts` entry):

```js
{
    label: 'browser/rallar-messages.ts',
    entry: 'packages/shared-web/browser/rallar-messages.ts',
    output: 'rallar-browser-messages.min.js',
    brotliBudgetKiB: 100
},
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
Expected: FAIL, the source path does not exist.

- [ ] **Step 3: Create the entry point**

Create `packages/shared-web/browser/rallar-messages.ts`:

```ts
export * from '@shared-web/browser/rallar-core.ts';

export type {
    RallarMessage,
    RallarMessageHandler,
    RallarMessageLane,
    RallarMessagePayload,
    RallarMessageSendBase,
    RallarMessageSendResult,
    RallarMessageTransport,
    RallarRoomMessageChannelDefinition,
    RallarRtcSendInput,
    RallarTypedMessageChannel,
    RallarTypedMessageChannelDefinition,
    RallarTypedMessageSendOptions,
    RallarTypedMessageSendStrategy,
    RallarTypedPayloadHandler,
    RallarTypedRtcSendOptions,
    RallarTypedWsSendOptions,
    RallarWsSendInput
} from '@shared-web/browser/messages/rallar-message-contracts.ts';

export type {
    RallarMessagesOperations,
    RallarRtcMessageLane,
    RallarWsMessageLane
} from '@shared-web/browser/messages/rallar-message-operations.ts';
```

- [ ] **Step 4: Measure and set the budget from the measurement**

Run: `npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles`
Expected: the table lists `browser/rallar-messages.ts` with a Brotli size well under 100 KiB (types
erase; the runtime payload is the core). Set `brotliBudgetKiB` in both files to the next whole KiB
above the measured figure plus 10 KiB of headroom for S1's handle, and record the measured figure in
the commit message. Record the aggregate facade figure too; if it is at or above its budget, raise the
budget to the next whole KiB and record it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run packages/tests/shared-web/shared-web-browser-entrypoints.test.ts packages/tests/shared-web/shared-web-browser-bundle-boundaries.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-web packages/tests/shared-web
git commit -m "feat(shared-web): add the rallar-messages entry point (measured <n> KiB Brotli)"
```

---

### Task 8: Recipe command contracts for the ALM operations

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/types.ts:1-40` (command kinds), `:257-270` (beside `RtcSendCommand`), `:560-580` (union)
- Modify: `packages/shared-test/rallar-bb-test/schema.ts` (beside the `'rtc.send'` entry; `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` at line 777)
- Modify: `packages/shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts`
- Test: `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`

**Interfaces:**

- Produces the following command types (all `& RallarBlackBoxTestCommandBase<'…'>`):

```ts
export type RallarBlackBoxTestMessagesCarrier = 'ws' | 'rtc' | 'rtc-with-ws-fallback';

export type RallarBlackBoxTestMessagesSendCommand =
    & RallarBlackBoxTestCommandBase<'messages.send'>
    & Readonly<{
        connection?: string;
        carrier: RallarBlackBoxTestMessagesCarrier;
        typeId: string;
        topicId?: string;
        payload: unknown;
        roomRef?: RallarBlackBoxTestRecord;
        scope?: RallarBlackBoxTestRecord;
        reliability?: 'best-effort' | 'at-least-once';
        ack?: 'none' | 'receiver' | 'all-logical-recipients' | 'group-leader';
        ttlMs?: number;
        orderingKey?: string;
        seq?: number;
        key?: string;
        toPeerId?: string;
        handleId?: string;
    }>;

export type RallarBlackBoxTestMessagesObserveCommand =
    & RallarBlackBoxTestCommandBase<'messages.observe'>
    & Readonly<{
        connection?: string;
        handleId: string;
        state: readonly string[];
    }>;

export type RallarBlackBoxTestMessagesCancelCommand =
    & RallarBlackBoxTestCommandBase<'messages.cancel'>
    & Readonly<{ connection?: string; handleId: string; }>;

export type RallarBlackBoxTestMessagesReceivedCommand =
    & RallarBlackBoxTestCommandBase<'messages.received'>
    & Readonly<{
        connection?: string;
        typeId: string;
        msgId?: string;
        count: number;
        absent?: boolean;
        windowMs: number;
    }>;

export type RallarBlackBoxTestMessagesReceiptsCommand =
    & RallarBlackBoxTestCommandBase<'messages.receipts'>
    & Readonly<{ connection?: string; handleId: string; }>;

export type RallarBlackBoxTestFaultInjectCommand =
    & RallarBlackBoxTestCommandBase<'fault.inject'>
    & Readonly<{
        faultId: string;
        carrier: 'ws' | 'rtc';
        match: Readonly<
            { controlType?: 'ack' | 'nack' | 'repair'; typeId?: string; msgId?: string; }
        >;
        action: 'drop' | Readonly<{ delayMs: number; }>;
        remaining: number;
    }>;

export type RallarBlackBoxTestStorageCountersCommand =
    & RallarBlackBoxTestCommandBase<'storage.counters'>
    & Readonly<{ reset?: boolean; }>;

export type RallarBlackBoxTestAgentReloadCommand =
    & RallarBlackBoxTestCommandBase<'agent.reload'>
    & Readonly<{ readyTimeoutMs: number; }>;
```

and the result value shapes the adapter returns:

```ts
export type RallarBlackBoxTestMessagesSendResultValue = Readonly<{
    handleId: string;
    msgId: string;
    carrier: RallarBlackBoxTestMessagesCarrier;
    status: string;
    reason?: string;
}>;

export type RallarBlackBoxTestMessagesObserveResultValue = Readonly<{
    handleId: string;
    state: string;
    submitted: boolean;
    confirmedPeerIds: readonly string[];
    unconfirmedPeerIds: readonly string[];
    attempts: number;
}>;

export type RallarBlackBoxTestStorageCountersResultValue = Readonly<{
    total: number;
    byOwner: Readonly<Record<'al-admission' | 'al-work', number>>;
    byKind: Readonly<Record<string, number>>;
}>;
```

- [ ] **Step 1: Write the failing schema test**

Create `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`:

```ts
import { validateRallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/schema.ts';
import { RALLAR_BLACK_BOX_TEST_COMMAND_KINDS } from '@shared-test/rallar-bb-test/types.ts';
import { describe, expect, it } from 'vitest';

const ALM_COMMAND_KINDS = [
    'messages.send',
    'messages.observe',
    'messages.cancel',
    'messages.received',
    'messages.receipts',
    'fault.inject',
    'storage.counters',
    'agent.reload'
] as const;

describe('ALM recipe commands', () => {
    it('registers every ALM command kind', () => {
        for (const kind of ALM_COMMAND_KINDS) {
            expect(RALLAR_BLACK_BOX_TEST_COMMAND_KINDS).toContain(kind);
        }
    });

    it('accepts a valid messages.send and rejects a send without a carrier', () => {
        const valid = validateRallarBlackBoxTestRecipe({
            recipeId: 'alm-send',
            name: 'alm send',
            commands: [{
                kind: 'messages.send',
                commandId: 'send-1',
                timeoutMs: 5_000,
                carrier: 'ws',
                typeId: 'alm.conformance',
                payload: { n: 1 },
                handleId: 'h-1'
            }]
        });
        expect(valid.left).toBeUndefined();

        const invalid = validateRallarBlackBoxTestRecipe({
            recipeId: 'alm-send',
            name: 'alm send',
            commands: [{
                kind: 'messages.send',
                commandId: 'send-2',
                timeoutMs: 5_000,
                typeId: 'x',
                payload: {}
            }]
        });
        expect(invalid.left?.message).toContain('carrier');
    });
});
```

Confirm the validator's exported name first with `grep -n "^export function validate" packages/shared-test/rallar-bb-test/schema.ts`
and use that name.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
Expected: FAIL: the kinds are not registered.

- [ ] **Step 3: Register the kinds, types, and schema**

In `types.ts` add the eight kinds to `RALLAR_BLACK_BOX_TEST_COMMAND_KINDS` after `'rtc.stream'`,
add the command and result types above beside `RallarBlackBoxTestRtcSendCommand`, and add the eight
command types to the `RallarBlackBoxTestCommand` union.

In `schema.ts`, beside the `'rtc.send'` entry, add one `strictCommandSchema` per kind. Required
property lists follow the types: `messages.send` requires `['carrier', 'typeId', 'payload']` with
`carrier: { type: 'string', enum: ['ws', 'rtc', 'rtc-with-ws-fallback'] }`; `messages.observe`
requires `['handleId', 'state']`; `messages.cancel` and `messages.receipts` require `['handleId']`;
`messages.received` requires `['typeId', 'count', 'windowMs']`; `fault.inject` requires
`['faultId', 'carrier', 'match', 'action', 'remaining']`; `storage.counters` requires `[]`;
`agent.reload` requires `['readyTimeoutMs']`. Use `stringSchema`, `numberSchema`, `booleanSchema`,
`recordSchema`, `anySchema` as the file does for the other commands.

In `RALLAR_BLACK_BOX_COMMAND_CAPABILITIES` add the eight kinds with the same capability record
shape the `'rtc.send'` entry uses, marked browser-only where the file distinguishes surfaces.

In `control-agent-capabilities.ts`, add `messaging: { supported: true, carriers: ['ws', 'rtc', 'rtc-with-ws-fallback'], faults: true, storageCounters: true, reload: true }`
to the returned capability block, and extend `RallarBlackBoxControlAgentCapabilities` in
`packages/shared-test/rallar-bb-test/distributed-run.ts` accordingly (required fields).

- [ ] **Step 4: Run the test and the existing harness tests**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts packages/tests/shared-test/rallar-bb-test.test.ts packages/tests/shared-test/rallar-bb-test-schema.test.ts packages/tests/rallar-black-box/schema-authoring.test.ts`
Expected: PASS. If `schema-authoring.test.ts` snapshots the command list, update the snapshot in this
commit.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-test packages/tests
git commit -m "feat(rallar-bb-test): add the ALM messaging, fault, storage, and reload command contracts"
```

---

### Task 9: Page-side runtime operations for typed sends, delivery observation, faults, and counters

**Files:**

- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts:48-62`
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts` (new input/diagnostics interfaces)
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-command-input.ts` (decoders)
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/messaging-controller.ts` (typed send + delivery ledger)
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts` (delegation)
- Modify: `packages/shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts:164` (create the scripted fault port and counting observer and pass them to `rallar.setup`)
- Modify: `packages/shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts:97-115` (new bridge methods)
- Test: `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts` (extend)

**Interfaces:**

- Consumes: `RallarMessagesOperations.room(definition).send(payload, { strategy, ... })` and `.ws.send` / `.rtc.send`; `ScriptedTransportFaultPort`; `CountingIndexedDbOperationObserver`; `RallarSetupInput.diagnosticsPorts` from Task 6.
- Produces on `BlackBoxRallarRuntime`:

```ts
sendMessage(input: unknown): Promise<BlackBoxRallarMessageSendDiagnostics>;
observeDelivery(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
cancelDelivery(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
readReceipts(input: unknown): Promise<BlackBoxRallarDeliveryObservation>;
injectFault(input: unknown): Promise<void>;
readStorageCounters(input: unknown): Promise<BlackBoxRallarStorageCounters>;
```

with:

```ts
export interface BlackBoxRallarMessageSendInput {
    readonly connection: string;
    readonly carrier: 'ws' | 'rtc' | 'rtc-with-ws-fallback';
    readonly typeId: string;
    readonly topicId: string | undefined;
    readonly payload: unknown;
    readonly roomRef: BlackBoxRallarRoomRef | undefined;
    readonly reliability: 'best-effort' | 'at-least-once' | undefined;
    readonly ack: ALAckMode | undefined;
    readonly ttlMs: number | undefined;
    readonly orderingKey: string | undefined;
    readonly seq: number | undefined;
    readonly key: string | undefined;
    readonly toPeerId: string | undefined;
    readonly handleId: string;
}

export interface BlackBoxRallarMessageSendDiagnostics {
    readonly handleId: string;
    readonly msgId: string;
    readonly carrier: BlackBoxRallarMessageSendInput['carrier'];
    readonly status: string;
    readonly reason: string | undefined;
    readonly message: RallarMessageSendResult;
}

export interface BlackBoxRallarDeliveryObservation {
    readonly handleId: string;
    readonly state:
        | 'rejected'
        | 'accepted'
        | 'queued'
        | 'transport-accepted'
        | 'acknowledged'
        | 'expired'
        | 'superseded'
        | 'failed'
        | 'cancelled';
    readonly submitted: boolean;
    readonly confirmedPeerIds: readonly string[];
    readonly unconfirmedPeerIds: readonly string[];
    readonly attempts: number;
}

export interface BlackBoxRallarStorageCounters extends IndexedDbOperationCounts {}
```

In F1 the delivery ledger is derived from the admission result: statuses `enqueued`,
`sent-immediate` map to `accepted` with `submitted: true`; `duplicate` and `skipped` map to
`accepted` with `submitted: false`; `superseded` maps to `superseded`; `no-route` and `circuit-open`
map to `failed`. S1 replaces this derivation with the real handle; the operation contract does not
change. `cancelDelivery` marks the ledger entry `cancelled` (no production cancel exists until S1).

- [ ] **Step 1: Write the failing runtime test**

Extend `packages/tests/rallar-black-box/browser-rallar-runtime.test.ts` (it builds the page runtime
with a fake facade; follow its existing `send` test):

```ts
it('sends a typed message over the requested carrier and records a delivery observation', async () => {
    const { runtime, facade } = createRuntimeWithFakeFacade();
    facade.messages.room = () => ({
        send: async () => ({
            transport: 'ws',
            status: 'enqueued',
            message: fakeMessage('msg-1'),
            entries: []
        })
    });
    await runtime.connect(connectionConfig());

    const sent = await runtime.sendMessage({
        connection: 'a',
        carrier: 'ws',
        typeId: 'alm.conformance',
        payload: { n: 1 },
        handleId: 'h-1'
    });
    expect(sent).toMatchObject({
        handleId: 'h-1',
        msgId: 'msg-1',
        carrier: 'ws',
        status: 'enqueued'
    });

    const observed = await runtime.observeDelivery({
        connection: 'a',
        handleId: 'h-1',
        state: ['accepted']
    });
    expect(observed).toMatchObject({
        handleId: 'h-1',
        state: 'accepted',
        submitted: true,
        attempts: 1
    });
});
```

Use the file's existing fixtures for `createRuntimeWithFakeFacade`, `connectionConfig`, and a message
builder; add `fakeMessage(msgId)` beside them if none exists.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/rallar-black-box/browser-rallar-runtime.test.ts`
Expected: FAIL, `sendMessage` is not a function.

- [ ] **Step 3: Add decoders**

In `decode-black-box-rallar-command-input.ts` add `decodeBlackBoxRallarMessageSendInput(value: unknown): BlackBoxRallarMessageSendInput`,
`decodeBlackBoxRallarDeliveryHandleInput(value: unknown): { connection: string; handleId: string; state: readonly string[] }`,
`decodeBlackBoxRallarFaultInput(value: unknown): ScriptedTransportFault`, and
`decodeBlackBoxRallarStorageCountersInput(value: unknown): { reset: boolean }`, using the file's
existing `optionalString`, `requiredString`, `optionalChoice`, and record helpers. Each throws a
`TypeError` naming the missing or malformed field (the file's convention for command input).

- [ ] **Step 4: Implement the typed send and the ledger in the messaging controller**

In `messaging-controller.ts` add a private `#deliveries = new Map<string, BlackBoxRallarDeliveryObservation>()`
and:

```ts
sendMessage = async (
    input: unknown,
    config: BlackBoxRallarConnectionConfig,
    lease: BlackBoxRallarMessagingLease
): Promise<BlackBoxRallarMessageSendDiagnostics> => {
    const send = decodeBlackBoxRallarMessageSendInput(input);
    const channel = this.#options.facade.messages.room<unknown>({
        typeId: send.typeId,
        ...(send.topicId ? { topicId: send.topicId } : {}),
        ...(send.roomRef ? { roomRef: send.roomRef } : {}),
        ...(send.roomRef ? {} : { roomId: config.roomId })
    });
    const options = {
        strategy: toTypedSendStrategy(send.carrier),
        reliability: send.reliability,
        ack: send.ack,
        ttlMs: send.ttlMs,
        orderingKey: send.orderingKey,
        seq: send.seq,
        key: send.key,
        ...(send.toPeerId ? { peerIds: [send.toPeerId] } : {})
    };
    this.#options.emitDiagnostic(config, 'rallar.browser.messages.send_started', {
        handleId: send.handleId,
        carrier: send.carrier
    });
    const message = await channel.send(send.payload, options);
    this.#resources.assertCurrent(lease, 'Rallar send completed after the runtime closed.');
    const observation = toDeliveryObservationFromAdmission(send.handleId, message);
    this.#deliveries.set(send.handleId, observation);
    const diagnostics: BlackBoxRallarMessageSendDiagnostics = {
        handleId: send.handleId,
        msgId: message.message.id.msgId,
        carrier: send.carrier,
        status: message.status,
        reason: message.reason,
        message
    };
    this.#options.emitDiagnostic(config, 'rallar.browser.messages.send_completed', diagnostics);
    return diagnostics;
};

readDelivery = (handleId: string): BlackBoxRallarDeliveryObservation => {
    const observation = this.#deliveries.get(handleId);
    if (observation === undefined) {
        throw new TypeError(`Unknown delivery handle ${handleId}`);
    }
    return observation;
};

cancelDelivery = (handleId: string): BlackBoxRallarDeliveryObservation => {
    const cancelled = { ...this.readDelivery(handleId), state: 'cancelled' as const };
    this.#deliveries.set(handleId, cancelled);
    return cancelled;
};
```

with the pure translations in the same file:

```ts
function toTypedSendStrategy(
    carrier: BlackBoxRallarMessageSendInput['carrier']
): RallarTypedMessageSendStrategy {
    return carrier;
}

function toDeliveryObservationFromAdmission(
    handleId: string,
    result: RallarMessageSendResult
): BlackBoxRallarDeliveryObservation {
    const submitted = result.status === 'enqueued' || result.status === 'sent-immediate';
    const state = result.status === 'superseded'
        ? 'superseded'
        : result.status === 'no-route' || result.status === 'circuit-open'
        ? 'failed'
        : 'accepted';
    return {
        handleId,
        state,
        submitted,
        confirmedPeerIds: [],
        unconfirmedPeerIds: [],
        attempts: 1
    };
}
```

`observeDelivery` in `black-box-rallar-runtime.ts` decodes the input, then polls `readDelivery`
every 25 ms until `state` is in the requested list or the command deadline (from the adapter's
abort signal) is reached; it returns the observation or throws a `TypeError('Delivery handle h-1 did not reach [acknowledged]; last state accepted')`.

- [ ] **Step 5: Wire faults and counters in the composition**

In `browser-rallar-runtime-composition.ts`, in `createBlackBoxBrowserRallarRuntimeDependency()`,
create `const faultPort = createScriptedTransportFaultPort();` and
`const storageObserver = createCountingIndexedDbOperationObserver();`, pass them through
`rallar.setup({ ..., diagnosticsPorts: { transportFaultPort: faultPort, indexedDbOperationObserver: storageObserver } })`
at the existing setup call (find it with `rg -n "setup\(" packages/shared-test/black-box-runner/browser/rallar-browser-runtime/`),
and expose them on the dependency object as `faults: faultPort` and `storage: storageObserver`. The
runtime's `injectFault` calls `faults.inject(decodeBlackBoxRallarFaultInput(input))`; `readStorageCounters`
returns `storage.getCounts()` after `storage.reset()` when `reset` is true.

- [ ] **Step 6: Add the bridge methods**

In `browser-rallar-runtime-bridge.ts` `createSpaBrowserRallarRuntime()` add, beside `send`:

```ts
async sendMessage(input) {
    return await (await resolveBrowserRallarRuntime()).sendMessage(input);
},
async observeDelivery(input) {
    return await (await resolveBrowserRallarRuntime()).observeDelivery(input);
},
async cancelDelivery(input) {
    return await (await resolveBrowserRallarRuntime()).cancelDelivery(input);
},
async readReceipts(input) {
    return await (await resolveBrowserRallarRuntime()).readReceipts(input);
},
async injectFault(input) {
    await (await resolveBrowserRallarRuntime()).injectFault(input);
},
async readStorageCounters(input) {
    return await (await resolveBrowserRallarRuntime()).readStorageCounters(input);
}
```

and add the same six methods to `RallarBlackBoxBrowserRallarRuntime` in `browser-adapter.ts:83-93`.

- [ ] **Step 7: Run the runtime tests and typechecks**

Run: `npx vitest run packages/tests/rallar-black-box/browser-rallar-runtime.test.ts packages/tests/shared-test/rallar-remote-browser-provider.test.ts`
Expected: PASS.

Run: `npx tsc -p packages/shared-test/tsconfig.json --noEmit` (if the package has no tsconfig, run
`npm run typecheck`).
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/shared-test packages/tests
git commit -m "feat(black-box): typed message sends, delivery observation, faults, and storage counters in the page runtime"
```

---

### Task 10: Browser adapter execution of the ALM commands

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/browser-adapter.ts:1074-1180` (dispatch), new private methods beside `sendRtc` (line 2088)
- Modify: `packages/shared-test/rallar-bb-test/black-box-runner-adapter.ts` (in-process adapter returns a typed `failed` result with code `browser-only-command` for the eight kinds)
- Test: extend `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`

**Interfaces:**

- Consumes: Task 9's bridge methods; Task 8's command types.
- Produces: results whose `value` is `RallarBlackBoxTestMessagesSendResultValue`,
  `RallarBlackBoxTestMessagesObserveResultValue`, or `RallarBlackBoxTestStorageCountersResultValue`;
  diagnostics topics `rallar.bb.messages.sent`, `rallar.bb.messages.observed`, `rallar.bb.messages.cancelled`,
  `rallar.bb.messages.receipts`, `rallar.bb.fault.injected`, `rallar.bb.storage.counters`, `rallar.bb.agent.reload_requested`.

- [ ] **Step 1: Write the failing adapter test**

Add to `packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts` a case that builds the
browser adapter with a fake `RallarBlackBoxBrowserRallarRuntime` (follow `rallar-bb-browser-adapter-auth.test.ts`
for the fixture), runs a recipe of `messages.send` then `messages.observe`, and asserts the two
results' `value` fields match the shapes above and that the diagnostics topics were recorded.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-alm-commands.test.ts`
Expected: FAIL, the adapter reports an unknown command kind.

- [ ] **Step 3: Add dispatch cases and handlers**

In the `execute` switch add:

```ts
case 'messages.send':
    return await this.sendMessage(command, context);
case 'messages.observe':
    return await this.observeDelivery(command, context);
case 'messages.cancel':
    return await this.cancelDelivery(command, context);
case 'messages.received':
    return await this.waitForReceivedMessages(command, context);
case 'messages.receipts':
    return await this.readReceipts(command, context);
case 'fault.inject':
    return await this.injectFault(command, context);
case 'storage.counters':
    return await this.readStorageCounters(command, context);
case 'agent.reload':
    return await this.requestAgentReload(command, context);
```

Each handler follows the `sendRtc` shape: resolve placeholders with `replaceCommandPlaceholders`,
build the abort scope with `this.commandAbortSignal(command, context)`, call the bridge method under
`this.withAbort(...)`, record one diagnostic with `context.recordEvent`, and return
`{ status: 'ok', value }`. `waitForReceivedMessages` reuses the runtime's existing received-message
buffer (the `rallar.browser.*.message` events the adapter already stores) and applies the count and
absence window on the runtime clock the same way the `wait` command does (read `runtime.ts:491`
`case 'wait'` and reuse its window evaluation function rather than reimplementing it).
`requestAgentReload` only records `rallar.bb.agent.reload_requested` and returns `ok`; the control
agent performs the reload (Task 11).

- [ ] **Step 4: Reject the eight kinds in the in-process adapter**

In `black-box-runner-adapter.ts`, where `'rtc.send'` is mapped (line 230), add a branch that returns
`{ status: 'failed', error: { code: 'browser-only-command', message:`${command.kind} requires a browser agent`} }`
for the eight ALM kinds.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run packages/tests/shared-test packages/tests/rallar-black-box/browser-rallar-runtime.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-test packages/tests
git commit -m "feat(rallar-bb-test): execute the ALM messaging, fault, storage, and reload commands"
```

---

### Task 11: Agent reload

**Files:**

- Modify: `packages/shared-test/rallar-bb-test/browser-control-agent.ts` (command dispatch and bootstrap)
- Modify: `packages/shared-test/rallar-bb-test/control-client.ts` (register with resumed command ids)
- Test: `packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts`

**Interfaces:**

- Produces: on `agent.reload` the agent sends its `result` envelope first, persists
  `{ runId, agentId, completedCommandIds }` under `sessionStorage['rallar-bb-agent-resume']`, then calls
  `location.reload()`. On bootstrap, a matching resume record is read once, deleted, and its
  `completedCommandIds` are sent in `register.resume.completedCommandIds` so the control server does not
  redeliver completed commands.

- [ ] **Step 1: Discover how the agent bootstraps and registers**

Run: `rg -n "readBrowserControlAgentBootstrap|completedCommandIds|location\.|sessionStorage" packages/shared-test/rallar-bb-test/browser-control-agent.ts packages/shared-test/rallar-bb-test/browser-control-agent-config.ts packages/shared-test/rallar-bb-test/control-client.ts`
Expected: the bootstrap reader (URL-driven), the register envelope construction in `control-client.ts`
where `resume.completedCommandIds` is filled, and no existing `sessionStorage` use.

- [ ] **Step 2: Write the failing test**

Create `packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts` using the fake control server
in `packages/tests/shared-test/fake-remote-browser-control-server.ts`: start an agent with a stubbed
`location.reload` (`vi.fn()`) and a stubbed `sessionStorage`, deliver an `agent.reload` command,
assert the `result` envelope arrived before `reload` was called and that `sessionStorage` holds the
resume record with the command id; then create a second agent with the same bootstrap and assert its
`register` envelope carries `resume.completedCommandIds` including that id and that the record was
removed.

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts`
Expected: FAIL, `agent.reload` is executed like an unknown command.

- [ ] **Step 4: Implement the reload**

In `browser-control-agent.ts`, before delegating a command to the runtime, intercept:

```ts
if (envelope.command.kind === 'agent.reload') {
    await sendResult({ ok: true, result: { status: 'ok', value: { reloading: true } } });
    writeAgentResumeRecord({
        runId: envelope.runId,
        agentId: bootstrap.agentId,
        completedCommandIds: [...completedCommandIds, envelope.commandId]
    });
    window.location.reload();
    return;
}
```

with the record owner in a new small module `packages/shared-test/rallar-bb-test/browser-control-agent-resume.ts`:

```ts
const RESUME_KEY = 'rallar-bb-agent-resume';

export interface AgentResumeRecord {
    readonly runId: string;
    readonly agentId: string;
    readonly completedCommandIds: readonly string[];
}

export function writeAgentResumeRecord(record: AgentResumeRecord): void {
    sessionStorage.setItem(RESUME_KEY, JSON.stringify(record));
}

export function takeAgentResumeRecord(
    runId: string,
    agentId: string
): AgentResumeRecord | undefined {
    const raw = sessionStorage.getItem(RESUME_KEY);
    if (raw === null) {
        return undefined;
    }
    sessionStorage.removeItem(RESUME_KEY);
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    if (
        record.runId !== runId || record.agentId !== agentId ||
        !Array.isArray(record.completedCommandIds)
    ) {
        return undefined;
    }
    return {
        runId,
        agentId,
        completedCommandIds: record.completedCommandIds.filter((id) => typeof id === 'string')
    };
}
```

At bootstrap, call `takeAgentResumeRecord(runId, agentId)` and pass its `completedCommandIds` into
`controlClient.connect({ ..., completedCommandIds })`; extend `connect`'s options and the register
envelope construction in `control-client.ts` to include them.

- [ ] **Step 5: Run the test and the control tests**

Run: `npx vitest run packages/tests/shared-test/rallar-bb-test-agent-reload.test.ts packages/tests/shared-test/rallar-bb-test-browser-control-agent-config.test.ts packages/tests/rallar-black-box/control-client.test.ts packages/tests/rallar-black-box/control-protocol-boundary.test.ts`
Expected: PASS.

Run: `cd apps/rallar-black-box-control-server && deno task check && deno task test`
Expected: exit 0 (the server already accepts `resume.completedCommandIds`).

- [ ] **Step 6: Commit**

```bash
git add packages/shared-test packages/tests
git commit -m "feat(rallar-bb-test): agent.reload preserves IndexedDB and resumes completed commands"
```

---

### Task 12: The baseline `alm-conformance` recipe family

**Files:**

- Create: `packages/shared-test/rallar-bb-test/conformance/alm/alm-conformance-carriers.ts`
- Create: `packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts`
- Test: `packages/tests/shared-test/alm-conformance-recipes.test.ts`

**Interfaces:**

- Produces:

```ts
export const ALM_CONFORMANCE_CARRIERS = ['ws', 'rtc', 'rtc-with-ws-fallback'] as const;
export type AlmConformanceCarrier = typeof ALM_CONFORMANCE_CARRIERS[number];

export interface CreateAlmConformanceRecipesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly carrier: AlmConformanceCarrier;
    readonly typeId: string;
    readonly senderConnection: string;
    readonly receiverConnection: string;
    readonly deadlineMs: number;
}

export interface AlmConformanceScenario {
    readonly scenarioId:
        | 'bounded-rejection'
        | 'deadline-expiry'
        | 'duplicate-no-op'
        | 'ordering-resync';
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
    readonly tags: readonly ('smoke' | 'full')[];
}

export function createAlmConformanceRecipes(
    input: CreateAlmConformanceRecipesInput
): readonly AlmConformanceScenario[];
```

Each scenario is a sender recipe and a receiver recipe that share `{runId}`-scoped identities and
distinct `commandId`s per scenario and carrier (the control server replays a reissued id as success).
The four baseline scenarios:

- `bounded-rejection`: a `messages.send` with a 70 000-byte payload expects result status `failed`
  with reason containing `oversized`; the receiver's `messages.received` with `absent: true` over a
  2 s window passes.
- `deadline-expiry`: `fault.inject` drops the data frame once on the sender's carrier, the send uses
  `ttlMs: 1_000`; `messages.observe` for `['expired', 'failed']` succeeds within 3 s; the receiver sees
  nothing.
- `duplicate-no-op`: the sender sends the same `key` twice with `reliability: 'at-least-once'`; the
  receiver's `messages.received` expects `count: 1` over a 2 s window.
- `ordering-resync`: the sender sends `seq: 1` then `seq: 300` on one `orderingKey`; the receiver's
  `messages.received` for `seq 300` is `absent` over 2 s and the receiver's diagnostics contain
  `resync-required` (asserted with the existing `assert` command over the event buffer, operator
  `contains`).

- [ ] **Step 1: Write the failing test**

Create `packages/tests/shared-test/alm-conformance-recipes.test.ts`:

```ts
import {
    ALM_CONFORMANCE_CARRIERS,
    createAlmConformanceRecipes
} from '@shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import { validateRallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/schema.ts';
import { describe, expect, it } from 'vitest';

const group = { applicationId: 'app', workspaceId: 'ws', groupId: 'room-alm' };

describe('alm-conformance recipe family', () => {
    it('produces four valid scenarios per carrier with distinct command ids', () => {
        for (const carrier of ALM_CONFORMANCE_CARRIERS) {
            const scenarios = createAlmConformanceRecipes({
                group,
                carrier,
                typeId: 'alm.conformance',
                senderConnection: 'sender',
                receiverConnection: 'receiver',
                deadlineMs: 5_000
            });
            expect(scenarios.map((scenario) => scenario.scenarioId)).toEqual([
                'bounded-rejection',
                'deadline-expiry',
                'duplicate-no-op',
                'ordering-resync'
            ]);
            const commandIds = scenarios.flatMap((scenario) =>
                [...scenario.sender.commands, ...scenario.receiver.commands].map((command) =>
                    command.commandId
                )
            );
            expect(new Set(commandIds).size).toBe(commandIds.length);
            for (const scenario of scenarios) {
                expect(validateRallarBlackBoxTestRecipe(scenario.sender).left).toBeUndefined();
                expect(validateRallarBlackBoxTestRecipe(scenario.receiver).left).toBeUndefined();
            }
        }
    });

    it('tags bounded-rejection and duplicate-no-op as smoke', () => {
        const scenarios = createAlmConformanceRecipes({
            group,
            carrier: 'ws',
            typeId: 'alm.conformance',
            senderConnection: 'sender',
            receiverConnection: 'receiver',
            deadlineMs: 5_000
        });
        expect(
            scenarios.filter((scenario) => scenario.tags.includes('smoke')).map((scenario) =>
                scenario.scenarioId
            )
        )
            .toEqual(['bounded-rejection', 'duplicate-no-op']);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run packages/tests/shared-test/alm-conformance-recipes.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Write the family**

Create `alm-conformance-carriers.ts` with the constant and type above. Create
`create-alm-conformance-recipes.ts` following the shape of
`apps/rallar-black-box/src/hetzner/create-hetzner-rtc-absence-wait-recipe.ts`: the same
`http.request` ensure-group and ensure-member commands (with new UUID request ids suffixed
`-{runtimeIdentity}`), an `rtc.connect` (for `rtc` and `rtc-with-ws-fallback`) or `ws.open`-free
connect (the facade's WS is already open after `connect`), then the scenario commands. Command ids are
`alm-${carrier}-${scenarioId}-${step}`. Each recipe's `metadata` carries
`{ profile: 'alm-conformance', carrier, scenarioId, group: roomRef }`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run packages/tests/shared-test/alm-conformance-recipes.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-test/rallar-bb-test/conformance/alm packages/tests/shared-test/alm-conformance-recipes.test.ts
git commit -m "feat(rallar-bb-test): baseline alm-conformance recipe family over three carriers"
```

---

### Task 13: Playwright full-stack lane for the family

**Files:**

- Create: `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`
- Modify: `package.json` (add `test:rallar:full-stack:memory:alm` and `test:rallar:full-stack:postgres:alm` scripts beside their `:director` siblings; add the memory script to `test:full-stack:memory`'s chain if that script enumerates specs, otherwise the `full-stack-*.spec.ts` glob already includes it)

**Interfaces:**

- Consumes: Task 12's family; the two-agent fixtures in `browser-rallar-two-agent-smoke.spec.ts`
  (agent auth, control client, snapshot polling).

- [ ] **Step 1: Read the two-agent smoke spec fully and reuse its helpers**

Run: `sed -n '90,260p' tests/playwright/rallar-black-box/browser-rallar-two-agent-smoke.spec.ts`
Expected: helper functions for creating two agents, sending control commands, and polling the control
run snapshot. Copy the ones you need into `full-stack-helpers.ts` if they are not exported there yet
(export them from `full-stack-helpers.ts`; do not duplicate them in the new spec).

- [ ] **Step 2: Write the spec**

Create `tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
    ALM_CONFORMANCE_CARRIERS,
    createAlmConformanceRecipes
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/create-alm-conformance-recipes.ts';
import {
    createTwoAgentRun,
    readFullStackConfig,
    runRecipeOnAgent,
    uniqueSuffix
} from './full-stack-helpers.ts';

const config = readFullStackConfig();
const scope = process.env.RALLAR_BLACK_BOX_ALM_SCOPE === 'full' ? 'full' : 'smoke';

test.describe('ALM conformance lane', () => {
    test.skip(!config.enabled, 'RALLAR_BLACK_BOX_FULL_STACK is not set');

    for (const carrier of ALM_CONFORMANCE_CARRIERS) {
        test(
            `baseline family over ${carrier} (${scope})`,
            async ({ browser, request }, testInfo) => {
                const run = await createTwoAgentRun({
                    browser,
                    request,
                    testInfo,
                    runId: `alm-${carrier}-${uniqueSuffix()}`
                });
                const scenarios = createAlmConformanceRecipes({
                    group: run.group,
                    carrier,
                    typeId: 'alm.conformance',
                    senderConnection: run.sender.connection,
                    receiverConnection: run.receiver.connection,
                    deadlineMs: 5_000
                }).filter((scenario) => scope === 'full' || scenario.tags.includes('smoke'));

                for (const scenario of scenarios) {
                    const [senderResult, receiverResult] = await Promise.all([
                        runRecipeOnAgent(run, run.sender, scenario.sender),
                        runRecipeOnAgent(run, run.receiver, scenario.receiver)
                    ]);
                    expect(senderResult.ok, `${scenario.scenarioId} sender`).toBe(true);
                    expect(receiverResult.ok, `${scenario.scenarioId} receiver`).toBe(true);
                }
                await testInfo.attach(`alm-${carrier}-${scope}.json`, {
                    body: JSON.stringify(await run.readSnapshot(), null, 2),
                    contentType: 'application/json'
                });
                await run.close();
            }
        );
    }
});
```

`createTwoAgentRun`, `runRecipeOnAgent`, and the run handle's `readSnapshot`/`close` are the helpers
extracted in Step 1 (name them exactly so). The memory lane runs `scope = 'smoke'` by default; the
Release Gate's Postgres lane sets `RALLAR_BLACK_BOX_ALM_SCOPE=full`.

- [ ] **Step 3: Add the scripts**

In `package.json` beside `test:rallar:full-stack:memory:director` add:

```json
"test:rallar:full-stack:memory:alm": "RALLAR_BLACK_BOX_FULL_STACK=1 RALLAR_BLACK_BOX_API_MODE=memory VITE_RALLAR_API_BASE_URL=${VITE_RALLAR_API_BASE_URL:-http://localhost:18080} playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts",
"test:rallar:full-stack:postgres:alm": "RALLAR_BLACK_BOX_FULL_STACK=1 RALLAR_BLACK_BOX_ALM_SCOPE=full VITE_RALLAR_API_BASE_URL=http://localhost:8080 playwright test --config apps/rallar-black-box/playwright.full-stack.config.ts tests/playwright/rallar-black-box/full-stack-alm-conformance.spec.ts",
```

Copy the remaining environment variables from the `:director` sibling verbatim (room id, application
id, agent credentials) so the lane authenticates the same way. Add
`npm run test:rallar:full-stack:postgres:alm` to the Release Gate step "Run Postgres full-stack smoke
tests" in `.github/workflows/release-gate.yml:179-183`.

- [ ] **Step 4: Run the memory lane locally**

Run: `npm run test:rallar:full-stack:memory:alm`
Expected: three tests pass (one per carrier), under three minutes. If a port is held by another
session, pin `--port` per the repo's port notes and retry; do not widen timeouts.

- [ ] **Step 5: Commit**

```bash
git add tests/playwright/rallar-black-box package.json .github/workflows/release-gate.yml
git commit -m "test(black-box): ALM conformance Playwright lane for memory and Postgres"
```

---

### Task 14: Hetzner manifests for the family

**Files:**

- Modify: `apps/rallar-black-box/src/hetzner-distributed-manifests.ts` (catalog entries)
- Regenerate: `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json`, `19-alm-conformance-15-agent-30s.json`, `20-alm-conformance-30-agent-30s.json`, `21-alm-conformance-50-agent-30s.json`
- Modify: `.github/workflows/hetzner-supported-distributed-manifests.yml:139-143, 179-187` (add `18-alm-conformance-2-agent.json` to the supported set)
- Test: `packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts` (extend the expected order arrays)

**Interfaces:**

- Consumes: `buildManifestEntry`, `HETZNER_DISTRIBUTED_MANIFEST_GROUP`, `controllerAgentIds`,
  `multicastManifestMetadata` from the catalog; Task 12's family.

- [ ] **Step 1: Find the generator**

Run: `rg -n "hetzner-distributed-manifests|manifests/hetzner" package.json apps/rallar-black-box/package.json scripts --glob '*.{json,mjs,ts}'`
Expected: one script that writes the JSON catalog. If none exists and the test compares against
`JSON.stringify(entry.manifest, null, 2)`, write the files with a one-off
`node --import tsx -e` invocation that imports the catalog and writes each `entry.manifest`; do not
add a new dependency (tsx is present only if already in `package.json`; otherwise use the existing
Vitest test to print the expected JSON).

- [ ] **Step 2: Add the catalog entries**

Add four `buildManifestEntry({...})` calls: a 2-agent entry in the green order (after `17-…`) with
`recipes` from `createAlmConformanceRecipes` for all three carriers and `profiles: ['alm', 'conformance', '2-agent', 'github-free-smoke']`,
and 15-, 30-, and 50-agent entries in the extended order whose recipes reuse the existing
`createRallarBlackBoxRtcMessagesPrincipalMulticastRecipes` for the fan-out plus one
`storage.counters` command per agent, `profiles: ['alm', 'messages.rtc', 'multicast', 'tree', '<n>-agent', 'extended']`,
`rolePattern: 'one-sender-many-receivers'`, and `metadata` extended with
`{ almMetrics: ['receiptLatencyMs', 'alOwnedIndexedDbOperations', 'retainedRows', 'retries', 'repairs', 'terminalCounts'] }`.

- [ ] **Step 3: Extend the manifest test and regenerate**

Add the four paths to `HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER` / `…_EXTENDED_ORDER` expectations in
the test, regenerate the JSON, and run:
`npx vitest run packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the 2-agent manifest to the supported set**

Append `apps/rallar-black-box/manifests/hetzner/18-alm-conformance-2-agent.json` to the two lists in
the workflow (the rejection guard at lines 139-143 and the matrix at 179-187). Leave the 15-, 30-,
and 50-agent manifests on manual dispatch through `github-free-distributed-recipe.yml`, which already
accepts any `manifest_path`.

- [ ] **Step 5: Commit**

```bash
git add apps/rallar-black-box .github/workflows/hetzner-supported-distributed-manifests.yml packages/tests/rallar-black-box
git commit -m "feat(black-box): ALM conformance Hetzner manifests at 2, 15, 30, and 50 agents"
```

---

### Task 15: Whole-branch validation and the PR

- [ ] **Step 1: Run the full local gates**

```bash
npm run test:unit
cd apps/api-v1 && deno task check && cd ../..
cd apps/rallar-black-box-control-server && deno task check && cd ../..
cd apps/relic-hunter-server-v1 && deno task check && cd ../..
npx dprint check
npm run check:repo-style:changed -- origin/main HEAD
npm --workspace @ar-eye-hunter/shared-web run check:browser-bundles
npm run test:repo-governance
npm run test:rallar:full-stack:memory:alm
```

Expected: every command exits 0. Record each result in the PR body's Validation section with the commit
it was measured on.

- [ ] **Step 2: Open the PR**

Body sections: Goal (the F1 outcome from the spec), Changes (the fifteen tasks in one paragraph each),
Acceptance (the spec's F1 acceptance list, each item with the test or lane that proves it),
Validation (Step 1's commands, the measured bundle figures, and the skipped Postgres lanes if Docker was
unavailable), Risk and rollback (the two new required ports change constructor signatures in `shared`
and `shared-web`; rollback is the revert), Follow-up (F2). Run `npm run pr:delivery -- status` and act
on its verdict; do not run `ready`.

---

## Self-review

- Spec coverage: F1 items 1 (operations: Tasks 8-10), 2 (faults: Tasks 4, 5, 9), 3 (reload: Task 11),
  4 (counters: Tasks 2, 3, 6, 9), 5 (family: Task 12), 6 (lanes: Tasks 13, 14), 7 (entry point: Task 7),
  8 (migration: Task 1). Acceptance bullets: baseline passes in memory and Postgres lanes (Task 13);
  a broken assertion fails the lane (covered by the family's `absent` scenarios failing when
  delivery happens; add a negative Playwright case only if the maintainer asks); reload preserves
  IndexedDB (Task 11 test); counter zero for `realtime.room` and positive for a typed send (add this
  as the first `full` scenario's `storage.counters` assertion in Task 12's family when S3 lands; in F1
  the family records counters as evidence without asserting zero, because every typed send still
  persists); bundle entry (Task 7); migration (Task 1); governance test (Task 15).
- Placeholder scan: every code step shows code; discovery steps name the exact command and the
  expected output.
- Type consistency: `TransportFaultPort.decideSend` (Tasks 4, 5, 9); `IndexedDbOperationObserver.observe`
  and `createPassThroughIndexedDbOperationObserver` (Tasks 2, 3, 6, 9); `RallarDiagnosticsPorts`
  (Tasks 6, 9); `BlackBoxRallarMessageSendInput`, `BlackBoxRallarDeliveryObservation` (Tasks 9, 10);
  `createAlmConformanceRecipes` and `ALM_CONFORMANCE_CARRIERS` (Tasks 12, 13, 14).
