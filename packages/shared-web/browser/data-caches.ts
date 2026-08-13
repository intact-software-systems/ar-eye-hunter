import { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AppTopics, ClientInfo } from '@shared/api/api-config.ts';
import { toScopedOverlayId } from '@shared/api/api-type-utils.ts';
import { type RallarOverlayTopologySnapshot, toOverlayInfoForSession, } from '@shared/api/overlay-topology.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
import {
    parseAuthoritativeClientSnapshot,
    parseAuthoritativeGroupSnapshot,
    parseAuthoritativeOverlayTopologySnapshot,
} from '@shared/api/authoritative-state-validation.ts';
import { DEFAULT_STATE_APPLICATION_ID, DEFAULT_STATE_WORKSPACE_ID, type StateScope, } from '@shared/api/state-types.ts';
import { GraphInfoSnapshot } from '@shared-graph/shared-graph-types.ts';
import * as graphsRepository from '@shared-graph/repository/graphs-repository.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { BootstrapOverlayPolicy } from '@shared/repository/overlay-bootstrap.ts';
import * as overlaysRepository from '@shared/repository/overlays-repository.ts';
import {
    acceptGroupSnapshotRemoval,
    acceptGroupSnapshotUpdate,
    type GroupFormationPolicyInput,
    isSameBootstrapOverlayPolicy,
    resolveBootstrapOverlayPolicy,
} from '@shared/services/group-snapshot-rtc-sync.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { QRtcSignalingMessage } from '@shared/webrtc/QRtcSignalingContracts.ts';

import {
    acceptGroupStateDeltaEnvelope,
    toGroupStateDeltaEnvelope,
} from './state-cache/group-state-delta-application.ts';
import {
    isRtcTopologyCurrentStateMessage,
} from './state-cache/is-rtc-topology-current-state-message.ts';
import {
    acceptClientStateSnapshots,
    acceptGroupStateSnapshotsOrRecompute,
    isSameStateScope,
} from './state-cache/state-cache-snapshot-adoption.ts';

export type StateCacheChange = Readonly<{
    clients: readonly ClientStateSnapshot[];
    groups: readonly GroupStateSnapshot[];
}>;

export type StateCacheChangeListener = (
    change: StateCacheChange,
) => void | Promise<void>;

export type StateCacheGroupFormationOptions = GroupFormationPolicyInput;

export type StateCacheScopeOptions = Readonly<{
    scope?: StateScope;
    rereadGroupSnapshots?: (
        scope: StateScope,
    ) => Promise<readonly GroupStateSnapshot[]>;
    groupFormation?: StateCacheGroupFormationOptions;
}>;

export type StateCacheInboxSource = Readonly<{
    onAllInboxMessagesDo(
        callback: OnMessageCallback,
        forceUpdate?: boolean,
    ): unknown;
}>;

const stateCacheChangeListeners = new Set<StateCacheChangeListener>();
const stateRepositoryObserverTasks = new Set<Promise<void>>();
let stateRepositoryObserversUnsubscribe: (() => void) | undefined;
let stateRepositoryObserverContext:
    | Readonly<{
    webRtcGroupManager: WebRtcGroupManager;
    sessionId: string;
    scope: StateScope;
    bootstrapOverlayPolicy: BootstrapOverlayPolicy;
    rereadGroupSnapshots?: (
        scope: StateScope,
    ) => Promise<readonly GroupStateSnapshot[]>;
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
    webSocketQueueBox: StateCacheInboxSource,
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
    options: StateCacheScopeOptions = {},
) {
    const initialScope = resolveStateCacheScope(options);
    installStateRepositoryObservers(
        webRtcGroupManager,
        myOwnClientData,
        initialScope,
        options,
    );

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
                            const clientSnapshot = parseAuthoritativeClientSnapshot(
                                data.payload.resource,
                                scope,
                            );
                            acceptClientStateSnapshots([clientSnapshot], scope);
                            await clientStateSnapshotsRepository
                                .waitForClientStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
                            break;
                        }

                        case AppTopics.groupStateSnapshot: {
                            const scope = readActiveStateCacheScope(initialScope);
                            const groupSnapshot = parseAuthoritativeGroupSnapshot(
                                data.payload.resource,
                                scope,
                            );
                            await acceptGroupStateSnapshotsOrRecompute(
                                [groupSnapshot],
                                scope,
                                stateRepositoryObserverContext
                                    ?.rereadGroupSnapshots,
                            );
                            await groupStateSnapshotsRepository
                                .waitForGroupStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
                            break;
                        }
                        case AppTopics.groupDirectorySnapshot: {
                            const scope = readActiveStateCacheScope(initialScope);
                            const groupSnapshot = parseAuthoritativeGroupSnapshot(
                                data.payload.resource,
                                scope,
                            );
                            await acceptGroupStateSnapshotsOrRecompute(
                                [groupSnapshot],
                                scope,
                                stateRepositoryObserverContext
                                    ?.rereadGroupSnapshots,
                            );
                            await groupStateSnapshotsRepository
                                .waitForGroupStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
                            break;
                        }

                        case AppTopics.clientStateEvent: {
                            break;
                        }

                        case AppTopics.groupStateEvent: {
                            const scope = readActiveStateCacheScope(initialScope);
                            const envelope = toGroupStateDeltaEnvelope(
                                data.payload.resource,
                                scope,
                            );
                            if (envelope === undefined) {
                                break;
                            }
                            await acceptGroupStateDeltaEnvelope(
                                envelope,
                                scope,
                                stateRepositoryObserverContext
                                    ?.rereadGroupSnapshots,
                            );
                            await groupStateSnapshotsRepository
                                .waitForGroupStateSnapshotChangesIdle();
                            await waitForStateRepositoryObserverTasks();
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
                            const topology = parseAuthoritativeOverlayTopologySnapshot(
                                data.payload.resource,
                                readActiveStateCacheScope(initialScope),
                            );
                            await acceptServerOverlayTopology({
                                topology,
                                sessionId: myOwnClientData.sessionId,
                                webRtcGroupManager,
                                adoption: isRtcTopologyCurrentStateMessage(
                                        data,
                                        topology,
                                        myOwnClientData.sessionId,
                                    )
                                    ? 'current-state'
                                    : 'publication',
                            });
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

export interface AcceptServerOverlayTopologyInput {
    readonly topology: RallarOverlayTopologySnapshot;
    readonly sessionId: string;
    readonly webRtcGroupManager: WebRtcGroupManager;
    // 'current-state' marks a fresh durable current-state read (server hydration/repair
    // push or a REST read-through) and force-adopts over an incomparable server overlay;
    // 'publication' keeps the ordinary monotonic-tuple admission.
    readonly adoption: 'current-state' | 'publication';
}

export async function acceptServerOverlayTopology(
    input: AcceptServerOverlayTopologyInput,
): Promise<void> {
    const overlay = toOverlayInfoForSession(input.topology, input.sessionId);
    if (input.adoption === 'current-state') {
        overlaysRepository.setCurrentServerOverlayById(input.topology.overlayId, overlay);
    } else {
        overlaysRepository.setOverlayById(input.topology.overlayId, overlay);
    }
    await overlaysRepository.waitForOverlayChangesIdle();
    await input.webRtcGroupManager.notifyOverlayTopologyChanged();
}

export async function hydrateStateCaches(
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
    clientSnapshots: readonly ClientStateSnapshot[],
    groupSnapshots: readonly GroupStateSnapshot[],
    options: StateCacheScopeOptions = {},
): Promise<void> {
    const scope = resolveStateCacheScope(options);
    installStateRepositoryObservers(
        webRtcGroupManager,
        myOwnClientData,
        scope,
        options,
    );
    acceptClientStateSnapshots(clientSnapshots, scope);
    await acceptGroupStateSnapshotsOrRecompute(
        groupSnapshots,
        scope,
        options.rereadGroupSnapshots,
    );
    await Promise.all([
        clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
        groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle(),
    ]);
    await waitForStateRepositoryObserverTasks();
}

function installStateRepositoryObservers(
    webRtcGroupManager: WebRtcGroupManager,
    myOwnClientData: ClientInfo,
    scope: StateScope,
    options: StateCacheScopeOptions,
): void {
    const bootstrapOverlayPolicy = resolveBootstrapOverlayPolicy(
        options.groupFormation,
        myOwnClientData.sessionId,
    );
    if (
        stateRepositoryObserverContext?.webRtcGroupManager === webRtcGroupManager &&
        stateRepositoryObserverContext.sessionId === myOwnClientData.sessionId &&
        isSameStateScope(stateRepositoryObserverContext.scope, scope) &&
        isSameBootstrapOverlayPolicy(
            stateRepositoryObserverContext.bootstrapOverlayPolicy,
            bootstrapOverlayPolicy,
        ) &&
        stateRepositoryObserverContext.rereadGroupSnapshots ===
            options.rereadGroupSnapshots
    ) {
        return;
    }

    stateRepositoryObserversUnsubscribe?.();
    stateRepositoryObserverContext = {
        webRtcGroupManager,
        sessionId: myOwnClientData.sessionId,
        scope,
        bootstrapOverlayPolicy,
        rereadGroupSnapshots: options.rereadGroupSnapshots,
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
                    await acceptGroupSnapshotRemoval(snapshot, webRtcGroupManager);
                } else {
                    await acceptGroupSnapshotUpdate(
                        snapshot,
                        webRtcGroupManager,
                        bootstrapOverlayPolicy,
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
