import { describe, expect, it } from 'vitest';

import {
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
    signRallarBlackBoxOperatorToken,
    verifyRallarBlackBoxOperatorToken
} from '@shared-server/http/black-box-operator-token.ts';
import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

describe('black-box operator token', () => {
    const issuedAtEpochMs = 1_700_000_000_000;
    const expiresAtEpochMs = issuedAtEpochMs + 86_400_000;

    it('signs and verifies a valid operator token', async () => {
        const token = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1'
        });

        const verified = await verifyRallarBlackBoxOperatorToken({
            token,
            secret: 'shared-secret',
            nowEpochMs: issuedAtEpochMs + 1_000
        });

        expect(verified.ok).toBe(true);
        if (!verified.ok) {
            return;
        }
        expect(verified.claims).toMatchObject({
            aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
            scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
            sub: 'alice',
            sessionId: 'session-1',
            iat: issuedAtEpochMs,
            exp: expiresAtEpochMs,
            jti: 'token-1'
        });
    });

    it('rejects expired tokens', async () => {
        const token = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1'
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token,
                secret: 'shared-secret',
                nowEpochMs: expiresAtEpochMs
            })
        ).resolves.toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects wrong scope and audience claims', async () => {
        const wrongScopeToken = await signTestOperatorToken({
            header: { alg: 'HS256', typ: 'JWT' },
            claims: {
                aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
                scope: 'wrong-scope',
                sub: 'alice',
                sessionId: 'session-1',
                iat: issuedAtEpochMs,
                exp: expiresAtEpochMs,
                jti: 'token-1'
            },
            secret: 'shared-secret'
        });
        const wrongAudienceToken = await signTestOperatorToken({
            header: { alg: 'HS256', typ: 'JWT' },
            claims: {
                aud: 'wrong-audience',
                scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
                sub: 'alice',
                sessionId: 'session-1',
                iat: issuedAtEpochMs,
                exp: expiresAtEpochMs,
                jti: 'token-1'
            },
            secret: 'shared-secret'
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token: wrongScopeToken,
                secret: 'shared-secret',
                nowEpochMs: issuedAtEpochMs + 1_000
            })
        ).resolves.toEqual({ ok: false, reason: 'wrong-scope' });
        await expect(
            verifyRallarBlackBoxOperatorToken({
                token: wrongAudienceToken,
                secret: 'shared-secret',
                nowEpochMs: issuedAtEpochMs + 1_000
            })
        ).resolves.toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('rejects tokens signed by another secret', async () => {
        const token = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1'
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token,
                secret: 'other-secret',
                nowEpochMs: issuedAtEpochMs + 1_000
            })
        ).resolves.toEqual({ ok: false, reason: 'bad-signature' });
    });

    it('rejects signed claims outside the exact current token shape', async () => {
        const token = await signTestOperatorToken({
            header: { alg: 'HS256', typ: 'JWT' },
            claims: {
                aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
                scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
                sub: 'alice',
                sessionId: 'session-1',
                iat: issuedAtEpochMs,
                exp: expiresAtEpochMs,
                jti: 'token-1',
                predecessorClaim: 'unsupported'
            },
            secret: 'shared-secret'
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token,
                secret: 'shared-secret',
                nowEpochMs: issuedAtEpochMs + 1_000
            })
        ).resolves.toEqual({ ok: false, reason: 'invalid-claims' });
    });

    it('rejects signed headers outside the exact current token shape', async () => {
        const token = await signTestOperatorToken({
            header: {
                alg: 'HS256',
                typ: 'JWT',
                predecessorHeader: 'unsupported'
            },
            claims: {
                aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
                scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
                sub: 'alice',
                sessionId: 'session-1',
                iat: issuedAtEpochMs,
                exp: expiresAtEpochMs,
                jti: 'token-1'
            },
            secret: 'shared-secret'
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token,
                secret: 'shared-secret',
                nowEpochMs: issuedAtEpochMs + 1_000
            })
        ).resolves.toEqual({ ok: false, reason: 'malformed' });
    });

    it('refuses to sign invalid current claims', async () => {
        await expect(
            signRallarBlackBoxOperatorToken({
                secret: 'shared-secret',
                subject: ' ',
                sessionId: 'session-1',
                issuedAtEpochMs,
                expiresAtEpochMs,
                tokenId: 'token-1'
            })
        ).rejects.toThrow('Operator token subject is required');
    });
});

interface SignTestOperatorTokenInput {
    readonly header: JsonWireValue;
    readonly claims: JsonWireValue;
    readonly secret: string;
}

async function signTestOperatorToken(
    input: SignTestOperatorTokenInput
): Promise<string> {
    const encodedHeader = encodeTestTokenJson(input.header);
    const encodedClaims = encodeTestTokenJson(input.claims);
    const unsignedToken = `${encodedHeader}.${encodedClaims}`;
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(input.secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(unsignedToken)
    );

    return `${unsignedToken}.${encodeTestTokenBytes(new Uint8Array(signature))}`;
}

function encodeTestTokenJson(value: JsonWireValue): string {
    return encodeTestTokenBytes(
        new TextEncoder().encode(JSON.stringify(value))
    );
}

function encodeTestTokenBytes(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}
