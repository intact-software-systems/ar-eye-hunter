import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuthSessionStorageKind } from '@shared/api/auth.ts';
import type {
    RallarDirectorStatus,
    RallarRealtimeLaneHealth,
    RallarRoomSummary,
    RallarRtcDiagnostics,
    RallarRtcStatus,
    RallarWsStatus,
} from '@shared-web/browser/rallar.ts';
import type {
    WebSocketTicketBackoffState,
} from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';

import type {
    ArenaEvent,
    ArenaMatchDurationMs,
    ArenaSnapshot,
    PickupAccepted,
    PickupIntent,
    PlayerHitAccepted,
    PlayerHitIntent,
    PlayerPose,
    PlayerShot,
    RemotePlayer,
    RemoteShot,
    RtcLaneStatus,
    ShotAccepted,
} from '../types.ts';
import type { ArenaLinkState, ArenaPresenceNotice } from '../squadLink.ts';

export type ArenaConnectionState = 'signed-out' | 'connecting' | 'connected' | 'error';
export type ArenaAiStatus =
    | 'idle'
    | 'generating'
    | 'loading model'
    | 'webllm'
    | 'mock fallback'
    | 'accepted'
    | 'error'
    | 'unavailable';

export type DirectorAttemptSource = 'manual' | 'auto';

export type DirectorAttemptState = Readonly<{
    source?: DirectorAttemptSource;
    status: 'idle' | 'pending' | 'succeeded' | 'not-elected' | 'not-ready' | 'failed';
    resultStatus?: string;
    reason?: string;
    startedAtEpochMs?: number;
    finishedAtEpochMs?: number;
    durationMs?: number;
}>;

export type HttpProbeDiagnostics = Readonly<{
    status: 'idle' | 'ok' | 'error';
    durationMs?: number;
    checkedAtEpochMs?: number;
    reason?: string;
    detail?: string;
}>;

export type ArenaTransportDiagnostics = Readonly<{
    refreshedAtEpochMs?: number;
    ws?: RallarWsStatus;
    rtc?: RallarRtcStatus;
    realtimeHealth: readonly RallarRealtimeLaneHealth[];
    rtcDiagnostics?: RallarRtcDiagnostics;
    wsTicketBackoff?: WebSocketTicketBackoffState;
    error?: string;
}>;

export type ArenaHttpDiagnostics = Readonly<{
    apiConfig: HttpProbeDiagnostics;
    ice: HttpProbeDiagnostics;
}>;

export type ArenaDiagnosticsRefreshOptions = Readonly<{
    includeRtcStats?: boolean;
}>;

export type ArenaConnection = Readonly<{
    session?: AuthSession;
    connectionState: ArenaConnectionState;
    error?: string;
    roomId?: string;
    rooms: readonly RallarRoomSummary[];
    directorStatus: RallarDirectorStatus;
    rtcLanes: readonly RtcLaneStatus[];
    directorAttempt: DirectorAttemptState;
    gameDiagnostics?: RallarGameDiagnostics;
    transportDiagnostics: ArenaTransportDiagnostics;
    httpDiagnostics: ArenaHttpDiagnostics;
    linkState: ArenaLinkState;
    presenceNotices: readonly ArenaPresenceNotice[];
    authStorageKind: AuthSessionStorageKind;
    authGeneration: number;
    networkEnabled: boolean;
    logoutQuiesced: boolean;
    aiStatus: ArenaAiStatus;
    aiError?: string;
    activeEvent?: ArenaEvent;
    arenaSnapshot?: ArenaSnapshot;
    remoteEvents: readonly ArenaEvent[];
    remotePlayers: ReadonlyMap<string, RemotePlayer>;
    remoteShots: readonly RemoteShot[];
    remotePlayerHits: readonly PlayerHitAccepted[];
    pickupAcceptances: readonly PickupAccepted[];
    login(username: string, password: string): Promise<void>;
    register(username: string, password: string, displayName?: string): Promise<void>;
    logout(): Promise<void>;
    refreshRooms(): Promise<void>;
    createArenaRoom(): Promise<void>;
    joinRoom(roomId: string): Promise<void>;
    appointSelfAsDirector(): Promise<void>;
    refreshDiagnostics(options?: ArenaDiagnosticsRefreshOptions): Promise<void>;
    requestArenaSync(): Promise<void>;
    dismissPresenceNotice(id: string): void;
    sendPose(pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>): void;
    sendShot(
        shot: Omit<PlayerShot, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted,
    ): void;
    sendPlayerHit(intent: PlayerHitIntent): void;
    sendPickupIntent(intent: PickupIntent): void;
    startArenaMatch(durationMs: ArenaMatchDurationMs): Promise<void>;
    publishArenaSnapshot(snapshot: ArenaSnapshot): void;
}>;
