import type { RallarBlackBoxTestRedactionOptions } from './types.ts';

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
    'encryption',
];

function normalizeKey(value: string): string {
    return value.toLowerCase().replaceAll(/[^a-z0-9_-]/g, '');
}

function shouldRedactKey(
    key: string,
    options: RallarBlackBoxTestRedactionOptions = {},
): boolean {
    const normalized = normalizeKey(key);
    const exactKeys = new Set((options.keys ?? []).map(normalizeKey));
    if (exactKeys.has(normalized)) {
        return true;
    }

    const substrings = options.keySubstrings ?? DEFAULT_KEY_SUBSTRINGS;
    return substrings.some((substring) => normalized.includes(normalizeKey(substring)));
}

function shouldRedactString(
    value: string,
    options: RallarBlackBoxTestRedactionOptions = {},
): boolean {
    return (options.secretValues ?? [])
        .filter((secret) => secret.length > 0)
        .some((secret) => value.includes(secret));
}

export function redactRallarBlackBoxValue<T>(
    value: T,
    options: RallarBlackBoxTestRedactionOptions = {},
): T {
    const replacement = options.replacement ?? RALLAR_BLACK_BOX_REDACTED_VALUE;

    function redact(current: unknown, key?: string): unknown {
        if (key && shouldRedactKey(key, options)) {
            return replacement;
        }

        if (typeof current === 'string') {
            return shouldRedactString(current, options)
                ? replacement
                : current;
        }

        if (Array.isArray(current)) {
            return current.map((item) => redact(item));
        }

        if (!current || typeof current !== 'object') {
            return current;
        }

        return Object.fromEntries(
            Object.entries(current).map(([childKey, childValue]) => [
                childKey,
                redact(childValue, childKey),
            ]),
        );
    }

    return redact(value) as T;
}
