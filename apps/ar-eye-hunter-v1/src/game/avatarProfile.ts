import {
    createRallarAiMockProvider,
    type RallarAiJsonProvider,
    type RallarAiJsonRequest,
    type RallarAiJsonSchema
} from '@shared/rallar-ai/mod.ts';

export const AVATAR_PROFILE_SCHEMA_ID = 'ar-eye-hunter.avatar-profile';
export const AVATAR_PROFILE_SCHEMA_VERSION = '2';
export const AVATAR_PROFILE_LEGACY_SCHEMA_VERSION = '1';

export const AVATAR_BODY_SHAPES = [
    'vanguard',
    'sprinter',
    'sentinel',
    'cipher'
] as const;
export const AVATAR_HELMETS = [
    'mono-visor',
    'split-visor',
    'audit-mask',
    'halo-hood'
] as const;
export const AVATAR_ARMOR_TRIMS = [
    'ribbed',
    'shoulder-plates',
    'circuit-sash',
    'blade-collar'
] as const;
export const AVATAR_GLOW_PALETTES = [
    'acid-cyan',
    'magenta-amber',
    'cyan-white',
    'danger-acid'
] as const;
export const AVATAR_TRAILS = [
    'none',
    'scanline',
    'afterimage',
    'spark-leak'
] as const;
export const AVATAR_DECALS = [
    'terms-accepted',
    'bug-bounty',
    'unpaid-overtime',
    'privacy-leak'
] as const;
export const AVATAR_HUMOUR_TAGS = [
    'legally distinct hero',
    'compliance enthusiast',
    'morale still pending',
    'blink twice for payroll'
] as const;
export const AVATAR_ROBOT_FRAMES = [
    'juggernaut',
    'warden',
    'reaper',
    'bulwark'
] as const;
export const AVATAR_TORSO_MASSES = [
    'medium',
    'heavy',
    'titan'
] as const;
export const AVATAR_SHOULDERS = [
    'anvil',
    'spike-rack',
    'riot-shields',
    'reactor-pauldrons'
] as const;
export const AVATAR_FACEPLATES = [
    'grim-slit',
    'skullplate',
    'tax-mask',
    'hollow-smirk'
] as const;
export const AVATAR_EXPRESSIONS = [
    'cold-stare',
    'angry-v',
    'deadpan',
    'grim-smirk'
] as const;
export const AVATAR_BROWS = [
    'blade-brow',
    'downturned',
    'forked',
    'visor-scowl'
] as const;

export type AvatarBodyShape = typeof AVATAR_BODY_SHAPES[number];
export type AvatarHelmetStyle = typeof AVATAR_HELMETS[number];
export type AvatarArmorTrim = typeof AVATAR_ARMOR_TRIMS[number];
export type AvatarGlowPalette = typeof AVATAR_GLOW_PALETTES[number];
export type AvatarTrailStyle = typeof AVATAR_TRAILS[number];
export type AvatarDecal = typeof AVATAR_DECALS[number];
export type AvatarHumourTag = typeof AVATAR_HUMOUR_TAGS[number];
export type RobotFrameKind = typeof AVATAR_ROBOT_FRAMES[number];
export type AvatarTorsoMass = typeof AVATAR_TORSO_MASSES[number];
export type AvatarShoulderStyle = typeof AVATAR_SHOULDERS[number];
export type AvatarFaceplate = typeof AVATAR_FACEPLATES[number];
export type AvatarExpression = typeof AVATAR_EXPRESSIONS[number];
export type AvatarBrowShape = typeof AVATAR_BROWS[number];

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
    robotFrame: RobotFrameKind;
    torsoMass: AvatarTorsoMass;
    shoulderStyle: AvatarShoulderStyle;
    faceplate: AvatarFaceplate;
    visorExpression: AvatarExpression;
    browShape: AvatarBrowShape;
}>;

export type AvatarProfileProposal = Readonly<{
    generationId: string;
    baseRoomId?: string;
    baseSessionId: string;
    baseRevision?: number;
    profile: AvatarProfile;
    sentAtEpochMs: number;
}>;

export type AvatarProfileContext = Readonly<{
    sessionId: string;
    username: string;
    roomId?: string;
    revision?: number;
}>;

export type AvatarProfileValidation =
    | Readonly<{ ok: true; profile: AvatarProfile; }>
    | Readonly<{ ok: false; reason: string; }>;

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
        'robotFrame',
        'torsoMass',
        'shoulderStyle',
        'faceplate',
        'visorExpression',
        'browShape'
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
        robotFrame: { type: 'string', enum: [...AVATAR_ROBOT_FRAMES] },
        torsoMass: { type: 'string', enum: [...AVATAR_TORSO_MASSES] },
        shoulderStyle: { type: 'string', enum: [...AVATAR_SHOULDERS] },
        faceplate: { type: 'string', enum: [...AVATAR_FACEPLATES] },
        visorExpression: { type: 'string', enum: [...AVATAR_EXPRESSIONS] },
        browShape: { type: 'string', enum: [...AVATAR_BROWS] }
    }
};

export function createAvatarProfileRequest(
    context: AvatarProfileContext
): RallarAiJsonRequest<AvatarProfileContext> {
    return {
        requestId: `avatar-profile:${context.sessionId}:${context.revision ?? 0}`,
        schemaId: AVATAR_PROFILE_SCHEMA_ID,
        schemaVersion: AVATAR_PROFILE_SCHEMA_VERSION,
        schema: AVATAR_PROFILE_SCHEMA,
        context,
        baseStateRevision: String(context.revision ?? 0),
        dedupeKey: `avatar-profile:${context.sessionId}`,
        maxOutputTokens: 600,
        temperature: 0.62,
        timeoutMs: 1_200,
        prompt: [
            'Create one cosmetic-only AR Eye Hunter avatar profile.',
            'The avatar must look like a strong intimidating neon robot with a readable facial expression.',
            'Use only enum values from the schema. Do not include gameplay stats, health, weapon bonuses, hitbox changes, speed, damage, or extra fields.',
            `Session: ${context.sessionId}. Username: ${context.username}.`,
            'Keep the callsign short, dry, and darkly funny.'
        ].join('\n')
    };
}

export function createAvatarProfileMockProvider(): RallarAiJsonProvider {
    return createRallarAiMockProvider({
        providerId: 'ar-eye-hunter-avatar-mock',
        modelId: 'deterministic-robot-cosmetics-v1',
        value: (request: RallarAiJsonRequest<AvatarProfileContext>) => {
            const context = request.context;
            const fallback = createDeterministicAvatarProfile(
                context?.sessionId ?? 'mock-session',
                context?.username ?? 'Hunter'
            );
            return {
                ...fallback,
                callsign: fallback.callsign.replace(/^Null /, 'Steel ').slice(0, 22),
                robotFrame: fallback.bodyShape === 'sprinter' ? 'reaper' : fallback.robotFrame,
                torsoMass: fallback.bodyShape === 'sentinel' ? 'titan' : fallback.torsoMass,
                visorExpression: fallback.helmet === 'audit-mask' ? 'deadpan' : fallback.visorExpression
            };
        }
    });
}

const AVATAR_LEGACY_PROFILE_KEYS = new Set([
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
    'humourTag'
]);

const AVATAR_PROFILE_KEYS = new Set([
    ...AVATAR_LEGACY_PROFILE_KEYS,
    'robotFrame',
    'torsoMass',
    'shoulderStyle',
    'faceplate',
    'visorExpression',
    'browShape'
]);

export function createDeterministicAvatarProfile(
    sessionId: string,
    username: string
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
        robotFrame: pick(AVATAR_ROBOT_FRAMES, seed >> 15),
        torsoMass: pick(AVATAR_TORSO_MASSES, seed >> 17),
        shoulderStyle: pick(AVATAR_SHOULDERS, seed >> 19),
        faceplate: pick(AVATAR_FACEPLATES, seed >> 21),
        visorExpression: pick(AVATAR_EXPRESSIONS, seed >> 23),
        browShape: pick(AVATAR_BROWS, seed >> 25)
    };
}

export function validateAvatarProfile(
    value: unknown,
    expectedSessionId?: string
): AvatarProfileValidation {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { ok: false, reason: 'not-object' };
    }

    const record = value as Record<string, unknown>;
    const version = record['version'];
    const legacy = version === AVATAR_PROFILE_LEGACY_SCHEMA_VERSION;
    const allowedKeys = legacy ? AVATAR_LEGACY_PROFILE_KEYS : AVATAR_PROFILE_KEYS;
    for (const key of Object.keys(record)) {
        if (!allowedKeys.has(key)) {
            return { ok: false, reason: `unexpected-field:${key}` };
        }
    }

    if (record['schema'] !== AVATAR_PROFILE_SCHEMA_ID) {
        return { ok: false, reason: 'invalid-schema' };
    }
    if (version !== AVATAR_PROFILE_SCHEMA_VERSION && !legacy) {
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
        robotFrame: legacy
            ? upgradeLegacyRobotFrame(readEnum(record, 'bodyShape', AVATAR_BODY_SHAPES))
            : readEnum(record, 'robotFrame', AVATAR_ROBOT_FRAMES),
        torsoMass: legacy
            ? upgradeLegacyTorsoMass(readEnum(record, 'bodyShape', AVATAR_BODY_SHAPES))
            : readEnum(record, 'torsoMass', AVATAR_TORSO_MASSES),
        shoulderStyle: legacy
            ? upgradeLegacyShoulderStyle(readEnum(record, 'armorTrim', AVATAR_ARMOR_TRIMS))
            : readEnum(record, 'shoulderStyle', AVATAR_SHOULDERS),
        faceplate: legacy
            ? upgradeLegacyFaceplate(readEnum(record, 'helmet', AVATAR_HELMETS))
            : readEnum(record, 'faceplate', AVATAR_FACEPLATES),
        visorExpression: legacy
            ? upgradeLegacyExpression(readEnum(record, 'helmet', AVATAR_HELMETS))
            : readEnum(record, 'visorExpression', AVATAR_EXPRESSIONS),
        browShape: legacy
            ? upgradeLegacyBrowShape(readEnum(record, 'armorTrim', AVATAR_ARMOR_TRIMS))
            : readEnum(record, 'browShape', AVATAR_BROWS)
    };

    for (const key of ['profileId', 'callsign'] as const) {
        if (!profile[key]) {
            return { ok: false, reason: `invalid-${key}` };
        }
    }
    for (
        const key of [
            'bodyShape',
            'helmet',
            'armorTrim',
            'glowPalette',
            'trailStyle',
            'decal',
            'humourTag',
            'robotFrame',
            'torsoMass',
            'shoulderStyle',
            'faceplate',
            'visorExpression',
            'browShape'
        ] as const
    ) {
        if (!profile[key]) {
            return { ok: false, reason: `invalid-${key}` };
        }
    }

    return { ok: true, profile };
}

function upgradeLegacyRobotFrame(shape: AvatarBodyShape): RobotFrameKind {
    switch (shape) {
        case 'sentinel':
            return 'warden';
        case 'sprinter':
            return 'reaper';
        case 'cipher':
            return 'bulwark';
        case 'vanguard':
        default:
            return 'juggernaut';
    }
}

function upgradeLegacyTorsoMass(shape: AvatarBodyShape): AvatarTorsoMass {
    return shape === 'sentinel' || shape === 'vanguard' ? 'heavy' : 'medium';
}

function upgradeLegacyShoulderStyle(trim: AvatarArmorTrim): AvatarShoulderStyle {
    switch (trim) {
        case 'shoulder-plates':
            return 'riot-shields';
        case 'blade-collar':
            return 'spike-rack';
        case 'circuit-sash':
            return 'reactor-pauldrons';
        case 'ribbed':
        default:
            return 'anvil';
    }
}

function upgradeLegacyFaceplate(helmet: AvatarHelmetStyle): AvatarFaceplate {
    switch (helmet) {
        case 'audit-mask':
            return 'tax-mask';
        case 'halo-hood':
            return 'hollow-smirk';
        case 'split-visor':
            return 'skullplate';
        case 'mono-visor':
        default:
            return 'grim-slit';
    }
}

function upgradeLegacyExpression(helmet: AvatarHelmetStyle): AvatarExpression {
    switch (helmet) {
        case 'audit-mask':
            return 'deadpan';
        case 'split-visor':
            return 'angry-v';
        case 'halo-hood':
            return 'grim-smirk';
        case 'mono-visor':
        default:
            return 'cold-stare';
    }
}

function upgradeLegacyBrowShape(trim: AvatarArmorTrim): AvatarBrowShape {
    switch (trim) {
        case 'shoulder-plates':
            return 'visor-scowl';
        case 'blade-collar':
            return 'blade-brow';
        case 'circuit-sash':
            return 'forked';
        case 'ribbed':
        default:
            return 'downturned';
    }
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
    maxLength: number
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
    allowed: readonly T[]
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
