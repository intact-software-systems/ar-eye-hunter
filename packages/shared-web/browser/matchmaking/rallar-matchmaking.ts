import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type {
    MatchmakingMutationResult,
    MatchmakingRefusal,
    MatchmakingRequest
} from '@shared/api/matchmaking/matchmaking-request.ts';
import { decodeMatchmakingSnapshot, type MatchmakingSnapshot } from '@shared/api/matchmaking/matchmaking-snapshot.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { isDefinitiveApiMutationFailure } from '../api/api-mutation-retry.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { matchmakingHttpApi } from './matchmaking-http-api.ts';

const REFUSAL_MESSAGES: Readonly<Record<MatchmakingRefusal, string>> = {
    unauthorized: 'Sign in again to find players.',
    'search-not-current': 'Your search changed. Review its current state before continuing.',
    'search-capacity': 'Matchmaking is busy. Please try a new search shortly.',
    'search-ended': 'This search has ended. Start a new search to find players.'
};

export namespace RallarMatchmaking {
    export interface State {
        readonly snapshot: MatchmakingSnapshot | null;
        readonly busy: boolean;
        readonly retryPending: boolean;
        readonly error: string | null;
    }
    export interface ReadInput {
        readonly scope: StateScope;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
    export interface ChangeInput extends ReadInput {
        readonly request: MatchmakingRequest;
        readonly requestId: string;
    }
    export interface Api {
        read(input: ReadInput): Promise<MatchmakingSnapshot>;
        change(input: ChangeInput): Promise<MatchmakingMutationResult>;
    }
    export interface Dependencies {
        readonly auth: RallarRoomEntry.Auth;
        readonly api: Api;
        readonly entry: Pick<RallarRoomEntry, 'enter'>;
        readonly activity: Pick<BrowserActivity, 'isActive' | 'onChange'>;
        readonly timers: Timers;
        readonly createId: () => string;
    }
    export interface Config {
        readonly scope: StateScope;
        readonly refreshIntervalMs: number;
    }
    export interface Pending {
        readonly request: MatchmakingRequest;
        readonly requestId: string;
    }
}

/** Owns search consent and recovery; RoomEntry and each game retain entry and gameplay authority. */
export class RallarMatchmaking {
    private readonly dependencies: RallarMatchmaking.Dependencies;
    private readonly config: RallarMatchmaking.Config;
    private readonly notifications = new SynchronousNotifications<RallarMatchmaking.State>((error) =>
        console.error('Matchmaking listener failed', error)
    );
    private readonly reads = new SingleFlight<number, void>();
    private subscriptions: SubscriptionScope | null = null;
    private controller = new AbortController();
    private revision = 0;
    private sessionKey: string | null = null;
    private pending: RallarMatchmaking.Pending | null = null;
    private state: RallarMatchmaking.State = { snapshot: null, busy: false, retryPending: false, error: null };

    static createBrowser(
        browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>,
        entry: RallarRoomEntry,
        config: RallarMatchmaking.Config
    ): RallarMatchmaking {
        return new RallarMatchmaking({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            api: matchmakingHttpApi,
            entry,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarMatchmaking.Dependencies, config: RallarMatchmaking.Config) {
        if (!Number.isSafeInteger(config.refreshIntervalMs) || config.refreshIntervalMs <= 0) {
            throw new TypeError('Matchmaking refresh interval must be a positive integer');
        }
        this.dependencies = dependencies;
        this.config = config;
    }

    getState(): RallarMatchmaking.State {
        return this.state;
    }

    onChange(listener: (state: RallarMatchmaking.State) => void): () => void {
        return this.notifications.subscribeAndNotify(listener, this.state).unsubscribe;
    }

    start(): Promise<void> {
        if (this.subscriptions === null) {
            this.subscriptions = new SubscriptionScope();
            this.sessionKey = this.authKey();
            this.subscriptions.add(
                this.dependencies.auth.onChange(() => this.authenticationChanged(), { emitCurrent: false })
            );
            this.subscriptions.add(this.dependencies.activity.onChange(() => {
                if (this.dependencies.activity.isActive()) {
                    void this.refresh();
                }
            }));
            this.subscriptions.add(startRepeating({
                timers: this.dependencies.timers,
                intervalMs: this.config.refreshIntervalMs,
                firstRun: 'after-interval',
                run: () => this.dependencies.activity.isActive() ? this.refresh() : Promise.resolve()
            }));
        }
        return this.dependencies.activity.isActive() ? this.refresh() : Promise.resolve();
    }

    stop(): void {
        const subscriptions = this.subscriptions;
        this.subscriptions = null;
        try {
            subscriptions?.unsubscribe();
        }
        finally {
            this.invalidate();
        }
    }

    refresh(): Promise<void> {
        const attempt = this.attempt();
        const revision = this.revision;
        return attempt === null
            ? Promise.resolve()
            : this.reads.run(revision, () => this.readCurrent(attempt, revision));
    }

    find(): Promise<void> {
        const state = this.state.snapshot?.state;
        return state === undefined || state.status === 'searching' || state.status === 'confirming'
            ? Promise.resolve()
            : this.act({ action: 'start', searchId: this.dependencies.createId() });
    }

    confirm(): Promise<void> {
        const state = this.state.snapshot?.state;
        return state?.status === 'confirming'
            ? this.act({ action: 'confirm', searchId: state.searchId })
            : Promise.resolve();
    }

    cancel(): Promise<void> {
        const state = this.state.snapshot?.state;
        return state?.status === 'searching' || state?.status === 'confirming'
            ? this.act({ action: 'cancel', searchId: state.searchId })
            : Promise.resolve();
    }

    retry(): Promise<void> {
        return this.pending === null || this.state.busy ? Promise.resolve() : this.send(this.pending);
    }

    async enter(): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null || this.state.busy || this.pending !== null) {
            return;
        }
        await this.refresh();
        const state = this.state.snapshot?.state;
        if (this.current(attempt) && state?.status === 'matched') {
            this.dependencies.entry.enter({
                intent: 'join',
                roomRef: state.roomRef,
                joinCode: null,
                participation: 'player'
            });
        }
    }

    private act(request: MatchmakingRequest): Promise<void> {
        return this.state.busy || this.pending !== null
            ? Promise.resolve()
            : this.send({ request, requestId: this.dependencies.createId() });
    }

    private async readCurrent(attempt: RallarMatchmaking.ReadInput, revision: number): Promise<void> {
        try {
            const snapshot = decodeMatchmakingSnapshot(await this.dependencies.api.read(attempt));
            if (!this.current(attempt) || revision !== this.revision) {
                return;
            }
            this.assertAccountScope(snapshot, attempt.session);
            this.publish({ ...this.state, snapshot, error: this.pending === null ? null : this.state.error });
        }
        catch (error) {
            if (this.current(attempt) && revision === this.revision) {
                this.publish({ ...this.state, snapshot: null, error: toError(error).message });
            }
        }
    }

    private async send(pending: RallarMatchmaking.Pending): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null) {
            return;
        }
        this.pending = pending;
        this.revision++;
        this.publish({ ...this.state, busy: true, retryPending: false, error: null });
        try {
            const result = await this.dependencies.api.change({ ...attempt, ...pending });
            if (!this.current(attempt)) {
                return;
            }
            this.assertAccountScope(result, attempt.session);
            if (result.requestId !== pending.requestId) {
                throw new TypeError('Matchmaking result belongs to another request');
            }
            this.pending = null;
            this.revision++;
            await this.refresh();
            if (this.current(attempt) && result.code !== null) {
                this.publish({ ...this.state, error: REFUSAL_MESSAGES[result.code] });
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.failPending(toError(error));
            }
        }
        finally {
            if (this.current(attempt)) {
                this.publish({ ...this.state, busy: false, retryPending: this.pending !== null });
            }
        }
    }

    private failPending(error: Error): void {
        if (isDefinitiveApiMutationFailure(error)) {
            this.pending = null;
        }
        this.publish({ ...this.state, error: error.message });
    }

    private assertAccountScope(value: Pick<MatchmakingSnapshot, 'scope' | 'principalId'>, session: AuthSession): void {
        if (!isSameGroupScope(value.scope, this.config.scope) || value.principalId !== session.clientId) {
            throw new TypeError('Matchmaking response belongs to another account or scope');
        }
    }

    private authenticationChanged(): void {
        const key = this.authKey();
        if (key === this.sessionKey) {
            return;
        }
        this.sessionKey = key;
        this.invalidate();
        if (this.dependencies.activity.isActive()) {
            void this.refresh();
        }
    }

    private invalidate(): void {
        this.revision++;
        this.controller.abort();
        this.controller = new AbortController();
        this.reads.clear();
        this.pending = null;
        this.publish({ snapshot: null, busy: false, retryPending: false, error: null });
    }

    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }

    private attempt(): RallarMatchmaking.ReadInput | null {
        const session = this.dependencies.auth.session();
        return this.subscriptions === null || session === undefined
            ? null
            : { scope: this.config.scope, session, signal: this.controller.signal };
    }

    private current(attempt: RallarMatchmaking.ReadInput): boolean {
        return this.subscriptions !== null && !attempt.signal.aborted &&
            this.authKey() === toAuthSessionKey(attempt.session);
    }

    private publish(state: RallarMatchmaking.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
