import { computeMatchmakingStorage } from '@shared-server/rallar-system/matchmaking/compute-matchmaking-storage.ts';
import { computeMatchmaking } from '@shared-server/rallar-system/matchmaking/compute-matchmaking.ts';
import { writeRuntimeStateConditionalBatch } from '@shared-server/runtime-state/postgres/write-runtime-state-conditional-batch.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createRuntime, policy, ref } from './party-service-fixture.ts';

describe('party mutations through authenticated AppInbox', () => {
    it('replays the exact result without duplicating membership and rejects changed request reuse', async () => {
        const storage = await createResourceInboxTestStorage('party_app_inbox_replay');
        try {
            const fixture = await createRuntime(storage);
            const command = fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } });
            expect(await fixture.run(command)).toEqual({ ref, principalId: 'alice', requestId: 'create', status: 'applied', code: null });
            expect(fixture.timing.map((event) => event.operation)).toEqual(['read', 'compute', 'validate', 'write', 'commit']);
            const after = await fixture.parties.read(ref);
            expect((await fixture.service.mutate.submit({ command, traceId: 'replay' })).right).toMatchObject({ status: 'applied' });
            expect(await fixture.parties.read(ref)).toEqual(after);
            expect(
                (await fixture.service.mutate.enqueue({
                    command: { ...command, request: { ...command.request, ref: { ...ref, partyId: 'other' } } },
                    traceId: 'changed'
                })).left?.code
            )
                .toBe('app-inbox-idempotency-conflict');
            expect(
                await fixture.run(
                    fixture.command('alice', 'invite-bob', {
                        ref,
                        expectedRosterRevision: 0,
                        intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' }
                    })
                )
            ).toMatchObject({ status: 'applied' });
            expect((await fixture.parties.readAccount(ref, 'bob')).account.invitations).toEqual([{
                partyId: ref.partyId,
                invitationId: 'invite-bob',
                expiresAtEpochMs: fixture.clock.now + policy.invitationLifetimeMs
            }]);
            const accept = fixture.command('bob', 'accept', { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'invite-bob' } });
            expect(await fixture.run(accept)).toMatchObject({ status: 'applied' });
            expect((await fixture.parties.read(ref)).record?.members.map((member) => member.principalId)).toEqual(['alice', 'bob']);
            expect((await fixture.parties.readAccount(ref, 'bob')).account.invitations).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it.each(['blocked', 'removed'] as const)('does not admit an invitation after friendship is %s during the read', async (change) => {
        const storage = await createResourceInboxTestStorage('party_consent_race');
        try {
            const fixture = await createRuntime(storage);
            await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
            await fixture.run(
                fixture.command('alice', 'invite', {
                    ref,
                    expectedRosterRevision: 0,
                    intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' }
                })
            );
            const readProfiles = fixture.profiles.readProfiles.bind(fixture.profiles);
            vi.spyOn(fixture.profiles, 'readProfiles').mockImplementationOnce(async (principalIds) => {
                const observed = await readProfiles(principalIds);
                const bob = observed.find((profile) => profile.profile.principalId === 'bob')!;
                await fixture.runtime.upsert(
                    'friends:profiles',
                    bob.entry!.key,
                    JSON.stringify({ ...bob.profile, contacts: change === 'blocked' ? [{ principalId: 'alice', status: 'blocked' }] : [] }),
                    NEVER_EXPIRE_AT_TIMESTAMP
                );
                return observed;
            });
            const command = fixture.command('bob', 'accept', { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'invite-bob' } });
            const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
            const beforeMatchmaking = await fixture.matchmaking.read(scope);
            const admitted = await fixture.service.mutate.enqueue({ command, traceId: 'friendship-race' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.parties.read(ref)).record?.members.map((member) => member.principalId)).toEqual(['alice']);
            expect((await fixture.parties.readAccount(ref, 'bob')).account.partyId).toBeNull();
            expect(await fixture.matchmaking.read(scope)).toEqual(beforeMatchmaking);
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'person-unavailable' });
            expect((await fixture.parties.read(ref)).record?.invitations).toHaveLength(1);
        }
        finally {
            await storage.close();
        }
    });

    it('rechecks a takeover after the absent leader reconnects before its conditional write', async () => {
        const storage = await createResourceInboxTestStorage('party_takeover_reconnect');
        try {
            const fixture = await createRuntime(storage);
            await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
            await fixture.run(fixture.command('alice', 'invite', {
                ref,
                expectedRosterRevision: 0,
                intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' }
            }));
            await fixture.run(fixture.command('bob', 'accept', {
                ref,
                expectedRosterRevision: null,
                intent: { action: 'accept', invitationId: 'invite-bob' }
            }));
            const session = (await fixture.clients.findSessionEntry({
                ...ref,
                principalId: 'alice',
                clientInstanceId: 'browser-alice',
                sessionId: 'session-alice'
            }))!;
            expect(await fixture.clients.updateSession({ ...session.value, expiresAtEpochMs: fixture.clock.now - 1 }, session.entry.revision))
                .toMatchObject({ status: 'applied' });
            const readPresence = fixture.clients.readPrincipalSnapshot.bind(fixture.clients);
            let reconnected = false;
            vi.spyOn(fixture.clients, 'readPrincipalSnapshot').mockImplementation(async (principalRef) => {
                const observed = await readPresence(principalRef);
                if (principalRef.principalId === 'alice' && !reconnected) {
                    reconnected = true;
                    // A reconnect advances the durable principal fence as well as the session lease.
                    expect(await fixture.clients.updateSession(session.value, session.entry.revision + 1)).toMatchObject({ status: 'applied' });
                    expect(
                        await fixture.clients.updatePrincipal({
                            ...observed!.principal.value,
                            presenceVersion: observed!.principal.value.presenceVersion + 1,
                            snapshotVersion: observed!.principal.value.snapshotVersion + 1
                        }, observed!.principal.entry.revision)
                    ).toMatchObject({ status: 'applied' });
                }
                return observed;
            });
            const before = await fixture.parties.read(ref);
            const command = fixture.command('bob', 'takeover', { ref, expectedRosterRevision: 1, intent: { action: 'take-leadership' } });
            const admitted = await fixture.service.mutate.enqueue({ command, traceId: 'reconnect-race' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.parties.read(ref)).toEqual(before);
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'leader-present' });
            expect((await fixture.parties.read(ref)).record?.leaderPrincipalId).toBe('alice');
        }
        finally {
            await storage.close();
        }
    });

    it('creating a party cancels the actor pending match for the entire cohort in the same transaction', async () => {
        const storage = await createResourceInboxTestStorage('party_invalidates_pending_match');
        try {
            const fixture = await createRuntime(storage);
            const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
            const matchmakingPolicy = { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 };
            for (const session of fixture.sessions) {
                const read = await fixture.matchmaking.read(scope, [session.clientId]);
                const transition = computeMatchmaking({
                    pool: read.pool,
                    partySearches: read.partySearches,
                    policy: matchmakingPolicy,
                    nowEpochMs: fixture.clock.now,
                    command: {
                        action: 'start',
                        principalId: session.clientId,
                        sessionId: session.sessionId,
                        sessionIssuedAtEpochMs: session.issuedAtEpochMs,
                        sessionExpiresAtEpochMs: session.expiresAtEpochMs,
                        searchId: `search-${session.clientId}`,
                        capturedAtEpochMs: fixture.clock.now
                    }
                });
                const prepared = computeMatchmakingStorage({ read, transition, finishedRetentionMs: 60000 });
                await storage.sql.begin((transaction) => writeRuntimeStateConditionalBatch(transaction, prepared));
            }
            expect((await fixture.matchmaking.read(scope)).pool.proposals).toHaveLength(1);
            expect(await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }))).toMatchObject({
                status: 'applied'
            });
            expect((await fixture.matchmaking.read(scope)).pool.proposals).toEqual([]);
            for (const principalId of ['alice', 'bob']) {
                expect((await fixture.matchmaking.readCurrent({ scope, principalId, nowEpochMs: fixture.clock.now })).finished?.reason)
                    .toBe('declined');
            }
            expect((await fixture.parties.read(ref)).record?.members.map((member) => member.principalId)).toEqual(['alice']);
        }
        finally {
            await storage.close();
        }
    });

    it('rolls back a party creation when logout wins during its read, then refuses on redelivery', async () => {
        const storage = await createResourceInboxTestStorage('party_app_inbox_revoke');
        try {
            const fixture = await createRuntime(storage);
            const read = fixture.auth.findSessionBySessionIdEntry.bind(fixture.auth);
            vi.spyOn(fixture.auth, 'findSessionBySessionIdEntry').mockImplementationOnce(async (sessionId) => {
                const observed = await read(sessionId);
                await fixture.auth.deleteSession(fixture.sessions[0]!);
                return observed;
            });
            const command = fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } });
            const admitted = await fixture.service.mutate.enqueue({ command, traceId: 'revoked' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.parties.read(ref)).record).toBeNull();
            expect((await fixture.parties.readAccount(ref, 'alice')).entry).toBeNull();
            expect((await fixture.matchmaking.read({ applicationId: ref.applicationId, workspaceId: ref.workspaceId })).entry).toBeNull();
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'unauthorized' });
            expect(fixture.timing.filter((event) => event.operation === 'read')).toHaveLength(2);
        }
        finally {
            await storage.close();
        }
    });
});
