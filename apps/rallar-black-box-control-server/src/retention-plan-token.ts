import { decodeBase64Url, toBase64Url } from '@shared/encoding/base64url.ts';

const TOKEN_VERSION = 'v1';
const TOKEN_SEGMENT_PATTERN = /^[0-9a-z]+$/;

export const RETENTION_PLAN_TOKEN_MAX_LENGTH = 512;

export const RETENTION_PLAN_TOKEN_DEFAULT_TTL_MS = 5 * 60_000;

export interface RetentionPlanTokenAdapter {
    readonly issue: (canonicalConsequence: string) => Promise<string>;
    readonly verify: (token: string, canonicalConsequence: string) => Promise<boolean>;
}

export interface RetentionPlanTokenAdapterInput {
    readonly key: Uint8Array;
    readonly now: () => number;
    readonly ttlMs: number;
    readonly subtle: Pick<SubtleCrypto, 'importKey' | 'sign' | 'verify'>;
}

export function createDefaultRetentionPlanTokenAdapter(key: Uint8Array): RetentionPlanTokenAdapter {
    return createRetentionPlanTokenAdapter({
        key,
        now: () => Date.now(),
        ttlMs: RETENTION_PLAN_TOKEN_DEFAULT_TTL_MS,
        subtle: crypto.subtle
    });
}

export function createRetentionPlanTokenAdapter(input: RetentionPlanTokenAdapterInput): RetentionPlanTokenAdapter {
    const { now, ttlMs, subtle } = input;
    if (input.key.byteLength < 32) {
        throw new Error('Retention plan token keys must contain at least 32 bytes.');
    }
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new Error('Retention plan token TTL must be a positive safe integer.');
    }

    const keyBytes = input.key.slice();
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
            const token = `${TOKEN_VERSION}.${expiry}.${toBase64Url(new Uint8Array(signature))}`;
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
            const signature = decodeBase64Url(encodedSignature).right;
            if (
                version !== TOKEN_VERSION ||
                !TOKEN_SEGMENT_PATTERN.test(expiry) ||
                signature?.byteLength !== 32
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
            try {
                const verified = await subtle.verify(
                    'HMAC',
                    await keyPromise,
                    new Uint8Array(signature),
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
