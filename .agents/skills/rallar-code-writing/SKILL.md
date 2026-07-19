---
name: rallar-code-writing
description: Use when writing, refactoring, or reviewing package-oriented Rallar TypeScript under packages/**, or app code that consumes or extends package APIs, to follow repo style, functional design, testability, and AI-generated code safety expectations.
---

# Rallar Code Writing

## Start Here

Inspect nearby package code and tests before choosing a shape. Read `references/package-code-style.md` when a change introduces exports, state, abstractions, or nontrivial behavior.

Useful first searches:

```bash
rg -n "export function|export const|export type|export class|createRallar|Readonly<|GroupRef|StateSync|RallarAi" packages
rg --files packages/tests packages/shared packages/shared-web packages/shared-server packages/relic-hunters
```

## Workflow

1. Identify the domain boundary first: shared contract, browser facade, server runtime, game rules, AI, motion, graph, or tests.
2. Reuse existing helpers and package APIs before adding new modules.
3. Keep algorithmic behavior in one canonical helper; adapters and bridges should delegate to it rather than reimplementing logic.
4. Prefer small functions with explicit inputs and return values.
5. Inject clocks, random IDs, repositories, providers, transports, and side effects through options.
6. Add or update behavior tests with the code change.
7. Use the rallar-testing skill to pick targeted checks and package type-checks.

## Contract Defaults

- Prefer required public and persisted fields. Authoritative persisted,
  replicated, queued, event, snapshot, and response values should be fully
  populated. Optional fields are appropriate only when omission has domain
  meaning and a consumer test; convenience during construction is not domain
  meaning.
- A field present in every successful authoritative response is required in
  shared TypeScript, derived service responses, OpenAPI, serializers, and
  compatibility tests. Do not transfer optionality from a sparse request field
  to its fully resolved successful output.
- Model incomplete construction with a separate input type or discriminated
  union, then produce a fully populated authoritative value at the boundary.
- Do not add a backwards-compatibility fallback by default. Before a plan
  keeps a legacy field, message shape, import, or runtime path, explicitly ask
  the human to approve compatibility and document how long it remains.

## Database Write Defaults

- Do not implement authoritative state as read, derive, then unconditional
  upsert. Create with conditional insert; update with expected-revision compare-and-set;
  delete or expire with expected-revision conditional delete.
- Treat expiry as deletion: its first authoritative guard is the
  expected-revision conditional delete of the exact observed row. Do not use a
  disconnected/tombstone update as an expiry shortcut; reserve such updates
  for non-expiry lifecycle transitions that explicitly retain the row.
- On a compare-and-set conflict, bound the retry count, re-read the whole
  decision surface, and rerun authorization, policy, capacity, lifecycle, and invariant checks.
  A retry of only the stale write is incorrect.
- Express authoritative control flow with direct named read, compute, validate,
  and write statements. Surround each statement with timing records and report
  the transaction separately; never put phase work in a timing callback.
- Make idempotency claims with insert-if-absent semantics. The losing writer
  loads the winner; it must not overwrite the ledger. This winner-load rule is
  for the idempotency ledger, not an authoritative outbox write.
- Insert the outbox intent inside the authoritative state/receipt/event
  transaction. Use an insert-only repository operation: a collision throws a
  typed error, rolls everything back, and performs no winner read. Keep any
  winner-loading convenience on a separately named non-authoritative/read path.
- Fail-closed event, outbox, and immutable-identity collisions are terminal at
  queue boundaries. Give their typed errors an explicit 4xx status and never
  retry, reschedule, or regenerate a command after such a collision.
- Hash caller semantics before server random/time defaults: keep omission as a
  mandatory nullable command field, then read and validate idempotency before
  invoking random, clock-default, verifier, or other volatile materialization.
  Only a ledger miss captures immutable facts. Reuse them for the full retry
  loop; replay and conflicting key reuse invoke no volatile callbacks. Never
  hash generated defaults or regenerate them after a compare-and-set conflict.
- Maintenance request IDs use a collision-safe canonical projection of every
  semantic field other than the derived command/request identity, including
  operation, full scope, principal/session/generation fences, observed
  cleanup/expiry values, and timestamps. Do not rely on the hash or raw
  delimiter joins to repair an aliased idempotency key.
- Database row, table, and advisory locks are exceptions, not reusable
  architecture. Require explicit human approval and document the protected
  invariant, evidence, bounded critical section, and removal condition.
- Before an authoritative compare-and-set, validate each persisted entry's
  canonical storage key, decoded value identity, and command-derived read slot.
  Derive expected principals, sessions, targets, and request IDs from the
  trusted command, never from the row being validated. Bind guards, dependent
  candidates, events, receipts, and outbox intents to those same identities.
- Apply that identity rule to reads as well as writes. Direct, prefix-list,
  page, event, and compact-receipt reads decode the canonical key and validate
  the complete persisted contract and trusted scope and slot before returning
  or projecting data. SQL-backed JSON must exactly agree with physical identity,
  filter, order, and cursor columns. A mismatch throws
  a typed invariant-corruption error for the whole read; it is not a miss to
  hide, a list row to filter, or data to rewrite or guess.
- Persisted shared-data validators enforce derived and cross-field invariants
  in addition to exact keys and primitive shapes. Recompute canonical scalar
  projections and require discriminants, payload presence, revisions, hashes,
  and related lifecycle fields to agree before accepting or replaying a row.
- Authoritative admin/domain summaries validate every source row canonically,
  including unscoped/global reads, before counting or joining in domain code.
  Reuse the complete persisted contract: exact shape, mandatory fields,
  identity, and cross-field lifecycle invariants. Test canonically keyed but
  shape-invalid rows, not only noncanonical keys or wrong-slot identities.
  Never collapse absent scope and a present sentinel-looking identifier into
  one join key. Aggregate shortcuts are allowed only for separately labeled raw
  storage telemetry, not authoritative domain summary fields.
- Key builders are pure injective encoders over field name, type/presence, and
  value. `encodeURIComponent`-style escaping alone cannot distinguish an
  absent value from a valid sentinel string. Test exact canonical keys,
  delimiter/percent/lookalike values, all derived child keys, prefix listings,
  and repository isolation. Ambiguous legacy data requires value-verified,
  conditional migration; never guess, duplicate into both scopes, or hide the
  ambiguity behind permanent dual reads.
- Recompute the complete canonical operation projection from the validated
  command, read set, and immutable facts and require exact equality before the
  first write. Common shape and identity checks are necessary but insufficient.
- Snapshot assemblers capture one observation time and intersect optimistic
  summary sessions with latest group active/unexpired policy, active membership,
  and connected/unexpired session state. Terminal or expired groups retain their
  causal tuple but report no live presence.

## Shape Decision

- Use a pure function for parsing, validation, transformation, derivation, routing decisions, key building, and policy checks.
- Use a factory returning a plain interface when behavior needs private mutable state but does not need inheritance or lifecycle hooks.
- Use a class when the code owns lifecycle, cache state, subscriptions, persistence, connection state, or long-lived runtime coordination.
- Keep stateful objects narrow and injectable; avoid hidden global state unless the surrounding package already uses that repository pattern.

## AI-Generated Code Safety Checklist

- No untested behavior changes.
- No new abstraction without real duplication or complexity reduction.
- No broad public export unless it is intentionally part of the package API.
- No hidden clock, randomness, network, storage, or repository dependency when injection would make tests deterministic.
- No clever code where named helpers or explicit branches would be easier to review.
- No parallel implementations of the same algorithm; bridges or adapters need a clear boundary, compatibility, or runtime reason.
- No app-local duplicate of behavior that already belongs in `packages/**`.
- No unconditional authoritative upsert after a read-derived decision.
- No lock-based concurrency test where a conflict, rebase, retry exhaustion,
  and final-convergence test is required.

## Validation

Run focused tests for the touched behavior and type-check the changed package. For public API or cross-runtime changes, check both browser and server consumers before finishing.
