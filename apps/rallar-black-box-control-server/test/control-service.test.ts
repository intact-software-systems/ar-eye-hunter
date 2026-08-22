import {
    parseControlClientMessage,
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxControlAgentIdentity, RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';
import { createRallarBlackBoxControlService } from '../src/control-service.ts';

function assert(condition: unknown, message = 'Assertion failed.'): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEquals<T>(actual: T, expected: T): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `Expected ${JSON.stringify(expected, null, 2)}, got ${JSON.stringify(actual, null, 2)}`
        );
    }
}

function assertThrows(callback: () => unknown, includes: string): void {
    try {
        callback();
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        assert(
            message.includes(includes),
            `Expected error to include ${includes}, got ${message}`
        );
        return;
    }

    throw new Error('Expected function to throw.');
}

function configureCommand(): RallarBlackBoxTestCommand {
    return {
        kind: 'configure',
        config: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice'
        }
    };
}

function registerEnvelope(
    completedCommandIds: readonly string[] = [],
    identity?: RallarBlackBoxControlAgentIdentity
): ControlClientEnvelope {
    return registerEnvelopeFor('run-1', 'agent-1', completedCommandIds, identity);
}

function registerEnvelopeFor(
    runId: string,
    agentId: string,
    completedCommandIds: readonly string[] = [],
    identity?: RallarBlackBoxControlAgentIdentity
): ControlClientEnvelope {
    return {
        kind: 'register',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId,
        atEpochMs: 1_000,
        identity,
        resume: {
            completedCommandIds
        }
    };
}

function commandResultEnvelope(
    runId: string,
    agentId: string,
    command: Readonly<{ commandId: string; command: RallarBlackBoxTestCommand; }>,
    ok = true
): ControlClientEnvelope {
    return {
        kind: 'result',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId,
        agentId,
        commandId: command.commandId,
        ok,
        result: {
            commandId: command.commandId,
            kind: command.command.kind,
            status: ok ? 'ok' : 'failed',
            ok,
            startedAtEpochMs: 2_000,
            endedAtEpochMs: 2_010,
            durationMs: 10,
            value: command.command.kind === 'recipe.run'
                ? {
                    recipeId: 'health-only',
                    results: [
                        {
                            commandId: 'health-child',
                            kind: 'health',
                            status: 'ok',
                            ok: true,
                            startedAtEpochMs: 2_001,
                            endedAtEpochMs: 2_002,
                            durationMs: 1
                        }
                    ]
                }
                : { ok },
            error: ok ? undefined : {
                code: 'TEST_FAILURE',
                message: 'Simulated failure.'
            }
        }
    };
}

function distributedManifest(
    overrides: Partial<RallarBlackBoxDistributedRunManifest> = {}
): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'dist-1',
        controlRunId: 'run-1',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [
            {
                recipeId: 'health-only',
                recipe: {
                    recipeId: 'health-only',
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'health-child'
                        }
                    ]
                }
            }
        ],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1', 'agent-2']
        },
        startMode: 'manual',
        ackTimeoutMs: 1_000,
        ...overrides
    };
}

function fleetIdentity(
    agentId: string,
    overrides: Partial<RallarBlackBoxControlAgentIdentity> = {}
): RallarBlackBoxControlAgentIdentity {
    return {
        principalId: agentId,
        clientId: agentId,
        sessionId: `${agentId}-session`,
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group',
        ...overrides
    };
}

function registerFleetAgents(
    service: ReturnType<typeof createRallarBlackBoxControlService>,
    count: number
): void {
    for (let index = 1; index <= count; index += 1) {
        const agentId = `agent-${String(index).padStart(2, '0')}`;
        service.receiveClientEnvelope(registerEnvelopeFor(
            'run-1',
            agentId,
            [],
            fleetIdentity(agentId, {
                region: index <= Math.ceil(count / 2) ? 'eu-north' : 'us-east',
                provider: index % 2 === 0 ? 'fly' : 'hetzner'
            })
        ));
    }
}

function principalWorldFleetManifest(
    expectedParticipantCount: number
): RallarBlackBoxDistributedRunManifest {
    return distributedManifest({
        recipes: [
            {
                recipeId: 'sender-recipe',
                role: 'sender',
                recipe: {
                    recipeId: 'sender-recipe',
                    commands: [{ kind: 'health', commandId: 'sender-health' }]
                }
            },
            {
                recipeId: 'receiver-recipe',
                role: 'receiver',
                recipe: {
                    recipeId: 'receiver-recipe',
                    commands: [{ kind: 'health', commandId: 'receiver-health' }]
                }
            }
        ],
        targetPolicy: {
            mode: 'all-online-group-members',
            expectedParticipantCount
        },
        roleAssignmentPolicy: {
            mode: 'ordered-targets',
            pattern: 'one-sender-many-receivers',
            orderBy: 'agent-id'
        }
    });
}

Deno.test('control service queues and dispatches commands to a registered agent', () => {
    const service = createRallarBlackBoxControlService({
        now: (() => {
            let now = 1_000;
            return () => now++;
        })(),
        commandIdFactory: () => 'generated-command-1'
    });

    service.receiveClientEnvelope(registerEnvelope());
    const queued = service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        command: configureCommand()
    });

    assertEquals(queued.commandId, 'generated-command-1');
    assertEquals(
        service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.commandId),
        ['generated-command-1']
    );
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);

    const run = service.snapshotRun('run-1');
    assert(run);
    assertEquals(run.commands[0].dispatchCount, 1);
    assertEquals(run.agents[0].connected, true);
});

Deno.test('control service stores results and suppresses completed resume commands', () => {
    const service = createRallarBlackBoxControlService();

    service.receiveClientEnvelope(registerEnvelope());
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: configureCommand()
    });
    assertEquals(
        service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.commandId),
        ['configure-1']
    );

    service.markAgentDisconnected('run-1', 'agent-1');
    service.receiveClientEnvelope(registerEnvelope(['configure-1']));
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);

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
    assertEquals(run.results.length, 1);
    assertEquals(run.commands[0].completedAtEpochMs !== undefined, true);
    assertEquals(run.agents[0].completedCommandIds, ['configure-1']);
    assertEquals(run.agents[0].resumeCompletedCommandIds, []);
});

Deno.test('control service hardens command enqueueing and run tokens', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService({
        now: () => now,
        allowedCommandKinds: ['configure'],
        commandRateLimitMax: 1,
        commandRateLimitWindowMs: 1_000,
        runTokenTtlMs: 5
    });

    service.receiveClientEnvelope(registerEnvelope());
    const first = service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: configureCommand()
    });
    const duplicate = service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: configureCommand()
    });

    assertEquals(duplicate, first);
    assertThrows(() =>
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
        }), 'different payload');
    assertThrows(() =>
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'stats-1',
            command: {
                kind: 'stats'
            }
        }), 'not allowed');
    assertThrows(() =>
        service.enqueueCommand({
            runId: 'run-1',
            agentId: 'agent-1',
            commandId: 'configure-2',
            command: configureCommand()
        }), 'rate limit');

    const token = service.issueRunToken({
        runId: 'run-1',
        agentId: 'agent-1'
    });
    assertEquals(service.hasActiveRunToken('run-1', 'agent-1'), true);
    assertEquals(service.validateRunToken('run-1', 'agent-1', token.token), true);
    now += 6;
    assertEquals(service.validateRunToken('run-1', 'agent-1', token.token), false);
});

Deno.test('control service stores Rallar identity metadata on register and heartbeat', () => {
    const service = createRallarBlackBoxControlService();

    service.receiveClientEnvelope(registerEnvelope([], {
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
    }));

    let run = service.snapshotRun('run-1');
    assert(run);
    assertEquals(run.agents[0].identity?.groupId, 'bb-group');
    assertEquals(run.agents[0].identity?.sessionId, 'session-1');

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
    assertEquals(run.agents[0].identity?.groupId, 'new-group');
    assertEquals(run.heartbeats[0].identity?.groupId, 'new-group');
});

Deno.test('control service stores heartbeat and event telemetry', () => {
    const service = createRallarBlackBoxControlService();

    service.receiveClientEnvelope(registerEnvelope());
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
    assertEquals(run.heartbeats.length, 1);
    assertEquals(run.events.length, 1);
    assertEquals(run.agents[0].status, 'running');
    assertEquals(run.agents[0].receivedEventCount, 1);
});

Deno.test('control service stores stats and redacted reports separately', () => {
    const service = createRallarBlackBoxControlService();

    service.receiveClientEnvelope(registerEnvelope());
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
    assertEquals(run.events.length, 2);
    assertEquals(run.stats.length, 1);
    assertEquals(run.reports.length, 1);
    assertEquals(JSON.stringify(run.reports).includes('secret-token'), false);
    assertEquals(JSON.stringify(run.reports).includes('"results"'), false);
});

Deno.test('control service compacts and deduplicates legacy full report payloads', () => {
    const service = createRallarBlackBoxControlService();

    service.receiveClientEnvelope(registerEnvelope());
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
    const directFullReport: ControlClientEnvelope = {
        kind: 'report',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_901,
        eventId: 'direct-report',
        payload: {
            reportId: 'direct-report',
            summary: { reason: 'legacy-direct' },
            results: [{ commandId: 'direct-result-heavy', value: 'large-direct-result' }],
            events: [{ eventId: 'direct-event-heavy', value: 'large-direct-event' }],
            stats: { atEpochMs: 1_901 }
        }
    };

    service.receiveClientEnvelope(fullReport);
    service.receiveClientEnvelope(fullReport);
    service.receiveClientEnvelope(directFullReport);

    const run = service.snapshotRun('run-1');
    assert(run);
    assertEquals(run.events.length, 2);
    assertEquals(run.reports.length, 2);
    const nestedReportPayload = run.reports.find((report) => report.eventId === 'report-duplicate')
        ?.payload as {
            payload?: {
                summary?: { omittedResultCount?: number; omittedEventCount?: number; };
                results?: unknown;
                events?: unknown;
            };
        };
    assertEquals(nestedReportPayload.payload?.results, undefined);
    assertEquals(nestedReportPayload.payload?.events, undefined);
    assertEquals(nestedReportPayload.payload?.summary?.omittedResultCount, 1);
    assertEquals(nestedReportPayload.payload?.summary?.omittedEventCount, 1);
    const directReportPayload = run.reports.find((report) => report.eventId === 'direct-report')
        ?.payload as {
            summary?: { omittedResultCount?: number; omittedEventCount?: number; };
            results?: unknown;
            events?: unknown;
        };
    assertEquals(directReportPayload.results, undefined);
    assertEquals(directReportPayload.events, undefined);
    assertEquals(directReportPayload.summary?.omittedResultCount, 1);
    assertEquals(directReportPayload.summary?.omittedEventCount, 1);
});

Deno.test('control service compacts recipe run results while preserving distributed rollups', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));

    service.createDistributedRun({
        ...distributedManifest(),
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
        }
    });
    service.stageDistributedRun('dist-1');
    const stageCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', stageCommand));
    service.startDistributedRun('dist-1');
    const startCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', startCommand));

    const passed = service.snapshotDistributedRun('dist-1');
    assert(passed);
    assertEquals(passed.state, 'passed');
    assertEquals(passed.rollup.summary.passedRecipes, 1);

    const run = service.snapshotRun('run-1');
    assert(run);
    const recipeResult = run.results.find((result) => result.commandId === startCommand.commandId);
    assert(recipeResult);
    const value = recipeResult.result?.value as { results?: unknown; resultCount?: number; };
    assertEquals(value.results, undefined);
    assertEquals(value.resultCount, 1);
});

Deno.test('control service compact result failure counts include all composite child failures', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelope());
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
    assertEquals(value.results, undefined);
    assertEquals(value.resultCount, 25);
    assertEquals(value.failureCount, 25);
    assertEquals(value.failures?.length, 20);
});

Deno.test('control service keeps terminal distributed rollups stable after runtime trimming', () => {
    const service = createRallarBlackBoxControlService({
        runtimeRetentionBounds: {
            commands: 10,
            results: 0,
            events: 0,
            stats: 0,
            reports: 0,
            heartbeats: 0
        }
    });
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));

    service.createDistributedRun({
        ...distributedManifest(),
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
        }
    });
    service.stageDistributedRun('dist-1');
    const stageCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', stageCommand));
    service.startDistributedRun('dist-1');
    const startCommand = service.takeDispatchableCommands('run-1', 'agent-1')[0];
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', startCommand));

    const passed = service.snapshotDistributedRun('dist-1');
    assert(passed);
    assertEquals(passed.state, 'passed');
    assertEquals(passed.rollup.summary.passedRecipes, 1);

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
    assertEquals(trimmedRun.results.length, 0);
    const stillPassed = service.snapshotDistributedRun('dist-1');
    assert(stillPassed);
    assertEquals(stillPassed.state, 'passed');
    assertEquals(stillPassed.rollup.summary.passedRecipes, 1);
    assertEquals(stillPassed.rollup.summary.passedParticipants, 1);
});

Deno.test('control service runtime retention trims old evidence but keeps active distributed results', () => {
    const service = createRallarBlackBoxControlService({
        runtimeRetentionBounds: {
            commands: 2,
            results: 2,
            events: 2,
            stats: 1,
            reports: 1,
            heartbeats: 1
        }
    });

    service.receiveClientEnvelope(registerEnvelope());
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
    assertEquals(run.commands.map((command) => command.envelope.commandId), ['health-3', 'health-4']);
    assertEquals(run.results.map((result) => result.commandId), ['health-3', 'health-4']);
    assertEquals(run.events.map((event) => event.eventId), ['event-3', 'event-4']);

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
    assertEquals(reportRun.reports.length, 1);
    assertEquals(reportRun.events.map((event) => event.eventId), ['report-1', 'report-2']);
    assertEquals(
        (reportRun.reports[0].payload as { payload?: { reportId?: string; }; }).payload?.reportId,
        'report-2'
    );
});

Deno.test('control service report dedupe survives report payload retention trimming', () => {
    const service = createRallarBlackBoxControlService({
        runtimeRetentionBounds: {
            commands: 10,
            results: 10,
            events: 10,
            stats: 10,
            reports: 0,
            heartbeats: 10
        }
    });
    service.receiveClientEnvelope(registerEnvelope());
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
    assertEquals(first.accepted, true);
    assertEquals(afterFirst.reports.length, 0);

    const duplicate = service.receiveClientEnvelope(report);
    const afterDuplicate = service.snapshotRun('run-1');
    assert(afterDuplicate);
    assertEquals(duplicate.accepted, false);
    assertEquals(
        afterDuplicate.events.filter((event) => event.eventId === 'report-retained-key').length,
        1
    );
});

Deno.test('control service returns bounded snapshots and resets or deletes runs', () => {
    const service = createRallarBlackBoxControlService();

    service.receiveClientEnvelope(registerEnvelope());
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: configureCommand()
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
    assertEquals(bounded.commands.map((command) => command.envelope.commandId), ['configure-2']);
    assertEquals(bounded.events.map((event) => event.eventId), ['event-2']);
    assertEquals(bounded.heartbeats.length, 0);

    const reset = service.resetRun('run-1');
    assert(reset);
    assertEquals(reset.agents.length, 1);
    assertEquals(reset.commands.length, 0);
    assertEquals(reset.events.length, 0);
    assertEquals(reset.heartbeats.length, 0);
    assertEquals(reset.agents[0].receivedEventCount, 0);

    assertEquals(service.deleteRun('run-1'), true);
    assertEquals(service.snapshotRun('run-1'), undefined);
    assertEquals(service.deleteRun('run-1'), false);
});

Deno.test('control service restores persisted snapshots as disconnected runs', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelope());
    service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        commandId: 'configure-1',
        command: configureCommand()
    });
    const snapshot = service.snapshot();

    const restored = createRallarBlackBoxControlService();
    restored.restoreSnapshot(snapshot);
    const run = restored.snapshotRun('run-1');

    assert(run);
    assertEquals(run.agents[0].agentId, 'agent-1');
    assertEquals(run.agents[0].connected, false);
    assertEquals(run.commands[0].envelope.commandId, 'configure-1');
});

Deno.test('control service stages, starts, monitors, and exports distributed runs', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));

    const created = service.createDistributedRun(distributedManifest());
    assertEquals(created.state, 'draft');
    assertEquals(created.targetAgentIds, ['agent-1', 'agent-2']);

    const staged = service.stageDistributedRun('dist-1');
    assertEquals(staged.state, 'waiting-for-ack');
    assertEquals(staged.commandLinks.filter((link) => link.phase === 'stage').length, 2);

    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    assertEquals(agent1StageCommands[0].command.kind, 'recipe.load');
    assertEquals(agent2StageCommands[0].command.kind, 'recipe.load');

    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StageCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StageCommands[0]));

    const ready = service.snapshotDistributedRun('dist-1');
    assert(ready);
    assertEquals(ready.state, 'ready');
    assertEquals(ready.rollup.summary.readyParticipants, 2);

    const started = service.startDistributedRun('dist-1');
    assertEquals(started.state, 'running');
    assertEquals(started.commandLinks.filter((link) => link.phase === 'start').length, 2);

    const agent1StartCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StartCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    assertEquals(agent1StartCommands[0].command.kind, 'recipe.run');
    assertEquals(agent2StartCommands[0].command.kind, 'recipe.run');

    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StartCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StartCommands[0]));

    const passed = service.snapshotDistributedRun('dist-1');
    assert(passed);
    assertEquals(passed.state, 'passed');
    assertEquals(passed.rollup.ok, true);
    assertEquals(passed.rollup.summary.passedRecipes, 2);

    const bundle = service.distributedRunArtifactBundle('dist-1');
    assert(bundle);
    assertEquals(bundle.files['manifest.json'].includes('"distributedRunId": "dist-1"'), true);
    assert(typeof bundle.files['target-resolution.json'] === 'string');
    assertEquals(bundle.files['target-resolution.json'].includes('"targetAgentIds"'), true);
    assertEquals(bundle.files['control-run.json'].includes('"runId": "run-1"'), true);

    const snapshot = service.snapshot();
    const restored = createRallarBlackBoxControlService();
    restored.restoreSnapshot(snapshot);
    assertEquals(restored.snapshotDistributedRun('dist-1')?.state, 'passed');
});

Deno.test('control service reconciles persisted distributed start links from completed control results', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));

    service.createDistributedRun(distributedManifest());
    service.stageDistributedRun('dist-1');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StageCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StageCommands[0]));

    service.startDistributedRun('dist-1');
    const agent1StartCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StartCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StartCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StartCommands[0]));

    const snapshot = JSON.parse(JSON.stringify(service.snapshot())) as ReturnType<typeof service.snapshot>;
    const staleSnapshot = {
        ...snapshot,
        distributedRuns: (snapshot.distributedRuns ?? []).map((distributedRun) => ({
            ...distributedRun,
            state: 'ready' as const,
            startedAtEpochMs: undefined,
            completedAtEpochMs: undefined,
            commandLinks: distributedRun.commandLinks.filter((link) => link.phase !== 'start')
        }))
    };

    const restored = createRallarBlackBoxControlService();
    restored.restoreSnapshot(staleSnapshot);
    const reconciled = restored.snapshotDistributedRun('dist-1');

    assert(reconciled);
    assertEquals(reconciled.commandLinks.filter((link) => link.phase === 'start').length, 2);
    assertEquals(reconciled.state, 'passed');
    assertEquals(reconciled.rollup.ok, true);
});

Deno.test('control service derives, filters, persists, and exports fleet reports', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService({
        now: () => {
            now += 10;
            return now;
        },
        redaction: {
            secretValues: ['alpha-secret']
        }
    });
    const agent1Identity: RallarBlackBoxControlAgentIdentity = {
        principalId: 'alice',
        clientId: 'alice',
        sessionId: 'session-1',
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group',
        region: 'eu-north',
        provider: 'hetzner',
        datacenter: 'fsn1',
        location: {
            latitude: 52.5333,
            longitude: 13.3833,
            label: 'fsn1 worker rack',
            precision: 'exact'
        },
        browserName: 'chromium',
        browserVersion: '126',
        os: 'linux',
        tags: ['pool-a']
    };
    const agent2Identity: RallarBlackBoxControlAgentIdentity = {
        principalId: 'bob',
        clientId: 'bob',
        sessionId: 'session-2',
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group',
        region: 'us-east',
        provider: 'hetzner',
        datacenter: 'ash',
        location: {
            latitude: 39.0438,
            longitude: -77.4874,
            label: 'ash worker rack',
            precision: 'exact'
        },
        browserName: 'chromium',
        browserVersion: '126',
        os: 'linux',
        tags: ['pool-a']
    };
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1', [], agent1Identity));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2', [], agent2Identity));
    service.receiveClientEnvelope({
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: now,
        status: 'ready',
        identity: agent1Identity
    });
    service.receiveClientEnvelope({
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-2',
        atEpochMs: now,
        status: 'ready',
        identity: agent2Identity
    });

    service.createDistributedRun(distributedManifest());
    service.stageDistributedRun('dist-1');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StageCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StageCommands[0]));
    service.startDistributedRun('dist-1');
    const agent1StartCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StartCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope({
        kind: 'event',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-2',
        commandId: agent2StartCommands[0].commandId,
        atEpochMs: now,
        payload: {
            severity: 'warning',
            diagnosticTypeId: 'rtc.lane.mismatch',
            transport: 'rtc',
            message: 'RTC lane mismatch while executing distributed run.'
        }
    });
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StartCommands[0]));
    const failedResult = commandResultEnvelope(
        'run-1',
        'agent-2',
        agent2StartCommands[0],
        false
    ) as Extract<ControlClientEnvelope, { kind: 'result'; }>;
    service.receiveClientEnvelope({
        ...failedResult,
        result: {
            ...failedResult.result!,
            error: {
                code: 'ASSERT_SECRET_LEAK',
                message: 'Observed alpha-secret in distributed result.'
            }
        }
    });

    const fleet = service.listFleetReports();
    assertEquals(fleet.reports.length, 1);
    assertEquals(fleet.aggregate.runCount, 1);
    assertEquals(fleet.aggregate.agentCount, 2);
    const report = fleet.reports[0];
    assertEquals(report.fleetReportSchemaVersion, 1);
    assertEquals(report.state, 'failed');
    assertEquals(report.summary.agents, 2);
    assertEquals(report.summary.passed, 1);
    assertEquals(report.summary.failed, 1);
    assertEquals(report.agents.find((agent) => agent.agentId === 'agent-2')?.label.region, 'us-east');
    assertEquals(
        report.agents.find((agent) => agent.agentId === 'agent-1')?.label.location?.latitude,
        52.5333
    );
    assertEquals(
        report.agents.find((agent) => agent.agentId === 'agent-2')?.label.location?.label,
        'ash worker rack'
    );
    assert(report.regions.some((region) => region.region === 'eu-north'));
    assert(report.regions.some((region) => region.region === 'us-east'));
    assert(report.failureSignatures.some((signature) => signature.category === 'command'));
    assert(report.failureSignatures.some((signature) => signature.category === 'diagnostic'));
    assertEquals(JSON.stringify(report).includes('alpha-secret'), false);
    assert(JSON.stringify(report).includes('<redacted>'));

    const filtered = service.listFleetReports({ region: 'us-east' });
    assertEquals(filtered.reports.map((item) => item.distributedRunId), ['dist-1']);
    assertEquals(service.listFleetReports({ region: 'ap-south' }).reports.length, 0);

    const bundle = service.fleetReportBundle('dist-1');
    assert(bundle);
    assert(bundle.files['summary.md'].includes('Fleet Run Report'));
    assert(bundle.files['agent-results.csv'].includes('agent-2,us-east,hetzner,failed'));
    assertEquals(bundle.files['fleet-report.json'].includes('alpha-secret'), false);

    const rebuilt = service.rebuildFleetReports();
    assertEquals(rebuilt.reports.length, 1);
    const snapshot = service.snapshot();
    assertEquals(snapshot.fleetReports?.length, 1);
    const restored = createRallarBlackBoxControlService();
    restored.restoreSnapshot(snapshot);
    assertEquals(restored.listFleetReports().reports.length, 1);
});

Deno.test('control service coordinates distributed barrier before auto start', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService({
        now: () => now++
    });
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));
    service.createDistributedRun(distributedManifest({
        startMode: 'auto-after-ready',
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }));

    const staged = service.stageDistributedRun('dist-1');
    assertEquals(staged.state, 'waiting-for-ack');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');

    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StageCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StageCommands[0]));

    const waitingAtBarrier = service.snapshotDistributedRun('dist-1');
    assert(waitingAtBarrier);
    assertEquals(waitingAtBarrier.state, 'waiting-for-barrier');
    assertEquals(waitingAtBarrier.commandLinks.filter((link) => link.phase === 'barrier').length, 2);

    const agent1BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-1')
        .filter((command) => command.command.kind === 'health');
    const agent2BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-2')
        .filter((command) => command.command.kind === 'health');
    assertEquals(agent1BarrierCommands[0].command.metadata?.barrier, {
        event: 'barrier.ready',
        expectedAgentIds: ['agent-1', 'agent-2'],
        timeoutMs: 1_000,
        scheduledStartEpochMs: undefined
    });

    service.receiveClientEnvelope(
        commandResultEnvelope('run-1', 'agent-1', agent1BarrierCommands[0])
    );
    assertEquals(service.snapshotDistributedRun('dist-1')?.state, 'waiting-for-barrier');

    service.receiveClientEnvelope(
        commandResultEnvelope('run-1', 'agent-2', agent2BarrierCommands[0])
    );

    const running = service.snapshotDistributedRun('dist-1');
    assert(running);
    assertEquals(running.state, 'running');
    assertEquals(running.commandLinks.filter((link) => link.phase === 'stage').length, 2);
    assertEquals(running.commandLinks.filter((link) => link.phase === 'barrier').length, 2);
    assertEquals(running.commandLinks.filter((link) => link.phase === 'start').length, 2);
    assert(running.barrierStartedAtEpochMs !== undefined);
    assert(running.barrierCompletedAtEpochMs !== undefined);
});

Deno.test('control service holds barrier-ready scheduled runs until start time', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService({
        now: () => now
    });
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));
    service.createDistributedRun(distributedManifest({
        startMode: 'scheduled',
        startDeadlineEpochMs: 1_050,
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }));

    service.stageDistributedRun('dist-1');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', agent1StageCommands[0]));
    service.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', agent2StageCommands[0]));
    const agent1BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(
        commandResultEnvelope('run-1', 'agent-1', agent1BarrierCommands[0])
    );
    service.receiveClientEnvelope(
        commandResultEnvelope('run-1', 'agent-2', agent2BarrierCommands[0])
    );

    const ready = service.snapshotDistributedRun('dist-1');
    assert(ready);
    assertEquals(ready.state, 'ready');
    assertEquals(ready.commandLinks.filter((link) => link.phase === 'start').length, 0);

    now = 1_050;
    service.receiveClientEnvelope({
        kind: 'heartbeat',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: now,
        status: 'ready'
    });

    const running = service.snapshotDistributedRun('dist-1');
    assert(running);
    assertEquals(running.state, 'running');
    assertEquals(running.commandLinks.filter((link) => link.phase === 'start').length, 2);
});

Deno.test('control service reports distributed barrier timeout, disconnect, and cancellation', () => {
    let now = 1_000;
    const timeoutService = createRallarBlackBoxControlService({
        now: () => now
    });
    timeoutService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    timeoutService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));
    timeoutService.createDistributedRun(distributedManifest({
        distributedRunId: 'dist-barrier-timeout',
        barrier: {
            enabled: true,
            timeoutMs: 10
        }
    }));
    timeoutService.stageDistributedRun('dist-barrier-timeout');
    const timeoutStage1 = timeoutService.takeDispatchableCommands('run-1', 'agent-1')[0];
    const timeoutStage2 = timeoutService.takeDispatchableCommands('run-1', 'agent-2')[0];
    timeoutService.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', timeoutStage1));
    timeoutService.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', timeoutStage2));
    const timeoutBarrier1 = timeoutService.takeDispatchableCommands('run-1', 'agent-1')[0];
    timeoutService.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', timeoutBarrier1));
    now += 11;

    const timedOut = timeoutService.snapshotDistributedRun('dist-barrier-timeout');
    assert(timedOut);
    assertEquals(timedOut.state, 'timed-out');
    assertEquals(timedOut.rollup.failures[0].error?.code, 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT');

    const disconnectService = createRallarBlackBoxControlService();
    disconnectService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    disconnectService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));
    disconnectService.createDistributedRun(distributedManifest({
        distributedRunId: 'dist-barrier-disconnect',
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }));
    disconnectService.stageDistributedRun('dist-barrier-disconnect');
    const disconnectStage1 = disconnectService.takeDispatchableCommands('run-1', 'agent-1')[0];
    const disconnectStage2 = disconnectService.takeDispatchableCommands('run-1', 'agent-2')[0];
    disconnectService.receiveClientEnvelope(
        commandResultEnvelope('run-1', 'agent-1', disconnectStage1)
    );
    disconnectService.receiveClientEnvelope(
        commandResultEnvelope('run-1', 'agent-2', disconnectStage2)
    );
    disconnectService.markAgentDisconnected('run-1', 'agent-2');

    const failed = disconnectService.snapshotDistributedRun('dist-barrier-disconnect');
    assert(failed);
    assertEquals(failed.state, 'failed');
    assertEquals(failed.rollup.failures[0].error?.code, 'RALLAR_BB_DISTRIBUTED_BARRIER_DISCONNECTED');

    const cancelService = createRallarBlackBoxControlService();
    cancelService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    cancelService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));
    cancelService.createDistributedRun(distributedManifest({
        distributedRunId: 'dist-barrier-cancel',
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }));
    cancelService.stageDistributedRun('dist-barrier-cancel');
    const cancelStage1 = cancelService.takeDispatchableCommands('run-1', 'agent-1')[0];
    const cancelStage2 = cancelService.takeDispatchableCommands('run-1', 'agent-2')[0];
    cancelService.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-1', cancelStage1));
    cancelService.receiveClientEnvelope(commandResultEnvelope('run-1', 'agent-2', cancelStage2));

    const cancelled = cancelService.cancelDistributedRun(
        'dist-barrier-cancel',
        'operator cancelled at barrier'
    );
    assertEquals(cancelled.state, 'cancelled');
    assertEquals(cancelled.commandLinks.filter((link) => link.phase === 'cancel').length, 2);
});

Deno.test('control service cancels distributed runs and queues cancel commands', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    service.createDistributedRun(distributedManifest({
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
        }
    }));

    const cancelled = service.cancelDistributedRun('dist-1', 'operator stopped test');
    assertEquals(cancelled.state, 'cancelled');
    assertEquals(cancelled.commandLinks.length, 1);
    assertEquals(cancelled.commandLinks[0].phase, 'cancel');

    const commands = service.takeDispatchableCommands('run-1', 'agent-1');
    assertEquals(commands[0].command.kind, 'recipe.cancel');
});

Deno.test('control service resolves all-online distributed targets from Rallar identity', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1', [], {
        principalId: 'alice',
        clientId: 'alice',
        sessionId: 'session-1',
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group'
    }));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2', [], {
        principalId: 'bob',
        clientId: 'bob',
        sessionId: 'session-2',
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'other-group'
    }));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-3', [], {
        principalId: 'carol',
        clientId: 'carol',
        sessionId: 'session-3',
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'bb-group'
    }));
    service.markAgentDisconnected('run-1', 'agent-3');

    const created = service.createDistributedRun(distributedManifest({
        targetPolicy: {
            mode: 'all-online-group-members'
        }
    }));

    assertEquals(created.targetAgentIds, ['agent-1']);
    const staged = service.stageDistributedRun('dist-1');
    assertEquals(staged.commandLinks.map((link) => link.agentId), ['agent-1']);
});

Deno.test('control service keeps explicit role-map target resolution aligned without fleet identity', () => {
    const service = createRallarBlackBoxControlService();
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-2'));

    const created = service.createDistributedRun(distributedManifest({
        recipes: [
            {
                recipeId: 'sender-recipe',
                role: 'sender',
                recipe: {
                    recipeId: 'sender-recipe',
                    commands: [{ kind: 'health', commandId: 'sender-health' }]
                }
            },
            {
                recipeId: 'receiver-recipe',
                role: 'receiver',
                recipe: {
                    recipeId: 'receiver-recipe',
                    commands: [{ kind: 'health', commandId: 'receiver-health' }]
                }
            }
        ],
        targetPolicy: {
            mode: 'role-map',
            expectedParticipantCount: 2,
            roles: {
                sender: ['agent-1'],
                receiver: ['agent-2']
            }
        },
        roleAssignments: [
            { role: 'sender', agentId: 'agent-1', required: true },
            { role: 'receiver', agentId: 'agent-2', required: true }
        ]
    }));

    assertEquals(created.targetAgentIds, ['agent-1', 'agent-2']);
    assertEquals(created.targetResolution?.targetAgentIds, ['agent-1', 'agent-2']);
    assertEquals(created.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-1', required: true },
        { role: 'receiver', agentId: 'agent-2', required: true }
    ]);
    assertEquals(created.targetResolution?.summary.selected, 2);

    const staged = service.stageDistributedRun('dist-1');
    assertEquals(
        staged.commandLinks.filter((link) => link.phase === 'stage').map((link) => [
            link.agentId,
            link.recipeId,
            link.role
        ]),
        [
            ['agent-1', 'sender-recipe', 'sender'],
            ['agent-2', 'receiver-recipe', 'receiver']
        ]
    );
});

Deno.test('control service resolves 50 global fleet targets and routes derived roles', () => {
    const service = createRallarBlackBoxControlService();
    registerFleetAgents(service, 50);

    const created = service.createDistributedRun(principalWorldFleetManifest(50));

    assertEquals(created.targetAgentIds.length, 50);
    assertEquals(created.targetAgentIds[0], 'agent-01');
    assertEquals(created.targetAgentIds[49], 'agent-50');
    assertEquals(created.targetResolution?.summary.selected, 50);
    assertEquals(created.targetResolution?.summary.roleCounts, {
        receiver: 49,
        sender: 1
    });
    assertEquals(created.targetResolution?.summary.regions, {
        'eu-north': 25,
        'us-east': 25
    });

    const staged = service.stageDistributedRun('dist-1');

    assertEquals(staged.state, 'waiting-for-ack');
    assertEquals(staged.commandLinks.filter((link) => link.phase === 'stage').length, 50);
    assertEquals(staged.commandLinks.filter((link) => link.role === 'sender').map((link) => link.agentId), [
        'agent-01'
    ]);
    assertEquals(staged.commandLinks.filter((link) => link.role === 'receiver').length, 49);

    const senderStageCommands = service.takeDispatchableCommands('run-1', 'agent-01');
    const receiverStageCommands = service.takeDispatchableCommands('run-1', 'agent-02');

    assertEquals(senderStageCommands[0].command.kind, 'recipe.load');
    assertEquals(
        senderStageCommands[0].command.kind === 'recipe.load'
            ? senderStageCommands[0].command.recipe.recipeId
            : undefined,
        'sender-recipe'
    );
    assertEquals(receiverStageCommands[0].command.kind, 'recipe.load');
    assertEquals(
        receiverStageCommands[0].command.kind === 'recipe.load'
            ? receiverStageCommands[0].command.recipe.recipeId
            : undefined,
        'receiver-recipe'
    );
});

Deno.test('control service records duplicate agent socket replacement diagnostics', () => {
    const service = createRallarBlackBoxControlService({
        now: () => 2_000
    });
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));

    service.recordDuplicateAgentSocketReplacement('run-1', 'agent-1');

    const run = service.snapshotRun('run-1');
    assert(run);
    assertEquals(run.events[0].kind, 'diagnostic');
    assertEquals((run.events[0].payload as { topic?: string; }).topic, 'rallar.bb.control.duplicate-agent-socket');
});

Deno.test('control service fails global fleet mismatch before queueing commands', () => {
    const service = createRallarBlackBoxControlService();
    registerFleetAgents(service, 49);

    service.createDistributedRun(principalWorldFleetManifest(50));
    const staged = service.stageDistributedRun('dist-1');

    assertEquals(staged.state, 'failed');
    assertEquals(staged.error?.code, 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');
    assertEquals(staged.commandLinks.length, 0);
    assertEquals(staged.targetResolution?.summary.selected, 49);
    assertEquals(staged.targetResolution?.summary.expectedParticipantCount, 50);
    assertEquals(staged.targetResolution?.summary.missingExpectedParticipants, 1);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-01'), []);
});

Deno.test('control service freezes global fleet target roles after staging', () => {
    const service = createRallarBlackBoxControlService();
    registerFleetAgents(service, 3);

    const staged = service.stageDistributedRun(
        service.createDistributedRun(principalWorldFleetManifest(3)).distributedRunId
    );
    assertEquals(staged.targetAgentIds, ['agent-01', 'agent-02', 'agent-03']);
    assertEquals(staged.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-01', required: true },
        { role: 'receiver', agentId: 'agent-02', required: true },
        { role: 'receiver', agentId: 'agent-03', required: true }
    ]);

    for (const agentId of staged.targetAgentIds) {
        const [stageCommand] = service.takeDispatchableCommands('run-1', agentId);
        service.receiveClientEnvelope(commandResultEnvelope('run-1', agentId, stageCommand));
    }
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-00', [], fleetIdentity('agent-00')));

    const started = service.startDistributedRun('dist-1');
    assertEquals(started.state, 'running');
    assertEquals(started.targetAgentIds, ['agent-01', 'agent-02', 'agent-03']);
    assertEquals(started.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-01', required: true },
        { role: 'receiver', agentId: 'agent-02', required: true },
        { role: 'receiver', agentId: 'agent-03', required: true }
    ]);
    assertEquals(started.commandLinks.filter((link) => link.phase === 'start').map((link) => link.agentId), [
        'agent-01',
        'agent-02',
        'agent-03'
    ]);
});

Deno.test('control service reports distributed target mismatch and ACK timeout', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService({
        now: () => now
    });
    service.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));

    service.createDistributedRun(distributedManifest({
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1'],
            expectedParticipantCount: 2
        }
    }));
    const mismatched = service.stageDistributedRun('dist-1');
    assertEquals(mismatched.state, 'failed');
    assertEquals(mismatched.error?.code, 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');

    const timeoutService = createRallarBlackBoxControlService({
        now: () => now
    });
    timeoutService.receiveClientEnvelope(registerEnvelopeFor('run-1', 'agent-1'));
    timeoutService.createDistributedRun(distributedManifest({
        distributedRunId: 'dist-timeout',
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
        },
        ackTimeoutMs: 10
    }));
    timeoutService.stageDistributedRun('dist-timeout');
    now += 11;

    const timedOut = timeoutService.snapshotDistributedRun('dist-timeout');
    assert(timedOut);
    assertEquals(timedOut.state, 'timed-out');
    assertEquals(timedOut.rollup.failures[0].state, 'timed-out');

    const timedOutAgain = timeoutService.snapshotDistributedRun('dist-timeout');
    assert(timedOutAgain);
    assertEquals(timedOutAgain.state, 'timed-out');
    assertEquals(timedOutAgain.rollup.failures[0].state, 'timed-out');
});

Deno.test('control service prunes old runs by update time', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService({
        now: () => now++
    });
    service.enqueueCommand({
        runId: 'run-old',
        agentId: 'agent-1',
        commandId: 'old-1',
        command: configureCommand()
    });
    service.enqueueCommand({
        runId: 'run-new',
        agentId: 'agent-1',
        commandId: 'new-1',
        command: configureCommand()
    });

    assertEquals(service.pruneRuns(1), ['run-old']);
    assertEquals(service.snapshot().runs.map((run) => run.runId), ['run-new']);
});

Deno.test('control protocol parses client envelopes before server ingestion', () => {
    const parsed = parseControlClientMessage(JSON.stringify(registerEnvelope(['configure-1'])));

    assert(parsed.ok);
    assertEquals(parsed.envelope.kind, 'register');
    assert(parsed.envelope.kind === 'register');
    assertEquals(parsed.envelope.resume.completedCommandIds, ['configure-1']);

    assertEquals(
        parseControlClientMessage(JSON.stringify({
            ...registerEnvelope(),
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
    assertEquals(parsed.envelope.command.kind, 'recipe.load');
});
