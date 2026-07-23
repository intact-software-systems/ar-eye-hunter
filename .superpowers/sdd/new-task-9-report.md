# Task 9 correction 2 execution report

## Outcome

The CRDT mutation path now uses AppInbox as the only production write entry
point. HTTP and WebSocket handlers enqueue commands; AppInbox opens the single
transaction; services read, compute, validate, and write through the received
transaction. Domain rows, canonical results, WS fanout, and durable audit work
therefore commit or roll back together.

The correction also closes the remaining review gaps:

- append timing and expiry use trusted server capture time;
- delivery identity is stable across reconnects while a reused update ID with
  different content is rejected;
- default production policy is deny, and document-type policy/quota
  configuration is wired into the production factory;
- trusted actor, principal, session, and server identity are mandatory in
  persistence contracts and schema, with an explicit legacy backfill migration;
- lifecycle commands distinguish preserve, clear, and set;
- accepted fanout resolves a principal to every active session after commit;
- destructive audit records are durable `APP_OUTBOX` work written in the same
  transaction and use the existing ResourceInbox retry mechanism;
- prune progress is fenced before deletion, every page is transactional, page
  expiry is renewed from current time, and app-data pruning requires an explicit
  namespace;
- legacy direct PostgreSQL mutation entry points reject instead of bypassing
  AppInbox; and
- converted CRDT/admin paths contain no row, advisory, or nested transaction
  locks and no inner retry loop.

## TDD evidence

Focused RED tests reproduced each correction before implementation, including:

- client-supplied append time and unbounded expiry;
- reconnect replay and changed-content update-ID collision;
- prune deletion before its progress fence and partial-write rollback;
- impossible result envelopes accepted by permissive decoders;
- sender-only fanout instead of principal fanout;
- production wildcard policy accidentally enabled;
- logical IDs substituted for physical update/snapshot rows;
- nullable trusted identity columns and accepted corrupt metadata;
- admin failure returned as `{ ok: true }` or collapsed to status 400;
- compact quota and rebuild-integrity violations still writing;
- audit work not surviving/retrying through ResourceInbox; and
- a conflict retry committing accepted output after authority revocation.

The corresponding GREEN suites exercise real PGlite transactions and injected
failures, in addition to focused service tests. The production injection suite
covers rollback at six write stages, conflict/revocation rereads, reconnect
replay, enqueue failure, durable audit retry, and no domain/outbox mutation on
rejection.

## Validation

- `npx vitest run packages/tests/shared-server/app-crdt-inbox-service.test.ts packages/tests/shared-server/rallar-crdt-log-repository.test.ts packages/tests/shared-server/rallar-crdt-server-topic.test.ts packages/tests/shared-server/admin-prune-expired-work.test.ts packages/tests/shared-server/admin-operations-service.test.ts packages/tests/shared-server/crdt-app-inbox-ingress-correction.test.ts packages/tests/shared-server/crdt-mutation-correction-2.test.ts packages/tests/shared-server/crdt-task9-correction.test.ts packages/tests/shared-server/rallar-middleware.test.ts packages/tests/shared-server/rallar-middleware-crdt-principal.test.ts packages/tests/shared-server/admin-prune-task9-correction.test.ts` — 11 files, 87 tests passed.
- `deno test --allow-env --allow-read --config deno.json test/routes/crdt-admin-routes.test.ts test/routes/crdt-admin-route-compat-correction.test.ts test/routes/admin-operations-routes.test.ts test/db/pglite-crdt-task9-correction.test.ts test/db/pglite-crdt-app-inbox-production-correction-2.test.ts test/db/pglite-admin-prune-authority-correction.test.ts` — 30 tests passed.
- `npm run typecheck` — passed across all workspaces in the final verification gate.
- `deno check --config deno.json src/main.ts` — passed in the final verification gate.
- `deno lint --rules-exclude=require-await <37 changed TypeScript files>` — passed. `require-await` is excluded because existing repository/test async interfaces intentionally implement promise-shaped APIs without awaiting.
- `deno fmt --check <37 changed TypeScript files>` — passed.
- `node scripts/check-changed-ts-file-growth.mjs 6cdb7ed6 WORKTREE` — passed; no production TypeScript file grew by more than 400 lines.
- `git diff --check` — passed in the final verification gate.

## Architectural decisions

There is one retry owner: ResourceInbox/AppInbox. A retry rereads authority,
policy, capacity, lifecycle, and revision facts and recomputes the complete
mutation. Service write functions do not contain an inner retry loop.

Fairness remains best effort. The existing retry/backoff and timeout mechanisms
remain independent of the explicit stale-schedule fairness lane; this correction
does not introduce locks to manufacture fairness.
