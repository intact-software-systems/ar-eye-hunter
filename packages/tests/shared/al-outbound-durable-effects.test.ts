import { toALOutboundMessageReference } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    computeOutboundTestAdmission,
    peekOutboundTestWorkReadyAt,
    toOutboundTestStores
} from './alm/outbound-runtime-test-fixture.ts';

import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import type { ALOutboundSettledSendResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import {
    ALOutboundMessageRuntime,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALNackControlMessage
} from '@shared/mod.ts';

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

    it('does not send when the deadline passes during the receipt read', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const store = createDefaultOutboundTestAdmissionStore();
        const send = vi.fn(async () => ({ status: 'sent' as const }));
        vi.spyOn(store, 'readReceiptState').mockImplementation(async () => {
            vi.setSystemTime(2_000);
            return undefined;
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: toOutboundTestStores(store),
            sendPreparedMessage: send,
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] })
        });
        await runtime.enqueueIfAbsent(createOutboundMessage('expires-during-receipt-read', { ttlMs: 1_000 }));
        expect(send).not.toHaveBeenCalled();
        expect(await peekOutboundTestWorkReadyAt(store)).toBeUndefined();
    });

    it('recovers a retained send when durable completion fails after its native settlement', async () => {
        vi.useFakeTimers();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const settlement = Promise.withResolvers<ALOutboundSettledSendResult>();
        const sent: string[] = [];
        let failCompletion = true;
        const runtime = createDefaultOutboundTestRuntime({
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    completeEffect: async (reservation) => {
                        if (failCompletion) {
                            failCompletion = false;
                            throw new Error('Completion storage unavailable');
                        }
                        await admissionStore.completeEffect(reservation);
                    }
                })),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));
                return sent.length === 1 ? { status: 'queued', settled: settlement.promise } : { status: 'sent' };
            },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] })
        });
        const message = createOutboundMessage('retained-completion-failure');
        await runtime.enqueueIfAbsent(message);
        settlement.resolve({ status: 'sent' });
        await vi.advanceTimersByTimeAsync(0);
        const retryAt = await peekOutboundTestWorkReadyAt(admissionStore);
        if (retryAt === undefined) {
            throw new Error('Completion failure must retain retryable work');
        }
        expect(retryAt).toBeGreaterThan(Date.now());
        await vi.advanceTimersByTimeAsync(retryAt - Date.now());
        expect(sent).toEqual([message.id.msgId, message.id.msgId]);
        expect(await peekOutboundTestWorkReadyAt(admissionStore)).toBeUndefined();
    });

    it.each(['cancelled', 'expired', 'superseded'] as const)('does not retry a retained send after %s settlement', async (status) => {
        vi.useFakeTimers();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const settlement = Promise.withResolvers<ALOutboundSettledSendResult>();
        const attempts: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared) => {
                attempts.push(String(prepared.msgId));
                return { status: 'queued', settled: settlement.promise };
            },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] })
        });
        const message = createOutboundMessage(`retained-${status}`);
        await runtime.enqueueIfAbsent(message);
        settlement.resolve({ status });
        await vi.advanceTimersByTimeAsync(10_001);
        expect(attempts).toEqual([message.id.msgId]);
        expect(await peekOutboundTestWorkReadyAt(admissionStore)).toBeUndefined();
    });

    it('drains committed send effects after a restart when the first runtime crashes before drain', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('msg-crash-before-drain');
        const runtime1 = createDefaultOutboundTestRuntime({
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => []
                })),
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
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

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
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

    it('drains a repair effect committed while the current drain is finishing', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const emptyRead = Promise.withResolvers<void>();
        const releaseEmptyRead = Promise.withResolvers<void>();
        const controlStored = Promise.withResolvers<void>();
        const msg = createOutboundMessage('msg-control-during-empty-read');
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }],
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            }),
            planRepairMessage: async (plannedMsg, request) => ({
                msg: plannedMsg,
                persist: false,
                preparedMessages: [{ kind: 'repair', msgId: plannedMsg.id.msgId, trigger: request.trigger }]
            })
        });
        await runtime.ready();
        const readNextReadyAt = admissionStore.peekNextEffectReadyAt.bind(admissionStore);
        const acceptControlMessage = admissionStore.acceptControlMessage.bind(admissionStore);
        vi.spyOn(admissionStore, 'peekNextEffectReadyAt').mockImplementation(async () => {
            const readyAt = await readNextReadyAt();
            emptyRead.resolve();
            await releaseEmptyRead.promise;
            return readyAt;
        });
        vi.spyOn(admissionStore, 'acceptControlMessage').mockImplementation(async (message, decodePrepared) => {
            const acceptance = await acceptControlMessage(message, decodePrepared);
            controlStored.resolve();
            return acceptance;
        });

        const enqueue = enqueueOutboundOrThrow(runtime, msg);
        await emptyRead.promise;
        const acceptControl = runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1
                }
            )
        );
        await controlStored.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        releaseEmptyRead.resolve();
        await Promise.all([enqueue, acceptControl]);

        await expect.poll(() => sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'repair', msgId: msg.id.msgId, trigger: 'nack', phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('replays a sent effect when completion fails after transport send', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        let failFirstComplete = true;
        const msg = createOutboundMessage('msg-complete-fails-after-send');
        const runtime = createDefaultOutboundTestRuntime({
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    completeEffect: async (reservation) => {
                        if (failFirstComplete) {
                            failFirstComplete = false;
                            throw new Error('complete failed after send');
                        }

                        await admissionStore.completeEffect(reservation);
                    }
                })),
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        const retryAt = await peekOutboundTestWorkReadyAt(admissionStore);
        if (retryAt === undefined) {
            throw new Error('Failed completion must leave a pending QueueBox retry');
        }
        await vi.advanceTimersByTimeAsync(retryAt - Date.now() - 1);
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
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async () => []
                })),
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
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

            return { status: 'sent' as const };
        };
        const runtime2 = createDefaultOutboundTestRuntime({
            stores: {
                admissionStore
            },
            sendPreparedMessage: blockingSend,
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
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
                msg: plannedMsg,
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
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    claimReadyEffects: async (input, decodePrepared) => {
                        const effects = await admissionStore.claimReadyEffects(input, decodePrepared);
                        if (
                            !acceptedAckDuringTimeout &&
                            effects.some((effect) => effect.payload.kind === 'ack-timeout')
                        ) {
                            acceptedAckDuringTimeout = true;
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage(
                                    { v: 2, msgId: 'control-timeout-ack', ts: 1, senderId: 'peer-1' },
                                    {
                                        ackedMsgId: msg.id.msgId,
                                        fromPeerId: 'peer-1',
                                        toPeerId: 'self',
                                        status: 'accepted',
                                        observedAtEpochMs: 1
                                    }
                                ),
                                decodeOutboundTestPayload
                            );
                        }

                        return effects;
                    }
                })),
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
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
                msg: plannedMsg,
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

    it('retains a conflicted admission and rereads receipts before worker delivery', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const msg = createOutboundMessage('msg-conflict-recompute');
        let rejectedFirstCommit = false;
        const runtime = createDefaultOutboundTestRuntime({
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    commitBundle: async (bundle, decodePrepared) => {
                        if (!rejectedFirstCommit) {
                            rejectedFirstCommit = true;
                            expect(await admissionStore.commitBundle(bundle)).toBe('committed');
                            await admissionStore.acceptControlMessage(
                                newALAckControlMessage(
                                    { v: 2, msgId: 'control-conflict-ack', ts: 1, senderId: 'peer-1' },
                                    {
                                        ackedMsgId: msg.id.msgId,
                                        fromPeerId: 'peer-1',
                                        toPeerId: 'self',
                                        status: 'accepted',
                                        observedAtEpochMs: 1
                                    }
                                ),
                                decodeOutboundTestPayload
                            );
                            return 'conflict';
                        }

                        return await admissionStore.commitBundle(bundle);
                    }
                })),
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
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
                msg: plannedMsg,
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

        expect((await runtime.enqueueIfAbsent(msg)).status).toBe('pending-admission');
        await vi.advanceTimersByTimeAsync(200);

        expect(rejectedFirstCommit).toBe(true);
        expect(sent).toEqual([]);
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
                msg: msg,
                persist: true,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            }),
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));

                return { status: 'sent' as const };
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
        expect(await admissionStore.readSentMessage(msg.id.msgId)).toBeUndefined();
    });

    it('ignores control messages after dispose without bootstrapping durable effects', async () => {
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sent: string[] = [];
        const msg = createOutboundMessage('pending-before-dispose');
        const admission = await computeOutboundTestAdmission(admissionStore, msg);
        const prepared = { kind: 'send', msgId: msg.id.msgId } as const;
        const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
        const payload = {
            kind: 'send-prepared',
            message: toALOutboundMessageReference(admissionStore.canonicalScope, admission.canonicalEntry!, msg),
            attemptIdentity: 'initial',
            prepared,
            preparedFingerprint,
            phase: 'immediate'
        } as const;
        const effectId = toALOutboundEffectId([
            'send',
            msg.id.msgId,
            'immediate',
            'initial',
            0,
            preparedFingerprint
        ]);
        await admissionStore.commitBundle({
            ...admission,
            durableEffects: [{ effectId, payload }]
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        runtime.dispose();

        const handled = await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-missing-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: 'missing-msg',
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1
                }
            )
        );

        expect(handled).toBe(false);
        expect(sent).toEqual([]);
        const pending = await admissionStore.claimReadyEffects({
            maxCount: 10
        });
        expect(pending.map((effect) => effect.payload)).toEqual([payload]);
    });

    it('returns a control admission conflict without an inner retry', async () => {
        vi.useFakeTimers();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        let attempts = 0;
        const runtime = createDefaultOutboundTestRuntime({
            stores: toOutboundTestStores(createFlakyOutboundAdmissionStore(admissionStore, {
                    acceptControlMessage: async (msg) => {
                        attempts += 1;
                        if (attempts < 4) {
                            throw new ALAdmissionBackendConflictError(
                                'simulated outbound control conflict'
                            );
                        }
                        return await admissionStore.acceptControlMessage(msg, decodeOutboundTestPayload);
                    }
                })),
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-control-conflict');
        await enqueueOutboundOrThrow(runtime, msg);

        const accepted = runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-expired', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'expired',
                    observedAtEpochMs: 1
                }
            )
        );
        await expect(accepted).rejects.toThrow('simulated outbound control conflict');
        expect(attempts).toBe(1);
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
                msg: plannedMsg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });

        const enqueue = enqueueOutboundOrThrow(runtime, msg);
        await sendStarted.promise;
        const leaseExpiresAt = await peekOutboundTestWorkReadyAt(admissionStore);
        if (leaseExpiresAt === undefined) {
            throw new Error('Expected the in-flight send to retain its durable lease');
        }
        expect(leaseExpiresAt).toBeGreaterThan(Date.now());
        runtime.dispose();
        sendCompleted.resolve();
        await enqueue;
        expect(await peekOutboundTestWorkReadyAt(admissionStore)).toBe(leaseExpiresAt);

        const recovered: string[] = [];
        const restarted = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared) => {
                recovered.push(String(prepared.msgId));

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] })
        });
        await restarted.ready();
        await vi.advanceTimersByTimeAsync(leaseExpiresAt - Date.now() - 1);
        expect(recovered).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(recovered).toEqual([msg.id.msgId]);
        expect(await peekOutboundTestWorkReadyAt(admissionStore)).toBeUndefined();
        restarted.dispose();
    });
});
