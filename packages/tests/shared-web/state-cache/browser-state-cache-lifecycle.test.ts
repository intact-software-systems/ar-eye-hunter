import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
// dprint-ignore
import {
    newALBroadcastMessage,
    newALEventRoute,
    type ALMessage
} from '@shared/al-contracts/al-contract.ts';
import { AppTopics, type ClientInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { toGroupLayoutIdentity } from '@shared/api/group-lifecycle/group-layout-identity.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
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
import { configureTestCacheRepositories } from '../../cache-repository-config.ts';
import {
    createClientSnapshot,
    createGroupSnapshot,
    createTopologySnapshot,
    createWebRtcGroupManager,
    newCurrentStateTopologyMessage,
    toCurrentTopologyMessageId,
    withGroupCausalRevision,
    withTopologyMessageId
} from './browser-state-cache-lifecycle-fixtures.ts';

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
            webRtcGroupManager: manager as never,
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
            webRtcGroupManager: manager as never,
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
            webRtcGroupManager: manager as never,
            clientData,
            clientSnapshots: [],
            groupSnapshots: [current]
        });
        acceptUpdate.mockClear();

        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn((input) => input === group.group),
            delete: vi.fn(async () => undefined)
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };

        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn(() => true),
            delete: vi.fn(async () => undefined)
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };

        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            notifyOverlayTopologyChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn(() => false),
            delete: vi.fn(async () => undefined),
            ensureAllGroupsConnected: vi.fn(async () => undefined)
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };

        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
        const manager = {
            notifyClientPresenceChanged: vi.fn(async () => undefined),
            notifyOverlayTopologyChanged: vi.fn(async () => undefined),
            acceptGroupUpdate: vi.fn(async () => undefined),
            has: vi.fn((input) => input === group.group),
            delete: vi.fn(async () => undefined)
        };
        const clientData: ClientInfo = {
            clientId: 'alice',
            sessionId: 'session-a',
            isOnline: true
        };
        const listener = vi.fn();
        const unsubscribe = browserStateCacheLifecycle.onChange(listener);

        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
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
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager as never,
            clientData,
            options: cacheOptions
        });
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
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
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager as never,
            clientData
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

    it('preserves server-planned identity when a browser graph message arrives before acceptance', async () => {
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
                onInboxMessage = callback.onMessage;
                return webSocketQueueBox;
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
            inbox: webSocketQueueBox,
            webRtcGroupManager: manager as never,
            clientData
        });
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: manager as never,
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
        await receive(newALBroadcastMessage(
            'server-a',
            newALEventRoute('graphs', group.group.groupId, 'graph'),
            'room',
            'graphs',
            { version: 4 },
            { groupRef: group.group }
        ));

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
                    onInboxMessage = callback.onMessage;
                    return webSocketQueueBox;
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
                inbox: webSocketQueueBox,
                webRtcGroupManager: manager as never,
                clientData
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
            await expect(receive(withTopologyMessageId(
                newCurrentStateTopologyMessage({
                    deliveryKind: deliveryKind,
                    senderId: 'session-a',
                    group: groupSnapshot,
                    topology: current,
                    resourceId: 'spoofed-current-topology'
                }),
                toCurrentTopologyMessageId(deliveryKind, current)
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
