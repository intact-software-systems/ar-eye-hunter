# CRDT Improvement Plan

Date: 2026-06-04

Status: Planning document for hardening and correcting the shared CRDT
implementation in `packages/shared/crdt`.

Related plans:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `plans/rallar-crdt-production-hardening-companion-plan.md`

## Purpose

This plan captures findings from the review of `packages/shared/crdt` and turns
them into concrete implementation work. The goal is to keep the current small,
deterministic CRDT core while fixing correctness gaps that matter for long-lived
collaborative documents.

The current implementation is a Rallar-owned JSON operation engine. It supports
LWW registers, multi-value registers, observed-remove sets, observed-delete
maps, dependency blocking, canonical JSON validation, optional envelope hashes,
snapshots, and durable-log contracts.

## Current Code Reviewed

Primary files:

- `packages/shared/crdt/crdt-types.ts`
- `packages/shared/crdt/crdt-clock.ts`
- `packages/shared/crdt/crdt-codec.ts`
- `packages/shared/crdt/crdt-document-key.ts`
- `packages/shared/crdt/crdt-durable-log.ts`
- `packages/shared/crdt/crdt-hash.ts`
- `packages/shared/crdt/crdt-operations.ts`
- `packages/shared/crdt/mod.ts`

Nearby validation and usage references:

- `packages/tests/shared/crdt-contracts.test.ts`
- `packages/tests/shared-web/rallar-crdt.test.ts`
- `packages/tests/shared-server/rallar-crdt-server-topic.test.ts`
- `packages/tests/shared-server/rallar-crdt-log-repository.test.ts`
- `packages/tests/shared-graph/graph-crdt.test.ts`

Review verification performed:

- `npx vitest run packages/tests/shared/crdt-contracts.test.ts`
- Result: 1 test file passed, 11 tests passed.

## Current Strengths

- The operation model is explicit and easy to reason about.
- Updates are versioned envelopes with document identity, replica identity,
  Lamport time, parent dependencies, schema version, operation version, payload,
  and optional canonical hash.
- Incoming updates are validated before application.
- Duplicate updates are idempotent through `updateId` tracking.
- Out-of-order delivery is tolerated through dependency blocking.
- OR-set removes and map deletes require observed update IDs, preserving
  concurrent adds and sets.
- Multi-value registers surface conflicts instead of silently discarding
  concurrent writes.
- Canonical JSON and stable document keys make hashing, validation, and storage
  keys deterministic.
- Snapshot import marks included updates as seen, so later causal descendants can
  apply without requiring the full old log.
- Durable-log contracts already define append, list, snapshot, lifecycle,
  retention, quota, and projection surfaces.

## Key Findings

### Snapshot Import Loses Collection CRDT State

The largest correctness gap is snapshot compaction for maps and sets.

Snapshots currently store only materialized JSON plus included update IDs. After
importing a snapshot, the engine keeps snapshot state in `baseValue` and only
replays post-snapshot updates. For scalar register paths this can work, but for
collection CRDT paths it loses the per-entry metadata needed for later merges.

Observed behavior:

- Snapshot contains `meta: { a: 1 }`.
- After import, a later `map.set` at path `["meta"]` with key `b` materializes
  `meta: { b: 2 }`, dropping `a`.
- Snapshot contains `items: ["one"]`.
- After import, a later OR-set add at path `["items"]` materializes
  `items: ["two"]`, dropping `one`.

This means snapshots are not safe compaction boundaries for maps or OR-sets
unless no later operations touch the same collection path.

### Overlapping Path Semantics Are Not Defined

Materialization currently applies maps first, then sets, then registers. This
creates a fixed type precedence that can override causality across different
operation kinds.

Example:

- A root `map.set` can write key `x`.
- A `register.set` can also write path `["x"]`.
- The register wins because registers are materialized after maps, regardless of
  which operation happened later.

This may be acceptable if document schemas guarantee one CRDT type per path, but
the shared package does not currently enforce or document that invariant.

### Parent Lists Grow Without Bound

`applyLocal(...)` records all currently seen update IDs as `parents`. This is
simple and strong, but it makes every future local update larger as the document
ages.

Risks:

- update envelopes become large
- dependency checks become slower
- sync messages become expensive
- local storage and durable log growth accelerates

Long-lived documents should use a causal frontier or vector-clock-like summary
rather than the complete seen set.

### Hashing Is Deterministic But Not Strong Integrity

The hash is `crdt-fnv1a32`, optional, and suitable for accidental mismatch
detection only. It should not be treated as a security boundary, collision-safe
content address, or tamper-proof signature.

If updates cross trust boundaries, the server should either require a stronger
hash or use authenticated server-side append metadata as the authority.

### Clock Summary Is Not A Full Replica Clock

The Lamport clock exposes `replicaClocks`, but `observe(lamport)` only updates
the local maximum and does not remember the remote replica ID. As a result, the
summary is not currently a complete vector-clock-style sync summary.

This is fine if `maxLamport` is the only intended guarantee, but misleading if
`updateClock` is meant to drive efficient sync or missing-update discovery.

### Caller Ergonomics Are Thin

Deletes and removes require callers to know observed add/update IDs. That is
correct for observed-remove semantics, but the package does not expose helpers
for common operations such as:

- remove OR-set element currently visible at a path
- delete current map key at a path
- write LWW register
- resolve multi-value register conflict

Without helpers, application code can accidentally create invalid or incomplete
operations.

### Guardrails Are Incomplete

Validation exists, but production limits are still thin at the shared-core
level.

Missing or unclear bounds:

- maximum operation count per batch
- maximum parent count
- maximum path depth
- maximum path segment length
- maximum key and element ID length
- maximum blocked update queue size
- tombstone compaction policy
- allowed CRDT kind per path or document schema

## Improvement Goals

- Make snapshots safe as compaction boundaries for all supported CRDT kinds.
- Define and enforce path ownership so different CRDT kinds do not fight over
  the same materialized JSON location.
- Reduce update growth by replacing full parent sets with compact causal
  frontier metadata.
- Clarify integrity guarantees and strengthen hashing where needed.
- Improve operation ergonomics with safe helper APIs.
- Expand tests from contract examples to convergence and compaction properties.
- Preserve the current deterministic, dependency-blocked, JSON-only design.

## Phase 1: Pin Current Gaps With Tests

Add failing tests before changing behavior.

Tasks:

- Add a snapshot test where a post-snapshot `map.set` preserves existing
  snapshot map entries.
- Add a snapshot test where a post-snapshot OR-set add preserves existing
  snapshot set entries.
- Add a snapshot test where a post-snapshot OR-set remove can remove a
  snapshot-era element without replaying the full old log.
- Add overlapping-path tests for map/register, map/set, and set/register
  combinations.
- Add tests documenting the current parent-list growth behavior.
- Add codec tests for path depth, key length, element ID length, operation
  count, and parent count once limits are chosen.

Acceptance criteria:

- Tests clearly demonstrate the unsafe current snapshot behavior.
- Tests define expected behavior for overlapping CRDT kinds, even if the chosen
  behavior is rejection rather than merge.
- Existing `packages/tests/shared/crdt-contracts.test.ts` coverage remains
  passing.

## Phase 2: Define Document Shape And Path Ownership

Introduce a schema-level concept of CRDT ownership per path.

Candidate API:

- document option `schema`
- allowed operation kinds per path prefix
- optional exact path ownership for registers, maps, and sets
- validation errors for unsupported paths or mixed CRDT kinds

Recommended default:

- Keep the current permissive mode for backward compatibility during migration.
- Add strict mode for production documents.
- In strict mode, reject overlapping CRDT kinds at the same path or across a
  parent/child path unless explicitly allowed.

Acceptance criteria:

- Applications can declare that `["title"]` is a register, `["meta"]` is a map,
  and `["items"]` is an OR-set.
- Invalid operations are rejected before they enter the document.
- Materialization no longer relies on silent type precedence for strict
  documents.

## Phase 3: Make Snapshots CRDT-State Preserving

Replace materialized-only snapshots with snapshots that preserve enough CRDT
state to continue merging after compaction.

Candidate approaches:

1. Store operation-state snapshots.
   - Include compact register writes, map entry write metadata, OR-set live adds,
     delete tombstones, remove tombstones, path lookup, and causal frontier.

2. Store materialized JSON plus CRDT sidecar metadata.
   - Keep current `value` for fast reads.
   - Add internal `crdtState` for future operations.

3. Keep materialized snapshots only, but replay old collection operations.
   - Simpler conceptually.
   - Weak as compaction because the old log still matters for collection paths.

Recommended direction:

- Use materialized JSON plus a CRDT-state sidecar in snapshot envelopes.
- Version the sidecar so older snapshots remain importable.
- Keep `value` as the public snapshot read model.

Acceptance criteria:

- Importing a snapshot and then applying map/set/register operations produces
  the same final value as replaying the full log.
- Snapshot metadata includes enough tombstone/conflict information for health
  reporting.
- Snapshot import can still satisfy dependencies for included updates.
- Existing snapshot hashes include the new sidecar when present.

## Phase 4: Compact Causal Dependencies

Replace `parents = all seen update IDs` with a compact causal frontier.

Candidate model:

- Continue accepting legacy `parents`.
- Add `causalFrontier` or `dependencyClock` to update envelopes.
- Track per-replica highest contiguous counter only if update IDs become
  structured by replica sequence.
- If update IDs remain arbitrary, maintain a frontier of updates that have no
  known descendants.

Recommended direction:

- Add explicit per-replica local sequence numbers to update metadata.
- Use a vector-clock-like summary for routine causal dependency checks.
- Keep `parents` for precise dependency edges and backward compatibility.

Acceptance criteria:

- Local update envelope size does not grow linearly with total document history.
- Dependency blocking still handles out-of-order descendants.
- Sync/catch-up can use compact summaries without losing correctness.

## Phase 5: Strengthen Integrity Semantics

Clarify and improve hashing and trust boundaries.

Tasks:

- Document `crdt-fnv1a32` as a deterministic checksum only.
- Decide whether optional hashes should become required for local/durable
  updates.
- Consider replacing or supplementing FNV-1a with SHA-256 through Web Crypto and
  server runtime equivalents.
- Keep server append metadata as the trusted authority for accepted updates.
- Add tests that tampered payloads are rejected when hashes are required.

Acceptance criteria:

- The code and docs no longer imply that optional FNV hashes are security
  integrity.
- Server/durable append code has a clear policy for missing, weak, or mismatched
  hashes.

## Phase 6: Add Safe Operation Builders

Add helpers that create valid operations from current document state.

Candidate helpers:

- `setRegister(path, value, policy)`
- `setMapKey(path, key, value)`
- `deleteMapKey(document, path, key)`
- `addSetElement(path, elementId, value)`
- `removeSetElement(document, path, elementId)`
- `resolveMultiRegister(path, value)`

These helpers can inspect visible state or internal metadata to include the
right observed update IDs.

Acceptance criteria:

- Application code can remove/delete visible values without manually gathering
  observed IDs.
- Helper-generated operations pass validation.
- Helper-generated removes/deletes preserve concurrent writes.

## Phase 7: Add Bounds, Quotas, And GC Policy

Extend validation and document health with practical limits.

Tasks:

- Add validation options for operation count, parent count, path depth, path
  segment length, key length, element ID length, and blocked queue size.
- Add tombstone and snapshot-age thresholds to health reporting.
- Define when tombstones can be compacted safely.
- Define retention behavior for destroyed, archived, redacted, or encrypted
  documents.

Acceptance criteria:

- Large or adversarial updates are rejected before materialization.
- Blocked-update queues cannot grow without policy.
- Tombstone compaction has clear causal preconditions.

## Phase 8: Property And Interop Testing

Broaden the test suite beyond deterministic examples.

Tasks:

- Add randomized delivery-order convergence tests.
- Add snapshot-vs-full-replay equivalence tests.
- Add duplicate delivery and delayed dependency tests.
- Add mixed transport tests through browser facade and server topic paths.
- Add durable-log catch-up tests that import snapshots and then replay pages.
- Add graph CRDT tests once graph collaboration semantics are productized.

Acceptance criteria:

- Random operation sets converge across replicas.
- Snapshot import is equivalent to full replay for supported schemas.
- Durable catch-up converges for late joiners.
- Tests cover local-only, tab sync, WS, RTC, and durable-log paths where
  applicable.

## Non-Goals

- Do not turn this package into a generic text CRDT in this plan.
- Do not store raw binary/blob payloads inside CRDT updates.
- Do not make RTC delivery a durability boundary.
- Do not treat CRDT delete as privacy erasure without separate retention and
  redaction workflows.
- Do not silently resolve multi-value conflicts without surfacing them to the
  application.

## Suggested Priority

1. Snapshot-state correctness.
2. Path ownership/schema validation.
3. Snapshot-vs-full-replay tests.
4. Parent/frontier compaction.
5. Hash/integrity policy.
6. Operation builder ergonomics.
7. Quotas and tombstone GC.
8. Broader property, transport, and durable catch-up tests.

## Open Questions

- Should strict path ownership be required by default for all production CRDT
  documents?
- Should snapshots expose CRDT sidecar state publicly, or keep it as an internal
  envelope field?
- Should update IDs become structured as `{ replicaId, sequence }` for better
  causal summaries?
- Should SHA-256 be required for every accepted durable update?
- How much CRDT metadata should browser local storage retain after a successful
  durable snapshot?
- What is the product-level conflict resolution UX for multi-value registers?
