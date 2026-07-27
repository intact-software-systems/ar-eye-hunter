---
name: rallar-platform
description: Use when working across Rallar package boundaries, public API surfaces, shared browser/server code, app-data, CRDT, package exports, new app or greenfield React/Vite/Three.js work, or general monorepo architecture under packages/** and apps/**.
---

# Rallar Platform

**REQUIRED SUB-SKILL:** Use `building-rallar-apps` for new consumer application
scaffolding and greenfield React, Vite, or Three.js architecture. Keep
`rallar-platform` focused on package boundaries and public-surface changes.
For selected game-authority, realtime, or validation surfaces, also use
`rallar-games`, `rallar-realtime`, or `rallar-testing`, respectively.

## Start Here

Read `references/package-map.md` when you need orientation. Then inspect the code before choosing an implementation path; this repo changes quickly and docs can lag.

Useful first searches:

```bash
rg -n "export .* from|createRallar|Rallar.*Facade|GroupRef|AppData|CRDT" packages apps
rg --files packages/shared packages/shared-web packages/shared-server packages/shared-test
```

## Boundaries

- `packages/shared` owns cross-runtime contracts: API types, AL, queues, WebRTC primitives, CRDT contracts, RallarAI, Rallar Game, Rallar Motion.
- `packages/shared-web` owns browser facades and browser persistence/transports.
- `packages/shared-server` owns middleware, repositories, server facades, Postgres adapters, auth, state sync, and server RallarAI.
- `packages/shared-test` owns black-box recipes, runners, providers, and test harness contracts.
- `apps/api-v1` composes the shared-server Rallar API.
- Game apps should consume package APIs rather than duplicating platform behavior.

## Public Surface Rules

- Preserve existing exports unless the task explicitly removes a deprecated API.
- Prefer adding narrow helpers beside the domain they belong to, then export through the local package barrel.
- Treat broad `mod.ts` barrels as compatibility surfaces; avoid moving symbols in ways that break imports.
- When editing shared contracts, inspect both browser and server consumers before changing a type.

## Contract Shape And Compatibility

- Authoritative shared fields are mandatory except documented input or
  migration exceptions.
- Authoritative persisted and shared contracts use mandatory fields by default.
- Required fields are the default for every authoritative persisted, replicated, queued, event, snapshot, and response contract.
  Use an optional field only when absence is a meaningful domain state that
  consumers are expected to handle and test. Sparse request, query, patch,
  builder, and migration input types are separate construction boundaries;
  their optionality must not leak into authoritative values.
- When a successful authoritative response always contains a value, require it
  in the shared TypeScript response and every derived response, OpenAPI
  `required` array, serializer, and consumer/schema compatibility test. Request
  omission semantics do not justify optional successful output.
- Do not weaken an authoritative output type merely because an intermediate
  builder or migration step is incomplete. Use a separate input type, a
  discriminated union, or an explicit migration adapter at the boundary.
- Strong contracts enable permissive convergence: mandatory causal metadata
  lets consumers accept newer observations, ignore stale ones, and detect
  equal-revision corruption without guessing.
- Backwards compatibility is a product decision, not an automatic default. If
  a design or implementation plan would retain a legacy field, work shape,
  import path, or fallback, explicitly ask the human to approve that scope
  before implementation. When approval already appears in the request, record
  the compatibility boundary and its retirement condition in the plan.

## Convergent Persistence Defaults

- **AppInbox is mandatory for incoming database mutations.** Every incoming
  HTTP or WebSocket path that mutates the database goes through AppInbox,
  including client/group/topology, authentication/session/ticket, CRDT append
  and administration, and mutating admin operations. A synchronous result wait
  never falls back to a direct mutation.
- AppInbox owns the transaction and retry boundary. Keep one visible `read`,
  `compute`, `validate`, then AppInbox transaction sequence. The `compute` and
  `validate` phases are pure; computed persistence data is not called a plan.
  The service `write(transaction, computed)` applies only that data: service
  write receives the transaction and never opens, commits, replaces, or retries
  one. A conflict returns to AppInbox for a fresh read and complete revalidation.
- In that transaction, service writes state, event, receipt, durable result, and
  final `APP_OUTBOX`/`WS_OUTBOX` rows directly through
  `ResourceInboxRepository` in the same transaction. There is no intermediate
  mutation outbox. Logical WebSocket audience resolution and worker wake-up
  happen only after commit.
- Resource-inbox processing uses 20 total processing attempts. Attempts one
  through five use 1, 2, 4, 8, and 16 ms; later delays rise through seconds and
  cap at 30 seconds with jitter. A distinct best-effort fairness lane claims
  retries more than 30 seconds overdue, independently of timeout recovery.
- Queue locks are coordination-only for bounded reservation claims. They do not
  authorize domain row, table, advisory, or CRDT document locks. Domain locks
  remain unapproved unless the human explicitly approves a measured exception.
- Use optimistic compare-and-set writes with bounded retries for authoritative
  shared state. Runtime-state creation, update, and deletion use
  `insertIfAbsent`, `upsertIfRevision`, and `deleteIfRevision`.
- Every retry must re-read current state and rerun authorization, policy,
  capacity, lifecycle, and invariant checks before deriving a new candidate.
  Never retry only the final write of a stale decision.
- Insert final outbox intents with insert-only semantics. Treat any collision as
  a typed rollback failure without loading a winner. The compact
  `MutationReceipt` family carries accepted authority, and group effects use
  `GroupStateCausalRevision`.
- Hash semantic caller intent before volatile server defaults. Represent
  omission as a mandatory nullable command field, capture random/time material
  once in immutable mandatory facts only after a validated ledger miss, and
  reuse them unchanged across every CAS retry. Matching replay and conflicting
  key reuse must not call random, clock-default, verifier, or other volatile
  materialization; a replay returns the winning receipt directly.
- Build maintenance request identity as a collision-safe canonical projection
  of the full semantic command. Operation, scope, principal/session/generation
  fences, observed predecessor values, and every cleanup or expiry timestamp
  must distinguish its idempotency key; exclude only the command/request identity
  being derived. Raw delimiter joins are not sufficient.
- Build scoped storage keys as injective typed projections, not escaped string
  concatenations that erase `undefined` versus a present identifier. Field
  name, presence/type, and value must determine one canonical key. Prove
  sentinel, delimiter, percent/lookalike, every child-key helper, prefix/list,
  and repository-boundary isolation. For an ambiguous legacy namespace,
  conditionally migrate only rows whose stored value proves the target scope;
  never fan out, guess, or retain an unbounded dual-read fallback.
- At every authoritative direct, prefix-list, page, event, and compact-receipt
  read boundary, decode the canonical storage identity and compare it with the
  trusted requested scope and slot before returning data. Do not derive the
  expected identity from the stored value. Wrong-slot or wrong-scope data is
  typed invariant corruption for the whole read, not a miss to hide, a row to
  filter, or data to rewrite or guess.
- Treat stale observations as rebase-or-ignore outcomes, duplicates as no-ops,
  and equal causal revisions with different content as invariant corruption.
- Existing direct handlers, service-owned transactions/retries, intermediate
  outboxes, and domain locks are migration debt, not compatibility precedent.
  Deadline, sunk-cost, or authority pressure does not waive these rules or the
  required verification gates.
- Test overlapping writers, retry exhaustion, idempotency races, stale expiry,
  and final convergence against the real Postgres conditional-write boundary.
- Authentication dependencies for authoritative user writes are mandatory and
  fail closed at construction and execution. Internal maintenance uses a
  closure-held narrow capability, never a forgeable public command type or
  caller-provided bypass flag.
- Before the first write, recompute the canonical operation projection from the
  validated command, read set, and immutable facts, then compare it exactly to
  the proposed guards, dependent rows, events, receipt, and outbox intent.
  Structural validation does not prove an operation is the one requested.
- Assemble snapshots at one observation time and intersect optimistic summary
  liveness with the latest group status and expiry, active membership, and
  connected/unexpired sessions. Archived, deleted, and expired groups expose
  zero live presence without discarding the summary's causal revision.
- Select the smallest correct concurrency domain. Group presence uses a
  per-session guard and does not contend on the group row; aggregate metadata
  and roster changes use the group guard.

## Validation

Use the rallar-testing skill for command selection. At minimum, type-check the changed package and run targeted tests for the touched domain.
