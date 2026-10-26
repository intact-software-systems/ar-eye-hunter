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
import type { RallarRecentRooms, RallarRoomEntry } from '@shared-web/browser/rallar-room-entry.ts';
import type {
    ALDeliveryState,
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
import type { AuthSession } from '@shared/api/api-config.ts';
import type { GroupDirectoryListing } from '@shared/api/group-directory/group-directory-listing.ts';
import type { GroupJoinMode, GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createRallarAiFunnyRoomName,
    createRallarAiRoomNameSeed,
    type RallarAiFunnyRoomNameTheme
} from '@shared/rallar-ai/mod.ts';
import type { RallarGameAuthorityClientStatus } from '@shared/rallar-game/mod.ts';
import { SingleFlight } from '@shared/resilience/single-flight.ts';
import { startRepeating } from '@shared/resilience/start-repeating.ts';
import type { Timers } from '@shared/resilience/timers.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    classifyRelicSnapshotAcceptance,
    type RelicSnapshotRejectionReason,
    type RelicSnapshotSource
} from './relic-snapshot-ordering.ts';
import type { RelicWsCommandDelivery } from './send-relic-ws-command.ts';
import type { RelicHunterEventSubscription } from './subscribe-relic-hunter-events.ts';
import type { RelicRoundTransitionSubscription } from './subscribe-relic-round-transitions.ts';
import { toRelicCommandPhase } from './to-relic-command-phase.ts';

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
export const RELIC_SNAPSHOT_TRANSPORT = 'rallar-ws+rtc';
const SNAPSHOT_REPAIR_INTERVAL_MS = 2_000;
const ROUND_TRANSITION_CUE_LOG_SIZE = 16;

export type RelicCommandTransport = 'ws' | 'rest';
export type RelicCommandOutcome =
    | { readonly transport: 'ws'; readonly delivery: RelicWsCommandDelivery; }
    | { readonly transport: 'rest'; readonly snapshot: RelicPublicSnapshot | undefined; };
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
    | { readonly kind: 'submit-action'; readonly action: RelicActionInput; }
    | { readonly kind: 'force-resolve-round'; }
    | { readonly kind: 'pickup-relic'; readonly relicId: string; }
    | { readonly kind: 'continue-review'; }
    | { readonly kind: 'set-round-limit'; readonly timeLimitMs: number; };

export interface RelicRuntimeDiagnostics {
    readonly phase: RelicHuntersRuntimePhase;
    readonly commandTransport: RelicCommandTransport;
    readonly lastCommandDelivery: ALDeliveryState | undefined;
    readonly snapshotTransport: typeof RELIC_SNAPSHOT_TRANSPORT;
    readonly authenticated: boolean;
    readonly middlewareConnected: boolean;
    readonly roomReady: boolean;
    readonly snapshotReady: boolean;
    readonly wsListenerReady: boolean;
    readonly roomListenerReady: boolean;
    readonly rtcReady: boolean;
    readonly authorityReady: boolean;
    readonly authorityPhase: RallarGameAuthorityClientStatus['phase'] | undefined;
    readonly authorityPeerAssistReadyPeers: number;
    readonly roomId: string | undefined;
    readonly commandInFlight: string | undefined;
    readonly ignoredSnapshotCount: number;
    readonly lastSnapshotSource: RelicSnapshotSource | undefined;
    readonly lastAcceptedSnapshot: RelicRuntimeSnapshotSummary | undefined;
    readonly lastIgnoredSnapshotReason: RelicSnapshotRejectionReason | undefined;
    readonly lastIgnoredSnapshot: RelicRuntimeSnapshotSummary | undefined;
    readonly lastHydratedAtEpochMs: number | undefined;
    readonly roundTransitionCues: readonly string[];
    readonly lastError: string | undefined;
}

export interface RelicRuntimeSnapshotSummary {
    readonly source: RelicSnapshotSource;
    readonly gameId: string;
    readonly roomId: string;
    readonly phase: string;
    readonly round: number;
    readonly updatedAtEpochMs: number;
    readonly playerCount: number;
    readonly submittedCount: number;
    readonly eventCount: number;
    readonly roomInvestigationCount: number;
}

interface RelicAuthentication {
    readonly mode: 'login' | 'register';
    readonly username: string;
    readonly password: string;
    readonly displayName: string | undefined;
}

interface RelicRoundRepair {
    readonly key: string;
    readonly deadlineEpochMs: number;
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
        onRtcSnapshotMessage(handler: (event: RelicServerEvent) => void): RallarUnsubscribe;
        onAuthoritySnapshotMessage(handler: (event: RelicServerEvent) => void): RallarUnsubscribe;
        onRoundTransitionMessage(roomId: string, subscription: RelicRoundTransitionSubscription): RallarUnsubscribe;
        onHunterEventMessage(roomId: string, subscription: RelicHunterEventSubscription): RallarUnsubscribe;
        authorityStatus(): RallarGameAuthorityClientStatus | undefined;
        publishRtcSnapshot(snapshot: RelicPublicSnapshot): Promise<boolean>;
        createRoom(
            displayName: string,
            joinMode: GroupJoinMode,
            directoryListing?: GroupDirectoryListing
        ): Promise<GroupSnapshot>;
        joinRoom(roomId: string): Promise<void>;
        fetchSnapshot(roomId: string): Promise<RelicPublicSnapshot | undefined>;
        sendWsCommand(roomId: string, command: RelicCommand): Promise<RelicWsCommandDelivery | undefined>;
        sendRestCommand(roomId: string, command: RelicCommand): Promise<RelicPublicSnapshot | undefined>;
        resetGame(roomId: string): Promise<RelicPublicSnapshot | undefined>;
    }

    export interface Connection {
        readonly roomEntry: RallarRoomEntry;
        readonly recentRooms: RallarRecentRooms;
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
        readonly session: AuthSession;
        readonly roomId: string | undefined;
    }
}

/** Owns the page's authenticated connection, current expedition and delivery lifecycle. */
export class RelicHuntersRuntime {
    private readonly deps: RelicHuntersRuntime.Dependencies;
    private connection: RelicHuntersRuntime.Connection;
    private readonly listeners = new Set<() => void>();
    private active = false;
    private generation = 0;
    private readonly connectionStarts = new SingleFlight<string, void>();
    private bootstrap: AbortController | undefined;
    private lifecycle: RallarSubscriptionScope | undefined;
    private transport: RallarSubscriptionScope | undefined;
    private roomListeners: RallarSubscriptionScope | undefined;
    private snapshotRequest = 0;
    private roomRefreshRequest = 0;
    private stopSnapshotRepair: (() => void) | undefined;
    private cancelRoundRepair: (() => void) | undefined;
    private stopRoundRepair: (() => void) | undefined;
    private roundRepairKey = '';

    public constructor(deps: RelicHuntersRuntime.Dependencies) {
        this.deps = deps;
        const session = deps.restoreSession();
        this.connection = {
            roomEntry: deps.roomEntry,
            recentRooms: deps.recentRooms,
            session,
            connectionState: session ? 'connecting' : 'signed-out',
            diagnostics: initialRelicDiagnostics(session),
            error: undefined,
            roomId: undefined,
            rooms: [],
            directory: { status: 'idle', entries: [], error: undefined },
            snapshot: undefined,
            roundTransition: undefined,
            lastHunterEvent: undefined,
            ...this.actions()
        };
    }

    public readonly getState = (): RelicHuntersRuntime.Connection => this.connection;
    public readonly subscribe = (listener: () => void): RallarUnsubscribe => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    public async start(): Promise<void> {
        if (this.active) {
            return;
        }
        this.active = true;
        this.diagnose({ middlewareConnected: false });
        this.deps.roomEntry.start();
        void this.deps.recentRooms.start();
        this.lifecycle = this.deps.subscriptions();
        this.lifecycle.add(this.deps.onAuthChange((state) => this.authChanged(state)));
        this.lifecycle.add(this.deps.roomEntry.onChange((state) => this.entryChanged(state)));
        await this.connect();
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
            joinRoom: (roomId) => this.joinRoom(roomId),
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
        for (const listener of this.listeners) {
            listener();
        }
    }

    private diagnose(patch: Partial<RelicRuntimeDiagnostics>): void {
        this.publish({ diagnostics: { ...this.connection.diagnostics, ...patch } });
    }

    private phase(phase: RelicHuntersRuntimePhase, patch: Partial<RelicRuntimeDiagnostics> = {}): void {
        this.publish({ connectionState: phase, diagnostics: { ...this.connection.diagnostics, ...patch, phase } });
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
        this.publish({
            session: state.session,
            connectionState: 'connecting',
            diagnostics: initialRelicDiagnostics(state.session),
            roomId: undefined,
            rooms: [],
            directory: { status: 'idle', entries: [], error: undefined },
            snapshot: undefined,
            roundTransition: undefined,
            lastHunterEvent: undefined
        });
        void this.connect();
    }

    private entryChanged(state: RallarRoomEntry.State): void {
        if (this.active && this.connection.diagnostics.middlewareConnected && state.status === 'pending') {
            void this.deps.roomEntry.resume();
        }
    }

    private signedOut(): void {
        this.invalidateConnection();
        this.publish({
            session: undefined,
            connectionState: 'signed-out',
            diagnostics: initialRelicDiagnostics(undefined),
            roomId: undefined,
            rooms: [],
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
        this.clearRoundRepair();
    }

    private attempt(): RelicHuntersRuntime.Attempt | undefined {
        const session = this.connection.session;
        return this.active && session
            ? { generation: this.generation, session, roomId: this.connection.roomId }
            : undefined;
    }

    private current(attempt: RelicHuntersRuntime.Attempt, requireRoom = false): boolean {
        return this.active && this.generation === attempt.generation &&
            sameSession(this.deps.restoreSession(), attempt.session) &&
            (!requireRoom || this.connection.roomId === attempt.roomId);
    }

    private connect(): Promise<void> {
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
        this.publish({ session, error: undefined, diagnostics: initialRelicDiagnostics(session) });
        this.phase('connecting');
        const attempt = this.attempt();
        if (!attempt) {
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
            this.publish({ error: message });
            this.phase('error', { lastError: message });
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
            .add(this.deps.onRtcSnapshotMessage((event) => this.receiveSnapshot(attempt, event, 'rallar-rtc')))
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
            ...this.roomDiagnostics(true)
        });
        this.installRoomListeners();
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
        connected = this.connection.diagnostics.middlewareConnected
    ): Partial<RelicRuntimeDiagnostics> {
        const authority = this.deps.authorityStatus();
        const roomReady = !!this.connection.roomId;
        return {
            roomId: this.connection.roomId,
            roomReady,
            snapshotReady: !!this.connection.snapshot,
            rtcReady: connected && roomReady,
            authorityReady: connected && roomReady && !!authority?.started,
            authorityPhase: authority?.phase,
            authorityPeerAssistReadyPeers: authority?.peerAssist.readyPeerIds.length ?? 0
        };
    }

    private adoptRoom(state: RallarRoomState, hydrate: boolean): void {
        const changed = state.currentRoomId !== this.connection.roomId;
        this.publish({ rooms: state.rooms, roomId: state.currentRoomId });
        if (changed) {
            this.snapshotRequest++;
            this.publish({ snapshot: undefined, roundTransition: undefined, lastHunterEvent: undefined });
            this.diagnose({ lastSnapshotSource: undefined });
            this.clearRoundRepair();
        }
        this.diagnose(this.roomDiagnostics());
        if (!changed || !this.connection.diagnostics.middlewareConnected) {
            return;
        }
        this.installRoomListeners();
        if (hydrate && state.currentRoomId) {
            void this.hydrateRoom('room-hydration');
        }
    }

    private installRoomListeners(): void {
        this.roomListeners?.unsubscribe();
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        this.roomListeners = this.deps.subscriptions();
        this.roomListeners.add(this.deps.onRoundTransitionMessage(attempt.roomId, {
            onTransition: (event) => this.acceptRoundTransition(attempt, event),
            onResyncRequired: () => {
                if (this.current(attempt, true)) {
                    void this.hydrateRoom('resync-recovery');
                }
            }
        }));
        this.roomListeners.add(this.deps.onHunterEventMessage(attempt.roomId, {
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
        this.publish({ roundTransition: event });
        this.diagnose({
            roundTransitionCues: [
                ...this.connection.diagnostics.roundTransitionCues,
                `${event.round}:${event.transition}`
            ].slice(-ROUND_TRANSITION_CUE_LOG_SIZE)
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
                lastIgnoredSnapshot: summarizeRuntimeSnapshot(snapshot, source)
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
            error: refusalExpired && this.connection.error === feedback?.text ? undefined : this.connection.error
        });
        this.diagnose({
            ...this.roomDiagnostics(),
            lastSnapshotSource: source,
            lastAcceptedSnapshot: summarizeRuntimeSnapshot(snapshot, source),
            lastIgnoredSnapshotReason: undefined,
            lastIgnoredSnapshot: undefined,
            lastHydratedAtEpochMs: this.deps.timers.nowMs()
        });
        if (source !== 'rallar-rtc') {
            this.publishSnapshotRepair();
        }
        this.scheduleRoundRepair(snapshot);
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
            const snapshot = await this.deps.fetchSnapshot(attempt.roomId);
            if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                return;
            }
            if (snapshot) {
                this.acceptSnapshot(snapshot, source, attempt.roomId);
            }
            else if (source === 'room-hydration') {
                this.publish({ snapshot: undefined });
            }
            this.diagnose({ lastError: undefined });
            if (refreshesConnection) {
                this.phase(this.connection.snapshot ? 'ready' : 'connected', this.roomDiagnostics());
            }
        }
        catch (error) {
            if (!this.current(attempt, true) || request !== this.snapshotRequest) {
                return;
            }
            const message = toError(error).message;
            this.diagnose({ lastError: message });
            if (refreshesConnection) {
                this.publish({ error: message });
                this.phase('degraded', { snapshotReady: !!this.connection.snapshot });
            }
        }
    }

    private publishSnapshotRepair(): void {
        const attempt = this.attempt();
        const snapshot = this.connection.snapshot;
        if (!attempt?.roomId || !snapshot || snapshot.roomId !== attempt.roomId) {
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

    private scheduleRoundRepair(snapshot: RelicPublicSnapshot): void {
        const repair = timedOutRoundRepair(snapshot);
        if (repair?.key === this.roundRepairKey) {
            return;
        }
        this.clearRoundRepair();
        if (!repair) {
            return;
        }
        this.roundRepairKey = repair.key;
        this.cancelRoundRepair = this.deps.timers.schedule(
            () => this.startRoundRepair(),
            Math.max(0, repair.deadlineEpochMs - this.deps.timers.nowMs())
        );
    }

    private startRoundRepair(): void {
        this.stopRoundRepair = startRepeating({
            timers: this.deps.timers,
            intervalMs: SNAPSHOT_REPAIR_INTERVAL_MS,
            firstRun: 'now',
            run: () => this.hydrateRoom('timeout-repair')
        });
    }

    private clearRoundRepair(): void {
        this.cancelRoundRepair?.();
        this.stopRoundRepair?.();
        this.cancelRoundRepair = undefined;
        this.stopRoundRepair = undefined;
        this.roundRepairKey = '';
    }

    private async authenticate(input: RelicAuthentication): Promise<void> {
        this.invalidateConnection();
        const generation = this.generation;
        this.publish({ error: undefined });
        this.phase('authenticating', { authenticated: false, middlewareConnected: false, lastError: undefined });
        try {
            const session = input.mode === 'login'
                ? await this.deps.login(input.username, input.password)
                : await this.deps.register(input.username, input.password, input.displayName);
            if (!this.active || !sameSession(this.deps.restoreSession(), session)) {
                return;
            }
            this.publish({ session });
            await this.connect();
        }
        catch (error) {
            if (!this.active || this.generation !== generation) {
                return;
            }
            const message = toError(error).message;
            this.publish({ error: message });
            this.phase('error', { lastError: message });
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
        try {
            const state = await this.deps.refreshRooms();
            if (!this.current(attempt) || request !== this.roomRefreshRequest) {
                return;
            }
            this.adoptRoom(state, true);
            await this.deps.directory.refresh();
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
        const attempt = this.attempt();
        if (!attempt || !this.connection.diagnostics.middlewareConnected) {
            return undefined;
        }
        this.deps.roomEntry.cancel();
        this.publish({ error: undefined });
        this.phase('joining-room', { lastError: undefined });
        const displayName = createRallarAiFunnyRoomName({
            baseName: RELIC_ROOM_NAME_THEME.defaultBaseName,
            theme: RELIC_ROOM_NAME_THEME,
            seed: createRallarAiRoomNameSeed('relic-hunters'),
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
            const admitted = this.deps.roomState().currentRoom;
            if (!admitted || !isCreatedRoomCleanupFailure(toError(error))) {
                this.operationFailed(toError(error));
                throw error;
            }
            snapshot = admitted;
            this.publish({
                error:
                    'The new expedition room is ready, but leaving the previous room failed. Your membership there remains.'
            });
        }
        if (!this.current(attempt)) {
            return undefined;
        }
        const completed = await this.finishRoomChange(attempt, snapshot.group.groupId);
        return completed ? snapshot : undefined;
    }

    private async joinRoom(roomId: string): Promise<void> {
        const attempt = this.attempt();
        if (!attempt) {
            return;
        }
        this.deps.roomEntry.cancel();
        this.publish({ error: undefined });
        this.phase('joining-room', { lastError: undefined });
        try {
            await this.deps.joinRoom(roomId);
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

    private async finishRoomChange(attempt: RelicHuntersRuntime.Attempt, roomId: string): Promise<boolean> {
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
        const joined = { ...attempt, roomId };
        if (!this.current(joined, true)) {
            return false;
        }
        await this.hydrateRoom('room-hydration');
        if (!this.current(joined, true)) {
            return false;
        }
        this.phase(this.connection.snapshot ? 'ready' : 'degraded', {
            ...this.roomDiagnostics(),
            lastHydratedAtEpochMs: this.deps.timers.nowMs(),
            lastError: this.connection.snapshot ? undefined : 'No current relic snapshot accepted for room.'
        });
        return true;
    }

    private operationFailed(error: Error): void {
        const message = error.message;
        this.publish({ error: message });
        this.phase('error', { lastError: message });
    }

    private async continueReview(): Promise<void> {
        if (this.connection.snapshot?.phase === 'review') {
            await this.sendCommand({ kind: 'continue-review' });
        }
    }

    private async sendCommand(input: RelicCommandDraft): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        const key = commandInFlightKey(input);
        if (this.connection.diagnostics.commandInFlight === key) {
            return;
        }
        this.publish({ error: undefined });
        this.diagnose({ commandInFlight: key, lastError: undefined });
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
            const result = toRelicCommandPhase(outcome, !!this.connection.snapshot);
            if (result.error) {
                this.publish({ error: result.error });
            }
            this.phase(result.phase, { ...result.patch, lastHydratedAtEpochMs: this.deps.timers.nowMs() });
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
        this.publish({ error: message });
        this.phase('degraded', { lastError: message });
    }

    private async resetExpedition(): Promise<void> {
        const attempt = this.attempt();
        if (!attempt?.roomId) {
            return;
        }
        this.publish({ error: undefined });
        try {
            const snapshot = await this.deps.resetGame(attempt.roomId);
            if (!this.current(attempt, true)) {
                return;
            }
            if (snapshot) {
                this.acceptSnapshot(snapshot, 'rest-reset', attempt.roomId);
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
            this.publish({ error: message });
            this.phase('degraded', { lastError: message });
        }
    }
}

function sameSession(left: AuthSession | undefined, right: AuthSession): boolean {
    return left?.sessionId === right.sessionId && left?.clientId === right.clientId;
}

function isCreatedRoomCleanupFailure(error: Error): boolean {
    return error.name === 'RallarRoomSwitchPartialFailureError' &&
        'operation' in error && error.operation === 'create-and-switch';
}

export function initialRelicDiagnostics(session: AuthSession | undefined): RelicRuntimeDiagnostics {
    return {
        phase: session ? 'connecting' : 'signed-out',
        commandTransport: 'ws',
        lastCommandDelivery: undefined,
        snapshotTransport: RELIC_SNAPSHOT_TRANSPORT,
        authenticated: !!session,
        middlewareConnected: false,
        roomReady: false,
        snapshotReady: false,
        wsListenerReady: false,
        roomListenerReady: false,
        rtcReady: false,
        authorityReady: false,
        authorityPhase: undefined,
        authorityPeerAssistReadyPeers: 0,
        roomId: undefined,
        commandInFlight: undefined,
        ignoredSnapshotCount: 0,
        lastSnapshotSource: undefined,
        lastAcceptedSnapshot: undefined,
        lastIgnoredSnapshotReason: undefined,
        lastIgnoredSnapshot: undefined,
        lastHydratedAtEpochMs: undefined,
        roundTransitionCues: [],
        lastError: undefined
    };
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

function summarizeRuntimeSnapshot(
    snapshot: RelicPublicSnapshot,
    source: RelicSnapshotSource
): RelicRuntimeSnapshotSummary {
    return {
        source,
        gameId: snapshot.gameId,
        roomId: snapshot.roomId,
        phase: snapshot.phase,
        round: snapshot.round,
        updatedAtEpochMs: snapshot.updatedAtEpochMs,
        playerCount: snapshot.players.length,
        submittedCount: snapshot.submittedPlayerIds.length,
        eventCount: snapshot.events.length,
        roomInvestigationCount: snapshot.roomInvestigations.length
    };
}

function timedOutRoundRepair(snapshot: RelicPublicSnapshot): RelicRoundRepair | undefined {
    if (snapshot.phase !== 'planning' || snapshot.roundStartedAtEpochMs === undefined) {
        return undefined;
    }
    const active = snapshot.players.filter((player) => !player.escaped && !player.defeated).length;
    const submitted = snapshot.submittedPlayerIds.length;
    if (active === 0 || submitted >= active) {
        return undefined;
    }
    const deadlineEpochMs = snapshot.roundStartedAtEpochMs + snapshot.roundTimeLimitMs;
    return {
        key: [snapshot.roomId, snapshot.createdAtEpochMs, snapshot.round, deadlineEpochMs, active, submitted].join(':'),
        deadlineEpochMs
    };
}
