import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, ClientInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { isGroupActive, isSessionInGroup } from '@shared/api/group-client-views.ts';
import { type RallarOverlayTopologySnapshot, toOverlayInfoForSession, } from '@shared/api/overlay-topology.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID, type StateScope, } from '@shared/api/state-types.ts';
import { GraphInfoSnapshot } from '@shared-graph/shared-graph-types.ts';
import * as graphsRepository from '@shared-graph/repository/graphs-repository.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import { WsQueueBoxClientService } from '@shared/services/WsQueueBoxClientService.ts';
import { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';

export type StateCacheChange = Readonly<{
    clients: readonly ClientStateSnapshot[];
    groups: readonly GroupStateSnapshot[];
}>;

export type StateCacheChangeListener = (
    change: StateCacheChange,
) => void | Promise<void>;

export type StateCacheScopeOptions = Readonly<{
    scope?: StateScope;
}>;

const stateCacheChangeListeners = new Set<StateCacheChangeListener>();
const stateRepositoryObserverTasks = new Set<Promise<void>>();
let stateRepositoryObserversUnsubscribe: (() => void) | undefined;
let stateRepositoryObserverContext:
    | Readonly<{
    webRtcGroupManager: WebRtcGroupManager;
    sessionId: string;
    scope: StateScope;
}>
    | undefined;

export function onStateCacheChange(
    listener: StateCacheChangeListener,
): () => void {
    stateCacheChangeListeners.add(listener);
    return () => {
        stateCacheChangeListeners.delete(listener);
    };
}

export function initialise(
    webSocketQueueBox: WsQueueBoxClientService,
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
    options: StateCacheScopeOptions = {},
) {
    const initialScope = resolveStateCacheScope(options);
    installStateRepositoryObservers(webRtcGroupManager, myOwnClientData, initialScope);

    webSocketQueueBox
        .onAllInboxMessagesDo(
            {
                onMessage: async (data: ALMessage) => {
                    switch (data.payload.typeId) {
                        case AppTopics.chat: {
                            console.log(`Received chat message: ${data.payload.resource}`);
                            break;
                        }

                        case AppTopics.rtcSignaling: {
                            const signal = JSON.parse(
                                data.payload.resource,
                            ) as QRtcSignalingMessage;
                            console.log('RTC signaling message :' + JSON.stringify(signal));
                            break;
                        }

                        case AppTopics.clientStateSnapshot: {
                            const scope = readActiveStateCacheScope(initialScope);
                            const clientSnapshot = JSON.parse(
                                data.payload.resource,
                            ) as ClientStateSnapshot;
                            acceptClientStateSnapshots([clientSnapshot], scope);
                            await clientStateSnapshotsRepository
                                .waitForClientStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
                            break;
                        }

                        case AppTopics.groupStateSnapshot: {
                            const scope = readActiveStateCacheScope(initialScope);
                            const groupSnapshot = JSON.parse(
                                data.payload.resource,
                            ) as GroupStateSnapshot;
                            acceptGroupStateSnapshots([groupSnapshot], scope);
                            await groupStateSnapshotsRepository
                                .waitForGroupStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
                            break;
                        }

                        case AppTopics.clientStateEvent:
                        case AppTopics.groupStateEvent: {
                            break;
                        }

                        case AppTopics.graphs: {
                            const graph = JSON.parse(
                                data.payload.resource,
                            ) as GraphInfoSnapshot;

                            console.log(`Received graph info: ${JSON.stringify(graph)}`);

                            const isUpdated = graphsRepository.setGraph(graph);

                            if (isUpdated) {
                                const neighbors = graph.predicted.groupGraph.hasNode(
                                    myOwnClientData.sessionId,
                                )
                                    ? graph.predicted.groupGraph.neighbors(
                                        myOwnClientData.sessionId,
                                    )
                                    : [];

                                overlaysRepository.updateNextHopSessionIds(
                                    toScopedOverlayId(graph.groupRef),
                                    neighbors,
                                );
                            }
                            break;
                        }
                        case AppTopics.overlayTopology: {
                            const topology = JSON.parse(
                                data.payload.resource,
                            ) as RallarOverlayTopologySnapshot;

                            overlaysRepository.setOverlayById(
                                topology.overlayId,
                                toOverlayInfoForSession(
                                    topology,
                                    myOwnClientData.sessionId,
                                ),
                            );
                            await overlaysRepository.waitForOverlayChangesIdle();
                            await webRtcGroupManager.notifyOverlayTopologyChanged();
                            break;
                        }
                        default: {
                            console.warn(`Unhandled WS message: ${data.payload.typeId}`);
                        }
                    }
                },
            },
        );
}

export async function hydrateStateCaches(
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
    clientSnapshots: readonly ClientStateSnapshot[],
    groupSnapshots: readonly GroupStateSnapshot[],
    options: StateCacheScopeOptions = {},
): Promise<void> {
    const scope = resolveStateCacheScope(options);
    installStateRepositoryObservers(webRtcGroupManager, myOwnClientData, scope);
    acceptClientStateSnapshots(clientSnapshots, scope);
    acceptGroupStateSnapshots(groupSnapshots, scope);
    await Promise.all([
        clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
        groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle(),
    ]);
    await waitForStateRepositoryObserverTasks();
}

function acceptClientStateSnapshots(
    snapshots: readonly ClientStateSnapshot[],
    scope: StateScope,
): boolean {
    return clientStateSnapshotsRepository.setClientStateSnapshots(
        snapshots.filter((snapshot) => isClientSnapshotInScope(snapshot, scope)),
    );
}

function acceptGroupStateSnapshots(
    snapshots: readonly GroupStateSnapshot[],
    scope: StateScope,
): boolean {
    return groupStateSnapshotsRepository.setGroupStateSnapshots(
        snapshots.filter((snapshot) => isGroupSnapshotInScope(snapshot, scope)),
    );
}

function installStateRepositoryObservers(
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
    scope: StateScope,
): void {
    if (
        stateRepositoryObserverContext?.webRtcGroupManager === webRtcGroupManager &&
        stateRepositoryObserverContext.sessionId === myOwnClientData.sessionId &&
        isSameStateScope(stateRepositoryObserverContext.scope, scope)
    ) {
        return;
    }

    stateRepositoryObserversUnsubscribe?.();
    stateRepositoryObserverContext = {
        webRtcGroupManager,
        sessionId: myOwnClientData.sessionId,
        scope,
    };

    const unsubscribeClient = clientStateSnapshotsRepository
        .onClientStateSnapshotChange((change) => {
            const snapshot = change.snapshot;
            if (
                change.kind === ObservableValueEventType.Refreshed ||
                change.manager !== undefined ||
                !snapshot
            ) {
                return;
            }

            return trackStateRepositoryObserverTask((async () => {
                await webRtcGroupManager.notifyClientPresenceChanged();
                await notifyStateCacheChange({
                    clients: [snapshot],
                    groups: [],
                });
            })());
        });

    const unsubscribeGroup = groupStateSnapshotsRepository
        .onGroupStateSnapshotChange((change) => {
            const snapshot = change.snapshot ?? change.previous;
            if (
                change.kind === ObservableValueEventType.Refreshed ||
                change.manager !== undefined ||
                !snapshot
            ) {
                return;
            }

            return trackStateRepositoryObserverTask((async () => {
                if (change.kind === ObservableValueEventType.Deleted) {
                    await handleGroupSnapshotRemoval(snapshot, webRtcGroupManager);
                } else {
                    await handleGroupSnapshotUpdate(
                        snapshot,
                        webRtcGroupManager,
                        myOwnClientData.sessionId,
                    );
                }
                await notifyStateCacheChange({
                    clients: [],
                    groups: [snapshot],
                });
            })());
        });

    stateRepositoryObserversUnsubscribe = () => {
        unsubscribeClient();
        unsubscribeGroup();
        if (
            stateRepositoryObserverContext?.webRtcGroupManager === webRtcGroupManager &&
            stateRepositoryObserverContext.sessionId === myOwnClientData.sessionId &&
            isSameStateScope(stateRepositoryObserverContext.scope, scope)
        ) {
            stateRepositoryObserverContext = undefined;
        }
    };
}

async function handleGroupSnapshotUpdate(
    snapshot: GroupStateSnapshot,
    webRtcGroupManager: WebRtcGroupManager,
    mySessionId: string,
): Promise<void> {
    if (!isGroupActive(snapshot)) {
        overlaysRepository.removeOverlayByGroupRef(snapshot.group);
        overlaysRepository.removeLegacyOverlayByGroupIdIfMatches(snapshot.group);

        if (webRtcGroupManager.has(snapshot.group)) {
            await webRtcGroupManager.delete(snapshot.group);
        }
        return;
    }

    overlaysRepository.createAndSetStarOverlays([snapshot]);

    if (isSessionInGroup(snapshot, mySessionId)) {
        await webRtcGroupManager.acceptGroupUpdate(snapshot);
    } else if (webRtcGroupManager.has(snapshot.group)) {
        await webRtcGroupManager.delete(snapshot.group);
    }
}

async function handleGroupSnapshotRemoval(
    snapshot: GroupStateSnapshot,
    webRtcGroupManager: WebRtcGroupManager,
): Promise<void> {
    overlaysRepository.removeOverlayByGroupRef(snapshot.group);
    overlaysRepository.removeLegacyOverlayByGroupIdIfMatches(snapshot.group);

    if (webRtcGroupManager.has(snapshot.group)) {
        await webRtcGroupManager.delete(snapshot.group);
    }
}

function trackStateRepositoryObserverTask(task: Promise<void>): Promise<void> {
    const tracked = task.finally(() => {
        stateRepositoryObserverTasks.delete(tracked);
    });
    stateRepositoryObserverTasks.add(tracked);
    return tracked;
}

async function waitForStateRepositoryObserverTasks(): Promise<void> {
    await Promise.all([...stateRepositoryObserverTasks]);
}

async function notifyStateCacheChange(change: StateCacheChange): Promise<void> {
    await Promise.all(
        [...stateCacheChangeListeners].map(async (listener) => {
            try {
                await listener(change);
            } catch (error) {
                console.error('Error notifying state cache listener', error);
            }
        }),
    );
}

function resolveStateCacheScope(options: StateCacheScopeOptions): StateScope {
    return options.scope ?? {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID,
    };
}

function readActiveStateCacheScope(fallback: StateScope): StateScope {
    return stateRepositoryObserverContext?.scope ?? fallback;
}

function isClientSnapshotInScope(
    snapshot: ClientStateSnapshot,
    scope: StateScope,
): boolean {
    return isSameStateScope(snapshot.principal, scope);
}

function isGroupSnapshotInScope(
    snapshot: GroupStateSnapshot,
    scope: StateScope,
): boolean {
    return isSameStateScope(snapshot.group, scope);
}

function isSameStateScope(
    left: Readonly<{ applicationId: string; workspaceId?: string }>,
    right: Readonly<{ applicationId: string; workspaceId?: string }>,
): boolean {
    return left.applicationId === right.applicationId &&
        (left.workspaceId ?? '') === (right.workspaceId ?? '');
}
