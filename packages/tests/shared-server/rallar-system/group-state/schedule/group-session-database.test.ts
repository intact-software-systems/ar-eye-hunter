import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { mutationDescriptor } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import type { GroupMutationDescriptor } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';
import { GROUP_SESSION_INTENTS_NAMESPACE, groupSessionIntentKey } from '@shared-server/rallar-system/group-state/schedule/group-session-intent-storage.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { describe, expect, it } from 'vitest';
import { createTestAuthSession } from '../group-state-test-runtime.ts';
import {
    commitMutation,
    createRetentionDatabaseFixture,
    prepareMutation,
    requireMutationWrite,
    retryMutation,
    type RetentionDatabaseFixture
} from '../retention/group-retention-database-fixture.ts';

const ref = { applicationId: 'scheduled-tests', workspaceId: 'default', groupId: 'last-seat' };

async function createScheduledFixture(startOffsetMs = 3_600_000) {
    const fixture = await createRetentionDatabaseFixture();
    const create = await prepareMutation(
        fixture,
        mutationDescriptor({
            operation: 'createGroup',
            scope: ref,
            groupId: ref.groupId,
            request: {
                requestId: 'create-session',
                groupId: ref.groupId,
                displayName: 'Last seat',
                kind: 'room',
                joinMode: 'open',
                maxMembers: 2,
                createdByPrincipalId: 'owner',
                actorPrincipalId: 'owner',
                retention: { mode: 'temporary' },
                scheduledStartAtEpochMs: fixture.nowEpochMs + startOffsetMs
            }
        })
    );
    await commitMutation(fixture, requireMutationWrite(create.computed));
    return fixture;
}

async function prepareForAccount(fixture: RetentionDatabaseFixture, principalId: string, descriptor: GroupMutationDescriptor) {
    const session = createTestAuthSession(principalId);
    await new AuthSessionRepository(fixture.runtime).putSession(session);
    const ingress = await fixture.mutations.captureMutationIngress(descriptor, session);
    return { ingress, computed: await retryMutation(fixture, ingress) };
}

function reservation(principalId: string, requestId: string) {
    return mutationDescriptor({
        operation: 'changeGroupSession',
        scope: ref,
        groupId: ref.groupId,
        request: { requestId, actorPrincipalId: principalId, action: 'reserve', expectedScheduleRevision: 1, startsAtEpochMs: null }
    });
}

describe('scheduled-session SQL concurrency and rollback', () => {
    it('fails direct and paginated private reads on SQL-backed identity corruption', async () => {
        const fixture = await createScheduledFixture();
        try {
            for (
                const value of [
                    { ...ref, principalId: 'other-account', reviewedScheduleRevision: 1 },
                    { ...ref, workspaceId: 'other-scope', principalId: 'alice', reviewedScheduleRevision: 1 },
                    { malformed: true }
                ]
            ) {
                await fixture.runtime.upsert(
                    GROUP_SESSION_INTENTS_NAMESPACE,
                    groupSessionIntentKey(ref, 'alice'),
                    JSON.stringify(value),
                    NEVER_EXPIRE_AT_TIMESTAMP
                );
                await Promise.all([
                    expect(fixture.repository.findSessionIntentEntry(ref, 'alice')),
                    expect(fixture.repository.listSessionIntentsPage(ref, 'alice', null)),
                    expect(fixture.repository.readRetirementEntries(ref))
                ].map((assertion) => assertion.rejects.toMatchObject({ code: 'group-state-repository-invariant-corruption' })));
            }
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('commits only one last-seat contender and reevaluates the loser against fresh state', async () => {
        const fixture = await createScheduledFixture();
        try {
            const alice = await prepareForAccount(fixture, 'alice', reservation('alice', 'alice-last-seat'));
            const bob = await prepareForAccount(fixture, 'bob', reservation('bob', 'bob-last-seat'));
            await commitMutation(fixture, requireMutationWrite(alice.computed));
            await expect(commitMutation(fixture, requireMutationWrite(bob.computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await fixture.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['alice']);
            expect(await fixture.repository.findSessionIntentEntry(ref, 'bob')).toBeUndefined();
            expect(await fixture.repository.findIdempotentGroupMutationReceipt(ref, 'bob-last-seat')).toBeUndefined();
            const retried = await retryMutation(fixture, bob.ingress);
            expect(retried).toMatchObject({ outcome: 'rejected', receipt: { rejection: 'Reservation refused: full.' } });
            expect(await fixture.repository.listEvents(ref)).toHaveLength(2);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('rolls back reservation, personal discovery, group revision, event and receipt as one unit', async () => {
        const fixture = await createScheduledFixture();
        try {
            const before = await fixture.repository.findGroupEntry(ref);
            const candidate = await prepareForAccount(fixture, 'alice', reservation('alice', 'rollback-reservation'));
            await expect(fixture.storage.sql.begin(async (transaction) => {
                await fixture.mutations.write(transaction, requireMutationWrite(candidate.computed));
                throw new Error('rollback-probe');
            })).rejects.toThrow('rollback-probe');
            expect(await fixture.repository.findGroupEntry(ref)).toEqual(before);
            expect((await fixture.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual([]);
            expect(await fixture.repository.findSessionIntentEntry(ref, 'alice')).toBeUndefined();
            expect(await fixture.repository.findIdempotentGroupMutationReceipt(ref, 'rollback-reservation')).toBeUndefined();
            expect(await fixture.repository.listEvents(ref)).toHaveLength(1);
            await commitMutation(fixture, requireMutationWrite(await retryMutation(fixture, candidate.ingress)));
            expect((await fixture.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual(['alice']);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('fences an admission computed against the old lobby when a reschedule wins', async () => {
        const fixture = await createScheduledFixture(660_000);
        try {
            const reschedule = await prepareMutation(
                fixture,
                mutationDescriptor({
                    operation: 'changeGroupSession',
                    scope: ref,
                    groupId: ref.groupId,
                    request: {
                        requestId: 'reschedule-race',
                        actorPrincipalId: 'owner',
                        action: 'reschedule',
                        expectedScheduleRevision: 1,
                        startsAtEpochMs: fixture.nowEpochMs + 3_600_000
                    }
                })
            );
            fixture.nowEpochMs += 60_000;
            const join = await prepareForAccount(
                fixture,
                'alice',
                mutationDescriptor({
                    operation: 'joinGroup',
                    scope: ref,
                    groupId: ref.groupId,
                    targetPrincipalId: 'alice',
                    request: { requestId: 'old-lobby-join', actorPrincipalId: 'alice', participation: 'player' }
                })
            );
            await commitMutation(fixture, requireMutationWrite(reschedule.computed));
            await expect(commitMutation(fixture, requireMutationWrite(join.computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect((await fixture.repository.readSnapshot(ref))?.members.map((member) => member.principalId)).toEqual(['owner']);
            expect(await fixture.repository.findSessionIntentEntry(ref, 'alice')).toBeUndefined();
            await expect(retryMutation(fixture, join.ingress)).rejects.toMatchObject({ denial: { code: 'group-admission-closed' } });
        }
        finally {
            await fixture.storage.close();
        }
    });
    it('resolves overlapping last-seat transactions without oversubscription', async () => {
        const fixture = await createScheduledFixture();
        try {
            const alice = await prepareForAccount(fixture, 'alice', reservation('alice', 'overlap-alice'));
            const bob = await prepareForAccount(fixture, 'bob', reservation('bob', 'overlap-bob'));
            const results = await Promise.allSettled([
                commitMutation(fixture, requireMutationWrite(alice.computed)),
                commitMutation(fixture, requireMutationWrite(bob.computed))
            ]);
            expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
            const loser = results[0].status === 'rejected' ? alice : bob;
            expect(await retryMutation(fixture, loser.ingress)).toMatchObject({ outcome: 'rejected' });
            expect((await fixture.repository.findSessionReservationsEntry(ref))?.value.principalIds).toHaveLength(1);
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('reevaluates a queued reservation at the no-show deadline', async () => {
        const fixture = await createScheduledFixture(660_000);
        try {
            const queued = await prepareForAccount(fixture, 'alice', reservation('alice', 'queued-expired'));
            fixture.nowEpochMs += 1_260_000;
            expect(await retryMutation(fixture, queued.ingress)).toMatchObject({
                outcome: 'rejected',
                receipt: { rejection: 'Reservation refused: reservations-expired.' }
            });
            expect((await fixture.repository.findSessionReservationsEntry(ref))?.value.principalIds).toEqual([]);
            expect(await fixture.repository.findSessionIntentEntry(ref, 'alice')).toBeUndefined();
        }
        finally {
            await fixture.storage.close();
        }
    });

    it('deletes private scheduling records and fences a reservation authorized before archival', async () => {
        const fixture = await createScheduledFixture();
        try {
            const stale = await prepareForAccount(fixture, 'alice', reservation('alice', 'stale-retired'));
            const archive = await prepareMutation(
                fixture,
                mutationDescriptor({
                    operation: 'updateGroup',
                    scope: ref,
                    groupId: ref.groupId,
                    request: { requestId: 'archive-scheduled-room', actorPrincipalId: 'owner', status: 'archived' }
                })
            );
            await commitMutation(fixture, requireMutationWrite(archive.computed));
            fixture.nowEpochMs += 604_800_000;
            const ingress = fixture.retention.capture({ groupRef: ref, requestId: 'delete-scheduled-room', observedAtEpochMs: fixture.nowEpochMs });
            const read = await fixture.retention.read(ingress, { attemptCount: 1, traceId: 'session-retirement' });
            const deletion = fixture.retention.compute(read);
            expect(fixture.retention.validate(read, deletion)).toEqual([]);
            await fixture.storage.sql.begin((transaction) => fixture.retention.write(transaction, deletion));
            expect(await fixture.repository.findGroup(ref)).toBeUndefined();
            expect(await fixture.repository.findSessionReservationsEntry(ref)).toBeUndefined();
            expect(await fixture.repository.findSessionIntentEntry(ref, 'owner')).toBeUndefined();
            await expect(commitMutation(fixture, requireMutationWrite(stale.computed))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await fixture.repository.findSessionIntentEntry(ref, 'alice')).toBeUndefined();
        }
        finally {
            await fixture.storage.close();
        }
    });
});
