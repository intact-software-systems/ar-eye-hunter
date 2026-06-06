export const GAME_PROTOCOL = 'ar-eye-hunter.v1';
export const GAME_LANE_ID = 'realtime';
export const GAME_MOTION_LANE_ID = 'motion';
export const GAME_COMBAT_LANE_ID = 'combat';
export const GAME_FX_LANE_ID = 'fx';
export const GAME_AI_LANE_ID = 'ai-events';
export const GAME_ROOM_NAME = 'AR Eye Hunter Arena';
export const GAME_DIRECTOR_TOPIC_ID = 'ar-eye-hunter.director';
export const GAME_DIRECTOR_INTENT_TYPE_ID = 'ar-eye-hunter.director.intent.v1';
export const GAME_DIRECTOR_OUTPUT_TYPE_ID = 'ar-eye-hunter.director.output.v1';
export const GAME_DIRECTOR_HEARTBEAT_TYPE_ID = 'ar-eye-hunter.director.heartbeat.v1';
export const GAME_DIRECTOR_SNAPSHOT_TYPE_ID = 'ar-eye-hunter.director.snapshot.v1';
export const GAME_DIRECTOR_SYNC_REQUEST_TYPE_ID = 'ar-eye-hunter.director.sync-request.v1';
export const GAME_AI_TOPIC_ID = 'ar-eye-hunter.ai-director';
export const GAME_AI_PROPOSAL_TYPE_ID = 'ar-eye-hunter.ai-director.proposal.v1';
export const GAME_AI_ACCEPTED_TYPE_ID = 'ar-eye-hunter.ai-director.accepted.v1';

export type Vec3Tuple = readonly [number, number, number];

export type TargetRarity = 'common' | 'volatile' | 'bounty' | 'rift';

export type EyeTargetState = Readonly<{
    id: string;
    position: Vec3Tuple;
    velocity: Vec3Tuple;
    radius: number;
    health: number;
    maxHealth: number;
    rarity: TargetRarity;
    phase: number;
    color: string;
    bountyUntilEpochMs?: number;
}>;

export type PlayerInputState = Readonly<{
    moveX: number;
    moveZ: number;
    sprint: boolean;
    dash: boolean;
    slide: boolean;
    jump: boolean;
    fire: boolean;
    altFire: boolean;
    overdrive: boolean;
    pause: boolean;
}>;

export type PlayerCombatState = Readonly<{
    score: number;
    combo: number;
    multiplier: number;
    energy: number;
    overdrive: number;
    overdriveActiveUntilEpochMs?: number;
    lastHitAtEpochMs?: number;
    dashReadyAtEpochMs: number;
    slideReadyAtEpochMs: number;
    shotReadyAtEpochMs: number;
}>;

export type PlayerPose = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
    velocity?: Vec3Tuple;
    angularVelocity?: Vec3Tuple;
    score: number;
    combo?: number;
    overdrive?: number;
    seq: number;
    sentAtEpochMs: number;
}>;

export type ShotIntent = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    origin: Vec3Tuple;
    direction: Vec3Tuple;
    charged?: boolean;
    overdrive?: boolean;
    seq: number;
    sentAtEpochMs: number;
}>;

export type PlayerShot = ShotIntent;

export type ShotAccepted = Readonly<{
    shot: ShotIntent;
    hit: boolean;
    targetId?: string;
    impact: Vec3Tuple;
    scoreDelta: number;
    combo: number;
    multiplier: number;
    overdrive: number;
    revision: number;
    acceptedAtEpochMs: number;
}>;

export type ArenaEventKind =
    | 'spawn-eye'
    | 'mutate-target'
    | 'arena-shift'
    | 'hazard-burst'
    | 'combo-bounty'
    | 'reward-drop'
    | 'overdrive-window';

export type ArenaEvent = Readonly<{
    id: string;
    kind: ArenaEventKind;
    targetId?: string;
    position?: Vec3Tuple;
    radius?: number;
    intensity?: number;
    durationMs?: number;
    rarity?: TargetRarity;
    scoreBonus?: number;
    startsAtEpochMs: number;
    expiresAtEpochMs: number;
    revision: number;
    source: 'director' | 'ai' | 'local';
    headline?: string;
}>;

export type ArenaSnapshot = Readonly<{
    protocol: typeof GAME_PROTOCOL;
    roomId?: string;
    revision: number;
    seed: number;
    targets: readonly EyeTargetState[];
    events: readonly ArenaEvent[];
    activeEvent?: ArenaEvent;
    sentAtEpochMs: number;
}>;

export type AiDirectorProposalValue = Readonly<{
    event: Omit<ArenaEvent, 'id' | 'startsAtEpochMs' | 'expiresAtEpochMs' | 'revision' | 'source'>;
    urgency: 'low' | 'medium' | 'high';
    reason: string;
}>;

export type AiDirectorProposal = Readonly<{
    generationId: string;
    dedupeKey: string;
    baseStateRevision: string;
    value: AiDirectorProposalValue;
    accepted: boolean;
    sentAtEpochMs: number;
}>;

export type RtcLaneStatus = Readonly<{
    laneId: string;
    status: 'idle' | 'open' | 'partial' | 'closed' | 'unavailable';
    readyPeers: number;
    notReadyPeers: number;
}>;

export type ArenaFxEvent = Readonly<{
    id: string;
    kind: 'tracer' | 'impact' | 'shockwave' | 'dash';
    origin?: Vec3Tuple;
    direction?: Vec3Tuple;
    position?: Vec3Tuple;
    color: string;
    sentAtEpochMs: number;
}>;

export type GameRealtimeMessage =
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'player-pose';
    pose: PlayerPose;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'player-shot';
    shot: PlayerShot;
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
    kind: 'director-player-state';
    pose: PlayerPose;
}>
    | Readonly<{
    protocol: typeof GAME_PROTOCOL;
    kind: 'director-shot-event';
    shot: PlayerShot;
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

export type RemotePlayer = Readonly<{
    pose: PlayerPose;
    lastSeenEpochMs: number;
}>;

export type RemoteShot = Readonly<{
    id: string;
    accepted?: ShotAccepted;
    shot: PlayerShot;
    receivedAtEpochMs: number;
}>;
