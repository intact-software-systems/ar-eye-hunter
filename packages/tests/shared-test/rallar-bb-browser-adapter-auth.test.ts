// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser-adapter.ts';
import { createRallarBlackBoxRtcRealtimeRecipe } from '../../shared-test/rallar-bb-test/recipe-fixtures.ts';

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

        expect(result.ok).toBe(true);
        const headers = new Headers(fetchCalls[0].init?.headers);
        expect(fetchCalls[0].input).toBe('https://api.example.test/api/state/apps/app/workspaces/ws/groups');
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('x-client-id')).toBe('client-1');
        expect(headers.get('content-type')).toBeNull();
    });

    it('connects the configured browser Rallar runtime before API path requests that need auth headers', async () => {
        const fetchCalls: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
        }> = [];
        const connectConfigs: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async (input, init) => {
                fetchCalls.push({ input, init });
                return new Response(JSON.stringify({ ok: true }), {
                    status: 201,
                    headers: {
                        'content-type': 'application/json',
                    },
                });
            }) as typeof fetch,
            rallarRuntime: {
                connect: async (config) => {
                    connectConfigs.push(config);
                    storage.setItem('auth.session', JSON.stringify({
                        clientId: 'controller-01',
                        accessToken: 'token-1',
                        username: 'rallar',
                        sessionId: 'controller-01',
                        expiresAtEpochMs: Date.now() + 60_000,
                    }));
                    return { connected: true };
                },
                send: async () => ({ sent: true }),
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-api-auth-with-runtime-login',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'controller-01',
                sessionId: 'controller-01',
                roomId: 'hetzner-headless-room',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    username: 'rallar',
                    password: 'secret',
                    register: 'if-needed',
                },
            },
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-api-auth-with-runtime-login',
            request: {
                path: '/api/state/apps/app/workspaces/ws/groups',
                method: 'POST',
                body: {
                    requestId: 'ensure-group',
                    groupId: 'bb-group',
                },
            },
            response: {
                body: 'json',
            },
        });

        expect(result.ok).toBe(true);
        const headers = new Headers(fetchCalls[0].init?.headers);
        expect(connectConfigs).toHaveLength(1);
        expect(connectConfigs[0]).not.toHaveProperty('roomId');
        expect(fetchCalls[0].input).toBe('https://api.example.test/api/state/apps/app/workspaces/ws/groups');
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('x-client-id')).toBe('controller-01');
    });

    it('preserves bootstrap Rallar credentials when recipe configure narrows live scope', async () => {
        const connectConfigs: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async () =>
                new Response(JSON.stringify({ ok: true }), {
                    status: 201,
                    headers: {
                        'content-type': 'application/json',
                    },
                })) as typeof fetch,
            rallarRuntime: {
                connect: async (config) => {
                    connectConfigs.push(config);
                    const rallar = (config as { rallar?: { username?: string; password?: string } }).rallar;
                    if (!rallar?.username || !rallar.password) {
                        throw new Error('missing Rallar credentials');
                    }
                    storage.setItem('auth.session', JSON.stringify({
                        clientId: 'controller-01',
                        accessToken: 'token-1',
                        username: rallar.username,
                        sessionId: 'controller-01',
                        expiresAtEpochMs: Date.now() + 60_000,
                    }));
                    return { connected: true };
                },
                send: async () => ({ sent: true }),
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'bootstrap-configure',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'controller-01',
                sessionId: 'controller-01',
                roomId: 'hetzner-headless-room',
                rallar: {
                    username: 'rallar',
                    password: 'secret',
                    register: 'if-needed',
                },
            },
        });
        await runtime.execute({
            kind: 'configure',
            commandId: 'recipe-configure-live-scope',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'controller-01',
                sessionId: 'controller-01',
                roomId: 'hetzner-headless-room',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    timeoutMs: 10_000,
                    logoutOnClose: false,
                    leaveRoomOnClose: false,
                    scope: {
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                    },
                    roomRef: {
                        applicationId: 'rallar-server',
                        workspaceId: 'default',
                        groupId: 'hetzner-headless-room',
                    },
                },
            },
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-api-auth-after-recipe-configure',
            request: {
                path: '/api/state/apps/rallar-server/workspaces/default/groups',
                method: 'POST',
                body: {
                    requestId: 'ensure-group',
                    groupId: 'hetzner-headless-room',
                },
            },
            response: {
                body: 'json',
            },
        });

        expect(result.ok).toBe(true);
        expect(connectConfigs).toHaveLength(1);
        expect(connectConfigs[0]).toMatchObject({
            rallar: {
                username: 'rallar',
                password: 'secret',
                register: 'if-needed',
                applicationId: 'rallar-server',
                workspaceId: 'default',
                timeoutMs: 10_000,
                logoutOnClose: false,
                leaveRoomOnClose: false,
            },
        });
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

    it('connects the configured browser Rallar runtime before resolving HTTP auth placeholders', async () => {
        const fetchCalls: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
        }> = [];
        const connectConfigs: unknown[] = [];
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
            rallarRuntime: {
                connect: async (config) => {
                    connectConfigs.push(config);
                    storage.setItem('auth.session', JSON.stringify({
                        clientId: 'controller-01',
                        accessToken: 'token-1',
                        username: 'rallar',
                        sessionId: 'controller-01',
                        expiresAtEpochMs: Date.now() + 60_000,
                    }));
                    return { connected: true };
                },
                send: async () => ({ sent: true }),
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-api-auth-placeholders-with-runtime-login',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'controller-01',
                sessionId: 'controller-01',
                roomId: 'hetzner-headless-room',
                transport: 'realtime',
                rallar: {
                    apiBaseUrl: 'https://api.example.test',
                    username: 'rallar',
                    password: 'secret',
                    register: 'if-needed',
                    transport: 'realtime',
                },
            },
        });
        const result = await runtime.execute({
            kind: 'http.request',
            commandId: 'http-api-auth-placeholders-with-runtime-login',
            request: {
                path: '/api/state/apps/app/workspaces/ws/groups/bb-group/members/{auth.clientId}',
                method: 'PUT',
                body: {
                    requestId: 'ensure-member:{auth.clientId}',
                    status: 'active',
                },
            },
            response: {
                body: 'json',
            },
        });

        expect(result.ok).toBe(true);
        const headers = new Headers(fetchCalls[0].init?.headers);
        expect(connectConfigs).toEqual([
            expect.objectContaining({
                connection: 'controller-01',
                actor: 'controller-01',
                rallar: expect.objectContaining({
                    apiBaseUrl: 'https://api.example.test',
                    username: 'rallar',
                    password: 'secret',
                    register: 'if-needed',
                    transport: 'realtime',
                    expectedSessionId: 'controller-01',
                }),
            }),
        ]);
        expect(connectConfigs[0]).not.toHaveProperty('roomId');
        expect(fetchCalls[0].input).toBe(
            'https://api.example.test/api/state/apps/app/workspaces/ws/groups/bb-group/members/controller-01',
        );
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(JSON.parse(String(fetchCalls[0].init?.body))).toEqual({
            requestId: 'ensure-member:controller-01',
            status: 'active',
        });
    });

    it('runs the RTC realtime recipe setup before browser RTC connect', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const operations: string[] = [];
        const fetchCalls: Array<{
            input: RequestInfo | URL;
            init?: RequestInit;
        }> = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async (input, init) => {
                fetchCalls.push({ input, init });
                operations.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
                return new Response(JSON.stringify({ ok: true }), {
                    status: init?.method === 'POST' ? 201 : 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                });
            }) as typeof fetch,
            rallarRuntime: {
                connect: async () => {
                    operations.push('RTC connect');
                    return { connected: true };
                },
                send: async () => ({ status: 'sent', peerIds: ['bob-session'], results: [], health: [] }),
                close: async () => ({ closed: true }),
                health: async () => ({ connected: true }),
            },
        });
        const recipe = createRallarBlackBoxRtcRealtimeRecipe({
            durationSeconds: 1,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room',
            },
        });

        await runtime.execute({
            kind: 'configure',
            commandId: 'configure-rtc-realtime',
            config: {
                apiBaseUrl: 'https://api.example.test',
                actor: 'alice',
                sessionId: 'session-1',
                transport: 'realtime',
                rallar: {
                    username: 'alice',
                    password: 'secret',
                    apiBaseUrl: 'https://api.example.test',
                    transport: 'realtime',
                },
            },
        });
        await runtime.execute({
            kind: 'recipe.load',
            commandId: 'load-rtc-realtime',
            recipe,
        });
        const runResult = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'run-rtc-realtime',
        });

        expect(runResult.ok).toBe(true);
        expect(operations.slice(0, 3)).toEqual([
            'POST /api/state/apps/rallar-server/workspaces/default/groups',
            'PUT /api/state/apps/rallar-server/workspaces/default/groups/hetzner-headless-room/members/alice',
            'RTC connect',
        ]);
        expect(fetchCalls.map(call => new URL(String(call.input)).pathname)).toEqual([
            '/api/state/apps/rallar-server/workspaces/default/groups',
            '/api/state/apps/rallar-server/workspaces/default/groups/hetzner-headless-room/members/alice',
        ]);
        expect(JSON.parse(String(fetchCalls[0].init?.body))).toMatchObject({
            requestId: 'rtc-realtime:ensure-group:rallar-server:default:hetzner-headless-room',
            groupId: 'hetzner-headless-room',
            joinMode: 'open',
        });
        expect(JSON.parse(String(fetchCalls[1].init?.body))).toMatchObject({
            requestId: 'rtc-realtime:ensure-member:rallar-server:default:hetzner-headless-room:alice',
            status: 'active',
        });
    });

    it('resolves rtc.send ready peer placeholders from runtime health', async () => {
        const sentPayloads: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            rallarRuntime: {
                connect: async () => ({ connected: true }),
                send: async (input) => {
                    sentPayloads.push(input);
                    return {
                        status: 'sent',
                        peerIds: ['peer-ready-1'],
                        results: [{ peerId: 'peer-ready-1', result: { status: 'sent' } }],
                        health: [],
                    };
                },
                close: async () => ({ closed: true }),
                health: async () => ({
                    rtcStatus: {
                        readyPeerIds: ['peer-ready-1', 'peer-ready-2'],
                    },
                }),
            },
        });

        const result = await runtime.execute({
            kind: 'rtc.send',
            commandId: 'send-ready-peer',
            connection: 'aliceRtc',
            transport: 'realtime',
            send: {
                roomId: 'room-1',
                data: { topic: 'rallar.test' },
                peerIds: ['{rtc.readyPeerIds[0]}'],
            },
        });

        expect(result.ok).toBe(true);
        expect(sentPayloads).toEqual([
            {
                roomId: 'room-1',
                data: { topic: 'rallar.test' },
                peerIds: ['peer-ready-1'],
            },
        ]);
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

    it('uses the websocket ticket session id when resolving ws.open auth placeholders', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'stale-session',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const openedSockets: string[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async () =>
                new Response(JSON.stringify({
                    ticket: 'ticket-rotated',
                    sessionId: 'ticket-session',
                    expiresAtEpochMs: Date.now() + 60_000,
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                })) as typeof fetch,
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
            commandId: 'configure-rotated-ws-ticket',
            config: {
                apiBaseUrl: 'https://api.example.test',
            },
        });
        const result = await runtime.execute({
            kind: 'ws.open',
            commandId: 'ws-open-rotated-ticket',
            connection: 'rallarApi',
            url: '{config.wsBaseUrl}/api/ws/{auth.sessionId}?ticket={auth.wsTicket}',
        });

        expect(result.ok).toBe(true);
        expect(openedSockets).toEqual([
            'wss://api.example.test/api/ws/ticket-session?ticket=ticket-rotated',
        ]);
    });

    it('resolves URL-encoded ws.open auth placeholders', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const openedSockets: string[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            fetch: (async () =>
                new Response(JSON.stringify({
                    ticket: 'ticket-1',
                    sessionId: 'session-1',
                    expiresAtEpochMs: Date.now() + 60_000,
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                })) as typeof fetch,
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
            commandId: 'configure-encoded-ws-placeholders',
            config: {
                apiBaseUrl: 'https://api.example.test',
            },
        });
        const result = await runtime.execute({
            kind: 'ws.open',
            commandId: 'ws-open-encoded-placeholders',
            connection: 'rallarApi',
            url: 'wss://api.example.test/api/ws/%7Bauth.sessionId%7D?ticket=%7Bauth.wsTicket%7D',
        });

        expect(result.ok).toBe(true);
        expect(openedSockets).toEqual([
            'wss://api.example.test/api/ws/session-1?ticket=ticket-1',
        ]);
    });

    it('resolves logged-in auth placeholders in raw ws.send payloads', async () => {
        storage.setItem('auth.session', JSON.stringify({
            clientId: 'alice',
            accessToken: 'token-1',
            username: 'alice',
            sessionId: 'session-1',
            expiresAtEpochMs: Date.now() + 60_000,
        }));
        const sent: unknown[] = [];
        const runtime = createRallarBlackBoxBrowserTestRuntime({
            webSocketFactory: (url) => ({
                readyState: 1,
                protocol: '',
                url,
                send: (data) => {
                    sent.push(data);
                },
                close: () => undefined,
            }),
        });

        await runtime.execute({
            kind: 'ws.open',
            commandId: 'ws-open-raw-auth-placeholders',
            connection: 'rallarApi',
            url: 'wss://api.example.test/ws',
        });
        const result = await runtime.execute({
            kind: 'ws.send',
            commandId: 'ws-send-raw-auth-placeholders',
            connection: 'rallarApi',
            data: {
                senderId: '{auth.sessionId}',
                username: '{auth.username}',
            },
        });

        expect(result.ok).toBe(true);
        expect(sent).toEqual([
            '{"senderId":"session-1","username":"alice"}',
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
