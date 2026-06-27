# Rallar Black Box Shared-Test Contract Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move reusable Rallar black-box control, distributed-run, artifact-analysis, and recipe-fixture contracts out of `apps/rallar-black-box/src` and into `packages/shared-test`, while keeping the SPA usable and the Hetzner distributed workflow stable.

**Architecture:** `packages/shared-test/rallar-bb-test` becomes the source of truth for browser-agent control protocol, distributed control snapshots, artifact parsing/analysis, monitor derivation, and reusable recipe builders. `apps/rallar-black-box` keeps UI state, React presentation, local persistence, command-center ergonomics, and Hetzner-specific manifest catalog wiring. The control server must depend on `packages/shared-test`, never on the SPA app source.

**Tech Stack:** TypeScript, Vitest, Deno control server, Vite/React SPA, `packages/shared-test/rallar-bb-test`, Hetzner GitHub Actions scripts.

---

Date: 2026-06-27

Status: Ready for implementation after the current `rtc.connect.readiness` validator fix is committed or folded into Iteration 1.

## Review Findings Driving This Plan

- `apps/rallar-black-box/src/control-protocol.ts` drifted from `packages/shared-test/rallar-bb-test/schema.ts`; the shared schema accepted `rtc.connect.readiness`, while browser agents rejected it.
- `apps/rallar-black-box-control-server` imports protocol types and constants from `../../rallar-black-box/src/control-protocol.ts`, creating an app-to-app dependency for a shared runtime contract.
- `ControlRunSnapshot`, `ControlDistributedRunSnapshot`, artifact bundle types, and distributed command-link types exist in app/server modules even though they describe control API and artifact wire formats.
- `distributed-run-artifact-analysis.ts` and the pure monitor/failure/performance derivation in `distributed-recipes.ts` are used by CLI, SPA import, tests, and remote artifact review. They are shared-test analysis logic, not SPA UI logic.
- Recipe builders in `recipe-fixtures.ts` generate portable black-box recipes and are reused by Hetzner manifests. The UI label catalog can stay in the app, but the recipe builders should live with the recipe contract.

## Files By Responsibility

Create or promote into `packages/shared-test/rallar-bb-test`:

- `control-protocol.ts`: control envelope types, protocol version, server/client message parsers, command validator.
- `control-snapshots.ts`: `ControlRunSnapshot`, `ControlDistributedRunSnapshot`, command links, artifact bundle wire types, snapshot bounds.
- `distributed-run-monitor.ts`: pure distributed monitor/report/verdict derivation that only depends on shared control snapshot types.
- `distributed-artifact-analysis.ts`: CI artifact file parsing, JSON/JSONL normalization, failure proposal, performance metrics, markdown rendering.
- `recipe-fixtures.ts`: reusable recipe builders and fixture definitions for smoke, provider parity, realtime, composite evidence, expected failure, cancellable local run.
- `mod.ts`: re-export the new shared modules.

Keep in `apps/rallar-black-box/src`:

- `App.tsx`: React state and rendering.
- `control-client.ts`: browser WebSocket client lifecycle and runtime dispatch.
- `control-run-manager.ts`: HTTP fetch helpers, URLs, SPA row/view models, and operator actions.
- `distributed-recipes.ts`: distributed recipe catalog UI, preflight presentation, filters, and compatibility re-exports during migration.
- `hetzner-distributed-manifests.ts`: Hetzner-specific manifest suite and file paths, importing shared recipe/manifest builders.
- `recipe-fixtures.ts`: compatibility re-export plus SPA-only labels if needed during migration.
- `distributed-run-artifact-analysis.ts`: compatibility re-export until all imports move.

Keep in `apps/rallar-black-box-control-server/src`:

- `control-service.ts`: in-memory service state and orchestration.
- `control-artifacts.ts`: artifact file generation that imports shared artifact bundle types.
- `control-fleet.ts`: fleet report generation can stay server-local for now because it owns server-side rollup generation, but its exported report types already belong to shared-test.

## Iteration 1: Promote Control Protocol Into `packages/shared-test`

Goal: make the exact contract that failed remotely live beside the shared command schema.

### Files

- Create: `packages/shared-test/rallar-bb-test/control-protocol.ts`
- Modify: `packages/shared-test/rallar-bb-test/mod.ts`
- Modify: `apps/rallar-black-box/src/control-protocol.ts`
- Create: `packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`
- Keep existing: `packages/tests/rallar-black-box/control-client.test.ts`

### Steps

- [ ] **Step 1: Add failing shared-test protocol tests**

Create `packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    type ControlCommandEnvelope,
    parseControlServerMessage,
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '../../../packages/shared-test/rallar-bb-test/types.ts';

function envelope(commandId: string, command: RallarBlackBoxTestCommand): ControlCommandEnvelope {
    return {
        kind: 'command',
        protocolVersion: 1,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId,
        command,
    };
}

describe('rallar-bb-test control protocol', () => {
    it('accepts recipe.load containing rtc.connect readiness', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-rtc-readiness-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-readiness-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-readiness',
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-connect-ready',
                            connection: 'rtc',
                            roomId: 'room-1',
                            applicationId: 'rallar-server',
                            workspaceId: 'default',
                            transport: 'realtime',
                            readiness: {
                                minReadyPeers: 1,
                                timeoutMs: 10_000,
                                intervalMs: 100,
                            },
                        },
                    ],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed.ok).toBe(true);
    });

    it('rejects malformed rtc.connect readiness in recipe.load', () => {
        const parsed = parseControlServerMessage(
            JSON.stringify(envelope('recipe-load-rtc-readiness-invalid-1', {
                kind: 'recipe.load',
                commandId: 'recipe-load-rtc-readiness-invalid-1',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-readiness-invalid',
                    commands: [
                        {
                            kind: 'rtc.connect',
                            commandId: 'rtc-connect-invalid-ready',
                            connection: 'rtc',
                            readiness: {
                                timeoutMs: 0,
                            },
                        },
                    ],
                },
            })),
            { runId: 'run-1', agentId: 'agent-1' },
        );

        expect(parsed).toEqual({
            ok: false,
            error: 'Control command payload is invalid: recipe.load.recipe.commands[0]: rtc.readiness.timeoutMs must be >= 1.',
        });
    });
});
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
```

Expected result: FAIL with an import/module-not-found error for `packages/shared-test/rallar-bb-test/control-protocol.ts`.

- [ ] **Step 3: Create the shared protocol module**

Copy the current implementation from `apps/rallar-black-box/src/control-protocol.ts` into `packages/shared-test/rallar-bb-test/control-protocol.ts`, including the `rtc.connect.readiness` fix:

```ts
if (command.kind === 'rtc.connect') {
    const readiness = validateRtcConnectReadiness(command.readiness);
    if (!readiness.ok) {
        return readiness;
    }
}
```

and:

```ts
function validateRtcConnectReadiness(value: unknown): ControlCommandValidationResult {
    if (value === undefined) {
        return { ok: true };
    }
    if (!isRecord(value)) {
        return fail('rtc.readiness must be an object.');
    }

    let result = validateKeys(value, ['minReadyPeers', 'timeoutMs', 'intervalMs'], 'rtc.readiness');
    if (!result.ok) {
        return result;
    }
    for (const field of ['minReadyPeers', 'timeoutMs', 'intervalMs']) {
        result = validateIntegerField(value, field, 'rtc.readiness', { minimum: 1 });
        if (!result.ok) {
            return result;
        }
    }
    return { ok: true };
}
```

- [ ] **Step 4: Export the shared module**

Add to `packages/shared-test/rallar-bb-test/mod.ts`:

```ts
export * from './control-protocol.ts';
```

- [ ] **Step 5: Turn the app protocol file into a compatibility re-export**

Replace `apps/rallar-black-box/src/control-protocol.ts` with:

```ts
export * from '@shared-test/rallar-bb-test/control-protocol.ts';
```

This keeps current SPA imports working while making the package module authoritative.

- [ ] **Step 6: Verify protocol tests and current SPA client tests pass**

Run:

```sh
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts \
  packages/tests/rallar-black-box/control-client.test.ts \
  packages/tests/shared-test/rallar-bb-test-schema.test.ts
```

Expected result: all tests pass.

- [ ] **Step 7: Type-check shared-test and rallar-black-box**

Run:

```sh
npm --workspace @ar-eye-hunter/shared-test run check:ts
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected result: both commands exit zero.

- [ ] **Step 8: Commit**

```sh
git add \
  packages/shared-test/rallar-bb-test/control-protocol.ts \
  packages/shared-test/rallar-bb-test/mod.ts \
  apps/rallar-black-box/src/control-protocol.ts \
  packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts \
  packages/tests/rallar-black-box/control-client.test.ts
git commit -m "refactor: promote black box control protocol"
```

## Iteration 2: Remove App-To-App Control Protocol Imports

Goal: make the control server and SPA consumers import the control protocol from `packages/shared-test`, not from the SPA source tree.

### Files

- Modify: `apps/rallar-black-box/src/control-client.ts`
- Modify: `apps/rallar-black-box/src/control-run-manager.ts`
- Modify: `apps/rallar-black-box/src/distributed-run-seeds.ts`
- Modify: `apps/rallar-black-box-control-server/src/control-service.ts`
- Modify: `apps/rallar-black-box-control-server/src/control-artifacts.ts`
- Modify: `apps/rallar-black-box-control-server/src/main.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-service.test.ts`
- Modify: `apps/rallar-black-box-control-server/test/control-artifacts.test.ts`
- Modify: `packages/tests/rallar-black-box/control-client.test.ts`
- Modify: `packages/tests/rallar-black-box/control-run-manager.test.ts`
- Create: `packages/tests/rallar-black-box/control-protocol-boundary.test.ts`

### Steps

- [ ] **Step 1: Add a boundary test that fails while the control server imports SPA protocol code**

Create `packages/tests/rallar-black-box/control-protocol-boundary.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const FILES = [
    'apps/rallar-black-box-control-server/src/control-service.ts',
    'apps/rallar-black-box-control-server/src/control-artifacts.ts',
    'apps/rallar-black-box-control-server/src/main.ts',
    'apps/rallar-black-box-control-server/test/control-service.test.ts',
    'apps/rallar-black-box-control-server/test/control-artifacts.test.ts',
];

describe('black-box control protocol package boundary', () => {
    it('does not import control protocol from the SPA app into the control server', () => {
        for (const file of FILES) {
            const source = readFileSync(file, 'utf8');
            expect(source, file).not.toContain('../../rallar-black-box/src/control-protocol.ts');
            expect(source, file).not.toContain('../rallar-black-box/src/control-protocol.ts');
        }
    });
});
```

- [ ] **Step 2: Run the boundary test and verify it fails**

Run:

```sh
npx vitest run packages/tests/rallar-black-box/control-protocol-boundary.test.ts
```

Expected result: FAIL naming `apps/rallar-black-box-control-server/src/control-service.ts`.

- [ ] **Step 3: Update SPA imports**

Change imports in SPA files from:

```ts
} from './control-protocol.ts';
```

to:

```ts
} from '@shared-test/rallar-bb-test/control-protocol.ts';
```

Apply this to:

- `apps/rallar-black-box/src/control-client.ts`
- `apps/rallar-black-box/src/control-run-manager.ts`
- `apps/rallar-black-box/src/distributed-run-seeds.ts`

- [ ] **Step 4: Update control-server imports**

Change imports in control-server files from:

```ts
} from '../../rallar-black-box/src/control-protocol.ts';
```

to:

```ts
} from '@shared-test/rallar-bb-test/control-protocol.ts';
```

Apply this to:

- `apps/rallar-black-box-control-server/src/control-service.ts`
- `apps/rallar-black-box-control-server/src/control-artifacts.ts`
- `apps/rallar-black-box-control-server/src/main.ts`
- `apps/rallar-black-box-control-server/test/control-service.test.ts`
- `apps/rallar-black-box-control-server/test/control-artifacts.test.ts`

- [ ] **Step 5: Update tests to import the shared package**

Change tests that only need protocol symbols from:

```ts
} from '../../../apps/rallar-black-box/src/control-protocol.ts';
```

to:

```ts
} from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
```

Apply this to:

- `packages/tests/rallar-black-box/control-client.test.ts`
- `packages/tests/rallar-black-box/control-run-manager.test.ts`

- [ ] **Step 6: Verify boundary and protocol behavior**

Run:

```sh
npx vitest run \
  packages/tests/rallar-black-box/control-protocol-boundary.test.ts \
  packages/tests/rallar-black-box/control-client.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts
```

Expected result: all tests pass.

- [ ] **Step 7: Verify Deno control server imports**

Run:

```sh
cd apps/rallar-black-box-control-server && deno task check
```

Expected result: Deno type-check exits zero.

- [ ] **Step 8: Verify SPA and shared-test type-checks**

Run:

```sh
npm --workspace @ar-eye-hunter/shared-test run check:ts
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected result: both commands exit zero.

- [ ] **Step 9: Commit**

```sh
git add \
  apps/rallar-black-box/src/control-client.ts \
  apps/rallar-black-box/src/control-run-manager.ts \
  apps/rallar-black-box/src/distributed-run-seeds.ts \
  apps/rallar-black-box-control-server/src/control-service.ts \
  apps/rallar-black-box-control-server/src/control-artifacts.ts \
  apps/rallar-black-box-control-server/src/main.ts \
  apps/rallar-black-box-control-server/test/control-service.test.ts \
  apps/rallar-black-box-control-server/test/control-artifacts.test.ts \
  packages/tests/rallar-black-box/control-client.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/control-protocol-boundary.test.ts
git commit -m "refactor: consume shared black box control protocol"
```

## Iteration 3: Promote Control Snapshot And Artifact Wire Types

Goal: put control API response and artifact wire types in shared-test so server, SPA, tests, and future CLI helpers share one model.

### Files

- Create: `packages/shared-test/rallar-bb-test/control-snapshots.ts`
- Modify: `packages/shared-test/rallar-bb-test/mod.ts`
- Modify: `apps/rallar-black-box/src/control-run-manager.ts`
- Modify: `apps/rallar-black-box-control-server/src/control-service.ts`
- Modify: `apps/rallar-black-box-control-server/src/control-artifacts.ts`
- Modify: `apps/rallar-black-box-control-server/src/control-fleet.ts`
- Modify: `apps/rallar-black-box-control-server/src/routes/swagger-routes.ts`
- Create: `packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts`

### Steps

- [ ] **Step 1: Add a shared snapshot type smoke test**

Create `packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

describe('rallar-bb-test control snapshot contracts', () => {
    it('models control and distributed artifact snapshots used by the SPA and control server', () => {
        const run = {
            runId: 'run-1',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
            agents: [],
            commands: [],
            results: [],
            events: [],
            stats: [],
            reports: [],
            heartbeats: [],
        } satisfies ControlRunSnapshot;

        const distributedRun = {
            distributedRunId: 'dist-1',
            controlRunId: 'run-1',
            manifest: {
                distributedRunId: 'dist-1',
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'room-1',
                },
                recipes: [],
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: [],
                },
            },
            state: 'draft',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
            targetAgentIds: [],
            commandLinks: [],
            rollup: {
                ok: false,
                summary: {
                    targeted: 0,
                    acknowledged: 0,
                    ready: 0,
                    running: 0,
                    passed: 0,
                    failed: 0,
                    cancelled: 0,
                    timedOut: 0,
                    disconnected: 0,
                    blockingFailures: 0,
                },
                participants: [],
                recipes: [],
                failures: [],
            },
        } satisfies ControlDistributedRunSnapshot;

        const artifact = {
            artifactSchemaVersion: 2,
            distributedRunId: 'dist-1',
            generatedAtEpochMs: 3,
            files: {
                'distributed-run.json': JSON.stringify(distributedRun),
                'manifest.json': JSON.stringify(distributedRun.manifest),
                'control-run.json': JSON.stringify(run),
                'report.json': '{}',
                'results.jsonl': '',
                'events.jsonl': '',
                'failures.json': '{}',
                'metadata.json': '{}',
            },
        } satisfies ControlDistributedRunArtifactBundle;

        expect(artifact.distributedRunId).toBe('dist-1');
    });
});
```

- [ ] **Step 2: Run the test and verify it fails because the module is missing**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts
```

Expected result: FAIL with an import/module-not-found error.

- [ ] **Step 3: Create `control-snapshots.ts`**

Move these type definitions into `packages/shared-test/rallar-bb-test/control-snapshots.ts`:

- `ControlQueuedCommandSnapshot`
- `ControlAgentSnapshot`
- `ControlRunSnapshot`
- `ControlServerSnapshot`
- `ControlSnapshotBounds`
- `ControlRunArtifactFileName`
- `ControlRunArtifactBundle`
- `ControlDistributedRunCommandPhase`
- `ControlDistributedRunCommandLink`
- `ControlDistributedRunSnapshot`
- `ControlDistributedRunListResponse`
- `ControlDistributedRunArtifactBundle`
- `ControlFleetReportFilter`

Use protocol envelope imports from:

```ts
import type {
    ControlCommandEnvelope,
    ControlEventEnvelope,
    ControlHeartbeatEnvelope,
    ControlResultEnvelope,
} from './control-protocol.ts';
```

Use distributed-run and fleet types from:

```ts
import type {
    RallarBlackBoxControlAgentIdentity,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedRunRollup,
    RallarBlackBoxDistributedRunState,
} from './distributed-run.ts';
import type {
    ControlFleetAgentRunOutcome,
    ControlFleetAggregateReport,
    ControlFleetFailureSignature,
    ControlFleetReportBundle,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
    ControlFleetTimingDistribution,
} from './fleet-report.ts';
```

- [ ] **Step 4: Export the shared snapshots module**

Add to `packages/shared-test/rallar-bb-test/mod.ts`:

```ts
export * from './control-snapshots.ts';
```

- [ ] **Step 5: Replace duplicated type definitions with imports**

In `apps/rallar-black-box/src/control-run-manager.ts`, keep functions and SPA row/view types, but import wire types from:

```ts
import type {
    ControlAgentSnapshot,
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunCommandLink,
    ControlDistributedRunListResponse,
    ControlDistributedRunSnapshot,
    ControlFleetReportFilter,
    ControlRunArtifactBundle,
    ControlRunArtifactFileName,
    ControlRunSnapshot,
    ControlServerSnapshot,
    ControlSnapshotBounds,
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
```

In control-server files, import shared wire types instead of declaring local copies.

- [ ] **Step 6: Verify snapshot consumers**

Run:

```sh
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/distributed-run-seeds.test.ts
cd apps/rallar-black-box-control-server && deno task check
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected result: all commands exit zero.

- [ ] **Step 7: Commit**

```sh
git add \
  packages/shared-test/rallar-bb-test/control-snapshots.ts \
  packages/shared-test/rallar-bb-test/mod.ts \
  apps/rallar-black-box/src/control-run-manager.ts \
  apps/rallar-black-box-control-server/src/control-service.ts \
  apps/rallar-black-box-control-server/src/control-artifacts.ts \
  apps/rallar-black-box-control-server/src/control-fleet.ts \
  apps/rallar-black-box-control-server/src/routes/swagger-routes.ts \
  packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts
git commit -m "refactor: share black box control snapshots"
```

## Iteration 4: Promote Distributed Monitor And Artifact Analysis

Goal: make imported CI artifact analysis, CLI analyzer output, and SPA run panels use one shared artifact/monitor model.

### Files

- Create: `packages/shared-test/rallar-bb-test/distributed-run-monitor.ts`
- Create: `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`
- Modify: `packages/shared-test/rallar-bb-test/mod.ts`
- Modify: `apps/rallar-black-box/src/distributed-recipes.ts`
- Modify: `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts`
- Modify: `apps/rallar-black-box/scripts/analyze-distributed-run-artifacts.ts`
- Modify: `apps/rallar-black-box/src/App.tsx`
- Move or add tests under `packages/tests/shared-test/`

### Steps

- [ ] **Step 1: Add shared artifact-analysis tests that mirror current app behavior**

Create `packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts` by copying the behavior-focused cases from `packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts` and changing imports to:

```ts
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { deriveDistributedRunMonitor } from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
```

Keep these initial cases in the first shared test file:

- JSONL-only failure evidence appears in both analyzer and snapshots.
- Malformed optional JSONL produces parse warnings without hiding verdict.
- SPA derivation failure becomes a warning.
- Info events do not increment warning/error diagnostics.
- Result durations produce p50/p95/p99/max and slowest-agent rows.

- [ ] **Step 2: Run shared artifact tests and verify they fail because modules are missing**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts
```

Expected result: FAIL with import/module-not-found errors.

- [ ] **Step 3: Move pure monitor derivation**

Move these exported functions and their pure helper types from `apps/rallar-black-box/src/distributed-recipes.ts` into `packages/shared-test/rallar-bb-test/distributed-run-monitor.ts`:

- `deriveDistributedRunMonitor`
- `deriveDistributedRunAnalysisReport`
- `deriveRunVerdictView`
- `filterDistributedRuns`
- `compareDistributedRuns`
- `deriveDistributedRunWarningRegressionReport`

Move supporting pure helpers used only by those functions, including event normalization, diagnostic correlation, failure extraction, latency summaries, artifact validation, and distributed run search text.

Keep UI catalog and preflight display helpers in `apps/rallar-black-box/src/distributed-recipes.ts`.

- [ ] **Step 4: Move artifact parsing and analyzer logic**

Move these exports from `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts` into `packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts`:

- `analyzeDistributedRunArtifactFiles`
- `distributedArtifactBundleFromFiles`
- `distributedArtifactSnapshotsFromFiles`
- exported analysis and performance types
- parse warnings, JSONL parsing, failure proposal, performance markdown rendering

Import shared monitor functions from:

```ts
import {
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveRunVerdictView,
} from './distributed-run-monitor.ts';
```

- [ ] **Step 5: Add compatibility re-exports in app files**

Replace `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts` with:

```ts
export * from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
```

In `apps/rallar-black-box/src/distributed-recipes.ts`, re-export shared monitor APIs while keeping app-local catalog functions:

```ts
export {
    compareDistributedRuns,
    deriveDistributedRunAnalysisReport,
    deriveDistributedRunMonitor,
    deriveDistributedRunWarningRegressionReport,
    deriveRunVerdictView,
    filterDistributedRuns,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
export type {
    DistributedRunAnalysisReport,
    DistributedRunMonitor,
    RunVerdictView,
} from '@shared-test/rallar-bb-test/distributed-run-monitor.ts';
```

- [ ] **Step 6: Update direct imports to shared modules**

Update `apps/rallar-black-box/scripts/analyze-distributed-run-artifacts.ts`:

```ts
import {
    analyzeDistributedRunArtifactFiles,
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
```

Update tests that do not need app UI catalog behavior to import shared modules.

- [ ] **Step 7: Verify artifact and monitor behavior**

Run:

```sh
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/rtc-diagnostics.test.ts
npm --workspace @ar-eye-hunter/shared-test run check:ts
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected result: all commands exit zero.

- [ ] **Step 8: Commit**

```sh
git add \
  packages/shared-test/rallar-bb-test/distributed-run-monitor.ts \
  packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts \
  packages/shared-test/rallar-bb-test/mod.ts \
  apps/rallar-black-box/src/distributed-recipes.ts \
  apps/rallar-black-box/src/distributed-run-artifact-analysis.ts \
  apps/rallar-black-box/scripts/analyze-distributed-run-artifacts.ts \
  apps/rallar-black-box/src/App.tsx \
  packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts
git commit -m "refactor: share distributed artifact analysis"
```

## Iteration 5: Promote Reusable Recipe Fixtures And Manifest Builders

Goal: make reusable recipe builders available to SPA, Hetzner manifest generation, shared-test docs, and future runner tooling without importing app files.

### Files

- Create: `packages/shared-test/rallar-bb-test/recipe-fixtures.ts`
- Modify: `packages/shared-test/rallar-bb-test/distributed-run.ts`
- Modify: `packages/shared-test/rallar-bb-test/mod.ts`
- Modify: `apps/rallar-black-box/src/recipe-fixtures.ts`
- Modify: `apps/rallar-black-box/src/hetzner-distributed-manifests.ts`
- Modify: `apps/rallar-black-box/src/distributed-recipes.ts`
- Modify: `apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts`
- Create: `packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts`

### Steps

- [ ] **Step 1: Add shared fixture tests**

Create `packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
} from '../../../packages/shared-test/rallar-bb-test/recipe-fixtures.ts';
import {
    validateJsonSchema,
    RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA,
} from '../../../packages/shared-test/rallar-bb-test/schema.ts';

describe('rallar-bb-test recipe fixtures', () => {
    it('builds live RTC recipes with optional ready-peer contracts', () => {
        const smoke = createRallarBlackBoxRtcSmokeRecipe({
            readyPeerCount: 1,
            readyTimeoutMs: 10_000,
        });
        const connect = smoke.commands.find(command => command.kind === 'rtc.connect');

        expect(connect).toMatchObject({
            kind: 'rtc.connect',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 10_000,
                intervalMs: 100,
            },
        });
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, smoke).ok).toBe(true);
    });

    it('keeps default local fixtures flexible without forced readiness', () => {
        const realtime = createRallarBlackBoxRtcRealtimeRecipe();
        const connect = realtime.commands.find(command => command.kind === 'rtc.connect');

        expect(connect).toMatchObject({ kind: 'rtc.connect' });
        expect((connect as { readiness?: unknown } | undefined)?.readiness).toBeUndefined();
        expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, realtime).ok).toBe(true);
    });

    it('exports a stable fixture catalog for SPA and manifest generation', () => {
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain('composite-evidence');
        expect(RALLAR_BLACK_BOX_RECIPE_FIXTURES.map(fixture => fixture.fixtureId)).toContain('expected-failure');
    });
});
```

- [ ] **Step 2: Run fixture tests and verify they fail because the module is missing**

Run:

```sh
npx vitest run packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts
```

Expected result: FAIL with an import/module-not-found error.

- [ ] **Step 3: Move reusable recipe builders**

Move from `apps/rallar-black-box/src/recipe-fixtures.ts` to `packages/shared-test/rallar-bb-test/recipe-fixtures.ts`:

- `RallarBlackBoxRecipeFixture`
- `RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID`
- realtime rate/duration constants
- `RallarBlackBoxRtcRealtimeRecipeOptions`
- `RallarBlackBoxLiveRecipeOptions`
- `normalizeRallarBlackBoxRtcRealtimeDurationSeconds`
- `createRallarBlackBoxRtcSmokeRecipe`
- `createRallarBlackBoxProviderParityLiveRecipe`
- `createRallarBlackBoxRtcRealtimeRecipe`
- `RALLAR_BLACK_BOX_RECIPE_FIXTURES`
- `recipeFixtureText`

Keep `RALLAR_BLACK_BOX_MANUAL_COMMAND_EXAMPLE` app-local unless another package uses it.

- [ ] **Step 4: Promote manifest builder primitives**

Move `buildDistributedRunManifest` and its pure input types from `apps/rallar-black-box/src/distributed-recipes.ts` to `packages/shared-test/rallar-bb-test/distributed-run.ts`.

Add an export from `packages/shared-test/rallar-bb-test/mod.ts` through the existing `distributed-run.ts` export.

- [ ] **Step 5: Add app compatibility re-exports**

Replace moved exports in `apps/rallar-black-box/src/recipe-fixtures.ts` with:

```ts
export {
    createRallarBlackBoxProviderParityLiveRecipe,
    createRallarBlackBoxRtcRealtimeRecipe,
    createRallarBlackBoxRtcSmokeRecipe,
    normalizeRallarBlackBoxRtcRealtimeDurationSeconds,
    RALLAR_BLACK_BOX_RECIPE_FIXTURES,
    RALLAR_BLACK_BOX_RTC_REALTIME_DEFAULT_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_INTERVAL_MS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MAX_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_MIN_DURATION_SECONDS,
    RALLAR_BLACK_BOX_RTC_REALTIME_RATE_HZ,
    RALLAR_BLACK_BOX_RTC_REALTIME_RECIPE_FIXTURE_ID,
    recipeFixtureText,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
export type {
    RallarBlackBoxLiveRecipeOptions,
    RallarBlackBoxRecipeFixture,
    RallarBlackBoxRtcRealtimeRecipeOptions,
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
```

Retain any SPA-only examples below those exports.

- [ ] **Step 6: Update Hetzner manifest catalog imports**

Change `apps/rallar-black-box/src/hetzner-distributed-manifests.ts` to import recipe builders from:

```ts
} from '@shared-test/rallar-bb-test/recipe-fixtures.ts';
```

and `buildDistributedRunManifest` from:

```ts
import { buildDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
```

- [ ] **Step 7: Verify manifests remain deterministic**

Run:

```sh
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
npm --workspace @ar-eye-hunter/shared-test run check:ts
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
```

Expected result: all commands exit zero and manifest check reports checked manifests.

- [ ] **Step 8: Commit**

```sh
git add \
  packages/shared-test/rallar-bb-test/recipe-fixtures.ts \
  packages/shared-test/rallar-bb-test/distributed-run.ts \
  packages/shared-test/rallar-bb-test/mod.ts \
  apps/rallar-black-box/src/recipe-fixtures.ts \
  apps/rallar-black-box/src/hetzner-distributed-manifests.ts \
  apps/rallar-black-box/src/distributed-recipes.ts \
  packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts
git commit -m "refactor: share black box recipe fixtures"
```

## Iteration 6: Update Documentation And Public Import Guidance

Goal: make future contributors import contracts from `packages/shared-test` first and keep the SPA as a consumer.

### Files

- Modify: `packages/shared-test/architecture.md`
- Modify: `packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md`
- Modify: `packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md`
- Modify: `docs/rallar-hetzner-distributed-recipes.md`
- Modify: `skills/rallar-hetzner-ops/references/github-action-workflow.md`
- Modify: `AGENTS.md`

### Steps

- [ ] **Step 1: Document ownership in shared-test architecture**

Add this section to `packages/shared-test/architecture.md`:

```md
## Rallar Black Box Contract Ownership

`packages/shared-test/rallar-bb-test` owns the reusable control-agent and
distributed-run contracts:

- command and recipe schemas;
- control protocol envelopes and parsers;
- control run and distributed run snapshot wire types;
- distributed artifact parsing and analysis;
- reusable black-box recipe fixtures and builders.

`apps/rallar-black-box` is a consumer and operator UI. It may expose
compatibility re-exports, but new shared protocol or artifact behavior should
start in `packages/shared-test`.

`apps/rallar-black-box-control-server` must import shared contracts from
`@shared-test/rallar-bb-test/*`, not from the SPA source tree.
```

- [ ] **Step 2: Update Hetzner docs**

In `docs/rallar-hetzner-distributed-recipes.md` and `skills/rallar-hetzner-ops/references/github-action-workflow.md`, add:

```md
The checked-in Hetzner manifests are generated from shared-test recipe builders
and shared distributed-run manifest contracts. If a manifest fails validation in
remote browser agents, check `packages/shared-test/rallar-bb-test/schema.ts`,
`control-protocol.ts`, and the generated manifest JSON together; these must
agree before dispatching on `main`.
```

- [ ] **Step 3: Update AGENTS.md boundary guidance**

Add one bullet under the package/app boundary section:

```md
- Keep Rallar black-box control protocol, distributed-run artifact contracts,
  reusable recipe fixtures, and artifact analysis in `packages/shared-test`;
  `apps/rallar-black-box` should consume those contracts for UI/operator flows.
```

- [ ] **Step 4: Verify docs and static boundary**

Run:

```sh
npx vitest run \
  packages/tests/rallar-black-box/control-protocol-boundary.test.ts \
  packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts \
  packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts \
  packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts \
  packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts
git diff --check
```

Expected result: all commands exit zero.

- [ ] **Step 5: Commit**

```sh
git add \
  packages/shared-test/architecture.md \
  packages/shared-test/rallar-bb-test/docs/distributed-run-contract.md \
  packages/shared-test/rallar-bb-test/docs/schema-and-capabilities.md \
  docs/rallar-hetzner-distributed-recipes.md \
  skills/rallar-hetzner-ops/references/github-action-workflow.md \
  AGENTS.md
git commit -m "docs: clarify black box shared-test ownership"
```

## Iteration 7: Remove Compatibility Shims And Enforce The Boundary

Goal: delete app-local compatibility re-exports after all internal consumers use package imports.

### Files

- Delete or reduce: `apps/rallar-black-box/src/control-protocol.ts`
- Delete or reduce: `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts`
- Reduce: `apps/rallar-black-box/src/recipe-fixtures.ts`
- Modify: tests that still import app shims
- Modify: boundary test to enforce no new app shim imports for shared contracts

### Steps

- [ ] **Step 1: Find remaining imports from app-local contract shims**

Run:

```sh
rg -n "src/control-protocol|src/distributed-run-artifact-analysis|src/recipe-fixtures" apps packages scripts
```

Expected result before edits: only intentional SPA UI imports remain for `recipe-fixtures.ts`; no control server imports point at SPA contract files.

- [ ] **Step 2: Update remaining shared-contract imports**

Replace remaining imports of:

```ts
apps/rallar-black-box/src/control-protocol.ts
apps/rallar-black-box/src/distributed-run-artifact-analysis.ts
```

with:

```ts
@shared-test/rallar-bb-test/control-protocol.ts
@shared-test/rallar-bb-test/distributed-artifact-analysis.ts
```

- [ ] **Step 3: Remove obsolete app shims if no imports remain**

Delete `apps/rallar-black-box/src/control-protocol.ts` and `apps/rallar-black-box/src/distributed-run-artifact-analysis.ts` only after `rg` shows no imports. Keep `apps/rallar-black-box/src/recipe-fixtures.ts` if it still contains SPA-only examples or labels.

- [ ] **Step 4: Strengthen boundary test**

Extend `packages/tests/rallar-black-box/control-protocol-boundary.test.ts`:

```ts
const FORBIDDEN_IMPORTS = [
    '../../rallar-black-box/src/control-protocol.ts',
    '../../../apps/rallar-black-box/src/control-protocol.ts',
    '../../../apps/rallar-black-box/src/distributed-run-artifact-analysis.ts',
];

for (const forbidden of FORBIDDEN_IMPORTS) {
    expect(source, `${file} imports ${forbidden}`).not.toContain(forbidden);
}
```

- [ ] **Step 5: Run full focused validation**

Run:

```sh
npx vitest run \
  packages/tests/shared-test/rallar-bb-test-control-protocol.test.ts \
  packages/tests/shared-test/rallar-bb-test-control-snapshots.test.ts \
  packages/tests/shared-test/rallar-bb-test-distributed-artifact-analysis.test.ts \
  packages/tests/shared-test/rallar-bb-test-recipe-fixtures.test.ts \
  packages/tests/rallar-black-box/control-client.test.ts \
  packages/tests/rallar-black-box/control-run-manager.test.ts \
  packages/tests/rallar-black-box/distributed-artifact-analysis.test.ts \
  packages/tests/rallar-black-box/distributed-recipes.test.ts \
  packages/tests/rallar-black-box/hetzner-distributed-manifests.test.ts \
  packages/tests/rallar-black-box/rtc-diagnostics.test.ts
npm --workspace @ar-eye-hunter/shared-test run check
npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit
cd apps/rallar-black-box-control-server && deno task check
npx tsx apps/rallar-black-box/scripts/write-hetzner-distributed-manifests.ts --check
git diff --check
```

Expected result: all commands exit zero.

- [ ] **Step 6: Commit**

```sh
git add -A
git commit -m "refactor: enforce black box shared-test boundaries"
```

## Iteration 8: Remote Verification After Merge To `main`

Goal: prove the package-boundary work did not regress the Hetzner distributed workflow and that `rtc.connect.readiness` reaches browser agents successfully.

### Steps

- [ ] **Step 1: Push or merge all completed iterations to `main`**

Confirm:

```sh
git status --short
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
```

Expected result: clean tree on the branch intended for merge; after merge, remote `main` contains all iterations.

- [ ] **Step 2: Run health manifest full rollout**

Run:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json \
  --ref main
```

Expected result: workflow passes; two agents register and health/stats complete.

- [ ] **Step 3: Run realtime manifest fast path**

Run:

```sh
scripts/hetzner/dispatch-distributed-recipe.sh \
  apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json \
  --ref main \
  --fast
```

Expected result: staged recipe is accepted by browser agents; no `rtc.connect has unsupported field: readiness` diagnostic appears.

- [ ] **Step 4: Analyze artifacts**

Download the run artifacts:

```sh
gh run download <run-id> -D /private/tmp/rallar-run-<run-id>
```

Inspect:

```sh
find /private/tmp/rallar-run-<run-id> -maxdepth 4 -type f | sort
sed -n '1,220p' /private/tmp/rallar-run-<run-id>/*analysis*/summary.md
sed -n '1,260p' /private/tmp/rallar-run-<run-id>/*analysis*/fix-proposal.md
```

Expected result for success: analysis includes performance output with p50/p95/p99/max or a clear reason if no RTT samples exist.

Expected result for failure: failure evidence is not protocol-schema drift; it cites a real runtime, RTC, readiness, or command failure.

## Final Acceptance Criteria

- The control server has no imports from `apps/rallar-black-box/src/control-protocol.ts`.
- Shared schema and runtime parser accept the same `rtc.connect.readiness` shape.
- Control snapshots and distributed artifact bundles are typed in `packages/shared-test`.
- CLI analyzer, SPA import, and tests use shared artifact analysis logic.
- Hetzner manifests are generated from shared recipe builders and remain deterministic.
- The SPA remains operational and `npx tsc -p apps/rallar-black-box/tsconfig.json --noEmit` passes.
- `npm --workspace @ar-eye-hunter/shared-test run check` passes.
- `cd apps/rallar-black-box-control-server && deno task check` passes.
- Remote Hetzner health and realtime readiness runs no longer fail because of unsupported `readiness`.

## Plan Self-Review

- Spec coverage: The review findings are covered by Iterations 1 through 7, and remote validation is covered by Iteration 8.
- Placeholder scan: No task relies on an undefined future step; every iteration names concrete files, imports, tests, and validation commands.
- Type consistency: Control protocol, control snapshots, artifact analysis, monitor derivation, and fixture builder names are stable across tasks and re-exported from `packages/shared-test/rallar-bb-test/mod.ts`.
