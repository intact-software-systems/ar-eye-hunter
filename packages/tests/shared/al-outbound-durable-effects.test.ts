import { createTestALOutboundControlAdmission } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import { toALOutboundMessageReference } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { ALAdmissionBackendConflictError } from '@shared/alm/ALAdmissionBackendConflictError.ts';
import type { ALOutboundSettledSendResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { toALOutboundWorkType } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { toALOutboundPreparedFingerprint } from '@shared/alm/outbound/to-al-outbound-prepared-fingerprint.ts';
import {
    ALOutboundMessageRuntime,
    EntityStatus,
    InboxOutboxEngine,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALNackControlMessage,
    type ResourceEntry
} from '@shared/mod.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    holdOutboundClaims,
    peekOutboundWorkReadyAt,
    reserveOutbox,
    type OutboundTestStores
} from './alm/outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from './alm/outbound-test-payload.ts';
import { waitForSettledOutboundWork } from './wait-for-al-outbound-work.ts';

describe('AL outbound durable effect lifecycle', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('does not send when the deadline passes during the receipt read', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const send = vi.fn(async () => ({ status: 'sent' as const }));
        vi.spyOn(stores.admissionStore, 'readReceiptState').mockImplementation(async () => {
            vi.setSystemTime(2_000);
            return undefined;
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: send,
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }] })
        });
        await runtime.enqueueIfAbsent(createOutboundMessage('expires-during-receipt-read', { ttlMs: 1_000 }));
        await settleOutboundWork(stores);
        expect(send).not.toHaveBeenCalled();
        expect(await peekOutboundTestWork(stores)).toBeUndefined();
    });

    it('recovers a retained send when its claim release fails after native settlement', async () => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const settlement = Promise.withResolvers<ALOutboundSettledSendResult>();
        const sent: string[] = [];
        failFirstCompletedRelease(stores);
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        const retryAt = await peekOutboundTestWork(stores);
        if (retryAt === undefined) {
            throw new Error('Completion failure must retain retryable work');
        }
        expect(retryAt).toBeGreaterThan(Date.now());
        await vi.advanceTimersByTimeAsync(retryAt - Date.now());
        expect(sent).toEqual([message.id.msgId, message.id.msgId]);
        expect(await peekOutboundTestWork(stores)).toBeUndefined();
    });

    it.each(['cancelled', 'expired', 'superseded'] as const)('does not retry a retained send after %s settlement', async (status) => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const settlement = Promise.withResolvers<ALOutboundSettledSendResult>();
        const attempts: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        expect(await peekOutboundTestWork(stores)).toBeUndefined();
    });

    it('drains committed send effects after a restart when the first runtime crashes before drain', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultOutboundTestStores();
        const msg = createOutboundMessage('msg-crash-before-drain');
        const claims = holdOutboundClaims(stores);
        const { runtime: runtime1, claimedCounts } = createUndrainedOutboundRuntime(
            stores,
            async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            }
        );

        await enqueueOutboundOrThrow(runtime1, msg);
        await expect.poll(() => claimedCounts.length).toBeGreaterThanOrEqual(2);
        runtime1.dispose();

        expect(sent).toEqual([]);
        expect(claimedCounts).toEqual([0, 0]);
        await claims.release();

        const runtime2 = createDefaultOutboundTestRuntime({
            stores,
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

    it('drains a repair effect committed while the current batch is claiming', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultOutboundTestStores();
        const msg = createOutboundMessage('msg-control-during-claim');
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        const claimStarted = Promise.withResolvers<void>();
        const releaseClaim = Promise.withResolvers<void>();
        const reserveEntries = stores.workQueue.reserveEntries.bind(stores.workQueue);
        let held = false;
        vi.spyOn(stores.workQueue, 'reserveEntries').mockImplementation(async (input) => {
            if (!held) {
                held = true;
                claimStarted.resolve();
                await releaseClaim.promise;
            }
            return await reserveEntries(input);
        });

        // Admission must not be drained here: its batch is the one this test holds at the claim.
        expect((await runtime.enqueueIfAbsent(msg)).status).toBe('accepted');
        await claimStarted.promise;
        // The control commits while the batch that owes the send is still claiming.
        await runtime.acceptControlMessage(
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
        releaseClaim.resolve();

        await expect.poll(() => sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'repair', msgId: msg.id.msgId, trigger: 'nack', phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('replays a sent effect when the claim release fails after transport send', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultOutboundTestStores();
        const msg = createOutboundMessage('msg-complete-fails-after-send');
        failFirstCompletedRelease(stores);
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        const retryAt = await peekOutboundTestWork(stores);
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
        const stores = createDefaultOutboundTestStores();
        const msg = createOutboundMessage('msg-single-claim');
        const claims = holdOutboundClaims(stores);
        const { runtime: runtime1, claimedCounts } = createUndrainedOutboundRuntime(
            stores,
            async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            }
        );

        await enqueueOutboundOrThrow(runtime1, msg);
        await expect.poll(() => claimedCounts.length).toBeGreaterThanOrEqual(2);
        runtime1.dispose();
        expect(sent).toEqual([]);
        await claims.release();

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
            stores,
            sendPreparedMessage: blockingSend,
            planOutgoingMessage: (plannedMsg) => ({
                msg: plannedMsg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
            })
        });
        const runtime3 = createDefaultOutboundTestRuntime({
            stores,
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

    it('does not repair when an acknowledgement is accepted while the timeout work is claimed', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const stores = createDefaultOutboundTestStores();
        const msg = createOutboundMessage('msg-ack-during-timeout');
        const control = createTestALOutboundControlAdmission({ ...stores, nowMs: Date.now });
        let acceptedAckDuringTimeout = false;
        const reserveEntries = stores.workQueue.reserveEntries.bind(stores.workQueue);
        vi.spyOn(stores.workQueue, 'reserveEntries').mockImplementation(async (input) => {
            const reserved = await reserveEntries(input);
            if (!acceptedAckDuringTimeout && await hasAckTimeoutWork(stores, [...reserved.values()])) {
                acceptedAckDuringTimeout = true;
                await control.admit(
                    newALAckControlMessage(
                        { v: 2, msgId: 'control-timeout-ack', ts: 1, senderId: 'peer-1' },
                        {
                            ackedMsgId: msg.id.msgId,
                            fromPeerId: 'peer-1',
                            toPeerId: 'self',
                            status: 'accepted',
                            observedAtEpochMs: 1
                        }
                    )
                );
            }

            return reserved;
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        await vi.advanceTimersByTimeAsync(0);
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
        const stores = createDefaultOutboundTestStores();
        const msg = createOutboundMessage('msg-conflict-recompute');
        const control = createTestALOutboundControlAdmission({ ...stores, nowMs: Date.now });
        const commitBundle = stores.admissionStore.commitBundle.bind(stores.admissionStore);
        let rejectedFirstCommit = false;
        vi.spyOn(stores.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            if (rejectedFirstCommit) {
                return await commitBundle(bundle);
            }
            rejectedFirstCommit = true;
            // The committed state races ahead of the caller's observation: the ACK lands and the
            // caller is told its own bundle conflicted, so its retained admission must reread.
            expect(await commitBundle(bundle)).toBe('committed');
            expect(
                await control.admit(
                    newALAckControlMessage(
                        { v: 2, msgId: 'control-conflict-ack', ts: 1, senderId: 'peer-1' },
                        {
                            ackedMsgId: msg.id.msgId,
                            fromPeerId: 'peer-1',
                            toPeerId: 'self',
                            status: 'accepted',
                            observedAtEpochMs: 1
                        }
                    )
                )
            ).toEqual({ kind: 'committed' });
            return 'conflict';
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        const stores = createDefaultOutboundTestStores();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            stores,
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
        expect(await stores.admissionStore.readSentMessage(msg.id.msgId)).toBeUndefined();
    });

    it('ignores control messages after dispose without bootstrapping durable effects', async () => {
        const stores = createDefaultOutboundTestStores();
        const sent: string[] = [];
        const msg = createOutboundMessage('pending-before-dispose');
        const admission = await computeOutboundTestAdmission(stores.admissionStore, msg);
        const prepared = { kind: 'send', msgId: msg.id.msgId } as const;
        const preparedFingerprint = toALOutboundPreparedFingerprint(prepared);
        const payload = {
            kind: 'send-prepared',
            message: toALOutboundMessageReference(stores.admissionStore.canonicalScope, admission.canonicalEntry!, msg),
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
        await stores.admissionStore.commitBundle({
            ...admission,
            durableEffects: [{ effectId, payload }]
        });
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        expect(await readRetainedWorkKinds(stores)).toEqual(['send-prepared']);
    });

    it('retains a control admission conflict as replayable work without an inner retry', async () => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-control-conflict');
        await enqueueOutboundOrThrow(runtime, msg);
        await settleOutboundWork(stores);
        const write = vi.spyOn(stores.backend, 'write').mockImplementationOnce(() => {
            throw new ALAdmissionBackendConflictError('simulated outbound control conflict');
        });

        const accepted = await runtime.acceptControlMessage(
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

        expect(accepted).toBe(false);
        expect(write).toHaveBeenCalledTimes(1);
        expect(await readRetainedWorkKinds(stores)).toEqual(['admit-control']);
        runtime.dispose();
    });

    it('reschedules an interrupted send so a new runtime can recover it', async () => {
        vi.useFakeTimers();
        const msg = createOutboundMessage('msg-dispose-during-effect');
        const stores = createDefaultOutboundTestStores();
        const sendStarted = Promise.withResolvers<void>();
        const sendCompleted = Promise.withResolvers<void>();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
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
        const leaseExpiresAt = await peekOutboundTestWork(stores);
        if (leaseExpiresAt === undefined) {
            throw new Error('Expected the in-flight send to retain its durable lease');
        }
        expect(leaseExpiresAt).toBeGreaterThan(Date.now());
        runtime.dispose();
        sendCompleted.resolve();
        await enqueue;
        await vi.advanceTimersByTimeAsync(0);
        // The failed attempt releases its own claim, so recovery waits on the retry, not the lease.
        const retryAt = await peekOutboundTestWork(stores);
        if (retryAt === undefined) {
            throw new Error('Expected the interrupted send to be rescheduled');
        }
        expect(retryAt).toBeLessThan(leaseExpiresAt);

        const recovered: string[] = [];
        const restarted = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async (prepared) => {
                recovered.push(String(prepared.msgId));

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] })
        });
        await restarted.ready();
        await vi.advanceTimersByTimeAsync(Math.max(0, retryAt - Date.now()));
        expect(recovered).toEqual([msg.id.msgId]);
        expect(await peekOutboundTestWork(stores)).toBeUndefined();
        restarted.dispose();
    });
});

async function peekOutboundTestWork(stores: OutboundTestStores): Promise<number | undefined> {
    return await peekOutboundWorkReadyAt(stores.workQueue, stores.admissionStore.namespace);
}

async function settleOutboundWork(stores: OutboundTestStores): Promise<void> {
    await waitForSettledOutboundWork(stores.workQueue, stores.admissionStore.namespace);
}

/** The claim release that reports a completed attempt fails once: the process dies before it lands. */
function failFirstCompletedRelease(stores: OutboundTestStores): void {
    const releaseEntries = stores.workQueue.releaseEntries.bind(stores.workQueue);
    let shouldFail = true;
    vi.spyOn(stores.workQueue, 'releaseEntries').mockImplementation(async (entries, disposition) => {
        if (shouldFail && disposition.status === EntityStatus.COMPLETED) {
            shouldFail = false;
            throw new Error('Completion storage unavailable');
        }
        return await releaseEntries(entries, disposition);
    });
}

/**
 * A runtime whose engine never ticks: its only batches are the one `ready()` runs and the one each
 * commit starts, so a test can observe both finishing before it changes what the queue will offer.
 */
function createUndrainedOutboundRuntime(
    stores: OutboundTestStores,
    sendPreparedMessage: ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['sendPreparedMessage']
): { runtime: ALOutboundMessageRuntime<OutboundTestPayload>; claimedCounts: number[]; } {
    const claimedCounts: number[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        queueEngine: new InboxOutboxEngine(),
        diagnostics: (event) => {
            if (event.kind === 'effect-drain') {
                claimedCounts.push(event.claimedCount);
            }
        },
        sendPreparedMessage,
        planOutgoingMessage: (plannedMsg) => ({
            msg: plannedMsg,
            persist: false,
            preparedMessages: [{ kind: 'send', msgId: plannedMsg.id.msgId }]
        })
    });
    return { runtime, claimedCounts };
}

async function hasAckTimeoutWork(
    stores: OutboundTestStores,
    entries: readonly ResourceEntry[]
): Promise<boolean> {
    const payloads = await Promise.all(
        entries
            .filter((entry) => entry.typeId === toALOutboundWorkType(stores.admissionStore.namespace))
            .map(async (entry) => (await stores.admissionStore.readWorkSnapshot(entry)).payload)
    );
    return payloads.some((payload) => payload.kind === 'ack-timeout');
}

async function readRetainedWorkKinds(stores: OutboundTestStores): Promise<readonly string[]> {
    const page = await stores.workQueue.readWorkPage({
        typeId: toALOutboundWorkType(stores.admissionStore.namespace),
        status: EntityStatus.NEW,
        maxToRead: 10,
        cursor: null
    });
    return await Promise.all(
        page.entries.map(async (entry) => (await stores.admissionStore.readWorkSnapshot(entry)).payload.kind)
    );
}
