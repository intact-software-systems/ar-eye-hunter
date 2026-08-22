const TOKEN_VERSION = 'v1';
const TOKEN_SEGMENT_PATTERN = /^[0-9a-z]+$/;

export const RETENTION_PLAN_TOKEN_MAX_LENGTH = 512;

export type RetentionPlanTokenAdapter = Readonly<{
    issue(canonicalConsequence: string): Promise<string>;
    verify(token: string, canonicalConsequence: string): Promise<boolean>;
}>;

export type RetentionPlanTokenAdapterOptions = Readonly<{
    key: Uint8Array;
    now?: () => number;
    ttlMs?: number;
    subtle?: Pick<SubtleCrypto, 'importKey' | 'sign' | 'verify'>;
}>;

export function createRetentionPlanTokenAdapter(
    options: RetentionPlanTokenAdapterOptions
): RetentionPlanTokenAdapter {
    const now = options.now ?? (() => Date.now());
    const ttlMs = options.ttlMs ?? 5 * 60_000;
    const subtle = options.subtle ?? crypto.subtle;
    if (options.key.byteLength < 32) {
        throw new Error('Retention plan token keys must contain at least 32 bytes.');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new Error('Retention plan token TTL must be a positive safe integer.');
    }

    const keyBytes = options.key.slice();
    const keyPromise = subtle.importKey(
        'raw',
        keyBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
    );
    const encoder = new TextEncoder();

    return {
        async issue(canonicalConsequence) {
            const issuedAtEpochMs = now();
            if (!Number.isSafeInteger(issuedAtEpochMs)) {
                throw new Error('Retention plan token time must be a safe integer.');
            }
            const expiresAtEpochMs = issuedAtEpochMs + ttlMs;
            if (!Number.isSafeInteger(expiresAtEpochMs)) {
                throw new Error('Retention plan token expiry must be a safe integer.');
            }
            const expiry = expiresAtEpochMs.toString(36);
            const signature = await subtle.sign(
                'HMAC',
                await keyPromise,
                tokenMessage(expiry, canonicalConsequence, encoder)
            );
            const token = `${TOKEN_VERSION}.${expiry}.${base64UrlEncode(signature)}`;
            if (token.length > RETENTION_PLAN_TOKEN_MAX_LENGTH) {
                throw new Error('Retention plan token exceeded its maximum length.');
            }
            return token;
        },

        async verify(token, canonicalConsequence) {
            if (!isBoundedToken(token)) {
                return false;
            }
            const [version, expiry, encodedSignature] = token.split('.');
            if (
                version !== TOKEN_VERSION ||
                !TOKEN_SEGMENT_PATTERN.test(expiry) ||
                !isBase64Url(encodedSignature)
            ) {
                return false;
            }
            const expiresAtEpochMs = Number.parseInt(expiry, 36);
            const currentEpochMs = now();
            if (
                !Number.isSafeInteger(expiresAtEpochMs) ||
                !Number.isSafeInteger(currentEpochMs) ||
                expiresAtEpochMs <= currentEpochMs
            ) {
                return false;
            }
            const signature = base64UrlDecode(encodedSignature);
            if (
                !signature ||
                signature.byteLength !== 32 ||
                base64UrlEncode(signature) !== encodedSignature
            ) {
                return false;
            }
            try {
                const verified = await subtle.verify(
                    'HMAC',
                    await keyPromise,
                    signature,
                    tokenMessage(expiry, canonicalConsequence, encoder)
                );
                return verified && expiresAtEpochMs > now();
            }
            catch {
                return false;
            }
        }
    };
}

function tokenMessage(
    expiry: string,
    canonicalConsequence: string,
    encoder: TextEncoder
): ArrayBuffer {
    return encoder.encode(`${TOKEN_VERSION}\n${expiry}\n${canonicalConsequence}`).buffer;
}

function isBoundedToken(token: string): boolean {
    return token.length > 0 &&
        token.length <= RETENTION_PLAN_TOKEN_MAX_LENGTH &&
        token.split('.').length === 3;
}

function isBase64Url(value: string): boolean {
    return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function base64UrlEncode(value: ArrayBuffer): string {
    const bytes = new Uint8Array(value);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

function base64UrlDecode(value: string): ArrayBuffer | undefined {
    try {
        const padding = '='.repeat((4 - value.length % 4) % 4);
        const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + padding);
        return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
    }
    catch {
        return undefined;
    }
}
