import {
    describe,
    expect,
    it
} from 'vitest';

import {
    computeBlackBoxRunnerPlanPreflight,
    type BlackBoxRunnerPlanPreflight
} from '@shared-test/black-box-runner/preflight/plan-preflight.ts';
import { computeBlackBoxRunnerEnvRequirements } from '@shared-test/black-box-runner/preflight/preflight-env-variables.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

function computeStrictPreflight(recipe: ApiJsonObject): BlackBoxRunnerPlanPreflight {
    return computeBlackBoxRunnerPlanPreflight({
        rawConfig: recipe,
        expandedConfig: recipe,
        executableInteractions: [],
        envRequirements: computeBlackBoxRunnerEnvRequirements(recipe, {}),
        profile: 'strict'
    });
}

describe('WebSocket expectation preflight', () => {
    it('accepts absence and close checks when the recipe selects a wait', () => {
        const waitSteps: readonly ApiJsonObject[] = [
            { type: 'ws.wait' },
            { type: 'ws.wait', request: { action: 'send' } },
            { type: 'ws', request: { action: 'wait' } },
            { type: 'ws', action: 'wait' }
        ];
        for (const step of waitSteps) {
            const recipe = { steps: [{ ...step, name: 'observe', expect: { absent: { private: true }, close: {} } }] };
            const report = computeStrictPreflight(recipe);
            expect(report.issues.filter((issue) => issue.code === 'STRICT_EXPECT_IGNORED'), JSON.stringify(step))
                .toEqual([]);
        }
    });

    it('rejects ignored checks when the recipe selects a send', () => {
        const sendSteps: readonly ApiJsonObject[] = [
            { type: 'ws.send' },
            { type: 'ws.send', request: { action: 'wait' } },
            { type: 'ws', request: { action: 'send' } },
            { type: 'ws', action: 'send' },
            { type: 'ws' }
        ];
        for (const step of sendSteps) {
            const recipe = { steps: [{ ...step, name: 'send', expect: { absent: { private: true }, close: {} } }] };
            const report = computeStrictPreflight(recipe);
            expect(report.issues.filter((issue) => issue.code === 'STRICT_EXPECT_IGNORED').map((issue) => issue.path), JSON.stringify(step))
                .toEqual(['steps[0].expect.absent', 'steps[0].expect.close']);
        }
    });
});
