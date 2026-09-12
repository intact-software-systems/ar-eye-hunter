import { Temporal } from '@js-temporal/polyfill';
import {
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { createInMemoryALAdmissionState, InMemoryAdmissionBackend } from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { decodeALInboundWorkEntry } from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import type { QueueBoxResourceEntryRepository } from '@shared/queuebox/queue-box-types.ts';
import { NonRetryableException } from '@shared/queuebox/resource-inbox/create-default-resource-inbox-dequeuer.ts';
import { EntityStatus, NOT_COMPLETED_RETRYABLE_STATUSES } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

interface ReadMessageWorkInput {
    readonly namespace: string;
    readonly backend: InMemoryAdmissionBackend;
    readonly trackKey: string;
    readonly msgId: string;
    readonly seq: number;
}

it('terminalizes a malformed reservation without starving independent timeout recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const engine = new InboxOutboxEngine();
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        queueEngine: engine,
        toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    let available = false;
    const delivered: string[] = [];
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        planIncomingMessage: (incoming, _source, observations) =>
            planALMessageHandling(incoming, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
        canDispatchMessage: () => available,
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async () => {},
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    for (const sequence of [1, 2]) {
        await runtime.admitIncomingMessage({ ...message(sequence), ordering: undefined }, { kind: 'ws-client', peerId: 'sender' });
    }
    const queue = resources.workQueue;
    const keys = await queue.getAllKeys();
    const first = (await queue.getItem(keys[0]))!;
    const claimed = await queue.reserveEntries({
        typeIds: new Set([first.typeId]),
        statusIds: new Set([EntityStatus.NEW]),
        reservationInput: { maxToReserve: 2, maxAttempts: 20 }
    });
    const [broken, sibling] = [...claimed.values()];
    expect(
        await queue.replaceIfObserved(broken, {
            ...broken,
            dequeueAudit: { ...broken.dequeueAudit, startTs: undefined }
        })
    ).not.toBeNull();
    available = true;
    vi.setSystemTime(Number(sibling.dequeueAudit.startTs!.epochMilliseconds) + 10_001);

    await expect.poll(async () => {
        await engine.executeOnce();
        return [await queue.getItem(broken.key), await queue.getItem(sibling.key)];
    }, { timeout: 1_000 }).toMatchObject([
        { status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1 } },
        { status: EntityStatus.COMPLETED, dequeueAudit: { attempts: 2 } }
    ]);
    expect(delivered).toEqual(['message-2']);
});

it('retries durable local delivery after restart with a single admission work owner', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const engine = new InboxOutboxEngine();
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        queueEngine: engine,
        toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    const attempts: string[] = [];
    const createRuntime = () =>
        new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage: (incoming, source, observations) =>
                planALMessageHandling(incoming, {
                    ...observations,
                    selfPeerId: 'receiver',
                    fromPeerId: source.kind === 'trusted-server' ? incoming.id.senderId : source.peerId
                }),
            dispatchInboxEntry: async (entry) => {
                attempts.push(decodePersistedALMessage(entry.resource).id.msgId);
                if (attempts.length === 1) {
                    throw new Error('Application temporarily unavailable');
                }
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
    const first = createRuntime();
    onTestFinished(() => first.dispose());
    const incoming: ALMessage = { ...message(1), ordering: undefined, qos: { durability: { algo: 'local-inbox' } } };

    await first.admitIncomingMessage(incoming, { kind: 'rtc-peer', peerId: 'sender' });

    await expect.poll(() => attempts).toEqual([incoming.id.msgId]);
    const keys = await resources.workQueue.getAllKeys();
    expect(keys).toHaveLength(1);
    const owner = (await resources.workQueue.getItem(keys[0]))!;
    expect(owner).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    first.dispose();

    vi.setSystemTime(owner.dequeueAudit.nextTs!.epochMilliseconds);
    const restarted = createRuntime();
    onTestFinished(() => restarted.dispose());
    await restarted.ready();
    await expect.poll(async () => {
        await engine.executeOnce();
        return resources.workQueue.getItem(owner.key);
    }).toMatchObject({ status: EntityStatus.COMPLETED, resource: owner.resource, dequeueAudit: { attempts: 2 } });
    expect(attempts).toEqual([incoming.id.msgId, incoming.id.msgId]);
});

it.each(['completed', 'retry', 'non-retryable'] as const)(
    'recovers an uncertain %s finalization through reservation timeout',
    async (outcome) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.restoreAllMocks();
            vi.useRealTimers();
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: engine,
            toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
        });
        vi.spyOn(resources.workQueue, 'releaseEntries').mockRejectedValueOnce(
            new Error('Queue finalization temporarily unavailable')
        );
        const deliveries: string[] = [];
        const createRuntime = () =>
            new ALInboundMessageRuntime({
                ...resources,
                planIncomingMessage: (incoming, _source, observations) =>
                    planALMessageHandling(incoming, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
                dispatchInboxEntry: async (entry) => {
                    deliveries.push(decodePersistedALMessage(entry.resource).id.msgId);
                    if (outcome === 'non-retryable') {
                        throw new NonRetryableException('Application rejects this message');
                    }
                    if (outcome === 'retry' && deliveries.length === 1) {
                        throw new Error('Application temporarily unavailable');
                    }
                },
                sendControlMessage: async () => {},
                diagnostics: undefined
            });
        const initial = createRuntime();
        onTestFinished(() => initial.dispose());
        await initial.admitIncomingMessage({ ...message(1), ordering: undefined }, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(() => deliveries).toEqual(['message-1']);
        const keys = await resources.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        const owner = (await resources.workQueue.getItem(keys[0]))!;
        expect(owner).toMatchObject({ status: EntityStatus.RESERVED, dequeueAudit: { attempts: 1 } });
        initial.dispose();

        vi.setSystemTime(Number(owner.dequeueAudit.startTs!.epochMilliseconds) + 10_001);
        const resumed = createRuntime();
        onTestFinished(() => resumed.dispose());
        await resumed.ready();
        await expect.poll(async () => {
            await engine.executeOnce();
            return resources.workQueue.getItem(owner.key);
        }).toMatchObject({
            status: outcome === 'non-retryable' ? EntityStatus.NON_RETRYABLE : EntityStatus.COMPLETED,
            resource: owner.resource,
            dequeueAudit: { attempts: 2, nextTs: undefined }
        });
        expect(deliveries).toEqual(['message-1', 'message-1']);
    }
);

it.each([
    { toPeerId: 'receiver', readDelayMs: 999, delivered: ['local:message-1'] },
    { toPeerId: 'receiver', readDelayMs: 1_000, delivered: [] },
    { toPeerId: 'receiver', readDelayMs: 1_001, delivered: [] },
    { toPeerId: 'next-hop', readDelayMs: 999, delivered: ['forward:message-1'] },
    { toPeerId: 'next-hop', readDelayMs: 1_000, delivered: [] },
    { toPeerId: 'next-hop', readDelayMs: 1_001, delivered: [] }
])('enforces the message deadline for $toPeerId after $readDelayMs ms inside the claim window', async ({ toPeerId, readDelayMs, delivered }) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    const admittedAt = Date.now();
    const resources = createDefaultALInboundRuntimeResources({
        selfPeerId: 'receiver',
        queueEngine: new InboxOutboxEngine(),
        toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
    });
    const reserve = resources.workQueue.reserveEntries.bind(resources.workQueue);
    vi.spyOn(resources.workQueue, 'reserveEntries').mockImplementation(async (request) => {
        const claimed = await reserve(request);
        if (claimed.size > 0) {
            // The eligibility read cleared this row before the claim; of everything it decided, only
            // the message's deadline is decided again, against the clock this moves.
            vi.setSystemTime(admittedAt + readDelayMs);
        }
        return claimed;
    });
    const deliveries: string[] = [];
    const runtime = new ALInboundMessageRuntime({
        ...resources,
        planIncomingMessage: (incoming, _source, observations) =>
            planALMessageHandling(incoming, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
        dispatchInboxEntry: async (entry) => {
            deliveries.push(`local:${decodePersistedALMessage(entry.resource).id.msgId}`);
        },
        forwardMessage: async (incoming) => {
            deliveries.push(`forward:${incoming.id.msgId}`);
        },
        sendControlMessage: async () => {},
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    const incoming: ALMessage = {
        ...message(1),
        ordering: undefined,
        targets: { mode: 'unicast', toPeerId },
        constraints: { expiresAtMs: admittedAt + 1_000 }
    };

    await runtime.admitIncomingMessage(incoming, { kind: 'ws-client', peerId: 'sender' });

    await waitForSettledWork(resources.workQueue);
    expect(deliveries).toEqual(delivered);
    expect(incoming.constraints?.expiresAtMs).toBe(admittedAt + 1_000);
});

it('retains predecessor completion through the longest admitted deadline across restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    const admittedAt = Date.now();
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const store = createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: 'retained-ordering-completion',
        backend,
        orderingTrackTtlMs: 100,
        supersedenceTrackTtlMs: 100,
        retention: normalizeALRuntimeStoreRetention({ bufferedMessageTtlMs: 50, durableEffectTtlMs: 500 })
    });
    const engine = new InboxOutboxEngine();
    const delivered: string[] = [];
    const createRuntime = () =>
        new ALInboundMessageRuntime({
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                stores: { admissionStore: store, workQueue: state.workQueue },
                queueEngine: engine,
                toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
            }),
            planIncomingMessage: (incoming, _source, observations) =>
                planALMessageHandling(incoming, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
            dispatchInboxEntry: async (entry) => {
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
    const initial = createRuntime();
    onTestFinished(() => initial.dispose());
    await initial.admitIncomingMessage(message(1), { kind: 'rtc-peer', peerId: 'sender' });
    await expect.poll(() => delivered).toEqual(['message-1']);
    const paused = vi.spyOn(state.workQueue, 'reserveEntries').mockResolvedValue(new Map());
    await initial.admitIncomingMessage({ ...message(2), constraints: { expiresAtMs: admittedAt + 10_000 } }, { kind: 'rtc-peer', peerId: 'sender' });
    await initial.admitIncomingMessage(message(3), { kind: 'rtc-peer', peerId: 'sender' });
    initial.dispose();
    paused.mockRestore();
    vi.setSystemTime(admittedAt + 1_000);
    const resumed = createRuntime();
    onTestFinished(() => resumed.dispose());
    await resumed.ready();
    await expect.poll(async () => {
        await engine.executeOnce();
        return delivered;
    }).toEqual(['message-1', 'message-2']);
    expect(await store.readOrderedDelivery(toALOrderingTrackKey(message(2))!, 3)).toEqual({
        completedThrough: 2,
        predecessor: undefined
    });
    vi.setSystemTime(admittedAt + 10_001);
    expect((await store.readOrderedDelivery(toALOrderingTrackKey(message(2))!, 3)).completedThrough).toBe(0);
});

it.each(['before-delivery', 'during-delivery'] as const)('does not reconstruct lost ordering evidence %s', async (loss) => {
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: `lost-progress-${loss}`,
        backend,
        orderingTrackTtlMs: 100,
        supersedenceTrackTtlMs: 100,
        retention: normalizeALRuntimeStoreRetention({ durableEffectTtlMs: 500 })
    });
    const engine = new InboxOutboxEngine();
    const trackKey = toALOrderingTrackKey(message(1))!;
    const progressKey = `${store.namespace}:delivered:${trackKey}`;
    let available = false;
    const delivered: string[] = [];
    const controls: ALMessage[] = [];
    const runtime = new ALInboundMessageRuntime({
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            stores: { admissionStore: store, workQueue: backend.workQueue },
            queueEngine: engine,
            toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
        }),
        planIncomingMessage: (incoming, _source, observations) =>
            planALMessageHandling(incoming, { ...observations, selfPeerId: 'receiver', fromPeerId: 'sender' }),
        canDispatchMessage: () => available,
        dispatchInboxEntry: async (entry) => {
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            await backend.write(async (tx) => await tx.remove(progressKey));
        },
        sendControlMessage: async (control) => {
            controls.push(control);
        },
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    for (const sequence of [1, 2]) {
        await runtime.admitIncomingMessage({ ...message(sequence), constraints: { expiresAtMs: Date.now() + 10_000 } }, {
            kind: 'ws-client',
            peerId: 'sender'
        });
    }
    if (loss === 'before-delivery') {
        await backend.write(async (tx) => await tx.remove(progressKey));
    }
    available = true;

    await expect.poll(async () => {
        await engine.executeOnce();
        return controls.map((control) => decodeALControlMessage(control).right);
    }).toContainEqual(expect.objectContaining({ type: 'nack', payload: expect.objectContaining({ reason: 'resync-required' }) }));
    expect(delivered).toEqual(loss === 'during-delivery' ? ['message-1'] : []);
    const remaining = await store.readBufferedRelease({ trackKey, seq: 2, nowMs: Date.now() });
    expect(remaining).toBeDefined();
    expect(remaining?.observations.deliveryProgress?.value).toBeUndefined();
});

it.each(['volatile', 'local-inbox'] as const)('keeps one buffered work owner across %s delivery retries', async (durability) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });
    const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
    const store = createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: `buffered-owner-${durability}`,
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const delivered: string[] = [];
    const failedAttemptReleased = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    onTestFinished(() => resume.resolve());
    const release = backend.workQueue.releaseEntries.bind(backend.workQueue);
    vi.spyOn(backend.workQueue, 'releaseEntries').mockImplementation(async (entries, disposition) => {
        const released = await release(entries, disposition);
        if (disposition.status === EntityStatus.RETRY) {
            failedAttemptReleased.resolve();
            await resume.promise;
        }
        return released;
    });
    let available = false;
    const runtime = new ALInboundMessageRuntime({
        ...createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            stores: { admissionStore: store, workQueue: backend.workQueue },
            toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox')
        }),

        planIncomingMessage: (incoming, source, observations) =>
            planALMessageHandling(incoming, {
                ...observations,
                selfPeerId: 'receiver',
                fromPeerId: source.kind === 'trusted-server' ? incoming.id.senderId : source.peerId
            }),
        dispatchInboxEntry: async (entry) => {
            if (!available && entry.key.resourceId === 'message-2') {
                throw new Error('Application temporarily unavailable');
            }
            delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
        },
        sendControlMessage: async () => {},
        diagnostics: undefined
    });
    onTestFinished(() => runtime.dispose());
    const second: ALMessage = { ...message(2), qos: { durability: { algo: durability } } };
    await runtime.admitIncomingMessage(second, { kind: 'rtc-peer', peerId: 'sender' });
    const admittedFirst = runtime.admitIncomingMessage(message(1), { kind: 'rtc-peer', peerId: 'sender' });
    const trackKey = toALOrderingTrackKey(second)!;
    await failedAttemptReleased.promise;
    const work = await readMessageWork({ namespace: store.namespace, backend, trackKey, msgId: second.id.msgId, seq: 2 });
    expect(work).toHaveLength(1);
    const owner = work[0].entry;
    expect(owner).toMatchObject({ status: EntityStatus.RETRY, dequeueAudit: { attempts: 1 } });
    expect(delivered).toEqual(['message-1']);

    available = true;
    vi.setSystemTime(Date.now() + 10_001);
    resume.resolve();
    await admittedFirst;
    await expect.poll(async () => {
        return (await backend.workQueue.getItem(owner.key))?.status;
    }).toBe(EntityStatus.COMPLETED);
    expect(await backend.workQueue.getItem(owner.key)).toMatchObject({
        resource: owner.resource,
        dequeueAudit: { attempts: 2 }
    });
    expect(delivered).toEqual(['message-1', 'message-2']);
    expect((await store.readOrderedDelivery(trackKey, 3)).completedThrough).toBe(2);
});

it.each(['FAILED', 'NON_RETRYABLE', 'expired', 'missing', 'malformed'] as const)(
    'requests resynchronization after a %s predecessor and still delivers independent work',
    async (failure) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const backend = new InMemoryAdmissionBackend(createInMemoryALAdmissionState(), Date.now);
        const store = createALInboundAdmissionStore({
            nowMs: Date.now,
            namespace: `predecessor-${failure}`,
            backend,
            orderingTrackTtlMs: 60_000,
            supersedenceTrackTtlMs: 60_000,
            retention: normalizeALRuntimeStoreRetention()
        });
        const engine = new InboxOutboxEngine();
        const controls: ALMessage[] = [];
        const delivered: string[] = [];
        let available = false;
        const runtime = new ALInboundMessageRuntime({
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                stores: { admissionStore: store, workQueue: backend.workQueue },
                queueEngine: engine,
                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
            }),

            planIncomingMessage: (message, source, observations) =>
                planALMessageHandling(message, {
                    ...observations,
                    selfPeerId: 'receiver',
                    fromPeerId: source.kind === 'trusted-server' ? message.id.senderId : source.peerId
                }),
            dispatchInboxEntry: async (entry) => {
                if (!available) {
                    return 'retry';
                }
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async (control) => {
                controls.push(control);
            },
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        await runtime.admitIncomingMessage(message(1), { kind: 'rtc-peer', peerId: 'sender' });
        const keys = await backend.workQueue.getAllKeys();
        expect(keys).toHaveLength(1);
        const predecessor = (await backend.workQueue.getItem(keys[0]))!;
        if (failure === 'missing') {
            await backend.workQueue.removeItem(predecessor.key);
        }
        else {
            expect(
                await backend.workQueue.replaceIfObserved(predecessor, {
                    ...predecessor,
                    status: failure === 'FAILED' || failure === 'NON_RETRYABLE' ? failure : predecessor.status,
                    resource: failure === 'malformed' ? '{invalid-json' : predecessor.resource,
                    audit: failure === 'expired'
                        ? { ...predecessor.audit, expiryTs: Temporal.Instant.fromEpochMilliseconds(Date.now() - 1) }
                        : predecessor.audit,
                    dequeueAudit: { ...predecessor.dequeueAudit, nextTs: undefined }
                })
            ).not.toBeNull();
        }
        vi.setSystemTime(Date.now() + 10_001);
        if (failure === 'malformed') {
            await expect.poll(async () => {
                await engine.executeOnce();
                return (await backend.workQueue.getItem(predecessor.key))?.status;
            }).toBe(EntityStatus.NON_RETRYABLE);
        }
        available = true;
        await runtime.admitIncomingMessage(message(2), { kind: 'rtc-peer', peerId: 'sender' });
        const independent = { ...message(3), ordering: undefined };
        await runtime.admitIncomingMessage(independent, { kind: 'rtc-peer', peerId: 'sender' });
        await expect.poll(async () => {
            await engine.executeOnce();
            return controls.map((control) => decodeALControlMessage(control).right);
        }).toContainEqual(expect.objectContaining({
            type: 'nack',
            payload: expect.objectContaining({ msgId: 'message-2', reason: 'resync-required', missingSeqs: [] })
        }));
        await expect.poll(async () => {
            await engine.executeOnce();
            return [...delivered];
        }).toEqual(['message-3']);
    }
);

it('keeps waiting ordered work unclaimed and drains all 256 messages after restart', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const state = createInMemoryALAdmissionState();
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    const store = createALInboundAdmissionStore({
        nowMs: Date.now,
        namespace: 'ordered-restart',
        backend,
        orderingTrackTtlMs: 60_000,
        supersedenceTrackTtlMs: 60_000,
        retention: normalizeALRuntimeStoreRetention()
    });
    const delivered: number[] = [];
    let unavailable = true;
    const createRuntime = () => {
        const engine = new InboxOutboxEngine();
        const runtime = new ALInboundMessageRuntime({
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                stores: { admissionStore: store, workQueue: state.workQueue },
                queueEngine: engine,
                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
            }),

            planIncomingMessage: (message, source, observations) =>
                planALMessageHandling(message, {
                    ...observations,
                    selfPeerId: 'receiver',
                    fromPeerId: source.kind === 'trusted-server' ? message.id.senderId : source.peerId
                }),
            dispatchInboxEntry: async (entry) => {
                if (unavailable) {
                    return 'retry';
                }
                delivered.push(decodePersistedALMessage(entry.resource).ordering!.seq!);
            },
            sendControlMessage: async () => {},
            diagnostics: undefined
        });
        onTestFinished(() => runtime.dispose());
        return { runtime, engine };
    };
    const first = createRuntime();
    for (let sequence = 2; sequence <= 256; sequence++) {
        expect((await first.runtime.admitIncomingMessage(message(sequence), { kind: 'rtc-peer', peerId: 'sender' })).right?.kind)
            .toBe('admitted');
    }
    expect((await first.runtime.admitIncomingMessage(message(1), { kind: 'rtc-peer', peerId: 'sender' })).right?.kind)
        .toBe('admitted');

    for (let cycle = 0; cycle < 30; cycle++) {
        await first.engine.executeOnce();
    }
    expect(delivered).toEqual([]);
    const work = await backend.workQueue.getAllKeys();
    expect(work.length).toBeGreaterThanOrEqual(256);
    const waiting = [];
    for (const key of work) {
        const entry = await backend.workQueue.getItem(key);
        if (entry?.status === EntityStatus.NEW) {
            waiting.push(entry);
        }
    }
    expect(waiting.length).toBeGreaterThanOrEqual(255);
    expect(waiting.every((entry) => entry.dequeueAudit.attempts === 0)).toBe(true);
    first.runtime.dispose();

    unavailable = false;
    vi.setSystemTime(Date.now() + 10_001);
    const restarted = createRuntime();
    await restarted.runtime.ready();
    await expect.poll(async () => {
        await restarted.engine.executeOnce();
        return [...delivered];
    }, { timeout: 30_000, interval: 5 }).toEqual(Array.from({ length: 256 }, (_, index) => index + 1));
    await expect.poll(async () => {
        return (await store.readOrderedDelivery(toALOrderingTrackKey(message(1))!, 257)).completedThrough;
    }).toBe(256);
    restarted.runtime.dispose();
    backend.workQueue.cleanup();

    const afterCleanup = createRuntime();
    await afterCleanup.runtime.admitIncomingMessage(message(257), { kind: 'rtc-peer', peerId: 'sender' });
    await expect.poll(() => delivered).toEqual(Array.from({ length: 257 }, (_, index) => index + 1));
}, 45_000);

/** The worker no longer drains inside admission: wait for every retained row to reach a terminal status. */
async function waitForSettledWork(workQueue: QueueBoxResourceEntryRepository): Promise<void> {
    await expect.poll(async () => {
        const entries = await Promise.all(
            (await workQueue.getAllKeys()).map((key) => workQueue.getItem(key))
        );
        return entries.every((entry) => entry === undefined || !NOT_COMPLETED_RETRYABLE_STATUSES.has(entry.status));
    }).toBe(true);
}

async function readMessageWork(input: ReadMessageWorkInput) {
    const work = [];
    for (const key of await input.backend.workQueue.getAllKeys()) {
        const entry = await input.backend.workQueue.getItem(key);
        if (entry === undefined) {
            continue;
        }
        const effect = decodeALInboundWorkEntry(entry, input.namespace);
        const payload = effect.payload;
        if (
            (payload.kind === 'release-buffered' && payload.trackKey === input.trackKey && payload.seq === input.seq) ||
            (payload.kind === 'dispatch-local' && payload.message.msgId === input.msgId)
        ) {
            work.push(effect);
        }
    }
    return work;
}

function message(sequence: number): ALMessage {
    return {
        id: { v: 2, msgId: `message-${sequence}`, senderId: 'sender', ts: Date.now() },
        route: { topicId: 'ordered-chat', resourceId: `message-${sequence}`, contextId: 'room' },
        targets: { mode: 'unicast', toPeerId: 'receiver' },
        ordering: { orderingKey: 'ordered-chat', seq: sequence },
        delivery: { reliability: 'best-effort', ack: 'none' },
        payload: { typeId: 'text', resource: '"hello"' }
    };
}
