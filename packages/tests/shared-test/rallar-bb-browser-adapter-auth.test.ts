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

    it('resolves logged-in auth placeholders in HTTP paths and bodies', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
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
            commandId: 'configure-api-auth-placeholders',
            config: {
                apiBaseUrl: 'https://api.example.test',
            },
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-api-auth-placeholders',
            request: {
                path: '/api/state/apps/app/workspaces/ws/groups/bb-group/members/{auth.clientId}',
                method: 'PUT',
                body: {
                    status: 'active',
                    nested: {
                        sessionId: '{auth.sessionId}',
                    },
                },
            },
            response: {
                body: 'json',
            },
        });

        expect(result.ok).toBe(true);
        expect(fetchCalls[0].input).toBe(
            'https://api.example.test/api/state/apps/app/workspaces/ws/groups/bb-group/members/alice',
        );
        expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
            status: 'active',
            nested: {
                sessionId: 'session-1',
            },
        });
    });

    it('resolves logged-in auth placeholders and fetches a websocket ticket for ws.open', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const fetchCalls: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
        }> = [];
        const openedSockets: string[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async (input, init) => {
                fetchCalls.push({ input, init });
                return new Response(JSON.stringify({
                    ticket: 'ticket-1',
                    sessionId: 'session-1',
                    expiresAtEpochMs: Date.now() + 60_000,
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                });
            }) as typeof fetch,
            webSocketFactory: (url) => {
                openedSockets.push(url);
                return {
                    readyState: 1,
                    protocol: '',
                    url,
                    send: () => undefined,
                    close: () => undefined,
                };
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-ws-auth-placeholders',
            config: {
                apiBaseUrl: 'https://api.example.test',
            },
        });
        const result = await runtime.execute({
            kind: 'ws.open',
            commandId: 'ws-open-auth-placeholders',
            connection: 'rallarApi',
            url: '{config.wsBaseUrl}/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
        });

        expect(result.ok).toBe(true);
        expect(fetchCalls[0].input).toBe('https://api.example.test/api/auth/ws-ticket');
        expect(new Headers(fetchCalls[0].init?.headers).get('authorization')).toBe('Bearer token-1');
        expect(openedSockets).toEqual([
            'wss://api.example.test/api/ws/session-1?ticket=ticket-1',
        ]);
    });

    it('resolves logged-in auth placeholders in RTC send payloads', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const sends: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async (input) => {
                    sends.push(input);
                    return { sent: true };
                },
                close: async () => ({ closed: true }),
                health: async () => ({ ok: true }),
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-rtc-auth-placeholders',
            config: {
                apiBaseUrl: 'https://api.example.test',
            },
        });
        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'rtc-send-auth-placeholders',
            send: {
                data: {
                    sentBy: '{auth.clientId}',
                    sessionId: '{auth.sessionId}',
                },
            },
        });

        expect(result.ok).toBe(true);
        expect(sends).toEqual([
            {
                data: {
                    sentBy: 'alice',
                    sessionId: 'session-1',
                },
            },
        ]);
    });

    it('resolves logged-in auth placeholders in browser Rallar WS sends', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const sends: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async () => ({ sent: true }),
                sendWs: async (input) => {
                    sends.push(input);
                    return { sent: true };
                },
                close: async () => ({ closed: true }),
                health: async () => ({ ok: true }),
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-ws-auth-placeholders',
            config: {
                apiBaseUrl: 'https://api.example.test',
                control: {
                    providerMode: 'browser-rallar',
                },
            },
        });
        const result = await runtime.execute({
            kind: 'ws.send',
            commandId: 'ws-send-auth-placeholders',
            connection: 'rallarApi',
            data: {
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                resourceId: 'message-{auth.clientId}',
                payload: {
                    sentBy: '{auth.clientId}',
                    sessionId: '{auth.sessionId}',
                },
            },
        });

        expect(result.ok).toBe(true);
        expect(sends).toEqual([
            {
                typeId: 'room.manual.message',
                topicId: 'room.manual.message',
                resourceId: 'message-alice',
                payload: {
                    sentBy: 'alice',
                    sessionId: 'session-1',
                },
            },
        ]);
        expect(result.value).toMatchObject({
            sent: {
                resourceId: 'message-alice',
                payload: {
                    sentBy: 'alice',
                    sessionId: 'session-1',
                },
            },
        });
    });
});
