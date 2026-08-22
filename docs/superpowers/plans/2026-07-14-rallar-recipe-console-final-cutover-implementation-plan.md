# Rallar Recipe Console Final Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Iteration 12 by making Recipe Console the safe blank-URL
default, clearing the registered legacy accessibility debt, proving the final
cross-viewport Ready-State contract, and recording every available and
unavailable qualification result without retiring the legacy experience.

**Architecture:** Change only the experience-selection default; explicit
legacy aliases, old deep links, and runner-agent launch URLs remain authoritative
and continue to select the lazy `LegacyExperience`. Put final legacy overrides
in one narrowly scoped stylesheet under `src/legacy/accessibility/**`, loaded
only with the legacy chunk. Add browser acceptance beside the existing Recipe
Console suites; do not add feature ownership to `App.tsx`,
`RecipeConsoleApp.tsx`, `LegacyAppShell.tsx`, a registry, or the global legacy
stylesheet.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Playwright Chromium, Deno.

## Global Constraints

- Preserve public exports, current control-server contracts, rollback URLs,
  aliases, runner-agent launch inputs, and explicit `experience=legacy` routes.
- Keep legacy and Recipe Console as mutually exclusive lazy experience
  closures. A cold blank/default route must not request, mount, subscribe, or
  poll legacy owners.
- Keep the twelve Iteration 11 stateful legacy exceptions mounted only inside
  active `LegacyExperience`; do not silently convert them to unmounted routes.
- Use tests first for every behavior change and watch each RED fail for the
  intended reason before production edits.
- Approved visual direction remains Signal Ledger (Direction A). Baseline
  changes require deliberate inspection; do not update snapshots merely to
  make a gate green.
- Browser QA must cover 1440×900 desktop, 900×900 tablet, genuine-touch 430×932
  portrait, genuine-touch 932×430 landscape, keyboard, reduced motion,
  persistent non-hover evidence, operational states, and both CSS load orders.
- The in-app Browser failure remains exactly `Browser runtime unavailable after
  setup failure: Cannot redefine property: process`; terminal Playwright is the
  permitted fallback and is not an in-app Browser pass.
- Configured live/Postgres validation is a pass only if it executes successfully.
  When unavailable, record exactly `Set RALLAR_BLACK_BOX_FULL_STACK=1 with
  Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and
  apps/rallar-black-box available.`
- Interpret Ready-State #3 according to the user's completion rule: all
  deterministic/code-backed behavior and every available validation must pass.
  Iteration 12 found the configured services available and executed the live
  owner 4/4; the deterministic config's separate opt-in wrapper remains an
  explicit skip and must never be described as that pass.
- No push or pull request.

---

## Repository-Authoritative Corrections

- The source plan names an app-local Playwright path, but repository tests live
  under `tests/playwright/rallar-black-box/**`.
- `App.tsx` is already 260 lines, `RecipeConsoleApp.tsx` 28 lines, and
  `LegacyAppShell.tsx` 111 lines. Iteration 12 must preserve those boundaries,
  not perform another shell extraction.
- Existing Recipe Console responsive suites already prove many interaction
  details, but the named final `recipe-console-accessibility.spec.ts` artifact
  and the six registered legacy debt surfaces do not yet exist.
- `src/styles.css` is extraction-hash-locked legacy parity. Final accessibility
  overrides belong in a scoped, legacy-only file rather than extending it.
- The production full-stack script exists as
  `npm run test:e2e:rallar-black-box:full-stack:real:distributed` and delegates
  to the current Postgres distributed Playwright config.

## Task 0: Bind The Final Cutover Plan

**Files:**

- Create: `docs/superpowers/plans/2026-07-14-rallar-recipe-console-final-cutover-implementation-plan.md`
- Modify: `.superpowers/sdd/progress.md` (ignored durable ledger only)

**Interfaces:**

- Consumes: Iteration 11 qualified implementation head `78e2c13` and
  documentation milestone `f281425`.
- Produces: the task contract used by all Iteration 12 implementers/reviewers.

- [x] Verify this plan against Iteration 12, all 14 Ready-State bullets, the
      current migration register, and current source/test paths.
- [x] Scan for placeholders, contradictory task requirements, and nonexistent
      commands or files.
- [x] Record the Iteration 12 plan path and Task 0 completion in
      `.superpowers/sdd/progress.md`.
- [x] Commit `docs: bind final Recipe Console cutover`.

## Task 1: Blank-URL Default And Explicit Legacy Compatibility

**Files:**

- Modify: `apps/rallar-black-box/src/app/experience-route.ts`
- Modify: `packages/tests/rallar-black-box/experience-route.test.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts`
- Modify: `tests/playwright/rallar-black-box/tabbed-navigation.spec.ts`

**Interfaces:**

- Consumes: `resolveAppExperience(search, defaultExperience?)` and the v1 URL
  codec.
- Produces: `DEFAULT_APP_EXPERIENCE === 'recipe-console'`; explicit legacy
  aliases still win; blank/provider-only URLs enter Recipe Console.

- [x] RED `experience-route.test.ts`: remove blank search from the legacy alias
      table, import `DEFAULT_APP_EXPERIENCE`, and assert:

  ```ts
  expect(DEFAULT_APP_EXPERIENCE).toBe('recipe-console');
  expect(resolveAppExperience('')).toBe('recipe-console');
  expect(resolveAppExperience('?provider=simulated')).toBe('recipe-console');
  ```

  Preserve assertions that `mode`, `workspace`, `appMode`, `tab`,
  `advancedSurface`, `advanced`, future versions, invalid explicit experience,
  and control-agent launch URLs resolve to legacy.

- [x] Run
      `./node_modules/.bin/vitest run packages/tests/rallar-black-box/experience-route.test.ts`
      and verify only the new default assertions fail because the constant is
      still `legacy`.
- [x] Make legacy-intent Playwright setup explicit by adding
      `experience=legacy` to provider-only routes in `tabbed-navigation.spec.ts`
      (Quick Test default, browser-Rallar Quick Test, persistence reload),
      `recipe-console-shell.spec.ts` (legacy side of the lazy round trip), and
      `recipe-console-chunks.spec.ts` (legacy cold entries). Do not change old
      compatibility routes that already contain a legacy key such as `tab`.
- [x] Add exact browser acceptance `blank URL opens Recipe Console Execute
  after the final ready-state flip`. Seed a valid local auth session plus stale
      stored legacy mode/tab, navigate literal `/`, and assert canonical Execute,
      Recipe Console navigation, no `.app-shell`, no legacy owner, no
      `LegacyExperience` request, and canonical v1 URL replacement.
- [x] Before changing production, run the exact named browser acceptance and
      observe RED because blank `/` still resolves to legacy. Keep the explicit
      legacy-intent route corrections in this test-only RED patch so unrelated
      legacy cases do not fail merely because they depended on the old default.
- [x] GREEN the smallest production change:

  ```ts
  export const DEFAULT_APP_EXPERIENCE: AppExperience = 'recipe-console';
  ```

- [x] Change the Iteration 11 cold default proof in
      `recipe-console-advanced.spec.ts` and the recipe side of
      `recipe-console-chunks.spec.ts` to enter through `/` (using auth setup where
      the browser-Rallar login gate applies). Preserve reciprocal explicit legacy
      chunk proof and credential-origin policy tests.
- [x] Run focused Vitest, the exact shell/default test, chunks 10/10, Advanced
      3/3, and full `tabbed-navigation.spec.ts`. Review every changed test route to
      ensure it expresses product intent rather than depending on the old default.
- [x] Dispatch a fresh specification reviewer and then a code-quality reviewer
      for Task 1. Fix every Critical or Important finding test-first, rerun the
      focused gates, and obtain a clean re-review before advancing.
- [x] Commit `feat: make Recipe Console the default`.

### Task 1 qualification — 2026-07-14

- RED was observed independently in unit and browser scope: the route suite
  failed only the new default expectation (14 passed, one failed), and the
  exact blank-route acceptance could not find Recipe Console while the constant
  still selected legacy.
- GREEN passes 15/15 route tests, the exact blank/default acceptance 1/1,
  reciprocal chunk/isolation 10/10, Advanced lifetime/alias proof 3/3, and the
  preserved legacy navigation suite 29/29. App TypeScript and diff-check pass.
- The only production change is the one default constant. Provider-only legacy
  test intent is explicit; every alias/deep link remains authoritative. The
  strengthened acceptance compares the full canonical URL, including the
  repository default `recipeId=rtc-realtime-stability`, and proves stale legacy
  storage, DOM owners, chunks, and resources cannot win on `/`.
- Fresh specification and code-quality reviews report no remaining finding.
- A subsequent whole-suite route audit found one exhaustive legacy reload that
  intentionally omitted workspace/tab but also relied on the old implicit
  experience. Its URL now carries only `experience=legacy`, preserving stored
  Event Stream authority. The two configured-stack cases were discovered and
  skipped, not passed, under the unavailable-service guard; focused re-review
  reports no finding.

## Task 2: Scoped Legacy Touch And Narrow-Screen Repair

**Files:**

- Create: `apps/rallar-black-box/src/legacy/accessibility/legacy-accessibility.css`
- Modify: `apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx`
- Modify: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-main.tsx`
- Modify: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-recipe-first-main.tsx`
- Modify: `packages/tests/rallar-black-box/legacy-shell-composition.test.ts`
- Create: `tests/playwright/rallar-black-box/recipe-console-accessibility.spec.ts`

**Interfaces:**

- Consumes: legacy panel root classes and the existing mutually exclusive
  `LegacyExperience` chunk.
- Produces: 44px action targets for Media, Rallar Data, CRDT, Auth,
  Groups/Clients, and Rallar Server; narrow CRDT tracks collapse and wide tables
  scroll locally.

- [x] RED the legacy import inventory and browser matrix. Require the new
      side-effect import immediately after `../../styles.css`, require both CSS
      fixtures to load it after legacy base CSS, then measure visible actions at
      1440×900, 430×932 touch, and 932×430 touch. Verify CRDT portrait currently
      overflows or keeps multi-column tracks and the registered targets are below
      44px.
- [x] Run the focused structure test and the new legacy accessibility case;
      confirm failures identify only the missing stylesheet/import and the recorded
      size/overflow debts.
- [x] Add only scoped rules rooted at `.app-shell` and the six panel classes.
      The core contract is:

  ```css
  .app-shell :is(
      .media-console-panel,
      .rallar-data-panel,
      .crdt-health-panel,
      .auth-command-center-panel,
      .rooms-clients-panel,
      .rallar-server-panel
  ) :is(
      button,
      input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]),
      select,
      textarea,
      label:has(input:is([type="checkbox"], [type="radio"]))
  ) {
      min-block-size: 44px;
  }

  @media (max-width: 960px) {
      .app-shell .crdt-health-panel :is(
          .crdt-editor-controls,
          .crdt-editor-workbench .form-grid,
          .crdt-editor-diagnostics
      ) {
          grid-template-columns: minmax(0, 1fr);
      }

      .app-shell .crdt-health-panel .table-shell {
          max-inline-size: 100%;
          overflow-x: auto;
          overscroll-behavior-x: contain;
      }
  }
  ```

  The `960px` starting breakpoint deliberately includes the required 932×430
  landscape viewport. Keep it only if the RED measurements show it is the
  smallest safe landscape-inclusive boundary; otherwise choose the smallest
  measured wider boundary and record it in the test. Expand the action selector
  only when the RED matrix proves another actual interactive control is
  undersized. Do not use unscoped `button`, `input`, or `table` rules.
- [x] In the same new spec add exact Ready-State #14 acceptance `exposes
  equivalent keyboard touch and persistent evidence at desktop portrait and
  landscape viewports`. Across the three required viewports, exercise primary
      keyboard navigation, a real visible selection/disclosure, persistent
      Advanced evidence without hover, 44px representative controls, reduced
      motion, and zero document overflow. The 900×900 tablet remains covered by the
      complete responsive suite.
- [x] GREEN the focused structure/browser tests, both CSS load orders, existing
      responsive/accessibility cases, and legacy AppTabs focus tests. Inspect
      desktop/portrait/landscape screenshots at original resolution.
- [x] Dispatch fresh Task 2 specification and code-quality reviewers. Fix every
      Critical or Important finding test-first and re-review before advancing.
- [x] Commit `fix: close final accessibility debt`.

### Task 2 qualification — 2026-07-14

- Structure RED had the two intended missing-import/stylesheet failures. The
  browser RED recorded 30px Media/Data/CRDT buttons, 42px Auth/Groups/Server
  buttons, 18–40px form controls and checkbox labels, CRDT 5/6/2 tracks,
  `overflow-x: visible`, 377px portrait escape, and 781px/287px stressed-table
  escape in portrait/landscape.
- The 44-line legacy-only stylesheet is imported after frozen legacy CSS and
  loaded in both fixture orders. It is rooted under `.app-shell` and the six
  registered panel classes, gives every measured action/form/checkbox-label hit
  area at least 44×44 without enlarging checkbox/radio glyphs, collapses CRDT at
  the measured landscape-inclusive 960px boundary, and contains the table
  scroll locally. No global stylesheet or mount policy changed.
- GREEN passes 14/14 focused structure/focus tests, the new canonical browser
  matrix 2/2, existing responsive/CSS isolation 31/31, legacy AppTabs browser
  focus 2/2, app TypeScript, and diff-check. Original-resolution desktop,
  genuine-touch portrait/landscape, and stressed CRDT screenshots were
  inspected without clipping or escape.
- The specification review's actionable-form target finding was reproduced
  RED and closed; re-review and a fresh code-quality review report no remaining
  finding. Browser touch hardware is emulated through `hasTouch`, coarse
  pointer, hover-none, and one touch point; no physical-device run is claimed.

## Task 3: Executable Contrast And Artifact-Missing Semantics

**Files:**

- Modify: `tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-analyze-safety.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-analyze-fixture.ts`
- Modify after the broader keyboard gate exposed the real scroll owner:
  `tests/playwright/rallar-black-box/recipe-console-fleet.spec.ts`
  `apps/rallar-black-box/src/recipe-console/fleet/FleetWorkspace.tsx`
- Modify if contrast RED proves the measured token gap:
  `apps/rallar-black-box/src/recipe-console/design/tokens.css`
- Modify only if artifact RED proves the response-projection gap:
  `apps/rallar-black-box/src/recipe-console/analyze/analyze-workspace-policy.ts`

**Interfaces:**

- Consumes: rendered Direction A status tokens and Control artifact load state.
- Produces: executable WCAG contrast evidence and an accessible Control artifact
  404 state that retains prior usable evidence without inventing data.

- [x] Add pure test-local RGB parsing, relative luminance, and contrast-ratio
      helpers. For every running/passed/failed/warning/stale/partial/disabled mark,
      assert text/background at least 4.5:1 and border/background at least 3:1.
      Also assert selected primary-navigation text/background at least 4.5:1 and
      its border/background and focus-outline/surrounding-background at least 3:1.
- [x] RED an Analyze safety case that first loads a valid Control artifact,
      configures the fixture's next artifact request to return 404, clicks the
      visible load action, and expects `Needs attention`, an accessible error that
      names unavailable/missing evidence without leaking a response body, the
      previous verdict/evidence still visible, and no fabricated replacement
      identity.
- [x] Run both focused specs before production edits. Verify contrast RED names
      the actual failing rendered token/ratio, and artifact RED fails only because
      the fixture lacks a one-shot HTTP failure or production exposes/mishandles
      that observable state.
- [x] Add a one-shot `failNextArtifactResponse(status, body)` fixture seam. If
      production already meets the acceptance, make no production change. If not,
      apply the smallest Analyze state/controller fix and keep derivation outside
      React.
- [x] Run status, Analyze safety, all operational-state cases, responsive CSS,
      and app typecheck.
- [x] When that broader gate exposes a keyboard-focus gap on the actual
      short-landscape Fleet scroll owner, reproduce it alone, target the named
      scroll region in the acceptance, and add only semantic focus ownership.
- [x] Dispatch fresh Task 3 specification and code-quality reviewers. Fix every
      Critical or Important finding test-first and re-review before advancing.
- [x] Commit `test: prove final operational accessibility`.

### Task 3 qualification — 2026-07-14

- Contrast RED measured the disabled status border at 1.2506:1; the scoped
  token change to `#7A8492` raises it to 3.3418:1. All seven rendered status
  text/background pairs pass 4.5:1, their borders pass 3:1, selected normal-size
  navigation text passes 4.5:1, and its border and focus outline pass 3:1.
- Analyze RED exposed the fixture's private 404 response sentinel verbatim.
  The one-shot failure is consumed before its optional defer gate, and only a
  canonical Control artifact 404 now projects a fixed unavailable-artifact
  message. Prior provenance, verdict, evidence, URL identity, and legacy link
  remain exact; fabricated response identities never reach visible copy.
- Focused Task 3 browser acceptance passes 13/13, Analyze policy unit coverage
  passes 5/5, and app TypeScript plus diff-check pass.
- The first broader operational/responsive/CSS run passed 36/37 and isolated a
  pre-existing Fleet short-landscape keyboard gap: the real 32,785px scroll
  owner was not focusable. The refined acceptance failed 0/1 on the missing
  `tabindex`, then passed 1/1 after the named region received semantic focus
  ownership. The exact broader gate now passes 37/37; existing global
  `:focus-visible` styling supplies the visible outline without new CSS.
- The specification review's 3:1 selected-text threshold finding was closed by
  the correct 4.5:1 normal-text assertion and matching plan language; re-review
  and a fresh code-quality/privacy/accessibility review report no Critical or
  Important finding. The review's two non-blocking notes are intentionally
  retained: the real browser pipeline, rather than a duplicate unit assertion,
  owns 404 privacy proof, and the single named Fleet region remains a tab stop
  outside short landscape so its landmark is consistently keyboard reachable.

## Task 4: Fresh Qualification, Reviews, And Cutover Records

**Files:**

- Modify: `playground/rallar-black-box-spa-reimplementation-plan.md`
- Modify: `apps/rallar-black-box/docs/recipe-console-product-spec.md`
- Modify: `apps/rallar-black-box/docs/recipe-console-migration-register.md`
- Modify: `apps/rallar-black-box/docs/recipe-console-iteration-2-fidelity-ledger.md`
- Modify: this child plan
- Modify: `.superpowers/sdd/progress.md` (ignored ledger only)

**Interfaces:**

- Consumes: Tasks 1–3 green commits and every Iteration 0–11 milestone.
- Produces: the final code-backed Ready-State matrix, exact skip evidence, and
  an independently reviewed local branch.

- [x] Dispatch independent reviews for default/compatibility routing,
      accessibility/contrast, React/CSS/chunk ownership, operational state, and
      final Ready-State traceability. RED/GREEN every Critical or Important
      finding, then re-review.
- [x] Run the following exact non-browser qualification commands and record
      their exit code and test count separately:

  ```bash
  npx vitest run \
    packages/tests/rallar-black-box/experience-route.test.ts \
    packages/tests/rallar-black-box/recipe-console-control-api.test.ts \
    packages/tests/rallar-black-box/recipe-console-url-state.test.ts \
    packages/tests/rallar-black-box/recipe-console-url-history.test.ts \
    packages/tests/rallar-black-box/ui-persistence.test.ts \
    packages/tests/rallar-black-box/app-tabs.test.ts \
    packages/tests/rallar-black-box/legacy-app-tabs-focus.test.ts \
    packages/tests/rallar-black-box/legacy-shell-composition.test.ts \
    packages/tests/rallar-black-box/legacy-shell-structure.test.ts \
    packages/tests/rallar-black-box/recipe-console-structure.test.ts \
    packages/tests/rallar-black-box/app-structure.test.ts \
    packages/tests/rallar-black-box/distributed-recipes.test.ts \
    packages/tests/rallar-black-box/control-run-manager.test.ts \
    packages/tests/rallar-black-box/schema-authoring.test.ts
  npx vitest run packages/tests/rallar-black-box
  npm --workspace @ar-eye-hunter/shared-test run check:ts
  npm --workspace @ar-eye-hunter/shared-test run check:deno
  deno check --node-modules-dir=none \
    packages/shared-test/rallar-bb-test/advanced-diagnostic-handoff.ts \
    packages/shared-test/rallar-bb-test/mod.ts
  npm --workspace rallar-black-box run typecheck
  npm run build:rallar-black-box
  npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
  npm run check:rallar-black-box-control
  npm run test:rallar-black-box-control
  ```

- [x] Run the following exact browser commands. The first command is the
      complete Recipe Console config; the remaining commands provide separately
      countable cutover, legacy, responsive, operational, CSS, keyboard/reduced-
      motion, and no-update visual evidence:

  ```bash
  npx playwright test \
    --config apps/rallar-black-box/playwright.recipe-console.config.ts
  npx playwright test \
    --config apps/rallar-black-box/playwright.config.ts \
    tests/playwright/rallar-black-box/recipe-console-shell.spec.ts \
    --grep "blank URL opens Recipe Console Execute after the final ready-state flip"
  npx playwright test \
    --config apps/rallar-black-box/playwright.config.ts \
    tests/playwright/rallar-black-box/recipe-console-accessibility.spec.ts \
    tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts \
    tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts \
    tests/playwright/rallar-black-box/recipe-console-analyze-safety.spec.ts \
    tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts
  npx playwright test \
    --config apps/rallar-black-box/playwright.recipe-console.config.ts \
    tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts \
    tests/playwright/rallar-black-box/recipe-console-advanced.spec.ts
  npx playwright test \
    --config apps/rallar-black-box/playwright.recipe-console.config.ts \
    tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts
  npx playwright test \
    --config apps/rallar-black-box/playwright.config.ts \
    tests/playwright/rallar-black-box/tabbed-navigation.spec.ts
  ```

  Inspect all captured desktop 1440×900, tablet 900×900, touch portrait
  430×932, and touch landscape 932×430 screenshots at original resolution;
  review console/page errors; never use `--update-snapshots` unless an
  intentional reviewed visual change requires it.
- [x] Attempt
      `npm run test:e2e:rallar-black-box:full-stack:real:distributed`. Record a
      real pass only on successful configured execution; otherwise record the exact
      unavailable prerequisite from Global Constraints as skipped.
- [x] Verify actual line counts and structure boundaries for `App.tsx`,
      `RecipeConsoleApp.tsx`, and `LegacyAppShell.tsx`; verify old deep links,
      explicit `experience=legacy`, Advanced Legacy, and runner-agent launch remain
      operational.
- [x] Update all five evidence documents with actual hashes, commits, counts,
      viewports, skips, cutover proof, rollback, remaining risks, and Ready-State
      #1–#14 dispositions. Mark #3 code-backed/conditionally available while
      leaving the configured live execution explicitly skipped if unavailable.
- [x] Run `git diff --check`, documentation consistency searches, and a final
      whole-branch independent review. Do not accept unresolved Critical or
      Important findings.
- [x] Commit `docs: qualify Recipe Console final cutover`. Do not push or open a
      pull request.

### Task 4 qualification — 2026-07-14

- Code milestone `aec6e57` closes the last accessibility, modal/focus,
  collision, live-test, Postgres-prefix, and durable-inbox qualification gaps.
  Default cutover remains the earlier single-purpose `4f04228` milestone.
- Exact non-browser proof passes 294/294 focused tests and 1,568/1,568 complete
  app tests across 149 files; shared-test TypeScript and Deno checks, direct
  Deno entries, app/shared-server/API checks, a 777-module production build,
  reciprocal chunk assertion, control-server 79/79, PGlite 13/13, real
  PostgreSQL 3/3, and Prisma's 15-migration up-to-date status.
- Final browser proof passes the settled Recipe Console configuration 196 with
  one explicit configured-live wrapper skip, blank/default 1/1, legacy
  navigation 29/29, responsive/accessibility/operational/CSS 48/48,
  chunk/Advanced 13/13, and concept fidelity 8/8 without snapshot updates.
  Original-resolution desktop/tablet/touch captures and explicit
  console/page-error evidence were inspected.
- Repository truth corrected the draft browser command: chunk/Advanced and
  concept specs intentionally target production preview port 4176 and must use
  `playwright.recipe-console.config.ts`, which owns both dev and preview. The
  regular config owns only 5176/5180 and forces SwiftShader. Its exploratory
  chunk/Advanced attempt passed five dev cases and received eight
  `ERR_CONNECTION_REFUSED` production navigations; no product assertion failed,
  the config was not broadened, and the authoritative deterministic runs pass.
- The configured service owner was available. The exact
  `npm run test:e2e:rallar-black-box:full-stack:real:distributed` command passes
  4/4 after executing visible create/stage/start/Monitor/Cancel/export plus
  strict browser ACK, WS, and RTC recipes. The deterministic config's one
  opt-in skip remains a skip and is not counted as this pass.
- Final line counts are 260 (`App.tsx`), 28 (`RecipeConsoleApp.tsx`), 111
  (`LegacyAppShell.tsx`), 149 (`ExecuteTargetWindow.tsx`), and 67 for the scoped
  legacy accessibility stylesheet. Explicit legacy/alias/agent-launch rollback
  stays operational and no legacy row is retired or newly hidden.
- Independent final review reports no Critical, Important, or Minor finding.
  The in-app Browser remains unavailable exactly as `Browser runtime
  unavailable after setup failure: Cannot redefine property: process`;
  terminal Playwright is fallback evidence, not an in-app Browser pass.

## Iteration 12 Exit Criteria

- [x] Authenticated blank `/` resolves to canonical Recipe Console Execute and
      does not load legacy resources; explicit old aliases/deep links remain legacy.
- [x] The six registered legacy accessibility debts are closed with 44px
      actions, narrow CRDT containment, and no page overflow.
- [x] Desktop, tablet, genuine-touch portrait/landscape, keyboard, reduced
      motion, persistent non-hover evidence, contrast, operational states, and CSS
      isolation pass executable browser gates.
- [x] Ready-State #14 has the exact named browser acceptance; #1–#14 have
      code-backed evidence. The deterministic config's opt-in live wrapper remains
      an exact skip; the separately configured owner executes and passes 4/4.
- [x] `App.tsx`, `RecipeConsoleApp.tsx`, and `LegacyAppShell.tsx` remain bounded
      glue; no registry, shell, or stylesheet monolith is introduced.
- [x] Legacy rollback navigation, all old routes, public exports, and existing
      control contracts remain operational; nothing is retired.
- [x] All available focused, complete, build, Deno, browser, visual, and review
      gates are green, docs match repository truth, and cohesive local milestone
      commits exist on the isolated `codex/` branch.
