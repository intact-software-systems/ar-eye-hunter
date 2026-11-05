import { PartyReader } from '@shared-server/rallar-system/parties/party-reader.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createRuntime, policy, ref } from './party-service-fixture.ts';

const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };

describe('private party recovery', () => {
    let storage: ResourceInboxTestStorage;
    beforeEach(async () => {
        storage = await createResourceInboxTestStorage('party_reader');
        return () => storage.close();
    });

    it('reveals only the recipient invitation until acceptance, then scoped member presence, and removes access after leave', async () => {
        const fixture = await createRuntime(storage, 4);
        const reader = new PartyReader({ parties: fixture.parties, clients: fixture.clients, nowEpochMs: () => fixture.clock.now }, {
            defaultMaxMembers: 2,
            maxMembersByApplication: { game: 4 }
        });
        await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
        await fixture.run(
            fixture.command('alice', 'invite', {
                ref,
                expectedRosterRevision: 0,
                intent: { action: 'invite', principalId: 'bob', invitationId: 'invitation-bob' }
            })
        );
        const invitation = {
            ref,
            invitationId: 'invitation-bob',
            senderPrincipalId: 'alice',
            principalId: 'bob',
            createdAtEpochMs: fixture.clock.now,
            expiresAtEpochMs: fixture.clock.now + policy.invitationLifetimeMs
        };
        expect(await reader.read(scope, 'bob')).toEqual({
            scope,
            principalId: 'bob',
            observedAtEpochMs: fixture.clock.now,
            maxMembers: 4,
            party: null,
            invitations: [invitation]
        });
        expect(await reader.read(scope, 'carol')).toMatchObject({ party: null, invitations: [] });
        expect(await reader.read({ ...scope, workspaceId: 'other' }, 'alice')).toMatchObject({ party: null, invitations: [] });
        expect((await reader.read(scope, 'alice')).party?.invitations).toHaveLength(1);
        await fixture.run(
            fixture.command('bob', 'accept', { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'invitation-bob' } })
        );
        const accepted = await reader.read(scope, 'bob');
        expect(accepted.party).toEqual({
            ref,
            rosterRevision: 1,
            leaderPrincipalId: 'alice',
            invitations: [],
            members: [
                { principalId: 'alice', joinedAtEpochMs: fixture.clock.now, displayName: 'alice', presence: 'present' },
                { principalId: 'bob', joinedAtEpochMs: fixture.clock.now, displayName: 'bob', presence: 'present' }
            ]
        });
        expect(accepted.invitations).toEqual([]);
        expect(JSON.stringify(accepted)).not.toMatch(/session-|browser-|generation-|accessToken|roomRef/);
        const original = (await fixture.parties.read(ref)).record;
        fixture.clock.now += 60000;
        expect((await reader.read(scope, 'bob')).party?.members.map((member) => member.presence)).toEqual(['away', 'away']);
        expect((await fixture.parties.read(ref)).record).toEqual(original);
        fixture.clock.now -= 60000;
        await fixture.run(fixture.command('bob', 'leave', { ref, expectedRosterRevision: 1, intent: { action: 'leave' } }));
        expect(await reader.read(scope, 'bob')).toMatchObject({ party: null, invitations: [] });
    });

    it.each(['', '   '])('keeps the roster readable when a member has an empty display name (%j)', async (displayName) => {
        const fixture = await createRuntime(storage);
        await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
        const snapshot = await fixture.clients.readSnapshot({ ...scope, principalId: 'alice' });
        if (!snapshot) {
            throw new Error('Expected the seeded client snapshot');
        }
        const reader = new PartyReader({
            parties: fixture.parties,
            clients: { readSnapshot: async () => ({ ...snapshot, principal: { ...snapshot.principal, displayName } }) },
            nowEpochMs: () => fixture.clock.now
        }, { defaultMaxMembers: 2, maxMembersByApplication: {} });
        expect((await reader.read(scope, 'alice')).party?.members).toEqual([
            { principalId: 'alice', joinedAtEpochMs: fixture.clock.now, displayName: 'alice', presence: 'present' }
        ]);
    });

    it('hides expired invitations without repairing storage and rejects corrupt identities before expiry filtering', async () => {
        const fixture = await createRuntime(storage);
        const reader = new PartyReader({ parties: fixture.parties, clients: fixture.clients, nowEpochMs: () => fixture.clock.now }, {
            defaultMaxMembers: 2,
            maxMembersByApplication: {}
        });
        await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
        await fixture.run(
            fixture.command('alice', 'invite', {
                ref,
                expectedRosterRevision: 0,
                intent: { action: 'invite', principalId: 'bob', invitationId: 'invitation-bob' }
            })
        );
        const stored = await fixture.parties.readAccount(scope, 'bob');
        fixture.clock.now += policy.invitationLifetimeMs;
        expect(await reader.read(scope, 'bob')).toMatchObject({ party: null, invitations: [] });
        expect(await fixture.parties.readAccount(scope, 'bob')).toEqual(stored);
        const party = await fixture.parties.read(ref);
        await fixture.runtime.upsert(
            {
                namespace: 'parties:records',
                key: party.entry!.key,
                value: JSON.stringify({ ...party.record, ref: { ...ref, workspaceId: 'foreign' } }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
        await expect(reader.read(scope, 'bob')).rejects.toThrow(/identity|scope/);
        await fixture.runtime.upsert({
            namespace: 'parties:records',
            key: party.entry!.key,
            value: party.entry!.value,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        const corrupted = JSON.stringify({ ...stored.account, scope: { ...scope, workspaceId: 'foreign' } });
        await fixture.runtime.upsert({
            namespace: 'parties:accounts',
            key: stored.entry!.key,
            value: corrupted,
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        await expect(reader.read(scope, 'bob')).rejects.toThrow(/identity|scope/);
    });
    it('refuses a mixed snapshot when the account leaves between enumeration and the batch read', async () => {
        const fixture = await createRuntime(storage);
        const reader = new PartyReader({ parties: fixture.parties, clients: fixture.clients, nowEpochMs: () => fixture.clock.now }, {
            defaultMaxMembers: 2,
            maxMembersByApplication: {}
        });
        await fixture.run(fixture.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
        const readBatch = fixture.runtime.readRuntimeStateBatch.bind(fixture.runtime);
        vi.spyOn(fixture.runtime, 'readRuntimeStateBatch').mockImplementationOnce(async (selectors) => {
            expect(await fixture.run(fixture.command('alice', 'leave', { ref, expectedRosterRevision: 0, intent: { action: 'leave' } }))).toMatchObject({
                status: 'applied'
            });
            return await readBatch(selectors);
        });
        await expect(reader.read(scope, 'alice')).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await reader.read(scope, 'alice')).toMatchObject({ party: null, invitations: [] });
    });
});
