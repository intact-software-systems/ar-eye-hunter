# Rallar Black Box Headless Browser Memory Report

Findings captured on 2026-06-28.

## Summary

The current Hetzner headless browser worker uses `rallar-black-box` as a full operator SPA. Each
headless agent loads and mounts the same React application that contains recipe authoring,
distributed-run monitoring, artifact browsing, topology visualization, REST workbench, CRDT panels,
fleet reporting, and other operator UI.

That preserves functionality, but it is not a minimal recipe executor/reporter. Local measurements
show that the dominant memory cost is the full SPA renderer for each browser agent, not recipe
execution itself.

Recommended direction:

1. Keep the current operator SPA for human use.
2. Add a separate headless browser entry for control-agent execution and reporting.
3. Reuse the existing browser runtime, control protocol, and reporting client.
4. Update Hetzner worker startup to load the headless entry by default.
5. Add bundle-boundary tests proving the headless entry excludes React UI, Sigma, graphology, and
   artifact/report browser surfaces.

This should reduce per-agent memory without losing browser-native execution behavior.

## Functional Target

The target shape is:

- A headless browser is a recipe executor.
- A headless browser is a reporter of that run.
- It keeps browser-native behavior where needed: auth, local storage, WebSocket, WebRTC, Rallar
  browser facade, CRDT/director support, command deadlines, event streaming, stats, heartbeats, and
  final reports.
- It does not carry operator-only extras: navigation UI, panels, topology graph, artifact import UI,
  prompt authoring, REST workbench, fleet dashboards, and hidden React surfaces.

## Current Execution Path

Hetzner starts the worker through `scripts/hetzner/controller/09-start-headless-workers.sh`, which
creates a systemd service running:

```sh
npm --workspace rallar-black-box run worker:headless
```

The worker in `apps/rallar-black-box/scripts/headless-worker.ts` opens one browser context per
agent:

```ts
const context = await browser.newContext();
const page = await context.newPage();
await page.goto(agent.url, { waitUntil: "domcontentloaded" });
```

The generated agent URL in `apps/rallar-black-box/src/headless-worker-config.ts` sets:

```txt
mode=control
provider=browser-rallar
autoConnect=1
tab=local-workbench
```

That lands in `apps/rallar-black-box/src/main.tsx`, which mounts `App.tsx`. `App.tsx` is the full
operator app and currently weighs 27,773 lines. Even when the requested route is local workbench,
the module graph eagerly includes many operator-only surfaces.

The actual executor/reporting primitives already exist below the UI:

- `apps/rallar-black-box/src/runtime-store.ts`
  - creates the runtime
  - configures browser-rallar
  - creates `RallarBlackBoxControlClient`
  - bootstraps remote control-agent mode
- `apps/rallar-black-box/src/control-client.ts`
  - registers the agent
  - streams heartbeats, stats, events, results, and terminal reports
  - dispatches control-server commands to the runtime
- `packages/shared-test/rallar-bb-test/browser-adapter.ts`
  - executes browser-native commands for RTC, WebSocket, HTTP, CRDT, director, health, close, and
    reset

The implementation issue is packaging, not missing executor capability.

## Control-Server Background Fetch Analysis

Static analysis shows two different categories of control-server communication.

Required executor/reporter traffic:

- `apps/rallar-black-box/src/control-client.ts` opens the control WebSocket, registers the agent,
  dispatches commands, sends heartbeats, stats, events, results, and terminal reports.
- `apps/rallar-black-box/src/control-client.ts` can also POST a final report to
  `reportUploadUrl` when configured. That is reporting traffic, not operator monitoring.
- `apps/rallar-black-box/scripts/headless-worker.ts` polls `/runs/{runId}` every 500 ms while
  waiting for the browser page to appear as a connected agent. This is a readiness check outside the
  page and stops once registration is observed.

Operator-only REST fetches:

- `RunnerRecipesPanel` does an initial readiness refresh when mounted. That probes the app API,
  optionally probes TURN at `/api/webrtc/ice`, calls `fetchControlServerSnapshot`, and may call
  `fetchControlRunSnapshot`.
- `RunnerRunsPanel` does an initial distributed-run refresh when mounted. It calls
  `fetchDistributedRuns`, may call `fetchDistributedRun`, may call `fetchControlRunSnapshot`, and
  polls every `RUNNER_DISTRIBUTED_POLL_MS` (currently 1,000 ms) while the selected distributed run is
  non-terminal. It can also auto-load distributed artifacts for terminal runs.
- `RunnerFleetPanel` refreshes fleet reports when mounted, calling `fetchFleetReports` and
  `fetchControlServerSnapshot`.
- `RunManagerPanel` refreshes when mounted, calling `fetchControlServerSnapshot` and
  `fetchControlRunSnapshot`.
- `DistributedRecipesPanel` refreshes when mounted, calling `fetchControlServerSnapshot`,
  `fetchDistributedRuns`, and usually `fetchControlRunSnapshot`.

For the current Hetzner headless worker path, `createHeadlessWorkerAgentUrl` sets
`tab=local-workbench`. The tab router maps that legacy tab to visible tab `advanced` and advanced
surface `workbench`. With that route:

- `RunnerRecipesPanel`, `RunnerRunsPanel`, and `RunnerFleetPanel` are not mounted because their
  active-tab guards fail.
- The `RunManagerPanel` and `DistributedRecipesPanel` copies inside `RunnerAdvancedPanel` are not
  mounted because their active-surface guards fail.
- Therefore the major control-server REST polling/fetch loops are present in the SPA bundle but
  should not fire during the default headless `local-workbench` distributed-run executor path.

This does not make the current SPA route minimal. `App.tsx` still mounts the full shell, many hidden
operator panels, and a top-level `useNow(250)` timer. It also ships all the fetch-capable operator
code in the same browser page. If a headless agent is launched with `tab=runs`, `tab=fleet`,
`tab=recipes`, `tab=run-manager`, `tab=distributed-recipes`, or an equivalent advanced surface, it
will start doing operator REST reads that are unnecessary for recipe execution/reporting.

Conclusion: do not remove the control WebSocket, heartbeats, stats, event/result/report streaming,
optional final report upload, or the worker readiness check. Those are part of the executor/reporter
contract. The REST snapshot, distributed-run history, fleet report, artifact browsing, and readiness
probe panels are operator UI responsibilities and should be excluded from the dedicated headless
browser entry.

## Bundle Findings

Fresh production build:

```sh
npm --workspace rallar-black-box run build
```

passed, with Vite warning about large chunks.

Current production output:

| Asset | Minified | Gzip |
| --- | ---: | ---: |
| `index-*.js` | 994.16 kB | 232.84 kB |
| `rallar-*.js` | 641.30 kB | 159.46 kB |
| `react-*.js` | 189.63 kB | 59.65 kB |
| `index-*.css` | 105.58 kB | 16.33 kB |

Module-level esbuild metafile analysis showed the eager SPA entry pulls in these large groups:

| Group | Source bytes |
| --- | ---: |
| `apps/rallar-black-box` | 1,485,230 |
| `node_modules/react-dom` | 1,086,103 |
| `packages/shared` | 1,081,206 |
| `packages/shared-test` | 889,608 |
| `packages/shared-web` | 635,863 |
| `node_modules/sigma` | 212,770 |
| `node_modules/graphology` | 178,150 |
| `node_modules/@js-temporal` | 128,868 |

Top individual inputs included:

- `apps/rallar-black-box/src/App.tsx`
- `packages/shared-web/browser/rallar.ts`
- `packages/shared-test/rallar-bb-test/distributed-run-monitor.ts`
- `packages/shared-test/rallar-bb-test/browser-adapter.ts`
- `packages/shared-test/rallar-bb-test/runtime.ts`
- `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`
- `node_modules/sigma`
- `node_modules/graphology`

The headless executor does need the browser adapter, runtime, shared-web browser facade, and control
protocol. It should not need React DOM, `App.tsx`, Sigma, graphology, topology panels, artifact
browser UI, or authoring/report dashboard modules.

## Memory Measurements

These measurements were taken locally with production `rallar-black-box` served to headless
Chromium. They are not a direct Hetzner VM measurement, so absolute RSS can differ on Linux. The
scaling shape is still useful because it isolates browser baseline, SPA load, agent registration,
and recipe execution.

| Scenario | Browser RSS | JS heap | DOM nodes |
| --- | ---: | ---: | ---: |
| Blank Chromium | 255.3 MiB | 0.5 MiB | 4 |
| Browser-rallar login gate | 332.4 MiB | 3.9 MiB | 80 |
| Simulated control-agent full UI | 408.4 MiB | 8.0 MiB | 9,045 |
| Browser-rallar registered agent x1 | 420.8 MiB | 9.1 MiB | 9,046 |
| Browser-rallar registered agents x2 | 656.7 MiB | 18.3 MiB | 18,092 |
| Browser-rallar registered agents x3 | 892.7 MiB | 27.6 MiB | 27,138 |
| x2 after health recipe passed | 680.5 MiB | 18.8 MiB | 18,886 |

Important observations:

- One full registered browser-rallar agent used about 420.8 MiB RSS locally.
- Each additional agent added roughly one renderer process at about 210-224 MiB RSS.
- Browser-side JS heap was modest: about 9 MiB per page after garbage collection.
- DOM size was not modest: about 9,000 nodes per agent before a real recipe run.
- Running a two-agent health recipe added only about 24 MiB RSS over idle registration.
- Recipe reporting added fewer than 800 DOM nodes across two pages in the measured health run.

So the memory problem is mostly the full mounted SPA per agent, not health recipe execution or
control-server reporting.

## Health Recipe Evidence

The local two-agent health run exercised:

- `recipe.load`
- `recipe.run`
- command dispatch
- result streaming
- event streaming
- stats streaming
- terminal reports
- distributed artifact export

The distributed run passed. Control-server counts after the run:

| Item | Count |
| --- | ---: |
| Agents | 2 |
| Commands | 4 |
| Results | 6 |
| Events | 28 |
| Stats | 6 |
| Reports | 2 |

Exported artifact payload sizes:

| File | Bytes |
| --- | ---: |
| `control-run.json` | 251,956 |
| `events.jsonl` | 67,174 |
| `report.json` | 24,775 |
| `results.jsonl` | 6,856 |
| `distributed-run.json` | 3,278 |
| `manifest.json` | 1,277 |
| `failures.json` | 542 |
| `metadata.json` | 467 |

This confirms the existing reporting path works and can be preserved by a thinner entry.

## Recommended Architecture

Add a headless-only browser entry beside the operator SPA:

```txt
apps/rallar-black-box/
  headless-agent.html
  src/headless-agent.ts
```

`headless-agent.ts` should:

1. Resolve the same bootstrap config as the current URL/env path.
2. Create `createRallarBlackBoxBrowserTestRuntime`.
3. Install `createSpaBrowserRallarRuntime`.
4. Install the browser Rallar event bridge.
5. Execute `reset` and `configure` with the existing remote-control config.
6. Connect `RallarBlackBoxControlClient`.
7. Keep a tiny status surface in the DOM for Playwright readiness only.
8. Avoid importing `App.tsx`, React, React DOM, Sigma, graphology, topology, artifact browser UI,
   fleet UI, prompt authoring, REST workbench, and CRDT editor UI.

To avoid behavior drift, extract shared UI-free helpers from `runtime-store.ts` rather than
reimplementing them:

- `resolveRallarBlackBoxBootstrapConfig`
- `rallarConfigFromBootstrap`
- `remoteControlConfig`
- `bootstrapFleetMetadata`
- `validateRallarBlackBoxProviderConfig`

Suggested module split:

```txt
apps/rallar-black-box/src/control-agent-bootstrap.ts
apps/rallar-black-box/src/control-agent-runtime.ts
apps/rallar-black-box/src/runtime-store.ts
```

`runtime-store.ts` can keep the React-facing store. The headless entry should depend on the new
UI-free modules plus `control-client.ts`.

## Hetzner Worker Change

Update `createHeadlessWorkerAgentUrl` to prefer the new route:

```txt
https://blackbox.rallar.intactss.com/headless-agent.html?...control params...
```

Keep a compatibility switch during rollout:

```txt
RALLAR_BLACK_BOX_HEADLESS_ENTRY=spa | headless-agent
```

Default should become `headless-agent` after local and Hetzner distributed recipe validation.

The current `confirmWorkbenchRegistrationUi` in `headless-worker.ts` should be replaced or bypassed
for the headless entry. The control-server snapshot is already the authoritative readiness signal:

- agent exists in `/runs/{runId}`
- agent is connected
- agent status is not failed
- identity has expected `applicationId`, `workspaceId`, and `groupId`

That avoids requiring any operator UI to prove a headless worker is ready.

## Validation Plan

Run focused validation in this order:

1. Build and bundle boundary:
   - `npm --workspace rallar-black-box run build`
   - test that the headless output does not include `App.tsx`, `react-dom`, `sigma`, or
     `graphology`
2. Local control-agent registration:
   - start local memory API
   - start local control server
   - load `headless-agent.html` in headless Chromium
   - assert `/runs/{runId}` reports the agent connected
3. Local distributed health:
   - run a two-agent health distributed manifest
   - assert final state `passed`
   - assert reports/events/results are exported
4. Local RTC smoke:
   - run a two-agent RTC smoke recipe
   - assert no feature loss in browser-native command execution
5. Hetzner fast path:
   - dispatch `apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json`
   - then dispatch `03-rtc-smoke-2-agent.json`
   - compare browser RSS/process count before and after the headless entry rollout

## Expected Impact

The lower bound is not zero because Chromium itself is expensive. The measured blank local
headless Chromium baseline was 255.3 MiB RSS.

The practical target is to remove the full SPA renderer overhead:

- eliminate thousands of DOM nodes per agent
- eliminate React DOM and operator UI bundle parsing/execution
- eliminate Sigma/graphology/topology import cost
- keep control-agent runtime and reporting behavior unchanged

The best success metric is per-agent incremental RSS on the Hetzner server, measured after:

1. registration
2. health recipe pass
3. RTC smoke pass
4. short realtime stream pass

If the headless entry still shows about the same per-agent RSS, the next investigation should move
from SPA packaging to Chromium process model, browser contexts versus pages, WebRTC runtime state,
and Linux shared-memory accounting.

## Caveats

- These measurements are local macOS headless-shell measurements, not direct Hetzner Linux
  measurements.
- No downloaded GitHub Actions distributed artifact was available in the workspace for a remote
  `analysis.json`/`performance.md` comparison.
- Existing uncommitted shared-test artifact-analysis changes were present before this report and
  were not touched.

## Bottom Line

The current design works, but it is carrying operator UI into every recipe executor. For the stated
goal -- "a headless browser should be a recipe executor and reporter of that run, without loss of
functionality and with no extra" -- the next implementation should create a dedicated headless
browser entry that reuses the existing runtime/control-client stack and leaves the React operator
surface behind.
