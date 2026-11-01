import type { AuthSession } from '@shared/api/api-config.ts';
import type { FriendsMutationResult, FriendsRefusal, FriendsRequest } from '@shared/api/friends/friends-request.ts';
import type { FriendsView } from '@shared/api/friends/friends-view.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ApiHttpError } from '../api/http-error.ts';
import { toAuthSessionKey } from '../auth/to-auth-session-key.ts';
import { BrowserActivity } from '../browser-activity.ts';
import type { RallarRoomEntry } from '../rooms/entry/rallar-room-entry.ts';
import { friendsHttpApi } from './friends-http-api.ts';

const FRIENDS_REFUSAL_MESSAGES: Readonly<Record<FriendsRefusal, string>> = {
    'request-unavailable': 'This friend request is no longer available. Refresh to see the current status.',
    'person-unavailable': 'This person is unavailable for that request.',
    unauthorized: 'Sign in again to update your friends.',
    capacity: 'A friend list or invitation limit has been reached. Remove an old contact or invitation and try again.',
    'friend-required': 'Both people must accept friendship before sending invitations.',
    'destination-unavailable': 'This room or scheduled session is no longer available to invite people to.',
    'invitation-expired': 'This invitation has expired. Send a new invitation.'
};

export namespace RallarFriends {
    export interface State {
        readonly view: FriendsView | null;
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
        readonly request: FriendsRequest;
        readonly requestId: string;
    }
    export interface Api {
        read(input: ReadInput): Promise<FriendsView>;
        change(input: ChangeInput): Promise<FriendsMutationResult>;
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
    export interface Attempt {
        readonly generation: number;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
    export interface Pending {
        readonly request: FriendsRequest;
        readonly requestId: string;
    }
}

/** Account-bound social consent. Existing entry and game owners retain admission and gameplay authority. */
export class RallarFriends {
    private readonly dependencies: RallarFriends.Dependencies;
    private readonly config: RallarFriends.Config;
    private readonly notifications = new SynchronousNotifications<RallarFriends.State>((error) =>
        console.error('Friends listener failed', error)
    );
    private readonly reads = new SingleFlight<string, void>();
    private subscriptions: SubscriptionScope | null = null;
    private controller = new AbortController();
    private generation = 0;
    private revision = 0;
    private sessionKey: string | null = null;
    private pending: RallarFriends.Pending | null = null;
    private state: RallarFriends.State = { view: null, busy: false, retryPending: false, error: null };

    static createBrowser(
        browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>,
        entry: RallarRoomEntry,
        config: RallarFriends.Config
    ): RallarFriends {
        return new RallarFriends({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            api: friendsHttpApi,
            entry,
            activity: new BrowserActivity(),
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    constructor(dependencies: RallarFriends.Dependencies, config: RallarFriends.Config) {
        if (!Number.isSafeInteger(config.refreshIntervalMs) || config.refreshIntervalMs <= 0) {
            throw new TypeError('Friends refresh interval must be a positive integer');
        }
        this.dependencies = dependencies;
        this.config = config;
    }

    getState(): RallarFriends.State {
        return this.state;
    }

    onChange(listener: (state: RallarFriends.State) => void): () => void {
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
        if (attempt === null) {
            return Promise.resolve();
        }
        const revision = this.revision;
        return this.reads.run(`${attempt.generation}:${revision}`, () => this.readCurrent(attempt, revision));
    }

    act(request: FriendsRequest): Promise<void> {
        return this.state.busy || this.pending !== null
            ? Promise.resolve()
            : this.send({ request: structuredClone(request), requestId: this.dependencies.createId() });
    }

    retry(): Promise<void> {
        return this.pending === null || this.state.busy ? Promise.resolve() : this.send(this.pending);
    }

    async openInvitation(invitationId: string): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null || this.state.busy || this.pending !== null) {
            return;
        }
        this.revision++;
        this.publish({ ...this.state, busy: true, error: null });
        try {
            await this.refresh();
            if (!this.current(attempt)) {
                return;
            }
            const invitation = this.state.view?.invitations.find((candidate) =>
                candidate.invitationId === invitationId
            );
            if (invitation === undefined) {
                throw new Error('This invitation is no longer available.');
            }
            if (
                invitation.roomRef.applicationId !== this.config.scope.applicationId ||
                invitation.roomRef.workspaceId !== this.config.scope.workspaceId
            ) {
                throw new Error('Open this invitation in its game and workspace.');
            }
            this.dependencies.entry.enter({
                intent: invitation.kind === 'scheduled-session' ? 'preview-session' : 'join',
                roomRef: invitation.roomRef,
                joinCode: null,
                participation: 'player'
            });
        }
        catch (error) {
            if (this.current(attempt)) {
                this.publish({ ...this.state, error: toError(error).message });
            }
        }
        finally {
            if (this.current(attempt)) {
                this.publish({ ...this.state, busy: false });
            }
        }
    }

    private async readCurrent(attempt: RallarFriends.Attempt, revision: number): Promise<void> {
        try {
            const view = await this.dependencies.api.read({
                scope: this.config.scope,
                session: attempt.session,
                signal: attempt.signal
            });
            if (!this.current(attempt) || revision !== this.revision) {
                return;
            }
            if (view.principalId !== attempt.session.clientId) {
                throw new TypeError('Friends response belongs to another account');
            }
            this.publish({ ...this.state, view, error: this.pending === null ? null : this.state.error });
        }
        catch (error) {
            if (this.current(attempt) && revision === this.revision) {
                this.publish({ ...this.state, view: null, error: toError(error).message });
            }
        }
    }

    private async send(pending: RallarFriends.Pending): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null) {
            return;
        }
        this.pending = pending;
        this.revision++;
        this.publish({ ...this.state, busy: true, retryPending: false, error: null });
        try {
            const result = await this.dependencies.api.change({
                ...pending,
                scope: this.config.scope,
                session: attempt.session,
                signal: attempt.signal
            });
            if (!this.current(attempt)) {
                return;
            }
            if (result.principalId !== attempt.session.clientId || result.requestId !== pending.requestId) {
                throw new TypeError('Friends result belongs to another command');
            }
            this.pending = null;
            this.revision++;
            await this.refresh();
            if (this.current(attempt) && result.status === 'refused') {
                this.publish({
                    ...this.state,
                    error: FRIENDS_REFUSAL_MESSAGES[result.code]
                });
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
        const exhausted = error instanceof ApiHttpError && error.mutationFailure?.retry?.kind === 'exhausted';
        if (
            exhausted || (error instanceof ApiHttpError && error.status >= 400 && error.status < 500 &&
                error.status !== 408 && error.status !== 429)
        ) {
            this.pending = null;
        }
        this.publish({
            ...this.state,
            error: exhausted
                ? 'The request could not complete. Review your friends and try the action again.'
                : error.message
        });
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
        this.generation++;
        this.controller.abort();
        this.controller = new AbortController();
        this.reads.clear();
        this.pending = null;
        this.publish({ view: null, busy: false, retryPending: false, error: null });
    }

    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }

    private attempt(): RallarFriends.Attempt | null {
        const session = this.dependencies.auth.session();
        return this.subscriptions === null || session === undefined
            ? null
            : { generation: this.generation, session, signal: this.controller.signal };
    }

    private current(attempt: RallarFriends.Attempt): boolean {
        return this.subscriptions !== null && attempt.generation === this.generation && !attempt.signal.aborted &&
            this.authKey() === toAuthSessionKey(attempt.session);
    }

    private publish(state: RallarFriends.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
