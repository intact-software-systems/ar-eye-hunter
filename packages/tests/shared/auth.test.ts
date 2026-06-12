import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSession, writeSession } from '@shared/api/auth.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

describe('browser auth session storage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        vi.stubGlobal('localStorage', memoryStorage());
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('clears and hides an expired stored session', () => {
        const expiredSession: AuthSession = {
            clientId: 'principal-1',
            sessionId: 'session-1',
            username: 'principal-1',
            accessToken: 'token-1',
            expiresAtEpochMs: 999,
        };
        writeSession(expiredSession);

        expect(readSession()).toBeUndefined();
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
        }),
    };
}
