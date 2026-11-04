import { Temporal } from '@js-temporal/polyfill';
import { createPSqlResourceInboxRepository } from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type {
    ClientMutationCommand,
    ClientMutationCommandInput,
    ClientMutationComputed,
    ClientMutationRead
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toConnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-connect-client-session-mutation-input.ts';
import { toExpireClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-expire-client-session-mutation-input.ts';
import { toUpsertClientPrincipalMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-upsert-client-principal-mutation-input.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutationInvariants } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { validateClientMutationAuthorityPolicy } from '@shared-server/rallar-system/client-state/mutation/result-validation/validate-client-mutation-authority-policy.ts';
import { PartyReader } from '@shared-server/rallar-system/parties/party-reader.ts';
import { toClientSessionExpiryCandidate } from '@shared-server/rallar-system/presence/session-expiry.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodeViewInvalidation, type ViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import type { ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import { putAuthorisedWsTestTicket } from '../client-state/authorised-ws-test-ticket.ts';
import {
    createRuntime,
    ref,
    type PartyServiceFixture
} from './party-service-fixture.ts';

interface PartyPresenceAttempt {
    readonly command: ClientMutationCommand;
    readonly read: ClientMutationRead;
    readonly computed: ClientMutationComputed;
}

interface PartyPresenceFixture {
    readonly party: PartyServiceFixture;
    readonly clients: ClientStateService;
    readonly reader: PartyReader;
    notices(): Promise<readonly ViewInvalidation[]>;
    prepare(input: ClientMutationCommandInput): Promise<PartyPresenceAttempt>;
    write(attempt: PartyPresenceAttempt): Promise<void>;
}

async function presenceFixture(storage: ResourceInboxTestStorage): Promise<PartyPresenceFixture> {
    const party = await createRuntime(storage, 3);
    await party.run(party.command('alice', 'create', { ref, expectedRosterRevision: null, intent: { action: 'create' } }));
    await party.run(
        party.command('alice', 'invite', { ref, expectedRosterRevision: 0, intent: { action: 'invite', principalId: 'bob', invitationId: 'bob-invite' } })
    );
    await party.run(party.command('bob', 'join', { ref, expectedRosterRevision: null, intent: { action: 'accept', invitationId: 'bob-invite' } }));
    const clients = createClientStateService({
        runtimeRepository: party.runtime,
        clientStateEventStore: new PSqlClientStateEventRepository(storage.sql),
        serviceId: 'presence-test',
        nowMs: () => party.clock.now
    });
    const reader = new PartyReader({ parties: party.parties, clients: party.clients, nowEpochMs: () => party.clock.now }, {
        defaultMaxMembers: 3,
        maxMembersByApplication: {}
    });
    const notices = async () => {
        const rows = await storage.sql<
            { ri_resource: string; }[]
        >`select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated' order by ri_resource_id`;
        return rows.map((row) => decodeViewInvalidation(JSON.parse(JSON.parse(row.ri_resource).payload.resource)));
    };
    const prepare = async (input: ClientMutationCommandInput): Promise<PartyPresenceAttempt> => {
        const session = await party.auth.findBySessionId('sessionId' in input ? input.sessionId : `session-${input.aggregateRef.principalId}`);
        if (!session) {
            throw new Error('Missing test authority');
        }
        const command = toClientMutationCommand(
            input,
            {
                nowEpochMs: party.clock.now,
                expireAtEpochMs: party.clock.now + 60000,
                serviceId: 'presence-test',
                traceId: 'presence-test-trace',
                eventId: input.commandId,
                attemptCount: 1,
                disconnectedSessionRetentionMs: 600000
            },
            input.operation === 'expireSession'
                ? toClientMutationSystemAuthority('presence-test')
                : toClientMutationIssuedSessionAuthority(session, ref, input.operation)
        );
        const read = await clients.read(command);
        const computed = computeClientMutation({ command, read });
        assertClientMutationInvariants({ command, read, computed });
        expect(validateClientMutationAuthorityPolicy(command, read)).toEqual([]);
        return { command, read, computed };
    };
    const write = async (attempt: PartyPresenceAttempt) => {
        const computed = attempt.computed;
        if (computed.outcome === 'write' || (computed.outcome === 'no-op' && computed.persistIdempotency)) {
            await storage.sql.begin((transaction) => clients.write(transaction, computed));
        }
    };
    return { party, clients, reader, notices, prepare, write };
}

function disconnect(commandId = 'disconnect'): Extract<ClientMutationCommandInput, { operation: 'disconnectSession' | 'disconnectAuthorisedWsSession'; }> {
    return {
        operation: 'disconnectSession',
        aggregateRef: { applicationId: ref.applicationId, workspaceId: ref.workspaceId, principalId: 'alice' },
        clientInstanceId: 'browser-alice',
        sessionId: 'session-alice',
        commandId,
        requestId: commandId,
        input: {
            generationId: 'generation-alice',
            disconnectedAtEpochMs: null,
            lastHeartbeatAtEpochMs: null,
            expiresAtEpochMs: null,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null
        }
    };
}

function heartbeat(now: number): ClientMutationCommandInput {
    return {
        ...disconnect('heartbeat'),
        operation: 'heartbeatSession',
        input: {
            generationId: 'generation-alice',
            lastHeartbeatAtEpochMs: now,
            expiresAtEpochMs: now + 60000,
            presenceState: null,
            actorPrincipalId: null,
            actorSessionId: null,
            reason: null
        }
    };
}

function connect(now: number, sessionId: string, generationId: string): ClientMutationCommandInput {
    return toConnectClientSessionMutationInput({
        operation: 'connectSession',
        scope: { applicationId: ref.applicationId, workspaceId: ref.workspaceId },
        principalId: 'alice',
        clientInstanceId: 'browser-alice',
        sessionId,
        defaultCommandId: `connect-${generationId}`,
        identityDefaults: {},
        request: { requestId: `connect-${generationId}`, generationId, connectedAtEpochMs: now, lastHeartbeatAtEpochMs: now, expiresAtEpochMs: now + 60000 }
    });
}

describe('party views follow semantic client presence', () => {
    it('keeps live heartbeats quiet, notifies only members on last-session loss, and does not republish replay', async () => {
        const storage = await createResourceInboxTestStorage('party_presence');
        try {
            const fixture = await presenceFixture(storage);
            const before = await fixture.notices();
            await fixture.write(await fixture.prepare(heartbeat(fixture.party.clock.now)));
            expect(await fixture.notices()).toEqual(before);
            const command = disconnect();
            await fixture.write(await fixture.prepare(command));
            const added = (await fixture.notices()).filter((notice) => !before.some((old) => old.changeId === notice.changeId));
            expect(added.map((notice) => notice.principalId).sort()).toEqual(['alice', 'bob']);
            expect(
                (await fixture.reader.read({ applicationId: ref.applicationId, workspaceId: ref.workspaceId }, 'bob')).party?.members.find((member) =>
                    member.principalId === 'alice'
                )?.presence
            ).toBe('away');
            await fixture.write(await fixture.prepare(command));
            expect(await fixture.notices()).toHaveLength(before.length + 2);
        }
        finally {
            await storage.close();
        }
    });
    it('keeps an additional session quiet, publishes only the last departure, and publishes a new generation reconnect', async () => {
        const storage = await createResourceInboxTestStorage('party_many_sessions');
        try {
            const fixture = await presenceFixture(storage);
            const before = await fixture.notices();
            await fixture.party.auth.putSession({ ...fixture.party.sessions[0]!, sessionId: 'alice-other', accessToken: 'other-test-only' });
            await fixture.write(await fixture.prepare(connect(fixture.party.clock.now, 'alice-other', 'generation-other')));
            await fixture.write(await fixture.prepare(disconnect()));
            expect(await fixture.notices()).toEqual(before);
            const extra = disconnect('disconnect-other');
            await fixture.write(await fixture.prepare({ ...extra, sessionId: 'alice-other', input: { ...extra.input, generationId: 'generation-other' } }));
            expect(await fixture.notices()).toHaveLength(before.length + 2);
            fixture.party.clock.now += 1;
            await fixture.write(await fixture.prepare(connect(fixture.party.clock.now, 'session-alice', 'generation-reconnected')));
            expect(await fixture.notices()).toHaveLength(before.length + 4);
            expect(
                (await fixture.reader.read({ applicationId: ref.applicationId, workspaceId: ref.workspaceId }, 'bob')).party?.members.find((member) =>
                    member.principalId === 'alice'
                )?.presence
            ).toBe('present');
        }
        finally {
            await storage.close();
        }
    });

    it.each(['expire', 'resurrect'] as const)('publishes the time-derived %s transition without notifying on normal heartbeats', async (kind) => {
        const storage = await createResourceInboxTestStorage(`party_${kind}`);
        try {
            const fixture = await presenceFixture(storage);
            const session = (await fixture.clients.readSnapshot({ applicationId: ref.applicationId, workspaceId: ref.workspaceId, principalId: 'alice' }))!
                .activeSessions[0]!;
            const before = await fixture.notices();
            fixture.party.clock.now = session.expiresAtEpochMs + 1;
            await fixture.party.auth.putSession({ ...fixture.party.sessions[0]!, expiresAtEpochMs: fixture.party.clock.now + 60000 });
            const input = kind === 'expire' ? toExpireClientSessionMutationInput(toClientSessionExpiryCandidate(session)) : heartbeat(fixture.party.clock.now);
            await fixture.write(await fixture.prepare(input));
            expect(await fixture.notices()).toHaveLength(before.length + 2);
            await fixture.write(await fixture.prepare(input));
            expect(await fixture.notices()).toHaveLength(before.length + 2);
            expect(
                (await fixture.reader.read({ applicationId: ref.applicationId, workspaceId: ref.workspaceId }, 'bob')).party?.members.find((member) =>
                    member.principalId === 'alice'
                )?.presence
            ).toBe(kind === 'expire' ? 'away' : 'present');
        }
        finally {
            await storage.close();
        }
    });

    it('rejects a stale roster audience and rebases the complete mutation on current members', async () => {
        const storage = await createResourceInboxTestStorage('party_presence_roster_race');
        try {
            const fixture = await presenceFixture(storage);
            const attempt = await fixture.prepare(disconnect());
            await fixture.party.run(fixture.party.command('bob', 'leave', { ref, expectedRosterRevision: 1, intent: { action: 'leave' } }));
            const before = await fixture.notices();
            await expect(fixture.write(attempt)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await fixture.notices()).toEqual(before);
            expect((await fixture.clients.readSnapshot(attempt.command.aggregateRef))?.activeSessions).toHaveLength(1);
            await fixture.write(await fixture.prepare(disconnect()));
            const added = (await fixture.notices()).filter((notice) => !before.some((old) => old.changeId === notice.changeId));
            expect(added.map((notice) => notice.principalId)).toEqual(['alice']);
        }
        finally {
            await storage.close();
        }
    });

    it('rolls back presence, event, proof and receipt when the final view outbox insert fails', async () => {
        const storage = await createResourceInboxTestStorage('party_presence_outbox_failure');
        try {
            const fixture = await presenceFixture(storage);
            const before = await fixture.notices();
            const attempt = await fixture.prepare(disconnect());
            const beforeRows = await storage.sql<{ count: string; }[]>`select count(*)::text as count from runtime_state_store`;
            await storage.sql`create function reject_presence_notice() returns trigger language plpgsql as
                'begin if NEW.ri_topic_id = ''view.invalidated'' then return null; end if; return NEW; end'`;
            await storage.sql`create trigger reject_presence_notice before insert on resource_inbox for each row execute function reject_presence_notice()`;
            await expect(fixture.write(attempt)).rejects.toThrow();
            expect(await fixture.notices()).toEqual(before);
            expect((await fixture.clients.readSnapshot(attempt.command.aggregateRef))?.activeSessions).toHaveLength(1);
            expect(await storage.sql`select count(*)::text as count from runtime_state_store`).toEqual(beforeRows);
            expect(await fixture.clients.listEvents(attempt.command.aggregateRef)).toEqual([]);
        }
        finally {
            await storage.close();
        }
    });

    it('expires multiple sessions and members of one party in one atomic AppInbox page', async () => {
        const storage = await createResourceInboxTestStorage('party_presence_expiry_page');
        try {
            const fixture = await presenceFixture(storage);
            const alice = (await fixture.clients.readSnapshot({ applicationId: ref.applicationId, workspaceId: ref.workspaceId, principalId: 'alice' }))!
                .activeSessions[0]!;
            await fixture.party.clients.insertSession({ ...alice, sessionId: 'session-alice-extra', generationId: 'generation-extra' });
            const before = await fixture.notices();
            fixture.party.clock.now = alice.expiresAtEpochMs + 1;
            const entries = createPSqlResourceInboxRepository(storage.sql, () => new Date(fixture.party.clock.now));
            const reader = new InboxQueueReader(new PSqlQueueBox(entries, () => Temporal.Instant.fromEpochMilliseconds(fixture.party.clock.now)), {
                newLaneConcurrency: 1
            });
            const service = new AppClientInboxService({
                inboxQueueReader: reader,
                resourceInboxRepository: entries.entries,
                resourceInboxResultsRepository: new ResourceInboxResultsRepository(storage.sql),
                database: storage.sql,
                clientStateService: fixture.clients
            }, { serviceId: 'presence-test', finishedRetentionMs: 60000, disconnectedSessionRetentionMs: 600000 });
            const entry = await service.enqueueExpiredSessions(fixture.party.clock.now);
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect((await entries.entries.findByKey(entry.key))?.status).toBe(EntityStatus.COMPLETED);
            for (const principalId of ['alice', 'bob']) {
                expect(
                    (await fixture.party.clients.listSessions({
                        applicationId: ref.applicationId,
                        workspaceId: ref.workspaceId,
                        principalId,
                        clientInstanceId: `browser-${principalId}`
                    })).every((session) => session.status === 'expired')
                ).toBe(true);
            }
            const added = (await fixture.notices()).filter((notice) => !before.some((old) => old.changeId === notice.changeId));
            expect(new Set(added.map((notice) => notice.principalId))).toEqual(new Set(['alice', 'bob']));
            expect(added.length).toBeGreaterThanOrEqual(2);
            await service.enqueueExpiredSessions(fixture.party.clock.now);
            await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
            expect(await fixture.notices()).toHaveLength(before.length + added.length);
        }
        finally {
            await storage.close();
        }
    });

    it('fences a concurrent party creation even when the presence read saw no party', async () => {
        const storage = await createResourceInboxTestStorage('party_presence_join_race');
        try {
            const fixture = await presenceFixture(storage);
            await fixture.party.run(fixture.party.command('alice', 'leave', { ref, expectedRosterRevision: 1, intent: { action: 'leave' } }));
            const attempt = await fixture.prepare(disconnect());
            const nextRef = { ...ref, partyId: 'new-party' };
            await fixture.party.run(fixture.party.command('alice', 'new-party', { ref: nextRef, expectedRosterRevision: null, intent: { action: 'create' } }));
            const before = await fixture.notices();
            await expect(fixture.write(attempt)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
            expect(await fixture.notices()).toEqual(before);
            await fixture.write(await fixture.prepare(disconnect()));
            expect(await fixture.notices()).toHaveLength(before.length + 1);
        }
        finally {
            await storage.close();
        }
    });

    it('publishes the visible identity edit to members without sending an unrelated principal a notice', async () => {
        const storage = await createResourceInboxTestStorage('party_presence_identity');
        try {
            const fixture = await presenceFixture(storage);
            const before = await fixture.notices();
            await fixture.write(
                await fixture.prepare(
                    toUpsertClientPrincipalMutationInput({
                        scope: { applicationId: ref.applicationId, workspaceId: ref.workspaceId },
                        principalId: 'alice',
                        defaultCommandId: 'rename',
                        request: { requestId: 'rename', username: 'alice', displayName: 'Alice Renamed' }
                    })
                )
            );
            expect(await fixture.notices()).toHaveLength(before.length + 2);
            const view = await fixture.reader.read({ applicationId: ref.applicationId, workspaceId: ref.workspaceId }, 'bob');
            expect(view.party?.members.find((member) => member.principalId === 'alice')?.displayName).toBe('Alice Renamed');
        }
        finally {
            await storage.close();
        }
    });

    it('includes a reconnect notice in the guarded WebSocket ticket transaction and rejects ticket replay', async () => {
        const storage = await createResourceInboxTestStorage('party_presence_ws_connect');
        try {
            const fixture = await presenceFixture(storage);
            await fixture.write(await fixture.prepare(disconnect()));
            const before = await fixture.notices();
            const entries = createPSqlResourceInboxRepository(storage.sql, () => new Date(fixture.party.clock.now));
            const reader = new InboxQueueReader(new PSqlQueueBox(entries, () => Temporal.Instant.fromEpochMilliseconds(fixture.party.clock.now)), {
                newLaneConcurrency: 1
            });
            const service = new AppClientInboxService({
                inboxQueueReader: reader,
                resourceInboxRepository: entries.entries,
                resourceInboxResultsRepository: new ResourceInboxResultsRepository(storage.sql),
                database: storage.sql,
                clientStateService: fixture.clients
            }, { serviceId: 'presence-test', finishedRetentionMs: 60000, disconnectedSessionRetentionMs: 600000 });
            const session = fixture.party.sessions[0]!;
            const ticketDigest = await putAuthorisedWsTestTicket(fixture.party.auth, session);
            for (const generationId of ['generation-new', 'generation-replay']) {
                const pending = service.writeAuthorisedWsClientConnect({
                    authSession: session,
                    generationId,
                    ticketDigest,
                    traceId: 'ws-presence-test',
                    input: {
                        applicationId: ref.applicationId,
                        workspaceId: ref.workspaceId,
                        clientInstanceId: 'browser-alice',
                        connectedAtEpochMs: fixture.party.clock.now + 1
                    }
                });
                await expect.poll(async () =>
                    (await storage.sql<{ count: string; }[]>`select count(*)::text as count from resource_inbox where ri_topic_id='app-inbox.client-state'`)[0]
                        ?.count
                ).toBe(generationId === 'generation-new' ? '1' : '2');
                await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
                expect((await pending).right?.status).toBe(generationId === 'generation-new' ? 'ok' : 'ticket-rejected');
                expect(await fixture.notices()).toHaveLength(before.length + 2);
            }
        }
        finally {
            await storage.close();
        }
    });
});
