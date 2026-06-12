import { describe, expect, it } from 'vitest';
import type { AuthSession } from '@shared/api/api-config.ts';
import { readAuthSessionFromRallarAuthState } from '../../../apps/rallar-black-box/src/auth-lifecycle.ts';

const session: AuthSession = {
    clientId: 'black-box-1',
    accessToken: 'token-1',
    username: 'black-box',
    sessionId: 'session-1',
    expiresAtEpochMs: Date.now() + 60_000,
};

describe('rallar black-box auth lifecycle', () => {
    it('clears the command center auth session for signed-out Rallar auth events', () => {
        for (const reason of ['logout', 'expired', 'unauthorized'] as const) {
            expect(readAuthSessionFromRallarAuthState({
                authenticated: false,
                reason,
            })).toBeUndefined();
        }
    });

    it('syncs the command center auth session for signed-in Rallar auth events', () => {
        expect(readAuthSessionFromRallarAuthState({
            authenticated: true,
            reason: 'current',
            session,
        })).toBe(session);
        expect(readAuthSessionFromRallarAuthState({
            authenticated: true,
            reason: 'login',
            session,
        })).toBe(session);
    });
});
