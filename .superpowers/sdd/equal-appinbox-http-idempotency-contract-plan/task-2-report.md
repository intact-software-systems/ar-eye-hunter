# Task 2 report: auth and client HTTP cutover

## Status

Implemented and verified on `codex/api-mutation-idempotency-path-contract` from task base
`407251f258180c2d19da1feb5ebe535eecdb4328`. The change is ready to commit and was not
pushed.

## Delivered behavior

- Replaced all six covered auth mutation routes and all five covered client mutation routes with
  the strict `.../requests/:requestId` contract. The removed mutation URLs are not registered and
  return 404. Request IDs are read only from the path, retain their exact case and bytes, and are
  rejected when also supplied through the idempotency header or request body.
- Routed every covered operation through an operation-specific AppInbox topic. Auth registration
  and login use normalized username plus operation context; authenticated auth operations use
  client/session context; single-use ticket consumption uses a credential digest. Client contexts
  include application, workspace, target principal, caller client, and caller session.
- Kept authentication and authorization ahead of replay disclosure. Logout replay after live
  session invalidation reads every live row for the exact `(operation topic, requestId)` scope,
  performs a fixed-work digest comparison for every candidate, and accepts exactly one matching
  credential-and-client proof. Consumed agent tickets use the same digest-proof principle. No raw
  credential is persisted or used as an AppInbox key.
- Preserved the existing physical AppInbox tuple, reservation, durable result, equal in-flight wait,
  retry, and atomic mutation/result/effect/completion boundary. Capture-time drift is excluded from
  logical command equality, so equal requests converge on one persisted winner while their exact
  winner result is replayed.
- Mapped validation, malformed JSON, authentication, authorization, conflict, rate-limit,
  unavailable, exhausted, and unexpected mutation failures to `ApiMutationFailure` `canonical.v1`.
  Application-owned response status, body, and headers continue through the durable result path.
- Cut the directly coupled shared-web auth and client HTTP callers to strict paths and request
  bodies without `requestId`. WebSocket-ticket retry/circuit-breaker attempts reuse one path request
  ID. The low-level Rallar black-box agent bootstrap callers use the new shared-web auth owners.
- Updated the authoritative mutation-route inventory to the strict paths and the extracted auth
  route owners, so the syntax-aware AppInbox routing boundary continues to cover the live files.
- Split `packages/shared-web/browser/api-integration.ts` into cohesive HTTP/auth owners without a
  facade: `api/http-request.ts`, `auth/session-http-api.ts`,
  `auth/agent-session-ticket-http-api.ts`, and `auth/websocket-ticket-http-api.ts`.
  `api-integration.ts` is now 915 lines.
- Split the former 2,437-line AR Eye Hunter arena hook into the `game/arena-runtime` hierarchy.
  The final main hook is 408 lines; extracted capability owners are 19–270 lines. This was
  structure closure caused by the direct auth import migration; behavior is protected by the
  arena lifecycle suites.
- Moved the state-snapshot read helpers into one cohesive `routes/state-snapshot-read` owner while
  preserving their imports and behavior.

## Security and compatibility decisions

- No schema or persisted-format change was introduced. The only database-port addition is
  `findAllByTopicAndResourceId(topicId, resourceId)`, implemented against the existing
  `resource_inbox` table and returning every live scoped candidate ordered by row ID.
- A lookup by `(topic, requestId)` is never treated as actor-unique. Replay proof examines all
  candidates and only then selects an exact context-valid command, preventing first-row disclosure
  and allowing two callers to reuse the same request ID independently.
- Credential comparison has fixed digest work for every candidate, including malformed/unrelated
  candidate rows. Cross-client proof is denied even when the request ID matches.
- Existing group, topology, CRDT, admin, and read routes were not migrated. Higher-level black-box
  workbench/recipe and public workflow closure remains the explicitly deferred Task 5 horizon; the
  low-level callers required to keep this slice buildable were migrated here.
- No compatibility shim or legacy mutation registration remains on the covered API routes.

## TDD evidence

### RED

- `cd apps/api-v1 && deno test -A test/routes/auth-client-mutation-idempotency-routes.test.ts`
  initially failed because the strict auth/client request paths were unregistered and the old
  identity sources were still accepted.
- `npx vitest run packages/tests/shared-server/auth/auth-http-idempotency-security.test.ts`
  initially failed the operation-key isolation and post-invalidation credential-proof cases. The
  suite was expanded to cover two actors sharing a logout request ID, their independent replays,
  cross-proof denial, capture-time drift, and consumed-ticket proof.
- The canonical registration-validation assertion initially observed the native validation body
  rather than `ApiMutationFailure canonical.v1` and failed until the route-wide mapping was applied.
- During final self-review, the authoritative architecture command
  `npx vitest run packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
  packages/tests/shared-server/mutation-route-owner-analysis.test.ts
  packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts
  packages/tests/shared-server/mutation-route-owner-group-construction.test.ts
  packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts` reported
  103 passing and 10 failing tests because the inventory still named the removed URLs and old auth
  owner. After migrating the inventory and nested auth-route audit roots, it passed 113/113.
- The first full shared-web run exposed an invalid colon-delimited client heartbeat request ID.
  The group workflow identity helper was preserved, while client API mutations received a separate
  canonical UUID owner; the focused workflow/heartbeat rerun passed 41/41 and the full suite then
  passed 533/533.

### GREEN

- API route/database focus:
  `cd apps/api-v1 && deno test -A test/routes/auth-client-mutation-idempotency-routes.test.ts
  test/config-route-auth-logout.test.ts test/routes/agent-session-ticket-route.test.ts
  test/routes/app-inbox-timeout-durable-route.test.ts
  test/client-state/client-state-mutation-routes.test.ts test/db/pglite-auth-app-inbox.test.ts
  test/composition/create-api-v1-route-installers.test.ts
  test/routes/state-snapshot-read-cors.test.ts test/routes/state-snapshot-read-query.test.ts`
  — 26/26 passed, including 10 strict route tests and 2 PGlite atomicity tests. The PGlite suite
  printed its expected terminal failed-entry diagnostics while still exiting 0; credential values
  are intentionally not reproduced here.
- `npx vitest run packages/tests/shared-server/auth` — 30 files, 123/123 passed. The focused HTTP
  idempotency security file contributes 4/4.
- `npx vitest run packages/tests/shared-server/client-state` — 22 files, 96/96 passed.
- Mutation routing/owner architecture focus — 7 files, 113/113 passed.
- `npm run test:shared-web` — 90 files, 533/533 passed.
- `npx vitest run packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts
  packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts` — 2 files, 21/21 passed.
- Typechecks passed for API-v1 (`deno task check`), shared-server, shared-web, rallar-black-box, and
  ar-eye-hunter-v1. The shared-web browser bundle budget check also passed.
- Touched API Deno formatting and lint checks each inspected 26 files with zero findings.
- `node scripts/check-changed-repo-style.mjs 407251f258180c2d19da1feb5ebe535eecdb4328
  WORKTREE` — zero changed-file style findings.
- `npm run check:repo-structure -- --base
  407251f258180c2d19da1feb5ebe535eecdb4328` — PASS. Its 12 review findings are existing coherent
  density/prefix boundaries in rallar-black-box, shared-server services, shared-web browser, and
  rallar-runtime; the actionable API-integration and arena navigation findings are closed.
- `npm run check:test-structure-coupling` — PASS with registry complete/current. Two unrelated
  `tests-typecheck-gate.test.ts` candidates remain unreviewed; no changed task candidate remains.
- `git diff --check` — clean.

## Broader gate observations

- Full `deno fmt --check apps/api-v1` remains red on 9 untouched files. Full
  `deno lint apps/api-v1` remains red with 30 findings in untouched files. The changed-file variants
  are green and no finding points to a task file.
- `npm run typecheck:tests` still reports 15 existing errors in five untouched shared-server test
  files: admin AppInbox, durable enqueue, expired-row replacement, the AppInbox transaction test
  runtime, and topology AppInbox handler tests. All touched focused suites and surface typechecks are
  green.
- `npm run pr:delivery -- status` reported `STOP_WRONG_BASE` for existing PR #304 because its base is
  not the repository default. No branch update, PR mutation, or push was attempted.

## Self-review

Every changed human-authored file was reviewed in full after the final structure moves. The review
caught and corrected two cross-slice regressions before commit: group workflow request IDs were
temporarily changed while creating canonical client IDs, and the mutation-route inventory still
described the removed routes. Final review confirmed exact path identity handling, all-candidate
constant-time credential proof, operation/context isolation, canonical failure construction,
direct-import ownership after the splits, and the absence of legacy covered route registrations.

There are no task-specific follow-up issues and no new retained compatibility exception.

### Commands executed and what they taught us

- Focused Deno and Vitest RED/GREEN runs proved the route contract, authentication-before-replay,
  actor isolation, proof replay, PGlite atomicity, and live route-owner inventory. Reusing one
  request ID across actors must always be tested at both the HTTP and storage-owner layers.
- Shared-server auth/client suites and the full shared-web suite proved that logical command
  convergence and caller retry behavior remain intact. A request-ID helper shared by different
  protocols is unsafe when the protocols permit different alphabets.
- Five surface typechecks plus the browser bundle budget proved the extracted owners preserve their
  package interfaces and app consumers. Large-file extraction is safest when direct imports are
  migrated before deleting the previous owner.
- Focused Deno lint/fmt, changed-style, structure, coupling, and diff checks proved the changed slice
  is clean. Full-tree warnings were separated from touched-file evidence by exact file lists instead
  of being silently grandfathered.
- Read-only Git and PR delivery checks confirmed the work is on the requested non-default branch and
  that the existing PR base is not suitable for automated delivery. No push or remote mutation was
  performed.

## Fix round 1

Fix base: `81354fb1a8f023d5bdf6140cecb160cddf1312b3`.

### Findings verified and corrected

1. **Logical retry identity.** `ApiMutationRequestOptions` now requires a caller-owned
   `requestId` for login, registration, logout, WebSocket-ticket issue, agent-ticket issue, and
   agent-ticket consumption. The Rallar session controller allocates login/register/logout IDs
   before `Command` construction. WebSocket ticket attempts receive one ID before the circuit
   supplier. Client heartbeat allocates one heartbeat ID and one distinct presence-repair ID before
   the outer command retry supplier. Browser agent issue and bootstrap consume callers now own the
   IDs; bootstrap consumption retains the same ID after a rejected/lost response.
2. **Winner-owned auth facts.** Auth routes pass stable intent and TTL only. `AppAuthInboxService`
   first reserves the existing physical AppInbox tuple, then the transaction winner samples the
   auth clock and creates IDs, tokens, tickets, password facts, hashes, and expiry timestamps. The
   repository operation `writeMaterializedIfAbsentOrReplaceExpired` composes the existing
   transaction, `tryWriteIfAbsentOrReplaceExpired`, exact-key reread, and replace operations; it
   adds no table, column, or persisted-format change and keeps the existing expired-row CAS/retry
   semantics. Concurrent losers block on/reuse the committed row and do not run the materializer.
3. **Canonical state middleware failures.** The state authentication middleware is now an explicit
   owner. Exact strict client mutation paths receive canonical authentication/authorization
   failures, while reads retain the legacy body. Resilience middleware emits canonical 429/503 for
   strict client mutations and retains legacy read responses. All five removed mutation paths
   bypass both middleware owners so they reach the router and remain 404 even without credentials.
4. **Retry-After.** Canonical 429 responses carry `Retry-After` as
   `ceil(retryAfterMs / 1000)` while preserving exact body metadata. The header is attached to the
   returned 429 response rather than the Hono context, preventing an eagerly constructed fallback
   from leaking the header onto successful responses. CORS exposes it and `ApiHttpError` preserves
   it for WebSocket backoff.
5. **Typed auth boundary.** `RequestAuthFailure` owns an explicit authentication/authorization
   discriminant, stable code, 401/403 status, and canonical details. Mutation failure mapping and
   post-invalidation logout proof fallback inspect this type; neither infers security behavior from
   message wording. Tests use deliberately changed messages to prove classification stability.
6. **Arena capability ownership.** Deleted the five forwarding owners
   `use-arena-actions.ts`, `use-arena-game-actions.ts`,
   `use-arena-connection-lifecycle.ts`, `use-arena-match-lifecycle.ts`, and
   `use-arena-transport-lifecycle.ts`. The 408-line root composes the real session, diagnostics,
   presence, combat, world, connection, RTC, match, director, and AI hooks directly. Runtime state
   (270 lines) and presence lifecycle (136 lines) are cohesive owners; all other arena owners are
   19–208 lines. The durable game entrypoint map now points to the hierarchy.

### TDD RED evidence

- Stable retry identity:
  `npm exec vitest -- run packages/tests/shared-web/rallar-auth-session-compat.test.ts
  packages/tests/shared-web/api-integration-ws-ticket-backoff.test.ts
  packages/tests/shared-web/api-workflows.test.ts
  packages/tests/rallar-black-box/legacy-shell-models.test.ts
  packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts
  packages/tests/rallar-black-box/runner-agent-launch.test.ts` initially reported 4 failed and 52
  passed. The failing assertions observed a new request ID per login/register/logout retry and no
  caller-owned identity at the ticket boundaries.
- Winner fact ownership: the new concurrent login and delayed-materialization assertions in
  `packages/tests/shared-server/auth/auth-http-idempotency-security.test.ts` initially failed because
  both contenders sampled request-time facts before AppInbox reservation. The final pre-dequeue
  assertion is exact: with two contenders, the auth clock and access-token fact creator are each
  called once; the delayed winner samples no clock until its materialization gate opens.
- Canonical middleware/auth boundary: the focused Deno route/service wave initially reported 16
  passed and 2 failed after moving validation/fact ownership, exposing stale registration mocks;
  the typed failure and route fixtures then passed 18/18. Message-independent authentication and
  logout replay assertions failed against the prior prefix-based classification.
- Shared-web public surface:
  `npm run test:shared-web` reported 89 files passed, 1 failed and 539/540 tests because the exact
  `mod.ts` snapshot omitted the deliberately exported `ApiMutationRequestOptions`. Updating that
  public contract produced 540/540.
- Header isolation:
  `cd apps/api-v1 && deno test --allow-env --allow-read
  test/services/state-api-resilience-middleware.test.ts` reported 6 passed and 1 failed with
  `'13' !== null` on a successful mutation. Attaching `Retry-After` to only the returned 429
  response produced 7/7.
- Arena navigation inspection found the root still at 518 lines with five forwarding owners and a
  durable reference to the deleted pre-split path. Direct composition, two cohesive state owners,
  forwarder deletion, and navigation correction reduced the root to 408 lines.

### GREEN behavior evidence

- Focused API route/auth/client/middleware/PGlite command:
  `cd apps/api-v1 && deno test -A
  test/routes/auth-client-mutation-idempotency-routes.test.ts
  test/config-route-auth-logout.test.ts test/routes/agent-session-ticket-route.test.ts
  test/routes/app-inbox-timeout-durable-route.test.ts
  test/client-state/client-state-mutation-routes.test.ts
  test/db/pglite-auth-app-inbox.test.ts test/db/pglite-auth-failure-atomicity.test.ts
  test/composition/create-api-v1-route-installers.test.ts
  test/services/state-api-authentication-middleware.test.ts
  test/services/state-api-resilience-middleware.test.ts test/request-auth-service.test.ts`
  — 37/37 passed. This includes four PGlite tests covering the new materialized repository path,
  atomic auth state/result/ticket CAS, policy reread, rollback on effect collision, and finalization
  retry exhaustion. Expected failed-entry diagnostics were printed by those negative tests; the
  command exited 0.
- Retry/lost-response command:
  `npm exec vitest -- run packages/tests/shared-web/api-integration-ws-ticket-backoff.test.ts
  packages/tests/shared-web/api-mutation-failure.test.ts
  packages/tests/shared-web/api-workflows.test.ts
  packages/tests/shared-web/rallar-auth-session-compat.test.ts
  packages/tests/rallar-black-box/legacy-shell-models.test.ts
  packages/tests/rallar-black-box/recipe-console-agent-launch.test.ts
  packages/tests/rallar-black-box/runner-agent-launch.test.ts` — 7 files, 93/93 passed. It covers
  login, register, logout, WebSocket ticket, agent-ticket issue and consume, heartbeat, and repair
  response-loss/retry identity.
- Winner/security/repository focus:
  `npm exec vitest -- run
  packages/tests/shared-server/auth/auth-http-idempotency-security.test.ts
  packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts` — 2 files, 9/9 passed.
  The concurrent test proves one pre-dequeue clock call and one secret-fact call; delayed execution
  samples at 9,000 ms and returns a 69,000 ms expiry rather than consuming TTL in the queue.
- Full shared-server auth plus expired-row coverage:
  `npm exec vitest -- run packages/tests/shared-server/auth
  packages/tests/shared-server/app-inbox-expired-row-replacement.test.ts` — 31 files, 128/128
  passed. Full client:
  `npm exec vitest -- run packages/tests/shared-server/client-state` — 22 files, 96/96 passed.
- Full shared-web: `npm run test:shared-web` — 90 files, 540/540 passed. Browser bundle boundary:
  `npm run check:browser-bundles --workspace=packages/shared-web` — passed; all budgeted entrypoints
  remained below their Brotli limits.
- Full arena: `npm exec vitest -- run packages/tests/ar-eye-hunter-v1` — 12 files, 76/76 passed.
  The focused diagnostics/auth lifecycle pair also passed 21/21.
- Mutation-route architecture inventory:
  `npm exec vitest -- run packages/tests/shared-server/app-inbox-mutation-routing-contract.test.ts
  packages/tests/shared-server/mutation-route-owner-analysis.test.ts
  packages/tests/shared-server/mutation-route-owner-boundary-traversal.test.ts
  packages/tests/shared-server/mutation-route-owner-group-construction.test.ts
  packages/tests/shared-server/mutation-route-owner-group-http-shapes.test.ts
  packages/tests/shared-server/mutation-route-owner-registration-collections.test.ts
  packages/tests/shared-server/mutation-route-owner-registration-predicates.test.ts` — 7 files,
  113/113 passed.

### GREEN static and repository evidence

- Five surface checks passed: `deno task check` in `apps/api-v1`, plus
  `npm run typecheck --workspace=packages/shared-server`,
  `npm run typecheck --workspace=packages/shared-web`,
  `npm run typecheck --workspace=apps/rallar-black-box`, and
  `npm run typecheck --workspace=apps/ar-eye-hunter-v1`.
- The explicit touched API set contained 21 TypeScript files. `deno fmt --check` and `deno lint`
  both reported `Checked 21 files` with zero findings. A wrapper run from the API subdirectory
  selected zero changed paths and consequently reproduced the known full-tree 9-file format and
  untouched lint findings; the explicit root-relative rerun above is the authoritative touched-file
  result.
- `node scripts/check-changed-repo-style.mjs
  407251f258180c2d19da1feb5ebe535eecdb4328 WORKTREE` — PASS with zero new findings.
- `npm run check:repo-structure -- --base
  407251f258180c2d19da1feb5ebe535eecdb4328` — PASS. Twelve findings remain review-level coherent
  density/prefix boundaries in black-box, shared-server services, shared-web browser, and
  rallar-runtime; no arena or newly extracted owner finding remains.
- `npm run check:test-structure-coupling` — PASS with registry entries current. The two unreviewed
  `tests-typecheck-gate.test.ts` candidates are unrelated and unchanged.
- `git diff --check` — clean.

### Fix-round self-review and disposition

Every fix-round changed human-authored file was reviewed after formatting, including the new
repository transaction helper, auth fact materializers/matchers, route and middleware boundaries,
all low-level HTTP callers and retry owners, the arena capability hierarchy, navigation reference,
and focused tests. The review caught the eager `Retry-After` leak described above before commit.
No schema, persisted format, old mutation route, compatibility facade, or security exception was
introduced. There are no task-specific follow-ups; the separately identified branch-wide Task 1
cognitive-load CI finding remains outside this fix round as directed.

### Commands executed and what they taught us (Fix round 1)

- Focused RED/GREEN Vitest and Deno commands established that request identity belongs to the
  logical action, not an individual transport attempt, and that response-loss tests must inspect
  exact request paths across attempts.
- Concurrent in-memory plus PGlite AppInbox tests established that materialization can be placed
  behind the existing transactional reservation without weakening expired-row replacement,
  finalization fencing, or rollback semantics.
- Middleware route tests established that strict-path recognition must include a deliberate bypass
  for removed mutation paths; otherwise pre-router auth/rate middleware can violate the required
  404 cutoff.
- Full package suites, five typechecks, bundle measurement, changed-style, structure, coupling, and
  diff checks established that the API/public-surface and arena ownership changes remain buildable
  and navigable across every touched consumer.
