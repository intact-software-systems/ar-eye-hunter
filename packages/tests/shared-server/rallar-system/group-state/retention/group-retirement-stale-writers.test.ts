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
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        const activity = await prepareMutation(
            fixture,
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
                            connectedAtEpochMs: fixture.nowEpochMs,
                            lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                            expiresAtEpochMs: fixture.nowEpochMs + 60_000,
                            actorPrincipalId: 'owner'
                        }
                    }
            )
        );
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe')).computed);
        fixture.nowEpochMs += 1_000;
        await commitRetention(fixture, (await prepareRetention(fixture, 'archive')).computed);
        fixture.nowEpochMs += 604800000;
        const deletion = await prepareRetention(fixture, 'delete');
        const staleWrite = requireMutationWrite(activity.computed);
        const writeActivity = () => commitMutation(fixture!, staleWrite);
        const writeDeletion = () => commitRetention(fixture!, deletion.computed);

        if (order === 'overlap') {
            const [writer, retirement] = await Promise.allSettled([writeActivity(), writeDeletion()]);
            expect(writer).toMatchObject({ status: 'rejected', reason: { code: 'runtime-state-write-conflict' } });
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
        expect(await fixture.repository.findGroup(RETENTION_REF)).toBeUndefined();
        expect(await fixture.repository.listMembers(RETENTION_REF)).toEqual([]);
        expect(await fixture.repository.listPresenceAdmissions(RETENTION_REF)).toEqual([]);
        expect(await fixture.repository.listPresenceSessions(RETENTION_REF)).toEqual([]);
        expect((await fixture.repository.listEvents(RETENTION_REF)).filter((event) => event.eventType === 'group-deleted')).toHaveLength(1);
    }, 30_000);
});
