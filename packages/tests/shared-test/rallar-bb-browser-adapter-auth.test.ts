// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser-adapter.ts';

function installStorage(): Storage {
    const values = new Map<string, string>();
    const storage = {
        get length() {
            return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => {
            values.delete(key);
        },
        setItem: (key: string, value: string) => {
            values.set(key, value);
        },
    } satisfies Storage;
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage,
    });
    Object.defineProperty(window, 'localStorage', {
        configurable: true,
        value: storage,
    });
    return storage;
}

describe('rallar-bb browser adapter auth', () => {
    let storage: Storage;

    beforeEach(() => {
        storage = installStorage();
    });

    it('adds current Rallar auth headers to configured API HTTP requests', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'client-1',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const fetchCalls: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
        }> = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async (input, init) => {
                fetchCalls.push({ input, init });
                return new Response(JSON.stringify({ ok: true }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                });
            }) as typeof fetch,
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-api-auth',
            config: {
                apiBaseUrl: 'https://api.example.test',
            },
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-api-auth',
            request: {
                path: '/api/state/apps/app/workspaces/ws/groups',
                method: 'GET',
            },
            response: {
                body: 'json',
            },
        });

        const headers = new Headers(fetchCalls[0].init?.headers);
        expect(result.ok).toBe(true);
        expect(fetchCalls[0].input).toBe('https://api.example.test/api/state/apps/app/workspaces/ws/groups');
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('x-client-id')).toBe('client-1');
        expect(headers.get('content-type')).toBeNull();
    });
});
