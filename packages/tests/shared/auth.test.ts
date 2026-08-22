import type { AuthSession } from '@shared/api/api-config.ts';
import { configureAuthSessionStorage, readAuthSessionStorageKind, readSession, resetAuthSessionStorage, writeSession } from '@shared/api/auth.ts';
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

    it('clears and hides an expired stored session', () => {
        const expiredSession: AuthSession = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            username: 'principal-1',
            accessToken: 'token-1',
            expiresAtEpochMs: 999
        };
        writeSession(expiredSession);

        expect(readSession()).toBeUndefined();
        expect(localStorage.getItem('auth.session')).toBeNull();
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
