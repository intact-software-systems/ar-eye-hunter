import { expect, it } from 'vitest';
import { createRetentionDatabaseFixture, RETENTION_REF } from '../group-state/retention/group-retention-database-fixture.ts';
import { createRoomEvent } from '@shared/api/room-events/room-event.ts';
import { RoomEventRepository } from '@shared-server/rallar-system/room-events/room-event-repository.ts';
import { writeGuardedViewPublication } from '@shared-server/rallar-system/websocket/outbox/guarded-view-publication.ts';

it('commits an event once across competing creators and keeps its courts scoped to the event lobby', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        const repository = new RoomEventRepository(fixture.runtime);
        const before = await repository.read(RETENTION_REF);
        expect(before).toBeNull();
        const event = createRoomEvent({ lobby: RETENTION_REF, organizerId: 'owner', nowEpochMs: fixture.nowEpochMs,
            command: {action: 'create', courts: [{groupId: 'court', capacity: 2}], closesAt: fixture.nowEpochMs + 120_000} });
        const publication = repository.prepare(before, event, [], {
            serviceId: 'rallar', traceId: 'trace', createdAtEpochMs: fixture.nowEpochMs, retentionMs: 60_000,
            audience: ['owner']
        });
        await fixture.storage.sql.begin(tx => writeGuardedViewPublication(tx, publication));
        await expect(fixture.storage.sql.begin(tx => writeGuardedViewPublication(tx, publication))).rejects.toThrow();
        expect((await repository.read(RETENTION_REF))?.value).toEqual(event);
        expect(await repository.read({ ...RETENTION_REF, applicationId: 'other' })).toBeNull();
        expect(publication.outbox.length).toBeGreaterThan(0);
    }
    finally { await fixture.storage.close(); }
});
