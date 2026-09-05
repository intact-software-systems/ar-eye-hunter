import { AppInboxType, type AppInboxEnqueueInput, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { toAppInboxResourceEntry } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { describe, expect, it } from 'vitest';

const ENQUEUE: AppInboxEnqueueInput = {
    type: AppInboxType.GROUP_CREATE,
    topicId: 'app-inbox.group-state',
    resourceId: 'authority-command',
    contextId: 'application:workspace:group',
    senderId: 'owner',
    data: { requestId: 'authority-command' }
};

describe('AppInboxReservationClient authority persistence', () => {
    it('persists a precomputed authority replacement only for the exact reservation', async () => {
        const queue = new AuthorityPersistenceQueue();
        const context = createReservedContext();
        await queue.enqueue(context.entry);
        const client = createClient(queue);

        await client.persistAuthority(context, { principalId: 'owner' });

        const persisted = await queue.getItem(context.entry.key);
        if (persisted === undefined) {
            throw new Error('Expected persisted authority');
        }
        const message = decodePersistedALMessage(persisted.resource);
        expect(JSON.parse(message.payload.resource)).toMatchObject({
            authority: { principalId: 'owner' }
        });
    });

    it('rejects a stale reservation without overwriting the concurrent winner', async () => {
        const queue = new AuthorityPersistenceQueue();
        const context = createReservedContext();
        const winner = {
            ...context.entry,
            resource: JSON.stringify({ winner: true }),
            dequeueAudit: {
                ...context.entry.dequeueAudit,
                attempts: context.entry.dequeueAudit.attempts + 1
            }
        };
        await queue.enqueue(winner);
        const client = createClient(queue);

        await expect(client.persistAuthority(context, { principalId: 'owner' })).rejects
            .toMatchObject({ code: 'app-inbox-reservation-conflict' });
        expect(await queue.getItem(context.entry.key)).toBe(winner);
    });
});

function createClient(queue: AuthorityPersistenceQueue): AppInboxReservationClient {
    return new AppInboxReservationClient(
        { repository: queue },
        { serviceId: 'server-1' }
    );
}

class AuthorityPersistenceQueue extends InMemoryQueueBox {
    async writeMaterializedIfAbsentOrReplaceExpired(): Promise<ResourceEntry> {
        throw new Error('Authority persistence test does not reserve entries');
    }
}

function createReservedContext(): AppInboxMessageContext<JsonWireValue> {
    const queued = toAppInboxResourceEntry(ENQUEUE, 'server-1');
    const entry = {
        ...queued,
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 2 }
    };
    return {
        enqueue: ENQUEUE,
        message: decodePersistedALMessage(entry.resource),
        entry,
        encodeResult: (result) => encodeAppInboxResult(result, 'Reservation client test result')
    };
}
