import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    readFullStackApiBaseUrl,
    readFullStackSpaBaseUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import { readFullStackControlBaseUrl } from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import {
    createBudgetedManifestEntry,
    HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    toControllerAgentIds
} from '../../../apps/rallar-black-box/src/hetzner/hetzner-manifest-entry.ts';
import { decodeRallarBlackBoxTestResult } from '../../../packages/shared-test/rallar-bb-test/composite-results.ts';
import {
    createPublicationWorkloadRecipes,
    type PublicationWorkloadRecipes
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/publication-workload/create-publication-workload-recipes.ts';
import { toPublicationWorkloadFigures } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/publication-workload/to-publication-workload-figures.ts';
import type { PublicationWorkloadParameters } from '../../../packages/shared-test/rallar-bb-test/conformance/alm/publication-workload/validate-publication-workload-parameters.ts';
import type { ControlDistributedRunCommandLink } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestResult } from '../../../packages/shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import {
    decodeJsonValue,
    decodeRecord
} from '../../../packages/shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import type { ApiJsonValue } from '../../../packages/shared/api/api-json-value.ts';

import { computeAllLocalAlmObservationDeadlines } from './compute-all-local-alm-observation-deadlines.ts';
import { uniqueSuffix } from './full-stack-helpers.ts';
import {
    startOwnedHeadlessWorker,
    stopOwnedHeadlessWorker,
    waitForOwnedWorkerAgents,
    type OwnedHeadlessWorkerCleanup,
    type OwnedHeadlessWorkerLaunch
} from './owned-headless-worker.ts';
import { readNativeDistributedRun, runOwnedWorkerManifest } from './run-owned-worker-manifest.ts';

const AGENT_COUNT = 3;

/**
 * The family's local point: one publisher and two subscribers, 60 live frames 500 ms apart on `rtc`. The family has
 * no default, so every value is this proof's own choice.
 */
const LOCAL_POINT: PublicationWorkloadParameters = {
    group: HETZNER_DISTRIBUTED_MANIFEST_GROUP,
    participantCount: AGENT_COUNT,
    carrier: 'rtc',
    publishIntervalMs: 500,
    windowMs: 30_000,
    publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
    payloadBytes: 256,
    ttlMs: 5_000,
    minReceiveRatio: 0.95,
    minSendSuccessRatio: 0.95,
    readyTimeoutMs: 45_000
};

/** The commands whose result values the figures record is read from, and each role's last `stats`. */
const RESULT_COMMAND_IDS = {
    publisherFrames: 'publication-workload-publisher-frames',
    publisherStats: 'publication-workload-publisher-stats',
    subscriberReceived: 'publication-workload-subscriber-received',
    subscriberStats: 'publication-workload-subscriber-stats'
} as const;

/** What one agent's recipe left behind: the history it ran under and the result of each of its commands. */
interface AgentRecipeRun {
    readonly agentId: string;
    readonly recipeId: string | undefined;
    readonly eventHistoryMode: ApiJsonValue | undefined;
    readonly results: readonly RallarBlackBoxTestResult[];
}

// The terminal wait is the manifest's own terminal timeout, and the harness abort, the owned worker's idle exit and
// this test's limit are derived from it. The API must be new to the run: every launch gives the same users a new
// password.
test('runs the publication workload local point on three agents and records its figures', async ({}, testInfo) => {
    test.skip(
        process.env.RALLAR_BLACK_BOX_FULL_STACK !== '1' || process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS !== '1',
        'Opt-in standalone headless full-stack observation required'
    );
    expect(
        process.env.RALLAR_BLACK_BOX_STORAGE_DIR,
        'The control server keeps whole results only in recorder storage, selected before it starts'
    ).toBeTruthy();
    const recipes = createPublicationWorkloadRecipes(LOCAL_POINT).fold((issues) => {
        throw new Error(`The local point is no point of the family: ${JSON.stringify(issues)}`);
    }, (valid) => valid);
    const artifactDir = testInfo.outputPath('observation');
    const manifestPath = path.join(artifactDir, 'source-manifest.json');
    const manifest = createLocalPointManifest(recipes, manifestPath);
    const deadlines = computeAllLocalAlmObservationDeadlines(manifest);
    test.setTimeout(deadlines.testTimeoutMs);
    const controlBaseUrl = readFullStackControlBaseUrl();
    const launch: OwnedHeadlessWorkerLaunch = {
        services: { apiBaseUrl: readFullStackApiBaseUrl(), spaBaseUrl: readFullStackSpaBaseUrl(), controlBaseUrl },
        manifest,
        agentCount: AGENT_COUNT,
        idleExitMs: deadlines.harnessTimeoutMs
    };
    const harnessAbort = new AbortController();
    const harnessTimer = setTimeout(() => harnessAbort.abort(), deadlines.harnessTimeoutMs);
    const worker = startOwnedHeadlessWorker(launch);
    worker.on('error', () => harnessAbort.abort());
    let cleanup: OwnedHeadlessWorkerCleanup | undefined;

    try {
        await waitForOwnedWorkerAgents(worker, launch, harnessAbort.signal);
        const operation = await runOwnedWorkerManifest({
            controlBaseUrl,
            manifestPath,
            manifestText: `${JSON.stringify(manifest, null, 2)}\n`,
            artifactDir,
            rtcCaptureMode: undefined,
            terminalTimeoutMs: deadlines.terminalTimeoutMs,
            signal: harnessAbort.signal,
            prepareEvidenceExport: async () => {
                cleanup = await stopOwnedHeadlessWorker(worker);
                expect(cleanup, 'The worker ends before its evidence is read').toBe('reaped');
            }
        });
        expect(operation.left, 'The distributed run passes and exports its evidence').toBeUndefined();
        const distributed = await readNativeDistributedRun(artifactDir);
        expect(distributed.state, 'The run passed').toBe('passed');

        const agentRuns = await readAgentRecipeRuns(
            artifactDir,
            distributed.commandLinks.filter((link) => link.phase === 'start')
        );
        const publisherRun = agentRuns.find((run) => run.recipeId === recipes.publisher.recipe.recipeId);
        expect(
            publisherRun,
            `One agent ran the publisher's recipe ${recipes.publisher.recipe.recipeId}; the agents ran ${
                agentRuns.map((run) => `${run.agentId}: ${run.recipeId}`).join(', ')
            }`
        ).toBeDefined();
        const figures = toPublicationWorkloadFigures({
            parameters: LOCAL_POINT,
            rooms: [{
                publishers: [{
                    agentId: publisherRun!.agentId,
                    loop: readResultValue(publisherRun!, RESULT_COMMAND_IDS.publisherFrames),
                    stats: readResultValue(publisherRun!, RESULT_COMMAND_IDS.publisherStats)
                }],
                subscribers: agentRuns
                    .filter((run) => run.recipeId === recipes.subscriber.recipe.recipeId)
                    .map((run) => ({
                        agentId: run.agentId,
                        received: readResultValue(run, RESULT_COMMAND_IDS.subscriberReceived)
                    }))
            }]
        });
        const figuresPath = testInfo.outputPath('publication-workload-figures.json');
        await writeFile(figuresPath, `${JSON.stringify(figures.right ?? { issues: figures.left }, null, 2)}\n`);
        await testInfo.attach('publication-workload-figures.json', {
            path: figuresPath,
            contentType: 'application/json'
        });

        expect(figures.right, `The run gives a figures record; issues: ${(figures.left ?? []).join('; ')}`)
            .toBeDefined();
        const { configured: { plan }, measured: { rooms: [room] } } = figures.right!;
        expect(room.publishers[0].publicationStage.counters.admitted, 'The stage handed enough frames to a carrier')
            .toBeGreaterThanOrEqual(plan.minAcceptedSends);
        expect(room.subscribers, 'Every subscriber of the point has figures').toHaveLength(plan.subscriberCount);
        for (const { agentId, observed, unrecordedSamples, sampleAgeMs } of room.subscribers) {
            expect(observed, `${agentId} received enough of the frames`).toBeGreaterThanOrEqual(
                plan.minExpectedInboundMessages
            );
            expect(observed, `${agentId} received no more messages than frames`).toBeLessThanOrEqual(plan.frameCount);
            expect(unrecordedSamples, `Every message ${agentId} received gave an age`).toBe(0);
            expect(sampleAgeMs.kind, `${agentId} recorded delivered sample ages`).toBe('recorded');
            // A stamp that is no send time reads as an age far above any window.
            expect(
                sampleAgeMs.kind === 'recorded' && sampleAgeMs.max < LOCAL_POINT.windowMs,
                `The oldest sample of ${agentId} is younger than the window: ${JSON.stringify(sampleAgeMs)}`
            ).toBe(true);
        }
        for (const run of agentRuns) {
            expect(run.eventHistoryMode, `${run.agentId} ran its recipe on a full event history`).toBe('full');
            expect(
                readResultValue(
                    run,
                    run === publisherRun ? RESULT_COMMAND_IDS.publisherStats : RESULT_COMMAND_IDS.subscriberStats
                ),
                `The page of ${run.agentId} kept every event, and its event capture has no gap`
            ).toMatchObject({
                eventHistory: { policy: { mode: 'full' }, evictedEvents: 0, capture: { status: 'continuous' } }
            });
        }
    }
    finally {
        clearTimeout(harnessTimer);
        harnessAbort.abort();
        // A worker already reaped is not stopped again: the stop signals its process group, and that id may by now
        // name another group.
        if (cleanup !== 'reaped') {
            cleanup = await stopOwnedHeadlessWorker(worker);
        }
        // Soft: a throw from here would replace the failure the test ended on.
        expect.soft(cleanup, 'The test leaves no worker running').not.toBe('unreaped');
    }
});

/**
 * The entry names no event history of its own: a manifest's history replaces the `full` one the subscriber's recipe
 * asks for. A control run holds a barrier id once, so each run of the test is a control run of its own.
 */
function createLocalPointManifest(
    recipes: PublicationWorkloadRecipes,
    filePath: string
): RallarBlackBoxDistributedRunManifest {
    const runId = `publication-workload-${uniqueSuffix()}`;
    const entry = createBudgetedManifestEntry({
        filePath,
        title: `Publication workload ${AGENT_COUNT}-agent local point`,
        description: 'One publisher and two subscribers: 60 live frames 500 ms apart on rtc.',
        distributedRunId: `${runId}-${AGENT_COUNT}-agent`,
        recipes: [recipes.publisher.recipe, recipes.subscriber.recipe],
        agentCount: AGENT_COUNT,
        profiles: ['alm', 'messages.rtc', 'publication-workload', `${AGENT_COUNT}-agent`],
        live: true,
        targetAgentIds: toControllerAgentIds(AGENT_COUNT),
        targetPolicyMode: 'role-map',
        rolePattern: 'one-sender-many-receivers',
        mainline: false,
        diagnostic: false,
        expectedFailure: false,
        stress: false,
        barrier: true,
        groupAssertions: [],
        metadata: { family: 'publication-workload' }
    });
    return { ...entry.manifest, controlRunId: runId };
}

/**
 * Read from the recorder's `results.jsonl`, where an agent's start row keeps the result of its recipe whole under
 * `fullResult`: the control run's own snapshot keeps a recipe's results without their values.
 */
async function readAgentRecipeRuns(
    artifactDir: string,
    starts: readonly ControlDistributedRunCommandLink[]
): Promise<readonly AgentRecipeRun[]> {
    const rows = (await readFile(path.join(artifactDir, 'results.jsonl'), 'utf8')).split('\n').filter(Boolean)
        .map((row) => decodeRecord(JSON.parse(row)));
    return starts.map((start) => {
        const row = rows.findLast((entry) => entry.agentId === start.agentId && entry.commandId === start.commandId);
        const startRow = `the row of ${start.agentId} for its start command ${start.commandId}`;
        expect(row, `results.jsonl holds ${startRow}`).toBeDefined();
        expect(row?.fullResult, `A fullResult is on ${startRow}`).toBeTruthy();
        const recipeRun = decodeRecord(decodeRecord(row?.fullResult).value);
        return {
            agentId: start.agentId,
            recipeId: start.recipeId,
            eventHistoryMode: decodeJsonValue(decodeRecord(decodeRecord(recipeRun.invocation).eventHistory).mode),
            results: (Array.isArray(recipeRun.results) ? recipeRun.results : []).flatMap((result) =>
                decodeRallarBlackBoxTestResult(result).fold(() => [], (decoded) => [decoded])
            )
        };
    });
}

/** Absent when the agent's recipe ran no such command, or its result holds no value. */
function readResultValue(run: AgentRecipeRun, commandId: string): ApiJsonValue | undefined {
    return decodeJsonValue(run.results.find((result) => result.commandId === commandId)?.value);
}
