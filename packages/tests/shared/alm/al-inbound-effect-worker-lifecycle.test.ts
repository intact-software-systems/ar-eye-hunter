import { Temporal } from '@js-temporal/polyfill';
import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import {
    planALMessageHandling,
    type ALMessageHandlingPlan,
    type ALMessagePlanningObservations
} from '@shared/al-contracts/al-policy.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import type { ALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import {
    computeALInboundWorkEntry,
    decodeALInboundWorkEntry,
    toALInboundWorkKey,
    toALInboundWorkType
} from '@shared/alm/inbound/al-inbound-work-entry.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { InboxOutboxEngine } from '@shared/services/InboxOutboxEngine.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

describe('inbound durable effect worker lifecycle', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retries persisted effects after a transient claim failure', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        await resources.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(resources.admissionStore, message)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp: Number.MAX_SAFE_INTEGER
            }],
            durableEffects: [computeALInboundWorkEntry({
                namespace: resources.admissionStore.namespace,
                observedAtMs: Date.now(),
                effectId: 'persisted-dispatch',
                expireAtTimestamp: Date.now() + 60_000,
                payload: {
                    kind: 'dispatch-local',
                    entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
                }
            })]
        });
        const claimReadyEffects = resources.admissionStore.claimReadyEffects.bind(resources.admissionStore);
        let shouldFailClaim = true;
        vi.spyOn(resources.admissionStore, 'claimReadyEffects').mockImplementation(async (input) => {
            if (shouldFailClaim) {
                shouldFailClaim = false;
                throw new Error('Admission backend temporarily unavailable');
            }
            return await claimReadyEffects(input);
        });
        const deliveredMessageIds: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        });
        try {
            await runtime.ready();

            expect(deliveredMessageIds).toEqual([]);

            await expect.poll(() => deliveredMessageIds).toEqual([message.id.msgId]);
        }
        finally {
            runtime.dispose();
        }
    });

    it('surfaces authoritative storage corruption that cannot be attributed to one queued message', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        vi.spyOn(resources.admissionStore.workQueue, 'readWorkPage').mockRejectedValue(
            new ALAdmissionCorruptionError('queuebox:page', new TypeError('invalid stored queue metadata'))
        );
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {}
        });
        try {
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
        }
        finally {
            runtime.dispose();
        }
    });

    it('marks corruption discovered during message delivery as NON_RETRYABLE', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage(
            'sender',
            { topicId: 'chat', resourceId: 'corrupt-delivery', contextId: 'room' },
            'receiver',
            'chat',
            { text: 'hello' }
        );
        await resources.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(resources.admissionStore, message)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp: Number.MAX_SAFE_INTEGER
            }],
            durableEffects: [computeALInboundWorkEntry({
                namespace: resources.admissionStore.namespace,
                observedAtMs: Date.now(),
                effectId: 'corrupt-delivery',
                expireAtTimestamp: Date.now() + 60_000,
                payload: {
                    kind: 'dispatch-local',
                    entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
                }
            })]
        });
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {
                throw new ALAdmissionCorruptionError(
                    'inbound:effect:corrupt-delivery',
                    new TypeError('invalid durable delivery')
                );
            },
            sendControlMessage: async () => {}
        });
        try {
            await runtime.ready();
            const stored = await resources.admissionStore.workQueue.getItem(
                toALInboundWorkKey(resources.admissionStore.namespace, 'corrupt-delivery')
            );
            expect(stored).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        }
        finally {
            runtime.dispose();
        }
    });

    it.each([
        { malformed: true, terminalStatus: EntityStatus.NON_RETRYABLE },
        { malformed: false, terminalStatus: EntityStatus.FAILED }
    ])('finalizes exhausted work as $terminalStatus when malformed is $malformed', async ({ malformed, terminalStatus }) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const nowMs = Date.now();
        const work = computeALInboundWorkEntry({
            namespace: resources.admissionStore.namespace,
            observedAtMs: nowMs - 20_000,
            expireAtTimestamp: nowMs + 120_000,
            effectId: 'exhausted-message',
            payload: { kind: 'release-buffered', trackKey: 'stream', seq: 1 }
        });
        await resources.admissionStore.workQueue.enqueue({
            ...work.entry,
            resource: malformed ? '{invalid-json' : work.entry.resource,
            status: EntityStatus.RESERVED,
            dequeueAudit: {
                attempts: 20,
                startTs: Temporal.Instant.fromEpochMilliseconds(nowMs - 10_001)
            }
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                delivered.push(entry.key.resourceId);
            },
            sendControlMessage: async (message) => {
                delivered.push(message.id.msgId);
            }
        });
        onTestFinished(() => runtime.dispose());
        await runtime.ready();
        expect(await resources.admissionStore.workQueue.getItem(work.entry.key)).toMatchObject({
            status: terminalStatus,
            dequeueAudit: { attempts: 21, nextTs: undefined }
        });
        vi.setSystemTime(nowMs + 60_000);
        for (let cycle = 0; cycle < 6; cycle += 1) {
            await resources.queueEngine.executeOnce();
        }
        expect(await resources.admissionStore.workQueue.getItem(work.entry.key)).toMatchObject({
            status: terminalStatus,
            dequeueAudit: { attempts: 21, nextTs: undefined }
        });
        expect(delivered).toEqual([]);
    });

    it('rejects work missing its ingress source without blocking a valid sibling', async () => {
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: engine,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const missingSource = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'missing-source', contextId: 'room' }, 'receiver', 'chat', {});
        const work = computeALInboundWorkEntry({
            namespace: resources.admissionStore.namespace,
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            effectId: 'missing-source',
            payload: { kind: 'dispatch-local', entry: QueueBoxUtilities.toResourceEntryFromMsg(missingSource, 'inbox') }
        });
        // A surviving queue entry with lost provenance cannot regain authority by retrying.
        await resources.admissionStore.workQueue.enqueue(work.entry);
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                delivered.push(entry.key.resourceId);
            },
            sendControlMessage: async () => {}
        });
        onTestFinished(() => runtime.dispose());
        const valid = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'valid-source', contextId: 'room' }, 'receiver', 'chat', {});
        await runtime.handleIncomingMessage(valid, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(async () => {
            await engine.executeOnce();
            return resources.admissionStore.workQueue.getItem(work.entry.key);
        }).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        await expect.poll(async () => {
            await engine.executeOnce();
            return delivered;
        }).toEqual(['valid-source']);
    });

    it.each(['corrupt', 'missing'] as const)('marks work referring to a %s buffered message as NON_RETRYABLE', async (failure) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'buffered', contextId: 'room' }, 'receiver', 'chat', {});
        await resources.admissionStore.commitBundle({
            admissionExpiresAtMs: null,
            senderId: 'sender',
            observations: (await readAdmission(resources.admissionStore, message)).observations,
            mutations: [],
            durableEffects: [computeALInboundWorkEntry({
                namespace: resources.admissionStore.namespace,
                observedAtMs: Date.now(),
                effectId: `${failure}-buffered-release`,
                expireAtTimestamp: Date.now() + 60_000,
                payload: {
                    kind: 'release-buffered',
                    trackKey: 'chat:sender',
                    seq: 1
                }
            })]
        });
        if (failure === 'corrupt') {
            vi.spyOn(resources.admissionStore, 'readBufferedRelease').mockRejectedValue(
                new ALAdmissionCorruptionError(
                    'inbound:buffered:chat:sender:1',
                    new TypeError('invalid buffered message')
                )
            );
        }
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {}
        });
        try {
            await runtime.ready();
            const stored = await resources.admissionStore.workQueue.getItem(
                toALInboundWorkKey(resources.admissionStore.namespace, `${failure}-buffered-release`)
            );
            expect(stored).toMatchObject({ status: EntityStatus.NON_RETRYABLE, dequeueAudit: { attempts: 1, nextTs: undefined } });
        }
        finally {
            runtime.dispose();
        }
    });

    it('completes a replayed buffered release when retained progress proves delivery', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const store = resources.admissionStore;
        const delivered: string[] = [];
        const dependencies = {
            ...resources,
            planIncomingMessage,
            readStoredEntry: (entry: ResourceEntry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry: ResourceEntry) => {
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        };
        const runtime = new ALInboundMessageRuntime(dependencies);
        onTestFinished(() => runtime.dispose());
        const message = {
            ...newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'completed', contextId: 'room' }, 'receiver', 'chat', {}),
            ordering: { orderingKey: 'stream', seq: 1 }
        };
        const trackKey = toALOrderingTrackKey(message)!;
        await runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(async () => (await store.readOrderedDelivery(trackKey, 2)).completedThrough).toBe(1);
        runtime.dispose();
        expect(await store.readBufferedRelease({ trackKey, seq: 1, nowMs: Date.now() })).toBeUndefined();

        const work = computeALInboundWorkEntry({
            namespace: store.namespace,
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            effectId: 'replayed-release',
            payload: { kind: 'release-buffered', trackKey, seq: 1 }
        });
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(store, message)).observations,
            mutations: [],
            durableEffects: [work]
        });
        const restarted = new ALInboundMessageRuntime({
            ...dependencies,
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                toInboxEntry: (incoming) => QueueBoxUtilities.toResourceEntryFromMsg(incoming, 'inbox'),
                stores: { admissionStore: store }
            })
        });
        onTestFinished(() => restarted.dispose());
        await restarted.ready();
        await expect.poll(async () => (await store.workQueue.getItem(work.entry.key))?.status).toBe(EntityStatus.COMPLETED);
        expect(delivered).toEqual([message.id.msgId]);
    });

    it('marks invalid buffered-delivery computation NON_RETRYABLE instead of completing the work', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => {
                const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox');
                return message.ordering?.seq === 2
                    ? { ...entry, key: { ...entry.key, resourceId: 'wrong-resource' } }
                    : entry;
            }
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                delivered.push(decodePersistedALMessage(entry.resource).route.resourceId);
            },
            sendControlMessage: async () => {}
        });
        onTestFinished(() => runtime.dispose());
        const first = {
            ...newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'first', contextId: 'room' }, 'receiver', 'chat', {}),
            ordering: { orderingKey: 'stream', seq: 1 }
        };
        const second = {
            ...newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'second', contextId: 'room' }, 'receiver', 'chat', {}),
            ordering: { orderingKey: 'stream', seq: 2 }
        };
        await runtime.handleIncomingMessage(second, { kind: 'ws-client', peerId: 'sender' });
        await runtime.handleIncomingMessage(first, { kind: 'ws-client', peerId: 'sender' });
        await expect.poll(async () => {
            const page = await resources.admissionStore.workQueue.readWorkPage({
                typeId: toALInboundWorkType(resources.admissionStore.namespace),
                status: EntityStatus.NON_RETRYABLE,
                maxToRead: 16,
                cursor: null
            });
            return page.entries.map((entry) => decodeALInboundWorkEntry(entry, resources.admissionStore.namespace).payload);
        }).toEqual([expect.objectContaining({ kind: 'release-buffered', seq: 2 })]);
        expect(delivered).toEqual(['first']);
    });

    it('wakes work admitted while a prior reservation is being finalized', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const finalizationStarted = Promise.withResolvers<void>();
        const releaseFinalization = Promise.withResolvers<void>();
        const releaseEntries = resources.admissionStore.workQueue.releaseEntries.bind(resources.admissionStore.workQueue);
        let paused = false;
        vi.spyOn(resources.admissionStore.workQueue, 'releaseEntries').mockImplementation(async (...args) => {
            const result = await releaseEntries(...args);
            if (!paused) {
                paused = true;
                finalizationStarted.resolve();
                await releaseFinalization.promise;
            }
            return result;
        });
        const deliveredMessageIds: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        });
        const first = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'first', contextId: 'room' }, 'receiver', 'chat', {});
        const second = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'second', contextId: 'room' }, 'receiver', 'chat', {});
        try {
            const firstAdmission = runtime.handleIncomingMessage(first, { kind: 'ws-client', peerId: 'sender' });
            await finalizationStarted.promise;
            const secondAdmission = await runtime.handleIncomingMessage(second, { kind: 'ws-client', peerId: 'sender' });
            expect(secondAdmission.right).toEqual({ kind: 'admitted' });
            releaseFinalization.resolve();
            await firstAdmission;

            await expect.poll(() => deliveredMessageIds).toEqual([first.id.msgId, second.id.msgId]);
        }
        finally {
            releaseFinalization.resolve();
            runtime.dispose();
        }
    });

    it('keeps one page read in flight when admission overlaps work advertisement', async () => {
        const engine = new InboxOutboxEngine();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            queueEngine: engine,
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const delivered: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                delivered.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        });
        const resumeRead = Promise.withResolvers<void>();
        onTestFinished(() => {
            resumeRead.resolve();
            runtime.dispose();
        });
        await runtime.ready();
        const readStarted = Promise.withResolvers<void>();
        const admissionWoke = Promise.withResolvers<void>();
        const readPage = resources.admissionStore.workQueue.readWorkPage.bind(resources.admissionStore.workQueue);
        let activeReads = 0;
        let maximumReads = 0;
        let pauseNextRead = true;
        vi.spyOn(resources.admissionStore.workQueue, 'readWorkPage').mockImplementation(async (request) => {
            activeReads += 1;
            maximumReads = Math.max(maximumReads, activeReads);
            try {
                const page = await readPage(request);
                if (pauseNextRead) {
                    pauseNextRead = false;
                    readStarted.resolve();
                    await resumeRead.promise;
                }
                return page;
            }
            finally {
                activeReads -= 1;
            }
        });
        const wake = engine.wake.bind(engine);
        vi.spyOn(engine, 'wake').mockImplementation(() => {
            wake();
            admissionWoke.resolve();
        });
        const advertised = engine.executeOnce();
        await readStarted.promise;
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'overlapping-read', contextId: 'room' }, 'receiver', 'chat', {});
        const admission = runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
        await admissionWoke.promise;
        resumeRead.resolve();
        await Promise.all([advertised, admission]);
        await expect.poll(async () => {
            await engine.executeOnce();
            return delivered;
        }).toEqual([message.id.msgId]);
        expect(maximumReads).toBe(1);

        // An external writer does not call this runtime's admission wakeup.
        for (let cycle = 0; cycle < 6; cycle += 1) {
            await engine.executeOnce();
        }
        const external = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'external-work', contextId: 'room' }, 'receiver', 'chat', {});
        const externalEntry = QueueBoxUtilities.toResourceEntryFromMsg(external, 'inbox');
        const expireAtTimestamp = Math.max(Date.now() + 60_000, externalEntry.audit.expiryTs.epochMilliseconds);
        const store = resources.admissionStore;
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: external.id.senderId,
            observations: (await readAdmission(store, external)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: external.id.msgId,
                    senderId: external.id.senderId,
                    source: { kind: 'ws-client', peerId: external.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp
            }],
            durableEffects: [computeALInboundWorkEntry({
                namespace: store.namespace,
                effectId: 'externally-admitted-work',
                observedAtMs: Date.now(),
                expireAtTimestamp,
                payload: { kind: 'dispatch-local', entry: externalEntry }
            })]
        });
        await expect.poll(async () => {
            await engine.executeOnce();
            return delivered;
        }).toEqual([message.id.msgId, external.id.msgId]);
        expect(maximumReads).toBe(1);
    });

    it('cancels a pending retry on disposal and never restarts delivery', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        let attempts = 0;
        const runtime = new ALInboundMessageRuntime({
            ...resources,

            planIncomingMessage,
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {
                attempts += 1;
                throw new Error('Delivery temporarily unavailable');
            },
            sendControlMessage: async () => {}
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        try {
            await runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });
            expect(attempts).toBe(1);

            runtime.dispose();
            vi.setSystemTime(Date.now() + 30_000);
            await resources.queueEngine.executeOnce();
            await runtime.ready();
            await runtime.handleIncomingMessage(message, { kind: 'ws-client', peerId: 'sender' });

            expect(attempts).toBe(1);
        }
        finally {
            runtime.dispose();
        }
    });

    it.each(['exhaustion-read', 'work-claim'] as const)('fences disposal during %s and recovers unfinished work after restart', async (stage) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const store = resources.admissionStore;
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: stage, contextId: 'room' }, 'receiver', 'chat', {}, { ttlMs: 60_000 });
        const work = computeALInboundWorkEntry({
            namespace: store.namespace,
            effectId: 'paused-delivery',
            observedAtMs: Date.now(),
            expireAtTimestamp: Date.now() + 60_000,
            payload: { kind: 'dispatch-local', entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox') }
        });
        await store.commitBundle({
            admissionExpiresAtMs: null,
            senderId: message.id.senderId,
            observations: (await readAdmission(store, message)).observations,
            mutations: [{
                kind: 'set-msg-owner',
                value: {
                    msgId: message.id.msgId,
                    senderId: message.id.senderId,
                    source: { kind: 'ws-client', peerId: message.id.senderId },
                    supersedenceKey: null
                },
                expireAtTimestamp: Date.now() + 60_000
            }],
            durableEffects: [work]
        });
        const operationStarted = Promise.withResolvers<void>();
        const resumeOperation = Promise.withResolvers<void>();
        if (stage === 'exhaustion-read') {
            const reserve = store.workQueue.reserveRetryExhaustionFinalizations.bind(store.workQueue);
            vi.spyOn(store.workQueue, 'reserveRetryExhaustionFinalizations').mockImplementationOnce(async (...args) => {
                const result = await reserve(...args);
                operationStarted.resolve();
                await resumeOperation.promise;
                return result;
            });
        }
        else {
            const claim = store.claimReadyEffects.bind(store);
            vi.spyOn(store, 'claimReadyEffects').mockImplementationOnce(async (request) => {
                const result = await claim(request);
                operationStarted.resolve();
                await resumeOperation.promise;
                return result;
            });
        }
        const deliveredMessageIds: string[] = [];
        const dependencies = {
            ...resources,
            planIncomingMessage,
            readStoredEntry: (entry: ResourceEntry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry: ResourceEntry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        };
        const runtime = new ALInboundMessageRuntime(dependencies);
        onTestFinished(() => {
            resumeOperation.resolve();
            runtime.dispose();
        });
        const ready = runtime.ready();
        await operationStarted.promise;
        runtime.dispose();
        resumeOperation.resolve();
        await ready;
        await resources.queueEngine.executeOnce();
        expect(deliveredMessageIds).toEqual([]);
        expect(await store.workQueue.getItem(work.entry.key)).toMatchObject({
            status: stage === 'exhaustion-read' ? EntityStatus.NEW : EntityStatus.RESERVED,
            dequeueAudit: { attempts: stage === 'exhaustion-read' ? 0 : 1 }
        });

        vi.setSystemTime(Date.now() + 10_001);
        const restarted = new ALInboundMessageRuntime({
            ...dependencies,
            ...createDefaultALInboundRuntimeResources({
                selfPeerId: 'receiver',
                toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox'),
                stores: { admissionStore: store }
            })
        });
        onTestFinished(() => restarted.dispose());
        await restarted.ready();
        await expect.poll(() => deliveredMessageIds).toEqual([message.id.msgId]);
    });
});

function planIncomingMessage(
    message: ALMessage,
    source: ALInboundMessageRuntime.Source,
    observations: ALMessagePlanningObservations
): ALMessageHandlingPlan {
    return planALMessageHandling(message, {
        ...observations,
        selfPeerId: 'receiver',
        fromPeerId: source.kind === 'trusted-server' ? undefined : source.peerId,
        connectedPeerIds: ['sender'],
        groupMemberPeerIds: ['sender', 'receiver'],
        overlayNeighborPeerIds: []
    });
}

async function readAdmission(store: ALInboundAdmissionStore, message: ALMessage) {
    const source = { kind: 'ws-client' as const, peerId: message.id.senderId };
    const nowMs = Date.now();
    return await store.readIncomingMessage({
        msg: message,
        source,
        nowMs,
        prePlan: planIncomingMessage(message, source, { nowMs })
    });
}
