import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { ALAdmissionCorruptionError } from '@shared/alm/al-admission-decoder.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('inbound durable effect worker lifecycle', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('retries persisted effects after a transient claim failure', async () => {
        vi.useFakeTimers();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        await resources.admissionStore.commitBundle({
            senderId: message.id.senderId,
            mutations: [],
            durableEffects: [{
                effectId: 'persisted-dispatch',
                payload: {
                    kind: 'dispatch-local',
                    entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
                }
            }]
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
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (plannedMessage, fromPeerId, stores) =>
                planALMessageHandling(plannedMessage, { ...stores, selfPeerId: 'receiver', fromPeerId }),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        });
        try {
            await runtime.ready();

            expect(deliveredMessageIds).toEqual([]);
            expect(vi.getTimerCount()).toBe(1);

            await vi.advanceTimersByTimeAsync(25);

            expect(deliveredMessageIds).toEqual([message.id.msgId]);
        }
        finally {
            runtime.dispose();
        }
    });

    it('surfaces persisted effect corruption without scheduling retries', async () => {
        vi.useFakeTimers();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        vi.spyOn(resources.admissionStore, 'claimReadyEffects').mockRejectedValue(
            new ALAdmissionCorruptionError('inbound:effect:broken', new TypeError('invalid effect'))
        );
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (message, fromPeerId, stores) => planALMessageHandling(message, { ...stores, selfPeerId: 'receiver', fromPeerId }),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {}
        });
        try {
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            expect(vi.getTimerCount()).toBe(0);
        }
        finally {
            runtime.dispose();
        }
    });

    it('surfaces corruption discovered during effect delivery without scheduling retries', async () => {
        vi.useFakeTimers();
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
            senderId: message.id.senderId,
            mutations: [],
            durableEffects: [{
                effectId: 'corrupt-delivery',
                payload: {
                    kind: 'dispatch-local',
                    entry: QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
                }
            }]
        });
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (plannedMessage, fromPeerId, stores) =>
                planALMessageHandling(plannedMessage, { ...stores, selfPeerId: 'receiver', fromPeerId }),
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
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            expect(vi.getTimerCount()).toBe(0);
        }
        finally {
            runtime.dispose();
        }
    });

    it('preserves buffered-release corruption for the effect worker to fail closed', async () => {
        vi.useFakeTimers();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        await resources.admissionStore.commitBundle({
            senderId: 'sender',
            mutations: [],
            durableEffects: [{
                effectId: 'corrupt-buffered-release',
                payload: {
                    kind: 'release-buffered',
                    trackKey: 'chat:sender',
                    seq: 1
                }
            }]
        });
        vi.spyOn(resources.admissionStore, 'readBufferedRelease').mockRejectedValue(
            new ALAdmissionCorruptionError(
                'inbound:buffered:chat:sender:1',
                new TypeError('invalid buffered message')
            )
        );
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (message, fromPeerId, stores) => planALMessageHandling(message, { ...stores, selfPeerId: 'receiver', fromPeerId }),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {},
            sendControlMessage: async () => {}
        });
        try {
            await expect(runtime.ready()).rejects.toBeInstanceOf(ALAdmissionCorruptionError);
            expect(vi.getTimerCount()).toBe(0);
        }
        finally {
            runtime.dispose();
        }
    });

    it('drains an effect committed while the current drain is finishing', async () => {
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        const emptyRead = Promise.withResolvers<void>();
        const releaseEmptyRead = Promise.withResolvers<void>();
        const committed = Promise.withResolvers<void>();
        const readNextReadyAt = resources.admissionStore.peekNextEffectReadyAt.bind(resources.admissionStore);
        const commitBundle = resources.admissionStore.commitBundle.bind(resources.admissionStore);
        vi.spyOn(resources.admissionStore, 'peekNextEffectReadyAt').mockImplementation(async (nowMs) => {
            const readyAt = await readNextReadyAt(nowMs);
            emptyRead.resolve();
            await releaseEmptyRead.promise;
            return readyAt;
        });
        vi.spyOn(resources.admissionStore, 'commitBundle').mockImplementation(async (bundle) => {
            const status = await commitBundle(bundle);
            committed.resolve();
            return status;
        });
        const deliveredMessageIds: string[] = [];
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (message, fromPeerId, stores) => planALMessageHandling(message, { ...stores, selfPeerId: 'receiver', fromPeerId }),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async (entry) => {
                deliveredMessageIds.push(decodePersistedALMessage(entry.resource).id.msgId);
            },
            sendControlMessage: async () => {}
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        try {
            const initialDrain = runtime.ready();
            await emptyRead.promise;

            const admission = runtime.handleIncomingMessage(message, 'sender');
            await committed.promise;
            releaseEmptyRead.resolve();
            await Promise.all([initialDrain, admission]);

            expect(deliveredMessageIds).toEqual([message.id.msgId]);
        }
        finally {
            runtime.dispose();
        }
    });

    it('cancels a pending retry on disposal and never restarts delivery', async () => {
        vi.useFakeTimers();
        const resources = createDefaultALInboundRuntimeResources({
            selfPeerId: 'receiver',
            toInboxEntry: (message) => QueueBoxUtilities.toResourceEntryFromMsg(message, 'inbox')
        });
        let attempts = 0;
        const runtime = new ALInboundMessageRuntime({
            ...resources,
            inbox: new InMemoryQueueBox(new Map()),
            planIncomingMessage: (message, fromPeerId, stores) => planALMessageHandling(message, { ...stores, selfPeerId: 'receiver', fromPeerId }),
            readStoredEntry: (entry) => decodePersistedALMessage(entry.resource),
            dispatchInboxEntry: async () => {
                attempts += 1;
                throw new Error('Delivery temporarily unavailable');
            },
            sendControlMessage: async () => {}
        });
        const message = newALUnicastMessage('sender', { topicId: 'chat', resourceId: 'message', contextId: 'room' }, 'receiver', 'chat', { text: 'hello' });
        try {
            await runtime.handleIncomingMessage(message, 'sender');
            expect(attempts).toBe(1);
            expect(vi.getTimerCount()).toBe(1);

            runtime.dispose();
            await vi.advanceTimersByTimeAsync(30_000);
            await runtime.ready();
            await runtime.handleIncomingMessage(message, 'sender');

            expect(attempts).toBe(1);
            expect(vi.getTimerCount()).toBe(0);
        }
        finally {
            runtime.dispose();
        }
    });
});
