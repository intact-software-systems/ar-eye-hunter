import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { createDefaultALOutboundDequeueResilience } from '@shared/alm/outbound/create-default-al-outbound-message-runtime.ts';
import {
    ALOutboundMessageRuntime,
    EntityStatus,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    QueueBoxUtilities
} from '@shared/mod.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    peekOutboundWorkReadyAt,
    reserveOutbox,
    waitUntil
} from './alm/outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './alm/outbound-test-payload.ts';

describe('ALOutboundMessageRuntime', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('replays a deferred send using its supplied store, clock, and queue engine', async () => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const admissionStore = stores.admissionStore;
        const sent: string[] = [];
        let nowMs = Date.now() + 1_000;
        vi.setSystemTime(nowMs);
        const queueEngine = new InboxOutboxEngine();
        const runtime = new ALOutboundMessageRuntime<OutboundTestPayload>({
            decodePreparedMessage: decodeOutboundTestPayload,
            admissionStore,
            workQueue: stores.workQueue,
            dequeue: { types: new Set<string>(), resilience: createDefaultALOutboundDequeueResilience() },
            effectWorkerId: 'injected-outbound-worker',
            clock: { nowMs: () => nowMs },
            queueEngine,
            ownsQueueEngine: false,
            browserLocks: undefined,
            random: () => 0,
            diagnostics: undefined,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [{ resourceId: msg.route.resourceId }] }),
            planDequeuedMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] }),
            afterDequeueAdmission: undefined,
            planRepairMessage: undefined,
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared.resourceId);
                return sent.length === 1 ? { status: 'not-ready', retryAfterMs: 25 } : { status: 'sent' };
            }
        });
        onTestFinished(() => runtime.dispose());

        await runtime.enqueueIfAbsent(createOutboundMessage('injected-retry'));
        await vi.advanceTimersByTimeAsync(0);
        expect(await peekOutboundWorkReadyAt(stores.workQueue, admissionStore.namespace)).toBe(nowMs + 25);
        nowMs += 24;
        vi.setSystemTime(nowMs);
        await queueEngine.executeOnce();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['injected-retry']);
        nowMs += 1;
        vi.setSystemTime(nowMs);
        await queueEngine.executeOnce();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual(['injected-retry', 'injected-retry']);
        expect(await peekOutboundWorkReadyAt(stores.workQueue, admissionStore.namespace)).toBeUndefined();
    });

    it.each([30_000, 30_001])('expires an asynchronous readiness settlement at %s ms without sending or acknowledging', async (elapsedMs) => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const admissionStore = stores.admissionStore;
        const release = vi.spyOn(stores.workQueue, 'releaseEntries');
        const settlement = Promise.withResolvers<{ status: 'not-ready'; retryAfterMs: number; }>();
        const send = vi.fn(async () => ({ status: 'queued' as const, settled: settlement.promise }));
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: send,
            planOutgoingMessage: (msg) => ({ msg, persist: false, preparedMessages: [{ kind: 'send' }] })
        });
        onTestFinished(() => runtime.dispose());
        const message = createOutboundMessage('async-expiry', { ttlMs: 30_000 });
        await runtime.enqueueIfAbsent(message);
        await vi.advanceTimersByTimeAsync(0);
        vi.setSystemTime(1_000 + elapsedMs);
        settlement.resolve({ status: 'not-ready', retryAfterMs: 60_000 });
        await vi.advanceTimersByTimeAsync(0);
        // A settlement past the deadline is dropped, never rescheduled.
        expect(release.mock.calls.map((call) => call[1].status)).toEqual([EntityStatus.COMPLETED]);
        expect(release.mock.calls[0]![0][0]!.audit.expiryTs.epochMilliseconds).toBe(31_000);
        expect(send).toHaveBeenCalledTimes(1);
        expect(await admissionStore.readReceiptState(message.id.msgId)).toBeUndefined();
        expect(await peekOutboundWorkReadyAt(stores.workQueue, admissionStore.namespace)).toBeUndefined();
    });

    it('returns no-route when the outbound planner drops enqueue', async () => {
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                dropReason: 'No route for outbound enqueue',
                msg: msg,
                persist: false,
                preparedMessages: []
            })
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('msg-dropped'));

        expect(result.status).toBe('no-route');
        expect(result.reason).toBe('No route for outbound enqueue');
        expect(result.entries).toEqual([]);
        runtime.dispose();
    });

    it('persists an outbox entry when enqueue has no prepared transport route', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: []
            })
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('msg-no-route'));

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(sent).toEqual([]);
        expect(await reserveOutbox(outbox)).toHaveLength(1);
        runtime.dispose();
    });

    it('returns accepted with a retained canonical fact for immediate prepared dispatch', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-immediate');

        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('accepted');
        expect(result.entries).toMatchObject([{ status: EntityStatus.COMPLETED }]);
        await expect.poll(() => sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        expect(await reserveOutbox(outbox)).toHaveLength(0);
        runtime.dispose();
    });

    it('stops invalidating the sender revision when acknowledgement ownership expires', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const stores = createDefaultOutboundTestStores();
        const admissionStore = stores.admissionStore;
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send' }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1']
                }
            })
        });
        const msg = createOutboundMessage('msg-owner-expiry', { ttlMs: 15_000 });

        await enqueueOutboundOrThrow(runtime, msg);

        const nextMessage = createOutboundMessage('next-message-for-same-sender');
        const plan = (msg: ALMessage) => ({ msg: msg, persist: false, preparedMessages: [] });
        const beforeAck = await admissionStore.readOutgoingMessage({ msg: nextMessage, planner: plan, observedCanonicalEntry: undefined, intent: 'enqueue' });
        await runtime.acceptControlMessage(newALAckControlMessage(
            { v: 2, msgId: 'control-owner-ack', ts: 1, senderId: 'peer-1' },
            {
                ackedMsgId: msg.id.msgId,
                fromPeerId: 'peer-1',
                toPeerId: 'self',
                status: 'accepted',
                observedAtEpochMs: 1
            }
        ));
        const afterAck = await admissionStore.readOutgoingMessage({ msg: nextMessage, planner: plan, observedCanonicalEntry: undefined, intent: 'enqueue' });
        expect(afterAck.clientRecord?.senderId).toBe('self');
        expect(afterAck.clientRecord).not.toEqual(beforeAck.clientRecord);

        vi.setSystemTime(new Date('2026-01-01T00:00:15.000Z'));
        const beforeLateAck = await admissionStore.readOutgoingMessage({
            msg: nextMessage,
            planner: plan,
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        await runtime.acceptControlMessage(newALAckControlMessage(
            { v: 2, msgId: 'control-late-ack', ts: 2, senderId: 'peer-1' },
            {
                ackedMsgId: msg.id.msgId,
                fromPeerId: 'peer-1',
                toPeerId: 'self',
                status: 'accepted',
                observedAtEpochMs: 2
            }
        ));
        const afterLateAck = await admissionStore.readOutgoingMessage({
            msg: nextMessage,
            planner: plan,
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        expect(afterLateAck.clientRecord).toEqual(beforeLateAck.clientRecord);
        runtime.dispose();
    });

    it('retries a not-ready transport after the requested delay across restart', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const stores = createDefaultOutboundTestStores();
        const admissionStore = stores.admissionStore;
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async () => ({
                status: 'not-ready',
                reason: 'RTC lane warming',
                retryAfterMs: 25
            }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-not-ready');
        const result = await runtime.enqueueIfAbsent(msg);
        await vi.advanceTimersByTimeAsync(0);

        expect(result.status).toBe('accepted');
        runtime.dispose();
        const restarted = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] })
        });
        await restarted.ready();
        await vi.advanceTimersByTimeAsync(24);
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual([msg.id.msgId]);
        await vi.advanceTimersByTimeAsync(500);
        expect(sent).toEqual([msg.id.msgId]);
        expect(await peekOutboundWorkReadyAt(stores.workQueue, admissionStore.namespace)).toBeUndefined();
        restarted.dispose();
    });

    it('does not replay a no-targets send after restart', async () => {
        vi.useFakeTimers();
        const stores = createDefaultOutboundTestStores();
        const admissionStore = stores.admissionStore;
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async () => ({
                status: 'no-targets',
                reason: 'solo room'
            }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('msg-no-targets'));
        await vi.advanceTimersByTimeAsync(0);

        expect(result.status).toBe('accepted');
        expect(await peekOutboundWorkReadyAt(stores.workQueue, admissionStore.namespace)).toBeUndefined();
        runtime.dispose();
        const restarted = createDefaultOutboundTestRuntime({
            stores,
            sendPreparedMessage: async () => {
                sent.push('replayed');

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({ msg: msg, persist: false, preparedMessages: [] })
        });
        await restarted.ready();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(sent).toEqual([]);
        restarted.dispose();
    });

    it('uses browser Web Locks around outbound commits when available', async () => {
        const requestLock = vi.fn(
            async <T>(
                _name: string,
                _options: { mode: 'exclusive'; },
                callback: () => Promise<T>
            ) => await callback()
        );
        vi.stubGlobal('navigator', {
            locks: {
                request: requestLock
            }
        });
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        await runtime.enqueueIfAbsent(createOutboundMessage('msg-web-lock'));

        expect(requestLock).toHaveBeenCalledWith(
            'rallar:al-outbound-commit:self',
            { mode: 'exclusive' },
            expect.any(Function)
        );
        runtime.dispose();
    });

    it('releases browser Web Locks before draining committed send effects', async () => {
        const events: string[] = [];
        const sendGate = Promise.withResolvers<void>();
        const requestLock = vi.fn(
            async <T>(
                _name: string,
                _options: { mode: 'exclusive'; },
                callback: () => Promise<T>
            ) => {
                events.push('lock-enter');
                const result = await callback();
                events.push('lock-exit');
                return result;
            }
        );
        vi.stubGlobal('navigator', {
            locks: {
                request: requestLock
            }
        });
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => {
                events.push('send-start');
                await sendGate.promise;
                events.push('send-end');

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        const enqueue = runtime.enqueueIfAbsent(createOutboundMessage('msg-web-lock-drain'));
        await waitUntil(() => events.includes('send-start'));

        expect(events).toEqual(['lock-enter', 'lock-exit', 'send-start']);
        // Admission returns before the send it committed, so the lock is never held across transport.
        expect((await enqueue).status).toBe('accepted');

        sendGate.resolve();
        await waitUntil(() => events.includes('send-end'));

        expect(events).toEqual(['lock-enter', 'lock-exit', 'send-start', 'send-end']);
        runtime.dispose();
    });

    it('waits for effects committed while another drain is running', async () => {
        const planned: string[] = [];
        const started: string[] = [];
        const firstGate = Promise.withResolvers<void>();
        const secondGate = Promise.withResolvers<void>();
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared) => {
                const resourceId = String(prepared.resourceId);
                started.push(resourceId);
                if (resourceId === 'msg-drain-first') {
                    await firstGate.promise;
                }
                if (resourceId === 'msg-drain-second') {
                    await secondGate.promise;
                }

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => {
                planned.push(msg.route.resourceId);
                return {
                    msg: msg,
                    persist: false,
                    preparedMessages: [{ kind: 'send', resourceId: msg.route.resourceId }]
                };
            }
        });

        const first = runtime.enqueueIfAbsent(createOutboundMessage('msg-drain-first'));
        await waitUntil(() => started.includes('msg-drain-first'));

        const second = await runtime.enqueueIfAbsent(createOutboundMessage('msg-drain-second'));

        expect(second.status).toBe('accepted');
        await waitUntil(() => planned.includes('msg-drain-second'));
        // The second send waits for the batch that is holding the first, and is not lost by it.
        expect(started).toEqual(['msg-drain-first']);

        firstGate.resolve();
        await waitUntil(() => started.includes('msg-drain-second'));

        secondGate.resolve();
        await first;
        expect(started).toEqual(['msg-drain-first', 'msg-drain-second']);
        runtime.dispose();
    });

    it('emits diagnostics for sender queue, browser lock, and effect drains', async () => {
        const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
        let nowMs = 0;
        const runtime = createDefaultOutboundTestRuntime({
            diagnostics: (event) => {
                diagnostics.push(event);
            },
            nowMs: () => {
                nowMs += 5;
                return nowMs;
            },
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        await runtime.enqueueIfAbsent(createOutboundMessage('msg-diagnostics'));

        await expect.poll(() => diagnostics.filter((event) => event.kind === 'effect-drain' && event.claimedCount === 1)).toHaveLength(1);
        expect(diagnostics.map((event) => event.kind)).toEqual(expect.arrayContaining([
            'sender-queue-wait',
            'browser-lock-wait',
            'browser-lock-hold',
            'effect-drain'
        ]));
        expect(diagnostics).toContainEqual(
            expect.objectContaining({
                kind: 'effect-drain',
                claimedCount: 1,
                completedCount: 1
            })
        );
        runtime.dispose();
    });

    it('returns an outbox entry when enqueue is persistent', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: true,
                preparedMessages: []
            })
        });
        const msg = createOutboundMessage('msg-persisted');

        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.key.topicId).toBe('AL_OUTBOUND_MESSAGE');
        const stored = await reserveOutbox(outbox);
        expect(stored).toHaveLength(1);
        expect(decodePersistedALMessage(stored[0]?.resource ?? '')).toMatchObject({
            id: {
                msgId: msg.id.msgId
            }
        });
        runtime.dispose();
    });

    it('returns duplicate with the existing outbox entry when a persistent message is enqueued twice', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: true,
                preparedMessages: []
            })
        });
        const msg = createOutboundMessage('msg-duplicate');

        const first = await runtime.enqueueIfAbsent(msg);
        const second = await runtime.enqueueIfAbsent(msg);

        expect(first.status).toBe('enqueued');
        expect(second.status).toBe('duplicate');
        expect(second.entry?.key).toEqual(first.entry?.key);
        expect(second.entries).toHaveLength(1);
        expect(await reserveOutbox(outbox)).toHaveLength(1);
        runtime.dispose();
    });

    it('returns superseded with no entries when an older superseded message is enqueued', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: true,
                preparedMessages: [],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.route.contextId}`
                }
            })
        });
        const newer = {
            ...createOutboundMessage('msg-supersedence-newer'),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 2
            }
        };
        const older = {
            ...createOutboundMessage('msg-supersedence-older'),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 1
            }
        };

        await enqueueOutboundOrThrow(runtime, newer);
        const superseded = await runtime.enqueueIfAbsent(older);

        expect(superseded.status).toBe('superseded');
        expect(superseded.entries).toEqual([]);
        const stored = await reserveOutbox(outbox);
        expect(stored).toHaveLength(1);
        expect(decodePersistedALMessage(stored[0]?.resource ?? '')).toMatchObject({
            id: {
                msgId: newer.id.msgId
            }
        });
        runtime.dispose();
    });

    it('triggers repair dispatches after acknowledgement timeouts', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
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
            planRepairMessage: async (msg, request) => ({
                msg: msg,
                persist: false,
                preparedMessages: [
                    {
                        kind: 'repair',
                        msgId: msg.id.msgId,
                        trigger: request.trigger
                    }
                ]
            })
        });

        const msg = createOutboundMessage('msg-timeout');

        await enqueueOutboundOrThrow(runtime, msg);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        await vi.advanceTimersByTimeAsync(102);

        expect(sent[1]).toMatchObject({
            kind: 'repair',
            msgId: msg.id.msgId,
            trigger: 'ack-timeout',
            phase: 'immediate'
        });

        await vi.advanceTimersByTimeAsync(102);
        expect(sent).toHaveLength(2);

        runtime.dispose();
    });

    it('stops pending acknowledgement timers when disposed', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                ackTracking: {
                    enabled: true,
                    timeoutMs: 100,
                    maxAttempts: 1,
                    expectedPeerIds: ['peer-1']
                }
            }),
            planRepairMessage: async (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId }]
            })
        });

        await enqueueOutboundOrThrow(runtime, createOutboundMessage('msg-dispose'));
        runtime.dispose();

        await vi.advanceTimersByTimeAsync(200);
        expect(sent).toHaveLength(1);
    });

    it('retransmits cached missing ordered messages when a gap nack arrives', async () => {
        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            })
        });

        const seq1 = {
            ...createOutboundMessage('msg-seq-1'),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 1
            }
        };
        const seq2 = {
            ...createOutboundMessage('msg-seq-2'),
            ordering: {
                orderingKey: 'conversation-1',
                epoch: 0,
                seq: 2
            }
        };

        await enqueueOutboundOrThrow(runtime, seq1);
        await enqueueOutboundOrThrow(runtime, seq2);

        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: seq2.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1,
                    orderingKey: toALOrderingTrackKey(seq1),
                    expectedSeq: 1,
                    missingSeqs: [1]
                }
            )
        );

        await expect.poll(() => sent.map((entry) => entry.msgId)).toEqual([
            seq1.id.msgId,
            seq2.id.msgId,
            seq1.id.msgId
        ]);
    });

    it('retries cached messages shortly after a not-yet-in-sync nack', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                retryTracking: {
                    enabled: true,
                    maxAttempts: 2,
                    retryDelayMs: 50
                }
            })
        });
        const msg = createOutboundMessage('msg-not-yet-in-sync');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-not-synced', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'not-yet-in-sync',
                    observedAtEpochMs: 1,
                    serverSnapshotVersion: 3
                }
            )
        );

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);

        await vi.advanceTimersByTimeAsync(49);
        expect(sent).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(3);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('admits a durable prepared attempt for a not-yet-in-sync retry without reopening the canonical fact', async () => {
        vi.useFakeTimers();

        const outbox = new InMemoryQueueBox(new Map());
        const sent: Array<OutboundTestPayload> = [];
        let persistRetry = false;
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
                persistRetry = true;

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) =>
                persistRetry
                    ? {
                        msg: msg,
                        persist: true,
                        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                        retryTracking: {
                            enabled: true,
                            maxAttempts: 2,
                            retryDelayMs: 50
                        }
                    }
                    : {
                        msg: msg,
                        persist: false,
                        preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                        retryTracking: {
                            enabled: true,
                            maxAttempts: 2,
                            retryDelayMs: 50
                        }
                    }
        });
        const msg = createOutboundMessage('msg-not-yet-in-sync-outbox');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-not-synced', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'not-yet-in-sync',
                    observedAtEpochMs: 1
                }
            )
        );
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(1);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        expect(await reserveOutbox(outbox)).toEqual([]);
        runtime.dispose();
    });

    it('coalesces duplicate not-yet-in-sync nacks while a retry is pending', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                retryTracking: {
                    enabled: true,
                    maxAttempts: 3,
                    retryDelayMs: 50
                }
            })
        });
        const msg = createOutboundMessage('msg-duplicate-not-yet-in-sync');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-not-synced-1', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'not-yet-in-sync',
                    observedAtEpochMs: 1
                }
            )
        );
        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-not-synced-2', ts: 2, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'not-yet-in-sync',
                    observedAtEpochMs: 2
                }
            )
        );
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(1);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('counts retransmission rounds rather than duplicate not-yet-in-sync nack deliveries', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                retryTracking: {
                    enabled: true,
                    maxAttempts: 2,
                    retryDelayMs: 50
                }
            })
        });
        const msg = createOutboundMessage('msg-duplicate-retry-budget');
        const nack = (serverSnapshotVersion = 1) =>
            newALNackControlMessage(
                {
                    v: 2,
                    msgId: `control-duplicate-not-synced-${serverSnapshotVersion}`,
                    ts: serverSnapshotVersion,
                    senderId: 'peer-1'
                },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'not-yet-in-sync',
                    observedAtEpochMs: serverSnapshotVersion,
                    serverSnapshotVersion
                }
            );

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(nack());
        await runtime.acceptControlMessage(nack());
        await runtime.acceptControlMessage(nack());
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(1);

        await runtime.acceptControlMessage(nack(2));
        await vi.advanceTimersByTimeAsync(50);
        await vi.advanceTimersByTimeAsync(1);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('retains immutable message rows while supersedence skips the older physical attempt', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: true,
                preparedMessages: [],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.route.contextId}`
                }
            })
        });

        const first = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-1',
                contextId: 'room-1'
            },
            'peer-1',
            'presence.state.v1',
            {
                online: true
            },
            { ttlMs: 30_000 }
        );
        const second = newALUnicastMessage(
            'self',
            {
                topicId: 'presence',
                resourceId: 'presence-2',
                contextId: 'room-1'
            },
            'peer-1',
            'presence.state.v1',
            {
                online: false
            },
            { ttlMs: 30_000 }
        );

        const [firstEntry] = await enqueueOutboundOrThrow(runtime, first);
        const [secondEntry] = await enqueueOutboundOrThrow(runtime, second);

        expect(secondEntry.key).not.toEqual(firstEntry.key);

        const reserved = await outbox.reserveEntries({ typeIds: new Set(['outbox']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 10 });

        expect(reserved.size).toBe(2);
        expect([...reserved.values()].map((entry) => decodePersistedALMessage(entry.resource).id.msgId).sort())
            .toEqual([first.id.msgId, second.id.msgId].sort());
    });

    it('serializes concurrent supersedence enqueues through the versioned sender record', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => ({ status: 'sent' as const }),
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: true,
                preparedMessages: [],
                supersedenceTracking: {
                    enabled: true,
                    algo: 'latest-wins',
                    key: `presence:${msg.id.senderId}:${msg.route.contextId}`
                }
            })
        });

        const first = {
            ...newALUnicastMessage(
                'self',
                {
                    topicId: 'presence',
                    resourceId: 'presence-1',
                    contextId: 'room-1'
                },
                'peer-1',
                'presence.state.v1',
                {
                    online: true
                },
                { ttlMs: 30_000 }
            ),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 1
            }
        };
        const second = {
            ...newALUnicastMessage(
                'self',
                {
                    topicId: 'presence',
                    resourceId: 'presence-2',
                    contextId: 'room-1'
                },
                'peer-1',
                'presence.state.v1',
                {
                    online: false
                },
                { ttlMs: 30_000 }
            ),
            ordering: {
                orderingKey: 'presence',
                epoch: 0,
                seq: 2
            }
        };

        await Promise.all([
            enqueueOutboundOrThrow(runtime, first),
            enqueueOutboundOrThrow(runtime, second)
        ]);

        const reserved = await outbox.reserveEntries({ typeIds: new Set(['outbox']), statusIds: new Set([EntityStatus.NEW]), reservationInput: 10 });
        expect(reserved.size).toBe(2);
        expect([...reserved.values()].map((entry) => decodePersistedALMessage(entry.resource).id.msgId).sort())
            .toEqual([first.id.msgId, second.id.msgId].sort());
    });

    it('does not miss acknowledgements that arrive while the send effect is running', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const sendStarted = Promise.withResolvers<void>();
        const sendCompleted = Promise.withResolvers<void>();
        const msg = createOutboundMessage('msg-ack-during-send');
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
                sendStarted.resolve();
                await sendCompleted.promise;

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

        const enqueue = enqueueOutboundOrThrow(runtime, msg);
        await sendStarted.promise;
        await runtime.acceptControlMessage(newALAckControlMessage(
            { v: 2, msgId: 'control-inflight-ack', ts: 1, senderId: 'peer-1' },
            {
                ackedMsgId: msg.id.msgId,
                fromPeerId: 'peer-1',
                toPeerId: 'self',
                status: 'accepted',
                observedAtEpochMs: 1
            }
        ));
        sendCompleted.resolve();
        await enqueue;
        await vi.advanceTimersByTimeAsync(200);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('does not resend successful prepared messages when a later prepared send fails', async () => {
        vi.useFakeTimers();

        const sent: string[] = [];
        let failPeer2 = true;
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared) => {
                if (prepared.peerId === 'peer-2' && failPeer2) {
                    failPeer2 = false;
                    throw new Error('peer-2 unavailable');
                }

                sent.push(String(prepared.peerId));

                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [
                    { peerId: 'peer-1' },
                    { peerId: 'peer-2' }
                ]
            })
        });

        await enqueueOutboundOrThrow(runtime, createOutboundMessage('msg-partial-send'));
        expect(sent).toEqual(['peer-1']);

        await vi.advanceTimersByTimeAsync(50);
        expect(sent).toEqual(['peer-1', 'peer-2']);
        runtime.dispose();
    });

    it('dispatches durable prepared repair work while retaining one completed canonical payload', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));
                return { status: 'sent' as const };
            },
            planOutgoingMessage: (msg) => ({
                msg: msg,
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            }),
            planRepairMessage: async (msg) => ({
                msg: msg,
                persist: true,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-persisted-repair');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage(
                { v: 2, msgId: 'control-persisted-gap', ts: 1, senderId: 'peer-1' },
                {
                    msgId: msg.id.msgId,
                    fromPeerId: 'peer-1',
                    toPeerId: 'self',
                    reason: 'gap',
                    observedAtEpochMs: 1
                }
            )
        );

        await expect.poll(() => sent.length).toBe(2);
        expect(sent).toEqual([msg.id.msgId, msg.id.msgId]);
        expect(await reserveOutbox(outbox)).toEqual([]);
    });
});
