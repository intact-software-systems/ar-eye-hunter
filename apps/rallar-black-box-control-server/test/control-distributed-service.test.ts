import {
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION,
    type ControlClientEnvelope
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxControlAgentIdentity } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { assert } from '@std/assert';

import { createRallarBlackBoxControlService } from '../src/control-service.ts';
import {
    assertJsonEquals,
    assertRight,
    registerFleetAgents,
    toCommandResultEnvelope,
    toControlServiceInput,
    toDistributedManifest,
    toFleetIdentity,
    toPrincipalWorldFleetManifest,
    toRegisterEnvelope
} from './support/control-service-test-fixtures.ts';

Deno.test('control service stages, starts, monitors, and exports distributed runs', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));

    const created = assertRight(service.createDistributedRun(toDistributedManifest()));
    assertJsonEquals(created.state, 'draft');
    assertJsonEquals(created.targetAgentIds, ['agent-1', 'agent-2']);

    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(staged.state, 'waiting-for-ack');
    assertJsonEquals(staged.commandLinks.filter((link) => link.phase === 'stage').length, 2);

    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    assertJsonEquals(agent1StageCommands[0].command.kind, 'recipe.load');
    assertJsonEquals(agent2StageCommands[0].command.kind, 'recipe.load');

    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StageCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StageCommands[0], ok: true }));

    const ready = service.snapshotDistributedRun('dist-1');
    assert(ready);
    assertJsonEquals(ready.state, 'ready');
    assertJsonEquals(ready.rollup.summary.readyParticipants, 2);

    const started = assertRight(service.startDistributedRun('dist-1'));
    assertJsonEquals(started.state, 'running');
    assertJsonEquals(started.commandLinks.filter((link) => link.phase === 'start').length, 2);

    const agent1StartCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StartCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    assertJsonEquals(agent1StartCommands[0].command.kind, 'recipe.run');
    assertJsonEquals(agent2StartCommands[0].command.kind, 'recipe.run');

    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StartCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StartCommands[0], ok: true }));

    const passed = service.snapshotDistributedRun('dist-1');
    assert(passed);
    assertJsonEquals(passed.state, 'passed');
    assertJsonEquals(passed.rollup.ok, true);
    assertJsonEquals(passed.rollup.summary.passedRecipes, 2);

    const bundle = service.createDistributedRunArtifactBundle('dist-1', {});
    assert(bundle);
    assertJsonEquals(bundle.files['manifest.json'].includes('"distributedRunId": "dist-1"'), true);
    assert(typeof bundle.files['target-resolution.json'] === 'string');
    assertJsonEquals(bundle.files['target-resolution.json'].includes('"targetAgentIds"'), true);
    assertJsonEquals(bundle.files['control-run.json'].includes('"runId": "run-1"'), true);

    const snapshot = service.snapshot();
    const restored = createRallarBlackBoxControlService(toControlServiceInput());
    restored.restoreSnapshot(snapshot);
    assertJsonEquals(restored.snapshotDistributedRun('dist-1')?.state, 'passed');
});

Deno.test('control service reconciles persisted distributed start links from completed control results', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));

    service.createDistributedRun(toDistributedManifest());
    service.stageDistributedRun('dist-1');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StageCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StageCommands[0], ok: true }));

    service.startDistributedRun('dist-1');
    const agent1StartCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StartCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StartCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StartCommands[0], ok: true }));

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

    const restored = createRallarBlackBoxControlService(toControlServiceInput());
    restored.restoreSnapshot(staleSnapshot);
    const reconciled = restored.snapshotDistributedRun('dist-1');

    assert(reconciled);
    assertJsonEquals(reconciled.commandLinks.filter((link) => link.phase === 'start').length, 2);
    assertJsonEquals(reconciled.state, 'passed');
    assertJsonEquals(reconciled.rollup.ok, true);
});

Deno.test('control service derives, filters, persists, and exports fleet reports', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => {
            now += 10;
            return now;
        },
        redaction: {
            secretValues: ['alpha-secret']
        }
    }));
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
        tags: ['pool-a'],
        sessionLabel: 'alice:session-1',
        updatedAtEpochMs: 1_000
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
        tags: ['pool-a'],
        sessionLabel: 'bob:session-2',
        updatedAtEpochMs: 1_000
    };
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: agent1Identity }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: agent2Identity }));
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

    service.createDistributedRun(toDistributedManifest());
    service.stageDistributedRun('dist-1');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StageCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StageCommands[0], ok: true }));
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
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StartCommands[0], ok: true }));
    const failedResult = toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StartCommands[0], ok: false }) as Extract<
        ControlClientEnvelope,
        { kind: 'result'; }
    >;
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

    const fleet = service.listFleetReports({});
    assertJsonEquals(fleet.reports.length, 1);
    assertJsonEquals(fleet.aggregate.runCount, 1);
    assertJsonEquals(fleet.aggregate.agentCount, 2);
    const report = fleet.reports[0];
    assertJsonEquals(report.fleetReportSchemaVersion, 1);
    assertJsonEquals(report.state, 'failed');
    assertJsonEquals(report.summary.agents, 2);
    assertJsonEquals(report.summary.passed, 1);
    assertJsonEquals(report.summary.failed, 1);
    assertJsonEquals(report.agents.find((agent) => agent.agentId === 'agent-2')?.label.region, 'us-east');
    assertJsonEquals(
        report.agents.find((agent) => agent.agentId === 'agent-1')?.label.location?.latitude,
        52.5333
    );
    assertJsonEquals(
        report.agents.find((agent) => agent.agentId === 'agent-2')?.label.location?.label,
        'ash worker rack'
    );
    assert(report.regions.some((region) => region.region === 'eu-north'));
    assert(report.regions.some((region) => region.region === 'us-east'));
    assert(report.failureSignatures.some((signature) => signature.category === 'command'));
    assert(report.failureSignatures.some((signature) => signature.category === 'diagnostic'));
    assertJsonEquals(JSON.stringify(report).includes('alpha-secret'), false);
    assert(JSON.stringify(report).includes('<redacted>'));

    const filtered = service.listFleetReports({ region: 'us-east' });
    assertJsonEquals(filtered.reports.map((item) => item.distributedRunId), ['dist-1']);
    assertJsonEquals(service.listFleetReports({ region: 'ap-south' }).reports.length, 0);

    const bundle = service.createFleetReportBundle('dist-1');
    assert(bundle);
    assert(bundle.files['summary.md'].includes('Fleet Run Report'));
    assert(bundle.files['agent-results.csv'].includes('agent-2,us-east,hetzner,failed'));
    assertJsonEquals(bundle.files['fleet-report.json'].includes('alpha-secret'), false);

    const rebuilt = service.rebuildFleetReports();
    assertJsonEquals(rebuilt.reports.length, 1);
    const snapshot = service.snapshot();
    assertJsonEquals(snapshot.fleetReports?.length, 1);
    const restored = createRallarBlackBoxControlService(toControlServiceInput());
    restored.restoreSnapshot(snapshot);
    assertJsonEquals(restored.listFleetReports({}).reports.length, 1);
});

Deno.test('control service coordinates distributed barrier before auto start', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now++
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));
    service.createDistributedRun(toDistributedManifest({
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }, { startMode: 'auto-after-ready' }));

    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(staged.state, 'waiting-for-ack');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');

    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StageCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StageCommands[0], ok: true }));

    const waitingAtBarrier = service.snapshotDistributedRun('dist-1');
    assert(waitingAtBarrier);
    assertJsonEquals(waitingAtBarrier.state, 'waiting-for-barrier');
    assertJsonEquals(waitingAtBarrier.commandLinks.filter((link) => link.phase === 'barrier').length, 2);

    const agent1BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-1')
        .filter((command) => command.command.kind === 'health');
    const agent2BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-2')
        .filter((command) => command.command.kind === 'health');
    assertJsonEquals(agent1BarrierCommands[0].command.metadata?.barrier, {
        event: 'barrier.ready',
        expectedAgentIds: ['agent-1', 'agent-2'],
        timeoutMs: 1_000,
        scheduledStartEpochMs: undefined
    });

    service.receiveClientEnvelope(
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1BarrierCommands[0], ok: true })
    );
    assertJsonEquals(service.snapshotDistributedRun('dist-1')?.state, 'waiting-for-barrier');

    service.receiveClientEnvelope(
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2BarrierCommands[0], ok: true })
    );

    const running = service.snapshotDistributedRun('dist-1');
    assert(running);
    assertJsonEquals(running.state, 'running');
    assertJsonEquals(running.commandLinks.filter((link) => link.phase === 'stage').length, 2);
    assertJsonEquals(running.commandLinks.filter((link) => link.phase === 'barrier').length, 2);
    assertJsonEquals(running.commandLinks.filter((link) => link.phase === 'start').length, 2);
    assert(running.barrierStartedAtEpochMs !== undefined);
    assert(running.barrierCompletedAtEpochMs !== undefined);
});

Deno.test('control service holds barrier-ready scheduled runs until start time', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));
    service.createDistributedRun(toDistributedManifest({
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }, { startMode: 'scheduled', startDeadlineEpochMs: 1_050 }));

    service.stageDistributedRun('dist-1');
    const agent1StageCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2StageCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1StageCommands[0], ok: true }));
    service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StageCommands[0], ok: true }));
    const agent1BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-1');
    const agent2BarrierCommands = service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: agent1BarrierCommands[0], ok: true })
    );
    service.receiveClientEnvelope(
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2BarrierCommands[0], ok: true })
    );

    const ready = service.snapshotDistributedRun('dist-1');
    assert(ready);
    assertJsonEquals(ready.state, 'ready');
    assertJsonEquals(ready.commandLinks.filter((link) => link.phase === 'start').length, 0);

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
    assertJsonEquals(running.state, 'running');
    assertJsonEquals(running.commandLinks.filter((link) => link.phase === 'start').length, 2);
});

Deno.test('control service reports distributed barrier timeout, disconnect, and cancellation', () => {
    let now = 1_000;
    const timeoutService = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now
    }));
    timeoutService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    timeoutService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));
    timeoutService.createDistributedRun(toDistributedManifest({
        distributedRunId: 'dist-barrier-timeout',
        barrier: {
            enabled: true,
            timeoutMs: 10
        }
    }));
    timeoutService.stageDistributedRun('dist-barrier-timeout');
    const timeoutStage1 = timeoutService.takeDispatchableCommands('run-1', 'agent-1')[0];
    const timeoutStage2 = timeoutService.takeDispatchableCommands('run-1', 'agent-2')[0];
    timeoutService.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: timeoutStage1, ok: true }));
    timeoutService.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: timeoutStage2, ok: true }));
    const timeoutBarrier1 = timeoutService.takeDispatchableCommands('run-1', 'agent-1')[0];
    timeoutService.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: timeoutBarrier1, ok: true }));
    now += 11;

    const timedOut = timeoutService.snapshotDistributedRun('dist-barrier-timeout');
    assert(timedOut);
    assertJsonEquals(timedOut.state, 'timed-out');
    assertJsonEquals(timedOut.rollup.failures[0].error?.code, 'RALLAR_BB_DISTRIBUTED_BARRIER_TIMEOUT');

    const disconnectService = createRallarBlackBoxControlService(toControlServiceInput());
    disconnectService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    disconnectService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));
    disconnectService.createDistributedRun(toDistributedManifest({
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
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: disconnectStage1, ok: true })
    );
    disconnectService.receiveClientEnvelope(
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: disconnectStage2, ok: true })
    );
    disconnectService.markAgentDisconnected('run-1', 'agent-2');

    const failed = disconnectService.snapshotDistributedRun('dist-barrier-disconnect');
    assert(failed);
    assertJsonEquals(failed.state, 'failed');
    assertJsonEquals(failed.rollup.failures[0].error?.code, 'RALLAR_BB_DISTRIBUTED_BARRIER_DISCONNECTED');

    const cancelService = createRallarBlackBoxControlService(toControlServiceInput());
    cancelService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    cancelService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));
    cancelService.createDistributedRun(toDistributedManifest({
        distributedRunId: 'dist-barrier-cancel',
        barrier: {
            enabled: true,
            timeoutMs: 1_000
        }
    }));
    cancelService.stageDistributedRun('dist-barrier-cancel');
    const cancelStage1 = cancelService.takeDispatchableCommands('run-1', 'agent-1')[0];
    const cancelStage2 = cancelService.takeDispatchableCommands('run-1', 'agent-2')[0];
    cancelService.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: cancelStage1, ok: true }));
    cancelService.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: cancelStage2, ok: true }));

    const cancelled = assertRight(cancelService.cancelDistributedRun(
        'dist-barrier-cancel',
        'operator cancelled at barrier'
    ));
    assertJsonEquals(cancelled.state, 'cancelled');
    assertJsonEquals(cancelled.commandLinks.filter((link) => link.phase === 'cancel').length, 2);
});

Deno.test('control service cancels distributed runs and queues cancel commands', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.createDistributedRun(toDistributedManifest({
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1'],
            includeOfflineExpectedAgents: false
        }
    }));

    const cancelled = assertRight(service.cancelDistributedRun('dist-1', 'operator stopped test'));
    assertJsonEquals(cancelled.state, 'cancelled');
    assertJsonEquals(cancelled.commandLinks.length, 1);
    assertJsonEquals(cancelled.commandLinks[0].phase, 'cancel');

    const commands = service.takeDispatchableCommands('run-1', 'agent-1');
    assertJsonEquals(commands[0].command.kind, 'recipe.cancel');
});

Deno.test('control service resolves all-online distributed targets from Rallar identity', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({
        runId: 'run-1',
        agentId: 'agent-1',
        completedCommandIds: [],
        identity: {
            principalId: 'alice',
            clientId: 'alice',
            sessionId: 'session-1',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
            sessionLabel: 'alice:session-1',
            updatedAtEpochMs: 1_000
        }
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({
        runId: 'run-1',
        agentId: 'agent-2',
        completedCommandIds: [],
        identity: {
            principalId: 'bob',
            clientId: 'bob',
            sessionId: 'session-2',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'other-group',
            sessionLabel: 'bob:session-2',
            updatedAtEpochMs: 1_000
        }
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({
        runId: 'run-1',
        agentId: 'agent-3',
        completedCommandIds: [],
        identity: {
            principalId: 'carol',
            clientId: 'carol',
            sessionId: 'session-3',
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group',
            sessionLabel: 'carol:session-3',
            updatedAtEpochMs: 1_000
        }
    }));
    service.markAgentDisconnected('run-1', 'agent-3');

    const created = assertRight(service.createDistributedRun(toDistributedManifest({
        targetPolicy: {
            mode: 'all-online-group-members',
            includeOfflineExpectedAgents: false
        }
    })));

    assertJsonEquals(created.targetAgentIds, ['agent-1']);
    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(staged.commandLinks.map((link) => link.agentId), ['agent-1']);
});

Deno.test('control service keeps explicit role-map target resolution aligned without fleet identity', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [], identity: undefined }));

    const created = assertRight(service.createDistributedRun(toDistributedManifest({
        recipes: [
            {
                recipeId: 'sender-recipe',
                role: 'sender',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'sender-recipe',
                    commands: [{ kind: 'health', commandId: 'sender-health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            },
            {
                recipeId: 'receiver-recipe',
                role: 'receiver',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'receiver-recipe',
                    commands: [{ kind: 'health', commandId: 'receiver-health' }]
                },
                variables: {},
                secretRefs: [],
                required: true
            }
        ],
        targetPolicy: {
            mode: 'role-map',
            expectedParticipantCount: 2,
            roles: {
                sender: ['agent-1'],
                receiver: ['agent-2']
            },
            includeOfflineExpectedAgents: false
        },
        roleAssignments: [
            { role: 'sender', agentId: 'agent-1', required: true, variables: {}, recipeIds: [] },
            { role: 'receiver', agentId: 'agent-2', required: true, variables: {}, recipeIds: [] }
        ]
    })));

    assertJsonEquals(created.targetAgentIds, ['agent-1', 'agent-2']);
    assertJsonEquals(created.targetResolution?.targetAgentIds, ['agent-1', 'agent-2']);
    assertJsonEquals(created.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-1', required: true, variables: {}, recipeIds: [] },
        { role: 'receiver', agentId: 'agent-2', required: true, variables: {}, recipeIds: [] }
    ]);
    assertJsonEquals(created.targetResolution?.summary.selected, 2);

    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(
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
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    registerFleetAgents(service, 50);

    const created = assertRight(service.createDistributedRun(toPrincipalWorldFleetManifest(50)));

    assertJsonEquals(created.targetAgentIds.length, 50);
    assertJsonEquals(created.targetAgentIds[0], 'agent-01');
    assertJsonEquals(created.targetAgentIds[49], 'agent-50');
    assertJsonEquals(created.targetResolution?.summary.selected, 50);
    assertJsonEquals(created.targetResolution?.summary.roleCounts, {
        receiver: 49,
        sender: 1
    });
    assertJsonEquals(created.targetResolution?.summary.regions, {
        'eu-north': 25,
        'us-east': 25
    });

    const staged = assertRight(service.stageDistributedRun('dist-1'));

    assertJsonEquals(staged.state, 'waiting-for-ack');
    assertJsonEquals(staged.commandLinks.filter((link) => link.phase === 'stage').length, 50);
    assertJsonEquals(staged.commandLinks.filter((link) => link.role === 'sender').map((link) => link.agentId), [
        'agent-01'
    ]);
    assertJsonEquals(staged.commandLinks.filter((link) => link.role === 'receiver').length, 49);

    const senderStageCommands = service.takeDispatchableCommands('run-1', 'agent-01');
    const receiverStageCommands = service.takeDispatchableCommands('run-1', 'agent-02');

    assertJsonEquals(senderStageCommands[0].command.kind, 'recipe.load');
    assertJsonEquals(
        senderStageCommands[0].command.kind === 'recipe.load'
            ? senderStageCommands[0].command.recipe.recipeId
            : undefined,
        'sender-recipe'
    );
    assertJsonEquals(receiverStageCommands[0].command.kind, 'recipe.load');
    assertJsonEquals(
        receiverStageCommands[0].command.kind === 'recipe.load'
            ? receiverStageCommands[0].command.recipe.recipeId
            : undefined,
        'receiver-recipe'
    );
});

Deno.test('control service fails global fleet mismatch before queueing commands', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    registerFleetAgents(service, 49);

    service.createDistributedRun(toPrincipalWorldFleetManifest(50));
    const staged = assertRight(service.stageDistributedRun('dist-1'));

    assertJsonEquals(staged.state, 'failed');
    assertJsonEquals(staged.error?.code, 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');
    assertJsonEquals(staged.commandLinks.length, 0);
    assertJsonEquals(staged.targetResolution?.summary.selected, 49);
    assertJsonEquals(staged.targetResolution?.summary.expectedParticipantCount, 50);
    assertJsonEquals(staged.targetResolution?.summary.missingExpectedParticipants, 1);
    assertJsonEquals(service.takeDispatchableCommands('run-1', 'agent-01'), []);
});

Deno.test('control service freezes global fleet target roles after staging', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    registerFleetAgents(service, 3);

    const staged = assertRight(service.stageDistributedRun(
        assertRight(service.createDistributedRun(toPrincipalWorldFleetManifest(3))).distributedRunId
    ));
    assertJsonEquals(staged.targetAgentIds, ['agent-01', 'agent-02', 'agent-03']);
    assertJsonEquals(staged.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-01', recipeIds: [], required: true, variables: {} },
        { role: 'receiver', agentId: 'agent-02', recipeIds: [], required: true, variables: {} },
        { role: 'receiver', agentId: 'agent-03', recipeIds: [], required: true, variables: {} }
    ]);

    for (const agentId of staged.targetAgentIds) {
        const [stageCommand] = service.takeDispatchableCommands('run-1', agentId);
        service.receiveClientEnvelope(toCommandResultEnvelope({ runId: 'run-1', agentId: agentId, command: stageCommand, ok: true }));
    }
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-00', completedCommandIds: [], identity: toFleetIdentity('agent-00') }));

    const started = assertRight(service.startDistributedRun('dist-1'));
    assertJsonEquals(started.state, 'running');
    assertJsonEquals(started.targetAgentIds, ['agent-01', 'agent-02', 'agent-03']);
    assertJsonEquals(started.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-01', recipeIds: [], required: true, variables: {} },
        { role: 'receiver', agentId: 'agent-02', recipeIds: [], required: true, variables: {} },
        { role: 'receiver', agentId: 'agent-03', recipeIds: [], required: true, variables: {} }
    ]);
    assertJsonEquals(started.commandLinks.filter((link) => link.phase === 'start').map((link) => link.agentId), [
        'agent-01',
        'agent-02',
        'agent-03'
    ]);
});

Deno.test('control service reports distributed target mismatch and ACK timeout', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));

    service.createDistributedRun(toDistributedManifest({
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1'],
            expectedParticipantCount: 2,
            includeOfflineExpectedAgents: false
        }
    }));
    const mismatched = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(mismatched.state, 'failed');
    assertJsonEquals(mismatched.error?.code, 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');

    const timeoutService = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now
    }));
    timeoutService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    timeoutService.createDistributedRun(toDistributedManifest({
        distributedRunId: 'dist-timeout',
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1'],
            includeOfflineExpectedAgents: false
        },
        ackTimeoutMs: 10
    }));
    timeoutService.stageDistributedRun('dist-timeout');
    now += 11;

    const timedOut = timeoutService.snapshotDistributedRun('dist-timeout');
    assert(timedOut);
    assertJsonEquals(timedOut.state, 'timed-out');
    assertJsonEquals(timedOut.rollup.failures[0].state, 'timed-out');

    const timedOutAgain = timeoutService.snapshotDistributedRun('dist-timeout');
    assert(timedOutAgain);
    assertJsonEquals(timedOutAgain.state, 'timed-out');
    assertJsonEquals(timedOutAgain.rollup.failures[0].state, 'timed-out');
});

Deno.test('control service defers a refused automatic start to a later refresh instead of failing the read', () => {
    let now = 1_000;
    const service = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now,
        commandRateLimitMax: 1,
        commandRateLimitWindowMs: 1_000
    }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.createDistributedRun(toDistributedManifest({
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'], includeOfflineExpectedAgents: false }
    }, { startMode: 'auto-after-ready' }));
    service.stageDistributedRun('dist-1');
    const [stageCommand] = service.takeDispatchableCommands('run-1', 'agent-1');

    // The stage command used the agent's only rate slot, so queueing the automatic start is refused.
    const received = service.receiveClientEnvelope(
        toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-1', command: stageCommand, ok: true })
    );
    const refused = service.snapshotDistributedRun('dist-1');
    assertJsonEquals(received.accepted, true);
    assert(refused);
    assertJsonEquals(refused.commandLinks.filter((link) => link.phase === 'start').length, 0);

    now += 1_001;
    const started = service.snapshotDistributedRun('dist-1');
    assert(started);
    assertJsonEquals(started.state, 'running');
    assertJsonEquals(started.commandLinks.filter((link) => link.phase === 'start').length, 1);
});

Deno.test('control service returns lifecycle failures as values without changing the run', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput({ allowedCommandKinds: ['recipe.cancel'] }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: undefined }));
    service.createDistributedRun(toDistributedManifest({
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'], includeOfflineExpectedAgents: false }
    }));

    assertJsonEquals(service.stageDistributedRun('missing').left, {
        code: 'distributed-run-not-found',
        message: 'Distributed run not found: missing.'
    });
    assertJsonEquals(service.createDistributedRun(toDistributedManifest()).left?.code, 'distributed-run-exists');
    assertJsonEquals(service.stageDistributedRun('dist-1').left, {
        code: 'command-kind-not-allowed',
        message: 'Command kind is not allowed: recipe.load.'
    });
    assertJsonEquals(service.snapshotDistributedRun('dist-1')?.state, 'draft');

    assertJsonEquals(assertRight(service.cancelDistributedRun('dist-1', 'operator stopped test')).state, 'cancelled');
    assertJsonEquals(service.startDistributedRun('dist-1').left, {
        code: 'distributed-run-terminal',
        message: 'Cannot start distributed run dist-1 in terminal state cancelled.'
    });
});
