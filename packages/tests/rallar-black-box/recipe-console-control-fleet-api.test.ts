// @vitest-environment happy-dom
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES,
    RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES,
} from '@shared-test/rallar-bb-test/fleet-report-validation.ts';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createRecipeConsoleControlApi,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import {
    ControlConnectionProvider,
    type RecipeConsoleControlConnection,
    useControlConnection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/ControlConnectionProvider.tsx';
import {
    TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-credential-policy.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BOOTSTRAP = {
    controlUrl: 'https://control.test/control',
    apiBaseUrl: 'https://api.test',
    credentialPolicy: TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY,
    bootstrapGroup: {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'fleet-room',
    },
} as const;

type Deferred<Value> = Readonly<{
    promise: Promise<Value>;
    resolve(value: Value): void;
}>;

function deferred<Value>(): Deferred<Value> {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>(onResolve => {
        resolve = onResolve;
    });
    return { promise, resolve };
}

function authSession(): AuthSession {
    return {
        clientId: 'operator-a',
        sessionId: 'session-operator-a',
        username: 'operator-a',
        accessToken: 'access-operator-a',
        expiresAtEpochMs: 4_000_000_000_000,
    };
}

function authorization(init: RequestInit | undefined): string | null {
    return new Headers(init?.headers).get('Authorization');
}

function bundle(
    distributedRunId: string,
    files: Readonly<Record<string, unknown>> = {
        'fleet-report.json': JSON.stringify({ distributedRunId }),
        'summary.md': `# ${distributedRunId}`,
        'agent-results.csv': 'agentId,state\nagent-a,passed\n',
        'failure-signatures.csv': 'signatureId,count\n',
    },
): Record<string, unknown> {
    return {
        fleetReportSchemaVersion: 1,
        distributedRunId,
        generatedAtEpochMs: 2_000,
        files,
    };
}

function bundleResponse(value: unknown): Response {
    const text = JSON.stringify(value);
    return new Response(text, {
        headers: {
            'content-type': 'application/json',
            'content-length': String(new TextEncoder().encode(text).byteLength),
        },
    });
}

function createApi(fetchFn: typeof fetch) {
    return createRecipeConsoleControlApi({
        ...BOOTSTRAP,
        fetchFn,
    });
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Recipe Console Fleet lazy control capability', () => {
    it('loads the feature lazily and sends no request before explicit selection', async () => {
        vi.useFakeTimers();
        const requests: URL[] = [];
        const api = createApi(async input => {
            requests.push(new URL(String(input)));
            return bundleResponse(bundle('distributed / one'));
        });

        expect(requests).toEqual([]);
        const fleet = await api.fleet.load();
        expect(requests).toEqual([]);
        expect(fleet.getSelectedReportBundle()).toBeUndefined();

        const selected = await fleet.selectReportBundle({
            distributedRunId: 'distributed / one',
        });
        await vi.advanceTimersByTimeAsync(60_000);

        expect(requests.map(url => url.pathname)).toEqual([
            '/fleet/reports/distributed%20%2F%20one/artifacts',
        ]);
        expect(selected.distributedRunId).toBe('distributed / one');
        expect(fleet.getSelectedReportBundle()).toBe(selected);
        api.close();
    });

    it('uses the existing authorized endpoint retry without exposing credentials', async () => {
        const requests: Array<{ path: string; auth: string | null }> = [];
        const api = createRecipeConsoleControlApi({
            ...BOOTSTRAP,
            authSession: authSession(),
            fetchFn: async (input, init) => {
                const url = new URL(String(input));
                const auth = authorization(init);
                requests.push({ path: url.pathname, auth });
                if (url.pathname === '/api/black-box/control-token') {
                    return Response.json({
                        tokenType: 'Bearer',
                        token: 'brokered-fleet-secret',
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
                return bundleResponse(bundle('distributed-auth'));
            },
        });

        const selected = await (await api.fleet.load()).selectReportBundle({
            distributedRunId: 'distributed-auth',
        });

        expect(selected.distributedRunId).toBe('distributed-auth');
        expect(requests).toEqual([
            { path: '/fleet/reports/distributed-auth/artifacts', auth: null },
            {
                path: '/api/black-box/control-token',
                auth: 'Bearer access-operator-a',
            },
            {
                path: '/fleet/reports/distributed-auth/artifacts',
                auth: 'Bearer brokered-fleet-secret',
            },
        ]);
        api.close();
    });

    it('does not load or request Fleet data merely because the provider exists', async () => {
        const requests: URL[] = [];
        let observed: RecipeConsoleControlConnection | undefined;
        const container = document.createElement('div');
        document.body.append(container);
        const root = createRoot(container);
        vi.stubGlobal('fetch', vi.fn(async input => {
            requests.push(new URL(String(input)));
            return Response.json({ runs: [], distributedRuns: [] });
        }));

        function Harness() {
            observed = useControlConnection();
            return null;
        }

        try {
            await act(async () => root.render(createElement(
                ControlConnectionProvider,
                { bootstrap: BOOTSTRAP },
                createElement(Harness),
            )));
            await vi.waitFor(() => expect(observed?.query.status).toBe('live'));
            const requestCount = requests.length;

            expect(observed?.fleet).toBeDefined();
            expect(requests.some(url =>
                url.pathname.startsWith('/fleet/reports/')
                && url.pathname.endsWith('/artifacts')
            )).toBe(false);
            await observed!.fleet!.load();
            expect(requests).toHaveLength(requestCount);
        } finally {
            await act(async () => root.unmount());
            container.remove();
        }
    });

    });

describe('Recipe Console Fleet selection authority', () => {
    it('rejects superseded, caller-aborted, and closed-context work without replacing current evidence', async () => {
        const firstResponse = deferred<Response>();
        const callerResponse = deferred<Response>();
        const contextResponse = deferred<Response>();
        const requests: string[] = [];
        const api = createApi(async input => {
            const distributedRunId = decodeURIComponent(
                new URL(String(input)).pathname.split('/').at(-2) ?? '',
            );
            requests.push(distributedRunId);
            if (distributedRunId === 'distributed-first') {
                return firstResponse.promise;
            }
            if (distributedRunId === 'distributed-caller') {
                return callerResponse.promise;
            }
            if (distributedRunId === 'distributed-context') {
                return contextResponse.promise;
            }
            return bundleResponse(bundle(distributedRunId));
        });
        const fleet = await api.fleet.load();

        const first = fleet.selectReportBundle({
            distributedRunId: 'distributed-first',
        });
        await vi.waitFor(() => expect(requests).toContain('distributed-first'));
        const current = await fleet.selectReportBundle({
            distributedRunId: 'distributed-current',
        });
        await expect(first).rejects.toMatchObject({ name: 'AbortError' });
        expect(fleet.getSelectedReportBundle()).toBe(current);
        firstResponse.resolve(bundleResponse(bundle('distributed-first')));

        const controller = new AbortController();
        const callerAborted = fleet.selectReportBundle({
            distributedRunId: 'distributed-caller',
            signal: controller.signal,
        });
        await vi.waitFor(() => expect(requests).toContain('distributed-caller'));
        controller.abort();
        await expect(callerAborted).rejects.toMatchObject({ name: 'AbortError' });
        expect(fleet.getSelectedReportBundle()).toBe(current);
        callerResponse.resolve(bundleResponse(bundle('distributed-caller')));

        const contextAborted = fleet.selectReportBundle({
            distributedRunId: 'distributed-context',
        });
        await vi.waitFor(() => expect(requests).toContain('distributed-context'));
        api.close();
        await expect(contextAborted).rejects.toMatchObject({ name: 'AbortError' });
        contextResponse.resolve(bundleResponse(bundle('distributed-context')));
        await expect(fleet.selectReportBundle({
            distributedRunId: 'distributed-after-close',
        })).rejects.toMatchObject({ name: 'AbortError' });
        expect(requests).not.toContain('distributed-after-close');
        expect(fleet.getSelectedReportBundle()).toBe(current);
    });

    it('parses bytes, validates identity and exact file keys, and never replaces retained evidence on failure', async () => {
        let nextResponse = () => bundleResponse(bundle('distributed-a'));
        const api = createApi(async () => nextResponse());
        const fleet = await api.fleet.load();
        const retained = await fleet.selectReportBundle({
            distributedRunId: 'distributed-a',
        });

        nextResponse = () => bundleResponse(bundle('wrong-id'));
        await expect(fleet.selectReportBundle({
            distributedRunId: 'distributed-b',
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            message: expect.stringContaining('bundle-run-id-mismatch'),
        });
        expect(fleet.getSelectedReportBundle()).toBe(retained);

        nextResponse = () => bundleResponse(bundle('distributed-b', {
            ...(bundle('distributed-b').files as Record<string, unknown>),
            'unexpected.txt': 'not allowed',
        }));
        await expect(fleet.selectReportBundle({
            distributedRunId: 'distributed-b',
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            message: expect.stringContaining('unexpected-bundle-file'),
        });
        expect(fleet.getSelectedReportBundle()).toBe(retained);

        nextResponse = () => new Response('{not-json', {
            headers: { 'content-type': 'application/json' },
        });
        await expect(fleet.selectReportBundle({
            distributedRunId: 'distributed-b',
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
        });
        expect(fleet.getSelectedReportBundle()).toBe(retained);

        nextResponse = () => bundleResponse(bundle('distributed-c'));
        const replacement = await fleet.selectReportBundle({
            distributedRunId: 'distributed-c',
        });
        expect(fleet.getSelectedReportBundle()).toBe(replacement);
        expect(replacement).not.toBe(retained);

        fleet.clearSelectedReportBundle();
        expect(fleet.getSelectedReportBundle()).toBeUndefined();
        api.close();
    });

    it('enforces per-file and aggregate UTF-8 bounds after the transfer gate', async () => {
        let nextResponse = () => bundleResponse(bundle('distributed-retained'));
        const api = createApi(async () => nextResponse());
        const fleet = await api.fleet.load();
        const retained = await fleet.selectReportBundle({
            distributedRunId: 'distributed-retained',
        });

        const oversizedFile = 'x'.repeat(
            RALLAR_BLACK_BOX_FLEET_REPORT_FILE_MAX_BYTES + 1,
        );
        nextResponse = () => bundleResponse(bundle('distributed-file', {
            'fleet-report.json': oversizedFile,
            'summary.md': '',
            'agent-results.csv': '',
            'failure-signatures.csv': '',
        }));
        await expect(fleet.selectReportBundle({
            distributedRunId: 'distributed-file',
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            message: expect.stringContaining('bundle-file-too-large'),
        });
        expect(fleet.getSelectedReportBundle()).toBe(retained);

        const aggregateQuarter = 'x'.repeat(
            RALLAR_BLACK_BOX_FLEET_REPORT_BUNDLE_MAX_BYTES / 4,
        );
        nextResponse = () => bundleResponse(bundle('distributed-aggregate', {
            'fleet-report.json': aggregateQuarter,
            'summary.md': `${aggregateQuarter}x`,
            'agent-results.csv': aggregateQuarter,
            'failure-signatures.csv': aggregateQuarter,
        }));
        await expect(fleet.selectReportBundle({
            distributedRunId: 'distributed-aggregate',
        })).rejects.toMatchObject({
            name: 'RecipeConsoleControlProtocolError',
            message: expect.stringContaining('bundle-too-large'),
        });
        expect(fleet.getSelectedReportBundle()).toBe(retained);
        api.close();
    });
});
