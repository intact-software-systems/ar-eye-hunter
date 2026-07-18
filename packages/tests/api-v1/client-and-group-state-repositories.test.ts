import { describe, expect, it } from 'vitest';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    ClientEvent,
    ClientInstance,
    ClientPrincipal,
    ClientSession,
} from '@shared/api/client-types.ts';
import type {
    Group,
    GroupEvent,
    GroupMember,
    GroupPresenceSession,
} from '@shared/api/group-types.ts';
import { ClientStateRepository } from '@shared-server/rallar-system/repositories/ClientStateRepository.ts';
import { GroupStateRepository } from '@shared-server/rallar-system/repositories/GroupStateRepository.ts';
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

        await clientRepository.putPrincipal(principal);
        await clientRepository.putInstance(instanceA);
        await clientRepository.putInstance(instanceB);
        await clientRepository.putSession(activeSession);
        await clientRepository.putSession(expiredSession);
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

        await clientRepository.putPrincipal(principal);
        await clientRepository.putPrincipal({
            ...principal,
            displayName: 'Updated principal',
        });

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

    it('assigns distinct causal revisions to concurrent client writes with one domain version', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const principal = createClientPrincipal();

        await Promise.all([
            clientRepository.putPrincipal({ ...principal, displayName: 'A' }),
            clientRepository.putPrincipal({ ...principal, displayName: 'B' }),
        ]);

        const snapshot = await clientRepository.readSnapshot(principal);
        expect(snapshot?.stateRevision).toBe(2);
        expect(snapshot?.principal.snapshotVersion).toBe(principal.snapshotVersion);
    });

    it('retries a client snapshot when the principal revision changes during child reads', async () => {
        const repository = new FakeRuntimeStateRepository();
        const clientRepository = new ClientStateRepository(repository, {
            events: new InMemoryClientStateEventStore(),
        });
        const principal = createClientPrincipal();

        await clientRepository.putPrincipal(principal);
        await clientRepository.putInstance(createClientInstance('instance-a'));
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls !== 2) {
                return;
            }
            await clientRepository.putInstance({
                ...createClientInstance('instance-a'),
                platform: 'native',
            });
            await clientRepository.putPrincipal({
                ...principal,
                displayName: 'Current principal',
            });
        };

        const snapshot = await clientRepository.readSnapshot(principal);

        expect(snapshot).toMatchObject({
            stateRevision: 2,
            principal: { displayName: 'Current principal' },
            instances: [{ platform: 'native' }],
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
            await clientRepository.putPrincipal(principal);
            await clientRepository.putInstance(createClientInstance('instance-a'));
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

            await clientRepository.putPrincipal(createClientPrincipal(principalId));
            await clientRepository.putInstance(
                createClientInstance(instanceId, principalId),
            );
            await clientRepository.putSession(
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
            await clientRepository.putPrincipal(createClientPrincipal(principalId));
            await clientRepository.putInstance(
                createClientInstance(`instance-${principalId}`, principalId),
            );
        }
        repository.resetCounters();
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls !== 4) {
                return;
            }
            repository.onFindEntriesByPrefix = undefined;
            await clientRepository.putInstance(
                createClientInstance('instance-new', 'principal-0'),
            );
            await clientRepository.putPrincipal({
                ...createClientPrincipal('principal-0'),
                displayName: 'Changed',
            });
            await clientRepository.removePrincipal(createClientPrincipal('principal-1'));
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

describe('GroupStateRepository', () => {
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
            disconnectedAtEpochMs: now - 10,
            disconnectReason: 'closed',
        });
        const expiredSession = createGroupSession('principal-c', 'session-c', {
            expiresAtEpochMs: now - 1,
        });

        await groupRepository.putGroup(group);
        await groupRepository.putMember(activeMember);
        await groupRepository.putMember(invitedMember);
        await groupRepository.putPresenceSession(activeSession);
        await groupRepository.putPresenceSession(disconnectedSession);
        await groupRepository.putPresenceSession(expiredSession);
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
            stateRevision: 1,
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

    it('exposes the durable group-row revision without changing snapshotVersion', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup();

        await groupRepository.putGroup(group);
        await groupRepository.putGroup({
            ...group,
            displayName: 'Updated group',
        });

        const direct = await groupRepository.readSnapshot(group);
        const listed = await groupRepository.listSnapshots(group);
        const page = await groupRepository.listSnapshotsPage(group, { limit: 10 });

        expect(direct?.stateRevision).toBe(2);
        expect(direct?.group.snapshotVersion).toBe(group.snapshotVersion);
        expect(listed[0]?.stateRevision).toBe(2);
        expect(page.snapshots[0]?.stateRevision).toBe(2);
    });

    it('assigns distinct causal revisions to concurrent group writes with one domain version', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup();

        await Promise.all([
            groupRepository.putGroup({ ...group, displayName: 'A' }),
            groupRepository.putGroup({ ...group, displayName: 'B' }),
        ]);

        const snapshot = await groupRepository.readSnapshot(group);
        expect(snapshot?.stateRevision).toBe(2);
        expect(snapshot?.group.snapshotVersion).toBe(group.snapshotVersion);
    });

    it('retries a group snapshot when the aggregate revision changes during child reads', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup();

        await groupRepository.putGroup(group);
        await groupRepository.putMember(createGroupMember('principal-a', 'active'));
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls !== 2) {
                return;
            }
            await groupRepository.putMember(
                createGroupMember('principal-a', 'banned'),
            );
            await groupRepository.putGroup({
                ...group,
                displayName: 'Current group',
            });
        };

        const snapshot = await groupRepository.readSnapshot(group);

        expect(snapshot).toMatchObject({
            stateRevision: 2,
            group: { displayName: 'Current group' },
            members: [{ status: 'banned' }],
        });
    });

    it('returns absent when a group is deleted during child reads', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        const group = createGroup('group-delete');
        await groupRepository.putGroup(group);
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

        await groupRepository.putGroup(group);
        repository.onFindEntriesByPrefix = async () => {
            if (repository.findEntriesByPrefixCalls % 2 !== 0) {
                return;
            }
            await groupRepository.putGroup({
                ...group,
                displayName: `Revision ${repository.findEntriesByPrefixCalls}`,
            });
        };

        await expect(groupRepository.readSnapshot(group)).rejects.toMatchObject({
            name: 'StateSnapshotReadConflictError',
            status: 503,
        });
        expect(repository.findEntriesByPrefixCalls).toBe(6);
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

            await groupRepository.putGroup(createGroup(groupId));
            await groupRepository.putMember(
                createGroupMember(principalId, 'active', groupId),
            );
            await groupRepository.putPresenceSession(
                createGroupSession(principalId, sessionId, {
                    groupId,
                    expiresAtEpochMs: now + 60_000,
                }),
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
        expect(repository.findEntriesByPrefixCalls).toBe(4);
        expect(repository.maxRowsReturnedPerFindEntriesByPrefix).toBe(groupCount);
    });

    it('target-reads only changed groups and omits groups deleted during full-list validation', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });
        for (const groupId of ['group-0', 'group-1', 'group-2']) {
            await groupRepository.putGroup(createGroup(groupId));
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
        expect(repository.findEntriesByPrefixCalls).toBe(6);
        expect(repository.findEntryCalls).toBe(2);
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

            await groupRepository.putGroup(createGroup(groupId));
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
        expect(repository.findEntryCalls).toBe(0);
        expect(repository.maxRowsReturnedPerFindEntriesByPrefix).toBe(1);
    });

    it('fills bounded group snapshot pages after expired raw group rows are skipped', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });

        await groupRepository.putGroup({
            ...createGroup('group-0000'),
            purgeAfterEpochMs: Date.now() - 1,
        });
        await groupRepository.putGroup(createGroup('group-0001'));
        await groupRepository.putGroup(createGroup('group-0002'));
        await groupRepository.putGroup(createGroup('group-0003'));

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
        await groupRepository.putGroup(createGroup('group-0000'));
        await groupRepository.putGroup(createGroup('group-0001'));
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
        await groupRepository.putGroup(group);
        await groupRepository.putMember(
            createGroupMember('principal-old', 'active', group.groupId),
        );
        repository.resetCounters();
        repository.onFindEntriesByKeys = async () => {
            repository.onFindEntriesByKeys = undefined;
            await groupRepository.putMember(
                createGroupMember('principal-new', 'active', group.groupId),
            );
            await groupRepository.putGroup({ ...group, displayName: 'Changed' });
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
        expect(repository.findEntryCalls).toBe(2);
    });

    it('keeps paged group snapshot scans inside the exact workspace scope', async () => {
        const repository = new FakeRuntimeStateRepository();
        const groupRepository = new GroupStateRepository(repository, {
            events: new InMemoryGroupStateEventStore(),
        });

        await groupRepository.putGroup(createGroup('room-current'));
        await groupRepository.putGroup({
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
        status: 'active',
        roles: ['member'],
        metadata: {},
        snapshotVersion: 3,
        profileVersion: 1,
        presenceVersion: 2,
        created: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
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
        platform: 'web',
        capabilities: ['rtc'],
        registered: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createClientSession(
    clientInstanceId: string,
    sessionId: string,
    overrides: Partial<ClientSession> = {},
): ClientSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        clientInstanceId,
        sessionId,
        status: 'active',
        presenceState: 'online',
        transport: 'ws',
        authenticatedAtEpochMs: 10,
        connectedAtEpochMs: 20,
        lastHeartbeatAtEpochMs: 30,
        expiresAtEpochMs: Date.now() + 60_000,
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
        actor: { serviceId: 'seed' },
    };
}

function createGroup(groupId = 'group-1'): Group {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        slug: groupId === 'group-1' ? 'party-1' : groupId,
        displayName: groupId === 'group-1' ? 'Party 1' : groupId,
        kind: 'party',
        status: 'active',
        joinMode: 'invite-only',
        metadata: {},
        snapshotVersion: 6,
        metadataVersion: 1,
        rosterVersion: 2,
        presenceVersion: 3,
        created: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createGroupMember(
    principalId: string,
    status: GroupMember['status'],
    groupId = 'group-1',
): GroupMember {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId,
        principalId,
        role: 'member',
        status,
        joined: { atEpochMs: 1, byServiceId: 'seed' },
        updated: { atEpochMs: 2, byServiceId: 'seed' },
    };
}

function createGroupSession(
    principalId: string,
    sessionId: string,
    overrides: Partial<GroupPresenceSession> = {},
): GroupPresenceSession {
    return {
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        groupId: 'group-1',
        principalId,
        sessionId,
        connectedAtEpochMs: 10,
        lastHeartbeatAtEpochMs: 20,
        expiresAtEpochMs: Date.now() + 60_000,
        ...overrides,
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
        occurredAtEpochMs,
        actor: { serviceId: 'seed' },
    };
}

class FakeRuntimeStateRepository implements RuntimeStateTransactionalRepositoryLike {
    readonly data = new Map<string, RuntimeStateEntry>();
    findEntryCalls = 0;
    findEntriesByPrefixCalls = 0;
    findEntriesByKeysCalls = 0;
    maxRowsReturnedPerFindEntriesByPrefix = 0;
    onFindEntryAfterRead?: () => void | Promise<void>;
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
        await this.onFindEntryAfterRead?.();
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
