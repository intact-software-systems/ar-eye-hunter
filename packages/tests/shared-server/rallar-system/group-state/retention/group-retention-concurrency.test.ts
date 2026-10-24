import { afterEach, describe, expect, it } from 'vitest';

import { writeAppOutboxInsert } from '@shared-server/rallar-system/app-outbox/app-outbox-insert.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';

import {
    commitMutation,
    commitRetention,
    createRetentionDatabaseFixture,
    prepareMutation,
    prepareRetention,
    requireMutationWrite,
    RETENTION_REF,
    retryMutation,
    seedRetentionRoom,
    type RetentionDatabaseFixture
} from './group-retention-database-fixture.ts';

let fixture: RetentionDatabaseFixture | undefined;
afterEach(async () => {
    await fixture?.storage.close();
    fixture = undefined;
});

type RacingOperation = 'first-connect' | 'reconnect' | 'heartbeat' | 'membership' | 'metadata';
const races = (['first-connect', 'reconnect', 'heartbeat', 'membership', 'metadata'] as const)
    .flatMap((operation) => (['activity-first', 'archive-first'] as const).map((order) => ({ operation, order })));

describe('retention conditional writes on real database storage', () => {
    it.each(races)('fences $operation with $order commit order', async ({ operation, order }) => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        await seedPriorActivity(fixture, operation);
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe-empty')).computed);
        fixture.nowEpochMs += 1_000;
        const archive = await prepareRetention(fixture, 'archive-empty');
        expect(archive.computed.outcome).toBe('write');
        const activity = await prepareMutation(fixture, activityDescriptor(fixture, operation));
        const activityWrite = requireMutationWrite(activity.computed);
        const beforeGroupRevision = (await fixture.repository.findGroup(RETENTION_REF))?.snapshotVersion;

        if (order === 'activity-first') {
            await commitMutation(fixture, activityWrite);
            const winner = await fixture.repository.findGroup(RETENTION_REF);
            await expect(commitRetention(fixture, archive.computed)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await fixture.repository.findGroup(RETENTION_REF)).toEqual(winner);
            const fresh = fixture.retention.compute(await fixture.retention.read(archive.ingress, 2));
            await commitRetention(fixture, fresh);
            expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe(operation === 'metadata' ? 'archived' : 'active');
            if (operation === 'metadata') {
                expect((await fixture.repository.findGroup(RETENTION_REF))?.metadata.theme).toBe('ocean');
            }
        }
        else {
            await commitRetention(fixture, archive.computed);
            await expect(commitMutation(fixture, activityWrite)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            if (operation === 'metadata') {
                expect(await retryMutation(fixture, activity.ingress)).toMatchObject({ outcome: 'rejected', policyDenial: { code: 'group-archived' } });
            }
            else {
                await expect(retryMutation(fixture, activity.ingress)).rejects.toMatchObject({ denial: { code: 'group-archived' } });
            }
            expect((await fixture.repository.findGroup(RETENTION_REF))?.status).toBe('archived');
            expect(await fixture.repository.listPresenceSessions(RETENTION_REF)).toEqual([]);
            expect((await fixture.repository.listPresenceAdmissions(RETENTION_REF)).every((row) => row.admittedSessions.length === 0)).toBe(true);
        }
        const events = await fixture.repository.listEvents(RETENTION_REF);
        expect(events.filter((event) => event.eventType === 'group-archived')).toHaveLength(order === 'archive-first' || operation === 'metadata' ? 1 : 0);
        if (order === 'activity-first' && ['first-connect', 'reconnect', 'heartbeat'].includes(operation)) {
            // Normal activity does not contend on the group aggregate; only the later retention clear advances it.
            expect(activityWrite.receipt.snapshotVersion).toBe(beforeGroupRevision);
        }
    }, 30_000);

    it.each(['first', 'second'] as const)('allows only the %s archiver to commit and replays that receipt exactly', async (winner) => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe')).computed);
        fixture.nowEpochMs += 1_000;
        const first = await prepareRetention(fixture, 'first');
        const second = await prepareRetention(fixture, 'second');
        const accepted = winner === 'first' ? first : second;
        const stale = winner === 'first' ? second : first;

        await commitRetention(fixture, accepted.computed);
        await expect(commitRetention(fixture, stale.computed)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(fixture.retention.compute(await fixture.retention.read(stale.ingress, 2)).outcome).toBe('no-op');
        expect(fixture.retention.compute(await fixture.retention.read(accepted.ingress, 2)))
            .toEqual({ outcome: 'replay', receipt: accepted.computed.receipt });
        expect((await fixture.repository.listEvents(RETENTION_REF)).filter((event) => event.eventType === 'group-archived')).toHaveLength(1);
    }, 30_000);

    it('rolls back group, admissions, event and receipt when the final outbox insert collides', async () => {
        fixture = await createRetentionDatabaseFixture();
        await seedRetentionRoom(fixture);
        await seedPriorActivity(fixture, 'heartbeat');
        await commitRetention(fixture, (await prepareRetention(fixture, 'observe')).computed);
        fixture.nowEpochMs += 1_000;
        const { computed, ingress } = await prepareRetention(fixture, 'outbox-collision');
        if (computed.outcome !== 'write') {
            throw new Error('Expected the archive candidate');
        }
        const before = await fixture.repository.readPresenceSummaryEntries(RETENTION_REF);
        const events = await fixture.repository.listEvents(RETENTION_REF);
        await fixture.storage.sql.begin((transaction) => writeAppOutboxInsert(transaction, computed.outboxWrites[0]));

        await expect(commitRetention(fixture, computed)).rejects.toMatchObject({ code: 'resource-inbox-invariant-corruption' });

        expect(await fixture.repository.readPresenceSummaryEntries(RETENTION_REF)).toEqual(before);
        expect(await fixture.repository.listEvents(RETENTION_REF)).toEqual(events);
        expect(await fixture.repository.findIdempotentGroupMutationReceipt(RETENTION_REF, ingress.commandId)).toBeUndefined();
    }, 30_000);
});

async function seedPriorActivity(fixture: RetentionDatabaseFixture, operation: RacingOperation): Promise<void> {
    if (operation !== 'reconnect' && operation !== 'heartbeat') {
        return;
    }
    const { computed } = await prepareMutation(fixture, connectDescriptor(fixture, 'initial', 1_000));
    await commitMutation(fixture, requireMutationWrite(computed));
    if (operation === 'reconnect') {
        const disconnected = await prepareMutation(
            fixture,
            mutationDescriptor({
                operation: 'disconnectPresence',
                scope: RETENTION_REF,
                groupId: RETENTION_REF.groupId,
                sessionId: 'owner-session',
                request: { requestId: 'disconnect-initial', generationId: 'initial', disconnectedAtEpochMs: fixture.nowEpochMs, actorPrincipalId: 'owner' }
            })
        );
        await commitMutation(fixture, requireMutationWrite(disconnected.computed));
    }
    fixture.nowEpochMs += 2_000;
}

function activityDescriptor(fixture: RetentionDatabaseFixture, operation: RacingOperation): GroupMutationDescriptor {
    if (operation === 'first-connect' || operation === 'reconnect') {
        return connectDescriptor(fixture, 'racing', 60_000);
    }
    if (operation === 'heartbeat') {
        return mutationDescriptor({
            operation: 'heartbeatPresence',
            scope: RETENTION_REF,
            groupId: RETENTION_REF.groupId,
            sessionId: 'owner-session',
            request: {
                requestId: 'racing-heartbeat',
                generationId: 'initial',
                lastHeartbeatAtEpochMs: fixture.nowEpochMs,
                expiresAtEpochMs: fixture.nowEpochMs + 60_000,
                actorPrincipalId: 'owner'
            }
        });
    }
    if (operation === 'membership') {
        return mutationDescriptor({
            operation: 'upsertMember',
            scope: RETENTION_REF,
            groupId: RETENTION_REF.groupId,
            targetPrincipalId: 'new-member',
            request: { requestId: 'racing-membership', status: 'active', actorPrincipalId: 'owner' }
        });
    }
    return mutationDescriptor({
        operation: 'updateGroup',
        scope: RETENTION_REF,
        groupId: RETENTION_REF.groupId,
        request: { requestId: 'racing-metadata', metadata: { theme: 'ocean' }, actorPrincipalId: 'owner' }
    });
}

function connectDescriptor(fixture: RetentionDatabaseFixture, generation: string, lifetimeMs: number): GroupMutationDescriptor {
    return mutationDescriptor({
        operation: 'connectPresence',
        scope: RETENTION_REF,
        groupId: RETENTION_REF.groupId,
        sessionId: 'owner-session',
        request: {
            requestId: `connect-${generation}`,
            principalId: 'owner',
            generationId: generation,
            connectionGenerationId: `${generation}-connection`,
            connectedAtEpochMs: fixture.nowEpochMs,
            lastHeartbeatAtEpochMs: fixture.nowEpochMs,
            expiresAtEpochMs: fixture.nowEpochMs + lifetimeMs,
            actorPrincipalId: 'owner'
        }
    });
}
