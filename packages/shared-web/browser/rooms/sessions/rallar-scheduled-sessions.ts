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
import { createDefaultTimers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { AuthenticatedResource } from '../../api/authenticated-resource.ts';
import { ApiHttpError } from '../../api/http-error.ts';
import { SelectedViewWatch } from '../../api/selected-view-watch.ts';
import { subscribeViewDeadline } from '../../api/subscribe-view-deadline.ts';
import { subscribeViewInvalidations } from '../../api/subscribe-view-invalidations.ts';
import type { SubscribeViewRecovery } from '../../api/subscribe-view-recovery.ts';
import { writeSelectedViewWatch } from '../../api/write-selected-view-watch.ts';
import { toAuthSessionKey } from '../../auth/to-auth-session-key.ts';
import { BrowserActivity } from '../../browser-activity.ts';
import type { RallarConnectionOperations } from '../../rallar-connection-facade.ts';
import type { RallarUnsubscribe } from '../../rallar-shared-contracts.ts';
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
    export interface Dependencies extends AuthenticatedResource.Dependencies {
        readonly api: Api;
        readonly entry: Pick<RallarRoomEntry, 'getState' | 'onChange' | 'enter' | 'enterScheduledLobby'>;
        readonly watch: Pick<SelectedViewWatch, 'select' | 'release'>;
        readConnectionGeneration(signal: AbortSignal): Promise<string>;
        onChanged(listener: () => Promise<void>): () => void;
    }
    export interface Config {
        readonly scope: StateScope;
    }
    /** One reviewed intent; the resource supplies its stable request identity. */
    export type Request =
        | Readonly<{ kind: 'create'; groupId: string; create: Create; }>
        | Readonly<{ kind: 'change'; roomRef: GroupRef; change: GroupSessionChange; }>;
}

/** The canonical read of one input: the loaded page range and the selection it was read for. */
interface ScheduledSessionsView {
    readonly sessions: readonly GroupSessionPreview[];
    readonly hasMore: boolean;
    readonly selectedRef: GroupRef | null;
    readonly selected: GroupSessionPreview | null;
    readonly previewError: string | null;
    readonly deadlineAtEpochMs: number | null;
}

/** Owns account-bound scheduling requests. RoomEntry owns saved destinations and game admission. */
export class RallarScheduledSessions {
    private readonly dependencies: RallarScheduledSessions.Dependencies;
    private readonly config: RallarScheduledSessions.Config;
    private readonly reader: ScheduledSessionViewReader;
    private readonly resource: AuthenticatedResource<ScheduledSessionsView, RallarScheduledSessions.Request>;
    private readonly notifications = new SynchronousNotifications<RallarScheduledSessions.State>((error) => {
        console.error('Error notifying scheduled-session listener', error);
    });
    private subscriptions: SubscriptionScope | null = null;
    private accountKey: string | null = null;
    private selectedRef: GroupRef | null = null;
    private pageCount = 1;
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
                change: (input) => writeSelectedViewWatch({ ...config.scope, family: 'session-preview' }, input)
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
        this.resource = new AuthenticatedResource(
            dependencies,
            { scope: config.scope, changeResult: 'read', subscribeRefresh: dependencies.onChanged },
            { read: (attempt) => this.readView(attempt), change: (input) => this.writeRequest(input) }
        );
        this.resource.onChange(() => this.publish());
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
            this.accountKey = this.authKey();
            this.subscriptions.add(
                this.dependencies.auth.onChange(() => this.accountChanged(), { emitCurrent: false })
            );
            this.subscriptions.add(subscribeViewDeadline<ScheduledSessionsView>({
                timers: this.dependencies.timers,
                onChange: (listener) => this.resource.onChange(listener),
                remainingMs: ({ deadlineAtEpochMs }) =>
                    deadlineAtEpochMs === null ? null : deadlineAtEpochMs - this.dependencies.timers.nowMs(),
                refresh: () => this.resource.refresh()
            }));
            this.subscriptions.add(this.dependencies.entry.onChange(() => this.entryChanged()));
            this.entryChanged();
        }
        return this.resource.start();
    }

    public stop(): void {
        const subscriptions = this.subscriptions;
        this.subscriptions = null;
        try {
            subscriptions?.unsubscribe();
        }
        finally {
            this.resource.stop();
            this.releasePreviewWatch();
            this.selectedRef = null;
            this.pageCount = 1;
            this.publish();
        }
    }

    public refresh(): Promise<void> {
        return this.resource.refresh();
    }

    public async loadMore(): Promise<void> {
        if (!this.state.hasMore || this.state.busy) {
            return;
        }
        this.pageCount++;
        await this.resource.refreshForNewInput();
    }

    public async select(ref: GroupRef): Promise<void> {
        this.assertScope(ref);
        if (this.state.busy || this.state.retryPending) {
            return;
        }
        this.dependencies.entry.enter({
            intent: 'preview-session',
            roomRef: ref,
            joinCode: null,
            participation: 'player'
        });
        await this.resource.refresh();
    }

    /** Fresh permission first; the application's existing entry listener still owns its gameplay eligibility. */
    public async enterLobby(): Promise<void> {
        const selectedRef = this.selectedRef;
        const accountKey = this.authKey();
        if (
            this.state.busy || this.state.retryPending || selectedRef === null || accountKey === null ||
            !this.dependencies.activity.isActive()
        ) {
            return;
        }
        await this.resource.refresh();
        const selected = this.state.selected;
        if (
            this.selectedRef === selectedRef && this.authKey() === accountKey && selected?.canEnter &&
            isSameGroupRef(selected.roomRef, selectedRef)
        ) {
            this.dependencies.entry.enterScheduledLobby();
        }
    }

    public create(input: RallarScheduledSessions.Create): Promise<void> {
        if (this.state.busy || this.state.retryPending) {
            return Promise.resolve();
        }
        return this.resource.act({ kind: 'create', groupId: this.dependencies.createId(), create: input });
    }

    public act(action: GroupSessionChange['action'], startsAtEpochMs: number | null = null): Promise<void> {
        const selected = this.state.selected;
        if (selected === null || this.state.busy || this.state.retryPending) {
            return Promise.resolve();
        }
        return this.resource.act({
            kind: 'change',
            roomRef: selected.roomRef,
            change: { action, startsAtEpochMs, expectedScheduleRevision: selected.schedule.revision }
        });
    }

    public retry(): Promise<void> {
        return this.resource.retry();
    }

    private async readView(attempt: AuthenticatedResource.ReadInput): Promise<ScheduledSessionsView> {
        const selectedRef = this.selectedRef;
        const pageCount = this.pageCount;
        const read = {
            attempt,
            isCurrent: () => !attempt.signal.aborted && this.selectedRef === selectedRef && this.pageCount === pageCount
        };
        const page = await this.reader.readPages({ ...read, pageCount });
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
        return {
            sessions: page.sessions,
            hasMore: page.nextKey !== null,
            selectedRef,
            selected: selected.preview,
            previewError,
            deadlineAtEpochMs: earliestSessionDeadline(page.deadlineAtEpochMs, selected.deadlineAtEpochMs)
        };
    }

    /** A schedule policy denial refuses this intent; it is not a loss of the account's authority. */
    private async writeRequest(
        input: AuthenticatedResource.ChangeInput<RallarScheduledSessions.Request>
    ): Promise<string | null> {
        const { request, requestId, session, signal } = input;
        try {
            if (request.kind === 'change') {
                await this.dependencies.api.change({
                    ref: request.roomRef,
                    request: { ...request.change, requestId },
                    session,
                    signal
                });
                return null;
            }
            const ref = await this.dependencies.api.create({
                scope: this.config.scope,
                request: { ...request.create, groupId: request.groupId, requestId },
                session,
                signal
            });
            if (!signal.aborted) {
                this.assertScope(ref);
                this.dependencies.entry.enter({
                    intent: 'preview-session',
                    roomRef: ref,
                    joinCode: null,
                    participation: 'player'
                });
            }
            return null;
        }
        catch (error) {
            if (error instanceof ApiHttpError && error.status === 403) {
                return error.message;
            }
            throw error;
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
        this.publish();
        void this.resource.refreshForNewInput();
    }

    private accountChanged(): void {
        const key = this.authKey();
        if (key === this.accountKey) {
            return;
        }
        this.accountKey = key;
        this.releasePreviewWatch();
        this.selectedRef = null;
        this.pageCount = 1;
        this.entryChanged();
    }

    private releasePreviewWatch(): void {
        void this.dependencies.watch.release().catch((error) => {
            console.error('Scheduled preview watch cleanup failed', toError(error));
        });
    }

    private authKey(): string | null {
        const session = this.dependencies.auth.session();
        return session === undefined ? null : toAuthSessionKey(session);
    }

    private assertScope(ref: GroupRef): void {
        if (!isSameGroupScope(ref, this.config.scope)) {
            throw new TypeError('Session room belongs to another application or workspace scope');
        }
    }

    /** A view read for an earlier selection never presents or authorizes the current one. */
    private publish(): void {
        const { view, busy, retryPending, error } = this.resource.getState();
        const selection = view !== null && this.selectedRef !== null && view.selectedRef === this.selectedRef
            ? view
            : null;
        this.state = {
            sessions: view?.sessions ?? [],
            selected: selection?.selected ?? null,
            hasMore: view?.hasMore ?? false,
            busy,
            retryPending,
            error: error ?? selection?.previewError ?? null
        };
        this.notifications.publishLatest(this.state);
    }
}
