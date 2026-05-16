import { rallar, type RallarRoomState } from '@shared-web/browser/rallar.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    RELIC_PROTOCOL_VERSION,
    RELIC_TOPICS,
    RELIC_TYPES,
    type RelicActionInput,
    type RelicCharacterId,
    type RelicCommand,
    type RelicPublicSnapshot,
    type RelicServerEvent,
} from '@relic-hunters/mod.ts';
import { fetchRelicSnapshot, resetRelicGame, sendRelicCommand } from './api.ts';
import type { RelicSnapshotRejectionReason, RelicSnapshotSource } from './relic-snapshot-ordering.ts';

export const RELIC_ROOM_NAME = 'Relic Hunters Expedition';
export const RELIC_COMMAND_TRANSPORT = 'rest' as const;
export const RELIC_SNAPSHOT_TRANSPORT = 'rallar-ws' as const;

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
    | Readonly<{ kind: 'join-expedition'; characterId?: RelicCharacterId }>
    | Readonly<{ kind: 'start-expedition' }>
    | Readonly<{ kind: 'submit-action'; action: RelicActionInput }>
    | Readonly<{ kind: 'set-round-limit'; timeLimitMs: number }>;

export type RelicRuntimeDiagnostics = Readonly<{
    phase: RelicHuntersRuntimePhase;
    commandTransport: typeof RELIC_COMMAND_TRANSPORT;
    snapshotTransport: typeof RELIC_SNAPSHOT_TRANSPORT;
    authenticated: boolean;
    middlewareConnected: boolean;
    roomReady: boolean;
    snapshotReady: boolean;
    wsListenerReady: boolean;
    roomListenerReady: boolean;
    rtcReady: boolean;
    roomId?: string;
    commandInFlight?: string;
    ignoredSnapshotCount: number;
    lastSnapshotSource?: string;
    lastAcceptedSnapshot?: RelicRuntimeSnapshotSummary;
    lastIgnoredSnapshotReason?: RelicSnapshotRejectionReason;
    lastIgnoredSnapshot?: RelicRuntimeSnapshotSummary;
    lastHydratedAtEpochMs?: number;
    lastError?: string;
}>;

export type RelicRuntimeSnapshotSummary = Readonly<{
    source: RelicSnapshotSource;
    gameId: string;
    roomId: string;
    phase: string;
    round: number;
    updatedAtEpochMs: number;
    playerCount: number;
    submittedCount: number;
    eventCount: number;
    roomInvestigationCount: number;
}>;

export type RelicRuntimeHydration = Readonly<{
    session: AuthSession;
    roomState: RallarRoomState;
    snapshot?: RelicPublicSnapshot;
    unsubscribe(): void;
    snapshotListenerReady: boolean;
    roomListenerReady: boolean;
    degradedError?: string;
}>;

export type RelicRoomHydration = Readonly<{
    roomId: string;
    roomState: RallarRoomState;
    snapshot?: RelicPublicSnapshot;
}>;

export type RelicHuntersRuntimeDeps = Readonly<{
    restoreSession(): AuthSession | undefined;
    login(username: string, password: string): Promise<AuthSession>;
    register(username: string, password: string, displayName?: string): Promise<AuthSession>;
    logout(): Promise<void>;
    connect(): Promise<void>;
    refreshRooms(): Promise<RallarRoomState>;
    onRoomsChange(handler: (state: RallarRoomState) => void): () => void;
    onSnapshotMessage(handler: (event: RelicServerEvent) => void): () => void;
    createRoom(displayName: string): Promise<{ group: { groupId: string } }>;
    joinRoom(roomId: string): Promise<{ group: { groupId: string } }>;
    fetchSnapshot(roomId: string): Promise<RelicPublicSnapshot | undefined>;
    sendCommand(roomId: string, command: RelicCommand): Promise<RelicPublicSnapshot | undefined>;
    resetGame(roomId: string): Promise<RelicPublicSnapshot | undefined>;
}>;

export class RelicHuntersRuntime {
    constructor(private readonly deps: RelicHuntersRuntimeDeps = browserRelicRuntimeDeps()) {}

    restoreSession(): AuthSession | undefined {
        return this.deps.restoreSession();
    }

    async login(username: string, password: string): Promise<AuthSession> {
        return this.deps.login(username, password);
    }

    async register(
        username: string,
        password: string,
        displayName?: string,
    ): Promise<AuthSession> {
        return this.deps.register(username, password, displayName);
    }

    async logout(): Promise<void> {
        await this.deps.logout();
    }

    async connectAndHydrate(
        onSnapshot: (event: RelicServerEvent) => void,
        onRoomsChange: (state: RallarRoomState) => void,
    ): Promise<RelicRuntimeHydration | undefined> {
        const session = this.deps.restoreSession();
        if (!session) {
            return undefined;
        }

        await this.deps.connect();
        const unsubscribeSnapshot = this.deps.onSnapshotMessage(onSnapshot);
        const unsubscribeRooms = this.deps.onRoomsChange(onRoomsChange);
        const unsubscribe = () => {
            unsubscribeSnapshot();
            unsubscribeRooms();
        };

        const roomState = await this.deps.refreshRooms();
        const roomId = roomState.currentRoomId;
        if (!roomId) {
            return {
                session,
                roomState,
                unsubscribe,
                snapshotListenerReady: true,
                roomListenerReady: true,
            };
        }

        try {
            return {
                session,
                roomState,
                snapshot: await this.deps.fetchSnapshot(roomId),
                unsubscribe,
                snapshotListenerReady: true,
                roomListenerReady: true,
            };
        } catch (error) {
            return {
                session,
                roomState,
                unsubscribe,
                snapshotListenerReady: true,
                roomListenerReady: true,
                degradedError: toErrorMessage(error),
            };
        }
    }

    async refreshRooms(): Promise<RallarRoomState> {
        return this.deps.refreshRooms();
    }

    async fetchSnapshot(roomId: string): Promise<RelicPublicSnapshot | undefined> {
        return this.deps.fetchSnapshot(roomId);
    }

    async createRoom(): Promise<RelicRoomHydration> {
        const created = await this.deps.createRoom(RELIC_ROOM_NAME);
        return this.hydrateRoom(created.group.groupId);
    }

    async joinRoom(roomId: string): Promise<RelicRoomHydration> {
        const joined = await this.deps.joinRoom(roomId);
        return this.hydrateRoom(joined.group.groupId);
    }

    async sendCommand(
        session: AuthSession,
        roomId: string,
        input: RelicCommandDraft,
    ): Promise<RelicPublicSnapshot | undefined> {
        // Browser gameplay keeps REST as the authoritative command transport.
        // Rallar WS is used for live snapshot fanout and late-arriving updates.
        const command = {
            protocolVersion: RELIC_PROTOCOL_VERSION,
            gameId: roomId,
            username: session.username,
            ...input,
        } as RelicCommand;

        return this.deps.sendCommand(roomId, command);
    }

    async resetExpedition(roomId: string): Promise<RelicPublicSnapshot | undefined> {
        return this.deps.resetGame(roomId);
    }

    private async hydrateRoom(roomId: string): Promise<RelicRoomHydration> {
        const snapshot = await this.deps.fetchSnapshot(roomId);
        const roomState = await this.deps.refreshRooms();
        return {
            roomId,
            roomState,
            snapshot,
        };
    }
}

export function initialRelicDiagnostics(
    session: AuthSession | undefined,
): RelicRuntimeDiagnostics {
    return {
        phase: session ? 'connecting' : 'signed-out',
        commandTransport: RELIC_COMMAND_TRANSPORT,
        snapshotTransport: RELIC_SNAPSHOT_TRANSPORT,
        authenticated: !!session,
        middlewareConnected: false,
        roomReady: false,
        snapshotReady: false,
        wsListenerReady: false,
        roomListenerReady: false,
        rtcReady: false,
        roomId: undefined,
        commandInFlight: undefined,
        ignoredSnapshotCount: 0,
        lastSnapshotSource: undefined,
        lastAcceptedSnapshot: undefined,
        lastIgnoredSnapshotReason: undefined,
        lastIgnoredSnapshot: undefined,
        lastHydratedAtEpochMs: undefined,
        lastError: undefined,
    };
}

function browserRelicRuntimeDeps(): RelicHuntersRuntimeDeps {
    return {
        restoreSession: () => rallar.auth.restore(),
        login: (username, password) => rallar.auth.login({ username, password }),
        register: (username, password, displayName) =>
            rallar.auth.registerAndLogin({
                username,
                password,
                displayName: displayName || username,
            }),
        logout: () => rallar.auth.logout(),
        connect: async () => {
            await rallar.connect();
        },
        refreshRooms: () => rallar.rooms.refresh(),
        onRoomsChange: (handler) => rallar.rooms.onChange(handler),
        onSnapshotMessage: (handler) =>
            rallar.messages.ws.onMessage<RelicServerEvent>(
                {
                    topicId: RELIC_TOPICS.snapshot,
                    typeId: RELIC_TYPES.snapshot,
                },
                (message) => handler(message.payload),
            ),
        createRoom: (displayName) => rallar.rooms.create({ displayName }),
        joinRoom: (roomId) => rallar.rooms.join(roomId),
        fetchSnapshot: (roomId) => fetchRelicSnapshot(roomId),
        sendCommand: (roomId, command) => sendRelicCommand(roomId, command),
        resetGame: (roomId) => resetRelicGame(roomId),
    };
}

export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
