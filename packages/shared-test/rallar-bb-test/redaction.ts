import type { RallarBlackBoxTestRedactionOptions } from './rallar-black-box-test-contracts.ts';

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

export function redactRallarBlackBoxValue<T>(
    value: T,
    options: RallarBlackBoxTestRedactionOptions = {}
): T {
    return toRedactedValue(value, undefined, toRedactionPolicy(options));
}

function toRedactionPolicy(options: RallarBlackBoxTestRedactionOptions): RedactionPolicy {
    return {
        exactKeys: new Set((options.keys ?? []).map(toNormalizedKey)),
        keySubstrings: (options.keySubstrings ?? DEFAULT_KEY_SUBSTRINGS).map(toNormalizedKey),
        secretValues: (options.secretValues ?? []).filter((secret) => secret.length > 0),
        replacement: options.replacement ?? RALLAR_BLACK_BOX_REDACTED_VALUE
    };
}

/** Redaction swaps a secret for the replacement text and rebuilds containers, so callers read the value they passed. */
function toRedactedValue<T>(value: T, key: string | undefined, policy: RedactionPolicy): T {
    if (key !== undefined && key.length > 0 && isRedactedKey(key, policy)) {
        return policy.replacement as T;
    }
    if (typeof value === 'string') {
        return hasSecretValue(value, policy) ? policy.replacement as T : value;
    }
    if (Array.isArray(value)) {
        return value.map((item) => toRedactedValue(item, undefined, policy)) as T;
    }
    if (value === null || typeof value !== 'object') {
        return value;
    }
    return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [childKey, toRedactedValue(child, childKey, policy)])
    ) as T;
}

function toNormalizedKey(key: string): string {
    return key.toLowerCase().replaceAll(/[^a-z0-9_-]/g, '');
}

function isRedactedKey(key: string, policy: RedactionPolicy): boolean {
    const normalized = toNormalizedKey(key);
    return policy.exactKeys.has(normalized) ||
        policy.keySubstrings.some((substring) => normalized.includes(substring));
}

function hasSecretValue(value: string, policy: RedactionPolicy): boolean {
    return policy.secretValues.some((secret) => value.includes(secret));
}
