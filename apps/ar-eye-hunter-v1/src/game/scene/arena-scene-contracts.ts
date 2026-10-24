import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture.js';
import type { Mesh } from '@babylonjs/core/Meshes/mesh.js';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import type { ArenaLinkState, ArenaPresenceNotice } from '../squadLink.ts';
import type {
    ArenaEvent,
    ArenaSnapshot,
    PickupIntent,
    PlayerArenaState,
    PlayerCombatState,
    PlayerHitAccepted,
    PlayerHitIntent,
    PlayerPose,
    RemotePlayer,
    RemoteShot,
    ShotAccepted,
    ShotIntent,
    Vec3Tuple
} from '../types.ts';
import type { ArenaSceneState } from './arena-scene-state.ts';

export interface BabylonArenaProps {
    readonly localSessionId?: string;
    readonly localUsername: string;
    readonly localColor: string;
    readonly roomId?: string;
    readonly roomReady: boolean;
    readonly networkEnabled: boolean;
    readonly authority: ArenaSceneState.Authority;
    readonly linkState: ArenaLinkState;
    readonly presenceNotices: readonly ArenaPresenceNotice[];
    readonly diagnosticsAttributes?: Readonly<Record<string, string>>;
    readonly remotePlayers: ReadonlyMap<string, RemotePlayer>;
    readonly remoteShots: readonly RemoteShot[];
    readonly remotePlayerHits: readonly PlayerHitAccepted[];
    readonly remoteEvents: readonly ArenaEvent[];
    readonly arenaSnapshot?: ArenaSnapshot;
    readonly onLocalPose: (pose: Omit<PlayerPose, 'sessionId' | 'username' | 'color'>) => void;
    readonly onLocalShot: (
        shot: Omit<ShotIntent, 'sessionId' | 'username' | 'color'>,
        accepted: ShotAccepted
    ) => void;
    readonly onPlayerHitIntent: (intent: PlayerHitIntent) => void;
    readonly onPickupIntent: (intent: PickupIntent) => void;
    readonly onLocalCombatChange: (combat: PlayerCombatState) => void;
    readonly onLocalPlayerChange: (player: Pick<PlayerArenaState, 'vitals' | 'loadout'>) => void;
    readonly onArenaSnapshot: (snapshot: ArenaSnapshot) => void;
}

export interface RemoteAvatar {
    readonly root: TransformNode;
    readonly body: Mesh;
    readonly visor: Mesh;
    readonly shoulderLeft: Mesh;
    readonly shoulderRight: Mesh;
    readonly trail: Mesh;
    readonly decal: Mesh;
    readonly label: Mesh;
    readonly ring: Mesh;
    readonly health: Mesh;
    readonly healthMaterial: StandardMaterial;
    readonly material: StandardMaterial;
    readonly accentMaterial: StandardMaterial;
    readonly labelTexture: DynamicTexture;
}

export interface PickupAvatar {
    readonly root: TransformNode;
    readonly core: Mesh;
    readonly ring: Mesh;
    readonly label: Mesh;
    readonly material: StandardMaterial;
    readonly labelTexture: DynamicTexture;
}

export interface TargetAvatar {
    readonly root: TransformNode;
    readonly iris: Mesh;
    readonly pupil: Mesh;
    readonly ring: Mesh;
    readonly halo: Mesh;
    readonly shardA: Mesh;
    readonly shardB: Mesh;
    readonly label: Mesh;
    readonly labelTexture: DynamicTexture;
    readonly coreMaterial: StandardMaterial;
    readonly pupilMaterial: StandardMaterial;
    readonly ringMaterial: StandardMaterial;
    readonly labelMaterial: StandardMaterial;
}

export interface TransientEffect {
    readonly startedAtMs: number;
    readonly durationMs: number;
    readonly meshes: readonly Mesh[];
    readonly materials: readonly StandardMaterial[];
    readonly textures?: readonly DynamicTexture[];
    readonly update?: (ageMs: number, progress: number) => void;
}

export interface ArenaSceneClock {
    readonly nowEpochMs: () => number;
    readonly nowMonotonicMs: () => number;
}

export interface MutableInputState {
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
}

export interface LocalPoseHistory {
    readonly observedAtEpochMs: number;
    readonly position: Vec3Tuple;
    readonly rotation: Vec3Tuple;
}

export type MutableButtonAction = Exclude<keyof MutableInputState, 'moveX' | 'moveZ'>;
