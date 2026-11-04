import type { AuthSession } from '@shared/api/api-config.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { ThrottledFlush } from '@shared/resilience/timing/throttled-flush.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import type { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { ApiHttpError } from './http-error.ts';
import { isDefinitiveApiMutationFailure } from './is-definitive-api-mutation-failure.ts';

export namespace AuthenticatedResource {
    export interface State<View> {
        readonly view: View | null;
        readonly busy: boolean;
        readonly retryPending: boolean;
        readonly error: string | null;
    }
    export interface ReadInput {
        readonly scope: StateScope;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
    export interface ChangeInput<Request> extends ReadInput {
        readonly request: Request;
        readonly requestId: string;
    }
    export interface Pending<Request> {
        readonly request: Request;
        readonly requestId: string;
    }
    /** Adapters validate account, scope and command binding before accepting any response. */
    export interface Api<View, Request> {
        read(input: ReadInput): Promise<View>;
        change(input: ChangeInput<Request>): Promise<string | null>;
    }
    export interface Dependencies {
        readonly auth: RallarRoomEntry.Auth;
        readonly activity: Pick<BrowserActivity, 'isActive' | 'onChange'>;
        readonly timers: Timers;
        readonly createId: () => string;
    }
    export interface Config {
        readonly scope: StateScope;
        subscribeRefresh(listener: () => Promise<void>): () => void;
    }
}

/** Owns private HTTP view lifetime and exact command recovery across browser authentication changes. */
export class AuthenticatedResource<View, Request> {
    private readonly dependencies: AuthenticatedResource.Dependencies;
    private readonly config: AuthenticatedResource.Config;
    private readonly api: AuthenticatedResource.Api<View, Request>;
    private readonly notifications = new SynchronousNotifications<AuthenticatedResource.State<View>>((error) =>
        console.error('Authenticated resource listener failed', error)
    );
    private reads: ThrottledFlush | null = null;
    private readRevision = -1;
    private subscriptions: SubscriptionScope | null = null;
    private controller = new AbortController();
    private revision = 0;
    private sessionKey: string | null = null;
    private pending: AuthenticatedResource.Pending<Request> | null = null;
    private state: AuthenticatedResource.State<View> = { view: null, busy: false, retryPending: false, error: null };

    constructor(
        dependencies: AuthenticatedResource.Dependencies,
        config: AuthenticatedResource.Config,
        api: AuthenticatedResource.Api<View, Request>
    ) {
        this.dependencies = dependencies;
        this.config = config;
        this.api = api;
    }

    getState(): AuthenticatedResource.State<View> {
        return this.state;
    }

    onChange(listener: (state: AuthenticatedResource.State<View>) => void): () => void {
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
            this.subscriptions.add(
                this.config.subscribeRefresh(() =>
                    this.dependencies.activity.isActive() ? this.refresh() : Promise.resolve()
                )
            );
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
        if (attempt === null) {
            return Promise.resolve();
        }
        if (this.reads === null || this.readRevision !== revision) {
            const previous = this.reads;
            this.readRevision = revision;
            this.reads = new ThrottledFlush({
                timers: this.dependencies.timers,
                write: async () => {
                    const current = this.attempt();
                    if (current !== null) {
                        await this.readCurrent(current, revision);
                    }
                }
            }, { minIntervalMs: 0, firstMarkDelayMs: 0 });
            void previous?.stop();
        }
        const covered = this.reads.mark();
        void this.reads.drain();
        return covered;
    }

    act(request: Request): Promise<void> {
        return this.state.busy || this.pending !== null
            ? Promise.resolve()
            : this.send({ request: structuredClone(request), requestId: this.dependencies.createId() });
    }

    retry(): Promise<void> {
        return this.pending === null || this.state.busy ? Promise.resolve() : this.send(this.pending);
    }

    protected beginOperation(): AuthenticatedResource.ReadInput | null {
        const attempt = this.attempt();
        if (attempt === null || this.state.busy || this.pending !== null) {
            return null;
        }
        this.revision++;
        this.publish({ ...this.state, busy: true, error: null });
        return this.current(attempt) ? attempt : null;
    }

    protected finishOperation(attempt: AuthenticatedResource.ReadInput): void {
        if (this.current(attempt)) {
            this.publish({ ...this.state, busy: false, retryPending: this.pending !== null });
        }
    }

    protected setError(error: string | null): void {
        this.publish({ ...this.state, error });
    }

    protected current(attempt: AuthenticatedResource.ReadInput): boolean {
        return this.subscriptions !== null && !attempt.signal.aborted &&
            this.authKey() === toAuthSessionKey(attempt.session);
    }

    private async readCurrent(attempt: AuthenticatedResource.ReadInput, revision: number): Promise<void> {
        if (!this.current(attempt) || revision !== this.revision) {
            return;
        }
        try {
            const view = await this.api.read(attempt);
            if (this.current(attempt) && revision === this.revision) {
                this.publish({ ...this.state, view, error: this.pending === null ? null : this.state.error });
            }
        }
        catch (error) {
            if (this.current(attempt) && revision === this.revision) {
                const failure = toError(error);
                this.invalidateLostAuthority(failure);
                this.publish({ ...this.state, view: null, error: failure.message });
            }
        }
    }

    private async send(pending: AuthenticatedResource.Pending<Request>): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null) {
            return;
        }
        this.pending = pending;
        this.revision++;
        this.publish({ ...this.state, busy: true, retryPending: false, error: null });
        if (!this.current(attempt)) {
            return;
        }
        try {
            const refusal = await this.api.change({ ...attempt, ...pending });
            if (!this.current(attempt)) {
                return;
            }
            this.pending = null;
            this.revision++;
            await this.refresh();
            if (this.current(attempt) && refusal !== null) {
                this.setError(refusal);
            }
        }
        catch (caught) {
            if (this.current(attempt)) {
                const error = toError(caught);
                this.invalidateLostAuthority(error);
                if (isDefinitiveApiMutationFailure(error)) {
                    this.pending = null;
                }
                this.setError(
                    error instanceof ApiHttpError && error.mutationFailure?.retry?.kind === 'exhausted'
                        ? 'The request could not complete. Refresh and try the action again.'
                        : error.message
                );
            }
        }
        finally {
            this.finishOperation(attempt);
        }
    }

    private invalidateLostAuthority(error: Error): void {
        if (error instanceof ApiHttpError && (error.status === 401 || error.status === 403)) {
            this.invalidate();
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
        const reads = this.reads;
        this.reads = null;
        this.readRevision = -1;
        void reads?.stop();
        this.pending = null;
        this.publish({ view: null, busy: false, retryPending: false, error: null });
    }

    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }

    private attempt(): AuthenticatedResource.ReadInput | null {
        const session = this.dependencies.auth.session();
        return this.subscriptions === null || session === undefined
            ? null
            : { scope: this.config.scope, session, signal: this.controller.signal };
    }

    private publish(state: AuthenticatedResource.State<View>): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
