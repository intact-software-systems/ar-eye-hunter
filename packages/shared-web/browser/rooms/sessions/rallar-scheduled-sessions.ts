import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef } from '@shared/api/api-type-utils.ts';
import type {
    ChangeGroupSessionRequest,
    GroupSessionChange,
    GroupSessionPage,
    GroupSessionPreview
} from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import type { RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import type { RallarRoomEntry } from '../entry/rallar-room-entry.ts';
import { scheduledSessionHttpApi } from './scheduled-session-http-api.ts';

export namespace RallarScheduledSessions {
    export interface State {
        readonly sessions: readonly GroupSessionPreview[];
        readonly selected: GroupSessionPreview | null;
        readonly hasMore: boolean;
        readonly busy: boolean;
        readonly retryPending: boolean;
        readonly error: string | null;
    }
    export interface Create {
        readonly displayName: string;
        readonly startsAtEpochMs: number;
        readonly maxPlayers: number;
    }
    export interface CreateRequest extends Create {
        readonly groupId: string;
        readonly requestId: string;
    }
    export interface ListInput {
        readonly scope: StateScope;
        readonly after: string | null;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
    export interface CreateInput {
        readonly scope: StateScope;
        readonly request: CreateRequest;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
    export interface ChangeInput {
        readonly ref: GroupRef;
        readonly request: ChangeGroupSessionRequest;
        readonly session: AuthSession;
        readonly signal: AbortSignal;
    }
    export interface Api {
        list(input: ListInput): Promise<GroupSessionPage>;
        read(ref: GroupRef, session: AuthSession, signal: AbortSignal): Promise<GroupSessionPreview | null>;
        create(input: CreateInput): Promise<GroupRef>;
        change(input: ChangeInput): Promise<void>;
    }
    export interface Auth extends Pick<RallarAuthFacade, 'onChange'> {
        session(): AuthSession | undefined;
    }
    export interface Dependencies {
        readonly auth: Auth;
        readonly api: Api;
        readonly entry: Pick<RallarRoomEntry, 'getState' | 'onChange' | 'enter' | 'enterScheduledLobby'>;
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
    export type Pending =
        | Readonly<{ kind: 'create'; request: CreateRequest; }>
        | Readonly<{ kind: 'change'; roomRef: GroupRef; request: ChangeGroupSessionRequest; }>;
}

/** Owns account-bound scheduling requests. RoomEntry owns saved destinations and game admission. */
export class RallarScheduledSessions {
    private readonly dependencies: RallarScheduledSessions.Dependencies;
    private readonly config: RallarScheduledSessions.Config;
    private readonly notifications = new SynchronousNotifications<RallarScheduledSessions.State>((error) => {
        console.error('Error notifying scheduled-session listener', error);
    });
    private readonly reads = new SingleFlight<string, void>();
    private subscriptions: SubscriptionScope | null = null;
    private controller = new AbortController();
    private generation = 0;
    private revision = 0;
    private sessionKey: string | null = null;
    private selectedRef: GroupRef | null = null;
    private pageCount = 1;
    private pending: RallarScheduledSessions.Pending | null = null;
    private state: RallarScheduledSessions.State = {
        sessions: [],
        selected: null,
        hasMore: false,
        busy: false,
        retryPending: false,
        error: null
    };

    public static createBrowser(
        browser: Pick<RallarRoomEntry.Browser, 'auth' | 'session'>,
        entry: RallarRoomEntry,
        config: RallarScheduledSessions.Config
    ): RallarScheduledSessions {
        return new RallarScheduledSessions({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            entry,
            api: scheduledSessionHttpApi,
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    public constructor(dependencies: RallarScheduledSessions.Dependencies, config: RallarScheduledSessions.Config) {
        if (!Number.isSafeInteger(config.refreshIntervalMs) || config.refreshIntervalMs <= 0) {
            throw new TypeError('Session refresh interval must be a positive integer');
        }
        this.dependencies = dependencies;
        this.config = config;
    }

    public getState(): RallarScheduledSessions.State {
        return this.state;
    }

    public onChange(listener: (state: RallarScheduledSessions.State) => void): RallarUnsubscribe {
        return this.notifications.subscribeAndNotify(listener, this.state).unsubscribe;
    }

    public start(): Promise<void> {
        if (this.subscriptions === null) {
            this.subscriptions = new SubscriptionScope();
            this.sessionKey = this.authKey();
            this.subscriptions.add(
                this.dependencies.auth.onChange(() => this.authenticationChanged(), { emitCurrent: false })
            );
            this.subscriptions.add(this.dependencies.entry.onChange(() => this.entryChanged()));
            this.subscriptions.add(startRepeating({
                timers: this.dependencies.timers,
                intervalMs: this.config.refreshIntervalMs,
                firstRun: 'after-interval',
                run: () => this.refresh()
            }));
            this.entryChanged();
        }
        return this.refresh();
    }

    public stop(): void {
        const subscriptions = this.subscriptions;
        this.subscriptions = null;
        try {
            subscriptions?.unsubscribe();
        }
        finally {
            this.invalidate();
        }
    }

    public refresh(): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null) {
            return Promise.resolve();
        }
        const revision = this.revision;
        return this.reads.run(`${attempt.generation}:${revision}`, () => this.readCurrent(attempt, revision));
    }

    public async loadMore(): Promise<void> {
        if (!this.state.hasMore || this.state.busy) {
            return;
        }
        this.pageCount++;
        this.revision++;
        await this.refresh();
    }

    public async select(ref: GroupRef): Promise<void> {
        this.assertScope(ref);
        if (this.state.busy || this.pending !== null) {
            return;
        }
        this.dependencies.entry.enter({
            intent: 'preview-session',
            roomRef: ref,
            joinCode: null,
            participation: 'player'
        });
        await this.refresh();
    }

    /** Fresh permission first; the application's existing entry listener still owns its gameplay eligibility. */
    public async enterLobby(): Promise<void> {
        if (this.state.busy || this.pending !== null) {
            return;
        }
        const attempt = this.attempt();
        const selectedRef = this.selectedRef;
        const revision = this.revision;
        if (attempt === null || selectedRef === null) {
            return;
        }
        await this.refresh();
        const selected = this.state.selected;
        if (
            this.current(attempt) && revision === this.revision && selected?.canEnter &&
            isSameGroupRef(selected.roomRef, selectedRef)
        ) {
            this.dependencies.entry.enterScheduledLobby();
        }
    }

    public create(input: RallarScheduledSessions.Create): Promise<void> {
        if (this.state.busy || this.pending !== null) {
            return Promise.resolve();
        }
        return this.send({
            kind: 'create',
            request: { ...input, groupId: this.dependencies.createId(), requestId: this.dependencies.createId() }
        });
    }

    public act(action: GroupSessionChange['action'], startsAtEpochMs: number | null = null): Promise<void> {
        const selected = this.state.selected;
        if (selected === null || this.state.busy || this.pending !== null) {
            return Promise.resolve();
        }
        return this.send({
            kind: 'change',
            roomRef: selected.roomRef,
            request: {
                action,
                startsAtEpochMs,
                expectedScheduleRevision: selected.schedule.revision,
                requestId: this.dependencies.createId()
            }
        });
    }

    public retry(): Promise<void> {
        return this.pending === null || this.state.busy ? Promise.resolve() : this.send(this.pending);
    }

    private async readCurrent(attempt: RallarScheduledSessions.Attempt, revision: number): Promise<void> {
        const selectedRef = this.selectedRef;
        try {
            const sessions: GroupSessionPreview[] = [];
            let cursor: string | null = null;
            const visited = new Set<string>();
            for (let page = 0; page < this.pageCount; page++) {
                const result = await this.dependencies.api.list({
                    scope: this.config.scope,
                    after: cursor,
                    session: attempt.session,
                    signal: attempt.signal
                });
                if (!this.current(attempt) || revision !== this.revision) {
                    return;
                }
                for (const session of result.sessions) {
                    this.assertScope(session.roomRef);
                    if (!sessions.some((existing) => isSameGroupRef(existing.roomRef, session.roomRef))) {
                        sessions.push(session);
                    }
                }
                cursor = result.nextKey;
                if (cursor === null) {
                    break;
                }
                if (visited.has(cursor)) {
                    throw new TypeError('Session directory repeated its pagination cursor');
                }
                visited.add(cursor);
            }
            const selected = selectedRef === null
                ? null
                : await this.dependencies.api.read(selectedRef, attempt.session, attempt.signal);
            if (!this.current(attempt) || revision !== this.revision) {
                return;
            }
            if (selected !== null && (selectedRef === null || !isSameGroupRef(selected.roomRef, selectedRef))) {
                throw new TypeError('Session preview names a different room');
            }
            this.publish({
                ...this.state,
                sessions,
                selected,
                hasMore: cursor !== null,
                error: this.pending === null ? null : this.state.error
            });
        }
        catch (error) {
            if (this.current(attempt) && revision === this.revision) {
                // A stale successful preview cannot authorize entry after a failed refresh.
                this.publish({ ...this.state, selected: null, error: toError(error).message });
            }
        }
    }

    private async send(pending: RallarScheduledSessions.Pending): Promise<void> {
        const attempt = this.attempt();
        if (attempt === null) {
            return;
        }
        this.pending = pending;
        this.revision++;
        this.publish({ ...this.state, busy: true, retryPending: false, error: null });
        try {
            if (pending.kind === 'create') {
                const ref = await this.dependencies.api.create({
                    scope: this.config.scope,
                    request: pending.request,
                    session: attempt.session,
                    signal: attempt.signal
                });
                if (!this.current(attempt)) {
                    return;
                }
                this.assertScope(ref);
                this.dependencies.entry.enter({
                    intent: 'preview-session',
                    roomRef: ref,
                    joinCode: null,
                    participation: 'player'
                });
            }
            else {
                await this.dependencies.api.change({
                    ref: pending.roomRef,
                    request: pending.request,
                    session: attempt.session,
                    signal: attempt.signal
                });
            }
            if (this.current(attempt)) {
                this.pending = null;
                this.revision++;
                await this.refresh();
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                // Definitive policy rejection permits a newly reviewed intent; transport ambiguity keeps the exact command.
                if (
                    error instanceof ApiHttpError && error.status >= 400 && error.status < 500 &&
                    error.status !== 408 && error.status !== 429
                ) {
                    this.pending = null;
                }
                this.publish({ ...this.state, error: toError(error).message, retryPending: this.pending !== null });
            }
        }
        finally {
            if (this.current(attempt)) {
                this.publish({ ...this.state, busy: false, retryPending: this.pending !== null });
            }
        }
    }

    private entryChanged(): void {
        const entry = this.dependencies.entry.getState();
        const principalId = this.dependencies.auth.session()?.clientId;
        const ref = entry.destination?.intent === 'preview-session' &&
                (entry.principalId === null || entry.principalId === principalId)
            ? entry.destination.roomRef
            : null;
        if (
            (ref === null && this.selectedRef === null) ||
            (ref !== null && this.selectedRef !== null && isSameGroupRef(ref, this.selectedRef))
        ) {
            return;
        }
        if (ref !== null) {
            this.assertScope(ref);
        }
        this.selectedRef = ref;
        this.revision++;
        this.publish({ ...this.state, selected: null, error: null });
        void this.refresh();
    }

    private authenticationChanged(): void {
        const key = this.authKey();
        if (key === this.sessionKey) {
            return;
        }
        this.sessionKey = key;
        this.invalidate();
        this.entryChanged();
        void this.refresh();
    }

    private invalidate(): void {
        this.generation++;
        this.controller.abort();
        this.controller = new AbortController();
        this.reads.clear();
        this.pending = null;
        this.selectedRef = null;
        this.pageCount = 1;
        this.publish({ sessions: [], selected: null, hasMore: false, busy: false, retryPending: false, error: null });
    }

    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }

    private attempt(): RallarScheduledSessions.Attempt | null {
        const session = this.dependencies.auth.session();
        return this.subscriptions === null || session === undefined
            ? null
            : { generation: this.generation, session, signal: this.controller.signal };
    }

    private current(attempt: RallarScheduledSessions.Attempt): boolean {
        return this.subscriptions !== null && attempt.generation === this.generation && !attempt.signal.aborted &&
            this.authKey() === toAuthSessionKey(attempt.session);
    }

    private assertScope(ref: GroupRef): void {
        if (
            ref.applicationId !== this.config.scope.applicationId || ref.workspaceId !== this.config.scope.workspaceId
        ) {
            throw new TypeError('Session room belongs to another application or workspace scope');
        }
    }

    private publish(state: RallarScheduledSessions.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
