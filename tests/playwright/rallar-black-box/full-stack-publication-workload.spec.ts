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
    type PublicationWorkloadRecipes,
    type PublicationWorkloadRoleKind,
    type PublicationWorkloadRoleRecipe,
    type PublicationWorkloadRoomRecipes
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/publication-workload/create-publication-workload-recipes.ts';
import {
    toPublicationWorkloadFigures,
    type PublicationWorkloadFigures,
    type PublicationWorkloadRoomResults
} from '../../../packages/shared-test/rallar-bb-test/conformance/alm/publication-workload/to-publication-workload-figures.ts';
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

/** One point this proof runs in the browser, under the name `RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT` picks it by. */
interface LocalPoint {
    readonly name: string;
    readonly description: string;
    readonly parameters: PublicationWorkloadParameters;
}

/** What one agent's recipe left behind: the history it ran under and the result of each of its commands. */
interface AgentRecipeRun {
    readonly agentId: string;
    readonly recipeId: string | undefined;
    readonly eventHistoryMode: ApiJsonValue | undefined;
    readonly results: readonly RallarBlackBoxTestResult[];
}

const SECOND_ROOM_GROUP = { ...HETZNER_DISTRIBUTED_MANIFEST_GROUP, groupId: 'hetzner-headless-room-2' };

/**
 * The family has no default, so every value is this proof's own choice. The second point's six agents are the most a
 * recorded 4-CPU run of the headless worker passed with (`docs/github-actions-black-box-headless-runbook.md`), and its
 * delivery level is the first hosted campaign's for several publishers
 * (`playground/alm/alm-first-hosted-campaign-targets.md`, section 2.3). The two loss points take the conformance lane's
 * seeded loss, a quarter from seed 7, whose first lost frames the lane already pins.
 */
const LOCAL_POINTS: readonly LocalPoint[] = [
    {
        name: 'one-room',
        description: 'One room of one publisher and two subscribers: 60 live frames 500 ms apart on rtc.',
        parameters: {
            groups: [HETZNER_DISTRIBUTED_MANIFEST_GROUP],
            participantCount: 3,
            publisherCount: 1,
            carrier: 'rtc',
            publishIntervalMs: 500,
            windowMs: 30_000,
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
            payloadBytes: 256,
            ttlMs: 5_000,
            minReceiveRatio: 0.95,
            minSendSuccessRatio: 0.95,
            readyTimeoutMs: 45_000,
            loss: { kind: 'none' }
        }
    },
    {
        name: 'two-rooms',
        description:
            'Two rooms of two publishers and one subscriber each: 30 live frames a publisher 500 ms apart on rtc.',
        parameters: {
            groups: [HETZNER_DISTRIBUTED_MANIFEST_GROUP, SECOND_ROOM_GROUP],
            participantCount: 3,
            publisherCount: 2,
            carrier: 'rtc',
            publishIntervalMs: 500,
            windowMs: 15_000,
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
            payloadBytes: 256,
            ttlMs: 5_000,
            minReceiveRatio: 0.9,
            minSendSuccessRatio: 0.95,
            readyTimeoutMs: 45_000,
            loss: { kind: 'none' }
        }
    },
    {
        name: 'one-room-ws-loss',
        description: 'The one-room point on ws under a seeded quarter loss: seed 7 drops 18 of the 60 frames.',
        parameters: {
            groups: [HETZNER_DISTRIBUTED_MANIFEST_GROUP],
            participantCount: 3,
            publisherCount: 1,
            carrier: 'ws',
            publishIntervalMs: 500,
            windowMs: 30_000,
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
            payloadBytes: 256,
            ttlMs: 5_000,
            // Over ws the seed decides which frames are lost, so the expectation is exact: every frame is admitted,
            // and each subscriber gets exactly the 42 the loss lets pass.
            minReceiveRatio: 1,
            minSendSuccessRatio: 1,
            readyTimeoutMs: 45_000,
            loss: { kind: 'seeded', ratio: 0.25, seed: 7 }
        }
    },
    {
        name: 'one-room-rtc-loss',
        description: 'The one-room point on rtc under a seeded quarter loss: a refused send is sent again.',
        parameters: {
            groups: [HETZNER_DISTRIBUTED_MANIFEST_GROUP],
            participantCount: 3,
            publisherCount: 1,
            carrier: 'rtc',
            publishIntervalMs: 500,
            windowMs: 30_000,
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
            payloadBytes: 256,
            ttlMs: 5_000,
            // The family's band for a loaded machine, not a loss allowance: a product that stopped resubmitting a
            // refused frame would, by the seed's own draws, lose at least 18 of its 120 sends and fail it; no run has
            // shown this.
            minReceiveRatio: 0.95,
            minSendSuccessRatio: 0.95,
            readyTimeoutMs: 45_000,
            loss: { kind: 'seeded', ratio: 0.25, seed: 7 }
        }
    }
];

/** The commands whose result values the figures record is read from. */
const RESULT_COMMAND_IDS = {
    publisherFrames: 'publication-workload-publisher-frames',
    publisherStats: 'publication-workload-publisher-stats',
    publisherLossRelease: 'publication-workload-publisher-loss-release',
    subscriberReceived: 'publication-workload-subscriber-received'
} as const;

/** Each role's last `stats`, read after its window. */
const STATS_COMMAND_IDS: Readonly<Record<PublicationWorkloadRoleKind, string>> = {
    publisher: RESULT_COMMAND_IDS.publisherStats,
    subscriber: 'publication-workload-subscriber-stats'
};

test('is asked for a point it holds', () => {
    test.skip(!isHeadlessFullStackOptedIn(), 'Opt-in standalone headless full-stack observation required');
    expect(
        LOCAL_POINTS.map(({ name }) => name),
        'RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT names a point of this proof'
    ).toContain(process.env.RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT);
});

// One point a Playwright run: every launch gives the same users, `controller-01` onward, a new password, so the API
// must be new to the point. The terminal wait is the manifest's own terminal timeout, and the harness abort, the owned
// worker's idle exit and the test's limit are derived from it.
for (const point of LOCAL_POINTS) {
    test(`runs the publication workload ${point.name} point and records its figures`, async ({}, testInfo) => {
        test.skip(!isHeadlessFullStackOptedIn(), 'Opt-in standalone headless full-stack observation required');
        test.skip(
            process.env.RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT !== point.name,
            'RALLAR_BLACK_BOX_PUBLICATION_WORKLOAD_POINT names another point'
        );
        expect(
            process.env.RALLAR_BLACK_BOX_STORAGE_DIR,
            'The control server keeps whole results only in recorder storage, selected before it starts'
        ).toBeTruthy();
        const recipes = createPublicationWorkloadRecipes(point.parameters).fold((issues) => {
            throw new Error(`The ${point.name} point is no point of the family: ${JSON.stringify(issues)}`);
        }, (valid) => valid);
        const artifactDir = testInfo.outputPath('observation');
        const manifestPath = path.join(artifactDir, 'source-manifest.json');
        const manifest = createLocalPointManifest(point, recipes, manifestPath);
        const deadlines = computeAllLocalAlmObservationDeadlines(manifest);
        test.setTimeout(deadlines.testTimeoutMs);
        const controlBaseUrl = readFullStackControlBaseUrl();
        const launch: OwnedHeadlessWorkerLaunch = {
            services: { apiBaseUrl: readFullStackApiBaseUrl(), spaBaseUrl: readFullStackSpaBaseUrl(), controlBaseUrl },
            manifest,
            agentCount: computeAgentCount(recipes),
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
            const figures = toPublicationWorkloadFigures({
                parameters: point.parameters,
                rooms: recipes.rooms.map((room) => toRoomResults(room, agentRuns))
            });
            const figuresPath = testInfo.outputPath('publication-workload-figures.json');
            await writeFile(figuresPath, `${JSON.stringify(figures.right ?? { issues: figures.left }, null, 2)}\n`);
            await testInfo.attach('publication-workload-figures.json', {
                path: figuresPath,
                contentType: 'application/json'
            });

            expect(
                figures.right,
                `The run gives a figures record; issues: ${(figures.left ?? []).join('; ')}; the agents ran ${
                    agentRuns.map((run) => `${run.agentId}: ${run.recipeId}`).join(', ')
                }`
            ).toBeDefined();
            expectPointFigures(figures.right!);
            expectLossFigures(figures.right!);
            expectAgentPages(recipes, agentRuns);
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
}

/** Only a caller that sets both opt-ins asks for this proof; `npm run test:rallar` loads the file and sets neither. */
function isHeadlessFullStackOptedIn(): boolean {
    return process.env.RALLAR_BLACK_BOX_FULL_STACK === '1' && process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS === '1';
}

/**
 * Every room holds the figures of each of its agents; every publisher's stage handed enough frames to a carrier; every
 * subscriber received enough of its room's frames and no more than them, with an age for each; and each delivered
 * figure covers exactly its subscribers. No latency level, no percentile and no rate is asserted.
 */
function expectPointFigures(figures: PublicationWorkloadFigures): void {
    const { configured: { parameters, plan }, measured } = figures;
    for (const [index, room] of measured.rooms.entries()) {
        const roomName = `room ${index + 1}`;
        expect(room.publishers, `Every publisher of ${roomName} has figures`).toHaveLength(parameters.publisherCount);
        expect(room.subscribers, `Every subscriber of ${roomName} has figures`).toHaveLength(plan.subscriberCount);
        for (const { agentId, publicationStage } of room.publishers) {
            expect(publicationStage.counters.admitted, `The stage of ${agentId} handed enough frames to a carrier`)
                .toBeGreaterThanOrEqual(plan.minAcceptedSends);
        }
        for (const { agentId, observed, unrecordedSamples, sampleAgeMs } of room.subscribers) {
            expect(observed, `${agentId} received enough of the frames of ${roomName}`).toBeGreaterThanOrEqual(
                plan.minExpectedInboundMessages
            );
            expect(observed, `${agentId} received no more messages than ${roomName} has frames`).toBeLessThanOrEqual(
                plan.expectedInboundMessages
            );
            expect(unrecordedSamples, `Every message ${agentId} received gave an age`).toBe(0);
            // A stamp that is no send time reads as an age far above any window.
            expect(
                sampleAgeMs.kind === 'recorded' && sampleAgeMs.max < parameters.windowMs,
                `The oldest sample of ${agentId} is younger than the window: ${JSON.stringify(sampleAgeMs)}`
            ).toBe(true);
        }
        expect(room.delivered.sampleAgeMs.kind, `${roomName} states one delivered sample age`).toBe('recorded');
        expect(room.delivered.observed, `The delivered figure of ${roomName} counts every subscriber's messages`)
            .toBe(computeSum(room.subscribers.map((subscriber) => subscriber.observed)));
    }
    expect(
        measured.delivered.sampleAgeMs.kind === 'recorded' && measured.delivered.sampleAgeMs.count,
        'The delivered sample age of the point holds every age of every room'
    ).toBe(
        computeSum(
            measured.rooms.map(({ delivered: { sampleAgeMs } }) =>
                sampleAgeMs.kind === 'recorded' ? sampleAgeMs.count : 0
            )
        )
    );
}

/**
 * Under a seeded loss each publisher's fault dropped a send, and over `ws` each subscriber observed exactly what its
 * room's publishers admitted less what their faults dropped: two measured counts, so the proof holds whatever frames
 * the stage handed on. A point with no loss is held to nothing here.
 */
function expectLossFigures(figures: PublicationWorkloadFigures): void {
    const { configured: { parameters }, measured } = figures;
    if (parameters.loss.kind !== 'seeded') {
        return;
    }
    for (const [index, room] of measured.rooms.entries()) {
        for (const { agentId, droppedSends } of room.publishers) {
            expect(droppedSends, `The fault of ${agentId} dropped at least one send`).toBeGreaterThanOrEqual(1);
        }
        if (parameters.carrier === 'ws') {
            const { admittedFrames, droppedSends } = room.published;
            const passedFrames = droppedSends === null ? undefined : admittedFrames - droppedSends;
            for (const { agentId, observed } of room.subscribers) {
                expect(
                    observed,
                    `${agentId} observed what the publishers of room ${
                        index + 1
                    } admitted less what their faults dropped`
                ).toBe(passedFrames);
            }
        }
    }
}

/**
 * A page that dropped events would under-count, and a page the product held over its volatile budget would have refused
 * frames the point's level then blames on delivery.
 */
function expectAgentPages(recipes: PublicationWorkloadRecipes, agentRuns: readonly AgentRecipeRun[]): void {
    const roles = recipes.rooms.flatMap((room) => room.roles);
    for (const run of agentRuns) {
        const role = roles.find(({ recipe }) => recipe.recipeId === run.recipeId);
        expect(role, `${run.agentId} ran a recipe of the point, and ran ${run.recipeId}`).toBeDefined();
        expect(run.eventHistoryMode, `${run.agentId} ran its recipe on a full event history`).toBe('full');
        expect(
            readResultValue(run, STATS_COMMAND_IDS[role!.kind]),
            `The page of ${run.agentId} kept every event, its event capture has no gap, and it was never overloaded`
        ).toMatchObject({
            eventHistory: { policy: { mode: 'full' }, evictedEvents: 0, capture: { status: 'continuous' } },
            rallar: { alm: { overloaded: false } }
        });
    }
}

/**
 * A room's results are those of the agents that ran one of the room's own recipes. A recipe's id holds its room, so no
 * agent's results reach two rooms.
 */
function toRoomResults(
    room: PublicationWorkloadRoomRecipes,
    agentRuns: readonly AgentRecipeRun[]
): PublicationWorkloadRoomResults {
    const runsOfKind = (kind: PublicationWorkloadRoleKind): readonly AgentRecipeRun[] =>
        agentRuns.filter((run) =>
            room.roles.some((role) => role.kind === kind && role.recipe.recipeId === run.recipeId)
        );
    return {
        group: room.group,
        publishers: runsOfKind('publisher').map((run) => ({
            agentId: run.agentId,
            loop: readResultValue(run, RESULT_COMMAND_IDS.publisherFrames),
            stats: readResultValue(run, RESULT_COMMAND_IDS.publisherStats),
            lossRelease: readResultValue(run, RESULT_COMMAND_IDS.publisherLossRelease)
        })),
        subscribers: runsOfKind('subscriber').map((run) => ({
            agentId: run.agentId,
            received: readResultValue(run, RESULT_COMMAND_IDS.subscriberReceived)
        }))
    };
}

/**
 * A role-map manifest whose roles are the recipe ids: each recipe runs on its own agents and on no other. The entry's
 * own pattern gives every agent every recipe and names no role, so the roles are written here. The entry names no event
 * history of its own: a manifest's history replaces the `full` one a subscriber's recipe asks for. A control run holds
 * a barrier id once, so each run of the test is a control run of its own.
 */
function createLocalPointManifest(
    point: LocalPoint,
    recipes: PublicationWorkloadRecipes,
    filePath: string
): RallarBlackBoxDistributedRunManifest {
    const runId = `publication-workload-${uniqueSuffix()}`;
    const roles = recipes.rooms.flatMap((room) => room.roles);
    const agentCount = computeAgentCount(recipes);
    const entry = createBudgetedManifestEntry({
        filePath,
        title: `Publication workload ${point.name} local point`,
        description: point.description,
        distributedRunId: `${runId}-${point.name}`,
        recipes: roles.map((role) => role.recipe),
        agentCount,
        profiles: ['alm', 'messages.rtc', 'publication-workload', point.name],
        live: true,
        targetAgentIds: toControllerAgentIds(agentCount),
        targetPolicyMode: 'role-map',
        rolePattern: 'all-agents',
        mainline: false,
        diagnostic: false,
        expectedFailure: false,
        stress: false,
        barrier: true,
        groupAssertions: [],
        metadata: { family: 'publication-workload', point: point.name }
    });
    return {
        ...entry.manifest,
        controlRunId: runId,
        recipes: entry.manifest.recipes.map((selection) => ({ ...selection, role: selection.recipeId })),
        targetPolicy: { mode: 'role-map', roles: toAgentIdsByRecipeId(roles), expectedParticipantCount: agentCount }
    };
}

/**
 * The agents are handed out in the order the rooms and their roles come, so the run's first agent writes the first
 * room's group.
 */
function toAgentIdsByRecipeId(
    roles: readonly PublicationWorkloadRoleRecipe[]
): Readonly<Record<string, readonly string[]>> {
    const agentIds = toControllerAgentIds(computeSum(roles.map((role) => role.agentCount)));
    return Object.fromEntries(roles.map((role, index) => {
        const firstAgent = computeSum(roles.slice(0, index).map((earlier) => earlier.agentCount));
        return [role.recipe.recipeId, agentIds.slice(firstAgent, firstAgent + role.agentCount)];
    }));
}

/** The agents of every room together, each running one recipe. */
function computeAgentCount(recipes: PublicationWorkloadRecipes): number {
    return computeSum(recipes.rooms.flatMap((room) => room.roles.map((role) => role.agentCount)));
}

function computeSum(counts: readonly number[]): number {
    return counts.reduce((sum, count) => sum + count, 0);
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
