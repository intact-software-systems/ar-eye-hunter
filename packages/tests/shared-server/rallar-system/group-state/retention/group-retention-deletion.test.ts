import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { groupStateGroupStorageKey } from '@shared-server/rallar-system/group-state/persistence/aggregate/group-aggregate-storage-keys.ts';
import { GROUPS_NAMESPACE } from '@shared-server/rallar-system/group-state/persistence/group-state-runtime-namespaces.ts';

import {
    commitRetention,
    createRetentionDatabaseFixture,
    prepareRetention,
    RETENTION_REF,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;

afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

describe('permanent deletion of archived temporary rooms', () => {
    it('deletes the room at seven archived days and preserves its audit and replay evidence', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe-empty')).computed);
        fixture.nowEpochMs += 1_000;
        const archive = await prepareRetention(fixture, 'archive-empty');
        await commitRetention(fixture, archive.computed);
        const archived = await fixture.repository.findGroup(RETENTION_REF);
        expect(archived?.status).toBe('archived');
        expect(archived?.archived?.atEpochMs).toBe(fixture.nowEpochMs);
        const archiveReceipt = await fixture.repository.findIdempotentGroupMutationReceipt(
            RETENTION_REF,
            archive.ingress.commandId
        );
        const archiveEvents = await fixture.repository.listEvents(RETENTION_REF);

        fixture.nowEpochMs += 604_799_999;
        await commitRetention(fixture, (await prepareRetention(fixture, 'before-deletion')).computed);
        expect(await fixture.repository.findGroup(RETENTION_REF)).toEqual(archived);
        expect(await fixture.repository.listMembers(RETENTION_REF)).not.toEqual([]);

        fixture.nowEpochMs += 1;
        const deletion = await prepareRetention(fixture, 'delete-at-deadline');
        await commitRetention(fixture, deletion.computed);

        expect(await fixture.repository.findGroup(RETENTION_REF)).toBeUndefined();
        const retired = await fixture.runtime.findEntry(GROUPS_NAMESPACE, groupStateGroupStorageKey(RETENTION_REF));
        expect(JSON.parse(retired!.value)).toEqual({
            ...RETENTION_REF,
            kind: 'retired-group',
            deletedAtEpochMs: fixture.nowEpochMs,
            causalRevision: { groupRevision: 4, presenceRevision: 0 },
            commandId: deletion.ingress.commandId,
            commandHash: deletion.ingress.commandHash
        });
        expect(retired!.expireAtTimestamp).toBe(253402300799999);
        expect(await fixture.repository.listMembers(RETENTION_REF)).toEqual([]);
        expect(await fixture.repository.listPresenceSessions(RETENTION_REF)).toEqual([]);
        expect(await fixture.repository.listPresenceAdmissions(RETENTION_REF)).toEqual([]);
        expect(await fixture.repository.findPresenceSummaryEntry(RETENTION_REF)).toBeUndefined();
        expect(await fixture.repository.findIdempotentGroupMutationReceipt(RETENTION_REF, archive.ingress.commandId))
            .toEqual(archiveReceipt);
        const events = await fixture.repository.listEvents(RETENTION_REF);
        expect(events).toEqual([...archiveEvents, expect.objectContaining({ eventType: 'group-deleted' })]);
        const replay = fixture.retention.compute(
            await fixture.retention.read(deletion.ingress, { attemptCount: 2, traceId: 'trace-group-retention-deletion' })
        );
        expect(replay).toEqual({ outcome: 'replay', receipt: deletion.computed.receipt });
        await commitRetention(fixture, replay);
        expect(await fixture.repository.listEvents(RETENTION_REF)).toEqual(events);
        expect(await fixture.repository.findGroup(RETENTION_REF)).toBeUndefined();
    }, 30_000);
});
