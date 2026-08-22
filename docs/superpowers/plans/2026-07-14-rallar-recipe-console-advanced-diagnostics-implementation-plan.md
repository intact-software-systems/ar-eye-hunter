# Rallar Recipe Console Advanced Diagnostics Implementation Plan

Status: complete; Iteration 11 qualified through `78e2c13`; Tasks 0–8 complete
Evidence date: 2026-07-14
Branch: `codex/rallar-black-box-spa-reimplementation`
Worktree: `tmp/worktrees/rallar-black-box-spa`

**Goal:** Make Recipe Console Advanced the complete, contextual bridge to every
preserved direct diagnostic and advanced legacy workflow while keeping the core
SPA lean. Failure evidence must open the relevant legacy tool with safe
run/group/command context and return to the same selected Recipe Console run.
Old aliases and the complete legacy experience remain operational.

**Architecture:** Add one small React-free diagnostic classifier under
`packages/shared-test/rallar-bb-test/**`. Keep a data-only Advanced catalog,
pure outbound/return URL builders, and bounded UI leaves under
`src/recipe-console/advanced/**`. Add a versioned, bounded context parser and
visible return bar under `src/legacy/diagnostics/context/**`; pass its values
through existing legacy owners. Preserve the mutually exclusive lazy
`RecipeConsoleApp`/`LegacyExperience` boundary. Dynamically import only
legacy surfaces that are safe to unmount, and retain the documented stateful
exceptions only inside active `LegacyExperience`.

## Repository-Authoritative Corrections

- `AdvancedPreview.tsx` is a 36-line placeholder with nine hard-coded links.
  It forces `provider=simulated`, drops run/group/agent/command context, omits
  Quick Test, RTC/Realtimes, Topology, Event Stream, and every Advanced Legacy
  workflow, and provides no safe return path.
- Recipe Console primary navigation is already exactly Execute, Monitor,
  Analyze, Tune, Fleet, and Advanced. Direct Rallar tabs exist only inside
  `LegacyExperience`; Iteration 11 must not hide or rewrite that rollback
  navigation.
- `App.tsx` already lazy-loads mutually exclusive Recipe Console and legacy
  experience closures. Cold Recipe Console therefore cannot mount legacy
  effects today; extend this proof instead of introducing another router.
- The proposed `LegacySurfaceRouter`, per-surface route wrappers, and registry
  do not exist. Do not create them. A feature-local data catalog may describe
  links, but it must not import React surfaces or become runtime ownership.
- `app-tabs.ts` already canonicalizes `manual-rallar`,
  `local-workbench`, `run-manager`, `distributed-recipes`, and
  `shared-test` into Advanced children, and `flow-builder` into Builder.
  The old aliases remain authoritative.
- `RunnerCompatibilityTabPanels`,
  `LegacyCompatibilityTailTabPanels`, and the direct Manual Rallar pane are
  unreachable duplicates after that normalization. They are not valid state
  owners. Remove them only after alias and user-visible behavior tests are RED
  then GREEN against the actual Advanced/Builder owner.
- `RunnerAdvancedPanel` remains mounted while its tab is hidden. Workbench and
  Manual are documented exceptions; Distributed Recipes, Run Manager, and
  Shared Test incorrectly remain mounted after first selection. Add an
  explicit `active` boundary before making those three dynamic.
- Recipes, Runs, Fleet, and Builder are already active-only but statically
  imported. Runs polls only while active. Distributed Recipes and Run Manager
  perform initial refresh work. Groups/Clients, Topology, and RTC Diagnostics
  are safe to unmount after their focused cleanup/ownership proof.
- `legacy-shell-composition.test.ts` deliberately locks the old six-group,
  24-section, no-lazy composition. Iteration 11 must update that stale contract,
  not evade it. Keep component implementation fingerprints unrelated to
  lifetime/import ownership.
- `assert-experience-chunks.ts` currently expects several safe surfaces in
  the legacy static closure. Update it to prove dynamic reachability and static
  absence while continuing to prove all production entries exist.
- Monitor's existing evidence destinations are internal inspector targets.
  External diagnostic classification is a separate shared deterministic
  helper; do not widen or overload the internal destination union.
- No legacy direct surface consumes Recipe Console bridge context today.
  Groups/WebSocket/RTC/Server can use existing global values; runner command,
  Run Manager, and Distributed Recipes need narrow initial-selection inputs.

## Binding Guardrails

- Keep `DEFAULT_APP_EXPERIENCE = 'legacy'`. Iteration 12 alone owns the final
  default flip. Iteration 11 hides no legacy row and declares no surface
  retired.
- Preserve every public export, import path, old alias, rollback URL, control
  endpoint, request/response shape, and destructive-operation behavior.
- Do not add a poller, credential owner, control client, global registry,
  global stylesheet, legacy component import in Recipe Console, or hidden CSS
  mount for a safe surface.
- Keep `App.tsx`, `RecipeConsoleWorkspace`,
  `RecipeConsoleActiveWork`, `AdvancedWorkspace`,
  `RunnerAdvancedPanel`, and `LegacyAppShell` as bounded composition glue.
  Split URL, classification, context, and visual ownership into focused files.
- Preserve only allow-listed `simulated` or `browser-rallar` provider
  values. Never serialize credentials, `controlUrl`, response bodies, or an
  arbitrary `returnTo` URL.
- Use versioned marker `diagnosticContext=1`; bounded context keys
  `contextApplicationId`, `contextWorkspaceId`, and `contextGroupId`;
  existing safe IDs `controlRunId`, `distributedRunId`, `agentId`,
  `recipeId`, `commandId`, and `transport`; and the source Recipe Console
  `view`. Reject values over 4,096 UTF-8 bytes.
- Explicit bridge context wins legacy defaults for that visit without
  persisting secrets. `agentId` is displayed but never reinterpreted as a
  legacy client/principal ID.
- Unknown failures receive no invented diagnostic recommendation. Match exact
  codes and bounded phrases, not generic words such as “route” or “server”.

## Iteration 11 Lifetime Register

The following exceptions may remain hidden-mounted only while
`LegacyExperience` itself is active. Cold Recipe Console loads and mounts none
of them.

| Surface                 | Retained view-owned reason                                  | Iteration 11 policy                            |
| ----------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| Quick Test              | editable values, subscription, messages, wait state         | preserve                                       |
| Auth diagnostic         | drafts, ticket, action history                              | preserve; never persist credentials            |
| WebSocket               | socket/subscription and forms                               | preserve                                       |
| RTC/Realtimes           | RTC subscription and received evidence                      | preserve                                       |
| Rallar Data             | open store and change listener                              | preserve                                       |
| CRDT                    | active document/subscription and editor/admin state         | preserve                                       |
| Media                   | active tracks and remote subscription                       | preserve                                       |
| Local Workbench         | drafts and active local execution                           | preserve actual Advanced owner                 |
| Manual Rallar           | payload drafts and active runtime work                      | preserve actual Advanced owner                 |
| Rallar Trace full panel | filters and event limit                                     | preserve; service-owned trace bar stays shared |
| Event Stream            | filters, selection, runtime subscription                    | preserve                                       |
| Rallar Server           | redacted drafts, invalid JSON, feedback/results, busy/error | preserve                                       |

Safe dynamic/unmounted targets are Recipes, Runs, Fleet, Builder, Distributed
Recipes, Run Manager, Shared Test, Groups/Clients, Topology, and RTC
Diagnostics. Flow Builder draft behavior must be characterized before deleting
its unreachable duplicate; if an actual visible persistence contract exists,
extract or retain its real owner rather than claiming the duplicate preserved
it.

## Task 0: Freeze Baseline, Ownership, And Exit Contract

Files:

- Read the parent plan, product spec, migration register, fidelity ledger,
  `app-tabs.ts`, both experience roots, shell composition, effect owners,
  chunk assertion, and Advanced/Monitor code.
- Update only this child plan with actual Task 0 evidence during execution.

- [x] Confirm the repository-authoritative corrections and lifetime register
      before changing code.
- [x] Record exact old alias-to-owner mappings and current production chunk
      closures.
- [x] GREEN the focused unit, type, build, chunk, Recipe Console, and legacy
      navigation baselines. Record unavailable browser/live evidence exactly.
- [x] Do not make a baseline commit unless evidence itself changes this plan.

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/app-tabs.test.ts \
  packages/tests/rallar-black-box/rallar-mode-boundary.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts \
  packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
  packages/tests/rallar-black-box/legacy-shell-structure.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts \
  packages/tests/rallar-black-box/experience-route.test.ts
npm --workspace rallar-black-box run typecheck
npm run build:rallar-black-box
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
```

### Task 0 baseline — `b8751e4`

The repository corrections and lifetime register above are binding. The exact
seven-file structure/route baseline passes 106/106; the wider context baseline
passes 217/217. App TypeScript, the unchanged 758-module production build, and
reciprocal Recipe Console/LegacyExperience chunk assertion pass. The immediately
preceding complete Recipe Console configuration passes 179 available cases with
one exact configured-live skip, and preserved legacy Fleet/navigation passes
33/33. The in-app Browser remains unavailable exactly as `Browser runtime
unavailable after setup failure: Cannot redefine property: process`; terminal
Playwright is the browser fallback. Configured live/Postgres remains skipped,
not passed, for the exact prerequisite statement recorded under Task 8. No
runtime behavior, default, alias, legacy visibility, or mount policy changed in
Task 0.

## Task 1: Add Deterministic Shared Diagnostic Classification

Files:

- Create `packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts`
- Modify `packages/shared-test/rallar-bb-test/mod.ts`
- Modify `apps/rallar-black-box/src/distributed-recipes.ts`
- Create
  `packages/tests/shared-test/rallar-bb-test-advanced-diagnostic-handoff.test.ts`

- [x] RED auth/ticket/unauthorized/forbidden/`BAD_AUTH` to ordered Auth then
      WebSocket targets.
- [x] RED `RALLAR_BB_RTC_NO_PEERS`, `RTC_NO_ROUTE`, and correlated
      `no_peer`/`no_route` diagnostics to RTC Diagnostics.
- [x] RED missing group/member to Groups/Clients and explicit
      `HTTP_SERVICE_UNAVAILABLE`/server-status failures to Rallar Server.
- [x] RED correlation isolation, stable deduplication, shuffled-input
      determinism, non-mutation, false-positive phrases, and unknown failures.
- [x] GREEN a React-free additive public API imported through `mod.ts` and
      the existing app compatibility barrel.
- [x] Commit `feat: classify advanced diagnostic handoffs` after all gates
      are green.

Validation:

```bash
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-advanced-diagnostic-handoff.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace @ar-eye-hunter/shared-test run check:deno
deno check --node-modules-dir=none \
  packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts \
  packages/shared-test/rallar-bb-test/mod.ts
```

### Task 1 milestone — `5ed54fc`

Task 1 adds one bounded, React-free, correlation-safe classifier with a stable
Auth → WebSocket → RTC Diagnostics → Groups/Clients → Rallar Server order.
Malformed, over-limit, uncorrelated, generic-word, and frozen non-mutation
cases pass. The shared and existing app compatibility barrels remain additive.
The final focused gate passes 62/62 with shared/app TypeScript, direct and full
shared Deno, and diff-check proof.

## Task 2: Define The Advanced Catalog And Safe Bridge URLs

Files:

- Create
  `apps/rallar-black-box/src/recipe-console/advanced/advanced-surface-catalog.ts`
- Create
  `apps/rallar-black-box/src/recipe-console/advanced/advanced-legacy-href.ts`
- Create
  `packages/tests/rallar-black-box/recipe-console-advanced-routing.test.ts`
- Modify `packages/tests/rallar-black-box/app-tabs.test.ts`
- Modify `packages/tests/rallar-black-box/experience-route.test.ts`

- [x] RED a complete data-only catalog for all 13 direct surfaces and the six
      Advanced Legacy workflows: Manual, Local Workbench, Run Manager,
      Distributed Recipes, Flow Builder, and Shared Test.
- [x] RED every canonical route and every existing alias, including
      `advancedSurface`/`advanced`, `flow-builder`, and runner launch routes.
- [x] RED provider allow-listing, secret/non-shareable scrubbing, 4,096-byte
      bounds, URL encoding, long/bidi IDs, and preservation of safe context.
- [x] RED a structural return builder that restores the exact Recipe Console
      view/run selection, removes legacy aliases/bridge fields, and cannot become
      an open redirect.
- [x] GREEN pure catalog/URL modules with no React, legacy imports, history
      mutation, runtime registry, or new URL authority.
- [x] Commit `feat: define advanced legacy routing contracts`.

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/recipe-console-advanced-routing.test.ts \
  packages/tests/rallar-black-box/app-tabs.test.ts \
  packages/tests/rallar-black-box/experience-route.test.ts \
  packages/tests/rallar-black-box/recipe-console-url-state.test.ts
```

Task 2 defines exactly 22 actionable leaves: 13 direct diagnostics, four
preserved runner fallbacks, and five selected Advanced children (with Flow
Builder owned by the real Builder route). Structural outbound links emit only
the versioned bridge and bounded allow-listed context; structural returns drop
bridge/group/legacy/secret fields and restore only owned Recipe Console state.
The reviewed Task 4A parser/context bar contract is included as routing
groundwork and cross-checked for identical return policy; shell and consumer
integration remains open under Task 4. The focused routing/context gate passes
19/19, the wider route contract passes 61/61, app TypeScript passes, and diff
check is clean.

## Task 3: Build Advanced And Contextual Monitor Handoffs

Files:

- Create `src/recipe-console/advanced/advanced-workspace-contract.ts`
- Create `src/recipe-console/advanced/AdvancedWorkspace.tsx`
- Create `src/recipe-console/advanced/AdvancedWorkspace.module.css`
- Remove `src/recipe-console/advanced/AdvancedPreview.tsx`
- Create `src/recipe-console/monitor/MonitorDiagnosticHandoffs.tsx`
- Create `src/recipe-console/monitor/MonitorDiagnosticHandoffs.module.css`
- Modify `RecipeConsoleActiveWork.tsx`, `RecipeConsoleWorkspace.tsx`,
  `MonitorInspector.tsx`, and `MonitorWorkspace.tsx`
- Create `recipe-console-advanced-ui.test.ts` and
  `recipe-console-monitor-diagnostic-handoff.test.ts`

- [x] RED lazy Advanced loading, complete categorized links, preserved provider
      and selection context, visible empty/invalid context, and no forced
      simulation.
- [x] RED selected-failure mappings, exact group/run/agent/recipe/command/
      transport handoff, correlated-diagnostic filtering, stable link order,
      unknown omission, and return to selected Monitor run.
- [x] GREEN bounded feature-local leaves. Advanced consumes existing URL and
      root selection only; Monitor adds no fetch, timer, credential owner, or
      duplicate derivation.
- [x] GREEN structure tests proving Recipe Console imports no legacy React/CSS
      and `RecipeConsoleActiveWork` remains composition glue.
- [x] Commit `feat: build contextual advanced diagnostics` (`75ab910`).

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/recipe-console-advanced-ui.test.ts \
  packages/tests/rallar-black-box/recipe-console-monitor-diagnostic-handoff.test.ts \
  packages/tests/rallar-black-box/recipe-console-monitor-inspector-window.test.ts \
  packages/tests/rallar-black-box/recipe-console-structure.test.ts
npm --workspace rallar-black-box run typecheck
```

## Task 4: Consume Legacy Context And Restore Recipe Console

Files:

- Create `src/legacy/diagnostics/context/legacy-diagnostic-context.ts`
- Create `src/legacy/diagnostics/context/LegacyDiagnosticContextBar.tsx`
- Create `src/legacy/diagnostics/context/LegacyDiagnosticContextBar.module.css`
- Modify `LegacyExperience.tsx`, `LegacyAppShell.tsx`,
  `legacy-shell-contracts.ts`, `global-context-model.ts`,
  `use-command-center-global-context.ts`, and
  `use-runner-shell-state.ts`
- Modify `RunManagerPanel.tsx`, `DistributedRecipesPanel.tsx`,
  `use-distributed-recipes-remote-state.ts`, and
  `use-distributed-recipe-builder.ts`
- Create `packages/tests/rallar-black-box/legacy-diagnostic-context.test.ts`

- [x] RED marker/version validation, bounds, secret rejection, context-change
      reconciliation, visible exact IDs, safe return, and unsupported context.
- [x] RED explicit application/workspace/group prefill without secret
      persistence; command selection when present; no agent-to-client coercion.
- [x] RED Run Manager initial control-run selection and Distributed Recipes
      exact control/distributed pair selection after first refresh, including
      missing/stale IDs.
- [x] GREEN narrow optional props and existing owners; no control contract or
      destructive behavior changes.
- [x] Commit `feat: consume legacy diagnostic context` (`7d3c05f`), followed
      by the reviewed selection-authority correction `2c53652`.

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/legacy-diagnostic-context.test.ts \
  packages/tests/rallar-black-box/legacy-shell-models.test.ts \
  packages/tests/rallar-black-box/legacy-run-url-selection.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts
npm --workspace rallar-black-box run typecheck
```

## Task 5: Prove Aliases And Remove Unreachable Duplicate Owners

- [x] RED an exhaustive alias matrix asserting canonical mode, visible tab,
      Advanced child, exactly one real DOM owner, and unchanged rollback URL.
- [x] RED runner-agent launch fragment consumption/scrubbing and Flow Builder
      edited-draft behavior against the actual owner.
- [x] Remove `RunnerCompatibilityTabPanels.tsx`,
      `LegacyCompatibilityTailTabPanels.tsx`, and the duplicate direct Manual
      pane only after their unreachable status is proven.
- [x] Update only intentional composition/lifetime assertions in
      `legacy-shell-composition.test.ts`, `legacy-shell-structure.test.ts`, and
      `app-structure.test.ts`; retain implementation fingerprints.
- [x] Commit `refactor: remove unreachable legacy compatibility mounts`
      (`318502d`).

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/app-tabs.test.ts \
  packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
  packages/tests/rallar-black-box/legacy-shell-structure.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts \
  packages/tests/rallar-black-box/runner-agent-launch.test.ts \
  packages/tests/rallar-black-box/flow-builder.test.ts
```

## Task 6: Dynamically Import Safe Surfaces And Prove Effect Ownership

Files:

- Modify `RunnerWorkspaceTabPanels.tsx`,
  `RunnerAdvancedPanel.tsx`, and `DirectConnectionTabPanels.tsx`
- Modify `apps/rallar-black-box/scripts/assert-experience-chunks.ts`
- Create `packages/tests/rallar-black-box/legacy-mount-policy.test.ts`

- [x] RED dynamic imports and active-only mounts for every safe target in the
      lifetime register, with local Suspense fallbacks and no runtime registry.
- [x] RED that leaving Advanced unmounts Distributed Recipes, Run Manager, and
      Shared Test; leaving direct tabs disposes Topology and stops all safe
      view-owned refresh/effect work.
- [x] RED that every documented exception remains mounted only inside active
      `LegacyExperience`, and that cold Recipe Console mounts none.
- [x] RED production manifest closure: safe surfaces absent from legacy static
      closure, present as reachable dynamic entries, all legacy code absent from
      Recipe Console static closure, and stateful exceptions absent from cold
      Recipe Console.
- [x] GREEN the exact app-structure proof named
      `legacy routes resolve through dynamic imports only`.
- [x] Commit `perf: lazy-load safe legacy surfaces` (`84493f3`).

Validation:

```bash
npx vitest run \
  packages/tests/rallar-black-box/legacy-mount-policy.test.ts \
  packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
  packages/tests/rallar-black-box/app-structure.test.ts
npm --workspace rallar-black-box run typecheck
npm run build:rallar-black-box
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
```

## Task 7: Prove Browser Cutover, Responsiveness, And Isolation

Files:

- Create `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts`
- Modify only focused shell, chunk, responsive/accessibility, CSS-isolation,
  Monitor, and legacy navigation specs where intentional contracts changed.

- [x] RED then GREEN the exact Ready-State titles:
      `keeps direct Rallar diagnostics out of primary navigation and opens them from Advanced`;
      `opens every registered legacy surface from its alias and contextual route`;
      `default Recipe Console does not load or poll inactive legacy routes except registered stateful exceptions`.
- [x] Prove auth+WS, RTC, Groups/Clients, and Server failure handoffs, actual
      context consumption, and exact return to the selected Monitor run.
- [x] Prove every alias, target-only lazy chunk, safe unmount/effect stop,
      stateful-exception round trip, no duplicate DOM owner, and no legacy request
      on cold Recipe Console.
- [x] QA 1440×900 desktop, 900×900 tablet, genuine-touch 430×932 portrait,
      genuine-touch 932×430 landscape, keyboard-only use, 44px targets, reduced
      motion, focus return, long/bidi IDs, zero document overflow, and non-hover
      evidence.
- [x] QA loading, empty, partial, stale, offline, permission, schema-error,
      unavailable-context, and missing-run states plus both Recipe Console/legacy
      CSS load orders.
- [x] Capture and deliberately review deterministic Direction A screenshots;
      update only approved baselines.
- [x] Commit the browser cutover proof as `2502f50`
      (`test: prove advanced diagnostics browser cutover`).

Validation:

```bash
npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts \
  tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-monitor.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-shell.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts

npx playwright test \
  --config apps/rallar-black-box/playwright.config.ts \
  tests/playwright/rallar-black-box/tabbed-navigation.spec.ts \
  tests/playwright/rallar-black-box/exhaustive-shell-navigation.spec.ts \
  tests/playwright/rallar-black-box/recipe-console-legacy-monitor-handoff.spec.ts
```

## Task 8: Independent Reviews And Fresh Iteration Exit

- [x] Dispatch independent reviews for shared classification/public contracts,
      URL/context/security semantics, React ownership/accessibility, and
      strangler/lifetime/chunk/browser proof. RED/GREEN every Critical or Important
      finding with its focused owner.
- [x] Run every focused command above, complete
      `packages/tests/rallar-black-box`, shared/app type and Deno checks, app
      build/chunk assertion, complete Recipe Console Playwright config, and the
      preserved legacy navigation suite.
- [x] Try the in-app Browser first; if unavailable, record the exact reason and
      use terminal Playwright without representing the Browser as passed.
- [x] Run configured live/Postgres proof only when the documented stack exists;
      otherwise record the exact skip reason below, never a pass.
- [x] Update this child plan, the parent iteration ledger, migration register,
      product spec, and fidelity ledger with actual commits, cutover evidence,
      screenshots, test counts, skips, stateful exceptions, and remaining
      Iteration 12 risks.
- [x] Make a cohesive final documentation milestone commit. Do not push or
      open a pull request.

Final qualification:

```bash
npx vitest run packages/tests/rallar-black-box
npm --workspace @ar-eye-hunter/shared-test run check:ts
npm --workspace @ar-eye-hunter/shared-test run check:deno
npm --workspace rallar-black-box run typecheck
npm run build:rallar-black-box
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
npx playwright test \
  --config apps/rallar-black-box/playwright.recipe-console.config.ts
```

Configured-live exact skip when unavailable:

`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1,
apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

### Task 8 qualification evidence — 2026-07-14

- Commits `5ed54fc`, `21446e9`, `75ab910`, `7d3c05f`, `2c53652`,
  `318502d`, `84493f3`, `2502f50`, and `78e2c13` implement and prove the
  bridge. No public export, control-server endpoint, request/response shape,
  destructive behavior, rollback URL, or default changed.
- The complete app suite passes 1,564/1,564 tests across 148 files. An initial
  sandbox run hit two denied local IPC/loopback operations and a permissioned
  run under concurrent browser load hit two five-second timeouts; isolated
  owners and the final uncontended full rerun passed. Shared-test TypeScript,
  all seven shared Deno entries, the direct two-entry Deno check, and app
  TypeScript pass.
- The explicit production build passes with 776 modules. The reciprocal
  experience assertion names separate `RecipeConsoleApp` and
  `LegacyExperience` entries and proves all ten safe legacy targets are
  reachable only through dynamic chunks.
- The canonical Task 7 Recipe Console gate passes 63/63. The complete Recipe
  Console configuration passes 190, skips one configured-live case, and fails
  none. The preserved legacy gate passes 30 and skips the two exhaustive
  configured-stack cases. The exact skip prerequisite is the statement above;
  none of those three cases is represented as passed.
- Direction A has four new Advanced baselines plus the intentionally refreshed
  Tune short-landscape baseline. Native-resolution inspection, exact compact-
  navigation geometry, 31/31 responsive/CSS cases, and 4/4 Advanced no-update
  screenshots pass. Desktop, tablet, genuine-touch portrait/landscape,
  keyboard, focus return/non-steal, retained-hidden focus recovery, reduced
  motion, 44px targets, operational states, and both CSS load orders are
  covered.
- Independent shared/public-contract, URL/security, React/ownership,
  lifetime/chunk, browser/cutover, visual, and final code reviews report no
  remaining Critical or Important issue after RED/GREEN fixes for selection
  authority, Strict Mode request lifetime, compact-nav clipping, diagnostic
  return focus, and retained-hidden legacy focus. The final review additionally
  found that the production legacy return anchor used a divergent builder from
  the browser-proven helper. `78e2c13` consolidates both callers on one neutral
  bounded builder, preserves canonical Advanced `legacySurface` before
  lower-priority selection fields at the 4,096-byte budget, and adds exact
  unit/browser regression proof; the re-review reports no finding.
- The in-app Browser was attempted first and is unavailable exactly as
  `Browser runtime unavailable after setup failure: Cannot redefine property:
  process`; terminal Playwright is fallback evidence, not an in-app Browser
  pass.
- `DEFAULT_APP_EXPERIENCE` remains `legacy`; every legacy row and old alias is
  still visible through the preserved legacy experience. Iteration 12 alone
  owns Ready-State #1, #14, the unavailable live #3 execution, final
  accessibility debt, and the blank-URL default flip.

## Iteration 11 Exit Criteria

- [x] Recipe Console Advanced exposes every registered direct diagnostic and
      Advanced Legacy workflow without adding direct tools to primary navigation.
- [x] Selected auth/ticket, no-peer/no-route, missing-group/member, and
      server-status failures open the correct tool with safe exact context and
      return to the same selected run.
- [x] Every old query alias, deep link, runner-agent launch URL, legacy
      navigation surface, rollback path, and public/control contract remains
      operational.
- [x] Safe legacy surfaces resolve through dynamic imports, mount only while
      opened, dispose view-owned work on exit, and remain production-reachable.
- [x] Registered stateful exceptions retain their documented behavior only
      inside active `LegacyExperience`; none load, mount, subscribe, or poll on a
      cold Recipe Console route.
- [x] Recipe Console and legacy static closures remain reciprocal, CSS remains
      isolated in both load orders, and no registry, replacement monolith, broad
      stylesheet, duplicate poller, hidden safe mount, or legacy React import has
      been introduced.
- [x] Desktop, tablet, touch portrait, touch landscape, keyboard, reduced
      motion, operational states, context/return, alias, chunk, effect, and
      accessibility browser proofs pass.
- [x] All available focused and complete unit, type, Deno, build, chunk,
      browser, and independent-review gates are green; unavailable live-service
      proof is recorded with its exact skip reason.
- [x] No legacy row is retired and the default remains legacy. Iteration 12
      remains the sole owner of the default flip and final Ready-State audit.
