import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryEntry, GroupDirectoryOrder } from '@shared/api/group-directory/group-directory-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import { BrowserRallarSubscriptionScope, notifyListener } from '../../messages/rallar-listener-delivery.ts';
import type { RallarStateListener, RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import type { BrowserRallarRooms } from '../browser-rallar-rooms.ts';

export namespace RallarRoomDirectory {
    export interface Request {
        readonly kind: GroupDirectoryEntry['kind'];
        readonly q: string;
        readonly limit: number;
        readonly includeEmpty: boolean;
        readonly order: GroupDirectoryOrder;
    }
    export interface State {
        readonly status: 'idle' | 'loading' | 'ready' | 'error';
        readonly entries: readonly GroupDirectoryEntry[];
        readonly error: string | undefined;
    }
    export interface Auth extends Pick<RallarAuthFacade, 'onChange'> {
        session(): AuthSession | undefined;
    }
    export interface Activity {
        isActive(): boolean;
        onChange(listener: () => void): RallarUnsubscribe;
    }
    export interface Dependencies {
        readonly auth: Auth;
        readonly rooms: Pick<BrowserRallarRooms, 'directory'>;
        readonly timers: Timers;
        readonly activity: Activity;
    }
    export interface Browser {
        readonly auth: Pick<RallarAuthFacade, 'onChange'>;
        readonly rooms: Pick<BrowserRallarRooms, 'directory'>;
        session(): AuthSession | undefined;
    }
    export interface Attempt {
        readonly generation: number;
        readonly sessionKey: string;
        readonly request: Request;
        readonly controller: AbortController;
    }
    export interface Config {
        readonly scope: StateScope;
        readonly request: Request;
        readonly refreshIntervalMs: number;
        readonly timeoutMs: number;
        readonly maxAttempts: number;
    }
}

export class RallarRoomDirectory {
    private readonly dependencies: RallarRoomDirectory.Dependencies;
    private readonly config: RallarRoomDirectory.Config;
    private request: RallarRoomDirectory.Request;
    private state: RallarRoomDirectory.State = { status: 'idle', entries: [], error: undefined };
    private settledState = this.state;
    private readonly listeners = new Set<RallarStateListener<RallarRoomDirectory.State>>();
    private readonly flights = new SingleFlight<number, void>();
    private subscriptions: BrowserRallarSubscriptionScope | undefined;
    private stopRepeating: (() => void) | undefined;
    private controller: AbortController | undefined;
    private generation = 0;
    private sessionKey: string | undefined;
    private pageActive = false;

    public static createBrowser(
        browser: RallarRoomDirectory.Browser,
        config: RallarRoomDirectory.Config
    ): RallarRoomDirectory {
        return new RallarRoomDirectory({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            rooms: browser.rooms,
            timers: createDefaultTimers(),
            activity: {
                isActive: () => document.visibilityState === 'visible' && navigator.onLine,
                onChange: (listener) => {
                    document.addEventListener('visibilitychange', listener);
                    window.addEventListener('online', listener);
                    window.addEventListener('offline', listener);
                    return () => {
                        document.removeEventListener('visibilitychange', listener);
                        window.removeEventListener('online', listener);
                        window.removeEventListener('offline', listener);
                    };
                }
            }
        }, config);
    }

    public constructor(dependencies: RallarRoomDirectory.Dependencies, config: RallarRoomDirectory.Config) {
        for (const value of [config.refreshIntervalMs, config.timeoutMs, config.maxAttempts]) {
            if (!Number.isSafeInteger(value) || value <= 0) {
                throw new TypeError('Directory intervals and attempt limits must be positive safe integers');
            }
        }
        this.dependencies = dependencies;
        this.config = config;
        this.request = { ...config.request };
    }

    public getState(): RallarRoomDirectory.State {
        return this.state;
    }

    public onChange(listener: RallarStateListener<RallarRoomDirectory.State>): RallarUnsubscribe {
        this.listeners.add(listener);
        notifyListener(listener, this.state);
        return () => {
            this.listeners.delete(listener);
        };
    }

    public start(): Promise<void> {
        if (this.subscriptions) {
            return this.flights.isInFlight(this.generation) ? this.refresh() : Promise.resolve();
        }
        this.subscriptions = new BrowserRallarSubscriptionScope();
        this.sessionKey = this.resolveSessionKey();
        this.pageActive = this.dependencies.activity.isActive();
        this.subscriptions.add(
            this.dependencies.auth.onChange(() => this.authenticationChanged(), { emitCurrent: false })
        );
        this.subscriptions.add(this.dependencies.activity.onChange(() => this.activityChanged()));
        return this.startAutomatic();
    }

    public stop(): void {
        const subscriptions = this.subscriptions;
        this.subscriptions = undefined;
        subscriptions?.unsubscribe();
        this.invalidate();
        this.settledState = { status: 'idle', entries: [], error: undefined };
        this.publish(this.settledState);
    }

    public async refresh(): Promise<void> {
        this.stopRepeating?.();
        this.stopRepeating = undefined;
        const generation = this.generation;
        await this.readCurrentDirectory();
        this.scheduleAutomatic(generation);
    }

    private readCurrentDirectory(): Promise<void> {
        const sessionKey = this.resolveSessionKey();
        if (!this.subscriptions || sessionKey === undefined || sessionKey !== this.sessionKey) {
            return Promise.resolve();
        }
        return this.flights.run(this.generation, () => {
            const controller = new AbortController();
            this.controller = controller;
            const attempt = { generation: this.generation, sessionKey, request: this.request, controller };
            // Register the flight before publishing loading; listeners may request the same refresh.
            return Promise.resolve().then(() => this.readDirectory(attempt));
        });
    }

    public changeRequest(request: RallarRoomDirectory.Request): Promise<void> {
        if (sameDirectoryRequest(this.request, request)) {
            return Promise.resolve();
        }
        this.request = { ...request };
        return this.restart(true);
    }

    private authenticationChanged(): void {
        const sessionKey = this.resolveSessionKey();
        if (sessionKey !== this.sessionKey) {
            this.sessionKey = sessionKey;
            void this.restart(true);
        }
    }

    private activityChanged(): void {
        const active = this.dependencies.activity.isActive();
        if (active !== this.pageActive) {
            this.pageActive = active;
            void this.restart(false);
        }
    }

    private restart(clear: boolean): Promise<void> {
        this.invalidate();
        const generation = this.generation;
        if (clear) {
            this.settledState = { status: 'idle', entries: [], error: undefined };
        }
        this.publish(this.settledState);
        return this.generation === generation ? this.startAutomatic() : Promise.resolve();
    }

    private invalidate(): void {
        this.generation += 1;
        this.stopRepeating?.();
        this.stopRepeating = undefined;
        this.controller?.abort();
        this.controller = undefined;
    }

    private startAutomatic(): Promise<void> {
        return this.subscriptions && this.pageActive && this.sessionKey !== undefined
            ? this.refresh()
            : Promise.resolve();
    }

    private scheduleAutomatic(generation: number): void {
        if (
            generation !== this.generation || !this.subscriptions || !this.pageActive ||
            this.sessionKey === undefined || this.stopRepeating
        ) {
            return;
        }
        this.stopRepeating = startRepeating({
            timers: this.dependencies.timers,
            intervalMs: this.config.refreshIntervalMs,
            firstRun: 'after-interval',
            run: () => this.readCurrentDirectory()
        });
    }

    private async readDirectory(attempt: RallarRoomDirectory.Attempt): Promise<void> {
        if (!this.current(attempt)) {
            return;
        }
        this.publish({ ...this.settledState, status: 'loading', error: undefined });
        try {
            const entries = await this.readPages(attempt);
            if (entries !== undefined && this.current(attempt)) {
                this.settledState = { status: 'ready', entries, error: undefined };
                this.publish(this.settledState);
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.settledState = { ...this.settledState, status: 'error', error: toError(error).message };
                this.publish(this.settledState);
            }
        }
    }

    private async readPages(attempt: RallarRoomDirectory.Attempt): Promise<readonly GroupDirectoryEntry[] | undefined> {
        const entries = new Map<string, GroupDirectoryEntry>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
            if (!this.current(attempt)) {
                return undefined;
            }
            const page = await this.dependencies.rooms.directory({
                ...attempt.request,
                ...(cursor === null ? {} : { cursor })
            }, {
                scope: this.config.scope,
                signal: attempt.controller.signal,
                timeoutMs: this.config.timeoutMs,
                maxAttempts: this.config.maxAttempts
            });
            if (!this.current(attempt)) {
                return undefined;
            }
            for (const entry of page.entries) {
                const { applicationId, workspaceId, groupId } = entry.groupRef;
                entries.set(JSON.stringify([applicationId, workspaceId, groupId]), entry);
            }
            cursor = page.nextCursor;
            if (cursor !== null) {
                if (cursors.has(cursor)) {
                    throw new Error('Directory returned a repeated continuation cursor');
                }
                cursors.add(cursor);
            }
        }
        while (cursor !== null);
        return [...entries.values()];
    }

    private current(attempt: RallarRoomDirectory.Attempt): boolean {
        return this.subscriptions !== undefined && attempt.generation === this.generation &&
            !attempt.controller.signal.aborted && this.resolveSessionKey() === attempt.sessionKey;
    }

    private resolveSessionKey(): string | undefined {
        const session = this.dependencies.auth.session();
        return session ? toAuthSessionKey(session) : undefined;
    }

    private publish(state: RallarRoomDirectory.State): void {
        this.state = state;
        for (const listener of this.listeners) {
            notifyListener(listener, state);
            if (this.state !== state) {
                return;
            }
        }
    }
}

function sameDirectoryRequest(left: RallarRoomDirectory.Request, right: RallarRoomDirectory.Request): boolean {
    return left.kind === right.kind && left.q === right.q && left.limit === right.limit &&
        left.includeEmpty === right.includeEmpty && left.order === right.order;
}
