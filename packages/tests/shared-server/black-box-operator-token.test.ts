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
        const wrongScopeToken = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1',
            claims: {
                scope: 'wrong-scope' as never,
            },
        });
        const wrongAudienceToken = await signRallarBlackBoxOperatorToken({
            secret: 'shared-secret',
            subject: 'alice',
            sessionId: 'session-1',
            issuedAtEpochMs,
            expiresAtEpochMs,
            tokenId: 'token-1',
            claims: {
                aud: 'wrong-audience' as never,
            },
        });

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
