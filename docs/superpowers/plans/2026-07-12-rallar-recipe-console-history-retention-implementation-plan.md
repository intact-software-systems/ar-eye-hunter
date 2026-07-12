# Rallar Recipe Console History, Compare, Saved Filters, And Retention Implementation Plan

Status: in progress; Iteration 7 is green through `cc17169` and `382df72`;
Tasks 0–5 are complete; Task 6 is in progress

**Goal:** Complete parent Iteration 8 by making past distributed work
findable, shareable, comparable, and safely cleanable without changing the
approved six-view information architecture or the legacy/control contracts.

**Architecture:** Add a bounded History workspace under the existing lazy
`Tune` route. Reuse the public shared-test history filter and Iteration 7 Tune
comparison models; do not create a second compare implementation. Extend the
control server with an optional non-destructive retention preview and guarded
confirmation while preserving the omitted-body destructive response and
deletion semantics. Store only bounded, versioned, non-secret filter presets.

**Tech stack:** React 19, TypeScript, CSS Modules, shared-test deterministic
helpers, Deno control server, Vitest, Playwright/System Chromium.

---

## Binding Decisions

- Iteration 7 must be green and committed before Task 1 implementation starts.
- Keep the six approved top-level views. History is a focused
  `src/recipe-console/history/**` subtree composed into the lazy Tune route;
  no `history` view or seventh primary-navigation item is added.
- The main Tune decision/evidence plane stays ahead of History in the reading
  path. History may be long, but it does not push current timing evidence below
  filters on first load.
- The root connection query result is the only server History source. Its
  current fallback distributed-run request remains part of that serialized
  authority and must retain visible provenance; a retained artifact may remain
  inspectable in Tune but never becomes a server-history row or authorizes
  retention.
- Reuse and extend `filterDistributedRuns(...)`; preserve its current
  case-insensitive matching, `createdAtEpochMs` range semantics, legacy
  `failureType` and `user` fields, and `updatedAtEpochMs` descending order.
- Add URL fields `historyGroup`, `historyRecipeId`, `historyProfile`, and
  `failureCategory`. Reuse `historyQuery`, `status`, `from`, and `to`.
  `recipeId` remains cross-view operational selection and is never overloaded
  as a History filter. Filter form
  submission/reset pushes one committed history entry; transient typing is
  component-local and never persisted as an operational selection.
- Render at most 100 filtered History rows in Iteration 8 and show exact total
  and omitted counts. Iteration 9 owns virtualization/windowing.
- Saved presets use one versioned local-storage key and a pure injected storage
  adapter. Persist only the whitelisted History filters and a bounded name;
  never persist run selections, compare IDs, credentials, tokens, artifacts,
  transient draft text, or active-preset state. Cap at 12 presets, 64 name
  characters, 512 query characters, and 256 characters for other strings.
  Create presets only from committed URL filters, never the current form draft.
- Preserve `POST /retention/cleanup` with no preview query as the current
  destructive behavior and exact success shape:
  `{ deletedRunIds, retainedRuns, maxRuns }`.
- Add `?dryRun=true` as a non-destructive preview. It returns the existing
  fields plus `dryRun: true`, `wouldDeleteRuns`, `wouldDeleteRunIds`,
  `wouldDeleteDistributedRunIds`, `wouldDeleteFleetReportIds`,
  `projectedRetainedRuns`, and an opaque `planToken`; `deletedRunIds` is empty
  and `retainedRuns` remains the current count. `wouldDeleteRuns` carries each
  candidate's control identity, connected-agent count, safe issued-run-token
  count, linked distributed identities/states, and linked fleet-report
  identities so every destructive consequence is visible before confirmation.
- Confirm the preview with `?planToken=...`. The short-lived token is bound to
  a process-scoped secret/nonce and fingerprints the cap,
  ordered candidate IDs, connected-agent IDs/counts, and a canonical stable
  content digest for every control run, linked distributed run, and fleet
  report that the plan will delete, including a secret-free digest and visible
  count of server-internal issued run-token state. Never expose token values.
  Do not rely on `updatedAtEpochMs` as a version: distinct mutations can share
  a millisecond. A same-timestamp content change, run-token issuance, process
  change, expiry, or any candidate/consequence drift returns `409` without
  mutation. Cryptographic digest/signature work may await: confirmation first
  captures the current canonical consequence string, verifies the token, then
  synchronously re-plans and byte-compares a fresh canonical string before
  applying those IDs in the same JavaScript turn. No await may separate that
  final re-plan, comparison, and prune. Omitting the token preserves legacy
  behavior.
- Generated plan tokens use a bounded versioned base64url syntax and are at
  most 512 characters. Successful guarded confirmation returns the exact
  legacy `{ deletedRunIds, retainedRuns, maxRuns }` success shape; only dry-run
  responses add preview fields.
- Keep request bodies completely ignored, including arbitrary or malformed
  bodies, because that is current repository behavior. Validate only the new
  `dryRun` and `planToken` query inputs. Unknown legacy query fields remain
  ignored. This avoids an unapproved request-contract break.
- Preview and guarded comparison use a pure retention plan that does not call
  `snapshot()`, advance orchestration timeouts, persist state, close sockets,
  or delete artifacts.
- Preserve current explicit-cleanup deletion semantics: prune control runs and
  their associated distributed/fleet state, then persist. Do not expand this
  endpoint to close run sockets or delete artifact-recorder files; that broader
  destructive change needs separate approval.
- Preview exposes connected-agent counts and linked nonterminal distributed
  state, and states explicitly that existing sockets and stored artifact files
  remain after this endpoint deletes in-memory control/distributed/fleet state.
- Invalid or duplicate `dryRun`/`planToken` values and incompatible preview/
  confirm combinations return `400` before mutation.
- Preserve the existing authorization-first route order. Unauthorized preview
  or confirmation requests return the existing authorization failure before
  any query validation, disclose no candidate IDs or token, and never mutate;
  possession of a valid `planToken` is not authorization.
- Retention request/validation implementation remains behind the existing lazy
  Tune/History boundary. The root provider may expose only a bounded generic
  credential-safe transport/config capability and type-only contracts; it must
  not statically import retention feature code. Changing endpoint,
  authorization origin, or connection generation aborts any in-flight
  retention operation, invalidates a successful preview/token/list, and
  disables confirmation.
- The History UI always previews first, displays exact candidates and
  current/projected counts, then requires an accessible `alertdialog` confirm.
  Cancel/Escape sends no destructive request. A drift `409` invalidates the
  token, keeps the old candidate list visible but clearly marked stale, disables
  confirmation, and requires a fresh `dryRun=true` before any new confirmation.
- After successful cleanup, refresh the serialized root query and clear only
  URL run/comparison selections whose pre-cleanup control association was
  actually deleted. Preserve filters and unrelated valid URL state.
- No legacy surface is hidden or cut over in Iteration 8. `runner.runs`,
  `runner.compare`, `legacy.distributed-recipes`, and `legacy.run-manager`
  retain their deep links and rollback responsibilities.

## Task 0: Lock Audit, Contracts, And Tests

Files:

- This plan
- `playground/rallar-black-box-spa-reimplementation-plan.md`
- `apps/rallar-black-box/docs/recipe-console-product-spec.md`
- `apps/rallar-black-box/docs/recipe-console-migration-register.md`

- [x] Audit existing shared filter, legacy History/Compare UI, v1 codec,
  storage rules, authorized Control transport, retention endpoint/service,
  OpenAPI, tests, mount policies, and rollback links.
- [x] Bind History placement, URL additions, row bounds, saved-preset bounds,
  preview response, guarded confirmation, and unchanged destructive semantics.
- [x] Record that the configured server may automatically prune during normal
  persistence, so manual preview can truthfully be empty.
- [x] Close independent plan-review gaps for stable full-consequence
  fingerprints (including fleet and same-timestamp drift), authorization-first
  route parity, and the stale-old-preview `409` contract. The follow-up review
  found no remaining Critical or Important gap.
- [x] Close the final repository/plan-review gaps: distinct
  `historyRecipeId` filter state, process/context-bound short-lived tokens,
  server-internal issued-token consequence truth, synchronous confirm, lazy
  retention client code, root fallback provenance, bounded new owners, and
  sole-survivor selection behavior.
- [x] Capture fresh Iteration 8 baseline after Iteration 7 commits: focused
  units, server check/test, app/shared TypeScript, build/chunks, exact History
  browser baseline, and the configured-live skip or pass.

Fresh Task 0 baseline at `382df72`: 194/194 focused tests across ten files;
control-server check and 57/57 tests; shared-test TypeScript plus all seven Deno
entries; app TypeScript; a 580-module build; reciprocal experience chunks; and
9/9 available History browser tests. The canonical configured-live owner was
discovered beside that History run and skipped, not passed, because: `Set
RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

## Task 1: Add Pure Retention Planning And Optional Server Preview

Files:

- Add `packages/shared-test/rallar-bb-test/control-retention.ts`
- Modify `packages/shared-test/rallar-bb-test/mod.ts` only if the new contract
  is not already exported through an existing bounded barrel
- Modify `apps/rallar-black-box-control-server/src/control-service.ts`
- Add a bounded server retention-token/adapter owner rather than extending the
  2,000+ line service with planning/digest logic
- Modify `apps/rallar-black-box-control-server/src/main.ts`
- Modify `apps/rallar-black-box-control-server/src/routes/swagger-routes.ts`
- Modify `apps/rallar-black-box/docs/current-state.md`
- Modify `apps/rallar-black-box/docs/command-execution.md`
- Modify focused server control-service, API, and Swagger tests
- Add `packages/tests/shared-test/rallar-bb-test-control-retention.test.ts`

- [x] RED-test a pure retention plan for disabled retention, exact cap, ties,
  insertion-order-compatible candidates, associated distributed/fleet IDs,
  and no mutation or time advancement.
- [x] RED-test that `applyRetentionPlan(...)` applies one exact precomputed plan
  while legacy/automatic `pruneRuns(...)` preserves its prior unbounded fast
  path, return order, and deletion behavior beyond preview limits.
- [x] RED-test authorized `?dryRun=true` through the real route: candidates,
  current/projected counts, empty `deletedRunIds`, and byte-for-byte unchanged
  service/persistence/artifact/socket state.
- [x] RED-test no preview query keeps the existing response shape, destructive
  default, ignored arbitrary/malformed body behavior, and unknown-query
  tolerance.
- [x] RED-test plan-token confirmation success and `409` drift for candidate
  identity, cap, connected agents, linked distributed state, and linked fleet
  reports. Include control/distributed/fleet content changes and issued run-
  token changes that retain the same timestamps. Expose only the safe issued-
  token count. Bind tokens to a process nonce and expiry; after any asynchronous
  cryptographic verification, re-plan, byte-compare, and prune synchronously so
  digest computation cannot introduce a mutation race.
- [x] RED-test invalid/duplicate `dryRun` and `planToken`, token with preview,
  overlong token, and all `400`/`409` paths as non-mutating.
- [x] RED-test the real route's authorization-first parity for preview and
  guarded confirmation. Unauthorized requests with valid, invalid, duplicate,
  and overlong query values disclose no candidates/token and never mutate;
  a valid `planToken` never substitutes for the existing admin authorization.
- [x] RED-test that a plan token from another server process, an expired token,
  and a token whose internal issued-run-token state changed return `409`
  without mutation or consequence disclosure beyond the existing stale error.
- [x] Inject clock, process nonce/key, and cryptographic operations into the
  bounded token adapter so expiry, process change, and digest races are
  deterministic without weakening production entropy or signatures.
- [x] Fix the API-test environment helper that currently overwrites a caller's
  `RALLAR_BLACK_BOX_RETENTION_MAX_RUNS` with `0`; capture RED first.
- [x] Update OpenAPI query/response/400/409/413 contracts and test exact schema.
  The `409` schema remains an error response and does not return a fresh preview
  or token; clients must request a new authorized dry run.
- [x] Update `current-state.md` and `command-execution.md`: retain the bare
  destructive cleanup example as legacy behavior and add explicit dry-run plus
  guarded-confirm examples and warnings without implying the preview deletes.

Task 1 is implemented in `07564df`. Shared-test owns two bounded pure owners
for stable consequence planning/canonicalization; the control server owns
bounded query, HMAC token, and cleanup-route adapters. Preview tokens are
short-lived, process/consequence-bound, exact 32-byte HMAC-SHA256 values with
canonical base64url encoding. Confirmation captures, verifies, then performs a
fresh synchronous byte comparison and applies the exact plan with no await
gap. Safe per-run revisions cover same-timestamp hidden/token drift; raw token
values never enter shared input, response, log, or persistence.

The real route proves authorization before query validation, nonempty linked
distributed/fleet consequences, zero preview mutation, exact legacy/guarded
success shapes, wrong-process/tampered/reused-token `409`, ignored malformed
bodies, artifact preservation, and the manual/automatic socket-artifact split.
Preview planning is bounded at 1,000 candidates, 100,000 collection items/
canonical nodes, 64 depth, 1 MiB per string, and 8 MiB incremental canonical
UTF-8; preview returns `413` and confirm returns uniform `409` when bounds are
exceeded. Bare/automatic legacy pruning deliberately bypasses those preview
bounds and remains operable beyond 1,000 candidates.

Fresh Task 1 validation passes 31/31 focused shared tests, the complete
shared-test TypeScript and seven-entry Deno checks, app TypeScript, control-
server check, and 79/79 complete control-server tests with real loopback. New
production owners are 42–282 lines. Independent code/security/contract reviews
closed three demonstrated Important defects (legacy bound leakage,
noncanonical signature aliases, and overlapping OpenAPI success schemas) and
end with no remaining Critical or Important issue.

Task 1 validation:

```sh
cd apps/rallar-black-box-control-server
deno task check
deno task test
cd ../..
npx vitest run packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts
npx vitest run packages/tests/shared-test/rallar-bb-test-control-retention.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
```

## Task 2: Add The Canonical Authorized Retention Client

Files:

- Add `apps/rallar-black-box/src/control-http-error.ts`
- Modify `apps/rallar-black-box/src/control-run-manager.ts` only to import and
  re-export the canonical error class; do not add retention serialization
- Add `apps/rallar-black-box/src/recipe-console/control/control-retention-validation.ts`
- Add `apps/rallar-black-box/src/recipe-console/control/control-retention-request.ts`
- Add `apps/rallar-black-box/src/recipe-console/control/control-retention-api.ts`
- Modify `apps/rallar-black-box/src/recipe-console/control/control-api.ts`
  only for a type-only/generic authorized transport boundary; do not statically
  import the retention implementation
- Modify `apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx`
  only through its bounded service
  contract; do not add feature UI/state
- Add focused retention request/API tests and retain existing control-manager
  tests as compatibility regression only

- [x] RED-test low-level request serialization: preview sends only
  `dryRun=true`; guarded confirm sends only the opaque plan token; legacy
  cleanup keeps the unmodified endpoint URL and body behavior.
- [x] RED-test malformed 2xx payloads, invalid IDs/counts/cap, inconsistent
  preview/deletion fields, 400, 409, abort, and non-JSON responses.
- [x] RED-test existing anonymous/manual/brokered retry policy, credential-origin
  withholding, and no token/query leakage for retention.
- [x] RED-test canonical HTTP-error identity and existing 401/403 authorized
  retry after the error-class extraction. The lazy request imports the tiny
  canonical owner directly; the existing public
  `ControlRunManagerHttpError` export remains identity-compatible.
- [x] Expose a narrow `retention.preview(...)` and
  `retention.confirm(...)` API from the lazy History boundary; do not duplicate
  transport or endpoint authorization logic.
- [x] RED-test that retention request/validation code is dynamically imported
  only after History invokes it and remains absent from inactive Recipe Console
  chunks. An AST/static-import gate forbids value imports or re-exports from
  `control-run-manager.ts`, the root provider, and eager `control-api.ts`.
  Endpoint, credential-origin, or connection-generation changes abort and
  invalidate preview state before a confirmation can be sent.
- [x] Keep types sourced from shared-test and preserve every existing public
  manager/API import path. Do not add retention serialization to or re-export
  it through the eagerly loaded `control-run-manager.ts`.

Task 2 is implemented in `7197beb`. The legacy manager export and the tiny
canonical HTTP-error owner share exact constructor identity. A generic
authorized endpoint owns credential injection and one endpoint challenge, so
the lazy retention feature never receives a raw manual or brokered token and a
brokered preview authorizes confirmation immediately. The provider exposes a
redacted connection context plus an opaque generation/signal, closes replaced
contexts in layout lifecycle without breaking StrictMode replay, and suppresses
abort-resistant stale imports/responses. Validated previews are immutable and
context-branded; confirmation accepts the exact current preview rather than an
arbitrary token, and preview/confirm concurrency is serialized.

Low-level requests preserve the bare legacy form and serialize preview/confirm
as bodyless POSTs with only their documented query. Exact preview/confirmation
validation uses shared candidate/state/limit contracts, rejects unknown or
inconsistent success payloads, applies cumulative collection/node/depth/string/
UTF-8 budgets, and reconciles consequences linearly. Build validation proves
the 9.94 kB (3.39 kB gzip) retention client is a separate dynamic entry whose
request/validator sentinels are absent from main, eager Recipe Console, and
inactive Tune static closures.

Fresh Task 2 validation passes 59/59 retention-client tests, 70/70 existing
manager/control-API tests, 23/23 structure/build-boundary tests, app TypeScript,
the 590-module production build, and the experience-chunk assertion. Independent
security/seam/provider reviews closed the demonstrated Important context race,
raw-bootstrap exposure, post-response TypeError mapping, confirm/preview race,
transient import retry, and quadratic/unbounded validation defects and report no
remaining Critical or Important finding.

## Task 3: Extend Shared History Filtering And V1 URL State

Files:

- Modify `packages/shared-test/rallar-bb-test/distributed-run-monitor.ts`
- Modify `packages/tests/rallar-black-box/distributed-recipes.test.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-codec.ts`
- Modify `apps/rallar-black-box/src/recipe-console/routing/url-state-helpers.ts`
- Modify URL state/history unit and browser tests
- Update the product-spec URL table and local-storage rules

- [x] RED-test additive semantic `failureCategory` matching against repository
  failure classification while preserving raw `failureType` behavior. Match
  actual run/rollup failures, never a synthetic readiness explanation attached
  only because a run is nonterminal.
- [x] RED-test group, recipe, profile, status, text, semantic failure category,
  inclusive created-time bounds, combined filters, empty results, malformed
  manifests, and stable descending order.
- [x] RED-test parse/normalize/serialize for `historyGroup`,
  `historyRecipeId`, `historyProfile`, and `failureCategory` beside valid,
  invalid, duplicate, sensitive, unknown, and legacy-alias fields.
- [x] RED-test one-push Apply/Reset and popstate/copy-link restoration without
  clearing comparison, timing, provider, or harmless unknown state.
- [x] RED-test filter → Candidate selection → cleanup → copied URL/back-forward
  so `historyRecipeId` and other filters survive while operational `recipeId`
  follows the selected run and may be cleared independently.
- [x] Keep committed filters shareable and make explicit URL state override any
  locally saved preset.

Task 3 filter/codec code is implemented in `48b2fd0`. Shared history filtering
preserves every legacy raw filter and stable date/order behavior, adds semantic
category matching through the canonical explanation classifier over actual
run/rollup failures only, and safely treats malformed manifest fields as absent
without reindexing fallback recipe identities. The v1 codec owns four additive
fields, keeps `historyRecipeId` independent from operational `recipeId`, rejects
invalid/duplicate categories canonically, and preserves comparison, timing,
provider, harmless unknown, copy-link, and popstate truth.

Fresh proof is 78/78 focused shared/URL tests, shared-test TypeScript plus all
seven Deno entries, app TypeScript, and diff checks. Independent review found no
Critical or Important implementation defect. The required combined filter →
Candidate → cleanup → copied URL/back-forward sequence remains explicitly open
through Task 5's pre-cleanup association reconciliation, copied-link, and
back/forward proof. Task 4 proves that loaded presets remain inert until an
explicit apply and that saves always capture the latest committed URL state.

## Task 4: Build Bounded Saved-Filter Persistence

Files:

- Add `apps/rallar-black-box/src/recipe-console/history/history-filter-contract.ts`
- Add `apps/rallar-black-box/src/recipe-console/history/history-filter-storage.ts`
- Add `apps/rallar-black-box/src/recipe-console/history/use-history-filter-presets.ts`
- Add `packages/tests/rallar-black-box/recipe-console-history-storage.test.ts`

- [x] RED-test storage-disabled, quota/read/write/remove exceptions as nonfatal.
- [x] RED-test schema version, exact whitelist, caps, deterministic normalized
  names/order, duplicate replacement, and oldest-entry eviction at 12.
- [x] RED-test that Save serializes committed URL filters rather than transient
  draft text.
- [x] RED-test malformed JSON, future version, non-array values, unknown keys,
  invalid enum/range values, oversize names/fields/count, and prototype-shaped
  objects are dropped without losing valid siblings.
- [x] RED-test that credentials, control URLs/tokens, run selection, compare
  IDs, artifacts, active preset, and transient drafts can never serialize.
- [x] Keep the adapter data-in/data-out with an injected storage port; browser
  localStorage access belongs only in `use-history-filter-presets.ts`, never
  `TuneWorkspace`, `HistoryWorkspace`, or a global provider.

Task 4 is implemented in `1e19dfb`. The pure contract and injected storage
adapter persist exactly the eight History filters in one versioned envelope,
with 12/64/512/256 item/name/query/string caps, a 128 KiB serialized-input
guard, a 1,024-entry direct-input guard, strict prototype/accessor/unknown-key
rejection, deterministic newest-first replacement semantics, and future-version
preservation. The hook is the sole browser `localStorage` owner and never
persists selections, comparison, credentials, artifacts, drafts, or active
preset state.

Fresh proof is 22/22 focused tests and app TypeScript. RED tests demonstrated
both React StrictMode replay of a storage write inside a functional updater and
unsafe carry-over when the injected storage port changed; writes now occur once
outside replayable updaters and a replaced port is re-read before interaction.
Explicit URL filters remain authoritative over loaded presets until apply.
Independent re-review reports no remaining Critical or Important issue.

## Task 5: Build Pure History Rows, URL Patches, And Cleanup Reconciliation

Files:

- Add `apps/rallar-black-box/src/recipe-console/history/history-model.ts`
- Add `apps/rallar-black-box/src/recipe-console/history/history-url-patches.ts`
- Add `apps/rallar-black-box/src/recipe-console/history/retention-selection-patch.ts`
- Add `packages/tests/rallar-black-box/recipe-console-history-model.test.ts`

- [x] RED-test exact rows from root distributed/control pairs, pairing status,
  group/recipe/profile/failure labels, created/updated time, control status,
  partial/stale/offline provenance, total/rendered/omitted counts, and 100-row
  bound.
- [x] RED-test unsafe/duplicate/malformed identities are quarantined from
  navigation, selection, filenames, and React keys. Every retention candidate
  remains visibly rendered with a generated key and its exact control ID;
  retention output/token truth is never filtered through URL-identity policy.
- [x] RED-test visible Baseline action patches `compareLeft` only; Candidate
  atomically aligns `compareRight`, `distributedRunId`, and `controlRunId` and
  clears dependent agent/recipe/command fields.
- [x] RED-test cleanup reconciliation against the pre-cleanup association map:
  deleted focus/right/left/control IDs clear only dependent fields; unrelated
  filter/comparison/timing/unknown state remains.
- [x] RED-test cleanup leaving one survivor against existing sole-control-run
  bootstrap. History filters remain stable, deleted selections do not revive,
  and any authoritative sole-survivor selection is explicit in the expected
  post-refresh model rather than mistaken for a previous-run auto-selection.
- [x] Reuse Tune's safe identity and selection patch behavior or extract one
  shared app-local pure helper; never fork its rules.

Task 5 is implemented in `13070af` and `caa3980`. The serialized root query now
retains whether distributed history came from the root snapshot, canonical
fallback, or was unavailable, including across stale refresh failures. The pure
History model uses `filterDistributedRuns(...)` as its sole filter/order
authority, reports exact available/filtered/rendered/omitted counts, projects at
most 100 rows, reuses Tune's safe identity and selection behavior, and preserves
exact retention consequences behind ordinal keys.

Shared-test owns the one malformed-safe group/recipe/profile/actual-failure
label projection. Pre-cleanup association capture and pure reconciliation clear
only deleted focus/comparison/dependent URL fields, preserve filters, timing,
unknown state, and newer valid selections, and keep sole-survivor bootstrap
explicit. The combined filter → Candidate → cleanup → copied URL → back/forward
sequence is green. Refresh-before-replace ordering remains intentionally owned
by Task 7's asynchronous cleanup hook.

Fresh proof is 176/176 related shared, History, URL, Tune, selection, and
distributed-recipe tests, complete shared-test TypeScript plus all seven Deno
entries, app TypeScript, and diff checks. Review exposed one Important issue:
the initial model built Tune performance for every unfiltered run before the
100-row cap. A RED getter fixture reproduced it; global duplicate/control maps
are now linear while identity/manifest work is limited to 100 visible unique
runs and two relevant controls per identity, with performance derivation off.
Independent re-review reports no remaining Critical or Important issue.

## Task 6: Compose Focused History And Saved-Filter UI In Tune

Files:

- Add `HistoryWorkspace.tsx`, `HistoryFilters.tsx`, `HistoryTable.tsx`, and
  `HistorySavedFilters.tsx` under
  `apps/rallar-black-box/src/recipe-console/history/**`
- Add focused co-located CSS Modules
- Modify `TuneWorkspace.tsx` only to compose one bounded History owner
- Add/update structure tests

- [ ] RED-test one History composition, no History feature state in
  `RecipeConsoleWorkspace`, no legacy import, no duplicate compare derivation,
  no global CSS, and no file over 300 lines (`HistoryWorkspace` <= 180;
  `TuneWorkspace` remains <= 180).
- [ ] Render exact source/provenance, active filter summary, Apply/Reset,
  table count/omission, empty/partial/stale/offline/error states, and safe
  legacy Runs handoff.
- [ ] Operate filters, baseline/candidate handoff, save/apply/delete preset,
  copy link, keyboard table/disclosures, and mobile controls through visible
  labeled elements; no hover-only evidence.
- [ ] Keep current Tune evidence first at desktop, portrait, and short
  landscape. History tables own contained overflow and never create document
  X overflow.
- [ ] Do not auto-select a previous run, fetch artifacts, execute Control
  recipes, or mutate recipe manifests.

## Task 7: Add Preview-First Retention UI And Confirmation

Files:

- Add `apps/rallar-black-box/src/recipe-console/history/use-retention-cleanup.ts`
- Add `apps/rallar-black-box/src/recipe-console/history/RetentionPanel.tsx`
- Add `apps/rallar-black-box/src/recipe-console/history/RetentionConfirmDialog.tsx`
- Add focused CSS and model/component tests
- Modify History composition and root refresh callback only through bounded
  props

- [ ] RED-test idle/previewing/preview-ready/confirming/succeeded/drift/error/
  unavailable states, operation generation, stale response suppression, abort,
  remount reset, and exact request counts.
- [ ] RED-test endpoint/base-URL, credential-origin, and connection-generation
  changes both before preview resolution and after preview success. They abort
  work, mark the old consequence list non-current, discard the token, and keep
  Confirm disabled.
- [ ] Preview must show cap, current/projected counts, exact would-delete IDs,
  connected-agent/socket consequences, each linked distributed run's state,
  and the explicit fact that current sockets and artifact files remain.
- [ ] Preview never mutates. Cancel/Escape/outside-dismiss emits no destructive
  request. Confirm is disabled until a current successful preview exists.
- [ ] Alertdialog traps focus, announces destructive scope, supports keyboard
  confirm/cancel, restores focus, prevents double submit, and exposes visible
  busy/error/drift status without motion dependence.
- [ ] Confirm sends the exact opaque preview token. On success, reconcile URL state,
  refresh the root serialized query, and show actual deletions. On `409`, keep
  the prior list visible with an explicit stale marker, discard its token,
  disable Confirm, and require a new preview request before reopening confirmation.
- [ ] Withhold cleanup entirely when endpoint provenance/credentials are unsafe;
  never persist preview IDs or authorization material.

## Task 8: Canonical Browser Acceptance And Operational QA

Files:

- Modify `tests/playwright/rallar-black-box/recipe-console-history.spec.ts`
- Extend deterministic control fixture(s) without live services
- Modify CSS-isolation/responsive/accessibility specs only for real History UI

- [ ] GREEN exact Ready-State test:
  `restores versioned view selection filters comparison and timing metric from a copied URL`.
- [ ] GREEN exact retention test:
  `previews retention impact before confirmed destructive cleanup`.
- [ ] Add visible-control tests for combined filtering, past-failure discovery,
  baseline/candidate selection, compare output, saved preset save/apply/delete,
  cancelled cleanup, drift conflict, auth failure, and post-delete URL cleanup.
- [ ] Assert preview/confirm HTTP bodies and request counts; a preview or
  cancelled dialog must never issue a destructive request.
- [ ] Cover 1440x900, 900x900, 430x932, and 932x430; keyboard-only filters,
  table actions, saved presets, dialog, copy link, back/forward, focus restore,
  reduced motion, 44px coarse targets, announcements, zero document overflow,
  and both legacy/Tune CSS load orders.
- [ ] Prove History/retention code remains absent when Tune never opens and is
  unmounted with Tune when inactive. The chunk assertion includes retention
  request/validation implementation, not only History React components.

## Task 9: Reviews, Fresh Exit, Documentation, And Milestone Commits

- [ ] Dispatch independent reviews for retention/server contract, authorized
  client/state, shared filtering/storage safety, UI/accessibility/browser, and
  strangler/cutover boundaries. Add RED/GREEN proof for every Critical or
  Important finding.
- [ ] Run the exact focused contract below, complete app unit suite, complete
  Recipe Console browser config, exact legacy navigation/ticket pair, and
  control-server tests after the last fix.
- [ ] Try the in-app Browser first; record its exact unavailability reason if
  fallback Playwright/System Chromium is used.
- [ ] Update this plan, parent ledger/decisions/risks, product spec, migration
  register, and fidelity ledger with counts, commits, evidence, skips, and
  unchanged rollback/cutover status.
- [ ] Keep Ready-State #8 comparison evidence satisfied; close #9 only after
  the exact copied-URL filter/comparison test passes. Do not claim #3 from
  mocked/no-environment evidence.
- [ ] Make cohesive local commits after all Iteration 8 gates are green. Do not
  push or open a PR.

## Focused Validation Contract

```sh
cd apps/rallar-black-box-control-server
deno task check
deno task test
cd ../..

npx vitest run \
  packages/tests/shared-test/rallar-bb-test-control-retention.test.ts \
  packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-retention-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-history.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-history-storage.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-model.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-model-hardening.test.ts \
  packages/tests/rallar-black-box/recipe-console-tune-selection.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts

npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace @ar-eye-hunter/shared-test run check:deno
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts

npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-history.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-tune.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts
```

The complete `packages/tests/rallar-black-box` suite, complete Recipe Console
Playwright configuration, and exact legacy tabbed-navigation/agent-ticket pair
remain mandatory at exit. The configured Postgres/live lifecycle is attempted
only when its services are available; otherwise report the exact skip reason
and never count it as passed.
