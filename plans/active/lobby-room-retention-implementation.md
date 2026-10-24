# Temporary room archival implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Let creators opt into temporary rooms that disappear from discovery while empty and archive after reconnect grace.

**Architecture:** Keep normalized retention state in one reserved group metadata entry and reuse `Group.emptySinceEpochMs` for its clock. A separately registered internal `GroupRetentionService` reads full presence authority and computes conditional archival; AppInbox owns its transaction and fresh retries. Reuse the existing group commit writer for guarded persistence, events, receipts and final outbox inserts.

**Tech Stack:** TypeScript, AppInbox/QueueBox, runtime-state conditional writes, PostgreSQL/PGlite, Vitest, shared-web rooms.

**Spec:** `plans/active/lobby-room-retention-design.md`

## Global constraints

- One feature PR from `eceabcc7da2ff8dc095fc661952c106a4d6e808b`; wait for maintainer merge before permanent cleanup.
- No legacy path, migration code, duplicated implementation, domain locks, or new group-row writes on normal presence activity.
- Every changed human-authored file is reviewed and remediated in full; changed support files enter closure recursively; independent untouched code remains outside it.
- Sparse creation intent defaults to persistent. Temporary grace defaults to 600,000 ms and accepts only safe integers from 1,000 through 86,400,000.
- Temporary rooms reject absolute expiry/purge fields on creation and update, and reject externally supplied idle anchors.
- Full scoped identity, immutable ingress facts, pure compute/validate, persistence-ready candidates, one attempt per delivery, and final outbox intents committed with state and receipt.
- The maintainer selected temporary defaults in both games with 600,000 ms grace and seven days of archived retention before deletion. This PR adopts those creation defaults and archives rooms; the next increment implements deletion with an explicit retained-data contract.

## Review focus

- A reconnect and disconnect between maintenance scans must reset grace even when no session remains and its ingress time predates the earlier observation.
- A first connect with no existing admission row and a heartbeat reviving an expired lease must each fence against archival in either commit order.
- A generic metadata replacement must neither erase retention nor inject it into persistent rooms; corrupt stored retention must fail closed.
- Delayed or duplicated maintenance delivery must use fresh authority and must not shorten a later idle period or duplicate its event/outbox effects.
- Shutdown, restart, and a multi-page scan must retain bounded work without overlapping scans or permanently skipping a canonical room key.

### Task 1: Creation opt-in and discovery behavior

**Files:**

- Create `packages/shared/api/group-retention.ts` for sparse public intent and the canonical stored metadata interpretation.
- Modify `packages/shared/api/state-types.ts`, `packages/shared-server/rallar-system/group-state/group-mutation-command.ts`, and mutation command/request validators for creation input.
- Modify `mutation/aggregate/create-initial-group-mutation.ts`, `mutation/aggregate/compute-group-aggregate-mutation.ts`, and `persistence/validate-persisted-group.ts` beneath the group-state owner for metadata ownership and invariants.
- Modify `packages/shared-server/rallar-system/group-state/directory/compute-group-directory-page.ts` so directory and Quick Join share empty-room hiding.
- Modify existing room creation contracts/translation in `packages/shared-web/browser/rooms/`, REST OpenAPI, and shared-test creation recipes where the public input is described or exercised.
- Create `packages/tests/shared-server/rallar-system/group-state/inbox/group-retention-policy.test.ts`; extend the existing room creation tests for SDK forwarding.

**Interfaces:**

- Produces `GroupRetentionIntent`: persistent, or temporary with optional `reconnectGraceMs` at creation.
- Produces `GroupRetentionState`: mandatory `mode: 'temporary'`, `reconnectGraceMs`, and `emptyPresenceFingerprint: string | null`.
- Produces `GROUP_RETENTION_METADATA_KEY = 'rallarRetention'` and `readGroupRetentionState(metadata: ApiJsonObject): GroupRetentionState | null`; absence means persistent, malformed presence throws.
- Produces `toInitialGroupRetentionState(intent: GroupRetentionIntent | undefined): GroupRetentionState | null` with the documented default and bounds.
- Task 2 consumes the stored state and the existing `Group.emptySinceEpochMs`; it introduces no second policy or idle-clock owner.

- [x] Write AppInbox behavior tests for default persistent creation, default/custom temporary grace, invalid input, reserved metadata injection, metadata preservation, forbidden deadlines/idle-anchor updates, and malformed durable state. Assert the stored normalized entry equals `{ mode: 'temporary', reconnectGraceMs: 600000, emptyPresenceFingerprint: null }` and the initial idle anchor is null.
- [x] Run `npx vitest run packages/tests/shared-server/rallar-system/group-state/inbox/group-retention-policy.test.ts`. Expected: RED on unsupported retention input or absent behavior, without unrelated harness failure.
- [x] Implement the creation and update boundaries above. Keep queued commands canonical by normalizing intent into metadata at ingress; do not add a new optional persisted command field.
- [x] Add directory/Quick Join and scoped-link tests: no live temporary session stays hidden with `includeEmpty: true`; persistent empty rooms retain current behavior; an admitted live temporary session is discoverable; a direct reference still uses normal admission before archival.
- [x] Run the policy and existing listing/Quick Join suites, then package typechecks. Expected: all affected behavior passes, no new type errors.
- [x] Add SDK forwarding and REST contract/recipe coverage with RED then GREEN. Publish the first coherent commit as a draft PR and attach it to the task. Expected: remote draft reflects opt-in delivery and remaining archival work.

### Task 2: Guarded archival maintenance

**Files:**

- Create `packages/shared-server/rallar-system/group-state/retention/group-retention-service.ts` as the owned read/compute/validate/write capability, and `compute-group-retention.ts` for decisions and prepared persistence.
- Add `group-retention-inbox.ts` and `reconcile-group-retention.ts` under the same owner for AppInbox registration and bounded lifecycle scanning.
- Modify `group-state-service.ts`, `group-state-service-contracts.ts`, `inbox/group-state-inbox-service.ts`, and the existing API runtime lifecycle composition to construct, register, start and stop the capability explicitly.
- Reuse the exact presence-summary authority read and canonical paginated group repository access. Narrow `mutation/write/write-group-mutation.ts` to the actual prepared commit fields it consumes; keep its transaction grammar intact.
- Create `packages/tests/shared-server/rallar-system/group-state/retention/group-retention.test.ts` and `group-retention-concurrency.test.ts`; extend the PostgreSQL integration configuration and shared-test recipes only as needed to exercise those behaviors.
- Update `docs/product.md`, `docs/architecture.md`, and the ongoing lobby roadmap with delivered behavior. Set temporary defaults in AR Eye and Relic creation paths.

**Interfaces:**

- Consumes Task 1's `readGroupRetentionState` and `GroupRetentionState`.
- `GroupRetentionService` owns canonical `Command`, immutable ingress facts, complete authoritative `Read`, and persistence-ready `Computed` types in its same-name type-only namespace.
- Public methods: `read(command)`, pure `compute(command, read, facts)`, pure `validate(command, read, facts, computed)`, and `write(transaction, computed)`; no preparation or domain reads inside write.
- Maintenance registration is internal-only and captures canonical command identity including full group scope and scan observation identity; no new authenticated endpoint.

- [x] Write decision tests for live recovery, initial empty anchor, unchanged-before-deadline no-op, exact deadline archival, changed fingerprint reset, inactive/absent no-op, corrupt scope, and stale/replayed maintenance. Assert reconnect-plus-disconnect between scans yields a later idle anchor even with an older ingress timestamp.
- [x] Run `npx vitest run packages/tests/shared-server/rallar-system/group-state/retention/group-retention.test.ts`. Expected: RED on missing retention capability; after implementation, GREEN for all decisions.
- [x] Implement full authority reads using current members/admissions/presence. Fingerprint their canonical identities and storage revisions. Compute anchor changes with the attempt clock; compute archive only for an unchanged empty observation at or beyond grace.
- [x] Write and run both-order PGlite races for archive versus first connect, reconnect, heartbeat, membership/metadata update, and another archiver. Include outbox-collision rollback, exact replay, mismatched identity, fresh retry and exhaustion. Expected: RED for an unfenced stale commit, then GREEN with group-first CAS, per-principal admission CAS/conditional insert and exact-revision presence deletes.
- [x] Wire AppInbox and bounded paginated maintenance with the existing repeating-work lifecycle. Add scan/shutdown/restart tests before implementation. Expected: no overlapping scan, bounded page, all canonical candidates eventually visited, no work after stop.
- [ ] Run affected package tests, relevant public API and bundle checks, PostgreSQL races and medium-scale gate, plus a fresh candidate of the already captured state-write performance workload. Expected: correctness passes and the unmodified performance comparator passes; #701's exception is not reused.
- [ ] Set `{ mode: 'temporary', reconnectGraceMs: 600_000 }` in both games' room creation paths, with tests/builds and visible-control browser evidence. Complete construction/runtime timelines and a manual 5/5 navigation probe for the mutation family.
- [ ] Run `npm run pr:delivery -- status` before broad final checks, obtain the required fresh whole-branch review, address material findings, and run `npm run pr:delivery -- ready` once. Expected: PR ready for maintainer review; wait for merge. Remove completed temporary design/implementation documents before final publication, leaving the ongoing roadmap accurate.
