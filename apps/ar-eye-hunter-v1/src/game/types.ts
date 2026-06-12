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

export type WeaponKind =
    | 'pulse-rifle'
    | 'spread-shot'
    | 'rail-lance'
    | 'glitch-blaster'
    | 'audit-pea-shooter'
    | 'confetti-cannon';

export type WeaponStats = Readonly<{
    kind: WeaponKind;
    label: string;
    tier: number;
    damage: number;
    cooldownMs: number;
    range: number;
    spreadRadians: number;
    rays: number;
    knockback: number;
    flavor: string;
}>;

export type ArenaLayoutTheme = Readonly<{
    base: string;
    grid: string;
    accent: string;
    warning: string;
    reward: string;
}>;

export type ArenaLayoutProp = Readonly<{
    id: string;
    kind: 'cover' | 'ramp' | 'portal' | 'bounce-pad' | 'hazard';
    position: Vec3Tuple;
    size: Vec3Tuple;
    rotationY?: number;
    blocksShots: boolean;
    label?: string;
}>;

export type ArenaLayoutSign = Readonly<{
    id: string;
    title: string;
    detail: string;
    position: Vec3Tuple;
    rotationY: number;
}>;

export type ArenaPickupAnchor = Readonly<{
    id: string;
    position: Vec3Tuple;
    weight?: number;
}>;

export type ArenaLayoutSpec = Readonly<{
    schema: 'ar-eye-hunter.arena-layout';
    version: '1';
    id: string;
    revision: number;
    name: string;
    halfSize: number;
    theme: ArenaLayoutTheme;
    spawnPoints: readonly Vec3Tuple[];
    pickupAnchors: readonly ArenaPickupAnchor[];
    props: readonly ArenaLayoutProp[];
    signs: readonly ArenaLayoutSign[];
}>;

export type ArenaPickupState = Readonly<{
    id: string;
    weaponKind: WeaponKind;
    tier: number;
    position: Vec3Tuple;
    anchorId: string;
    spawnedAtEpochMs: number;
    expiresAtEpochMs: number;
    pickedBySessionId?: string;
    pickedAtEpochMs?: number;
    label: string;
}>;

export type PlayerVitalsState = Readonly<{
    health: number;
    maxHealth: number;
    deaths: number;
    kills: number;
    deadUntilEpochMs?: number;
    respawnedAtEpochMs?: number;
    lastDamagedAtEpochMs?: number;
}>;

export type PlayerLoadoutState = Readonly<{
    weaponKind: WeaponKind;
    tier: number;
    pickedAtEpochMs?: number;
}>;

export type PlayerArenaState = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    position: Vec3Tuple;
    rotation: Vec3Tuple;
    vitals: PlayerVitalsState;
    loadout: PlayerLoadoutState;
    seq: number;
    updatedAtEpochMs: number;
}>;

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
    vitals?: PlayerVitalsState;
    loadout?: PlayerLoadoutState;
    seq: number;
    sentAtEpochMs: number;
}>;

export type ShotIntent = Readonly<{
    sessionId: string;
    username: string;
    color: string;
    origin: Vec3Tuple;
    direction: Vec3Tuple;
    weaponKind?: WeaponKind;
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

export type PlayerHitIntent = Readonly<{
    shot: ShotIntent;
    targetSessionId: string;
    targetSeq?: number;
    predictedImpact: Vec3Tuple;
    sentAtEpochMs: number;
}>;

export type PlayerHitAccepted = Readonly<{
    intent: PlayerHitIntent;
    hit: boolean;
    impact: Vec3Tuple;
    damage: number;
    weaponKind: WeaponKind;
    target: PlayerArenaState;
    attacker: PlayerArenaState;
    eliminated: boolean;
    revision: number;
    acceptedAtEpochMs: number;
}>;

export type PickupIntent = Readonly<{
    pickupId: string;
    sessionId: string;
    position: Vec3Tuple;
    seq: number;
    sentAtEpochMs: number;
}>;

export type PickupAccepted = Readonly<{
    intent: PickupIntent;
    pickup: ArenaPickupState;
    player: PlayerArenaState;
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
    | 'overdrive-window'
    | 'weapon-drop'
    | 'weapon-picked-up'
    | 'player-hit'
    | 'player-eliminated'
    | 'player-respawned'
    | 'layout-shift'
    | 'chaos-modifier';

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
    layout: ArenaLayoutSpec;
    targets: readonly EyeTargetState[];
    pickups: readonly ArenaPickupState[];
    players: readonly PlayerArenaState[];
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
