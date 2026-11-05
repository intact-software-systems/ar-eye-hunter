import { Temporal } from '@js-temporal/polyfill';
import {
    createPSqlResourceInboxRepository,
    type PSqlResourceInboxRepository
} from '@shared-server/queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { PSqlQueueBox } from '@shared-server/queuebox/postgres/p-sql-queue-box.ts';
import { ResourceInboxResultsRepository } from '@shared-server/queuebox/postgres/resource-inbox-results-repository.ts';
import type { ClientStateService } from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';
import { createClientStateService } from '@shared-server/rallar-system/client-state/client-state-service.ts';
import { AppClientInboxService } from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-service.ts';
import { isClientSnapshotPresent } from '@shared-server/rallar-system/client-state/is-client-snapshot-present.ts';
import {
    toClientMutationIssuedSessionAuthority,
    toClientMutationSystemAuthority
} from '@shared-server/rallar-system/client-state/mutation/client-mutation-authority.ts';
import { toClientMutationCommand } from '@shared-server/rallar-system/client-state/mutation/client-mutation-command.ts';
import type { ClientMutationCommandInput } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { toDisconnectClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-disconnect-client-session-mutation-input.ts';
import { toHeartbeatClientSessionMutationInput } from '@shared-server/rallar-system/client-state/mutation/command-input/to-heartbeat-client-session-mutation-input.ts';
import type { ClientExpiryAttempt } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-expiry-sequence.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { assertClientMutationInvariants } from '@shared-server/rallar-system/client-state/mutation/result-validation/assert-client-mutation.ts';
import { computeFriendsMutation, validateFriendsMutation } from '@shared-server/rallar-system/friends/compute-friends-mutation.ts';
import { assertFriendsPresenceRead } from '@shared-server/rallar-system/friends/compute-friends-presence-publication.ts';
import type { FriendsMutationComputed } from '@shared-server/rallar-system/friends/friends-mutation-contracts.ts';
import { FRIENDS_PROFILE_NAMESPACE, friendsProfileKey } from '@shared-server/rallar-system/friends/friends-profile.ts';
import { writeFriendsMutation } from '@shared-server/rallar-system/friends/write-friends-mutation.ts';
import { PARTY_ACCOUNTS_NAMESPACE, partyAccountKey } from '@shared-server/rallar-system/parties/persistence/party-account.ts';
import { PSqlClientStateEventRepository } from '@shared-server/rallar-system/state-events/postgres/p-sql-client-state-event-repository.ts';
import { RuntimeStateWriteConflictError } from '@shared-server/runtime-state/optimistic-runtime-state-write.ts';
import { decodePersistedALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeViewInvalidationMessage, type ViewInvalidation } from '@shared/api/views/view-invalidation.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import { InboxQueueReader } from '@shared/services/inbox-queue-reader.ts';
import { expect, it, vi } from 'vitest';
import { createResourceInboxTestStorage, type ResourceInboxTestStorage } from '../../queuebox/resource-inbox-test-storage.ts';
import { createAppInboxTestResilience } from '../app-inbox/test-support/app-inbox-resource-fixtures.ts';
import {
    createRuntime,
    ref,
    type PartyServiceFixture
} from '../parties/party-service-fixture.ts';

const scope = { applicationId: ref.applicationId, workspaceId: ref.workspaceId };
const postgresIt = process.env.RALLAR_POSTGRES_INTEGRATION === '1' ? it : it.skip;

interface FriendsPresenceFixture {
    readonly party: PartyServiceFixture;
    readonly clients: ClientStateService;
    prepare(input: ClientMutationCommandInput): Promise<ClientExpiryAttempt>;
    write(attempt: ClientExpiryAttempt): Promise<void>;
    notices(): Promise<readonly (ViewInvalidation.ScopedAccount | ViewInvalidation.Account)[]>;
}

async function fixture(storage: ResourceInboxTestStorage): Promise<FriendsPresenceFixture> {
    const party = await createRuntime(storage, 3);
    const clients = createClientStateService({
        runtimeRepository: party.runtime,
        clientStateEventStore: new PSqlClientStateEventRepository(storage.sql),
        serviceId: 'friends-presence-test',
        nowMs: () => party.clock.now
    });
    return {
        party,
        clients,
        prepare: (input) => preparePresence(party, clients, input),
        async write({ mutation }) {
            if (mutation.outcome === 'write' || (mutation.outcome === 'no-op' && mutation.persistIdempotency)) {
                await storage.sql.begin((transaction) => clients.write(transaction, mutation));
            }
        },
        async notices() {
            const rows = await storage.sql<readonly { ri_resource: string; }[]>`
                select ri_resource from resource_inbox where ri_topic_id = 'view.invalidated' order by ri_resource_id`;
            return rows.map((row) => {
                const notice = decodeViewInvalidationMessage(decodePersistedALMessageValue(JSON.parse(row.ri_resource)));
                if (notice.principalId === null) {
                    throw new Error('Private presence fixture received a public catalog notice');
                }
                return notice;
            });
        }
    };
}

async function preparePresence(party: PartyServiceFixture, clients: ClientStateService, input: ClientMutationCommandInput): Promise<ClientExpiryAttempt> {
    const session = await party.auth.findBySessionId('sessionId' in input ? input.sessionId : `session-${input.aggregateRef.principalId}`);
    if (!session && input.operation !== 'expireSession') {
        throw new Error('Missing persisted test authority');
    }
    const command = toClientMutationCommand(
        input,
        {
            nowEpochMs: party.clock.now,
            expireAtEpochMs: party.clock.now + 60000,
            serviceId: 'friends-presence-test',
            traceId: 'friends-presence-trace',
            eventId: input.commandId,
            attemptCount: 1,
            disconnectedSessionRetentionMs: 600000
        },
        input.operation === 'expireSession'
            ? toClientMutationSystemAuthority('friends-presence-test')
            : toClientMutationIssuedSessionAuthority(session!, ref, input.operation)
    );
    const read = await clients.read(command);
    const mutation = computeClientMutation({ command, read });
    assertClientMutationInvariants({ command, read, computed: mutation });
    return { command, read, mutation };
}

function disconnect(principalId = 'alice', sessionId = `session-${principalId}`, generationId = `generation-${principalId}`): ClientMutationCommandInput {
    return toDisconnectClientSessionMutationInput({
        operation: 'disconnectSession',
        scope,
        principalId,
        clientInstanceId: `browser-${principalId}`,
        sessionId,
        request: { generationId, requestId: `disconnect-${sessionId}` },
        defaultCommandId: `disconnect-${sessionId}`
    });
}

async function shareOnline(test: FriendsPresenceFixture, visible: boolean, principalId = 'alice'): Promise<void> {
    const { profile } = await test.party.profiles.readProfile(principalId);
    await test.party.runtime.upsert(
        {
            namespace: FRIENDS_PROFILE_NAMESPACE,
            key: friendsProfileKey(principalId),
            value: JSON.stringify({ ...profile, shareOnline: visible }),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        }
    );
}

it('publishes only the consenting friend in the changed scope and keeps ordinary heartbeats and replay quiet', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        await test.write(
            await test.prepare(toHeartbeatClientSessionMutationInput({
                scope,
                principalId: 'alice',
                clientInstanceId: 'browser-alice',
                sessionId: 'session-alice',
                request: { generationId: 'generation-alice', requestId: 'heartbeat' },
                defaultCommandId: 'heartbeat'
            }))
        );
        expect(await test.notices()).toEqual([]);
        await test.write(await test.prepare(disconnect()));
        const notices = await test.notices();
        expect(notices).toHaveLength(1);
        expect(notices[0]).toMatchObject({
            resource: 'friends',
            principalId: 'bob',
            scope: { applicationId: ref.applicationId, workspaceId: ref.workspaceId }
        });
        await test.write(await test.prepare(disconnect()));
        expect(await test.notices()).toEqual(notices);
    }
    finally {
        await storage.close();
    }
});

it('fences consent even when sharing was hidden, then rereads the visible audience on outer retry', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence_visibility');
    try {
        const test = await fixture(storage);
        const attempt = await test.prepare(disconnect());
        await shareOnline(test, true);
        await expect(test.write(attempt)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect(await test.notices()).toEqual([]);
        expect((await test.clients.readSnapshot(attempt.command.aggregateRef))?.activeSessions).toHaveLength(1);
        await test.write(await test.prepare(disconnect()));
        expect((await test.notices()).map((notice) => notice.principalId)).toEqual(['bob']);
    }
    finally {
        await storage.close();
    }
});

it('fences an absent profile against concurrent creation and revokes a stale mutual audience before writing', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence_consent');
    try {
        const test = await fixture(storage);
        const previous = await test.party.profiles.readProfile('alice');
        await test.party.runtime.deleteByKey(FRIENDS_PROFILE_NAMESPACE, friendsProfileKey('alice'));
        const absent = await test.prepare(disconnect());
        await test.party.runtime.upsert(
            {
                namespace: FRIENDS_PROFILE_NAMESPACE,
                key: friendsProfileKey('alice'),
                value: JSON.stringify({ ...previous.profile, shareOnline: true }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
        await expect(test.write(absent)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        const shared = await test.prepare(disconnect());
        const bob = await test.party.profiles.readProfile('bob');
        await test.party.runtime.upsert(
            {
                namespace: FRIENDS_PROFILE_NAMESPACE,
                key: friendsProfileKey('bob'),
                value: JSON.stringify({ ...bob.profile, contacts: [] }),
                expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
            }
        );
        await expect(test.write(shared)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await test.write(await test.prepare(disconnect()));
        expect(await test.notices()).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

it.each(['hidden', 'absent'] as const)('makes a previously read %s visibility change retry when presence commits first', async (kind) => {
    const storage = await createResourceInboxTestStorage(`friends_presence_inverse_${kind}`);
    try {
        const test = await fixture(storage);
        if (kind === 'absent') {
            await test.party.runtime.deleteByKey(FRIENDS_PROFILE_NAMESPACE, friendsProfileKey('alice'));
        }
        const visibility = await prepareVisibility(test);
        await test.write(await test.prepare(disconnect()));
        expect(await test.notices()).toEqual([]);
        await expect(storage.sql.begin((transaction) => writeFriendsMutation(transaction, visibility))).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await test.party.profiles.readProfile('alice')).profile.shareOnline).toBe(false);
        const retried = await prepareVisibility(test);
        await storage.sql.begin((transaction) => writeFriendsMutation(transaction, retried));
        expect((await test.notices()).map(({ principalId, scope }) => ({ principalId, scope })).sort((a, b) => a.principalId.localeCompare(b.principalId)))
            .toEqual(
                kind === 'hidden' ? [{ principalId: 'alice', scope: null }, { principalId: 'bob', scope: null }] : [{ principalId: 'alice', scope: null }]
            );
    }
    finally {
        await storage.close();
    }
});

it('observes peer consent without rewriting it, so presence leaves every friend profile revision untouched', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence_peer_observation');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        const bob = await test.party.profiles.readProfile('bob');
        const attempt = await test.prepare(disconnect());
        expect(attempt.mutation.outcome === 'write' && JSON.parse(attempt.mutation.viewObservations.observationsJson))
            .toEqual([expect.objectContaining({ key: friendsProfileKey('bob'), revision: bob.entry!.revision })]);
        await test.write(attempt);
        expect((await test.notices()).map((notice) => notice.principalId)).toEqual(['bob']);
        expect(await test.party.profiles.readProfile('bob')).toEqual(bob);
    }
    finally {
        await storage.close();
    }
});

postgresIt('makes presence retry when a visibility change holding the own profile commits before it', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence_inflight_visibility', 3);
    try {
        const test = await fixture(storage);
        const visibility = await prepareVisibility(test);
        const presence = await test.prepare(disconnect());
        let release!: () => void;
        const released = new Promise<void>((resolve) => {
            release = resolve;
        });
        let held!: () => void;
        const holding = new Promise<void>((resolve) => {
            held = resolve;
        });
        const committed = storage.sql.begin(async (transaction) => {
            await writeFriendsMutation(transaction, visibility);
            held();
            await released;
        });
        await holding;
        const blocked = test.write(presence).then(() => 'applied', (error: unknown) => error);
        await vi.waitFor(async () => {
            const [row] = await storage.sql<{ waiting: number; }[]>`
                select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock'`;
            expect(row.waiting).toBeGreaterThan(0);
        });
        release();
        await committed;
        expect(await blocked).toBeInstanceOf(RuntimeStateWriteConflictError);
        expect((await test.notices()).map(({ principalId, scope }) => `${principalId}:${scope === null}`).sort()).toEqual([
            'alice:true',
            'bob:true'
        ]);
        await test.write(await test.prepare(disconnect()));
        expect((await test.notices()).filter((notice) => notice.scope !== null).map((notice) => notice.principalId)).toEqual(['bob']);
    }
    finally {
        await storage.close();
    }
});

it('does not apply the party active-principal gate to a friend heartbeat resurrection', async () => {
    const storage = await createResourceInboxTestStorage('friends_disabled_resurrection');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        const principal = (await test.party.clients.findPrincipalEntry({ ...scope, principalId: 'alice' }))!;
        await test.party.clients.updatePrincipal(
            { ...principal.value, status: 'disabled', deleted: null, disabled: { ...principal.value.updated, reason: 'test' } },
            principal.entry.revision
        );
        const before = (await test.clients.readSnapshot({ ...scope, principalId: 'alice' }))!;
        test.party.clock.now = before.activeSessions[0]!.expiresAtEpochMs + 1;
        await test.party.auth.putSession({ ...test.party.sessions[0]!, expiresAtEpochMs: test.party.clock.now + 60000 });
        expect(isClientSnapshotPresent(before, test.party.clock.now)).toBe(false);
        const command = toHeartbeatClientSessionMutationInput({
            scope,
            principalId: 'alice',
            clientInstanceId: 'browser-alice',
            sessionId: 'session-alice',
            request: {
                generationId: 'generation-alice',
                requestId: 'resurrect',
                lastHeartbeatAtEpochMs: test.party.clock.now,
                expiresAtEpochMs: test.party.clock.now + 60000
            },
            defaultCommandId: 'resurrect'
        });
        await test.write(await test.prepare(command));
        expect((await test.notices()).map((notice) => notice.principalId)).toEqual(['bob']);
        const after = (await test.clients.readSnapshot({ ...scope, principalId: 'alice' }))!;
        expect(after.principal.status).toBe('disabled');
        expect(isClientSnapshotPresent(after, test.party.clock.now)).toBe(true);
        await test.write(await test.prepare(command));
        expect(await test.notices()).toHaveLength(1);
    }
    finally {
        await storage.close();
    }
});

it('keeps an additional session quiet and publishes only when the final session disconnects', async () => {
    const storage = await createResourceInboxTestStorage('friends_multiple_sessions');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        const session = (await test.clients.readSnapshot({ ...scope, principalId: 'alice' }))!.activeSessions[0]!;
        await test.party.clients.insertSession({ ...session, sessionId: 'session-extra', generationId: 'generation-extra' });
        await test.party.auth.putSession({ ...test.party.sessions[0]!, sessionId: 'session-extra', accessToken: 'extra-test-token' });
        await test.write(await test.prepare(disconnect()));
        expect(await test.notices()).toEqual([]);
        await test.write(await test.prepare(disconnect('alice', 'session-extra', 'generation-extra')));
        expect((await test.notices()).map((notice) => notice.principalId)).toEqual(['bob']);
    }
    finally {
        await storage.close();
    }
});

it('coalesces overlapping own and peer consent guards while expiring both friends in one AppInbox page', async () => {
    const storage = await createResourceInboxTestStorage('friends_expiry_page');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        await shareOnline(test, true, 'bob');
        const alice = (await test.clients.readSnapshot({ ...scope, principalId: 'alice' }))!.activeSessions[0]!;
        await test.party.clients.insertSession({ ...alice, sessionId: 'session-alice-extra', generationId: 'generation-extra' });
        test.party.clock.now = alice.expiresAtEpochMs + 1;
        const { service, reader, entries } = createExpiryInbox(storage, test);
        const entry = await service.enqueueExpiredSessions(test.party.clock.now);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect((await entries.entries.findByKey(entry.key))?.status).toBe('COMPLETED');
        const notices = await test.notices();
        expect(new Set(notices.map((notice) => notice.principalId))).toEqual(new Set(['alice', 'bob']));
        expect(notices.every((notice) => notice.scope?.applicationId === scope.applicationId && notice.scope.workspaceId === scope.workspaceId)).toBe(true);
        for (const principalId of ['alice', 'bob']) {
            expect(
                (await test.party.clients.listSessions({ ...scope, principalId, clientInstanceId: `browser-${principalId}` })).every((session) =>
                    session.status === 'expired'
                )
            ).toBe(true);
        }
        await service.enqueueExpiredSessions(test.party.clock.now);
        await reader.dequeueInbox(InboxQueueReader.INBOX_DEQUEUE_TYPES, createAppInboxTestResilience(0));
        expect(await test.notices()).toEqual(notices);
    }
    finally {
        await storage.close();
    }
});

it('rolls back presence, consent guards, events and proof when the final friend notice insert fails', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence_outbox_rollback');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        const profiles = await test.party.profiles.readProfiles(['alice', 'bob']);
        const rows = await storage.sql`select count(*)::text as count from runtime_state_store`;
        const attempt = await test.prepare(disconnect());
        await storage.sql`create function reject_friend_notice() returns trigger language plpgsql as
            'begin if NEW.ri_topic_id = ''view.invalidated'' then return null; end if; return NEW; end'`;
        await storage.sql`create trigger reject_friend_notice before insert on resource_inbox for each row execute function reject_friend_notice()`;
        await expect(test.write(attempt)).rejects.toThrow();
        expect(await test.notices()).toEqual([]);
        expect(await test.party.profiles.readProfiles(['alice', 'bob'])).toEqual(profiles);
        expect(await storage.sql`select count(*)::text as count from runtime_state_store`).toEqual(rows);
        expect((await test.clients.readSnapshot(attempt.command.aggregateRef))?.activeSessions).toHaveLength(1);
        expect(await test.clients.listEvents(attempt.command.aggregateRef)).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

async function prepareVisibility(test: FriendsPresenceFixture): Promise<FriendsMutationComputed> {
    const actor = await test.party.profiles.readProfile('alice');
    const session = (await test.party.auth.findSessionBySessionIdEntry('session-alice'))!;
    const computed = computeFriendsMutation({
        serviceId: 'friends-presence-test',
        traceId: 'visibility',
        finishedRetentionMs: 60000,
        peers: await test.party.profiles.readProfiles(
            actor.profile.contacts.filter((contact) => contact.status === 'friend').map((contact) => contact.principalId)
        ),
        actor,
        target: null,
        session,
        targetAvailable: false,
        destination: null,
        nowEpochMs: test.party.clock.now,
        config: { maxContacts: 20, maxInvitations: 20, invitationLifetimeMs: 60000 },
        input: {
            principalId: 'alice',
            sessionId: session.value.sessionId,
            sessionIssuedAtEpochMs: session.value.issuedAtEpochMs,
            sessionExpiresAtEpochMs: session.value.expiresAtEpochMs,
            requestId: 'visibility',
            capturedAtEpochMs: test.party.clock.now,
            request: { action: 'visibility', shareOnline: true }
        }
    });
    expect(validateFriendsMutation(computed)).toEqual([]);
    return computed;
}

interface FriendsPresenceExpiryInbox {
    readonly service: AppClientInboxService;
    readonly reader: InboxQueueReader;
    readonly entries: PSqlResourceInboxRepository;
}

function createExpiryInbox(storage: ResourceInboxTestStorage, test: FriendsPresenceFixture): FriendsPresenceExpiryInbox {
    const entries = createPSqlResourceInboxRepository(storage.sql, () => new Date(test.party.clock.now));
    const reader = new InboxQueueReader(new PSqlQueueBox(entries, () => Temporal.Instant.fromEpochMilliseconds(test.party.clock.now)), {
        newLaneConcurrency: 1
    });
    const service = new AppClientInboxService({
        inboxQueueReader: reader,
        resourceInboxRepository: entries.entries,
        resourceInboxResultsRepository: new ResourceInboxResultsRepository(storage.sql),
        database: storage.sql,
        clientStateService: test.clients
    }, { serviceId: 'friends-presence-test', finishedRetentionMs: 60000, disconnectedSessionRetentionMs: 600000 });
    return { service, reader, entries };
}

it('rejects incomplete or altered captured consent before a client presence mutation can write', async () => {
    const storage = await createResourceInboxTestStorage('friends_presence_read_authority');
    try {
        const test = await fixture(storage);
        await shareOnline(test, true);
        const attempt = await test.prepare(disconnect());
        const presence = attempt.read.friendsPresence!;
        expect(presence.peers.map(({ profile }) => profile.principalId)).toEqual(['bob']);
        expect(() => assertFriendsPresenceRead('alice', { ...presence, peers: [] })).toThrow('complete consent audience');
        expect(() =>
            assertFriendsPresenceRead('alice', {
                ...presence,
                peers: presence.peers.map((peer) => ({ ...peer, profile: { ...peer.profile, contacts: [] } }))
            })
        ).toThrow('captured peer profile');
        expect(() =>
            assertFriendsPresenceRead('alice', {
                ...presence,
                own: { ...presence.own, profile: { ...presence.own.profile, shareOnline: false } }
            })
        ).toThrow('captured own profile');
        expect(await test.notices()).toEqual([]);
    }
    finally {
        await storage.close();
    }
});

it.each(
    [
        ['party-account', 'key'],
        ['party-account', 'expired'],
        ['party-account', 'finite'],
        ['friends-profile', 'key'],
        ['friends-profile', 'expired'],
        ['friends-profile', 'finite']
    ] as const
)('rejects a corrupt captured %s companion with %s metadata', async (selectorId, corruption) => {
    const storage = await createResourceInboxTestStorage(`social_companion_${selectorId}_${corruption}`);
    try {
        const test = await fixture(storage);
        await test.party.runtime.upsert({
            namespace: PARTY_ACCOUNTS_NAMESPACE,
            key: partyAccountKey(scope, 'alice'),
            value: JSON.stringify({ scope, principalId: 'alice', partyId: null, invitations: [] }),
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
        });
        const read = test.party.runtime.readRuntimeStateBatch.bind(test.party.runtime);
        vi.spyOn(test.party.runtime, 'readRuntimeStateBatch').mockImplementation(async (selectors) => {
            const result = await read(selectors);
            return result.map((selection) =>
                selection.selectorId !== selectorId ? selection : {
                    ...selection,
                    entries: selection.entries.map((entry) => ({
                        ...entry,
                        key: corruption === 'key' ? 'wrong-key' : entry.key,
                        expireAtTimestamp: corruption === 'expired' ? 1 : corruption === 'finite' ? Date.now() + 60000 : entry.expireAtTimestamp
                    }))
                }
            );
        });
        await expect(test.prepare(disconnect())).rejects.toThrow(/identity|lifetime|expiry/i);
    }
    finally {
        vi.restoreAllMocks();
        await storage.close();
    }
});

it('fences sharing changed after the initial client and own-profile statement', async () => {
    const storage = await createResourceInboxTestStorage('friends_captured_consent');
    try {
        const test = await fixture(storage);
        const read = test.party.runtime.readRuntimeStateBatch.bind(test.party.runtime);
        let changed = false;
        vi.spyOn(test.party.runtime, 'readRuntimeStateBatch').mockImplementation(async (selectors) => {
            const captured = await read(selectors);
            if (!changed && selectors.some((selector) => selector.selectorId === 'friends-profile')) {
                changed = true;
                await shareOnline(test, true);
            }
            return captured;
        });
        const stale = await test.prepare(disconnect());
        expect(changed).toBe(true);
        expect(stale.read.friendsPresence?.own.profile.shareOnline).toBe(false);
        await expect(test.write(stale)).rejects.toBeInstanceOf(RuntimeStateWriteConflictError);
        await test.write(await test.prepare(disconnect()));
        expect((await test.notices()).map((notice) => notice.principalId)).toEqual(['bob']);
    }
    finally {
        vi.restoreAllMocks();
        await storage.close();
    }
});
