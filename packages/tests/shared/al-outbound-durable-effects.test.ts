import { afterEach, describe, expect, it, vi } from 'vitest';

import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import { ALOutboundMessageRuntime, InMemoryQueueBox, newALAckControlMessage, newALNackControlMessage } from '@shared/mod.ts';

import {
    createDefaultOutboundTestAdmissionStore,
    createDefaultOutboundTestRuntime,
    createFlakyOutboundAdmissionStore,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    reserveOutbox
} from './alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './alm/outbound-test-payload.ts';

describe('AL outbound durable effect lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('drains committed send effects after a restart when the first runtime crashes before drain', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('msg-crash-before-drain');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => []
                })
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();

        expect(sent).toEqual([]);

        const runtime2 = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        await runtime2.ready();

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime2.dispose();
    });

    it('replays a sent effect when completion fails after transport send', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        let failFirstComplete = true;
        const msg = createOutboundMessage('msg-complete-fails-after-send');
        const runtime = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    completeEffect: async (effectId, workerId) => {
                        if (failFirstComplete) {
                            failFirstComplete = false;
                            throw new Error('complete failed after send');
                        }

                        await admissionStore.completeEffect(effectId, workerId, decodeOutboundTestPayload);
                    }
                })
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        await vi.advanceTimersByTimeAsync(49);
        expect(sent).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('lets only one runtime claim the same committed send effect', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('msg-single-claim');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => []
                })
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        await enqueueOutboundOrThrow(runtime1, msg);
        runtime1.dispose();
        expect(sent).toEqual([]);

        const sendStarted = Promise.withResolvers<void>();
        const sendBarrier = Promise.withResolvers<void>();
        const blockingSend: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['sendPreparedMessage'] = async (
            prepared,
            phase
        ) => {
            sent.push({ ...prepared, phase });
            sendStarted.resolve();
            await sendBarrier.promise;
        };
        const runtime2 = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore
            },
            sendPreparedMessage: blockingSend,
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });
        const runtime3 = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore
            },
            sendPreparedMessage: blockingSend,
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });
        const drain = Promise.all([runtime2.ready(), runtime3.ready()]);

        await sendStarted.promise;
        await Promise.resolve();
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        sendBarrier.resolve();
        await drain;
        runtime2.dispose();
        runtime3.dispose();
    });

    it('does not repair when an acknowledgement is accepted while the timeout effect is claimed', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('msg-ack-during-timeout');
        let acceptedAckDuringTimeout = false;
        const runtime = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async (input, decodePrepared) => {
                        const effects = await admissionStore.claimReadyEffects(input, decodePrepared);
                        if (
                            !acceptedAckDuringTimeout &&
                            effects.some((effect) => effect.payload.kind === 'ack-timeout')
                        ) {
                            acceptedAckDuringTimeout = true;
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage('peer-1', 'self', msg.id.msgId),
                                decodeOutboundTestPayload
                            );
                        }

                        return effects;
                    }
                })
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1']
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: plannedMsg.id.msgId,
                        trigger: request.trigger
                    }
                ]
            })
        });

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        await vi.advanceTimersByTimeAsync(100);

        expect(acceptedAckDuringTimeout).toBe(true);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('recomputes from the latest read after a commit conflict', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('msg-conflict-recompute');
        let rejectedFirstCommit = false;
        const runtime = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    commitBundle: async (bundle, decodePrepared) => {
                        if (!rejectedFirstCommit) {
                            rejectedFirstCommit = true;
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage('peer-1', 'self', msg.id.msgId),
                                decodeOutboundTestPayload
                            );
                            return 'conflict';
                        }

                        return await admissionStore.commitBundle(bundle, decodePrepared);
                    }
                })
            },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1']
                },
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: plannedMsg.id.msgId,
                        trigger: request.trigger
                    }
                ]
            })
        });

        const conflictEnqueue = enqueueOutboundOrThrow(runtime, msg);
        await vi.advanceTimersByTimeAsync(10);
        await conflictEnqueue;
        await vi.advanceTimersByTimeAsync(200);

        expect(rejectedFirstCommit).toBe(true);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('skips outbound enqueue after dispose without storing or sending', async () => {
        const outbox = new InMemoryQueueBox();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores: { admissionStore },
            planOutgoingMessage: (msg) => ({
                persist: true,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));
            }
        });
        runtime.dispose();
        const msg = createOutboundMessage('msg-after-dispose');
        const result = await runtime.enqueueIfAbsent(msg);

        expect(result).toMatchObject({
            status: 'skipped',
            reason: 'Outbound runtime is disposed.',
            entries: []
        });
        expect(sent).toEqual([]);
        expect(await reserveOutbox(outbox)).toEqual([]);
        expect(await admissionStore.getSentMessage(msg.id.msgId)).toBeUndefined();
    });

    it('ignores control messages after dispose without bootstrapping durable effects', async () => {
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sent: string[] = [];
        const msg = createOutboundMessage('pending-before-dispose');
        const payload = {
            kind: 'send-prepared',
            msg,
            prepared: { kind: 'send', msgId: msg.id.msgId },
            phase: 'immediate'
        } as const;
        await admissionStore.commitBundle({
            senderId: 'self',
            mutations: [],
            durableEffects: [{ effectId: 'pending-before-dispose', payload }]
        }, decodeOutboundTestPayload);
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        runtime.dispose();

        const handled = await runtime.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', 'missing-msg', 'gap')
        );

        expect(handled).toBe(false);
        expect(sent).toEqual([]);
        const pending = await admissionStore.claimReadyEffects({
            workerId: 'next-runtime',
            maxCount: 10,
            leaseMs: 100,
            nowMs: Date.now()
        }, decodeOutboundTestPayload);
        expect(pending.map((effect) => effect.payload)).toEqual([payload]);
    });

    it('retries the complete control-message admission after optimistic conflicts', async () => {
        vi.useFakeTimers();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        let attempts = 0;
        const runtime = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore: createFlakyOutboundAdmissionStore(admissionStore, {
                    acceptControlMessage: async (msg) => {
                        attempts += 1;
                        if (attempts < 4) {
                            throw new ALAdmissionBackendConflictError(
                                'simulated outbound control conflict'
                            );
                        }
                        return await admissionStore.acceptControlMessage(msg, decodeOutboundTestPayload);
                    }
                })
            },
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });

        const accepted = runtime.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', 'missing-msg', 'expired')
        );
        await vi.runAllTimersAsync();

        await expect(accepted).resolves.toBe(true);
        expect(attempts).toBe(4);
        runtime.dispose();
    });

    it('leaves an interrupted send leased until a new runtime can recover it', async () => {
        vi.useFakeTimers();
        const msg = createOutboundMessage('msg-dispose-during-effect');
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sendStarted = Promise.withResolvers<void>();
        const sendCompleted = Promise.withResolvers<void>();
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async () => {
                sendStarted.resolve();
                await sendCompleted.promise;
                throw new Error('network closed');
            },
            planOutgoingMessage: (plannedMsg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        const enqueue = enqueueOutboundOrThrow(runtime, msg);
        await sendStarted.promise;
        const leaseExpiresAt = await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload);
        if (leaseExpiresAt === undefined) {
            throw new Error('Expected the in-flight send to retain its durable lease');
        }
        expect(leaseExpiresAt).toBeGreaterThan(Date.now());
        runtime.dispose();
        sendCompleted.resolve();
        await enqueue;
        expect(await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(leaseExpiresAt);

        const recovered: string[] = [];
        const restarted = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared) => {
                recovered.push(String(prepared.msgId));
            },
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [] })
        });
        await restarted.ready();
        await vi.advanceTimersByTimeAsync(leaseExpiresAt - Date.now() - 1);
        expect(recovered).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(recovered).toEqual([msg.id.msgId]);
        expect(await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
        restarted.dispose();
    });
});
