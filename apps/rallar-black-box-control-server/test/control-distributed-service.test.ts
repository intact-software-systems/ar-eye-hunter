import { decodeBlackBoxRallarCrdtOpenInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts';
import { toControlAgentIdentity } from '@shared-test/rallar-bb-test/control-client/to-control-agent-identity.ts';
import {
    parseControlServerMessage,
    RALLAR_BLACK_BOX_CONTROL_PROTOCOL_VERSION
} from '@shared-test/rallar-bb-test/control-protocol.ts';
import { decodeControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import type { RallarBlackBoxControlAgentIdentity, RallarBlackBoxDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run.ts';
import { toControlAgentCapabilities } from '@shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import { validateControlFleetRunReportCollection } from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import type {
    RallarBlackBoxTestCommandContext,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestCrdtOpenCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRuntime
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { validateExecutableRecipe } from '@shared-test/rallar-bb-test/recipe/validate-executable-recipe.ts';
import {
    createDefaultRallarBlackBoxTestRuntime,
    type CreateRallarBlackBoxTestRuntimeOptions
} from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { decodeJsonValue } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { resolveRtcCaptureConfiguration } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';
import { assert, assertEquals, assertThrows } from '@std/assert';

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
    toRegisterEnvelope,
    toUnconfiguredAgentIdentity
} from './support/control-service-test-fixtures.ts';

interface CaptureIntentTestRuntime extends RallarBlackBoxTestRuntime {
    readonly captureConsumptions: readonly RtcSignalingDiagnostics.CaptureConfiguration[];
}

/** A bounded executor consumes canonical capture intent; it never claims an applied SDK receipt. */
function createCaptureIntentTestRuntime(options: CreateRallarBlackBoxTestRuntimeOptions): CaptureIntentTestRuntime {
    const captureConsumptions: RtcSignalingDiagnostics.CaptureConfiguration[] = [];
    const runtime = createDefaultRallarBlackBoxTestRuntime({
        now: options.now,
        sleep: options.sleep,
        idFactory: options.idFactory,
        cleanup: options.cleanup,
        readAlmUsage: options.readAlmUsage,
        readCongestionCounters: options.readCongestionCounters,
        commandExecutor: (command, context) => {
            if (command.kind === 'rtc.connect') {
                const capture = resolveRtcCaptureConfiguration({ ...context.rtcCapture, sinkAvailable: false });
                captureConsumptions.push(capture);
            }
            return options.commandExecutor?.(command, context);
        }
    });
    Object.defineProperty(runtime, 'rtcCaptureSupport', {
        value: Object.freeze({ configurationVersion: 1, modes: Object.freeze(['off', 'signaling', 'native']) }),
        enumerable: true
    });
    return Object.assign(runtime, { captureConsumptions });
}

function toCaptureRuntimeIdentity(agentId: string, runtime: RallarBlackBoxTestRuntime): RallarBlackBoxControlAgentIdentity {
    return toControlAgentIdentity({
        config: runtime.state().currentConfig,
        rtcCaptureSupport: runtime.rtcCaptureSupport,
        agentId,
        userAgent: undefined,
        location: undefined,
        atEpochMs: 1_000
    });
}

Deno.test('distributed run Off reaches both role invocations but an intent-only executor cannot certify application', async () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    const agents = ['agent-1', 'agent-2'].map((agentId) => {
        const connections: RallarBlackBoxTestCommandContext[] = [];
        const runtime = createCaptureIntentTestRuntime({
            now: () => 1_000,
            commandExecutor: (command, context) => {
                if (command.kind === 'rtc.connect') {
                    connections.push(context);
                    return { status: 'ok', value: { connected: true } };
                }
                return undefined;
            }
        });
        return { agentId, runtime, connections };
    });
    const manifest = {
        schemaVersion: 1 as const,
        distributedRunId: 'capture-execution',
        controlRunId: 'run-1',
        rtcCaptureMode: 'off' as const,
        group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'bb-group' },
        recipes: ['sender', 'receiver'].map((role) => ({
            recipeId: `capture-${role}`,
            role,
            recipe: {
                schemaVersion: 1 as const,
                recipeId: `capture-${role}`,
                rtcCaptureMode: 'native' as const,
                commands: [
                    { kind: 'configure' as const, commandId: `${role}-configure`, config: { rallar: { rtcCaptureMode: 'signaling' as const } } },
                    { kind: 'rtc.connect' as const, commandId: `${role}-connect-signaling` },
                    { kind: 'configure' as const, commandId: `${role}-configure-omission`, config: {} },
                    { kind: 'rtc.connect' as const, commandId: `${role}-connect-omission` }
                ]
            },
            variables: {}
        })),
        targetPolicy: { mode: 'role-map' as const, roles: { sender: ['agent-1'], receiver: ['agent-2'] } },
        startMode: 'manual' as const,
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 1_000,
        barrier: { enabled: false as const },
        groupAssertions: [],
        metadata: {}
    };

    for (const { agentId, runtime } of agents) {
        service.receiveClientEnvelope(
            toRegisterEnvelope({ runId: 'run-1', agentId, completedCommandIds: [], identity: toCaptureRuntimeIdentity(agentId, runtime) })
        );
    }
    assertRight(service.createDistributedRun(manifest));
    assertRight(service.stageDistributedRun('capture-execution'));

    for (const { agentId, runtime } of agents) {
        const commands = service.takeDispatchableCommands('run-1', agentId);
        assertEquals(commands.length, 1);
        const decoded = parseControlServerMessage(JSON.stringify(commands[0]), { runId: 'run-1', agentId });
        assert(decoded.ok);
        assertEquals(decoded.envelope.command.kind, 'recipe.load');
        const result = await runtime.execute({ ...decoded.envelope.command, commandId: decoded.envelope.commandId });
        assertEquals(result.ok, true);
        const received = service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId,
            commandId: decoded.envelope.commandId,
            ok: result.ok,
            result
        });
        assertEquals(received.accepted, true);
    }
    assertEquals(service.snapshotDistributedRun('capture-execution')?.state, 'ready');
    assertRight(service.startDistributedRun('capture-execution'));

    const invocations = [];
    for (const { agentId, runtime, connections } of agents) {
        const commands = service.takeDispatchableCommands('run-1', agentId);
        assertEquals(commands.length, 1);
        const decoded = parseControlServerMessage(JSON.stringify(commands[0]), { runId: 'run-1', agentId });
        assert(decoded.ok);
        const command = decoded.envelope.command;
        assert(command.kind === 'recipe.run');
        assertEquals(command.recipe, manifest.recipes[agentId === 'agent-1' ? 0 : 1].recipe);
        const result = await runtime.execute({ ...command, commandId: decoded.envelope.commandId });
        assertEquals(result.ok, true);
        assert(isJsonRecordValue(result.value));
        assert(isJsonRecordValue(result.value.invocation));
        assert(Array.isArray(result.value.results));
        assertEquals(result.value.results.length, 4);
        invocations.push({
            agentId,
            dispatchedMode: command.rtcCaptureMode,
            connections: connections.map((context) => context.rtcCapture),
            invocationRun: result.value.invocation.run,
            invocationRecipe: result.value.invocation.recipe
        });
        const received = service.receiveClientEnvelope({
            kind: 'result',
            protocolVersion: 1,
            runId: 'run-1',
            agentId,
            commandId: decoded.envelope.commandId,
            ok: result.ok,
            result
        });
        assertEquals(received.accepted, false);
        assertEquals(service.snapshotCommand('run-1', decoded.envelope.commandId)?.completedAtEpochMs, undefined);
        assertEquals(service.snapshotRun('run-1')?.results.some((envelope) => envelope.commandId === decoded.envelope.commandId), false);
    }
    assertEquals(service.snapshotDistributedRun('capture-execution')?.state, 'running');
    assertEquals(invocations, [
        {
            agentId: 'agent-1',
            dispatchedMode: 'off',
            connections: [
                { run: 'off', recipe: 'native', step: 'signaling' },
                { run: 'off', recipe: 'native', step: undefined }
            ],
            invocationRun: 'off',
            invocationRecipe: 'native'
        },
        {
            agentId: 'agent-2',
            dispatchedMode: 'off',
            connections: [
                { run: 'off', recipe: 'native', step: 'signaling' },
                { run: 'off', recipe: 'native', step: undefined }
            ],
            invocationRun: 'off',
            invocationRecipe: 'native'
        }
    ]);
});

for (
    const capture of [
        { mode: 'off' as const, expected: 'off' as const },
        { mode: 'signaling' as const, expected: 'signaling' as const },
        { mode: 'native' as const, expected: 'native' as const },
        { mode: undefined, expected: undefined }
    ]
) {
    for (
        const start of [
            { name: 'staged manual inline', mode: 'manual' as const, stage: true, referenceOnly: false },
            { name: 'direct manual inline', mode: 'manual' as const, stage: false, referenceOnly: false },
            { name: 'automatic loaded reference', mode: 'auto-after-ready' as const, stage: true, referenceOnly: true },
            { name: 'scheduled loaded reference', mode: 'scheduled' as const, stage: true, referenceOnly: true }
        ]
    ) {
        Deno.test(`distributed run ${capture.mode ?? 'Inherit'} executes ${start.name} and preserves intent without certifying missing application`, async () => {
            let now = 1_000;
            const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
            const connections: RallarBlackBoxTestCommandContext[] = [];
            const runtime = createCaptureIntentTestRuntime({
                now: () => now,
                commandExecutor: (command, context) => {
                    if (command.kind === 'rtc.connect') {
                        connections.push(context);
                        return { status: 'ok', value: { connected: true } };
                    }
                    return undefined;
                }
            });
            const recipe = {
                schemaVersion: 1 as const,
                recipeId: 'variant-capture-body',
                rtcCaptureMode: 'native' as const,
                commands: [{ kind: 'rtc.connect' as const, commandId: 'variant-connect' }]
            };
            if (start.referenceOnly) {
                const loaded = await runtime.execute({ kind: 'recipe.load', commandId: 'admit-reference-body', recipe });
                assertEquals(loaded.ok, true);
                const loadedBody = decodeJsonValue(runtime.state().loadedRecipe);
                assertEquals(loadedBody, recipe);
            }
            const manifest = toDistributedManifest(
                {
                    distributedRunId: 'capture-variant',
                    ...(capture.mode === undefined ? {} : { rtcCaptureMode: capture.mode }),
                    recipes: [{ recipeId: recipe.recipeId, ...(start.referenceOnly ? {} : { recipe }), variables: {} }],
                    targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'] }
                },
                start.mode === 'scheduled'
                    ? { startMode: 'scheduled', startDeadlineEpochMs: 1_500 }
                    : { startMode: start.mode }
            );
            service.receiveClientEnvelope(
                toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [], identity: toCaptureRuntimeIdentity('agent-1', runtime) })
            );
            assertRight(service.createDistributedRun(manifest));
            if (start.stage) {
                assertRight(service.stageDistributedRun('capture-variant'));
            }
            else {
                assertRight(service.startDistributedRun('capture-variant'));
            }

            const invocations = [];
            for (const phase of ['admission', 'start'] as const) {
                while (true) {
                    const commands = service.takeDispatchableCommands('run-1', 'agent-1');
                    if (commands.length === 0) {
                        break;
                    }
                    for (const envelope of commands) {
                        const decoded = parseControlServerMessage(JSON.stringify(envelope), { runId: 'run-1', agentId: 'agent-1' });
                        assert(decoded.ok);
                        const command = decoded.envelope.command;
                        if (command.kind === 'recipe.run') {
                            assertEquals(command.recipe, start.referenceOnly ? undefined : recipe);
                            assertEquals(command.rtcCaptureMode, capture.expected);
                            assertEquals(Object.hasOwn(command, 'rtcCaptureMode'), capture.mode !== undefined);
                        }
                        const result = await runtime.execute({ ...command, commandId: decoded.envelope.commandId });
                        assertEquals(result.ok, true);
                        if (result.kind === 'recipe.run') {
                            assert(isJsonRecordValue(result.value));
                            assert(isJsonRecordValue(result.value.invocation));
                            invocations.push({ run: result.value.invocation.run, recipe: result.value.invocation.recipe });
                        }
                        assertEquals(
                            service.receiveClientEnvelope({
                                kind: 'result',
                                protocolVersion: 1,
                                runId: 'run-1',
                                agentId: 'agent-1',
                                commandId: decoded.envelope.commandId,
                                ok: result.ok,
                                result
                            }).accepted,
                            command.kind !== 'recipe.run' || (capture.mode === undefined && start.referenceOnly)
                        );
                        if (command.kind === 'recipe.run' && !(capture.mode === undefined && start.referenceOnly)) {
                            assertEquals(service.snapshotCommand('run-1', decoded.envelope.commandId)?.completedAtEpochMs, undefined);
                            assertEquals(service.snapshotRun('run-1')?.results.some((envelope) => envelope.commandId === decoded.envelope.commandId), false);
                        }
                    }
                }
                if (phase === 'admission' && start.mode === 'scheduled') {
                    assertEquals(service.snapshotDistributedRun('capture-variant')?.state, 'ready');
                    now = 1_500;
                    assertEquals(service.snapshotDistributedRun('capture-variant')?.state, 'running');
                }
                if (phase === 'admission' && start.stage && start.mode === 'manual') {
                    assertEquals(service.snapshotDistributedRun('capture-variant')?.state, 'ready');
                    assertRight(service.startDistributedRun('capture-variant'));
                }
            }
            assertEquals(service.snapshotDistributedRun('capture-variant')?.state, capture.mode === undefined && start.referenceOnly ? 'passed' : 'running');
            assertEquals(connections.map((context) => context.rtcCapture), [
                { run: capture.expected, recipe: 'native', step: undefined }
            ]);
            assertEquals(invocations, [{ run: capture.expected, recipe: 'native' }]);
            assertEquals(runtime.captureConsumptions, [{ mode: capture.expected ?? 'native', origin: capture.expected === undefined ? 'recipe' : 'run' }]);
            if (start.stage || start.referenceOnly) {
                const loadedBody = decodeJsonValue(runtime.state().loadedRecipe);
                assertEquals(loadedBody, recipe);
            }
            const accepted = service.snapshotDistributedRun('capture-variant');
            assert(accepted);
            assertEquals(accepted.manifest, manifest);
            const restored = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
            restored.restoreSnapshot({
                ...service.snapshot(),
                distributedRuns: [assertRight(decodeControlDistributedRunSnapshot(JSON.parse(JSON.stringify(accepted))))]
            });
            assertEquals(restored.snapshotDistributedRun('capture-variant')?.manifest, manifest);
            const bundle = restored.createDistributedRunArtifactBundle('capture-variant', {});
            assert(bundle);
            const exported = decodeJsonValue(JSON.parse(bundle.files['manifest.json']));
            assertEquals(exported, decodeJsonValue(manifest));
        });
    }
}

Deno.test('control service stages, starts, monitors, and exports distributed runs', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));

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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));

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

    const snapshot: unknown = JSON.parse(JSON.stringify(service.snapshot()));
    assert(isJsonRecordValue(snapshot));
    assert(Array.isArray(snapshot.runs));
    assert(Array.isArray(snapshot.distributedRuns));
    const fleet = validateControlFleetRunReportCollection(snapshot.fleetReports);
    assert(fleet.ok);
    const staleSnapshot = {
        runs: snapshot.runs.map((run) => assertRight(decodeControlRunSnapshot(run))),
        fleetReports: fleet.reports,
        distributedRuns: snapshot.distributedRuns.map((value) => assertRight(decodeControlDistributedRunSnapshot(value))).map((distributedRun) => ({
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
    const failedResult = toCommandResultEnvelope({ runId: 'run-1', agentId: 'agent-2', command: agent2StartCommands[0], ok: false });
    assert(failedResult.kind === 'result');
    assert(failedResult.result);
    service.receiveClientEnvelope({
        ...failedResult,
        result: {
            ...failedResult.result,
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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));
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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));
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
        status: 'ready',
        identity: toUnconfiguredAgentIdentity('agent-1', now)
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
    timeoutService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    timeoutService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));
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
    disconnectService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    disconnectService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));
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
    cancelService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    cancelService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));
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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.createDistributedRun(toDistributedManifest({
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1']
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
            mode: 'all-online-group-members'
        }
    })));

    assertJsonEquals(created.targetAgentIds, ['agent-1']);
    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(staged.commandLinks.map((link) => link.agentId), ['agent-1']);
});

Deno.test('control service keeps explicit role-map target resolution aligned without fleet identity', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-2', completedCommandIds: [] }));

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
                variables: {}
            },
            {
                recipeId: 'receiver-recipe',
                role: 'receiver',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'receiver-recipe',
                    commands: [{ kind: 'health', commandId: 'receiver-health' }]
                },
                variables: {}
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
            { role: 'sender', agentId: 'agent-1', variables: {}, recipeIds: [] },
            { role: 'receiver', agentId: 'agent-2', variables: {}, recipeIds: [] }
        ]
    })));

    assertJsonEquals(created.targetAgentIds, ['agent-1', 'agent-2']);
    assertJsonEquals(created.targetResolution?.targetAgentIds, ['agent-1', 'agent-2']);
    assertJsonEquals(created.targetResolution?.roleAssignments, [
        { role: 'sender', agentId: 'agent-1', variables: {}, recipeIds: [] },
        { role: 'receiver', agentId: 'agent-2', variables: {}, recipeIds: [] }
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

Deno.test('control service refuses required Native RTC capture for explicit roles before staging any target', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    assertEquals(
        service.receiveClientEnvelope(toRegisterEnvelope({
            agentId: 'agent-1',
            identity: toFleetIdentity('agent-1', {
                providerMode: 'simulated',
                capabilities: {
                    crdt: { supported: false, transports: [], apiBaseUrlConfigured: false },
                    assertions: { absence: true, untilLoop: true, operators: [] },
                    messaging: { supported: false, carriers: [], faults: false, storageCounters: false, reload: false }
                }
            })
        })).accepted,
        true
    );
    assertEquals(service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-2' })).accepted, true);
    assertRight(service.createDistributedRun(toDistributedManifest({
        rtcCaptureMode: 'native',
        recipes: [
            {
                recipeId: 'capture-sender',
                role: 'sender',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'capture-sender',
                    commands: [{ kind: 'rtc.connect', commandId: 'sender-connect' }]
                },
                variables: {}
            },
            {
                recipeId: 'capture-receiver',
                role: 'receiver',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'capture-receiver',
                    commands: [{ kind: 'rtc.connect', commandId: 'receiver-connect' }]
                },
                variables: {}
            }
        ],
        targetPolicy: { mode: 'role-map', roles: { sender: ['agent-1'], receiver: ['agent-2'] } }
    })));

    const staged = service.stageDistributedRun('dist-1');
    const message = staged.left?.message ?? staged.right?.error?.message;
    assertEquals({
        refused: staged.left !== undefined || staged.right?.state === 'failed',
        mentionsCapture: message?.toLowerCase().includes('capture') === true,
        commandLinks: service.snapshotDistributedRun('dist-1')?.commandLinks,
        queuedAgent1: service.takeDispatchableCommands('run-1', 'agent-1'),
        queuedAgent2: service.takeDispatchableCommands('run-1', 'agent-2')
    }, {
        refused: true,
        mentionsCapture: true,
        commandLinks: [],
        queuedAgent1: [],
        queuedAgent2: []
    });
});

Deno.test('control service refuses required Native RTC capture on unstaged selected-agent manual start', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    assertEquals(service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-1' })).accepted, true);
    assertEquals(service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-2' })).accepted, true);
    const created = assertRight(service.createDistributedRun(toDistributedManifest({
        rtcCaptureMode: 'native',
        recipes: [{
            recipeId: 'manual-capture',
            recipe: {
                schemaVersion: 1,
                recipeId: 'manual-capture',
                commands: [{ kind: 'rtc.connect', commandId: 'manual-connect' }]
            },
            variables: {}
        }],
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1', 'agent-2'] }
    })));
    assertEquals(created.targetAgentIds, ['agent-1', 'agent-2']);
    assertEquals(created.commandLinks, []);

    const started = service.startDistributedRun('dist-1');
    const message = started.left?.message ?? started.right?.error?.message;
    assertEquals({
        refused: started.left !== undefined || started.right?.state === 'failed',
        mentionsCapture: message?.toLowerCase().includes('capture') === true,
        commandLinks: service.snapshotDistributedRun('dist-1')?.commandLinks,
        queuedAgent1: service.takeDispatchableCommands('run-1', 'agent-1'),
        queuedAgent2: service.takeDispatchableCommands('run-1', 'agent-2')
    }, {
        refused: true,
        mentionsCapture: true,
        commandLinks: [],
        queuedAgent1: [],
        queuedAgent2: []
    });
});

Deno.test('capture admission restaging preserves frozen membership and rechecks its original targets', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    for (const agentId of ['agent-1', 'agent-2']) {
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId, identity: toCaptureTestIdentity(agentId, ['native']) }));
    }
    const manifest = toDistributedManifest({
        rtcCaptureMode: 'native',
        targetPolicy: { mode: 'all-online-group-members' },
        roleAssignmentPolicy: { mode: 'ordered-targets', orderBy: 'agent-id', pattern: 'sender-receiver' },
        recipes: [{ recipeId: 'rtc', recipe: { schemaVersion: 1, recipeId: 'rtc', commands: [{ kind: 'rtc.connect' }] }, variables: {} }]
    });
    assertRight(service.createDistributedRun(manifest));
    const first = assertRight(service.stageDistributedRun('dist-1'));
    service.takeDispatchableCommands('run-1', 'agent-1');
    service.takeDispatchableCommands('run-1', 'agent-2');
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-0', identity: toCaptureTestIdentity('agent-0', ['native']) }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-2', identity: toFleetIdentity('agent-2') }));
    const refused = assertRight(service.stageDistributedRun('dist-1'));
    assertEquals(refused.state, 'failed');
    assertEquals(refused.targetAgentIds, ['agent-1', 'agent-2']);
    assertEquals(refused.targetResolution?.roleAssignments, first.targetResolution?.roleAssignments);
    assertEquals(refused.commandLinks, first.commandLinks);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-0'), []);
});

Deno.test('capture admission keeps an unsupported Health role alongside the supported RTC role', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-1' }));
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-2', identity: toCaptureTestIdentity('agent-2', ['native']) }));
    const manifest = toDistributedManifest({
        rtcCaptureMode: 'native',
        targetPolicy: { mode: 'role-map', roles: { observer: ['agent-1'], receiver: ['agent-2'] } },
        recipes: [
            { role: 'observer', recipeId: 'health', recipe: { schemaVersion: 1, recipeId: 'health', commands: [{ kind: 'health' }] }, variables: {} },
            { role: 'receiver', recipeId: 'rtc', recipe: { schemaVersion: 1, recipeId: 'rtc', commands: [{ kind: 'rtc.connect' }] }, variables: {} }
        ]
    });
    assertRight(service.createDistributedRun(manifest));
    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertEquals(staged.state, 'waiting-for-ack');
    assertEquals(staged.targetAgentIds, ['agent-1', 'agent-2']);
    assertEquals(staged.commandLinks.map((link) => ({ agentId: link.agentId, recipeId: link.recipeId })), [{ agentId: 'agent-1', recipeId: 'health' }, {
        agentId: 'agent-2',
        recipeId: 'rtc'
    }]);
});

function toCaptureTestIdentity(agentId: string, modes: readonly ('off' | 'signaling' | 'native')[]): RallarBlackBoxControlAgentIdentity {
    return toFleetIdentity(agentId, {
        capabilities: toControlAgentCapabilities({
            config: undefined,
            providerMode: undefined,
            apiBaseUrl: undefined,
            rtcCaptureSupport: { configurationVersion: 1, modes }
        })
    });
}

for (const policy of ['selected-agents', 'role-map', 'all-online-group-members'] as const) {
    Deno.test(`capture admission refuses mixed supported targets with no partial staging for ${policy}`, () => {
        const service = createRallarBlackBoxControlService(toControlServiceInput());
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-1', identity: toCaptureTestIdentity('agent-1', ['off', 'signaling', 'native']) }));
        service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-2', identity: toCaptureTestIdentity('agent-2', ['off', 'signaling']) }));
        const manifest: RallarBlackBoxDistributedRunManifest = toDistributedManifest({
            rtcCaptureMode: 'native',
            recipes: [{
                recipeId: 'mixed-capture',
                recipe: { schemaVersion: 1, recipeId: 'mixed-capture', commands: [{ kind: 'rtc.connect' }] },
                variables: {}
            }],
            targetPolicy: policy === 'role-map'
                ? { mode: policy, roles: { sender: ['agent-1'], receiver: ['agent-2'] } }
                : policy === 'selected-agents'
                ? { mode: policy, agentIds: ['agent-1', 'agent-2'] }
                : { mode: policy }
        });
        assertRight(service.createDistributedRun(manifest));
        const staged = assertRight(service.stageDistributedRun('dist-1'));
        assertEquals(staged.state, 'failed');
        assert(staged.error?.message.includes('agent-2'));
        assert(staged.error?.message.toLowerCase().includes('capture'));
        assertEquals(staged.commandLinks, []);
        assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
        assertEquals(service.takeDispatchableCommands('run-1', 'agent-2'), []);
    });
}

for (const startMode of ['manual', 'auto-after-ready', 'scheduled'] as const) {
    for (const loss of ['missing', 'signaling-only'] as const) {
        Deno.test(`capture admission rechecks frozen roles after staging for ${startMode} with ${loss} support`, async () => {
            let now = 1_000;
            const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => now }));
            const runtimes = new Map(['agent-1', 'agent-2'].map((agentId) => [agentId, createDefaultRallarBlackBoxTestRuntime()]));
            for (const agentId of runtimes.keys()) {
                service.receiveClientEnvelope(toRegisterEnvelope({ agentId, identity: toCaptureTestIdentity(agentId, ['off', 'signaling', 'native']) }));
            }
            const manifest = toDistributedManifest({
                rtcCaptureMode: 'native',
                targetPolicy: { mode: 'all-online-group-members' },
                roleAssignmentPolicy: { mode: 'ordered-targets', orderBy: 'agent-id', pattern: 'sender-receiver' },
                recipes: ['sender', 'receiver'].map((role) => ({
                    role,
                    recipeId: role,
                    recipe: { schemaVersion: 1, recipeId: role, commands: [{ kind: 'rtc.connect' }] },
                    variables: {}
                }))
            }, startMode === 'scheduled' ? { startMode, startDeadlineEpochMs: 1_500 } : { startMode });
            assertRight(service.createDistributedRun(manifest));
            const staged = assertRight(service.stageDistributedRun('dist-1'));
            assertEquals(staged.targetAgentIds, ['agent-1', 'agent-2']);
            const frozenRoles = staged.targetResolution?.roleAssignments;
            const commands = [...runtimes.keys()].flatMap((agentId) => service.takeDispatchableCommands('run-1', agentId));
            assertEquals(commands.length, 2);
            service.receiveClientEnvelope(
                toRegisterEnvelope({
                    agentId: 'agent-2',
                    identity: loss === 'missing' ? toFleetIdentity('agent-2') : toCaptureTestIdentity('agent-2', ['off', 'signaling'])
                })
            );
            service.receiveClientEnvelope(
                toRegisterEnvelope({ agentId: 'agent-0', identity: toCaptureTestIdentity('agent-0', ['off', 'signaling', 'native']) })
            );
            for (const envelope of commands) {
                assert(envelope.agentId);
                const runtime = runtimes.get(envelope.agentId);
                assert(runtime);
                const result = await runtime.execute({ ...envelope.command, commandId: envelope.commandId });
                assertEquals(result.ok, true);
                assertEquals(
                    service.receiveClientEnvelope({
                        kind: 'result',
                        protocolVersion: 1,
                        runId: 'run-1',
                        agentId: envelope.agentId,
                        commandId: envelope.commandId,
                        ok: result.ok,
                        result
                    }).accepted,
                    true
                );
            }
            if (startMode === 'manual') {
                service.startDistributedRun('dist-1');
            }
            if (startMode === 'scheduled') {
                now = 1_500;
            }
            const refused = service.snapshotDistributedRun('dist-1');
            assert(refused);
            assertEquals(refused.state, 'failed');
            assert(refused.error?.message.toLowerCase().includes('capture'));
            assertEquals(refused.targetAgentIds, ['agent-1', 'agent-2']);
            assertEquals(refused.targetResolution?.roleAssignments, frozenRoles);
            assertEquals(refused.commandLinks.filter((link) => link.phase === 'start'), []);
            for (const agentId of ['agent-0', 'agent-1', 'agent-2']) {
                assertEquals(service.takeDispatchableCommands('run-1', agentId), []);
            }
        });
    }
}

for (const policy of ['selected-agents', 'role-map'] as const) {
    for (const peer of ['absent', 'unidentified', 'offline'] as const) {
        for (const phase of ['stage', 'start'] as const) {
            Deno.test(`capture admission fix1 refuses ${policy} ${phase} with named ${peer} peer before any dispatch`, () => {
                const service = createRallarBlackBoxControlService(toControlServiceInput());
                service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-1', identity: toCaptureTestIdentity('agent-1', ['native']) }));
                if (peer !== 'absent') {
                    service.receiveClientEnvelope(
                        toRegisterEnvelope({ agentId: 'agent-2', ...(peer === 'offline' ? { identity: toCaptureTestIdentity('agent-2', ['native']) } : {}) })
                    );
                    if (peer === 'offline') {
                        service.markAgentDisconnected('run-1', 'agent-2');
                    }
                }
                const manifest = toDistributedManifest({
                    rtcCaptureMode: 'native',
                    targetPolicy: policy === 'selected-agents'
                        ? { mode: policy, agentIds: ['agent-1', 'agent-2'] }
                        : { mode: policy, roles: { sender: ['agent-1'], receiver: ['agent-2'] } },
                    roleAssignmentPolicy: { mode: 'ordered-targets', orderBy: 'agent-id', pattern: 'sender-receiver' },
                    recipes: ['sender', 'receiver'].map((role) => ({
                        role,
                        recipeId: role,
                        recipe: { schemaVersion: 1, recipeId: role, commands: [{ kind: 'rtc.connect' }] },
                        variables: {}
                    }))
                });
                assertRight(service.createDistributedRun(manifest));
                const refused = assertRight(phase === 'stage' ? service.stageDistributedRun('dist-1') : service.startDistributedRun('dist-1'));
                assertEquals(refused.state, 'failed');
                assert(refused.error?.message.includes('agent-2'));
                assert(refused.error?.message.toLowerCase().includes('capture'));
                assertEquals(refused.commandLinks, []);
                assertEquals(service.takeDispatchableCommands('run-1', 'agent-1'), []);
                assertEquals(service.takeDispatchableCommands('run-1', 'agent-2'), []);
            });
        }
    }
}

Deno.test('capture admission fix1 preserves unrelated role work with a named missing Health peer', () => {
    const service = createRallarBlackBoxControlService(toControlServiceInput());
    service.receiveClientEnvelope(toRegisterEnvelope({ agentId: 'agent-1', identity: toCaptureTestIdentity('agent-1', ['native']) }));
    const manifest = toDistributedManifest({
        rtcCaptureMode: 'native',
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1', 'agent-2'] },
        roleAssignmentPolicy: { mode: 'ordered-targets', orderBy: 'agent-id', pattern: 'sender-receiver' },
        recipes: [
            { role: 'sender', recipeId: 'live', recipe: { schemaVersion: 1, recipeId: 'live', commands: [{ kind: 'rtc.connect' }] }, variables: {} },
            { role: 'receiver', recipeId: 'health', recipe: { schemaVersion: 1, recipeId: 'health', commands: [{ kind: 'health' }] }, variables: {} }
        ]
    });
    assertRight(service.createDistributedRun(manifest));
    const staged = assertRight(service.stageDistributedRun('dist-1'));
    assertEquals(staged.state, 'waiting-for-ack');
    assertEquals(staged.targetAgentIds, ['agent-1']);
    assertEquals(service.takeDispatchableCommands('run-1', 'agent-1').map((command) => command.command.kind), ['recipe.load']);
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
        { role: 'sender', agentId: 'agent-01', recipeIds: [], variables: {} },
        { role: 'receiver', agentId: 'agent-02', recipeIds: [], variables: {} },
        { role: 'receiver', agentId: 'agent-03', recipeIds: [], variables: {} }
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
        { role: 'sender', agentId: 'agent-01', recipeIds: [], variables: {} },
        { role: 'receiver', agentId: 'agent-02', recipeIds: [], variables: {} },
        { role: 'receiver', agentId: 'agent-03', recipeIds: [], variables: {} }
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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));

    service.createDistributedRun(toDistributedManifest({
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-1'],
            expectedParticipantCount: 2
        }
    }));
    const mismatched = assertRight(service.stageDistributedRun('dist-1'));
    assertJsonEquals(mismatched.state, 'failed');
    assertJsonEquals(mismatched.error?.code, 'RALLAR_BB_DISTRIBUTED_TARGET_COUNT_MISMATCH');

    const timeoutService = createRallarBlackBoxControlService(toControlServiceInput({
        now: () => now
    }));
    timeoutService.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    timeoutService.createDistributedRun(toDistributedManifest({
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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.createDistributedRun(toDistributedManifest({
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'] }
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
    service.receiveClientEnvelope(toRegisterEnvelope({ runId: 'run-1', agentId: 'agent-1', completedCommandIds: [] }));
    service.createDistributedRun(toDistributedManifest({
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'] }
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

interface CrdtAdmissionWitness {
    readonly title: string;
    readonly command: RallarBlackBoxTestCrdtOpenCommand;
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly capture: 'native' | undefined;
    readonly supported: boolean;
    readonly registered: boolean;
    readonly outcome: 'dispatch' | 'capture-refusal' | 'missing-target';
}

const CRDT_ADMISSION_WITNESSES: readonly CrdtAdmissionWitness[] = [
    {
        title: 'blank local unsupported',
        command: { kind: 'crdt.open', name: '', transport: 'local-only' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'blank local supported',
        command: { kind: 'crdt.open', name: '', transport: 'local-only' },
        config: undefined,
        capture: 'native',
        supported: true,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'valid local unsupported',
        command: { kind: 'crdt.open', name: 'valid-name', transport: 'local-only' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'blank nonlocal unsupported',
        command: { kind: 'crdt.open', name: '', transport: 'ws' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'capture-refusal'
    },
    {
        title: 'blank nonlocal supported',
        command: { kind: 'crdt.open', name: '', transport: 'ws' },
        config: undefined,
        capture: 'native',
        supported: true,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'valid nonlocal unsupported',
        command: { kind: 'crdt.open', name: 'valid-name', transport: 'ws' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'capture-refusal'
    },
    {
        title: 'valid nonlocal supported',
        command: { kind: 'crdt.open', name: 'valid-name', transport: 'ws' },
        config: undefined,
        capture: 'native',
        supported: true,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'blank explicit local overrides configured ws',
        command: { kind: 'crdt.open', name: '', transport: 'local-only' },
        config: { rallar: { crdtTransport: 'ws' } },
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'blank command ws overrides configured local',
        command: { kind: 'crdt.open', name: '', rallar: { crdtTransport: 'ws' } },
        config: { rallar: { crdtTransport: 'local-only' } },
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'capture-refusal'
    },
    {
        title: 'blank nonlocal omitted capture',
        command: { kind: 'crdt.open', name: '', transport: 'ws' },
        config: undefined,
        capture: undefined,
        supported: false,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'blank omitted transport',
        command: { kind: 'crdt.open', name: '' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'blank local missing target',
        command: { kind: 'crdt.open', name: '', transport: 'local-only' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: false,
        outcome: 'missing-target'
    },
    {
        title: 'valid local missing target',
        command: { kind: 'crdt.open', name: 'valid-name', transport: 'local-only' },
        config: undefined,
        capture: 'native',
        supported: false,
        registered: false,
        outcome: 'missing-target'
    },
    {
        title: 'invalid configured transport unsupported',
        command: { kind: 'crdt.open', name: 'valid-name' },
        config: { rallar: { crdtTransport: 'unverified' } },
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'capture-refusal'
    },
    {
        title: 'invalid configured transport with explicit local',
        command: { kind: 'crdt.open', name: 'valid-name', transport: 'local-only' },
        config: { rallar: { crdtTransport: 'unverified' } },
        capture: 'native',
        supported: false,
        registered: true,
        outcome: 'capture-refusal'
    },
    {
        title: 'invalid configured transport supported',
        command: { kind: 'crdt.open', name: 'valid-name' },
        config: { rallar: { crdtTransport: 'unverified' } },
        capture: 'native',
        supported: true,
        registered: true,
        outcome: 'dispatch'
    },
    {
        title: 'invalid configured transport omitted capture',
        command: { kind: 'crdt.open', name: 'valid-name' },
        config: { rallar: { crdtTransport: 'unverified' } },
        capture: undefined,
        supported: false,
        registered: true,
        outcome: 'dispatch'
    }
];

for (const phase of ['stage', 'start'] as const) {
    for (const witness of CRDT_ADMISSION_WITNESSES) {
        Deno.test(`capture admission fix2 ${phase} preserves visible ${witness.title} outcome`, () => {
            const recipe: RallarBlackBoxTestRecipe = {
                schemaVersion: 1,
                recipeId: 'crdt-admission-boundary',
                commands: [...(witness.config ? [{ kind: 'configure' as const, config: witness.config }] : []), witness.command]
            };
            assertEquals(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe).ok, true);
            assertEquals(validateExecutableRecipe(recipe), []);
            const service = createRallarBlackBoxControlService(toControlServiceInput({ now: () => 1_500 }));
            if (witness.registered) {
                service.receiveClientEnvelope(
                    toRegisterEnvelope({ agentId: 'agent-1', identity: toCaptureTestIdentity('agent-1', witness.supported ? ['native'] : ['off']) })
                );
            }
            assertEquals(
                assertRight(service.createDistributedRun(toDistributedManifest({
                    rtcCaptureMode: witness.capture,
                    targetPolicy: { mode: 'selected-agents', agentIds: ['agent-1'] },
                    recipes: [{ recipeId: recipe.recipeId, recipe, variables: {} }]
                }))).state,
                'draft'
            );
            const snapshot = assertRight(phase === 'stage' ? service.stageDistributedRun('dist-1') : service.startDistributedRun('dist-1'));
            const commands = service.takeDispatchableCommands('run-1', 'agent-1');
            if (witness.outcome === 'dispatch') {
                assertEquals(snapshot.state, phase === 'stage' ? 'waiting-for-ack' : 'running');
                assertEquals(commands.map((envelope) => envelope.command.kind), [phase === 'stage' ? 'recipe.load' : 'recipe.run']);
            }
            else if (witness.outcome === 'missing-target') {
                assertEquals(snapshot.state, phase === 'stage' ? 'failed' : 'running');
                assertEquals(snapshot.error, undefined);
                assertEquals(snapshot.commandLinks.map((link) => link.phase), [phase]);
                assertEquals(
                    snapshot.rollup.failures,
                    phase === 'stage' ? [{ kind: 'participant', key: 'agent-1', state: 'disconnected', error: undefined }] : []
                );
                assertEquals(commands, []);
            }
            else {
                assertEquals(snapshot.state, 'failed');
                assertEquals(snapshot.error?.code, 'RALLAR_BB_DISTRIBUTED_CAPTURE_UNSUPPORTED');
                assertEquals(snapshot.commandLinks, []);
                assertEquals(commands, []);
            }
        });
    }
}

Deno.test('capture admission fix2 keeps the execution decoder strict for blank names and invalid transport', () => {
    assertThrows(() => decodeBlackBoxRallarCrdtOpenInput({ name: '', transport: 'local-only' }), TypeError, 'CRDT option must be a non-empty string.');
    assertThrows(
        () => decodeBlackBoxRallarCrdtOpenInput({ name: 'valid-name', rallar: { crdtTransport: 'unverified' } }),
        TypeError,
        'CRDT transport is invalid.'
    );
    assertEquals(decodeBlackBoxRallarCrdtOpenInput({ name: 'valid-name', transport: 'local-only', rallar: { crdtTransport: 'ws' } }).transport, 'local-only');
    assertThrows(() => decodeBlackBoxRallarCrdtOpenInput({ name: 'valid-name', transport: 'unverified' }), TypeError, 'CRDT transport is invalid.');
    assertEquals(decodeBlackBoxRallarCrdtOpenInput({ name: 'valid-name', transport: 'ws', rallar: { crdtTransport: 'local-only' } }).transport, 'ws');
    assertEquals(decodeBlackBoxRallarCrdtOpenInput({ name: 'valid-name' }).transport, undefined);
});
