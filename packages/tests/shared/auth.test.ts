import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, configureAuthSessionStorage, readAuthSessionStorageKind, readSession, resetAuthSessionStorage, writeSession } from '@shared/api/auth.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('browser auth session storage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        vi.stubGlobal('localStorage', memoryStorage());
        vi.stubGlobal('sessionStorage', memoryStorage());
        resetAuthSessionStorage();
    });

    afterEach(() => {
        vi.useRealTimers();
        resetAuthSessionStorage();
        vi.unstubAllGlobals();
    });

    it('keeps a stored session whose server-issued expiry the browser clock has already passed', () => {
        // The browser clock runs ahead of the server: by server time this session is still valid.
        const storedSession: AuthSession = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            username: 'principal-1',
            accessToken: 'token-1',
            expiresAtEpochMs: 999
        };
        writeSession(storedSession);

        expect(readSession()).toEqual(storedSession);
        expect(localStorage.getItem('auth.session')).not.toBeNull();
    });

    it('hides a stored session without a finite expiry', () => {
        localStorage.setItem(
            'auth.session',
            JSON.stringify({
                clientId: 'principal-1',
                sessionId: 'session-1',
                username: 'principal-1',
                accessToken: 'token-1',
                expiresAtEpochMs: null
            })
        );

        expect(readSession()).toBeUndefined();
    });

    it('keeps a guest bearer in memory and respects the configured store on the next account login', () => {
        const account: AuthSession = { clientId: 'player', sessionId: 'account', username: 'player', accessToken: 'account-token', expiresAtEpochMs: 2_000 };
        const guest = { ...account, guestRoom: { applicationId: 'game', workspaceId: 'park', groupId: 'court' }, accessToken: 'court-token' };
        configureAuthSessionStorage('session');
        writeSession(account);
        writeSession(guest, 'memory');
        expect(readSession()).toEqual(guest);
        expect(sessionStorage.getItem('auth.session')).toBe(JSON.stringify(account));
        expect(localStorage.length).toBe(0);
        clearSession();
        expect(readSession()).toBeUndefined();
        writeSession(account);
        expect(readAuthSessionStorageKind()).toBe('session');
        expect(readSession()).toEqual(account);
    });

    it('can isolate auth sessions in browser session storage', () => {
        const activeSession: AuthSession = {
            clientId: 'principal-2',
            sessionId: 'session-2',
            username: 'principal-2',
            accessToken: 'token-2',
            expiresAtEpochMs: 2_000
        };

        configureAuthSessionStorage('session');
        writeSession(activeSession);

        expect(readAuthSessionStorageKind()).toBe('session');
        expect(readSession()).toEqual(activeSession);
        expect(sessionStorage.getItem('auth.session')).not.toBeNull();
        expect(localStorage.getItem('auth.session')).toBeNull();
    });
});

function memoryStorage(): Storage {
    const values = new Map<string, string>();
    return {
        get length() {
            return values.size;
        },
        clear: vi.fn(() => values.clear()),
        getItem: vi.fn((key: string) => values.get(key) ?? null),
        key: vi.fn((index: number) => [...values.keys()][index] ?? null),
        removeItem: vi.fn((key: string) => {
            values.delete(key);
        }),
        setItem: vi.fn((key: string, value: string) => {
            values.set(key, value);
        })
    };
}
