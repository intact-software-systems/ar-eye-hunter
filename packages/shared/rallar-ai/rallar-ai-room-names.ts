import { hashRallarAiJson } from './rallar-ai-hashing.ts';

export interface RallarAiFunnyRoomNameTheme {
    readonly id: string;
    readonly defaultBaseName: string;
    readonly nouns: readonly string[];
}

export interface CreateRallarAiFunnyRoomNameOptions {
    readonly baseName: string;
    readonly theme: RallarAiFunnyRoomNameTheme;
    readonly seed: string;
    readonly existingNames?: readonly string[];
}

const ROOM_NAME_MAX_LENGTH = 72;
const MAX_NAME_ATTEMPTS = 64;
const ADJECTIVES = [
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
];

export function createRallarAiRoomNameSeed(prefix = 'rallar-ai-room'): string {
    const randomPart = typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).slice(2, 10);

    return `${prefix}:${Date.now().toString(36)}:${randomPart}`;
}

export function createRallarAiFunnyRoomName(
    options: CreateRallarAiFunnyRoomNameOptions
): string {
    if (
        !options.theme.id.trim() || !options.theme.defaultBaseName.trim() ||
        options.theme.nouns.length === 0 || options.theme.nouns.some((noun) => !noun.trim())
    ) {
        throw new Error('Room name theme requires a nonempty ID, default base name, and noun vocabulary');
    }
    const baseName = normalizeRoomName(options.baseName) ||
        normalizeRoomName(options.theme.defaultBaseName);
    const existingNames = new Set(
        (options.existingNames ?? []).map(normalizeComparableName)
    );

    for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
        const candidate = createCandidateName(options, baseName, attempt);
        if (!existingNames.has(normalizeComparableName(candidate))) {
            return candidate;
        }
    }

    return createFallbackName(options, baseName, existingNames);
}

function createCandidateName(
    options: CreateRallarAiFunnyRoomNameOptions,
    baseName: string,
    attempt: number
): string {
    const saltedSeed = `${options.theme.id}:${baseName}:${options.seed}:${attempt}`;
    const adjective = ADJECTIVES[indexFor(`${saltedSeed}:adjective`, ADJECTIVES.length)];
    const noun = options.theme.nouns[indexFor(`${saltedSeed}:noun`, options.theme.nouns.length)];
    const code = shortCode(`${saltedSeed}:code`);
    return compactRoomName(baseName, `${adjective} ${noun}`, code);
}

function createFallbackName(
    options: CreateRallarAiFunnyRoomNameOptions,
    baseName: string,
    existingNames: ReadonlySet<string>
): string {
    let sequence = existingNames.size;
    while (true) {
        const code = shortCode(`${options.theme.id}:${baseName}:${options.seed}:fallback:${sequence}`);
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
