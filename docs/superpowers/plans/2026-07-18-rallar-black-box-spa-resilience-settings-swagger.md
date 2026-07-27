# Rallar Black Box SPA Resilience, Settings, and Swagger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Recipe Console read production-scale controller state without false timeouts, expose actionable diagnostics and non-secret defaults/logout in the new UI, and make Swagger requests use the browser's current origin.

**Architecture:** Poll a zero-evidence controller index, derive selected/active/compared control run IDs, fetch only those detailed runs, and publish explicit evidence provenance through the existing serialized query service. Resolve versioned personal defaults with URL/deployment precedence inside the Recipe Console app, expose them through a focused account/settings panel, and use an origin-relative OpenAPI server URL.

**Tech Stack:** TypeScript, React 19, Vite, CSS Modules, Vitest, Deno tests/check, Playwright, Browser plugin.

## Global Constraints

- Preserve existing control routes and public snapshot response shapes.
- The default control-read timeout is exactly `20_000` ms and configurable from `1_000` through `120_000` ms.
- Index polling sends exactly zero for commands, results, events, stats, reports, and heartbeats.
- Detailed evidence uses commands `120`, results `120`, events `160`, stats `60`, reports `40`, and heartbeats `80`.
- URL parameters override matching `VITE_RALLAR_*` deployment values; deployment values override personal defaults; personal defaults override built-in bootstrap defaults.
- Never persist credentials, tokens, passwords, auth sessions, client IDs, session IDs, tickets, endpoint query strings, or endpoint fragments.
- Keep URL-selected endpoint credential-provenance protections unchanged.
- Reuse the current Recipe Console visual system; do not add imagery, gradients, badges, or unrelated redesign work.
- UI acceptance requires a visible-control Playwright workflow plus Browser desktop/mobile QA.
- Keep unrelated changes in the user's main checkout out of this branch.

---

### Task 1: Index-first snapshot reader and evidence provenance

**Files:**
- Create: `apps/rallar-black-box/src/recipe-console/control/control-detail-run-ids.ts`
- Modify: `apps/rallar-black-box/src/control-run-manager.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/control/control-api.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/control/control-snapshot-reader.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/control/control-snapshot-revision.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/control/control-snapshot-validation.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx`
- Test: `packages/tests/rallar-black-box/recipe-console-control-detail-run-ids.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-control-api.test.ts`

**Interfaces:**
- Consumes: `fetchControlServerSnapshot`, `fetchControlRunSnapshot`, `ControlServerSnapshot`, `RecipeConsoleUrlState`, and the existing `ControlAuthorizedTransport`.
- Produces: `recipeConsoleDetailRunIds(input): readonly string[]`, `mergeControlRunDetails(index, details): ControlServerSnapshot`, `RECIPE_CONSOLE_CONTROL_INDEX_BOUNDS`, and `RecipeConsoleControlRunEvidenceProvenance`.

- [ ] **Step 1: Write failing detail-selection tests**

Create `recipe-console-control-detail-run-ids.test.ts` with fixtures proving stable de-duplication for explicit control selection, bootstrap selection, selected/compared distributed runs, and every non-terminal distributed run:

```ts
expect(recipeConsoleDetailRunIds({
  snapshot,
  bootstrapRunId: 'bootstrap-run',
  urlState: {
    v: 1,
    experience: 'recipe-console',
    view: 'tune',
    controlRunId: 'explicit-run',
    distributedRunId: 'selected-distributed',
    compareLeft: 'left-distributed',
    compareRight: 'right-distributed',
  },
})).toEqual([
  'explicit-run',
  'bootstrap-run',
  'selected-owner',
  'left-owner',
  'right-owner',
  'active-owner',
]);
```

Also prove IDs absent from the index are omitted and terminal distributed runs are not added only because they exist.

- [ ] **Step 2: Run the new helper test and verify RED**

Run:

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-control-detail-run-ids.test.ts
```

Expected: FAIL because `control-detail-run-ids.ts` does not exist.

- [ ] **Step 3: Implement the pure detail selector and merge helper**

Implement stable, data-in/data-out helpers:

```ts
export function recipeConsoleDetailRunIds(input: Readonly<{
  snapshot: ControlServerSnapshot;
  bootstrapRunId?: string;
  urlState: RecipeConsoleUrlState;
}>): readonly string[] {
  const available = new Set(input.snapshot.runs.map(run => run.runId));
  const distributedById = new Map(
    (input.snapshot.distributedRuns ?? []).map(run => [run.distributedRunId, run]),
  );
  const ids: string[] = [];
  const add = (runId: string | undefined) => {
    if (runId && available.has(runId) && !ids.includes(runId)) ids.push(runId);
  };
  add(input.urlState.controlRunId);
  add(input.bootstrapRunId);
  for (const distributedRunId of [
    input.urlState.distributedRunId,
    input.urlState.compareLeft,
    input.urlState.compareRight,
  ]) add(distributedRunId ? distributedById.get(distributedRunId)?.controlRunId : undefined);
  for (const run of input.snapshot.distributedRuns ?? []) {
    if (!isDistributedRunTerminalState(run.state)) add(run.controlRunId);
  }
  return ids;
}

export function mergeControlRunDetails(
  index: ControlServerSnapshot,
  details: readonly ControlRunSnapshot[],
): ControlServerSnapshot {
  const byId = new Map(details.map(run => [run.runId, run]));
  return { ...index, runs: index.runs.map(run => byId.get(run.runId) ?? run) };
}
```

- [ ] **Step 4: Run the helper test and verify GREEN**

Run the command from Step 2. Expected: PASS.

- [ ] **Step 5: Write failing reader tests for index/detail request order and provenance**

Extend `recipe-console-control-api.test.ts` so `readSnapshot()` is expected to request:

```text
https://control.test/runs?limitCommands=0&limitResults=0&limitEvents=0&limitStats=0&limitReports=0&limitHeartbeats=0
https://control.test/runs/run-a?limitCommands=120&limitResults=120&limitEvents=160&limitStats=60&limitReports=40&limitHeartbeats=80
```

Configure `detailRunIds: () => ['run-a']`, return an index run with empty evidence and a detailed run with one event, then assert:

```ts
expect(result.snapshot.runs[0].events).toHaveLength(1);
expect(result.runEvidence).toEqual({
  detailedRunIds: ['run-a'],
  indexOnlyRunIds: ['run-b'],
});
```

Add cases proving the same abort signal reaches both requests, a malformed detailed run becomes `RecipeConsoleControlProtocolError`, detailed reads reuse the root endpoint authorization state, and an exact detail-document change produces a new opaque revision even when the root index document is byte-identical.

- [ ] **Step 6: Run the focused reader tests and verify RED**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-control-api.test.ts
```

Expected: FAIL because the root still uses detailed bounds and `detailRunIds`/`runEvidence` do not exist.

- [ ] **Step 7: Implement index-first reads**

In `control-api.ts`, split bounds and extend config:

```ts
export const RECIPE_CONSOLE_CONTROL_INDEX_BOUNDS = {
  commands: 0, results: 0, events: 0, stats: 0, reports: 0, heartbeats: 0,
} as const satisfies ControlSnapshotBounds;

export const RECIPE_CONSOLE_CONTROL_DETAIL_BOUNDS = {
  commands: 120, results: 120, events: 160, stats: 60, reports: 40, heartbeats: 80,
} as const satisfies ControlSnapshotBounds;

export type RecipeConsoleControlApiConfig = Readonly<{
  controlUrl?: string;
  manualToken?: string;
  apiBaseUrl: string;
  authSession?: AuthSession;
  indexBounds?: ControlSnapshotBounds;
  bounds?: ControlSnapshotBounds;
  fetchFn?: ControlRunManagerFetch;
  credentialPolicy: RecipeConsoleControlCredentialPolicy;
  detailRunIds?(snapshot: ControlServerSnapshot): readonly string[];
}>;
```

In `control-run-manager.ts`, read detailed runs through `readJsonResponseDocument`, call `rememberControlResponseDocument`, and preserve the existing exported return type. In the reader, validate the index, complete distributed-run fallback as today, derive IDs only after distributed runs are available, fetch detail runs in stable serial order through the existing `runsAuthorization`, validate each by wrapping it as `{ runs: [detail] }`, merge them, and publish mandatory `runEvidence` on the result.

Extend `ControlSnapshotRevisionSession.associate` with `detailDocuments?: readonly unknown[]`; cache and compare their exact raw texts in stable run-ID order along with the root/fallback document. Associate the merged snapshot with the root, fallback when present, and detailed documents so cache invalidation remains evidence-correct.

In `ControlConnectionProvider`, supply a callback that parses the current Recipe Console URL at query time and calls `recipeConsoleDetailRunIds` with `bootstrap.bootstrapRunId`.

- [ ] **Step 8: Run focused API, query, selection, history, monitor, and tune tests**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-control-api.test.ts packages/tests/rallar-black-box/recipe-console-control-query.test.ts packages/tests/rallar-black-box/recipe-console-control-selection.test.ts packages/tests/rallar-black-box/recipe-console-history-model.test.ts packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts packages/tests/rallar-black-box/recipe-console-tune-model.test.ts
```

Expected: all tests PASS with no warnings.

- [ ] **Step 9: Commit the snapshot slice**

```bash
git add apps/rallar-black-box/src/control-run-manager.ts apps/rallar-black-box/src/recipe-console/control packages/tests/rallar-black-box/recipe-console-control-api.test.ts packages/tests/rallar-black-box/recipe-console-control-detail-run-ids.test.ts
git commit -m "fix: scale recipe console control reads"
```

---

### Task 2: Configurable timeout and visible diagnostic

**Files:**
- Modify: `apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/control/ControlCommandContext.tsx`
- Test: `packages/tests/rallar-black-box/recipe-console-control-query.test.ts`
- Test: `packages/tests/rallar-black-box/recipe-console-control-command-context.test.ts`

**Interfaces:**
- Consumes: `ControlQuerySnapshot.lastError` and a `controlReadTimeoutMs` provider prop.
- Produces: `CONTROL_QUERY_DEFAULT_REQUEST_TIMEOUT_MS = 20_000` and timeout-specific status copy.

- [ ] **Step 1: Add failing default/configuration and copy tests**

Assert the exported default is `20_000`, that provider source passes its prop to `createControlQueryService`, and that:

```ts
expect(controlCommandStatus({
  ...offlineQuery,
  reachability: 'unreachable',
  lastError: { kind: 'timeout', message: 'Control request timed out after 20000 ms.' },
})).toEqual({
  status: 'failed',
  label: 'Timed out after 20 s · unreachable',
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-control-query.test.ts packages/tests/rallar-black-box/recipe-console-control-command-context.test.ts
```

Expected: FAIL on the old `4_000` default and generic offline label.

- [ ] **Step 3: Implement minimal timeout wiring and copy**

Rename the constant to `CONTROL_QUERY_DEFAULT_REQUEST_TIMEOUT_MS`, accept optional `controlReadTimeoutMs`, and pass:

```ts
requestTimeoutMs: controlReadTimeoutMs ?? CONTROL_QUERY_DEFAULT_REQUEST_TIMEOUT_MS
```

Add a pure timeout label parser that uses the structured error message's millisecond value and formats whole seconds without changing other status branches.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run Step 2. Expected: PASS.

- [ ] **Step 5: Commit the diagnostic slice**

```bash
git add apps/rallar-black-box/src/recipe-console/control packages/tests/rallar-black-box/recipe-console-control-query.test.ts packages/tests/rallar-black-box/recipe-console-control-command-context.test.ts
git commit -m "fix: expose recipe console read timeouts"
```

---

### Task 3: Versioned non-secret Recipe Console preferences

**Files:**
- Create: `apps/rallar-black-box/src/recipe-console/app/recipe-console-preferences.ts`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Test: `packages/tests/rallar-black-box/recipe-console-preferences.test.ts`

**Interfaces:**
- Consumes: `RecipeConsoleControlBootstrap`, browser `Storage`, URL search, and Vite environment values.
- Produces: `readRecipeConsolePreferences`, `writeRecipeConsolePreferences`, `resetRecipeConsolePreferences`, `resolveRecipeConsolePreferenceState`, and `RECIPE_CONSOLE_PREFERENCES_STORAGE_KEY`.

- [ ] **Step 1: Write failing persistence, validation, and precedence tests**

Use a memory `Storage` adapter and prove:

```ts
expect(readRecipeConsolePreferences(storage)).toEqual({
  controlUrl: 'wss://personal.test/control',
  apiBaseUrl: 'https://api.personal.test',
  applicationId: 'personal-app',
  workspaceId: 'personal-workspace',
  groupId: 'personal-group',
  controlReadTimeoutMs: 20_000,
});
```

Reject endpoint credentials/query/fragment, unknown keys, token-like keys, non-integer timeouts, and out-of-range timeouts. Prove each field's URL and environment lock separately and prove reset removes the key.

- [ ] **Step 2: Run the new test and verify RED**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-preferences.test.ts
```

Expected: FAIL because the preferences module does not exist.

- [ ] **Step 3: Implement the versioned allow-list and resolver**

Use the storage document:

```ts
type StoredRecipeConsolePreferences = Readonly<{
  version: 1;
  values: RecipeConsolePreferences;
}>;
```

Parse every field explicitly. Endpoint parsing must accept only `http:`, `https:`, `ws:`, or `wss:`, reject username/password/search/hash, and normalize trailing slash consistently. Return field-specific locks:

```ts
type RecipeConsolePreferenceLocks = Readonly<Record<
  'controlUrl' | 'apiBaseUrl' | 'applicationId' | 'workspaceId' | 'groupId',
  'url' | 'deployment' | undefined
>>;
```

Map `groupId` to URL `roomId` and environment `VITE_RALLAR_ROOM_ID`. Keep `controlReadTimeoutMs` personal because there is no existing URL/deployment contract for it.

- [ ] **Step 4: Wire preferences into RecipeConsoleApp**

Initialize state lazily from `globalThis.localStorage`, resolve effective bootstrap values, and pass `controlReadTimeoutMs` to `ControlConnectionProvider`. Expose save/reset callbacks and preference state to `RecipeConsoleWorkspace`. Storage exceptions become a concise settings error string without crashing.

- [ ] **Step 5: Run tests and build; verify GREEN**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-preferences.test.ts packages/tests/rallar-black-box/recipe-console-control-api.test.ts
npm --workspace rallar-black-box run build
```

Expected: tests PASS; Vite build exits 0.

- [ ] **Step 6: Commit the preferences slice**

```bash
git add apps/rallar-black-box/src/recipe-console/app packages/tests/rallar-black-box/recipe-console-preferences.test.ts
git commit -m "feat: persist recipe console personal defaults"
```

---

### Task 4: Account, settings, and logout UI

**Files:**
- Create: `apps/rallar-black-box/src/recipe-console/shell/AccountSettingsPanel.tsx`
- Create: `apps/rallar-black-box/src/recipe-console/shell/AccountSettingsPanel.module.css`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleApp.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/app/RecipeConsoleWorkspace.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/shell/RecipeConsoleShell.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/shell/TopCommandBar.tsx`
- Modify: `apps/rallar-black-box/src/recipe-console/shell/TopCommandBar.module.css`
- Test: `packages/tests/rallar-black-box/recipe-console-structure.test.ts`
- Test: `tests/playwright/rallar-black-box/recipe-console-settings.spec.ts`

**Interfaces:**
- Consumes: preference values/locks/save/reset, `AuthSession`, `authBusy`, `authError`, `onLogout`, and `query.lastError`.
- Produces: visible `Open account and settings`, `Save defaults`, `Reset defaults`, and `Logout` controls.

- [ ] **Step 1: Write failing structure tests for complete prop flow**

Assert that `RecipeConsoleApp` destructures and forwards `authBusy`, `authError`, and `onLogout`; `RecipeConsoleWorkspace` supplies account/settings props to `RecipeConsoleShell`; and `TopCommandBar` renders `AccountSettingsPanel`. Assert no import from `legacy/` and no token/password/session persistence strings in the new module.

- [ ] **Step 2: Run the structure test and verify RED**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-structure.test.ts
```

Expected: FAIL because the props are still dropped and the panel does not exist.

- [ ] **Step 3: Implement the panel in the existing design system**

The panel owns only form/open state. Render:

```tsx
<IconButton
  aria-expanded={open}
  aria-label="Open account and settings"
  icon="sliders"
  onClick={() => setOpen(true)}
  ref={triggerRef}
/>
```

The conditional panel uses `role="dialog"`, `aria-modal="true"`, a close button, a backdrop, Escape handling, initial focus, focus cycling, and trigger-focus restoration. Use labeled inputs for Control URL, API URL, Application, Workspace, Group, and Control read timeout (ms). Managed fields are disabled with `Managed by URL` or `Managed by deployment`. Account copy shows username or `No authenticated account`, shows only `Session active`/`No active session`, and never prints the session/client IDs.

Buttons call the supplied callbacks. Disable logout while `authBusy`; show `authError`, validation errors, storage error, and `query.lastError.message` in semantic status regions.

- [ ] **Step 4: Run structure tests and verify GREEN**

Run Step 2. Expected: PASS.

- [ ] **Step 5: Write the visible-control Playwright workflow and verify RED**

Create a test that routes control index/detail reads, opens the panel through the top-right button, changes Application and timeout, clicks `Save defaults`, verifies visible effective context plus the exact versioned local-storage allow-list, reloads to prove restoration, clicks `Reset defaults`, presses Escape and verifies focus restoration. A browser-rallar authenticated fixture must click `Logout` and verify the existing login heading is visible.

- [ ] **Step 6: Run the Playwright test and make it GREEN**

```bash
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-settings.spec.ts
```

Expected: PASS in Chromium.

- [ ] **Step 7: Review React behavior against the installed guidance**

Confirm lazy storage initialization, primitive effect dependencies, functional state updates where callbacks depend on prior state, no inline component definitions, no duplicate global listeners, and a versioned/minimal local-storage schema.

- [ ] **Step 8: Commit the UI slice**

```bash
git add apps/rallar-black-box/src/recipe-console tests/playwright/rallar-black-box/recipe-console-settings.spec.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts
git commit -m "feat: add recipe console account settings"
```

---

### Task 5: Same-origin Swagger execution and compact runtime JSON

**Files:**
- Modify: `apps/rallar-black-box-control-server/src/routes/swagger-routes.ts`
- Modify: `apps/rallar-black-box-control-server/src/main.ts`
- Test: `apps/rallar-black-box-control-server/test/swagger-routes.test.ts`
- Test: `apps/rallar-black-box-control-server/test/api-black-box.test.ts`

**Interfaces:**
- Consumes: OpenAPI 3.1 relative server URL resolution.
- Produces: `servers: [{ url: '/', description: 'Current control server' }]` and compact runtime JSON.

- [ ] **Step 1: Change Swagger expectations first and verify RED**

Update the first Swagger test and route response test to expect `/` even when the internal request URL is HTTP:

```ts
const spec = controlOpenApiSpec(
  new Request('http://control.internal/api/openapi.json'),
) as { servers?: readonly { url: string; description: string }[] };
assertEquals(spec.servers, [{
  url: '/',
  description: 'Current control server',
}]);
```

Add an API black-box assertion that `/runs` response text does not contain pretty-print indentation after a fixture run exists.

- [ ] **Step 2: Run Deno tests and verify RED**

```bash
deno test test/swagger-routes.test.ts test/api-black-box.test.ts --allow-run --allow-net --allow-env --allow-read --allow-write
```

Expected: Swagger server URL and compact JSON assertions FAIL.

- [ ] **Step 3: Implement the minimal fixes**

Remove request-origin derivation and return the constant relative server URL:

```ts
export function controlOpenApiSpec(_request: Request): JsonRecord {
  return {
    ...CONTROL_OPENAPI_SPEC,
    servers: [{ url: '/', description: 'Current control server' }],
  };
}
```

Change the control server's runtime `jsonResponse` to `JSON.stringify(value)`. Keep content type, CORS, status, and error semantics unchanged.

- [ ] **Step 4: Run Deno tests and verify GREEN**

Run Step 2. Expected: all tests PASS.

- [ ] **Step 5: Run the control-server check**

```bash
deno task check
```

Expected: exit 0.

- [ ] **Step 6: Commit the Swagger/controller slice**

```bash
git add apps/rallar-black-box-control-server/src apps/rallar-black-box-control-server/test
git commit -m "fix: keep swagger requests on the current origin"
```

---

### Task 6: Integrated verification and rendered evidence

**Files:**
- Verify all files changed by Tasks 1-5.
- Save temporary screenshots outside the repository under `/Users/knut-helgevik/.codex/visualizations/2026/07/18/019f74d8-03e8-7c70-927a-be37bd067923/`.

**Interfaces:**
- Consumes: the completed app, local control server, approved design, and before screenshots.
- Produces: fresh test/build evidence and desktop/mobile/Swagger after screenshots.

- [ ] **Step 1: Run the focused Vitest suite**

```bash
npx vitest run packages/tests/rallar-black-box/recipe-console-control-detail-run-ids.test.ts packages/tests/rallar-black-box/recipe-console-control-api.test.ts packages/tests/rallar-black-box/recipe-console-control-query.test.ts packages/tests/rallar-black-box/recipe-console-control-command-context.test.ts packages/tests/rallar-black-box/recipe-console-preferences.test.ts packages/tests/rallar-black-box/recipe-console-structure.test.ts packages/tests/rallar-black-box/recipe-console-control-selection.test.ts packages/tests/rallar-black-box/recipe-console-history-model.test.ts packages/tests/rallar-black-box/recipe-console-monitor-state.test.ts packages/tests/rallar-black-box/recipe-console-tune-model.test.ts
```

Expected: all files and tests PASS.

- [ ] **Step 2: Run server verification**

```bash
deno task test
deno task check
```

Run from `apps/rallar-black-box-control-server`. Expected: exit 0 for both.

- [ ] **Step 3: Run app build and UI workflow**

```bash
npm --workspace rallar-black-box run build
npx playwright test --config apps/rallar-black-box/playwright.recipe-console.config.ts tests/playwright/rallar-black-box/recipe-console-settings.spec.ts tests/playwright/rallar-black-box/recipe-console-control.spec.ts tests/playwright/rallar-black-box/recipe-console-status-semantics.spec.ts
```

Expected: build and all selected Playwright tests PASS.

- [ ] **Step 4: Start local app/control services and run Browser QA**

Define the target flows:

```text
Recipe Console -> account/settings button -> save/reset defaults -> visible effective context and restored focus.
Recipe Console -> delayed control read -> visible timeout diagnostic.
Swagger UI -> Runs / GET /runs -> Try it out -> Execute -> same-origin request and rendered 200 response.
```

Use the Browser plugin first. Verify URL/title, meaningful DOM, no framework overlay, console health, and the target interaction at desktop 1440×900 and mobile 390×844. Capture `recipe-console-settings-desktop.png`, `recipe-console-settings-mobile.png`, `recipe-console-timeout-diagnostic.png`, and `swagger-ui-after.png` outside the repo.

- [ ] **Step 5: Compare accepted design and rendered screenshots**

Use `view_image` on the existing accepted Recipe Console screenshot and each latest render. Record at least these comparison points: command-bar density, 44 px control sizing, typography, white/surface palette, six-pixel radius/borders, right-panel placement, mobile bottom-sheet behavior, focus treatment, visible copy, and absence of invented decoration.

- [ ] **Step 6: Run final diff and requirement audit**

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Re-read the approved spec and mark each goal as verified or name the exact remaining gap. Confirm no unrelated main-checkout files appear in this worktree diff.

- [ ] **Step 7: Complete the branch using Superpowers**

Invoke `superpowers:verification-before-completion`, then `superpowers:finishing-a-development-branch`. Present integration choices only after fresh verification evidence exists.
