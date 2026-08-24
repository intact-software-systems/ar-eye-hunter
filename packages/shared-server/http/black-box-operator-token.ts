import {
    decodeJsonWireValue,
    type JsonWireObject,
    type JsonWireValue
} from '../rallar-system/protocol/json-wire-identity.ts';

export const RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE = 'rallar-black-box-control-server' as const;
export const RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE = 'rallar-black-box:distributed-operator' as const;

export interface RallarBlackBoxOperatorTokenClaims {
    readonly aud: typeof RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE;
    readonly scope: typeof RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE;
    readonly sub: string;
    readonly sessionId: string;
    readonly iat: number;
    readonly exp: number;
    readonly jti: string;
}

export interface SignRallarBlackBoxOperatorTokenInput {
    readonly secret: string;
    readonly subject: string;
    readonly sessionId: string;
    readonly issuedAtEpochMs: number;
    readonly expiresAtEpochMs: number;
    readonly tokenId?: string;
    readonly claims?: Partial<RallarBlackBoxOperatorTokenClaims>;
}

export interface VerifyRallarBlackBoxOperatorTokenInput {
    readonly token?: string;
    readonly secret?: string;
    readonly nowEpochMs?: number;
}

export type RallarBlackBoxOperatorTokenVerifyResult =
    | Readonly<{ ok: true; claims: RallarBlackBoxOperatorTokenClaims; }>
    | Readonly<{
        ok: false;
        reason:
            | 'missing-token'
            | 'missing-secret'
            | 'malformed'
            | 'bad-signature'
            | 'wrong-audience'
            | 'wrong-scope'
            | 'expired'
            | 'invalid-claims';
    }>;

interface TokenHeader {
    readonly alg: 'HS256';
    readonly typ: 'JWT';
}

interface DecodedOperatorTokenClaims {
    readonly aud: string;
    readonly scope: string;
    readonly sub: string;
    readonly sessionId: string;
    readonly iat: number;
    readonly exp: number;
    readonly jti: string;
}

interface DecodedSignedOperatorToken {
    readonly encodedHeader: string;
    readonly encodedClaims: string;
    readonly header: JsonWireValue;
    readonly claims: JsonWireValue;
    readonly signature: Uint8Array;
}

const HEADER: TokenHeader = {
    alg: 'HS256',
    typ: 'JWT'
};

export async function signRallarBlackBoxOperatorToken(
    input: SignRallarBlackBoxOperatorTokenInput
): Promise<string> {
    const secret = input.secret.trim();
    const issues = validateOperatorTokenSigningInput(input, secret);
    if (issues.length > 0) {
        throw new TypeError(issues[0]);
    }

    const claims: RallarBlackBoxOperatorTokenClaims = {
        aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
        scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
        sub: input.subject,
        sessionId: input.sessionId,
        iat: input.issuedAtEpochMs,
        exp: input.expiresAtEpochMs,
        jti: input.tokenId ?? randomTokenId(),
        ...input.claims
    };
    const encodedHeader = base64UrlEncodeJson(HEADER);
    const encodedClaims = base64UrlEncodeJson(claims);
    const unsignedToken = `${encodedHeader}.${encodedClaims}`;
    const signature = await hmacSha256(secret, unsignedToken);

    return `${unsignedToken}.${base64UrlEncodeBytes(signature)}`;
}

export async function verifyRallarBlackBoxOperatorToken(
    input: VerifyRallarBlackBoxOperatorTokenInput
): Promise<RallarBlackBoxOperatorTokenVerifyResult> {
    const token = input.token?.trim();
    if (!token) {
        return { ok: false, reason: 'missing-token' };
    }
    const secret = input.secret?.trim();
    if (!secret) {
        return { ok: false, reason: 'missing-secret' };
    }

    const decodedToken = decodeSignedOperatorToken(token);
    if (decodedToken === undefined || !isTokenHeader(decodedToken.header)) {
        return { ok: false, reason: 'malformed' };
    }

    const verified = await verifyHmacSha256(
        secret,
        `${decodedToken.encodedHeader}.${decodedToken.encodedClaims}`,
        decodedToken.signature
    );
    if (!verified) {
        return { ok: false, reason: 'bad-signature' };
    }

    return toOperatorTokenClaimsVerifyResult(
        decodedToken.claims,
        input.nowEpochMs ?? Date.now()
    );
}

function validateOperatorTokenSigningInput(
    input: SignRallarBlackBoxOperatorTokenInput,
    secret: string
): readonly string[] {
    const issues: string[] = [];
    if (secret.length === 0) {
        issues.push('RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET is required');
    }
    if (input.subject.trim().length === 0) {
        issues.push('Operator token subject is required');
    }
    if (input.sessionId.trim().length === 0) {
        issues.push('Operator token session ID is required');
    }
    if (
        !Number.isFinite(input.issuedAtEpochMs) ||
        !Number.isFinite(input.expiresAtEpochMs) ||
        input.issuedAtEpochMs < 0 ||
        input.expiresAtEpochMs <= input.issuedAtEpochMs
    ) {
        issues.push('Operator token validity interval is invalid');
    }
    if (input.tokenId !== undefined && input.tokenId.trim().length === 0) {
        issues.push('Operator token ID must not be empty');
    }
    return issues;
}

function decodeSignedOperatorToken(
    token: string
): DecodedSignedOperatorToken | undefined {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        return undefined;
    }

    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    try {
        return {
            encodedHeader,
            encodedClaims,
            header: decodeBase64UrlJson(encodedHeader),
            claims: decodeBase64UrlJson(encodedClaims),
            signature: base64UrlDecodeBytes(encodedSignature)
        };
    }
    catch (_error) {
        return undefined;
    }
}

function toOperatorTokenClaimsVerifyResult(
    claims: JsonWireValue,
    nowEpochMs: number
): RallarBlackBoxOperatorTokenVerifyResult {
    const parsed = decodeOperatorTokenClaims(claims);
    if (!parsed) {
        return { ok: false, reason: 'invalid-claims' };
    }
    if (parsed.aud !== RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE) {
        return { ok: false, reason: 'wrong-audience' };
    }
    if (parsed.scope !== RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE) {
        return { ok: false, reason: 'wrong-scope' };
    }
    if (parsed.exp <= nowEpochMs) {
        return { ok: false, reason: 'expired' };
    }

    return {
        ok: true,
        claims: {
            ...parsed,
            aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
            scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE
        }
    };
}

function decodeOperatorTokenClaims(
    claims: JsonWireValue
): DecodedOperatorTokenClaims | undefined {
    if (
        !isJsonWireObject(claims) ||
        !hasExactKeys(claims, [
            'aud',
            'scope',
            'sub',
            'sessionId',
            'iat',
            'exp',
            'jti'
        ])
    ) {
        return undefined;
    }
    if (
        typeof claims.aud !== 'string' ||
        typeof claims.scope !== 'string' ||
        typeof claims.sub !== 'string' ||
        typeof claims.sessionId !== 'string' ||
        typeof claims.iat !== 'number' ||
        typeof claims.exp !== 'number' ||
        typeof claims.jti !== 'string'
    ) {
        return undefined;
    }
    if (
        claims.sub.trim().length === 0 ||
        claims.sessionId.trim().length === 0 ||
        claims.jti.trim().length === 0 ||
        !Number.isFinite(claims.iat) ||
        !Number.isFinite(claims.exp) ||
        claims.iat < 0 ||
        claims.exp <= claims.iat
    ) {
        return undefined;
    }

    return {
        aud: claims.aud,
        scope: claims.scope,
        sub: claims.sub,
        sessionId: claims.sessionId,
        iat: claims.iat,
        exp: claims.exp,
        jti: claims.jti
    };
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
    const key = await importHmacKey(secret, ['sign']);
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(value)
    );
    return new Uint8Array(signature);
}

async function verifyHmacSha256(
    secret: string,
    value: string,
    signature: Uint8Array
): Promise<boolean> {
    const key = await importHmacKey(secret, ['verify']);
    return crypto.subtle.verify(
        'HMAC',
        key,
        arrayBufferFromBytes(signature),
        new TextEncoder().encode(value)
    );
}

async function importHmacKey(
    secret: string,
    usages: KeyUsage[]
): Promise<CryptoKey> {
    if (!crypto.subtle) {
        throw new Error('Web Crypto HMAC support is required');
    }

    return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        {
            name: 'HMAC',
            hash: 'SHA-256'
        },
        false,
        usages
    );
}

function base64UrlEncodeJson(
    value: TokenHeader | RallarBlackBoxOperatorTokenClaims
): string {
    return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson(value: string): JsonWireValue {
    return decodeJsonWireValue(
        JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(value))),
        'Black-box operator token JSON'
    );
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }

    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}

function base64UrlDecodeBytes(value: string): Uint8Array {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const padded = normalized.padEnd(
        normalized.length + ((4 - normalized.length % 4) % 4),
        '='
    );
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function arrayBufferFromBytes(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
}

function randomTokenId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return base64UrlEncodeBytes(bytes);
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
    value: JsonWireObject,
    expectedKeys: readonly string[]
): boolean {
    const keys = Object.keys(value);
    return keys.length === expectedKeys.length &&
        expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isTokenHeader(value: JsonWireValue): boolean {
    return isJsonWireObject(value) &&
        hasExactKeys(value, ['alg', 'typ']) &&
        value.alg === 'HS256' &&
        value.typ === 'JWT';
}
