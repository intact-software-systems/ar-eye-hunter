# Rallar CRDT Sequence/Text Follow-Up Plan

Date: 2026-06-04

Status: Partially implemented. Ordered-list sequence CRDT support now exists;
rich text and editor-grade sequence work remain follow-up product scope.

Related plans:

- `plans/rallar-crdt-product-and-implementation-plan.md`
- `plans/rallar-crdt-production-hardening-companion-plan.md`

## Purpose

Rallar CRDT currently supports JSON operation batches, maps, OR-sets, LWW
registers, multi-value registers, and ordered-list sequence insert/delete/move
operations.

This plan now records the implemented ordered-list slice and the work still
needed if collaborative rich text, editor-grade lists, or paragraph-level
editing become product scope.

## Current Boundary

Do not model rich text as unordered map/register state. For ordered lists,
applications can now use sequence operations with stable element and position
IDs. Until rich text is implemented, applications should use:

- map/register fields for metadata
- OR-sets for unordered membership
- ordered-list sequence operations for kanban columns, paragraph ordering, and
  rich-list shells
- external rich-text services for editor-grade text collaboration

## Implementation Plan

### Implemented Ordered-List Slice

- Added `sequence.insert`, `sequence.delete`, and `sequence.move` operation
  contracts under `packages/shared/crdt`.
- Added stable position IDs with deterministic replica/update tie-breaks.
- Added durable replay, snapshot metadata, and missing-dependency checks for
  observed sequence update IDs.
- Added browser helpers for ordered-list mutation.
- Added convergence, move/delete, snapshot, and browser-helper tests.

### Phase 1: Product Semantics

- Define whether Rallar needs plain text, rich text, or tree-like document
  support beyond ordered-list shells.
- Define conflict presentation and application-level resolution expectations.
- Define maximum document size and chunking behavior.

### Phase 2: Shared Sequence Core

- Add rich-text operation contracts under `packages/shared/crdt`.
- Define mark/span behavior, cursor affinity, and text-specific tombstones.
- Add deterministic rich-text insert/delete/mark tests and fuzz tests.
- Preserve operation identity for durable append and debug replay.

### Phase 3: Browser Facade

- Add rich-text helpers without changing `rallar.data`.
- Add chunked replay and snapshot import/export for large ordered documents.
- Expose conflicts and repair state through existing CRDT health.

### Phase 4: Durable And Operational Hardening

- Add quota policies for sequence length, operation size, and tombstone growth.
- Add compaction/redaction strategy before production use.
- Add black-box recipes for concurrent edits, deletes, reconnect, and replay.

## Acceptance

- Reordered, duplicated, and replayed ordered-list operations converge.
- Ordered-list snapshots plus later operations reproduce full replay.
- Rich-text operations converge when they are added.
- Tombstone/compaction behavior is explicitly documented.
- Large ordered documents do not require unbounded catch-up payloads.
