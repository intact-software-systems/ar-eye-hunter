import { hashRallarAiJson } from './rallar-ai-hashing.ts';

export type RallarAiFunnyRoomNameTheme = 'ar-eye-hunter' | 'relic-hunters';

export type CreateRallarAiFunnyRoomNameOptions = Readonly<{
    baseName: string;
    theme: RallarAiFunnyRoomNameTheme;
    seed: string;
    existingNames?: readonly string[];
}>;

const ROOM_NAME_MAX_LENGTH = 72;
const MAX_NAME_ATTEMPTS = 64;
const DEFAULT_BASE_NAMES: Record<RallarAiFunnyRoomNameTheme, string> = {
    'ar-eye-hunter': 'AR Eye Hunter Arena',
    'relic-hunters': 'Relic Hunters Expedition'
};

const THEME_WORDS: Record<
    RallarAiFunnyRoomNameTheme,
    Readonly<{
        adjectives: readonly string[];
        nouns: readonly string[];
    }>
> = {
    'ar-eye-hunter': {
        adjectives: [
            'Quantum',
            'Neon',
            'Turbo',
            'Glitchy',
            'Pixel',
            'Wobbly',
            'Hyper',
            'Vector',
            'Recursive',
            'Laser',
            'Cosmic',
            'Hologram'
        ],
        nouns: [
            'Crosshair',
            'Reticle',
            'Beacon',
            'Bullseye',
            'Snapshot',
            'Prism',
            'Spark',
            'Dart',
            'Lens',
            'Ping',
            'Circuit',
            'Target'
        ]
    },
    'relic-hunters': {
        adjectives: [
            'Quantum',
            'Neon',
            'Turbo',
            'Glitchy',
            'Pixel',
            'Wobbly',
            'Hyper',
            'Vector',
            'Recursive',
            'Laser',
            'Cosmic',
            'Hologram'
        ],
        nouns: [
            'Teacup',
            'Compass',
            'Pickle',
            'Noodle',
            'Lantern',
            'Keycard',
            'Scroll',
            'Dojo',
            'Kiosk',
            'Satchel',
            'Map',
            'Pebble'
        ]
    }
};

export function createRallarAiRoomNameSeed(prefix = 'rallar-ai-room'): string {
    const randomPart = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).slice(2, 10);

    return `${prefix}:${Date.now().toString(36)}:${randomPart}`;
}

export function createRallarAiFunnyRoomName(
    options: CreateRallarAiFunnyRoomNameOptions
): string {
    const baseName = normalizeRoomName(options.baseName) ||
        DEFAULT_BASE_NAMES[options.theme];
    const existingNames = new Set(
        (options.existingNames ?? []).map(normalizeComparableName)
    );

    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
        const candidate = createCandidateName(options.theme, baseName, options.seed, attempt);
        if (!existingNames.has(normalizeComparableName(candidate))) {
            return candidate;
        }
    }

    return createFallbackName(options.theme, baseName, options.seed, existingNames);
}

function createCandidateName(
    theme: RallarAiFunnyRoomNameTheme,
    baseName: string,
    seed: string,
    attempt: number
): string {
    const words = THEME_WORDS[theme];
    const saltedSeed = `${theme}:${baseName}:${seed}:${attempt}`;
    const adjective = words.adjectives[indexFor(`${saltedSeed}:adjective`, words.adjectives.length)];
    const noun = words.nouns[indexFor(`${saltedSeed}:noun`, words.nouns.length)];
    const code = shortCode(`${saltedSeed}:code`);
    return compactRoomName(baseName, `${adjective} ${noun}`, code);
}

function createFallbackName(
    theme: RallarAiFunnyRoomNameTheme,
    baseName: string,
    seed: string,
    existingNames: ReadonlySet<string>
): string {
    let sequence = existingNames.size;
    while (true) {
        const code = shortCode(`${theme}:${baseName}:${seed}:fallback:${sequence}`);
        const candidate = compactRoomName(baseName, 'RallarAI Session', `${code}-${sequence}`);
        if (!existingNames.has(normalizeComparableName(candidate))) {
            return candidate;
        }
        sequence += 1;
    }
}

function compactRoomName(baseName: string, callsign: string, code: string): string {
    const suffix = ` #${code}`;
    const fullName = `${baseName}: ${callsign}${suffix}`;
    if (fullName.length <= ROOM_NAME_MAX_LENGTH) {
        return fullName;
    }

    const maxCallsignLength = Math.max(
        8,
        ROOM_NAME_MAX_LENGTH - baseName.length - ': '.length - suffix.length
    );
    return `${baseName}: ${callsign.slice(0, maxCallsignLength).trimEnd()}${suffix}`;
}

function shortCode(seed: string): string {
    return hashHex(seed).slice(0, 6).toUpperCase();
}

function indexFor(seed: string, length: number): number {
    return Number.parseInt(hashHex(seed), 16) % length;
}

function hashHex(seed: string): string {
    const hash = hashRallarAiJson({ seed });
    return hash.slice(hash.lastIndexOf(':') + 1);
}

function normalizeRoomName(value: string): string {
    return value.trim().replace(/\s+/g, ' ');
}

function normalizeComparableName(value: string): string {
    return normalizeRoomName(value).toLowerCase();
}
