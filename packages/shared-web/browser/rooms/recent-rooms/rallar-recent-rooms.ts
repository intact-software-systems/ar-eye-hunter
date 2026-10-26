import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { BoundedConcurrencyAdmission } from '@shared/resilience/bounded-concurrency-admission.ts';

import { BrowserRallarSubscriptionScope } from '../../messages/rallar-listener-delivery.ts';
import type { RallarDataFacade, RallarDataStore } from '../../rallar-data.ts';
import type { RallarStateListener, RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import type { RallarRoomEntry } from '../entry/rallar-room-entry.ts';
import { computeRecentRoomHistory, decodeRecentRoomHistory } from './recent-room-history.ts';

const HISTORY_KEY = 'history';
const STORAGE_FAILURE = 'Could not load or save recent rooms on this device. Retry when local storage is available.';

export namespace RallarRecentRooms {
    export interface Visit {
        readonly roomRef: GroupRef;
        readonly visitedAtEpochMs: number;
    }

    export interface History {
        readonly rooms: readonly Visit[];
    }

    export type Edit =
        | { readonly kind: 'visit'; readonly visit: Visit; }
        | { readonly kind: 'forget'; readonly roomRef: GroupRef; };

    export interface State extends History {
        readonly principalId: string | null;
        readonly status: 'signed-out' | 'loading' | 'ready' | 'failed';
        readonly failure: string | null;
    }

    export interface Dependencies {
        readonly auth: RallarRoomEntry.Auth;
        readonly entry: Pick<RallarRoomEntry, 'getState' | 'onChange'>;
        readonly data: Pick<RallarDataFacade, 'open'>;
        now(): number;
    }

    export interface Config {
        readonly scope: StateScope;
    }

    export interface Browser {
        readonly auth: Pick<RallarAuthFacade, 'onChange'>;
        readonly data: Pick<RallarDataFacade, 'open'>;
        session(): AuthSession | undefined;
    }
}

/** Owns local navigation history; every return still goes through RallarRoomEntry admission. */
export class RallarRecentRooms {
    private state: RallarRecentRooms.State = { principalId: null, rooms: [], status: 'signed-out', failure: null };
    private readonly dependencies: RallarRecentRooms.Dependencies;
    private readonly scope: StateScope;
    private readonly notifications = new SynchronousNotifications<RallarRecentRooms.State>((error) => {
        console.error('Error notifying recent rooms listener', error);
    });
    private subscriptions: BrowserRallarSubscriptionScope | null = null;
    private store: RallarDataStore<RallarRecentRooms.History> | null = null;
    private storeSubscription: RallarUnsubscribe | null = null;
    private lastEntry: RallarRoomEntry.State | null = null;
    private generation = 0;
    // Serializes store ownership changes with local edits; a stale close cannot dispose a restarted store.
    private readonly storageAdmission = new BoundedConcurrencyAdmission({ maxConcurrent: 1 });
    private latestOperation: Promise<void> = Promise.resolve();

    public static createBrowser(
        rallar: RallarRecentRooms.Browser,
        entry: RallarRoomEntry,
        config: RallarRecentRooms.Config
    ): RallarRecentRooms {
        return new RallarRecentRooms({
            auth: {
                session: () => rallar.session(),
                onChange: (listener, options) => rallar.auth.onChange(listener, options)
            },
            data: rallar.data,
            entry,
            now: () => Date.now()
        }, config);
    }

    public constructor(dependencies: RallarRecentRooms.Dependencies, config: RallarRecentRooms.Config) {
        this.dependencies = dependencies;
        this.scope = config.scope;
    }

    public getState(): RallarRecentRooms.State {
        return this.state;
    }

    public onChange(listener: RallarStateListener<RallarRecentRooms.State>): RallarUnsubscribe {
        return this.notifications.subscribeAndNotify(listener, this.state).unsubscribe;
    }

    public start(): Promise<void> {
        if (this.subscriptions) {
            return this.whenIdle();
        }
        this.subscriptions = new BrowserRallarSubscriptionScope();
        this.subscriptions.add(this.dependencies.auth.onChange(() => {
            const principalId = this.dependencies.auth.session()?.clientId ?? null;
            if (principalId !== this.state.principalId) {
                void this.loadAccount(principalId);
            }
        }, { emitCurrent: false }));
        this.subscriptions.add(this.dependencies.entry.onChange((entry) => this.entryChanged(entry)));
        return this.loadAccount(this.dependencies.auth.session()?.clientId ?? null);
    }

    public stop(): Promise<void> {
        this.generation += 1;
        this.subscriptions?.unsubscribe();
        this.subscriptions = null;
        const stopped = this.enqueue(this.generation, () => this.closeStore());
        this.publish({ principalId: null, rooms: [], status: 'signed-out', failure: null });
        return stopped;
    }

    public retry(): Promise<void> {
        if (!this.subscriptions) {
            return this.whenIdle();
        }
        this.lastEntry = null;
        return this.loadAccount(this.dependencies.auth.session()?.clientId ?? null);
    }

    public async whenIdle(): Promise<void> {
        while (true) {
            const operation = this.latestOperation;
            await operation;
            if (operation === this.latestOperation) {
                return;
            }
        }
    }

    public forget(roomRef: GroupRef, principalId: string): Promise<void> {
        const generation = this.generation;
        if (!this.isCurrent(generation, principalId) || !this.inScope(roomRef)) {
            return this.whenIdle();
        }
        return this.enqueue(generation, async () => {
            if (!this.isCurrent(generation, principalId) || this.state.status !== 'ready') {
                return;
            }
            await this.updateHistory(generation, { kind: 'forget', roomRef });
        });
    }

    private loadAccount(principalId: string | null): Promise<void> {
        const generation = ++this.generation;
        const loaded = this.enqueue(generation, async () => {
            await this.closeStore();
            if (principalId === null || !this.isCurrent(generation, principalId)) {
                return;
            }
            // Capture the principal in the scope before awaiting, rather than resolving a later auth session.
            this.store = await this.dependencies.data.open<RallarRecentRooms.History>(
                `recent-rooms:${JSON.stringify([this.scope.applicationId, this.scope.workspaceId])}`,
                { scope: `principal:${principalId}`, durability: 'write-through', hydrate: 'lazy', sync: true }
            );
            if (!this.isCurrent(generation, principalId)) {
                await this.closeStore();
                return;
            }
            await this.refreshHistory(generation);
            this.storeSubscription = this.store.onChange(() => {
                void this.enqueue(generation, () => this.refreshHistory(generation));
            });
            this.entryChanged(this.dependencies.entry.getState());
        });
        this.publish({
            principalId,
            rooms: [],
            status: principalId === null ? 'signed-out' : 'loading',
            failure: null
        });
        return loaded;
    }

    private entryChanged(entry: RallarRoomEntry.State): void {
        if (entry.status !== 'entered') {
            this.lastEntry = null;
            return;
        }
        const principalId = entry.principalId;
        const roomRef = entry.destination?.roomRef;
        if (
            entry === this.lastEntry || !principalId || !roomRef || !this.inScope(roomRef) ||
            !this.isCurrent(this.generation, principalId)
        ) {
            return;
        }
        this.lastEntry = entry;
        const generation = this.generation;
        const visit: RallarRecentRooms.Visit = { roomRef, visitedAtEpochMs: this.dependencies.now() };
        void this.enqueue(generation, async () => {
            if (!this.isCurrent(generation, principalId) || this.state.status !== 'ready') {
                return;
            }
            await this.updateHistory(generation, { kind: 'visit', visit });
        });
    }

    private async updateHistory(
        generation: number,
        edit: RallarRecentRooms.Edit
    ): Promise<void> {
        const store = this.store;
        if (!store) {
            return;
        }
        const decoded = decodeRecentRoomHistory(await store.get(HISTORY_KEY), this.scope);
        if (decoded.left) {
            this.fail(generation, decoded.left);
            return;
        }
        if (generation !== this.generation || !decoded.right) {
            return;
        }
        const next = computeRecentRoomHistory(decoded.right, edit);
        const validated = decodeRecentRoomHistory(next, this.scope);
        if (validated.left) {
            this.fail(generation, validated.left);
            return;
        }
        await store.set(HISTORY_KEY, next);
        if (generation === this.generation) {
            this.publish({ ...this.state, rooms: next.rooms, status: 'ready', failure: null });
        }
    }

    private async refreshHistory(generation: number): Promise<void> {
        if (generation !== this.generation || !this.store) {
            return;
        }
        const decoded = decodeRecentRoomHistory(await this.store.get(HISTORY_KEY), this.scope);
        if (generation !== this.generation) {
            return;
        }
        if (decoded.left) {
            this.fail(generation, decoded.left);
        }
        else if (decoded.right) {
            this.publish({ ...this.state, rooms: decoded.right.rooms, status: 'ready', failure: null });
        }
    }

    private async closeStore(): Promise<void> {
        this.storeSubscription?.();
        this.storeSubscription = null;
        if (this.store) {
            await this.store.close();
            this.store = null;
        }
    }

    private enqueue(generation: number, operation: () => Promise<void>): Promise<void> {
        const completion = this.storageAdmission.admit(async () => {
            try {
                await operation();
            }
            catch {
                this.fail(generation, STORAGE_FAILURE);
            }
        });
        this.latestOperation = completion;
        return completion;
    }

    private isCurrent(generation: number, principalId: string): boolean {
        return this.subscriptions !== null && generation === this.generation &&
            this.state.principalId === principalId && this.dependencies.auth.session()?.clientId === principalId;
    }

    private inScope(roomRef: GroupRef): boolean {
        return roomRef.applicationId === this.scope.applicationId && roomRef.workspaceId === this.scope.workspaceId;
    }

    private fail(generation: number, failure: string): void {
        if (generation === this.generation) {
            this.publish({ ...this.state, rooms: [], status: 'failed', failure });
        }
    }

    private publish(state: RallarRecentRooms.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
