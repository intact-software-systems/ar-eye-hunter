import type { AuthSession } from '@shared/api/api-config.ts';
import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';
import {
    type TournamentCatalogEntry,
    type TournamentCatalogPage,
    type TournamentCatalogView
} from '@shared/api/tournaments/tournament-catalog.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { startRepeating } from '@shared/resilience/timing/start-repeating.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ApiHttpError } from '../api/http-error.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { readTournamentCatalogRange } from './read-tournament-catalog-range.ts';
import { tournamentCatalogHttpApi } from './tournament-catalog-http-api.ts';

export namespace RallarTournamentCatalog {
    export interface State {
        readonly view: TournamentCatalogView;
        readonly status: 'signed-out' | 'loading' | 'ready' | 'error';
        readonly entries: readonly TournamentCatalogEntry[];
        readonly nextCursor: string | null;
        readonly stale: boolean;
        readonly paused: boolean;
        readonly error: string | null;
    }
    export interface ReadInput {
        readonly scope: StateScope;
        readonly session: AuthSession;
        readonly view: TournamentCatalogView;
        readonly limit: number;
        readonly cursor: string | null;
        readonly signal: AbortSignal;
        readonly timeoutMs: number;
    }
    export interface Api {
        read(input: ReadInput): Promise<TournamentCatalogPage>;
    }
    export interface Dependencies {
        readonly auth: RallarRoomEntry.Auth;
        readonly activity: Pick<BrowserActivity, 'isActive' | 'onChange'>;
        readonly timers: Timers;
        readonly api: Api;
    }
    export interface Config {
        readonly scope: StateScope;
        readonly limit: number;
        readonly refreshIntervalMs: number;
        readonly timeoutMs: number;
    }
}

/** One account's loaded catalogue range; previewing never grants participation or changes rooms. */
export class RallarTournamentCatalog {
    private readonly dependencies: RallarTournamentCatalog.Dependencies;
    private readonly config: RallarTournamentCatalog.Config;
    private readonly notifications = new SynchronousNotifications<RallarTournamentCatalog.State>((error) =>
        console.error('Tournament catalogue listener failed', error)
    );
    private readonly flights = new SingleFlight<number, void>();
    private state: RallarTournamentCatalog.State = {
        view: 'public',
        status: 'signed-out',
        entries: [],
        nextCursor: null,
        stale: false,
        paused: false,
        error: null
    };
    private subscriptions: SubscriptionScope | null = null;
    private controller = new AbortController();
    private stopRepeating: (() => void) | null = null;
    private generation = 0;
    private pages = 0;
    private sessionKey: string | null = null;
    private operation: 'append' | 'refresh' | null = null;

    static createBrowser(
        browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>,
        config: RallarTournamentCatalog.Config
    ): RallarTournamentCatalog {
        return new RallarTournamentCatalog({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            api: tournamentCatalogHttpApi
        }, config);
    }

    constructor(dependencies: RallarTournamentCatalog.Dependencies, config: RallarTournamentCatalog.Config) {
        decodeStateScope(config.scope);
        if (
            [config.limit, config.refreshIntervalMs, config.timeoutMs].some((value) =>
                !Number.isSafeInteger(value) || value <= 0
            ) || config.limit > 50
        ) {
            throw new TypeError('Tournament catalogue bounds are invalid');
        }
        this.dependencies = dependencies;
        this.config = config;
    }
    getState(): RallarTournamentCatalog.State {
        return this.state;
    }
    onChange(listener: (state: RallarTournamentCatalog.State) => void): () => void {
        return this.notifications.subscribeAndNotify(listener, this.state).unsubscribe;
    }
    start(): Promise<void> {
        if (this.subscriptions === null) {
            this.subscriptions = new SubscriptionScope();
            this.sessionKey = this.authKey();
            this.subscriptions.add(
                this.dependencies.auth.onChange(() => this.authenticationChanged(), { emitCurrent: false })
            );
            this.subscriptions.add(this.dependencies.activity.onChange(() => this.activityChanged()));
        }
        return this.refresh();
    }
    stop(): void {
        const subscriptions = this.subscriptions;
        this.subscriptions = null;
        try {
            subscriptions?.unsubscribe();
        }
        finally {
            this.reset(true);
        }
    }
    async refresh(): Promise<void> {
        if (this.operation === 'append') {
            this.reset(false);
        }
        this.stopRepeating?.();
        this.stopRepeating = null;
        const generation = this.generation;
        await this.readRange(false);
        if (generation === this.generation) {
            this.scheduleAutomatic();
        }
    }
    async loadMore(): Promise<void> {
        if (this.state.nextCursor === null) {
            return;
        }
        this.stopRepeating?.();
        this.stopRepeating = null;
        const generation = this.generation;
        await this.readRange(true);
        if (generation === this.generation) {
            this.scheduleAutomatic();
        }
    }
    changeView(view: TournamentCatalogView): Promise<void> {
        if (view === this.state.view) {
            return Promise.resolve();
        }
        if (view !== 'public' && view !== 'mine') {
            throw new TypeError('Invalid tournament catalogue view');
        }
        this.reset(true);
        this.publish({ ...this.state, view });
        return this.refresh();
    }
    private authenticationChanged(): void {
        const key = this.authKey();
        if (key !== this.sessionKey) {
            this.sessionKey = key;
            this.reset(true);
            void this.refresh();
        }
    }
    private activityChanged(): void {
        this.reset(false);
        if (this.dependencies.activity.isActive()) {
            void this.refresh();
        }
    }
    private reset(clear: boolean): void {
        this.operation = null;
        this.generation++;
        this.controller.abort();
        this.controller = new AbortController();
        this.stopRepeating?.();
        this.stopRepeating = null;
        if (clear) {
            this.pages = 0;
        }
        this.publish({
            ...this.state,
            status: this.authKey() === null ? 'signed-out' : 'ready',
            entries: clear ? [] : this.state.entries,
            nextCursor: clear ? null : this.state.nextCursor,
            stale: !clear && this.pages > 0,
            paused: !this.dependencies.activity.isActive(),
            error: null
        });
    }
    private scheduleAutomatic(): void {
        if (
            this.subscriptions === null || this.authKey() === null || !this.dependencies.activity.isActive() ||
            this.stopRepeating !== null
        ) {
            return;
        }
        this.stopRepeating = startRepeating({
            timers: this.dependencies.timers,
            intervalMs: this.config.refreshIntervalMs,
            firstRun: 'after-interval',
            run: () => this.readRange(false)
        });
    }
    private readRange(append: boolean): Promise<void> {
        const session = this.dependencies.auth.session();
        if (this.subscriptions === null || session === undefined || !this.dependencies.activity.isActive()) {
            return Promise.resolve();
        }
        const generation = this.generation;
        return this.flights.run(generation, () => this.readPages(session, append, generation));
    }
    private async readPages(session: AuthSession, append: boolean, generation: number): Promise<void> {
        const view = this.state.view;
        const previousStale = this.state.stale;
        this.operation = append ? 'append' : 'refresh';
        this.publish({ ...this.state, status: 'loading', error: null, stale: this.pages > 0, paused: false });
        try {
            const range = await readTournamentCatalogRange({
                api: this.dependencies.api,
                request: {
                    ...this.config,
                    session,
                    view,
                    cursor: append ? this.state.nextCursor : null,
                    signal: this.controller.signal
                },
                pagesToRead: append ? 1 : Math.max(1, this.pages),
                entries: append ? this.state.entries : []
            });
            if (!this.current(session, generation)) {
                return;
            }
            this.pages = (append ? this.pages : 0) + range.pages;
            this.publish({
                view,
                status: 'ready',
                entries: range.entries,
                nextCursor: range.nextCursor,
                stale: append && previousStale,
                paused: false,
                error: null
            });
        }
        catch (caught) {
            if (this.current(session, generation)) {
                const error = toError(caught);
                if (error instanceof ApiHttpError && (error.status === 401 || error.status === 403)) {
                    this.reset(true);
                }
                this.publish({ ...this.state, status: 'error', stale: this.pages > 0, error: error.message });
            }
        }
        finally {
            if (generation === this.generation) {
                this.operation = null;
            }
        }
    }
    private current(session: AuthSession, generation: number): boolean {
        return this.subscriptions !== null && generation === this.generation &&
            this.authKey() === toAuthSessionKey(session) && !this.controller.signal.aborted;
    }
    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }
    private publish(state: RallarTournamentCatalog.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
