import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, it } from 'vitest';
import {
    fetchBlackBoxControlToken,
    resolveBlackBoxControlToken,
    shouldRefreshBlackBoxControlToken,
    type BlackBoxControlTokenSession
} from '../../../apps/rallar-black-box/src/control-operator-token.ts';

const authSession: AuthSession = {
    clientId: 'alice-client',
    username: 'alice',
    accessToken: 'access-token',
    sessionId: 'session-1',
    expiresAtEpochMs: 1_700_000_100_000
};

describe('black-box control operator token', () => {
    it('requests a brokered token with auth headers', async () => {
        const requests: Array<{ input: RequestInfo | URL; init?: RequestInit; }> = [];
        const fetchFn = async (
            input: RequestInfo | URL,
            init?: RequestInit
        ): Promise<Response> => {
            requests.push({ input, init });
            return Response.json({
                tokenType: 'Bearer',
                token: 'brokered-token',
                issuedAtEpochMs: 1_700_000_000_000,
                expiresAtEpochMs: 1_700_086_400_000,
                ttlMs: 86_400_000
            });
        };

        const token = await fetchBlackBoxControlToken({
            apiBaseUrl: 'https://api.rallar.test',
            authSession,
            fetchFn
        });

        expect(String(requests[0].input)).toBe('https://api.rallar.test/api/black-box/control-token');
        expect(requests[0].init?.method).toBe('POST');
        expect(requests[0].init?.headers).toMatchObject({
            Authorization: 'Bearer access-token',
            'x-client-id': 'alice-client'
        });
        expect(token).toEqual({
            source: 'brokered',
            token: 'brokered-token',
            issuedAtEpochMs: 1_700_000_000_000,
            expiresAtEpochMs: 1_700_086_400_000,
            ttlMs: 86_400_000
        });
    });

    it('uses manual control tokens without calling the broker', async () => {
        let fetchCalls = 0;
        const resolved = await resolveBlackBoxControlToken({
            manualToken: ' manual-admin-token ',
            apiBaseUrl: 'https://api.rallar.test',
            authSession,
            fetchFn: async () => {
                fetchCalls += 1;
                return Response.json({});
            }
        });

        expect(resolved).toEqual({
            source: 'manual',
            token: 'manual-admin-token'
        });
        expect(fetchCalls).toBe(0);
    });

    it('refreshes missing or nearly expired brokered tokens', async () => {
        const validToken: BlackBoxControlTokenSession = {
            source: 'brokered',
            token: 'valid-token',
            issuedAtEpochMs: 1_700_000_000_000,
            expiresAtEpochMs: 1_700_100_000_000,
            ttlMs: 100_000_000
        };
        const expiringToken: BlackBoxControlTokenSession = {
            ...validToken,
            token: 'expiring-token',
            expiresAtEpochMs: 1_700_000_200_000
        };

        expect(shouldRefreshBlackBoxControlToken(undefined, 1_700_000_000_000)).toBe(true);
        expect(shouldRefreshBlackBoxControlToken(validToken, 1_700_000_000_000)).toBe(false);
        expect(shouldRefreshBlackBoxControlToken(expiringToken, 1_700_000_000_000)).toBe(true);
    });

    it('requires login when no manual token is available', async () => {
        await expect(
            resolveBlackBoxControlToken({
                apiBaseUrl: 'https://api.rallar.test'
            })
        ).rejects.toThrow('Sign in or enter a Control Token to run recipes on connected agents.');
    });
});
