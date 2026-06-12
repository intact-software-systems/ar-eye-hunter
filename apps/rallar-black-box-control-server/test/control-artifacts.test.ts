import {
    controlRunEventsJsonl,
    controlRunFailureBundle,
    controlRunResultsJsonl,
    createControlDistributedRunArtifactBundle,
    createControlRunArtifactBundle,
} from '../src/control-artifacts.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '../src/control-service.ts';
import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '../../rallar-black-box/src/control-protocol.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEquals<T>(actual: T, expected: T): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`,
        );
    }
}

const run: ControlRunSnapshot = {
    runId: 'artifact-run',
    createdAtEpochMs: 1_000,
    updatedAtEpochMs: 2_000,
    agents: [{
        runId: 'artifact-run',
        agentId: 'agent-1',
        connected: true,
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 2,
        receivedEventCount: 1,
        completedCommandIds: ['health-1', 'http-1', 'crdt-wait-1'],
        resumeCompletedCommandIds: [],
    }],
    commands: [
        {
            envelope: {
                kind: 'command',
                protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
                runId: 'artifact-run',
                agentId: 'agent-1',
                commandId: 'http-1',
                command: {
                    kind: 'http.request',
                    request: {
                        url: 'http://api.example.test/secret',
                        headers: {
                            Authorization: 'Bearer secret-token',
                        },
                    },
                },
            },
            queuedAtEpochMs: 1_100,
            completedAtEpochMs: 1_200,
            dispatchCount: 1,
        },
        {
            envelope: {
                kind: 'command',
                protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
                runId: 'artifact-run',
                agentId: 'agent-1',
                commandId: 'crdt-wait-1',
                command: {
                    kind: 'crdt.wait',
                    handle: 'checklist',
                    timeoutMs: 1_000,
                    conditions: [{
                        source: 'health',
                        path: 'pendingUpdateCount',
                        operator: 'equals',
                        expected: 0,
                    }],
                },
            },
            queuedAtEpochMs: 1_210,
            completedAtEpochMs: 1_240,
            dispatchCount: 1,
        },
    ],
    results: [
        {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'artifact-run',
            agentId: 'agent-1',
            commandId: 'health-1',
            ok: true,
        },
        {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'artifact-run',
            agentId: 'agent-1',
            commandId: 'http-1',
            ok: false,
            error: {
                code: 'HTTP_FAILED',
                message: 'HTTP request failed.',
                details: {
                    accessToken: 'secret-token',
                },
            },
        },
        {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'artifact-run',
            agentId: 'agent-1',
            commandId: 'crdt-wait-1',
            ok: true,
            result: {
                kind: 'crdt.wait',
                status: 'ok',
                ok: true,
                commandId: 'crdt-wait-1',
                startedAtEpochMs: 1_220,
                endedAtEpochMs: 1_240,
                durationMs: 20,
                value: {
                    handle: 'checklist',
                    attempts: 3,
                    waitedMs: 500,
                    health: {
                        pendingUpdateCount: 0,
                        failedPendingUpdateCount: 0,
                        dependencyBlockedUpdateCount: 0,
                    },
                    lastSyncResult: {
                        status: 'ok',
                    },
                },
            },
        },
    ],
    events: [
        {
            kind: 'diagnostic',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'artifact-run',
            agentId: 'agent-1',
            eventId: 'event-1',
            commandId: 'http-1',
            atEpochMs: 1_300,
            payload: {
                topic: 'rallar.bb.http.failed',
                token: 'secret-token',
            },
        },
        {
            kind: 'diagnostic',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'artifact-run',
            agentId: 'agent-1',
            eventId: 'event-crdt',
            commandId: 'crdt-wait-1',
            atEpochMs: 1_320,
            payload: {
                topic: 'rallar.bb.crdt.wait_matched',
                handle: 'checklist',
                pendingUpdateCount: 0,
                dependencyBlockedUpdateCount: 0,
                lastSyncResult: {
                    status: 'ok',
                },
            },
        },
    ],
    stats: [],
    reports: [],
    heartbeats: [],
};

Deno.test('control artifacts export redacted shared-test compatible files', () => {
    const bundle = createControlRunArtifactBundle(run, 3_000);
    const report = JSON.parse(bundle.files['report.json']);
    const failures = JSON.parse(bundle.files['failures.json']);
    const metadata = JSON.parse(bundle.files['metadata.json']);

    assertEquals(bundle.runId, 'artifact-run');
    assertEquals(report.summary.total, 3);
    assertEquals(report.summary.failure, 1);
    assertEquals(failures.failures.length, 1);
    assertEquals(metadata.generatedAtEpochMs, 3_000);
    assert(bundle.files['events.jsonl'].includes('"kind":"step-result"'));
    assert(bundle.files['events.jsonl'].includes('"kind":"crdt-diagnostic"'));
    assert(bundle.files['events.jsonl'].includes('"transport":"CRDT"'));
    assert(bundle.files['events.jsonl'].includes('"connection":"checklist"'));
    assert(bundle.files['events.jsonl'].includes('dependencyBlockedUpdateCount'));
    assert(!JSON.stringify(bundle).includes('secret-token'));
    assert(JSON.stringify(bundle).includes('<redacted>'));
});

Deno.test('control artifacts export event, result, and failure bundles', () => {
    assert(controlRunEventsJsonl(run).includes('rtc-diagnostic'));
    assert(controlRunEventsJsonl(run).includes('crdt-diagnostic'));
    assert(controlRunResultsJsonl(run).includes('HTTP_FAILED'));
    assert(controlRunResultsJsonl(run).includes('"transport":"CRDT"'));
    assertEquals(controlRunFailureBundle(run).failures.length, 1);
});

Deno.test('control distributed artifacts export filtered v2 analysis files', () => {
    const distributedRun: ControlDistributedRunSnapshot = {
        distributedRunId: 'dist-artifact',
        controlRunId: 'artifact-run',
        manifest: {
            schemaVersion: 1,
            distributedRunId: 'dist-artifact',
            controlRunId: 'artifact-run',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'bb-group',
            },
            recipes: [{ recipeId: 'http-failure', required: true }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-1'],
            },
            startMode: 'manual',
        },
        state: 'failed',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 1_400,
        startedAtEpochMs: 1_100,
        completedAtEpochMs: 1_400,
        targetAgentIds: ['agent-1'],
        commandLinks: [{
            phase: 'start',
            agentId: 'agent-1',
            commandId: 'http-1',
            recipeId: 'http-failure',
            queuedAtEpochMs: 1_100,
        }],
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: 1,
                passedParticipants: 0,
                failedParticipants: 1,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 0,
                failedRecipes: 1,
                blockingFailures: 1,
            },
            failures: [{
                kind: 'recipe',
                key: 'http-failure',
                state: 'failed',
                required: true,
                error: {
                    code: 'HTTP_FAILED',
                    message: 'HTTP request failed.',
                    details: {
                        token: 'secret-token',
                    },
                },
            }],
        },
    };
    const controlRun: ControlRunSnapshot = {
        ...run,
        events: [
            ...run.events,
            {
                kind: 'event',
                protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
                runId: 'artifact-run',
                agentId: 'agent-1',
                eventId: 'dist-ref-event',
                commandId: 'crdt-wait-1',
                atEpochMs: 1_360,
                payload: {
                    topic: 'rallar.bb.distributed.reference',
                    distributedRunId: 'dist-artifact',
                    token: 'secret-token',
                },
            },
        ],
    };

    const bundle = createControlDistributedRunArtifactBundle(distributedRun, controlRun, 4_000);
    const report = JSON.parse(bundle.files['report.json'] ?? '{}');
    const failures = JSON.parse(bundle.files['failures.json'] ?? '{}');
    const metadata = JSON.parse(bundle.files['metadata.json'] ?? '{}');

    assertEquals(bundle.artifactSchemaVersion, 2);
    assertEquals(report.execution, 'distributed-run');
    assertEquals(report.summary.total, 1);
    assertEquals(report.summary.commandCount, 1);
    assertEquals(failures.failures.length, 2);
    assertEquals(metadata.generatedAtEpochMs, 4_000);
    assert((bundle.files['results.jsonl'] ?? '').includes('"commandId":"http-1"'));
    assert(!(bundle.files['results.jsonl'] ?? '').includes('"commandId":"crdt-wait-1"'));
    assert((bundle.files['events.jsonl'] ?? '').includes('dist-ref-event'));
    assert(!JSON.stringify(bundle).includes('secret-token'));
    assert(JSON.stringify(bundle).includes('<redacted>'));
});
