import type { RelicRoom, RelicRoomKind } from '@relic-hunters/mod.ts';
import type { CastleKitMaterialRole } from './castleKit.ts';

export type RoomIdentitySilhouette =
    | 'gatehouse'
    | 'main-corridor'
    | 'armory-storage'
    | 'main-shrine'
    | 'secret-cell'
    | 'treasury'
    | 'haunted-barracks'
    | 'garden-watchtower';

export type RoomIdentity = Readonly<{
    kind: RelicRoomKind;
    label: string;
    castleRole: string;
    silhouette: RoomIdentitySilhouette;
    primaryMaterial: CastleKitMaterialRole;
    accentMaterial: CastleKitMaterialRole;
    dangerMaterial?: CastleKitMaterialRole;
    landmark: string;
    floorMotif:
        | 'threshold'
        | 'runner'
        | 'stacked-crates'
        | 'altar-ring'
        | 'warning-grid'
        | 'vault-ring'
        | 'broken-beams'
        | 'garden-path';
}>;

export const ROOM_KIND_ORDER: readonly RelicRoomKind[] = [
    'entrance',
    'hallway',
    'storage',
    'shrine',
    'trap',
    'treasure',
    'monster',
    'exit'
];

export const ROOM_IDENTITIES: Readonly<Record<RelicRoomKind, RoomIdentity>> = {
    entrance: {
        kind: 'entrance',
        label: 'Entrance',
        castleRole: 'Gatehouse / front gate',
        silhouette: 'gatehouse',
        primaryMaterial: 'lacquer',
        accentMaterial: 'metal',
        landmark: 'large gate frame and portcullis',
        floorMotif: 'threshold'
    },
    hallway: {
        kind: 'hallway',
        label: 'Hallway',
        castleRole: 'Main corridor',
        silhouette: 'main-corridor',
        primaryMaterial: 'wood',
        accentMaterial: 'accentBlue',
        landmark: 'long runner and repeated guide rails',
        floorMotif: 'runner'
    },
    storage: {
        kind: 'storage',
        label: 'Storage',
        castleRole: 'Armory / storage room',
        silhouette: 'armory-storage',
        primaryMaterial: 'wood',
        accentMaterial: 'metal',
        landmark: 'crate stacks and weapon racks',
        floorMotif: 'stacked-crates'
    },
    shrine: {
        kind: 'shrine',
        label: 'Shrine',
        castleRole: 'Main hall / shrine',
        silhouette: 'main-shrine',
        primaryMaterial: 'paper',
        accentMaterial: 'portal',
        landmark: 'raised altar and torii focus',
        floorMotif: 'altar-ring'
    },
    trap: {
        kind: 'trap',
        label: 'Trap Room',
        castleRole: 'Secret passage / jail-cell trap room',
        silhouette: 'secret-cell',
        primaryMaterial: 'metal',
        accentMaterial: 'accentCoral',
        dangerMaterial: 'crack',
        landmark: 'cell bars and warning plates',
        floorMotif: 'warning-grid'
    },
    treasure: {
        kind: 'treasure',
        label: 'Treasure',
        castleRole: 'Treasury',
        silhouette: 'treasury',
        primaryMaterial: 'gold',
        accentMaterial: 'wood',
        landmark: 'vault plinth and coin stacks',
        floorMotif: 'vault-ring'
    },
    monster: {
        kind: 'monster',
        label: 'Monster',
        castleRole: 'Haunted barracks / damaged keep',
        silhouette: 'haunted-barracks',
        primaryMaterial: 'rubble',
        accentMaterial: 'crack',
        dangerMaterial: 'accentCoral',
        landmark: 'broken beams and claw marks',
        floorMotif: 'broken-beams'
    },
    exit: {
        kind: 'exit',
        label: 'Exit',
        castleRole: 'Watch tower / garden gate',
        silhouette: 'garden-watchtower',
        primaryMaterial: 'portal',
        accentMaterial: 'foliage',
        landmark: 'garden gate and escape beacon',
        floorMotif: 'garden-path'
    }
};

export function roomIdentityForKind(kind: RelicRoomKind): RoomIdentity {
    return ROOM_IDENTITIES[kind];
}

export function roomIdentityForRoom(room: RelicRoom): RoomIdentity {
    return roomIdentityForKind(room.kind);
}

export function allRoomIdentities(): readonly RoomIdentity[] {
    return ROOM_KIND_ORDER.map(roomIdentityForKind);
}
