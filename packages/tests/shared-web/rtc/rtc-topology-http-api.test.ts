import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import {
    deleteStateGroupTopologyConfig,
    deleteStateGroupTopologyOverride,
    putStateGroupTopologyConfig,
    putStateGroupTopologyOverride,
    readStateGroupGraph,
    readStateGroupTopology,
    readStateGroupTopologyConfig,
    readStateGroupTopologyOverride,
    readStateScopedGlobalGraph,
    reconfigureStateGroupTopology
} from '@shared-web/browser/rtc/rtc-topology-http-api.ts';
import type {
    GroupTopologyConfigAcceptedCausalRevision,
    PutGroupTopologyConfigRequest,
    PutGroupTopologyOverrideRequest,
    ReconfigureGroupTopologyRequest
} from '@shared/api/graph-topology-management-types.ts';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

interface FetchCall {
    readonly physicalUrl: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body?: object;
}

describe('RTC topology HTTP mutations', () => {
    const fetchCalls: FetchCall[] = [];

    beforeEach(() => {
        fetchCalls.length = 0;
        configureApiClient({ apiBaseUrl: '' });
        installEmptyLocalStorage();
    });

    afterEach(() => {
        configureApiClient({ apiBaseUrl: '' });
        vi.unstubAllGlobals();
    });

    it('mutates topology config and overrides with authenticated requests', async () => {
        expectTypeOf<PutGroupTopologyConfigRequest>().toMatchTypeOf<Readonly<{ requestId: string; }>>();
        expectTypeOf<PutGroupTopologyOverrideRequest>().toMatchTypeOf<Readonly<{ requestId: string; }>>();
        expectTypeOf<ReconfigureGroupTopologyRequest>().toMatchTypeOf<Readonly<{ requestId: string; }>>();
        type ConfigReceipt = Awaited<ReturnType<typeof putStateGroupTopologyConfig>>['receipt'];
        expectTypeOf<ConfigReceipt['acceptedCausalRevision']>().toEqualTypeOf<GroupTopologyConfigAcceptedCausalRevision | null>();
        const scope = {
            applicationId: 'app 1',
            workspaceId: 'workspace/1'
        };
        const authSession = {
            clientId: 'owner-1',
            username: 'owner',
            sessionId: 'owner-session',
            accessToken: 'token-1',
            expiresAtEpochMs: Date.now() + 60_000
        };
        stubFetch(fetchCalls, () => jsonResponse({ ok: true }));

        await putStateGroupTopologyConfig({
            groupId: 'room /1',
            request: { config: { topologyKind: 'mesh', degreeLimit: 3 } },
            options: { authSession, requestId: 'topology-config-put-request-1' },
            scope
        });
        await putStateGroupTopologyOverride({
            groupId: 'room /1',
            request: { config: { topologyKind: 'star' }, ttlMs: 60_000 },
            options: { authSession, requestId: 'topology-override-put-request-1' },
            scope
        });
        await reconfigureStateGroupTopology({
            groupId: 'room /1',
            request: { options: { topologyKind: 'tree' }, publish: false },
            options: { authSession, requestId: 'topology-reconfigure-request-1' },
            scope
        });
        await deleteStateGroupTopologyConfig({
            groupId: 'room /1',
            options: { authSession, requestId: 'topology-config-delete-request-1' },
            scope
        });
        await deleteStateGroupTopologyOverride({
            groupId: 'room /1',
            options: { authSession, requestId: 'topology-override-delete-request-1' },
            scope
        });

        const topologyPath = '/api/state/apps/app%201/workspaces/workspace%2F1/groups/room%20%2F1/topology';
        expect(fetchCalls.map((call) => `${call.method} ${call.physicalUrl}`)).toEqual([
            `PUT ${topologyPath}/config/requests/topology-config-put-request-1`,
            `PUT ${topologyPath}/override/requests/topology-override-put-request-1`,
            `POST ${topologyPath}/reconfigure/requests/topology-reconfigure-request-1`,
            `DELETE ${topologyPath}/config/requests/topology-config-delete-request-1`,
            `DELETE ${topologyPath}/override/requests/topology-override-delete-request-1`
        ]);
        expect(fetchCalls.every((call) => call.headers.authorization === 'Bearer token-1')).toBe(true);
        expect(fetchCalls[0].body).toMatchObject({
            config: { topologyKind: 'mesh', degreeLimit: 3 }
        });
        expect(fetchCalls[1].body).toMatchObject({
            config: { topologyKind: 'star' },
            ttlMs: 60_000
        });
        expect(fetchCalls[2].body).toMatchObject({
            options: { topologyKind: 'tree' },
            publish: false
        });
        expect(fetchCalls[3].body).toEqual({});
        expect(fetchCalls[4].body).toEqual({});
    });

    it('rejects empty topology mutation request IDs before issuing HTTP', async () => {
        const scope = { applicationId: 'app', workspaceId: 'workspace' };
        const cases = [
            () =>
                putStateGroupTopologyConfig({
                    groupId: 'room',
                    request: { config: {} },
                    options: { requestId: '' },
                    scope
                }),
            () =>
                putStateGroupTopologyOverride({
                    groupId: 'room',
                    request: { config: {}, ttlMs: 1 },
                    options: { requestId: '' },
                    scope
                }),
            () =>
                reconfigureStateGroupTopology({
                    groupId: 'room',
                    request: {},
                    options: { requestId: '' },
                    scope
                }),
            () =>
                deleteStateGroupTopologyConfig({
                    groupId: 'room',
                    options: { requestId: '' },
                    scope
                }),
            () =>
                deleteStateGroupTopologyOverride({
                    groupId: 'room',
                    options: { requestId: '' },
                    scope
                })
        ];

        for (const call of cases) {
            await expect(call()).rejects.toThrow('API mutation requestId must contain');
        }
        expect(fetchCalls).toHaveLength(0);
    });

    it('reads scoped graph diagnostics and topology views with encoded query paths', async () => {
        const scope = { applicationId: 'app 1', workspaceId: 'workspace/1' };
        stubFetch(fetchCalls, () => jsonResponse({ ok: true }));

        await readStateScopedGlobalGraph(scope, { includeMeasured: true, refresh: 'always' });
        await readStateGroupGraph('room /1', scope, { includeMeasured: true, refresh: 'never' });
        await readStateGroupTopology('room /1', scope);
        await readStateGroupTopologyConfig('room /1', scope);
        await readStateGroupTopologyOverride('room /1', scope);

        const scopePath = '/api/state/apps/app%201/workspaces/workspace%2F1';
        expect(fetchCalls.map((call) => `${call.method} ${call.physicalUrl}`)).toEqual([
            `GET ${scopePath}/graphs/global?includeMeasured=true&refresh=always`,
            `GET ${scopePath}/groups/room%20%2F1/graphs/latest?includeMeasured=true&refresh=never`,
            `GET ${scopePath}/groups/room%20%2F1/topology`,
            `GET ${scopePath}/groups/room%20%2F1/topology/config`,
            `GET ${scopePath}/groups/room%20%2F1/topology/override`
        ]);
    });
});

function stubFetch(fetchCalls: FetchCall[], response: () => Response): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            fetchCalls.push({
                physicalUrl: String(input),
                method: init?.method ?? 'GET',
                headers: Object.fromEntries(new Headers(init?.headers).entries()),
                body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
            });
            return Promise.resolve(response());
        })
    );
}

function jsonResponse(body: object): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
}

function installEmptyLocalStorage(): void {
    vi.stubGlobal('localStorage', {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn()
    });
}
