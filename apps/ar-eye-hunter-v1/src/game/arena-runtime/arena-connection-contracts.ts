import type { WebSocketTicketBackoffState } from '@shared-web/browser/auth/websocket-ticket-http-api.ts';
import type {
    RallarDirectorStatus,
    RallarRealtimeLaneHealth,
    RallarRoomSummary,
    RallarRtcDiagnostics,
    RallarRtcStatus,
    RallarWsStatus
} from '@shared-web/browser/rallar.ts';
import type { RallarGameHostAppointResult } from '@shared-web/game/director/rallar-game-director-appointment-contracts.ts';
import type { RallarGameDiagnostics } from '@shared-web/game/mod.ts';
import type { ALReceiptMode } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { AuthSessionStorageKind } from '@shared/api/auth.ts';

import type { ArenaLinkState, ArenaPresenceNotice } from '../squadLink.ts';
import type {
    ArenaEvent,
    ArenaMatchDurationMs,
    ArenaMatchLifecycleMessage,
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
    ShotAccepted
} from '../types.ts';

export type ArenaConnectionState = 'signed-out' | 'connecting' | 'connected' | 'error';
export type ArenaAiStatus =
    | 'idle'
    | 'generating'
    | 'loading model'
    | 'webllm'
    | 'accepted'
    | 'error'
    | 'unavailable';

export type DirectorAttemptSource = 'manual' | 'auto';

export interface CapabilityDelivery {
    readonly state: 'pending' | 'confirmed' | 'failed' | 'expired' | 'superseded' | 'cancelled' | 'unobservable';
    readonly evidence: ALDeliveryState;
    readonly reason: string | undefined;
}

/** The logical receipt of the latest match lifecycle output this director published. */
export interface MatchDelivery {
    readonly output: ArenaMatchLifecycleMessage['kind'];
    readonly state: ALDeliveryState;
    /** Undefined until the first receipt settles. */
    readonly receiptMode: ALReceiptMode | undefined;
    readonly expectedRecipientPeerIds: readonly string[];
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly reason: string | undefined;
}

interface IdleDirectorAttempt {
    readonly status: 'idle';
    readonly source?: never;
    readonly startedAtEpochMs?: never;
    readonly finishedAtEpochMs?: never;
    readonly durationMs?: never;
    readonly reason?: never;
    readonly resultStatus?: never;
    readonly capabilityDelivery?: never;
}

interface PendingDirectorAttempt {
    readonly status: 'pending';
    readonly source: DirectorAttemptSource;
    readonly startedAtEpochMs: number;
    readonly finishedAtEpochMs?: never;
    readonly durationMs?: never;
    readonly reason?: never;
    readonly resultStatus?: never;
    /** Absent when no WS handle was returned, or reporting has not completed. */
    readonly capabilityDelivery: CapabilityDelivery | undefined;
}

export interface FinishedDirectorAttempt {
    readonly status: 'succeeded' | 'not-elected' | 'not-ready' | 'failed';
    readonly source: DirectorAttemptSource;
    readonly startedAtEpochMs: number;
    readonly finishedAtEpochMs: number;
    readonly durationMs: number;
    readonly reason: string | undefined;
    readonly resultStatus: RallarGameHostAppointResult['status'];
    /** Absent when reporting did not return a WS handle. */
    readonly capabilityDelivery: CapabilityDelivery | undefined;
}

export type DirectorAttemptState = IdleDirectorAttempt | PendingDirectorAttempt | FinishedDirectorAttempt;

export interface HttpProbeDiagnostics {
    readonly status: 'idle' | 'ok' | 'error';
    readonly durationMs?: number;
    readonly checkedAtEpochMs?: number;
    readonly reason?: string;
    readonly detail?: string;
}

export interface ArenaTransportDiagnostics {
    readonly refreshedAtEpochMs?: number;
    readonly ws?: RallarWsStatus;
    readonly rtc?: RallarRtcStatus;
    readonly realtimeHealth: readonly RallarRealtimeLaneHealth[];
    readonly rtcDiagnostics?: RallarRtcDiagnostics;
    readonly wsTicketBackoff?: WebSocketTicketBackoffState;
    readonly error?: string;
}

export interface ArenaHttpDiagnostics {
    readonly apiConfig: HttpProbeDiagnostics;
    readonly ice: HttpProbeDiagnostics;
}

export interface ArenaDiagnosticsRefreshOptions {
    readonly includeRtcStats?: boolean;
}

export interface ArenaConnection {
    readonly session?: AuthSession;
    readonly connectionState: ArenaConnectionState;
    readonly error?: string;
    readonly roomId?: string;
    readonly rooms: readonly RallarRoomSummary[];
    readonly directorStatus: RallarDirectorStatus;
    readonly rtcLanes: readonly RtcLaneStatus[];
    readonly directorAttempt: DirectorAttemptState;
    /** Undefined until this director publishes a match lifecycle output in the current network generation. */
    readonly matchDelivery: MatchDelivery | undefined;
    readonly gameDiagnostics?: RallarGameDiagnostics;
    readonly transportDiagnostics: ArenaTransportDiagnostics;
    readonly httpDiagnostics: ArenaHttpDiagnostics;
    readonly linkState: ArenaLinkState;
    readonly presenceNotices: readonly ArenaPresenceNotice[];
    readonly authStorageKind: AuthSessionStorageKind;
    readonly authGeneration: number;
    readonly networkEnabled: boolean;
    readonly logoutQuiesced: boolean;
    readonly aiStatus: ArenaAiStatus;
    readonly aiError?: string;
    readonly activeEvent?: ArenaEvent;
    readonly arenaSnapshot?: ArenaSnapshot;
    readonly remoteEvents: readonly ArenaEvent[];
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly remoteShots: readonly RemoteShot[];
    readonly remotePlayerHits: readonly PlayerHitAccepted[];
    readonly pickupAcceptances: readonly PickupAccepted[];
    login(username: string, password: string): Promise<void>;
    register(
        username: string,
        password: string,
        displayName?: string
    ): Promise<void>;
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
        accepted: ShotAccepted
    ): void;
    sendPlayerHit(intent: PlayerHitIntent): void;
    sendPickupIntent(intent: PickupIntent): void;
    startArenaMatch(durationMs: ArenaMatchDurationMs): Promise<void>;
    publishArenaSnapshot(snapshot: ArenaSnapshot): void;
}
