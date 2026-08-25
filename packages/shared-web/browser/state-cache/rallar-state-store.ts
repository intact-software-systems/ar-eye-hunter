import type { RallarStateRuntimePort } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import type { ApiMiddleware } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import { notifyListener } from '@shared-web/browser/messages/rallar-listener-delivery.ts';
import type { RallarPeopleState, RallarPerson } from '@shared-web/browser/people/rallar-people-contracts.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import { browserStateCacheLifecycle } from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readActiveClientSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID, type StateScope } from '@shared/api/state-types.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

interface BrowserStateScopeValue extends Pick<StateScope, 'applicationId'> {
    readonly workspaceId?: string;
}

export interface RallarStateCacheReadPort {
    onCacheChange(listener: () => void | Promise<void>): RallarUnsubscribe;
    readGroupSnapshots(): readonly GroupSnapshot[];
    findGroupSnapshotByRef(roomRef: GroupRef): GroupSnapshot | undefined;
    findFirstGroupRefForSession(sessionId: string): GroupRef | undefined;
    readClientSnapshots(): readonly ClientSnapshot[];
    findClientSnapshot(principalId: string): ClientSnapshot | undefined;
}

export interface RallarStateSnapshotAcceptanceInput {
    readonly context: ApiMiddleware;
    readonly clients: readonly ClientSnapshot[];
    readonly groups: readonly GroupSnapshot[];
    readonly scope?: StateScope;
}

export interface RallarStatePort {
    attachCache(): void;
    detachCache(): void;
    acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void>;
    emit(): void;
    onAfterEmit(listener: () => void): RallarUnsubscribe;
    peopleState(): RallarPeopleState;
    person(principalId: string): RallarPerson | undefined;
    onPeopleChange(
        listener: RallarStateListener<RallarPeopleState>,
        options?: RallarOnChangeOptions
    ): RallarUnsubscribe;
}

export function createRallarStateCacheReadPort(): RallarStateCacheReadPort {
    return {
        onCacheChange: (listener) => browserStateCacheLifecycle.onChange(listener),
        readGroupSnapshots: () => groupStateSnapshotsRepository.getAllGroupStateSnapshots(),
        findGroupSnapshotByRef: (roomRef) => groupStateSnapshotsRepository.findGroupStateSnapshotByRef(roomRef),
        findFirstGroupRefForSession: (sessionId) =>
            groupStateSnapshotsRepository.findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId),
        readClientSnapshots: () => clientStateSnapshotsRepository.getAllClientStateSnapshots(),
        findClientSnapshot: (principalId) =>
            clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(principalId)
    };
}

export namespace RallarStateStore {
    export interface Input {
        readonly runtime: RallarStateRuntimePort;
        readonly roomStateStore: RallarRoomStateStorePort;
        readonly readSession: () => AuthSession | undefined;
        readonly stateCache: RallarStateCacheReadPort;
    }
}

export class RallarStateStore implements RallarStatePort {
    readonly #peopleStateListeners = new Set<RallarStateListener<RallarPeopleState>>();
    readonly #afterEmitListeners = new Set<() => void>();
    readonly #input: RallarStateStore.Input;

    constructor(input: RallarStateStore.Input) {
        this.#input = input;
    }

    attachCache(): void {
        if (!this.#input.runtime.readStateCacheUnsubscribe()) {
            this.#input.runtime.setStateCacheUnsubscribe(
                browserStateCacheLifecycle.onChange(() => this.emit())
            );
        }
    }

    detachCache(): void {
        this.#input.runtime.readStateCacheUnsubscribe()?.();
        this.#input.runtime.setStateCacheUnsubscribe(undefined);
    }

    async acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void> {
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: input.context.middleware.webRtcGroupManager,
            clientData: toClientInfo(input.context.session),
            clientSnapshots: input.clients,
            groupSnapshots: input.groups,
            options: { scope: input.scope }
        });
        this.emit();
    }

    emit(): void {
        const roomState = this.#input.roomStateStore.state();
        const peopleState = this.peopleState();
        this.#input.roomStateStore.emit(roomState);
        for (const listener of this.#peopleStateListeners) {
            notifyListener(listener, peopleState);
        }
        for (const listener of this.#afterEmitListeners) {
            listener();
        }
    }

    onAfterEmit(listener: () => void): RallarUnsubscribe {
        this.#afterEmitListeners.add(listener);
        return () => this.#afterEmitListeners.delete(listener);
    }

    peopleState(): RallarPeopleState {
        const clients = this.readClientSnapshots().sort((left, right) =>
            toPersonName(left).localeCompare(toPersonName(right))
        );
        return { people: clients.map(toPerson), clients };
    }

    person(principalId: string): RallarPerson | undefined {
        const snapshot = this.findClientSnapshot(principalId);
        return snapshot ? toPerson(snapshot) : undefined;
    }

    onPeopleChange(
        listener: RallarStateListener<RallarPeopleState>,
        options: RallarOnChangeOptions = {}
    ): RallarUnsubscribe {
        this.#peopleStateListeners.add(listener);
        if (options.emitCurrent ?? true) {
            notifyListener(listener, this.peopleState());
        }
        return () => this.#peopleStateListeners.delete(listener);
    }

    private readClientSnapshots(): ClientSnapshot[] {
        return [...this.#input.stateCache.readClientSnapshots()].filter((snapshot) =>
            this.isInDefaultScope(snapshot.principal)
        );
    }

    private findClientSnapshot(principalId: string): ClientSnapshot | undefined {
        const snapshot = this.#input.stateCache.findClientSnapshot(principalId);
        return snapshot && this.isInDefaultScope(snapshot.principal) ? snapshot : undefined;
    }

    private isInDefaultScope(
        value: BrowserStateScopeValue
    ): boolean {
        return isSameStateScopeValue(value, this.#input.runtime.readDefaultScope());
    }
}

function toClientInfo(session: AuthSession): ClientInfo {
    return {
        clientId: session.clientId,
        sessionId: session.sessionId,
        isOnline: true
    };
}

function toPerson(snapshot: ClientSnapshot): RallarPerson {
    return {
        principalId: snapshot.principal.principalId,
        username: snapshot.principal.username,
        displayName: snapshot.principal.displayName ?? undefined,
        isOnline: snapshot.isOnline,
        activeSessionCount: snapshot.activeSessionCount,
        activeSessionIds: readActiveClientSessionIds(snapshot),
        snapshot
    };
}

function toPersonName(snapshot: ClientSnapshot): string {
    return (
        snapshot.principal.displayName ?? snapshot.principal.username ?? snapshot.principal.principalId
    );
}

function isSameStateScopeValue(
    value: BrowserStateScopeValue,
    scope?: StateScope
): boolean {
    if (!scope) {
        return true;
    }
    return (
        value.applicationId === scope.applicationId &&
        normalizeStateWorkspaceId(value.workspaceId) === normalizeStateWorkspaceId(scope.workspaceId)
    );
}

function normalizeStateWorkspaceId(workspaceId?: string): string {
    return workspaceId ?? DEFAULT_STATE_WORKSPACE_ID;
}
