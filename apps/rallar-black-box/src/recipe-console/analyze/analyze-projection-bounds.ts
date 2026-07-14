import { ANALYZE_ARTIFACT_URL_ID_MAX_LENGTH } from
    './analyze-identity-policy.ts';

/** Hard recursive limits for values crossing from the worker to the UI thread. */
export const ANALYZE_PROJECTION_MAX_ARRAY_LENGTH = 100;
export const ANALYZE_PROJECTION_MAX_TEXT_BYTES = 2 * 1_024;
export const ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES = 1 * 1_024 * 1_024;

export const MAX_ANALYSIS_ROWS = 64;
export const MAX_NESTED_EVIDENCE_ROWS = 8;
export const MAX_EVIDENCE_AGENT_IDS = 16;
export const MAX_METADATA_BYTES = 512;
export const MAX_SUMMARY_BYTES = 1_024;
export const MAX_TUNE_ROWS = ANALYZE_PROJECTION_MAX_ARRAY_LENGTH;
export const PROJECTION_OMISSION_MESSAGE =
    'Oversized display details were omitted at the worker boundary.';

const MAX_IDENTIFIER_BYTES = 256;
const MAX_AUTHORITY_IDENTIFIER_BYTES =
    ANALYZE_ARTIFACT_URL_ID_MAX_LENGTH * 3;
const MAX_PROJECTION_DEPTH = 12;
const MAX_TUNE_CANDIDATE_MANIFEST_BYTES = 128 * 1_024;

export function projectOpaqueIdentifier(
    value: string,
    maxBytes = MAX_IDENTIFIER_BYTES,
): string {
    const byteLength = utf8ByteLength(value);
    if (byteLength <= maxBytes) return value;
    return `opaque-id:${byteLength}:${stableDisplayDigest(value)}`;
}

/**
 * Keeps every identity accepted by the character-based URL policy exact while
 * bounding the worst-case UTF-8 representation of each UTF-16 code unit.
 */
export function projectAuthorityIdentifier(value: string): string {
    return projectOpaqueIdentifier(value, MAX_AUTHORITY_IDENTIFIER_BYTES);
}

export function projectOpaqueKey(value: string): string {
    const byteLength = utf8ByteLength(value);
    if (byteLength <= MAX_METADATA_BYTES) return value;
    return `opaque-key:${byteLength}:${stableDisplayDigest(value)}`;
}

export function boundedText(
    value: string,
    maxBytes = ANALYZE_PROJECTION_MAX_TEXT_BYTES,
): string {
    if (utf8ByteLength(value) <= maxBytes) return value;
    const suffix = '…';
    const contentLimit = Math.max(0, maxBytes - utf8ByteLength(suffix));
    let bytes = 0;
    let result = '';
    for (const character of value) {
        const characterBytes = utf8ByteLength(character);
        if (bytes + characterBytes > contentLimit) break;
        result += character;
        bytes += characterBytes;
    }
    return result + suffix;
}

export function boundedClone(
    value: unknown,
    limits: Readonly<{ arrayLimit: number; textLimit: number }>,
    depth = 0,
    ancestors = new Set<object>(),
): unknown {
    if (typeof value === 'string') return boundedText(value, limits.textLimit);
    if (!value || typeof value !== 'object') return value;
    if (depth >= MAX_PROJECTION_DEPTH || ancestors.has(value)) {
        return PROJECTION_OMISSION_MESSAGE;
    }
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            return value.slice(0, Math.min(
                limits.arrayLimit,
                ANALYZE_PROJECTION_MAX_ARRAY_LENGTH,
            )).map(child => boundedClone(child, limits, depth + 1, ancestors));
        }
        const projected: Record<string, unknown> = {};
        for (const [index, [rawKey, child]] of Object.entries(value)
            .slice(0, ANALYZE_PROJECTION_MAX_ARRAY_LENGTH).entries()) {
            const key = uniqueProjectedKey(projected, projectOpaqueKey(rawKey), index);
            projected[key] = boundedClone(child, limits, depth + 1, ancestors);
        }
        return projected;
    } finally {
        ancestors.delete(value);
    }
}

export function isExactCandidateManifestSafe(value: unknown): boolean {
    const measured = safeExactJsonBytes(value, new Set<object>(), 0);
    return measured !== undefined && measured <= MAX_TUNE_CANDIDATE_MANIFEST_BYTES;
}

export function withinSerializedLimit<T>(candidate: T, fallback: () => T): T {
    return utf8ByteLength(JSON.stringify(candidate)) <=
            ANALYZE_PROJECTION_MAX_SERIALIZED_BYTES
        ? candidate
        : fallback();
}

export function finiteNumber(value: number): number {
    return Number.isFinite(value) ? value : 0;
}

function uniqueProjectedKey(
    projected: Readonly<Record<string, unknown>>,
    candidate: string,
    index: number,
): string {
    if (!(candidate in projected)) return candidate;
    return projectOpaqueKey(`${candidate}:${index}`);
}

function safeExactJsonBytes(
    value: unknown,
    ancestors: Set<object>,
    depth: number,
): number | undefined {
    if (depth > MAX_PROJECTION_DEPTH) return undefined;
    if (value === null || typeof value === 'boolean') {
        return value === null ? 4 : value ? 4 : 5;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value)
            ? utf8ByteLength(JSON.stringify(value))
            : undefined;
    }
    if (typeof value === 'string') {
        if (utf8ByteLength(value) > ANALYZE_PROJECTION_MAX_TEXT_BYTES) {
            return undefined;
        }
        return utf8ByteLength(JSON.stringify(value));
    }
    if (value === undefined) return 0;
    if (typeof value !== 'object' || ancestors.has(value)) return undefined;
    ancestors.add(value);
    try {
        if (Array.isArray(value)) return safeExactArrayBytes(value, ancestors, depth);
        return safeExactObjectBytes(value, ancestors, depth);
    } finally {
        ancestors.delete(value);
    }
}

function safeExactArrayBytes(
    value: readonly unknown[],
    ancestors: Set<object>,
    depth: number,
): number | undefined {
    if (value.length > ANALYZE_PROJECTION_MAX_ARRAY_LENGTH) return undefined;
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const child of value) {
        const childBytes = safeExactJsonBytes(child, ancestors, depth + 1);
        if (childBytes === undefined) return undefined;
        bytes += childBytes;
        if (bytes > MAX_TUNE_CANDIDATE_MANIFEST_BYTES) return undefined;
    }
    return bytes;
}

function safeExactObjectBytes(
    value: object,
    ancestors: Set<object>,
    depth: number,
): number | undefined {
    const entries = Object.entries(value);
    if (entries.length > ANALYZE_PROJECTION_MAX_ARRAY_LENGTH) return undefined;
    let bytes = 2;
    let included = 0;
    for (const [key, child] of entries) {
        if (child === undefined) continue;
        if (utf8ByteLength(key) > ANALYZE_PROJECTION_MAX_TEXT_BYTES) {
            return undefined;
        }
        const childBytes = safeExactJsonBytes(child, ancestors, depth + 1);
        if (childBytes === undefined) return undefined;
        if (included > 0) bytes += 1;
        bytes += utf8ByteLength(JSON.stringify(key)) + 1 + childBytes;
        included += 1;
        if (bytes > MAX_TUNE_CANDIDATE_MANIFEST_BYTES) return undefined;
    }
    return bytes;
}

function stableDisplayDigest(value: string): string {
    let a = 0x811c9dc5;
    let b = 0x9e3779b9;
    let c = 0x85ebca6b;
    let d = 0xc2b2ae35;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        a = Math.imul(a ^ code, 0x01000193);
        b = Math.imul(b ^ code ^ index, 0x85ebca6b);
        c = Math.imul(c ^ code ^ (index << 7), 0xc2b2ae35);
        d = Math.imul(d ^ code ^ (index >>> 3), 0x27d4eb2d);
    }
    return [a, b, c, d].map(part =>
        (part >>> 0).toString(16).padStart(8, '0')
    ).join('');
}

function utf8ByteLength(value: string): number {
    let bytes = 0;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (
            code >= 0xd800 && code <= 0xdbff &&
            index + 1 < value.length &&
            value.charCodeAt(index + 1) >= 0xdc00 &&
            value.charCodeAt(index + 1) <= 0xdfff
        ) {
            bytes += 4;
            index += 1;
        } else bytes += 3;
    }
    return bytes;
}
