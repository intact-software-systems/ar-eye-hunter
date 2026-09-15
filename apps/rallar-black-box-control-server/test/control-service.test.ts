import {
    parseControlClientMessage,
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import { assert } from '@std/assert';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertJsonEquals,
    assertRight,
    toCommandResultEnvelope,
    toConfigureCommand,
    toControlServiceInput,
    toDistributedManifest,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

Deno.test('control service queues and dispatches commands to a registered agent', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: (() => {
            let now = 1_000;
            return () => now++;
        })(),
        createCommandId: () => 'generated-command-1'
    }));

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    const queued = assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        command: toConfigureCommand()
    }));

    assertJsonEquals(queued.commandId, 'generated-command-1');
    assertJsonEquals(
        service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.commandId),
        ['generated-command-1']
    );
    assertJsonEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.commands[0].dispatchCount, 1);
    assertJsonEquals(run.agents[0].connected, true);
});

Deno.test('control service stores results and suppresses completed resume commands', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: toConfigureCommand()
    });
    assertJsonEquals(
        service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.commandId),
        ['configure-1']
    );

    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: ['configure-1'], identity: undefined }));
    assertJsonEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);

    service.receiveClientEnvelope({
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        ok: true,
        replayed: true,
        result: {
            commandId: 'configure-1',
            kind: 'configure',
            status: 'ok',
            ok: true,
            startedAtEpochMs: 1_000,
            endedAtEpochMs: 1_001,
            durationMs: 1,
            value: {
                configured: true
            }
        }
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.results.length, 1);
    assertJsonEquals(run.commands[0].completedAtEpochMs !== undefined, true);
    assertJsonEquals(run.agents[0].completedCommandIds, ['configure-1']);
    assertJsonEquals(run.agents[0].resumeCompletedCommandIds, []);
});

Deno.test('control service hardens command enqueueing and run tokens', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now,
        allowedCommandKinds: ['configure'],
        commandRateLimitMax: 1,
        commandRateLimitWindowMs: 1_000
    }));

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    const first = assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: toConfigureCommand()
    }));
    const duplicate = assertRight(service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: toConfigureCommand()
    }));

    assertJsonEquals(duplicate, first);
    assertJsonEquals(
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'configure-1',
            command: {
                kind: 'configure',
                config: {
                    runId: 'run-1',
                    agentId: 'agent-1',
                    actor: 'bob'
                }
            }
        }).left,
        { code: 'command-payload-conflict', message: 'Command configure-1 already exists with a different payload.' }
    );
    assertJsonEquals(
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'stats-1',
            command: {
                kind: 'stats'
            }
        }).left,
        { code: 'command-kind-not-allowed', message: 'Command kind is not allowed: stats.' }
    );
    assertJsonEquals(
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'configure-2',
            command: toConfigureCommand()
        }).left,
        { code: 'command-rate-limited', message: 'Command rate limit exceeded.' }
    );

    const token = service.issueRunToken({
        runId: 'run-1',
        agentId: 'agent-1',
        ttlMs: 5
    });
    assertJsonEquals(service.hasActiveRunToken('run-1', 'agent-1'), true);
    assertJsonEquals(service.validateRunToken('run-1', 'agent-1', token.token), true);
    now += 6;
    assertJsonEquals(service.validateRunToken('run-1', 'agent-1', token.token), false);
});

Deno.test('control service stores Rallar identity metadata on register and heartbeat', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());

    service.receiveClientEnvelope(toRegisterEnvelope({
        completedCommandIds: [],
        identity: {
            principalId: 'alice',
            clientId: 'alice',
            username: 'alice',
            sessionId: 'session-1',
            clientInstanceId: 'alice-browser',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
            providerMode: 'browser-rallar',
            browserLabel: 'Safari',
            sessionLabel: 'alice:session-1',
            updatedAtEpochMs: 1_000
        }
    }));

    let run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.agents[0].identity?.groupId, 'bb-group');
    assertJsonEquals(run.agents[0].identity?.sessionId, 'session-1');

    service.receiveClientEnvelope({
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_500,
        status: 'running',
        identity: {
            principalId: 'alice',
            clientId: 'alice',
            sessionId: 'session-1',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'new-group',
            providerMode: 'browser-rallar',
            updatedAtEpochMs: 1_500
        }
    });

    run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.agents[0].identity?.groupId, 'new-group');
    assertJsonEquals(run.heartbeats[0].identity?.groupId, 'new-group');
});

Deno.test('control service stores heartbeat and event telemetry', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope({
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_500,
        status: 'running',
        lastCommandId: 'configure-1'
    });
    service.receiveClientEnvelope({
        kind: 'diagnostic',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_600,
        eventId: 'event-1',
        commandId: 'configure-1',
        payload: {
            topic: 'rallar.bb.control.command_received'
        }
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.heartbeats.length, 1);
    assertJsonEquals(run.events.length, 1);
    assertJsonEquals(run.agents[0].status, 'running');
    assertJsonEquals(run.agents[0].receivedEventCount, 1);
});

Deno.test('control service stores stats and redacted reports separately', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope({
        kind: 'stats',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_700,
        eventId: 'stats-1',
        payload: {
            kind: 'stats',
            topic: 'rallar.bb.stats',
            payload: {
                counters: {
                    commands: 1,
                    events: 2,
                    failures: 0,
                    messages: 0,
                    diagnostics: 1
                }
            }
        }
    });
    service.receiveClientEnvelope({
        kind: 'report',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_800,
        eventId: 'report-1',
        payload: {
            kind: 'report',
            topic: 'rallar.bb.report.final',
            payload: {
                reportId: 'report-1',
                results: [
                    {
                        value: {
                            token: 'secret-token'
                        }
                    }
                ]
            }
        }
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.events.length, 2);
    assertJsonEquals(run.stats.length, 1);
    assertJsonEquals(run.reports.length, 1);
    assertJsonEquals(JSON.stringify(run.reports).includes('secret-token'), false);
    assertJsonEquals(JSON.stringify(run.reports).includes('"results"'), false);
});

Deno.test('control service compacts canonical reports and preserves arbitrary event payloads', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    const fullReport: ControlClientEnvelope = {
        kind: 'report',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_900,
        eventId: 'report-duplicate',
        payload: {
            kind: 'report',
            topic: 'rallar.bb.report.final',
            atEpochMs: 1_900,
            eventId: 'report-duplicate',
            payload: {
                reportId: 'report-duplicate',
                summary: { reason: 'disconnect' },
                results: [{ commandId: 'result-heavy', value: 'large-result' }],
                events: [{ eventId: 'event-heavy', value: 'large-event' }],
                stats: { atEpochMs: 1_900 }
            }
        }
    };
    const opaqueEnvelope: ControlClientEnvelope = {
        kind: 'report',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_901,
        eventId: 'opaque-record',
        payload: {
            reportId: 'opaque-record',
            summary: { reason: 'opaque-event' },
            results: [{ commandId: 'opaque-result', value: 'arbitrary-result' }],
            events: [{ eventId: 'opaque-event', value: 'arbitrary-event' }],
            stats: { atEpochMs: 1_901 }
        }
    };

    service.receiveClientEnvelope(fullReport);
    service.receiveClientEnvelope(fullReport);
    service.receiveClientEnvelope(opaqueEnvelope);

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.events.length, 2);
    assertJsonEquals(run.reports.length, 2);
    const nestedReportPayload = run.reports.find((report) => report.eventId === 'report-duplicate')
        ?.payload as {
            payload?: {
                summary?: { omittedResultCount?: number; omittedEventCount?: number; };
                results?: unknown;
                events?: unknown;
            };
        };
    assertJsonEquals(nestedReportPayload.payload?.results, undefined);
    assertJsonEquals(nestedReportPayload.payload?.events, undefined);
    assertJsonEquals(nestedReportPayload.payload?.summary?.omittedResultCount, 1);
    assertJsonEquals(nestedReportPayload.payload?.summary?.omittedEventCount, 1);
    const opaquePayload = run.reports.find((report) => report.eventId === 'opaque-record')
        ?.payload as {
            summary?: { omittedResultCount?: number; omittedEventCount?: number; };
            results?: unknown;
            events?: unknown;
        };
    assertJsonEquals(opaquePayload, opaqueEnvelope.payload);
});

Deno.test('control service compacts recipe run results while preserving distributed rollups', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));

    service.createDistributedRun({
        ...toDistributedManifest(),
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
        }
    });
    service.stageDistributedRun('dist-1');
    const stageCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: stageCommand, ok: true }));
    service.startDistributedRun('dist-1');
    const startCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: startCommand, ok: true }));

    const passed = service.snapshotDistributedRun('dist-1');
    assert(passed);
    assertJsonEquals(passed.state, 'passed');
    assertJsonEquals(passed.rollup.summary.passedRecipes, 1);

    const run = service.snapshotRun('run-1');
    assert(run);
    const recipeResult = run.results.find((result) => result.commandId === startCommand.commandId);
    assert(recipeResult);
    const value = recipeResult.result?.value as { results?: unknown; resultCount?: number; };
    assertJsonEquals(value.results, undefined);
    assertJsonEquals(value.resultCount, 1);
});

Deno.test('control service compact result failure counts include all composite child failures', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    const failedChildren = Array.from({ length: 25 }, (_, index) => ({
        commandId: `child-${index}`,
        commandIndex: index,
        result: {
            commandId: `child-${index}`,
            kind: 'assert',
            status: 'failed',
            ok: false,
            startedAtEpochMs: 2_000 + index,
            endedAtEpochMs: 2_001 + index,
            durationMs: 1,
            error: {
                code: 'ASSERT_FAILED',
                message: `Child ${index} failed.`
            }
        }
    }));

    service.receiveClientEnvelope({
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'loop-1',
        ok: false,
        result: {
            commandId: 'loop-1',
            kind: 'loop',
            status: 'failed',
            ok: false,
            startedAtEpochMs: 2_000,
            endedAtEpochMs: 2_100,
            durationMs: 100,
            value: {
                commandId: 'loop-1',
                iterations: 25,
                childResultCount: 25,
                passed: 0,
                failed: 25,
                cancelled: false,
                results: failedChildren
            }
        }
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    const loopResult = run.results.find((result) => result.commandId === 'loop-1');
    assert(loopResult);
    const value = loopResult.result?.value as {
        results?: unknown;
        resultCount?: number;
        failureCount?: number;
        failures?: readonly unknown[];
    };
    assertJsonEquals(value.results, undefined);
    assertJsonEquals(value.resultCount, 25);
    assertJsonEquals(value.failureCount, 25);
    assertJsonEquals(value.failures?.length, 20);
});

Deno.test('control service keeps terminal distributed rollups stable after runtime trimming', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        runtimeRetentionBounds: {
            commands: 10,
            results: 0,
            events: 0,
            stats: 0,
            reports: 0,
            heartbeats: 0
        }
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));

    service.createDistributedRun({
        ...toDistributedManifest(),
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
        }
    });
    service.stageDistributedRun('dist-1');
    const stageCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: stageCommand, ok: true }));
    service.startDistributedRun('dist-1');
    const startCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: startCommand, ok: true }));

    const passed = service.snapshotDistributedRun('dist-1');
    assert(passed);
    assertJsonEquals(passed.state, 'passed');
    assertJsonEquals(passed.rollup.summary.passedRecipes, 1);

    service.receiveClientEnvelope({
        kind: 'event',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 3_000,
        eventId: 'post-terminal-event',
        payload: { ok: true }
    });

    const trimmedRun = service.snapshotRun('run-1');
    assert(trimmedRun);
    assertJsonEquals(trimmedRun.results.length, 0);
    const stillPassed = service.snapshotDistributedRun('dist-1');
    assert(stillPassed);
    assertJsonEquals(stillPassed.state, 'passed');
    assertJsonEquals(stillPassed.rollup.summary.passedRecipes, 1);
    assertJsonEquals(stillPassed.rollup.summary.passedParticipants, 1);
});

Deno.test('control service runtime retention trims old evidence but keeps active distributed results', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        runtimeRetentionBounds: {
            commands: 2,
            results: 2,
            events: 2,
            stats: 1,
            reports: 1,
            heartbeats: 1
        }
    }));

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    for (let index = 1; index <= 4; index += 1) {
        const commandId = `health-${index}`;
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId,
            command: { kind: 'health', commandId }
        });
        service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId: 'agent-1',
            commandId,
            ok: true
        });
        service.receiveClientEnvelope({
            kind: 'event',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId: 'agent-1',
            atEpochMs: 2_000 + index,
            eventId: `event-${index}`,
            payload: { index }
        });
    }

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.commands.map((command) => command.envelope.commandId), ['health-3', 'health-4']);
    assertJsonEquals(run.results.map((result) => result.commandId), ['health-3', 'health-4']);
    assertJsonEquals(run.events.map((event) => event.eventId), ['event-3', 'event-4']);

    for (const reportId of ['report-1', 'report-2', 'report-1']) {
        service.receiveClientEnvelope({
            kind: 'report',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId: 'agent-1',
            atEpochMs: 3_000,
            eventId: reportId,
            payload: {
                kind: 'report',
                topic: 'rallar.bb.report.final',
                payload: { reportId }
            }
        });
    }

    const reportRun = service.snapshotRun('run-1');
    assert(reportRun);
    assertJsonEquals(reportRun.reports.length, 1);
    assertJsonEquals(reportRun.events.map((event) => event.eventId), ['report-1', 'report-2']);
    assertJsonEquals(
        (reportRun.reports[0].payload as { payload?: { reportId?: string; }; }).payload?.reportId,
        'report-2'
    );
});

Deno.test('control service report dedupe survives report payload retention trimming', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        runtimeRetentionBounds: {
            commands: 10,
            results: 10,
            events: 10,
            stats: 10,
            reports: 0,
            heartbeats: 10
        }
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    const report: ControlClientEnvelope = {
        kind: 'report',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 3_000,
        eventId: 'report-retained-key',
        payload: {
            kind: 'report',
            topic: 'rallar.bb.report.final',
            payload: {
                reportId: 'report-retained-key',
                summary: { reason: 'finished' }
            }
        }
    };

    const first = service.receiveClientEnvelope(report);
    const afterFirst = service.snapshotRun('run-1');
    assert(afterFirst);
    assertJsonEquals(first.accepted, true);
    assertJsonEquals(afterFirst.reports.length, 0);

    const duplicate = service.receiveClientEnvelope(report);
    const afterDuplicate = service.snapshotRun('run-1');
    assert(afterDuplicate);
    assertJsonEquals(duplicate.accepted, false);
    assertJsonEquals(
        afterDuplicate.events.filter((event) => event.eventId === 'report-retained-key').length,
        1
    );
});

Deno.test('control service returns bounded snapshots and resets or deletes runs', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());

    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: toConfigureCommand()
    });
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-2',
        command: {
            kind: 'configure',
            config: {
                runId: 'run-1',
                agentId: 'agent-1',
                actor: 'alice',
                roomId: 'room-2'
            }
        }
    });
    service.receiveClientEnvelope({
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_500,
        status: 'running'
    });
    service.receiveClientEnvelope({
        kind: 'diagnostic',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_600,
        eventId: 'event-1',
        payload: {
            topic: 'first'
        }
    });
    service.receiveClientEnvelope({
        kind: 'diagnostic',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_700,
        eventId: 'event-2',
        payload: {
            topic: 'second'
        }
    });

    const bounded = service.snapshotRun('run-1', {
        commands: 1,
        events: 1,
        heartbeats: 0
    });
    assert(bounded);
    assertJsonEquals(bounded.commands.map((command) => command.envelope.commandId), ['configure-2']);
    assertJsonEquals(bounded.events.map((event) => event.eventId), ['event-2']);
    assertJsonEquals(bounded.heartbeats.length, 0);

    const reset = service.resetRun('run-1');
    assert(reset);
    assertJsonEquals(reset.agents.length, 1);
    assertJsonEquals(reset.commands.length, 0);
    assertJsonEquals(reset.events.length, 0);
    assertJsonEquals(reset.heartbeats.length, 0);
    assertJsonEquals(reset.agents[0].receivedEventCount, 0);

    assertJsonEquals(service.deleteRun('run-1'), true);
    assertJsonEquals(service.snapshotRun('run-1'), undefined);
    assertJsonEquals(service.deleteRun('run-1'), false);
});

Deno.test('control service restores persisted snapshots as disconnected runs', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ completedCommandIds: [], identity: undefined }));
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: toConfigureCommand()
    });
    const snapshot = service.snapshot();

    const restored = createRallarBlackBoxControlService(toControlServiceInput());
    restored.restoreSnapshot(snapshot);
    const run = restored.snapshotRun('run-1');

    assert(run);
    assertJsonEquals(run.agents[0].agentId, 'agent-1');
    assertJsonEquals(run.agents[0].connected, false);
    assertJsonEquals(run.commands[0].envelope.commandId, 'configure-1');
});
Deno.test('control service records duplicate agent socket replacement diagnostics', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => 2_000
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));

    service.recordDuplicateAgentSocketReplacement('run-1', 'agent-1');

    const run = service.snapshotRun('run-1');
    assert(run);
    assertJsonEquals(run.events[0].kind, 'diagnostic');
    assertJsonEquals((run.events[0].payload as { topic?: string; }).topic, 'rallar.bb.control.duplicate-agent-socket');
});
Deno.test('control service prunes old runs by update time', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now++
    }));
    service.enqueueCommand({
        runId: 'run-old',
        agentId: 'agent-1',
        commandId: 'old-1',
        command: toConfigureCommand()
    });
    service.enqueueCommand({
        runId: 'run-new',
        agentId: 'agent-1',
        commandId: 'new-1',
        command: toConfigureCommand()
    });

    assertJsonEquals(service.applyRunRetention(1), ['run-old']);
    assertJsonEquals(service.snapshot().runs.map((run) => run.runId), ['run-new']);
});

Deno.test('control protocol parses client envelopes before server ingestion', () => {
    const parsed = parseControlClientMessage(JSON.stringify(toRegisterEnvelope({ completedCommandIds: ['configure-1'], identity: undefined })));

    assert(parsed.ok);
    assertJsonEquals(parsed.envelope.kind, 'register');
    assert(parsed.envelope.kind === 'register');
    assertJsonEquals(parsed.envelope.resume.completedCommandIds, ['configure-1']);

    assertJsonEquals(
        parseControlClientMessage(JSON.stringify({
            ...toRegisterEnvelope({ completedCommandIds: [], identity: undefined }),
            protocolVersion: 2
        })),
        {
            ok: false,
            error: 'Unsupported control protocol version.'
        }
    );
});

Deno.test('control protocol accepts scoped RTC commands inside recipes', () => {
    const parsed = parseControlServerMessage(
        JSON.stringify({
            kind: 'command',
            protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'stage-rtc',
            command: {
                kind: 'recipe.load',
                commandId: 'stage-rtc',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'rtc-scoped',
                    commands: [{
                        kind: 'rtc.connect',
                        commandId: 'rtc-connect',
                        connection: 'distributed-rtc',
                        actor: '{auth.clientId}',
                        roomId: 'room-1',
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        scope: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1'
                        },
                        roomRef: {
                            applicationId: 'app-1',
                            workspaceId: 'workspace-1',
                            groupId: 'room-1'
                        },
                        minSnapshotVersion: 3,
                        transport: 'realtime',
                        rallar: {
                            apiBaseUrl: 'http://localhost:8080',
                            restoreSession: true
                        }
                    }]
                }
            }
        }),
        {
            runId: 'run-1',
            agentId: 'agent-1'
        }
    );

    assert(parsed.ok, parsed.ok ? undefined : parsed.error);
    assertJsonEquals(parsed.envelope.command.kind, 'recipe.load');
});
