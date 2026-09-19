import type { ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { assert, assertEquals } from '@std/assert';

import { ControlAgentSockets } from '../src/control-agent-sockets.ts';
import { ControlArtifactRecorder, toRunDirectoryName } from '../src/control-artifact-recorder.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import { createControlHttpResponses } from '../src/http/control-http-responses.ts';
import { ControlHttpSecurity } from '../src/http/control-http-security.ts';
import { createControlRequestBodyReader } from '../src/http/control-request-body.ts';
import { createRetentionPlanTokenAdapter } from '../src/retention-plan-token.ts';
import { routeControlHttpRequest, type ControlHttpRouteDependencies } from '../src/routes/control-http-router.ts';
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
const OPEN_ACCESS_CONFIGURATION = {
    adminToken: undefined,
    allowedOrigins: [],
    operatorTokenSecret: undefined,
    requireReadToken: false,
    requireRunToken: false,
    requireTls: false
};

Deno.test('immediate manual retention deletes runs without closing sockets, deleting artifacts, or reading the body', async () => {
    const harness = await createRetentionRouteHarness();
    try {
        const response = await routeControlHttpRequest(harness.toRequest(''), harness.dependencies);

        assertEquals(response.status, 200);
        assertEquals(await response.json(), { deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 });
        assertEquals(harness.closedSockets, []);
        assertEquals(harness.readBodyPulls(), 0);
        assertEquals(await harness.readMarker(), PRESERVED_MARKER);
        assertEquals(harness.persistCalls, ['persist']);
    }
    finally {
        await Deno.remove(harness.storageDir, { recursive: true });
    }
});

Deno.test('previewed and confirmed manual retention keeps sockets, artifacts, and the body untouched', async () => {
    const harness = await createRetentionRouteHarness();
    try {
        const preview = await routeControlHttpRequest(harness.toRequest('?dryRun=true'), harness.dependencies);
        const previewBody = await preview.json() as { planToken?: string; };
        assert(typeof previewBody.planToken === 'string');

        const confirmQuery = `?planToken=${encodeURIComponent(previewBody.planToken)}`;
        const confirm = await routeControlHttpRequest(harness.toRequest(confirmQuery), harness.dependencies);

        assertEquals(preview.status, 200);
        assertEquals(confirm.status, 200);
        assertEquals(await confirm.json(), { deletedRunIds: ['run-old'], retainedRuns: 1, maxRuns: 1 });
        assertEquals(harness.closedSockets, []);
        assertEquals(harness.readBodyPulls(), 0);
        assertEquals(await harness.readMarker(), PRESERVED_MARKER);
    }
    finally {
        await Deno.remove(harness.storageDir, { recursive: true });
    }
});

async function createRetentionRouteHarness(): Promise<RetentionRouteHarness> {
    const storageDir = await Deno.makeTempDir({ prefix: 'rallar-retention-route-' });
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
            return await Deno.readTextFile(markerPath).catch(() => '');
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
        artifactRecorder: new ControlArtifactRecorder({ storageDir, commandSnapshots: NO_COMMAND_SNAPSHOTS }),
        persistence: { restore: () => Promise.resolve(), persist: () => persistCalls.push('persist') },
        retentionPlanTokens: createRetentionPlanTokenAdapter({ key: new Uint8Array(32) }),
        commandDestinations: { httpAllowedHosts: [], httpAllowedOrigins: [], wsAllowedHosts: [], wsAllowedOrigins: [] },
        retentionMaxRuns: 1,
        runTokenTtlMs: 60_000,
        now: () => 3_000
    };
}

async function writeArtifactMarker(storageDir: string, runId: string): Promise<string> {
    const markerDirectory = `${storageDir}/runs/${toRunDirectoryName(runId)}`;
    await Deno.mkdir(markerDirectory, { recursive: true });
    await Deno.writeTextFile(`${markerDirectory}/sentinel.jsonl`, PRESERVED_MARKER);
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
