import type { ApiV1ConfigurationValueDecoder } from './decode-api-v1-configuration-values.ts';

export function decodeApiV1ConfigurationUrl(
    decoder: ApiV1ConfigurationValueDecoder,
    path: string,
    protocols: readonly string[]
): string {
    const sourceValue = decoder.readResolvedSourceValue(path);
    const value = decoder.nonEmptyString(path);
    if (!sourceValue.found || sourceValue.blocked || value.length === 0) {
        return '';
    }
    try {
        const url = new URL(value);
        if (
            !protocols.includes(url.protocol) ||
            url.username.length > 0 ||
            url.password.length > 0 ||
            url.search.length > 0 ||
            url.hash.length > 0
        ) {
            throw new TypeError('invalid URL');
        }
        return value.endsWith('/') ? value.slice(0, -1) : value;
    }
    catch {
        decoder.reportInvalidSourceValue(
            sourceValue,
            path,
            'invalid-url',
            `Value must be an absolute ${protocols.join(' or ')} URL without credentials, query, or fragment.`
        );
        return '';
    }
}

export function requireApiV1DatabaseUrl(
    decoder: ApiV1ConfigurationValueDecoder,
    value: string | undefined
): string {
    const databaseUrl = decoder.requireSecret('databaseUrl', value);
    if (databaseUrl.length === 0) {
        return '';
    }
    try {
        const parsed = new URL(databaseUrl);
        if (
            !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
            parsed.hostname.length === 0
        ) {
            throw new TypeError('invalid database URL');
        }
        return databaseUrl;
    }
    catch {
        decoder.secretIssue(
            'databaseUrl',
            'invalid-database-url',
            'Database URL must be an absolute PostgreSQL URL.'
        );
        return '';
    }
}
