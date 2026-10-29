import {
    afterEach,
    describe,
    expect,
    it
} from 'vitest';

import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import {
    commitMutation,
    commitRetention,
    createRetentionDatabaseFixture,
    prepareMutation,
    prepareRetention,
    requireMutationWrite,
    RETENTION_REF,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

const races = (['membership', 'presence'] as const).flatMap((operation) =>
    (['writer-first', 'delete-first', 'overlap'] as const).map((order) => ({ operation, order }))
);

describe('retirement fences work authorized before archival', () => {
    it.each(races)('rejects stale $operation with $order transactions', async ({ operation, order }) => {
        const database = await createRetentionDatabaseFixture();
        fixture = database;
        await seedRetentionRoom(database);
        const activity = await prepareMutation(
            database,
            mutationDescriptor(
                operation === 'membership'
                    ? {
                        operation: 'upsertMember',
                        scope: RETENTION_REF,
                        groupId: RETENTION_REF.groupId,
                        targetPrincipalId: 'late-member',
                        request: { requestId: 'late-member', status: 'active', actorPrincipalId: 'owner' }
                    }
                    : {
                        operation: 'connectPresence',
                        scope: RETENTION_REF,
                        groupId: RETENTION_REF.groupId,
                        sessionId: 'owner-session',
                        request: {
                            requestId: 'late-connect',
                            principalId: 'owner',
                            generationId: 'late',
                            connectionGenerationId: 'late-connection',
                            connectedAtEpochMs: database.nowEpochMs,
                            lastHeartbeatAtEpochMs: database.nowEpochMs,
                            expiresAtEpochMs: database.nowEpochMs + 60_000,
                            actorPrincipalId: 'owner'
                        }
                    }
            )
        );
        await commitRetention(database, (await prepareRetention(database, 'observe')).computed);
        database.nowEpochMs += 1_000;
        await commitRetention(database, (await prepareRetention(database, 'archive')).computed);
        database.nowEpochMs += 604800000;
        const deletion = await prepareRetention(database, 'delete');
        const staleWrite = requireMutationWrite(activity.computed);
        const writeActivity = () => commitMutation(database, staleWrite);
        const writeDeletion = () => commitRetention(database, deletion.computed);

        if (order === 'overlap') {
            const [writer, retirement] = await Promise.allSettled([writeActivity(), writeDeletion()]);
            if (writer.status !== 'rejected') {
                throw new Error('The stale writer must not commit after archival.');
            }
            // PostgreSQL may abort the overlapping stale transaction before its application guard returns.
            expect(['runtime-state-write-conflict', '40P01']).toContain(writer.reason.code);
            expect(retirement.status).toBe('fulfilled');
        }
        else if (order === 'writer-first') {
            await expect(writeActivity()).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            await writeDeletion();
        }
        else {
            await writeDeletion();
            await expect(writeActivity()).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        }
        expect(await database.repository.findGroup(RETENTION_REF)).toBeUndefined();
        expect(await database.repository.listMembers(RETENTION_REF)).toEqual([]);
        expect(await database.repository.listPresenceAdmissions(RETENTION_REF)).toEqual([]);
        expect(await database.repository.listPresenceSessions(RETENTION_REF)).toEqual([]);
        const deletions = (await database.repository.listEvents(RETENTION_REF))
            .filter((event) => event.eventType === 'group-deleted');
        expect(deletions).toHaveLength(1);
    }, 30_000);
});
