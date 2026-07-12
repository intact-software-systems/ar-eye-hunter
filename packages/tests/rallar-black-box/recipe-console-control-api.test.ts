import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, it } from 'vitest';
import {
    ControlRunManagerHttpError,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    createRecipeConsoleControlApi as createRecipeConsoleControlApiWithPolicy,
    RECIPE_CONSOLE_CONTROL_SNAPSHOT_BOUNDS,
    type RecipeConsoleControlApiConfig,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import {
    recipeConsoleControlCredentialPolicyFromSearch,
    TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts';

type TestControlApiConfig =
    & Omit<RecipeConsoleControlApiConfig, 'credentialPolicy'>
    & Partial<Pick<RecipeConsoleControlApiConfig, 'credentialPolicy'>>;

function createRecipeConsoleControlApi(config: TestControlApiConfig) {
    return createRecipeConsoleControlApiWithPolicy({
        ...config,
        credentialPolicy: config.credentialPolicy ??
            TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
    });
}

const COMPLETE_SNAPSHOT = {
    runs: [],
    distributedRuns: [],
} as const;

const DISTRIBUTED_MANIFEST = {
    schemaVersion: 1,
    distributedRunId: 'distributed-execute-a',
    controlRunId: 'run-a',
    group: {
        applicationId: 'app-a',
        workspaceId: 'workspace-a',
        groupId: 'group-a',
    },
    recipes: [{ recipeId: 'recipe-a' }],
    targetPolicy: {
        mode: 'selected-agents',
        agentIds: ['agent-a'],
        expectedParticipantCount: 1,
    },
    startMode: 'manual',
    ackTimeoutMs: 15_000,
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

function protocolControlAgent(agentId: string) {
    return {
        agentId,
        connected: true,
        completedCommandIds: [],
        receivedResultCount: 0,
        receivedEventCount: 0,
        reconnectCount: 0,
    };
}

function protocolControlRun(runId: string, agentIds: readonly string[] = []) {
    return {
        runId,
        agents: agentIds.map(protocolControlAgent),
        commands: [],
    };
}

function protocolDistributedRun(
    distributedRunId: string,
    overrides: Readonly<Record<string, unknown>> = {},
) {
    return {
        distributedRunId,
        controlRunId: 'run-a',
        state: 'running',
        updatedAtEpochMs: 1,
        targetAgentIds: [],
        commandLinks: [],
        manifest: {
            group: {
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a',
            },
        },
        rollup: { summary: { blockingFailures: 0 } },
        ...overrides,
    };
}

function protocolTargetResolution(
    overrides: Readonly<Record<string, unknown>> = {},
) {
    return {
        group: DISTRIBUTED_MANIFEST.group,
        resolvedAtEpochMs: 10,
        staleAfterMs: 15_000,
        targetPolicyMode: 'selected-agents',
        targetAgentIds: ['agent-a'],
        roleAssignments: [],
        blockers: [],
        summary: {
            agents: 1,
            targetable: 1,
            selected: 1,
            expectedParticipantCount: 1,
            missingExpectedParticipants: 0,
            staleAgents: 0,
            offlineAgents: 0,
            wrongGroupAgents: 0,
            agentsWithoutIdentity: 0,
            roleCounts: {},
            regions: {},
            providers: {},
        },
        ...overrides,
    };
}

function protocolDistributedArtifact(
    overrides: Readonly<Record<string, unknown>> = {},
) {
    return {
        artifactSchemaVersion: 2,
        distributedRunId: 'distributed-execute-a',
        generatedAtEpochMs: 20,
        files: {
            'distributed-run.json': '{}',
            'manifest.json': '{}',
            'control-run.json': '{}',
        },
        ...overrides,
    };
}

describe('Recipe Console control API', () => {
    it('trusts configured endpoints but makes URL endpoint credentials provenance-aware', () => {
        expect(recipeConsoleControlCredentialPolicyFromSearch(
            '?v=1&experience=recipe-console&view=execute',
        )).toMatchObject({
            allowManualToken: true,
            allowBrokeredToken: true,
        });
        expect(recipeConsoleControlCredentialPolicyFromSearch(
            '?v=1&experience=recipe-console&controlUrl=https%3A%2F%2Funtrusted.test',
        )).toMatchObject({
            allowManualToken: false,
            allowBrokeredToken: false,
            controlUrlFromLocation: true,
            controlTokenFromLocation: false,
        });
        expect(recipeConsoleControlCredentialPolicyFromSearch(
            '?v=1&experience=recipe-console' +
            '&controlUrl=https%3A%2F%2Funtrusted.test&controlToken=caller-token',
        )).toMatchObject({
            allowManualToken: true,
            allowBrokeredToken: false,
            controlUrlFromLocation: true,
            controlTokenFromLocation: true,
        });
        expect(recipeConsoleControlCredentialPolicyFromSearch(
            '?v=1&experience=recipe-console&apiBaseUrl=https%3A%2F%2Funtrusted-api.test',
        )).toMatchObject({
            allowManualToken: true,
            allowBrokeredToken: false,
            allowBootstrapAgentTicket: false,
            apiBaseUrlFromLocation: true,
        });
        expect(recipeConsoleControlCredentialPolicyFromSearch(
            '?mode=control&controlUrl=https%3A%2F%2Flegacy-control.test',
        )).toMatchObject({
            allowManualToken: false,
            allowBrokeredToken: false,
            allowBootstrapAgentTicket: true,
            controlUrlFromLocation: true,
            controlTokenFromLocation: false,
        });
    });

    it('fails closed when a caller omits credential provenance', async () => {
        const requests: Array<{
            url: string;
            authorization: string | null;
        }> = [];
        const configWithoutPolicy: Omit<
            RecipeConsoleControlApiConfig,
            'credentialPolicy'
        > = {
            controlUrl: 'https://untrusted-control.test/control',
            manualToken: 'ambient-control-secret',
            apiBaseUrl: 'https://untrusted-api.test',
            authSession: authSession('victim-client', 'victim-session'),
            fetchFn: async (input, init) => {
                requests.push({
                    url: String(input),
                    authorization: authorization(init),
                });
                return Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                );
            },
        };
        const api = createRecipeConsoleControlApiWithPolicy(
            configWithoutPolicy as RecipeConsoleControlApiConfig,
        );

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlCredentialTrustError',
            credentialTrustRequired: true,
        });
        expect(requests).toEqual([{
            url: expect.stringContaining('https://untrusted-control.test/runs?'),
            authorization: null,
        }]);
    });

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

    it.each([
        [401, 'Unauthorized'],
        [403, 'Forbidden'],
    ] as const)('retries a %s once with a brokered token and reuses that token within one API instance', async (
        challengeStatus,
        challengeStatusText,
    ) => {
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
                    {
                        status: challengeStatus,
                        statusText: challengeStatusText,
                    },
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
            name: 'RecipeConsoleControlAuthorizationError',
            message: 'Session expired.',
            reachable: true,
            authorizationRequired: true,
            controlStatus: 401,
            brokerStatus: 401,
            brokerStatusText: 'Unauthorized',
        });
    });

    it('preserves broker HTTP provenance separately from the control authorization challenge', async () => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input) => String(input).includes('/control-token')
                ? Response.json(
                    { error: 'Token broker unavailable.' },
                    { status: 503, statusText: 'Service Unavailable' },
                )
                : Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                ),
        });

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlAuthorizationError',
            message: 'Token broker unavailable.',
            reachable: true,
            authorizationRequired: true,
            controlStatus: 401,
            controlStatusText: 'Unauthorized',
            brokerStatus: 503,
            brokerStatusText: 'Service Unavailable',
        });
    });

    it('keeps proactive near-expiry broker authorization failures structured', async () => {
        const now = Date.now();
        let brokerRequests = 0;
        const controlAuthorizations: Array<string | null> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                if (String(input).includes('/control-token')) {
                    brokerRequests += 1;
                    return brokerRequests === 1
                        ? Response.json({
                            tokenType: 'Bearer',
                            token: 'near-expiry-token',
                            issuedAtEpochMs: now,
                            expiresAtEpochMs: now + 60_000,
                            ttlMs: 60_000,
                        })
                        : Response.json(
                            { error: 'Session expired during refresh.' },
                            { status: 403, statusText: 'Forbidden' },
                        );
                }
                const auth = authorization(init);
                controlAuthorizations.push(auth);
                return auth
                    ? Response.json(COMPLETE_SNAPSHOT)
                    : Response.json(
                        { error: 'Operator token required.' },
                        { status: 401, statusText: 'Unauthorized' },
                    );
            },
        });

        await expect(api.readSnapshot({})).resolves.toMatchObject({
            authorization: 'brokered',
        });
        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlAuthorizationError',
            message: 'Session expired during refresh.',
            reachable: true,
            authorizationRequired: true,
            controlStatus: 401,
            brokerStatus: 403,
            brokerStatusText: 'Forbidden',
        });
        expect(brokerRequests).toBe(2);
        expect(controlAuthorizations).toEqual([
            null,
            'Bearer near-expiry-token',
        ]);
    });

    it('keeps public runs usable when protected fallback token refresh fails', async () => {
        const now = Date.now();
        const requests: string[] = [];
        let brokerRequests = 0;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                const auth = authorization(init);
                if (url.pathname === '/api/black-box/control-token') {
                    brokerRequests += 1;
                    requests.push(`broker:${auth}`);
                    return brokerRequests === 1
                        ? Response.json({
                            tokenType: 'Bearer',
                            token: 'near-expiry-fallback-token',
                            issuedAtEpochMs: now,
                            expiresAtEpochMs: now + 60_000,
                            ttlMs: 60_000,
                        })
                        : Response.json(
                            { error: 'Configured token broker unavailable.' },
                            { status: 503, statusText: 'Service Unavailable' },
                        );
                }
                if (url.pathname === '/runs') {
                    requests.push(`runs:${auth}`);
                    return Response.json({ runs: [] });
                }
                requests.push(`distributed:${auth}`);
                return auth
                    ? Response.json({ distributedRuns: [] })
                    : Response.json(
                        { error: 'Distributed authorization required.' },
                        { status: 401, statusText: 'Unauthorized' },
                    );
            },
        });

        await expect(api.readSnapshot({})).resolves.toMatchObject({
            completeness: 'complete',
            authorization: 'brokered',
        });
        await expect(api.readSnapshot({})).resolves.toMatchObject({
            snapshot: { runs: [] },
            completeness: 'partial',
            authorization: 'anonymous',
            partialError: {
                name: 'RecipeConsoleControlAuthorizationError',
                authorizationRequired: true,
                controlStatus: 401,
                brokerStatus: 503,
            },
        });
        expect(requests).toEqual([
            'runs:null',
            'distributed:null',
            'broker:Bearer access-client-a',
            'distributed:Bearer near-expiry-fallback-token',
            'runs:null',
            'broker:Bearer access-client-a',
        ]);
    });

    it('never sends stored credentials to a URL-selected control origin', async () => {
        const requests: Array<{
            url: string;
            authorization: string | null;
        }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://untrusted-control.test/control',
            manualToken: 'environment-control-secret',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('victim-client', 'victim-session'),
            credentialPolicy: recipeConsoleControlCredentialPolicyFromSearch(
                '?v=1&experience=recipe-console' +
                '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol',
            ),
            fetchFn: async (input, init) => {
                requests.push({
                    url: String(input),
                    authorization: authorization(init),
                });
                return Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                );
            },
        });

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlCredentialTrustError',
            status: 401,
            reachable: true,
            authorizationRequired: true,
            credentialTrustRequired: true,
            message: expect.stringContaining('URL-configured control endpoint'),
        });
        expect(requests).toEqual([{
            url: expect.stringContaining('https://untrusted-control.test/runs?'),
            authorization: null,
        }]);
    });

    it('never sends the stored auth session to a URL-selected token broker', async () => {
        const requests: Array<{
            url: string;
            authorization: string | null;
        }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://configured-control.test/control',
            apiBaseUrl: 'https://untrusted-api.test',
            authSession: authSession('victim-client', 'victim-session'),
            credentialPolicy: recipeConsoleControlCredentialPolicyFromSearch(
                '?v=1&experience=recipe-console' +
                '&apiBaseUrl=https%3A%2F%2Funtrusted-api.test',
            ),
            fetchFn: async (input, init) => {
                requests.push({
                    url: String(input),
                    authorization: authorization(init),
                });
                return Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                );
            },
        });

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlCredentialTrustError',
            credentialTrustRequired: true,
            message: expect.stringContaining('URL-configured API endpoint'),
        });
        expect(requests).toEqual([{
            url: expect.stringContaining('https://configured-control.test/runs?'),
            authorization: null,
        }]);
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

    it('preserves the strongest authorization provenance across combined reads', async () => {
        const requests: string[] = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                const auth = authorization(init);
                requests.push(`${url.pathname}:${auth}`);
                if (url.pathname === '/api/black-box/control-token') {
                    return Response.json({
                        tokenType: 'Bearer',
                        token: 'brokered-core-token',
                        issuedAtEpochMs: 3_000_000_000_000,
                        expiresAtEpochMs: 4_000_000_000_000,
                        ttlMs: 1_000_000_000_000,
                    });
                }
                if (url.pathname === '/runs') {
                    return auth
                        ? Response.json({ runs: [] })
                        : Response.json(
                            { error: 'Core authorization required.' },
                            { status: 401, statusText: 'Unauthorized' },
                        );
                }
                return Response.json({ distributedRuns: [] });
            },
        });

        await expect(api.readSnapshot({})).resolves.toMatchObject({
            completeness: 'complete',
            authorization: 'brokered',
        });
        expect(requests).toEqual([
            '/runs:null',
            '/api/black-box/control-token:Bearer access-client-a',
            '/runs:Bearer brokered-core-token',
            '/distributed-runs:null',
        ]);
    });

    it('reuses one broker token when both control snapshot endpoints require it', async () => {
        const requests: string[] = [];
        let brokerRequests = 0;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                const auth = authorization(init);
                requests.push(`${url.pathname}:${auth}`);
                if (url.pathname === '/api/black-box/control-token') {
                    brokerRequests += 1;
                    return Response.json({
                        tokenType: 'Bearer',
                        token: 'shared-broker-token',
                        issuedAtEpochMs: 3_000_000_000_000,
                        expiresAtEpochMs: 4_000_000_000_000,
                        ttlMs: 1_000_000_000_000,
                    });
                }
                if (!auth) {
                    return Response.json(
                        { error: 'Operator token required.' },
                        { status: 401, statusText: 'Unauthorized' },
                    );
                }
                return url.pathname === '/runs'
                    ? Response.json({ runs: [] })
                    : Response.json({ distributedRuns: [] });
            },
        });

        await expect(api.readSnapshot({})).resolves.toMatchObject({
            completeness: 'complete',
            authorization: 'brokered',
        });
        expect(brokerRequests).toBe(1);
        expect(requests).toEqual([
            '/runs:null',
            '/api/black-box/control-token:Bearer access-client-a',
            '/runs:Bearer shared-broker-token',
            '/distributed-runs:null',
            '/distributed-runs:Bearer shared-broker-token',
        ]);
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

    it.each([401, 403])(
        'retains structured fallback HTTP %s authorization on a partial snapshot',
        async status => {
            const api = createRecipeConsoleControlApi({
                controlUrl: 'wss://control.test/control',
                apiBaseUrl: 'https://api.test',
                fetchFn: async (input) => String(input).endsWith('/distributed-runs')
                    ? Response.json(
                        { error: 'Distributed-run authorization required.' },
                        { status },
                    )
                    : Response.json({ runs: [] }),
            });

            const result = await api.readSnapshot({});

            expect(result).toMatchObject({
                snapshot: { runs: [] },
                completeness: 'partial',
                partialError: {
                    name: 'ControlRunManagerHttpError',
                    status,
                },
            });
        },
    );

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
    ])('retains usable runs when optional distributed fallback payloads are malformed %#', async payload => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input) => String(input).endsWith('/distributed-runs')
                ? Response.json(payload)
                : Response.json({ runs: [] }),
        });

        const result = await api.readSnapshot({});

        expect(result).toMatchObject({
            snapshot: { runs: [] },
            completeness: 'partial',
            authorization: 'anonymous',
            partialError: {
                name: 'RecipeConsoleControlProtocolError',
                reachable: true,
                message: 'Control server snapshot distributedRuns must be an array.',
            },
        });
    });

    it.each([
        [
            { invalid: true },
            'Control server snapshot distributedRuns must be an array.',
        ],
        [
            [null],
            'Control server snapshot distributedRuns[0] must be an object.',
        ],
        [
            [{
                distributedRunId: 'distributed-malformed',
                controlRunId: 'run-a',
                state: 'running',
                updatedAtEpochMs: 1,
                targetAgentIds: [],
                commandLinks: [],
                rollup: { summary: { blockingFailures: 0 } },
            }],
            'Control server snapshot distributedRuns[0].manifest must be an object.',
        ],
        [
            [{
                distributedRunId: 'distributed-future',
                controlRunId: 'run-a',
                state: 'future-unknown',
                updatedAtEpochMs: 1,
                targetAgentIds: [],
                commandLinks: [],
                manifest: {
                    group: {
                        applicationId: 'app-a',
                        workspaceId: 'workspace-a',
                        groupId: 'group-a',
                    },
                },
                rollup: { summary: { blockingFailures: 0 } },
            }],
            'Control server snapshot distributedRuns[0].state must be a known distributed-run state.',
        ],
        [
            [{
                distributedRunId: 'distributed-target-resolution',
                controlRunId: 'run-a',
                state: 'running',
                updatedAtEpochMs: 1,
                targetAgentIds: ['agent-a'],
                commandLinks: [],
                manifest: {
                    group: {
                        applicationId: 'app-a',
                        workspaceId: 'workspace-a',
                        groupId: 'group-a',
                    },
                },
                rollup: { summary: { blockingFailures: 0 } },
                targetResolution: {},
            }],
            'Control server snapshot distributedRuns[0].targetResolution.roleAssignments must be an array.',
        ],
    ])('retains usable runs when embedded optional distributed context is malformed %#', async (
        distributedRuns,
        message,
    ) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json({
                runs: [],
                distributedRuns,
            }),
        });

        const result = await api.readSnapshot({});

        expect(result).toMatchObject({
            snapshot: { runs: [] },
            completeness: 'partial',
            partialError: {
                name: 'RecipeConsoleControlProtocolError',
                reachable: true,
                message,
            },
        });
        expect('distributedRuns' in result.snapshot).toBe(false);
    });

    it.each([
        [{ distributedRuns: [] }, 'runs'],
        [{ runs: [], distributedRuns: [], fleetReports: {} }, 'fleetReports'],
        [null, 'runs'],
    ])('rejects a malformed top-level %s snapshot', async (payload, field) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json(payload),
        });

        const request = api.readSnapshot({});
        await expect(request).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
        });
        await expect(request).rejects.toThrow(
            `Control server snapshot ${field} must be an array.`,
        );
    });

    it.each([
        [
            {
                runs: [
                    protocolControlRun('run-duplicate'),
                    protocolControlRun('run-duplicate'),
                ],
                distributedRuns: [],
            },
            'Control server snapshot runs must contain unique runId values.',
        ],
        [
            {
                runs: [protocolControlRun('run-a', [
                    'agent-duplicate',
                    'agent-duplicate',
                ])],
                distributedRuns: [],
            },
            'Control server snapshot runs[0].agents must contain unique agentId values.',
        ],
    ])('rejects duplicate core control identities %#', async (payload, message) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json(payload),
        });

        const request = api.readSnapshot({});
        await expect(request).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
        });
        await expect(request).rejects.toThrow(message);
    });

    it.each([
        [
            [
                protocolDistributedRun('distributed-duplicate'),
                protocolDistributedRun('distributed-duplicate'),
            ],
            'Control server snapshot distributedRuns must contain unique distributedRunId values.',
        ],
        [
            [protocolDistributedRun('distributed-a', {
                targetAgentIds: ['agent-duplicate', 'agent-duplicate'],
            })],
            'Control server snapshot distributedRuns[0].targetAgentIds must contain unique values.',
        ],
    ])('retains core runs when distributed identities are duplicated %#', async (
        distributedRuns,
        message,
    ) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json({
                runs: [protocolControlRun('run-a')],
                distributedRuns,
            }),
        });

        await expect(api.readSnapshot({})).resolves.toMatchObject({
            snapshot: { runs: [{ runId: 'run-a' }] },
            completeness: 'partial',
            partialError: {
                name: 'RecipeConsoleControlProtocolError',
                reachable: true,
                message,
            },
        });
    });

    it.each([
        [
            { runId: 'run-malformed', agents: null },
            'Control server snapshot runs[0].agents must be an array.',
        ],
        [
            { runId: 'run-malformed', agents: [], commands: null },
            'Control server snapshot runs[0].commands must be an array.',
        ],
        [
            {
                runId: 'run-malformed',
                agents: [{
                    agentId: 'agent-malformed',
                    connected: true,
                    completedCommandIds: null,
                    receivedResultCount: 0,
                    receivedEventCount: 0,
                    reconnectCount: 0,
                }],
                commands: [],
            },
            'Control server snapshot runs[0].agents[0].completedCommandIds must be an array.',
        ],
        [
            {
                runId: 'run-malformed',
                agents: [{
                    agentId: 'agent-malformed',
                    connected: true,
                    completedCommandIds: [],
                    receivedResultCount: 0,
                    receivedEventCount: 0,
                    reconnectCount: 0,
                    lastHeartbeatAtEpochMs: '1',
                }],
                commands: [],
            },
            'Control server snapshot runs[0].agents[0].lastHeartbeatAtEpochMs must be a finite number.',
        ],
        [
            {
                runId: 'run-malformed',
                agents: [{
                    agentId: 'agent-malformed',
                    connected: true,
                    completedCommandIds: [],
                    receivedResultCount: 0,
                    receivedEventCount: 0,
                    reconnectCount: 0,
                    lastSeenAtEpochMs: '1',
                }],
                commands: [],
            },
            'Control server snapshot runs[0].agents[0].lastSeenAtEpochMs must be a finite number.',
        ],
        [
            {
                runId: 'run-malformed',
                agents: [{
                    agentId: 'agent-malformed',
                    connected: true,
                    completedCommandIds: [],
                    receivedResultCount: 0,
                    receivedEventCount: 0,
                    reconnectCount: 0,
                    identity: { updatedAtEpochMs: '1' },
                }],
                commands: [],
            },
            'Control server snapshot runs[0].agents[0].identity.updatedAtEpochMs must be a finite number.',
        ],
        [
            {
                runId: 'run-malformed',
                agents: [{
                    agentId: 'agent-malformed',
                    connected: true,
                    completedCommandIds: [],
                    receivedResultCount: 0,
                    receivedEventCount: 0,
                    reconnectCount: 0,
                    identity: { principalId: { toString: null } },
                }],
                commands: [],
            },
            'Control server snapshot runs[0].agents[0].identity.principalId must be a string.',
        ],
    ])('rejects nested control-run shapes that are unsafe for repository derivations %#', async (
        run,
        message,
    ) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json({
                runs: [run],
                distributedRuns: [],
            }),
        });

        const request = api.readSnapshot({});
        await expect(request).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
        });
        await expect(request).rejects.toThrow(message);
    });

    it('marks invalid JSON from a successful control response as reachable', async () => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => new Response('{', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        });

        await expect(api.readSnapshot({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
        });
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

    it('delegates every execution operation to the canonical REST contract with cancellation', async () => {
        const controller = new AbortController();
        const requests: Array<{
            path: string;
            method: string;
            body: string | undefined;
            authorization: string | null;
            signal: AbortSignal | null | undefined;
        }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            manualToken: 'operator-token',
            apiBaseUrl: 'https://api.test',
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                requests.push({
                    path: url.pathname,
                    method: init?.method ?? 'GET',
                    body: typeof init?.body === 'string' ? init.body : undefined,
                    authorization: authorization(init),
                    signal: init?.signal,
                });
                if (url.pathname.endsWith('/artifacts')) {
                    return Response.json(protocolDistributedArtifact());
                }
                if (url.pathname.endsWith('/resolve-targets')) {
                    return Response.json(protocolTargetResolution());
                }
                const state = url.pathname.endsWith('/stage')
                    ? 'waiting-for-ack'
                    : url.pathname.endsWith('/start')
                    ? 'running'
                    : url.pathname.endsWith('/cancel')
                    ? 'cancelled'
                    : 'draft';
                return Response.json(protocolDistributedRun(
                    'distributed-execute-a',
                    { state, manifest: DISTRIBUTED_MANIFEST },
                ));
            },
        });
        const request = { signal: controller.signal };

        await expect(api.execution.resolveTargets({
            manifest: DISTRIBUTED_MANIFEST,
            ...request,
        })).resolves.toMatchObject({ targetAgentIds: ['agent-a'] });
        await expect(api.execution.createRun({
            manifest: DISTRIBUTED_MANIFEST,
            ...request,
        })).resolves.toMatchObject({ state: 'draft' });
        await expect(api.execution.stageRun({
            distributedRunId: 'distributed-execute-a',
            ...request,
        })).resolves.toMatchObject({ state: 'waiting-for-ack' });
        await expect(api.execution.startRun({
            distributedRunId: 'distributed-execute-a',
            ...request,
        })).resolves.toMatchObject({ state: 'running' });
        await expect(api.execution.cancelRun({
            distributedRunId: 'distributed-execute-a',
            reason: 'Operator stopped the run.',
            ...request,
        })).resolves.toMatchObject({ state: 'cancelled' });
        await expect(api.execution.exportRunArtifact({
            distributedRunId: 'distributed-execute-a',
            ...request,
        })).resolves.toMatchObject({ artifactSchemaVersion: 2 });

        expect(requests).toEqual([
            {
                path: '/distributed-runs/resolve-targets',
                method: 'POST',
                body: JSON.stringify({ manifest: DISTRIBUTED_MANIFEST }),
                authorization: 'Bearer operator-token',
                signal: controller.signal,
            },
            {
                path: '/distributed-runs',
                method: 'POST',
                body: JSON.stringify({ manifest: DISTRIBUTED_MANIFEST }),
                authorization: 'Bearer operator-token',
                signal: controller.signal,
            },
            {
                path: '/distributed-runs/distributed-execute-a/stage',
                method: 'POST',
                body: undefined,
                authorization: 'Bearer operator-token',
                signal: controller.signal,
            },
            {
                path: '/distributed-runs/distributed-execute-a/start',
                method: 'POST',
                body: undefined,
                authorization: 'Bearer operator-token',
                signal: controller.signal,
            },
            {
                path: '/distributed-runs/distributed-execute-a/cancel',
                method: 'POST',
                body: JSON.stringify({ reason: 'Operator stopped the run.' }),
                authorization: 'Bearer operator-token',
                signal: controller.signal,
            },
            {
                path: '/distributed-runs/distributed-execute-a/artifacts',
                method: 'GET',
                body: undefined,
                authorization: 'Bearer operator-token',
                signal: controller.signal,
            },
        ]);
    });

    it('keeps read, write, and artifact authorization challenges separate while reusing one broker token', async () => {
        const requests: string[] = [];
        let brokerRequests = 0;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                const path = new URL(String(input)).pathname;
                const auth = authorization(init);
                requests.push(`${path}:${auth}`);
                if (path === '/api/black-box/control-token') {
                    brokerRequests += 1;
                    return Response.json({
                        tokenType: 'Bearer',
                        token: 'shared-execution-token',
                        issuedAtEpochMs: 3_000_000_000_000,
                        expiresAtEpochMs: 4_000_000_000_000,
                        ttlMs: 1_000_000_000_000,
                    });
                }
                if (!auth) {
                    return Response.json(
                        { error: 'Operator token required.' },
                        { status: 401, statusText: 'Unauthorized' },
                    );
                }
                if (path === '/runs') return Response.json(COMPLETE_SNAPSHOT);
                if (path.endsWith('/artifacts')) {
                    return Response.json(protocolDistributedArtifact());
                }
                return Response.json(protocolDistributedRun(
                    'distributed-execute-a',
                    { state: 'draft', manifest: DISTRIBUTED_MANIFEST },
                ));
            },
        });

        await api.readSnapshot({});
        await api.execution.createRun({ manifest: DISTRIBUTED_MANIFEST });
        await api.execution.stageRun({
            distributedRunId: 'distributed-execute-a',
        });
        await api.execution.exportRunArtifact({
            distributedRunId: 'distributed-execute-a',
        });

        expect(brokerRequests).toBe(1);
        expect(requests).toEqual([
            '/runs:null',
            '/api/black-box/control-token:Bearer access-client-a',
            '/runs:Bearer shared-execution-token',
            '/distributed-runs:null',
            '/distributed-runs:Bearer shared-execution-token',
            '/distributed-runs/distributed-execute-a/stage:Bearer shared-execution-token',
            '/distributed-runs/distributed-execute-a/artifacts:null',
            '/distributed-runs/distributed-execute-a/artifacts:Bearer shared-execution-token',
        ]);
    });

    it('refreshes a near-expiry broker token before a later execution write', async () => {
        const now = Date.now();
        const writeAuthorizations: Array<string | null> = [];
        let brokerRequests = 0;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('client-a', 'session-a'),
            fetchFn: async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/api/black-box/control-token') {
                    brokerRequests += 1;
                    return Response.json({
                        tokenType: 'Bearer',
                        token: `execution-token-${brokerRequests}`,
                        issuedAtEpochMs: now,
                        expiresAtEpochMs: brokerRequests === 1 ? now + 60_000 : now + 3_600_000,
                        ttlMs: brokerRequests === 1 ? 60_000 : 3_600_000,
                    });
                }
                const auth = authorization(init);
                writeAuthorizations.push(auth);
                if (!auth) {
                    return Response.json(
                        { error: 'Operator token required.' },
                        { status: 401, statusText: 'Unauthorized' },
                    );
                }
                return Response.json(protocolDistributedRun(
                    'distributed-execute-a',
                    { state: 'draft', manifest: DISTRIBUTED_MANIFEST },
                ));
            },
        });

        await api.execution.createRun({ manifest: DISTRIBUTED_MANIFEST });
        await api.execution.stageRun({
            distributedRunId: 'distributed-execute-a',
        });

        expect(brokerRequests).toBe(2);
        expect(writeAuthorizations).toEqual([
            null,
            'Bearer execution-token-1',
            'Bearer execution-token-2',
        ]);
    });

    it('withholds ambient credentials from URL-selected execution writes', async () => {
        const authorizations: Array<string | null> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://untrusted-control.test/control',
            manualToken: 'environment-secret',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('victim-client', 'victim-session'),
            credentialPolicy: recipeConsoleControlCredentialPolicyFromSearch(
                '?v=1&experience=recipe-console' +
                    '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol',
            ),
            fetchFn: async (_input, init) => {
                authorizations.push(authorization(init));
                return Response.json(
                    { error: 'Operator token required.' },
                    { status: 401, statusText: 'Unauthorized' },
                );
            },
        });

        await expect(api.execution.createRun({
            manifest: DISTRIBUTED_MANIFEST,
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlCredentialTrustError',
            credentialTrustRequired: true,
        });
        expect(authorizations).toEqual([null]);
    });

    it.each(
        [
            ['resolveTargets', { targetAgentIds: 'agent-a' }, 'targetAgentIds'],
            ['createRun', { state: 'future-state' }, 'state'],
        ] as const,
    )('rejects malformed successful %s responses as reachable protocol errors', async (
        operation,
        overrides,
        message,
    ) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () =>
                operation === 'resolveTargets'
                    ? Response.json(protocolTargetResolution(overrides))
                    : Response.json(protocolDistributedRun(
                        'distributed-execute-a',
                        { ...overrides, manifest: DISTRIBUTED_MANIFEST },
                    )),
        });

        const request = operation === 'resolveTargets'
            ? api.execution.resolveTargets({ manifest: DISTRIBUTED_MANIFEST })
            : api.execution.createRun({ manifest: DISTRIBUTED_MANIFEST });
        await expect(request).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
            message: expect.stringContaining(message),
        });
    });

    it('accepts a schema-v2 base artifact without optional enriched files', async () => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () => Response.json(protocolDistributedArtifact()),
        });

        await expect(api.execution.exportRunArtifact({
            distributedRunId: 'distributed-execute-a',
        })).resolves.toEqual(protocolDistributedArtifact());
    });

    it.each(
        [
            ['artifactSchemaVersion', { artifactSchemaVersion: 1 }],
            ['distributedRunId', { distributedRunId: 7 }],
            ['generatedAtEpochMs', { generatedAtEpochMs: Number.NaN }],
            ['distributed-run.json', {
                files: {
                    ...protocolDistributedArtifact().files,
                    'distributed-run.json': null,
                },
            }],
            ['manifest.json', {
                files: {
                    ...protocolDistributedArtifact().files,
                    'manifest.json': false,
                },
            }],
            ['control-run.json', {
                files: {
                    ...protocolDistributedArtifact().files,
                    'control-run.json': {},
                },
            }],
            ['target-resolution.json', {
                files: {
                    ...protocolDistributedArtifact().files,
                    'target-resolution.json': 7,
                },
            }],
            ['results.jsonl', {
                files: {
                    ...protocolDistributedArtifact().files,
                    'results.jsonl': [],
                },
            }],
        ] as const,
    )('rejects a malformed successful artifact %s field', async (
        field,
        overrides,
    ) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            apiBaseUrl: 'https://api.test',
            fetchFn: async () =>
                Response.json(
                    protocolDistributedArtifact(overrides),
                ),
        });

        await expect(api.execution.exportRunArtifact({
            distributedRunId: 'distributed-execute-a',
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
            message: expect.stringContaining(field),
        });
    });
});
