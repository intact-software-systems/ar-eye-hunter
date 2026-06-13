import type { RallarAiJsonSchema } from '@shared/rallar-ai/mod.ts';

export const AVATAR_PROFILE_SCHEMA_ID = 'ar-eye-hunter.avatar-profile';
export const AVATAR_PROFILE_SCHEMA_VERSION = '1';

export const AVATAR_BODY_SHAPES = [
    'vanguard',
    'sprinter',
    'sentinel',
    'cipher',
] as const;
export const AVATAR_HELMETS = [
    'mono-visor',
    'split-visor',
    'audit-mask',
    'halo-hood',
] as const;
export const AVATAR_ARMOR_TRIMS = [
    'ribbed',
    'shoulder-plates',
    'circuit-sash',
    'blade-collar',
] as const;
export const AVATAR_GLOW_PALETTES = [
    'acid-cyan',
    'magenta-amber',
    'cyan-white',
    'danger-acid',
] as const;
export const AVATAR_TRAILS = [
    'none',
    'scanline',
    'afterimage',
    'spark-leak',
] as const;
export const AVATAR_DECALS = [
    'terms-accepted',
    'bug-bounty',
    'unpaid-overtime',
    'privacy-leak',
] as const;
export const AVATAR_HUMOUR_TAGS = [
    'legally distinct hero',
    'compliance enthusiast',
    'morale still pending',
    'blink twice for payroll',
] as const;

export type AvatarBodyShape = typeof AVATAR_BODY_SHAPES[number];
export type AvatarHelmetStyle = typeof AVATAR_HELMETS[number];
export type AvatarArmorTrim = typeof AVATAR_ARMOR_TRIMS[number];
export type AvatarGlowPalette = typeof AVATAR_GLOW_PALETTES[number];
export type AvatarTrailStyle = typeof AVATAR_TRAILS[number];
export type AvatarDecal = typeof AVATAR_DECALS[number];
export type AvatarHumourTag = typeof AVATAR_HUMOUR_TAGS[number];

export type AvatarProfile = Readonly<{
    schema: typeof AVATAR_PROFILE_SCHEMA_ID;
    version: typeof AVATAR_PROFILE_SCHEMA_VERSION;
    profileId: string;
    sessionId: string;
    callsign: string;
    bodyShape: AvatarBodyShape;
    helmet: AvatarHelmetStyle;
    armorTrim: AvatarArmorTrim;
    glowPalette: AvatarGlowPalette;
    trailStyle: AvatarTrailStyle;
    decal: AvatarDecal;
    humourTag: AvatarHumourTag;
}>;

export type AvatarProfileProposal = Readonly<{
    generationId: string;
    baseRoomId?: string;
    baseSessionId: string;
    baseRevision?: number;
    profile: AvatarProfile;
    sentAtEpochMs: number;
}>;

export type AvatarProfileValidation =
    | Readonly<{ ok: true; profile: AvatarProfile }>
    | Readonly<{ ok: false; reason: string }>;

export const AVATAR_PROFILE_SCHEMA: RallarAiJsonSchema = {
    type: 'object',
    required: [
        'schema',
        'version',
        'profileId',
        'sessionId',
        'callsign',
        'bodyShape',
        'helmet',
        'armorTrim',
        'glowPalette',
        'trailStyle',
        'decal',
        'humourTag',
    ],
    additionalProperties: false,
    properties: {
        schema: { type: 'string', enum: [AVATAR_PROFILE_SCHEMA_ID] },
        version: { type: 'string', enum: [AVATAR_PROFILE_SCHEMA_VERSION] },
        profileId: { type: 'string', minLength: 1, maxLength: 80 },
        sessionId: { type: 'string', minLength: 1, maxLength: 120 },
        callsign: { type: 'string', minLength: 1, maxLength: 22 },
        bodyShape: { type: 'string', enum: [...AVATAR_BODY_SHAPES] },
        helmet: { type: 'string', enum: [...AVATAR_HELMETS] },
        armorTrim: { type: 'string', enum: [...AVATAR_ARMOR_TRIMS] },
        glowPalette: { type: 'string', enum: [...AVATAR_GLOW_PALETTES] },
        trailStyle: { type: 'string', enum: [...AVATAR_TRAILS] },
        decal: { type: 'string', enum: [...AVATAR_DECALS] },
        humourTag: { type: 'string', enum: [...AVATAR_HUMOUR_TAGS] },
    },
};

const AVATAR_PROFILE_KEYS = new Set([
    'schema',
    'version',
    'profileId',
    'sessionId',
    'callsign',
    'bodyShape',
    'helmet',
    'armorTrim',
    'glowPalette',
    'trailStyle',
    'decal',
    'humourTag',
]);

export function createDeterministicAvatarProfile(
    sessionId: string,
    username: string,
): AvatarProfile {
    const seed = hashString(`${sessionId}:${username}`);
    const callsignBase = username.trim() || 'Hunter';
    return {
        schema: AVATAR_PROFILE_SCHEMA_ID,
        version: AVATAR_PROFILE_SCHEMA_VERSION,
        profileId: `avatar:${sessionId}:${Math.abs(seed).toString(36)}`,
        sessionId,
        callsign: `${pick(['Null', 'Neon', 'Audit', 'Laser'], seed)} ${callsignBase}`.slice(0, 22),
        bodyShape: pick(AVATAR_BODY_SHAPES, seed),
        helmet: pick(AVATAR_HELMETS, seed >> 3),
        armorTrim: pick(AVATAR_ARMOR_TRIMS, seed >> 5),
        glowPalette: pick(AVATAR_GLOW_PALETTES, seed >> 7),
        trailStyle: pick(AVATAR_TRAILS, seed >> 9),
        decal: pick(AVATAR_DECALS, seed >> 11),
        humourTag: pick(AVATAR_HUMOUR_TAGS, seed >> 13),
    };
}

export function validateAvatarProfile(
    value: unknown,
    expectedSessionId?: string,
): AvatarProfileValidation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'not-object' };
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
        if (!AVATAR_PROFILE_KEYS.has(key)) {
            return { ok: false, reason: `unexpected-field:${key}` };
        }
    }

    if (record['schema'] !== AVATAR_PROFILE_SCHEMA_ID) {
        return { ok: false, reason: 'invalid-schema' };
    }
    if (record['version'] !== AVATAR_PROFILE_SCHEMA_VERSION) {
        return { ok: false, reason: 'invalid-version' };
    }

    const sessionId = readShortString(record, 'sessionId', 120);
    if (!sessionId) {
        return { ok: false, reason: 'invalid-sessionId' };
    }
    if (expectedSessionId && sessionId !== expectedSessionId) {
        return { ok: false, reason: 'session-mismatch' };
    }

    const profile: AvatarProfile = {
        schema: AVATAR_PROFILE_SCHEMA_ID,
        version: AVATAR_PROFILE_SCHEMA_VERSION,
        profileId: readShortString(record, 'profileId', 80) ?? '',
        sessionId,
        callsign: readShortString(record, 'callsign', 22) ?? '',
        bodyShape: readEnum(record, 'bodyShape', AVATAR_BODY_SHAPES),
        helmet: readEnum(record, 'helmet', AVATAR_HELMETS),
        armorTrim: readEnum(record, 'armorTrim', AVATAR_ARMOR_TRIMS),
        glowPalette: readEnum(record, 'glowPalette', AVATAR_GLOW_PALETTES),
        trailStyle: readEnum(record, 'trailStyle', AVATAR_TRAILS),
        decal: readEnum(record, 'decal', AVATAR_DECALS),
        humourTag: readEnum(record, 'humourTag', AVATAR_HUMOUR_TAGS),
    };

    for (const key of ['profileId', 'callsign'] as const) {
        if (!profile[key]) {
            return { ok: false, reason: `invalid-${key}` };
        }
    }
    for (const key of [
        'bodyShape',
        'helmet',
        'armorTrim',
        'glowPalette',
        'trailStyle',
        'decal',
        'humourTag',
    ] as const) {
        if (!profile[key]) {
            return { ok: false, reason: `invalid-${key}` };
        }
    }

    return { ok: true, profile };
}

export function avatarAccentForPalette(palette: AvatarGlowPalette): string {
    switch (palette) {
        case 'magenta-amber':
            return '#ff3df2';
        case 'cyan-white':
            return '#00e5ff';
        case 'danger-acid':
            return '#ff4d7d';
        case 'acid-cyan':
        default:
            return '#49ff86';
    }
}

function readShortString(
    record: Record<string, unknown>,
    key: string,
    maxLength: number,
): string | undefined {
    const value = record[key];
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > maxLength) {
        return undefined;
    }
    return trimmed;
}

function readEnum<T extends string>(
    record: Record<string, unknown>,
    key: string,
    allowed: readonly T[],
): T {
    const value = record[key];
    return typeof value === 'string' && allowed.includes(value as T)
        ? value as T
        : '' as T;
}

function pick<T>(values: readonly T[], seed: number): T {
    return values[Math.abs(seed) % values.length];
}

function hashString(value: string): number {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
        hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
    }
    return hash;
}
