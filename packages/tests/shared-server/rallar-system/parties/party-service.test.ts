import { AuthSessionRepository } from '@shared-server/rallar-system/auth/persistence/auth-session-repository.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/client-state/persistence/client-state-repository.ts';
import { FriendsRepository } from '@shared-server/rallar-system/friends/friends-repository.ts';
import type { RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';
import type { PartyCommand } from '@shared-server/rallar-system/parties/party-command.ts';
import { PartyService } from '@shared-server/rallar-system/parties/party-service.ts';
import { PartyRepository } from '@shared-server/rallar-system/parties/persistence/party-repository.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { PSqlRuntimeStateRepository } from '@shared-server/runtime-state/postgres/p-sql-runtime-state-repository.ts';
import type { ClientPrincipal, ClientSession } from '@shared/api/client-types.ts';
import type { PartyRequest } from '@shared/api/parties/party-request.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { describe, expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import type { ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createSqlServerAppInbox } from '../../rallar-server/create-test-server-app-inbox.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';

const ref = { applicationId: 'game', workspaceId: 'default', partyId: 'party-one' };
const policy = { maxMembers: 2, maxInvitations: 16, invitationLifetimeMs: 600000 };

async function createRuntime(storage: ResourceInboxTestStorage) {
    const clock = { now: Date.now() };
    const runtime = new PSqlRuntimeStateRepository(storage.sql);
    const queue = createSqlServerAppInbox({ database: storage.sql, nowEpochMs: () => clock.now });
    const auth = new AuthSessionRepository(runtime);
    const parties = new PartyRepository(runtime, () => clock.now);
    const profiles = new FriendsRepository(runtime);
    const clients = new ClientStateRepository(runtime, new PSqlClientStateEventRepository(storage.sql));
    const sessions = ['alice', 'bob'].map((principalId) => ({
        clientId: principalId,
        username: principalId,
        sessionId: `session-${principalId}`,
        accessToken: `test-only-${principalId}`,
        issuedAtEpochMs: clock.now - 1000,
        expiresAtEpochMs: clock.now + 60000
    }));
    for (const session of sessions) {
        await auth.putSession(session);
        const principalId = session.clientId;
        const audit = {
            atEpochMs: clock.now - 1000,
            actor: { kind: 'service' as const, serviceId: 'party-test' },
            reason: null,
            traceId: null,
            requestId: null
        };
        const principal: ClientPrincipal = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId,
            username: principalId,
            displayName: principalId,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            roles: [],
            metadata: {},
            snapshotVersion: 1,
            profileVersion: 1,
            presenceVersion: 1,
            created: audit,
            updated: audit,
            lastSeenAtEpochMs: clock.now - 1000,
            status: 'active',
            disabled: null,
            deleted: null
        };
        await clients.insertPrincipal(principal);
        await clients.insertInstance({
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId,
            clientInstanceId: `browser-${principalId}`,
            platform: 'web',
            deviceLabel: null,
            appVersion: null,
            userAgent: null,
            capabilities: [],
            registered: audit,
            updated: audit,
            status: 'active',
            revoked: null
        });
        const presence: ClientSession = {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            principalId,
            clientInstanceId: `browser-${principalId}`,
            sessionId: session.sessionId,
            generationId: `generation-${principalId}`,
            generationVersion: 1,
            presenceState: 'online',
            transport: 'http',
            connectionId: null,
            authenticatedAtEpochMs: session.issuedAtEpochMs,
            connectedAtEpochMs: session.issuedAtEpochMs,
            lastHeartbeatAtEpochMs: session.issuedAtEpochMs,
            expiresAtEpochMs: session.expiresAtEpochMs,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null
        };
        await clients.insertSession(presence);
        await runtime.upsert(
            'friends:profiles',
            `principal=${principalId}`,
            JSON.stringify({
                principalId,
                shareOnline: false,
                contacts: [{ principalId: principalId === 'alice' ? 'bob' : 'alice', status: 'friend' }],
                invitations: []
            }),
            NEVER_EXPIRE_AT_TIMESTAMP
        );
    }
    const timing: RallarTimingEvent[] = [];
    const service = new PartyService({
        appInbox: queue.inbox,
        parties,
        profiles,
        authSessions: auth,
        clients,
        nowEpochMs: () => clock.now,
        timing: (event) => timing.push(event)
    }, { defaultPolicy: policy, policiesByApplication: {} });
    queue.inbox.start();
    function command(principalId: string, requestId: string, request: PartyRequest): PartyCommand {
        const session = sessions.find((candidate) => candidate.clientId === principalId)!;
        return {
            principalId,
            sessionId: session.sessionId,
            sessionIssuedAtEpochMs: session.issuedAtEpochMs,
            sessionExpiresAtEpochMs: session.expiresAtEpochMs,
            requestId,
            request,
            capturedAtEpochMs: null,
            policy: null
        };
    }
    async function run(input: PartyCommand) {
        const enqueued = await service.mutate.enqueue({ command: input, traceId: input.requestId });
        expect(enqueued.left).toBeUndefined();
        await queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        const result = await enqueued.right!.wait();
        expect(result.left).toBeUndefined();
        return result.right;
    }
    return { clock, runtime, queue, auth, parties, profiles, clients, sessions, service, command, run, timing };
}

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
            const admitted = await fixture.service.mutate.enqueue({ command, traceId: 'friendship-race' });
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await fixture.parties.read(ref)).record?.members.map((member) => member.principalId)).toEqual(['alice']);
            expect((await fixture.parties.readAccount(ref, 'bob')).account.partyId).toBeNull();
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'person-unavailable' });
            expect((await fixture.parties.read(ref)).record?.invitations).toHaveLength(1);
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
            await fixture.queue.reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await admitted.right!.wait()).right).toMatchObject({ status: 'refused', code: 'unauthorized' });
            expect(fixture.timing.filter((event) => event.operation === 'read')).toHaveLength(2);
        }
        finally {
            await storage.close();
        }
    });
});
