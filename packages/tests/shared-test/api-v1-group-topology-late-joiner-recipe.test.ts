import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { BlackBoxFetch } from '@shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import { toExecutableInteractions } from '@shared-test/black-box-runner/recipes/to-executable-interactions.ts';
import type { GroupTopologyManagementView } from '@shared/api/graph-topology-management-types.ts';

import { readApiV1Recipe } from './api-v1-recipe-test-fixture.ts';

interface TopologyRecipeRequest {
    readonly method: string;
    readonly url: string;
    readonly clientId: string | null;
}

const GROUP_REF = { applicationId: 'topology-app', workspaceId: 'topology-workspace', groupId: 'topology-group' };
const TOPOLOGY_URL = 'http://topology.test/api/state/apps/topology-app/workspaces/topology-workspace/groups/topology-group/topology';
const JOIN_URL =
    'http://topology.test/api/state/apps/topology-app/workspaces/topology-workspace/groups/topology-group/members/late/requests/join-latejoin-late-semantic';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('late-joiner topology recipe baseline readiness', () => {
    it.each([
        ['founder-session', 'member-session'],
        ['member-session', 'founder-session']
    ])('captures only the complete two-session topology regardless of order: %j', async (...sessions) => {
        const http = new TopologyRecipePorts([
            toTopologyView(['founder-session'], 2),
            toTopologyView(sessions, 3)
        ], toTopologyView(['founder-session', 'member-session'], 3));
        const report = await runTopologyRecipe(http);

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.formationTopologyVersion).toBe(3);
        expect(report.outputs.lateJoinerTopologyVersion).toBe(3);
        expect(http.requests.map(({ method, url, clientId }) => ({ method, url, clientId }))).toEqual([
            { method: 'GET', url: TOPOLOGY_URL, clientId: 'founder' },
            { method: 'GET', url: TOPOLOGY_URL, clientId: 'founder' },
            { method: 'PUT', url: JOIN_URL, clientId: 'late' },
            { method: 'GET', url: TOPOLOGY_URL, clientId: 'late' }
        ]);
    });

    it('accepts an already complete baseline immediately and sends the late join once', async () => {
        const http = new TopologyRecipePorts(
            [toTopologyView(['founder-session', 'member-session'], 3)],
            toTopologyView(['founder-session', 'member-session'], 3)
        );
        const report = await runTopologyRecipe(http);

        expect(report.summary.failure).toBe(0);
        expect(http.requests.map(({ method, clientId }) => ({ method, clientId }))).toEqual([
            { method: 'GET', clientId: 'founder' },
            { method: 'PUT', clientId: 'late' },
            { method: 'GET', clientId: 'late' }
        ]);
    });

    it.each([
        { name: 'missing founder', sessions: ['member-session'] },
        { name: 'missing member', sessions: ['founder-session'] },
        { name: 'extra session', sessions: ['founder-session', 'member-session', 'other-session'] },
        { name: 'duplicate session', sessions: ['founder-session', 'founder-session'] },
        { name: 'wrong session', sessions: ['founder-session', 'other-session'] }
    ])('fails before late join when the baseline never converges: $name', async ({ sessions }) => {
        const http = new TopologyRecipePorts([toTopologyView(sessions, 2)], toTopologyView(['founder-session', 'member-session'], 3));
        const report = await runTopologyRecipe(http);

        expect(report.summary.failure).toBe(1);
        expect(report.resultsByName.captureFormationTopology[0]).toMatchObject({ status: 'FAILURE', pollExhausted: true });
        expect(report.outputs.formationTopologyVersion).toBeUndefined();
        expect(report.resultsByName.joinLate).toBeUndefined();
        expect(report.resultsByName.readTopologyAsLateJoinerWithoutNewPublication).toBeUndefined();
        expect(http.requests.length).toBeGreaterThan(1);
        expect(http.requests.length).toBeLessThanOrEqual(20);
        expect(http.requests.every(({ method, url, clientId }) => method === 'GET' && url === TOPOLOGY_URL && clientId === 'founder')).toBe(true);
        expect(report.summary.durationMs).toBeLessThanOrEqual(15000);
    });

    it('still fails on a changed final version after one late join and one final read', async () => {
        const http = new TopologyRecipePorts(
            [toTopologyView(['founder-session', 'member-session'], 3)],
            toTopologyView(['founder-session', 'member-session'], 4)
        );
        const report = await runTopologyRecipe(http);

        expect(report.summary.failure).toBe(1);
        expect(report.outputs.formationTopologyVersion).toBe(3);
        expect(report.resultsByName.readTopologyAsLateJoinerWithoutNewPublication[0]).toMatchObject({
            status: 'FAILURE',
            actual: { body: { snapshot: { version: 4 } } },
            expected: { body: { snapshot: { version: 3 } } }
        });
        expect(http.requests.map(({ method, clientId }) => ({ method, clientId }))).toEqual([
            { method: 'GET', clientId: 'founder' },
            { method: 'PUT', clientId: 'late' },
            { method: 'GET', clientId: 'late' }
        ]);
    });
});

async function runTopologyRecipe(http: TopologyRecipePorts): ReturnType<typeof executeBlackBox> {
    const recipe = readApiV1Recipe('tests/api-v1/api-v1-group-topology-late-joiner.json');
    const steps = recipe.steps ?? [];
    const start = steps.findIndex((step) => step.name === 'captureFormationTopology');
    const end = steps.findIndex((step) => step.name === 'readTopologyAsLateJoinerWithoutNewPublication');
    if (start < 0 || end < start) {
        throw new Error('Missing late-joiner topology baseline segment');
    }
    const outputs = {
        founderClientId: 'founder',
        founderSessionId: 'founder-session',
        founderAuthHeader: 'Bearer founder-test',
        memberSessionId: 'member-session',
        lateClientId: 'late',
        lateAuthHeader: 'Bearer late-test'
    };
    const interactions = toExecutableInteractions({
        ...recipe,
        variables: { ...GROUP_REF, rallarApiBaseUrl: 'http://topology.test', runId: 'semantic' },
        steps: [
            ...Object.entries(outputs).map(([output, value]) => ({ name: `seed-${output}`, type: 'set', output, value })),
            ...steps.slice(start, end + 1)
        ]
    });
    const pending = executeBlackBox(interactions, 0, {
        failFast: true,
        dependencies: { now: Date.now, createUuid: () => 'topology-semantic', fetch: http.fetch }
    });
    await vi.runAllTimersAsync();
    return await pending;
}

function toTopologyView(activeSessionIds: readonly string[], version: number): GroupTopologyManagementView {
    return {
        groupRef: GROUP_REF,
        overlayId: 'topology-overlay',
        snapshot: {
            sourceGroupStateCausalRevision: { groupRevision: 3, presenceRevision: version === 2 ? 1 : 2 },
            state: 'active',
            overlayId: 'topology-overlay',
            groupRef: GROUP_REF,
            name: 'Late-joiner room',
            topology: 'star',
            activeSessionIds,
            nextHopsBySessionId: Object.fromEntries(activeSessionIds.map((session) => [session, activeSessionIds.filter((other) => other !== session)])),
            degreeLimit: 32,
            version,
            createdByClientId: 'founder',
            createdAtEpochMs: 0,
            updatedAtEpochMs: 0
        },
        acceptedSnapshot: null,
        config: {
            serverDefaults: { topologyKind: 'auto', degreeLimit: 32, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 },
            durable: null,
            temporary: null,
            requestOptions: null,
            effective: { topologyKind: 'auto', degreeLimit: 32, treeMinSize: 3, meshMinSize: 8, meshParamK: 2 }
        },
        pending: { reconfigureQueued: version === 2, dueAtEpochMs: version === 2 ? 100 : null, generation: version === 2 ? 4 : null }
    };
}

class TopologyRecipePorts {
    readonly requests: TopologyRecipeRequest[] = [];
    readonly #baselines: readonly GroupTopologyManagementView[];
    readonly #final: GroupTopologyManagementView;
    #reads = 0;

    constructor(baselines: readonly GroupTopologyManagementView[], final: GroupTopologyManagementView) {
        this.#baselines = baselines;
        this.#final = final;
    }

    readonly fetch: BlackBoxFetch = async (url, request) => {
        const method = request?.method ?? 'GET';
        const clientId = new Headers(request?.headers).get('x-client-id');
        this.requests.push({ method, url: String(url), clientId });
        if (method === 'GET' && String(url) === TOPOLOGY_URL) {
            return Response.json(clientId === 'founder' ? this.#baselines[Math.min(this.#reads++, this.#baselines.length - 1)] : this.#final);
        }
        if (method === 'PUT' && String(url) === JOIN_URL && clientId === 'late') {
            return Response.json({ group: { groupId: GROUP_REF.groupId } });
        }
        throw new Error(`Unexpected topology recipe request ${method} ${String(url)}`);
    };
}
