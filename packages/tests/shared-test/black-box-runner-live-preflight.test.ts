import { describe, expect, it } from 'vitest';
import {
    runBlackBoxRunnerLivePreflight,
    shouldRunBlackBoxRunnerLivePreflight,
    type BlackBoxRunnerLivePreflightInput,
} from '../../shared-test/black-box-runner/preflight/live-preflight.ts';

type FetchCall = Readonly<{
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
}>;

class OpeningWebSocket {
    onopen: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;

    readonly url: string;

    constructor(url: string) {
        this.url = url;
        queueMicrotask(() => this.onopen?.({ type: 'open' }));
    }

    close(): void {
        this.onclose?.({ type: 'close' });
    }
}

class FailingWebSocket {
    onopen: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;

    readonly url: string;

    constructor(url: string) {
        this.url = url;
        queueMicrotask(() => this.onerror?.({ type: 'error' }));
    }

    close(): void {
        this.onclose?.({ type: 'close' });
    }
}

function headersFrom(init?: RequestInit): Record<string, string> {
    const output: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
        output[key] = value;
    });
    return output;
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(value), {
        status: init.status ?? 200,
        headers: {
            'content-type': 'application/json',
            ...(init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}),
        },
    });
}

function standardConfig(): BlackBoxRunnerLivePreflightInput {
    return {
        entryId: 'live-entry',
        profile: 'live',
        recipe: 'examples/live.json',
        requires: {
            env: [
                'RALLAR_API_BASE_URL',
                'RALLAR_ALICE_USERNAME',
                'RALLAR_ALICE_PASSWORD',
            ],
            httpServices: [
                {
                    name: 'Rallar API',
                    env: 'RALLAR_API_BASE_URL',
                },
            ],
            playwright: true,
        },
        config: {
            variables: {
                aliceUsername: {
                    env: 'RALLAR_ALICE_USERNAME',
                },
                alicePassword: {
                    env: 'RALLAR_ALICE_PASSWORD',
                    secret: true,
                },
                applicationId: {
                    env: 'RALLAR_BB_APPLICATION_ID',
                    default: 'app',
                },
                workspaceId: {
                    env: 'RALLAR_BB_WORKSPACE_ID',
                    default: 'workspace',
                },
                groupId: {
                    env: 'RALLAR_BB_GROUP_ID',
                    default: 'group',
                },
            },
            connections: {
                aliceRtc: {
                    provider: 'rallar-browser',
                    roomRef: {
                        applicationId: '{applicationId}',
                        workspaceId: '{workspaceId}',
                        groupId: '{groupId}',
                    },
                },
            },
            steps: [
                {
                    name: 'createWebSocketTicket',
                    type: 'http',
                    request: {
                        path: '/api/auth/ws-ticket',
                    },
                },
            ],
        },
        environment: {
            RALLAR_API_BASE_URL: 'http://rallar.test',
            RALLAR_ALICE_USERNAME: 'alice',
            RALLAR_ALICE_PASSWORD: 'secret',
            RALLAR_PREFLIGHT_CORS_ORIGIN: 'https://spa.test',
            RALLAR_BB_GROUP_ID: 'recipe-group',
            RALLAR_BB_RUN_ID: 'run-123',
        },
        checkPlaywright: async () => true,
        webSocketImplementation: OpeningWebSocket,
    };
}

describe('black-box runner live preflight', () => {
    it('reports missing live environment variables before network checks', async () => {
        const report = await runBlackBoxRunnerLivePreflight({
            requires: {
                env: ['RALLAR_API_BASE_URL', 'RALLAR_ALICE_USERNAME'],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                    },
                ],
            },
            environment: {},
            config: {},
            fetchImplementation: async () => {
                throw new Error('fetch should not run');
            },
        });

        expect(report.ok).toBe(false);
        expect(report.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
            'MISSING_ENV',
            'RALLAR_API_BASE_URL_MISSING',
        ]));
        expect(report.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: 'env:RALLAR_API_BASE_URL',
                status: 'failed',
            }),
            expect.objectContaining({
                id: 'rallar-api-config',
                status: 'skipped',
            }),
        ]));
    });

    it('reports failed Rallar API config reachability as a provisioning failure', async () => {
        const report = await runBlackBoxRunnerLivePreflight({
            requires: {
                env: ['RALLAR_API_BASE_URL'],
                httpServices: [
                    {
                        name: 'Rallar API',
                        env: 'RALLAR_API_BASE_URL',
                    },
                ],
            },
            environment: {
                RALLAR_API_BASE_URL: 'http://rallar.test',
            },
            config: {},
            fetchImplementation: async () => {
                throw new Error('connection refused');
            },
        });

        expect(report.ok).toBe(false);
        expect(report.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'HTTP_SERVICE_UNAVAILABLE',
                checkId: 'rallar-api-config',
            }),
        ]));
    });

    it('reports bad configured credentials without leaking password values', async () => {
        const input = standardConfig();
        const report = await runBlackBoxRunnerLivePreflight({
            ...input,
            fetchImplementation: async (url, init) => {
                if (String(url).endsWith('/api/config')) {
                    return jsonResponse({ ok: true }, {
                        headers: {
                            'access-control-allow-origin': 'https://spa.test',
                        },
                    });
                }
                if (String(url).endsWith('/api/auth/login')) {
                    return jsonResponse({ error: 'Invalid username or password' }, { status: 401 });
                }
                throw new Error(`unexpected fetch ${String(url)} ${init?.method}`);
            },
        });

        expect(report.ok).toBe(false);
        expect(report.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'BAD_AUTH',
                checkId: 'auth-login:alice',
            }),
        ]));
        expect(JSON.stringify(report)).not.toContain('secret');
    });

    it('reports bad WebSocket upgrade after ticket creation', async () => {
        const input = standardConfig();
        const report = await runBlackBoxRunnerLivePreflight({
            ...input,
            config: {
                variables: input.config?.variables,
                steps: [
                    {
                        type: 'http',
                        request: {
                            path: '/api/auth/ws-ticket',
                        },
                    },
                ],
            },
            fetchImplementation: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/api/config') {
                    return jsonResponse({ ok: true }, {
                        headers: {
                            'access-control-allow-origin': 'https://spa.test',
                        },
                    });
                }
                if (path === '/api/auth/login') {
                    return jsonResponse({
                        clientId: 'alice-client',
                        sessionId: 'alice-session',
                        accessToken: 'alice-token',
                    });
                }
                if (path === '/api/auth/ws-ticket') {
                    return jsonResponse({
                        ticket: 'super-secret-ticket',
                        sessionId: 'alice-session',
                        expiresAtEpochMs: 123,
                    });
                }
                throw new Error(`unexpected fetch ${String(url)}`);
            },
            webSocketImplementation: FailingWebSocket,
        });

        expect(report.ok).toBe(false);
        expect(report.issues).toEqual(expect.arrayContaining([
            expect.objectContaining({
                code: 'WS_UPGRADE_FAILED',
                checkId: 'ws-upgrade',
            }),
        ]));
    });

    it('passes a successful local API preflight and keeps secrets out of the report', async () => {
        const calls: FetchCall[] = [];
        const input = standardConfig();
        const report = await runBlackBoxRunnerLivePreflight({
            ...input,
            fetchImplementation: async (url, init) => {
                const parsed = new URL(String(url));
                const body = init?.body ? JSON.parse(String(init.body)) : undefined;
                calls.push({
                    url: String(url),
                    method: init?.method ?? 'GET',
                    headers: headersFrom(init),
                    body,
                });

                if (parsed.pathname === '/api/config') {
                    return jsonResponse({ ok: true }, {
                        headers: {
                            'access-control-allow-origin': 'https://spa.test',
                        },
                    });
                }
                if (parsed.pathname === '/api/auth/login') {
                    return jsonResponse({
                        clientId: 'alice-client',
                        sessionId: 'alice-session',
                        accessToken: 'alice-token',
                    });
                }
                if (parsed.pathname.endsWith('/groups') && init?.method === 'POST') {
                    return jsonResponse({ group: { groupId: body.groupId } }, { status: 201 });
                }
                if (parsed.pathname.includes('/members/') && init?.method === 'PUT') {
                    return jsonResponse({ members: [{ principalId: 'alice-client', status: 'active' }] });
                }
                if (parsed.pathname === '/api/auth/ws-ticket') {
                    return jsonResponse({
                        ticket: 'super-secret-ticket',
                        sessionId: 'alice-session',
                        expiresAtEpochMs: 123,
                    });
                }
                if (parsed.pathname === '/api/webrtc/ice') {
                    return jsonResponse({
                        iceServers: [
                            {
                                urls: 'stun:stun.example.test',
                            },
                        ],
                    });
                }
                throw new Error(`unexpected fetch ${String(url)}`);
            },
        });

        expect(report.ok).toBe(true);
        expect(report.skipReasons).toHaveLength(0);
        expect(report.requirements.checks).toEqual(expect.arrayContaining([
            'rallar-api-config',
            'cors-origin',
            'auth-login',
            'group-permission',
            'ws-ticket',
            'ws-upgrade',
            'ice-config',
            'playwright',
        ]));
        expect(report.checks.every(check => check.status === 'passed')).toBe(true);
        expect(calls.some(call => call.url.endsWith('/api/webrtc/ice'))).toBe(true);
        const createGroup = calls.find(call =>
            call.method === 'POST' && call.url.endsWith('/groups')
        );
        expect(createGroup?.body).toMatchObject({
            groupId: 'bb-live-preflight-live-entry-run-123',
            kind: 'room',
        });
        expect(createGroup?.url).not.toContain('recipe-group');
        expect(JSON.stringify(report)).not.toContain('secret');
        expect(JSON.stringify(report)).not.toContain('alice-token');
        expect(JSON.stringify(report)).not.toContain('super-secret-ticket');
    });

    it('detects recipes that need live preflight', () => {
        expect(shouldRunBlackBoxRunnerLivePreflight({
            requires: {
                env: ['RALLAR_API_BASE_URL'],
            },
            config: {},
        })).toBe(true);
        expect(shouldRunBlackBoxRunnerLivePreflight({
            config: {
                connections: {
                    aliceRtc: {
                        provider: 'rallar-browser',
                    },
                },
            },
        })).toBe(true);
        expect(shouldRunBlackBoxRunnerLivePreflight({
            config: {
                steps: [
                    {
                        type: 'set',
                        value: 'local',
                    },
                ],
            },
        })).toBe(false);
    });
});
