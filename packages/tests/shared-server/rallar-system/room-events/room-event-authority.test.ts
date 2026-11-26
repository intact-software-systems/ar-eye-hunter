import { expect, it } from 'vitest';
import { AuthSessionPersistence } from '@shared-server/rallar-system/auth/persistence/auth-session-persistence.ts';
import { RoomEventAuthority } from '@shared-server/rallar-system/room-events/room-event-authority.ts';
import { createRetentionDatabaseFixture, RETENTION_REF, seedRetentionRoom } from '../group-state/retention/group-retention-database-fixture.ts';

it('requires both deployment organizer permission and a live lobby owner to open an event', async () => {
    const fixture = await createRetentionDatabaseFixture();
    try {
        await seedRetentionRoom(fixture);
        const dependencies = { groups: fixture.repository, authSessions: new AuthSessionPersistence(fixture.runtime) };
        const input = { lobby: RETENTION_REF, principalId: 'owner', sessionId: fixture.owner.sessionId,
            command: { action: 'create', courts: [{ groupId: 'gym', capacity: 2 }], closesAt: fixture.nowEpochMs + 60_000 } as const,
            requestId: 'open' };
        await expect(new RoomEventAuthority(dependencies, []).read(input, null, fixture.nowEpochMs)).rejects.toThrow(/organizer/i);
        const scoped = new RoomEventAuthority(dependencies, [], { [RETENTION_REF.applicationId]: ['owner'] });
        expect((await scoped.read(input, null, fixture.nowEpochMs)).audience).toEqual(['owner']);
        const otherLobby = { ...RETENTION_REF, applicationId: 'other' };
        await seedRetentionRoom(fixture, otherLobby);
        await expect(scoped.read({ ...input, lobby: otherLobby }, null, fixture.nowEpochMs)).rejects.toThrow(/organizer/i);
        const authority = new RoomEventAuthority(dependencies, ['owner']);
        await expect(authority.read({ ...input, principalId: 'other' }, null, fixture.nowEpochMs)).rejects.toThrow();
        const verified = await authority.read(input, null, fixture.nowEpochMs);
        expect(verified.audience).toEqual(['owner']);
    }
    finally { await fixture.storage.close(); }
});
