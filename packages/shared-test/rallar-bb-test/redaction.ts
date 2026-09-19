import type {
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRedactionOptions
} from './rallar-black-box-test-contracts.ts';

export const RALLAR_BLACK_BOX_REDACTED_VALUE = '<redacted>';

const DEFAULT_KEY_SUBSTRINGS = [
    'authorization',
    'cookie',
    'password',
    'secret',
    'token',
    'ticket',
    'apikey',
    'api-key',
    'access_token',
    'refresh_token',
    'keyring',
    'privatekey',
    'ciphertext',
    'encrypted',
    'encryption'
];

interface RedactionPolicy {
    readonly exactKeys: ReadonlySet<string>;
    readonly keySubstrings: readonly string[];
    readonly secretValues: readonly string[];
    readonly replacement: string;
}

/**
 * The copy is typed as the value passed in although a redacted leaf becomes the replacement text: callers only
 * serialize or display redacted evidence, and every container keeps its shape.
 */
export function redactRallarBlackBoxValue<T>(
    value: T,
    options: RallarBlackBoxTestRedactionOptions = {}
): T {
    return toRedactedValue(value, toRedactionPolicy(options)) as T;
}

function toRedactionPolicy(options: RallarBlackBoxTestRedactionOptions): RedactionPolicy {
    return {
        exactKeys: new Set((options.keys ?? []).map(toNormalizedKey)),
        keySubstrings: (options.keySubstrings ?? DEFAULT_KEY_SUBSTRINGS).map(toNormalizedKey),
        secretValues: (options.secretValues ?? []).filter((secret) => secret.length > 0),
        replacement: options.replacement ?? RALLAR_BLACK_BOX_REDACTED_VALUE
    };
}

/** Evidence of any shape reaches redaction, so each level is narrowed before it is copied. */
function toRedactedValue(value: unknown, policy: RedactionPolicy): unknown {
    if (typeof value === 'string') {
        return hasSecretValue(value, policy) ? policy.replacement : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => toRedactedValue(item, policy));
    }
    if (!isRedactableRecord(value)) {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [
            key,
            isRedactedKey(key, policy) ? policy.replacement : toRedactedValue(child, policy)
        ])
    );
}

/** An error or class instance is copied by its own enumerable fields, like a plain record. */
function isRedactableRecord(value: unknown): value is RallarBlackBoxTestRecord {
    return typeof value === 'object' && value !== null;
}

function toNormalizedKey(key: string): string {
    return key.toLowerCase().replaceAll(/[^a-z0-9_-]/g, '');
}

function isRedactedKey(key: string, policy: RedactionPolicy): boolean {
    const normalized = toNormalizedKey(key);
    return key.length > 0 && (
        policy.exactKeys.has(normalized) ||
        policy.keySubstrings.some((substring) => normalized.includes(substring))
    );
}

function hasSecretValue(value: string, policy: RedactionPolicy): boolean {
    return policy.secretValues.some((secret) => value.includes(secret));
}
