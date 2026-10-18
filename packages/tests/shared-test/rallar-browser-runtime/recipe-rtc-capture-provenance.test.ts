import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { toRallarBlackBoxCompositeResultFlatEntries } from '@shared-test/rallar-bb-test/composite-results.ts';
import { parseControlClientMessage } from '@shared-test/rallar-bb-test/control-protocol.ts';
import { decodeControlRunSnapshot } from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { computeDistributedRunSnapshotPerformance } from '@shared-test/rallar-bb-test/distributed-run-performance/compute-distributed-run-snapshot-performance.ts';
import { toControlAgentCapabilities } from '@shared-test/rallar-bb-test/distributed/control-agent-capabilities.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { decodeJsonValue, decodeRecord } from '@shared-test/rallar-bb-test/runtime/decode-runtime-result-values.ts';
import { resolveRequiredRtcCaptureFailure } from '@shared-web/browser/connection/browser-rtc-capture-intent.ts';
import { toRtcCaptureReadout } from '@shared-web/browser/connection/to-rtc-capture-readout.ts';

import { createControlRunArtifactBundle } from '../../../../apps/rallar-black-box-control-server/src/control-artifacts.ts';
import { createDistributedRunArtifactBundle } from '../../../../apps/rallar-black-box-control-server/test/support/create-distributed-run-artifact-bundle.ts';
import { takeAgentDispatchableCommands } from '../../../../apps/rallar-black-box-control-server/test/support/take-agent-dispatchable-commands.ts';
import {
    createCaptureApplicationRuntime,
    createCaptureController,
    executeSerializedControllerCommand,
    installCaptureApplicationTestEnvironment
} from './capture-application-test-runtime.ts';

installCaptureApplicationTestEnvironment();

describe('actual SDK capture receipt provenance', () => {
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
                const [dispatch] = takeAgentDispatchableCommands(service, 'sdk-receipt-run', 'sdk-agent');
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
                const [stage] = takeAgentDispatchableCommands(service, 'sdk-path-run', 'sdk-agent');
                expect(stage?.command.kind).toBe('recipe.load');
                const { envelope: stageEnvelope } = await executeSerializedControllerCommand(runtime, stage);
                expect(service.receiveClientEnvelope(stageEnvelope).accepted).toBe(true);
                expect(service.startDistributedRun('sdk-distributed').left).toBeUndefined();
                const [start] = takeAgentDispatchableCommands(service, 'sdk-path-run', 'sdk-agent');
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
                const bundle = createDistributedRunArtifactBundle(service, 'sdk-distributed', {});
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
                    const source = await readFile(new URL('./recipe-rtc-capture-provenance.test.ts', import.meta.url));
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
});
