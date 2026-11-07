import type { Server } from 'bun';
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './support/assert.ts';

import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { Either } from '@shared/resilience/Either.ts';
import { createDefaultTimers } from '@shared/resilience/timers.ts';

import { ControlAgentSockets } from '../src/control-agent-sockets.ts';
import {
    ControlArtifactRecorder,
    DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
} from '../src/control-artifact-recorder.ts';
import { toRunDirectoryName } from '../src/control-artifact-storage.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { createControlHttpResponses } from '../src/http/control-http-responses.ts';
import { ControlHttpSecurity } from '../src/http/control-http-security.ts';
import { createControlRequestBodyReader } from '../src/http/control-request-body.ts';
import { createDefaultRetentionPlanTokenAdapter } from '../src/retention-plan-token.ts';
import { routeControlHttpRequest, type ControlHttpRouteDependencies } from '../src/routes/control-http-router.ts';
import type { ControlSocketData } from '../src/routes/control-socket-route.ts';
import { toControlServiceInput } from './support/control-service-test-fixtures.ts';

interface RetentionRouteHarness {
    readonly dependencies: ControlHttpRouteDependencies;
    readonly closedSockets: readonly string[];
    readonly persistCalls: readonly string[];
    readonly storageDir: string;
    readBodyPulls(): number;
    toRequest(query: string): Request;
    readMarker(): Promise<string>;
}

const PRESERVED_MARKER = 'manual-cleanup-must-preserve-this\n';
const NO_COMMAND_SNAPSHOTS = { snapshotCommand: () => undefined };
// The retention routes never reach the `/control` upgrade path, so a non-upgrading server is enough.
const NO_UPGRADE_SERVER = { upgrade: () => false } as unknown as Server<ControlSocketData>;
const OPEN_ACCESS_CONFIGURATION = {
    adminToken: undefined,
    allowedOrigins: [],
    operatorTokenSecret: undefined,
    requireReadToken: false,
    requireRunToken: false,
    requireTls: false
};

test('immediate manual retention deletes runs without closing sockets, deleting artifacts, or reading the body', async () => {
    const harness = await createRetentionRouteHarness();
    try {
        const response = (await routeControlHttpRequest(harness.toRequest(''), harness.dependencies, NO_UPGRADE_SERVER))!;

        expect(response.status).toEqual(200);
        expect(await response.json()).toEqual({ deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 });
        expect(harness.closedSockets).toEqual([]);
        expect(harness.readBodyPulls()).toEqual(0);
        expect(await harness.readMarker()).toEqual(PRESERVED_MARKER);
        expect(harness.persistCalls).toEqual(['persist']);
    }
    finally {
        await rm(harness.storageDir, { recursive: true, force: true });
    }
});

test('previewed and confirmed manual retention keeps sockets, artifacts, and the body untouched', async () => {
    const harness = await createRetentionRouteHarness();
    try {
        const preview = (await routeControlHttpRequest(harness.toRequest('?dryRun=true'), harness.dependencies, NO_UPGRADE_SERVER))!;
        const previewBody = await preview.json() as { planToken?: string; };
        assert(typeof previewBody.planToken === 'string');

        const confirmQuery = `?planToken=${encodeURIComponent(previewBody.planToken)}`;
        const confirm = (await routeControlHttpRequest(harness.toRequest(confirmQuery), harness.dependencies, NO_UPGRADE_SERVER))!;

        expect(preview.status).toEqual(200);
        expect(confirm.status).toEqual(200);
        expect(await confirm.json()).toEqual({ deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 });
        expect(harness.closedSockets).toEqual([]);
        expect(harness.readBodyPulls()).toEqual(0);
        expect(await harness.readMarker()).toEqual(PRESERVED_MARKER);
    }
    finally {
        await rm(harness.storageDir, { recursive: true, force: true });
    }
});

async function createRetentionRouteHarness(): Promise<RetentionRouteHarness> {
    const storageDir = await mkdtemp(join(tmpdir(), 'rallar-retention-route-'));
    const markerPath = await writeArtifactMarker(storageDir, 'run-old');
    const closedSockets: string[] = [];
    const persistCalls: string[] = [];
    const dependencies = createRetentionRouteDependencies(storageDir, closedSockets, persistCalls);
    let bodyPulls = 0;

    return {
        dependencies,
        closedSockets,
        persistCalls,
        storageDir,
        readBodyPulls: () => bodyPulls,
        toRequest: (query) =>
            new Request(`http://control.test/retention/cleanup${query}`, {
                method: 'POST',
                body: new ReadableStream<Uint8Array>({
                    pull(controller) {
                        bodyPulls += 1;
                        controller.close();
                    }
                }, { highWaterMark: 0 })
            }),
        readMarker: async () => {
            // Awaiting an artifact response drains the recorder's queued deletions before the marker is read.
            await dependencies.artifactRecorder.response({
                runId: 'run-new',
                kind: 'events',
                fallbackRun: toControlRun('run-new', 2_000),
                corsOrigins: []
            });
            return await readFile(markerPath, 'utf8').catch(() => '');
        }
    };
}

function createRetentionRouteDependencies(
    storageDir: string,
    closedSockets: string[],
    persistCalls: string[]
): ControlHttpRouteDependencies {
    const controlService = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 3_000 }));
    controlService.restoreSnapshot({
        runs: [toControlRun('run-old', 1_000), toControlRun('run-new', 2_000)],
        distributedRuns: [],
        fleetReports: []
    });
    const agentSockets = new ControlAgentSockets(controlService);
    agentSockets.register(
        { readyState: 1, send: () => undefined, close: (code, reason) => closedSockets.push(`${code}:${reason}`) },
        { runId: 'run-old', agentId: 'agent-old' }
    );

    return {
        controlService,
        security: new ControlHttpSecurity({ configuration: OPEN_ACCESS_CONFIGURATION, controlService }),
        requestBody: createControlRequestBodyReader(8),
        responses: createControlHttpResponses(['*']),
        agentSockets,
        artifactRecorder: new ControlArtifactRecorder({
            storageDir,
            commandSnapshots: NO_COMMAND_SNAPSHOTS,
            timers: createDefaultTimers(),
            config: DEFAULT_CONTROL_ARTIFACT_RECORDER_CONFIG
        }),
        completedRuns: {
            readRun: (runId) =>
                Promise.resolve(
                    Either.ofRight(toControlRun(runId, 0))
                )
        },
        persistence: { persist: () => persistCalls.push('persist') },
        retentionPlanTokens: createDefaultRetentionPlanTokenAdapter(new Uint8Array(32)),
        commandDestinations: { httpAllowedHosts: [], httpAllowedOrigins: [], wsAllowedHosts: [], wsAllowedOrigins: [] },
        retentionMaxRuns: 1,
        runTokenTtlMs: 60_000,
        now: () => 3_000
    };
}

async function writeArtifactMarker(storageDir: string, runId: string): Promise<string> {
    const markerDirectory = `${storageDir}/runs/${toRunDirectoryName(runId)}`;
    await mkdir(markerDirectory, { recursive: true });
    await writeFile(`${markerDirectory}/sentinel.jsonl`, PRESERVED_MARKER, 'utf8');
    return `${markerDirectory}/sentinel.jsonl`;
}

function toControlRun(runId: string, updatedAtEpochMs: number): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: updatedAtEpochMs,
        updatedAtEpochMs,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}
