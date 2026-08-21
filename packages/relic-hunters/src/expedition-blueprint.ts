import {
    failRallarAiValidation,
    okRallarAiValidation,
    validateRallarAiJsonSchemaValue,
    type RallarAiJsonSchema,
    type RallarAiValidationIssue,
    type RallarAiValidationResult
} from '@shared/rallar-ai/mod.ts';
import type { RelicDefinition, RelicExpeditionSetupSource, RelicRoom, RelicRoomKind } from './model.ts';

export const RELIC_EXPEDITION_BLUEPRINT_SCHEMA_ID = 'relic-hunters.expedition-blueprint';
export const RELIC_EXPEDITION_BLUEPRINT_SCHEMA_VERSION = '1';

export const RELIC_EXPEDITION_BLUEPRINT_LIMITS = {
    minRooms: 6,
    maxRooms: 12,
    minRelics: 4,
    maxRelics: 18,
    minRelicValue: 1,
    maxRelicValue: 12,
    minCoordinate: -12,
    maxCoordinate: 12,
    maxIdLength: 80,
    maxNameLength: 80,
    maxThemeLength: 80,
    maxSeedLength: 120
} as const;

export const RELIC_EXPEDITION_VISUAL_THEMES = [
    'Morning Garden Keep',
    'Koi Courtyard Citadel',
    'Sunlit Lantern Castle',
    'Breeze Watchtower'
] as const;

export const RELIC_EXPEDITION_VISUAL_LIMITS = {
    maxAbsX: 6,
    maxAbsZ: 7,
    maxEdgeDistance: 5,
    maxRoomNameLength: 42
} as const;

export const RELIC_ROOM_KINDS: readonly RelicRoomKind[] = [
    'entrance',
    'hallway',
    'storage',
    'shrine',
    'trap',
    'treasure',
    'monster',
    'exit'
];

export type RelicExpeditionBlueprintRoom = Readonly<{
    id: string;
    name: string;
    kind: RelicRoomKind;
    x: number;
    z: number;
    neighbors: readonly string[];
    collapsed?: boolean;
    unstable?: boolean;
}>;

export type RelicExpeditionBlueprintRelic = Readonly<{
    id: string;
    name: string;
    value: number;
    roomId: string;
}>;

export type RelicExpeditionBlueprint = Readonly<{
    schemaVersion: 1;
    seed: string;
    theme: string;
    source?: RelicExpeditionSetupSource;
    rooms: readonly RelicExpeditionBlueprintRoom[];
    relics: readonly RelicExpeditionBlueprintRelic[];
}>;

export type CreateProceduralRelicExpeditionBlueprintOptions = Readonly<{
    seed: string;
    theme?: string;
    source?: RelicExpeditionSetupSource;
}>;

const ID_SCHEMA: RallarAiJsonSchema = {
    type: 'string',
    minLength: 1,
    maxLength: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxIdLength
};

export const RELIC_EXPEDITION_BLUEPRINT_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: ['schemaVersion', 'seed', 'theme', 'rooms', 'relics'],
    additionalProperties: false,
    properties: {
        schemaVersion: { type: 'integer', const: 1 },
        seed: {
            type: 'string',
            minLength: 1,
            maxLength: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxSeedLength
        },
        theme: {
            type: 'string',
            minLength: 1,
            maxLength: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxThemeLength
        },
        source: {
            type: 'string',
            enum: ['default', 'procedural', 'rallar-ai', 'mock']
        },
        rooms: {
            type: 'array',
            minItems: RELIC_EXPEDITION_BLUEPRINT_LIMITS.minRooms,
            maxItems: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxRooms,
            items: {
                type: 'object',
                required: ['id', 'name', 'kind', 'x', 'z', 'neighbors'],
                additionalProperties: false,
                properties: {
                    id: ID_SCHEMA,
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxNameLength
                    },
                    kind: { type: 'string', enum: RELIC_ROOM_KINDS },
                    x: {
                        type: 'number',
                        minimum: RELIC_EXPEDITION_BLUEPRINT_LIMITS.minCoordinate,
                        maximum: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxCoordinate
                    },
                    z: {
                        type: 'number',
                        minimum: RELIC_EXPEDITION_BLUEPRINT_LIMITS.minCoordinate,
                        maximum: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxCoordinate
                    },
                    neighbors: {
                        type: 'array',
                        minItems: 1,
                        maxItems: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxRooms - 1,
                        items: ID_SCHEMA
                    }
                }
            }
        },
        relics: {
            type: 'array',
            minItems: RELIC_EXPEDITION_BLUEPRINT_LIMITS.minRelics,
            maxItems: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxRelics,
            items: {
                type: 'object',
                required: ['id', 'name', 'value', 'roomId'],
                additionalProperties: false,
                properties: {
                    id: ID_SCHEMA,
                    name: {
                        type: 'string',
                        minLength: 1,
                        maxLength: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxNameLength
                    },
                    value: {
                        type: 'integer',
                        minimum: RELIC_EXPEDITION_BLUEPRINT_LIMITS.minRelicValue,
                        maximum: RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxRelicValue
                    },
                    roomId: ID_SCHEMA
                }
            }
        }
    }
};

export function validateRelicExpeditionBlueprint(
    value: unknown
): RallarAiValidationResult {
    const schemaValidation = validateRallarAiJsonSchemaValue(
        RELIC_EXPEDITION_BLUEPRINT_SCHEMA,
        value
    );
    const issues = [...schemaValidation.issues];

    if (!isRecord(value)) {
        return failRallarAiValidation(issues);
    }

    const rooms = Array.isArray(value.rooms) ? value.rooms : [];
    const relics = Array.isArray(value.relics) ? value.relics : [];
    validateRooms(rooms, issues);
    validateRelics(relics, rooms, issues);

    return issues.length === 0
        ? okRallarAiValidation()
        : failRallarAiValidation(issues);
}

export function assertRelicExpeditionBlueprint(
    value: unknown
): asserts value is RelicExpeditionBlueprint {
    const validation = validateRelicExpeditionBlueprint(value);
    if (!validation.ok) {
        throw new Error(
            `Invalid Relic expedition blueprint: ${validation.errors.join('; ')}`
        );
    }
}

export function validateRelicExpeditionVisualFit(
    value: unknown
): RallarAiValidationResult {
    const baseValidation = validateRelicExpeditionBlueprint(value);
    const issues = [...baseValidation.issues];

    if (!isRecord(value)) {
        return failRallarAiValidation(issues);
    }

    if (
        typeof value.theme !== 'string' ||
        !RELIC_EXPEDITION_VISUAL_THEMES.includes(
            value.theme as typeof RELIC_EXPEDITION_VISUAL_THEMES[number]
        )
    ) {
        issues.push(issue(
            '$.theme',
            'visual-theme',
            `Theme must be one of: ${RELIC_EXPEDITION_VISUAL_THEMES.join(', ')}.`
        ));
    }

    const rooms = Array.isArray(value.rooms) ? value.rooms.filter(isRecord) : [];
    const roomById = new Map<string, Record<string, unknown>>();
    for (const room of rooms) {
        if (typeof room.id === 'string') {
            roomById.set(room.id, room);
        }
    }

    for (const [index, room] of rooms.entries()) {
        const path = `$.rooms[${index}]`;
        if (typeof room.name === 'string' && room.name.length > RELIC_EXPEDITION_VISUAL_LIMITS.maxRoomNameLength) {
            issues.push(issue(
                `${path}.name`,
                'visual-room-name-length',
                `Room names must fit compact HUD labels (${RELIC_EXPEDITION_VISUAL_LIMITS.maxRoomNameLength} chars max).`
            ));
        }
        validateVisualCoordinate(room.x, `${path}.x`, RELIC_EXPEDITION_VISUAL_LIMITS.maxAbsX, issues);
        validateVisualCoordinate(room.z, `${path}.z`, RELIC_EXPEDITION_VISUAL_LIMITS.maxAbsZ, issues);

        if (!Array.isArray(room.neighbors) || typeof room.id !== 'string') {
            continue;
        }
        for (const neighborId of room.neighbors) {
            if (typeof neighborId !== 'string' || room.id > neighborId) {
                continue;
            }
            const neighbor = roomById.get(neighborId);
            if (!neighbor || !isNumber(room.x) || !isNumber(room.z) || !isNumber(neighbor.x) || !isNumber(neighbor.z)) {
                continue;
            }
            const distance = Math.hypot(room.x - neighbor.x, room.z - neighbor.z);
            if (distance > RELIC_EXPEDITION_VISUAL_LIMITS.maxEdgeDistance) {
                issues.push(issue(
                    `${path}.neighbors`,
                    'visual-edge-distance',
                    `Neighbor edges must stay within ${RELIC_EXPEDITION_VISUAL_LIMITS.maxEdgeDistance} grid units for camera and map readability.`
                ));
            }
        }
    }

    return issues.length === 0
        ? okRallarAiValidation()
        : failRallarAiValidation(issues);
}

export function assertRelicExpeditionVisualFit(
    value: unknown
): asserts value is RelicExpeditionBlueprint {
    const validation = validateRelicExpeditionVisualFit(value);
    if (!validation.ok) {
        throw new Error(
            `Invalid Relic expedition visual fit: ${validation.errors.join('; ')}`
        );
    }
}

export function createProceduralRelicExpeditionBlueprint(
    options: CreateProceduralRelicExpeditionBlueprintOptions
): RelicExpeditionBlueprint {
    const random = createSeededRandom(options.seed);
    const mirror = random() >= 0.5 ? -1 : 1;
    const verticalOffset = Math.floor(random() * 3) - 1;
    const includeGallery = random() >= 0.35;
    const includeBarracks = random() >= 0.55;
    const theme = options.theme ?? proceduralTheme(random);

    const rooms: RelicExpeditionBlueprintRoom[] = [
        room('entrance', themedName(theme, 'Gatehouse'), 'entrance', 0, -6 + verticalOffset, [
            'hallway',
            'storage'
        ]),
        room('hallway', themedName(theme, 'Long Gallery'), 'hallway', 0, -3 + verticalOffset, [
            'entrance',
            'shrine',
            'trap',
            ...(includeGallery ? ['gallery'] : [])
        ]),
        room('storage', themedName(theme, 'Armory Stores'), 'storage', -4 * mirror, -3 + verticalOffset, [
            'entrance',
            'trap'
        ]),
        room('shrine', themedName(theme, 'Lantern Shrine'), 'shrine', 4 * mirror, -3 + verticalOffset, [
            'hallway',
            'treasure'
        ]),
        room('trap', themedName(theme, 'Pressure Cell'), 'trap', 0, verticalOffset, [
            'hallway',
            'storage',
            'treasure',
            'monster'
        ]),
        room('treasure', themedName(theme, 'Moon Vault'), 'treasure', 4 * mirror, verticalOffset, [
            'shrine',
            'trap',
            ...(includeGallery ? ['gallery'] : [])
        ]),
        room('monster', themedName(theme, 'Broken Barracks'), 'monster', 0, 3 + verticalOffset, [
            'trap',
            'exit',
            ...(includeBarracks ? ['barracks'] : [])
        ]),
        room('exit', themedName(theme, 'Garden Watchtower'), 'exit', 0, 6 + verticalOffset, [
            'monster'
        ])
    ];

    if (includeGallery) {
        rooms.push(room('gallery', themedName(theme, 'Painted Gallery'), 'hallway', 2 * mirror, -1 + verticalOffset, [
            'hallway',
            'treasure'
        ]));
    }
    if (includeBarracks) {
        rooms.push(room('barracks', themedName(theme, 'Ash Barracks'), 'storage', -3 * mirror, 3 + verticalOffset, [
            'monster'
        ]));
    }

    return {
        schemaVersion: 1,
        seed: options.seed,
        theme,
        source: options.source ?? 'procedural',
        rooms,
        relics: proceduralRelics(random, rooms)
    };
}

export function roomsFromRelicExpeditionBlueprint(
    blueprint: RelicExpeditionBlueprint
): readonly RelicRoom[] {
    return blueprint.rooms.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        kind: candidate.kind,
        x: candidate.x,
        z: candidate.z,
        neighbors: [...candidate.neighbors]
    }));
}

export function relicsFromRelicExpeditionBlueprint(
    blueprint: RelicExpeditionBlueprint
): readonly RelicDefinition[] {
    const relics = blueprint.relics.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        value: candidate.value,
        roomId: candidate.roomId
    }));
    return ensureRelicCoverage(blueprint.rooms, relics);
}

function validateRooms(
    rawRooms: readonly unknown[],
    issues: RallarAiValidationIssue[]
): void {
    const rooms = rawRooms.filter(isRecord);
    const roomIds = new Set<string>();
    const coordinates = new Set<string>();

    for (const [index, room] of rooms.entries()) {
        const path = `$.rooms[${index}]`;
        if (typeof room.id !== 'string' || !isStableId(room.id)) {
            issues.push(issue(`${path}.id`, 'invalid-room-id', 'Room id must be stable kebab-case.'));
            continue;
        }
        if (roomIds.has(room.id)) {
            issues.push(issue(`${path}.id`, 'duplicate-room-id', 'Room id must be unique.'));
        }
        roomIds.add(room.id);

        if (room.collapsed !== undefined || room.unstable !== undefined) {
            issues.push(issue(path, 'initial-room-state', 'Rooms cannot start collapsed or unstable.'));
        }

        const coordinateKey = `${room.x}:${room.z}`;
        if (coordinates.has(coordinateKey)) {
            issues.push(issue(path, 'overlapping-room-coordinate', 'Room coordinates must not overlap.'));
        }
        coordinates.add(coordinateKey);

        if (Array.isArray(room.neighbors)) {
            const neighborIds = new Set<string>();
            for (const [neighborIndex, neighborId] of room.neighbors.entries()) {
                const neighborPath = `${path}.neighbors[${neighborIndex}]`;
                if (neighborId === room.id) {
                    issues.push(issue(neighborPath, 'self-neighbor', 'Room cannot neighbor itself.'));
                }
                if (typeof neighborId === 'string' && neighborIds.has(neighborId)) {
                    issues.push(issue(neighborPath, 'duplicate-neighbor', 'Neighbor id must be unique per room.'));
                }
                if (typeof neighborId === 'string') {
                    neighborIds.add(neighborId);
                }
            }
        }
    }

    const entrance = rooms.find((room) => room.id === 'entrance');
    const exit = rooms.find((room) => room.id === 'exit');
    if (!entrance) {
        issues.push(issue('$.rooms', 'missing-entrance', 'Blueprint must include room id entrance.'));
    }
    else if (entrance.kind !== 'entrance') {
        issues.push(issue('$.rooms.entrance.kind', 'invalid-entrance-kind', 'Entrance room must use entrance kind.'));
    }
    if (!exit) {
        issues.push(issue('$.rooms', 'missing-exit', 'Blueprint must include room id exit.'));
    }
    else if (exit.kind !== 'exit') {
        issues.push(issue('$.rooms.exit.kind', 'invalid-exit-kind', 'Exit room must use exit kind.'));
    }

    for (const room of rooms) {
        if (!Array.isArray(room.neighbors)) {
            continue;
        }
        for (const neighborId of room.neighbors) {
            if (typeof neighborId !== 'string') {
                continue;
            }
            const neighbor = rooms.find((candidate) => candidate.id === neighborId);
            if (!neighbor) {
                issues.push(
                    issue(`$.rooms.${room.id}.neighbors`, 'unknown-neighbor', `Unknown neighbor ${neighborId}.`)
                );
                continue;
            }
            if (!Array.isArray(neighbor.neighbors) || !neighbor.neighbors.includes(room.id)) {
                issues.push(
                    issue(
                        `$.rooms.${room.id}.neighbors`,
                        'asymmetric-neighbor',
                        `Neighbor ${neighborId} must link back to ${room.id}.`
                    )
                );
            }
        }
    }

    if (
        entrance &&
        exit &&
        typeof entrance.id === 'string' &&
        typeof exit.id === 'string' &&
        rooms.length > 0
    ) {
        const reachable = reachableRoomIds(rooms, entrance.id);
        if (!reachable.has(exit.id)) {
            issues.push(issue('$.rooms', 'unreachable-exit', 'Exit must be reachable from entrance.'));
        }
        if (reachable.size !== rooms.length) {
            issues.push(issue('$.rooms', 'disconnected-graph', 'Every room must be reachable from entrance.'));
        }
    }
}

function validateRelics(
    rawRelics: readonly unknown[],
    rawRooms: readonly unknown[],
    issues: RallarAiValidationIssue[]
): void {
    const roomIds = new Set(rawRooms.filter(isRecord).map((room) => room.id).filter(isString));
    const relicIds = new Set<string>();

    for (const [index, relic] of rawRelics.entries()) {
        const path = `$.relics[${index}]`;
        if (!isRecord(relic)) {
            continue;
        }
        if (typeof relic.id !== 'string' || !isStableId(relic.id)) {
            issues.push(issue(`${path}.id`, 'invalid-relic-id', 'Relic id must be stable kebab-case.'));
            continue;
        }
        if (relicIds.has(relic.id)) {
            issues.push(issue(`${path}.id`, 'duplicate-relic-id', 'Relic id must be unique.'));
        }
        relicIds.add(relic.id);
        if (typeof relic.roomId === 'string' && !roomIds.has(relic.roomId)) {
            issues.push(
                issue(`${path}.roomId`, 'unknown-relic-room', 'Relic roomId must refer to a room in the blueprint.')
            );
        }
    }
}

function proceduralRelics(
    random: () => number,
    rooms: readonly RelicExpeditionBlueprintRoom[]
): readonly RelicExpeditionBlueprintRelic[] {
    const candidateRooms = rooms;
    const names = shuffle([
        'Crimson Fan of Quarterly Losses',
        'Jade Oni Severance Seal',
        'Silver Bell of Mandatory Cheer',
        'Storm Pearl Helpdesk Ticket',
        'Sun Disk Compliance Badge',
        'Moon Comb for Executive Hair',
        'Ivory Netsuke of Mild Panic',
        'Bronze Mirror That Blames You',
        'Foxfire Mask, Lightly Audited',
        'Lotus Crown of Unpaid Overtime',
        'Ashen Tanto Return Form',
        'Golden Koi Exit Voucher',
        'Neon Shrine Receipt',
        'Predator Wellness Coupon',
        'Pressure Plate Apology Token',
        'Gift Shop Escape Stub'
    ], random);
    const relics: RelicExpeditionBlueprintRelic[] = [];
    const relicCount = Math.min(
        RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxRelics,
        rooms.length + 4 + Math.floor(random() * 5)
    );

    for (let index = 0; index < relicCount; index += 1) {
        const targetRoom = candidateRooms[index % candidateRooms.length] ?? rooms[0];
        const name = names[index % names.length];
        relics.push({
            id: `${toStableId(name)}-${index + 1}`,
            name,
            value: RELIC_EXPEDITION_BLUEPRINT_LIMITS.minRelicValue +
                Math.floor(random() * RELIC_EXPEDITION_BLUEPRINT_LIMITS.maxRelicValue),
            roomId: targetRoom.id
        });
    }

    return relics;
}

function ensureRelicCoverage(
    rooms: readonly Pick<RelicExpeditionBlueprintRoom, 'id' | 'name' | 'kind'>[],
    relics: readonly RelicDefinition[]
): readonly RelicDefinition[] {
    const coveredRoomIds = new Set(relics.map((relic) => relic.roomId));
    const usedIds = new Set(relics.map((relic) => relic.id));
    const additions: RelicDefinition[] = [];
    for (const room of rooms) {
        if (coveredRoomIds.has(room.id)) {
            continue;
        }
        let id = `${room.id}-facility-relic`;
        let suffix = 2;
        while (usedIds.has(id)) {
            id = `${room.id}-facility-relic-${suffix}`;
            suffix += 1;
        }
        usedIds.add(id);
        additions.push({
            id,
            name: fallbackRelicNameForRoom(room),
            value: room.kind === 'exit' ? 2 : room.kind === 'entrance' || room.kind === 'hallway' ? 1 : 3,
            roomId: room.id
        });
    }
    return [...relics, ...additions];
}

function fallbackRelicNameForRoom(
    room: Pick<RelicExpeditionBlueprintRoom, 'name' | 'kind'>
): string {
    switch (room.kind) {
        case 'entrance':
            return 'Visitor Waiver With Bite Marks';
        case 'hallway':
            return 'Queue Token for Doom';
        case 'storage':
            return 'Inventory Audit Katana';
        case 'shrine':
            return 'Morale Compliance Shrine Chip';
        case 'trap':
            return 'Safety Third Warning Plate';
        case 'treasure':
            return 'Executive Bonus Vault Key';
        case 'monster':
            return 'Employee Wellness Fang';
        case 'exit':
            return 'Gift Shop Exit Voucher';
    }
}

function room(
    id: string,
    name: string,
    kind: RelicRoomKind,
    x: number,
    z: number,
    neighbors: readonly string[]
): RelicExpeditionBlueprintRoom {
    return {
        id,
        name,
        kind,
        x,
        z,
        neighbors
    };
}

function proceduralTheme(random: () => number): string {
    return shuffle(RELIC_EXPEDITION_VISUAL_THEMES, random)[0] ?? 'Morning Garden Keep';
}

function themedName(theme: string, roomName: string): string {
    return `${theme} ${roomName}`;
}

function reachableRoomIds(
    rooms: readonly Record<string, unknown>[],
    startRoomId: string
): Set<string> {
    const byId = new Map(rooms.map((room) => [room.id, room]));
    const reachable = new Set<string>();
    const queue = [startRoomId];
    while (queue.length > 0) {
        const roomId = queue.shift();
        if (!roomId || reachable.has(roomId)) {
            continue;
        }
        reachable.add(roomId);
        const room = byId.get(roomId);
        if (!room || !Array.isArray(room.neighbors)) {
            continue;
        }
        for (const neighborId of room.neighbors) {
            if (typeof neighborId === 'string' && !reachable.has(neighborId)) {
                queue.push(neighborId);
            }
        }
    }
    return reachable;
}

function createSeededRandom(seed: string): () => number {
    let state = 2166136261;
    for (const char of seed) {
        state ^= char.charCodeAt(0);
        state = Math.imul(state, 16777619) >>> 0;
    }
    return () => {
        state += 0x6D2B79F5;
        let value = state;
        value = Math.imul(value ^ value >>> 15, value | 1);
        value ^= value + Math.imul(value ^ value >>> 7, value | 61);
        return ((value ^ value >>> 14) >>> 0) / 4294967296;
    };
}

function shuffle<T>(values: readonly T[], random: () => number): readonly T[] {
    const next = [...values];
    for (let index = next.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [next[index], next[swapIndex]] = [next[swapIndex], next[index]];
    }
    return next;
}

function toStableId(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isStableId(value: string): boolean {
    return /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
}

function issue(path: string, code: string, message: string): RallarAiValidationIssue {
    return { path, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isString(value: unknown): value is string {
    return typeof value === 'string';
}

function isNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function validateVisualCoordinate(
    value: unknown,
    path: string,
    maxAbsValue: number,
    issues: RallarAiValidationIssue[]
): void {
    if (!isNumber(value)) {
        return;
    }
    if (!Number.isInteger(value)) {
        issues.push(issue(path, 'visual-coordinate-integer', 'Room coordinates must be integers.'));
    }
    if (Math.abs(value) > maxAbsValue) {
        issues.push(issue(
            path,
            'visual-coordinate-footprint',
            `Room coordinate must stay within +/-${maxAbsValue}.`
        ));
    }
}
