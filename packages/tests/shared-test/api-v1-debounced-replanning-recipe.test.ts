import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

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

describe('API-v1 debounce causal prerequisite', () => {
    it('keeps four mutations at the original cadence and waits for all six exact sessions', async () => {
        const http = createDebounceHttpPort();
        const pending = executeRecipeSegment({
            recipe: 'api-v1-debounced-replanning',
            start: 'replacingSessions',
            end: undefined,
            outputs: AUTH_OUTPUTS,
            fetch: http.fetch
        });
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure, JSON.stringify(report.results)).toBe(0);
        expect(report.outputs).toMatchObject({ burstGroupRevision: 8, burstPresenceRevision: 6 });
        expect(http.requests.filter(({ method }) => method === 'PUT').map(({ atEpochMs }) => atEpochMs)).toEqual([0, 500, 1000, 1500]);
        expect(http.requests.filter(({ path }) => path === GROUP_PATH).map(({ atEpochMs }) => atEpochMs)).toEqual([2000, 2250]);
    });

    it.each(['missing session', 'wrong generation', 'extra session', 'wrong topology revision'])('never treats %s as the whole burst', async (invalid) => {
        const http = createDebounceHttpPort(invalid);
        const pending = executeRecipeSegment({
            recipe: 'api-v1-debounced-replanning',
            start: 'replacingSessions',
            end: undefined,
            outputs: AUTH_OUTPUTS,
            fetch: http.fetch
        });
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure).toBeGreaterThan(0);
        expect(report.resultsByName.boundedReplanCoversTheWholeBurst[0].status).toBe('FAILURE');
        expect(report.summary.durationMs).toBeLessThanOrEqual(14000);
        expect(http.requests.filter(({ method }) => method === 'PUT')).toHaveLength(4);
        expect(report.resultsByName.nothingPendsAfterTheReplan).toBeUndefined();
    });
});

function createDebounceHttpPort(invalid = ''): RecipeHttpPort {
    let logins = 0;
    let puts = 0;
    let formations = 0;
    let groupReads = 0;
    const sessions = toDebounceSessions('');
    const observed = toDebounceSessions(invalid);
    return createRecipeHttpPort(({ method, path }) => {
        if (path.includes('/auth/login/')) {
            return Response.json({ sessionId: `churn-${++logins}`, accessToken: 'churn-test' });
        }
        if (method === 'PUT') {
            return Response.json(toGroupSnapshot(8, [3, 3, 4, 5][puts++], sessions.slice(0, 5)));
        }
        if (path.endsWith('/formation')) {
            const index = formations++;
            return Response.json({
                lifecycleState: 'active',
                pending: index < 4 ? { reconfigureQueued: true, generation: index + 1, dueAtEpochMs: index === 0 ? 4000 : 4500 } : null
            });
        }
        if (path === GROUP_PATH) {
            return Response.json(toGroupSnapshot(8, groupReads++ === 0 && !invalid ? 5 : 6, groupReads === 1 && !invalid ? sessions.slice(0, 5) : observed));
        }
        if (path.endsWith('/topology')) {
            return Response.json(
                toTopology({
                    groupRevision: 8,
                    presenceRevision: invalid === 'wrong topology revision' ? 5 : 6,
                    version: 2,
                    activeSessionIds: ['alice-session', 'bob-session', 'churn-1', 'churn-2', 'churn-3', 'churn-4']
                })
            );
        }
        throw new Error(`Unexpected debounce request ${method} ${path}`);
    });
}

function toDebounceSessions(invalid: string): ApiJsonObject[] {
    const sessions = [
        { ...ALICE, generationId: 'generation-semantic' },
        { ...BOB, generationId: 'generation-semantic' },
        ...[1, 2, 3, 4].map((iteration) => ({
            sessionId: `churn-${iteration}`,
            principalId: 'alice',
            generationId: `generation-${iteration}-semantic`,
            status: 'active'
        }))
    ];
    return invalid === 'missing session'
        ? sessions.slice(0, 5)
        : invalid === 'wrong generation'
        ? sessions.map((session, index) => index === 5 ? { ...session, generationId: 'old-generation' } : session)
        : invalid === 'extra session'
        ? [...sessions, { ...ALICE, sessionId: 'extra-session' }]
        : sessions;
}
