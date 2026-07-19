# Task 4 fourth fresh-review correction report

## Scope

This correction is limited to the API-v1 group/member/presence mutation
boundary and its shared-server implementation. It does not implement Task 5
topology-configuration work and does not add database row, table, or advisory
locks.

## Findings corrected

- Group mutation reads now prove three relationships before the first
  authoritative compare-and-set: the persisted entry has the canonical encoded
  storage key, its decoded value carries the same identity, and it occupies the
  exact actor, target, owner, director, admission, session, summary, or
  idempotency slot selected by the trusted command and aggregate metadata.
- Expected principals and sessions are never derived from the candidate row.
  Public heartbeat/disconnect, internal session cleanup, and director
  appointment reject a canonical session key whose value belongs to another
  principal. Authority admissions and their session generations must form an
  exact one-principal relationship; duplicate cross-principal references and
  conflicting generations fail closed.
- Computed guards, member/admission candidates, receipts, events, and mutation
  outbox intents are bound back to the command-derived identity. Presence
  summary reads likewise validate canonical group, member, admission, session,
  and predecessor-summary keys before accepting a computed result.
- Canonical group-state keys now live in a neutral pure module shared by the
  repository and deterministic mutation validator. Workspace absence and
  reserved identifiers use the repository's encoded key format, so validation
  does not duplicate or import repository implementation details.
- `AppGroupInboxService` overrides all four inherited unauthenticated enqueue
  variants. Each rejects before queue insertion or preparation; the explicit
  authenticated enqueue method remains the only group-mutation ingress.
- The API-v1 OpenAPI contract now includes the mandatory convergent group-state
  fields already exposed by runtime types: group ownership/count data, presence
  generation identity, snapshot state/causal revisions, and request generation
  IDs. Parsed OpenAPI and documentation compatibility tests enforce parity.
- The third correction report's shared-server command was corrected to the
  executable repository command.

## Architecture and skill corrections

- `AGENTS.md`, `rallar-code-writing`, and `rallar-realtime` now require future
  work to validate canonical key/value/command-slot relationships before CAS
  writes and prohibit deriving trusted identity from the row under validation.
- A fresh-agent pressure check read the updated skills and independently
  described the required command-derived canonical-key validation and
  optimistic retry behavior. The repository skill-integrity suite remains
  green.

## TDD evidence

The correction started with exhaustive RED probes before production edits:

```text
focused shared-server relationship/inbox run
5 findings failed

apps/api-v1/test/swagger-routes.test.ts
mandatory convergent group-state schema assertion failed
```

Additional RED probes demonstrated that public and internal presence reads
could accept the wrong principal and fail only later in policy code, that one
session could be referenced by admissions for different principals, and that a
canonical target-session key with the wrong principal value produced no
validation error in the isolated internal-disconnect path. Those probes turned
green only after the production relationship checks were added.

The final focused checkpoints were:

```text
npx vitest run packages/tests/shared-server/group-state-concurrency.test.ts
1 file passed; 39 tests passed

npx vitest run <6 Task 4 shared-server files>
6 files passed; 126 tests passed

npx vitest run packages/tests/api-v1/client-and-group-state-repositories.test.ts
1 file passed; 25 tests passed

deno test -A apps/api-v1/test/services/group-state-service.test.ts
31 passed; 0 failed
```

## Final validation

```text
npx vitest run packages/tests/shared-server
55 files passed; 2 configured files skipped
518 tests passed; 7 configured tests skipped

npx vitest run packages/tests/shared-server \
  packages/tests/api-v1/client-and-group-state-repositories.test.ts \
  packages/tests/shared-web/rallar-group-docs-compat.test.ts \
  packages/tests/repo/rallar-skill-integrity.test.ts
58 files passed; 2 configured files skipped
556 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test
191 passed; 0 failed

npm run test:postgres:presence-expiry
1 file passed; 2 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped
group-presence profile: 17 successful steps

npm run typecheck
all workspace TypeScript checks passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
76 files checked

cd apps/api-v1 && deno fmt --check test/swagger-routes.test.ts
1 file checked

npx vitest run packages/tests/repo/rallar-skill-integrity.test.ts
1 file passed; 7 tests passed

git diff --check
passed
```

The PostgreSQL and managed-memory gates initially received sandbox localhost
connect/bind denials; their approved localhost reruns are the passing results
above. No required live gate was skipped.

The root `npm run lint` command exits nonzero because four existing workspaces
(`ar-eye-hunter-v1`, `rallar-black-box`, `rallar-black-box-headless`, and
`relic-hunters-v1`) do not define a `lint` script. Every workspace that does
define one completed successfully, and the affected API-v1 Deno lint passed.
This is a root script inventory defect rather than a changed-code lint failure.

Static no-lock scans found no row/advisory/table lock use in the corrected
production paths. The deterministic mutation module has no repository,
clock-read, random, environment, transaction, or publisher dependency. The
performance baseline remains unchanged at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.

## Compatibility and residual risk

The change preserves repository key bytes by making their existing encoding a
shared pure function, and it does not alter the optimistic retry protocol or
public package exports. Failures are intentionally earlier for corrupted or
mis-slotted persisted reads. No follow-up is required for Task 4; Task 5 remains
outside this correction.
