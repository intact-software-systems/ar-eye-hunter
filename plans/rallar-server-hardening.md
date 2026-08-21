# Rallar Server Hardening Proposal

## Summary

Keep the earlier implementation plan, with three added gaps: state read authorization, QueueBox/runtime observability, and explicit regression coverage for server hardening. Do not add a state-sync outbox yet.

Focus order:

1. Bring docs/schema truth current.
2. Add missing tests around existing gaps.
3. Fix small correctness drift.
4. Add bounded hardening code with tests beside each change.

## Additional Gaps Found

- State read routes require an auth session, but group/client snapshot and event reads do not appear to enforce per-resource membership/self-read policy. Add characterization tests first, then decide strict defaults carefully.
- Event-list rate limiting covers `/events` but not `/events/page`.
- `QueueBoxPubSubBridge` sends full payloads through Postgres `NOTIFY`, risking payload-limit failures.
- `hydrateStateSyncSnapshotCaches(...)` exists but is not wired into API-v1 startup/read paths.
- Event page APIs exist, but repositories still load all events before slicing.
- Server docs/schema drift: docs omit `resource_inbox_results` and CRDT tables; Prisma schema appears to omit CRDT models while migrations/in-memory schema include them.
- Operational observability is thin for queue age, retry attempts, no-route state-sync publishes, and pub/sub drops.

## Implementation Changes

- Update docs and schema map:
  - Fix `rallar-server-repositories.md` physical storage summary.
  - Add `resource_inbox_results` and CRDT table rows.
  - Either add CRDT models to `apps/api-v1/prisma/schema.prisma` or document migrations plus `in-memory-schema.sql` as the schema source. Recommended: add models.
- Add read-authorization characterization:
  - Prove current group/client read behavior for authenticated non-member/non-self users.
  - Add a conservative opt-in strict-read policy, e.g. `RALLAR_STATE_STRICT_READ_AUTH=false` initially, before changing defaults.
- Fix state API event route classification:
  - Treat both `/events` and `/events/page` as event-list requests.
- Add state cache hydration at safe async boundaries:
  - Hydrate process caches after successful state list/read REST responses.
  - Do not make `WsQueueBoxServerService` target resolution async in this iteration.
- Add key-only Postgres pub/sub:
  - Keep full-entry delivery for local/test adapters.
  - Add `delivery: 'key'` for Postgres; subscriber loads the durable queue entry by key before local enqueue.
- Add repository-level event paging:
  - Add client/group event page methods below services.
  - Keep existing `listEvents(...)` array APIs unchanged.
- Add QueueBox observability:
  - Emit timing/counter-style events for pub/sub payload skipped/dropped, key-load miss, state-sync no-route, queue retry age, and app-inbox wait fallback.

## Test Coverage

- Add new tests with the code, not after:
  - `state-api-read-authorization.test.ts`: current behavior characterization plus strict-read policy tests.
  - `state-api-resilience-middleware.test.ts`: `/events/page` uses event-list limiter.
  - `queuebox-pubsub-bridge.test.ts`: full-entry backward compatibility, key-only delivery, missing durable key, malformed payload, large payload avoidance.
  - API-v1 pub/sub tests: Postgres adapter emits key-only envelopes and validates channel/payload shape.
  - `state-sync-cache-hydration.test.ts` plus route-level tests: REST list/read hydrates caches.
  - `state-event-listing.test.ts` and repository tests: cursor order, limit, event type filter, and no full-history service call for page routes.
  - Schema/docs guard tests where practical: CRDT tables present in Prisma schema if Prisma remains a source of truth.
- Add a focused root script:
  - `test:rallar-server-hardening` running the focused Vitest and Deno files for this plan.
- Verification commands:
  - `npm run test:rallar-server-hardening`
  - `npx tsc -p packages/shared-server/tsconfig.json --noEmit`
  - `cd apps/api-v1 && deno task check`
  - Run broader `npm run test:unit` if public/shared contracts change.

## Assumptions

- “Tests for coverage” means focused behavior coverage, not adding a code-coverage threshold tool.
- Existing public browser/server APIs remain backward compatible.
- Strict read authorization starts opt-in unless the product decision is to break current workspace-wide read behavior.
- State-sync outbox and async WS recipient resolution remain deferred until fault-injection proves the current AppInbox plus QueueBox model is insufficient.
