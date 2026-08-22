import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { RelicPublicSnapshot, RelicRoom } from '@relic-hunters/mod.ts';

export type FacilityBounds = Readonly<{
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
}>;

export type FacilityPoint = Readonly<{
    x: number;
    y: number;
}>;

export type NeonCameraPose = Readonly<{
    position: Vector3;
    target: Vector3;
    fov: number;
}>;

export type RelicSceneNextCameraMode = 'avatar' | 'first-person' | 'overview' | 'flyover';

export const NEON_ROOM_GRID_SCALE = 15.2;

export const RELIC_SCENE_NEXT_CAMERA_MODES: readonly RelicSceneNextCameraMode[] = [
    'avatar',
    'first-person',
    'overview'
] as const;

export const RELIC_SCENE_NEXT_FLYOVER_DURATION_MS = 6200;
export const RELIC_SCENE_NEXT_REDUCED_FLYOVER_DURATION_MS = 650;

export const RELIC_SCENE_NEXT_VISUAL_CONTRACT = {
    minAverageLuma: 0.28,
    maxDarkPixelRatio: 0.62,
    minNeonPixelRatio: 0.035,
    persistentHudBudgetDesktop: 0.25
} as const;

const BLACK_HUMOUR_SIGNS: Record<RelicRoom['kind'], readonly string[]> = {
    entrance: [
        'Welcome. Liability has already escaped.',
        'Visitor badge optional. Survival less so.'
    ],
    hallway: [
        'Queue here for ominous certainty.',
        'This corridor has been optimized for regret.'
    ],
    storage: [
        'Inventory says nothing is missing. Bold claim.',
        'Please alphabetize the cursed assets.'
    ],
    shrine: [
        'Morale Compliance Shrine',
        'Pray quickly. The meter is running.'
    ],
    trap: [
        'Safety Third',
        'Caution: floor pursuing new opportunities.'
    ],
    treasure: [
        'Executive Bonus Vault',
        'Please declare all stolen destiny.'
    ],
    monster: [
        'Employee Wellness Kennel',
        'Do not feed the quarterly predator.'
    ],
    exit: [
        'Exit Through Gift Shop Protocol',
        'Emergency evacuation, premium tier only.'
    ]
};

export function facilityRoomPosition(room: Pick<RelicRoom, 'x' | 'z'>): Vector3 {
    return new Vector3(room.x * NEON_ROOM_GRID_SCALE, 0, room.z * NEON_ROOM_GRID_SCALE);
}

export function calculateFacilityBounds(map: readonly Pick<RelicRoom, 'x' | 'z'>[]): FacilityBounds {
    if (map.length === 0) {
        return { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    }
    const xs = map.map((room) => room.x);
    const zs = map.map((room) => room.z);
    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minZ: Math.min(...zs),
        maxZ: Math.max(...zs)
    };
}

export function projectFacilityMapPoint(
    room: Pick<RelicRoom, 'x' | 'z'>,
    bounds: FacilityBounds,
    padding = 11
): FacilityPoint {
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const depth = Math.max(1, bounds.maxZ - bounds.minZ);
    return {
        x: padding + ((room.x - bounds.minX) / width) * (100 - padding * 2),
        y: padding + ((room.z - bounds.minZ) / depth) * (100 - padding * 2)
    };
}

export function shouldShowFacilityMapLabel({
    room,
    selectedRoomId,
    localRoomId,
    exitRoomId
}: Readonly<{
    room: Pick<RelicRoom, 'id' | 'kind'>;
    selectedRoomId?: string;
    localRoomId?: string;
    exitRoomId?: string;
}>): boolean {
    return room.id === selectedRoomId ||
        room.id === localRoomId ||
        room.id === exitRoomId ||
        room.kind === 'exit';
}

export function facilityRoomCallsign(room: Pick<RelicRoom, 'kind' | 'name'>): string {
    const prefix = room.kind.slice(0, 3).toUpperCase();
    const initials = room.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0]?.toUpperCase() ?? '')
        .join('');
    return `${prefix}-${initials || '00'}`;
}

export function blackHumourSignForRoom(room: Pick<RelicRoom, 'id' | 'kind'>): string {
    const options = BLACK_HUMOUR_SIGNS[room.kind];
    const hash = [...room.id].reduce((total, char) => total + char.charCodeAt(0), 0);
    return options[hash % options.length] ?? options[0];
}

export function planNeonTacticalCameraPose({
    snapshot,
    localPlayerId,
    selectedRoomId,
    focusRoomId,
    aspectRatio
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    localPlayerId?: string;
    selectedRoomId?: string;
    focusRoomId?: string;
    aspectRatio: number;
}>): NeonCameraPose {
    const focusRooms = selectCameraFocusRooms(snapshot, localPlayerId, selectedRoomId, focusRoomId);
    const positions = focusRooms.map(facilityRoomPosition);
    const minX = Math.min(...positions.map((position) => position.x));
    const maxX = Math.max(...positions.map((position) => position.x));
    const minZ = Math.min(...positions.map((position) => position.z));
    const maxZ = Math.max(...positions.map((position) => position.z));
    const center = new Vector3((minX + maxX) / 2, 1.2, (minZ + maxZ) / 2);
    const spanX = Math.max(NEON_ROOM_GRID_SCALE * 2.2, maxX - minX + NEON_ROOM_GRID_SCALE * 2.2);
    const spanZ = Math.max(NEON_ROOM_GRID_SCALE * 2.1, maxZ - minZ + NEON_ROOM_GRID_SCALE * 2.1);
    const aspectCorrectedWidth = spanX / Math.max(0.74, aspectRatio || 1);
    const span = Math.max(aspectCorrectedWidth, spanZ);
    const distance = clamp(span * 0.42 + 8, 15, 46);
    const height = clamp(span * 0.25 + 9, 13, 30);

    return {
        position: new Vector3(
            center.x - distance * 0.54,
            height,
            center.z - distance * 0.76
        ),
        target: center,
        fov: 0.78
    };
}

export function planNeonAvatarCameraPose({
    avatarPosition,
    cameraYaw,
    cameraPitch = 0
}: Readonly<{
    avatarPosition: Vector3;
    cameraYaw: number;
    cameraPitch?: number;
}>): NeonCameraPose {
    const forward = yawForward(cameraYaw);
    const right = yawRight(cameraYaw);
    const pitch = clamp(cameraPitch, -0.48, 0.58);
    const distance = 6.2 - Math.sin(pitch) * 1.1;
    const height = 3.05 + Math.sin(pitch) * 1.7;
    const target = avatarPosition
        .add(new Vector3(0, 1.32, 0))
        .add(forward.scale(1.2));
    const position = avatarPosition
        .subtract(forward.scale(distance))
        .add(right.scale(0.64))
        .add(new Vector3(0, height, 0));

    return {
        position,
        target,
        fov: 0.86
    };
}

export function planNeonFirstPersonCameraPose({
    avatarPosition,
    cameraYaw,
    cameraPitch = 0
}: Readonly<{
    avatarPosition: Vector3;
    cameraYaw: number;
    cameraPitch?: number;
}>): NeonCameraPose {
    const pitch = clamp(cameraPitch, -0.72, 0.72);
    const forward = yawForward(cameraYaw);
    const eye = avatarPosition
        .add(new Vector3(0, 1.58, 0))
        .add(forward.scale(0.24));
    const look = forward
        .scale(Math.cos(pitch))
        .add(new Vector3(0, Math.sin(pitch), 0))
        .normalize();

    return {
        position: eye,
        target: eye.add(look.scale(8)),
        fov: 0.98
    };
}

export function planNeonOverviewCameraPose({
    snapshot,
    aspectRatio
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    aspectRatio: number;
}>): NeonCameraPose {
    const positions = snapshot.map.map(facilityRoomPosition);
    if (positions.length === 0) {
        return {
            position: new Vector3(-18, 24, -26),
            target: Vector3.Zero(),
            fov: 0.76
        };
    }
    const minX = Math.min(...positions.map((position) => position.x));
    const maxX = Math.max(...positions.map((position) => position.x));
    const minZ = Math.min(...positions.map((position) => position.z));
    const maxZ = Math.max(...positions.map((position) => position.z));
    const center = new Vector3((minX + maxX) / 2, 1.2, (minZ + maxZ) / 2);
    const spanX = Math.max(NEON_ROOM_GRID_SCALE * 3, maxX - minX + NEON_ROOM_GRID_SCALE * 2.8);
    const spanZ = Math.max(NEON_ROOM_GRID_SCALE * 3, maxZ - minZ + NEON_ROOM_GRID_SCALE * 2.8);
    const span = Math.max(spanZ, spanX / Math.max(0.72, aspectRatio || 1));
    const distance = clamp(span * 0.62 + 13, 24, 74);
    const height = clamp(span * 0.52 + 18, 26, 68);

    return {
        position: new Vector3(
            center.x - distance * 0.52,
            height,
            center.z - distance * 0.78
        ),
        target: center,
        fov: 0.74
    };
}

export function planNeonFlyoverCameraPose({
    snapshot,
    progress,
    aspectRatio
}: Readonly<{
    snapshot: RelicPublicSnapshot;
    progress: number;
    aspectRatio: number;
}>): NeonCameraPose {
    const route = neonFlyoverRouteRooms(snapshot);
    if (route.length === 0) {
        return planNeonOverviewCameraPose({ snapshot, aspectRatio });
    }
    if (route.length === 1) {
        const center = facilityRoomPosition(route[0]);
        return {
            position: center.add(new Vector3(-7, 5.6, -8)),
            target: center.add(new Vector3(0, 1.2, 0)),
            fov: 0.82
        };
    }

    const eased = smoothstep(clamp(progress, 0, 1));
    const scaled = eased * (route.length - 1);
    const index = Math.min(route.length - 2, Math.floor(scaled));
    const localT = smoothstep(scaled - index);
    const current = facilityRoomPosition(route[index]);
    const next = facilityRoomPosition(route[index + 1]);
    const lookahead = facilityRoomPosition(route[Math.min(route.length - 1, index + 2)]);
    const center = Vector3.Lerp(current, next, localT);
    const direction = lookahead.subtract(center).normalize();
    const side = new Vector3(direction.z, 0, -direction.x);
    const rise = Math.sin(eased * Math.PI) * 1.2;

    return {
        position: center
            .subtract(direction.scale(4.4))
            .add(side.scale(1.4))
            .add(new Vector3(0, 4.9 + rise, 0)),
        target: Vector3.Lerp(next, lookahead, 0.38).add(new Vector3(0, 1.1, 0)),
        fov: 0.84
    };
}

export function neonFlyoverRouteRooms(snapshot: RelicPublicSnapshot): readonly RelicRoom[] {
    const entrance = snapshot.map.find((room) => room.kind === 'entrance') ?? snapshot.map[0];
    const exit = snapshot.map.find((room) => room.kind === 'exit');
    const routeIds = entrance && exit
        ? shortestRoomPath(snapshot.map, entrance.id, exit.id)
        : entrance
        ? [entrance.id]
        : [];
    const route = routeIds
        .map((roomId) => snapshot.map.find((room) => room.id === roomId))
        .filter((room): room is RelicRoom => !!room);
    const used = new Set(route.map((room) => room.id));
    const remaining = snapshot.map
        .filter((room) => !used.has(room.id))
        .sort((left, right) => left.z === right.z ? left.x - right.x : left.z - right.z);
    return [...route, ...remaining];
}

function selectCameraFocusRooms(
    snapshot: RelicPublicSnapshot,
    localPlayerId?: string,
    selectedRoomId?: string,
    focusRoomId?: string
): readonly RelicRoom[] {
    const roomById = new Map(snapshot.map.map((room) => [room.id, room]));
    const ids = new Set<string>();
    const localPlayer = snapshot.players.find((player) => player.playerId === localPlayerId);
    if (localPlayer) {
        ids.add(localPlayer.roomId);
        const localRoom = roomById.get(localPlayer.roomId);
        for (const neighborId of localRoom?.neighbors ?? []) {
            ids.add(neighborId);
        }
    }
    if (selectedRoomId) {
        ids.add(selectedRoomId);
    }
    if (focusRoomId) {
        ids.add(focusRoomId);
    }
    if (ids.size === 0) {
        for (const room of snapshot.map) {
            ids.add(room.id);
        }
    }
    const rooms = [...ids]
        .map((roomId) => roomById.get(roomId))
        .filter((room): room is RelicRoom => !!room);
    return rooms.length > 0 ? rooms : snapshot.map;
}

function shortestRoomPath(
    map: readonly RelicRoom[],
    fromRoomId: string,
    toRoomId: string
): readonly string[] {
    if (fromRoomId === toRoomId) {
        return [fromRoomId];
    }
    const roomById = new Map(map.map((room) => [room.id, room]));
    const visited = new Set<string>([fromRoomId]);
    const queue: string[][] = [[fromRoomId]];
    while (queue.length > 0) {
        const path = queue.shift()!;
        const room = roomById.get(path[path.length - 1]);
        if (!room) {
            continue;
        }
        for (const neighborId of room.neighbors) {
            if (visited.has(neighborId)) {
                continue;
            }
            const neighbor = roomById.get(neighborId);
            if (!neighbor || neighbor.collapsed) {
                continue;
            }
            const next = [...path, neighborId];
            if (neighborId === toRoomId) {
                return next;
            }
            visited.add(neighborId);
            queue.push(next);
        }
    }
    return [fromRoomId];
}

function yawForward(yaw: number): Vector3 {
    return new Vector3(Math.sin(yaw), 0, Math.cos(yaw)).normalize();
}

function yawRight(yaw: number): Vector3 {
    return new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).normalize();
}

function smoothstep(value: number): number {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
