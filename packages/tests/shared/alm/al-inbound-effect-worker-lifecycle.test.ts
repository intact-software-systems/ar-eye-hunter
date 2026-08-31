import { newALUnicastMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { ALInboundMessageRuntime } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { createDefaultALInboundRuntimeResources } from '@shared/alm/inbound/create-default-al-inbound-message-runtime.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('inbound durable effect worker lifecycle', () => {
    afterEach(() => vi.useRealTimers());

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
