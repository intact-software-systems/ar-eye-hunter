# Rallar Recipe Console Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Iteration 2 as a seeded, URL-backed, responsive Signal
Ledger Recipe Console beside the intact legacy application, with proven lazy
experience chunks, CSS isolation, concept fidelity, and no backend dependency.

**Architecture:** `App.tsx` retains runtime/auth/ticket gates and selects one
lazy experience. `LegacyExperience` owns every legacy controller and stylesheet;
`RecipeConsoleApp` owns a versioned URL codec, focused shell regions, one
responsive inspector subtree, and independent view modules. Seed adapters use
repository fixtures plus deterministic shared-test analysis and never invent
live state.

**Tech Stack:** React 19, TypeScript, Vite 8, CSS Modules, Vitest, Playwright,
existing `packages/shared-test/rallar-bb-test` contracts.

## Global Constraints

- Work only in the isolated worktree on `codex/rallar-black-box-spa-reimplementation`; do not push or open a pull request.
- Follow red-green-refactor for every behavioral change: write the focused test, run it and observe the expected failure, implement minimally, then rerun it green.
- Preserve every public export, control-server contract, blank URL, old deep link, runner-agent launch URL, and legacy surface.
- Blank URLs and old `workspace`, `appMode`, `tab`, `advancedSurface`, `advanced`, and control-agent aliases remain legacy through Iteration 11.
- `experience=recipe-console` is the explicit Iteration 2 opt-in; Recipe Console canonicalizes and emits `v=1` URLs.
- Render exactly one experience branch. Inactive legacy and Recipe Console trees must be lazy-loaded and unmounted, never retained with `hidden`, `display:none`, an experience registry, or parallel JSX.
- `App.tsx` remains provider/bootstrap/auth/experience-routing glue; it declares no feature panel and stays at or below 260 lines.
- New UI lives under `apps/rallar-black-box/src/recipe-console/**`; the lazy legacy owner lives under `apps/rallar-black-box/src/legacy/**`; reusable deterministic analysis stays in `packages/shared-test/**`.
- Recipe Console feature modules must not import `src/legacy/**`; Advanced emits a legacy URL but does not statically import a legacy panel.
- Concepts govern hierarchy, density, palette, typography, geometry, state treatment, and responsive transformation. Repository fixtures and deterministic derivations govern displayed copy and data.
- Use `RALLAR_BLACK_BOX_RECIPE_FIXTURES`, `failed-command`, and `high-latency-rtc` as the canonical Execute, Monitor, and Tune sources defined by the approved design contract.
- No Iteration 2 UI may imply live control connectivity or live execution. Seed actions are visibly preview-only; unavailable evidence renders unavailable.
- Recipe Console CSS is scoped below `.recipe-console`; no new shell CSS may depend on `.panel`, `.metric`, `.workspace-grid`, legacy tabs, or broad legacy selectors.
- Keep `RecipeConsoleApp.tsx` at or below 180 lines, `RecipeConsoleShell.tsx` at or below 240 lines, every other Recipe Console TSX file at or below 300 lines, every routing/data file at or below 280 lines, and every CSS Module at or below 400 lines.
- Operational status always combines color with visible text and a distinct icon/shape. Touch targets are at least 44×44px.
- Desktop is 1440×900, portrait is 430×932, and short landscape is 932×430. No document overflow is permitted; only the matrix may scroll horizontally in portrait.
- Reduced motion removes transform travel, pulses, interpolation, and repeated emphasis. Inspector focus is trapped while open, Escape closes it, and focus returns to its trigger.
- Do not represent unavailable live-service validation as passed. Use the exact skip reason from the parent implementation plan.

---

### Task 1: Versioned URL State And Experience Selection

**Files:**

- Create: `apps/rallar-black-box/src/app/experience-route.ts`
- Create: `apps/rallar-black-box/src/app/use-experience-route.ts`
- Create: `apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts`
- Create: `apps/rallar-black-box/src/recipe-console/routing/url-state-codec.ts`
- Create: `apps/rallar-black-box/src/recipe-console/routing/url-history.ts`
- Create: `apps/rallar-black-box/src/recipe-console/routing/use-recipe-console-url-state.ts`
- Test: `packages/tests/rallar-black-box/experience-route.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-url-state.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-url-history.test.ts`

**Interfaces:**

- Produces:

```ts
export type AppExperience = 'legacy' | 'recipe-console';
export const DEFAULT_APP_EXPERIENCE: AppExperience = 'legacy';
export function resolveAppExperience(
    search: string,
    defaultExperience?: AppExperience
): AppExperience;
export function useExperienceRoute(): AppExperience;

export const RECIPE_CONSOLE_URL_VERSION = 1 as const;
export const RECIPE_CONSOLE_VIEWS = [
    'execute',
    'monitor',
    'analyze',
    'tune',
    'fleet',
    'advanced'
] as const;
export type RecipeConsoleView = typeof RECIPE_CONSOLE_VIEWS[number];
export type RecipeConsoleUrlState = Readonly<{
    v: 1;
    experience: 'recipe-console';
    view: RecipeConsoleView;
    controlRunId?: string;
    distributedRunId?: string;
    agentId?: string;
    recipeId?: string;
    commandId?: string;
    diagnosticSeverity?: 'debug' | 'info' | 'warning' | 'error';
    transport?: 'realtime' | 'messages.rtc' | 'ws' | 'http' | 'runtime';
    historyQuery?: string;
    status?:
        | 'draft'
        | 'resolving-targets'
        | 'staging'
        | 'waiting-for-ack'
        | 'waiting-for-barrier'
        | 'ready'
        | 'running'
        | 'passed'
        | 'failed'
        | 'cancelled'
        | 'timed-out';
    from?: number;
    to?: number;
    compareLeft?: string;
    compareRight?: string;
    timingMetric?: 'command-duration' | 'stream-send-duration' | 'stream-drift' | 'stream-cadence';
    fleetRegion?: string;
    fleetMapLayers?:
        readonly ('live-agents' | 'historical-regions' | 'failures' | 'observed-routes')[];
    legacySurface?: string;
}>;
export type RecipeConsoleUrlIssue = Readonly<{
    field: string;
    code: 'missing' | 'invalid' | 'duplicate' | 'normalized' | 'inapplicable';
    value?: string;
    message: string;
}>;
export type ParsedRecipeConsoleUrl = Readonly<{
    state: RecipeConsoleUrlState;
    issues: readonly RecipeConsoleUrlIssue[];
    canonicalSearch: string;
    needsReplace: boolean;
}>;
export function parseRecipeConsoleUrl(search: string): ParsedRecipeConsoleUrl;
export function serializeRecipeConsoleUrl(
    state: RecipeConsoleUrlState,
    baseSearch?: string
): string;
export function createRecipeConsoleShareHref(
    location: Pick<Location, 'origin' | 'pathname' | 'search' | 'hash'>,
    state: RecipeConsoleUrlState
): string;
export const RECIPE_CONSOLE_SENSITIVE_URL_KEYS = [
    'agentSessionTicket',
    'controlToken',
    'rallarPassword',
    'rallarToken',
    'accessToken',
    'refreshToken',
    'password',
    'token'
] as const;
```

- `useRecipeConsoleUrlState()` returns `{ state, issues, navigate, replace,
  copyHref }`. `navigate(patch)` pushes committed state; `replace(patch)`
  replaces high-frequency state. It installs one `popstate` listener and never
  pushes while processing `popstate`.

- [ ] **Step 1: Write experience and codec tests first**

Add table-driven tests proving blank and every old alias resolve legacy;
`experience=recipe-console` with missing `v` or `v=1` opts in; `v=2` does not;
explicit valid experience wins over stale old aliases; a supplied future
Recipe Console default still preserves aliases as legacy. Add codec tests for
all fields, default `view=execute`, visible issues, case-sensitive enums,
first-value duplicate handling, trimmed optional IDs, safe nonnegative epoch
milliseconds, reversed range swapping, canonical fleet-layer order, explicit
`fleetMapLayers=none`, `legacySurface` only on Advanced, unknown parameter
preservation, old-alias removal only when serializing Recipe Console, and
case-insensitive removal of every `RECIPE_CONSOLE_SENSITIVE_URL_KEYS` entry
from query state during every Recipe Console canonicalization, serialization,
push, and replace, plus removal from both query and hash in copied links.
Non-sensitive query parameters and non-sensitive fragment fields remain intact.
The experience resolver never rewrites a legacy URL, so runner launch
compatibility remains untouched until Recipe Console is explicitly selected.

Core assertions must include:

```ts
expect(resolveAppExperience('')).toBe('legacy');
expect(resolveAppExperience('?workspace=black-box-runner', 'recipe-console')).toBe('legacy');
expect(resolveAppExperience('?experience=recipe-console')).toBe('recipe-console');
expect(resolveAppExperience('?v=2&experience=recipe-console')).toBe('legacy');

const parsed = parseRecipeConsoleUrl(
    '?provider=simulated&v=1&experience=recipe-console&view=monitor&view=tune' +
        '&from=900&to=100&fleetMapLayers=failures,live-agents'
);
expect(parsed.state).toMatchObject({
    view: 'monitor',
    from: 100,
    to: 900,
    fleetMapLayers: ['live-agents', 'failures']
});
expect(parsed.issues.map((issue) => issue.code)).toEqual(
    expect.arrayContaining(['duplicate', 'normalized'])
);
expect(parsed.canonicalSearch).toContain('provider=simulated');
```

- [ ] **Step 2: Run RED verification**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/experience-route.test.ts packages/tests/rallar-black-box/recipe-console-url-state.test.ts packages/tests/rallar-black-box/recipe-console-url-history.test.ts
```

Expected: fail because the six production modules do not exist.

- [ ] **Step 3: Implement the pure resolver, codec, and history adapter**

Use one owned-key list in `url-state-contract.ts`. Serialization starts from
`new URLSearchParams(baseSearch)`, deletes only owned Recipe Console keys and
old aliases plus every case-insensitive sensitive key, then writes canonical
fields. Unknown non-sensitive `provider`, `roomId`, and
future parameters remain. History tests use a small injected adapter:

```ts
export type RecipeConsoleHistoryPort = Readonly<{
    readSearch(): string;
    push(search: string): void;
    replace(search: string): void;
    subscribe(listener: () => void): () => void;
}>;

export function createRecipeConsoleUrlHistory(
    port: RecipeConsoleHistoryPort
): Readonly<{
    read(): ParsedRecipeConsoleUrl;
    push(patch: Partial<RecipeConsoleUrlState>): ParsedRecipeConsoleUrl;
    replace(patch: Partial<RecipeConsoleUrlState>): ParsedRecipeConsoleUrl;
    subscribe(listener: (value: ParsedRecipeConsoleUrl) => void): () => void;
}>;
```

The browser hook wraps this port with `window.history.pushState`,
`replaceState`, and `popstate`; it does not own validation logic.

- [ ] **Step 4: Run GREEN verification and refactor**

Run the Step 2 command. Expected: all tests pass with no console warnings.
Then run `npm --workspace rallar-black-box run typecheck`; expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/rallar-black-box/src/app apps/rallar-black-box/src/recipe-console/routing packages/tests/rallar-black-box/experience-route.test.ts packages/tests/rallar-black-box/recipe-console-url-state.test.ts packages/tests/rallar-black-box/recipe-console-url-history.test.ts
git commit -m "feat: add recipe console URL contract"
```

### Task 2: Mutually Exclusive Lazy Experience Boundary

**Files:**

- Create: `apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Create: `apps/rallar-black-box/src/auth.css`
- Create: `apps/rallar-black-box/playwright.recipe-console.config.ts`
- Create: `apps/rallar-black-box/scripts/assert-experience-chunks.ts`
- Modify: `apps/rallar-black-box/src/App.tsx`
- Modify: `apps/rallar-black-box/src/main.tsx`
- Modify: `apps/rallar-black-box/src/auth-flow.ts`
- Modify: `apps/rallar-black-box/vite.config.ts`
- Test: `packages/tests/rallar-black-box/auth-flow.test.ts`
- Test: `packages/tests/rallar-black-box/legacy-shell-composition.test.ts`
- Test: `packages/tests/rallar-black-box/legacy-shell-structure.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-structure.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts`
- Test: `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts`
- Test: `tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts`

**Interfaces:**

```ts
export function bootstrapMatchesAuthSession(
    bootstrap: RallarBlackBoxBootstrapConfig,
    session: AuthSession
): boolean;

export type LegacyExperienceProps = Readonly<{
    runtime: LegacyShellRuntime;
    auth: LegacyShellAuth;
}>;

export type RecipeConsoleAppProps = Readonly<{
    authSession?: AuthSession;
    authBusy: boolean;
    authError?: string;
    onLogout(): Promise<void>;
}>;
```

- [ ] **Step 1: Add failing auth and composition gates**

Assert `bootstrapMatchesAuthSession` is false before the exact
`bootstrapPatchFromAuthSession` merge, true after it, and false for a wrong
actor/session, retained password/register state, or disabled restore-session.
Assert `App.tsx` has exactly two module-scope dynamic imports, no static
`LegacyAppShell`, no legacy controller hooks, no feature JSX, and one ternary
experience branch after ticket/login gates. Assert `LegacyExperience` is the
sole owner of `useRunnerShellState`, `useLegacyNavigation`,
`useCommandCenterGlobalContext`, legacy `ensureBootstrapped`, and
`useRunnerShellSelectionSync`. Assert Recipe Console has no import path into
`src/legacy/**`. Create the Vite-only Playwright config with
`testMatch: /recipe-console-.*\.spec\.ts/`, port 5176, one app web server, and
no control server. Add browser tests proving blank and representative old
aliases render `.app-shell` without requesting RecipeConsoleApp; explicit
Recipe Console renders `.recipe-console` without `.app-shell` or legacy
requests; and popstate switches by unmounting the inactive tree. Add a build
test that initially fails because the chunk assertion script is absent. Name
the focused browser case `keeps one lazy experience mounted`.

- [ ] **Step 2: Run RED verification**

```bash
npx vitest run packages/tests/rallar-black-box/auth-flow.test.ts packages/tests/rallar-black-box/legacy-shell-composition.test.ts packages/tests/rallar-black-box/legacy-shell-structure.test.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts --grep "keeps one lazy experience mounted"
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts tests/playwright/rallar-black-box/agent-session-ticket-ui.spec.ts
```

Before the Playwright command, follow the installed Browser skill and open
`/?provider=simulated&experience=recipe-console`; record that the old App does
not render the Recipe Console marker. Expected automated result: fail on the
missing predicate, wrapper, lazy imports, chunk script, and experience DOM.
The established legacy navigation/ticket command remains a green
characterization baseline before the refactor.

- [ ] **Step 3: Move legacy ownership behind the lazy wrapper**

`LegacyExperience` imports `../../styles.css`, runs the four existing legacy
hooks unchanged, guards bootstrap with simulated provider or an auth session
whose bootstrap fields match, and renders the unchanged `LegacyAppShell`.
`App.tsx` keeps runtime subscription, auth subscription, stored-session read,
ticket consumption/scrub, bootstrap patch, login gate, and logout. It adds:

```ts
const RecipeConsoleApp = lazy(() => import('./recipe-console/app/RecipeConsoleApp.tsx'));
const LegacyExperience = lazy(() => import('./legacy/shell/LegacyExperience.tsx'));
```

After auth gates, render one `Suspense` and one conditional branch. Pass only
the shared auth surface to Recipe Console. The initial Recipe Console entry
renders `<main className="recipe-console" data-view="execute">` with a visible
loading-safe heading; later tasks replace its inner frame.

- [ ] **Step 4: Split static auth CSS without editing legacy CSS**

Change `main.tsx` from `styles.css` to `auth.css`. Copy only the exact auth
shell rules needed by ticket/login screens: root box sizing/font, html/body/root
minimum size and margin, form-control font sizing, `.auth-shell`, `.auth-panel`,
`.auth-heading`, `.auth-form`, `.check-field`, `.auth-summary`, `.field`,
`.eyebrow`, headings, `.pill`, `.command-center-status`, `.workbench-error`,
and the 760px 44px-control rules. Do not remove or change a byte in
`styles.css`; LegacyExperience loads that complete stylesheet in its own chunk.
Set `build.manifest = true` in Vite.

- [ ] **Step 5: Implement the initial executable chunk proof**

`assert-experience-chunks.ts` reads `dist/.vite/manifest.json`; it proves the
main static closure excludes both experiences; main's direct dynamic edges are
filtered to exactly two named experience entries, RecipeConsoleApp and
LegacyExperience, while unrelated auth/runtime dynamic entries remain allowed;
Recipe Console's static closure excludes legacy sentinels; LegacyExperience's
static closure includes them; and the two experience entries differ. The
Vitest boundary test runs a fresh temporary build before
invoking that assertion. Do not follow dynamic edges while computing a static
closure.

- [ ] **Step 6: Run GREEN and compatibility verification**

Run the Step 2 command, then:

```bash
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
npx vitest run packages/tests/rallar-black-box/app-structure.test.ts packages/tests/rallar-black-box/legacy-shell-composition.test.ts packages/tests/rallar-black-box/legacy-shell-structure.test.ts packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts --grep "keeps one lazy experience mounted"
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts tests/playwright/rallar-black-box/agent-session-ticket-ui.spec.ts
```

Expected: all commands exit 0; Vite emits separate dynamic RecipeConsoleApp and
LegacyExperience entries; resource interception sees no cross-experience load;
all existing legacy composition assertions stay green.

- [ ] **Step 7: Commit**

```bash
git add apps/rallar-black-box/src/App.tsx apps/rallar-black-box/src/main.tsx apps/rallar-black-box/src/auth-flow.ts apps/rallar-black-box/src/auth.css apps/rallar-black-box/src/legacy/shell/LegacyExperience.tsx apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx apps/rallar-black-box/vite.config.ts apps/rallar-black-box/playwright.recipe-console.config.ts apps/rallar-black-box/scripts/assert-experience-chunks.ts packages/tests/rallar-black-box/auth-flow.test.ts packages/tests/rallar-black-box/legacy-shell-composition.test.ts packages/tests/rallar-black-box/legacy-shell-structure.test.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts
git commit -m "refactor: isolate lazy app experiences"
```

### Task 3: Repository-Backed Seeded View Models

**Files:**

- Create: `apps/rallar-black-box/src/recipe-console/data/seeded-console-state.ts`
- Create: `apps/rallar-black-box/src/recipe-console/data/recipe-console-models.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-seeded-state.test.ts`

**Interfaces:**

```ts
export type RecipeConsoleSeedState = Readonly<{
    execute: ExecutePreviewModel;
    monitor: MonitorPreviewModel;
    tune: TunePreviewModel;
}>;
export function createRecipeConsoleSeedState(): RecipeConsoleSeedState;
```

`ExecutePreviewModel` exposes the selected shared fixture, catalog rows,
`distributedRecipeCommandPreview`, `distributedRecipePreflight`, two derived
target rows, 2/2 default target IDs, and a connectivity state of
`required-not-checked`. `MonitorPreviewModel` exposes the `failed-command`
seed, shared monitor/report/verdict, ordered failure ledger, agent progress,
and selected command failure. `TunePreviewModel` exposes the
`high-latency-rtc` IDs/state plus only stable projected fields: three per-agent
means, percentile summary, histogram, scatter points, matrix cells, empty
reasons, and `rtcTimelineAvailable: false`. It does not expose a clock-bearing
diagnostics/performance object.

- [ ] **Step 1: Write exact seeded-contract tests**

Assert the Execute selection is `rtc-realtime-stability`, its preview is
`5 manifest commands - 25 stream frames`, target IDs are `seed-agent-a` and
`seed-agent-b`, and control connectivity is not checked. Assert Monitor exact
IDs, 2 participants/1 failed, 4 commands/1 failed, the two ordered failure
codes/messages, diagnostic correlation only to the command row, verdict title,
likely cause, next action, and 520ms slowest evidence. Assert Tune run state is
passed, agent means are `[112.5, 1010, 1190]`, percentiles are
1010/1190/1190/1190, histogram counts are `[1,0,0,2]`, and unavailable RTC
timeline metrics are not synthesized.
Call `createRecipeConsoleSeedState()` twice and assert deep equality so a
`Date.now()`-backed field cannot leak into the model.

- [ ] **Step 2: Run RED verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-seeded-state.test.ts
```

Expected: fail because the two model modules do not exist.

- [ ] **Step 3: Implement thin deterministic adapters**

Import recipes directly from
`@shared-test/rallar-bb-test/recipe-fixtures.ts`; import monitor/report/verdict,
target-row, preflight, and command-preview helpers directly from
`@shared-test/rallar-bb-test/distributed-run-monitor.ts`. Use
`createSyntheticDistributedRunSeed` for canonical snapshots. Execute target
resolution configures the selected shared fixture through its existing factory
with the sample snapshot's exact group, then uses:

```ts
const targetSeed = createSyntheticDistributedRunSeed('passed-clean');
const selectedRecipe = createRallarBlackBoxRtcRealtimeStabilityRecipe({
    group: targetSeed.distributedRun.manifest.group
});
const targetRows = distributedRecipeTargetRows({
    run: targetSeed.controlRun,
    group: targetSeed.distributedRun.manifest.group,
    requiredCommandKinds: distributedRecipeCommandKinds(selectedRecipe),
    nowEpochMs: 1_900_000_002_550
});
```

Assert the configured recipe's ensure-group/member/connect commands reference
`rallar-server/default/seed-room`; never rewrite the sample agent identities or
claim that the unconfigured fixture's default group matched them.

Use the existing `deriveRtcDiagnostics`/`deriveRtcPerformanceView` projection
with an empty RTC state for Tune, then immediately copy only the stable arrays
and numeric summaries named by `TunePreviewModel`. Do not retain timestamps,
copy analysis formulas into React, or invent comparison/frame metrics.

- [ ] **Step 4: Run GREEN verification**

Run the Step 2 command and
`npx vitest run packages/tests/rallar-black-box/distributed-run-seeds.test.ts`.
Expected: 6 existing seed tests plus every new test pass. Run app typecheck;
expected exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/rallar-black-box/src/recipe-console/data packages/tests/rallar-black-box/recipe-console-seeded-state.test.ts
git commit -m "feat: add deterministic recipe console previews"
```

### Task 4: Scoped Signal Ledger Design System And Shell

**Files:**

- Create: `apps/rallar-black-box/src/recipe-console/design/tokens.css`
- Create: `apps/rallar-black-box/src/recipe-console/design/reset.css`
- Create: `apps/rallar-black-box/src/recipe-console/app/recipe-console-navigation.ts`
- Create: `apps/rallar-black-box/src/recipe-console/shell/RecipeConsoleShell.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/shell/RecipeConsoleShell.module.css`
- Create: `apps/rallar-black-box/src/recipe-console/shell/TopCommandBar.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/shell/PrimaryNavigation.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/shell/InspectorHost.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/shell/responsive-presentation.ts`
- Create: `apps/rallar-black-box/src/recipe-console/shell/use-responsive-presentation.ts`
- Create: `apps/rallar-black-box/src/recipe-console/ui/Icon.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/IconButton.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/CommandBarItem.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/StatusMark.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/MetricStrip.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/SelectableRow.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/MatrixCell.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/SegmentedControl.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/OverlaySheet.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/StatePanel.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/ui/primitives.module.css`
- Create: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation.html`
- Create: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-main.tsx`
- Create: `apps/rallar-black-box/test/fixtures/RecipeConsoleIsolationSamples.tsx`
- Create: `apps/rallar-black-box/test/fixtures/LegacyIsolationSamples.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Test: `packages/tests/rallar-black-box/recipe-console-structure.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-responsive-presentation.test.ts`
- Test: `tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts`
- Test: `tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts`
- Test: `tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts`

**Interfaces:**

```ts
export type RecipeConsolePresentation = Readonly<{
    navigation: 'rail' | 'compact-rail' | 'bottom';
    inspector: 'rail' | 'overlay' | 'sheet';
    commandBarHeight: 48 | 52;
}>;
export function resolveRecipeConsolePresentation(
    width: number,
    height: number
): RecipeConsolePresentation;
export function useRecipeConsolePresentation(): RecipeConsolePresentation;
```

`RecipeConsoleShell` accepts current view, URL issues, command-bar context,
navigation callback, work content, optional inspector content, inspector-open
state, close callback, and restore-focus ref. Navigation uses one six-item
model in the exact Execute/Monitor/Analyze/Tune/Fleet/Advanced order.
`InspectorHost` renders its child exactly once as desktop rail, compact overlay,
or portrait sheet according to `RecipeConsolePresentation`; CSS owns geometry,
while the hook owns matching ARIA and keyboard mode.

- [ ] **Step 1: Extend the structure gate before components**

Assert exact nav order, no emoji, no broad legacy selectors, CSS variables are
descendants of `.recipe-console`, exactly one inspector child expression,
focusable icon-only controls require `aria-label`, module caps, and no inline
component declarations. Assert `RecipeConsoleApp` uses an explicit switch for
one active view and contains no registry/barrel or parallel hidden views.
Add pure resolver cases for 1440×900 desktop rail, 900×900 compact overlay,
430×932 portrait bottom-nav/sheet, and 932×430 compact-rail/overlay. Add browser
tests named `renders scoped shell geometry at every contract viewport`,
`pairs every operational status with text and shape`, and
`keeps representative legacy and recipe console styles isolated`. The geometry
test asserts exact 52/184/352 desktop tracks, 64/360 tablet behavior, 52/48/64
portrait bands, and 48/60/320 landscape behavior plus reduced-motion media.
It also asserts desktop inspector is non-modal, tablet/landscape are modal
overlays, and portrait is a modal sheet.

- [ ] **Step 2: Run RED verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-structure.test.ts
npx vitest run packages/tests/rallar-black-box/recipe-console-responsive-presentation.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts --grep "renders scoped shell geometry|pairs every operational status|keeps representative legacy"
```

Expected: fail on missing design, responsive resolver, shell, primitives,
fixture, geometry, status semantics, and scoped styles.

- [ ] **Step 3: Implement tokens, reset, icons, and primitives**

Use the approved exact token ledger: canvas `#F5F7FA`, surface `#FFFFFF`, text
`#172033`, border `#D5DBE3`, rail `#EEF1F5`, primary `#2446C2`, hover
`#1937A2`, selected `#E7ECFF/#1B3696/#3659D4`, focus `#315CF3`, and the
running/passed/failed/warning/stale/partial/disabled triples in the design spec.
`Icon` is one code-native 16/18px outline SVG family with `aria-hidden` paths;
`StatusMark` adds visible text and distinct shape. `OverlaySheet` establishes
the single semantic dialog/sheet host and applies `aria-modal="true"` only in
overlay/sheet modes selected by `useRecipeConsolePresentation`. Implement the
hook with `useSyncExternalStore`, one deduplicated matchMedia/resize
subscription, and cleanup. Task 6 adds
keyboard trap/close/restore behavior after the failing portrait browser test.

- [ ] **Step 4: Implement the responsive shell skeleton**

Desktop grid: 52px command bar, 184px rail, `minmax(0,1fr)` work, optional
352px inspector. Compact grid: 64px rail and 360px overlay. Portrait: 52px
command bar, work scroller, 48px selection dock, 64px bottom nav. Short
landscape: 48px command bar, 60px rail, contained work, 320px overlay. Every
grid child gets `min-width:0; min-height:0`. `RecipeConsoleApp` imports tokens
and reset, reads the URL hook, creates seed state once with lazy `useState`, and
renders accessible provisional work headings for all six views.

Build the separate Vite-served CSS fixture with `recipe-console`, `legacy`, and
`both` modes. It imports the legacy stylesheet before Recipe Console styles and
renders representative controls, forms, tables, statuses, metrics, and dialog
geometry as sibling samples without importing a legacy React panel.

- [ ] **Step 5: Run GREEN verification**

Run every Step 2 command, app typecheck, and app build. Expected: all exit 0,
all viewport/status/isolation cases pass, and no module cap fails.

- [ ] **Step 6: Commit**

```bash
git add apps/rallar-black-box/src/recipe-console/app apps/rallar-black-box/src/recipe-console/design apps/rallar-black-box/src/recipe-console/shell apps/rallar-black-box/src/recipe-console/ui apps/rallar-black-box/test/fixtures packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/recipe-console-responsive-presentation.test.ts tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts
git commit -m "feat: build signal ledger shell"
```

### Task 5: Execute Preview Surface

**Files:**

- Create: `apps/rallar-black-box/src/recipe-console/execute/ExecutePreview.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/execute/ExecutePreview.module.css`
- Create: `apps/rallar-black-box/src/recipe-console/execute/use-execute-preview.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Test: `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts`

**Interfaces:**

```ts
export type ExecutePreviewProps = Readonly<{
    model: ExecutePreviewModel;
    onInspectorChange(content: ReactNode | undefined): void;
}>;
export function useExecutePreview(model: ExecutePreviewModel): Readonly<{
    query: string;
    selectedRecipeId: string;
    selectedTargetIds: readonly string[];
    previewStatus: 'idle' | 'staged-preview' | 'started-preview';
    setQuery(value: string): void;
    selectRecipe(recipeId: string): void;
    toggleTarget(agentId: string): void;
    stagePreview(): void;
    startPreview(): void;
}>;
```

- [ ] **Step 1: Write the failing Execute browser contract**

Add a test named `renders repository-backed Execute preview without services`
and navigate to
`/?provider=simulated&experience=recipe-console&view=execute`; assert catalog
search, selected RTC Realtime Stability, repository alternatives, 2/2 sample
targets, connectivity `Required · not checked in preview`, real command/frame
summary, preview badge, disabled Cancel reason, and one primary Start Preview
action. Click Stage Preview then Start Preview and assert only local preview
status changes; no control-server request occurs.

- [ ] **Step 2: Run RED verification**

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts --grep "renders repository-backed Execute preview without services"
```

Expected: fail because ExecutePreview controls/content do not exist.

- [ ] **Step 3: Implement Execute as three continuous regions**

Render recipe ledger, sample target/preflight plane, and Recipe details
inspector from `ExecutePreviewModel`. `useExecutePreview` owns only UI state:
search query, selected fixture ID, selected sample targets, preflight expansion,
and `'idle' | 'staged-preview' | 'started-preview'`. It makes no fetch. Search
uses case-insensitive fixture label/description/recipe ID matching. Stage and
Start labels include `Preview`; a visible notice says live execution begins in
Iteration 4.

- [ ] **Step 4: Run GREEN verification**

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts --grep "renders repository-backed Execute preview without services"
npx vitest run packages/tests/rallar-black-box/recipe-console-structure.test.ts
npm --workspace rallar-black-box run typecheck
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/rallar-black-box/src/recipe-console/execute apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx tests/playwright/rallar-black-box/recipe-console-shell.spec.ts
git commit -m "feat: add seeded execute workspace"
```

### Task 6: Failed Monitor And Single Inspector Flow

**Files:**

- Create: `apps/rallar-black-box/src/recipe-console/monitor/MonitorPreview.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/monitor/MonitorPreview.module.css`
- Create: `apps/rallar-black-box/src/recipe-console/monitor/FailureInspector.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Modify: `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts`

**Interfaces:**

```ts
export type MonitorPreviewProps = Readonly<{
    model: MonitorPreviewModel;
    selectedFailureKey: string;
    stale: boolean;
    onSelectFailure(key: string, trigger: HTMLButtonElement): void;
    onToggleStale(): void;
    onCloseInspector(): void;
}>;
export type FailureInspectorProps = Readonly<{
    model: MonitorPreviewModel;
    failureKey: string;
}>;
```

- [ ] **Step 1: Write failing Monitor desktop and portrait tests**

Assert the fixed evidence order, Outcome failed, `Failures (2)`, exact two
codes/messages, selected command row, 2-agent phase matrix, stale toggle that
retains evidence, and inspector cause/action/evidence. Assert the legacy RTC
link points to an explicit legacy compatibility URL. At 430×932 assert content
order, `Failure · seed-agent-b` selection dock, no inspector DOM until Inspect
is activated, a modal bottom sheet after activation, Escape close, focus
restoration, Tab/Shift+Tab containment, and matrix-only horizontal overflow.
Name the desktop test `renders failure-first Monitor from canonical evidence`
and the portrait test `opens one portrait failure inspector and restores focus`.
Add `traps and restores focus in tablet and landscape overlays`; at 900×900
and 932×430 it proves Tab/Shift+Tab containment, Escape close, subtree unmount,
and exact trigger focus restoration.

- [ ] **Step 2: Run RED verification**

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts --grep "renders failure-first Monitor|opens one portrait failure inspector|traps and restores focus in tablet and landscape overlays"
```

Expected: fail because MonitorPreview does not exist.

- [ ] **Step 3: Implement failure-first Monitor**

Render verdict, actions, failure ledger, agent×phase matrix, and collapsed
timeline in that order from the canonical model. Select the command failure by
default. Map Minimal fix area deterministically from selected agent/command/
recipe IDs. Treat `Open legacy RTC diagnostic` as compatibility navigation to
`/?provider=simulated&experience=legacy&tab=rtc-diagnostics`; do not import the
legacy panel. A local stale/reconnecting switch adds a StatusMark and last-known
age without replacing failures or matrix. Complete `OverlaySheet` keyboard
behavior here: cycle focus within the open sheet, close on Escape, unmount its
content, and restore focus to the exact Inspect trigger.

- [ ] **Step 4: Run GREEN verification**

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts --grep "renders failure-first Monitor|opens one portrait failure inspector|traps and restores focus in tablet and landscape overlays"
npx vitest run packages/tests/rallar-black-box/recipe-console-structure.test.ts
npm --workspace rallar-black-box run typecheck
```

Expected: all pass and the inspector locator count returns to zero after close.

- [ ] **Step 5: Commit**

```bash
git add apps/rallar-black-box/src/recipe-console/monitor apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx tests/playwright/rallar-black-box/recipe-console-shell.spec.ts
git commit -m "feat: add failure-first monitor preview"
```

### Task 7: Tune Timing Surface And Remaining Routed Views

**Files:**

- Create: `apps/rallar-black-box/src/recipe-console/tune/TunePreview.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/tune/TunePreview.module.css`
- Create: `apps/rallar-black-box/src/recipe-console/tune/TimingDistribution.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/analyze/AnalyzePreview.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/fleet/FleetPreview.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/advanced/AdvancedPreview.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/views/PreviewState.module.css`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Modify: `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts`
- Modify: `packages/tests/rallar-black-box/recipe-console-structure.test.ts`

**Interfaces:**

```ts
export type TunePreviewProps = Readonly<{
    model: TunePreviewModel;
    metric: NonNullable<RecipeConsoleUrlState['timingMetric']>;
    onMetricChange(metric: NonNullable<RecipeConsoleUrlState['timingMetric']>): void;
    onInspectAgent(agentId: string): void;
}>;
export type TimingDistributionProps = Readonly<{
    points: TunePreviewModel['points'];
    histogram: TunePreviewModel['histogram'];
}>;
```

- [ ] **Step 1: Write failing Tune and routing tests**

At 932×430 assert 48px command bar, 60px rail, 52/48 contained panes, Passed
candidate `seed-high-latency-rtc`, no invented baseline, three matrix agents,
exact command-duration percentiles, real SVG distribution, and explicit
unavailable send/drift/cadence evidence when selecting those segments. Assert
Analyze, Fleet, and Advanced each render a distinct bounded module, update
`view` through pushState, restore through popstate, and Advanced offers an
explicit legacy link without mounting legacy DOM.
Name the tests `renders command-duration Tune without invented stream evidence`
and `routes bounded Analyze Fleet and Advanced previews`. In Tune, use arrow
keys to move matrix focus and Enter/Space to open inspection; assert the
selected agent ID and focus position change.
Extend the structure gate to require direct focused view imports, one explicit
switch, and no view registry/barrel or import from `src/legacy/**`.

- [ ] **Step 2: Run RED verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-structure.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts --grep "renders command-duration Tune|routes bounded Analyze Fleet and Advanced"
```

Expected: fail on missing four view modules and matrix keyboard behavior.

- [ ] **Step 3: Implement Tune without fabricated stream evidence**

Render the agent matrix and timing pane. Command uses three per-agent means and
the four canonical percentiles. `TimingDistribution` draws labeled axes,
histogram bars, and point labels from model arrays as code-native SVG. Send
duration, Drift, and Cadence retain their selectable segments but render
`Unavailable in this command-duration seed` plus the reason; do not show zeros.

- [ ] **Step 4: Implement bounded Analyze, Fleet, and Advanced previews**

Analyze renders a clearly seeded `EmptyState` for artifact readiness and lists the
supported core/evidence/partial bundle distinction without accepting files yet.
Fleet renders an `ErrorState` reading `Fleet live data unavailable in offline
preview` with a visible no-control-connection reason and no fabricated region,
agent, or map data. Advanced explains the strangler bridge and links to explicit
legacy Auth, Groups, WebSocket, RTC, Data, CRDT, Media, Server, and tracing
URLs; links are data only and no legacy module is imported.

- [ ] **Step 5: Run GREEN verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-structure.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts --grep "renders command-duration Tune|routes bounded Analyze Fleet and Advanced"
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
```

Expected: all pass; the 932×430 document has no horizontal or vertical overflow.

- [ ] **Step 6: Commit**

```bash
git add apps/rallar-black-box/src/recipe-console/tune apps/rallar-black-box/src/recipe-console/analyze apps/rallar-black-box/src/recipe-console/fleet apps/rallar-black-box/src/recipe-console/advanced apps/rallar-black-box/src/recipe-console/views apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx packages/tests/rallar-black-box/recipe-console-structure.test.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts
git commit -m "feat: complete seeded recipe console views"
```

### Task 8: CSS Load-Order And Chunk-Boundary Hardening

**Files:**

- Create: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-recipe-first.html`
- Create: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation-recipe-first-main.tsx`
- Modify: `apps/rallar-black-box/test/fixtures/recipe-console-css-isolation.html`
- Modify: `apps/rallar-black-box/scripts/assert-experience-chunks.ts`
- Modify: `packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts`

**Interfaces:**

```ts
export type ExperienceChunkGraph = Readonly<{
    main: string;
    mainStaticClosure: ReadonlySet<string>;
    mainDynamicEntries: ReadonlySet<string>;
    mainDynamicExperienceEntries: ReadonlySet<string>;
    recipeConsoleStaticClosure: ReadonlySet<string>;
    legacyStaticClosure: ReadonlySet<string>;
    productionClosure: ReadonlySet<string>;
}>;
export function readExperienceChunkGraph(
    manifestPath: string
): ExperienceChunkGraph;
export function assertExperienceChunkGraph(graph: ExperienceChunkGraph): void;
```

- [ ] **Step 1: Write failing static and browser boundary tests**

Extend the CSS spec with a test named `is independent of stylesheet load order`
that snapshots representative computed styles under legacy-first and
Recipe-Console-first fixture entries and requires identical values. Add
`survives Recipe Console to legacy to Recipe Console navigation` to capture
computed styles before and after real popstate experience round trips. Extend
the chunk tests with non-vacuous static-closure assertions and production
resource interception for both direct experiences.

- [ ] **Step 2: Run RED verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts --grep "stylesheet load order|Recipe Console to legacy|static closure"
```

Expected: fail because the reverse-order entry and stricter closure/round-trip
proof do not exist.

- [ ] **Step 3: Implement the separate QA fixture**

Keep both fixture HTML files outside the production `index.html` input. One
entry imports `styles.css` before Recipe Console tokens/reset; the other imports
the same CSS in reverse order. Both render the existing sample components only
and import neither `App`, `LegacyAppShell`, nor a diagnostic module.

- [ ] **Step 4: Implement manifest/graph assertions**

Refactor the existing script to expose the typed graph interface above while
retaining its CLI. The main static closure excludes both experiences; exactly
two filtered dynamic experience entries exist while unrelated auth/runtime
dynamic entries remain allowed; Recipe Console static closure excludes legacy;
Legacy static closure contains `panel-media`, `panel-rallar-server`, and legacy
distributed-recipes sentinels; the production closure excludes both fixture
entries. The build test invokes the same exported assertions, not duplicated
graph logic.

- [ ] **Step 5: Run GREEN verification**

Run app build, `npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts`,
then both exact Step 2 commands without `--grep`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add apps/rallar-black-box/test/fixtures apps/rallar-black-box/scripts/assert-experience-chunks.ts packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts tests/playwright/rallar-black-box/recipe-console-css-isolation.spec.ts tests/playwright/rallar-black-box/recipe-console-chunks.spec.ts
git commit -m "test: prove recipe console isolation boundaries"
```

### Task 9: History, Keyboard, Concept, And Legacy Regression Gates

**Files:**

- Modify: `apps/rallar-black-box/playwright.recipe-console.config.ts`
- Create: `apps/rallar-black-box/src/recipe-console/app/navigation-keyboard.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/shell/PrimaryNavigation.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/shell/RecipeConsoleShell.module.css`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Create: `tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts`
- Create: `tests/playwright/rallar-black-box/recipe-console-history.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-shell.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts`
- Modify: `tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-navigation-keyboard.test.ts`

**Interfaces:**

```ts
export type RovingNavigationKey =
    | 'ArrowUp'
    | 'ArrowDown'
    | 'ArrowLeft'
    | 'ArrowRight'
    | 'Home'
    | 'End';
export function nextRovingNavigationIndex(
    current: number,
    key: RovingNavigationKey,
    itemCount: number
): number;
```

- [ ] **Step 1: Write the remaining failing automated contracts**

Keep the config restricted to `recipe-console-*.spec.ts`. Add URL history tests
for all six views, v1 copied-state restoration, push/replace/popstate, unknown
query preservation, sensitive query/fragment stripping, and invalid-field
visible fallback. Add keyboard tests for arrow/Home/End roving navigation and
Enter/Space activation, plus the pure wrap/clamp rules. Extend responsive tests
with 900×900 tablet behavior, matrix arrow movement, 44px touch targets,
reduced motion, Analyze EmptyState, Monitor StaleState, Fleet ErrorState, and no
relevant console warning/error.
Instrument `setInterval`/`clearInterval`: direct Recipe Console creates no
legacy 250ms `useNow` interval, legacy does, and a popstate transition from
legacy to Recipe Console clears it while unmounting `.app-shell`.
The concept-fidelity spec also captures four checked-in implementation
baselines at the logical QA viewports: 1440×900 Execute, 1440×900 failed
Monitor, 430×932 portrait Monitor, and 932×430 short-landscape Tune. Use
`toHaveScreenshot` with `maxDiffPixelRatio: 0.01` only after comparing those
renders side by side with the native approved concept images and the
repository-truth deviations; never auto-accept an unexplained snapshot drift.
Add a mocked runner-agent launch test named
`preserves runner-agent launch ticket semantics in legacy` using
`mode=control&workspace=black-box-runner&tab=local-workbench&provider=browser-rallar`
and a fragment containing `agentSessionTicket` plus a second harmless fragment
field. Assert one consume POST under StrictMode, preservation of query and the
second fragment field, ticket-only scrubbing, and final legacy workbench DOM.

- [ ] **Step 2: Run RED verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-navigation-keyboard.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts
```

Expected: fail on the missing pure navigation helper, keyboard behavior, and
unapproved/missing concept baselines; any remaining geometry/history/ticket
gap fails with a specific assertion.

- [ ] **Step 3: Implement the exact remaining behavior**

Implement `nextRovingNavigationIndex` with wraparound for arrows, 0 for Home,
and `itemCount - 1` for End; `itemCount <= 0` returns 0. PrimaryNavigation uses
one roving `tabIndex=0`, focuses the computed item, and activates only on
Enter/Space. RecipeConsoleApp wires copy-link to the URL hook and visible
invalid-state feedback. Make only assertion-driven CSS adjustments in the
owning shell/view CSS Modules; do not loosen geometry, request, focus, or
semantic assertions.

- [ ] **Step 4: Review and check in concept baselines**

Generate the four logical-viewport screenshots, inspect them side by side with
the native concept PNGs through `view_image`, and correct unexplained hierarchy,
density, palette, typography, selected/error, or responsive drift. Check in
baselines only after the repository-backed deviations remain intentional. Use
`maxDiffPixelRatio: 0.01` for subsequent runs.

- [ ] **Step 5: Run GREEN and legacy regression verification**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-navigation-keyboard.test.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts tests/playwright/rallar-black-box/agent-session-ticket-ui.spec.ts
```

Expected: the Recipe Console config collects only `recipe-console-*.spec.ts`;
all new tests and the established 28-test legacy navigation/ticket slice pass.

- [ ] **Step 6: Commit**

```bash
git add apps/rallar-black-box/src/recipe-console/app/navigation-keyboard.ts apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx apps/rallar-black-box/src/recipe-console/shell/PrimaryNavigation.tsx apps/rallar-black-box/src/recipe-console/shell/RecipeConsoleShell.module.css apps/rallar-black-box/playwright.recipe-console.config.ts packages/tests/rallar-black-box/recipe-console-navigation-keyboard.test.ts tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts tests/playwright/rallar-black-box/recipe-console-concept-fidelity.spec.ts-snapshots tests/playwright/rallar-black-box/recipe-console-history.spec.ts tests/playwright/rallar-black-box/recipe-console-shell.spec.ts tests/playwright/rallar-black-box/recipe-console-responsive-accessibility.spec.ts tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts
git commit -m "test: harden recipe console browser contracts"
```

### Task 10: Exploratory QA, Whole-Iteration Review, And Exit Evidence

**Files:**

- Create: `apps/rallar-black-box/docs/recipe-console-iteration-2-fidelity-ledger.md`
- Modify: `playground/rallar-black-box-spa-reimplementation-plan.md`
- Modify: `apps/rallar-black-box/docs/recipe-console-migration-register.md`

**Evidence contract:** The fidelity ledger records Browser availability,
environment/URL/viewports, page identity, meaningful DOM, framework-overlay
absence, console health, screenshots, interaction proof, concept mismatch
rows, automated commands/counts, chunk sizes, skipped live validation, and
remaining risks. Documentation may say complete only after Steps 1–6 pass.

- [ ] **Step 1: Run final in-app Browser QA**

Follow the installed Browser skill. Target flows: explicit Execute → Monitor
failure inspection → Tune timing selection; blank/old alias → legacy; portrait
selection dock → sheet → Escape/focus restoration; tablet overlay; landscape
matrix/timing; CSS isolation in both load orders. Verify URL/title, meaningful
DOM, no framework overlay, console health, screenshot evidence, keyboard and
interaction results. Record the exact Browser failure before any fallback.

- [ ] **Step 2: Complete the fidelity ledger**

Compare all fresh screenshots with all four native concept PNGs. Add explicit
rows for copy/data truth, layout/hierarchy, typography, palette and operational
status semantics, icons, control geometry, responsive transformation, motion,
and CSS isolation. Record the intentional 2/2 sample targets, 5 commands/25
frames, failed-command IDs, Passed Tune state, canonical timing values, and
unavailable RTC stream evidence.

- [ ] **Step 3: Run the full fresh validation set**

```bash
npx vitest run packages/tests/rallar-black-box/experience-route.test.ts packages/tests/rallar-black-box/recipe-console-url-state.test.ts packages/tests/rallar-black-box/recipe-console-url-history.test.ts packages/tests/rallar-black-box/recipe-console-seeded-state.test.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/recipe-console-responsive-presentation.test.ts packages/tests/rallar-black-box/recipe-console-navigation-keyboard.test.ts packages/tests/rallar-black-box/recipe-console-build-boundary.test.ts packages/tests/rallar-black-box/auth-flow.test.ts packages/tests/rallar-black-box/legacy-shell-composition.test.ts packages/tests/rallar-black-box/legacy-shell-structure.test.ts
npm --workspace rallar-black-box run typecheck
npm --workspace rallar-black-box run build
npx tsx apps/rallar-black-box/scripts/assert-experience-chunks.ts
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts
npx playwright test --config apps/rallar-black-box/playwright.config.ts tests/playwright/rallar-black-box/tabbed-navigation.spec.ts tests/playwright/rallar-black-box/agent-session-ticket-ui.spec.ts
npx vitest run packages/tests/rallar-black-box
```

Read complete output and record exact test counts, build module/chunk sizes,
and failures/warnings. Do not infer a broad pass from focused commands.

- [ ] **Step 4: Qualify live/full-stack coverage exactly**

Run the parent plan's live/full-stack command only when the Postgres-backed API,
control server, and app stack are enabled. Otherwise record exactly:
`Set RALLAR_BLACK_BOX_FULL_STACK=1 with Postgres-backed apps/api-v1, apps/rallar-black-box-control-server, and apps/rallar-black-box available.`

- [ ] **Step 5: Dispatch the whole-Iteration-2 review**

Generate one review package from the pre-Iteration-2 design commit through
Task 9 HEAD. A fresh reviewer checks the approved design, all Iteration 2 exit
criteria, strangler/deep-link compatibility, TDD evidence, React/chunk/CSS
quality, accessibility, and test quality. Fix every Critical or Important
finding with a focused failing regression test, rerun its owning command, and
repeat review until spec compliance and task quality are both approved.

- [ ] **Step 6: Rerun affected verification after review fixes**

Rerun every Step 3 command affected by a review fix and then the full Recipe
Console Playwright config. Fresh green output is mandatory after the last code
change.

- [ ] **Step 7: Update exit ledgers from evidence**

Mark Iteration 2 complete only if every exit criterion has fresh proof. Record
test counts, build/chunk sizes, browser viewports, Browser status, concept
deviations, CSS/chunk proof, review verdicts, no cutover/no hide, and the exact
live-service pass or skip. Keep Iterations 3–12 pending and every migration row
uncut.

- [ ] **Step 8: Commit the green Iteration 2 milestone**

```bash
git add apps/rallar-black-box/docs/recipe-console-iteration-2-fidelity-ledger.md playground/rallar-black-box-spa-reimplementation-plan.md apps/rallar-black-box/docs/recipe-console-migration-register.md
git commit -m "docs: record recipe console shell exit"
```
