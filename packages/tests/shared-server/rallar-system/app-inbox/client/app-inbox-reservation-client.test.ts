import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it
} from 'vitest';

import { AppInboxType, type AppInboxEnqueueInput } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { AppInboxReservationClient } from '@shared-server/rallar-system/app-inbox/client/app-inbox-reservation-client.ts';

import { TestResourceInbox } from '../test-support/app-inbox-resource-fixtures.ts';
import { createAppInboxQueueMessageFixture } from '../test-support/create-app-inbox-queue-message-fixture.ts';

const ENQUEUE: AppInboxEnqueueInput = {
    type: AppInboxType.GROUP_CREATE,
    topicId: 'app-inbox.group-state',
    resourceId: 'authority-command',
    contextId: 'application:workspace:group',
    senderId: 'owner',
    data: { requestId: 'authority-command' }
};

describe('AppInboxReservationClient materialized reservation', () => {
    it('retains the precise placeholder creation instant when materializing and replaying the winning data', async () => {
        const queue = new TestResourceInbox(new Map());
        let createdAt = Temporal.Instant.from('2026-10-13T23:59:59.123456789Z');
        const client = new AppInboxReservationClient({
            repository: queue,
            creationNow: () => createdAt,
            createMessage: createAppInboxQueueMessageFixture
        }, { serviceId: 'server-1' });
        const first = await client.reserveMaterializedEntry(ENQUEUE, async () => {
            createdAt = Temporal.Instant.from('2026-10-14T00:00:00.987654321Z');
            return { ...ENQUEUE, data: { requestId: 'authority-command', materialized: true } };
        });
        const persisted = await queue.getItem(first.key);
        createdAt = Temporal.Instant.from('2026-10-15T00:00:00Z');
        const replay = await client.reserveMaterializedEntry(ENQUEUE, async () => {
            throw new Error('Replay must not run the winning materializer');
        });

        expect(first.winner).toBe(true);
        expect(replay.winner).toBe(false);
        expect(replay.enqueue.data).toEqual({ requestId: 'authority-command', materialized: true });
        expect(persisted?.audit.createdTs.toString()).toBe('2026-10-13T23:59:59.123456789');
        expect(persisted?.audit.date.toString()).toBe('23:59:59.123456789');
        expect(persisted?.dequeueAudit).toEqual({ attempts: 0 });
        expect(await queue.getItem(first.key)).toEqual(persisted);
    });
});
