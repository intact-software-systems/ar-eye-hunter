import { describe, expect, expectTypeOf, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    AuditStamp as ClientAuditStamp,
    ClientEvent,
    ClientInstance,
    ClientPrincipal,
    ClientSession,
} from '@shared/api/client-types.ts';
import type {
    AuditStamp as GroupAuditStamp,
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSummary,
    GroupPresenceSession,
} from '@shared/api/group-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
import {
    groupStateGroupStorageKey,
    groupStateMemberStorageKey,
    groupStatePresenceSessionStorageKey,
} from '@shared-server/rallar-system/group-state-storage-keys.ts';
import {
    InMemoryClientStateEventStore,
    InMemoryGroupStateEventStore,
} from '@shared-server/rallar-system/repositories/StateEventStore.ts';
import { readStateEventListQuery } from '@shared-server/rallar-system/state-event-listing.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateTransactionalRepositoryLike,
} from '@shared-server/runtime-state/RuntimeStateRepository.ts';

describe('ClientStateRepository', () => {
    it('exposes only conditional client-state mutation methods', () => {
        expectTypeOf<ClientStateRepository>().not.toHaveProperty('putPrincipal');
        expectTypeOf<ClientStateRepository>().not.toHaveProperty('removePrincipal');
        expectTypeOf<ClientStateRepository>().not.toHaveProperty('putInstance');
        expectTypeOf<ClientStateRepository>().not.toHaveProperty('removeInstance');
        expectTypeOf<ClientStateRepository>().not.toHaveProperty('putSession');
        expectTypeOf<ClientStateRepository>().not.toHaveProperty('removeSession');

        const clientRepository = new ClientStateRepository(
            new FakeRuntimeStateRepository(),
        );
        expect(Object.hasOwn(Object.getPrototypeOf(clientRepository), 'putPrincipal'))
            .toBe(false);
        expect(Object.hasOwn(Object.getPrototypeOf(clientRepository), 'removeSession'))
            .toBe(false);
    });

    it('normalizes explicit pre-contract client rows at the persisted boundary', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const canonical = createClientPrincipal();
        const legacy = {
            applicationId: canonical.applicationId,
            principalId: canonical.principalId,
            username: canonical.username,
            status: canonical.status,
            roles: canonical.roles,
            metadata: canonical.metadata,
            snapshotVersion: canonical.snapshotVersion,
            profileVersion: canonical.profileVersion,
            presenceVersion: canonical.presenceVersion,
            created: { atEpochMs: 1, byServiceId: 'seed' },
            updated: { atEpochMs: 2, byServiceId: 'seed' },
        };
        await repository.upsert(
            'client-state:principals',
            'app=app-1:ws=workspace-1:principal=principal-1',
            JSON.stringify(legacy),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(clientRepository.findPrincipal(canonical)).resolves.toEqual({
            ...canonical,
            displayName: null,
            created: createClientAuditStamp(1),
            updated: createClientAuditStamp(2),
        });
    });

    it('fails closed when a client row identity differs from its canonical slot', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const expected = createClientPrincipal();
        await repository.upsert(
            'client-state:principals',
            'app=app-1:ws=workspace-1:principal=principal-1',
            JSON.stringify(createClientPrincipal('principal-2')),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(clientRepository.findPrincipal(expected)).rejects.toThrow(
            'Stored client principal identity differs from its canonical slot',
        );
    });

    it('stores durable client records, expires sessions, and assembles snapshots', async () => {
        const repository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryClientStateEventStore();
        const clientRepository = new ClientStateRepository(repository, {
            events: eventStore,
        });
        const now = Date.now();

        const principal = createClientPrincipal();
        const instanceA = createClientInstance('instance-a');
        const instanceB = createClientInstance('instance-b');
        const activeSession = createClientSession('instance-a', 'session-a', {
            expiresAtEpochMs: now + 60_000,
            lastHeartbeatAtEpochMs: now - 500,
            presenceState: 'busy',
        });
        const expiredSession = createClientSession('instance-b', 'session-b', {
            expiresAtEpochMs: now - 1,
            lastHeartbeatAtEpochMs: now - 1_000,
        });

        await insertClientPrincipal(clientRepository, principal);
        await insertClientInstance(clientRepository, instanceA);
        await insertClientInstance(clientRepository, instanceB);
        await insertClientSession(clientRepository, activeSession);
        await insertClientSession(clientRepository, expiredSession);
        await clientRepository.appendEvent(createClientEvent('evt-2', now + 2_000));
        await clientRepository.appendEvent(createClientEvent('evt-1', now + 1_000));

        expect(
            await clientRepository.findSession({
                applicationId: principal.applicationId,
                workspaceId: principal.workspaceId,
                principalId: principal.principalId,
                clientInstanceId: 'instance-b',
                sessionId: 'session-b',
            }),
        ).toEqual(expiredSession);

        expect(
            await clientRepository.listPrincipals({
                applicationId: principal.applicationId,
                workspaceId: principal.workspaceId,
            }),
        ).toEqual([principal]);

        const presence = await clientRepository.readPresenceSnapshot({
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
        });

        expect(presence).toEqual({
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
            presenceVersion: principal.presenceVersion,
            isOnline: true,
            presenceState: 'busy',
            activeSessions: [activeSession],
            lastSeenAtEpochMs: activeSession.lastHeartbeatAtEpochMs,
        });

        const snapshot = await clientRepository.readSnapshot({
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
        });

        expect(snapshot?.stateRevision).toBe(1);
        expect(snapshot?.principal).toEqual(principal);
        expect(snapshot?.instances).toEqual([instanceA, instanceB]);
        expect(snapshot?.activeSessions).toEqual([activeSession]);
        expect(snapshot?.activeSessionCount).toBe(1);
        expect(snapshot?.isOnline).toBe(true);
        expect(
            await clientRepository.listEvents({
                applicationId: principal.applicationId,
                workspaceId: principal.workspaceId,
                principalId: principal.principalId,
            }),
        ).toEqual([
            createClientEvent('evt-1', now + 1_000),
            createClientEvent('evt-2', now + 2_000),
        ]);

        expect(repository.findStoredEntry('client-state:principals')).toMatchObject({
            expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP,
        });
        expect(repository.findStoredEntry('client-state:events')).toBeUndefined();
        expect(eventStore.listEventsCalls).toBe(1);
    });

    it('exposes the durable principal-row revision without changing snapshotVersion', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const principal = createClientPrincipal();

        await insertClientPrincipal(clientRepository, principal);
        await updateClientPrincipal(clientRepository, {
            ...principal,
            displayName: 'Updated principal',
        }, 0);

        const ref = {
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId,
        };
        const direct = await clientRepository.readSnapshot(ref);
        const listed = await clientRepository.listSnapshots(ref);

        expect(direct?.stateRevision).toBe(2);
        expect(direct?.principal.snapshotVersion).toBe(principal.snapshotVersion);
        expect(listed[0]?.stateRevision).toBe(2);
    });

    it('allows one of two concurrent client compare-and-set writes to win', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const principal = createClientPrincipal();

        await insertClientPrincipal(clientRepository, principal);
        const results = await Promise.all([
            clientRepository.updatePrincipal({ ...principal, displayName: 'A' }, 0),
            clientRepository.updatePrincipal({ ...principal, displayName: 'B' }, 0),
        ]);

        const snapshot = await clientRepository.readSnapshot(principal);
        expect(results.map((result) => result.status).sort()).toEqual([
            'applied',
            'conflict',
        ]);
        expect(snapshot?.stateRevision).toBe(2);
        expect(snapshot?.principal.snapshotVersion).toBe(principal.snapshotVersion);
    });

    it('retries a client snapshot when the principal revision changes during child reads', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const principal = createClientPrincipal();

        await insertClientPrincipal(clientRepository, principal);
        await insertClientInstance(
            clientRepository,
            createClientInstance('instance-a'),
        );
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls !== 2) {
                return;
            }
            await updateClientInstance(clientRepository, {
                ...createClientInstance('instance-a'),
                platform: 'desktop',
            }, 0);
            await updateClientPrincipal(clientRepository, {
                ...principal,
                displayName: 'Current principal',
            }, 0);
        };

        const snapshot = await clientRepository.readSnapshot(principal);

        expect(snapshot).toMatchObject({
            stateRevision: 2,
            principal: { displayName: 'Current principal' },
            instances: [{ platform: 'desktop' }],
        });
    });

    it('returns absent when a client principal is created after the aggregate probe', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const principal = createClientPrincipal();
        repository.onFindEntryAfterRead = async () => {
            repository.onFindEntryAfterRead = undefined;
            await insertClientPrincipal(clientRepository, principal);
            await insertClientInstance(
                clientRepository,
                createClientInstance('instance-a'),
            );
        };

        await expect(clientRepository.readSnapshot(principal)).resolves.toBeUndefined();
    });

    it('lists client snapshots with scope-wide child reads instead of per-principal fanout', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const now = Date.now();
        const clientCount = 50;

        for (let index = 0; index < clientCount; index += 1) {
            const principalId = `principal-${String(index).padStart(4, '0')}`;
            const instanceId = `instance-${String(index).padStart(4, '0')}`;
            const sessionId = `session-${String(index).padStart(4, '0')}`;

            await insertClientPrincipal(
                clientRepository,
                createClientPrincipal(principalId),
            );
            await insertClientInstance(
                clientRepository,
                createClientInstance(instanceId, principalId),
            );
            await insertClientSession(
                clientRepository,
                createClientSession(instanceId, sessionId, {
                    principalId,
                    expiresAtEpochMs: now + 60_000,
                }),
            );
        }

        repository.resetCounters();
        const snapshots = await clientRepository.listSnapshots({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });

        expect(snapshots).toHaveLength(clientCount);
        expect(snapshots[0].principal.principalId).toBe('principal-0000');
        expect(snapshots[0].instances).toHaveLength(1);
        expect(snapshots[0].activeSessions).toHaveLength(1);
        expect(repository.findEntryCalls).toBe(0);
        expect(repository.findEntriesByPrefixCalls).toBe(4);
        expect(repository.maxRowsReturnedPerFindEntriesByPrefix).toBe(clientCount);
    });

    it('target-reads only changed clients and omits clients deleted during full-list validation', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        for (const principalId of ['principal-0', 'principal-1', 'principal-2']) {
            await insertClientPrincipal(
                clientRepository,
                createClientPrincipal(principalId),
            );
            await insertClientInstance(
                clientRepository,
                createClientInstance(`instance-${principalId}`, principalId),
            );
        }
        repository.resetCounters();
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls !== 4) {
                return;
            }
            repository.onFindEntriesByPrefix = undefined;
            await insertClientInstance(
                clientRepository,
                createClientInstance('instance-new', 'principal-0'),
            );
            await updateClientPrincipal(clientRepository, {
                ...createClientPrincipal('principal-0'),
                displayName: 'Changed',
            }, 0);
            await deleteClientPrincipal(
                clientRepository,
                createClientPrincipal('principal-1'),
                0,
            );
        };

        const snapshots = await clientRepository.listSnapshots({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });

        expect(snapshots.map((snapshot) => snapshot.principal.principalId)).toEqual([
            'principal-0',
            'principal-2',
        ]);
        expect(snapshots[0]).toMatchObject({
            principal: { displayName: 'Changed' },
            instances: expect.arrayContaining([
                expect.objectContaining({ clientInstanceId: 'instance-new' }),
            ]),
        });
        expect(repository.findEntriesByPrefixCalls).toBe(6);
        expect(repository.findEntryCalls).toBe(2);
    });

    it('lists client event pages with event-type filtering through dedicated event-store paging', async () => {
        const repository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryClientStateEventStore();
        const clientRepository = new ClientStateRepository(repository, {
            events: eventStore,
        });
        const ref = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'principal-1',
        };
        await clientRepository.appendEvent(
            createClientEvent('evt-1', 1_000, 'session-connected'),
        );
        await clientRepository.appendEvent(
            createClientEvent('evt-2', 2_000, 'session-disconnected'),
        );
        await clientRepository.appendEvent(
            createClientEvent('evt-3', 3_000, 'session-connected'),
        );
        await clientRepository.appendEvent(
            createClientEvent('evt-4', 4_000, 'session-disconnected'),
        );

        const firstPage = await clientRepository.listEventPage(
            ref,
            readStateEventListQuery(
                new URLSearchParams('eventType=session-disconnected&limit=1'),
            ),
        );
        const secondPage = await clientRepository.listEventPage(ref, {
            eventTypes: ['session-disconnected'],
            limit: 1,
            after: firstPage.nextCursor,
        });
        const recentEvents = await clientRepository.listRecentEvents(ref, {
            eventTypes: ['session-disconnected'],
            limit: 1,
            after: firstPage.nextCursor,
        });

        expect(firstPage.events.map((event) => event.eventId)).toEqual(['evt-2']);
        expect(firstPage.hasMore).toBe(true);
        expect(secondPage.events.map((event) => event.eventId)).toEqual(['evt-4']);
        expect(secondPage.hasMore).toBe(false);
        expect(recentEvents.map((event) => event.eventId)).toEqual(['evt-4']);
        expect(repository.findEntriesByPrefixCalls).toBe(0);
        expect(repository.findEntriesByPrefixPageCalls).toHaveLength(0);
        expect(eventStore.listRecentEventsCalls).toBe(1);
        expect(eventStore.listEventPageCalls).toBe(2);
    });

    it('preserves client event cursor order when snapshot versions diverge from timestamps', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const ref = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            principalId: 'principal-1',
        };
        await clientRepository.appendEvent(
            createClientEvent('evt-late-snapshot', 1_000, 'session-connected', 30),
        );
        await clientRepository.appendEvent(
            createClientEvent('evt-early-snapshot', 2_000, 'session-connected', 10),
        );
        await clientRepository.appendEvent(
            createClientEvent('evt-middle-snapshot', 3_000, 'session-connected', 20),
        );

        const firstPage = await clientRepository.listEventPage(ref, { limit: 2 });
        const secondPage = await clientRepository.listEventPage(ref, {
            limit: 2,
            after: firstPage.nextCursor,
        });

        expect(firstPage.events.map((event) => event.eventId)).toEqual([
            'evt-early-snapshot',
            'evt-middle-snapshot',
        ]);
        expect(firstPage.hasMore).toBe(true);
        expect(secondPage.events.map((event) => event.eventId)).toEqual([
            'evt-late-snapshot',
        ]);
        expect(secondPage.hasMore).toBe(false);
    });
});

async function insertClientPrincipal(
    repository: ClientStateRepository,
    principal: ClientPrincipal,
): Promise<void> {
    expect(await repository.insertPrincipal(principal)).toEqual({
        status: 'applied',
        revision: 0,
    });
}

async function updateClientPrincipal(
    repository: ClientStateRepository,
    principal: ClientPrincipal,
    expectedRevision: number,
): Promise<void> {
    expect(await repository.updatePrincipal(principal, expectedRevision)).toEqual({
        status: 'applied',
        revision: expectedRevision + 1,
    });
}

async function deleteClientPrincipal(
    repository: ClientStateRepository,
    principal: ClientPrincipal,
    expectedRevision: number,
): Promise<void> {
    expect(await repository.deletePrincipal(principal, expectedRevision)).toEqual({
        status: 'applied',
    });
}

async function insertClientInstance(
    repository: ClientStateRepository,
    instance: ClientInstance,
): Promise<void> {
    expect(await repository.insertInstance(instance)).toEqual({
        status: 'applied',
        revision: 0,
    });
}

async function updateClientInstance(
    repository: ClientStateRepository,
    instance: ClientInstance,
    expectedRevision: number,
): Promise<void> {
    expect(await repository.updateInstance(instance, expectedRevision)).toEqual({
        status: 'applied',
        revision: expectedRevision + 1,
    });
}

async function insertClientSession(
    repository: ClientStateRepository,
    session: ClientSession,
): Promise<void> {
    expect(await repository.insertSession(session)).toEqual({
        status: 'applied',
        revision: 0,
    });
}

describe('GroupStateRepository', () => {
    it('normalizes f135 legacy group rows and preserves their raw authority fence', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository);
        const ref = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'legacy-group',
        };
        const legacyAudit = { atEpochMs: 1, byServiceId: 'seed' };
        const legacyGroup = {
            applicationId: ref.applicationId,
            groupId: ref.groupId,
            displayName: 'Legacy group',
            kind: 'room',
            status: 'active',
            joinMode: 'open',
            metadata: {},
            activeMemberCount: 1,
            ownerPrincipalId: 'owner',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0,
            created: legacyAudit,
            updated: legacyAudit,
        };
        const legacyMember = {
            applicationId: ref.applicationId,
            groupId: ref.groupId,
            principalId: 'owner',
            role: 'owner',
            status: 'active',
            joined: legacyAudit,
            updated: legacyAudit,
        };
        const legacySession = {
            applicationId: ref.applicationId,
            groupId: ref.groupId,
            principalId: 'owner',
            sessionId: 'session-1',
            generationId: 'generation-1',
            generationVersion: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: 1,
            expiresAtEpochMs: 60_000,
        };
        await repository.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(ref),
            JSON.stringify(legacyGroup),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await repository.upsert(
            'group-state:members',
            groupStateMemberStorageKey({ ...ref, principalId: 'owner' }),
            JSON.stringify(legacyMember),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await repository.upsert(
            'group-state:sessions',
            groupStatePresenceSessionStorageKey({
                ...ref,
                sessionId: 'session-1',
            }),
            JSON.stringify(legacySession),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );

        await expect(groupRepository.findGroup(ref)).resolves.toMatchObject({
            ...ref,
            slug: null,
            archived: null,
            deleted: null,
            created: createGroupAuditStamp(1),
        });
        await expect(groupRepository.findMember({ ...ref, principalId: 'owner' }))
            .resolves.toMatchObject({ ...ref, status: 'active' });
        await expect(groupRepository.findPresenceSession({
            ...ref,
            sessionId: 'session-1',
        })).resolves.toMatchObject({
            ...ref,
            status: 'active',
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        });

        const guarded = await groupRepository.readSnapshotWithAuthorityGuard(ref);
        if (!guarded) throw new Error('Expected legacy authoritative snapshot');
        await expect(groupRepository.advanceAuthorityFence(guarded.authorityGuard))
            .resolves.toEqual({ status: 'applied', revision: 1 });
    });

    it('rejects explicit null and wrong-slot persisted group identities', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository);
        const expected = createGroup('expected-group');
        await repository.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(expected),
            JSON.stringify({ ...expected, workspaceId: null }),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await expect(groupRepository.findGroup(expected)).rejects.toThrow(
            /workspaceId/,
        );
        await repository.upsert(
            'group-state:groups',
            groupStateGroupStorageKey(expected),
            JSON.stringify(createGroup('wrong-group')),
            NEVER_EXPIRE_AT_TIMESTAMP,
        );
        await expect(groupRepository.findGroup(expected)).rejects.toThrow(
            /scope differs|identity differs/,
        );
    });

    it('stores groups by scope, supports slug lookup, and assembles group snapshots', async () => {
        const repository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryGroupStateEventStore();
        const groupRepository = new GroupStateRepository(repository, {
            events: eventStore,
        });
        const now = Date.now();

        const group = createGroup();
        const activeMember = createGroupMember('principal-a', 'active');
        const invitedMember = createGroupMember('principal-b', 'invited');
        const activeSession = createGroupSession('principal-a', 'session-a', {
            expiresAtEpochMs: now + 60_000,
        });
        const disconnectedSession = createGroupSession('principal-b', 'session-b', {
            expiresAtEpochMs: now + 60_000,
            disconnected: { atEpochMs: now - 10, reason: 'closed' },
        });
        const expiredSession = createGroupSession('principal-c', 'session-c', {
            expiresAtEpochMs: now - 1,
        });

        await putGroupFixture(groupRepository, group);
        await groupRepository.putMember(activeMember);
        await groupRepository.putMember(invitedMember);
        await groupRepository.putPresenceSession(activeSession);
        await groupRepository.putPresenceSession(disconnectedSession);
        await groupRepository.putPresenceSession(expiredSession);
        await groupRepository.insertPresenceSummary(
            createGroupPresenceSummary(group.groupId, [activeSession], 3),
        );
        await groupRepository.appendEvent(createGroupEvent('evt-2', now + 2_000));
        await groupRepository.appendEvent(createGroupEvent('evt-1', now + 1_000));

        expect(
            await groupRepository.findPresenceSession({
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId,
                sessionId: 'session-c',
            }),
        ).toEqual(expiredSession);

        expect(
            await groupRepository.findGroupBySlug(
                {
                    applicationId: group.applicationId,
                    workspaceId: group.workspaceId,
                },
                'party-1',
            ),
        ).toEqual(group);

        const snapshot = await groupRepository.readSnapshot({
            applicationId: group.applicationId,
            workspaceId: group.workspaceId,
            groupId: group.groupId,
        });

        expect(snapshot).toEqual({
            stateRevision: 9,
            causalRevision: {
                groupRevision: 6,
                presenceRevision: 3,
            },
            group,
            members: [activeMember, invitedMember],
            activeSessions: [activeSession],
            memberCount: 1,
            onlineMemberCount: 1,
        });

        expect(
            await groupRepository.listEvents({
                applicationId: group.applicationId,
                workspaceId: group.workspaceId,
                groupId: group.groupId,
            }),
        ).toEqual([createGroupEvent('evt-1', now + 1_000), createGroupEvent('evt-2', now + 2_000)]);
        expect(repository.findStoredEntry('group-state:events')).toBeUndefined();
        expect(eventStore.listEventsCalls).toBe(1);
    });

    it('exposes the canonical group revision without changing snapshotVersion', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup();

        await putGroupFixture(groupRepository, group);
        await groupRepository.putGroup({
            ...group,
            displayName: 'Updated group',
        });

        const direct = await groupRepository.readSnapshot(group);
        const listed = await groupRepository.listSnapshots(group);
        const page = await groupRepository.listSnapshotsPage(group, { limit: 10 });

        expect(direct?.stateRevision).toBe(6);
        expect(direct?.group.snapshotVersion).toBe(group.snapshotVersion);
        expect(listed[0]?.stateRevision).toBe(6);
        expect(page.snapshots[0]?.stateRevision).toBe(6);
    });

    it('assigns distinct causal revisions to concurrent group writes with one domain version', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup();

        await groupRepository.putMember(createGroupOwner(group));

        await Promise.all([
            groupRepository.putGroup({ ...group, displayName: 'A' }),
            groupRepository.putGroup({ ...group, displayName: 'B' }),
        ]);

        const snapshot = await groupRepository.readSnapshot(group);
        expect(snapshot?.stateRevision).toBe(6);
        expect(snapshot?.group.snapshotVersion).toBe(group.snapshotVersion);
    });

    it('retries a group snapshot when the aggregate revision changes during child reads', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = { ...createGroup(), activeMemberCount: 2 };

        await putGroupFixture(groupRepository, group);
        await groupRepository.putMember(createGroupMember('principal-b', 'active'));
        let groupReads = 0;
        repository.onFindEntryAfterRead = async (namespace) => {
            if (namespace !== 'group-state:groups' || ++groupReads !== 1) {
                return;
            }
            await groupRepository.putMember(
                createGroupMember('principal-b', 'banned'),
            );
            await groupRepository.putGroup({
                ...group,
                displayName: 'Current group',
                activeMemberCount: 1,
            });
        };

        const snapshot = await groupRepository.readSnapshot(group);

        expect(snapshot).toMatchObject({
            stateRevision: 6,
            group: { displayName: 'Current group' },
            members: expect.arrayContaining([
                expect.objectContaining({ principalId: 'principal-b', status: 'banned' }),
            ]),
        });
    });

    it('returns absent when a group is deleted during child reads', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup('group-delete');
        await putGroupFixture(groupRepository, group);
        await groupRepository.putMember(
            createGroupMember('principal-a', 'active', group.groupId),
        );
        repository.onFindEntriesByPrefix = async () => {
            repository.onFindEntriesByPrefix = undefined;
            await groupRepository.removeGroup(group);
        };

        await expect(groupRepository.readSnapshot(group)).resolves.toBeUndefined();
    });

    it('fails a group snapshot read after three continuously conflicting attempts', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup();

        await putGroupFixture(groupRepository, group);
        let groupReads = 0;
        repository.onFindEntryAfterRead = async (namespace) => {
            if (namespace !== 'group-state:groups' || ++groupReads % 2 === 0) {
                return;
            }
            await groupRepository.putGroup({
                ...group,
                displayName: `Revision ${groupReads}`,
            });
        };

        await expect(groupRepository.readSnapshot(group)).rejects.toMatchObject({
            name: 'StateSnapshotReadConflictError',
            status: 503,
        });
        expect(repository.findEntriesByPrefixCalls).toBe(6);
        expect(repository.findEntriesByPrefixCallsByNamespace).toEqual(new Map([
            ['group-state:members', 3],
            ['group-state:sessions', 3],
        ]));
        expect(groupReads).toBe(6);
    });

    it('lists group snapshots with scope-wide child reads instead of per-group fanout', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const now = Date.now();
        const groupCount = 50;

        for (let index = 0; index < groupCount; index += 1) {
            const groupId = `group-${String(index).padStart(4, '0')}`;
            const principalId = `principal-${String(index).padStart(4, '0')}`;
            const sessionId = `session-${String(index).padStart(4, '0')}`;

            await putGroupFixture(groupRepository, createGroup(groupId));
            await groupRepository.putMember(
                createGroupMember(principalId, 'active', groupId),
            );
            await groupRepository.putPresenceSession(
                createGroupSession(principalId, sessionId, {
                    groupId,
                    expiresAtEpochMs: now + 60_000,
                }),
            );
            await groupRepository.insertPresenceSummary(
                createGroupPresenceSummary(
                    groupId,
                    [createGroupSession(principalId, sessionId, {
                        groupId,
                        expiresAtEpochMs: now + 60_000,
                    })],
                    1,
                ),
            );
        }

        repository.resetCounters();
        const snapshots = await groupRepository.listSnapshots({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });

        expect(snapshots).toHaveLength(groupCount);
        expect(snapshots[0].group.groupId).toBe('group-0000');
        expect(snapshots[0].members).toHaveLength(1);
        expect(snapshots[0].activeSessions).toHaveLength(1);
        expect(snapshots[0].memberCount).toBe(1);
        expect(snapshots[0].onlineMemberCount).toBe(1);
        expect(repository.findEntryCalls).toBe(0);
        expect(repository.findEntriesByPrefixCalls).toBe(5);
        expect(repository.findEntriesByPrefixCallsByNamespace).toEqual(new Map([
            ['group-state:groups', 2],
            ['group-state:members', 1],
            ['group-state:presence-summaries', 1],
            ['group-state:sessions', 1],
        ]));
        expect(repository.maxRowsReturnedPerFindEntriesByPrefix).toBe(groupCount);
    });

    it('target-reads only changed groups and omits groups deleted during full-list validation', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        for (const groupId of ['group-0', 'group-1', 'group-2']) {
            await putGroupFixture(groupRepository, createGroup(groupId));
            await groupRepository.putMember(
                createGroupMember(`principal-${groupId}`, 'active', groupId),
            );
        }
        repository.resetCounters();
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls !== 4) {
                return;
            }
            repository.onFindEntriesByPrefix = undefined;
            await groupRepository.putMember(
                createGroupMember('principal-new', 'active', 'group-0'),
            );
            await groupRepository.putGroup({
                ...createGroup('group-0'),
                displayName: 'Changed',
                activeMemberCount: 2,
            });
            await groupRepository.removeGroup(createGroup('group-1'));
        };

        const snapshots = await groupRepository.listSnapshots({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        });

        expect(snapshots.map((snapshot) => snapshot.group.groupId)).toEqual([
            'group-0',
            'group-2',
        ]);
        expect(snapshots[0]).toMatchObject({
            group: { displayName: 'Changed' },
            members: expect.arrayContaining([
                expect.objectContaining({ principalId: 'principal-new' }),
            ]),
        });
        expect(repository.findEntriesByPrefixCalls).toBe(7);
        expect(repository.findEntriesByPrefixCallsByNamespace).toEqual(new Map([
            ['group-state:groups', 2],
            ['group-state:members', 2],
            ['group-state:presence-summaries', 1],
            ['group-state:sessions', 2],
        ]));
        expect(repository.findEntryCalls).toBe(3);
    });

    it('lists bounded group snapshot pages without scanning every group row', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const now = Date.now();
        const groupCount = 5;

        for (let index = 0; index < groupCount; index += 1) {
            const groupId = `group-${String(index).padStart(4, '0')}`;
            const principalId = `principal-${String(index).padStart(4, '0')}`;

            await putGroupFixture(groupRepository, createGroup(groupId));
            await groupRepository.putMember(
                createGroupMember(principalId, 'active', groupId),
            );
            await groupRepository.putPresenceSession(
                createGroupSession(principalId, `session-${index}`, {
                    groupId,
                    expiresAtEpochMs: now + 60_000,
                }),
            );
        }

        repository.resetCounters();
        const page = await (groupRepository as unknown as {
            listSnapshotsPage(
                scope: { applicationId: string; workspaceId: string },
                options: { limit: number },
            ): Promise<{
                snapshots: readonly { group: { groupId: string } }[];
                scannedGroupCount: number;
                hasMore: boolean;
            }>;
        }).listSnapshotsPage({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        }, {
            limit: 2,
        });

        expect(page.snapshots.map((snapshot) => snapshot.group.groupId)).toEqual([
            'group-0000',
            'group-0001',
        ]);
        expect(page.scannedGroupCount).toBe(2);
        expect(page.hasMore).toBe(true);
        expect(repository.findEntriesByPrefixPageCalls).toEqual([
            {
                namespace: 'group-state:groups',
                keyPrefix: 'app=app-1:ws=workspace-1:',
                afterKey: undefined,
                limit: 3,
            },
        ]);
        expect(repository.findEntriesByKeysCalls).toBe(1);
        expect(repository.findEntriesByPrefixCalls).toBe(4);
        expect(repository.findEntriesByPrefixCallsByNamespace).toEqual(new Map([
            ['group-state:members', 2],
            ['group-state:sessions', 2],
        ]));
        expect(repository.findEntryCalls).toBe(2);
        expect(repository.maxRowsReturnedPerFindEntriesByPrefix).toBe(1);
    });

    it('fills bounded group snapshot pages after expired raw group rows are skipped', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });

        await putGroupFixture(groupRepository, {
            ...createGroup('group-0000'),
            purgeAfterEpochMs: Date.now() - 1,
        });
        await putGroupFixture(groupRepository, createGroup('group-0001'));
        await putGroupFixture(groupRepository, createGroup('group-0002'));
        await putGroupFixture(groupRepository, createGroup('group-0003'));

        const page = await (groupRepository as unknown as {
            listSnapshotsPage(
                scope: { applicationId: string; workspaceId: string },
                options: { limit: number },
            ): Promise<{
                snapshots: readonly { group: { groupId: string } }[];
                scannedGroupCount: number;
                hasMore: boolean;
                nextGroupKey?: string;
            }>;
        }).listSnapshotsPage({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        }, {
            limit: 2,
        });

        expect(page.snapshots.map((snapshot) => snapshot.group.groupId)).toEqual([
            'group-0001',
            'group-0002',
        ]);
        expect(page.scannedGroupCount).toBe(2);
        expect(page.hasMore).toBe(true);
        expect(page.nextGroupKey).toBe('app=app-1:ws=workspace-1:group=group-0002');
    });

    it('omits groups deleted during page validation while retaining the scanned cursor', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        await putGroupFixture(groupRepository, createGroup('group-0000'));
        await putGroupFixture(groupRepository, createGroup('group-0001'));
        repository.onFindEntriesByKeys = async () => {
            repository.onFindEntriesByKeys = undefined;
            await groupRepository.removeGroup(createGroup('group-0000'));
        };

        const page = await groupRepository.listSnapshotsPage({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        }, { limit: 2 });

        expect(page.snapshots.map((snapshot) => snapshot.group.groupId)).toEqual([
            'group-0001',
        ]);
        expect(page.scannedGroupCount).toBe(2);
        expect(page.nextGroupKey).toBe('app=app-1:ws=workspace-1:group=group-0001');
    });

    it('target-reads a group changed during exact-key page validation', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup('group-0000');
        await putGroupFixture(groupRepository, group);
        await groupRepository.putMember(
            createGroupMember('principal-0000', 'active', group.groupId),
        );
        repository.resetCounters();
        repository.onFindEntriesByKeys = async () => {
            repository.onFindEntriesByKeys = undefined;
            await groupRepository.putMember(
                createGroupMember('principal-new', 'active', group.groupId),
            );
            await groupRepository.putGroup({
                ...group,
                displayName: 'Changed',
                activeMemberCount: 2,
            });
        };

        const page = await groupRepository.listSnapshotsPage({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        }, { limit: 1 });

        expect(page.snapshots[0]).toMatchObject({
            group: { displayName: 'Changed' },
            members: expect.arrayContaining([
                expect.objectContaining({ principalId: 'principal-new' }),
            ]),
        });
        expect(repository.findEntriesByKeysCalls).toBe(1);
        expect(repository.findEntriesByPrefixCalls).toBe(4);
        expect(repository.findEntriesByPrefixCallsByNamespace).toEqual(new Map([
            ['group-state:members', 2],
            ['group-state:sessions', 2],
        ]));
        expect(repository.findEntryCalls).toBe(4);
    });

    it('keeps paged group snapshot scans inside the exact workspace scope', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });

        await putGroupFixture(groupRepository, createGroup('room-current'));
        await putGroupFixture(groupRepository, {
            ...createGroup('room-sibling'),
            workspaceId: 'workspace-10',
        });

        const page = await (groupRepository as unknown as {
            listSnapshotsPage(
                scope: { applicationId: string; workspaceId: string },
                options: { limit: number },
            ): Promise<{
                snapshots: readonly { group: { groupId: string; workspaceId: string } }[];
                scannedGroupCount: number;
                hasMore: boolean;
            }>;
        }).listSnapshotsPage({
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
        }, {
            limit: 10,
        });

        expect(page.snapshots.map((snapshot) => snapshot.group)).toEqual([
            expect.objectContaining({
                groupId: 'room-current',
                workspaceId: 'workspace-1',
            }),
        ]);
        expect(page.scannedGroupCount).toBe(1);
        expect(page.hasMore).toBe(false);
    });

    it('lists group event pages with cursor order through dedicated event-store paging', async () => {
        const repository = new FakeRuntimeStateRepository();
        const eventStore = new InMemoryGroupStateEventStore();
        const groupRepository = new GroupStateRepository(repository, {
            events: eventStore,
        });
        const ref = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
        };
        await groupRepository.appendEvent(createGroupEvent('evt-1', 1_000));
        await groupRepository.appendEvent(createGroupEvent('evt-2', 2_000));
        await groupRepository.appendEvent(createGroupEvent('evt-3', 3_000));

        const firstPage = await groupRepository.listEventPage(
            ref,
            readStateEventListQuery(new URLSearchParams('limit=2')),
        );
        const secondPage = await groupRepository.listEventPage(ref, {
            limit: 2,
            after: firstPage.nextCursor,
        });
        const recentEvents = await groupRepository.listRecentEvents(ref, {
            limit: 2,
            after: firstPage.nextCursor,
        });

        expect(firstPage.events.map((event) => event.eventId)).toEqual([
            'evt-1',
            'evt-2',
        ]);
        expect(firstPage.hasMore).toBe(true);
        expect(secondPage.events.map((event) => event.eventId)).toEqual([
            'evt-3',
        ]);
        expect(secondPage.hasMore).toBe(false);
        expect(recentEvents.map((event) => event.eventId)).toEqual([
            'evt-2',
            'evt-3',
        ]);
        expect(repository.findEntriesByPrefixCalls).toBe(0);
        expect(repository.findEntriesByPrefixPageCalls).toHaveLength(0);
        expect(eventStore.listRecentEventsCalls).toBe(1);
        expect(eventStore.listEventPageCalls).toBe(2);
    });

    it('preserves group event cursor order when snapshot versions diverge from timestamps', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const ref = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1',
        };
        await groupRepository.appendEvent(
            createGroupEvent('evt-late-snapshot', 1_000, 30),
        );
        await groupRepository.appendEvent(
            createGroupEvent('evt-early-snapshot', 2_000, 10),
        );
        await groupRepository.appendEvent(
            createGroupEvent('evt-middle-snapshot', 3_000, 20),
        );

        const firstPage = await groupRepository.listEventPage(ref, { limit: 2 });
        const secondPage = await groupRepository.listEventPage(ref, {
            limit: 2,
            after: firstPage.nextCursor,
        });

        expect(firstPage.events.map((event) => event.eventId)).toEqual([
            'evt-early-snapshot',
            'evt-middle-snapshot',
        ]);
        expect(firstPage.hasMore).toBe(true);
        expect(secondPage.events.map((event) => event.eventId)).toEqual([
            'evt-late-snapshot',
        ]);
        expect(secondPage.hasMore).toBe(false);
    });
});

function createClientPrincipal(principalId = 'principal-1'): ClientPrincipal {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId,
        username: principalId,
        displayName: principalId,
        avatarUrl: null,
        authProvider: null,
        externalSubjectId: null,
        status: 'active',
        disabled: null,
        deleted: null,
        roles: ['member'],
        metadata: {},
        snapshotVersion: 3,
        profileVersion: 1,
        presenceVersion: 2,
        created: createClientAuditStamp(1),
        updated: createClientAuditStamp(2),
        lastSeenAtEpochMs: null,
    };
}

function createClientInstance(
    clientInstanceId: string,
    principalId = 'principal-1',
): ClientInstance {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId,
        clientInstanceId,
        status: 'active',
        revoked: null,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: ['rtc'],
        registered: createClientAuditStamp(1),
        updated: createClientAuditStamp(2),
    };
}

function createClientSession(
    clientInstanceId: string,
    sessionId: string,
    overrides: Partial<Pick<
        ClientSession,
        | 'principalId'
        | 'generationId'
        | 'generationVersion'
        | 'presenceState'
        | 'connectionId'
        | 'authenticatedAtEpochMs'
        | 'connectedAtEpochMs'
        | 'lastHeartbeatAtEpochMs'
        | 'expiresAtEpochMs'
    >> = {},
): ClientSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        clientInstanceId,
        sessionId,
        generationId: `generation-${sessionId}`,
        generationVersion: 10,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        connectionId: null,
        authenticatedAtEpochMs: 10,
        connectedAtEpochMs: 20,
        lastHeartbeatAtEpochMs: 30,
        expiresAtEpochMs: Date.now() + 60_000,
        disconnectedAtEpochMs: null,
        disconnectReason: null,
        ...overrides,
    };
}

function createClientEvent(
    eventId: string,
    occurredAtEpochMs: number,
    eventType: ClientEvent['eventType'] = 'session-connected',
    snapshotVersion = occurredAtEpochMs,
): ClientEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        eventId,
        eventType,
        clientInstanceId: 'instance-a',
        sessionId: 'session-a',
        snapshotVersion,
        occurredAtEpochMs,
        actor: { kind: 'service', serviceId: 'seed' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
    };
}

function createGroup(groupId = 'group-1'): Group {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        slug: groupId === 'group-1' ? 'party-1' : groupId,
        displayName: groupId === 'group-1' ? 'Party 1' : groupId,
        description: null,
        kind: 'party',
        status: 'active',
        archived: null,
        deleted: null,
        joinMode: 'invite-only',
        maxMembers: null,
        maxSessionsPerMember: null,
        metadata: {},
        activeMemberCount: 1,
        ownerPrincipalId: ownerPrincipalIdFor(groupId),
        snapshotVersion: 6,
        metadataVersion: 1,
        rosterVersion: 2,
        presenceVersion: 3,
        created: createGroupAuditStamp(1),
        updated: createGroupAuditStamp(2),
        expiresAtEpochMs: null,
        emptySinceEpochMs: null,
        purgeAfterEpochMs: null,
    };
}

function createGroupMember(
    principalId: string,
    status: GroupMember['status'],
    groupId = 'group-1',
): GroupMember {
    const updated = createGroupAuditStamp(2);
    const role: GroupMember['role'] = principalId === ownerPrincipalIdFor(groupId)
        ? 'owner'
        : 'member';
    const base = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        principalId,
        role,
        joined: createGroupAuditStamp(1),
        updated,
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
    };
    switch (status) {
        case 'invited':
            return {
                ...base,
                status,
                joined: null,
                left: null,
                removed: null,
                banned: null,
            };
        case 'active':
            return { ...base, status, left: null, removed: null, banned: null };
        case 'left':
            return { ...base, status, left: updated, removed: null, banned: null };
        case 'removed':
            return { ...base, status, left: null, removed: updated, banned: null };
        case 'banned':
            return { ...base, status, left: null, removed: null, banned: updated };
    }
}

async function putGroupFixture(
    repository: GroupStateRepository,
    group: Group,
): Promise<void> {
    await repository.putGroup(group);
    await repository.putMember(createGroupOwner(group));
}

function createGroupOwner(group: Group): GroupMember {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId,
        principalId: group.ownerPrincipalId,
        role: 'owner',
        status: 'active',
        joined: createGroupAuditStamp(1),
        updated: createGroupAuditStamp(2),
        invitedByPrincipalId: null,
        invitationExpiresAtEpochMs: null,
        left: null,
        removed: null,
        banned: null,
    };
}

function ownerPrincipalIdFor(groupId: string): string {
    if (groupId === 'group-1' || groupId === 'group-delete') return 'principal-a';
    const paged = /^group-(\d{4})$/.exec(groupId);
    if (paged) return `principal-${paged[1]}`;
    if (/^group-\d$/.test(groupId)) return `principal-${groupId}`;
    return `owner-${groupId}`;
}

function createGroupSession(
    principalId: string,
    sessionId: string,
    overrides: Readonly<{
        groupId?: string;
        generationId?: string;
        generationVersion?: number;
        connectedAtEpochMs?: number;
        lastHeartbeatAtEpochMs?: number;
        expiresAtEpochMs?: number;
        disconnected?: Readonly<{ atEpochMs: number; reason: string }>;
    }> = {},
): GroupPresenceSession {
    const connectedAtEpochMs = overrides.connectedAtEpochMs ?? 10;
    const base = {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: overrides.groupId ?? 'group-1',
        principalId,
        sessionId,
        generationId: overrides.generationId ?? `generation-${sessionId}`,
        generationVersion: overrides.generationVersion ?? connectedAtEpochMs,
        connectedAtEpochMs,
        lastHeartbeatAtEpochMs: overrides.lastHeartbeatAtEpochMs ?? 20,
        expiresAtEpochMs: overrides.expiresAtEpochMs ?? Date.now() + 60_000,
    };
    if (overrides.disconnected !== undefined) {
        return {
            ...base,
            status: 'disconnected',
            disconnectedAtEpochMs: overrides.disconnected.atEpochMs,
            disconnectReason: overrides.disconnected.reason,
        };
    }
    return {
        ...base,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null,
    };
}

function createGroupPresenceSummary(
    groupId: string,
    activeSessions: readonly GroupPresenceSession[],
    presenceRevision: number,
): GroupPresenceSummary {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        causalRevision: {
            groupRevision: 1,
            presenceRevision,
        },
        activePrincipalIds: [...new Set(activeSessions.map((session) => session.principalId))],
        activeSessionIds: activeSessions.map((session) => session.sessionId),
        activeSessions,
        activePrincipalCount: new Set(
            activeSessions.map((session) => session.principalId),
        ).size,
        activeSessionCount: activeSessions.length,
        computedAtEpochMs: 30,
    };
}

function createGroupEvent(
    eventId: string,
    occurredAtEpochMs: number,
    snapshotVersion = occurredAtEpochMs,
): GroupEvent {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        eventId,
        eventType: 'session-connected',
        snapshotVersion,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion,
        },
        occurredAtEpochMs,
        actor: { kind: 'service', serviceId: 'seed' },
        reason: null,
        traceId: null,
        requestId: null,
        payload: {},
    };
}

function createClientAuditStamp(atEpochMs: number): ClientAuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'seed' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

function createGroupAuditStamp(atEpochMs: number): GroupAuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'seed' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    findEntryCalls = 0;
    findEntriesByPrefixCalls = 0;
    readonly findEntriesByPrefixCallsByNamespace = new Map<string, number>();
    findEntriesByKeysCalls = 0;
    maxRowsReturnedPerFindEntriesByPrefix = 0;
    onFindEntryAfterRead?: (
        namespace: string,
        key: string,
    ) => void | Promise<void>;
    onFindEntriesByPrefix?: () => void | Promise<void>;
    onFindEntriesByKeys?: () => void | Promise<void>;
    findEntriesByPrefixPageCalls: Array<
        Readonly<{
            namespace: string;
            keyPrefix: string;
            afterKey?: string;
            limit: number;
        }>
    > = [];

    async begin<T>(
        fn: (repository: RuntimeStateTransactionalRepositoryLike) => Promise<T>,
    ): Promise<T> {
        return await fn(this);
    }

    async findEntry(namespace: string, key: string): Promise<RuntimeStateEntry | undefined> {
        this.findEntryCalls += 1;
        const entry = this.data.get(this.toKey(namespace, key));
        await this.onFindEntryAfterRead?.(namespace, key);
        return entry ? { ...entry } : undefined;
    }

    async findAllEntries(namespace: string): Promise<readonly RuntimeStateEntry[]> {
        return [...this.data.entries()]
            .filter(([compositeKey]) => this.toNamespace(compositeKey) === namespace)
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async findEntriesByPrefix(
        namespace: string,
        keyPrefix: string,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixCalls += 1;
        this.findEntriesByPrefixCallsByNamespace.set(
            namespace,
            (this.findEntriesByPrefixCallsByNamespace.get(namespace) ?? 0) + 1,
        );
        await this.onFindEntriesByPrefix?.();
        const rows = [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
        this.maxRowsReturnedPerFindEntriesByPrefix = Math.max(
            this.maxRowsReturnedPerFindEntriesByPrefix,
            rows.length,
        );
        return rows;
    }

    async findEntriesByKeys(
        namespace: string,
        keys: readonly string[],
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByKeysCalls += 1;
        await this.onFindEntriesByKeys?.();
        const keySet = new Set(keys);
        return [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    keySet.has(this.toStoreKey(compositeKey)),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key));
    }

    async findEntriesByPrefixPage(
        namespace: string,
        keyPrefix: string,
        options: Readonly<{
            afterKey?: string;
            limit: number;
        }>,
    ): Promise<readonly RuntimeStateEntry[]> {
        this.findEntriesByPrefixPageCalls.push({
            namespace,
            keyPrefix,
            afterKey: options.afterKey,
            limit: options.limit,
        });

        return [...this.data.entries()]
            .filter(
                ([compositeKey]) =>
                    this.toNamespace(compositeKey) === namespace &&
                    this.toStoreKey(compositeKey).startsWith(keyPrefix),
            )
            .map(([, entry]) => ({ ...entry }))
            .sort((left, right) => left.key.localeCompare(right.key))
            .filter((entry) =>
                options.afterKey === undefined ||
                entry.key.localeCompare(options.afterKey) > 0
            )
            .slice(0, options.limit);
    }

    async upsert(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<void> {
        const compositeKey = this.toKey(namespace, key);
        const current = this.data.get(compositeKey);
        this.data.set(compositeKey, {
            key,
            value,
            expireAtTimestamp,
            updatedTimestamp: new Date().toISOString(),
            revision: current ? current.revision + 1 : 0,
        });
    }

    async insertIfAbsent(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
    ): Promise<{ status: 'applied'; revision: number } | { status: 'conflict' }> {
        const compositeKey = this.toKey(namespace, key);
        if (this.data.has(compositeKey)) {
            return { status: 'conflict' };
        }
        await this.upsert(namespace, key, value, expireAtTimestamp);
        return { status: 'applied', revision: 0 };
    }

    async upsertIfRevision(
        namespace: string,
        key: string,
        value: string,
        expireAtTimestamp: number,
        expectedRevision: number,
    ): Promise<{ status: 'applied'; revision: number } | { status: 'conflict' }> {
        const current = this.data.get(this.toKey(namespace, key));
        if (!current || current.revision !== expectedRevision) {
            return { status: 'conflict' };
        }
        await this.upsert(namespace, key, value, expireAtTimestamp);
        return { status: 'applied', revision: expectedRevision + 1 };
    }

    async deleteIfRevision(
        namespace: string,
        key: string,
        expectedRevision: number,
    ): Promise<{ status: 'applied' } | { status: 'conflict' }> {
        const current = this.data.get(this.toKey(namespace, key));
        if (!current || current.revision !== expectedRevision) {
            return { status: 'conflict' };
        }
        await this.deleteByKey(namespace, key);
        return { status: 'applied' };
    }

    async deleteByKey(namespace: string, key: string): Promise<void> {
        this.data.delete(this.toKey(namespace, key));
    }

    async deleteExpired(namespace: string): Promise<number> {
        let deleted = 0;

        for (const [compositeKey, entry] of this.data.entries()) {
            if (this.toNamespace(compositeKey) !== namespace) {
                continue;
            }

            if (entry.expireAtTimestamp > Date.now()) {
                continue;
            }

            this.data.delete(compositeKey);
            deleted += 1;
        }

        return deleted;
    }

    async lockKey(_namespace: string, _key: string): Promise<void> {}

    findStoredEntry(namespace: string): RuntimeStateEntry | undefined {
        return [...this.data.entries()].find(
            ([compositeKey]) => this.toNamespace(compositeKey) === namespace,
        )?.[1];
    }

    resetCounters(): void {
        this.findEntryCalls = 0;
        this.findEntriesByPrefixCalls = 0;
        this.findEntriesByPrefixCallsByNamespace.clear();
        this.findEntriesByKeysCalls = 0;
        this.maxRowsReturnedPerFindEntriesByPrefix = 0;
        this.findEntriesByPrefixPageCalls.length = 0;
    }

    private toKey(namespace: string, key: string): string {
        return `${namespace}::${key}`;
    }

    private toNamespace(compositeKey: string): string {
        return compositeKey.split('::', 1)[0] ?? '';
    }

    private toStoreKey(compositeKey: string): string {
        return compositeKey.slice(this.toNamespace(compositeKey).length + 2);
    }
}
