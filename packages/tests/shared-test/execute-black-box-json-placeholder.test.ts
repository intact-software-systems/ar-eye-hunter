import { describe, expect, it } from 'vitest';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

describe('executeBlackBox JSON string placeholders', () => {
    it('preserves a resolved serialized JSON object', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'payload',
                            value: '{"text":"hello","groupId":"group-1"}',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1
                        },
                        response: {}
                    },
                    renderPayload: {}
                }
            ],
            0,
            {
                failFast: true,
                variables: {}
            }
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.payload).toBe(
            '{"text":"hello","groupId":"group-1"}'
        );
    });
});
