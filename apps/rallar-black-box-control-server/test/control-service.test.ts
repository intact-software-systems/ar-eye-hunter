import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    type ControlClientEnvelope,
    parseControlClientMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
} from '../../rallar-black-box/src/control-protocol.ts';
import type { RallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/types.ts';

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

function configureCommand(): RallarBlackBoxTestCommand {
    return {
        kind: 'configure',
        config: {
            runId: 'run-1',
            agentId: 'agent-1',
            actor: 'alice',
        },
    };
}

function registerEnvelope(completedCommandIds: readonly string[] = []): ControlClientEnvelope {
    return {
        kind: 'register',
        protocolVersion: RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
        runId: 'run-1',
        agentId: 'agent-1',
        atEpochMs: 1_000,
        resume: {
            completedCommandIds,
        },
    };
}

Deno.test('control service queues and dispatches commands to a registered agent', () => {
    const service = createRallarBlackBoxControlService({
        now: (() => {
            let now = 1_000;
            return () => now++;
        })(),
        commandIdFactory: () => 'generated-command-1',
    });

    service.receiveClientEnvelope(registerEnvelope());
    const queued = service.enqueueCommand({
        runId: 'run-1',
        agentId: 'agent-1',
        command: configureCommand(),
    });

    assertEquals(queued.commandId, 'generated-command-1');
    assertEquals(
        service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.commandId),
        ['generated-command-1'],
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
        command: configureCommand(),
    });
    assertEquals(
        service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.commandId),
        ['configure-1'],
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
                configured: true,
            },
        },
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    assertEquals(run.results.length, 1);
    assertEquals(run.commands[0].completedAtEpochMs !== undefined, true);
    assertEquals(run.agents[0].completedCommandIds, ['configure-1']);
    assertEquals(run.agents[0].resumeCompletedCommandIds, []);
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
        lastCommandId: 'configure-1',
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
            topic: 'rallar.bb.control.command_received',
        },
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
                    diagnostics: 1,
                },
            },
        },
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
                            token: 'secret-token',
                        },
                    },
                ],
            },
        },
    });

    const run = service.snapshotRun('run-1');
    assert(run);
    assertEquals(run.events.length, 2);
    assertEquals(run.stats.length, 1);
    assertEquals(run.reports.length, 1);
    assertEquals(JSON.stringify(run.reports).includes('secret-token'), false);
    assertEquals(JSON.stringify(run.reports).includes('<redacted>'), true);
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
            protocolVersion: 2,
        })),
        {
            ok: false,
            error: 'Unsupported control protocol version.',
        },
    );
});
