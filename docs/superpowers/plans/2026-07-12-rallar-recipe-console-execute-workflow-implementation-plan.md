# Rallar Recipe Console Execute Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
> Every behavioral slice follows red-green-refactor and records its focused
> validation before the next slice begins.

**Goal:** Complete Iteration 4 with a guided, truthful distributed Execute
workflow that lets an operator choose a repository recipe, resolve safe
targets, create a run, stage it, wait for ACK readiness, start it, cancel it,
refresh it, and export its bounded artifact without editing JSON.

**Architecture:** Keep `ControlConnectionProvider` as the root owner of the
serialized query and credential-aware control client. Extract its authenticated
transport before adding write operations, then expose a narrow execution API
that delegates to the existing control-run manager. A bounded Execute hook
coordinates URL selection and one in-flight action while pure shared/app
helpers own catalog projection, target safety, manifest construction,
validation, fingerprints, and action policy. Focused React views render those
models; they do not duplicate target or lifecycle rules.

**Tech stack:** React 19, TypeScript, Vite 8, Vitest, Playwright, the existing
control-run manager/control-server REST contract, and deterministic helpers in
`packages/shared-test/rallar-bb-test/**`.

## Binding Iteration 4 Decisions

- The live Execute target plane replaces the seeded target preview. Catalog,
  schema, and preflight evidence remain available offline, but no seeded agent
  is ever rendered or enabled as a live target.
- Selected recipe identity uses the existing v1 `recipeId` URL field and stores
  the canonical recipe's `recipe.recipeId`. `controlRunId` and
  `distributedRunId` retain the Iteration 3 URL semantics. Target checkbox
  selection and profile filter remain bounded view state.
- Unknown explicit recipe/control/distributed IDs remain visible and blocked;
  no collection-index or seed fallback is allowed.
- Build the catalog from shared fixtures. Shared deterministic projection owns
  provider/profile/live/schema/preflight facts and configured group-aware
  recipes. The legacy catalog keeps its existing imports by delegating through
  compatibility wrappers rather than becoming a Recipe Console dependency.
- Target rows derive from the fresh selected control run, selected group, and
  selected recipe command kinds. `partial` may still provide current core-agent
  evidence, but every mutation requires a complete `live` snapshot so the new
  distributed run remains observable. `stale`, `offline`, `connecting`, and
  authorization failures retain last-known evidence but make every mutation
  unsafe.
- Add shared duplicate-session blocking using a documented normalized identity
  key. Missing capability remains evidence-backed: the current contract can
  prove CRDT runtime/transport support, not generic RTC/WS/HTTP capability.
- Use `buildDistributedRunManifest(...)` with one selected recipe,
  `selected-agents`, `all-agents`, manual start, a 15-second ACK timeout, and an
  exact expected participant count. Validate both shared JSON Schema and the
  distributed manifest contract. Raw JSON is read-only and closed by default.
- `Resolve targets` calls the server preview and stores it with a full-manifest
  fingerprint. Recipe, target, group, run, or manifest changes invalidate it.
  Create and Stage each issue a fresh
  `POST /distributed-runs/resolve-targets` immediately before their mutation
  request and refuse to mutate if resolved IDs no longer exactly match the
  selected safe IDs. This is mandatory because selected-agent Stage currently
  trusts manifest IDs rather than re-resolving them.
- The guided lifecycle is strict even though the server is permissive:
  resolve → create `draft` → stage → wait through `waiting-for-ack` / optional
  barrier → Start only at `ready`. HTTP 2xx never implies lifecycle success;
  returned snapshot state/error is authoritative.
- Create never silently reuses a duplicate run ID. Stage never creates. Start
  never records intent while ACK is pending. Cancel is available only for a
  known non-terminal run. Export performs an actual bounded artifact download.
- All mutations are one-at-a-time, abort on Execute unmount/config invalidation,
  retain actionable errors, and refresh root query truth after success and
  failure. Optimistic responses reconcile by `updatedAtEpochMs` with newer
  query snapshots.
- Explicit live-action arming names the exact control origin, run, recipe, and
  selected target count. It is required for Create, Stage, Start, and Cancel
  and resets when that context changes. This is state, not warning decoration.
- Writes reuse Iteration 3 origin/credential policy. Deployment-configured
  origins may use configured or brokered credentials. URL-selected control
  origins receive no ambient credential; only a `controlToken` from that same
  incoming URL may authorize them. Reads and writes keep separate endpoint
  authorization state.
- Do not tighten nested distributed-command destination enforcement in this
  iteration. The server currently validates direct commands more strictly than
  commands nested in `recipe.load`/`recipe.run`; changing that is a potentially
  breaking server policy and remains an explicit risk requiring approval.
- Do not cut over or hide `runner.recipes` or
  `legacy.distributed-recipes`. They still own agent setup, readiness, local
  launch, history, monitor, compare, and authoring. Their rollback URLs, mounts,
  primary visibility, and deep links remain unchanged.

## Task 1: Shared Catalog, Manifest, And Target Truth

**Files:**

- Create `packages/shared-test/rallar-bb-test/distributed-recipe-catalog.ts`
- Create `packages/shared-test/rallar-bb-test/distributed-run-validation.ts`
- Modify `packages/shared-test/rallar-bb-test/mod.ts`
- Modify `packages/shared-test/rallar-bb-test/distributed-run-monitor.ts`
- Modify `apps/rallar-black-box/src/legacy/runner/distributed-recipes/distributed-recipe-catalog.ts`
- Test `packages/tests/rallar-black-box/distributed-recipes.test.ts`
- Test `packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts`
- Test `packages/tests/shared-test/rallar-bb-test-schema.test.ts`

- [ ] RED-test canonical shared catalog projection, configured group-aware
  recipes, search/profile facts, recipe compatibility badges, and preflight
  service requirements. Schema badges must use
  `validateRallarBlackBoxRecipeCompatibility(...)`; include a recipe that is
  preflight-clean but fails shared JSON Schema.
- [ ] RED-test duplicate fresh identities becoming non-targetable while stale,
  offline, wrong-group, missing-identity, and CRDT capability behavior remains
  exact. Derive only explicitly requested CRDT transports; a CRDT command kind
  must not require every transport implementation.
- [ ] Add a narrow combined manifest validation result beside shared manifest
  contracts; do not import the legacy wrapper from Recipe Console.
- [ ] Make legacy catalog exports delegate to the shared deterministic owner
  without changing their import paths or current values.
- [ ] Run the three focused tests, shared-test TypeScript check, and app
  typecheck.
- [ ] Commit `feat: share recipe execution catalog and target truth`.

## Task 2: Credential-Aware Execution API

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/control/control-authorized-transport.ts`
- Create `apps/rallar-black-box/src/recipe-console/control/control-execution-api.ts`
- Create `apps/rallar-black-box/src/recipe-console/control/control-execution-validation.ts`
- Modify `apps/rallar-black-box/src/recipe-console/control/control-api.ts`
- Modify `apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx`
- Test `packages/tests/rallar-black-box/recipe-console-control-api.test.ts`
- Test `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

- [ ] Keep the complete Iteration 3 API suite green while extracting the token
  cache, challenge state, broker retry, origin trust, response/protocol, and
  abort behavior from the 482-line adapter.
- [ ] RED-test Resolve/Create/Stage/Start/Cancel/Export delegation through the
  canonical control-run manager, including exact methods, paths, bodies,
  response states, and abort signals.
- [ ] RED-test separate read/write authorization challenges, broker-token reuse
  and refresh, manual precedence, URL-origin credential withholding, broker
  provenance, malformed successful responses, and artifact validation.
- [ ] Validate schema-v2 artifact envelopes with the three required base files,
  accept absent optional enriched files, and reject every malformed file that
  is present.
- [ ] Expose only the narrow execution operations through the root connection;
  no token, raw fetch, or control-run-manager ownership enters Execute React
  code.
- [ ] Run API/structure tests and app typecheck.
- [ ] Commit `feat: add recipe console execution control API`.

## Task 3: Pure Execute Workflow State And URL Selection

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/execute/execute-workflow-state.ts`
- Create `apps/rallar-black-box/src/recipe-console/execute/execute-manifest.ts`
- Create `apps/rallar-black-box/src/recipe-console/execute/execute-action-policy.ts`
- Test `packages/tests/rallar-black-box/recipe-console-execute-workflow.test.ts`
- Modify/test `packages/tests/rallar-black-box/recipe-console-url-state.test.ts`

- [ ] RED-test URL recipe selection/restoration, invalid explicit IDs, default
  selection without index fallback, profile/search projection, and dependent
  distributed-run clearing.
- [ ] RED-test deterministic run ID generation, manifest construction, combined
  validation, raw JSON, fingerprints, exact-resolution comparison, and
  invalidation on every input field.
- [ ] RED-test every action availability/reason across connecting, live,
  partial, stale, offline, auth-required, invalid schema, zero/unsafe targets,
  draft, waiting ACK, waiting barrier, ready, running, terminal, and busy state.
- [ ] RED-test response reconciliation and 2xx terminal-failed truth.
- [ ] Run workflow/URL/shared distributed tests and app typecheck.
- [ ] Commit `feat: derive guided recipe execution state`.

## Task 4: Bounded Execute Controller And Views

**Files:**

- Create `apps/rallar-black-box/src/recipe-console/execute/use-execute-workflow.ts`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteCatalog.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteTargets.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecutePreflight.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteManifestDisclosure.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteRunStatus.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteActionBand.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteCancelDialog.tsx`
- Create `apps/rallar-black-box/src/recipe-console/execute/ExecuteRecipeInspector.tsx`
- Create focused CSS modules under `src/recipe-console/execute/**`
- Modify `apps/rallar-black-box/src/recipe-console/execute/ExecuteWorkspace.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx`
- Modify `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Remove the replaced `ExecutePreview`, preview hook/export/CSS, Execute seeded
  model, and unused generic control-overview React modules only after the new
  workflow and structure gates are green.
- Test `packages/tests/rallar-black-box/recipe-console-structure.test.ts`
- Create `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts`

- [ ] Add structure/browser RED assertions before React implementation: no
  seeded agents or Preview actions, no legacy imports, no raw control ownership,
  thin workspace/controller composition, TSX below 300 lines, scoped CSS.
- [ ] Render searchable/profile-filtered catalog rows with provider,
  live-service, schema, and preflight badges.
- [ ] Render one recipe-aware target plane with every blocker reason, selection
  controls only for current-safe rows, and explicit last-known/unavailable
  states. Avoid a second generic agent board above it.
- [ ] Render preflight tree/service requirements, read-only raw manifest
  disclosure, authoritative run identity/state/error, and the state-specific
  action band with associated disabled reasons.
- [ ] Keep inspector selection, portrait dock, focus restoration, URL history,
  keyboard selection, accessible Cancel confirmation, and reduced-motion
  semantics coherent. Refresh authoritative Execute data without key-remounting
  or discarding an uncreated draft; preserve the existing reset behavior for
  other seeded views.
- [ ] Run structure/workflow tests, focused browser RED/GREEN, typecheck, and
  build.
- [ ] Commit `feat: replace execute preview with guided workflow`.

## Task 5: Lifecycle Orchestration, Cancel, And Export

**Files:**

- Modify `apps/rallar-black-box/src/recipe-console/execute/use-execute-workflow.ts`
- Create `apps/rallar-black-box/src/recipe-console/execute/execute-artifact-export.ts`
- Extend `tests/playwright/rallar-black-box/recipe-console-execute.spec.ts`

- [ ] RED-test visible Resolve → Create → Stage → wait-ready → Start against a
  mocked simulated `Composite Evidence` distributed ACK lifecycle. Assert
  brokered write auth, manifest content, URLs, no JSON editing, run identity,
  progress, and terminal response truth.
- [ ] RED-test duplicate submission suppression, mutation abort/cleanup,
  revalidation drift, structured HTTP/protocol/trust errors, refresh after both
  success and failure, and draft preservation across global Refresh. Include a
  changed server resolution after the explicit Resolve and prove no Stage
  request is sent.
- [ ] RED-test Cancel for a non-terminal run and an actual downloaded artifact
  bundle with deterministic filename/content; keep terminal Cancel disabled.
- [ ] Add the env-gated configured lifecycle test and preserve the exact
  unavailable-service skip reason.
- [ ] Keep these canonical acceptance names exact:
  `runs a simulated distributed ACK recipe through visible controls`;
  `diagnoses non-targetable agents before staging`;
  `restores an existing Execute run from a copied v1 URL`; and
  `completes the configured live distributed run lifecycle and exports its artifact`.
- [ ] Run focused tests/browser spec, typecheck/build, chunk assertion, and
  control-server check/test.
- [ ] Commit `test: prove guided recipe execution lifecycle`.

## Task 6: Browser QA, Review, Cutover Evidence, And Exit

- [ ] Update the Execute concept fixture/baseline to a mocked live two-agent
  state while retaining the approved Signal Ledger hierarchy. Update the
  fidelity ledger with the repository-truth change; no new visual direction is
  introduced.
- [ ] Prove 1440×900 desktop, 900×900 tablet, 430×932 portrait, 932×430
  landscape, keyboard-only operation, 44px touch targets, focus trap/restore,
  reduced motion, contained scrolling, status announcements, and CSS isolation
  in both load orders.
- [ ] Prove ready, blocked, waiting ACK/barrier, running, cancelled, passed,
  terminal-failed, mutation error, stale, offline, partial, authorization, and
  credential-trust states.
- [ ] Run exact focused tests, complete app tests, complete Recipe Console
  Playwright config, exact legacy navigation/ticket pair, typecheck/build/chunk
  proof, shared-test checks, and control-server check/test.
- [ ] Dispatch independent code/contract and browser/cutover reviews; cover
  every Critical/Important finding with RED/GREEN proof and rerun fresh exit
  validation after the last fix.
- [ ] Update the parent plan, this implementation plan, fidelity ledger, and
  migration register with actual commits, evidence, skipped live proof, and
  remaining risks. Keep both legacy workflow rows uncut and visible.
- [ ] Commit `docs: record guided recipe execution exit` only after the
  Iteration 4 exit criterion passes.

## Exact Focused Validation

```bash
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-distributed-run.test.ts \
  packages/tests/shared-test/rallar-bb-test-schema.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/schema-authoring.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-api.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-query.test.ts \
  packages/tests/rallar-black-box/recipe-console-control-selection.test.ts \
  packages/tests/rallar-black-box/recipe-console-execute-workflow.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-history.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts

npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts

cd apps/rallar-black-box-control-server
deno task check
deno task test
```

Focused browser acceptance:

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-execute.spec.ts
```

Final broader validation:

```bash
npx vitest run packages/tests/rallar-black-box
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts
npx playwright test --config apps/rallar-black-box/playwright.config.ts \
  tests/playwright/rallar-black-box/tabbed-navigation.spec.ts \
  tests/playwright/rallar-black-box/agent-session-ticket-ui.spec.ts
```

The configured Postgres-backed lifecycle is not implied by mocked UI, Deno,
or local read proof. If unavailable, record it as skipped, never passed, with
exactly:

`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

## Iteration 4 Exit Gate

Iteration 4 is complete only when an operator can select a shared recipe,
resolve current safe targets, explicitly arm the destination, create and stage
the run, wait for authoritative ACK readiness, and start it through visible
controls without JSON editing. Cancel, Refresh, Export, raw-manifest disclosure,
all documented blocker states, URL restoration, responsive/accessibility/CSS
proof, fresh validation, and independent review must also pass. This does not
cut over or hide a legacy surface, and Ready-State #3 remains open for the
Iteration 5 monitor workflow plus configured live/Postgres proof.
