# Task 4 third fresh-review correction report

## Scope

This correction reviews Task 4 after `79c31d0f` and remains limited to the
API-v1 group/member/presence mutation boundary and its shared-server
implementation. It does not implement Task 5 topology-configuration work and
does not introduce database row, table, or advisory locks.

## Findings corrected

- Authoritative user group writes now fail closed at both the type and runtime
  boundaries. `authSessionRepository` is mandatory, all public mutation methods
  require authority, `prepareMutation` always authenticates, and constructing a
  service without a real auth-session reader is rejected.
- `AppGroupInboxService` exposes one authenticated enqueue method that requires
  a real `IssuedAuthSession`. Calling the inherited raw enqueue path rejects
  before queue insertion. Dequeued proofs are exact, command-bound contracts:
  missing, legacy, malformed, extra-field, expired, revoked, or mismatched proof
  data cannot reach the mutation service.
- Socket cleanup and expiry no longer share the public `GroupStateService`,
  cached service, middleware runtime, or group app-inbox surface. Composition
  retains a separately wired narrow `GroupStateMaintenanceService` capability.
  It accepts only session identity/time, derives generation, revision, expiry,
  and disconnect semantics from persisted state, and cannot accept
  caller-provided actor, reason, or bypass fields.
- Maintenance remains optimistic and convergent. Socket cleanup and periodic
  expiry perform exact-generation conditional writes with the shared bounded
  `[0, 2, 8]` retry policy; stale candidates re-read and cannot disconnect a
  newer reconnect generation. A winning expiry atomically stores its receipt,
  event, and mutation-outbox intent, while repeated reconciliation is a no-op.
- Membership removal and ban now write an admission fence even when no
  admission row existed. A first connect racing that governance transition
  therefore contends on the same conditional row, rebases from the winner, and
  cannot resurrect presence for a non-active member.
- Presence-summary convergence now reads exact group, member, admission,
  session, and current-summary entry envelopes, validates their persisted
  shapes, and filters live sessions through current active membership. The
  summary remains an optimistic materialized view: it CASes only its exact
  predecessor and newer source mutations enqueue follow-up convergence work.
- Stored group/member/session lifecycle validators now require the matching
  audit fields for archived/deleted, left/removed/banned, and disconnected
  states. Test fixtures were migrated to the mandatory authoritative shapes
  rather than weakening production types.
- A test-only authenticated runtime helper supplies explicit issued sessions to
  the real mandatory production API. No production unauthenticated overload or
  fallback was added for compatibility with tests.

## Architecture and documentation corrections

- `AGENTS.md`, `rallar-platform`, and `rallar-realtime` now make fail-closed
  authority, narrow maintenance capabilities, active-membership filtering, and
  optimistic materialized-view convergence explicit guidance for future AI
  changes.
- `rallar-server-repositories-improvements.md` now describes the implemented
  transaction-local mutation outbox as the sole group publication owner. Stale
  text describing group app-inbox publication, deferred/missing outbox work,
  and group advisory-lock hardening was removed.
- The documented durability tradeoff is explicit: WebSocket close observation
  is best effort, so process death can leave presence live until its mandatory
  TTL. Periodic generation-fenced expiry is the durable recovery path;
  immediate disconnect latency is optimistic while convergence is eventual.

## TDD evidence

The correction started with focused failing assertions before production edits:

```text
group-app-inbox-authority.test.ts
2 failed, 11 passed
```

The RED cases proved that extra proof fields were accepted and maintenance was
still exposed publicly. Focused concurrency/summary RED runs added five failing
cases for missing fail-closed construction, absent-row connect-versus-ban/remove
fencing, stale membership in summary computation, and malformed entry envelopes.

The first consolidated GREEN checkpoint was:

```text
npx vitest run packages/tests/shared-server/group-app-inbox-authority.test.ts \
  packages/tests/shared-server/group-state-concurrency.test.ts \
  -t "fails closed before|raw user inbox|extra fields|legacy maintenance|refuses to construct|fences a first connect|filters a stale admitted|before the summary CAS"
2 files passed; 14 passed; 32 skipped by the name filter
```

The final focused authority/inbox/outbox regression passed 3 files and 40 tests.

## Final validation

```text
npx vitest run --project shared-server
55 files passed; 2 configured files skipped
514 tests passed; 7 configured tests skipped

cd apps/api-v1 && deno task test
190 passed; 0 failed

npm run test:postgres:presence-expiry
1 file passed; 2 tests passed

npm run test:api-v1:black-box:memory
11 profiles passed; 0 failed; 0 skipped

npm run typecheck
all workspace TypeScript checks passed

cd apps/api-v1 && deno task check
passed

cd apps/api-v1 && deno task lint
76 files checked

cd apps/api-v1 && deno fmt --check <7 changed API files>
7 files checked

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
production paths. The deterministic mutation module has no clock read, random,
environment, transaction, or publisher access; its only `Date` use is
deterministic `Date.parse(...)` validation. The performance baseline remains
unchanged at SHA-256
`ba502493d88d08272a14c66f8ac81575c273cba8c8c654800dad8a9ddfdb81a7`.
