import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import type {
    AuditStamp,
    ClientEvent,
    ClientSnapshot,
} from '@shared/api/client-types.ts';
import type {
    GroupEvent,
    GroupSnapshot,
    GroupStateCausalRevision,
} from '@shared/api/group-types.ts';
import type { GroupStateDeltaEnvelope } from '@shared/api/group-state-delta.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
} from '@shared/api/state-types.ts';
import {
    newALBroadcastMessage,
    newALEventRoute,
    newALUnicastMessage,
} from '@shared/al-contracts/al-contract.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findOverlayById, setOverlayById } from '@shared/repository/overlays-repository.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import * as dataCaches from '@shared-web/browser/data-caches.ts';
import { configureTestCacheRepositories } from '../cache-repository-config.ts';
import { createTestGroup } from '@shared-test/create-test-group.ts';

describe('browser data caches state scope filtering', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('hydrates only snapshots in the default state scope', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const sameScopeClient = createClientSnapshot(
            'alice',
            'session-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            1,
        );
        const otherWorkspaceClient = createClientSnapshot(
            'bob',
            'session-b',
            DEFAULT_STATE_APPLICATION_ID,
            'workspace-b',
            1,
        );
        const sameScopeGroup = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a'],
            1,
        );
        const otherWorkspaceGroup = createGroupSnapshot(
            'room-b',
            DEFAULT_STATE_APPLICATION_ID,
            'workspace-b',
            ['session-b'],
            1,
        );

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [sameScopeClient, otherWorkspaceClient],
            [sameScopeGroup, otherWorkspaceGroup],
        );

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots()
                .map((snapshot) => snapshot.principal.principalId)
                .sort(),
        ).toEqual(['alice']);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
                .map((snapshot) => snapshot.group.groupId)
                .sort(),
        ).toEqual(['room-a']);
    });

    it('hydrates only snapshots in an explicit custom state scope', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const defaultScopeClient = createClientSnapshot(
            'alice',
            'session-a',
            'ar-eye-hunter',
            'default',
            1,
        );
        const customScopeClient = createClientSnapshot(
            'bob',
            'session-b',
            'app-1',
            'workspace-b',
            1,
        );
        const defaultScopeGroup = createGroupSnapshot(
            'room-a',
            'ar-eye-hunter',
            'default',
            ['session-a'],
            1,
        );
        const customScopeGroup = createGroupSnapshot(
            'room-b',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [defaultScopeClient, customScopeClient],
            [defaultScopeGroup, customScopeGroup],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots()
                .map((snapshot) => snapshot.principal.principalId),
        ).toEqual(['bob']);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
                .map((snapshot) => snapshot.group.groupId),
        ).toEqual(['room-b']);
    });

    it('recovers incomparable group tuples through a durable reread before RTC recomputation', async () => {
        const manager: Parameters<typeof dataCaches.hydrateStateCaches>[0] =
            createWebRtcGroupManager();
        const acceptUpdate = vi.spyOn(manager, 'acceptGroupUpdate');
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const current = withGroupCausalRevision(
            createGroupSnapshot(
                'room-a',
                DEFAULT_STATE_APPLICATION_ID,
                DEFAULT_STATE_WORKSPACE_ID,
                ['session-a'],
                2,
            ),
            { groupRevision: 2, presenceRevision: 1 },
        );
        const incomparable = withGroupCausalRevision(
            current,
            { groupRevision: 1, presenceRevision: 2 },
        );
        const recovered = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a'],
            3,
        );
        const rereadGroupSnapshots = vi.fn(async () => [recovered]);

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [],
            [current],
        );
        acceptUpdate.mockClear();

        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [],
            [incomparable],
            { rereadGroupSnapshots },
        );
        expect(rereadGroupSnapshots).toHaveBeenCalledOnce();
        expect(acceptUpdate).toHaveBeenCalledWith(recovered);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(current.group))
            .toEqual(recovered);
    });

    it('retains RTC connections when the current session leaves an active snapshot', async () => {
        const group = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn((input) => input === group.group),
            delete: vi.fn(async () => undefined),
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };

        await dataCaches.hydrateStateCaches(
            manager as never,
            clientData,
            [],
            [group],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );

        expect(manager.has).toHaveBeenCalledWith(group.group);
        expect(manager.delete).toHaveBeenCalledWith(group.group, {
            retainConnections: true,
        });
    });

    it('removes overlays but retains RTC connections when an active snapshot no longer includes the current session', async () => {
        const joined = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-a', 'session-b'],
            1,
        );
        const left = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            2,
        );
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn(() => true),
            delete: vi.fn(async () => undefined),
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };

        await dataCaches.hydrateStateCaches(
            manager as never,
            clientData,
            [],
            [joined],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );

        expect(findOverlayById(toScopedOverlayId(joined.group))).toBeDefined();
        manager.acceptGroupUpdate.mockClear();
        manager.delete.mockClear();

        groupStateSnapshotsRepository.setGroupStateSnapshot(left);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(findOverlayById(toScopedOverlayId(left.group))).toBeUndefined();
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(manager.delete).toHaveBeenCalledWith(left.group, {
            retainConnections: true,
        });
    });

    it('reconciles RTC peers when an active directory snapshot excludes the current session', async () => {
        const directoryOnly = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-b'],
            1,
        );
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            notifyOverlayTopologyChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn(() => false),
            delete: vi.fn(async () => undefined),
            ensureAllGroupsConnected: vi.fn(async () => undefined),
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };

        await dataCaches.hydrateStateCaches(
            manager as never,
            clientData,
            [],
            [directoryOnly],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );

        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
        expect(manager.ensureAllGroupsConnected).toHaveBeenCalledOnce();
    });

    it('cleans up RTC group tracking and notifies listeners when a group snapshot is removed', async () => {
        const group = createGroupSnapshot(
            'shared-room',
            'app-1',
            'workspace-b',
            ['session-a'],
            1,
        );
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            notifyOverlayTopologyChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn((input) => input === group.group),
            delete: vi.fn(async () => undefined),
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);

        await dataCaches.hydrateStateCaches(
            manager as never,
            clientData,
            [],
            [group],
            {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b',
                },
            },
        );
        manager.acceptGroupUpdate.mockClear();
        manager.delete.mockClear();
        listener.mockClear();

        groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(group.group);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(manager.delete).toHaveBeenCalledWith(group.group);
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [group],
        });

        unsubscribe();
    });

    it('ignores bare group and client state event websocket messages in the snapshot cache layer', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);

        dataCaches.initialise(
            webSocketQueueBox,
            manager,
            clientData,
        );

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-a', 'event-1'),
                'all',
                AppTopics.groupStateEvent,
                createGroupEvent('room-a', 'event-1'),
            ),
        );
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.clientStateEvent, 'alice', 'event-2'),
                'all',
                AppTopics.clientStateEvent,
                createClientEvent('alice', 'event-2'),
            ),
        );

        expect(listener).not.toHaveBeenCalled();
        expect(manager.notifyClientPresenceChanged).not.toHaveBeenCalled();
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(clientStateSnapshotsRepository.getAllClientStateSnapshots()).toEqual(
            [],
        );
        expect(groupStateSnapshotsRepository.getAllGroupStateSnapshots()).toEqual(
            [],
        );

        unsubscribe();
    });

    it('retains durable incomparable recovery across initialise and hydrate', async () => {
        const manager: Parameters<typeof dataCaches.initialise>[1] =
            createWebRtcGroupManager();
        const recompute = vi.spyOn(manager, 'ensureAllGroupsConnected');
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);
        const current = withGroupCausalRevision(
            createGroupSnapshot(
                'room-a',
                DEFAULT_STATE_APPLICATION_ID,
                DEFAULT_STATE_WORKSPACE_ID,
                ['session-b'],
                2,
            ),
            { groupRevision: 2, presenceRevision: 1 },
        );
        const incoming = withGroupCausalRevision(
            current,
            { groupRevision: 1, presenceRevision: 2 },
        );
        const recovered = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-b'],
            3,
        );
        const rereadGroupSnapshots = vi.fn(async () => [recovered]);
        const cacheOptions = { rereadGroupSnapshots };

        dataCaches.initialise(
            webSocketQueueBox,
            manager,
            clientData,
            cacheOptions,
        );
        await dataCaches.hydrateStateCaches(
            manager,
            clientData,
            [],
            [current],
            cacheOptions,
        );
        recompute.mockClear();
        listener.mockClear();

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(
                    AppTopics.groupDirectorySnapshot,
                    'room-a',
                    'room-a',
                ),
                'all',
                AppTopics.groupDirectorySnapshot,
                incoming,
            ),
        );

        expect(groupStateSnapshotsRepository.getAllGroupStateSnapshots()).toEqual([
            recovered,
        ]);
        expect(rereadGroupSnapshots).toHaveBeenCalledOnce();
        expect(recompute).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [recovered],
        });
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();

        unsubscribe();
    });

    it('applies overlay topology websocket snapshots to the local overlay cache', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const groupSnapshot = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a', 'session-b'],
            2,
        );
        const topology: RallarOverlayTopologySnapshot = {
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1,
            },
            state: 'active',
            overlayId: toScopedOverlayId(groupSnapshot.group),
            groupRef: {
                applicationId: groupSnapshot.group.applicationId,
                workspaceId: groupSnapshot.group.workspaceId,
                groupId: groupSnapshot.group.groupId,
            },
            name: 'room-a',
            topology: 'tree',
            activeSessionIds: ['session-a', 'session-b'],
            nextHopsBySessionId: {
                'session-a': ['session-b'],
                'session-b': ['session-a'],
            },
            degreeLimit: 5,
            version: 1,
            createdByClientId: 'server',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2,
        };

        dataCaches.initialise(
            webSocketQueueBox,
            manager,
            clientData,
        );

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-1'),
                'room',
                AppTopics.overlayTopology,
                topology,
                {
                    groupRef: groupSnapshot.group,
                },
            ),
        );

        expect(findOverlayById(topology.overlayId)).toMatchObject({
            overlayId: topology.overlayId,
            groupRef: topology.groupRef,
            topology: 'tree',
            nextHopSessionIds: ['session-b'],
            overlayVersion: 1,
        });
        expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledOnce();

        const removed = {
            ...topology,
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 2,
            },
            state: 'removed' as const,
            nextHopsBySessionId: {
                'session-a': [],
                'session-b': [],
            },
        };
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-2',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-2'),
                'room',
                AppTopics.overlayTopology,
                removed,
                { groupRef: groupSnapshot.group },
            ),
        );
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-stale'),
                'room',
                AppTopics.overlayTopology,
                topology,
                { groupRef: groupSnapshot.group },
            ),
        );

        expect(findOverlayById(topology.overlayId)).toBeUndefined();
        expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledTimes(3);
    });

    it.each([
        'rtc-topology-current-repair',
        'rtc-topology-hydration',
    ] as const)(
        'adopts incomparable durable current state from %s',
        async (deliveryKind) => {
            const manager = createWebRtcGroupManager();
            const clientData: ClientInfo = {
                clientId: 'alice',
                sessionId: 'session-a',
                isOnline: true,
            };
            let onInboxMessage:
                | ((message: unknown) => Promise<void>)
                | undefined;
            const webSocketQueueBox = {
                onAllInboxMessagesDo: vi.fn((callback: {
                    onMessage: (message: unknown) => Promise<void>;
                }) => {
                    onInboxMessage = callback.onMessage;
                    return webSocketQueueBox;
                }),
            };
            const groupSnapshot = createGroupSnapshot(
                'room-current-repair',
                DEFAULT_STATE_APPLICATION_ID,
                DEFAULT_STATE_WORKSPACE_ID,
                ['session-a', 'session-b'],
                2,
            );
            const historical = createTopologySnapshot(
                groupSnapshot,
                { groupRevision: 4, presenceRevision: 6 },
                7,
            );
            const current = createTopologySnapshot(
                groupSnapshot,
                { groupRevision: 5, presenceRevision: 5 },
                8,
            );
            dataCaches.initialise(webSocketQueueBox, manager, clientData);
            const receive = onInboxMessage;
            if (!receive) throw new Error('WebSocket topology callback was not installed.');

            await receive(withTopologyMessageId(
                newALBroadcastMessage(
                    'server-a',
                    newALEventRoute(
                        AppTopics.overlayTopology,
                        groupSnapshot.group.groupId,
                        'historical-topology',
                    ),
                    'room',
                    AppTopics.overlayTopology,
                    historical,
                    { groupRef: groupSnapshot.group },
                ),
                JSON.stringify(['rtc-topology-publication', 'historical-work']),
            ));
            await expect(receive(withTopologyMessageId(
                newCurrentStateTopologyMessage(
                    deliveryKind,
                    'rallar-server',
                    groupSnapshot,
                    current,
                    'mismatched-current-topology',
                ),
                toCurrentTopologyMessageId(deliveryKind, {
                    ...current,
                    version: current.version + 1,
                }),
            ))).rejects.toThrow('Overlay revision conflict');
            expect(findOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: historical.sourceGroupStateCausalRevision,
                overlayVersion: historical.version,
            });
            await expect(receive(withTopologyMessageId(
                newCurrentStateTopologyMessage(
                    deliveryKind,
                    'session-a',
                    groupSnapshot,
                    current,
                    'spoofed-current-topology',
                ),
                toCurrentTopologyMessageId(deliveryKind, current),
            ))).rejects.toThrow('Overlay revision conflict');
            expect(findOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: historical.sourceGroupStateCausalRevision,
                overlayVersion: historical.version,
            });
            await receive(withTopologyMessageId(
                newCurrentStateTopologyMessage(
                    deliveryKind,
                    'rallar-server',
                    groupSnapshot,
                    current,
                    'current-topology',
                ),
                toCurrentTopologyMessageId(deliveryKind, current),
            ));

            expect(findOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: current.sourceGroupStateCausalRevision,
                overlayVersion: current.version,
            });
            expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledTimes(2);

            const delayed = createTopologySnapshot(
                groupSnapshot,
                { groupRevision: 4, presenceRevision: 4 },
                9,
            );
            await receive(withTopologyMessageId(
                newCurrentStateTopologyMessage(
                    deliveryKind,
                    'rallar-server',
                    groupSnapshot,
                    delayed,
                    'delayed-current-topology',
                ),
                toCurrentTopologyMessageId(deliveryKind, delayed),
            ));
            expect(findOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: current.sourceGroupStateCausalRevision,
                overlayVersion: current.version,
            });

            const equalConflict = { ...current, name: 'Conflicting current topology' };
            await expect(receive(withTopologyMessageId(
                newCurrentStateTopologyMessage(
                    deliveryKind,
                    'rallar-server',
                    groupSnapshot,
                    equalConflict,
                    'conflicting-current-topology',
                ),
                toCurrentTopologyMessageId(deliveryKind, equalConflict),
            ))).rejects.toThrow('Overlay revision conflict');
            expect(findOverlayById(current.overlayId)).toMatchObject({
                name: current.name,
                sourceGroupStateCausalRevision: current.sourceGroupStateCausalRevision,
                overlayVersion: current.version,
            });
        },
    );

    it('pulls the floored group snapshot when a delta envelope arrives over a causal gap', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        let onInboxMessage:
            | ((message: unknown) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: unknown) => Promise<void>;
            }) => {
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
            }),
        };
        const listener = vi.fn();
        const unsubscribe = dataCaches.onStateCacheChange(listener);
        const resulting = createGroupSnapshot(
            'room-a',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a'],
            2,
        );
        const envelope = createGroupStateDeltaEnvelope(
            resulting,
            { groupRevision: 1, presenceRevision: 1 },
        );
        configureApiClient({ apiBaseUrl: 'https://api.example.test' });
        vi.stubGlobal('localStorage', { getItem: () => null });
        const fetchMock = vi.fn(async () => groupSnapshotResponse(resulting));
        vi.stubGlobal('fetch', fetchMock);

        dataCaches.initialise(
            webSocketQueueBox,
            manager,
            clientData,
        );

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.groupStateEvent, 'room-a', envelope.event.eventId),
                'all',
                AppTopics.groupStateEvent,
                envelope,
            ),
        );

        expect(fetchMock).toHaveBeenCalledOnce();
        expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
            'https://api.example.test/api/state/apps/rallar-server/workspaces/default' +
                '/groups/room-a?minGroupRevision=2&minPresenceRevision=2',
        );
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
        ).toEqual([resulting]);
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [resulting],
        });

        vi.unstubAllGlobals();
        unsubscribe();
    });

    it('creates a bounded bootstrap overlay for active group snapshots', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const memberSessionIds = Array.from(
            { length: 8 },
            (_, index) => `session-${String.fromCharCode(97 + index)}`,
        );
        const group = createGroupSnapshot(
            'room-bootstrap',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            memberSessionIds,
            1,
        );

        await dataCaches.hydrateStateCaches(manager, clientData, [], [group]);

        const overlay = findOverlayById(toScopedOverlayId(group.group));
        expect(overlay).toMatchObject({
            provenance: 'bootstrap',
            topology: 'star',
            degreeLimit: 5,
        });
        expect(overlay?.nextHopSessionIds).toHaveLength(5);
        expect(overlay?.nextHopSessionIds).not.toContain('session-a');
    });

    it('does not restamp a bootstrap overlay over an existing server overlay', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const group = createGroupSnapshot(
            'room-server-owned',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a', 'session-b', 'session-c'],
            1,
        );
        const overlayId = toScopedOverlayId(group.group);
        setOverlayById(overlayId, {
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1,
            },
            provenance: 'server',
            state: 'active',
            overlayId,
            groupRef: group.group,
            topology: 'tree',
            name: 'room-server-owned',
            createdByClientId: 'server',
            createdAtEpochMs: 1,
            nextHopSessionIds: ['session-c'],
            degreeLimit: 5,
            overlayVersion: 1,
            updatedAtEpochMs: 1,
        });

        const newerGroup = createGroupSnapshot(
            'room-server-owned',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            ['session-a', 'session-b', 'session-c'],
            5,
        );
        await dataCaches.hydrateStateCaches(manager, clientData, [], [newerGroup]);

        expect(findOverlayById(overlayId)).toMatchObject({
            provenance: 'server',
            topology: 'tree',
            nextHopSessionIds: ['session-c'],
        });
    });

    it('restores the unconditional full-membership star in legacy-star mode', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true,
        };
        const memberSessionIds = Array.from(
            { length: 8 },
            (_, index) => `session-${String.fromCharCode(97 + index)}`,
        );
        const group = createGroupSnapshot(
            'room-legacy',
            DEFAULT_STATE_APPLICATION_ID,
            DEFAULT_STATE_WORKSPACE_ID,
            memberSessionIds,
            1,
        );

        await dataCaches.hydrateStateCaches(manager, clientData, [], [group], {
            groupFormation: { mode: 'legacy-star', bootstrapDegree: 5 },
        });

        const overlay = findOverlayById(toScopedOverlayId(group.group));
        expect(overlay).toMatchObject({
            provenance: 'bootstrap',
            topology: 'star',
            degreeLimit: 7,
        });
        expect(overlay?.nextHopSessionIds).toEqual(memberSessionIds);
    });
});

function createWebRtcGroupManager() {
    return {
        notifyClientPresenceChanged: vi.fn(async () => undefined),
        notifyOverlayTopologyChanged: vi.fn(async () => undefined),
        acceptGroupUpdate: vi.fn(async () => undefined),
        ensureAllGroupsConnected: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
        has: vi.fn(() => false),
    } as never;
}

function createClientSnapshot(
    principalId: string,
    sessionId: string,
    applicationId: string,
    workspaceId: string,
    snapshotVersion: number,
): ClientSnapshot {
    return {
        stateRevision: snapshotVersion,
        principal: {
            applicationId,
            workspaceId,
            principalId,
            username: principalId,
            displayName: null,
            avatarUrl: null,
            authProvider: null,
            externalSubjectId: null,
            status: 'active',
            roles: [],
            metadata: {},
            snapshotVersion,
            profileVersion: snapshotVersion,
            presenceVersion: 1,
            created: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            disabled: null,
            deleted: null,
            lastSeenAtEpochMs: snapshotVersion,
        },
        instances: [],
        activeSessions: [{
            applicationId,
            workspaceId,
            principalId,
            clientInstanceId: `${principalId}-instance`,
            sessionId,
            status: 'active',
            generationId: `generation-${snapshotVersion}`,
            generationVersion: snapshotVersion,
            presenceState: 'online',
            transport: 'ws',
            authenticatedAtEpochMs: 1,
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
            connectionId: null,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        }],
        isOnline: true,
        activeSessionCount: 1,
        lastSeenAtEpochMs: snapshotVersion,
    };
}

function createGroupSnapshot(
    groupId: string,
    applicationId: string,
    workspaceId: string,
    sessionIds: readonly string[],
    snapshotVersion: number,
): GroupSnapshot {
    const ownerPrincipalId = sessionIds[0];
    if (!ownerPrincipalId) {
        throw new TypeError('Group fixture requires an owner');
    }
    return {
        stateRevision: snapshotVersion * 2,
        causalRevision: {
            groupRevision: snapshotVersion,
            presenceRevision: snapshotVersion,
        },
        group: createTestGroup({
            applicationId,
            workspaceId,
            groupId,
            displayName: groupId,
            snapshotVersion,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: snapshotVersion,
            created: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            activeMemberCount: sessionIds.length,
            ownerPrincipalId,
        }),
        members: sessionIds.map((sessionId, index) => ({
            applicationId,
            workspaceId,
            groupId,
            principalId: sessionId,
            role: index === 0 ? 'owner' : 'member',
            status: 'active',
            joined: auditStamp(1),
            updated: auditStamp(snapshotVersion),
            left: null,
            removed: null,
            banned: null,
            invitedByPrincipalId: null,
            invitationExpiresAtEpochMs: null,
        })),
        activeSessions: sessionIds.map((sessionId) => ({
            applicationId,
            workspaceId,
            groupId,
            sessionId,
            principalId: sessionId,
            generationId: `generation-${snapshotVersion}`,
            generationVersion: snapshotVersion,
            status: 'active',
            connectedAtEpochMs: 1,
            lastHeartbeatAtEpochMs: snapshotVersion,
            expiresAtEpochMs: 60_000,
            disconnectedAtEpochMs: null,
            disconnectReason: null,
        })),
        memberCount: sessionIds.length,
        onlineMemberCount: sessionIds.length,
    };
}

function createTopologySnapshot(
    group: GroupSnapshot,
    causalRevision: GroupSnapshot['causalRevision'],
    version: number,
): RallarOverlayTopologySnapshot {
    return {
        sourceGroupStateCausalRevision: causalRevision,
        state: 'active',
        overlayId: toScopedOverlayId(group.group),
        groupRef: {
            applicationId: group.group.applicationId,
            workspaceId: group.group.workspaceId,
            groupId: group.group.groupId,
        },
        name: group.group.displayName,
        topology: 'tree',
        activeSessionIds: ['session-a', 'session-b'],
        nextHopsBySessionId: {
            'session-a': ['session-b'],
            'session-b': ['session-a'],
        },
        degreeLimit: 5,
        version,
        createdByClientId: 'server',
        createdAtEpochMs: 1,
        updatedAtEpochMs: version,
    };
}

function withTopologyMessageId<T extends { readonly id: Readonly<{ readonly msgId: string }> }>(
    message: T,
    messageId: string,
): T {
    return {
        ...message,
        id: { ...message.id, msgId: messageId },
    };
}

function newCurrentStateTopologyMessage(
    deliveryKind: 'rtc-topology-current-repair' | 'rtc-topology-hydration',
    senderId: string,
    group: GroupSnapshot,
    topology: RallarOverlayTopologySnapshot,
    resourceId: string,
) {
    const route = newALEventRoute(
        AppTopics.overlayTopology,
        group.group.groupId,
        resourceId,
    );
    return deliveryKind === 'rtc-topology-current-repair'
        ? newALBroadcastMessage(
            senderId,
            route,
            'room',
            AppTopics.overlayTopology,
            topology,
            { groupRef: group.group },
        )
        : (() => {
            const message = newALUnicastMessage(
                senderId,
                route,
                'session-a',
                AppTopics.overlayTopology,
                topology,
            );
            return {
                ...message,
                id: { ...message.id, sessionId: 'session-a' },
            };
        })();
}

function toCurrentTopologyMessageId(
    deliveryKind: 'rtc-topology-current-repair' | 'rtc-topology-hydration',
    topology: RallarOverlayTopologySnapshot,
): string {
    const revision = topology.sourceGroupStateCausalRevision;
    return deliveryKind === 'rtc-topology-current-repair'
        ? JSON.stringify([
            deliveryKind,
            JSON.stringify([
                topology.groupRef.applicationId,
                topology.groupRef.workspaceId === undefined
                    ? ['absent']
                    : ['present', topology.groupRef.workspaceId],
                topology.groupRef.groupId,
            ]),
            revision.groupRevision,
            revision.presenceRevision,
            topology.version,
        ])
        : JSON.stringify([
            deliveryKind,
            'session-a',
            'generation-a',
            revision.groupRevision,
            revision.presenceRevision,
            topology.version,
        ]);
}

function withGroupCausalRevision(
    snapshot: GroupSnapshot,
    causalRevision: GroupSnapshot['causalRevision'],
): GroupSnapshot {
    return {
        ...snapshot,
        stateRevision:
            causalRevision.groupRevision + causalRevision.presenceRevision,
        causalRevision,
        group: {
            ...snapshot.group,
            snapshotVersion: causalRevision.groupRevision,
            presenceVersion: causalRevision.presenceRevision,
        },
    };
}

function createGroupStateDeltaEnvelope(
    resulting: GroupSnapshot,
    predecessorCausalRevision: GroupStateCausalRevision,
): GroupStateDeltaEnvelope {
    const activeSessionIds = resulting.activeSessions.map(
        (session) => session.sessionId,
    );
    return {
        event: {
            applicationId: resulting.group.applicationId,
            workspaceId: resulting.group.workspaceId,
            groupId: resulting.group.groupId,
            eventId: `event-${resulting.group.groupId}-${resulting.stateRevision}`,
            eventType: 'session-heartbeat',
            snapshotVersion: resulting.group.snapshotVersion,
            causalRevision: resulting.causalRevision,
            occurredAtEpochMs: 1,
            actor: { kind: 'service', serviceId: 'summary-worker' },
            reason: null,
            traceId: null,
            requestId: 'request-delta',
            payload: {},
        },
        predecessorCausalRevision,
        resultingCausalRevision: resulting.causalRevision,
        members: [],
        removedMemberPrincipalIds: [],
        sessions: [],
        removedSessionIds: [],
        activeSessionIds,
        group: resulting.group,
        memberCount: resulting.memberCount,
        onlineMemberCount: resulting.onlineMemberCount,
        audienceSessionIds: activeSessionIds,
    };
}

function groupSnapshotResponse(snapshot: GroupSnapshot): Response {
    return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'rallar-state-source': 'durable',
            'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
            'rallar-presence-revision': String(
                snapshot.causalRevision.presenceRevision,
            ),
        },
    });
}

function createGroupEvent(
    groupId: string,
    eventId: string,
): GroupEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        groupId,
        eventId,
        eventType: 'member-joined',
        snapshotVersion: 1,
        causalRevision: { groupRevision: 1, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: {
            kind: 'session',
            principalId: 'alice',
            sessionId: 'session-a',
        },
        reason: null,
        traceId: null,
        requestId: 'request-1',
        payload: {},
    };
}

function createClientEvent(
    principalId: string,
    eventId: string,
): ClientEvent {
    return {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        principalId,
        eventId,
        eventType: 'session-connected',
        snapshotVersion: 1,
        clientInstanceId: `${principalId}-instance`,
        sessionId: 'session-a',
        occurredAtEpochMs: 1,
        actor: {
            kind: 'session',
            principalId,
            sessionId: 'session-a',
        },
        reason: null,
        traceId: null,
        requestId: 'request-2',
        payload: {},
    };
}

function auditStamp(atEpochMs: number): AuditStamp {
    return {
        atEpochMs,
        actor: { kind: 'service', serviceId: 'test' },
        reason: null,
        traceId: null,
        requestId: null,
    };
}
