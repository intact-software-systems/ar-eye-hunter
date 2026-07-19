# Task 4 fifth fresh-review correction report

## Scope

This correction is limited to API-v1 group/member/presence mutation semantics,
their shared-server implementation, and the repository guidance that governs
future work on those paths. It does not implement Task 5 topology work, change
API-v1 files, or add database row, table, or advisory locks.

## Findings corrected

- Join-code rotation no longer puts generated codes or clock-derived expiry
  values into the semantic command before its idempotency hash is computed.
  Omitted public inputs remain explicit `null` command fields. The stable
  semantic intent is hashed first, while one generated code and one captured
  clock observation are carried as immutable mutation facts across all CAS
  retries.
- Idempotency is checked before those captured facts affect a result. A replay
  therefore returns the original receipt even when the current clock or random
  source differs. Concurrent omitted-default invocations converge, explicit
  and omitted intent remains distinguishable, and CAS retries never regenerate
  defaults.
- Trusted facts now bind the resolved join code to the command: rotation must
  provide a resolved/verifier pair and an explicit code must match it;
  join/accept operations bind it to their command input; unrelated operations
  require both values to be `null`.
- Expiry and disconnected-session maintenance request IDs now include their
  semantic observation timestamps. Two workers observing different times do
  not masquerade as one request, while exact duplicates still converge on one
  durable terminal effect.
- `validateGroupMutation` now recomputes the complete deterministic projection
  from the trusted command, validated read set, and immutable facts, then
  requires exact equality. Forged but shape-consistent guards, entries,
  receipts, events, idempotency records, and outbox intents are rejected before
  any authoritative write.

## Optional/default audit

The shared-server audit found one volatile semantic-default defect in the
public group mutation surface: join-code rotation generated a default before
semantic hashing. Group creation's join-mode/director defaults are
deterministic. Invitation expiry and presence timestamps are derived from
captured facts after idempotency handling. An automatically generated request
ID remains invocation identity only when no stable idempotency key is supplied.
No other public group mutation exposed the same volatile-default problem.

## Architecture and skill corrections

`AGENTS.md`, `rallar-platform`, `rallar-realtime`, and
`rallar-code-writing` now require future work to preserve omission in semantic
commands, hash intent before resolving volatile defaults, capture facts once
per invocation, retry the full read/validate/project/CAS operation without
regeneration, cover every semantic observation in maintenance IDs, and compare
the exact canonical deterministic projection rather than validating only its
shape.

The repository improvement document records the concrete audit and fixed
identity rules. A fresh-agent RED pressure check initially chose unsafe retry
regeneration, incomplete maintenance identity, and shape-only validation. A
fresh-agent GREEN check after the guidance edits independently selected
semantic hashing before defaults, complete maintenance identity, and canonical
projection recomputation. The repository skill-integrity suite also remains
green.

## TDD evidence

The tests were written before the production correction. The initial focused
run produced 7 failures and 40 passes, covering mandatory nullable rotation
fields, forged deterministic projections, omitted-default replay, explicit
versus omitted intent, concurrent omitted requests, expiry workers with
different observations, and disconnected-session cleanup with different
observations. A later command/fact-binding probe failed independently before
the binding validator was added.

Final focused checkpoints:

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts \
  packages/tests/shared-server/group-state-service-idempotency.test.ts
2 files passed; 64 tests passed

npx vitest run <6 Task 4 shared-server files>
6 files passed; 135 tests passed

npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file passed; 25 tests passed

deno test -A apps/api-v1/test/services/group-state-service.test.ts
31 passed; 0 failed
```

## Final validation

```text
npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
530 tests passed; 7 configured tests skipped

npx vitest run <documentation, skill-integrity, and focused broad files>
4 files passed; 74 tests passed

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
1 file passed; 7 tests passed

npm run typecheck
all workspace TypeScript checks passed

cd apps/api-v1 && deno task test
191 passed; 0 failed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
76 files checked

npm run test:postgres:presence-expiry
1 file passed; 2 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
group-presence profile: 17 successful steps

git diff --check
passed
```

The PostgreSQL and managed-memory gates initially received sandbox localhost
connect/bind denials. Their approved localhost reruns are the passing results
above; no required live gate was skipped.

The full API-v1 `deno fmt --check` still reports 13 existing unformatted files
out of 101. This correction changes no file under `apps/api-v1`, so the result
is independent of this diff; bulk-formatting unrelated files is outside scope.
The root `npm run lint` process exits zero, but its output reports four existing
workspaces without lint scripts (`ar-eye-hunter-v1`, `rallar-black-box`,
`rallar-black-box-headless`, and `relic-hunters-v1`). Every configured workspace
linter completed successfully, including API-v1 Deno lint.

Static scans found no row/advisory/table lock primitives in either corrected
production service and no direct clock, random, environment, transaction,
publisher, or Rallar repository dependency in the deterministic mutation
module. The performance baseline remains unchanged at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.

## Compatibility and residual risk

The change preserves public operation shapes by representing omitted rotation
inputs with mandatory nullable fields at the internal authoritative boundary.
It preserves optimistic compare-and-set behavior and strengthens convergence
under replays and contention. Invalid or forged computed projections now fail
earlier by design. Task 5 remains outside this correction.
