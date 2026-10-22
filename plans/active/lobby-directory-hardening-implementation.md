# Lobby Directory Hardening Implementation Plan

> **For agentic workers:** Use `rallar-repo:adaptive-plan-execution` and
> `superpowers:executing-plans` to implement the two increments below. Load the owning platform,
> realtime, code-writing, game, and testing skills before their surfaces. Checkboxes describe future
> work; this planning PR does not claim implementation or runtime acceptance.

**Goal:** Finish slice 0 so callers can discover safe room summaries, revalidate them across browser
origins, and distinguish loading, empty, stale, and failed results without leaking prior-session state.

**Architecture:** Keep the existing group-directory read path and canonical shared contracts. Complete
conditional HTTP behavior at the API middleware/route boundary, and keep presentation/request lifetime
in the AR Eye runtime. Discovery remains separate from authoritative membership and activity admission.

**Tech stack:** TypeScript, Deno/Hono, React, Vitest, Deno tests, Playwright, shared black-box recipes.

**Spec:** [Lobby and matchmaking product plan, slice 0](./lobby-and-matchmaking.md#slice-0-finish-directory-hardening).

## Global constraints

- Preserve `GET /api/state/apps/{applicationId}/workspaces/{workspaceId}/group-directory` and
  `rallar.rooms.directory(request?, options?): Promise<GroupDirectoryPage>`.
- Preserve `GroupDirectoryEntry`, `GroupDirectoryPage`, and sparse `GroupDirectoryRequest` in
  `packages/shared/api/group-directory/group-directory-types.ts`. No persisted shape change is needed.
- Preserve default limit 50, maximum 200, `includeEmpty=false`, trimmed case-insensitive name search,
  the existing four `kind` values, and online-count-descending/group-id-ascending ordering.
- Pagination remains best-effort as counts change. Deduplicate entries within a refresh; never claim
  snapshot consistency or add an unrequested snapshot-retention service.
- `isFull` reports the effective membership cap. It does not imply admission availability or activity
  readiness. Do not filter out forming rooms merely because they are not lifecycle-active.
- Entries contain no roster, sessions, hidden metadata, invitation credentials, or full snapshots.
  Preserve application/workspace scope and caller visibility; never hydrate the membership cache.
- No Quick Join, listing migration, cleanup policy, spectator role, push subscription, metadata filter
  language, or permissive authoritative reader is included.
- Review and remediate every changed human-authored file in full. Every support file changed by that
  remediation enters closure recursively. Independent untouched code remains outside closure.
- Inspect current code before executing: earlier plans are context, not current standards authority.
  Preserve unrelated work, use a feature branch, and let the PR own delivery state.

## Existing implementation and remaining gaps

The original slice 0 features already exist in the tree (directory hardening PR #685). Establish a
fresh baseline using the focused commands below; do not rewrite working behavior to follow an obsolete
checklist. Source inspection establishes ownership, not runtime success.

| Boundary             | Current owner and behavior                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public contracts     | `packages/shared/api/group-directory/group-directory-types.ts`: dedicated entry/page/request, capacity, lifecycle, and limits.                                                                        |
| Query and page       | `packages/shared-server/rallar-system/group-state/directory/decode-group-directory-query.ts` and `compute-group-directory-page.ts`: filters, defaults, live keyset ordering, safe projection.         |
| Visibility           | `packages/shared-server/rallar-system/group-state/policy/group-snapshot-visibility-policy.ts`: directory tier excludes full-reader members, pending/invited members, and blocked users as applicable. |
| HTTP registration    | `apps/api-v1/src/group-state/register-group-state-read-routes.ts`: auth, decode, scoped snapshot read, visibility, page projection, JSON, Hono ETag middleware.                                       |
| Browser request      | `packages/shared-web/browser/state-read/state-snapshot-http-api.ts`: `listStateGroupDirectory`; `packages/shared-web/browser/rooms/browser-rallar-rooms.ts` owns the scoped facade operation.         |
| App request lifetime | `apps/ar-eye-hunter-v1/src/game/arena-runtime/actions/use-arena-session-actions.ts`: paged refresh, deduplication, and separate directory error.                                                      |
| App presentation     | `apps/ar-eye-hunter-v1/src/arena-ui/arena-operations.tsx`: room rows, full-room disabling, and error copy.                                                                                            |
| Relic composition    | `apps/relic-hunter-server-v1/src/main.ts` already installs `installApiHttpMiddleware`; preserve that shared owner.                                                                                    |

Concrete remaining work:

1. OpenAPI calls every entry joinable, although discovery does not evaluate every admission rule.
   Shared CORS middleware neither allows explicit `If-None-Match` nor exposes `ETag`, despite the
   documented conditional-request interface. Existing tests exercise ETags without that CORS boundary.
2. `ArenaRoomList` can render empty-lobby guidance and a directory error together. There is no explicit
   directory loading status. Refresh completion checks only that some session exists, so an old
   request can publish after a different session signs in; overlapping refreshes also need a clear
   latest-request rule. Existing hook tests do not prove the resulting visible workflow.

## Review focus

Pin these five risks in the owning increment's tests:

- Allowed cross-origin conditional reads expose a usable validator and permit the request header;
  disallowed origins remain disallowed (increment A).
- Cached successful content never substitutes for current authentication, caller visibility, or
  scope; malformed requests remain typed errors even with a validator (increment A).
- A discoverable forming or approval-based room is not described as guaranteed admission, and
  AR Eye/Relic search stays generic (increment A).
- A failed first load is not an empty success; failed refreshes label retained results stale, and
  visible Refresh recovers them (increment B).
- Logout/account replacement or a newer refresh prevents late success and failure from overwriting
  current directory state (increment B).

## Increment A: complete the discoverable-page HTTP contract

**Outcome:** Existing pages are usable and accurately documented across allowed browser origins,
including conditional reads, without weakening visibility or changing room admission.

**Modify:**

- `apps/api-v1/src/services/install-api-http-middleware.ts`.
- `apps/api-v1/src/group-state/register-group-state-read-routes.ts`.
- `apps/api-v1/resources/api-v1-openapi.yaml`.
- `apps/api-v1/test/services/install-api-http-middleware.test.ts`.
- `apps/api-v1/test/group-state/group-state-directory-route.test.ts`.
- `packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-directory.json`.

**Inspect and preserve:** the shared directory contracts, decoder, page computation, visibility
policy, `apps/relic-hunter-server-v1/src/main.ts`, and
`packages/tests/shared-web/state-group-directory-request.test.ts`. Change these only for a reproduced
in-scope failure or required touched-file remediation; do not duplicate them in API-v1 or Relic.

**Interfaces:** Keep `installApiHttpMiddleware(app, input): void`,
`registerGroupStateReadRoutes(app, dependencies, authorization): void`, and the public directory
signatures unchanged. Increment B consumes the existing page response. This increment changes header
behavior and documentation, not the response body's shape.

- [ ] Run the current directory route, middleware, and browser-request tests. Record the baseline;
      existing green cases remain regression coverage and do not need to be rewritten as artificial reds.
- [ ] Add middleware tests for an allowed-origin GET preflight requesting
      `content-type,authorization,x-client-id,if-none-match`, and a successful directory response whose
      `Access-Control-Expose-Headers` includes `ETag`. Assert the denied-origin behavior too. Run the
      focused Deno tests and confirm the missing-header cases fail for that reason.
- [ ] Extend route tests through the real middleware registration: unchanged page returns bodyless
      304 with validator/cache headers; changed count/capacity/visibility returns a new representation;
      unauthenticated strict-mode reads and malformed queries retain 401/400 even with `If-None-Match`.
      Include a validator captured before logout and a second actor who sees a different directory.
      Assert returned content or errors, not an internal helper-call sequence.
- [ ] Preserve the existing Hono ETag implementation. Allow `If-None-Match` and expose `ETag` through
      the shared HTTP middleware. Mark directory success responses `Cache-Control: private, no-cache`;
      merge `Vary: Authorization, x-client-id` with the CORS `Origin` variation. Ensure error responses
      are not converted to 304 and use `Cache-Control: no-store`. Gate conditional handling on successful
      page responses at this existing route boundary if the new tests expose the need.
- [ ] Extend directory route cases with AR Eye and Relic display names, both queried as `kind=room`,
      forming rooms, and rooms requiring admission approval. Verify safe entries and unchanged
      credential/visibility filtering, explicit/default/uncapped capacity, malformed-query outcomes, and
      unchanged keyset semantics. A zero-online result is hidden unless `includeEmpty=true`; including it
      does not promise that the underlying room can be joined. Reuse existing cases instead of duplicating
      already-complete assertions.
- [ ] Update OpenAPI from “joinable” to “discoverable”; explain membership-cap fullness, admission
      rechecking, best-effort pagination, caller-specific cache behavior, conditional-response headers,
      and the cross-origin contract. A 304 reduces body transfer; it does not prove reduced server reads.
- [ ] Extend the existing directory black-box recipe with the conditional/CORS contract and the
      second application-shaped name. Preserve its existing authentication, filtering, pagination,
      validator, and membership-transition cases. Do not create a parallel recipe for the same behavior.
- [ ] Run increment A's focused checks and affected native checks below. Review the complete touched
      files and the route-to-response path. Commit the coherent HTTP increment on the implementation
      branch with `fix: complete directory conditional read contract`.

**Legacy judgment:** Keep the canonical shared directory and shared HTTP middleware. Do not introduce
an app-local CORS copy, a second summary type, a fallback row decoder, or a second ETag algorithm.
No retained compatibility boundary or persisted migration is proposed.

## Increment B: make directory loading and recovery truthful in the app

**Outcome:** A user sees a clear result, can recover through Refresh, and never sees a directory
published by an old session or superseded refresh. Room discovery still does not change membership.

**Modify:**

- `apps/ar-eye-hunter-v1/src/game/arena-runtime/actions/use-arena-session-actions.ts`.
- `apps/ar-eye-hunter-v1/src/game/arena-runtime/state/use-arena-runtime-state.ts`.
- `apps/ar-eye-hunter-v1/src/game/arena-runtime/arena-connection-contracts.ts`.
- `apps/ar-eye-hunter-v1/src/game/arena-runtime/use-rallar-arena.ts`.
- `apps/ar-eye-hunter-v1/src/arena-ui/arena-operations.tsx`.
- `packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts`.
- `packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts` for its complete arena fixture.
- `apps/ar-eye-hunter-v1/playwright.config.ts` to select the new spec in its desktop project.

**Create:** `tests/playwright/ar-eye-hunter/open-arena-directory.spec.ts`.

**Inspect:** `packages/tests/ar-eye-hunter-v1/arena-runtime-test-harness.ts` for reusable auth and
runtime setup, and `tests/playwright/ar-eye-hunter/director-capability-delivery.spec.ts` for the
existing visible sign-in/operations flow. Any modified harness also enters full standards closure.

**Interfaces:** Keep `ArenaConnection.refreshRooms(): Promise<void>` and the existing `openRooms`
and `openRoomsError` outputs. Add required
`openRoomsStatus: 'idle' | 'loading' | 'ready' | 'error'` to the arena connection contract and owned
state, and forward it through the existing hook. This is app presentation state, not a shared Rallar
public API or a persisted value. Increment A's `GroupDirectoryPage` stays unchanged.

- [ ] Add hook cases using controlled deferred promises: successful empty load becomes `ready`;
      first failure becomes `error`; successful retry clears the error; a later refresh wins over an
      earlier success or failure; logout followed by another login ignores both old outcomes; a failure
      on a later page retains the last complete result, never a partially assembled replacement.
      Run the focused Vitest file and confirm the missing status/request-ownership assertions fail.
- [ ] Own a monotonic refresh generation and capture the issuing session identity before the first
      await in `refreshRooms`. Every state publication after an await, including error/finalization,
      requires the same current session and latest generation. Reset directory state on sign-out.
      Continue requesting and deduplicating the existing pages within that one refresh. Do not introduce
      a reusable request framework or change authoritative membership behavior.
- [ ] Start as `idle`, enter `loading` when refreshing, and publish `ready` only after a complete
      successful page traversal. On failure publish `error`, retain the previous complete entries, and
      expose the failure message. A retry clears the displayed error while loading; it does not relabel
      retained entries as current until successful completion.
- [ ] Update visible copy: loading shows “Loading open arenas…”; an error shows “Could not load open
      arenas” and the existing Refresh action; retained entries after error show “Last loaded arenas —
      refresh to check availability.” Show empty-lobby guidance only after `ready` with no own or open
      rooms. Keep full rows disabled and label other rows “Request to join” so discovery does not promise
      immediate admission. A successful join still follows the existing authoritative entry flow.
- [ ] Add Playwright cases that sign in through visible controls and click Refresh: first-load error
      without empty guidance, successful empty result, stale retained rows after failure, recovery to a
      changed page, and a full row that cannot be joined. Network interception is appropriate for
      deterministic UI failure cases; do not claim those intercepted tests prove browser HTTP caching.
- [ ] Add a separate allowed-origin browser check with a live local API and no request interception:
      fetch the directory, read its exposed ETag, send explicit `If-None-Match`, and verify the 304.
      Click the visible Refresh action again and verify the normal facade still renders a page. Do not
      feed a raw 304 into the JSON-only helper or add a parallel application cache; native browser
      revalidation and explicit low-level conditional fetch are distinct paths. Report live-service
      skips as skips.
- [ ] Include the new spec in `desktop-delivery`'s `testMatch`; `--list` must actually select it.
      Resolve reachability through the existing test workflow/manual-suite rules, without marking a
      never-run test as CI proof. Run focused unit/browser checks and the AR Eye build below. Commit the
      coherent app increment with `fix: make arena directory refresh state reliable`.

**Legacy judgment:** Preserve the existing room facade, request helper, complete-page replacement,
shared middleware, and runtime harness. Remove affected duplicate or obsolete code during closure;
no new legacy path or compatibility adapter is authorized by this plan.

## Validation commands and acceptance

Commands below are for the implementation PR. Record actual passed, failed, and skipped outcomes;
this document is not test evidence. Run from repository root except where a working directory is
explicitly named.

| Stage               | Command                                                                                                                                                      | Required result                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline and A      | `deno test --allow-env --allow-read test/group-state/group-state-directory-route.test.ts test/services/install-api-http-middleware.test.ts` in `apps/api-v1` | Existing cases pass; new CORS/header cases fail before the fix and pass afterward.                                                      |
| Baseline and A      | `npx vitest run packages/tests/shared-web/state-group-directory-request.test.ts`                                                                             | Existing facade request/response contract remains green.                                                                                |
| A native checks     | `deno task check` in `apps/api-v1`, then separately in `apps/relic-hunter-server-v1`                                                                         | Both hosts accept the shared middleware/route changes.                                                                                  |
| A REST behavior     | `npm run test:api-v1:black-box:memory -- --standard-only`                                                                                                    | Standard recipes, including the extended directory recipe, pass; inspect current-run artifacts.                                         |
| A group-read gate   | `npm run test:api-v1:black-box:postgres:medium-scale`                                                                                                        | The testing skill's API-v1 group-state gate passes without reducing its workload; report unavailable Postgres as skipped, not accepted. |
| B unit behavior     | `npx vitest run packages/tests/ar-eye-hunter-v1/use-rallar-arena-auth-lifecycle.test.ts packages/tests/ar-eye-hunter-v1/app-diagnostics-lifecycle.test.ts`   | Final status, entries, errors, and session/request races satisfy the named cases.                                                       |
| B browser selection | `npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts open-arena-directory.spec.ts --list`                                                | The new desktop tests are listed, not silently excluded.                                                                                |
| B visible behavior  | `npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts open-arena-directory.spec.ts`                                                       | Deterministic visible workflow cases pass.                                                                                              |
| B live browser      | `RALLAR_ARENA_FULL_STACK=1 npx playwright test --config apps/ar-eye-hunter-v1/playwright.config.ts open-arena-directory.spec.ts`                             | With the local API fixture on port 8080, sign-in and cross-origin conditional reads pass; the Playwright config starts the SPA on 5186. |
| B consumer          | `npm --workspace ar-eye-hunter-v1 run build`                                                                                                                 | Typecheck and production build pass; report warnings.                                                                                   |
| Reachability        | `npm run check:test-reachability`                                                                                                                            | New semantic coverage is selected or honestly registered under the repository's manual-suite contract.                                  |
| Standards           | `npm run check:repo-style` and `npm run check:repo-structure`                                                                                                | Review findings across the touched closure; warning-only exit status is not a waiver.                                                   |

If implementation changes a shared-web export or entry point, additionally run public API snapshot
and browser-bundle boundary tests and the shared-web bundle check. If it changes authoritative
mutations or their concurrency domain, load the convergent-service reference and add the state-write
performance/comparison gates required by the testing skill. Those changes are not anticipated here.
Do not run distributed RTC manifests merely for documentation, HTTP headers, or presentation state.

Before broad final validation run `npm run pr:delivery -- status`; repair real conflicts first.
Require the applicable Branch Release Gate and report its actual state. At handoff run
`npm run pr:delivery -- ready` once. The PR that completes both increments deletes this implementation
plan and updates the product plan's baseline; retain later product outcomes. Stop when GitHub reports
merged, without post-merge governance work.

## Risk, rollback, and follow-up

The main risks are accidentally changing discovery into authorization, accepting stale session
results, and overstating what caching or green hook tests prove. Explicit route, browser, and visible
workflow evidence covers those separately. There is no persisted migration: rollback is reverting the
implementation changes, not retaining an alternate production path.

No independent follow-up issue is required for slice 0. Invitations, Quick Join, listing migration,
retention, and social features remain the later product outcomes. A genuine public compatibility or
standards exception discovered during execution follows the repository's maintainer decision rules;
it is not silently resolved by retaining a fallback.
