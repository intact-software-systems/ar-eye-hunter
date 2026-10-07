import { describe, expect, it, vi } from 'vitest';

import { decodeBlackBoxRallarCrdtWaitInput } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/decode-black-box-rallar-crdt-input.ts';
import { matchesBlackBoxRallarCrdtWaitCondition } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/matches-black-box-rallar-crdt-wait-condition.ts';
import { createDefaultRallarBlackBoxBrowserControlAgent } from '@shared-test/rallar-bb-test/browser-control-agent.ts';
import { createDefaultRallarBlackBoxControlClient } from '@shared-test/rallar-bb-test/control-client.ts';
import { resolveLatestWaitEvent } from '@shared-test/rallar-bb-test/wait/wait-event-match.ts';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { parseControlClientMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';

import { toControlAgentCapabilities } from '@shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import type { RallarBlackBoxTestCommand, RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';

import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';

import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { SimulatedWebSocket } from '../../shared/native-websocket-fixture.ts';
import { createBrowserTestStorage } from '../browser-test-storage.ts';

import {
    createCaptureApplicationRuntime,
    createCaptureController,
    executeSerializedControllerCommand,
    executeSocketCommand,
    installCaptureApplicationTestEnvironment,
    readSocketRegistration,
    readSocketResult,
    type CaptureApplicationRuntime
} from './capture-application-test-runtime.ts';

installCaptureApplicationTestEnvironment();

describe('controller accepted recipe execution intent', () => {
    it.each(
        [
            { kind: 'wait', mutated: false },
            { kind: 'wait', mutated: true },
            { kind: 'crdt.wait', mutated: false },
            { kind: 'crdt.wait', mutated: true }
        ] as const
    )('retains accepted nested comparison policy for $kind; mutation=$mutated', ({ kind, mutated }) => {
        const service = createCaptureController();
        service.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'match-intent',
            agentId: 'match-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'match-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        const expected = { items: [{ value: 10 }] };
        const command: RallarBlackBoxTestCommand = kind === 'wait'
            ? { kind, timeoutMs: 50, match: { topic: 'match-observation', equals: expected } }
            : { kind, handle: 'match-document', timeoutMs: 50, conditions: [{ source: 'value', operator: 'equals', expected }] };
        expect(service.enqueueCommand({ runId: 'match-intent', agentId: 'match-agent', commandId: 'match-gate', command }).left).toBeUndefined();
        if (mutated) {
            expected.items[0].value = 5;
        }
        const [dispatch] = service.takeDispatchableCommands('match-intent', 'match-agent');
        const accepted = dispatch.command;
        let matched: boolean;
        if (accepted.kind === 'wait') {
            matched = resolveLatestWaitEvent([
                { eventId: 'observed', atEpochMs: 1_000, kind: 'event', topic: 'match-observation', payload: { items: [{ value: 5 }] } }
            ], accepted.match) !== undefined;
        }
        else {
            expect(accepted.kind).toBe('crdt.wait');
            const input = decodeBlackBoxRallarCrdtWaitInput(accepted);
            matched = matchesBlackBoxRallarCrdtWaitCondition(input.conditions[0], { items: [{ value: 5 }] }, {
                replicaId: 'replica',
                pendingUpdateCount: 0,
                failedPendingUpdateCount: 0,
                dependencyBlockedUpdateCount: 0,
                seenUpdateCount: 0
            });
        }
        console.info('Accepted structured match witness', JSON.stringify({ kind, mutated, accepted, matched }));
        expect(matched).toBe(false);
    });

    it.each([false, true])('preserves the accepted assertion gate before real SDK effects; caller mutation=%s', async (mutated) => {
        const { page, runtime, events } = createCaptureApplicationRuntime();
        const service = createCaptureController();
        service.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'assert-intent',
            agentId: 'assert-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'assert-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        const expected = [10, 20];
        try {
            expect(
                service.enqueueCommand({
                    runId: 'assert-intent',
                    agentId: 'assert-agent',
                    commandId: 'assert-root',
                    command: {
                        kind: 'recipe.run',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'assert-body',
                            commands: [
                                {
                                    kind: 'configure',
                                    commandId: 'assert-config',
                                    config: { defaults: { value: 5 }, rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } }
                                },
                                { kind: 'assert', commandId: 'accepted-range', source: 'config.defaults.value', operator: 'between', expected },
                                { kind: 'rtc.connect', commandId: 'after-assert', connection: 'after-assert' }
                            ]
                        }
                    }
                }).left
            ).toBeUndefined();
            if (mutated) {
                expected[0] = 0;
                expected[1] = 10;
            }
            const [dispatch] = service.takeDispatchableCommands('assert-intent', 'assert-agent');
            const { result, envelope } = await executeSerializedControllerCommand(runtime, dispatch);
            const admitted = service.receiveClientEnvelope(envelope);
            const effects = events.filter((event) => event.topic === 'rallar.browser.connect_completed');
            const assertion = toRallarBlackBoxCompositeResultFlatEntries([result]).find((entry) => entry.kind === 'assert');
            console.info('Accepted assertion gate witness', JSON.stringify({ mutated, dispatch, result, admitted, effects }));
            expect.soft(result.ok).toBe(false);
            expect.soft(assertion?.result.value).toMatchObject({ expected: [10, 20], actual: 5, passed: false });
            expect.soft(effects).toEqual([]);
            expect(admitted.accepted).toBe(true);
        }
        finally {
            await page.close();
        }
    });

    it.each([false, true])('executes the acknowledged queued body before any same-ID replacement effects; replacement=%s', async (replaceLocally) => {
        const { page, facade, runtime, events } = createCaptureApplicationRuntime();
        const service = createCaptureController();
        service.receiveClientEnvelope({
            kind: 'register',
            protocolVersion: 1,
            runId: 'accepted-body-run',
            agentId: 'accepted-body-agent',
            atEpochMs: 1_000,
            identity: { sessionLabel: 'accepted-body-agent', updatedAtEpochMs: 1_000 },
            resume: { completedCommandIds: [] }
        });
        const recipe: RallarBlackBoxTestRecipe = {
            schemaVersion: 1,
            recipeId: 'same-body-id',
            commands: [
                { kind: 'configure', commandId: 'accepted-configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                { kind: 'rtc.connect', commandId: 'accepted-connect', connection: 'accepted-A' }
            ]
        };
        try {
            expect(
                service.enqueueCommand({
                    runId: 'accepted-body-run',
                    agentId: 'accepted-body-agent',
                    commandId: 'accepted-load',
                    command: { kind: 'recipe.load', recipe }
                }).left
            ).toBeUndefined();
            const [load] = service.takeDispatchableCommands('accepted-body-run', 'accepted-body-agent');
            const { result: loadResult, envelope: loadEnvelope } = await executeSerializedControllerCommand(runtime, load);
            expect(loadResult).toMatchObject({ ok: true, value: { recipeBodyId: expect.any(String) } });
            expect(service.receiveClientEnvelope(loadEnvelope).accepted).toBe(true);
            if (replaceLocally) {
                const replacement = await runtime.execute({
                    kind: 'recipe.load',
                    commandId: 'local-replacement-load',
                    recipe: {
                        ...recipe,
                        commands: [
                            recipe.commands[0],
                            { kind: 'rtc.connect', commandId: 'replacement-connect', connection: 'replacement-B' }
                        ]
                    }
                });
                expect(replacement.ok).toBe(true);
                expect(decodeRecord(replacement.value).recipeBodyId).not.toEqual(decodeRecord(loadResult.value).recipeBodyId);
            }
            expect(
                service.enqueueCommand({
                    runId: 'accepted-body-run',
                    agentId: 'accepted-body-agent',
                    commandId: 'accepted-run',
                    command: { kind: 'recipe.run', rtcCaptureMode: 'off' }
                }).left
            ).toBeUndefined();
            const [run] = service.takeDispatchableCommands('accepted-body-run', 'accepted-body-agent');
            const { result, envelope } = await executeSerializedControllerCommand(runtime, run);
            const admitted = service.receiveClientEnvelope(envelope);
            const effects = events.filter((event) => event.topic === 'rallar.browser.connect_completed').map((event) => event.connection);
            console.info(
                'Accepted-body witness',
                JSON.stringify({
                    replaceLocally,
                    loadResult,
                    command: run,
                    result,
                    effects,
                    receipt: facade.rtcCapture(),
                    admitted,
                    completed: service.snapshotCommand('accepted-body-run', 'accepted-run')?.completedAtEpochMs
                })
            );
            expect.soft(effects).not.toContain('replacement-B');
            if (replaceLocally && !result.ok) {
                expect.soft(effects).toEqual([]);
                expect.soft(result.status).not.toBe('ok');
                if (admitted.accepted) {
                    expect(service.snapshotRun('accepted-body-run')?.results.find((entry) => entry.commandId === 'accepted-run'))
                        .toMatchObject({ ok: false, result: { ok: false } });
                    expect(service.snapshotCommand('accepted-body-run', 'accepted-run')?.completedAtEpochMs).toBe(1_000);
                }
                else {
                    expect(service.snapshotCommand('accepted-body-run', 'accepted-run')?.completedAtEpochMs).toBeUndefined();
                }
            }
            else if (!replaceLocally || admitted.accepted) {
                expect.soft(result.ok).toBe(true);
                expect.soft(effects).toEqual(['accepted-A']);
                expect.soft(decodeRecord(decodeRecord(result.value).invocation).recipeBodyId).toEqual(decodeRecord(loadResult.value).recipeBodyId);
                expect.soft(facade.rtcCapture()).toMatchObject({
                    configuration: { mode: 'off', origin: 'run' },
                    application: { status: 'applied', mode: 'off' }
                });
                expect.soft(admitted.accepted).toBe(true);
                expect.soft(service.snapshotCommand('accepted-body-run', 'accepted-run')?.completedAtEpochMs).toBe(1_000);
            }
            else {
                expect(service.snapshotCommand('accepted-body-run', 'accepted-run')?.completedAtEpochMs).toBeUndefined();
            }
        }
        finally {
            await page.close();
        }
    });

    it.each(['direct inline', 'staged inline', 'staged configuration', 'mutated caller', 'mutated caller configuration', 'mutated caller defaults'] as const)(
        'executes accepted inline body and capture configuration: %s',
        async (scenario) => {
            const { page, facade, runtime, events } = createCaptureApplicationRuntime();
            const service = createCaptureController();
            service.receiveClientEnvelope({
                kind: 'register',
                protocolVersion: 1,
                runId: 'inline-intent-run',
                agentId: 'inline-agent',
                atEpochMs: 1_000,
                identity: {
                    sessionLabel: 'inline-agent',
                    applicationId: 'app',
                    workspaceId: 'workspace',
                    groupId: 'group',
                    updatedAtEpochMs: 1_000,
                    capabilities: toControlAgentCapabilities({
                        rtcCaptureSupport: runtime.rtcCaptureSupport,
                        config: undefined,
                        providerMode: undefined,
                        apiBaseUrl: undefined
                    })
                },
                resume: { completedCommandIds: [] }
            });
            const connectionDefaults = { connection: 'inline-A' };
            const rallarConfiguration = {
                apiBaseUrl: 'https://test.invalid',
                applicationId: 'app',
                rtcCaptureMode: 'off' as RtcSignalingDiagnostics.CaptureMode
            };
            const recipe: RallarBlackBoxTestRecipe & { commands: RallarBlackBoxTestRecipe['commands'][number][]; } = {
                schemaVersion: 1,
                recipeId: 'inline-same-id',
                commands: [
                    { kind: 'configure', commandId: 'inline-configure', config: { rallar: rallarConfiguration, defaults: connectionDefaults } },
                    { kind: 'rtc.connect', commandId: 'inline-A-connect', ...(scenario === 'mutated caller defaults' ? {} : { connection: 'inline-A' }) }
                ]
            };
            const manifest = {
                schemaVersion: 1 as const,
                distributedRunId: 'inline-intent',
                controlRunId: 'inline-intent-run',
                rtcCaptureMode: (scenario.includes('configuration') ? undefined : 'off') as RtcSignalingDiagnostics.CaptureMode | undefined,
                group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' },
                recipes: [{ recipeId: recipe.recipeId, recipe, variables: {} }],
                targetPolicy: { mode: 'selected-agents' as const, agentIds: ['inline-agent'] },
                variables: {},
                roleAssignments: [],
                ackTimeoutMs: 1_000,
                barrier: { enabled: false as const },
                startMode: 'manual' as const,
                groupAssertions: [],
                metadata: {}
            };
            try {
                expect(service.createDistributedRun(manifest).left).toBeUndefined();
                if (scenario !== 'direct inline') {
                    expect(service.stageDistributedRun('inline-intent').left).toBeUndefined();
                    const [stage] = service.takeDispatchableCommands('inline-intent-run', 'inline-agent');
                    const { envelope } = await executeSerializedControllerCommand(runtime, stage);
                    expect(service.receiveClientEnvelope(envelope).accepted).toBe(true);
                }
                if (scenario === 'mutated caller') {
                    recipe.commands[1] = { kind: 'rtc.connect', commandId: 'inline-B-connect', connection: 'inline-B' };
                    manifest.rtcCaptureMode = 'native';
                }
                if (scenario === 'mutated caller configuration') {
                    rallarConfiguration.rtcCaptureMode = 'native';
                }
                if (scenario === 'mutated caller defaults') {
                    connectionDefaults.connection = 'inline-B';
                }
                const started = service.startDistributedRun('inline-intent');
                if (scenario === 'mutated caller defaults') {
                    expect(started.left).toBeUndefined();
                }
                if (started.left !== undefined) {
                    expect(scenario.startsWith('mutated caller')).toBe(true);
                    expect(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
                    return;
                }
                const [start] = service.takeDispatchableCommands('inline-intent-run', 'inline-agent');
                const { result, envelope } = await executeSerializedControllerCommand(runtime, start);
                const admitted = service.receiveClientEnvelope(envelope);
                if (scenario === 'mutated caller defaults') {
                    expect(admitted.accepted).toBe(true);
                }
                const effects = events.filter((event) => event.topic === 'rallar.browser.connect_completed').map((event) => event.connection);
                console.info('Inline-intent witness', JSON.stringify({ scenario, start, result, effects, receipt: facade.rtcCapture(), admitted }));
                expect.soft(effects).not.toContain('inline-B');
                if (admitted.accepted) {
                    expect.soft(effects).toEqual(['inline-A']);
                    expect.soft(result.ok).toBe(true);
                    expect.soft(facade.rtcCapture()).toMatchObject({
                        configuration: { mode: 'off', origin: scenario.includes('configuration') ? 'step' : 'run' },
                        application: { status: 'applied', mode: 'off' }
                    });
                    expect.soft(service.snapshotDistributedRun('inline-intent')?.state).toBe('passed');
                }
                else {
                    expect(scenario.startsWith('mutated caller')).toBe(true);
                }
            }
            finally {
                await page.close();
            }
        }
    );
});

describe('SDK recipe execution across actual control consumers', () => {
    it('publishes an owned RTC child result before the held control root completes', async () => {
        const { page, runtime, events } = createCaptureApplicationRuntime();
        vi.stubGlobal('WebSocket', SimulatedWebSocket);
        const client = createDefaultRallarBlackBoxControlClient({ runtime, heartbeatIntervalMs: 10_000, statsIntervalMs: 0 });
        const service = createCaptureController();
        const rootId = 'owned-progress-root';
        client.connect({ url: 'ws://owned-progress.test/control', runId: 'owned-progress', agentId: 'progress-agent', completedCommandIds: [] });
        const socket = SimulatedWebSocket.instances.at(-1)!;
        try {
            await socket.open();
            expect(service.receiveClientEnvelope(readSocketRegistration(socket)).accepted).toBe(true);
            const manual = await runtime.execute({ kind: 'health', commandId: rootId });
            expect(
                socket.sent.map((wire) => parseControlClientMessage(wire)).some((parsed) =>
                    parsed.ok && parsed.envelope.kind === 'event' && parsed.envelope.commandId === rootId &&
                    decodeRecord(parsed.envelope.payload).kind === 'result'
                )
            ).toBe(false);
            expect(
                service.enqueueCommand({
                    runId: 'owned-progress',
                    agentId: 'progress-agent',
                    commandId: rootId,
                    command: {
                        kind: 'recipe.run',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'owned-progress-body',
                            commands: [
                                {
                                    kind: 'configure',
                                    commandId: 'progress-config',
                                    config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } }
                                },
                                { kind: 'rtc.connect', commandId: 'progress-connect', connection: 'owned-child' },
                                { kind: 'wait', commandId: 'hold-root', timeoutMs: 10_000, match: { topic: 'release-owned-root' } }
                            ]
                        }
                    }
                }).left
            ).toBeUndefined();
            const [dispatch] = service.takeDispatchableCommands('owned-progress', 'progress-agent');
            await socket.receive(JSON.stringify(dispatch));
            await vi.waitFor(() => expect(runtime.state().activeCommand?.kind).toBe('wait'));
            const child = runtime.state().commandHistory.find((result) => result.kind === 'rtc.connect');
            expect(child?.ok).toBe(true);
            expect(events.filter((event) => event.topic === 'rallar.browser.connect_completed').map((event) => event.connection)).toEqual(['owned-child']);
            expect(readSocketResult(socket, rootId)).toBeUndefined();
            const childFrame = socket.sent.map((wire) => parseControlClientMessage(wire)).find((parsed) =>
                parsed.ok && parsed.envelope.kind === 'event' && parsed.envelope.commandId === child?.commandId &&
                decodeRecord(parsed.envelope.payload).kind === 'result'
            );
            console.info(
                'Owned child progress witness',
                JSON.stringify({ child, childFrame, frames: socket.sent, activeCommand: runtime.state().activeCommand })
            );
            expect.soft(childFrame?.ok).toBe(true);
            if (childFrame?.ok) {
                expect(childFrame.envelope).toMatchObject({ runId: 'owned-progress', agentId: 'progress-agent' });
                expect(service.receiveClientEnvelope(childFrame.envelope).accepted).toBe(true);
            }
            runtime.recordEvent({
                ...{ control: { runId: 'owned-progress', agentId: 'progress-agent', rootCommandId: rootId } },
                kind: 'result',
                topic: 'forged-manual-control-result',
                commandId: rootId,
                payload: manual
            });
            const forged = socket.sent.map((wire) => parseControlClientMessage(wire)).some((parsed) =>
                parsed.ok && parsed.envelope.kind === 'event' && decodeRecord(parsed.envelope.payload).topic === 'forged-manual-control-result'
            );
            console.info('Forged manual attribution witness', JSON.stringify({ forged, local: runtime.state().events.at(-1) }));
            expect.soft(forged).toBe(false);
            expect(service.snapshotCommand('owned-progress', rootId)?.completedAtEpochMs).toBeUndefined();
            runtime.recordEvent({ kind: 'event', topic: 'release-owned-root' });
            await vi.waitFor(() => expect(readSocketResult(socket, rootId)).toBeDefined());
            const root = readSocketResult(socket, rootId)!;
            expect(root.result?.ok).toBe(true);
            expect(service.receiveClientEnvelope(root).accepted).toBe(true);
        }
        finally {
            runtime.recordEvent({ kind: 'event', topic: 'release-owned-root' });
            client.dispose();
            await page.close();
        }
    });

    it.each(['run', 'agent', 'run and agent'] as const)(
        'runs newly assigned work with a colliding command ID through the retained interactive runtime; reassigned=%s',
        async (reassigned) => {
            const { page, facade, events } = createCaptureApplicationRuntime();
            Object.assign(window, { location: { search: '?provider=browser-rallar', hash: '' } });
            vi.stubGlobal('WebSocket', SimulatedWebSocket);
            vi.stubGlobal('sessionStorage', createBrowserTestStorage());
            const { rallarBlackBoxRuntimeStore: store } = await import('../../../../apps/rallar-black-box/src/runtime-store.ts');
            const service = createCaptureController();
            const originalRunId = `interactive-A-${reassigned}`;
            const originalAgentId = `agent-A-${reassigned}`;
            const rootCommandId = `colliding-interactive-root-${reassigned}`;
            const originalBootstrap = store.getSnapshot().bootstrap;
            try {
                await store.runManualCommands([{ kind: 'reset', commandId: 'interactive-reset' }], 'Prepare interactive assignment');
                for (
                    const address of [
                        { runId: originalRunId, agentId: originalAgentId, connection: 'assignment-A', reconnect: false },
                        { runId: originalRunId, agentId: originalAgentId, connection: 'assignment-A', reconnect: true },
                        {
                            runId: reassigned.includes('run') ? `interactive-B-${reassigned}` : originalRunId,
                            agentId: reassigned.includes('agent') ? `agent-B-${reassigned}` : originalAgentId,
                            connection: 'assignment-B',
                            reconnect: false
                        }
                    ]
                ) {
                    store.connectControl('ws://interactive.test/control', address.runId, address.agentId);
                    const socket = SimulatedWebSocket.instances.at(-1);
                    if (socket === undefined) {
                        throw new Error('Interactive consumer did not create its control socket.');
                    }
                    await socket.open();
                    const registration = readSocketRegistration(socket);
                    if (address.reconnect) {
                        expect(registration.resume.completedCommandIds).toContain(rootCommandId);
                    }
                    else {
                        expect.soft(registration.resume.completedCommandIds).not.toContain(rootCommandId);
                    }
                    expect(service.receiveClientEnvelope(registration).accepted).toBe(true);
                    const queued = service.enqueueCommand({
                        runId: address.runId,
                        agentId: address.agentId,
                        commandId: rootCommandId,
                        command: {
                            kind: 'recipe.run',
                            rtcCaptureMode: 'off',
                            recipe: {
                                schemaVersion: 1,
                                recipeId: 'interactive-body',
                                commands: [
                                    {
                                        kind: 'configure',
                                        commandId: `configure-${address.runId}`,
                                        config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } }
                                    },
                                    { kind: 'rtc.connect', commandId: `connect-${address.runId}`, connection: address.connection }
                                ]
                            }
                        }
                    });
                    if (reassigned === 'agent' && address.connection === 'assignment-B') {
                        const relabeled = readSocketResult(socket, rootCommandId);
                        const effects = events.filter((event) => event.topic === 'rallar.browser.connect_completed').map((event) => event.connection);
                        console.info(
                            'Agent-only scope and conflict witness',
                            JSON.stringify({ address, registration: registration, queued, relabeled, effects })
                        );
                        expect(queued.left?.code).toBe('command-payload-conflict');
                        expect(service.takeDispatchableCommands(address.runId, address.agentId)).toEqual([]);
                        expect(effects).toEqual(['assignment-A']);
                        expect.soft(relabeled).toBeUndefined();
                        store.disconnectControl();
                        continue;
                    }
                    expect(queued.left).toBeUndefined();
                    const [dispatch] = service.takeDispatchableCommands(address.runId, address.agentId);
                    const envelope = dispatch === undefined ? readSocketResult(socket, rootCommandId) : await executeSocketCommand(socket, dispatch);
                    if (envelope === undefined) {
                        throw new Error('Interactive consumer did not return its recipe result.');
                    }
                    const admitted = service.receiveClientEnvelope(envelope);
                    const effects = events.filter((event) => event.topic === 'rallar.browser.connect_completed').map((event) => event.connection);
                    console.info(
                        'Interactive-assignment witness',
                        JSON.stringify({
                            reassigned,
                            address,
                            registration: registration,
                            dispatch,
                            envelope: envelope,
                            admitted,
                            effects,
                            receipt: facade.rtcCapture()
                        })
                    );
                    if (address.reconnect) {
                        expect.soft(admitted.accepted).toBe(true);
                        expect.soft(envelope.replayed).toBe(true);
                        expect.soft(envelope.result?.replayed).toBe(true);
                        expect(effects).toEqual(['assignment-A']);
                        const stored = service.snapshotRun(originalRunId)?.results.find((result) => result.commandId === rootCommandId)
                            ?.result;
                        expect(decodeRecord(envelope.result?.value).invocation).toEqual(decodeRecord(stored?.value).invocation);
                        expect(service.snapshotCommand(originalRunId, rootCommandId)?.completedAtEpochMs).toBe(1_000);
                        expect(facade.rtcCapture()).toMatchObject({ application: { status: 'applied', mode: 'off' } });
                    }
                    else if (address.connection === 'assignment-A') {
                        expect(effects).toEqual(['assignment-A']);
                        expect(admitted.accepted).toBe(true);
                        expect(facade.rtcCapture()).toMatchObject({ application: { status: 'applied', mode: 'off' } });
                    }
                    else {
                        expect.soft(dispatch).toBeDefined();
                        expect.soft(envelope).toMatchObject({ runId: address.runId, agentId: address.agentId, replayed: false });
                        expect.soft(envelope.result?.replayed).not.toBe(true);
                        expect.soft(envelope.result?.ok).toBe(true);
                        expect.soft(admitted.accepted).toBe(true);
                        expect.soft(service.snapshotCommand(address.runId, rootCommandId)?.completedAtEpochMs).toBe(1_000);
                        expect.soft(effects).toEqual(['assignment-A', 'assignment-B']);
                        expect.soft(facade.rtcCapture()).toMatchObject({
                            configuration: { mode: 'off', origin: 'run' },
                            application: { status: 'applied', mode: 'off' }
                        });
                    }
                    store.disconnectControl();
                }
            }
            finally {
                store.disconnectControl();
                store.updateBootstrapConfig(originalBootstrap);
                await page.close();
            }
        }
    );

    it('keeps a settling original assignment out of the new control address and its cache', async () => {
        const { page, events } = createCaptureApplicationRuntime();
        Object.assign(window, { location: { search: '?provider=browser-rallar', hash: '' } });
        vi.stubGlobal('WebSocket', SimulatedWebSocket);
        vi.stubGlobal('sessionStorage', createBrowserTestStorage());
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../../apps/rallar-black-box/src/runtime-store.ts');
        const service = createCaptureController();
        const originalBootstrap = store.getSnapshot().bootstrap;
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(connectionHttp.readIceCandidates).mockImplementationOnce(async () => {
            entered.resolve();
            await release.promise;
            return { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
        });
        const rootCommandId = 'settling-control-root';
        try {
            store.connectControl('ws://interactive.test/control', 'settling-A', 'settling-agent');
            const first = SimulatedWebSocket.instances.at(-1)!;
            await first.open();
            expect(service.receiveClientEnvelope(readSocketRegistration(first)).accepted).toBe(true);
            expect(
                service.enqueueCommand({
                    runId: 'settling-A',
                    agentId: 'settling-agent',
                    commandId: rootCommandId,
                    command: {
                        kind: 'recipe.run',
                        rtcCaptureMode: 'off',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'settling-body',
                            commands: [
                                {
                                    kind: 'configure',
                                    commandId: 'settling-A-config',
                                    config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } }
                                },
                                { kind: 'rtc.connect', commandId: 'settling-A-connect', connection: 'settling-A' }
                            ]
                        }
                    }
                }).left
            ).toBeUndefined();
            const [original] = service.takeDispatchableCommands('settling-A', 'settling-agent');
            await first.receive(JSON.stringify(original));
            await entered.promise;
            store.connectControl('ws://interactive.test/control', 'settling-B', 'settling-agent');
            const second = SimulatedWebSocket.instances.at(-1)!;
            await second.open();
            const registered = readSocketRegistration(second);
            expect(service.receiveClientEnvelope(registered).accepted).toBe(true);
            release.resolve();
            await vi.waitFor(() =>
                expect(events.some((event) => event.topic === 'rallar.browser.connect_completed' && event.connection === 'settling-A')).toBe(true)
            );
            const relabeled = readSocketResult(second, rootCommandId);
            console.info('Settling-assignment witness', JSON.stringify({ original, registered, relabeled, state: store.getSnapshot().state, effects: events }));
            expect.soft(relabeled).toBeUndefined();
            expect.soft(
                second.sent.map((wire) => parseControlClientMessage(wire)).some((parsed) =>
                    parsed.ok && parsed.envelope.kind === 'event' && parsed.envelope.commandId === rootCommandId
                )
            ).toBe(false);
            store.disconnectControl();
            store.connectControl('ws://interactive.test/control', 'settling-B', 'settling-agent');
            const resumed = SimulatedWebSocket.instances.at(-1)!;
            await resumed.open();
            const registration = readSocketRegistration(resumed);
            expect.soft(registration.resume.completedCommandIds).not.toContain(rootCommandId);
            expect(service.receiveClientEnvelope(registration).accepted).toBe(true);
            expect(
                service.enqueueCommand({
                    runId: 'settling-B',
                    agentId: 'settling-agent',
                    commandId: rootCommandId,
                    command: {
                        kind: 'recipe.run',
                        rtcCaptureMode: 'off',
                        recipe: {
                            schemaVersion: 1,
                            recipeId: 'settling-body',
                            commands: [
                                { kind: 'rtc.connect', commandId: 'settling-B-connect', connection: 'settling-B' }
                            ]
                        }
                    }
                }).left
            ).toBeUndefined();
            const [next] = service.takeDispatchableCommands('settling-B', 'settling-agent');
            expect.soft(next).toBeDefined();
            if (next !== undefined) {
                const result = await executeSocketCommand(resumed, next);
                expect(result).toMatchObject({ runId: 'settling-B', agentId: 'settling-agent', replayed: false, result: { ok: true } });
                expect(service.receiveClientEnvelope(result).accepted).toBe(true);
                const frames = resumed.sent.flatMap((wire) => {
                    const parsed = parseControlClientMessage(wire);
                    return parsed.ok ? [parsed.envelope] : [];
                });
                const currentRootResult = frames.findIndex((frame) =>
                    frame.kind === 'event' && frame.commandId === rootCommandId && decodeRecord(frame.payload).kind === 'result'
                );
                const firstReport = frames.findIndex((frame) => frame.kind === 'report');
                console.info('Same-ID report ownership witness', JSON.stringify({ currentRootResult, firstReport, frames }));
                expect(currentRootResult).toBeGreaterThanOrEqual(0);
                expect.soft(firstReport).toBeGreaterThan(currentRootResult);
            }
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed').map((event) => event.connection)).toEqual([
                'settling-A',
                'settling-B'
            ]);
        }
        finally {
            release.resolve();
            store.disconnectControl();
            store.updateBootstrapConfig(originalBootstrap);
            await page.close();
        }
    });

    it.each(['root Off', 'recipe Off', 'step Off'] as const)(
        'applies %s to the suffix SDK after actual agent reload and resumed registration',
        async (selection) => {
            vi.stubGlobal('WebSocket', SimulatedWebSocket);
            vi.stubGlobal('sessionStorage', createBrowserTestStorage());
            const reloadPage = vi.fn();
            vi.stubGlobal('location', { reload: reloadPage });
            const service = createCaptureController();
            const first = createCaptureApplicationRuntime(() => ({ timeOrigin: 10, origin: 'https://test.invalid' }));
            const launch = {
                search:
                    '?mode=control&provider=browser-rallar&autoConnect=1&controlUrl=ws%3A%2F%2Freload.test%2Fcontrol&runId=sdk-reload&agentId=reload-agent&apiBaseUrl=https%3A%2F%2Ftest.invalid&applicationId=app&sessionId=session&actor=tester&rallarRestoreSession=1',
                env: {},
                hash: ''
            };
            let agent = createDefaultRallarBlackBoxBrowserControlAgent(launch);
            let second: CaptureApplicationRuntime | undefined;
            const deadlineEpochMs = Date.now() + 60_000;
            try {
                expect((await agent.start()).right).toBe('connecting');
                const prefixSocket = SimulatedWebSocket.instances.at(-1)!;
                await prefixSocket.open();
                const registered = readSocketRegistration(prefixSocket);
                expect(service.receiveClientEnvelope(registered).accepted).toBe(true);
                expect(
                    service.enqueueCommand({
                        runId: 'sdk-reload',
                        agentId: 'reload-agent',
                        commandId: 'reload-logical-root',
                        deadlineEpochMs,
                        command: {
                            kind: 'recipe.run',
                            rtcCaptureMode: selection === 'root Off' ? 'off' : undefined,
                            recipe: {
                                schemaVersion: 1,
                                recipeId: 'reload-capture',
                                rtcCaptureMode: selection === 'recipe Off' ? 'off' : undefined,
                                continueOnFailure: false,
                                metadata: { profile: 'alm-conformance' },
                                commands: [
                                    { kind: 'health', commandId: 'prefix-health' },
                                    { kind: 'agent.reload', commandId: 'replace-agent-page', readyTimeoutMs: 60_000 },
                                    {
                                        kind: 'configure',
                                        commandId: 'suffix-configuration',
                                        config: { roomId: '', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } }
                                    },
                                    {
                                        kind: 'rtc.connect',
                                        commandId: 'suffix-connect',
                                        connection: 'suffix-SDK',
                                        rallar: selection === 'step Off' ? { rtcCaptureMode: 'off' } : undefined
                                    }
                                ]
                            }
                        }
                    }).left
                ).toBeUndefined();
                const [prefix] = service.takeDispatchableCommands('sdk-reload', 'reload-agent');
                expect(prefix.deadlineEpochMs).toBe(deadlineEpochMs);
                const prefixResult = await executeSocketCommand(prefixSocket, prefix);
                expect(service.receiveClientEnvelope(prefixResult).accepted).toBe(true);
                const [reload] = service.takeDispatchableCommands('sdk-reload', 'reload-agent');
                expect(reload.command.kind).toBe('agent.reload');
                expect(reload.deadlineEpochMs).toBe(deadlineEpochMs);
                const reloadResult = await executeSocketCommand(prefixSocket, reload);
                await vi.waitFor(() => expect(reloadPage).toHaveBeenCalledTimes(1));
                expect(service.receiveClientEnvelope(reloadResult).accepted).toBe(true);
                expect(service.takeDispatchableCommands('sdk-reload', 'reload-agent')).toEqual([]);
                agent.dispose();
                await first.page.close();
                service.markAgentDisconnected('sdk-reload', 'reload-agent');
                second = createCaptureApplicationRuntime(() => ({ timeOrigin: 20, origin: 'https://test.invalid' }));
                agent = createDefaultRallarBlackBoxBrowserControlAgent(launch);
                expect((await agent.start()).right).toBe('connecting');
                const suffixSocket = SimulatedWebSocket.instances.at(-1)!;
                await suffixSocket.open();
                const resumed = readSocketRegistration(suffixSocket);
                expect(resumed).toMatchObject({
                    runId: 'sdk-reload',
                    agentId: 'reload-agent',
                    resume: { completedCommandIds: expect.arrayContaining([reload.commandId]) }
                });
                expect(service.receiveClientEnvelope(resumed).accepted).toBe(true);
                expect(sessionStorage.getItem('rallar-bb-agent-resume')).toBeNull();
                const [suffix] = service.takeDispatchableCommands('sdk-reload', 'reload-agent');
                expect(suffix.deadlineEpochMs).toBe(deadlineEpochMs);
                const suffixResult = await executeSocketCommand(suffixSocket, suffix);
                const admitted = service.receiveClientEnvelope(suffixResult);
                const effects = second.events.filter((event) => event.topic === 'rallar.browser.connect_completed');
                console.info(
                    'Reload-SDK witness',
                    JSON.stringify({
                        selection,
                        prefix,
                        reload,
                        resumed: resumed,
                        suffix,
                        result: suffixResult,
                        effects,
                        receipt: second.facade.rtcCapture(),
                        admitted
                    })
                );
                expect(effects.map((event) => event.connection)).toEqual(['suffix-SDK']);
                expect(suffixResult.result?.ok).toBe(true);
                expect(admitted.accepted).toBe(true);
                expect(first.facade.isConnected()).toBe(false);
                expect.soft(second.facade.rtcCapture()).toMatchObject({ application: { status: 'applied', mode: 'off' } });
                const connectResult = toRallarBlackBoxCompositeResultFlatEntries([suffixResult.result!]).find((entry) => entry.kind === 'rtc.connect');
                expect(connectResult?.result.value).toMatchObject({
                    document: { timeOrigin: 20, origin: 'https://test.invalid' },
                    applicationId: 'app',
                    connection: 'suffix-SDK'
                });
            }
            finally {
                agent.dispose();
                await first.page.close();
                await second?.page.close();
            }
        }
    );
});
