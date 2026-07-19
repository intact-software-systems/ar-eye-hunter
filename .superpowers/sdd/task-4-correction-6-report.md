# Task 4 sixth fresh-review correction report

## Scope

This correction is limited to the Task 4 group/member/presence write path,
shared group snapshot assembly, and the repository guidance that governs future
work on those surfaces. It does not start Task 5, change topology behavior, or
add database row, table, or advisory locks.

## Findings corrected

### Replay resolves before volatile materialization

`executeReceipt` now validates and hashes the semantic command before its retry
loop. Every attempt reverifies authority, reads the full mutation surface, and
runs a pure validated idempotency probe. A matching ledger entry returns the
stored winner and conflicting key reuse fails before random join-code/event,
clock-default, or verifier materialization. Only a validated ledger miss
captures one mandatory immutable fact set. The same facts are reused for every
CAS retry; if a concurrent contender wins, the next read replays that winner.

The early probe preserves canonical storage-key/value/command-slot validation
and validates the stored request, hash, receipt, and receipt command identity.
The normal miss path remains the explicit read -> compute -> validate -> write
flow with phase timing, while the replay/conflict path revalidates its canonical
probe result in the validate phase. Authentication is still reverified before
every read.

### Maintenance identity is complete and collision-safe

Expiry and socket-cleanup commands now derive their request/command ID from a
versioned domain prefix plus canonical JSON of the complete semantic command.
The projection includes operation, application/workspace/group scope,
principal, session, generation ID/version, observed expiry, disconnect time,
heartbeat, expiry, and the fixed maintenance actor/reason fields. It cannot
alias delimiter-bearing identifiers. Exact duplicate work still shares one
terminal event/outbox; any changed hashed observation gets a distinct identity
and rebases or no-ops against current state.

The Task 4 maintenance audit found only these two internal group-state command
builders (`expiry` and `session-cleanup`); both use the same canonical helper.
No caller-controlled maintenance identity or bypass path was added.

### Snapshot liveness follows current group policy

`GroupStateRepository` now captures one observation time per snapshot assembly.
A summarized session is active only while the latest group is `active` and not
logically expired, the current member is active, and the session is connected
and unexpired. The shared assembler covers `readSnapshot`, `listSnapshots`, and
`listSnapshotsPage`, so archived, deleted, and expired groups report zero
`activeSessions` and `onlineMemberCount` even before summary work drains. The
current group revision and summary presence revision remain intact.

The delayed join-code verifier can change race scheduling. The existing
metadata-versus-rotation test now asserts the actually convergent result: both
caller metadata and the stored verifier metadata survive, while the plaintext
join code remains absent.

## Historical and guidance corrections

The fifth correction report is retained as historical evidence but now has a
prominent supersession note: its implementation still called volatile sources
before the ledger and its maintenance IDs covered only selected timestamps.

`AGENTS.md`, `rallar-platform`, `rallar-realtime`, `rallar-code-writing`, and
the repository improvement guide now state all three durable rules:

- replay and conflict perform zero volatile materialization, and a same-request
  candidate is never abandoned/regenerated during CAS retry;
- maintenance identity is a collision-safe canonical projection of every field
  in the semantic command other than its derived command/request identity, not
  an incomplete raw delimiter join; and
- snapshot assemblers preserve causal revisions while intersecting optimistic
  summaries with latest group lifecycle/expiry, membership, and session state.

Writing-skills pressure evidence was captured before editing. With no repo
guidance, a fresh agent allowed abandoning/regenerating a generated candidate
inside one request and proposed an incomplete maintenance key that excluded
scan time and omitted principal/heartbeat/observed-expiry facts. After the
guidance changes, a fresh agent independently required zero replay/conflict
callbacks, immutable retry facts, the complete canonical maintenance
projection, and lifecycle-gated snapshots with preserved causal tuples.

## TDD evidence

Tests were edited before production or guidance changes.

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
4 failed; 46 passed
```

The four RED failures were:

- the collision-safe maintenance identity helper was absent;
- identical omitted-code replay invoked the injected random source after it was
  armed to throw;
- conflicting semantic input invoked random materialization instead of raising
  `GroupMutationIdempotencyConflictError`; and
- a stale live summary leaked presence after the latest group became archived.

The lifecycle fixture was then tightened while still RED: it writes a valid
live summary against active group revision 1, updates only the latest group to
revision 2, and proves the same leak for archived/deleted/past-expiry cases
through all three snapshot APIs. The maintenance proof varies domain, every
scope/session/principal/generation/observation/timestamp field, and ambiguous
delimiter placements at a fixed maintenance time.

Final focused checkpoints:

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts \
  packages/tests/shared-server/group-state-service-idempotency.test.ts
2 files passed; 66 tests passed

npx vitest run <6 Task 4 shared-server files>
6 files passed; 147 tests passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts \
  packages/tests/shared-server/group-state-concurrency.test.ts \
  packages/tests/shared-server/group-state-service-idempotency.test.ts
4 files passed; 76 tests passed
```

## Full validation

```text
npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
532 tests passed; 7 configured tests skipped

npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file passed; 25 tests passed

deno test -A apps/api-v1/test/services/group-state-service.test.ts
31 passed; 0 failed

cd apps/api-v1 && deno task test
191 passed; 0 failed

npm run typecheck
all root and workspace TypeScript checks passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
76 files checked

cd apps/api-v1 && deno fmt --check test/swagger-routes.test.ts
1 file checked

npm run test:postgres:presence-expiry
1 file passed; 2 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
group-presence profile: 17 successful steps

git diff --check
passed
```

The live PostgreSQL and memory black-box commands first received sandbox
localhost connect/bind denials. Their approved reruns are the passing results
above; no live gate was skipped.

The full API-v1 `deno fmt --check` still reports the same 13 existing
unformatted files out of 101; this correction changes no API-v1 file. An
exploratory `deno fmt --check` over changed shared package files also failed
because Deno's two-space output conflicts with the package's established
four-space format. No bulk reformat was applied; package TypeScript checks,
focused tests, and `git diff --check` are clean.

Static scans found no row/advisory/table lock primitive in the changed
production paths and no repository import, clock, random, environment,
transaction, or publisher dependency in the deterministic mutation module.
The performance baseline remains unchanged at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.

## Compatibility and residual risk

Public REST request/response shapes remain unchanged. The maintenance helper is
exported only from the existing shared-server service module for focused pure
identity tests; it is not added to a broad package barrel. Existing durable
maintenance records retain their historical keys, while new observations use
the versioned canonical key. This is safe because idempotency keys are immutable
per work item and current maintenance scans derive only the new identity.

Presence summaries remain asynchronous materialized views and may undercount
until convergence, but they can no longer over-report liveness for a terminal or
expired latest group. Task 5 remains outside this correction.
