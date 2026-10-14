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
    AUTH_OUTPUTS,
    createRecipeHttpPort,
    executeRecipeSegment,
    type RecipeHttpPort
} from './api-v1-recipe-causal-prerequisite-fixture.ts';

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
});
afterEach(() => vi.useRealTimers());

describe('API-v1 reconfigure landing causal prerequisite', () => {
    it.each([5, 2])('waits past the active baseline for an advanced layout with requested degree %i', async (degreeLimit) => {
        const http = createLandingHttpPort([{ version: 1, degreeLimit: 5 }, { version: 2, degreeLimit }]);
        const pending = executeLanding(http.fetch);
        await vi.runAllTimersAsync();
        const report = await pending;

        expect(report.summary.failure, JSON.stringify(report.results)).toBe(0);
        expect(report.outputs).toMatchObject({ settledVersion: 2, settledDegreeLimit: degreeLimit });
        const commands = http.requests.filter(({ method }) => method === 'POST');
        expect(commands).toHaveLength(2);
        expect(commands.map(({ body }) => JSON.parse(body ?? ''))).toEqual([
            { publish: true, options: { degreeLimit: 5 } },
            { publish: true, options: { degreeLimit: 2 } }
        ]);
        expect(http.requests.filter(({ method }) => method === 'GET').map(({ atEpochMs }) => atEpochMs)).toEqual([0, 150]);
    });

    it.each([{ name: 'unchanged baseline', version: 1, degreeLimit: 5 }, { name: 'unrelated degree', version: 2, degreeLimit: 3 }])(
        'fails within the original deadline for an $name and never repeats commands',
        async ({ version, degreeLimit }) => {
            const http = createLandingHttpPort([{ version, degreeLimit }]);
            const pending = executeLanding(http.fetch);
            await vi.runAllTimersAsync();
            const report = await pending;

            expect(report.summary.failure).toBeGreaterThan(0);
            expect(report.summary.durationMs).toBeLessThanOrEqual(15000);
            expect(http.requests.filter(({ method }) => method === 'POST')).toHaveLength(2);
            expect(http.requests.filter(({ method }) => method === 'GET').length).toBeGreaterThan(1);
        }
    );
});

function executeLanding(fetch: BlackBoxFetch): ReturnType<typeof executeBlackBox> {
    return executeRecipeSegment({
        recipe: 'api-v1-reconfigure-landing-concurrency',
        start: 'twoReconfiguresLandAtOnce',
        end: undefined,
        outputs: { ...AUTH_OUTPUTS, baselineVersion: 1 },
        fetch
    });
}

function createLandingHttpPort(layouts: readonly ApiJsonObject[]): RecipeHttpPort {
    let reads = 0;
    return createRecipeHttpPort(({ method, path }) => {
        if (method === 'POST') {
            return Response.json({ status: 'queued', outboxId: path.includes('-wide-') ? 'wide-outbox' : 'narrow-outbox' });
        }
        if (method === 'GET' && path.endsWith('/topology')) {
            return Response.json({ snapshot: { state: 'active', ...layouts[Math.min(reads++, layouts.length - 1)] } });
        }
        throw new Error(`Unexpected landing request ${method} ${path}`);
    });
}
