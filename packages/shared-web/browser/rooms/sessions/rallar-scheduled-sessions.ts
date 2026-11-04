import type { AuthSession } from '@shared/api/api-config.ts';
import { isSameGroupRef, isSameGroupScope } from '@shared/api/api-type-utils.ts';
import type {
    ChangeGroupSessionRequest,
    GroupSessionChange,
    GroupSessionPage,
    GroupSessionPreview
} from '@shared/api/group-sessions/group-session-schedule.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { StateScope } from '@shared/api/state-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import { SubscriptionScope } from '@shared/resilience/subscription-scope.ts';
import { createDefaultTimers, type Timers } from '@shared/resilience/timers.ts';
import { ThrottledFlush } from '@shared/resilience/timing/throttled-flush.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { changeSelectedViewWatch } from '../../api/change-selected-view-watch.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { SelectedViewWatch } from '../../api/selected-view-watch.ts';
import { subscribeViewDeadline } from '../../api/subscribe-view-deadline.ts';
import { subscribeViewInvalidations } from '../../api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '../../api/subscribe-view-recovery.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import { BrowserActivity } from '../../browser-activity.ts';
import type { RallarConnectionOperations } from '../../rallar-connection-facade.ts';
import type { RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
import type { RallarAuthFacade } from '../../session/rallar-auth-facade.ts';
import type { RallarRoomEntry } from '../entry/rallar-room-entry.ts';
import { requireOwnWsConnectionGenerationId } from '../require-own-ws-connection-generation-id.ts';
import { scheduledSessionHttpApi } from './scheduled-session-http-api.ts';
import { earliestSessionDeadline, ScheduledSessionViewReader } from './scheduled-session-view-reader.ts';

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
        readonly activity: Pick<BrowserActivity, 'isActive' | 'onChange'>;
        readonly watch: Pick<SelectedViewWatch, 'select' | 'release'>;
        readConnectionGeneration(signal: AbortSignal): Promise<string>;
        onChanged(listener: () => Promise<void>): () => void;
    }
    export interface Config {
        readonly scope: StateScope;
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

interface SessionViewDeadline {
    readonly atEpochMs: number;
}

/** Owns account-bound scheduling requests. RoomEntry owns saved destinations and game admission. */
export class RallarScheduledSessions {
    private readonly dependencies: RallarScheduledSessions.Dependencies;
    private readonly config: RallarScheduledSessions.Config;
    private readonly reader: ScheduledSessionViewReader;
    private readonly notifications = new SynchronousNotifications<RallarScheduledSessions.State>((error) => {
        console.error('Error notifying scheduled-session listener', error);
    });
    private reads: ThrottledFlush | null = null;
    private readRevision = -1;
    private deadline: SessionViewDeadline | null = null;
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
        browser:
            & SubscribeViewRecovery.Browser
            & Pick<RallarRoomEntry.Browser, 'auth'>
            & Pick<RallarConnectionOperations, 'connect'>,
        entry: RallarRoomEntry,
        config: RallarScheduledSessions.Config
    ): RallarScheduledSessions {
        return new RallarScheduledSessions({
            auth: {
                session: () => browser.session(),
                onChange: (listener, options) => browser.auth.onChange(listener, options)
            },
            entry,
            activity: new BrowserActivity(),
            onChanged: (changed) =>
                subscribeViewInvalidations({ browser, scope: config.scope, resource: 'sessions', changed }),
            watch: new SelectedViewWatch({
                createId: () => crypto.randomUUID(),
                change: (input) => changeSelectedViewWatch({ ...config.scope, family: 'session-preview' }, input)
            }),
            readConnectionGeneration: async (signal) => {
                const context = await browser.connect({ scope: config.scope, signal });
                return await requireOwnWsConnectionGenerationId(context, signal);
            },
            api: scheduledSessionHttpApi,
            timers: createDefaultTimers(),
            createId: () => crypto.randomUUID()
        }, config);
    }

    public constructor(dependencies: RallarScheduledSessions.Dependencies, config: RallarScheduledSessions.Config) {
        this.dependencies = dependencies;
        this.config = config;
        this.reader = new ScheduledSessionViewReader(dependencies, config.scope);
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
            const refresh = () => this.dependencies.activity.isActive() ? this.refresh() : Promise.resolve();
            this.subscriptions.add(this.dependencies.onChanged(refresh));
            this.subscriptions.add(this.dependencies.activity.onChange(() => {
                void refresh();
            }));
            this.subscriptions.add(subscribeViewDeadline<SessionViewDeadline>({
                timers: this.dependencies.timers,
                onChange: (listener) => this.onChange(() => listener({ view: this.deadline })),
                remainingMs: (deadline) => deadline.atEpochMs - this.dependencies.timers.nowMs(),
                refresh
            }));
            this.subscriptions.add(this.dependencies.entry.onChange(() => this.entryChanged()));
            this.entryChanged();
        }
        return this.dependencies.activity.isActive() ? this.refresh() : Promise.resolve();
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
            const read = { attempt, isCurrent: () => this.current(attempt) && revision === this.revision };
            const page = await this.reader.readPages({ ...read, pageCount: this.pageCount });
            if (page === null) {
                return;
            }
            let selected: ScheduledSessionViewReader.Preview = { preview: null, deadlineAtEpochMs: null };
            let previewError: string | null = null;
            try {
                if (selectedRef === null) {
                    this.releasePreviewWatch();
                }
                else {
                    selected = await this.reader.readPreview({ ...read, ref: selectedRef });
                }
            }
            catch (error) {
                previewError = toError(error).message;
            }
            if (!this.current(attempt) || revision !== this.revision) {
                return;
            }
            this.publishCanonical({
                ...this.state,
                sessions: page.sessions,
                selected: selected.preview,
                hasMore: page.nextKey !== null,
                error: previewError ?? (this.pending === null ? null : this.state.error)
            }, earliestSessionDeadline(page.deadlineAtEpochMs, selected.deadlineAtEpochMs));
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
        if (this.dependencies.activity.isActive()) {
            void this.refresh();
        }
    }

    private authenticationChanged(): void {
        const key = this.authKey();
        if (key === this.sessionKey) {
            return;
        }
        this.sessionKey = key;
        this.invalidate();
        this.entryChanged();
        if (this.dependencies.activity.isActive()) {
            void this.refresh();
        }
    }

    private releasePreviewWatch(): void {
        void this.dependencies.watch.release().catch((error) => {
            console.error('Scheduled preview watch cleanup failed', toError(error));
        });
    }

    private invalidate(): void {
        this.generation++;
        this.releasePreviewWatch();
        this.controller.abort();
        this.controller = new AbortController();
        void this.reads?.stop();
        this.reads = null;
        this.pending = null;
        this.deadline = null;
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
            !isSameGroupScope(ref, this.config.scope)
        ) {
            throw new TypeError('Session room belongs to another application or workspace scope');
        }
    }

    /** Local busy/error changes retain this observation's absolute deadline. */
    private publishCanonical(state: RallarScheduledSessions.State, deadlineAtEpochMs: number | null): void {
        this.deadline = deadlineAtEpochMs === null ? null : { atEpochMs: deadlineAtEpochMs };
        this.publish(state);
    }

    private publish(state: RallarScheduledSessions.State): void {
        this.state = state;
        this.notifications.publishLatest(state);
    }
}
