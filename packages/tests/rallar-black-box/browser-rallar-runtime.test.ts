import { describe, expect, it, vi } from 'vitest';

import type {
    BlackBoxRallarDeliveryObservation,
    BlackBoxRallarMessageSendDiagnostics
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-operation-contracts.ts';
import type { BlackBoxRallarRuntime } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';
import {
    createBlackBoxRallarRuntime,
    type BlackBoxRallarRuntimeInstallationTarget
} from '@shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime.ts';
import { readBlackBoxRtcCausalState } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/read-black-box-rtc-causal-state.ts';

import {
    createSpaBrowserRallarRuntime,
    installSpaBrowserRallarEventBridge
} from '../../../apps/rallar-black-box/src/browser-rallar-runtime.ts';
import {
    createRallarBlackBoxBrowserTestRuntime,
    type RallarBlackBoxBrowserRoomRefreshOptions
} from '../../../packages/shared-test/rallar-bb-test/browser-adapter.ts';
import { selectRallarBlackBoxDiagnostics } from '../../../packages/shared-test/rallar-bb-test/selectors.ts';
import { ApiHttpError } from '../../../packages/shared-web/browser/api/http-error.ts';
import type { RallarMessageSendResult } from '../../../packages/shared-web/browser/messages/rallar-message-contracts.ts';
import {
    newALRoute,
    newALUntargetedMessage
} from '../../../packages/shared/al-contracts/al-contract.ts';
import type { ALOutboundEnqueueStatus } from '../../../packages/shared/alm/outbound/al-outbound-message-runtime.ts';
import { RallarValidationError } from '../../../packages/shared/api/rallar-validation.ts';

import { createBrowserRallarRequiredMethodsTestDouble } from '../shared-test/browser-rallar-required-methods-test-double.ts';
import {
    events,
    facade,
    resetFacade,
    topics
} from '../shared-test/rallar-browser-runtime/browser-rallar-runtime-test-harness.ts';

interface BrowserRuntimeTiming {
    readonly now: () => number;
    readonly delay: (milliseconds: number) => Promise<void>;
}

async function withBrowserRuntime(
    run: (nativeRuntime: BlackBoxRallarRuntime) => Promise<void>
): Promise<void> {
    await withBrowserRuntimeTiming(
        { now: Date.now, delay: async () => undefined },
        run
    );
}

async function withBrowserRuntimeTiming(
    timing: BrowserRuntimeTiming,
    run: (nativeRuntime: BlackBoxRallarRuntime) => Promise<void>
): Promise<void> {
    resetFacade();
    const targetWindow: BlackBoxRallarRuntimeInstallationTarget = {
        __blackBoxRallarEmit: (event) => {
            events.push(event);
        }
    };
    const nativeRuntime = createBlackBoxRallarRuntime({
        facade: facade.rallar,
        targetWindow,
        clock: { now: timing.now },
        delay: timing.delay
    });
    targetWindow.__blackBoxRallar = nativeRuntime;
    vi.stubGlobal('window', targetWindow);
    try {
        await run(nativeRuntime);
    }
    finally {
        try {
            await nativeRuntime.close();
        }
        finally {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
        }
    }
}

function almConnectionConfig(): Parameters<BlackBoxRallarRuntime['connect']>[0] {
    return {
        connection: 'aliceAlm',
        actor: 'alice',
        roomId: 'room-1',
        rallar: {
            apiBaseUrl: 'https://api.example.test',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            username: 'alice',
            password: 'secret'
        }
    };
}

const almRoomRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};

function almSendResult(
    status: ALOutboundEnqueueStatus,
    msgId: string
): RallarMessageSendResult {
    return {
        transport: 'ws',
        status,
        message: {
            id: { v: 2, msgId, ts: 0, senderId: 'client-1' },
            route: {
                topicId: 'alm.conformance',
                contextId: 'room-1',
                resourceId: 'room-1'
            },
            payload: {
                typeId: 'alm.conformance',
                contentType: 'application/json',
                resource: '{}'
            }
        },
        entries: []
    };
}

async function sendAlmMessage(
    nativeRuntime: BlackBoxRallarRuntime,
    handleId: string
): Promise<BlackBoxRallarMessageSendDiagnostics> {
    return await nativeRuntime.sendMessage({
        connection: 'aliceAlm',
        carrier: 'ws',
        typeId: 'alm.conformance',
        payload: { n: 1 },
        handleId
    });
}

const OVERSIZED_PAYLOAD_MESSAGE = '$.payload: Payload exceeds 65536 bytes.';

function oversizedPayloadError(): RallarValidationError {
    return new RallarValidationError(OVERSIZED_PAYLOAD_MESSAGE, [
        {
            path: '$.payload',
            code: 'payload-too-large',
            message: 'Payload exceeds 65536 bytes.'
        }
    ]);
}

const almDeliveryStateCases: ReadonlyArray<
    readonly [
        ALOutboundEnqueueStatus,
        BlackBoxRallarDeliveryObservation['state'],
        boolean
    ]
> = [
    ['enqueued', 'accepted', true],
    ['accepted', 'accepted', true],
    ['skipped', 'accepted', false],
    ['duplicate', 'accepted', false],
    ['pending-admission', 'queued', false],
    ['superseded', 'superseded', false],
    ['expired', 'expired', false],
    ['rate-limited', 'rejected', false],
    ['no-route', 'failed', false],
    ['circuit-open', 'failed', false],
    ['failed', 'failed', false]
];

describe('rallar-black-box browser-rallar ALM operations', () => {
    it('sends a typed message over the requested carrier and records a delivery observation', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            facade.behavior.typedSend.mockResolvedValue({
                transport: 'ws',
                status: 'enqueued',
                message: {
                    id: { v: 2, msgId: 'msg-1', ts: 0, senderId: 'client-1' },
                    route: {
                        topicId: 'alm.conformance',
                        contextId: 'room-1',
                        resourceId: 'room-1'
                    },
                    payload: {
                        typeId: 'alm.conformance',
                        contentType: 'application/json',
                        resource: '{}'
                    }
                },
                entries: []
            });
            await nativeRuntime.connect(almConnectionConfig());

            const sent = await nativeRuntime.sendMessage({
                connection: 'aliceAlm',
                carrier: 'ws',
                typeId: 'alm.conformance',
                payload: { n: 1 },
                handleId: 'h-1'
            });

            expect(sent).toMatchObject({
                handleId: 'h-1',
                msgId: 'msg-1',
                carrier: 'ws',
                status: 'enqueued'
            });
            expect(facade.records.typedChannelOpens).toEqual([
                {
                    typeId: 'alm.conformance',
                    topicId: undefined,
                    roomId: 'room-1',
                    roomRef: almRoomRef
                }
            ]);
            expect(facade.records.typedSends).toEqual([
                [{ n: 1 }, { strategy: 'ws' }]
            ]);

            const observed = await nativeRuntime.observeDelivery({
                connection: 'aliceAlm',
                handleId: 'h-1',
                state: ['accepted'],
                timeoutMs: 1_000
            });

            expect(observed).toMatchObject({
                handleId: 'h-1',
                state: 'accepted',
                submitted: true,
                attempts: 1
            });
            await expect(
                nativeRuntime.cancelDelivery({
                    connection: 'aliceAlm',
                    handleId: 'h-1'
                })
            ).resolves.toMatchObject({ handleId: 'h-1', state: 'cancelled' });
            await expect(
                nativeRuntime.readReceipts({ connection: 'aliceAlm', handleId: 'h-1' })
            ).resolves.toMatchObject({
                confirmedPeerIds: [],
                unconfirmedPeerIds: []
            });
        });
    });

    it('injects a scripted transport fault and reports the IndexedDB storage counters', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            await nativeRuntime.connect(almConnectionConfig());
            const { faults, storage, outboundDiagnostics, inboundDiagnostics, storageReset } = facade.rallar.diagnostics;

            await nativeRuntime.injectFault({
                faultId: 'drop-once',
                carrier: 'ws',
                match: { typeId: 'alm.conformance' },
                action: 'drop',
                remaining: 1
            });

            expect(facade.records.defaultWrites.at(-1)?.diagnosticsPorts).toEqual({
                transportFaultPort: faults,
                indexedDbOperationObserver: storage,
                outboundDiagnostics: outboundDiagnostics.sink,
                inboundDiagnostics: inboundDiagnostics.sink,
                onStorageReset: storageReset.sink
            });
            expect(
                faults.decideSend(
                    'ws',
                    JSON.stringify(
                        newALUntargetedMessage(
                            'alice',
                            newALRoute('room.alm-conformance', 'room-1', 'resource-1'),
                            'alm.conformance',
                            { marker: 'drop-me' }
                        )
                    )
                )
            ).toEqual({ kind: 'drop', faultId: 'drop-once' });
            expect(faults.getObservations()).toEqual([
                { faultId: 'drop-once', carrier: 'ws', decision: 'drop' }
            ]);

            storage.observe({ owner: 'al-admission', kind: 'write' });
            await expect(
                nativeRuntime.readStorageCounters({ reset: false })
            ).resolves.toEqual({
                total: 1,
                byOwner: { 'al-admission': 1, 'al-work': 0 },
                byKind: { write: 1 }
            });
        });
    });

    it('refuses the scripted-port commands when the connection names no application', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            const config = almConnectionConfig();
            await nativeRuntime.connect({
                ...config,
                rallar: { ...config.rallar, applicationId: undefined }
            });

            await expect(
                nativeRuntime.injectFault({
                    faultId: 'drop-once',
                    carrier: 'ws',
                    match: { typeId: 'alm.conformance' },
                    action: 'drop',
                    remaining: 1
                })
            ).rejects.toThrow(
                new TypeError(
                    'Scripted transport and storage ports are not installed: ' +
                        'fault.inject needs a connection that names an application.'
                )
            );
            await expect(
                nativeRuntime.readStorageCounters({ reset: false })
            ).rejects.toThrow(
                new TypeError(
                    'Scripted transport and storage ports are not installed: ' +
                        'storage.counters needs a connection that names an application.'
                )
            );
        });
    });

    it.each(almDeliveryStateCases)(
        'maps the %s admission status to a %s observation',
        async (status, state, submitted) => {
            await withBrowserRuntime(async (nativeRuntime) => {
                facade.behavior.typedSend.mockResolvedValue(
                    almSendResult(status, `msg-${status}`)
                );
                await nativeRuntime.connect(almConnectionConfig());

                await sendAlmMessage(nativeRuntime, `h-${status}`);

                await expect(
                    nativeRuntime.readReceipts({
                        connection: 'aliceAlm',
                        handleId: `h-${status}`
                    })
                ).resolves.toEqual({
                    handleId: `h-${status}`,
                    state,
                    submitted,
                    confirmedPeerIds: [],
                    unconfirmedPeerIds: [],
                    attempts: 1
                });
            });
        }
    );

    it('observes a pending delivery after durable message admission completes', async () => {
        let clockEpochMs = 0;
        const timing = {
            now: () => clockEpochMs,
            delay: async (milliseconds: number) => {
                clockEpochMs += milliseconds;
            }
        };
        await withBrowserRuntimeTiming(timing, async (nativeRuntime) => {
            facade.behavior.typedSend.mockResolvedValue(
                almSendResult('pending-admission', 'msg-pending')
            );
            facade.behavior.messageAdmission
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true);
            await nativeRuntime.connect(almConnectionConfig());
            await sendAlmMessage(nativeRuntime, 'h-pending');

            await expect(
                nativeRuntime.observeDelivery({
                    connection: 'aliceAlm',
                    handleId: 'h-pending',
                    state: ['accepted'],
                    timeoutMs: 1_000
                })
            ).resolves.toMatchObject({
                handleId: 'h-pending',
                state: 'accepted',
                submitted: true
            });
        });
    });

    it('times out observing a delivery state the handle never reaches', async () => {
        let clockEpochMs = 0;
        const timing = {
            now: () => clockEpochMs,
            delay: async (milliseconds: number) => {
                clockEpochMs += milliseconds;
            }
        };

        await withBrowserRuntimeTiming(timing, async (nativeRuntime) => {
            facade.behavior.typedSend.mockResolvedValue(
                almSendResult('enqueued', 'msg-1')
            );
            await nativeRuntime.connect(almConnectionConfig());
            await sendAlmMessage(nativeRuntime, 'h-1');

            await expect(
                nativeRuntime.observeDelivery({
                    connection: 'aliceAlm',
                    handleId: 'h-1',
                    state: ['acknowledged'],
                    timeoutMs: 100
                })
            ).rejects.toThrow(
                new TypeError(
                    'Delivery handle h-1 did not reach [acknowledged]; last state accepted'
                )
            );
            expect(clockEpochMs).toBeGreaterThanOrEqual(100);
        });
    });

    it('emits the send_started and send_completed diagnostics topics', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            facade.behavior.typedSend.mockResolvedValue(
                almSendResult('enqueued', 'msg-1')
            );
            await nativeRuntime.connect(almConnectionConfig());

            await sendAlmMessage(nativeRuntime, 'h-1');

            expect(topics()).toEqual(
                expect.arrayContaining([
                    'rallar.browser.messages.send_started',
                    'rallar.browser.messages.send_completed'
                ])
            );
        });
    });

    it('rejects a delivery read for a handle no send registered', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            await nativeRuntime.connect(almConnectionConfig());

            await expect(
                nativeRuntime.readReceipts({
                    connection: 'aliceAlm',
                    handleId: 'missing-1'
                })
            ).rejects.toThrow('Unknown delivery handle missing-1');
        });
    });

    it('reports a facade-rejected oversized send as a rejected value', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            facade.behavior.typedSend.mockRejectedValue(oversizedPayloadError());
            await nativeRuntime.connect(almConnectionConfig());

            await expect(
                sendAlmMessage(nativeRuntime, 'h-oversized')
            ).resolves.toEqual({
                handleId: 'h-oversized',
                msgId: undefined,
                carrier: 'ws',
                status: 'rejected',
                reason: OVERSIZED_PAYLOAD_MESSAGE,
                message: undefined
            });

            await expect(
                nativeRuntime.readReceipts({
                    connection: 'aliceAlm',
                    handleId: 'h-oversized'
                })
            ).resolves.toEqual({
                handleId: 'h-oversized',
                state: 'rejected',
                submitted: false,
                confirmedPeerIds: [],
                unconfirmedPeerIds: [],
                attempts: 1
            });
        });
    });

    it('emits the rejected send on the send_completed diagnostic', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            facade.behavior.typedSend.mockRejectedValue(oversizedPayloadError());
            await nativeRuntime.connect(almConnectionConfig());

            await sendAlmMessage(nativeRuntime, 'h-oversized');

            expect(
                events.find(
                    (event) => event.topic === 'rallar.browser.messages.send_completed'
                )?.data
            ).toEqual({
                handleId: 'h-oversized',
                msgId: undefined,
                carrier: 'ws',
                status: 'rejected',
                reason: OVERSIZED_PAYLOAD_MESSAGE,
                message: undefined
            });
        });
    });

    it('propagates a send failure that is not a facade validation rejection', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            facade.behavior.typedSend.mockRejectedValue(new Error('ws lane closed'));
            await nativeRuntime.connect(almConnectionConfig());

            await expect(
                sendAlmMessage(nativeRuntime, 'h-lane-closed')
            ).rejects.toThrow('ws lane closed');
            await expect(
                nativeRuntime.readReceipts({
                    connection: 'aliceAlm',
                    handleId: 'h-lane-closed'
                })
            ).rejects.toThrow('Unknown delivery handle h-lane-closed');
        });
    });
});

describe('rallar-black-box SPA browser-rallar runtime', () => {
    it('returns browser runtime results through the SPA bridge', async () => {
        await withBrowserRuntime(async () => {
            facade.behavior.realtimeSend.mockResolvedValue([
                {
                    peerId: 'bob-session',
                    laneId: 'realtime',
                    result: { status: 'sent', bufferedAmount: 0 }
                }
            ]);
            facade.behavior.rtcWaitForRoom.mockResolvedValue({
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                ws: facade.rallar.ws.status(),
                rtc: {
                    desired: true,
                    mode: 'lazy',
                    state: 'open',
                    acceptedLayoutIdentity: {
                        groupRevision: 2,
                        presenceRevision: 2,
                        version: 1,
                        state: 'active'
                    },
                    desiredPeerIds: ['bob-session'],
                    knownPeerIds: ['bob-session'],
                    activePeerIds: ['bob-session'],
                    readyPeerIds: ['bob-session'],
                    failedPeerIds: [],
                    peers: [],
                    laneId: 'realtime'
                }
            });
            const runtime = createSpaBrowserRallarRuntime();
            await expect(
                runtime.connect({
                    connection: 'aliceRtc',
                    roomId: 'room-1',
                    rallar: {
                        apiBaseUrl: 'https://api.example.test',
                        applicationId: 'app-1',
                        workspaceId: 'workspace-1',
                        username: 'alice',
                        password: 'secret'
                    }
                })
            ).resolves.toMatchObject({
                status: 'connected',
                connection: 'aliceRtc',
                sessionId: facade.session.sessionId
            });
            await expect(
                runtime.send({ peerIds: ['bob-session'], data: { text: 'hello' } })
            ).resolves.toMatchObject({ status: 'sent', peerIds: ['bob-session'] });
            await expect(
                runtime.sendWs?.({
                    typeId: 'room.manual.message',
                    payload: { text: 'hello ws' }
                })
            ).resolves.toMatchObject({
                status: 'sent',
                transport: 'ws',
                typeId: 'room.manual.message'
            });
            await expect(
                runtime.refreshRoom({ timeoutMs: 100 })
            ).resolves.toBeUndefined();
            expect(facade.records.roomStateRefreshes).toContainEqual([
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                {
                    timeoutMs: 100,
                    scope: { applicationId: 'app-1', workspaceId: 'workspace-1' }
                }
            ]);
            await expect(
                runtime.waitForRoom({
                    connect: true,
                    minReadyPeers: 1,
                    timeoutMs: 100
                })
            ).resolves.toMatchObject({
                rtc: { state: 'open', readyPeerIds: ['bob-session'] }
            });
            expect(facade.records.rtcRoomWaits).toContainEqual([
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                {
                    connect: true,
                    laneId: 'realtime',
                    minReadyPeers: 1,
                    signal: undefined,
                    timeoutMs: 100
                }
            ]);
            facade.behavior.rtcCausalState.mockImplementation(() => {
                throw new Error('Ordinary health must not read current RTC causal state.');
            });
            await expect(runtime.health()).resolves.not.toHaveProperty('rtcCausalState');
            facade.behavior.rtcCausalState.mockImplementation(() =>
                readBlackBoxRtcCausalState({
                    readMiddleware: () => ({
                        session: facade.session,
                        middleware: {
                            webRtcGroupManager: {
                                state: () => ({
                                    groupIds: ['room-1'],
                                    desiredPeerIds: ['peer-2', 'peer-1', 'peer-1'],
                                    onlinePeerIds: ['peer-3', 'peer-1', 'peer-3'],
                                    onlineDesiredPeerIds: ['peer-1'],
                                    connectablePeerIds: ['peer-2', 'peer-1'],
                                    peerIdsWithNoReconnectableLanes: [],
                                    peerOwners: new Map()
                                }),
                                readDiagnostics: () => ({
                                    reconcileRunCount: 3,
                                    reconcileAwaitedInFlightCount: 0,
                                    reconcileCoalescedRerunCount: 1,
                                    lastDesiredPeerCount: 2,
                                    connectAttemptCount: 4,
                                    connectFailureCount: 0,
                                    connectDeferredBudgetCount: 0,
                                    connectDeferredPacingCount: 0,
                                    disconnectCount: 0,
                                    retainedCreatedCount: 0,
                                    retainedExpiredCount: 0,
                                    retainedEvictionCount: 0
                                })
                            },
                            webRtcConnectionService: {
                                knownPeerIds: () => ['peer-3', 'peer-2', 'peer-3'],
                                peerConnectionAttemptDiagnostics: (peerId) =>
                                    peerId === 'peer-3'
                                        ? undefined
                                        : ({
                                            peerId,
                                            attempts: 2,
                                            firstAttemptAtEpochMs: 10,
                                            lastAttemptAtEpochMs: 20,
                                            maxAttempts: 3,
                                            maxTotalDurationMs: 90000,
                                            cooldownMs: 30000
                                        })
                            }
                        }
                    })
                })
            );
            await expect(
                runtime.health({ includeRtcDiagnostics: true })
            ).resolves.toMatchObject({
                connected: true,
                rtcDiagnostics: { sessionId: facade.session.sessionId, peerCount: 1 },
                rtcCausalState: {
                    localSessionId: 'session-1',
                    desiredPeerIds: ['peer-1', 'peer-2'],
                    onlinePeerIds: ['peer-1', 'peer-3'],
                    connectablePeerIds: ['peer-1', 'peer-2'],
                    knownPeerIds: ['peer-2', 'peer-3'],
                    managerDiagnostics: { reconcileRunCount: 3 },
                    attempts: [{ peerId: 'peer-1', diagnostics: { attempts: 2 } }, { peerId: 'peer-2', diagnostics: { attempts: 2 } }, {
                        peerId: 'peer-3',
                        diagnostics: null
                    }]
                }
            });
            facade.behavior.rtcCausalState.mockImplementation(() => readBlackBoxRtcCausalState({ readMiddleware: () => undefined }));
            await expect(runtime.health({ includeRtcDiagnostics: true })).resolves.not.toHaveProperty('rtcCausalState');
            await expect(runtime.close()).resolves.toMatchObject({
                status: 'closed',
                disconnected: true,
                cleanupErrors: []
            });
        });
    });

    it('returns director operation diagnostics through the SPA bridge', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            vi.spyOn(nativeRuntime.director, 'appoint').mockResolvedValue({
                status: 'appointed'
            });
            vi.spyOn(nativeRuntime.director, 'resign').mockResolvedValue({
                status: 'resigned'
            });
            vi.spyOn(nativeRuntime.director, 'status').mockResolvedValue({
                status: 'status'
            });
            vi.spyOn(nativeRuntime.director, 'relayStart').mockResolvedValue({
                status: 'relay_started'
            });
            vi.spyOn(nativeRuntime.director, 'intent').mockResolvedValue({
                status: 'intent_sent'
            });
            vi.spyOn(nativeRuntime.director, 'syncRequest').mockResolvedValue({
                status: 'sync_requested'
            });
            vi.spyOn(nativeRuntime.director, 'relayStop').mockResolvedValue({
                status: 'relay_stopped'
            });
            const runtime = createSpaBrowserRallarRuntime();

            await expect(
                runtime.director?.appoint({ roomId: 'room-1' })
            ).resolves.toEqual({ status: 'appointed' });
            await expect(
                runtime.director?.status({ roomId: 'room-1' })
            ).resolves.toEqual({ status: 'status' });
            await expect(
                runtime.director?.relayStart({
                    handle: 'relay-1',
                    intentTypeId: 'intent',
                    outputTypeId: 'output'
                })
            ).resolves.toEqual({ status: 'relay_started' });
            await expect(
                runtime.director?.intent({
                    handle: 'relay-1',
                    intent: { intentId: 'intent-1' }
                })
            ).resolves.toEqual({ status: 'intent_sent' });
            await expect(
                runtime.director?.syncRequest({ handle: 'relay-1' })
            ).resolves.toEqual({ status: 'sync_requested' });
            await expect(
                runtime.director?.relayStop({ handle: 'relay-1' })
            ).resolves.toEqual({ status: 'relay_stopped' });
            await expect(
                runtime.director?.resign({ roomId: 'room-1' })
            ).resolves.toEqual({ status: 'resigned' });
        });
    });

    it('bridges browser Rallar events into the shared runtime', async () => {
        await withBrowserRuntime(async () => {
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime()
            });
            installSpaBrowserRallarEventBridge(runtime);

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-browser-rallar',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    sessionId: facade.session.sessionId,
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret'
                    },
                    control: {
                        providerMode: 'browser-rallar'
                    }
                }
            });
            const result = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-browser-rallar',
                connection: 'aliceRtc'
            });

            expect(result.ok).toBe(true);
            expect(
                selectRallarBlackBoxDiagnostics(runtime.state()).some(
                    (event) =>
                        event.topic === 'rallar.browser.connect.phase_completed' &&
                        event.connection === 'aliceRtc'
                )
            ).toBe(true);
        });
    });

    it('maps shared connect and send commands to the browser Rallar runtime', async () => {
        await withBrowserRuntime(async (nativeRuntime) => {
            const connect = vi.spyOn(nativeRuntime, 'connect');
            const send = vi.spyOn(nativeRuntime, 'send');
            facade.behavior.realtimeSend.mockResolvedValue([
                {
                    peerId: 'bob-session',
                    laneId: 'realtime',
                    result: { status: 'sent', bufferedAmount: 0 }
                }
            ]);
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: createSpaBrowserRallarRuntime()
            });

            await runtime.execute({
                kind: 'configure',
                commandId: 'configure-real-command-path',
                config: {
                    apiBaseUrl: 'https://api.example.test',
                    actor: 'alice',
                    sessionId: facade.session.sessionId,
                    roomId: 'room-1',
                    transport: 'realtime',
                    rallar: {
                        username: 'alice',
                        password: 'secret',
                        transport: 'realtime'
                    },
                    control: {
                        providerMode: 'browser-rallar'
                    }
                }
            });
            const connectResult = await runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-real-command-path',
                connection: 'realRtc'
            });
            const sendResult = await runtime.execute({
                kind: 'rtc.send',
                commandId: 'send-real-command-path',
                connection: 'realRtc',
                transport: 'realtime',
                send: {
                    roomId: 'room-1',
                    peerIds: ['bob-session'],
                    data: {
                        text: 'hello'
                    }
                }
            });

            expect(connectResult.ok).toBe(true);
            expect(sendResult.ok).toBe(true);
            expect(connect).toHaveBeenCalledWith({
                connection: 'realRtc',
                actor: 'alice',
                roomId: 'room-1',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    username: 'alice',
                    password: 'secret',
                    transport: 'realtime',
                    expectedSessionId: facade.session.sessionId
                }
            });
            expect(send).toHaveBeenCalledWith({
                roomId: 'room-1',
                peerIds: ['bob-session'],
                data: {
                    text: 'hello'
                }
            });
            expect(
                selectRallarBlackBoxDiagnostics(runtime.state()).some(
                    (event) =>
                        event.topic === 'rallar.bb.rtc.send_completed' &&
                        event.commandId === 'send-real-command-path'
                )
            ).toBe(true);
        });
    });

    it('waits for rtc.connect readiness before reporting success', async () => {
        const health = vi
            .fn()
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: []
                }
            })
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: ['peer-a', 'peer-b']
                }
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-peers',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 2,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            readiness: {
                readyPeerIds: ['peer-a', 'peer-b'],
                minReadyPeers: 2
            }
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).map(
                (event) => event.topic
            )
        ).toEqual(
            expect.arrayContaining([
                'rallar.bb.rtc.readiness_wait_started',
                'rallar.bb.rtc.readiness_ready',
                'rallar.bb.rtc.connected'
            ])
        );
    });

    it('delegates messages.rtc readiness to the canonical room wait', async () => {
        const waitForRoom = vi.fn<BlackBoxRallarRuntime['waitForRoom']>(
            async () => ({
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                ws: facade.rallar.ws.status(),
                rtc: {
                    desired: true,
                    mode: 'lazy',
                    state: 'open',
                    acceptedLayoutIdentity: {
                        groupRevision: 2,
                        presenceRevision: 2,
                        version: 1,
                        state: 'active'
                    },
                    desiredPeerIds: ['peer-a'],
                    knownPeerIds: ['peer-a'],
                    activePeerIds: ['peer-a'],
                    readyPeerIds: ['peer-a'],
                    failedPeerIds: [],
                    peers: [],
                    laneId: 'realtime'
                }
            })
        );
        const rallarRuntime = {
            ...createBrowserRallarRequiredMethodsTestDouble(),
            connect: vi.fn(async () => ({ connected: true })),
            send: vi.fn(),
            refreshRoom: vi.fn(async () => undefined),
            waitForRoom,
            close: vi.fn(),
            health: vi.fn(async () => {
                throw new Error(
                    'messages.rtc readiness must not poll global RTC health.'
                );
            })
        };
        const runtime = createRallarBlackBoxBrowserTestRuntime({ rallarRuntime });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-room',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(waitForRoom).toHaveBeenCalledWith({
            connect: true,
            minReadyPeers: 1,
            signal: expect.any(AbortSignal),
            timeoutMs: expect.any(Number)
        });
        expect(result.value).toMatchObject({
            readiness: {
                ready: true,
                readyPeerIds: ['peer-a'],
                room: {
                    rtc: {
                        state: 'open'
                    }
                }
            }
        });
    });

    it('fails messages.rtc readiness from canonical room state without polling global health', async () => {
        const refreshRoom = vi.fn(async () => undefined);
        const waitForRoom = vi.fn<BlackBoxRallarRuntime['waitForRoom']>(
            async () => ({
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                ws: facade.rallar.ws.status(),
                rtc: {
                    desired: true,
                    mode: 'lazy',
                    state: 'idle',
                    desiredPeerIds: [],
                    knownPeerIds: [],
                    activePeerIds: [],
                    readyPeerIds: [],
                    failedPeerIds: [],
                    peers: [],
                    laneId: 'realtime'
                }
            })
        );
        const health = vi.fn(async () => {
            throw new Error(
                'messages.rtc readiness must not poll global RTC health.'
            );
        });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                refreshRoom,
                waitForRoom,
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-room-not-ready',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: 'RTC connect timed out waiting for room transport readiness.'
        });
        expect(result.value).toMatchObject({
            readiness: {
                ready: false,
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0,
                room: { rtc: { state: 'idle' } }
            }
        });
    });

    it('does not retry a messages.rtc authority refresh failure', async () => {
        const refreshError = new Error('transient point-read failure');
        let refreshAttempts = 0;
        const refreshRoom = async (): Promise<never> => {
            refreshAttempts += 1;
            throw refreshError;
        };
        const waitForRoom: BlackBoxRallarRuntime['waitForRoom'] = async () => {
            throw new Error('A failed authority refresh must stop before room readiness.');
        };
        const health = async (): Promise<never> => {
            throw new Error('messages.rtc readiness must not poll global RTC health.');
        };
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                refreshRoom,
                waitForRoom,
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-room-refresh-failure',
            connection: 'rtc',
            roomId: 'room-1',
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            transport: 'messages.rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 1_500,
                intervalMs: 100
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
            message: refreshError.message
        });
        expect(refreshAttempts).toBe(1);
    });

    it('refreshes room authority before accepting an already-ready RTC peer', async () => {
        const refreshRoom = vi.fn(async () => undefined);
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(),
                close: vi.fn(),
                health: vi.fn(async () => ({
                    rtcStatus: {
                        readyPeerIds: ['peer-a']
                    }
                })),
                refreshRoom
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-already-ready',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            readiness: {
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0
            }
        });
    });

    it('refreshes room state while waiting for an initially undiscovered RTC peer', async () => {
        let roomStateRefreshed = false;
        const refreshRoom = vi.fn(
            async (_options: RallarBlackBoxBrowserRoomRefreshOptions) => {
                roomStateRefreshed = true;
            }
        );
        const health = vi.fn(async () => ({
            rtcStatus: {
                readyPeerIds: roomStateRefreshed ? ['peer-a'] : []
            }
        }));
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                close: vi.fn(),
                health,
                refreshRoom
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-after-room-refresh',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(true);
        expect(refreshRoom).toHaveBeenCalledWith({
            signal: expect.any(AbortSignal),
            timeoutMs: expect.any(Number)
        });
        const refreshOptions = refreshRoom.mock.calls[0]?.[0];
        expect(refreshOptions?.timeoutMs).toBeGreaterThan(0);
        expect(refreshOptions?.timeoutMs).toBeLessThanOrEqual(50);
        expect(result.value).toMatchObject({
            readiness: {
                readyPeerIds: ['peer-a'],
                roomRefreshAttempts: 1,
                roomRefreshSuccesses: 1,
                roomRefreshRetryableFailures: 0
            }
        });
    });

    it('does not let a pending room refresh overrun rtc.connect readiness', async () => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn(
                (_options: RallarBlackBoxBrowserRoomRefreshOptions) => new Promise<void>(() => undefined)
            );
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: []
                        }
                    })),
                    refreshRoom
                }
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-pending-room-refresh',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10,
                    intervalMs: 1
                }
            });
            await vi.advanceTimersByTimeAsync(0);

            const signal = refreshRoom.mock.calls[0]?.[0].signal;
            expect(signal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(10);
            const result = await pending;

            expect(result.ok).toBe(false);
            expect(result.error).toMatchObject({
                code: 'RALLAR_BB_RTC_READY_TIMEOUT'
            });
            expect(result.value).toMatchObject({
                readiness: {
                    roomRefreshAttempts: 1,
                    roomRefreshSuccesses: 0,
                    roomRefreshRetryableFailures: 0
                }
            });
            expect(signal?.aborted).toBe(true);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('cancels a pending room refresh when distributed execution is cancelled', async () => {
        vi.useFakeTimers();
        try {
            const refreshRoom = vi.fn(
                (_options: RallarBlackBoxBrowserRoomRefreshOptions) => new Promise<void>(() => undefined)
            );
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: []
                        }
                    })),
                    refreshRoom
                }
            });

            const pendingConnect = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-cancelled-room-refresh',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 10_000,
                    intervalMs: 1
                }
            });
            await vi.advanceTimersByTimeAsync(0);
            const signal = refreshRoom.mock.calls[0]?.[0].signal;

            await runtime.execute({
                kind: 'recipe.cancel',
                commandId: 'cancel-pending-room-refresh',
                reason: 'distributed run cancelled'
            });
            const result = await pendingConnect;

            expect(result.status).toBe('cancelled');
            expect(signal?.aborted).toBe(true);
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('keeps waiting after a transient room refresh failure', async () => {
        vi.useFakeTimers();
        try {
            const refreshError = new Error('transient point-read failure');
            let roomStateRefreshed = false;
            const refreshRoom = vi
                .fn()
                .mockRejectedValueOnce(refreshError)
                .mockImplementationOnce(async () => {
                    roomStateRefreshed = true;
                });
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: roomStateRefreshed ? ['peer-a'] : []
                        }
                    })),
                    refreshRoom
                }
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-after-transient-refresh-failure',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 1_500,
                    intervalMs: 100
                }
            });
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(1_000);
            const result = await pending;

            expect(result.ok).toBe(true);
            expect(result.value).toMatchObject({
                readiness: {
                    readyPeerIds: ['peer-a'],
                    roomRefreshAttempts: 2,
                    roomRefreshSuccesses: 1,
                    roomRefreshRetryableFailures: 1,
                    lastRefreshError: {
                        name: 'Error',
                        message: refreshError.message
                    }
                }
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('does not trust already-ready RTC health after a transient room refresh failure', async () => {
        vi.useFakeTimers();
        try {
            const refreshError = new Error('transient point-read failure');
            const refreshRoom = vi
                .fn()
                .mockRejectedValueOnce(refreshError)
                .mockResolvedValueOnce(undefined);
            const runtime = createRallarBlackBoxBrowserTestRuntime({
                rallarRuntime: {
                    ...createBrowserRallarRequiredMethodsTestDouble(),
                    connect: vi.fn(async () => ({ connected: true })),
                    send: vi.fn(),
                    close: vi.fn(),
                    health: vi.fn(async () => ({
                        rtcStatus: {
                            readyPeerIds: ['peer-a']
                        }
                    })),
                    refreshRoom
                }
            });

            const pending = runtime.execute({
                kind: 'rtc.connect',
                commandId: 'connect-after-stale-ready-health',
                connection: 'rtc',
                readiness: {
                    minReadyPeers: 1,
                    timeoutMs: 1_500,
                    intervalMs: 100
                }
            });
            await vi.advanceTimersByTimeAsync(0);

            await vi.advanceTimersByTimeAsync(1_000);
            const result = await pending;

            expect(result.ok).toBe(true);
            expect(result.value).toMatchObject({
                readiness: {
                    readyPeerIds: ['peer-a'],
                    roomRefreshAttempts: 2,
                    roomRefreshSuccesses: 1,
                    roomRefreshRetryableFailures: 1,
                    lastRefreshError: {
                        name: 'Error',
                        message: refreshError.message
                    }
                }
            });
        }
        finally {
            vi.useRealTimers();
        }
    });

    it.each([
        [
            'HTTP authorization',
            new ApiHttpError(
                'GET',
                '/api/state/rooms/example',
                403,
                'room refresh forbidden'
            )
        ],
        [
            'configuration validation',
            new RallarValidationError(
                '$.roomRef: Exact room reference is required.',
                [
                    {
                        path: '$.roomRef',
                        code: 'room-ref-required',
                        message: 'Exact room reference is required.'
                    }
                ]
            )
        ]
    ])(
        'fails rtc.connect immediately after a permanent %s refresh failure',
        async (_label, refreshError) => {
            vi.useFakeTimers();
            try {
                const refreshRoom = vi.fn().mockRejectedValue(refreshError);
                const runtime = createRallarBlackBoxBrowserTestRuntime({
                    rallarRuntime: {
                        ...createBrowserRallarRequiredMethodsTestDouble(),
                        connect: vi.fn(async () => ({ connected: true })),
                        send: vi.fn(),
                        close: vi.fn(),
                        health: vi.fn(async () => ({
                            rtcStatus: {
                                readyPeerIds: []
                            }
                        })),
                        refreshRoom
                    }
                });

                const pending = runtime.execute({
                    kind: 'rtc.connect',
                    commandId: `connect-after-${refreshError.name}`,
                    connection: 'rtc',
                    readiness: {
                        minReadyPeers: 1,
                        timeoutMs: 25,
                        intervalMs: 1
                    }
                });
                let completed = false;
                void pending.then(() => {
                    completed = true;
                });
                await vi.advanceTimersByTimeAsync(0);
                expect(completed).toBe(true);
                const result = await pending;

                expect(result.ok).toBe(false);
                expect(result.error).toMatchObject({
                    code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                    message: refreshError.message,
                    details: {
                        name: refreshError.name
                    }
                });
            }
            finally {
                vi.useRealTimers();
            }
        }
    );

    it('uses the readiness timeout window after rtc.connect completes', async () => {
        const health = vi
            .fn()
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: []
                }
            })
            .mockResolvedValueOnce({
                rtcStatus: {
                    readyPeerIds: ['peer-a']
                }
            });
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-after-command-timeout',
            connection: 'rtc',
            timeoutMs: 1,
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 50,
                intervalMs: 5
            }
        });

        expect(result.ok).toBe(true);
        expect(result.value).toMatchObject({
            readiness: {
                ready: true,
                readyPeerIds: ['peer-a'],
                minReadyPeers: 1
            }
        });
    });

    it('fails rtc.connect when readiness times out', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({
                    connected: true,
                    rtcStatus: {
                        readyPeerIds: []
                    }
                })),
                send: vi.fn(),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health: vi.fn(async () => ({
                    rtcStatus: {
                        readyPeerIds: []
                    }
                }))
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.connect',
            commandId: 'connect-ready-timeout',
            connection: 'rtc',
            readiness: {
                minReadyPeers: 1,
                timeoutMs: 5,
                intervalMs: 1
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_READY_TIMEOUT',
            message: 'RTC connect timed out waiting for ready peers.'
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).some(
                (event) =>
                    event.topic === 'rallar.bb.rtc.readiness_timeout' &&
                    event.commandId === 'connect-ready-timeout' &&
                    event.severity === 'error'
            )
        ).toBe(true);
    });

    it('fails realtime send commands when the browser runtime resolves no peers', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({
                    status: 'no-peers',
                    transport: 'realtime',
                    roomId: 'awesome',
                    peerIds: [],
                    results: [],
                    health: []
                })),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health: vi.fn()
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'manual-send-no-peers',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                roomId: 'awesome',
                data: {
                    text: 'hello solo room'
                }
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_NO_PEERS',
            message: 'RTC send resolved no target peers.'
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).some(
                (event) =>
                    event.topic === 'rallar.bb.rtc.send_failed' &&
                    event.commandId === 'manual-send-no-peers' &&
                    event.severity === 'error'
            )
        ).toBe(true);
    });

    it('fails messages.rtc send commands when the browser runtime reports no route', async () => {
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                ...createBrowserRallarRequiredMethodsTestDouble(),
                connect: vi.fn(async () => ({ connected: true })),
                send: vi.fn(async () => ({
                    status: 'sent',
                    transport: 'messages.rtc',
                    roomId: 'awesome',
                    message: {
                        status: 'no-route',
                        reason: 'No outbound transport route for message test-msg'
                    },
                    health: []
                })),
                refreshRoom: vi.fn(async () => undefined),
                close: vi.fn(),
                health: vi.fn()
            }
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'manual-send-no-route',
            connection: 'aliceRtc',
            transport: 'messages.rtc',
            send: {
                roomId: 'awesome',
                typeId: 'manual.type',
                topicId: 'manual.topic',
                payload: {
                    text: 'hello solo room'
                }
            }
        });

        expect(result.ok).toBe(false);
        expect(result.error).toMatchObject({
            code: 'RALLAR_BB_RTC_NO_ROUTE',
            message: 'RTC send failed with status no-route: No outbound transport route for message test-msg'
        });
        expect(
            selectRallarBlackBoxDiagnostics(runtime.state()).some(
                (event) =>
                    event.topic === 'rallar.bb.rtc.send_failed' &&
                    event.commandId === 'manual-send-no-route' &&
                    event.severity === 'error'
            )
        ).toBe(true);
    });
});
