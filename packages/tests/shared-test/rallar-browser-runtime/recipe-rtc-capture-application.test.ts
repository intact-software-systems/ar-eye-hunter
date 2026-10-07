import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';

import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';

import { type BlackBoxBrowserRallarRuntimeDependency } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarConnectionRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/connection/black-box-rallar-connection-runtime.ts';

import { createSpaBrowserRallarRuntime } from '@shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { parseControlClientMessage, parseControlServerMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { computeDistributedRunSnapshotPerformance } from '@shared-test/rallar-bb-test/distributed-run-performance/compute-distributed-run-snapshot-performance.ts';
import { toControlAgentCapabilities } from '@shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { resolveRequiredRtcCaptureFailure } from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import * as connectionHttp from '@shared-web/browser/connection/connection-http-api.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';
import type { RallarMessageHandle } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarMessageSelectorInput } from '@shared-web/browser/messages/rallar-message-selectors.ts';

import * as snapshots from '@shared-web/browser/state-read/refresh-state-snapshots.ts';
import * as auth from '@shared/api/auth.ts';
import { isRallarCrdtDocumentRef, type RallarCrdtMetricEvent } from '@shared/crdt/mod.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import { createControlRunArtifactBundle } from '../../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';

import { createHttpCatchUpResponse } from '../../shared-web/crdt/rallar-crdt-test-runtime.ts';

import {
    createCaptureApplicationRuntime,
    createCaptureController,
    executeSerializedControllerCommand,
    installCaptureApplicationTestEnvironment
} from './capture-application-test-runtime.ts';

installCaptureApplicationTestEnvironment();

interface HydratedCrdtSubscription {
    readonly selector: RallarMessageSelectorInput;
    readonly ownershipFailure: ReturnType<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion['captureOwnershipFailure']>;
}

describe('decoded recipe application through the SPA and SDK initializer', () => {
    it.each([false, true])(
        'preserves the actual SDK Off receipt and invocation in accepted controller storage; nested reference=%s',
        async (nestedReference) => {
            const { page, runtime, events } = createCaptureApplicationRuntime();
            const service = createCaptureController();
            service.receiveClientEnvelope({
                kind: 'register',
                protocolVersion: 1,
                runId: 'sdk-receipt-run',
                agentId: 'sdk-agent',
                atEpochMs: 1_000,
                identity: { sessionLabel: 'sdk-agent', updatedAtEpochMs: 1_000 },
                resume: { completedCommandIds: [] }
            });
            try {
                const recipe: RallarBlackBoxTestRecipe = {
                    schemaVersion: 1,
                    recipeId: 'sdk-receipt',
                    commands: [
                        { kind: 'configure', commandId: 'sdk-configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect', commandId: 'sdk-connect' }
                    ]
                };
                const queued = service.enqueueCommand({
                    runId: 'sdk-receipt-run',
                    agentId: 'sdk-agent',
                    commandId: 'sdk-recipe-root',
                    command: {
                        kind: 'recipe.run',
                        rtcCaptureMode: 'off',
                        recipe: nestedReference
                            ? {
                                schemaVersion: 1,
                                recipeId: 'sdk-outer',
                                commands: [
                                    { kind: 'recipe.load', commandId: 'sdk-load', recipe },
                                    { kind: 'recipe.run', commandId: 'sdk-reference' }
                                ]
                            }
                            : recipe
                    }
                });
                expect(queued.left).toBeUndefined();
                const [dispatch] = service.takeDispatchableCommands('sdk-receipt-run', 'sdk-agent');
                expect(dispatch?.commandId).toBe('sdk-recipe-root');
                const { result, envelope } = await executeSerializedControllerCommand(runtime, dispatch);
                expect(result).toMatchObject({ commandId: 'sdk-recipe-root', status: 'ok', ok: true });
                const connect = toRallarBlackBoxCompositeResultFlatEntries([result])
                    .find((entry) => entry.commandId === 'sdk-connect')?.result;
                expect(connect).toMatchObject({ kind: 'rtc.connect', status: 'ok', ok: true });
                const rtcCapture = toRtcCaptureReadout(decodeJsonValue(decodeRecord(connect?.value).rtcCapture));
                expect(rtcCapture.left).toBeUndefined();
                expect(rtcCapture.right).toMatchObject({
                    status: 'observed',
                    value: {
                        configurationVersion: 1,
                        configuration: { mode: 'off', origin: 'run' },
                        application: { status: 'applied', mode: 'off' },
                        connectionId: { status: 'observed', value: expect.any(String) },
                        nativeScopeId: { status: 'unavailable', reason: 'not-applicable' },
                        nativeAvailability: { status: 'unavailable', reason: 'disabled' },
                        nativeCoverage: 'not-applicable'
                    }
                });
                if (rtcCapture.right === undefined) {
                    throw new Error('Actual SDK receipt did not decode.');
                }
                expect(resolveRequiredRtcCaptureFailure({ mode: 'off', origin: 'run' }, rtcCapture.right)).toBeUndefined();
                expect(events.filter((event) => event.topic === 'rallar.browser.rtc.signaling_diagnostics')).toEqual([]);
                const invocation = decodeRecord(decodeRecord(result.value).invocation);
                expect(invocation).toMatchObject({ invocationId: expect.any(String), recipeBodyId: expect.any(String), run: 'off' });
                const invalid = JSON.parse(JSON.stringify(envelope));
                const invalidRecipe = nestedReference ? invalid.result.value.results[1] : invalid.result;
                invalidRecipe.value.results[1].value.rtcCapture.value.application.mode = 'native';
                const refused = parseControlClientMessage(JSON.stringify(invalid));
                if (!refused.ok) {
                    throw new Error('Invalid application fixture must still cross the wire decoder.');
                }
                expect(service.receiveClientEnvelope(refused.envelope).accepted).toBe(false);
                expect(service.snapshotRun('sdk-receipt-run')?.results).toEqual([]);
                expect(service.snapshotCommand('sdk-receipt-run', 'sdk-recipe-root')?.completedAtEpochMs).toBeUndefined();
                expect(service.snapshotRun('sdk-receipt-run')?.agents[0].completedCommandIds).toEqual([]);
                expect(service.receiveClientEnvelope(envelope).accepted).toBe(true);
                const stored = service.snapshotRun('sdk-receipt-run')?.results.find((entry) => entry.commandId === 'sdk-recipe-root');
                expect(stored).toMatchObject({ runId: 'sdk-receipt-run', agentId: 'sdk-agent', commandId: 'sdk-recipe-root', ok: true, replayed: false });
                expect(decodeRecord(stored?.result?.value).invocation).toEqual(invocation);
                if (stored?.result === undefined) {
                    throw new Error('Accepted actual SDK result must retain its finite children.');
                }
                const storedConnect = toRallarBlackBoxCompositeResultFlatEntries([stored.result])
                    .find((entry) => entry.commandId === 'sdk-connect')?.result;
                expect(toRtcCaptureReadout(decodeJsonValue(decodeRecord(storedConnect?.value).rtcCapture)).right).toEqual(rtcCapture.right);
                for (const field of ['document', 'scope', 'roomRef', 'applicationId', 'workspaceId', 'clientId', 'sessionId']) {
                    expect(decodeRecord(storedConnect?.value)[field]).toEqual(decodeRecord(connect?.value)[field]);
                }
                const snapshot = service.snapshotForPersistence({});
                const decoded = decodeControlRunSnapshot(JSON.parse(JSON.stringify(snapshot.runs[0])));
                expect(decoded.left).toBeUndefined();
                if (decoded.right === undefined) {
                    throw new Error('Stored SDK receipt snapshot did not decode.');
                }
                service.restoreSnapshot({ ...snapshot, runs: [decoded.right] });
                const restored = service.snapshotRun('sdk-receipt-run');
                expect(restored).toBeDefined();
                if (restored === undefined) {
                    throw new Error('Stored SDK receipt run did not restore.');
                }
                const exported = createControlRunArtifactBundle(restored, 1_001);
                const rows = exported.files['results.jsonl'].trim().split('\n').map((line) => decodeRecord(JSON.parse(line)));
                expect(rows).toHaveLength(1);
                const exportedActual = decodeRecord(rows[0].actual);
                expect(exportedActual.invocation).toEqual(invocation);
                const exportedConnect = toRallarBlackBoxCompositeResultFlatEntries([{ ...stored.result, value: exportedActual }])
                    .find((entry) => entry.commandId === 'sdk-connect')?.result;
                expect(toRtcCaptureReadout(decodeJsonValue(decodeRecord(exportedConnect?.value).rtcCapture)).right).toEqual(rtcCapture.right);
            }
            finally {
                await page.close();
            }
        }
    );

    it.each([false, true])(
        'retains actual SDK receipt paths and replay through distributed snapshots and native disk provenance; retired=%s',
        async (retired) => {
            const { page, facade, runtime, events } = createCaptureApplicationRuntime();
            const service = createCaptureController();
            const recipe: RallarBlackBoxTestRecipe = {
                schemaVersion: 1,
                recipeId: 'sdk-path-receipt',
                commands: [
                    { kind: 'configure', commandId: 'sdk-configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                    { kind: 'loop', commandId: 'sdk-loop', count: 2, commands: [{ kind: 'rtc.connect', commandId: 'same-connect' }] },
                    {
                        kind: 'parallel',
                        commandId: 'sdk-parallel',
                        maxConcurrency: 1,
                        groups: [
                            { groupId: 'left', commands: [{ kind: 'rtc.connect', commandId: 'same-connect' }] },
                            { groupId: 'right', commands: [{ kind: 'rtc.connect', commandId: 'same-connect' }] }
                        ]
                    }
                ]
            };
            service.receiveClientEnvelope({
                kind: 'register',
                protocolVersion: 1,
                runId: 'sdk-path-run',
                agentId: 'sdk-agent',
                atEpochMs: 1_000,
                identity: {
                    sessionLabel: 'sdk-agent',
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
            try {
                const created = service.createDistributedRun({
                    schemaVersion: 1,
                    distributedRunId: 'sdk-distributed',
                    controlRunId: 'sdk-path-run',
                    rtcCaptureMode: 'off',
                    group: { applicationId: 'app', workspaceId: 'workspace', groupId: 'group' },
                    recipes: [{ recipeId: recipe.recipeId, recipe, variables: {} }],
                    targetPolicy: { mode: 'selected-agents', agentIds: ['sdk-agent'] },
                    variables: {},
                    roleAssignments: [],
                    ackTimeoutMs: 1_000,
                    barrier: { enabled: false },
                    startMode: 'manual',
                    groupAssertions: [],
                    metadata: {}
                });
                expect(created.left).toBeUndefined();
                expect(service.stageDistributedRun('sdk-distributed').left).toBeUndefined();
                const [stage] = service.takeDispatchableCommands('sdk-path-run', 'sdk-agent');
                expect(stage?.command.kind).toBe('recipe.load');
                const { envelope: stageEnvelope } = await executeSerializedControllerCommand(runtime, stage);
                expect(service.receiveClientEnvelope(stageEnvelope).accepted).toBe(true);
                expect(service.startDistributedRun('sdk-distributed').left).toBeUndefined();
                const [start] = service.takeDispatchableCommands('sdk-path-run', 'sdk-agent');
                expect(start?.command.kind).toBe('recipe.run');
                const { result } = await executeSerializedControllerCommand(runtime, start);
                expect(result.ok).toBe(true);
                const original = toRallarBlackBoxCompositeResultFlatEntries([result]);
                const connections = original.filter((entry) => entry.kind === 'rtc.connect');
                expect(connections).toHaveLength(4);
                expect(new Set(connections.map((entry) => entry.path)).size).toBe(4);
                const originalReceipt = toRtcCaptureReadout(decodeJsonValue(decodeRecord(connections[0].result.value).rtcCapture)).right;
                expect(originalReceipt?.status).toBe('observed');
                if (originalReceipt === undefined) {
                    throw new Error('Distributed SDK receipt did not decode.');
                }
                expect(resolveRequiredRtcCaptureFailure({ mode: 'off', origin: 'run' }, originalReceipt)).toBeUndefined();
                for (const connection of connections) {
                    expect(toRtcCaptureReadout(decodeJsonValue(decodeRecord(connection.result.value).rtcCapture)).right).toEqual(originalReceipt);
                }
                const originalEffects = events.filter((event) => event.topic === 'rallar.browser.connect_completed');
                if (retired) {
                    await page.close();
                    expect(facade.isConnected()).toBe(false);
                }
                const { result: replay, envelope: replayEnvelope, wire } = await executeSerializedControllerCommand(runtime, start);
                expect(replay.replayed).toBe(true);
                expect(replay.value).toEqual(result.value);
                expect(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual(originalEffects);
                expect(replayEnvelope.replayed).toBe(true);
                expect(service.receiveClientEnvelope(replayEnvelope).accepted).toBe(true);
                const snapshot = service.snapshotForPersistence({});
                const decoded = decodeControlRunSnapshot(JSON.parse(JSON.stringify(snapshot.runs[0])));
                expect(decoded.left).toBeUndefined();
                if (decoded.right === undefined) {
                    throw new Error('Distributed SDK snapshot did not decode.');
                }
                service.restoreSnapshot({ ...snapshot, runs: [decoded.right] });
                const distributed = service.snapshotDistributedRun('sdk-distributed');
                expect(distributed?.state).toBe('passed');
                expect(distributed?.commandLinks.find((link) => link.commandId === start.commandId)?.phase).toBe('start');
                const bundle = service.createDistributedRunArtifactBundle('sdk-distributed', {});
                expect(bundle).toBeDefined();
                if (bundle === undefined) {
                    throw new Error('Distributed SDK bundle was unavailable.');
                }
                const exported = decodeControlRunSnapshot(JSON.parse(bundle.files['control-run.json'])).right;
                if (exported === undefined || distributed === undefined) {
                    throw new Error('Historical measurement source snapshots did not decode.');
                }
                const measurement = computeDistributedRunSnapshotPerformance({ distributedRun: distributed, controlRun: exported });
                expect(measurement.commandTiming.count).toBe(2);
                const stored = exported?.results.find((entry) => entry.commandId === start.commandId);
                expect(stored).toMatchObject({ replayed: true, result: { replayed: true } });
                expect(decodeRecord(stored?.result?.value).invocation).toEqual(decodeRecord(result.value).invocation);
                if (stored?.result === undefined) {
                    throw new Error('Distributed SDK stored result was unavailable.');
                }
                const retained = toRallarBlackBoxCompositeResultFlatEntries([stored.result]).filter((entry) => entry.kind === 'rtc.connect');
                expect(
                    retained.map((entry) => ({
                        path: entry.path,
                        sourceRecipePath: entry.sourceRecipePath,
                        position: entry.position,
                        commandId: entry.commandId
                    }))
                )
                    .toEqual(
                        connections.map((entry) => ({
                            path: entry.path,
                            sourceRecipePath: entry.sourceRecipePath,
                            position: entry.position,
                            commandId: entry.commandId
                        }))
                    );
                for (const entry of retained) {
                    expect(toRtcCaptureReadout(decodeJsonValue(decodeRecord(entry.result.value).rtcCapture)).right).toEqual(originalReceipt);
                }
                const witnessPath = process.env.RALLAR_SDK_RECEIPT_WITNESS_PATH;
                if (witnessPath !== undefined && !retired) {
                    const source = await readFile(new URL('./recipe-rtc-capture-application.test.ts', import.meta.url));
                    const producer = {
                        test: 'actual SDK distributed Off receipt and replay',
                        sourceSha256: createHash('sha256').update(source).digest('hex'),
                        wireSha256: createHash('sha256').update(wire).digest('hex')
                    };
                    const text = JSON.stringify({
                        producer,
                        snapshot,
                        envelopes: [stageEnvelope, replayEnvelope],
                        receipt: originalReceipt,
                        invocation: decodeRecord(result.value).invocation,
                        commandId: start.commandId
                    });
                    await writeFile(witnessPath, text, { flag: 'wx' });
                    console.log(`SDK disk witness producer: ${createHash('sha256').update(text).digest('hex')}`);
                }
            }
            finally {
                await page.close();
            }
        }
    );

    it.each(
        [
            { scenario: 'explicit Off', mode: 'off', run: undefined, recipe: undefined },
            { scenario: 'run Off with step Signaling and recipe Native', mode: 'signaling', run: 'off', recipe: 'native' },
            { scenario: 'ordinary omitted capture intent', mode: undefined, run: undefined, recipe: undefined }
        ] as const
    )('carries captured $scenario into the owned room join port', async (selection) => {
        const { facade, page } = createCaptureApplicationRuntime();
        const connectPort = vi.spyOn(facade, 'connect');
        const joinPort = vi.spyOn(facade.rooms, 'join').mockResolvedValue();
        const captureContext: { run: RtcSignalingDiagnostics.CaptureMode; recipe: RtcSignalingDiagnostics.CaptureMode; } | undefined =
            selection.run && selection.recipe ? { run: selection.run, recipe: selection.recipe } : undefined;
        const rallar = {
            apiBaseUrl: 'https://test.invalid',
            applicationId: 'app',
            workspaceId: 'workspace',
            timeoutMs: 1_234,
            rtcCaptureMode: selection.mode,
            rtcCaptureContext: captureContext
        };
        try {
            const connecting = page.connect({ connection: 'default', roomId: 'room', rallar });
            rallar.rtcCaptureMode = 'off';
            if (captureContext) {
                captureContext.run = 'native';
                captureContext.recipe = 'off';
            }
            await connecting;
            const expectedContext = selection.run && selection.recipe ? { run: selection.run, recipe: selection.recipe } : undefined;
            expect(connectPort).toHaveBeenCalledWith({
                timeoutMs: 1_234,
                dataChannelLanes: undefined,
                rtcCaptureMode: selection.mode,
                rtcCaptureContext: expectedContext
            });
            expect(joinPort).toHaveBeenCalledWith('room', {
                timeoutMs: 1_234,
                scope: { applicationId: 'app', workspaceId: 'workspace' },
                rtcCaptureMode: selection.mode,
                rtcCaptureContext: expectedContext
            });
        }
        finally {
            await page.close();
        }
    });

    it.each(['phase completed', 'phase status', 'result lane health', 'terminal publication', 'document read', 'SDK clock'] as const)(
        'required connect retains its original refusal after %s closes its page',
        async (boundary) => {
            const realNow = Date.now;
            const clock = boundary === 'SDK clock' ? vi.spyOn(Date, 'now') : undefined;
            const readDocument = vi.fn<BlackBoxRallarConnectionRuntime.Input['readDocument']>(() => ({ timeOrigin: 1, origin: 'https://test.invalid' }));
            const { events, facade, page, runtime, targetWindow } = createCaptureApplicationRuntime(readDocument);
            let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
            let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
            let constructionConnected = false;
            const closeObservedPage = (): void => {
                const receipt = facade.rtcCapture();
                if (!closing && receipt) {
                    originalReceipt = receipt;
                    constructionConnected = facade.isConnected();
                    closing = page.close();
                }
            };
            if (boundary === 'phase completed' || boundary === 'terminal publication') {
                targetWindow.__blackBoxRallarEmit = (event) => {
                    events.push(event);
                    if (
                        boundary === 'terminal publication'
                            ? event.topic === 'rallar.browser.connect_completed'
                            : event.topic === 'rallar.browser.connect.phase_completed' && typeof event.data === 'object' && event.data !== null &&
                                'phase' in event.data && event.data.phase === 'rallar-connect'
                    ) {
                        closeObservedPage();
                    }
                };
            }
            else if (boundary === 'phase status') {
                const readStatus = facade.rtc.status;
                vi.spyOn(facade.rtc, 'status').mockImplementation((options) => {
                    const status = readStatus(options);
                    closeObservedPage();
                    return status;
                });
            }
            else if (boundary === 'result lane health') {
                const readHealth = facade.realtime.health;
                vi.spyOn(facade.realtime, 'health').mockImplementation((options) => {
                    const health = readHealth(options);
                    closeObservedPage();
                    return health;
                });
            }
            else if (boundary === 'document read') {
                readDocument.mockImplementation(() => {
                    closeObservedPage();
                    return { timeOrigin: 1, origin: 'https://test.invalid' };
                });
            }
            else {
                clock?.mockImplementation(() => {
                    const now = realNow();
                    if (facade.isConnected()) {
                        closeObservedPage();
                    }
                    return now;
                });
            }
            try {
                const result = await runtime.execute({
                    kind: 'recipe.run',
                    rtcCaptureMode: 'off',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'closed-connect',
                        commands: [
                            { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                            { kind: 'rtc.connect' }
                        ]
                    }
                });
                expect(originalReceipt).toMatchObject({ configuration: { mode: 'off', origin: 'run' }, application: { status: 'applied', mode: 'off' } });
                expect(constructionConnected).toBe(true);
                expect(closing).toBeDefined();
                await closing;
                expect.soft(result.ok, JSON.stringify(result)).toBe(false);
                const failure = {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    reason: 'operation-not-current',
                    requestedConfiguration: { mode: 'off', origin: 'run' },
                    rtcCapture: { status: 'observed', value: originalReceipt }
                };
                expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                    status: 'failed',
                    error: { code: 'RALLAR_RTC_CAPTURE_UNVERIFIED', details: failure }
                });
                const completions = events.filter((event) => event.topic === 'rallar.browser.connect_completed');
                if (boundary === 'terminal publication') {
                    expect(JSON.parse(JSON.stringify(completions))).toEqual([expect.objectContaining({
                        connection: 'default',
                        data: expect.objectContaining({ status: 'connected', rtcCapture: { status: 'observed', value: originalReceipt } })
                    })]);
                }
                else {
                    expect.soft(completions).toEqual([]);
                }
                expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                    expect.arrayContaining([expect.objectContaining({ connection: 'default', error: expect.objectContaining(failure) })])
                );
            }
            finally {
                await page.close();
            }
        }
    );

    it('required Native refuses unavailable application while actual SDK construction succeeds', async () => {
        const { facade, page, runtime, events, targetWindow } = createCaptureApplicationRuntime();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let constructionConnected = false;
        let connectedAtRefusal = false;
        let receiptAtRefusal: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            const completion = await connect(options);
            originalReceipt = completion.rtcCapture.status === 'observed' ? completion.rtcCapture.value : undefined;
            constructionConnected = facade.isConnected();
            return completion;
        });
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_failed') {
                connectedAtRefusal = facade.isConnected();
                receiptAtRefusal = facade.rtcCapture();
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'native',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'native-unavailable',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'native', origin: 'run' },
                application: { status: 'unavailable', reason: 'sink-unavailable' }
            });
            expect(constructionConnected).toBe(true);
            expect(connectedAtRefusal).toBe(true);
            expect(receiptAtRefusal).toBe(originalReceipt);
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'application-unavailable',
                        requestedConfiguration: { mode: 'native', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'application-unavailable',
                        requestedConfiguration: { mode: 'native', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it('required Native preserves actual applied partial coverage through page JSON success', async () => {
        const { facade, page, runtime, events } = createCaptureApplicationRuntime();
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'native',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'native-partial',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            const originalReceipt = facade.rtcCapture();
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'native', origin: 'run' },
                application: { status: 'applied', mode: 'native' },
                nativeCoverage: 'partial'
            });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(facade.isConnected()).toBe(true);
            expect(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'ok',
                value: { status: 'connected', rtcCapture: { status: 'observed', value: originalReceipt } }
            });
            expect(JSON.parse(JSON.stringify(events.find((event) => event.topic === 'rallar.browser.connect_completed')))).toMatchObject({
                connection: 'default',
                data: { rtcCapture: { status: 'observed', value: originalReceipt } }
            });
        }
        finally {
            await page.close();
        }
    });

    it('required connect refuses session invalidated through observed SDK lifecycle clock after graph acceptance', async () => {
        const realNow = Date.now;
        const clock = vi.spyOn(Date, 'now');
        const { facade, page, runtime, events, targetWindow } = createCaptureApplicationRuntime();
        let completion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let constructionConnected = false;
        let connectedAtRefusal = false;
        let receiptAtRefusal: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            completion = await connect(options);
            constructionConnected = facade.isConnected();
            return completion;
        });
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_failed') {
                connectedAtRefusal = facade.isConnected();
                receiptAtRefusal = facade.rtcCapture();
            }
        };
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let reentryFired = false;
        clock.mockImplementation(() => {
            const now = realNow();
            const receipt = facade.rtcCapture();
            if (!reentryFired && receipt && facade.isConnected()) {
                originalReceipt = receipt;
                reentryFired = true;
                vi.mocked(auth.readSession).mockReturnValue(undefined);
            }
            return now;
        });
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'clock-session-ended',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app' } } },
                        { kind: 'rtc.connect' }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(reentryFired).toBe(true);
            expect(constructionConnected).toBe(true);
            expect(connectedAtRefusal).toBe(true);
            expect(receiptAtRefusal).toBe(originalReceipt);
            expect(completion?.rtcCapture).toEqual({ status: 'observed', value: originalReceipt });
            expect(facade.session()).toBeUndefined();
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'session-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'session-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it.each([
        { scenario: 'required Off room-await closure retains canonical refusal', required: true },
        { scenario: 'omitted-intent room-await closure retains ordinary cancellation', required: false }
    ])('$scenario', async ({ required }) => {
        const { facade, page, runtime, events } = createCaptureApplicationRuntime();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let constructionConnected = false;
        vi.spyOn(facade.rooms, 'join').mockImplementation(async () => {
            originalReceipt = facade.rtcCapture();
            constructionConnected = facade.isConnected();
            entered.resolve();
            await release.promise;
        });
        try {
            const executing = runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: required ? 'off' : undefined,
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'pending-room-page-closed',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'workspace' } } },
                        { kind: 'rtc.connect', roomId: 'room' }
                    ]
                }
            });
            await entered.promise;
            const closing = page.close();
            release.resolve();
            const result = await executing;
            expect(await closing).toMatchObject({ status: 'closed', disconnected: true });
            expect(originalReceipt).toMatchObject({ application: { status: 'applied' }, connectionId: { status: 'observed' } });
            expect(constructionConnected).toBe(true);
            expect(facade.isConnected()).toBe(false);
            expect(result.ok, JSON.stringify(result)).toBe(false);
            expect(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            const history = JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')));
            const failures = JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')));
            if (required) {
                expect(originalReceipt).toMatchObject({
                    configuration: { mode: 'off', origin: 'run' },
                    application: { status: 'applied', mode: 'off' }
                });
                expect.soft(history).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'operation-not-current',
                            requestedConfiguration: { mode: 'off', origin: 'run' },
                            rtcCapture: { status: 'observed', value: originalReceipt }
                        }
                    }
                });
                expect.soft(failures).toEqual(expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'operation-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })]));
            }
            else {
                expect(history).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                        message: expect.stringContaining('cancelled'),
                        details: { name: 'Error' }
                    }
                });
                expect(failures).toEqual(expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({ name: 'Error', message: expect.stringContaining('cancelled') })
                })]));
                expect(history.error.details).not.toHaveProperty('rtcCapture');
                expect(failures[0].error).not.toHaveProperty('code');
            }
        }
        finally {
            release.resolve();
            await page.close();
        }
    });

    it('required room connect refuses replaced SDK middleware with its original receipt', async () => {
        const { facade, page, runtime, events, targetWindow } = createCaptureApplicationRuntime();
        let originalCompletion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let replacementCompletion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let originalSession: ReturnType<BlackBoxBrowserRallarRuntimeDependency['session']>;
        let replacementSession: ReturnType<BlackBoxBrowserRallarRuntimeDependency['session']>;
        let originalConnected = false;
        let replacementConnected = false;
        let latestReceiptAtRefusal: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            originalCompletion = await connect(options);
            originalSession = facade.session();
            originalConnected = facade.isConnected();
            return originalCompletion;
        });
        vi.spyOn(facade.rooms, 'join').mockImplementation(async () => {
            await facade.disconnect();
            replacementCompletion = await connect({ rtcCaptureContext: { run: 'off' } });
            replacementSession = facade.session();
            replacementConnected = facade.isConnected();
        });
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_failed') {
                latestReceiptAtRefusal = facade.rtcCapture();
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'room-sdk-replaced',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'workspace' } } },
                        { kind: 'rtc.connect', roomId: 'room' }
                    ]
                }
            });
            const originalReceipt = originalCompletion?.rtcCapture.status === 'observed' ? originalCompletion.rtcCapture.value : undefined;
            const replacementReceipt = replacementCompletion?.rtcCapture.status === 'observed' ? replacementCompletion.rtcCapture.value : undefined;
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' },
                connectionId: { status: 'observed' }
            });
            expect(replacementReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' },
                connectionId: { status: 'observed' }
            });
            expect(replacementReceipt?.connectionId).not.toEqual(originalReceipt?.connectionId);
            expect(originalConnected).toBe(true);
            expect(replacementConnected).toBe(true);
            expect(originalSession?.sessionId).toBe('session');
            expect(replacementSession).toEqual(originalSession);
            expect(latestReceiptAtRefusal).toBe(replacementReceipt);
            expect.soft(result.ok, JSON.stringify(result)).toBe(false);
            expect.soft(JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')))).toMatchObject({
                status: 'failed',
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    details: {
                        reason: 'middleware-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    }
                }
            });
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.connect_completed')).toEqual([]);
            expect.soft(JSON.parse(JSON.stringify(events.filter((event) => event.topic === 'rallar.browser.connect_failed')))).toEqual(
                expect.arrayContaining([expect.objectContaining({
                    connection: 'default',
                    error: expect.objectContaining({
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'middleware-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: { status: 'observed', value: originalReceipt }
                    })
                })])
            );
        }
        finally {
            await page.close();
        }
    });

    it.each([
        { scenario: 'non-reentrant room completion starts genuine readiness', closePage: false },
        { scenario: 'closed room completion refuses before readiness starts', closePage: true }
    ])('$scenario', async ({ closePage }) => {
        const { facade, page, runtime, events, targetWindow } = createCaptureApplicationRuntime();
        let originalReceipt: ReturnType<BlackBoxBrowserRallarRuntimeDependency['rtcCapture']>;
        let closing: ReturnType<BlackBoxRallarRuntime['close']> | undefined;
        vi.spyOn(facade.rooms, 'join').mockResolvedValue();
        vi.spyOn(facade, 'refreshRoomState').mockResolvedValue();
        targetWindow.__blackBoxRallarEmit = (event) => {
            events.push(event);
            if (event.topic === 'rallar.browser.connect_completed') {
                originalReceipt = facade.rtcCapture();
                if (closePage) {
                    closing = page.close();
                }
            }
        };
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'room-measurement-start',
                    commands: [
                        { kind: 'configure', config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', workspaceId: 'workspace' } } },
                        { kind: 'rtc.connect', roomId: 'room', readiness: { minReadyPeers: 1, timeoutMs: 100, intervalMs: 10 } }
                    ]
                }
            });
            expect(originalReceipt).toMatchObject({
                configuration: { mode: 'off', origin: 'run' },
                application: { status: 'applied', mode: 'off' }
            });
            expect(JSON.parse(JSON.stringify(events.find((event) => event.topic === 'rallar.browser.connect_completed')))).toMatchObject({
                connection: 'default',
                data: { roomId: 'room', rtcCapture: { status: 'observed', value: originalReceipt } }
            });
            const history = JSON.parse(JSON.stringify(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')));
            const readinessStarts = runtime.state().events.filter((event) => event.topic === 'rallar.bb.rtc.readiness_wait_started');
            expect(result.ok, JSON.stringify(result)).toBe(false);
            if (closePage) {
                expect(closing).toBeDefined();
                await closing;
                expect(history).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'operation-not-current',
                            requestedConfiguration: { mode: 'off', origin: 'run' },
                            rtcCapture: { status: 'observed', value: originalReceipt }
                        }
                    }
                });
                expect(readinessStarts).toEqual([]);
            }
            else {
                expect(readinessStarts).toEqual(expect.arrayContaining([expect.objectContaining({
                    payload: expect.objectContaining({ data: { minReadyPeers: 1, timeoutMs: 100, intervalMs: 10 } })
                })]));
                expect(history).toMatchObject({
                    status: 'failed',
                    value: {
                        roomId: 'room',
                        rtcCapture: { status: 'observed', value: originalReceipt },
                        readiness: { ready: false, readyPeerIds: [] }
                    },
                    error: { code: 'RALLAR_BB_RTC_READY_TIMEOUT' }
                });
                expect(history.value.readiness.roomRefreshSuccesses).toBeGreaterThan(0);
            }
        }
        finally {
            await page.close();
        }
    });

    it('preserves actual non-reentrant Off connect evidence through page JSON success', async () => {
        const { facade, page } = createCaptureApplicationRuntime();
        try {
            const connected = await createSpaBrowserRallarRuntime().connect({
                connection: 'default',
                rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureContext: { run: 'off' } }
            });
            expect(JSON.parse(JSON.stringify(connected))).toMatchObject({
                status: 'connected',
                rtcCapture: {
                    status: 'observed',
                    value: {
                        configuration: { mode: 'off', origin: 'run' },
                        application: { status: 'applied', mode: 'off' }
                    }
                }
            });
            expect(connected).toMatchObject({ rtcCapture: { status: 'observed', value: facade.rtcCapture() } });
        }
        finally {
            await page.close();
        }
    });

    it('carries a recipe run override to an already connected WS acquisition', async () => {
        const { page, runtime, events } = createCaptureApplicationRuntime();
        try {
            const connected = await page.connect({
                connection: 'default',
                rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'native' }
            });
            expect(connected).toMatchObject({
                status: 'connected',
                rtcCapture: {
                    status: 'observed',
                    value: {
                        configuration: { mode: 'native', origin: 'step' },
                        application: { status: 'applied', mode: 'native' },
                        connectionId: { status: 'observed' }
                    }
                }
            });
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'ws-existing',
                    commands: [
                        { kind: 'configure', config: { control: { providerMode: 'browser-rallar' }, rallar: { applicationId: 'app' } } },
                        { kind: 'ws.send', data: { typeId: 'test', topicId: 'app.capture', payload: {} } }
                    ]
                }
            });
            expect(result.ok, JSON.stringify(result)).toBe(false);
            expect(result).toMatchObject({
                value: {
                    results: expect.arrayContaining([expect.objectContaining({
                        kind: 'ws.send',
                        status: 'failed',
                        ok: false,
                        error: expect.objectContaining({ code: 'RALLAR_BLACK_BOX_COMMAND_FAILED' })
                    })])
                }
            });
            expect(events.filter((event) => event.topic === 'rallar.browser.ws.send_failed')).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    connection: 'default',
                    data: expect.objectContaining({ transport: 'ws', typeId: 'test', topicId: 'app.capture' }),
                    error: expect.objectContaining({
                        code: 'new-connection-required',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        currentConfiguration: { mode: 'native', origin: 'step' },
                        currentReceipt: connected.rtcCapture
                    })
                })
            ]));
        }
        finally {
            await page.close();
        }
    });

    it('refuses incompatible capture passed through the SPA WS operation before sending', async () => {
        const { page } = createCaptureApplicationRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'native' } });
            const bridge = createSpaBrowserRallarRuntime();
            const outcome = await bridge.sendWs?.({ typeId: 'test', topicId: 'app.capture', payload: {} }, { rtcCaptureContext: { run: 'off' } }).then(
                () => ({ sent: true }),
                (error: unknown) => ({ error: toError(error) })
            );
            expect(outcome).toMatchObject({ error: { code: 'new-connection-required', requestedConfiguration: { mode: 'off', origin: 'run' } } });
        }
        finally {
            await page.close();
        }
    });

    it('snapshots separate SPA WS intent before its runtime lookup yields', async () => {
        const { page } = createCaptureApplicationRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'off' } });
            const context: { run: 'off' | 'native'; } = { run: 'off' };
            const sending = createSpaBrowserRallarRuntime().sendWs?.({ typeId: 'test', topicId: 'app.capture', payload: {} }, { rtcCaptureContext: context });
            context.run = 'native';
            expect(await sending).toMatchObject({ rtcCapture: { status: 'observed', value: { configuration: { mode: 'off', origin: 'step' } } } });
        }
        finally {
            await page.close();
        }
    });

    it('returns the acquired Off receipt through the existing page WS result and JSON boundary', async () => {
        const { page, facade } = createCaptureApplicationRuntime();
        try {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'off' } });
            const result = await page.sendWs({ typeId: 'test', topicId: 'app.capture', payload: { rtcCapture: { status: 'observed', value: 'lookalike' } } });
            expect(JSON.parse(JSON.stringify(result))).toMatchObject({
                rtcCapture: { status: 'observed', value: facade.rtcCapture() },
                message: { rtcCapture: { status: 'observed', value: 'lookalike' } }
            });
        }
        finally {
            await page.close();
        }
    });

    it.each([
        { run: 'off', recipe: 'native', step: 'signaling', app: 'app', mode: 'off', origin: 'run', application: { status: 'applied', mode: 'off' } },
        { run: 'native', recipe: 'off', step: 'off', app: 'app', mode: 'native', origin: 'run', application: { status: 'applied', mode: 'native' } },
        { recipe: 'native', step: 'off', app: 'app', mode: 'off', origin: 'step', application: { status: 'applied', mode: 'off' } },
        { recipe: 'native', app: 'app', mode: 'native', origin: 'recipe', application: { status: 'applied', mode: 'native' } },
        { app: 'app', mode: 'signaling', origin: 'product-default', application: { status: 'applied', mode: 'signaling' } },
        { mode: 'off', origin: 'product-default', application: { status: 'applied', mode: 'off' } },
        { run: 'native', mode: 'native', origin: 'run', application: { status: 'unavailable', reason: 'sink-unavailable' } }
    ])('constructs $mode/$origin and exposes the actual public receipt', async (selection) => {
        const { facade, page, runtime } = createCaptureApplicationRuntime();
        let completion: BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion | undefined;
        let constructionConnected = false;
        const connect = facade.connect;
        vi.spyOn(facade, 'connect').mockImplementation(async (options) => {
            completion = await connect(options);
            constructionConnected = facade.isConnected();
            return completion;
        });
        const decoded = parseControlServerMessage(
            JSON.stringify({
                kind: 'command',
                protocolVersion: 1,
                runId: 'run',
                agentId: 'agent',
                commandId: 'wire',
                command: {
                    kind: 'recipe.run',
                    rtcCaptureMode: selection.run,
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'authored',
                        rtcCaptureMode: selection.recipe,
                        commands: [
                            {
                                kind: 'configure',
                                config: { rallar: { apiBaseUrl: 'https://test.invalid', applicationId: selection.app, rtcCaptureMode: selection.step } }
                            },
                            { kind: 'rtc.connect' }
                        ]
                    }
                }
            }),
            { runId: 'run', agentId: 'agent' }
        );
        expect(decoded.ok).toBe(true);
        if (!decoded.ok) {
            throw new Error(decoded.error);
        }
        try {
            const result = await runtime.execute(decoded.envelope.command);
            const originalReceipt = completion?.rtcCapture.status === 'observed' ? completion.rtcCapture.value : undefined;
            expect(constructionConnected).toBe(true);
            expect(originalReceipt).toMatchObject({
                configuration: { mode: selection.mode, origin: selection.origin },
                application: selection.application
            });
            if (selection.application.status === 'unavailable') {
                expect(result.ok, JSON.stringify(result)).toBe(false);
                expect(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')).toMatchObject({
                    status: 'failed',
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        details: {
                            reason: 'application-unavailable',
                            requestedConfiguration: { mode: selection.mode, origin: selection.origin },
                            rtcCapture: { status: 'observed', value: originalReceipt }
                        }
                    }
                });
                return;
            }
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(runtime.state().commandHistory.find((entry) => entry.kind === 'rtc.connect')?.value).toMatchObject({
                rtcCapture: {
                    status: 'observed',
                    value: { configuration: { mode: selection.mode, origin: selection.origin }, application: selection.application }
                }
            });
        }
        finally {
            await page.close();
        }
    });
    it('queues different source intent while construction is held and rejects it with the actual original receipt', async () => {
        const { page, facade } = createCaptureApplicationRuntime();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(connectionHttp.readIceCandidates).mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
        });
        const config = {
            connection: 'default',
            rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureContext: { run: 'off' as const } }
        };
        const first = page.connect(config);
        await entered.promise;
        const different = page.connect({ ...config, rallar: { ...config.rallar, rtcCaptureContext: { run: 'native' } } });
        let settled = false;
        const checked = different.then((value) => {
            settled = true;
            return { value };
        }, (error: unknown) => {
            settled = true;
            return { error: toError(error) };
        });
        expect(settled).toBe(false);
        release.resolve();
        try {
            const original = await first;
            expect(await checked).toMatchObject({
                error: {
                    code: 'new-connection-required',
                    requestedConfiguration: { mode: 'native', origin: 'run' },
                    currentReceipt: { status: 'observed', value: { configuration: { mode: 'off', origin: 'run' } } }
                }
            });
            expect(facade.session()?.sessionId).toBe('session');
            const reused = await page.connect({ ...config, rallar: { ...config.rallar, rtcCaptureContext: { recipe: 'off' } } });
            expect(reused.rtcCapture).toEqual(original.rtcCapture);
            expect(connectionHttp.readIceCandidates).toHaveBeenCalledTimes(1);
        }
        finally {
            await page.close();
        }
    });

    it('carries run Off through the WS fallback and retries exactly once', async () => {
        const { page, facade } = createCaptureApplicationRuntime();
        const send = vi.fn().mockRejectedValueOnce(new Error('Black-box Rallar runtime is not connected.')).mockResolvedValue({ status: 'sent' });
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({ rallarRuntime: { ...createSpaBrowserRallarRuntime(), sendWs: send } });
        try {
            const result = await runtime.execute({
                kind: 'recipe.run',
                rtcCaptureMode: 'off',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'ws',
                    commands: [
                        {
                            kind: 'configure',
                            config: { control: { providerMode: 'browser-rallar' }, apiBaseUrl: 'https://test.invalid', rallar: { applicationId: 'app' } }
                        },
                        { kind: 'ws.send', data: { typeId: 'hello', topicId: 'capture', payload: {} } }
                    ]
                }
            });
            expect(result.ok, JSON.stringify(result)).toBe(true);
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
            expect(send).toHaveBeenCalledTimes(2);
        }
        finally {
            await page.close();
        }
    });

    it.each(
        [
            {
                scenario: 'required Off refuses initial CRDT subscriptions after hydrate metric invalidates its original session',
                mode: 'off',
                invalidate: true
            },
            { scenario: 'applied Off preserves initial CRDT subscriptions through a non-reentrant hydrate metric', mode: 'off', invalidate: false },
            { scenario: 'applied Native preserves initial CRDT subscriptions through a non-reentrant hydrate metric', mode: 'native', invalidate: false },
            { scenario: 'omitted intent preserves initial CRDT subscriptions through a non-reentrant hydrate metric', mode: undefined, invalidate: false }
        ] as const
    )('fences initial live CRDT hydrate subscriptions: $scenario', async ({ mode, invalidate }) => {
        const { page, facade, events } = createCaptureApplicationRuntime();
        const session = auth.readSession();
        const subscriptions: HydratedCrdtSubscription[] = [];
        const unsubscribes: Array<() => void> = [];
        const metrics: RallarCrdtMetricEvent[] = [];
        let callbackConnected = false;
        let ownershipBeforeMetric: ReturnType<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion['captureOwnershipFailure']>;
        let ownershipAfterMetric: ReturnType<BlackBoxBrowserRallarRuntimeDependency.ConnectCompletion['captureOwnershipFailure']>;
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
            const capture = mode ? { rtcCaptureContext: { run: mode } } : {};
            const completion = await facade.connect(capture);
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: {
                    application: { status: 'applied', ...(mode ? { mode } : {}) },
                    ...(mode ? { configuration: { mode, origin: 'run' } } : {}),
                    connectionId: { status: 'observed' }
                }
            });
            expect(Object.isFrozen(completion.rtcCapture)).toBe(true);
            expect(completion.captureOwnershipFailure()).toBeUndefined();
            expect(facade.isConnected()).toBe(true);
            const subscribe = facade.messages.ws.onMessage;
            vi.spyOn(facade.messages.ws, 'onMessage').mockImplementation((selector, handler) => {
                const unsubscribe = subscribe(selector, handler);
                subscriptions.push({ selector, ownershipFailure: completion.captureOwnershipFailure() });
                unsubscribes.push(unsubscribe);
                return unsubscribe;
            });
            const open = facade.crdt.open;
            vi.spyOn(facade.crdt, 'open').mockImplementation(async (name, options) =>
                await open(name, {
                    ...options,
                    metrics: {
                        record: (event) => {
                            metrics.push(event);
                            if (event.name === 'crdt.merge.replay.ms') {
                                callbackConnected = facade.isConnected();
                                ownershipBeforeMetric = completion.captureOwnershipFailure();
                                if (invalidate) {
                                    vi.mocked(auth.readSession).mockReturnValue(undefined);
                                }
                                ownershipAfterMetric = completion.captureOwnershipFailure();
                            }
                        }
                    }
                })
            );
            const outcome = await page.crdt.open({
                name: `hydrate-session-${mode ?? 'omitted'}-${invalidate}`,
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'hydrated' },
                ...(mode ? { rallar: capture } : {})
            }).then((value) => ({ value }), (caught: unknown) => ({ error: toError(caught) }));
            expect(metrics).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'crdt.merge.replay.ms' })]));
            expect(callbackConnected).toBe(true);
            expect(ownershipBeforeMetric).toBeUndefined();
            expect(ownershipAfterMetric).toBe(invalidate ? 'session-not-current' : undefined);
            if (invalidate) {
                expect.soft(outcome).toMatchObject({
                    error: {
                        code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                        reason: 'session-not-current',
                        requestedConfiguration: { mode: 'off', origin: 'run' },
                        rtcCapture: completion.rtcCapture
                    }
                });
                // Required initial subscription eligibility forbids these actual document-protocol registrations.
                expect.soft(subscriptions.filter(({ selector }) =>
                    typeof selector !== 'string' && (
                        selector.typeId === 'rallar.crdt.update.v1' || selector.typeId === 'rallar.crdt.sync-request.v1' ||
                        selector.typeId === 'rallar.crdt.catch-up-response.v1'
                    )
                )).toEqual([]);
                expect.soft(events.filter((event) => event.topic === 'rallar.browser.crdt.opened')).toEqual([]);
            }
            else {
                expect(outcome).toMatchObject({ value: { status: 'opened', value: { title: 'hydrated' }, rtcCapture: completion.rtcCapture } });
                expect(subscriptions).toEqual(expect.arrayContaining([
                    expect.objectContaining({ selector: expect.objectContaining({ typeId: 'rallar.crdt.update.v1' }), ownershipFailure: undefined }),
                    expect.objectContaining({ selector: expect.objectContaining({ typeId: 'rallar.crdt.sync-request.v1' }), ownershipFailure: undefined })
                ]));
                await expect(page.crdt.read({ handle: `hydrate-session-${mode ?? 'omitted'}-${invalidate}` })).resolves.toMatchObject({
                    value: { title: 'hydrated' }
                });
            }
        }
        finally {
            vi.mocked(auth.readSession).mockReturnValue(session);
            for (const unsubscribe of unsubscribes) {
                unsubscribe();
            }
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('required Native refuses initial live CRDT effects when its actual SDK application is unavailable', async () => {
        const { page, facade, events } = createCaptureApplicationRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            const completion = await facade.connect({ rtcCaptureContext: { run: 'native' } });
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: {
                    configuration: { mode: 'native', origin: 'run' },
                    connectionId: { status: 'observed' },
                    application: { status: 'unavailable', reason: 'sink-unavailable' }
                }
            });
            expect(completion.captureOwnershipFailure()).toBeUndefined();
            expect(facade.isConnected()).toBe(true);
            const handles: RallarMessageHandle[] = [];
            const send = facade.messages.ws.send;
            vi.spyOn(facade.messages.ws, 'send').mockImplementation(async (input) => {
                const handle = await send(input);
                handles.push(handle);
                return handle;
            });
            const outcome = await page.crdt.open({
                name: 'unavailable-initial-live',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'initial' },
                rallar: { rtcCaptureContext: { run: 'native' } }
            }).then((value) => ({ value }), (caught: unknown) => ({ error: toError(caught) }));
            expect.soft(outcome).toMatchObject({
                error: {
                    code: 'RALLAR_RTC_CAPTURE_UNVERIFIED',
                    reason: 'application-unavailable',
                    requestedConfiguration: { mode: 'native', origin: 'run' },
                    rtcCapture: completion.rtcCapture
                }
            });
            expect.soft(handles.map((handle) => ({ rtcCapture: handle.rtcCapture(), lifecycle: handle.lifecycle() }))).toEqual([]);
            expect.soft(events.filter((event) => event.topic === 'rallar.browser.crdt.opened')).toEqual([]);
            expect(facade.isConnected()).toBe(true);
            expect(completion.captureOwnershipFailure()).toBeUndefined();
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it.each(['off', 'native'] as const)('preserves applied %s initial live CRDT effects and original receipt', async (mode) => {
        const { page, facade } = createCaptureApplicationRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app', diagnosticsPorts: { signalingDiagnostics: () => {} } });
            const completion = await facade.connect({ rtcCaptureContext: { run: mode } });
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: { configuration: { mode, origin: 'run' }, application: { status: 'applied', mode } }
            });
            expect(completion.captureOwnershipFailure()).toBeUndefined();
            const handles: RallarMessageHandle[] = [];
            const send = facade.messages.ws.send;
            vi.spyOn(facade.messages.ws, 'send').mockImplementation(async (input) => {
                const handle = await send(input);
                handles.push(handle);
                return handle;
            });
            const opened = await page.crdt.open({
                name: `applied-initial-live-${mode}`,
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'initial' },
                rallar: { rtcCaptureContext: { run: mode } }
            });
            expect(opened).toMatchObject({ status: 'opened', value: { title: 'initial' }, rtcCapture: completion.rtcCapture });
            expect(handles.map((handle) => handle.lifecycle())).toEqual(expect.arrayContaining([
                expect.objectContaining({ typeId: 'rallar.crdt.catch-up-request.v1', evidence: expect.objectContaining({ admittedAtMs: expect.any(Number) }) }),
                expect.objectContaining({ typeId: 'rallar.crdt.sync-request.v1', evidence: expect.objectContaining({ admittedAtMs: expect.any(Number) }) })
            ]));
            for (const handle of handles) {
                expect(handle.rtcCapture()).toEqual(completion.rtcCapture);
                expect(handle.lifecycle()).toMatchObject({ evidence: { admittedAtMs: expect.any(Number) } });
            }
            expect(JSON.parse(JSON.stringify(opened))).toMatchObject({ rtcCapture: completion.rtcCapture });
            const reused = await facade.crdt.open(`applied-initial-live-${mode}`, { applicationId: 'app', workspaceId: 'main' });
            expect(reused.read()).toEqual({ title: 'initial' });
            await expect(page.crdt.read({ handle: `applied-initial-live-${mode}` })).resolves.toMatchObject({ value: { title: 'initial' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('omitted CRDT capture intent preserves live effects with an actual unavailable Native application', async () => {
        const { page, facade } = createCaptureApplicationRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' } });
            const completion = await facade.connect();
            expect(completion.rtcCapture).toMatchObject({
                status: 'observed',
                value: { application: { status: 'unavailable', reason: 'sink-unavailable' } }
            });
            const opened = await page.crdt.open({
                name: 'ordinary-unavailable-initial-live',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'ws',
                persist: false,
                tabSync: false,
                initialValue: { title: 'ordinary' }
            });
            expect(opened).toMatchObject({
                status: 'opened',
                value: { title: 'ordinary' },
                rtcCapture: completion.rtcCapture,
                health: { lastLiveSendStatus: 'sent' }
            });
            await expect(page.crdt.read({ handle: 'ordinary-unavailable-initial-live' })).resolves.toMatchObject({ value: { title: 'ordinary' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('local CRDT capture intent preserves persisted authored state without constructing a live graph', async () => {
        const { page, facade } = createCaptureApplicationRuntime();
        try {
            const opened = await page.crdt.open({
                name: 'local-capture-control',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'local-only',
                persist: true,
                tabSync: false,
                initialValue: { title: 'local' },
                rallar: { rtcCaptureContext: { run: 'native' } }
            });
            expect(opened).toMatchObject({
                status: 'opened',
                value: { title: 'local' },
                rtcCapture: { status: 'unavailable', reason: 'not-applicable' }
            });
            expect(facade.isConnected()).toBe(false);
            await page.crdt.apply({
                handle: 'local-capture-control',
                batch: { kind: 'batch', operations: [{ kind: 'map.set', path: [], key: 'title', value: 'persisted' }] }
            });
            await page.crdt.close({ handle: 'local-capture-control' });
            const reopened = await page.crdt.open({
                name: 'local-capture-control',
                applicationId: 'app',
                workspaceId: 'main',
                transport: 'local-only',
                persist: true,
                tabSync: false
            });
            expect(reopened).toMatchObject({ value: { title: 'persisted' } });
            await expect(page.crdt.read({ handle: 'local-capture-control' })).resolves.toMatchObject({ value: { title: 'persisted' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it('ordinary HTTP CRDT catch-up preserves durable readback without a live message effect', async () => {
        const { page, facade } = createCaptureApplicationRuntime();
        try {
            facade.configure({ apiBaseUrl: 'https://test.invalid' });
            facade.setDefaults({ applicationId: 'app' });
            await facade.connect();
            vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
                expect(url).toBe('https://test.invalid/api/crdt/catch-up');
                expect(init.method).toBe('POST');
                const request: unknown = JSON.parse(String(init.body));
                if (
                    typeof request !== 'object' || request === null ||
                    !('requestId' in request) || typeof request.requestId !== 'string' ||
                    !('document' in request) || !isRallarCrdtDocumentRef(request.document)
                ) {
                    throw new TypeError('Expected a complete HTTP catch-up request.');
                }
                return Response.json({ ok: true, result: createHttpCatchUpResponse({ requestId: request.requestId, document: request.document }) });
            });
            const opened = await page.crdt.open({
                name: 'http-capture-control',
                applicationId: 'app',
                workspaceId: 'main',
                scope: { kind: 'custom', customScope: 'http-only' },
                transport: 'ws',
                durableCatchUp: 'http',
                persist: false,
                tabSync: false
            });
            expect(opened).toMatchObject({
                status: 'opened',
                value: { title: 'HTTP durable title' },
                health: { lastServerAppendSequence: 1, liveSentUpdateCount: 0 }
            });
            await expect(page.crdt.read({ handle: 'http-capture-control' })).resolves.toMatchObject({ value: { title: 'HTTP durable title' } });
        }
        finally {
            await page.close();
            expect(facade.isConnected()).toBe(false);
        }
    });

    it.each(['fresh', 'existing', 'no-api', 'local-only'] as const)('carries capture into the %s CRDT path', async (path) => {
        const { page, facade, runtime } = createCaptureApplicationRuntime();
        if (path === 'existing' || path === 'no-api') {
            await page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureMode: 'off' } });
        }
        try {
            const command = {
                kind: 'crdt.open' as const,
                name: 'capture',
                applicationId: 'app',
                apiBaseUrl: path === 'no-api' ? undefined : 'https://test.invalid',
                transport: path === 'local-only' ? 'local-only' as const : 'ws' as const,
                persist: false,
                tabSync: false
            };
            if (path === 'existing' || path === 'no-api') {
                await expect(page.crdt.open({ ...command, rallar: { rtcCaptureContext: { run: 'native' } } })).rejects.toMatchObject({
                    code: 'new-connection-required',
                    requestedConfiguration: { mode: 'native', origin: 'run' }
                });
                expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'step' });
            }
            else {
                const result = await runtime.execute({
                    kind: 'recipe.run',
                    rtcCaptureMode: 'native',
                    recipe: { schemaVersion: 1, recipeId: 'crdt', commands: [command] }
                });
                expect(result.ok, JSON.stringify(result)).toBe(true);
                expect(runtime.state().commandHistory.find((entry) => entry.kind === 'crdt.open')?.value).toMatchObject({
                    rtcCapture: path === 'fresh'
                        ? { status: 'observed', value: { configuration: { mode: 'native', origin: 'run' } } }
                        : { status: 'unavailable', reason: 'not-applicable' }
                });
                expect(facade.rtcCapture()?.configuration).toEqual(path === 'fresh' ? { mode: 'native', origin: 'run' } : undefined);
                expect(connectionHttp.readIceCandidates).toHaveBeenCalledTimes(path === 'fresh' ? 1 : 0);
            }
        }
        finally {
            await page.close();
        }
    });

    it('preserves host selection and actual pending receipt across compatible direct SDK acquisition', async () => {
        const { facade, page } = createCaptureApplicationRuntime();
        facade.setDefaults({ applicationId: 'app', rtc: { captureMode: 'native' }, diagnosticsPorts: { signalingDiagnostics: () => {} } });
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        vi.mocked(connectionHttp.readIceCandidates).mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            return { iceServers: [], expiresAtEpochMs: Date.now() + 60_000 };
        });
        const first = facade.connect();
        await entered.promise;
        expect(facade.rtcCapture()).toBeUndefined();
        const compatible = facade.connect({ rtcCaptureContext: { run: 'native' } });
        await expect(facade.connect({ rtcCaptureContext: { run: 'off' } })).rejects.toMatchObject({
            code: 'new-connection-required',
            currentReceipt: { status: 'unavailable', reason: 'absent' },
            requestedConfiguration: { mode: 'off', origin: 'run' }
        });
        release.resolve();
        try {
            await Promise.all([first, compatible]);
            const original = facade.rtcCapture();
            expect(original?.configuration).toEqual({ mode: 'native', origin: 'host' });
            expect(JSON.parse(JSON.stringify(original))).toEqual(original);
            expect(connectionHttp.readIceCandidates).toHaveBeenCalledTimes(1);
            await facade.disconnect();
            await facade.connect({ rtcCaptureContext: { run: 'off' } });
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
            expect(facade.rtcCapture()?.connectionId).not.toEqual(original?.connectionId);
        }
        finally {
            await page.close();
        }
    });

    it('captures direct adapter intent before asynchronous authentication and construction', async () => {
        const { facade, page } = createCaptureApplicationRuntime();
        const run: { run: 'off' | 'native'; } = { run: 'off' };
        const pending = page.connect({ connection: 'default', rallar: { apiBaseUrl: 'https://test.invalid', applicationId: 'app', rtcCaptureContext: run } });
        run.run = 'native';
        try {
            await pending;
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        }
        finally {
            await page.close();
        }
    });
    it('captures supported page CRDT context before live connection awaits', async () => {
        const { facade, page } = createCaptureApplicationRuntime();
        const context: { run: 'off' | 'native'; } = { run: 'off' };
        const pending = page.crdt.open({
            name: 'immutable-page-context',
            applicationId: 'app',
            apiBaseUrl: 'https://test.invalid',
            transport: 'ws',
            persist: false,
            tabSync: false,
            rallar: { rtcCaptureContext: context }
        });
        context.run = 'native';
        try {
            expect(await pending).toMatchObject({
                rtcCapture: { status: 'observed', value: { configuration: { mode: 'off', origin: 'run' } } }
            });
            expect(facade.rtcCapture()?.configuration).toEqual({ mode: 'off', origin: 'run' });
        }
        finally {
            await page.close();
        }
    });
});
