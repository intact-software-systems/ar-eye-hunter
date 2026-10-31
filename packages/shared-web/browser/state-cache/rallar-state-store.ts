import type { RallarStateRuntimePort } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import type { RallarPeopleState, RallarPerson } from '@shared-web/browser/people/rallar-people-contracts.ts';
import type {
    RallarOnChangeOptions,
    RallarStateListener,
    RallarUnsubscribe
} from '@shared-web/browser/rallar-shared-contracts.ts';
import type { RallarRoomState } from '@shared-web/browser/rooms/rallar-room-contracts.ts';
import type { RallarRoomStateStorePort } from '@shared-web/browser/rooms/room-state-store.ts';
import {
    browserStateCacheLifecycle,
    type BrowserStateCacheLifecycle,
    type StateCacheChangeListener
} from '@shared-web/browser/state-cache/browser-state-cache-lifecycle.ts';
import type { AuthSession, ClientInfo } from '@shared/api/api-config.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import { readActiveClientSessionIds } from '@shared/api/group-client-views.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { readConfiguredValue } from '@shared/cache/RepositoryManager.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import * as clientStateSnapshotsRepository from '@shared/repository/client-state-snapshots-repository.ts';
import * as groupStateSnapshotsRepository from '@shared/repository/group-state-snapshots-repository.ts';

export interface RallarStateCacheReadPort {
    onCacheChange(listener: StateCacheChangeListener): RallarUnsubscribe;
    readGroupSnapshots(): readonly GroupSnapshot[];
    findGroupSnapshotByRef(roomRef: GroupRef): GroupSnapshot | undefined;
    /** Whether the cache ever held the room, which outlives the snapshot's TTL. */
    wasGroupSnapshotObserved(roomRef: GroupRef): boolean;
    findFirstGroupRefForSession(sessionId: string): GroupRef | undefined;
    readClientSnapshots(): readonly ClientSnapshot[];
    findClientSnapshot(principalId: string): ClientSnapshot | undefined;
}

export interface RallarStateSnapshotAcceptanceInput {
    readonly context: {
        readonly session: AuthSession;
        readonly middleware: Pick<BrowserStateCacheLifecycle.HydrateInput, 'webRtcGroupManager'>;
    };
    readonly clients: readonly ClientSnapshot[];
    readonly groups: readonly GroupSnapshot[];
    readonly scope?: StateScope;
    /** Select only after hydration succeeds and the initiating session is still current. */
    readonly currentRoom?: GroupSnapshot;
    readonly assertCurrent?: () => void;
}

export interface RallarStatePort {
    attachCache(): void;
    detachCache(): void;
    acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void>;
    emit(): void;
    /** Same-turn derived observation after room and people delivery; superseded publications stop. */
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
        wasGroupSnapshotObserved: (roomRef) =>
            groupStateSnapshotsRepository.wasGroupStateSnapshotObservedByRef(roomRef),
        findFirstGroupRefForSession: (sessionId) =>
            groupStateSnapshotsRepository.findFirstGroupStateSnapshotRefSessionIdIsIn(sessionId),
        readClientSnapshots: () => clientStateSnapshotsRepository.getAllClientStateSnapshots(),
        findClientSnapshot: (principalId) =>
            clientStateSnapshotsRepository.findClientStateSnapshotByPrincipalId(principalId)
    };
}

export namespace RallarStateStore {
    export interface EmittableState {
        readonly room: RallarRoomState;
        readonly people: RallarPeopleState;
    }

    export interface Input {
        readonly runtime: RallarStateRuntimePort;
        readonly roomStateStore: RallarRoomStateStorePort;
        readonly stateCache: RallarStateCacheReadPort;
    }
}

/** Owns people projection and ordered room, people, then derived publication for one facade. */
export class RallarStateStore implements RallarStatePort {
    private readonly peopleNotifications = new SynchronousNotifications<RallarPeopleState>((error) => {
        console.error('Error notifying Rallar people state listener', error);
    });
    private readonly afterEmitNotifications = new SynchronousNotifications<void>((error) => {
        console.error('Error notifying Rallar derived state listener', error);
    });
    private readonly input: RallarStateStore.Input;

    constructor(input: RallarStateStore.Input) {
        this.input = input;
    }

    attachCache(): void {
        if (!this.input.runtime.readStateCacheUnsubscribe()) {
            this.input.runtime.setStateCacheUnsubscribe(
                browserStateCacheLifecycle.onChange(() => this.emit())
            );
        }
    }

    detachCache(): void {
        this.input.runtime.readStateCacheUnsubscribe()?.();
        this.input.runtime.setStateCacheUnsubscribe(undefined);
    }

    async acceptSnapshots(input: RallarStateSnapshotAcceptanceInput): Promise<void> {
        input.assertCurrent?.();
        await browserStateCacheLifecycle.hydrate({
            webRtcGroupManager: input.context.middleware.webRtcGroupManager,
            clientData: toClientInfo(input.context.session),
            clientSnapshots: input.clients,
            groupSnapshots: input.groups,
            options: { scope: input.scope }
        });
        input.assertCurrent?.();
        if (input.currentRoom) {
            this.input.roomStateStore.setCurrentRoom(input.currentRoom);
        }
        this.emit();
    }

    emit(): void {
        const state = this.readEmittableState();
        if (!state) {
            return;
        }
        if (!this.input.roomStateStore.emit(state.room)) {
            return;
        }
        if (!this.peopleNotifications.publishLatest(state.people)) {
            return;
        }
        this.afterEmitNotifications.publishLatest();
    }

    /**
     * Connect configures the snapshot repositories, so disconnect and logout can
     * both emit before they exist. There is no state to report until then.
     */
    private readEmittableState(): RallarStateStore.EmittableState | undefined {
        return readConfiguredValue(() => ({
            room: this.input.roomStateStore.state(),
            people: this.peopleState()
        }));
    }

    onAfterEmit(listener: () => void): RallarUnsubscribe {
        const subscription = this.afterEmitNotifications.subscribe(listener);
        return () => subscription.unsubscribe();
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
        const current = (options.emitCurrent ?? true)
            ? readConfiguredValue(() => this.peopleState())
            : undefined;
        const subscription = current
            ? this.peopleNotifications.subscribeAndNotify(listener, current)
            : this.peopleNotifications.subscribe(listener);
        return () => subscription.unsubscribe();
    }

    private readClientSnapshots(): ClientSnapshot[] {
        return [...this.input.stateCache.readClientSnapshots()].filter((snapshot) =>
            this.isInDefaultScope(snapshot.principal)
        );
    }

    private findClientSnapshot(principalId: string): ClientSnapshot | undefined {
        const snapshot = this.input.stateCache.findClientSnapshot(principalId);
        return snapshot && this.isInDefaultScope(snapshot.principal) ? snapshot : undefined;
    }

    private isInDefaultScope(value: StateScope): boolean {
        const scope = this.input.runtime.readDefaultScope();
        return !scope || isSameGroupScope(value, scope);
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
