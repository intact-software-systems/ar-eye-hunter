import { describe, expect, it } from 'vitest';
import {
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
    RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
    signRallarBlackBoxOperatorToken,
    verifyRallarBlackBoxOperatorToken,
} from '@shared-server/http/black-box-operator-token.ts';

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
            tokenId: 'token-1',
        });

        const verified = await verifyRallarBlackBoxOperatorToken({
            token,
            secret: 'shared-secret',
            nowEpochMs: issuedAtEpochMs + 1_000,
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
            jti: 'token-1',
        });
    });

    it('rejects expired tokens', async () => {
        const token = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1',
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token,
                secret: 'shared-secret',
                nowEpochMs: expiresAtEpochMs,
            }),
        ).resolves.toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects wrong scope and audience claims', async () => {
        const commonClaims = {
            aud: RALLAR_BLACK_BOX_OPERATOR_TOKEN_AUDIENCE,
            scope: RALLAR_BLACK_BOX_OPERATOR_TOKEN_SCOPE,
            sub: 'alice',
            sessionId: 'session-1',
            iat: issuedAtEpochMs,
            exp: expiresAtEpochMs,
            jti: 'token-1',
        };
        const wrongScopeToken = await signTestOperatorToken(
            { ...commonClaims, scope: 'wrong-scope' },
            'shared-secret',
        );
        const wrongAudienceToken = await signTestOperatorToken(
            { ...commonClaims, aud: 'wrong-audience' },
            'shared-secret',
        );

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token: wrongScopeToken,
                secret: 'shared-secret',
                nowEpochMs: issuedAtEpochMs + 1_000,
            }),
        ).resolves.toEqual({ ok: false, reason: 'wrong-scope' });
        await expect(
            verifyRallarBlackBoxOperatorToken({
                token: wrongAudienceToken,
                secret: 'shared-secret',
                nowEpochMs: issuedAtEpochMs + 1_000,
            }),
        ).resolves.toEqual({ ok: false, reason: 'wrong-audience' });
    });

    it('rejects tokens signed by another secret', async () => {
        const token = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1',
        });

        await expect(
            verifyRallarBlackBoxOperatorToken({
                token,
                secret: 'other-secret',
                nowEpochMs: issuedAtEpochMs + 1_000,
            }),
        ).resolves.toEqual({ ok: false, reason: 'bad-signature' });
    });
});

async function signTestOperatorToken(
    claims: Readonly<Record<string, unknown>>,
    secret: string,
): Promise<string> {
    const header = encodeBase64UrlJson({ alg: 'HS256', typ: 'JWT' });
    const payload = encodeBase64UrlJson(claims);
    const unsignedToken = `${header}.${payload}`;
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const signature = new Uint8Array(await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(unsignedToken),
    ));
    return `${unsignedToken}.${encodeBase64UrlBytes(signature)}`;
}

function encodeBase64UrlJson(value: unknown): string {
    return encodeBase64UrlBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBase64UrlBytes(value: Uint8Array): string {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/u, '');
}
