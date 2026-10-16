import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import { isStateSnapshotTopic } from '@shared/api/state-snapshot-page.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { StateSnapshotAssembly } from '@shared/services/state-snapshot-assembly.ts';
// dprint-ignore
import {
    DEFAULT_STATE_APPLICATION_ID,
    DEFAULT_STATE_WORKSPACE_ID,
    type StateScope
} from '@shared/api/state-types.ts';
import { ObservableValueEventType } from '@shared/cache/RepositoryInterfaces.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';
import type { BootstrapOverlayPolicy } from '@shared/repository/overlay-bootstrap.ts';
import {
    acceptGroupSnapshotRemoval,
    acceptGroupSnapshotUpdate,
    isSameBootstrapOverlayPolicy,
    resolveBootstrapOverlayPolicy,
    type BootstrapOverlayPolicyInput,
    type GroupSnapshotRtcSyncPort
} from '@shared/services/group-snapshot-rtc-sync.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import type { WebRtcGroupManager } from '@shared/services/web-rtc-group-manager.ts';
import { DeferredOverlayTopologies } from './deferred-overlay-topologies.ts';
import { isGroupHeartbeatSnapshotRenewal } from './group-heartbeat-snapshot-adoption.ts';
import { adoptDeferredOverlayTopology, dispatchOverlayTopologyMessage } from './overlay-topology-message-dispatch.ts';
import {
    acceptClientStateSnapshots,
    acceptGroupStateSnapshotsOrRecompute,
    isSameStateScope
} from './state-cache-snapshot-adoption.ts';
import { dispatchStateEventMessage } from './state-event-message-dispatch.ts';
import { dispatchStateSnapshotMessage } from './state-snapshot-message-dispatch.ts';

export interface StateCacheChange {
    readonly clients: readonly ClientSnapshot[];
    readonly groups: readonly GroupSnapshot[];
}

export type StateCacheChangeListener = (
    change: StateCacheChange
) => void | Promise<void>;

export interface StateCacheScopeOptions {
    readonly scope?: StateScope;
    readonly rereadGroupSnapshots?: (
        scope: StateScope
    ) => Promise<readonly GroupSnapshot[]>;
    readonly groupFormation?: BootstrapOverlayPolicyInput;
}

export interface StateCacheInboxSource {
    onAllInboxMessagesDo(
        callback: OnMessageCallback,
        forceUpdate?: boolean
    ): void;
}

export interface BrowserStateCacheLifecyclePort {
    cancelSnapshotAssemblies(): void;
    onChange(listener: StateCacheChangeListener): () => void;
    initialise(input: BrowserStateCacheLifecycle.InitialiseInput): void;
    hydrate(input: BrowserStateCacheLifecycle.HydrateInput): Promise<void>;
}

export namespace BrowserStateCacheLifecycle {
    export interface RtcGroupPort
        extends
            GroupSnapshotRtcSyncPort,
            Pick<WebRtcGroupManager, 'notifyClientPresenceChanged' | 'notifyOverlayTopologyChanged'> {}

    export interface InitialiseInput {
        readonly inbox: StateCacheInboxSource;
        readonly webRtcGroupManager: RtcGroupPort;
        readonly clientData: ClientInfo;
        readonly options?: StateCacheScopeOptions;
    }

    export interface HydrateInput {
        readonly webRtcGroupManager: RtcGroupPort;
        readonly clientData: ClientInfo;
        readonly clientSnapshots: readonly ClientSnapshot[];
        readonly groupSnapshots: readonly GroupSnapshot[];
        readonly options?: StateCacheScopeOptions;
    }

    export interface ObserverContext {
        readonly webRtcGroupManager: RtcGroupPort;
        readonly sessionId: string;
        readonly scope: StateScope;
        readonly bootstrapOverlayPolicy: BootstrapOverlayPolicy;
        readonly rereadGroupSnapshots?: (
            scope: StateScope
        ) => Promise<readonly GroupSnapshot[]>;
    }
}

export class BrowserStateCacheLifecycle implements BrowserStateCacheLifecyclePort {
    readonly #snapshotAssembly = new StateSnapshotAssembly();
    readonly #deferredOverlayTopologies = new DeferredOverlayTopologies();

    cancelSnapshotAssemblies(): void {
        this.#snapshotAssembly.clear();
    }
    readonly #changeListeners = new Set<StateCacheChangeListener>();
    readonly #observerTasks = new Set<Promise<void>>();
    #observersUnsubscribe: (() => void) | undefined;
    #observerContext: BrowserStateCacheLifecycle.ObserverContext | undefined;

    onChange(listener: StateCacheChangeListener): () => void {
        this.#changeListeners.add(listener);
        return () => {
            this.#changeListeners.delete(listener);
        };
    }

    initialise(input: BrowserStateCacheLifecycle.InitialiseInput): void {
        this.cancelSnapshotAssemblies();
        const {
            clientData: myOwnClientData,
            inbox: webSocketQueueBox,
            webRtcGroupManager
        } = input;
        const options = input.options ?? {};
        const initialScope = resolveStateCacheScope(options);
        this.installStateRepositoryObservers({
            webRtcGroupManager,
            sessionId: myOwnClientData.sessionId,
            scope: initialScope,
            bootstrapOverlayPolicy: resolveBootstrapOverlayPolicy(options.groupFormation, myOwnClientData.sessionId),
            rereadGroupSnapshots: options.rereadGroupSnapshots
        });

        webSocketQueueBox.onAllInboxMessagesDo({
            onMessage: async (message: ALMessage) => {
                const scope = this.readActiveStateCacheScope(initialScope);
                const lifecycleDispatch = {
                    scope,
                    rereadGroupSnapshots: this.#observerContext?.rereadGroupSnapshots,
                    waitForLifecycleObservers: async () => await this.waitForStateRepositoryObserverTasks()
                };
                if (!isStateSnapshotTopic(message.payload.typeId)) {
                    await dispatchStateEventMessage({ ...lifecycleDispatch, message });
                    return;
                }
                const result = this.#snapshotAssembly.accept({ message, scope, nowMs: Date.now() });
                if (result.left) {
                    throw new TypeError(result.left.message);
                }
                if (result.right!.kind !== 'complete') {
                    return;
                }
                const snapshot = result.right!.snapshot;
                if (await dispatchStateSnapshotMessage({ ...lifecycleDispatch, snapshot })) {
                    return;
                }
                await dispatchOverlayTopologyMessage({
                    snapshot,
                    scope,
                    sessionId: myOwnClientData.sessionId,
                    webRtcGroupManager,
                    deferredTopologies: this.#deferredOverlayTopologies
                });
            }
        });
    }

    async hydrate(input: BrowserStateCacheLifecycle.HydrateInput): Promise<void> {
        const {
            clientData,
            clientSnapshots,
            groupSnapshots,
            webRtcGroupManager
        } = input;
        const options = input.options ?? {};
        const scope = resolveStateCacheScope(options);
        this.installStateRepositoryObservers({
            webRtcGroupManager,
            sessionId: clientData.sessionId,
            scope,
            bootstrapOverlayPolicy: resolveBootstrapOverlayPolicy(options.groupFormation, clientData.sessionId),
            rereadGroupSnapshots: options.rereadGroupSnapshots
        });
        acceptClientStateSnapshots(clientSnapshots, scope);
        await acceptGroupStateSnapshotsOrRecompute(
            groupSnapshots,
            scope,
            { rereadGroupSnapshots: options.rereadGroupSnapshots }
        );
        await Promise.all([
            clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
            groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle()
        ]);
        await this.waitForStateRepositoryObserverTasks();
    }

    private installStateRepositoryObservers(
        next: BrowserStateCacheLifecycle.ObserverContext
    ): void {
        const { webRtcGroupManager } = next;
        if (this.hasMatchingObserverContext(next)) {
            return;
        }

        // Transfers in flight and held layouts belong to the connection, not to the observer options a room refresh may change.
        if (this.#observerContext === undefined || !isSameObserverConnection(this.#observerContext, next)) {
            this.cancelSnapshotAssemblies();
            this.#deferredOverlayTopologies.clear();
        }
        this.#observersUnsubscribe?.();
        this.#observerContext = next;

        const unsubscribeClient = this.observeClientStateChanges(webRtcGroupManager);
        const unsubscribeGroup = this.observeGroupStateChanges(next);

        this.#observersUnsubscribe = () => {
            unsubscribeClient();
            unsubscribeGroup();
            if (this.#observerContext !== undefined && isSameObserverConnection(this.#observerContext, next)) {
                this.#observerContext = undefined;
            }
        };
    }

    private hasMatchingObserverContext(
        next: BrowserStateCacheLifecycle.ObserverContext
    ): boolean {
        const context = this.#observerContext;
        return context !== undefined &&
            isSameObserverConnection(context, next) &&
            isSameBootstrapOverlayPolicy(
                context.bootstrapOverlayPolicy,
                next.bootstrapOverlayPolicy
            ) &&
            context.rereadGroupSnapshots === next.rereadGroupSnapshots;
    }

    private observeClientStateChanges(
        webRtcGroupManager: Pick<BrowserStateCacheLifecycle.RtcGroupPort, 'notifyClientPresenceChanged'>
    ): () => void {
        return clientStateSnapshotsRepository.onClientStateSnapshotChange((change) => {
            const snapshot = change.snapshot;
            if (
                change.kind === ObservableValueEventType.Refreshed ||
                change.manager !== undefined ||
                !snapshot
            ) {
                return;
            }

            return this.trackStateRepositoryObserverTask((async () => {
                await webRtcGroupManager.notifyClientPresenceChanged();
                await this.notifyStateCacheChange({ clients: [snapshot], groups: [] });
            })());
        });
    }

    private observeGroupStateChanges(context: BrowserStateCacheLifecycle.ObserverContext): () => void {
        const { webRtcGroupManager, sessionId, bootstrapOverlayPolicy } = context;
        return groupStateSnapshotsRepository.onGroupStateSnapshotChange((change) => {
            const snapshot = change.snapshot ?? change.previous;
            if (
                change.kind === ObservableValueEventType.Refreshed ||
                (
                    change.previous !== undefined &&
                    change.snapshot !== undefined &&
                    change.previous.activeSessions.length === change.snapshot.activeSessions.length &&
                    isGroupHeartbeatSnapshotRenewal(change.previous, change.snapshot)
                ) ||
                change.manager !== undefined ||
                !snapshot
            ) {
                return;
            }

            return this.trackStateRepositoryObserverTask((async () => {
                if (change.kind === ObservableValueEventType.Deleted) {
                    this.#deferredOverlayTopologies.discard(snapshot.group);
                    await acceptGroupSnapshotRemoval(snapshot, webRtcGroupManager);
                }
                else {
                    await acceptGroupSnapshotUpdate(
                        snapshot,
                        webRtcGroupManager,
                        bootstrapOverlayPolicy
                    );
                    await adoptDeferredOverlayTopology({
                        groupRef: snapshot.group,
                        sessionId,
                        webRtcGroupManager,
                        deferredTopologies: this.#deferredOverlayTopologies
                    });
                }
                await this.notifyStateCacheChange({ clients: [], groups: [snapshot] });
            })());
        });
    }

    private trackStateRepositoryObserverTask(task: Promise<void>): Promise<void> {
        const tracked = task.finally(() => {
            this.#observerTasks.delete(tracked);
        });
        this.#observerTasks.add(tracked);
        return tracked;
    }

    private async waitForStateRepositoryObserverTasks(): Promise<void> {
        await Promise.all([...this.#observerTasks]);
    }

    private async notifyStateCacheChange(change: StateCacheChange): Promise<void> {
        await Promise.all(
            [...this.#changeListeners].map(async (listener) => {
                try {
                    await listener(change);
                }
                catch (error) {
                    console.error(
                        'Error notifying state cache listener',
                        toError(error)
                    );
                }
            })
        );
    }

    private readActiveStateCacheScope(initialScope: StateScope): StateScope {
        return this.#observerContext?.scope ?? initialScope;
    }
}

function isSameObserverConnection(
    left: BrowserStateCacheLifecycle.ObserverContext,
    right: BrowserStateCacheLifecycle.ObserverContext
): boolean {
    return left.webRtcGroupManager === right.webRtcGroupManager &&
        left.sessionId === right.sessionId &&
        isSameStateScope(left.scope, right.scope);
}

function resolveStateCacheScope(options: StateCacheScopeOptions): StateScope {
    return options.scope ?? {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID
    };
}

export const browserStateCacheLifecycle: BrowserStateCacheLifecyclePort = new BrowserStateCacheLifecycle();
