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
  The main hook is 651 lines; extracted owners are 14–186 lines, and each hierarchy directory has
  no more than three direct source owners. This was structure closure caused by the direct auth
  import migration; behavior is protected by the arena lifecycle suites.
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
