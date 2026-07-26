import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

describe('executeBlackBox synchronous step failures', () => {
    it('records a missing assert placeholder and continues when fail-fast is disabled', async () => {
        const report = await executeBlackBox([
            {
                SET: {
                    request: {
                        output: 'beforeFailure',
                        value: 'observed',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1,
                    },
                    response: {},
                },
                setBeforeFailure: {},
            },
            {
                ASSERT: {
                    request: {
                        actual: '{missingAssertValue}',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 2,
                    },
                    response: {
                        body: 'expected',
                    },
                },
                assertMissingPlaceholder: {},
            },
            {
                SET: {
                    request: {
                        output: 'afterFailure',
                        value: 'continued',
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 3,
                    },
                    response: {},
                },
                setAfterFailure: {},
            },
        ], 0, {
            failFast: false,
        });

        expect(report.summary).toMatchObject({
            total: 3,
            success: 2,
            failure: 1,
        });
        expect(report.resultsByName.assertMissingPlaceholder[0]).toMatchObject({
            status: 'FAILURE',
            exception: 'Cannot resolve placeholder {missingAssertValue}',
            interactionExecutionNumber: 2,
        });
        expect(report.resultsByName.setAfterFailure[0].status).toBe('SUCCESS');
        expect(report.outputs.afterFailure).toBe('continued');
    });
});
