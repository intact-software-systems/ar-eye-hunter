import {
    decodeRelicSnapshotPayload,
    RELIC_PROTOCOL_VERSION,
    type RelicActionInput,
    type RelicCharacterId,
    type RelicCommand,
    type RelicHunterEvent,
    type RelicPublicSnapshot,
    type RelicRoundTransitionEvent,
    type RelicServerEvent
} from '@relic-hunters/mod.ts';
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
import type { RallarRecentRooms } from '@shared-web/browser/rooms/recent-rooms/rallar-recent-rooms.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { validateAuthoritativeGroupSnapshot } from '@shared/api/authoritative-state-validation.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';
import { SynchronousNotifications } from '@shared/cache/synchronous-notifications.ts';
import {
    createRallarAiFunnyRoomName,
    type RallarAiFunnyRoomNameTheme
} from '@shared/rallar-ai/mod.ts';
import type { RallarGameAuthorityClientStatus } from '@shared/rallar-game/mod.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { RelicRoundDeadlineRepair } from './relic-round-deadline-repair.ts';
import {
    createInitialRelicRuntimeDiagnostics,
    toRelicRuntimeSnapshotSummary,
    type RelicRuntimeDiagnostics
} from './relic-runtime-diagnostics.ts';
import {
    classifyRelicSnapshotAcceptance,
    type RelicSnapshotSource
} from './relic-snapshot-ordering.ts';
import type { RelicWsCommandDelivery } from './send-relic-ws-command.ts';
import type { RelicHunterEventSubscription } from './subscribe-relic-hunter-events.ts';
import type { RelicRoundTransitionSubscription } from './subscribe-relic-round-transitions.ts';
import { toRelicCommandPhase, type RelicCommandOutcome } from './to-relic-command-phase.ts';

export const RELIC_ROOM_NAME_THEME: RallarAiFunnyRoomNameTheme = {
    id: 'relic-hunters',
    defaultBaseName: 'Relic Hunters Expedition',
    nouns: [
        'Teacup',
        'Compass',
        'Pickle',
        'Noodle',
        'Lantern',
        'Keycard',
        'Scroll',
        'Dojo',
        'Kiosk',
        'Satchel',
        'Map',
        'Pebble'
    ]
};
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
export type RelicCommandDraft =
    | { readonly kind: 'join-expedition'; readonly characterId?: RelicCharacterId; }
    | { readonly kind: 'start-expedition'; }
    | { readonly kind: 'take-keeper'; }
    | { readonly kind: 'submit-action'; readonly action: RelicActionInput; }
    | { readonly kind: 'force-resolve-round'; }
    | { readonly kind: 'pickup-relic'; readonly relicId: string; }
    | { readonly kind: 'continue-review'; }
    | { readonly kind: 'set-round-limit'; readonly timeLimitMs: number; };

interface RelicAuthentication {
    readonly mode: 'login' | 'register';
    readonly username: string;
    readonly password: string;
    readonly displayName: string | undefined;
}

export namespace RelicHuntersRuntime {
    export interface Dependencies {
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
        fetchSnapshot(roomId: string): Promise<RelicPublicSnapshot | undefined>;
        sendWsCommand(roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined>;
        sendRestCommand(roomId: string, command: RelicCommand): Promise<RelicPublicSnapshot | undefined>;
        resetGame(roomId: string): Promise<RelicPublicSnapshot | undefined>;
    }

    export interface Connection {
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
    private bootstrap: AbortController | undefined;
    private lifecycle: RallarSubscriptionScope | undefined;
    private transport: RallarSubscriptionScope | undefined;
    private roomListeners: RallarSubscriptionScope | undefined;
    private snapshotRequest = 0;
    private roomRefreshRequest = 0;
    private stopSnapshotRepair: (() => void) | undefined;
    private readonly roundRepair: RelicRoundDeadlineRepair;

    public constructor(deps: RelicHuntersRuntime.Dependencies) {
        this.deps = deps;
        this.roundRepair = new RelicRoundDeadlineRepair({
            timers: deps.timers,
            refresh: () => this.hydrateRoom('timeout-repair')
        }, { intervalMs: SNAPSHOT_REPAIR_INTERVAL_MS });
        const session = deps.restoreSession();
        this.connection = {
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

    private actions(): Pick<
        RelicHuntersRuntime.Connection,
        | 'login'
        | 'register'
        | 'logout'
        | 'refreshRooms'
        | 'createRoom'
        | 'joinRoom'
        | 'watchRoom'
        | 'joinAsPlayer'
        | 'leaveRoom'
        | 'leaveExpedition'
        | 'takeKeeper'
        | 'joinExpedition'
        | 'startExpedition'
        | 'submitAction'
        | 'forceResolveRound'
        | 'pickupRelic'
        | 'continueReview'
        | 'setRoundLimit'
        | 'resetExpedition'
    > {
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
            leaveRoom: () => this.leaveRoom(),
            leaveExpedition: () => this.leaveExpedition(),
            takeKeeper: () => this.sendCommand({ kind: 'take-keeper' }),
            joinExpedition: (characterId) => this.sendCommand({ kind: 'join-expedition', characterId }),
            startExpedition: () => this.sendCommand({ kind: 'start-expedition' }),
            submitAction: (action) => this.sendCommand({ kind: 'submit-action', action }),
            forceResolveRound: () => this.sendCommand({ kind: 'force-resolve-round' }),
            pickupRelic: (relicId) => this.sendCommand({ kind: 'pickup-relic', relicId }),
            continueReview: () => this.continueReview(),
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
        if (
            state.status === 'pending' && this.hasUnfinishedParticipation() &&
            (state.destination?.participation === 'spectator' ||
                state.destination?.roomRef.groupId !== this.connection.roomId)
        ) {
            this.deps.roomEntry.cancel();
            this.operationFailed(new Error('Use Leave expedition before entering or watching another expedition.'));
            return;
        }
        if (this.active && this.connection.diagnostics.middlewareConnected && state.status === 'pending') {
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
            ...this.roomDiagnostics(this.connection, true)
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
        if (this.deps.roomEntry.getState().status === 'pending') {
            await this.deps.roomEntry.resume();
        }
        if (this.current(attempt)) {
            await this.hydrateRoom('bootstrap');
        }
    }

    private roomDiagnostics(
        state: RelicHuntersRuntime.Connection = this.connection,
        connected = state.diagnostics.middlewareConnected
    ): Partial<RelicRuntimeDiagnostics> {
        const authority = this.deps.authorityStatus();
        const roomReady = !!state.roomId;
        return {
            roomId: state.roomId,
            roomReady,
            snapshotReady: !!state.snapshot,
            rtcReady: connected && roomReady,
            authorityReady: connected && roomReady && !!authority?.started,
            authorityPhase: authority?.phase,
            authorityPeerAssistReadyPeers: authority?.peerAssist.readyPeerIds.length ?? 0
        };
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
                ...this.roomDiagnostics(next),
                lastSnapshotSource: changed ? undefined : next.diagnostics.lastSnapshotSource,
                commandInFlight: roleChanged ? undefined : next.diagnostics.commandInFlight
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
        if (event.kind === 'command-refused' && this.connection.snapshot?.phase === 'finished') {
            return;
        }
        const previous = this.connection.lastHunterEvent;
        const priorRefusalDisplayed = previous?.kind === 'command-refused' && this.connection.error === previous.text;
        this.publish({
            lastHunterEvent: event,
            error: event.kind === 'command-refused'
                ? event.text
                : priorRefusalDisplayed
                ? undefined
                : this.connection.error
        });
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
            this.diagnose({
                ignoredSnapshotCount: this.connection.diagnostics.ignoredSnapshotCount + 1,
                lastIgnoredSnapshotReason: acceptance.reason,
                lastIgnoredSnapshot: toRelicRuntimeSnapshotSummary(snapshot, source)
            });
            return false;
        }
        const previous = this.connection.snapshot;
        const feedback = this.connection.lastHunterEvent;
        const refusalExpired = feedback?.kind === 'command-refused' && previous !== undefined && (
            previous.createdAtEpochMs !== snapshot.createdAtEpochMs ||
            previous.round !== snapshot.round || previous.phase !== snapshot.phase
        );
        this.publish({
            snapshot,
            lastHunterEvent: refusalExpired ? undefined : feedback,
            error: refusalExpired && this.connection.error === feedback?.text ? undefined : this.connection.error,
            diagnostics: {
                ...this.connection.diagnostics,
                ...this.roomDiagnostics(),
                snapshotReady: true,
                lastSnapshotSource: source,
                lastAcceptedSnapshot: toRelicRuntimeSnapshotSummary(snapshot, source),
                lastIgnoredSnapshotReason: undefined,
                lastIgnoredSnapshot: undefined,
                lastHydratedAtEpochMs: this.deps.timers.nowMs()
            }
        });
        if (!this.current(attempt, true) || this.connection.snapshot !== snapshot) {
            return false;
        }
        if (source !== 'rallar-rtc') {
            this.publishSnapshotRepair();
        }
        this.roundRepair.observe(snapshot);
        return true;
    }

    private async hydrateRoom(source: RelicSnapshotSource): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        const request = ++this.snapshotRequest;
        const refreshesConnection = source === 'bootstrap' || source === 'room-hydration';
        try {
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
            if (refreshesConnection) {
                this.phase(this.connection.snapshot ? 'ready' : 'connected', {
                    ...this.roomDiagnostics(),
                    lastError: undefined
                });
            }
            else {
                this.diagnose({ lastError: undefined });
            }
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
        this.publish({ directory: { ...this.connection.directory, status: 'loading', error: undefined } });
        if (!this.current(attempt) || request !== this.roomRefreshRequest) {
            return;
        }
        try {
            const state = await this.deps.refreshRooms();
            if (!this.current(attempt) || request !== this.roomRefreshRequest) {
                return;
            }
            this.adoptRoom(state, true);
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
        if (this.hasUnfinishedParticipation()) {
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
        const displayName = createRallarAiFunnyRoomName({
            baseName: RELIC_ROOM_NAME_THEME.defaultBaseName,
            theme: RELIC_ROOM_NAME_THEME,
            seed: this.deps.createRoomNameSeed(),
            existingNames: this.connection.rooms.map((room) => room.name)
        });
        let snapshot: GroupSnapshot;
        try {
            snapshot = await this.deps.createRoom(displayName, joinMode, directoryListing);
        }
        catch (error) {
            if (!this.current(attempt)) {
                return undefined;
            }
            const failure = toError(error);
            const admitted = toCreatedRoomSnapshot(failure);
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

    private hasUnfinishedParticipation(): boolean {
        return this.connection.participation === 'player' && this.connection.snapshot?.phase !== 'finished' &&
            this.connection.snapshot?.players.some((player) =>
                    player.playerId === this.connection.session?.sessionId && player.withdrawnAtEpochMs === undefined
                ) === true;
    }

    private async joinRoom(roomId: string, participation: 'preserve' | 'player' | 'spectator'): Promise<void> {
        if (this.hasUnfinishedParticipation() && (participation === 'spectator' || roomId !== this.connection.roomId)) {
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
            (this.connection.snapshot.phase !== 'lobby' || this.connection.snapshot.players.length >= 4)
        ) {
            return;
        }
        await this.joinRoom(this.connection.roomId, 'player');
    }

    private async leaveExpedition(): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        try {
            await this.withdrawExpedition(attempt);
        }
        catch (error) {
            if (this.current(attempt, true)) {
                this.operationFailed(toError(error));
            }
        }
    }

    /** Membership may be removed only after the game authority confirms withdrawal, not after WS admission. */
    private async withdrawExpedition(attempt: RelicHuntersRuntime.Attempt): Promise<void> {
        if (!attempt.roomId || !this.hasUnfinishedParticipation()) {
            return;
        }
        const snapshot = await this.deps.sendRestCommand(attempt.roomId, {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: attempt.roomId,
            username: attempt.session.username,
            kind: 'leave-expedition'
        });
        if (!this.current(attempt, true)) {
            return;
        }
        if (
            !snapshot ||
            snapshot.players.some((player) =>
                player.playerId === attempt.session.sessionId && player.withdrawnAtEpochMs === undefined
            )
        ) {
            throw new Error('Withdrawal has not been confirmed. Stay in the room and try again.');
        }
        this.acceptSnapshot(snapshot, 'rest-command', attempt.roomId);
        if (this.current(attempt, true)) {
            this.phase('ready', { snapshotReady: true, lastError: undefined }, { error: undefined });
        }
    }

    private async leaveRoom(): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        try {
            await this.withdrawExpedition(attempt);
            if (!this.current(attempt, true)) {
                return;
            }
            await this.deps.leaveRoom(attempt.roomId);
            if (this.current(attempt)) {
                this.adoptRoom(this.deps.roomState(), false);
            }
        }
        catch (error) {
            if (this.current(attempt, true)) {
                this.operationFailed(toError(error));
            }
        }
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
            ...this.roomDiagnostics(),
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

    private async continueReview(): Promise<void> {
        if (this.connection.snapshot?.phase === 'review') {
            await this.sendCommand({ kind: 'continue-review' });
        }
    }

    private async sendCommand(input: RelicCommandDraft): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId || this.connection.participation !== 'player') {
            return;
        }
        const key = commandInFlightKey(input);
        if (this.connection.diagnostics.commandInFlight === key) {
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
            const command: RelicCommand = {
                protocolVersion: RELIC_PROTOCOL_VERSION,
                gameId: attempt.roomId,
                username: attempt.session.username,
                ...input
            };
            const delivery = await this.deps.sendWsCommand(attempt.roomId, command);
            if (!this.current(attempt, true)) {
                return;
            }
            // REST is used only before a WS server is known; never retry a WS attempt over REST.
            const outcome: RelicCommandOutcome = delivery === undefined
                ? { transport: 'rest', snapshot: await this.deps.sendRestCommand(attempt.roomId, command) }
                : { transport: 'ws', delivery };
            if (!this.current(attempt, true)) {
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
        const message = toError(error).message;
        if (
            input.kind === 'continue-review' && message.includes('There is no review to continue') &&
            this.connection.snapshot?.phase !== 'review'
        ) {
            this.phase('ready', { snapshotReady: !!this.connection.snapshot, lastError: undefined });
            return;
        }
        this.phase('degraded', { lastError: message }, { error: message });
    }

    private async resetExpedition(): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId || this.connection.participation !== 'player') {
            return;
        }
        this.publish({ error: undefined });
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
    }
}

function sameSession(left: AuthSession | undefined, right: AuthSession): boolean {
    return left?.sessionId === right.sessionId && left?.clientId === right.clientId;
}

function toCreatedRoomSnapshot(error: Error): GroupSnapshot | undefined {
    if (
        error.name !== 'RallarRoomSwitchPartialFailureError' ||
        !('operation' in error) || error.operation !== 'create-and-switch' || !('joinedRoom' in error)
    ) {
        return undefined;
    }
    try {
        // The committed result identifies this creation even while its cached room is absent or replaced.
        validateAuthoritativeGroupSnapshot(error.joinedRoom);
        return error.joinedRoom;
    }
    catch {
        return undefined;
    }
}

function commandInFlightKey(input: RelicCommandDraft): string {
    if (input.kind === 'submit-action') {
        return `${input.kind}:${JSON.stringify(input.action)}`;
    }
    if (input.kind === 'pickup-relic') {
        return `${input.kind}:${input.relicId}`;
    }
    return input.kind;
}
