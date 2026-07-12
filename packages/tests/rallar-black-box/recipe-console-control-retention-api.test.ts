import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';
import type { AuthSession } from '@shared/api/api-config.ts';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ControlRunManagerHttpError as CanonicalHttpError } from '../../../apps/rallar-black-box/src/control-http-error.ts';
import { ControlRunManagerHttpError as LegacyHttpError } from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    createRecipeConsoleControlApi,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type {
    RecipeConsoleControlConnection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import {
    createControlLazyCapability,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-lazy-capability.ts';
import {
    requestControlRetentionConfirmation,
    requestControlRetentionPreview,
    requestLegacyControlRetentionCleanup,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-request.ts';
import {
    parseControlRetentionConfirmation,
    parseControlRetentionPreview,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-retention-validation.ts';
import {
    recipeConsoleControlCredentialPolicyFromSearch,
    TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts';

const repositoryRoot = resolve(import.meta.dirname, '../../..');

const PREVIEW = {
    deletedRunIds: [],
    retainedRuns: 4,
    maxRuns: 2,
    dryRun: true,
    wouldDeleteRuns: [
        {
            runId: 'run-a',
            createdAtEpochMs: 10,
            updatedAtEpochMs: 30,
            connectedAgentCount: 2,
            issuedRunTokenCount: 1,
            distributedRuns: [
                { distributedRunId: 'distributed-a-1', state: 'running' },
                { distributedRunId: 'distributed-a-2', state: 'passed' },
            ],
            fleetReportIds: ['distributed-a-2'],
        },
        {
            runId: 'run-b',
            createdAtEpochMs: 20,
            updatedAtEpochMs: 30,
            connectedAgentCount: 0,
            issuedRunTokenCount: 0,
            distributedRuns: [
                { distributedRunId: 'distributed-b', state: 'failed' },
            ],
            fleetReportIds: ['distributed-b'],
        },
    ],
    wouldDeleteRunIds: ['run-a', 'run-b'],
    // The server preserves global distributed insertion order, which may
    // interleave candidate groups. Set equality, not flattened order, is truth.
    wouldDeleteDistributedRunIds: [
        'distributed-b',
        'distributed-a-1',
        'distributed-a-2',
    ],
    wouldDeleteFleetReportIds: ['distributed-b', 'distributed-a-2'],
    projectedRetainedRuns: 2,
    preserves: {
        connectedAgentSockets: true,
        storedArtifactFiles: true,
    },
    planToken: 'opaque.v1_Abc-123',
} as const;

const CONFIRMATION = {
    deletedRunIds: ['run-a', 'run-b'],
    retainedRuns: 2,
    maxRuns: 2,
} as const;

function clonePreview(): Record<string, unknown> {
    return structuredClone(PREVIEW) as unknown as Record<string, unknown>;
}

function authSession(clientId = 'client-a'): AuthSession {
    return {
        clientId,
        sessionId: `session-${clientId}`,
        username: clientId,
        accessToken: `access-${clientId}`,
        expiresAtEpochMs: 4_000_000_000_000,
    };
}

function authorization(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get('Authorization');
}

describe('Recipe Console retention request wire format', () => {
    it('serializes preview, confirmation, and legacy compatibility without bodies or inherited secrets', async () => {
        const requests: Array<{ url: URL; init?: RequestInit }> = [];
        const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
            requests.push({ url: new URL(String(input)), init });
            return Response.json(PREVIEW);
        };
        const baseUrl = 'https://control.test/control?token=must-not-leak#fragment';

        await requestControlRetentionPreview({ baseUrl, fetchFn });
        await requestControlRetentionConfirmation({
            baseUrl,
            planToken: 'opaque +&/token',
            fetchFn,
        });
        await requestLegacyControlRetentionCleanup({ baseUrl, fetchFn });

        expect(requests.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
            '/retention/cleanup?dryRun=true',
            '/retention/cleanup?planToken=opaque+%2B%26%2Ftoken',
            '/retention/cleanup',
        ]);
        for (const request of requests) {
            expect(request.init?.method).toBe('POST');
            expect(request.init?.body).toBeUndefined();
            expect(new Headers(request.init?.headers).has('Content-Type')).toBe(false);
            expect(new Headers(request.init?.headers).has('Authorization')).toBe(false);
            expect(request.url.hash).toBe('');
            expect(request.url.searchParams.has('token')).toBe(false);
        }
    });

    it.each([
        [400, 'Bad Request'],
        [409, 'Conflict'],
        [413, 'Payload Too Large'],
    ])('retains canonical HTTP %s provenance', async (status, statusText) => {
        const fetchFn = async () => Response.json(
            { error: `retention-${status}` },
            { status, statusText },
        );

        const failure = requestControlRetentionPreview({
            baseUrl: 'https://control.test',
            fetchFn,
        });

        await expect(failure).rejects.toBeInstanceOf(CanonicalHttpError);
        await expect(failure).rejects.toBeInstanceOf(LegacyHttpError);
        await expect(failure).rejects.toMatchObject({
            message: `retention-${status}`,
            status,
            statusText,
        });
    });

    it('keeps non-JSON success parse failures and non-JSON HTTP status separate', async () => {
        await expect(requestControlRetentionPreview({
            baseUrl: 'https://control.test',
            fetchFn: async () => new Response('not-json'),
        })).rejects.toBeInstanceOf(SyntaxError);

        await expect(requestControlRetentionPreview({
            baseUrl: 'https://control.test',
            fetchFn: async () => new Response('not-json', {
                status: 409,
                statusText: 'Conflict',
            }),
        })).rejects.toMatchObject({
            name: 'ControlRunManagerHttpError',
            status: 409,
            statusText: 'Conflict',
        });
    });
});

describe('Recipe Console retention response validation', () => {
    it('accepts exact server consequences, interleaved global order, and opaque unsafe-for-navigation IDs', () => {
        const value = clonePreview();
        const candidates = value.wouldDeleteRuns as Array<Record<string, unknown>>;
        candidates[0].runId = '  run\0/Δ  ';
        (value.wouldDeleteRunIds as string[])[0] = '  run\0/Δ  ';

        const parsed = parseControlRetentionPreview(value);

        expect(parsed.wouldDeleteRuns[0].runId).toBe('  run\0/Δ  ');
        expect(parsed.wouldDeleteDistributedRunIds).toEqual(
            PREVIEW.wouldDeleteDistributedRunIds,
        );
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(Object.isFrozen(parsed.wouldDeleteRuns)).toBe(true);
        expect(Object.isFrozen(parsed.wouldDeleteRuns[0].distributedRuns)).toBe(true);
    });

    it.each([
        ['a missing root field', (value: Record<string, unknown>) => {
            delete value.preserves;
        }],
        ['an unknown root field', (value: Record<string, unknown>) => {
            value.secret = 'must-not-survive';
        }],
        ['a nonempty deleted list', (value: Record<string, unknown>) => {
            value.deletedRunIds = ['run-a'];
        }],
        ['a false dry-run marker', (value: Record<string, unknown>) => {
            value.dryRun = false;
        }],
        ['a negative count', (value: Record<string, unknown>) => {
            value.retainedRuns = -1;
        }],
        ['a fractional cap', (value: Record<string, unknown>) => {
            value.maxRuns = 1.5;
        }],
        ['an unsafe cap', (value: Record<string, unknown>) => {
            value.maxRuns = Number.MAX_SAFE_INTEGER + 1;
        }],
        ['an empty identity', (value: Record<string, unknown>) => {
            (value.wouldDeleteRunIds as string[])[0] = '';
        }],
        ['duplicate run identities', (value: Record<string, unknown>) => {
            (value.wouldDeleteRunIds as string[])[1] = 'run-a';
            (value.wouldDeleteRuns as Array<Record<string, unknown>>)[1].runId = 'run-a';
        }],
        ['an oversize identity', (value: Record<string, unknown>) => {
            const identity = 'x'.repeat(1024 * 1024 + 1);
            (value.wouldDeleteRunIds as string[])[0] = identity;
            (value.wouldDeleteRuns as Array<Record<string, unknown>>)[0].runId = identity;
        }],
        ['a candidate with an extra field', (value: Record<string, unknown>) => {
            (value.wouldDeleteRuns as Array<Record<string, unknown>>)[0].rawToken = 'secret';
        }],
        ['an invalid candidate timestamp', (value: Record<string, unknown>) => {
            (value.wouldDeleteRuns as Array<Record<string, unknown>>)[0].updatedAtEpochMs = NaN;
        }],
        ['an invalid distributed state', (value: Record<string, unknown>) => {
            const run = (value.wouldDeleteRuns as Array<Record<string, unknown>>)[0];
            (run.distributedRuns as Array<Record<string, unknown>>)[0].state = 'invented';
        }],
        ['a run-list mismatch', (value: Record<string, unknown>) => {
            (value.wouldDeleteRunIds as string[]).reverse();
        }],
        ['a distributed union mismatch', (value: Record<string, unknown>) => {
            (value.wouldDeleteDistributedRunIds as string[]).pop();
        }],
        ['a fleet union mismatch', (value: Record<string, unknown>) => {
            (value.wouldDeleteFleetReportIds as string[]).pop();
        }],
        ['a candidate fleet report without a linked distributed run', (value: Record<string, unknown>) => {
            const run = (value.wouldDeleteRuns as Array<Record<string, unknown>>)[0];
            run.fleetReportIds = ['distributed-elsewhere'];
            value.wouldDeleteFleetReportIds = ['distributed-b', 'distributed-elsewhere'];
        }],
        ['a global fleet order outside distributed order', (value: Record<string, unknown>) => {
            value.wouldDeleteFleetReportIds = ['distributed-a-2', 'distributed-b'];
        }],
        ['a projected-count mismatch', (value: Record<string, unknown>) => {
            value.projectedRetainedRuns = 1;
        }],
        ['a cap projection mismatch', (value: Record<string, unknown>) => {
            value.maxRuns = 1;
        }],
        ['a false socket-preservation marker', (value: Record<string, unknown>) => {
            (value.preserves as Record<string, unknown>).connectedAgentSockets = false;
        }],
        ['an unknown preservation field', (value: Record<string, unknown>) => {
            (value.preserves as Record<string, unknown>).artifactRows = true;
        }],
        ['an empty token', (value: Record<string, unknown>) => {
            value.planToken = '';
        }],
        ['a padded token', (value: Record<string, unknown>) => {
            value.planToken = ' token ';
        }],
        ['a control-character token', (value: Record<string, unknown>) => {
            value.planToken = 'opaque\nsecret';
        }],
        ['an oversize token', (value: Record<string, unknown>) => {
            value.planToken = 't'.repeat(513);
        }],
    ])('rejects %s', (_label, mutate) => {
        const value = clonePreview();
        mutate(value);
        expect(() => parseControlRetentionPreview(value)).toThrow();
    });

    it('accepts disabled zero retention only when it preserves every run', () => {
        const value = clonePreview();
        value.maxRuns = 0;
        value.projectedRetainedRuns = 4;
        value.wouldDeleteRuns = [];
        value.wouldDeleteRunIds = [];
        value.wouldDeleteDistributedRunIds = [];
        value.wouldDeleteFleetReportIds = [];

        expect(parseControlRetentionPreview(value)).toMatchObject({
            maxRuns: 0,
            retainedRuns: 4,
            projectedRetainedRuns: 4,
        });
    });

    it('rejects multiplicative nested collections that exceed the cumulative shared response budget', () => {
        const candidateCount = 600;
        const distributedPerCandidate = 100;
        const candidates = Array.from({ length: candidateCount }, (_, candidate) => ({
            runId: `run-${candidate}`,
            createdAtEpochMs: candidate,
            updatedAtEpochMs: candidate,
            connectedAgentCount: 0,
            issuedRunTokenCount: 0,
            distributedRuns: Array.from(
                { length: distributedPerCandidate },
                (_, linked) => ({
                    distributedRunId: `distributed-${candidate}-${linked}`,
                    state: 'passed',
                }),
            ),
            fleetReportIds: [],
        }));
        const runIds = candidates.map(candidate => candidate.runId);
        const distributedIds = candidates.flatMap(candidate =>
            candidate.distributedRuns.map(run => run.distributedRunId)
        );
        const value = {
            ...PREVIEW,
            retainedRuns: candidateCount + 1,
            maxRuns: 1,
            wouldDeleteRuns: candidates,
            wouldDeleteRunIds: runIds,
            wouldDeleteDistributedRunIds: distributedIds,
            wouldDeleteFleetReportIds: [],
            projectedRetainedRuns: 1,
        };

        expect(() => parseControlRetentionPreview(value)).toThrow(/bound|budget/i);
    });

    it('validates confirmation against the exact branded preview consequences', () => {
        const preview = parseControlRetentionPreview(clonePreview());
        const confirmation = parseControlRetentionConfirmation(CONFIRMATION, preview);

        expect(confirmation).toEqual(CONFIRMATION);
        expect(Object.isFrozen(confirmation)).toBe(true);
    });

    it.each([
        ['an extra field', { ...CONFIRMATION, dryRun: false }],
        ['different IDs', { ...CONFIRMATION, deletedRunIds: ['run-b', 'run-a'] }],
        ['a retained mismatch', { ...CONFIRMATION, retainedRuns: 3 }],
        ['a cap mismatch', { ...CONFIRMATION, maxRuns: 1 }],
        ['a fractional count', { ...CONFIRMATION, retainedRuns: 1.5 }],
    ])('rejects confirmation with %s', (_label, value) => {
        const preview = parseControlRetentionPreview(clonePreview());
        expect(() => parseControlRetentionConfirmation(value, preview)).toThrow();
    });
});

describe('Recipe Console authorized retention API', () => {
    it('uses anonymous success without brokering and caches one lazy API instance', async () => {
        const requests: string[] = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'wss://control.test/control',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async (input, init) => {
                requests.push(`${new URL(String(input)).pathname}:${authorization(init)}`);
                return Response.json(PREVIEW);
            },
        });

        const first = await api.retention.load();
        const second = await api.retention.load();
        const preview = await first.preview({});

        expect(first).toBe(second);
        expect(preview).toMatchObject({ planToken: PREVIEW.planToken });
        expect(requests).toEqual(['/retention/cleanup:null']);
    });

    it.each([401, 403])(
        'brokers a trusted anonymous %s preview once and sends confirmation with the cached credential immediately',
        async challengeStatus => {
            const requests: Array<{ path: string; query: string; auth: string | null }> = [];
            const api = createRecipeConsoleControlApi({
                controlUrl: 'wss://control.test/control?token=never',
                apiBaseUrl: 'https://api.test',
                authSession: authSession(),
                credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
                fetchFn: async (input, init) => {
                    const url = new URL(String(input));
                    const auth = authorization(init);
                    requests.push({ path: url.pathname, query: url.search, auth });
                    if (url.pathname === '/api/black-box/control-token') {
                        return Response.json({
                            tokenType: 'Bearer',
                            token: 'brokered-retention-secret',
                            issuedAtEpochMs: 3_000_000_000_000,
                            expiresAtEpochMs: 4_000_000_000_000,
                            ttlMs: 1_000_000_000_000,
                        });
                    }
                    if (!auth) {
                        return Response.json(
                            { error: 'Operator token required.' },
                            { status: challengeStatus },
                        );
                    }
                    return url.searchParams.has('planToken')
                        ? Response.json(CONFIRMATION)
                        : Response.json(PREVIEW);
                },
            });
            const retention = await api.retention.load();

            const preview = await retention.preview({});
            const confirmation = await retention.confirm({ preview });

            expect(confirmation).toEqual(CONFIRMATION);
            expect(requests).toEqual([
                { path: '/retention/cleanup', query: '?dryRun=true', auth: null },
                {
                    path: '/api/black-box/control-token',
                    query: '',
                    auth: 'Bearer access-client-a',
                },
                {
                    path: '/retention/cleanup',
                    query: '?dryRun=true',
                    auth: 'Bearer brokered-retention-secret',
                },
                {
                    path: '/retention/cleanup',
                    query: `?planToken=${encodeURIComponent(PREVIEW.planToken)}`,
                    auth: 'Bearer brokered-retention-secret',
                },
            ]);
            expect(JSON.stringify(requests)).not.toContain('run-a');
        },
    );

    it('uses a manual credential once and never brokers its authorization failure', async () => {
        const requests: Array<{ path: string; auth: string | null }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test/control',
            manualToken: ' manual-retention-secret ',
            apiBaseUrl: 'https://api.test',
            authSession: authSession(),
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                requests.push({ path: url.pathname, auth: authorization(init) });
                return Response.json({ error: 'Forbidden.' }, { status: 403 });
            },
        });
        const retention = await api.retention.load();

        await expect(retention.preview({})).rejects.toMatchObject({ status: 403 });
        expect(requests).toEqual([{
            path: '/retention/cleanup',
            auth: 'Bearer manual-retention-secret',
        }]);
    });

    it('withholds ambient credentials from a URL-selected control origin', async () => {
        const requests: Array<{ url: string; auth: string | null }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://untrusted-control.test/control',
            manualToken: 'ambient-manual-secret',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('victim'),
            credentialPolicy: recipeConsoleControlCredentialPolicyFromSearch(
                '?v=1&experience=recipe-console' +
                    '&controlUrl=https%3A%2F%2Funtrusted-control.test%2Fcontrol',
            ),
            fetchFn: async (input, init) => {
                requests.push({ url: String(input), auth: authorization(init) });
                return Response.json({ error: 'Unauthorized.' }, { status: 401 });
            },
        });
        const retention = await api.retention.load();

        await expect(retention.preview({})).rejects.toMatchObject({
            credentialTrustRequired: true,
        });
        expect(requests).toEqual([{
            url: 'https://untrusted-control.test/retention/cleanup?dryRun=true',
            auth: null,
        }]);
    });

    it('allows only the caller-supplied token for the same URL-selected control origin', async () => {
        const requests: Array<{ url: string; auth: string | null }> = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://caller-control.test/control',
            manualToken: 'caller-control-token',
            apiBaseUrl: 'https://api.test',
            authSession: authSession('victim'),
            credentialPolicy: recipeConsoleControlCredentialPolicyFromSearch(
                '?v=1&experience=recipe-console' +
                    '&controlUrl=https%3A%2F%2Fcaller-control.test%2Fcontrol' +
                    '&controlToken=caller-control-token',
            ),
            fetchFn: async (input, init) => {
                requests.push({ url: String(input), auth: authorization(init) });
                return Response.json(PREVIEW);
            },
        });

        await (await api.retention.load()).preview({});

        expect(requests).toEqual([{
            url: 'https://caller-control.test/retention/cleanup?dryRun=true',
            auth: 'Bearer caller-control-token',
        }]);
        expect(JSON.stringify(requests)).not.toContain('access-victim');
    });

    it.each([400, 409, 413])('does not broker or retry a retention HTTP %s', async status => {
        const requests: string[] = [];
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            authSession: authSession(),
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async (input) => {
                requests.push(String(input));
                return Response.json({ error: `failure-${status}` }, { status });
            },
        });
        const retention = await api.retention.load();

        await expect(retention.preview({})).rejects.toMatchObject({ status });
        expect(requests).toEqual([
            'https://control.test/retention/cleanup?dryRun=true',
        ]);
    });

    it.each([
        ['invalid JSON', () => new Response('not-json')],
        ['an invalid payload', () => Response.json({ ...PREVIEW, retainedRuns: -1 })],
    ])('maps %s 2xx to a reachable protocol error', async (_label, response) => {
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async () => response(),
        });
        const retention = await api.retention.load();

        await expect(retention.preview({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
        });
    });

    it('maps a post-response TypeError to a reachable protocol error', async () => {
        const response = {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => {
                throw new TypeError('Response adapter failed while reading JSON.');
            },
        } as Response;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async () => response,
        });
        const retention = await api.retention.load();

        await expect(retention.preview({})).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            reachable: true,
            message: 'Response adapter failed while reading JSON.',
        });
    });

    it('brands previews to one API context and refuses cross-endpoint confirmation locally', async () => {
        let endpointBRequests = 0;
        const firstApi = createRecipeConsoleControlApi({
            controlUrl: 'https://control-a.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async () => Response.json(PREVIEW),
        });
        const secondApi = createRecipeConsoleControlApi({
            controlUrl: 'https://control-b.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async () => {
                endpointBRequests += 1;
                return Response.json(CONFIRMATION);
            },
        });
        const preview = await (await firstApi.retention.load()).preview({});
        const secondRetention = await secondApi.retention.load();

        await expect(secondRetention.confirm({ preview })).rejects.toThrow(
            /current control connection/i,
        );
        expect(endpointBRequests).toBe(0);
        expect(firstApi.retention.generation).not.toBe(
            secondApi.retention.generation,
        );
    });

    it('aborts and suppresses a response even when the fetch adapter ignores its signal', async () => {
        let resolveResponse!: (response: Response) => void;
        const response = new Promise<Response>((resolve) => {
            resolveResponse = resolve;
        });
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async () => response,
        });
        const retention = await api.retention.load();
        const pending = retention.preview({});

        api.close();
        resolveResponse(Response.json(PREVIEW));

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await expect(retention.preview({})).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('refuses confirmation after connection invalidation without sending a request', async () => {
        let requests = 0;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async (_input) => {
                requests += 1;
                return Response.json(PREVIEW);
            },
        });
        const retention = await api.retention.load();
        const preview = await retention.preview({});
        api.close();

        await expect(retention.confirm({ preview })).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(requests).toBe(1);
    });

    it('rejects a new preview while confirmation is in flight and never leaves a pre-cleanup preview current', async () => {
        let resolveConfirmation!: (response: Response) => void;
        const confirmation = new Promise<Response>(resolve => {
            resolveConfirmation = resolve;
        });
        let requests = 0;
        const api = createRecipeConsoleControlApi({
            controlUrl: 'https://control.test',
            apiBaseUrl: 'https://api.test',
            credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
            fetchFn: async input => {
                requests += 1;
                return new URL(String(input)).searchParams.has('planToken')
                    ? confirmation
                    : Response.json(PREVIEW);
            },
        });
        const retention = await api.retention.load();
        const preview = await retention.preview({});
        const pendingConfirmation = retention.confirm({ preview });

        await expect(retention.preview({})).rejects.toThrow(/confirmation.*progress/i);
        expect(requests).toBe(2);
        resolveConfirmation(Response.json(CONFIRMATION));
        await expect(pendingConfirmation).resolves.toEqual(CONFIRMATION);

        await expect(retention.preview({})).resolves.toMatchObject({
            planToken: PREVIEW.planToken,
        });
        expect(requests).toBe(3);
    });
});

describe('Recipe Console retention lazy boundary', () => {
    it('suppresses a deferred lazy result after its lifetime is aborted', async () => {
        const controller = new AbortController();
        let resolveValue!: (value: { value: string }) => void;
        let loads = 0;
        const deferred = new Promise<{ value: string }>((resolve) => {
            resolveValue = resolve;
        });
        const capability = createControlLazyCapability({
            signal: controller.signal,
            load: async () => {
                loads += 1;
                return deferred;
            },
        });
        const pending = capability.load();
        controller.abort();
        resolveValue({ value: 'stale' });

        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await expect(capability.load()).rejects.toMatchObject({ name: 'AbortError' });
        expect(loads).toBe(1);
    });

    it('retries a transient lazy import failure within the same live context', async () => {
        const controller = new AbortController();
        let loads = 0;
        const capability = createControlLazyCapability({
            signal: controller.signal,
            load: async () => {
                loads += 1;
                if (loads === 1) throw new TypeError('Chunk temporarily unavailable.');
                return { value: 'loaded' };
            },
        });

        await expect(capability.load()).rejects.toThrow('temporarily unavailable');
        await expect(capability.load()).resolves.toEqual({ value: 'loaded' });
        await expect(capability.load()).resolves.toEqual({ value: 'loaded' });
        expect(loads).toBe(2);
    });

    it('keeps feature modules out of eager value-import graphs and provider serialization', () => {
        const managerPath = 'apps/rallar-black-box/src/control-run-manager.ts';
        const controlApiPath =
            'apps/rallar-black-box/src/recipe-console/control/control-api.ts';
        const providerPath =
            'apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
        const requestPath =
            'apps/rallar-black-box/src/recipe-console/control/control-retention-request.ts';

        for (const path of [managerPath, controlApiPath, providerPath]) {
            const imports = moduleImports(path);
            expect(
                imports.filter(item =>
                    !item.typeOnly && item.specifier.includes('control-retention')
                ),
                path,
            ).toEqual([]);
            expect(source(path), path).not.toContain('/retention/cleanup');
        }
        expect(dynamicImports(controlApiPath)).toEqual([
            './control-retention-api.ts',
        ]);
        expect(source(requestPath)).toContain(
            "from '../../control-http-error.ts'",
        );
        expect(source(requestPath)).not.toContain('control-run-manager');

        const provider = source(providerPath);
        expect(provider).toContain('retention: apiSetup.api?.retention');
        expect(provider).toMatch(/\.close\(\)/);
        expect(provider).toContain('React StrictMode replays effects');
        expect(provider).toContain('useLayoutEffect');
        expect(provider).not.toMatch(
            /planToken|dryRun|['"]Authorization['"]|\.set\(['"]Authorization/,
        );
        expectTypeOf<RecipeConsoleControlConnection['bootstrap']>()
            .not.toHaveProperty('manualToken');
        expectTypeOf<RecipeConsoleControlConnection['bootstrap']>()
            .not.toHaveProperty('credentialPolicy');

        const validation = source(
            'apps/rallar-black-box/src/recipe-console/control/control-retention-validation.ts',
        );
        const relationships = validation.slice(
            validation.indexOf('function validateLinkedConsequences'),
            validation.indexOf('function exactRecord'),
        );
        expect(relationships).not.toContain('.includes(');
        expect(relationships).not.toMatch(
            /for\s*\([^)]*candidates[^)]*\)[\s\S]*distributedIds\.filter/,
        );
    });
});

function source(path: string): string {
    return readFileSync(resolve(repositoryRoot, path), 'utf8');
}

function moduleImports(path: string): Array<{
    specifier: string;
    typeOnly: boolean;
}> {
    const file = sourceFile(path);
    const imports: Array<{ specifier: string; typeOnly: boolean }> = [];
    file.forEachChild(node => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
            imports.push({
                specifier: node.moduleSpecifier.text,
                typeOnly: node.importClause?.isTypeOnly === true,
            });
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)) {
            imports.push({
                specifier: node.moduleSpecifier.text,
                typeOnly: node.isTypeOnly,
            });
        }
    });
    return imports;
}

function dynamicImports(path: string): string[] {
    const file = sourceFile(path);
    const imports: string[] = [];
    function visit(node: ts.Node): void {
        if (
            ts.isCallExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ImportKeyword &&
            node.arguments.length === 1 &&
            ts.isStringLiteral(node.arguments[0])
        ) {
            imports.push(node.arguments[0].text);
        }
        ts.forEachChild(node, visit);
    }
    visit(file);
    return imports;
}

function sourceFile(path: string): ts.SourceFile {
    return ts.createSourceFile(
        path,
        source(path),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
}
