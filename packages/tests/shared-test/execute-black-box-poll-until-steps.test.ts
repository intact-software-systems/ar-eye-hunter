import { describe, expect, it } from 'vitest';

import type { ApiJsonObject } from '@shared/api/api-json-value.ts';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

function assertStepWithPoll(poll: ApiJsonObject | undefined): ApiJsonObject {
    return {
        ASSERT: {
            request: {
                actual: { converged: false },
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 1,
                ...(poll === undefined ? {} : { poll })
            },
            response: { body: { converged: true } }
        },
        waitForConvergence: {}
    };
}

describe('executeBlackBox poll-until on non-HTTP steps', () => {
    // Before this, `assert` had no retry loop at all, so a recipe waiting on a
    // value had to sleep for a fixed period and hope.
    it('retries a failing assert step for the declared bound', async () => {
        const report: any = await executeBlackBox(
            [assertStepWithPoll({ maxAttempts: 3, backoffMs: 1, backoffMultiplier: 1 })],
            0,
            { failFast: false }
        );

        expect(report.summary.failure).toBe(1);
        expect(report.resultsList[0].pollAttempts).toBe(3);
        expect(report.resultsList[0].pollExhausted).toBe(true);
    });

    it('runs an assert step once when it declares no poll', async () => {
        const report: any = await executeBlackBox([assertStepWithPoll(undefined)], 0, { failFast: false });

        expect(report.summary.failure).toBe(1);
        expect(report.resultsList[0].pollAttempts).toBeUndefined();
    });

    it('reports the attempt count when the condition converges', async () => {
        const report: any = await executeBlackBox(
            [{
                ASSERT: {
                    request: {
                        actual: { converged: true },
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1,
                        poll: { maxAttempts: 5, backoffMs: 1 }
                    },
                    response: { body: { converged: true } }
                },
                alreadyConverged: {}
            }],
            0,
            { failFast: true }
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsList[0].pollAttempts).toBe(1);
        expect(report.resultsList[0].pollExhausted).toBe(false);
    });
});
