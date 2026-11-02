import { MatchmakingService } from '@shared-server/rallar-system/matchmaking/matchmaking-service.ts';
import { PartyService } from '@shared-server/rallar-system/parties/party-service.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createSqlServerAppInbox } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { createRuntime, policy, ref } from './party-service-fixture.ts';

const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };

describe('party matchmaking through authenticated AppInbox', () => {
    it('lets only the party leader start the entire roster and admits one room after every account confirms', async () => {
        const storage = await createResourceInboxTestStorage('party_matchmaking_admission');
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
            await fixture.run(
                fixture.command('bob', 'accept', { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'invite-bob' } })
            );
            const start = { action: 'start-party' as const, partyId: ref.partyId, rosterRevision: 1, searchId: 'party-search' };
            expect(await fixture.runMatch(fixture.matchCommand('bob', 'not-leader', start)))
                .toMatchObject({ status: 'refused', code: 'party-leader-required' });
            expect(await fixture.runMatch(fixture.matchCommand('alice', 'solo', { action: 'start', searchId: 'solo' })))
                .toMatchObject({ status: 'refused', code: 'party-required' });
            expect(await fixture.runMatch(fixture.matchCommand('alice', 'start-party', start))).toMatchObject({ status: 'applied' });
            const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
            const proposal = (await fixture.matchmaking.read(scope)).pool.proposals[0]!;
            expect(proposal.participants.map((participant) => participant.principalId)).toEqual(['alice', 'bob']);
            for (const participant of proposal.participants) {
                expect(await fixture.groups.readSnapshot(proposal.roomRef)).toBeUndefined();
                expect(
                    await fixture.runMatch(
                        fixture.matchCommand(participant.principalId, `confirm-${participant.principalId}`, {
                            action: 'confirm',
                            searchId: participant.searchId
                        })
                    )
                ).toMatchObject({ status: 'applied' });
            }
            expect((await fixture.groups.readSnapshot(proposal.roomRef))?.members.map((member) => member.principalId).sort())
                .toEqual(['alice', 'bob']);
            expect((await fixture.parties.read(ref)).record?.rosterRevision).toBe(1);
            expect((await fixture.matchmaking.read(scope)).partySearches).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('fills the remaining seats from public searches without splitting the party', async () => {
        const storage = await createResourceInboxTestStorage('party_public_fill');
        try {
            const fixture = await createRuntime(storage, 4);
            await formParty(fixture);
            await fixture.runMatch(fixture.matchCommand('carol', 'carol-search', { action: 'start', searchId: 'carol-search' }));
            await fixture.runMatch(fixture.matchCommand('alice', 'party-search', {
                action: 'start-party',
                partyId: ref.partyId,
                rosterRevision: 1,
                searchId: 'party-search'
            }));
            expect((await fixture.matchmaking.read(scope)).pool.proposals).toEqual([]);
            await fixture.runMatch(fixture.matchCommand('dan', 'dan-search', { action: 'start', searchId: 'dan-search' }));
            const proposal = (await fixture.matchmaking.read(scope)).pool.proposals[0]!;
            expect(proposal.participants.map((member) => member.principalId).sort()).toEqual(['alice', 'bob', 'carol', 'dan']);
            for (const member of proposal.participants) {
                expect(await fixture.groups.readSnapshot(proposal.roomRef)).toBeUndefined();
                await fixture.runMatch(fixture.matchCommand(member.principalId, `confirm-${member.principalId}`, {
                    action: 'confirm',
                    searchId: member.searchId
                }));
            }
            expect((await fixture.groups.readSnapshot(proposal.roomRef))?.members.map((member) => member.principalId).sort())
                .toEqual(['alice', 'bob', 'carol', 'dan']);
        }
        finally {
            await storage.close();
        }
    });

    it('refuses stale rosters and members with no live authenticated presence without reserving seats', async () => {
        const storage = await createResourceInboxTestStorage('party_search_authority');
        try {
            const fixture = await createRuntime(storage);
            await formParty(fixture);
            expect(
                await fixture.runMatch(fixture.matchCommand('alice', 'stale', {
                    action: 'start-party',
                    partyId: ref.partyId,
                    rosterRevision: 0,
                    searchId: 'stale'
                }))
            ).toMatchObject({ status: 'refused', code: 'party-changed' });
            await fixture.auth.deleteSession(fixture.sessions[1]!);
            expect(
                await fixture.runMatch(fixture.matchCommand('alice', 'away', {
                    action: 'start-party',
                    partyId: ref.partyId,
                    rosterRevision: 1,
                    searchId: 'away'
                }))
            ).toMatchObject({ status: 'refused', code: 'party-member-away' });
            const pool = await fixture.matchmaking.read(scope);
            expect(pool.pool.searching).toEqual([]);
            expect(pool.pool.proposals).toEqual([]);
            expect(pool.partySearches).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('rolls back a final confirmation when a party leave wins after the admission read', async () => {
        const storage = await createResourceInboxTestStorage('party_confirmation_leave_race');
        try {
            const fixture = await createRuntime(storage);
            await formParty(fixture);
            await fixture.runMatch(fixture.matchCommand('alice', 'search', {
                action: 'start-party',
                partyId: ref.partyId,
                rosterRevision: 1,
                searchId: 'party-search'
            }));
            const proposal = (await fixture.matchmaking.read(scope)).pool.proposals[0]!;
            const alice = proposal.participants.find((member) => member.principalId === 'alice')!;
            const bob = proposal.participants.find((member) => member.principalId === 'bob')!;
            await fixture.runMatch(fixture.matchCommand('alice', 'confirm-alice', { action: 'confirm', searchId: alice.searchId }));
            const competingQueue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => fixture.clock.now });
            const partyWriter = new PartyService({
                appInbox: competingQueue.inbox,
                parties: fixture.parties,
                matchmaking: fixture.matchmaking,
                profiles: fixture.profiles,
                authSessions: fixture.auth,
                clients: fixture.clients,
                nowEpochMs: () => fixture.clock.now,
                timing: undefined
            }, { defaultPolicy: policy, policiesByApplication: {}, finishedRetentionMs: 60000 });
            competingQueue.inbox.start();
            const readAdmission = fixture.groups.readMutationExactEntries.bind(fixture.groups);
            vi.spyOn(fixture.groups, 'readMutationExactEntries').mockImplementationOnce(async (input) => {
                const read = await readAdmission(input);
                const left = await partyWriter.mutate.enqueue({
                    command: fixture.command('bob', 'leave', { ref, expectedRosterRevision: 1, intent: { action: 'leave' } }),
                    traceId: 'leave-wins'
                });
                await competingQueue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                expect((await left.right!.wait()).right).toMatchObject({ status: 'applied' });
                return read;
            });
            const command = fixture.matchCommand('bob', 'confirm-bob', { action: 'confirm', searchId: bob.searchId });
            const final = await fixture.matchService.mutate.enqueue({ command, traceId: 'stale-confirmation' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.groups.readSnapshot(proposal.roomRef)).toBeUndefined();
            expect((await fixture.matchmaking.read(scope)).pool.proposals).toEqual([]);
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await final.right!.wait()).right).toMatchObject({ status: 'refused', code: 'search-ended' });
            expect((await fixture.parties.read(ref)).record?.members.map((member) => member.principalId)).toEqual(['alice']);
            for (const principalId of ['alice', 'bob']) {
                expect((await fixture.matchmaking.readCurrent({ scope, principalId, nowEpochMs: fixture.clock.now })).finished?.reason)
                    .toBe('declined');
            }
        }
        finally {
            await storage.close();
        }
    });
    it('preserves the admitted room when confirmation wins over a stale party leave', async () => {
        const storage = await createResourceInboxTestStorage('party_leave_confirmation_race');
        try {
            const fixture = await createRuntime(storage);
            await formParty(fixture);
            await fixture.runMatch(fixture.matchCommand('alice', 'search', {
                action: 'start-party',
                partyId: ref.partyId,
                rosterRevision: 1,
                searchId: 'party-search'
            }));
            const proposal = (await fixture.matchmaking.read(scope)).pool.proposals[0]!;
            const alice = proposal.participants.find((member) => member.principalId === 'alice')!;
            const bob = proposal.participants.find((member) => member.principalId === 'bob')!;
            await fixture.runMatch(fixture.matchCommand('alice', 'confirm-alice', { action: 'confirm', searchId: alice.searchId }));
            const competingQueue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => fixture.clock.now });
            const matchWriter = new MatchmakingService({
                appInbox: competingQueue.inbox,
                repository: fixture.matchmaking,
                parties: fixture.parties,
                authSessions: fixture.auth,
                clients: fixture.clients,
                groups: fixture.groups,
                nowEpochMs: () => fixture.clock.now,
                timing: undefined
            }, {
                serviceId: 'party-test',
                finishedRetentionMs: 60000,
                policiesByApplication: {},
                defaultPolicy: { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 }
            });
            competingQueue.inbox.start();
            const readPool = fixture.matchmaking.read.bind(fixture.matchmaking);
            vi.spyOn(fixture.matchmaking, 'read').mockImplementationOnce(async (...args) => {
                const read = await readPool(...args);
                const admitted = await matchWriter.mutate.enqueue({
                    command: fixture.matchCommand('bob', 'confirm-bob', { action: 'confirm', searchId: bob.searchId }),
                    traceId: 'confirmation-wins'
                });
                await competingQueue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                expect((await admitted.right!.wait()).right).toMatchObject({ status: 'applied' });
                return read;
            });
            const command = fixture.command('bob', 'leave', { ref, expectedRosterRevision: 1, intent: { action: 'leave' } });
            const leave = await fixture.service.mutate.enqueue({ command, traceId: 'stale-leave' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.groups.readSnapshot(proposal.roomRef))?.members.map((member) => member.principalId).sort())
                .toEqual(['alice', 'bob']);
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await leave.right!.wait()).right).toMatchObject({ status: 'applied' });
            expect((await fixture.parties.read(ref)).record?.members.map((member) => member.principalId)).toEqual(['alice']);
            expect((await fixture.groups.readSnapshot(proposal.roomRef))?.members.map((member) => member.principalId).sort())
                .toEqual(['alice', 'bob']);
            for (const principalId of ['alice', 'bob']) {
                expect((await fixture.matchmaking.readCurrent({ scope, principalId, nowEpochMs: fixture.clock.now })).finished)
                    .toMatchObject({ reason: 'matched', roomRef: proposal.roomRef });
            }
        }
        finally {
            await storage.close();
        }
    });

    it('rolls back the whole search when a member logs out after the presence authorization read', async () => {
        const storage = await createResourceInboxTestStorage('party_search_logout_race');
        try {
            const fixture = await createRuntime(storage);
            await formParty(fixture);
            const readSession = fixture.auth.findSessionBySessionIdEntry.bind(fixture.auth);
            let revoked = false;
            vi.spyOn(fixture.auth, 'findSessionBySessionIdEntry').mockImplementation(async (sessionId) => {
                const read = await readSession(sessionId);
                if (sessionId === fixture.sessions[1]!.sessionId && !revoked) {
                    revoked = true;
                    await fixture.auth.deleteSession(fixture.sessions[1]!);
                }
                return read;
            });
            const command = fixture.matchCommand('alice', 'start', {
                action: 'start-party',
                partyId: ref.partyId,
                rosterRevision: 1,
                searchId: 'party-search'
            });
            const start = await fixture.matchService.mutate.enqueue({ command, traceId: 'member-revoked' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            const after = await fixture.matchmaking.read(scope);
            expect(after.pool.searching).toEqual([]);
            expect(after.pool.proposals).toEqual([]);
            expect(after.partySearches).toEqual([]);
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await start.right!.wait()).right).toMatchObject({ status: 'refused', code: 'party-member-away' });
        }
        finally {
            await storage.close();
        }
    });
});

async function formParty(fixture: Awaited<ReturnType<typeof createRuntime>>): Promise<void> {
    expect(await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } })))
        .toMatchObject({ status: 'applied' });
    expect(
        await fixture.run(
            fixture.command('alice', 'invite', { ref, expectedRosterRevision: 0, intent: { action: 'invite', principalId: 'bob', invitationId: 'invite-bob' } })
        )
    ).toMatchObject({ status: 'applied' });
    expect(await fixture.run(fixture.command('bob', 'accept', { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'invite-bob' } })))
        .toMatchObject({ status: 'applied' });
}
