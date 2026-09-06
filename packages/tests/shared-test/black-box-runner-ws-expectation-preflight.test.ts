import { describe, expect, it } from 'vitest';

import { explainBlackBoxRunnerPlan } from '@shared-test/black-box-runner/preflight/plan-preflight.ts';

describe('WebSocket expectation preflight', () => {
    it('accepts absence and close checks when the recipe selects a wait', () => {
        for (
            const step of [
                { type: 'ws.wait' },
                { type: 'ws.wait', request: { action: 'send' } },
                { type: 'ws', request: { action: 'wait' } },
                { type: 'ws', action: 'wait' }
            ]
        ) {
            const recipe = { steps: [{ ...step, name: 'observe', expect: { absent: { private: true }, close: {} } }] };
            const report = explainBlackBoxRunnerPlan({ rawConfig: recipe, profile: 'strict' });
            expect(report.issues.filter((issue) => issue.code === 'STRICT_EXPECT_IGNORED'), JSON.stringify(step))
                .toEqual([]);
        }
    });

    it('rejects ignored checks when the recipe selects a send', () => {
        for (
            const step of [
                { type: 'ws.send' },
                { type: 'ws.send', request: { action: 'wait' } },
                { type: 'ws', request: { action: 'send' } },
                { type: 'ws', action: 'send' },
                { type: 'ws' }
            ]
        ) {
            const recipe = { steps: [{ ...step, name: 'send', expect: { absent: { private: true }, close: {} } }] };
            const report = explainBlackBoxRunnerPlan({ rawConfig: recipe, profile: 'strict' });
            expect(report.issues.filter((issue) => issue.code === 'STRICT_EXPECT_IGNORED').map((issue) => issue.path), JSON.stringify(step))
                .toEqual(['steps[0].expect.absent', 'steps[0].expect.close']);
        }
    });
});
