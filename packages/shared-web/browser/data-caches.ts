import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, ClientInfo } from '@shared/api/api-config.ts';
import { isGroupActive, isSessionInGroup, readGroupId, } from '@shared/api/group-client-views.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
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

const stateCacheChangeListeners = new Set<StateCacheChangeListener>();
const stateRepositoryObserverTasks = new Set<Promise<void>>();
let stateRepositoryObserversUnsubscribe: (() => void) | undefined;
let stateRepositoryObserverContext:
    | Readonly<{
    webRtcGroupManager: WebRtcGroupManager;
    sessionId: string;
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
) {
    installStateRepositoryObservers(webRtcGroupManager, myOwnClientData);

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
                            const clientSnapshot = JSON.parse(
                                data.payload.resource,
                            ) as ClientStateSnapshot;
                            acceptClientStateSnapshots([clientSnapshot]);
                            await clientStateSnapshotsRepository
                                .waitForClientStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
                            break;
                        }

                        case AppTopics.groupStateSnapshot: {
                            const groupSnapshot = JSON.parse(
                                data.payload.resource,
                            ) as GroupStateSnapshot;
                            acceptGroupStateSnapshots([groupSnapshot]);
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

                            const isUpdated = graphsRepository.setGraphById(
                                graph.graphId,
                                graph,
                            );

                            if (isUpdated) {
                                const neighbors = graph.predicted.groupGraph.neighbors(
                                    myOwnClientData.sessionId,
                                );

                                overlaysRepository.updateNextHopSessionIds(
                                    graph.graphId,
                                    neighbors,
                                );
                            }
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
): Promise<void> {
    installStateRepositoryObservers(webRtcGroupManager, myOwnClientData);
    acceptClientStateSnapshots(clientSnapshots);
    acceptGroupStateSnapshots(groupSnapshots);
    await Promise.all([
        clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
        groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle(),
    ]);
    await waitForStateRepositoryObserverTasks();
}

function acceptClientStateSnapshots(
    snapshots: readonly ClientStateSnapshot[],
): boolean {
    return clientStateSnapshotsRepository.setClientStateSnapshots(
        snapshots,
    );
}

function acceptGroupStateSnapshots(
    snapshots: readonly GroupStateSnapshot[],
): boolean {
    return groupStateSnapshotsRepository.setGroupStateSnapshots(
        snapshots,
    );
}

function installStateRepositoryObservers(
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
): void {
    if (
        stateRepositoryObserverContext?.webRtcGroupManager === webRtcGroupManager &&
        stateRepositoryObserverContext.sessionId === myOwnClientData.sessionId
    ) {
        return;
    }

    stateRepositoryObserversUnsubscribe?.();
    stateRepositoryObserverContext = {
        webRtcGroupManager,
        sessionId: myOwnClientData.sessionId,
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
            const snapshot = change.snapshot;
            if (
                change.kind === ObservableValueEventType.Refreshed ||
                change.manager !== undefined ||
                !snapshot
            ) {
                return;
            }

            return trackStateRepositoryObserverTask((async () => {
                await handleGroupSnapshotUpdate(
                    snapshot,
                    webRtcGroupManager,
                    myOwnClientData.sessionId,
                );
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
            stateRepositoryObserverContext.sessionId === myOwnClientData.sessionId
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
    const groupId = readGroupId(snapshot);

    if (!isGroupActive(snapshot)) {
        overlaysRepository.removeOverlayById(groupId);

        if (webRtcGroupManager.has(groupId)) {
            await webRtcGroupManager.delete(groupId);
        }
        return;
    }

    overlaysRepository.createAndSetStarOverlays([snapshot]);

    if (isSessionInGroup(snapshot, mySessionId)) {
        await webRtcGroupManager.acceptGroupUpdate(snapshot);
    } else if (webRtcGroupManager.has(groupId)) {
        await webRtcGroupManager.delete(groupId);
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
