import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { createDefaultAppInboxQueueMessage } from '@shared-server/rallar-system/app-inbox/app-inbox-queue-entry.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';
import { toResourceEntryWithKey } from '@shared/queuebox/ResourceEntry.ts';

import { TestResourceInbox } from '../test-support/app-inbox-resource-fixtures.ts';

const ENQUEUE: AppInboxEnqueueInput = {
    type: AppInboxType.GROUP_CREATE,
    topicId: 'app-inbox.group-state',
    resourceId: 'authority-command',
    contextId: 'application:workspace:group',
    senderId: 'owner',
    traceId: 'trace-authority-command',
    data: { requestId: 'authority-command' }
};

describe('AppInboxReservationClient materialized reservation', () => {
    it('distinguishes a corrupt retained reservation from ordinary idempotency conflict', async () => {
        const client = new AppInboxReservationClient({
            repository: { writeMaterializedIfAbsentOrReplaceExpired: async (entry) => toResourceEntryWithKey(entry.key, 'APP_INBOX', { corrupt: true }) },
            creationNow: Temporal.Now.instant,
            createMessage: createDefaultAppInboxQueueMessage
        }, { serviceId: 'server-1' });
        await expect(client.reserveMaterializedEntry(ENQUEUE, async () => {
            throw new Error('A retained row must not recapture facts');
        })).rejects.toMatchObject({ code: 'app-inbox-malformed-command', operationSource: 'corrupt' });
    });

    it('retains the placeholder creation instant to the millisecond when materializing and replaying the winning data', async () => {
        const queue = new TestResourceInbox(new Map());
        let createdAt = Temporal.Instant.from('2026-10-13T23:59:59.123456789Z');
        const client = new AppInboxReservationClient({
            repository: queue,
            creationNow: () => createdAt,
            createMessage: createDefaultAppInboxQueueMessage
        }, { serviceId: 'server-1' });
        const first = await client.reserveMaterializedEntry(ENQUEUE, async () => {
            createdAt = Temporal.Instant.from('2026-10-14T00:00:00.987654321Z');
            const { traceId: _trace, ...command } = ENQUEUE;
            return { ...command, data: { requestId: 'authority-command', materialized: true } };
        });
        const persisted = await queue.getItem(first.key);
        createdAt = Temporal.Instant.from('2026-10-15T00:00:00Z');
        const replay = await client.reserveMaterializedEntry(ENQUEUE, async () => {
            throw new Error('Replay must not run the winning materializer');
        });

        expect(first.winner).toBe(true);
        expect(replay.winner).toBe(false);
        expect(replay.enqueue.data).toEqual({ requestId: 'authority-command', materialized: true });
        expect(persisted?.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123');
        expect(persisted?.audit.date.toString()).toBe('23:59:59.123');
        expect(persisted?.dequeueAudit).toEqual({ attempts: 0 });
        expect(await queue.getItem(first.key)).toEqual(persisted);
    });

    it('stamps the reservation trace on the materialized command and replays the winner trace', async () => {
        const queue = new TestResourceInbox(new Map());
        const client = new AppInboxReservationClient({
            repository: queue,
            creationNow: Temporal.Now.instant,
            createMessage: createDefaultAppInboxQueueMessage
        }, { serviceId: 'server-1' });
        const { traceId: _trace, ...command } = ENQUEUE;

        const first = await client.reserveMaterializedEntry(ENQUEUE, async () => command);
        const replay = await client.reserveMaterializedEntry({ ...ENQUEUE, traceId: 'trace-replay' }, async () => {
            throw new Error('Replay must not run the winning materializer');
        });

        expect(JSON.parse(first.entry.resource)).toMatchObject({ id: { traceId: 'trace-authority-command' } });
        expect(first.enqueue).toEqual(command);
        expect(replay.entry).toEqual(first.entry);
        expect(JSON.parse(replay.entry.resource)).toMatchObject({ id: { traceId: 'trace-authority-command' } });
    });
});
