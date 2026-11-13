import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import { adoptGroupSnapshotsFromHeartbeat } from '@shared-web/browser/state-cache/group-heartbeat-snapshot-adoption.ts';
import { createPagedSnapshotReceiver } from './browser-state-cache-lifecycle-fixtures.ts';
// dprint-ignore
import {
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import {
    createPassThroughGroupStateSnapshotChangeSink,
    type GroupStateSnapshotChangeSink
} from '@shared/repository/group-state-snapshot-change-sink.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import { findAcceptedOverlayById, findPlannedOverlayById } from '@shared/repository/overlays-repository.ts';
// dprint-ignore
import {
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import { configureTestCacheRepositories } from '../../configure-test-cache-repositories.ts';
import {
    createClientSnapshot,
    createGroupSnapshot,
    createGroupStateDeltaEnvelope,
    createTopologySnapshot,
    createWebRtcGroupManager,
    newCurrentStateTopologyMessage,
    toCurrentTopologyMessageId,
    withGroupCausalRevision,
    withTopologyMessageId
} from './browser-state-cache-lifecycle-fixtures.ts';

/** One sink per file, so a connect's initialise and hydrate match as the middleware's do. */
const passThroughGroupStateDiagnostics = createPassThroughGroupStateSnapshotChangeSink();

describe('browser state cache lifecycle scope filtering', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    it('hydrates only snapshots in the default state scope', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const sameScopeClient = createClientSnapshot({
            principalId: 'alice',
            sessionId: 'session-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            snapshotVersion: 1
        });
        const otherWorkspaceClient = createClientSnapshot({
            principalId: 'bob',
            sessionId: 'session-b',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: 'workspace-b',
            snapshotVersion: 1
        });
        const sameScopeGroup = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a'],
            snapshotVersion: 1
        });
        const otherWorkspaceGroup = createGroupSnapshot({
            groupId: 'room-b',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [sameScopeClient, otherWorkspaceClient],
            groupSnapshots: [sameScopeGroup, otherWorkspaceGroup]
        });

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots()
                .map((snapshot) => snapshot.principal.principalId)
                .sort()
        ).toEqual(['alice']);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
                .map((snapshot) => snapshot.group.groupId)
                .sort()
        ).toEqual(['room-a']);
    });

    it('hydrates only snapshots in an explicit custom state scope', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const defaultScopeClient = createClientSnapshot({
            principalId: 'alice',
            sessionId: 'session-a',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            snapshotVersion: 1
        });
        const customScopeClient = createClientSnapshot({
            principalId: 'bob',
            sessionId: 'session-b',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            snapshotVersion: 1
        });
        const defaultScopeGroup = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: 'ar-eye-hunter',
            workspaceId: 'default',
            sessionIds: ['session-a'],
            snapshotVersion: 1
        });
        const customScopeGroup = createGroupSnapshot({
            groupId: 'room-b',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [defaultScopeClient, customScopeClient],
            groupSnapshots: [defaultScopeGroup, customScopeGroup],
            options: {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b'
                }
            }
        });

        expect(
            clientStateSnapshotsRepository.getAllClientStateSnapshots()
                .map((snapshot) => snapshot.principal.principalId)
        ).toEqual(['bob']);
        expect(
            groupStateSnapshotsRepository.getAllGroupStateSnapshots()
                .map((snapshot) => snapshot.group.groupId)
        ).toEqual(['room-b']);
    });

    it('recovers incomparable group tuples through a durable reread before RTC recomputation', async () => {
        const manager = createWebRtcGroupManager();
        const acceptUpdate = vi.spyOn(manager, 'acceptGroupUpdate');
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const current = withGroupCausalRevision(
            createGroupSnapshot({
                groupId: 'room-a',
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                sessionIds: ['session-a'],
                snapshotVersion: 2
            }),
            { groupRevision: 2, presenceRevision: 1 }
        );
        const incomparable = withGroupCausalRevision(
            current,
            { groupRevision: 1, presenceRevision: 2 }
        );
        const recovered = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a'],
            snapshotVersion: 3
        });
        const rereadGroupSnapshots = vi.fn(async () => [recovered]);

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [current]
        });
        acceptUpdate.mockClear();

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [incomparable],
            options: { rereadGroupSnapshots }
        });
        expect(rereadGroupSnapshots).toHaveBeenCalledOnce();
        expect(acceptUpdate).toHaveBeenCalledWith(recovered);
        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(current.group))
            .toEqual(recovered);
    });

    it('retains RTC connections when the current session leaves an active snapshot', async () => {
        const group = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const manager = createWebRtcGroupManager();
        manager.has.mockImplementation((input) => input === group.group);
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [group],
            options: {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b'
                }
            }
        });

        expect(manager.has).toHaveBeenCalledWith(group.group);
        expect(manager.delete).toHaveBeenCalledWith(group.group, {
            retainConnections: true
        });
    });

    it('removes overlays but retains RTC connections when an active snapshot no longer includes the current session', async () => {
        const joined = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 1
        });
        const left = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 2
        });
        const manager = createWebRtcGroupManager();
        manager.has.mockImplementation(() => true);
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [joined],
            options: {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b'
                }
            }
        });

        expect(findPlannedOverlayById(toScopedOverlayId(joined.group))).toBeDefined();
        manager.acceptGroupUpdate.mockClear();
        manager.delete.mockClear();

        groupStateSnapshotsRepository.setGroupStateSnapshot(left);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(findPlannedOverlayById(toScopedOverlayId(left.group))).toBeUndefined();
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(manager.delete).toHaveBeenCalledWith(left.group, {
            retainConnections: true
        });
    });

    it('reconciles RTC peers when an active directory snapshot excludes the current session', async () => {
        const directoryOnly = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-b'],
            snapshotVersion: 1
        });
        const manager = createWebRtcGroupManager();
        manager.has.mockImplementation(() => false);
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [directoryOnly],
            options: {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b'
                }
            }
        });

        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
        expect(manager.ensureAllGroupsConnected).toHaveBeenCalledOnce();
    });

    it('cleans up RTC group tracking and notifies listeners when a group snapshot is removed', async () => {
        const group = createGroupSnapshot({
            groupId: 'shared-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-a'],
            snapshotVersion: 1
        });
        const manager = createWebRtcGroupManager();
        manager.has.mockImplementation((input) => input === group.group);
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [group],
            options: {
                scope: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-b'
                }
            }
        });
        manager.acceptGroupUpdate.mockClear();
        manager.delete.mockClear();
        listener.mockClear();

        groupStateSnapshotsRepository.removeGroupStateSnapshotByRef(group.group);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(manager.delete).toHaveBeenCalledWith(group.group);
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [group]
        });

        unsubscribe();
    });

    it('does not amplify a lease-only group authority renewal to RTC or state-cache listeners', async () => {
        const current = createGroupSnapshot({
            groupId: 'quiet-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 1
        });
        const renewed: typeof current = {
            ...current,
            activeSessions: current.activeSessions.map((session) => ({
                ...session,
                lastHeartbeatAtEpochMs: 20_000,
                expiresAtEpochMs: 120_000
            }))
        };
        const manager = createWebRtcGroupManager();
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData: {
                clientId: 'session-a',
                sessionId: 'session-a',
                isOnline: true
            },
            clientSnapshots: [],
            groupSnapshots: [current],
            options: {
                scope: { applicationId: 'app-1', workspaceId: 'workspace-b' }
            }
        });
        manager.acceptGroupUpdate.mockClear();
        manager.delete.mockClear();
        listener.mockClear();
        const rawKinds: string[] = [];
        const unsubscribeRaw = groupStateSnapshotsRepository.onGroupStateSnapshotChange((change) => {
            rawKinds.push(change.kind);
        });

        expect(
            groupStateSnapshotsRepository.replaceGroupStateSnapshotIfUnchanged(
                current,
                renewed
            )
        ).toBe(true);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(current.group)).toBe(renewed);
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();
        expect(manager.delete).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
        expect(rawKinds).toEqual(['updated']);

        unsubscribeRaw();
        unsubscribe();
    });

    it('reconciles RTC peers when a TTL-crossing heartbeat restores a same-tuple room session', async () => {
        const full = createGroupSnapshot({
            groupId: 'renewed-room',
            applicationId: 'app-1',
            workspaceId: 'workspace-b',
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 1
        });
        const heartbeatAtEpochMs = Date.now();
        const observed = {
            ...full,
            activeSessions: [{
                ...full.activeSessions[0]!,
                lastHeartbeatAtEpochMs: heartbeatAtEpochMs - 1_000,
                expiresAtEpochMs: heartbeatAtEpochMs + 60_000
            }],
            onlineMemberCount: 1
        };
        const renewed = {
            ...full,
            activeSessions: full.activeSessions.map((session) => ({
                ...session,
                lastHeartbeatAtEpochMs: heartbeatAtEpochMs,
                expiresAtEpochMs: heartbeatAtEpochMs + 120_000
            }))
        };
        const manager = createWebRtcGroupManager();
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);

        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData: { clientId: 'session-a', sessionId: 'session-a', isOnline: true },
            clientSnapshots: [],
            groupSnapshots: [observed],
            options: { scope: { applicationId: 'app-1', workspaceId: 'workspace-b' } }
        });
        manager.acceptGroupUpdate.mockClear();
        listener.mockClear();

        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            vi.setSystemTime(heartbeatAtEpochMs + 61_001);
            expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(observed.group)).toBeUndefined();

            adoptGroupSnapshotsFromHeartbeat([observed], [renewed]);
            await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

            expect(manager.acceptGroupUpdate).toHaveBeenCalledWith(renewed);
            expect(listener).toHaveBeenCalledWith({ clients: [], groups: [renewed] });
        }
        finally {
            vi.useRealTimers();
            unsubscribe();
        }
    });

    it('retains durable incomparable recovery across initialise and hydrate', async () => {
        const manager = createWebRtcGroupManager();
        const recompute = vi.spyOn(manager, 'ensureAllGroupsConnected');
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        let onInboxMessage:
            | ((message: ALMessage) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: ALMessage) => Promise<void>;
            }) => {
                onInboxMessage = createPagedSnapshotReceiver(callback.onMessage);
            })
        };
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);
        const current = withGroupCausalRevision(
            createGroupSnapshot({
                groupId: 'room-a',
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                sessionIds: ['session-b'],
                snapshotVersion: 2
            }),
            { groupRevision: 2, presenceRevision: 1 }
        );
        const incoming = withGroupCausalRevision(
            current,
            { groupRevision: 1, presenceRevision: 2 }
        );
        const recovered = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-b'],
            snapshotVersion: 3
        });
        const rereadGroupSnapshots = vi.fn(async () => [recovered]);
        const cacheOptions = { rereadGroupSnapshots };

        browserStateCacheLifecycle.initialise({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager,
            clientData,
            options: cacheOptions
        });
        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [current],
            options: cacheOptions
        });
        recompute.mockClear();
        listener.mockClear();

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(
                    AppTopics.groupDirectorySnapshot,
                    'room-a',
                    'room-a'
                ),
                'all',
                AppTopics.groupDirectorySnapshot,
                incoming
            )
        );

        expect(groupStateSnapshotsRepository.getAllGroupStateSnapshots()).toEqual([
            recovered
        ]);
        expect(rereadGroupSnapshots).toHaveBeenCalledOnce();
        expect(recompute).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith({
            clients: [],
            groups: [recovered]
        });
        expect(manager.acceptGroupUpdate).not.toHaveBeenCalled();

        unsubscribe();
    });

    it('applies overlay topology websocket snapshots to the local overlay cache', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        let onInboxMessage:
            | ((message: ALMessage) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: ALMessage) => Promise<void>;
            }) => {
                onInboxMessage = createPagedSnapshotReceiver(callback.onMessage);
            })
        };
        const groupSnapshot = createGroupSnapshot({
            groupId: 'room-a',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 2
        });
        const topology: RallarOverlayTopologySnapshot = {
            sourceGroupStateCausalRevision: {
                groupRevision: 1,
                presenceRevision: 1
            },
            state: 'active',
            overlayId: toScopedOverlayId(groupSnapshot.group),
            groupRef: {
                applicationId: groupSnapshot.group.applicationId,
                workspaceId: groupSnapshot.group.workspaceId,
                groupId: groupSnapshot.group.groupId
            },
            name: 'room-a',
            topology: 'tree',
            activeSessionIds: ['session-a', 'session-b'],
            nextHopsBySessionId: {
                'session-a': ['session-b'],
                'session-b': ['session-a']
            },
            degreeLimit: 5,
            version: 1,
            createdByClientId: 'server',
            createdAtEpochMs: 1,
            updatedAtEpochMs: 2
        };

        browserStateCacheLifecycle.initialise({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager,
            clientData
        });
        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [groupSnapshot]
        });

        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-1'),
                'room',
                AppTopics.overlayTopology,
                topology,
                {
                    groupRef: groupSnapshot.group
                }
            )
        );

        expect(findPlannedOverlayById(topology.overlayId)).toMatchObject({
            overlayId: topology.overlayId,
            groupRef: topology.groupRef,
            topology: 'tree',
            nextHopSessionIds: ['session-b'],
            overlayVersion: 1
        });
        expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledOnce();

        const removed = {
            ...topology,
            sourceGroupStateCausalRevision: {
                groupRevision: 2,
                presenceRevision: 2
            },
            state: 'removed' as const,
            nextHopsBySessionId: {
                'session-a': [],
                'session-b': []
            }
        };
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-2',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-2'),
                'room',
                AppTopics.overlayTopology,
                removed,
                { groupRef: groupSnapshot.group }
            )
        );
        await onInboxMessage?.(
            newALBroadcastMessage(
                'server-1',
                newALEventRoute(AppTopics.overlayTopology, 'room-a', 'topology-stale'),
                'room',
                AppTopics.overlayTopology,
                topology,
                { groupRef: groupSnapshot.group }
            )
        );

        expect(findPlannedOverlayById(topology.overlayId)).toBeUndefined();
        expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledTimes(2);
    });

    it('ignores an obsolete graph message without changing server-planned identity', async () => {
        const manager = createWebRtcGroupManager();
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        let onInboxMessage:
            | ((message: ALMessage) => Promise<void>)
            | undefined;
        const webSocketQueueBox = {
            onAllInboxMessagesDo: vi.fn((callback: {
                onMessage: (message: ALMessage) => Promise<void>;
            }) => {
                onInboxMessage = createPagedSnapshotReceiver(callback.onMessage);
            })
        };
        const group = createGroupSnapshot({
            groupId: 'room-graph-ordering',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 2
        });
        const topology = createTopologySnapshot(
            group,
            { groupRevision: 2, presenceRevision: 2 },
            3
        );

        browserStateCacheLifecycle.initialise({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager,
            clientData
        });
        await browserStateCacheLifecycle.hydrate({
            groupStateDiagnostics: passThroughGroupStateDiagnostics,
            webRtcGroupManager: manager,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [group]
        });
        const receive = onInboxMessage;
        if (!receive) {
            throw new Error('WebSocket cache callback was not installed.');
        }

        await receive(newALBroadcastMessage(
            'server-a',
            newALEventRoute(AppTopics.overlayTopology, group.group.groupId, 'topology'),
            'room',
            AppTopics.overlayTopology,
            topology,
            { groupRef: group.group }
        ));
        expect(findPlannedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);

        // The retired topic must be ignored before payload decoding, so this
        // sentinel is intentionally not a valid historical graph snapshot.
        await receive(newALBroadcastMessage(
            'server-a',
            newALEventRoute('graphs', group.group.groupId, 'graph'),
            'room',
            'graphs',
            { intentionallyInvalid: true },
            { groupRef: group.group }
        ));
        expect(findPlannedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);

        const accepted = createGroupSnapshot({
            groupId: group.group.groupId,
            applicationId: group.group.applicationId,
            workspaceId: group.group.workspaceId ?? DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion: 3
        });
        groupStateSnapshotsRepository.setGroupStateSnapshot({
            ...accepted,
            group: {
                ...accepted.group,
                acceptedLayoutIdentity: toGroupLayoutIdentity(topology)
            }
        });
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(findAcceptedOverlayById(topology.overlayId)?.overlayVersion).toBe(3);
        expect(findPlannedOverlayById(topology.overlayId)).toBeUndefined();
    });

    it.each(
        [
            'rtc-topology-current-repair',
            'rtc-topology-hydration'
        ] as const
    )(
        'adopts incomparable durable current state from %s',
        async (deliveryKind) => {
            const manager = createWebRtcGroupManager();
            const clientData: ClientInfo = {
                clientId: 'alice',
                sessionId: 'session-a',
                isOnline: true
            };
            let onInboxMessage:
                | ((message: ALMessage) => Promise<void>)
                | undefined;
            const webSocketQueueBox = {
                onAllInboxMessagesDo: vi.fn((callback: {
                    onMessage: (message: ALMessage) => Promise<void>;
                }) => {
                    onInboxMessage = createPagedSnapshotReceiver(callback.onMessage);
                })
            };
            const groupSnapshot = createGroupSnapshot({
                groupId: 'room-current-repair',
                applicationId: DEFAULT_STATE_APPLICATION_ID,
                workspaceId: DEFAULT_STATE_WORKSPACE_ID,
                sessionIds: ['session-a', 'session-b'],
                snapshotVersion: 2
            });
            const historical = createTopologySnapshot(
                groupSnapshot,
                { groupRevision: 4, presenceRevision: 6 },
                7
            );
            const current = createTopologySnapshot(
                groupSnapshot,
                { groupRevision: 5, presenceRevision: 5 },
                8
            );
            browserStateCacheLifecycle.initialise({
                groupStateDiagnostics: passThroughGroupStateDiagnostics,
                inbox: webSocketQueueBox,
                webRtcGroupManager: manager,
                clientData
            });
            await browserStateCacheLifecycle.hydrate({
                groupStateDiagnostics: passThroughGroupStateDiagnostics,
                webRtcGroupManager: manager,
                clientData,
                clientSnapshots: [],
                groupSnapshots: [groupSnapshot]
            });
            const receive = onInboxMessage;
            if (!receive) {
                throw new Error('WebSocket topology callback was not installed.');
            }

            await receive(withTopologyMessageId(
                newALBroadcastMessage(
                    'server-a',
                    newALEventRoute(
                        AppTopics.overlayTopology,
                        groupSnapshot.group.groupId,
                        'historical-topology'
                    ),
                    'room',
                    AppTopics.overlayTopology,
                    historical,
                    { groupRef: groupSnapshot.group }
                ),
                JSON.stringify(['rtc-topology-publication', 'historical-work'])
            ));
            await expect(receive(withTopologyMessageId(
                newCurrentStateTopologyMessage({
                    deliveryKind: deliveryKind,
                    senderId: 'rallar-server',
                    group: groupSnapshot,
                    topology: current,
                    resourceId: 'mismatched-current-topology'
                }),
                toCurrentTopologyMessageId(deliveryKind, {
                    ...current,
                    version: current.version + 1
                })
            ))).resolves.toBeUndefined();
            expect(findPlannedOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: historical.sourceGroupStateCausalRevision,
                overlayVersion: historical.version
            });
            await receive(withTopologyMessageId(
                newCurrentStateTopologyMessage({
                    deliveryKind: deliveryKind,
                    senderId: 'rallar-server',
                    group: groupSnapshot,
                    topology: current,
                    resourceId: 'current-topology'
                }),
                toCurrentTopologyMessageId(deliveryKind, current)
            ));

            expect(findPlannedOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: current.sourceGroupStateCausalRevision,
                overlayVersion: current.version
            });
            expect(manager.notifyOverlayTopologyChanged).toHaveBeenCalledTimes(2);

            const delayed = createTopologySnapshot(
                groupSnapshot,
                { groupRevision: 4, presenceRevision: 4 },
                9
            );
            await receive(withTopologyMessageId(
                newCurrentStateTopologyMessage({
                    deliveryKind: deliveryKind,
                    senderId: 'rallar-server',
                    group: groupSnapshot,
                    topology: delayed,
                    resourceId: 'delayed-current-topology'
                }),
                toCurrentTopologyMessageId(deliveryKind, delayed)
            ));
            expect(findPlannedOverlayById(current.overlayId)).toMatchObject({
                sourceGroupStateCausalRevision: current.sourceGroupStateCausalRevision,
                overlayVersion: current.version
            });

            const equalConflict = { ...current, name: 'Conflicting current topology' };
            await expect(receive(withTopologyMessageId(
                newCurrentStateTopologyMessage({
                    deliveryKind: deliveryKind,
                    senderId: 'rallar-server',
                    group: groupSnapshot,
                    topology: equalConflict,
                    resourceId: 'conflicting-current-topology'
                }),
                toCurrentTopologyMessageId(deliveryKind, equalConflict)
            ))).resolves.toBeUndefined();
            expect(findPlannedOverlayById(current.overlayId)).toMatchObject({
                name: current.name,
                sourceGroupStateCausalRevision: current.sourceGroupStateCausalRevision,
                overlayVersion: current.version
            });
        }
    );
});

describe('browser state cache lifecycle group changes for diagnostics', () => {
    beforeEach(() => {
        configureTestCacheRepositories();
    });

    const clientData: ClientInfo = { clientId: 'alice', sessionId: 'session-a', isOnline: true };

    function createRoomSnapshot(snapshotVersion: number) {
        return createGroupSnapshot({
            groupId: 'room-applied',
            applicationId: DEFAULT_STATE_APPLICATION_ID,
            workspaceId: DEFAULT_STATE_WORKSPACE_ID,
            sessionIds: ['session-a', 'session-b'],
            snapshotVersion
        });
    }

    /** One sink for the connect's initialise and hydrate, as the middleware passes it: the hydrate keeps the observers. */
    function connectWithSink(groupStateDiagnostics: GroupStateSnapshotChangeSink) {
        const manager = createWebRtcGroupManager();
        let receive: ((message: ALMessage) => Promise<void>) | undefined;
        browserStateCacheLifecycle.initialise({
            inbox: {
                onAllInboxMessagesDo: vi.fn((callback: { onMessage: (message: ALMessage) => Promise<void>; }) => {
                    receive = createPagedSnapshotReceiver(callback.onMessage);
                })
            },
            webRtcGroupManager: manager,
            clientData,
            groupStateDiagnostics
        });
        return {
            manager,
            receive: async (message: ALMessage) => await receive?.(message),
            hydrate: async (snapshot: GroupSnapshot) =>
                await browserStateCacheLifecycle.hydrate({
                    webRtcGroupManager: manager,
                    clientData,
                    clientSnapshots: [],
                    groupSnapshots: [snapshot],
                    groupStateDiagnostics
                })
        };
    }

    function withSessionLeases(snapshot: GroupSnapshot, sessionCount: number, leaseEpochMs: number): GroupSnapshot {
        const activeSessions = snapshot.activeSessions.slice(0, sessionCount).map((session) => ({
            ...session,
            lastHeartbeatAtEpochMs: leaseEpochMs,
            expiresAtEpochMs: leaseEpochMs + 60_000
        }));
        return { ...snapshot, activeSessions, onlineMemberCount: activeSessions.length };
    }

    function newDeltaMessage(resulting: ReturnType<typeof createRoomSnapshot>, predecessor: number): ALMessage {
        const envelope = createGroupStateDeltaEnvelope(resulting, { groupRevision: predecessor, presenceRevision: predecessor });
        return newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupStateEvent, 'room-applied', envelope.event.eventId),
            'all',
            AppTopics.groupStateEvent,
            envelope
        );
    }

    function newDirectorySnapshotMessage(snapshot: ReturnType<typeof createRoomSnapshot>): ALMessage {
        return newALBroadcastMessage(
            'server-1',
            newALEventRoute(AppTopics.groupDirectorySnapshot, 'room-applied', 'room-applied'),
            'all',
            AppTopics.groupDirectorySnapshot,
            snapshot
        );
    }

    it('hands each raw group change to the diagnostics sink, in order, for a delta, a snapshot page and a heartbeat adoption', async () => {
        const stated: groupStateSnapshotsRepository.GroupStateSnapshotChange[] = [];
        const connect = connectWithSink((change) => stated.push(change));
        const paged = createRoomSnapshot(3);
        const advanced = createRoomSnapshot(4);
        const leased = withSessionLeases(advanced, 2, 10_000);
        await connect.hydrate(createRoomSnapshot(1));

        await connect.receive(newDeltaMessage(createRoomSnapshot(2), 1));
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
        await connect.receive(newDirectorySnapshotMessage(paged));
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
        adoptGroupSnapshotsFromHeartbeat([paged], [advanced]);
        adoptGroupSnapshotsFromHeartbeat([advanced], [leased]);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(stated.map(({ kind, snapshot }) => [kind, snapshot?.causalRevision])).toEqual([
            [ObservableValueEventType.Created, createRoomSnapshot(1).causalRevision],
            [ObservableValueEventType.Updated, createRoomSnapshot(2).causalRevision],
            [ObservableValueEventType.Updated, paged.causalRevision],
            [ObservableValueEventType.Updated, advanced.causalRevision],
            [ObservableValueEventType.Updated, leased.causalRevision]
        ]);
        expect(stated.at(-1)?.snapshot).toBe(leased);
        expect(stated.every(({ groupRef }) => groupRef.groupId === 'room-applied')).toBe(true);
    });

    it('hands a heartbeat that changes the session count at an equal tuple to the sink, once per change', async () => {
        const stated: groupStateSnapshotsRepository.GroupStateSnapshotChange[] = [];
        const connect = connectWithSink((change) => stated.push(change));
        const held = withSessionLeases(createRoomSnapshot(4), 2, 10_000);
        const reduced = withSessionLeases(held, 1, 11_000);
        const restored = withSessionLeases(held, 2, 12_000);
        await connect.hydrate(held);

        adoptGroupSnapshotsFromHeartbeat([held], [reduced]);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();
        adoptGroupSnapshotsFromHeartbeat([reduced], [restored]);
        await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

        expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(held.group)).toBe(restored);
        expect(stated.map(({ snapshot, previous }) => [snapshot, previous])).toEqual([
            [held, undefined],
            [reduced, held],
            [restored, reduced]
        ]);
    });

    it('a sink that throws changes no adoption', async () => {
        const reached: (number | undefined)[] = [];
        const throwing: GroupStateSnapshotChangeSink = (change) => {
            reached.push(change.snapshot?.causalRevision.groupRevision);
            throw new Error('sink failed');
        };
        const { manager, receive, hydrate } = connectWithSink(throwing);
        const notifiedRevisions: number[] = [];
        const unsubscribe = browserStateCacheLifecycle.onChange((change) => {
            notifiedRevisions.push(...change.groups.map((group) => group.causalRevision.groupRevision));
        });
        const first = createRoomSnapshot(1);
        const advanced = createRoomSnapshot(2);

        try {
            await hydrate(first);
            await receive(newDeltaMessage(advanced, 1));
            await groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle();

            expect(groupStateSnapshotsRepository.findGroupStateSnapshotByRef(first.group)?.causalRevision)
                .toEqual(advanced.causalRevision);
            expect(manager.acceptGroupUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ causalRevision: advanced.causalRevision })
            );
            expect(notifiedRevisions).toEqual([1, 2]);
            expect(reached).toEqual([1, 2]);
        }
        finally {
            unsubscribe();
        }
    });
});
