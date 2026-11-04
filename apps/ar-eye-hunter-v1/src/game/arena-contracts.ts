import type {
    ArenaEvent,
    ArenaSnapshot,
    EyeAttackAccepted,
    GAME_PROTOCOL,
    MatchEndedAccepted,
    MatchStartedAccepted,
    MatchStartIntent,
    PickupAccepted,
    PickupIntent,
    PlayerHitAccepted,
    PlayerHitIntent,
    PlayerLoadoutState,
    PlayerVitalsState,
    ShotAccepted,
    ShotIntent,
    Vec3Tuple
} from '@ar-eye-hunter/arena-contracts.ts';
import type { ArenaRematchCommand } from '@ar-eye-hunter/arena-rematch.ts';
import type { AvatarProfile } from './avatarProfile.ts';
export const GAME_LANE_ID = 'realtime';
export const GAME_MOTION_LANE_ID = 'motion';
export const GAME_COMBAT_LANE_ID = 'combat';
export const GAME_FX_LANE_ID = 'fx';
export const GAME_AI_LANE_ID = 'ai-events';
export const GAME_ROOM_NAME = 'AR Eye Hunter Arena';
export const GAME_DIRECTOR_TOPIC_ID = 'room.ar-eye-hunter.director';
export const GAME_AI_TOPIC_ID = 'room.ar-eye-hunter.ai-director';
export const GAME_AI_PROPOSAL_TYPE_ID = 'ar-eye-hunter.ai-director.proposal.v1';
export const GAME_AI_ACCEPTED_TYPE_ID = 'ar-eye-hunter.ai-director.accepted.v1';

export interface PlayerPose {
    readonly sessionId: string;
    readonly username: string;
    readonly color: string;
    readonly avatarProfile?: AvatarProfile;
    readonly position: Vec3Tuple;
    readonly rotation: Vec3Tuple;
    readonly velocity?: Vec3Tuple;
    readonly angularVelocity?: Vec3Tuple;
    readonly score: number;
    readonly combo?: number;
    readonly overdrive?: number;
    readonly vitals?: PlayerVitalsState;
    readonly loadout?: PlayerLoadoutState;
    readonly seq: number;
    readonly sentAtEpochMs: number;
}

export interface AiDirectorProposalValue {
    readonly event: Omit<ArenaEvent, 'id' | 'startsAtEpochMs' | 'expiresAtEpochMs' | 'revision' | 'source'>;
    readonly urgency: 'low' | 'medium' | 'high';
    readonly reason: string;
}

export interface AiDirectorProposal {
    readonly generationId: string;
    readonly dedupeKey: string;
    readonly baseStateRevision: string;
    readonly value: AiDirectorProposalValue;
    readonly accepted: boolean;
    readonly sentAtEpochMs: number;
}

export interface RtcLaneStatus {
    readonly laneId: string;
    readonly status: 'idle' | 'open' | 'partial' | 'closed' | 'unavailable';
    readonly readyPeers: number;
    readonly notReadyPeers: number;
}

export interface ArenaFxEvent {
    readonly id: string;
    readonly kind: 'tracer' | 'impact' | 'shockwave' | 'dash';
    readonly origin?: Vec3Tuple;
    readonly direction?: Vec3Tuple;
    readonly position?: Vec3Tuple;
    readonly color: string;
    readonly sentAtEpochMs: number;
}

export type GameRealtimeMessage =
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'player-pose';
        pose: PlayerPose;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'player-shot';
        shot: ShotIntent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'player-shot-intent';
        shot: ShotIntent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'player-pose-intent';
        pose: PlayerPose;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-shot-accepted';
        accepted: ShotAccepted;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'player-hit-intent';
        intent: PlayerHitIntent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-player-hit-accepted';
        accepted: PlayerHitAccepted;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'pickup-intent';
        intent: PickupIntent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-pickup-accepted';
        accepted: PickupAccepted;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'match-rematch-intent';
        command: ArenaRematchCommand;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'match-start-intent';
        intent: MatchStartIntent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-rematch-refused';
        sessionId: string;
        completedGameId: string;
        message: string;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-match-started';
        accepted: MatchStartedAccepted;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-match-ended';
        accepted: MatchEndedAccepted;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-eye-attack-accepted';
        accepted: EyeAttackAccepted;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-player-state';
        pose: PlayerPose;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-shot-event';
        shot: ShotIntent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'arena-event';
        event: ArenaEvent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-arena-snapshot';
        snapshot: ArenaSnapshot;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'ai-director-proposal';
        proposal: AiDirectorProposal;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'fx-event';
        event: ArenaFxEvent;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-heartbeat';
        sessionId: string;
        sentAtEpochMs: number;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-state-snapshot';
        players: readonly PlayerPose[];
        sentAtEpochMs: number;
    }>
    | Readonly<{
        protocol: typeof GAME_PROTOCOL;
        kind: 'director-sync-request';
        sessionId: string;
        sentAtEpochMs: number;
    }>;

export type ArenaMatchLifecycleMessage = Extract<
    GameRealtimeMessage,
    Readonly<{ kind: 'director-match-started' | 'director-match-ended'; }>
>;

export interface RemotePlayer {
    readonly pose: PlayerPose;
    readonly lastSeenEpochMs: number;
}

export interface RemoteShot {
    readonly id: string;
    readonly accepted?: ShotAccepted;
    readonly shot: ShotIntent;
    readonly receivedAtEpochMs: number;
}
