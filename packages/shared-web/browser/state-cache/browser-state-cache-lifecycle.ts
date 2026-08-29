import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot as ClientStateSnapshot } from '@shared/api/client-types.ts';
import type { GroupSnapshot as GroupStateSnapshot } from '@shared/api/group-types.ts';
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
    type BootstrapOverlayPolicyInput
} from '@shared/services/group-snapshot-rtc-sync.ts';
import type { OnMessageCallback } from '@shared/services/InboxOutboxContracts.ts';
import { WebRtcGroupManager } from '@shared/services/WebRtcGroupManager.ts';
import { dispatchOverlayTopologyMessage } from './overlay-topology-message-dispatch.ts';
import {
    acceptClientStateSnapshots,
    acceptGroupStateSnapshotsOrRecompute,
    isSameStateScope
} from './state-cache-snapshot-adoption.ts';
import { dispatchStateEventMessage } from './state-event-message-dispatch.ts';
import { dispatchStateSnapshotMessage } from './state-snapshot-message-dispatch.ts';

export interface StateCacheChange {
    readonly clients: readonly ClientStateSnapshot[];
    readonly groups: readonly GroupStateSnapshot[];
}

export type StateCacheChangeListener = (
    change: StateCacheChange
) => void | Promise<void>;

export interface StateCacheScopeOptions {
    readonly scope?: StateScope;
    readonly rereadGroupSnapshots?: (
        scope: StateScope
    ) => Promise<readonly GroupStateSnapshot[]>;
    readonly groupFormation?: BootstrapOverlayPolicyInput;
}

export interface StateCacheInboxSource {
    onAllInboxMessagesDo(
        callback: OnMessageCallback,
        forceUpdate?: boolean
    ): void;
}

export namespace BrowserStateCacheLifecycle {
    export interface InitialiseInput {
        readonly inbox: StateCacheInboxSource;
        readonly webRtcGroupManager: WebRtcGroupManager;
        readonly clientData: ClientInfo;
        readonly options?: StateCacheScopeOptions;
    }

    export interface HydrateInput {
        readonly webRtcGroupManager: WebRtcGroupManager;
        readonly clientData: ClientInfo;
        readonly clientSnapshots: readonly ClientStateSnapshot[];
        readonly groupSnapshots: readonly GroupStateSnapshot[];
        readonly options?: StateCacheScopeOptions;
    }

    export interface ObserverContext {
        readonly webRtcGroupManager: WebRtcGroupManager;
        readonly sessionId: string;
        readonly scope: StateScope;
        readonly bootstrapOverlayPolicy: BootstrapOverlayPolicy;
        readonly rereadGroupSnapshots?: (
            scope: StateScope
        ) => Promise<readonly GroupStateSnapshot[]>;
    }
}

export interface BrowserStateCacheLifecyclePort {
    onChange(listener: StateCacheChangeListener): () => void;
    initialise(input: BrowserStateCacheLifecycle.InitialiseInput): void;
    hydrate(input: BrowserStateCacheLifecycle.HydrateInput): Promise<void>;
}

export class BrowserStateCacheLifecycle implements BrowserStateCacheLifecyclePort {
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
        const {
            clientData: myOwnClientData,
            inbox: webSocketQueueBox,
            webRtcGroupManager
        } = input;
        const options = input.options ?? {};
        const initialScope = resolveStateCacheScope(options);
        this.installStateRepositoryObservers(
            webRtcGroupManager,
            myOwnClientData,
            initialScope,
            options
        );

        webSocketQueueBox.onAllInboxMessagesDo({
            onMessage: async (message: ALMessage) => {
                const scope = this.readActiveStateCacheScope(initialScope);
                const lifecycleDispatch = {
                    message,
                    scope,
                    rereadGroupSnapshots: this.#observerContext?.rereadGroupSnapshots,
                    waitForLifecycleObservers: async () => await this.waitForStateRepositoryObserverTasks()
                };
                if (
                    await dispatchStateSnapshotMessage(lifecycleDispatch) ||
                    await dispatchStateEventMessage(lifecycleDispatch)
                ) {
                    return;
                }
                await dispatchOverlayTopologyMessage({
                    message,
                    scope,
                    sessionId: myOwnClientData.sessionId,
                    webRtcGroupManager
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
        this.installStateRepositoryObservers(
            webRtcGroupManager,
            clientData,
            scope,
            options
        );
        acceptClientStateSnapshots(clientSnapshots, scope);
        await acceptGroupStateSnapshotsOrRecompute(
            groupSnapshots,
            scope,
            options.rereadGroupSnapshots
        );
        await Promise.all([
            clientStateSnapshotsRepository.waitForClientStateSnapshotChangesIdle(),
            groupStateSnapshotsRepository.waitForGroupStateSnapshotChangesIdle()
        ]);
        await this.waitForStateRepositoryObserverTasks();
    }

    private installStateRepositoryObservers(
        webRtcGroupManager: WebRtcGroupManager,
        myOwnClientData: ClientInfo,
        scope: StateScope,
        options: StateCacheScopeOptions
    ): void {
        const bootstrapOverlayPolicy = resolveBootstrapOverlayPolicy(
            options.groupFormation,
            myOwnClientData.sessionId
        );
        if (
            this.hasMatchingObserverContext(
                webRtcGroupManager,
                myOwnClientData.sessionId,
                scope,
                bootstrapOverlayPolicy,
                options.rereadGroupSnapshots
            )
        ) {
            return;
        }

        this.#observersUnsubscribe?.();
        this.#observerContext = {
            webRtcGroupManager,
            sessionId: myOwnClientData.sessionId,
            scope,
            bootstrapOverlayPolicy,
            rereadGroupSnapshots: options.rereadGroupSnapshots
        };

        const unsubscribeClient = this.observeClientStateChanges(webRtcGroupManager);
        const unsubscribeGroup = this.observeGroupStateChanges(
            webRtcGroupManager,
            bootstrapOverlayPolicy
        );

        this.#observersUnsubscribe = () => {
            unsubscribeClient();
            unsubscribeGroup();
            if (
                this.#observerContext?.webRtcGroupManager === webRtcGroupManager &&
                this.#observerContext.sessionId === myOwnClientData.sessionId &&
                isSameStateScope(this.#observerContext.scope, scope)
            ) {
                this.#observerContext = undefined;
            }
        };
    }

    private hasMatchingObserverContext(
        webRtcGroupManager: WebRtcGroupManager,
        sessionId: string,
        scope: StateScope,
        bootstrapOverlayPolicy: BootstrapOverlayPolicy,
        rereadGroupSnapshots: StateCacheScopeOptions['rereadGroupSnapshots']
    ): boolean {
        const context = this.#observerContext;
        return context?.webRtcGroupManager === webRtcGroupManager &&
            context.sessionId === sessionId &&
            isSameStateScope(context.scope, scope) &&
            isSameBootstrapOverlayPolicy(
                context.bootstrapOverlayPolicy,
                bootstrapOverlayPolicy
            ) &&
            context.rereadGroupSnapshots === rereadGroupSnapshots;
    }

    private observeClientStateChanges(
        webRtcGroupManager: WebRtcGroupManager
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

    private observeGroupStateChanges(
        webRtcGroupManager: WebRtcGroupManager,
        bootstrapOverlayPolicy: BootstrapOverlayPolicy
    ): () => void {
        return groupStateSnapshotsRepository.onGroupStateSnapshotChange((change) => {
            const snapshot = change.snapshot ?? change.previous;
            if (
                change.kind === ObservableValueEventType.Refreshed ||
                change.manager !== undefined ||
                !snapshot
            ) {
                return;
            }

            return this.trackStateRepositoryObserverTask((async () => {
                if (change.kind === ObservableValueEventType.Deleted) {
                    await acceptGroupSnapshotRemoval(snapshot, webRtcGroupManager);
                }
                else {
                    await acceptGroupSnapshotUpdate(
                        snapshot,
                        webRtcGroupManager,
                        bootstrapOverlayPolicy
                    );
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
                    console.error('Error notifying state cache listener', error);
                }
            })
        );
    }

    private readActiveStateCacheScope(initialScope: StateScope): StateScope {
        return this.#observerContext?.scope ?? initialScope;
    }
}

function resolveStateCacheScope(options: StateCacheScopeOptions): StateScope {
    return options.scope ?? {
        applicationId: DEFAULT_STATE_APPLICATION_ID,
        workspaceId: DEFAULT_STATE_WORKSPACE_ID
    };
}

export const browserStateCacheLifecycle: BrowserStateCacheLifecyclePort = new BrowserStateCacheLifecycle();
