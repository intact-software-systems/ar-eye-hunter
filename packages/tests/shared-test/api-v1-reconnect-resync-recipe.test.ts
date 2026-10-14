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

import {
    ALICE,
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

describe('API-v1 reconnect causal prerequisite', () => {
    it('waits for Alpha second generation and Beta before requesting the hydration ticket', async () => {
        const http = createReconnectHttpPort();
        const pending = executeReconnect(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure, JSON.stringify(report.results)).toBe(0);
        expect(http.requests.filter(({ path }) => path.includes('/ws-ticket/')).map(({ atEpochMs }) => atEpochMs)).toEqual([150]);
        expect(http.requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
    });

    it.each(['missing Alpha', 'wrong generation', 'wrong session'])('blocks hydration preparation for %s within the original deadline', async (invalid) => {
        const http = createReconnectHttpPort(invalid);
        const pending = executeReconnect(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure).toBeGreaterThan(0);
        expect(report.resultsByName.restoreAlphaPresenceBeforeSocketHydration[0].status).toBe('SUCCESS');
        expect(report.resultsByName.theAuthoritativeTopologyIncludesBothSessionsBeforeReconnect[0].status).toBe('FAILURE');
        expect(report.summary.durationMs).toBeLessThanOrEqual(15000);
        expect(http.requests.some(({ path }) => path.includes('/ws-ticket/'))).toBe(false);
        expect(http.requests.filter(({ method }) => method === 'PUT')).toHaveLength(1);
    });
});

function executeReconnect(fetch: BlackBoxFetch): ReturnType<typeof executeBlackBox> {
    return executeRecipeSegment({
        recipe: 'api-v1-group-state-reconnect-resync',
        start: 'restoreAlphaPresenceBeforeSocketHydration',
        end: 'createAlphaWsTicketSecond',
        outputs: {
            alphaClientId: 'alice',
            alphaSessionId: 'alice-session',
            alphaAuthHeader: 'Bearer alice-test',
            betaClientId: 'bob',
            betaSessionId: 'bob-session'
        },
        fetch
    });
}

function createReconnectHttpPort(invalid = ''): RecipeHttpPort {
    let reads = 0;
    const alpha = {
        ...ALICE,
        generationId: invalid === 'wrong generation' ? 'old-generation' : 'generation-reconnect-alpha-second-semantic',
        sessionId: invalid === 'wrong session' ? 'other-session' : 'alice-session'
    };
    const beta = { ...BOB, generationId: 'generation-reconnect-beta-semantic' };
    return createRecipeHttpPort(({ method, path }) => {
        if (method === 'PUT') {
            return Response.json(toGroupSnapshot(3, 3, [beta]));
        }
        if (path === GROUP_PATH) {
            return Response.json(toGroupSnapshot(3, 4, reads++ === 0 || invalid === 'missing Alpha' ? [beta] : [alpha, beta]));
        }
        if (path.endsWith('/topology')) {
            return Response.json(toTopology({ groupRevision: 3, presenceRevision: 4, version: 2, activeSessionIds: ['alice-session', 'bob-session'] }));
        }
        if (path.includes('/ws-ticket/')) {
            return Response.json({ ticket: 'hydration-test', sessionId: 'alice-session' });
        }
        throw new Error(`Unexpected reconnect request ${method} ${path}`);
    });
}
