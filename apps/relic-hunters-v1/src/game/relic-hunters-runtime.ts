import {
    decodeRelicSnapshotPayload,
    hasUnfinishedRelicParticipation,
    type RelicActionInput,
    type RelicCharacterId,
    type RelicCommand,
    type RelicHunterEvent,
    type RelicPublicSnapshot,
    type RelicRoundTransitionEvent,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
import { RELIC_EXPEDITION_CAPACITY } from '@relic-hunters/src/model.ts';
import type {
    RallarAuthChangeListener,
    RallarAuthState,
    RallarRoomPresenceWaitOptions,
    RallarRoomPresenceWaitResult,
    RallarRoomState,
    RallarRoomSummary,
    RallarStartOptions,
    RallarStartResult,
    RallarSubscriptionScope,
    RallarUnsubscribe
} from '@shared-web/browser/rallar.ts';
import type { RallarRoomDirectory } from '@shared-web/browser/rooms/directory/rallar-room-directory.ts';
import type { RallarRoomEntry } from '@shared-web/browser/rooms/entry/rallar-room-entry.ts';
import type { RallarRoomMove } from '@shared-web/browser/rooms/move/rallar-room-move.ts';
import type { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import type { RallarGameAuthorityClientStatus } from '@shared/rallar-game/mod.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { deliverRelicCommand } from './runtime/deliver-relic-command.ts';
import {
    createRelicRematchDraft,
    type RelicCommandDraft,
    type RelicRematchDraft
} from './runtime/relic-command-draft.ts';
import { acceptRelicHunterFeedback, expireRelicHunterFeedback } from './runtime/relic-hunter-feedback.ts';

import {
    createInitialRelicRuntimeDiagnostics,
    toAcceptedRelicSnapshotDiagnostics,
    toIgnoredRelicSnapshotDiagnostics,
    toRelicRoomDiagnostics,
    type RelicRuntimeDiagnostics
} from './relic-runtime-diagnostics.ts';
import {
    classifyRelicSnapshotAcceptance,
    type RelicSnapshotSource
} from './relic-snapshot-ordering.ts';
import { createRelicRoomName } from './runtime/create-relic-room-name.ts';
import { RelicExpeditionParticipation } from './runtime/relic-expedition-participation.ts';
import { RelicRoundDeadlineRepair } from './runtime/relic-round-deadline-repair.ts';
import { toCreatedRelicRoomSnapshot } from './runtime/to-created-relic-room-snapshot.ts';
import type { RelicWsCommandDelivery } from './send-relic-ws-command.ts';
import type { RelicHunterEventSubscription } from './subscribe-relic-hunter-events.ts';
import type { RelicRoundTransitionSubscription } from './subscribe-relic-round-transitions.ts';
import { toRelicCommandPhase } from './to-relic-command-phase.ts';

const SNAPSHOT_REPAIR_INTERVAL_MS = 2_000;
const ROUND_TRANSITION_CUE_LOG_SIZE = 16;

export type RelicHuntersRuntimePhase =
    | 'signed-out'
    | 'authenticating'
    | 'connecting'
    | 'connected'
    | 'joining-room'
    | 'ready'
    | 'degraded'
    | 'error';

interface RelicAuthentication {
    readonly mode: 'login' | 'register';
    readonly username: string;
    readonly password: string;
    readonly displayName: string | undefined;
}

export namespace RelicHuntersRuntime {
    export interface Dependencies extends RelicExpeditionParticipation.Dependencies {
        readonly roomMove: RallarRoomMove;
        readonly roomEntry: RallarRoomEntry;
        readonly recentRooms: RallarRecentRooms;
        readonly directory: RallarRoomDirectory;
        readonly timers: Timers;
        restoreSession(): AuthSession | undefined;
        start(options: RallarStartOptions): Promise<Pick<RallarStartResult, 'session' | 'connected' | 'roomState'>>;
        subscriptions(): RallarSubscriptionScope;
        login(username: string, password: string): Promise<AuthSession>;
        register(username: string, password: string, displayName?: string): Promise<AuthSession>;
        logout(): Promise<void>;
        onAuthChange(listener: RallarAuthChangeListener): RallarUnsubscribe;
        roomState(): RallarRoomState;
        refreshRooms(): Promise<RallarRoomState>;
        waitForPresence(roomId: string, options: RallarRoomPresenceWaitOptions): Promise<RallarRoomPresenceWaitResult>;
        onRoomsChange(handler: (state: RallarRoomState) => void): RallarUnsubscribe;
        onSnapshotMessage(handler: (event: RelicServerEvent) => void): RallarUnsubscribe;
        onAuthoritySnapshotMessage(handler: (event: RelicServerEvent) => void): RallarUnsubscribe;
        onRoundTransitionMessage(roomId: string, subscription: RelicRoundTransitionSubscription): RallarUnsubscribe;
        onHunterEventMessage(roomId: string, subscription: RelicHunterEventSubscription): RallarUnsubscribe;
        authorityStatus(): RallarGameAuthorityClientStatus | undefined;
        publishRtcSnapshot(snapshot: RelicPublicSnapshot): Promise<boolean>;
        createRoomNameSeed(): string;
        createRoom(
            displayName: string,
            joinMode: GroupJoinMode,
            directoryListing?: GroupDirectoryListing
        ): Promise<GroupSnapshot>;
        joinRoom(roomId: string, participation: 'preserve' | 'player' | 'spectator'): Promise<void>;
        leaveRoom(roomId: string): Promise<void>;
        initializeGame(roomId: string): Promise<RelicPublicSnapshot | undefined>;
        sendWsCommand(roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined>;
        resetGame(roomId: string): Promise<RelicPublicSnapshot | undefined>;
    }

    export interface Connection extends Actions {
        readonly roomMove: RallarRoomMove;
        readonly roomEntry: RallarRoomEntry;
        readonly recentRooms: RallarRecentRooms;
        readonly participation: 'player' | 'spectator' | undefined;
        readonly onlinePlayerCount: number;
        readonly session: AuthSession | undefined;
        readonly connectionState: RelicHuntersRuntimePhase;
        readonly diagnostics: RelicRuntimeDiagnostics;
        readonly error: string | undefined;
        readonly roomId: string | undefined;
        readonly rooms: readonly RallarRoomSummary[];
        readonly directory: RallarRoomDirectory.State;
        readonly snapshot: RelicPublicSnapshot | undefined;
        readonly roundTransition: RelicRoundTransitionEvent | undefined;
        readonly lastHunterEvent: RelicHunterEvent | undefined;
    }

    export interface Actions {
        login(username: string, password: string): Promise<void>;
        register(username: string, password: string, displayName?: string): Promise<void>;
        logout(): Promise<void>;
        refreshRooms(): Promise<void>;
        createRoom(
            joinMode?: GroupJoinMode,
            directoryListing?: GroupDirectoryListing
        ): Promise<GroupSnapshot | undefined>;
        joinRoom(roomId: string): Promise<void>;
        watchRoom(roomId: string): Promise<void>;
        joinAsPlayer(): Promise<void>;
        leaveRoom(): Promise<void>;
        leaveExpedition(): Promise<void>;
        takeKeeper(): Promise<void>;
        joinExpedition(characterId?: RelicCharacterId): Promise<void>;
        startExpedition(): Promise<void>;
        setRematchReady(ready: boolean, characterId: RelicCharacterId): Promise<void>;
        startRematch(): Promise<void>;
        setRematchRoundLimit(timeLimitMs: number): Promise<void>;
        submitAction(action: RelicActionInput): Promise<void>;
        forceResolveRound(): Promise<void>;
        pickupRelic(relicId: string): Promise<void>;
        continueReview(): Promise<void>;
        setRoundLimit(timeLimitMs: number): Promise<void>;
        resetExpedition(): Promise<void>;
    }

    export interface Attempt {
        readonly generation: number;
        readonly roomGeneration: number;
        readonly participation?: 'player' | 'spectator';
        readonly session: AuthSession;
        readonly roomId: string | undefined;
    }
}

/** Owns the page's authenticated connection, current expedition and delivery lifecycle. */
export class RelicHuntersRuntime {
    private readonly deps: RelicHuntersRuntime.Dependencies;
    private connection: RelicHuntersRuntime.Connection;
    private readonly notifications = new SynchronousNotifications<void>((error) => {
        console.error('Error notifying Relic runtime listener', error);
    });
    private active = false;
    private generation = 0;
    private roomGeneration = 0;
    private readonly connectionStarts = new SingleFlight<string, void>();
    private readonly departures = new SingleFlight<string, void>();
    private bootstrap: AbortController | undefined;
    private lifecycle: RallarSubscriptionScope | undefined;
    private transport: RallarSubscriptionScope | undefined;
    private roomListeners: RallarSubscriptionScope | undefined;
    private snapshotRequest = 0;
    private roomRefreshRequest = 0;
    private stopSnapshotRepair: (() => void) | undefined;
    private readonly admission: RelicExpeditionParticipation;
    private readonly roundRepair: RelicRoundDeadlineRepair;

    public constructor(deps: RelicHuntersRuntime.Dependencies) {
        this.deps = deps;
        this.admission = new RelicExpeditionParticipation(deps);
        this.roundRepair = new RelicRoundDeadlineRepair({
            timers: deps.timers,
            refresh: () => this.hydrateRoom('timeout-repair')
        }, { intervalMs: SNAPSHOT_REPAIR_INTERVAL_MS });
        const session = deps.restoreSession();
        this.connection = {
            roomMove: deps.roomMove,
            roomEntry: deps.roomEntry,
            recentRooms: deps.recentRooms,
            session,
            connectionState: session ? 'connecting' : 'signed-out',
            diagnostics: createInitialRelicRuntimeDiagnostics(session),
            error: undefined,
            roomId: undefined,
            rooms: [],
            participation: undefined,
            onlinePlayerCount: 0,
            directory: { status: 'idle', entries: [], error: undefined },
            snapshot: undefined,
            roundTransition: undefined,
            lastHunterEvent: undefined,
            ...this.actions()
        };
    }

    public readonly getState = (): RelicHuntersRuntime.Connection => this.connection;
    public readonly subscribe = (listener: () => void): RallarUnsubscribe =>
        this.notifications.subscribe(listener).unsubscribe;

    public async start(): Promise<void> {
        if (this.active) {
            return;
        }
        this.active = true;
        const generation = this.generation;
        // Reserve ownership before publication: a listener can stop and restart synchronously.
        const lifecycle = this.deps.subscriptions();
        this.lifecycle = lifecycle;
        this.diagnose({ middlewareConnected: false });
        if (this.lifecycle !== lifecycle) {
            return;
        }
        this.deps.roomEntry.start();
        if (this.lifecycle !== lifecycle) {
            return;
        }
        void this.deps.recentRooms.start();
        if (this.lifecycle !== lifecycle) {
            return;
        }
        lifecycle.add(this.deps.onAuthChange((state) => this.authChanged(state)));
        if (this.lifecycle !== lifecycle) {
            return;
        }
        lifecycle.add(this.deps.roomEntry.onChange((state) => this.entryChanged(state)));
        if (this.lifecycle !== lifecycle) {
            return;
        }
        if (this.generation === generation) {
            await this.connect();
        }
        else {
            // Auth replay may already have started a connection for the restored session.
            await Promise.all(this.connectionStarts.completions());
        }
    }

    public stop(): void {
        this.active = false;
        this.invalidateConnection();
        this.lifecycle?.unsubscribe();
        this.lifecycle = undefined;
        void this.deps.recentRooms.stop();
        this.deps.roomEntry.stop();
    }

    private actions(): RelicHuntersRuntime.Actions {
        return {
            login: (username, password) =>
                this.authenticate({ mode: 'login', username, password, displayName: undefined }),
            register: (username, password, displayName) =>
                this.authenticate({ mode: 'register', username, password, displayName }),
            logout: () => this.logout(),
            refreshRooms: () => this.refreshRooms(),
            createRoom: (joinMode = 'open', directoryListing) => this.createRoom(joinMode, directoryListing),
            joinRoom: (roomId) => this.joinRoom(roomId, 'preserve'),
            watchRoom: (roomId) => this.joinRoom(roomId, 'spectator'),
            joinAsPlayer: () => this.joinAsPlayer(),
            leaveRoom: () => this.depart(true),
            leaveExpedition: () => this.depart(false),
            takeKeeper: () => this.sendCommand({ kind: 'take-keeper' }),
            joinExpedition: (characterId) => this.sendCommand({ kind: 'join-expedition', characterId }),
            startExpedition: () => this.sendCommand({ kind: 'start-expedition' }),
            setRematchReady: (ready, characterId) =>
                this.sendRematchCommand({ kind: 'set-rematch-ready', ready, characterId }),
            startRematch: () => this.sendRematchCommand({ kind: 'start-rematch' }),
            setRematchRoundLimit: (timeLimitMs) =>
                this.sendRematchCommand({ kind: 'set-rematch-round-limit', timeLimitMs }),
            submitAction: (action) => this.sendCommand({ kind: 'submit-action', action }),
            forceResolveRound: () => this.sendCommand({ kind: 'force-resolve-round' }),
            pickupRelic: (relicId) => this.sendCommand({ kind: 'pickup-relic', relicId }),
            continueReview: async () => {
                if (this.connection.snapshot?.phase === 'review') {
                    await this.sendCommand({ kind: 'continue-review' });
                }
            },
            setRoundLimit: (timeLimitMs) => this.sendCommand({ kind: 'set-round-limit', timeLimitMs }),
            resetExpedition: () => this.resetExpedition()
        };
    }

    private publish(patch: Partial<RelicHuntersRuntime.Connection>): void {
        this.connection = { ...this.connection, ...patch };
        this.notifications.publishLatest(undefined);
    }

    private diagnose(patch: Partial<RelicRuntimeDiagnostics>): void {
        this.publish({ diagnostics: { ...this.connection.diagnostics, ...patch } });
    }

    private phase(
        phase: RelicHuntersRuntimePhase,
        diagnostics: Partial<RelicRuntimeDiagnostics> = {},
        state: Partial<RelicHuntersRuntime.Connection> = {}
    ): void {
        this.publish({
            ...state,
            connectionState: phase,
            diagnostics: { ...this.connection.diagnostics, ...diagnostics, phase }
        });
    }

    private authChanged(state: RallarAuthState): void {
        if (!this.active) {
            return;
        }
        if (!state.authenticated || !state.session) {
            this.signedOut();
            return;
        }
        if (sameSession(this.connection.session, state.session)) {
            return;
        }
        this.invalidateConnection();
        const generation = this.generation;
        this.publish({
            session: state.session,
            connectionState: 'connecting',
            diagnostics: createInitialRelicRuntimeDiagnostics(state.session),
            roomId: undefined,
            rooms: [],
            participation: undefined,
            onlinePlayerCount: 0,
            directory: { status: 'idle', entries: [], error: undefined },
            snapshot: undefined,
            roundTransition: undefined,
            lastHunterEvent: undefined
        });
        if (this.active && this.generation === generation) {
            void this.connect();
        }
    }

    private entryChanged(state: RallarRoomEntry.State): void {
        if (!this.active || state.status !== 'pending') {
            return;
        }
        // Admission can finish before expedition hydration; absence is not evidence of participation.
        if (this.connection.participation === 'player' && !this.connection.snapshot) {
            return;
        }
        if (
            this.blocksRoomChange() &&
            (this.connection.diagnostics.commandInFlight !== undefined ||
                state.destination?.participation === 'spectator' ||
                state.destination?.roomRef.groupId !== this.connection.roomId)
        ) {
            this.deps.roomEntry.cancel();
            this.operationFailed(new Error('Use Leave expedition before entering or watching another expedition.'));
            return;
        }
        if (this.connection.diagnostics.middlewareConnected) {
            void this.deps.roomEntry.resume();
        }
    }

    private signedOut(): void {
        this.invalidateConnection();
        this.publish({
            session: undefined,
            connectionState: 'signed-out',
            diagnostics: createInitialRelicRuntimeDiagnostics(undefined),
            roomId: undefined,
            rooms: [],
            participation: undefined,
            onlinePlayerCount: 0,
            directory: { status: 'idle', entries: [], error: undefined },
            snapshot: undefined,
            roundTransition: undefined,
            lastHunterEvent: undefined,
            error: undefined
        });
    }

    private invalidateConnection(): void {
        this.generation++;
        this.snapshotRequest++;
        this.roomRefreshRequest++;
        this.bootstrap?.abort();
        this.bootstrap = undefined;
        this.connectionStarts.clear();
        this.transport?.unsubscribe();
        this.transport = undefined;
        this.deps.directory.stop();
        this.roomListeners?.unsubscribe();
        this.roomListeners = undefined;
        this.stopSnapshotRepair?.();
        this.stopSnapshotRepair = undefined;
        this.roundRepair.clear();
    }

    private attempt(): RelicHuntersRuntime.Attempt | undefined {
        const session = this.connection.session;
        return this.active && session
            ? {
                generation: this.generation,
                roomGeneration: this.roomGeneration,
                session,
                roomId: this.connection.roomId,
                participation: this.connection.participation
            }
            : undefined;
    }

    private current(attempt: RelicHuntersRuntime.Attempt, requireRoom = false): boolean {
        return this.active && this.generation === attempt.generation &&
            sameSession(this.deps.restoreSession(), attempt.session) &&
            (!requireRoom ||
                (this.connection.roomId === attempt.roomId && this.roomGeneration === attempt.roomGeneration &&
                    this.connection.participation === attempt.participation));
    }

    private connect(): Promise<void> {
        if (!this.active) {
            return Promise.resolve();
        }
        const session = this.deps.restoreSession();
        if (!session) {
            this.signedOut();
            return Promise.resolve();
        }
        if (this.connection.diagnostics.middlewareConnected && sameSession(this.connection.session, session)) {
            return Promise.resolve();
        }
        const key = JSON.stringify([this.generation, session.clientId, session.sessionId]);
        return this.connectionStarts.run(key, () => this.connectSession(session));
    }

    private async connectSession(session: AuthSession): Promise<void> {
        const attempt = {
            generation: this.generation,
            roomGeneration: this.roomGeneration,
            session,
            roomId: this.connection.roomId
        };
        this.phase('connecting', createInitialRelicRuntimeDiagnostics(session), { session, error: undefined });
        if (!this.current(attempt)) {
            return;
        }
        this.bootstrap = new AbortController();
        try {
            const started = await this.deps.start({
                refreshRooms: this.deps.roomEntry.getState().status === 'idle',
                signal: this.bootstrap.signal
            });
            if (!this.current(attempt)) {
                return;
            }
            if (!started.connected || !started.session) {
                this.signedOut();
                return;
            }
            this.installTransport(attempt);
            if (!this.current(attempt)) {
                return;
            }
            await this.deps.roomEntry.resume();
            if (!this.current(attempt)) {
                return;
            }
            const entry = this.deps.roomEntry.getState();
            const roomState = entry.status === 'entered'
                ? this.deps.roomState()
                : entry.status !== 'idle'
                ? { rooms: [], currentRoomId: undefined, members: [] }
                : started.roomState ?? await this.deps.refreshRooms();
            if (!this.current(attempt)) {
                return;
            }
            this.adoptRoom(roomState, false);
            await this.completeBootstrap(attempt);
            if (this.current(attempt)) {
                await this.deps.directory.start();
            }
        }
        catch (error) {
            if (!this.current(attempt)) {
                return;
            }
            const message = toError(error).message;
            this.phase('error', { lastError: message }, { error: message });
        }
    }

    private installTransport(attempt: RelicHuntersRuntime.Attempt): void {
        this.transport = this.deps.subscriptions();
        this.transport
            .add(this.deps.directory.onChange((directory) => {
                if (this.current(attempt)) {
                    this.publish({ directory });
                }
            }))
            .add(this.deps.onSnapshotMessage((event) => this.receiveSnapshot(attempt, event, 'rallar-ws')))
            .add(this.deps.onAuthoritySnapshotMessage((event) => this.receiveSnapshot(attempt, event, 'rallar-rtc')))
            .add(this.deps.onRoomsChange((state) => {
                if (this.current(attempt)) {
                    this.adoptRoom(state, true);
                }
            }));
    }

    private async completeBootstrap(attempt: RelicHuntersRuntime.Attempt): Promise<void> {
        if (!this.current(attempt)) {
            return;
        }
        this.phase('connected', {
            middlewareConnected: true,
            authenticated: true,
            wsListenerReady: true,
            roomListenerReady: true,
            lastError: undefined,
            ...toRelicRoomDiagnostics(this.connection, this.deps.authorityStatus(), true)
        });
        if (!this.current(attempt)) {
            return;
        }
        this.installRoomListeners();
        if (!this.current(attempt)) {
            return;
        }
        this.stopSnapshotRepair = startRepeating({
            timers: this.deps.timers,
            intervalMs: SNAPSHOT_REPAIR_INTERVAL_MS,
            firstRun: 'after-interval',
            run: () => this.publishSnapshotRepair()
        });
        this.entryChanged(this.deps.roomEntry.getState());
        if (this.current(attempt)) {
            await this.hydrateRoom('bootstrap');
        }
    }

    private adoptRoom(state: RallarRoomState, hydrate: boolean): void {
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        const member = state.currentRoom?.members.find((entry) =>
            entry.principalId === attempt.session.clientId && entry.status === 'active'
        );
        const participation: RelicHuntersRuntime.Connection['participation'] = member
            ? (member.role === 'spectator' ? 'spectator' : 'player')
            : undefined;
        const roleChanged = participation !== this.connection.participation;
        const changed = state.currentRoomId !== this.connection.roomId;
        if (changed || roleChanged) {
            this.roomGeneration++;
            this.snapshotRequest++;
            this.roundRepair.clear();
        }
        const next = {
            ...this.connection,
            rooms: state.rooms,
            participation,
            onlinePlayerCount:
                state.members.filter((member) =>
                    member.status === 'active' && member.role !== 'spectator' && member.isOnline
                ).length,
            roomId: state.currentRoomId,
            snapshot: changed ? undefined : this.connection.snapshot,
            roundTransition: changed ? undefined : this.connection.roundTransition,
            lastHunterEvent: changed || roleChanged ? undefined : this.connection.lastHunterEvent
        };
        this.publish({
            ...next,
            diagnostics: {
                ...next.diagnostics,
                ...toRelicRoomDiagnostics(next, this.deps.authorityStatus()),
                lastSnapshotSource: changed ? undefined : next.diagnostics.lastSnapshotSource,
                commandInFlight: changed || roleChanged ? undefined : next.diagnostics.commandInFlight
            }
        });
        if (
            !this.current(attempt) || this.connection.roomId !== state.currentRoomId ||
            (!changed && !roleChanged) || !this.connection.diagnostics.middlewareConnected
        ) {
            return;
        }
        this.installRoomListeners();
        if (hydrate && state.currentRoomId && this.current(attempt) && this.connection.roomId === state.currentRoomId) {
            void this.hydrateRoom('room-hydration');
        }
    }

    private installRoomListeners(): void {
        this.roomListeners?.unsubscribe();
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        const listeners = this.deps.subscriptions();
        this.roomListeners = listeners;
        listeners.add(this.deps.onRoundTransitionMessage(attempt.roomId, {
            onTransition: (event) => this.acceptRoundTransition(attempt, event),
            onResyncRequired: () => {
                if (this.current(attempt, true)) {
                    void this.hydrateRoom('resync-recovery');
                }
            }
        }));
        if (!this.current(attempt, true)) {
            return;
        }
        listeners.add(this.deps.onHunterEventMessage(attempt.roomId, {
            principalId: attempt.session.clientId,
            playerId: attempt.session.sessionId,
            onEvent: (event) => this.acceptHunterEvent(attempt, event)
        }));
    }

    private acceptRoundTransition(attempt: RelicHuntersRuntime.Attempt, event: RelicRoundTransitionEvent): void {
        if (!this.current(attempt, true)) {
            return;
        }
        const snapshot = this.connection.snapshot;
        if (snapshot && snapshot.createdAtEpochMs !== event.createdAtEpochMs) {
            return;
        }
        this.publish({
            roundTransition: event,
            diagnostics: {
                ...this.connection.diagnostics,
                roundTransitionCues: [
                    ...this.connection.diagnostics.roundTransitionCues,
                    `${event.round}:${event.transition}`
                ].slice(-ROUND_TRANSITION_CUE_LOG_SIZE)
            }
        });
    }

    private acceptHunterEvent(attempt: RelicHuntersRuntime.Attempt, event: RelicHunterEvent): void {
        if (!this.current(attempt, true)) {
            return;
        }
        const feedback = acceptRelicHunterFeedback(this.connection, event);
        if (feedback) {
            this.publish(feedback);
        }
    }

    private receiveSnapshot(
        attempt: RelicHuntersRuntime.Attempt,
        event: RelicServerEvent,
        source: RelicSnapshotSource
    ): void {
        if (!this.current(attempt)) {
            return;
        }
        const snapshot = decodeRelicSnapshotPayload(event).right;
        if (snapshot && this.connection.roomId) {
            this.acceptSnapshot(snapshot, source, this.connection.roomId);
        }
    }

    private acceptSnapshot(snapshot: RelicPublicSnapshot, source: RelicSnapshotSource, roomId: string): boolean {
        const attempt = this.attempt();
        if (!attempt || attempt.roomId !== roomId) {
            return false;
        }
        const acceptance = classifyRelicSnapshotAcceptance({
            current: this.connection.snapshot,
            candidate: snapshot,
            expectedRoomId: roomId,
            allowSemanticRegression: source === 'rest-reset'
        });
        if (!acceptance.accepted) {
            this.diagnose(
                toIgnoredRelicSnapshotDiagnostics({
                    diagnostics: this.connection.diagnostics,
                    snapshot,
                    source,
                    reason: acceptance.reason
                })
            );
            return false;
        }
        this.publish({
            snapshot,
            ...expireRelicHunterFeedback(this.connection, snapshot),
            diagnostics: toAcceptedRelicSnapshotDiagnostics({
                state: this.connection,
                authority: this.deps.authorityStatus(),
                snapshot,
                source,
                nowEpochMs: this.deps.timers.nowMs()
            })
        });
        if (!this.current(attempt, true) || this.connection.snapshot !== snapshot) {
            return false;
        }
        if (source !== 'rallar-rtc') {
            this.publishSnapshotRepair();
        }
        this.roundRepair.observe(snapshot);
        if (this.current(attempt, true)) {
            this.entryChanged(this.deps.roomEntry.getState());
        }
        return true;
    }

    private async hydrateRoom(source: RelicSnapshotSource): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        const roomId = attempt.roomId;
        const request = ++this.snapshotRequest;
        const refreshesConnection = source === 'bootstrap' || source === 'room-hydration';
        try {
            if (this.admission.hasPending(attempt.roomId, attempt.session.sessionId)) {
                await this.deps.withParticipationLock(
                    attempt.roomId,
                    attempt.session.sessionId,
                    () => this.admission.reconcile(roomId, attempt.session.sessionId)
                );
                if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                    return;
                }
            }
            const existing = await this.deps.fetchSnapshot(attempt.roomId);
            if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                return;
            }
            const snapshot = existing ?? (this.connection.participation === 'player'
                ? await this.deps.initializeGame(attempt.roomId)
                : undefined);
            if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                return;
            }
            if (snapshot) {
                this.acceptSnapshot(snapshot, source, attempt.roomId);
            }
            else if (source === 'room-hydration') {
                this.publish({ snapshot: undefined });
            }
            if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                return;
            }
            this.finishHydration(refreshesConnection);
        }
        catch (error) {
            if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                return;
            }
            const message = toError(error).message;
            if (refreshesConnection) {
                this.phase('degraded', { snapshotReady: !!this.connection.snapshot, lastError: message }, {
                    error: message
                });
            }
            else {
                this.diagnose({ lastError: message });
            }
        }
    }

    private publishSnapshotRepair(): void {
        const attempt = this.attempt();
        const snapshot = this.connection.snapshot;
        if (
            this.connection.participation !== 'player' || !attempt?.roomId || !snapshot ||
            snapshot.roomId !== attempt.roomId
        ) {
            return;
        }
        void this.deps.publishRtcSnapshot(snapshot).catch((error) =>
            this.snapshotRepairFailed(attempt, toError(error))
        );
    }

    private snapshotRepairFailed(attempt: RelicHuntersRuntime.Attempt, error: Error): void {
        if (this.current(attempt, true)) {
            this.diagnose({ lastError: `RTC snapshot sync failed: ${error.message}` });
        }
    }

    private async authenticate(input: RelicAuthentication): Promise<void> {
        this.invalidateConnection();
        const generation = this.generation;
        this.phase('authenticating', { authenticated: false, middlewareConnected: false, lastError: undefined }, {
            error: undefined
        });
        if (!this.active || this.generation !== generation) {
            return;
        }
        try {
            const session = input.mode === 'login'
                ? await this.deps.login(input.username, input.password)
                : await this.deps.register(input.username, input.password, input.displayName);
            if (!this.active || !sameSession(this.deps.restoreSession(), session)) {
                return;
            }
            const authenticated = {
                generation: this.generation,
                roomGeneration: this.roomGeneration,
                session,
                roomId: this.connection.roomId
            };
            this.publish({ session });
            if (this.current(authenticated)) {
                await this.connect();
            }
        }
        catch (error) {
            if (!this.active || this.generation !== generation) {
                return;
            }
            const message = toError(error).message;
            this.phase('error', { lastError: message }, { error: message });
        }
    }

    private async logout(): Promise<void> {
        this.signedOut();
        try {
            await this.deps.logout();
        }
        finally {
            if (this.active && !this.deps.restoreSession()) {
                this.signedOut();
            }
        }
    }

    private async refreshRooms(): Promise<void> {
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        const request = ++this.roomRefreshRequest;
        this.publish({
            directory: { ...this.connection.directory, status: 'loading', error: undefined },
            error: this.connection.snapshot ? this.connection.error : undefined
        });
        if (!this.current(attempt) || request !== this.roomRefreshRequest) {
            return;
        }
        try {
            const state = await this.deps.refreshRooms();
            if (!this.current(attempt) || request !== this.roomRefreshRequest) {
                return;
            }
            this.adoptRoom(state, true);
            if (this.current(attempt, true) && request === this.roomRefreshRequest && !this.connection.snapshot) {
                await this.hydrateRoom('room-hydration');
            }
            if (this.current(attempt) && request === this.roomRefreshRequest) {
                await this.deps.directory.refresh();
            }
        }
        catch (error) {
            if (this.current(attempt) && request === this.roomRefreshRequest) {
                this.publish({
                    directory: {
                        ...this.connection.directory,
                        status: 'error',
                        error: toError(error).message
                    }
                });
            }
        }
    }

    private async createRoom(
        joinMode: GroupJoinMode,
        directoryListing: GroupDirectoryListing | undefined
    ): Promise<GroupSnapshot | undefined> {
        if (this.blocksRoomChange()) {
            this.operationFailed(new Error('Use Leave expedition before creating another room.'));
            return undefined;
        }
        const attempt = this.attempt();
        if (!attempt || !this.connection.diagnostics.middlewareConnected) {
            return undefined;
        }
        this.deps.roomEntry.cancel();
        if (!this.current(attempt)) {
            return;
        }
        this.phase('joining-room', { lastError: undefined }, { error: undefined });
        if (!this.current(attempt)) {
            return;
        }
        const displayName = createRelicRoomName(
            this.deps.createRoomNameSeed(),
            this.connection.rooms.map((room) => room.name)
        );
        let snapshot: GroupSnapshot;
        try {
            snapshot = await this.deps.createRoom(displayName, joinMode, directoryListing);
        }
        catch (error) {
            if (!this.current(attempt)) {
                return undefined;
            }
            const failure = toError(error);
            const admitted = toCreatedRelicRoomSnapshot(failure);
            if (!admitted) {
                this.operationFailed(failure);
                throw error;
            }
            snapshot = admitted;
            this.publish({
                error:
                    'The new expedition room was created, but leaving the previous room failed. Your membership there remains.'
            });
        }
        if (!this.current(attempt)) {
            return undefined;
        }
        const completed = await this.finishRoomChange(attempt, snapshot.group.groupId);
        return completed ? snapshot : undefined;
    }

    private blocksRoomChange(): boolean {
        return this.connection.diagnostics.commandInFlight !== undefined ||
            this.admission.blocksDeparture(this.connection);
    }

    private async joinRoom(roomId: string, participation: 'preserve' | 'player' | 'spectator'): Promise<void> {
        if (
            this.blocksRoomChange() && (this.connection.diagnostics.commandInFlight !== undefined ||
                participation === 'spectator' || roomId !== this.connection.roomId)
        ) {
            this.operationFailed(new Error('Use Leave expedition before entering or watching another expedition.'));
            return;
        }
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        this.deps.roomEntry.cancel();
        if (!this.current(attempt)) {
            return;
        }
        this.phase('joining-room', { lastError: undefined }, { error: undefined });
        if (!this.current(attempt)) {
            return;
        }
        try {
            await this.deps.joinRoom(roomId, participation);
            if (this.current(attempt)) {
                await this.finishRoomChange(attempt, roomId);
            }
        }
        catch (error) {
            if (this.current(attempt)) {
                this.operationFailed(toError(error));
            }
        }
    }

    private async joinAsPlayer(): Promise<void> {
        if (!this.connection.roomId || this.connection.participation !== 'spectator') {
            return;
        }
        if (
            this.connection.snapshot &&
            (this.connection.snapshot.phase !== 'lobby' && this.connection.snapshot.phase !== 'finished' ||
                this.connection.snapshot.phase === 'lobby' &&
                    this.connection.snapshot.players.length >= RELIC_EXPEDITION_CAPACITY)
        ) {
            return;
        }
        await this.joinRoom(this.connection.roomId, 'player');
    }

    private depart(leaveRoom: boolean): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return Promise.resolve();
        }
        return this.departures.run(
            `${attempt.generation}:${attempt.roomGeneration}`,
            () => this.finishDeparture(attempt, leaveRoom)
        );
    }

    private async finishDeparture(attempt: RelicHuntersRuntime.Attempt, leaveRoom: boolean): Promise<void> {
        if (this.connection.diagnostics.commandInFlight) {
            this.operationFailed(new Error('Wait for the current expedition command before leaving.'));
            return;
        }
        this.diagnose({ commandInFlight: 'leave-expedition' });
        try {
            await this.deps.withParticipationLock(attempt.roomId ?? '', attempt.session.sessionId, async () => {
                if (!this.current(attempt, true)) {
                    return;
                }
                await this.withdrawExpedition(attempt);
                if (leaveRoom && attempt.roomId && this.current(attempt, true)) {
                    await this.deps.leaveRoom(attempt.roomId);
                    if (this.current(attempt)) {
                        this.adoptRoom(this.deps.roomState(), false);
                    }
                }
            });
        }
        catch (error) {
            if (this.current(attempt, true)) {
                this.operationFailed(toError(error));
            }
        }
        finally {
            if (this.current(attempt, true) && this.connection.diagnostics.commandInFlight === 'leave-expedition') {
                this.diagnose({ commandInFlight: undefined });
            }
        }
    }

    /** Membership may be removed only after the game authority confirms withdrawal, not after WS admission. */
    private async withdrawExpedition(attempt: RelicHuntersRuntime.Attempt): Promise<void> {
        if (!attempt.roomId || this.connection.participation !== 'player') {
            return;
        }
        if (!this.connection.snapshot) {
            throw new Error('Expedition state is not ready. Refresh before leaving.');
        }
        const snapshot = await this.admission.withdraw(
            { roomId: attempt.roomId, session: attempt.session },
            () => this.current(attempt, true)
        );
        if (!this.current(attempt, true)) {
            return;
        }
        if (!snapshot) {
            throw new Error('Expedition state is not ready. Refresh before leaving.');
        }
        this.acceptSnapshot(snapshot, 'rest-command', attempt.roomId);
        if (
            this.connection.snapshot?.createdAtEpochMs !== snapshot.createdAtEpochMs ||
            hasUnfinishedRelicParticipation(this.connection.snapshot, attempt.session.sessionId)
        ) {
            throw new Error('Expedition changed while leaving. Stay in the room and try again.');
        }
        this.phase('ready', { snapshotReady: true, lastError: undefined }, { error: undefined });
    }

    private async finishRoomChange(attempt: RelicHuntersRuntime.Attempt, roomId: string): Promise<boolean> {
        if (!this.current(attempt)) {
            return false;
        }
        const presence = await this.deps.waitForPresence(roomId, {
            expect: { sessionIds: [attempt.session.sessionId] },
            signal: this.bootstrap?.signal,
            timeoutMs: 10_000
        });
        if (!this.current(attempt)) {
            return false;
        }
        if (presence.status !== 'ready') {
            this.operationFailed(
                new Error('Room admission succeeded, but presence is not ready. Try entering the room again.')
            );
            return false;
        }
        this.adoptRoom(this.deps.roomState(), false);
        const joined = {
            ...attempt,
            roomId,
            roomGeneration: this.roomGeneration,
            participation: this.connection.participation
        };
        if (!this.current(joined, true)) {
            return false;
        }
        await this.hydrateRoom('room-hydration');
        if (!this.current(joined, true)) {
            return false;
        }
        this.phase(this.connection.snapshot || this.connection.participation === 'spectator' ? 'ready' : 'degraded', {
            ...toRelicRoomDiagnostics(this.connection, this.deps.authorityStatus()),
            lastHydratedAtEpochMs: this.deps.timers.nowMs(),
            lastError: this.connection.snapshot || this.connection.participation === 'spectator'
                ? undefined
                : 'No current relic snapshot accepted for room.'
        });
        return this.current(joined, true);
    }

    private operationFailed(error: Error): void {
        const message = error.message;
        this.phase('error', { lastError: message }, { error: message });
    }

    private sendRematchCommand(input: RelicRematchDraft): Promise<void> {
        const draft = createRelicRematchDraft({
            snapshot: this.connection.snapshot,
            room: this.deps.roomState().currentRoom,
            sessionId: this.connection.session?.sessionId,
            now: this.deps.timers.nowMs(),
            request: input
        });
        return draft ? this.sendCommand(draft) : Promise.resolve();
    }

    private async sendCommand(input: RelicCommandDraft): Promise<void> {
        const attempt = this.attempt();
        if (
            !attempt?.roomId || this.connection.participation !== 'player' ||
            this.connection.diagnostics.commandInFlight !== undefined
        ) {
            return;
        }
        const key = input.kind;
        if (input.kind !== 'join-expedition' && this.admission.hasPending(attempt.roomId, attempt.session.sessionId)) {
            return;
        }
        this.publish({
            error: undefined,
            diagnostics: { ...this.connection.diagnostics, commandInFlight: key, lastError: undefined }
        });
        if (!this.current(attempt, true)) {
            return;
        }
        try {
            const outcome = await deliverRelicCommand({
                dependencies: this.deps,
                participation: this.admission,
                draft: input,
                attempt: { ...attempt, roomId: attempt.roomId },
                isCurrent: () => this.current(attempt, true)
            });
            if (outcome === undefined || !this.current(attempt, true)) {
                return;
            }
            if (outcome.transport === 'rest' && outcome.snapshot) {
                this.acceptSnapshot(outcome.snapshot, 'rest-command', attempt.roomId);
            }
            if (!this.current(attempt, true)) {
                return;
            }
            const result = toRelicCommandPhase(outcome, !!this.connection.snapshot);
            this.phase(
                result.phase,
                { ...result.patch, lastHydratedAtEpochMs: this.deps.timers.nowMs() },
                { error: result.error || this.connection.error }
            );
        }
        catch (error) {
            this.commandFailed(attempt, input, toError(error));
        }
        finally {
            if (this.current(attempt, true) && this.connection.diagnostics.commandInFlight === key) {
                this.diagnose({ commandInFlight: undefined });
            }
        }
    }

    private commandFailed(attempt: RelicHuntersRuntime.Attempt, input: RelicCommandDraft, error: Error): void {
        if (!this.current(attempt, true)) {
            return;
        }
        if (
            input.kind === 'continue-review' && error.message.includes('There is no review to continue') &&
            this.connection.snapshot?.phase !== 'review'
        ) {
            this.phase('ready', { snapshotReady: !!this.connection.snapshot, lastError: undefined });
            return;
        }
        this.phase('degraded', { lastError: error.message }, { error: error.message });
    }

    private async resetExpedition(): Promise<void> {
        const attempt = this.attempt();
        if (
            !attempt?.roomId || this.connection.participation !== 'player' ||
            this.connection.diagnostics.commandInFlight !== undefined ||
            this.admission.hasPending(attempt.roomId, attempt.session.sessionId)
        ) {
            return;
        }
        this.diagnose({ commandInFlight: 'reset-expedition', lastError: undefined });
        if (!this.current(attempt, true)) {
            return;
        }
        try {
            const snapshot = await this.deps.resetGame(attempt.roomId);
            if (!this.current(attempt, true)) {
                return;
            }
            if (snapshot) {
                this.acceptSnapshot(snapshot, 'rest-reset', attempt.roomId);
            }
            if (!this.current(attempt, true)) {
                return;
            }
            this.phase(this.connection.snapshot ? 'ready' : 'degraded', {
                snapshotReady: !!this.connection.snapshot,
                lastHydratedAtEpochMs: this.deps.timers.nowMs(),
                lastError: snapshot ? undefined : 'No relic snapshot returned for reset.'
            });
        }
        catch (error) {
            if (!this.current(attempt, true)) {
                return;
            }
            const message = toError(error).message;
            this.phase('degraded', { lastError: message }, { error: message });
        }
        finally {
            if (this.current(attempt, true)) {
                this.diagnose({ commandInFlight: undefined });
            }
        }
    }

    private finishHydration(refreshesConnection: boolean): void {
        if (refreshesConnection) {
            this.phase(this.connection.snapshot ? 'ready' : 'connected', {
                ...toRelicRoomDiagnostics(this.connection, this.deps.authorityStatus()),
                lastError: undefined
            });
        }
        else {
            this.diagnose({ lastError: undefined });
        }
    }
}

function sameSession(left: AuthSession | undefined, right: AuthSession): boolean {
    return left?.sessionId === right.sessionId && left?.clientId === right.clientId;
}
