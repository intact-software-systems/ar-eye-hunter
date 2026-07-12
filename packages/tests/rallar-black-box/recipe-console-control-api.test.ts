import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, it } from 'vitest';
import {
    ControlRunManagerHttpError,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    createRecipeConsoleControlApi,
    RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';

const COMPLETE_SNAPSHOT = {
    runs: [],
    distributedRuns: [],
} as const;

function authSession(clientId: string, sessionId: string): AuthSession {
    return {
        clientId,
        sessionId,
        username: clientId,
        accessToken: `access-${clientId}`,
        expiresAtEpochMs: 4_000_000_000_000,
    };
}

function authorization(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get('Authorization');
}

describe('Recipe Console control API', () => {
    it('owns the bounded Recipe Console snapshot defaults', () => {
        expect(RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS).toEqual({
            commands: 120,
            results: 120,
            events: 160,
            stats: 60,
            reports: 40,
            heartbeats: 80,
        });
    });

    it('delegates an anonymous bounded snapshot read to the canonical control client with cancellation', async () => {
        const requests: Array<{ url: string; init?: RequestInit }> = [];
        const controller = new AbortController();
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control?token=must-not-be-used',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input, init) => {
                requests.push({ url: String(input), init });
                return Response.json(COMPLETE_SNAPSHOT);
            },
        });

        const result = await api.readSnapshot({ signal: controller.signal });

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe(
            'https://control.test/runs?limitCommands=120&limitResults=120' +
            '&limitEvents=160&limitStats=60&limitReports=40&limitHeartbeats=80',
        );
        expect(authorization(requests[0].init)).toBeNull();
        expect(requests[0].init?.signal).toBe(controller.signal);
        expect(requests[0].url).not.toContain('must-not-be-used');
        expect(result).toEqual({
            snapshot: COMPLETE_SNAPSHOT,
            completeness: 'complete',
            authorization: 'anonymous',
        });
    });

    it('passes a caller snapshot-bound override exactly instead of merging defaults', async () => {
        const urls: string[] = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            bounds: {
                commands: 7,
                heartbeats: 3,
            },
            fetchFn: async (input) => {
                urls.push(String(input));
                return Response.json(COMPLETE_SNAPSHOT);
            },
        });

        await api.readSnapshot({});

        expect(urls).toEqual([
            'https://control.test/runs?limitCommands=7&limitHeartbeats=3',
        ]);
    });

    it('uses a manual token before anonymous or brokered authorization', async () => {
        const requests: Array<{ url: string; authorization: string | null }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            manualToken: ' manual-token ',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                requests.push({
                    url: String(input),
                    authorization: authorization(init),
                });
                return Response.json(COMPLETE_SNAPSHOT);
            },
        });

        const result = await api.readSnapshot({});

        expect(requests).toHaveLength(1);
        expect(requests[0].url).toContain('https://control.test/runs?');
        expect(requests[0].authorization).toBe('Bearer manual-token');
        expect(result.authorization).toBe('manual');
    });

    it('retries a 401 once with a brokered token and reuses that token within one API instance', async () => {
        const controller = new AbortController();
        const controlAuthorizations: Array<string | null> = [];
        const requestSignals: Array<AbortSignal | null | undefined> = [];
        const brokerClients: string[] = [];
        const fetchFn = async (
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> => {
            requestSignals.push(init?.signal);
            const url = String(input);
            if (url === 'https://api.test/api/black-box/control-token') {
                const clientId = new Headers(init?.headers).get('x-client-id') ?? 'missing';
                brokerClients.push(clientId);
                return Response.json({
                    tokenType: 'Bearer',
                    token: `brokered-${clientId}`,
                    issuedAtEpochMs: 3_000_000_000_000,
                    expiresAtEpochMs: 4_000_000_000_000,
                    ttlMs: 1_000_000_000_000,
                });
            }

            const auth = authorization(init);
            controlAuthorizations.push(auth);
            return auth
                ? Response.json(COMPLETE_SNAPSHOT)
                : Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                );
        };
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn,
        });

        const first = await api.readSnapshot({ signal: controller.signal });
        const second = await api.readSnapshot({});

        expect(first.authorization).toBe('brokered');
        expect(second.authorization).toBe('brokered');
        expect(brokerClients).toEqual(['client-a']);
        expect(controlAuthorizations).toEqual([
            null,
            'Bearer brokered-client-a',
            'Bearer brokered-client-a',
        ]);
        expect(requestSignals.slice(0, 3)).toEqual([
            controller.signal,
            controller.signal,
            controller.signal,
        ]);
    });

    it('preserves the reachable authorization failure when token brokering fails', async () => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input) => String(input).includes('/control-token')
                ? Response.json(
                    { error: 'Session expired.' },
                    { status: 401, statusText: 'Unauthorized' },
                )
                : Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                ),
        });

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'ControlRunManagerHttpError',
            message: 'Session expired.',
            status: 401,
            statusText: 'Unauthorized',
        });
    });

    it('does not wrap cancellation during token brokering as an authorization failure', async () => {
        const controller = new AbortController();
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input) => {
                if (String(input).includes('/control-token')) {
                    controller.abort();
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }
                return Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                );
            },
        });

        await expect(api.readSnapshot({ signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    it('keeps the broker cache instance-local when the auth session changes', async () => {
        const brokerClients: string[] = [];
        const controlAuthorizations: Array<string | null> = [];
        const fetchFn = async (
            input: RequestInfo | URL,
            init?: RequestInit,
        ): Promise<Response> => {
            const url = String(input);
            if (url === 'https://api.test/api/black-box/control-token') {
                const clientId = new Headers(init?.headers).get('x-client-id') ?? 'missing';
                brokerClients.push(clientId);
                return Response.json({
                    tokenType: 'Bearer',
                    token: `brokered-${clientId}`,
                    issuedAtEpochMs: 3_000_000_000_000,
                    expiresAtEpochMs: 4_000_000_000_000,
                    ttlMs: 1_000_000_000_000,
                });
            }

            const auth = authorization(init);
            controlAuthorizations.push(auth);
            return auth
                ? Response.json(COMPLETE_SNAPSHOT)
                : Response.json({ error: 'Forbidden.' }, { status: 403 });
        };

        const firstApi = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn,
        });
        await firstApi.readSnapshot({});
        const secondApi = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-b', 'session-b'),
            fetchFn,
        });
        await secondApi.readSnapshot({});

        expect(brokerClients).toEqual(['client-a', 'client-b']);
        expect(controlAuthorizations).toEqual([
            null,
            'Bearer brokered-client-a',
            null,
            'Bearer brokered-client-b',
        ]);
    });

    it('uses the canonical distributed-run fallback when the bounded snapshot omits it', async () => {
        const requests: Array<{ url: string; signal: AbortSignal | null | undefined }> = [];
        const controller = new AbortController();
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input, init) => {
                const url = String(input);
                requests.push({ url, signal: init?.signal });
                return url.endsWith('/distributed-runs')
                    ? Response.json({ distributedRuns: [] })
                    : Response.json({ runs: [] });
            },
        });

        const result = await api.readSnapshot({ signal: controller.signal });

        expect(requests.map(request => request.url)).toEqual([
            'https://control.test/runs?limitCommands=120&limitResults=120' +
            '&limitEvents=160&limitStats=60&limitReports=40&limitHeartbeats=80',
            'https://control.test/distributed-runs',
        ]);
        expect(requests.every(request => request.signal === controller.signal)).toBe(true);
        expect(result).toEqual({
            snapshot: COMPLETE_SNAPSHOT,
            completeness: 'complete',
            authorization: 'anonymous',
        });
    });

    it('retains usable runs as partial when the distributed-run fallback fails', async () => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input) => String(input).endsWith('/distributed-runs')
                ? Response.json(
                    { error: 'Distributed runs are temporarily unavailable.' },
                    { status: 503, statusText: 'Service Unavailable' },
                )
                : Response.json({ runs: [] }),
        });

        const result = await api.readSnapshot({});

        expect(result.snapshot).toEqual({ runs: [] });
        expect(result.completeness).toBe('partial');
        expect(result.authorization).toBe('anonymous');
        expect(result.partialError).toBeInstanceOf(ControlRunManagerHttpError);
        expect(result.partialError).toMatchObject({
            message: 'Distributed runs are temporarily unavailable.',
            status: 503,
        });
    });

    it('does not convert distributed fallback cancellation into a partial snapshot', async () => {
        const controller = new AbortController();
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input) => {
                if (String(input).endsWith('/distributed-runs')) {
                    controller.abort();
                    throw new DOMException('The operation was aborted.', 'AbortError');
                }
                return Response.json({ runs: [] });
            },
        });

        await expect(api.readSnapshot({ signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    it.each([
        { distributedRuns: { invalid: true } },
        { runs: [] },
    ])('rejects malformed distributed fallback payloads %#', async payload => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input) => String(input).endsWith('/distributed-runs')
                ? Response.json(payload)
                : Response.json({ runs: [] }),
        });

        await expect(api.readSnapshot({})).rejects.toThrow(
            'Control server snapshot distributedRuns must be an array.',
        );
    });

    it.each([
        [{ distributedRuns: [] }, 'runs'],
        [{ runs: [], distributedRuns: {} }, 'distributedRuns'],
        [{ runs: [], distributedRuns: [], fleetReports: {} }, 'fleetReports'],
        [null, 'runs'],
    ])('rejects a malformed top-level %s snapshot', async (payload, field) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json(payload),
        });

        await expect(api.readSnapshot({})).rejects.toThrow(
            `Control server snapshot ${field} must be an array.`,
        );
    });

    it('surfaces a nonempty invalid configured control URL without falling back to localhost', async () => {
        let fetchCalls = 0;

        const request = Promise.resolve().then(() => createRecipeConsoleControlApi({
            controlUrl: 'not a valid control URL',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => {
                fetchCalls += 1;
                return Response.json(COMPLETE_SNAPSHOT);
            },
        }).readSnapshot({}));

        await expect(request).rejects.toThrow(/control URL.*invalid|invalid.*control URL/i);
        expect(fetchCalls).toBe(0);
    });

    it('rejects control URLs containing userinfo credentials before deriving or fetching', async () => {
        let fetchCalls = 0;
        const request = Promise.resolve().then(() => createRecipeConsoleControlApi({
            controlUrl: 'https://operator:password@control.test/control?token=also-secret',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => {
                fetchCalls += 1;
                return Response.json(COMPLETE_SNAPSHOT);
            },
        }).readSnapshot({}));

        await expect(request).rejects.toThrow(/control URL.*credentials/i);
        expect(fetchCalls).toBe(0);
    });

    it('preserves a structured authorization error when no broker session is available', async () => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json(
                { error: 'Operator token required.' },
                { status: 401, statusText: 'Unauthorized' },
            ),
        });

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'ControlRunManagerHttpError',
            message: 'Operator token required.',
            status: 401,
            statusText: 'Unauthorized',
        });
    });
});
