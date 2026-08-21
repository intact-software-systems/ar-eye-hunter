export const RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE = 'rallar-black-box-control-server' as const;
export const RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE = 'rallar-black-box:distributed-operator' as const;

type TokenHeader = Readonly<{
    alg: 'HS256';
    typ: 'JWT';
}>;

export type RallarBlackBoxOperatorTokenClaims = Readonly<{
    aud: typeof RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE;
    scope: typeof RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE;
    sub: string;
    sessionId: string;
    iat: number;
    exp: number;
    jti: string;
}>;

export type SignRallarBlackBoxOperatorTokenInput = Readonly<{
    secret: string;
    subject: string;
    sessionId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
    tokenId?: string;
    claims?: Partial<RallarBlackBoxOperatorTokenClaims>;
}>;

export type VerifyRallarBlackBoxOperatorTokenInput = Readonly<{
    token?: string;
    secret?: string;
    nowEpochMs?: number;
}>;

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

const HEADER: TokenHeader = {
    alg: 'HS256',
    typ: 'JWT'
};

export async function signRallarBlackBoxOperatorToken(
    input: SignRallarBlackBoxOperatorTokenInput
): Promise<string> {
    const secret = input.secret.trim();
    if (!secret) {
        throw new Error('RALLAR_BLACK_BOX_OPERATOR_TOKEN_SECRET is required');
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

    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
        return { ok: false, reason: 'malformed' };
    }

    const [encodedHeader, encodedClaims, encodedSignature] = parts;
    let header: unknown;
    let claims: unknown;
    let signature: Uint8Array;
    try {
        header = decodeBase64UrlJson(encodedHeader);
        claims = decodeBase64UrlJson(encodedClaims);
        signature = base64UrlDecodeBytes(encodedSignature);
    }
    catch (_error) {
        return { ok: false, reason: 'malformed' };
    }

    if (!isRecord(header) || header.alg !== 'HS256' || header.typ !== 'JWT') {
        return { ok: false, reason: 'malformed' };
    }

    const verified = await verifyHmacSha256(
        secret,
        `${encodedHeader}.${encodedClaims}`,
        signature
    );
    if (!verified) {
        return { ok: false, reason: 'bad-signature' };
    }

    const parsed = parseClaims(claims);
    if (!parsed) {
        return { ok: false, reason: 'invalid-claims' };
    }
    if (parsed.aud !== RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE) {
        return { ok: false, reason: 'wrong-audience' };
    }
    if (parsed.scope !== RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE) {
        return { ok: false, reason: 'wrong-scope' };
    }
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    if (parsed.exp <= nowEpochMs) {
        return { ok: false, reason: 'expired' };
    }

    return { ok: true, claims: parsed };
}

function parseClaims(
    claims: unknown
): RallarBlackBoxOperatorTokenClaims | undefined {
    if (!isRecord(claims)) {
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

    return claims as RallarBlackBoxOperatorTokenClaims;
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

function base64UrlEncodeJson(value: unknown): string {
    return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64UrlJson(value: string): unknown {
    return JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(value)));
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
