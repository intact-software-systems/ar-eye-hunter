import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import type { executeBlackBox } from '@shared-test/black-box-runner/execute-black-box.ts';
import type { BlackBoxFetch } from '@shared-test/black-box-runner/execution/black-box-scenario-context.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import {
    ALICE,
    AUTH_OUTPUTS,
    BOB,
    createRecipeHttpPort,
    executeRecipeSegment,
    GROUP_PATH,
    toGroupSnapshot,
    toTopology,
    type RecipeHttpPort
} from './api-v1-recipe-causal-prerequisite-fixture.ts';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('API-v1 connect fence causal prerequisite', () => {
    it('uses the exact replacement identity after a lagging committed presence response', async () => {
        const http = createConnectFenceHttpPort([toGroupSnapshot(4, 1, [ALICE]), toGroupSnapshot(4, 2, [ALICE, BOB])]);
        const pending = executeConnectFence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure, JSON.stringify(report.results)).toBe(0);
        expect(report.outputs).toMatchObject({ currentLayoutGroupRevision: 4, currentLayoutPresenceRevision: 2, currentLayoutVersion: 2 });
        const connects = http.requests.filter(({ path }) => path.includes('/lifecycle/connect/'));
        expect(connects).toHaveLength(3);
        expect(connects.every(({ atEpochMs }) => atEpochMs >= 250)).toBe(true);
        expect(JSON.parse(connects[2].body ?? '')).toEqual({
            expectedFormationEpoch: 1,
            expectedLayout: { groupRevision: 4, presenceRevision: 2, version: 2, state: 'active' }
        });
    });

    it.each([
        { name: 'missing Bob', snapshot: toGroupSnapshot(4, 2, [ALICE]) },
        { name: 'wrong group', snapshot: { ...toGroupSnapshot(4, 2, [ALICE, BOB]), group: { groupId: 'other-group' } } },
        { name: 'wrong session', snapshot: toGroupSnapshot(4, 2, [ALICE, { ...BOB, sessionId: 'other-session' }]) },
        { name: 'wrong generation', snapshot: toGroupSnapshot(4, 2, [ALICE, { ...BOB, generationId: 'old-generation' }]) }
    ])('blocks every connect within the original bound for $name', async ({ snapshot }) => {
        const http = createConnectFenceHttpPort([snapshot]);
        const pending = executeConnectFence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure).toBeGreaterThan(0);
        expect(report.resultsByName.bobArrivesAndTheStoreReplans[0].status).toBe('SUCCESS');
        expect(report.resultsByName.replacementLayoutIsPublished[0].status).toBe('FAILURE');
        expect(report.summary.durationMs).toBeLessThanOrEqual(15000);
        expect(http.requests.some(({ path }) => path.includes('/lifecycle/connect/'))).toBe(false);
        expect(http.requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
    });

    it('refuses a topology whose group revision differs from the exact converged projection', async () => {
        const http = createConnectFenceHttpPort([toGroupSnapshot(4, 2, [ALICE, BOB])], 99);
        const pending = executeConnectFence(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure).toBeGreaterThan(0);
        expect(report.resultsByName.replacementLayoutIsPublished[0].status).toBe('FAILURE');
        expect(http.requests.some(({ path }) => path.includes('/lifecycle/connect/'))).toBe(false);
    });
});

function executeConnectFence(fetch: BlackBoxFetch): ReturnType<typeof executeBlackBox> {
    return executeRecipeSegment({
        recipe: 'api-v1-group-connect-fence',
        start: 'bobArrivesAndTheStoreReplans',
        end: undefined,
        outputs: { ...AUTH_OUTPUTS, firstLayoutGroupRevision: 2, firstLayoutPresenceRevision: 1, firstLayoutVersion: 1, firstLayoutState: 'active' },
        fetch
    });
}

function createConnectFenceHttpPort(snapshots: readonly ApiJsonObject[], topologyGroupRevision = 4): RecipeHttpPort {
    let groupReads = 0;
    let topologyReads = 0;
    return createRecipeHttpPort(({ method, path, body }) => {
        if (method === 'PUT') {
            return Response.json(toGroupSnapshot(4, 1, [ALICE]));
        }
        if (method === 'GET' && path === GROUP_PATH) {
            return Response.json(snapshots[Math.min(groupReads++, snapshots.length - 1)]);
        }
        if (path.endsWith('/topology')) {
            return Response.json(
                topologyReads++ === 0
                    ? toTopology({ groupRevision: 2, presenceRevision: 1, version: 1, activeSessionIds: ['alice-session'] })
                    : toTopology({ groupRevision: topologyGroupRevision, presenceRevision: 2, version: 2, activeSessionIds: ['alice-session', 'bob-session'] })
            );
        }
        if (path.endsWith('/formation')) {
            return Response.json({
                lifecycleState: 'planned',
                formationEpoch: 1,
                formationAttemptCount: 0,
                establishmentStartedAtEpochMs: null,
                pending: null
            });
        }
        if (path.includes('/lifecycle/connect/')) {
            const status = path.includes('stale-epoch') || path.includes('superseded') || !body?.includes('"presenceRevision":2') ? 409 : 200;
            return Response.json(
                status === 200
                    ? { group: { lifecycleState: 'connecting', formationEpoch: 2 } }
                    : {
                        type: 'api-mutation-failure',
                        version: 'canonical.v2',
                        code: path.includes('stale-epoch') ? 'group-connect-stale-epoch' : 'group-connect-planned-layout-superseded',
                        status: 409
                    },
                { status }
            );
        }
        throw new Error(`Unexpected connect-fence request ${method} ${path}`);
    });
}
