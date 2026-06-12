import type {
    ArenaLayoutProp,
    ArenaLayoutSign,
    ArenaLayoutSpec,
    ArenaPickupAnchor,
    Vec3Tuple,
} from './types.ts';

export const DEFAULT_ARENA_HALF_SIZE = 60;
export const DEFAULT_ARENA_SIZE = DEFAULT_ARENA_HALF_SIZE * 2;
export const ARENA_LAYOUT_SCHEMA_ID = 'ar-eye-hunter.arena-layout';
export const ARENA_LAYOUT_SCHEMA_VERSION = '1';

const MAX_PROPS = 24;
const MAX_SIGNS = 10;
const MAX_PICKUP_ANCHORS = 18;
const MAX_SPAWNS = 10;
const MIN_SPAWN_SEPARATION = 8;

export const FALLBACK_ARENA_LAYOUT: ArenaLayoutSpec = {
    schema: ARENA_LAYOUT_SCHEMA_ID,
    version: ARENA_LAYOUT_SCHEMA_VERSION,
    id: 'matrix-killbox-v2',
    revision: 1,
    name: 'Mandatory Fun Killbox',
    halfSize: DEFAULT_ARENA_HALF_SIZE,
    theme: {
        base: '#020805',
        grid: '#49ff86',
        accent: '#00e5ff',
        warning: '#ff3df2',
        reward: '#ffe66d',
    },
    spawnPoints: [
        [-45, 1.72, -45],
        [45, 1.72, 45],
        [-45, 1.72, 45],
        [45, 1.72, -45],
        [0, 1.72, -52],
        [0, 1.72, 52],
    ],
    pickupAnchors: [
        { id: 'pickup-north', position: [0, 1.05, 42], weight: 1.2 },
        { id: 'pickup-south', position: [0, 1.05, -42], weight: 1.2 },
        { id: 'pickup-east', position: [42, 1.05, 0], weight: 1 },
        { id: 'pickup-west', position: [-42, 1.05, 0], weight: 1 },
        { id: 'pickup-core', position: [0, 1.05, 0], weight: 0.8 },
        { id: 'pickup-tax-office', position: [-32, 1.05, 32], weight: 1 },
        { id: 'pickup-hr-portal', position: [32, 1.05, -32], weight: 1 },
        { id: 'pickup-compliance', position: [47, 1.05, 38], weight: 0.75 },
        { id: 'pickup-committee', position: [-47, 1.05, -38], weight: 0.75 },
    ],
    props: [
        {
            id: 'cover-audit-1',
            kind: 'cover',
            position: [-22, 1.4, -16],
            size: [6.8, 2.8, 1.2],
            rotationY: 0.2,
            blocksShots: true,
            label: 'Audit Wall',
        },
        {
            id: 'cover-audit-2',
            kind: 'cover',
            position: [22, 1.4, 16],
            size: [6.8, 2.8, 1.2],
            rotationY: 0.2,
            blocksShots: true,
            label: 'Audit Wall',
        },
        {
            id: 'cover-policy-1',
            kind: 'cover',
            position: [-34, 1.2, 22],
            size: [1.35, 2.4, 7.4],
            rotationY: -0.35,
            blocksShots: true,
            label: 'Policy Pillar',
        },
        {
            id: 'cover-policy-2',
            kind: 'cover',
            position: [34, 1.2, -22],
            size: [1.35, 2.4, 7.4],
            rotationY: -0.35,
            blocksShots: true,
            label: 'Policy Pillar',
        },
        {
            id: 'bounce-morale',
            kind: 'bounce-pad',
            position: [0, 0.08, 24],
            size: [7.2, 0.12, 7.2],
            blocksShots: false,
            label: 'Morale Launcher',
        },
        {
            id: 'hazard-late-fee',
            kind: 'hazard',
            position: [0, 0.1, -24],
            size: [10.2, 0.12, 2.8],
            blocksShots: false,
            label: 'Late Fee Zone',
        },
        {
            id: 'portal-exit-interview-a',
            kind: 'portal',
            position: [-52, 2.1, 0],
            size: [4.4, 4.4, 0.4],
            blocksShots: false,
            label: 'Exit Interview',
        },
        {
            id: 'portal-exit-interview-b',
            kind: 'portal',
            position: [52, 2.1, 0],
            size: [4.4, 4.4, 0.4],
            blocksShots: false,
            label: 'Re-entry Interview',
        },
    ],
    signs: [
        {
            id: 'sign-terms',
            title: 'TERMS UPDATED',
            detail: 'you agreed by blinking',
            position: [-32, 3.4, 57.2],
            rotationY: Math.PI,
        },
        {
            id: 'sign-audit',
            title: 'FUN AUDIT',
            detail: 'noncompliance looks expensive',
            position: [32, 3.4, -57.2],
            rotationY: 0,
        },
        {
            id: 'sign-hr',
            title: 'HR PORTAL',
            detail: 'respawn paperwork waived',
            position: [57.2, 3.2, 24],
            rotationY: -Math.PI / 2,
        },
    ],
};

export type ArenaLayoutValidation =
    | Readonly<{ ok: true; layout: ArenaLayoutSpec }>
    | Readonly<{ ok: false; reason: string; layout: ArenaLayoutSpec }>;

export function validateArenaLayoutSpec(value: unknown): ArenaLayoutValidation {
    if (!isRecord(value)) {
        return fallback('Layout must be an object.');
    }

    const rawHalfSize = toFiniteNumber(value['halfSize'], DEFAULT_ARENA_HALF_SIZE);
    const halfSize = clamp(rawHalfSize, 32, 72);
    const spawnPoints = readVec3Array(value['spawnPoints'], MAX_SPAWNS, halfSize);
    if (spawnPoints.length < 2 || !hasSeparatedSpawns(spawnPoints)) {
        return fallback('Layout needs at least two readable spawn points.');
    }

    const pickupAnchors = readPickupAnchors(value['pickupAnchors'], halfSize);
    if (pickupAnchors.length < 3) {
        return fallback('Layout needs at least three pickup anchors.');
    }

    const layout: ArenaLayoutSpec = {
        schema: ARENA_LAYOUT_SCHEMA_ID,
        version: ARENA_LAYOUT_SCHEMA_VERSION,
        id: readString(value['id'], 'ai-matrix-layout').slice(0, 64),
        revision: Math.max(1, Math.round(toFiniteNumber(value['revision'], 1))),
        name: readString(value['name'], 'RallarAI Matrix Killbox').slice(0, 72),
        halfSize,
        theme: readTheme(value['theme']),
        spawnPoints,
        pickupAnchors,
        props: readProps(value['props'], halfSize),
        signs: readSigns(value['signs'], halfSize),
    };

    return { ok: true, layout };
}

export function assertArenaLayoutSpec(value: unknown): ArenaLayoutSpec {
    const validation = validateArenaLayoutSpec(value);
    return validation.layout;
}

export function pickSpawnPoint(
    layout: ArenaLayoutSpec,
    sessionId: string,
    salt = 0,
): Vec3Tuple {
    const index = Math.abs(hashString(`${sessionId}:${salt}:${layout.revision}`)) %
        layout.spawnPoints.length;
    return layout.spawnPoints[index] ?? FALLBACK_ARENA_LAYOUT.spawnPoints[0];
}

export function pickPickupAnchor(
    layout: ArenaLayoutSpec,
    sequence: number,
): ArenaPickupAnchor {
    const anchors = layout.pickupAnchors.length > 0
        ? layout.pickupAnchors
        : FALLBACK_ARENA_LAYOUT.pickupAnchors;
    const total = anchors.reduce((sum, anchor) => sum + (anchor.weight ?? 1), 0);
    let cursor = (Math.abs(hashString(`${layout.id}:${layout.revision}:${sequence}`)) % 10_000) /
        10_000 * total;
    for (const anchor of anchors) {
        cursor -= anchor.weight ?? 1;
        if (cursor <= 0) {
            return anchor;
        }
    }
    return anchors[anchors.length - 1];
}

export function blocksShot(
    layout: ArenaLayoutSpec,
    origin: Vec3Tuple,
    impact: Vec3Tuple,
): boolean {
    return layout.props.some((prop) =>
        prop.blocksShots && segmentIntersectsAabb(origin, impact, prop.position, prop.size)
    );
}

function readTheme(value: unknown): ArenaLayoutSpec['theme'] {
    if (!isRecord(value)) {
        return FALLBACK_ARENA_LAYOUT.theme;
    }
    return {
        base: readHex(value['base'], FALLBACK_ARENA_LAYOUT.theme.base),
        grid: readHex(value['grid'], FALLBACK_ARENA_LAYOUT.theme.grid),
        accent: readHex(value['accent'], FALLBACK_ARENA_LAYOUT.theme.accent),
        warning: readHex(value['warning'], FALLBACK_ARENA_LAYOUT.theme.warning),
        reward: readHex(value['reward'], FALLBACK_ARENA_LAYOUT.theme.reward),
    };
}

function readProps(value: unknown, halfSize: number): readonly ArenaLayoutProp[] {
    if (!Array.isArray(value)) {
        return FALLBACK_ARENA_LAYOUT.props;
    }
    return value.slice(0, MAX_PROPS).flatMap((item, index) => {
        if (!isRecord(item)) {
            return [];
        }
        const kind = readPropKind(item['kind']);
        const size = readVec3(item['size'], [2.4, 1.2, 2.4], [0.4, 0.08, 0.4], [10, 8, 10]);
        const prop: ArenaLayoutProp = {
            id: readString(item['id'], `prop-${index}`).slice(0, 64),
            kind,
            position: clampPosition(readVec3(item['position'], [0, 1, 0]), halfSize),
            size,
            rotationY: clamp(toFiniteNumber(item['rotationY'], 0), -Math.PI, Math.PI),
            blocksShots: typeof item['blocksShots'] === 'boolean'
                ? item['blocksShots']
                : kind === 'cover',
            label: readString(item['label'], defaultPropLabel(kind)).slice(0, 44),
        };
        return [prop];
    });
}

function readSigns(value: unknown, halfSize: number): readonly ArenaLayoutSign[] {
    if (!Array.isArray(value)) {
        return FALLBACK_ARENA_LAYOUT.signs;
    }
    return value.slice(0, MAX_SIGNS).flatMap((item, index) => {
        if (!isRecord(item)) {
            return [];
        }
        return [{
            id: readString(item['id'], `sign-${index}`).slice(0, 64),
            title: readString(item['title'], 'COMPLIANCE NOTICE').slice(0, 24),
            detail: readString(item['detail'], 'optimism requires approval').slice(0, 44),
            position: clampPosition(readVec3(item['position'], [0, 3, halfSize - 2]), halfSize),
            rotationY: clamp(toFiniteNumber(item['rotationY'], 0), -Math.PI, Math.PI),
        }];
    });
}

function readPickupAnchors(value: unknown, halfSize: number): readonly ArenaPickupAnchor[] {
    if (!Array.isArray(value)) {
        return FALLBACK_ARENA_LAYOUT.pickupAnchors;
    }
    return value.slice(0, MAX_PICKUP_ANCHORS).flatMap((item, index) => {
        if (!isRecord(item)) {
            return [];
        }
        return [{
            id: readString(item['id'], `pickup-${index}`).slice(0, 64),
            position: clampPosition(readVec3(item['position'], [0, 1.05, 0]), halfSize),
            weight: clamp(toFiniteNumber(item['weight'], 1), 0.25, 4),
        }];
    });
}

function readVec3Array(value: unknown, max: number, halfSize: number): readonly Vec3Tuple[] {
    if (!Array.isArray(value)) {
        return FALLBACK_ARENA_LAYOUT.spawnPoints;
    }
    return value.slice(0, max).flatMap((item) =>
        Array.isArray(item)
            ? [clampPosition(readVec3(item, [0, 1.72, 0]), halfSize)]
            : []
    );
}

function readVec3(
    value: unknown,
    fallback: Vec3Tuple,
    min?: Vec3Tuple,
    max?: Vec3Tuple,
): Vec3Tuple {
    if (!Array.isArray(value)) {
        return fallback;
    }
    const tuple: Vec3Tuple = [
        toFiniteNumber(value[0], fallback[0]),
        toFiniteNumber(value[1], fallback[1]),
        toFiniteNumber(value[2], fallback[2]),
    ];
    if (!min || !max) {
        return tuple;
    }
    return [
        clamp(tuple[0], min[0], max[0]),
        clamp(tuple[1], min[1], max[1]),
        clamp(tuple[2], min[2], max[2]),
    ];
}

function clampPosition(value: Vec3Tuple, halfSize: number): Vec3Tuple {
    const margin = 2;
    return [
        clamp(value[0], -halfSize + margin, halfSize - margin),
        clamp(value[1], 0.08, 9),
        clamp(value[2], -halfSize + margin, halfSize - margin),
    ];
}

function hasSeparatedSpawns(spawns: readonly Vec3Tuple[]): boolean {
    for (let i = 0; i < spawns.length; i += 1) {
        for (let j = i + 1; j < spawns.length; j += 1) {
            if (Math.hypot(spawns[i][0] - spawns[j][0], spawns[i][2] - spawns[j][2]) >= MIN_SPAWN_SEPARATION) {
                return true;
            }
        }
    }
    return false;
}

function segmentIntersectsAabb(
    start: Vec3Tuple,
    end: Vec3Tuple,
    center: Vec3Tuple,
    size: Vec3Tuple,
): boolean {
    const min: Vec3Tuple = [
        center[0] - size[0] / 2,
        center[1] - size[1] / 2,
        center[2] - size[2] / 2,
    ];
    const max: Vec3Tuple = [
        center[0] + size[0] / 2,
        center[1] + size[1] / 2,
        center[2] + size[2] / 2,
    ];
    let tMin = 0;
    let tMax = 1;
    for (let axis = 0; axis < 3; axis += 1) {
        const delta = end[axis] - start[axis];
        if (Math.abs(delta) < 0.0001) {
            if (start[axis] < min[axis] || start[axis] > max[axis]) {
                return false;
            }
            continue;
        }
        const inv = 1 / delta;
        let near = (min[axis] - start[axis]) * inv;
        let far = (max[axis] - start[axis]) * inv;
        if (near > far) {
            [near, far] = [far, near];
        }
        tMin = Math.max(tMin, near);
        tMax = Math.min(tMax, far);
        if (tMin > tMax) {
            return false;
        }
    }
    return true;
}

function readPropKind(value: unknown): ArenaLayoutProp['kind'] {
    return value === 'ramp' || value === 'portal' || value === 'bounce-pad' || value === 'hazard'
        ? value
        : 'cover';
}

function defaultPropLabel(kind: ArenaLayoutProp['kind']): string {
    if (kind === 'portal') {
        return 'Policy Portal';
    }
    if (kind === 'bounce-pad') {
        return 'Morale Launcher';
    }
    if (kind === 'hazard') {
        return 'Late Fee Zone';
    }
    if (kind === 'ramp') {
        return 'Escalation Ramp';
    }
    return 'Compliance Cover';
}

function readString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function readHex(value: unknown, fallback: string): string {
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function toFiniteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function fallback(reason: string): ArenaLayoutValidation {
    return { ok: false, reason, layout: FALLBACK_ARENA_LAYOUT };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash;
}
