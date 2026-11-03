import type { ArenaRematch } from './arena-rematch.ts';
export const GAME_PROTOCOL = 'ar-eye-hunter.v1';

export type Vec3Tuple = readonly [number, number, number];

export type TargetRarity = 'common' | 'volatile' | 'bounty' | 'rift';

export type EyeThreatKind = 'passive' | 'beam-sentry' | 'boss';

export interface EyeThreatState {
    readonly kind: EyeThreatKind;
    readonly damage: number;
    readonly range: number;
    readonly coneRadians: number;
    readonly windupMs: number;
    readonly cooldownMs: number;
    readonly nextAttackAtEpochMs: number;
    readonly targetSessionId?: string;
}

export interface EyeAttackCue {
    readonly id: string;
    readonly targetId: string;
    readonly targetSessionId: string;
    readonly origin: Vec3Tuple;
    readonly aimPoint: Vec3Tuple;
    readonly damage: number;
    readonly range: number;
    readonly coneRadians: number;
    readonly startsAtEpochMs: number;
    readonly firesAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly revision: number;
}

export interface EyeAttackAccepted {
    readonly cue: EyeAttackCue;
    readonly hit: boolean;
    readonly impact: Vec3Tuple;
    readonly damage: number;
    readonly target?: PlayerArenaState;
    readonly eliminated: boolean;
    readonly revision: number;
    readonly acceptedAtEpochMs: number;
    readonly reason?: 'hit' | 'cover' | 'dodged' | 'dead-player' | 'stale-cue';
}

export interface WaveState {
    readonly number: number;
    readonly phase: 'warmup' | 'active' | 'reward';
    readonly startedAtEpochMs: number;
    readonly nextPhaseAtEpochMs: number;
    readonly targetBudget: number;
    readonly hostileBudget: number;
    readonly pickupRewardBudget: number;
    readonly activeModifierId?: string;
}

export type ArenaMatchDurationMs = 60_000 | 180_000 | 300_000;

export interface ArenaMatchPlayerBaseline {
    readonly sessionId: string;
    readonly username: string;
    readonly score: number;
    readonly kills: number;
    readonly deaths: number;
    readonly joinedOrder: number;
}

export interface ArenaMatchStanding {
    readonly sessionId: string;
    readonly username: string;
    readonly scoreDelta: number;
    readonly killsDelta: number;
    readonly deathsDelta: number;
    readonly rank: number;
}

export interface ArenaMatchState {
    readonly matchId: string;
    readonly status: 'active' | 'complete';
    readonly enrollment: 'open' | 'confirmed';
    readonly durationMs: ArenaMatchDurationMs;
    readonly directorSessionId: string;
    readonly startedAtEpochMs: number;
    readonly endsAtEpochMs: number;
    readonly baseline: Readonly<Record<string, ArenaMatchPlayerBaseline>>;
    readonly results?: readonly ArenaMatchStanding[];
    readonly completedAtEpochMs?: number;
    readonly rematch?: ArenaRematch;
}

export type WeaponKind =
    | 'pulse-rifle'
    | 'spread-shot'
    | 'rail-lance'
    | 'glitch-blaster'
    | 'audit-pea-shooter'
    | 'confetti-cannon';

export interface WeaponStats {
    readonly kind: WeaponKind;
    readonly label: string;
    readonly tier: number;
    readonly damage: number;
    readonly cooldownMs: number;
    readonly range: number;
    readonly spreadRadians: number;
    readonly rays: number;
    readonly knockback: number;
    readonly flavor: string;
}

export interface ArenaLayoutTheme {
    readonly base: string;
    readonly grid: string;
    readonly accent: string;
    readonly warning: string;
    readonly reward: string;
}

export interface ArenaLayoutProp {
    readonly id: string;
    readonly kind: 'cover' | 'ramp' | 'portal' | 'bounce-pad' | 'hazard';
    readonly position: Vec3Tuple;
    readonly size: Vec3Tuple;
    readonly rotationY?: number;
    readonly blocksShots: boolean;
    readonly label?: string;
}

export interface ArenaLayoutSign {
    readonly id: string;
    readonly title: string;
    readonly detail: string;
    readonly position: Vec3Tuple;
    readonly rotationY: number;
}

export interface ArenaPickupAnchor {
    readonly id: string;
    readonly position: Vec3Tuple;
    readonly weight?: number;
}

export interface ArenaLayoutSpec {
    readonly schema: 'ar-eye-hunter.arena-layout';
    readonly version: '1';
    readonly id: string;
    readonly revision: number;
    readonly name: string;
    readonly halfSize: number;
    readonly theme: ArenaLayoutTheme;
    readonly spawnPoints: readonly Vec3Tuple[];
    readonly pickupAnchors: readonly ArenaPickupAnchor[];
    readonly props: readonly ArenaLayoutProp[];
    readonly signs: readonly ArenaLayoutSign[];
}

export interface ArenaPickupState {
    readonly id: string;
    readonly weaponKind: WeaponKind;
    readonly tier: number;
    readonly position: Vec3Tuple;
    readonly anchorId: string;
    readonly spawnedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly pickedBySessionId?: string;
    readonly pickedAtEpochMs?: number;
    readonly label: string;
}

export interface PlayerVitalsState {
    readonly health: number;
    readonly maxHealth: number;
    readonly deaths: number;
    readonly kills: number;
    readonly deadUntilEpochMs?: number;
    readonly respawnedAtEpochMs?: number;
    readonly lastDamagedAtEpochMs?: number;
}

export interface PlayerLoadoutState {
    readonly weaponKind: WeaponKind;
    readonly tier: number;
    readonly pickedAtEpochMs?: number;
}

export interface PlayerArenaState {
    readonly sessionId: string;
    readonly username: string;
    readonly color: string;
    readonly score: number;
    readonly position: Vec3Tuple;
    readonly rotation: Vec3Tuple;
    readonly vitals: PlayerVitalsState;
    readonly loadout: PlayerLoadoutState;
    readonly seq: number;
    readonly updatedAtEpochMs: number;
}

export interface EyeTargetState {
    readonly id: string;
    readonly position: Vec3Tuple;
    readonly velocity: Vec3Tuple;
    readonly radius: number;
    readonly health: number;
    readonly maxHealth: number;
    readonly rarity: TargetRarity;
    readonly phase: number;
    readonly color: string;
    readonly threat?: EyeThreatState;
    readonly bountyUntilEpochMs?: number;
}

export interface PlayerInputState {
    readonly moveX: number;
    readonly moveZ: number;
    readonly sprint: boolean;
    readonly dash: boolean;
    readonly slide: boolean;
    readonly jump: boolean;
    readonly fire: boolean;
    readonly altFire: boolean;
    readonly overdrive: boolean;
    readonly pause: boolean;
}

export interface PlayerCombatState {
    readonly score: number;
    readonly combo: number;
    readonly multiplier: number;
    readonly energy: number;
    readonly overdrive: number;
    readonly overdriveActiveUntilEpochMs?: number;
    readonly lastHitAtEpochMs?: number;
    readonly dashReadyAtEpochMs: number;
    readonly slideReadyAtEpochMs: number;
    readonly shotReadyAtEpochMs: number;
}

export interface ShotIntent {
    readonly sessionId: string;
    readonly username: string;
    readonly color: string;
    readonly origin: Vec3Tuple;
    readonly direction: Vec3Tuple;
    readonly weaponKind: WeaponKind;
    readonly charged?: boolean;
    readonly overdrive?: boolean;
    readonly seq: number;
    readonly sentAtEpochMs: number;
}

export interface ShotAccepted {
    readonly shot: ShotIntent;
    readonly hit: boolean;
    readonly targetId?: string;
    readonly impact: Vec3Tuple;
    readonly scoreDelta: number;
    readonly combo: number;
    readonly multiplier: number;
    readonly overdrive: number;
    readonly revision: number;
    readonly acceptedAtEpochMs: number;
}

export interface PlayerHitIntent {
    readonly shot: ShotIntent;
    readonly targetSessionId: string;
    readonly targetSeq?: number;
    readonly predictedImpact: Vec3Tuple;
    readonly sentAtEpochMs: number;
}

export interface PlayerHitAccepted {
    readonly intent: PlayerHitIntent;
    readonly hit: boolean;
    readonly impact: Vec3Tuple;
    readonly damage: number;
    readonly weaponKind: WeaponKind;
    readonly target: PlayerArenaState;
    readonly attacker: PlayerArenaState;
    readonly eliminated: boolean;
    readonly revision: number;
    readonly acceptedAtEpochMs: number;
}

export interface PickupIntent {
    readonly pickupId: string;
    readonly sessionId: string;
    readonly position: Vec3Tuple;
    readonly seq: number;
    readonly sentAtEpochMs: number;
}

export interface PickupAccepted {
    readonly intent: PickupIntent;
    readonly pickup: ArenaPickupState;
    readonly player: PlayerArenaState;
    readonly revision: number;
    readonly acceptedAtEpochMs: number;
}

export interface MatchStartIntent {
    readonly matchId: string;
    readonly directorSessionId: string;
    readonly durationMs: ArenaMatchDurationMs;
    readonly sentAtEpochMs: number;
}

export interface MatchStartedAccepted {
    readonly intent: MatchStartIntent;
    readonly match: ArenaMatchState;
    readonly revision: number;
    readonly acceptedAtEpochMs: number;
}

export interface MatchEndedAccepted {
    readonly match: ArenaMatchState;
    readonly revision: number;
    readonly acceptedAtEpochMs: number;
}

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
    | 'pickup-taken'
    | 'player-hit'
    | 'player-eliminated'
    | 'player-respawned'
    | 'layout-shift'
    | 'chaos-modifier'
    | 'wave-start'
    | 'wave-complete'
    | 'eye-attack-windup'
    | 'eye-attack-hit'
    | 'eye-attack-dodged'
    | 'boss-eye'
    | 'match-started'
    | 'match-ended'
    | 'match-winner'
    | 'avatar-profile-accepted';

export interface ArenaEvent {
    readonly id: string;
    readonly kind: ArenaEventKind;
    readonly targetId?: string;
    readonly position?: Vec3Tuple;
    readonly radius?: number;
    readonly intensity?: number;
    readonly durationMs?: number;
    readonly rarity?: TargetRarity;
    readonly scoreBonus?: number;
    readonly startsAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly revision: number;
    readonly source: 'director' | 'ai' | 'local';
    readonly headline?: string;
}

export interface ArenaSnapshot {
    readonly protocol: typeof GAME_PROTOCOL;
    readonly roomId?: string;
    readonly revision: number;
    readonly seed: number;
    readonly layout: ArenaLayoutSpec;
    readonly targets: readonly EyeTargetState[];
    readonly pickups: readonly ArenaPickupState[];
    readonly players: readonly PlayerArenaState[];
    readonly attacks: readonly EyeAttackCue[];
    readonly wave: WaveState;
    readonly match?: ArenaMatchState;
    readonly events: readonly ArenaEvent[];
    readonly activeEvent?: ArenaEvent;
    readonly sentAtEpochMs: number;
}
export interface ArenaSimulationState {
    readonly revision: number;
    readonly seed: number;
    readonly layout: ArenaLayoutSpec;
    readonly targets: readonly EyeTargetState[];
    readonly pickups: readonly ArenaPickupState[];
    readonly players: readonly PlayerArenaState[];
    readonly attacks: readonly EyeAttackCue[];
    readonly wave: WaveState;
    readonly match?: ArenaSnapshot['match'];
    readonly events: readonly ArenaEvent[];
    readonly activeEvent?: ArenaEvent;
    readonly nextPickupSeq: number;
    readonly nextPickupAtEpochMs: number;
}
