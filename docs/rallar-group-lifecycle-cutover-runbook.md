# Rallar Group Lifecycle Cutover Runbook

The group formation lifecycle ships as a **hard cutover**. Product decision 14 forbids compatibility
shims, so there is no version negotiation, no dual-read, and no adapter that accepts the old shapes.
This document exists because that decision has a deployment consequence which is easy to discover the
expensive way: **durable rows written before the cutover cannot be decoded after it**, and the failure
mode is a throw on a worker, not a rejected request.

Read `docs/rallar-group-formation-architecture.md` for what the lifecycle is. This document only
covers getting from a pre-lifecycle deployment to a lifecycle one.

## Why a reset is required, not merely tidy

Two independent mechanisms make old rows unreadable.

**Full `GroupSnapshot`s are embedded in durable queue rows.** An AppInbox command, its result row and
the outbox entries it produced all carry the aggregate as serialized JSON. On dequeue those are
re-validated with **exact-key strictness** — `requireExactKeys` in
`packages/shared-server/rallar-system/protocol/exact-object-decoding.ts` compares the sorted key list
and throws `TypeError` on any difference, in **both** directions. A row queued before the lifecycle
fields existed is missing keys the decoder now requires; a row queued before `activationStatus` was
added carries one fewer key than the current list. Either is a throw.

**The coalesced work metadata is guarded the same way.** The replanning window's maximum-wait anchor
is a field on the coalesced work codec, itself behind an exact required/allowed list. Rows in flight
across the cutover fail the same check.

A throw on a queue worker is not a request failure a client retries. The entry redelivers, throws
again, and burns down its attempt budget to `FAILED`. Nothing surfaces to a user, and the work the
row represented is silently lost.

The browser side fails even more quietly: group delta application swallows validation throws and
degrades to ignoring the delta, so a browser holding a pre-cutover cache does not error — it simply
stops seeing group changes.

## What must be verified before cutting over

Record the answers; do not assume them. This is the check the runbook exists to make explicit.

1. **No running deployment requires compatibility.** Confirm that every deployment reading either
   database is being replaced in this cutover, not left on the old build. Today the repository
   deploys three Deno applications (`rallar-server`, `rallar-bb-server`, `relic-hunters`) and three
   browser bundles (Eye Hunter to Cloudflare Pages, Relic Hunter Web and Rallar Kit to Cloudflare
   Workers) from one `main` push, so the answer is normally "yes, all of them" — but a manually
   pinned application or a second environment sharing a database would make it "no", and that has to
   be found before the reset rather than after.
2. **Which databases are in scope.** Two are: `DATABASE_URL` (api-v1, shared by `rallar-server` and
   `rallar-bb-server`) and `DATABASE_URL_RELIC` (`relic-hunters`). Both hold group aggregates and
   both hold queue rows, so both are reset. A deployment that has added a third database has to add
   it here.
3. **Whether any queued work is worth preserving.** It cannot be migrated — see above — so the only
   options are to drain it before the reset or to accept losing it. Decide deliberately.

## Ordering

The ordering is the whole point: every step exists because doing it later admits a window in which a
new server reads an old row or an old server writes one.

1. **Stop accepting new work.** Take the servers out of rotation. If they must stay up to serve
   reads, set `RALLAR_API_QUEUE_WORKERS=disabled` on every process first — a disabled worker process
   is deliberately passive and stops producing new durable rows. This requires
   `RALLAR_SQL_BACKEND=postgres`.
2. **Drain the queues.** With intake stopped and workers still enabled on exactly one process, wait
   for the queues to empty. Observe it on `GET /api/admin/operations/realtime`: wake counts stop
   advancing, drain failures stay flat, and maximum lag returns to its floor. A queue that will not
   drain has entries already failing — inspect them with
   `POST /api/admin/support/explain/queue-item` before deciding to discard them.
3. **Reset or drop.** Drop both databases, or reset them to an empty schema, and run
   `deno task prisma migrate deploy` against each. A reused database that merely had migrations
   applied is **not** sufficient: migrations change the schema and leave the pre-cutover rows in
   place, which is exactly the state that throws.
4. **Deploy both servers before any browser.** `rallar-server` and `relic-hunters` first (and
   `rallar-bb-server` with them), so no old server can write a row a new one will read. The
   repository's `deploy.yml` already orders each API deployment behind its own migration step; what
   this runbook adds is that the browsers must not go first.
5. **Deploy the browsers.** Then instruct clients to reload. A browser holding a pre-cutover
   IndexedDB cache is the last stale reader in the system, and its failure mode is silence rather
   than an error, so a forced reload is worth more here than it usually is.

## Rollback

Rollback is symmetric and equally destructive, for the same reason: the new build writes rows the old
one cannot decode.

- **Before the reset**, rollback is ordinary: redeploy the previous build. Nothing has been written
  in the new shape.
- **After the reset**, the previous build cannot read the new rows. Rolling back means repeating the
  procedure in the other direction — stop, drain, reset both databases again, deploy the old servers,
  then the old browsers. There is no path that preserves data written after the cutover.
- **If a decode fails after the fact** — a worker throwing `TypeError: ... fields are invalid`, or an
  entry burning to `FAILED` — the cause is a surviving pre-cutover row, which means step 3 did not
  actually empty the database. Do not patch the decoder to accept the old shape; that reintroduces
  the compatibility path decision 14 removed. Reset again.

## Local development

The same property bites locally, which is where it will be met first. A reused local Postgres carries
queued rows across a branch switch, so after checking out a branch that changes any persisted group
shape, drop the database rather than migrating it.

`npm run db:down` is **not** enough on its own: it runs `docker compose down` without `-v`, and the
`pgdata` named volume survives with every pre-cutover row in it. Remove the volume explicitly:

```sh
docker compose down -v && npm run db:test:up
```

The black-box Postgres profiles and the medium-scale gate are the usual place this surfaces — as
decode throws on the mutation path, not as an obviously shape-related failure.
