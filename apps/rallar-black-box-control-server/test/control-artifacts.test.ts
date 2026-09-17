import { RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { assert } from '@std/assert';

import {
    controlResultArtifactJsonl,
    controlResultEventArtifactJsonl,
    controlRunEventsJsonl,
    controlRunFailureBundle,
    controlRunResultsJsonl,
    createControlDistributedRunArtifactBundle,
    createControlRunArtifactBundle
} from '../src/control-artifacts.ts';
import { assertJsonEquals } from './support/control-service-test-fixtures.ts';

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
        resumeCompletedCommandIds: []
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
                            Authorization: 'Bearer secret-token'
                        }
                    }
                }
            },
            queuedAtEpochMs: 1_100,
            completedAtEpochMs: 1_200,
            dispatchCount: 1
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
                        expected: 0
                    }]
                }
            },
            queuedAtEpochMs: 1_210,
            completedAtEpochMs: 1_240,
            dispatchCount: 1
        }
    ],
    results: [
        {
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'artifact-run',
            agentId: 'agent-1',
            commandId: 'health-1',
            ok: true
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
                    accessToken: 'secret-token'
                }
            }
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
                        dependencyBlockedUpdateCount: 0
                    },
                    lastSyncResult: {
                        status: 'ok'
                    }
                }
            }
        }
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
                token: 'secret-token'
            }
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
                    status: 'ok'
                }
            }
        }
    ],
    stats: [],
    reports: [],
    heartbeats: []
};

Deno.test('control artifacts export redacted shared-test compatible files', () => {
    const bundle = createControlRunArtifactBundle(run, 3_000);
    const report = JSON.parse(bundle.files['report.json']);
    const failures = JSON.parse(bundle.files['failures.json']);
    const metadata = JSON.parse(bundle.files['metadata.json']);

    assertJsonEquals(bundle.runId, 'artifact-run');
    assertJsonEquals(report.summary.total, 3);
    assertJsonEquals(report.summary.failure, 1);
    assertJsonEquals(failures.failures.length, 1);
    assertJsonEquals(metadata.generatedAtEpochMs, 3_000);
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
    assertJsonEquals(controlRunFailureBundle(run).failures.length, 1);
});

Deno.test('control artifact JSONL helpers preserve queued command metadata', () => {
    const resultJsonl = controlResultArtifactJsonl(run.results[2], run.commands[1]);
    const resultRow = JSON.parse(resultJsonl) as {
        action?: string;
        transport?: string;
        connection?: string;
    };
    assertJsonEquals(resultRow.action, 'crdt.wait');
    assertJsonEquals(resultRow.transport, 'CRDT');
    assertJsonEquals(resultRow.connection, 'checklist');

    const eventJsonl = controlResultEventArtifactJsonl(run.results[2], run.commands[1]);
    const eventRow = JSON.parse(eventJsonl) as {
        kind?: string;
        action?: string;
        transport?: string;
        connection?: string;
    };
    assertJsonEquals(eventRow.kind, 'step-result');
    assertJsonEquals(eventRow.action, 'crdt.wait');
    assertJsonEquals(eventRow.transport, 'CRDT');
    assertJsonEquals(eventRow.connection, 'checklist');
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
                groupId: 'bb-group'
            },
            recipes: [{ recipeId: 'http-failure', required: true, variables: {} }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: ['agent-1']
            },
            startMode: 'manual',
            variables: {},
            roleAssignments: [],
            ackTimeoutMs: 30_000,
            barrier: { enabled: false },
            groupAssertions: [],
            metadata: {}
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
            queuedAtEpochMs: 1_100
        }],
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: 1,
                readyParticipants: 1,
                passedParticipants: 0,
                failedParticipants: 1,
                recipes: 1,
                passedRecipes: 0,
                failedRecipes: 1,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 1
            },
            failures: [{
                kind: 'recipe',
                key: 'http-failure',
                state: 'failed',
                error: {
                    code: 'HTTP_FAILED',
                    message: 'HTTP request failed.',
                    details: {
                        token: 'secret-token'
                    }
                }
            }]
        }
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
                    token: 'secret-token'
                }
            }
        ]
    };

    const bundle = createControlDistributedRunArtifactBundle(distributedRun, controlRun, 4_000);
    const report = JSON.parse(bundle.files['report.json'] ?? '{}');
    const failures = JSON.parse(bundle.files['failures.json'] ?? '{}');
    const metadata = JSON.parse(bundle.files['metadata.json'] ?? '{}');

    assertJsonEquals(bundle.artifactSchemaVersion, 2);
    assertJsonEquals(report.execution, 'distributed-run');
    assertJsonEquals(report.summary.total, 1);
    assertJsonEquals(report.summary.commandCount, 1);
    assertJsonEquals(failures.failures.length, 2);
    assertJsonEquals(metadata.generatedAtEpochMs, 4_000);
    assertJsonEquals('results.jsonl' in bundle.files, false);
    assertJsonEquals('events.jsonl' in bundle.files, false);
    assertJsonEquals(metadata.artifactRefs.resultsJsonl, '/runs/artifact-run/results.jsonl');
    assertJsonEquals(metadata.artifactRefs.eventsJsonl, '/runs/artifact-run/events.jsonl');
    assert(!JSON.stringify(bundle).includes('secret-token'));
    assert(JSON.stringify(bundle).includes('<redacted>'));
});
