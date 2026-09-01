import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    ALOutboundMessageRuntime,
    EntityStatus,
    InMemoryQueueBox,
    newALAckControlMessage,
    newALNackControlMessage,
    newALUnicastMessage,
    QueueBoxUtilities
} from '@shared/mod.ts';

import {
    createDefaultOutboundTestAdmissionStore,
    createDefaultOutboundTestRuntime,
    createOutboundMessage,
    enqueueOutboundOrThrow,
    firstValue,
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

    it('replays a deferred send using its supplied store, clock, and scheduler', async () => {
        vi.useFakeTimers();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sent: string[] = [];
        let nowMs = Date.now() + 1_000;
        const runtime = new ALOutboundMessageRuntime<OutboundTestPayload>({
            decodePreparedMessage: decodeOutboundTestPayload,
            admissionStore,
            effectWorkerId: 'injected-outbound-worker',
            clock: { nowMs: () => nowMs },
            scheduler: {
                schedule: (callback, delayMs) => {
                    const timer = setTimeout(callback, delayMs * 2);
                    return () => clearTimeout(timer);
                }
            },
            browserLocks: undefined,
            outbox: new InMemoryQueueBox(new Map()),
            diagnostics: undefined,
            toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox'),
            readMessageFromEntry: (entry) => decodePersistedALMessage(entry.resource),
            planOutgoingMessage: (msg) => ({ persist: false, preparedMessages: [{ resourceId: msg.route.resourceId }] }),
            planDequeuedMessage: () => ({ persist: false, preparedMessages: [] }),
            beforeDequeueDispatch: undefined,
            planRepairMessage: undefined,
            onFallbackDequeue: undefined,
            sendPreparedMessage: async (prepared) => {
                sent.push(prepared.resourceId);
                return sent.length === 1 ? { status: 'not-ready', retryAfterMs: 25 } : { status: 'sent' };
            }
        });
        onTestFinished(() => runtime.dispose());

        await runtime.enqueueIfAbsent(createOutboundMessage('injected-retry'));
        expect(await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBe(nowMs + 25);
        nowMs += 25;
        await vi.advanceTimersByTimeAsync(25);
        expect(sent).toEqual(['injected-retry']);
        await vi.advanceTimersByTimeAsync(25);
        expect(sent).toEqual(['injected-retry', 'injected-retry']);
        expect(await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
    });

    it('returns no-route when the outbound planner drops enqueue', async () => {
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                dropReason: 'No route for outbound enqueue',
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
            },
            planOutgoingMessage: () => ({
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

    it('returns sent-immediate with no entries for immediate prepared dispatch', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-immediate');

        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        expect(result.entries).toEqual([]);
        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        expect(await reserveOutbox(outbox)).toHaveLength(0);
        runtime.dispose();
    });

    it('stops invalidating the sender revision when acknowledgement ownership expires', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });
        const msg = createOutboundMessage('msg-owner-expiry', { ttlMs: 15_000 });

        await enqueueOutboundOrThrow(runtime, msg);

        const nextMessage = createOutboundMessage('next-message-for-same-sender');
        const plan = () => ({ persist: false, preparedMessages: [] });
        const beforeAck = await admissionStore.readOutgoingMessage(nextMessage, plan);
        await runtime.acceptControlMessage(newALAckControlMessage('peer-1', 'self', msg.id.msgId));
        const afterAck = await admissionStore.readOutgoingMessage(nextMessage, plan);
        expect(afterAck.clientRecord?.senderId).toBe('self');
        expect(afterAck.clientRecord).not.toEqual(beforeAck.clientRecord);

        vi.setSystemTime(new Date('2026-01-01T00:00:15.000Z'));
        const beforeLateAck = await admissionStore.readOutgoingMessage(nextMessage, plan);
        await runtime.acceptControlMessage(newALAckControlMessage('peer-1', 'self', msg.id.msgId));
        const afterLateAck = await admissionStore.readOutgoingMessage(nextMessage, plan);
        expect(afterLateAck.clientRecord).toEqual(beforeLateAck.clientRecord);
        runtime.dispose();
    });

    it('retries a not-ready transport after the requested delay across restart', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async () => ({
                status: 'not-ready',
                reason: 'RTC lane warming',
                retryAfterMs: 25
            }),
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }]
            })
        });
        const msg = createOutboundMessage('msg-not-ready');
        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('sent-immediate');
        runtime.dispose();
        const restarted = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async (prepared) => {
                sent.push(String(prepared.msgId));
            },
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [] })
        });
        await restarted.ready();
        await vi.advanceTimersByTimeAsync(24);
        expect(sent).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual([msg.id.msgId]);
        await vi.advanceTimersByTimeAsync(500);
        expect(sent).toEqual([msg.id.msgId]);
        expect(await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
        restarted.dispose();
    });

    it('does not replay a no-targets send after restart', async () => {
        vi.useFakeTimers();
        const admissionStore = createDefaultOutboundTestAdmissionStore();
        const sent: string[] = [];
        const runtime = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async () => ({
                status: 'no-targets',
                reason: 'solo room'
            }),
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        const result = await runtime.enqueueIfAbsent(createOutboundMessage('msg-no-targets'));

        expect(result.status).toBe('sent-immediate');
        expect(await admissionStore.peekNextEffectReadyAt(decodeOutboundTestPayload)).toBeUndefined();
        runtime.dispose();
        const restarted = createDefaultOutboundTestRuntime({
            stores: { admissionStore },
            sendPreparedMessage: async () => {
                sent.push('replayed');
            },
            planOutgoingMessage: () => ({ persist: false, preparedMessages: [] })
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
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
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
            },
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        const enqueue = runtime.enqueueIfAbsent(createOutboundMessage('msg-web-lock-drain'));
        await waitUntil(() => events.includes('send-start'));

        expect(events).toEqual(['lock-enter', 'lock-exit', 'send-start']);
        let settled = false;
        void enqueue.then(() => {
            settled = true;
        });
        await Promise.resolve();
        expect(settled).toBe(false);

        sendGate.resolve();
        await enqueue;

        expect(events).toEqual(['lock-enter', 'lock-exit', 'send-start', 'send-end']);
        expect(settled).toBe(true);
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
            },
            planOutgoingMessage: (msg) => {
                planned.push(msg.route.resourceId);
                return {
                    persist: false,
                    preparedMessages: [{ kind: 'send', resourceId: msg.route.resourceId }]
                };
            }
        });

        const first = runtime.enqueueIfAbsent(createOutboundMessage('msg-drain-first'));
        await waitUntil(() => started.includes('msg-drain-first'));

        const second = runtime.enqueueIfAbsent(createOutboundMessage('msg-drain-second'));
        let secondSettled = false;
        void second.then(() => {
            secondSettled = true;
        });

        await waitUntil(() => planned.includes('msg-drain-second'));
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        firstGate.resolve();
        await waitUntil(() => started.includes('msg-drain-second'));
        await Promise.resolve();
        expect(secondSettled).toBe(false);

        secondGate.resolve();
        await Promise.all([first, second]);
        expect(secondSettled).toBe(true);
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
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: false,
                preparedMessages: [{ kind: 'send' }]
            })
        });

        await runtime.enqueueIfAbsent(createOutboundMessage('msg-diagnostics'));

        const eventKinds = diagnostics.map((event) => event.kind);
        expect(eventKinds).toEqual(expect.arrayContaining([
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
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: true,
                preparedMessages: []
            })
        });
        const msg = createOutboundMessage('msg-persisted');

        const result = await runtime.enqueueIfAbsent(msg);

        expect(result.status).toBe('enqueued');
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]?.key.resourceId).toBe('msg-persisted');
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
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: () => ({
                persist: true,
                preparedMessages: []
            })
        });
        const msg = createOutboundMessage('msg-duplicate');

        const first = await runtime.enqueueIfAbsent(msg);
        const second = await runtime.enqueueIfAbsent(msg);

        expect(first.status).toBe('enqueued');
        expect(second.status).toBe('duplicate');
        expect(second.entry?.key.resourceId).toBe('msg-duplicate');
        expect(second.entries).toHaveLength(1);
        expect(await reserveOutbox(outbox)).toHaveLength(1);
        runtime.dispose();
    });

    it('returns superseded with no entries when an older superseded message is enqueued', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
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
            },
            planOutgoingMessage: (msg) => ({
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

        await vi.advanceTimersByTimeAsync(100);

        expect(sent[1]).toMatchObject({
            kind: 'repair',
            msgId: msg.id.msgId,
            trigger: 'ack-timeout',
            phase: 'immediate'
        });

        await vi.advanceTimersByTimeAsync(100);
        expect(sent).toHaveLength(2);

        runtime.dispose();
    });

    it('stops pending acknowledgement timers when disposed', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
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
            },
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: {
                    enabled: false,
                    algo: 'none',
                    maxAttempts: 0
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
            newALNackControlMessage('peer-1', 'self', seq2.id.msgId, 'gap', {
                status: 'gap',
                trackKey: toALOrderingTrackKey(seq1),
                seq: 2,
                expectedSeq: 1,
                lastContiguousSeq: 0,
                missingSeqs: [1],
                releasableSeqs: []
            })
        );

        expect(sent.map((entry) => entry.msgId)).toEqual([
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
            },
            planOutgoingMessage: (msg) => ({
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
                'server-1',
                'self',
                msg.id.msgId,
                'not-yet-in-sync',
                undefined,
                {
                    serverSnapshotVersion: 3
                }
            )
        );

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

    it('can re-enter the outbox for a not-yet-in-sync retry when planning requires durability', async () => {
        vi.useFakeTimers();

        const outbox = new InMemoryQueueBox(new Map());
        const sent: Array<OutboundTestPayload> = [];
        let persistRetry = false;
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
                persistRetry = true;
            },
            planOutgoingMessage: (msg) =>
                persistRetry
                    ? {
                        persist: true,
                        preparedMessages: [],
                        retryTracking: {
                            enabled: true,
                            maxAttempts: 2,
                            retryDelayMs: 50
                        }
                    }
                    : {
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
            newALNackControlMessage('server-1', 'self', msg.id.msgId, 'not-yet-in-sync')
        );
        await vi.advanceTimersByTimeAsync(50);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10
        );
        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = decodePersistedALMessage(stored.resource);
        expect(storedMsg.id.msgId).toBe(msg.id.msgId);
        runtime.dispose();
    });

    it('coalesces duplicate not-yet-in-sync nacks while a retry is pending', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
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
            newALNackControlMessage('server-1', 'self', msg.id.msgId, 'not-yet-in-sync')
        );
        await runtime.acceptControlMessage(
            newALNackControlMessage('server-1', 'self', msg.id.msgId, 'not-yet-in-sync')
        );
        await vi.advanceTimersByTimeAsync(50);

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
            },
            planOutgoingMessage: (msg) => ({
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
        const nack = () => newALNackControlMessage(
            'server-1',
            'self',
            msg.id.msgId,
            'not-yet-in-sync'
        );

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(nack());
        await runtime.acceptControlMessage(nack());
        await runtime.acceptControlMessage(nack());
        await vi.advanceTimersByTimeAsync(50);

        await runtime.acceptControlMessage(nack());
        await vi.advanceTimersByTimeAsync(50);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' },
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('reuses the prior outbox key when supersedence replaces a persisted message', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
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
            }
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
            }
        );

        const [firstEntry] = await enqueueOutboundOrThrow(runtime, first);
        const [secondEntry] = await enqueueOutboundOrThrow(runtime, second);

        expect(secondEntry.key).toEqual(firstEntry.key);

        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10
        );

        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = decodePersistedALMessage(stored.resource);
        expect(storedMsg.id.msgId).toBe(second.id.msgId);
    });

    it('serializes concurrent supersedence enqueues through the versioned sender record', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
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
                }
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
                }
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

        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10
        );
        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = decodePersistedALMessage(stored.resource);
        expect(storedMsg.id.msgId).toBe(second.id.msgId);
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

        const enqueue = enqueueOutboundOrThrow(runtime, msg);
        await sendStarted.promise;
        await runtime.acceptControlMessage(newALAckControlMessage('peer-1', 'self', msg.id.msgId));
        sendCompleted.resolve();
        await enqueue;
        await vi.advanceTimersByTimeAsync(200);

        expect(sent).toEqual([
            { kind: 'send', msgId: msg.id.msgId, phase: 'immediate' }
        ]);
        runtime.dispose();
    });

    it('uses a stored acknowledgement accepted before outbound tracking is created', async () => {
        vi.useFakeTimers();

        const sent: Array<OutboundTestPayload> = [];
        const runtime = createDefaultOutboundTestRuntime({
            sendPreparedMessage: async (prepared, phase) => {
                sent.push({ ...prepared, phase });
            },
            planOutgoingMessage: (msg) => ({
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
                persist: false,
                preparedMessages: [{ kind: 'repair', msgId: msg.id.msgId, trigger: request.trigger }]
            })
        });
        const msg = createOutboundMessage('msg-ack-before-send');

        await runtime.acceptControlMessage(
            newALAckControlMessage('peer-1', 'self', msg.id.msgId)
        );
        await enqueueOutboundOrThrow(runtime, msg);
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
            },
            planOutgoingMessage: () => ({
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

    it('persists repair dispatches when the repair planner requests outbox durability', async () => {
        const outbox = new InMemoryQueueBox(new Map());
        const runtime = createDefaultOutboundTestRuntime({
            outbox,
            sendPreparedMessage: async () => Promise.resolve(),
            planOutgoingMessage: (msg) => ({
                persist: false,
                preparedMessages: [{ kind: 'send', msgId: msg.id.msgId }],
                repairTracking: {
                    enabled: true,
                    algo: 'retransmit',
                    maxAttempts: 1
                }
            }),
            planRepairMessage: async () => ({
                persist: true,
                preparedMessages: []
            })
        });
        const msg = createOutboundMessage('msg-persisted-repair');

        await enqueueOutboundOrThrow(runtime, msg);
        await runtime.acceptControlMessage(
            newALNackControlMessage('peer-1', 'self', msg.id.msgId, 'gap')
        );

        const reserved = await outbox.reserveEntries(
            new Set(['outbox']),
            new Set([EntityStatus.NEW]),
            10
        );
        expect(reserved.size).toBe(1);
        const stored = firstValue(reserved);
        const storedMsg = decodePersistedALMessage(stored.resource);
        expect(storedMsg.id.msgId).toBe(msg.id.msgId);
    });
});
