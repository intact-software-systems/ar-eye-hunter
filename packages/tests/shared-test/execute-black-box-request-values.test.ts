import { describe, expect, it } from 'vitest';

import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

describe('black-box request values', () => {
    it('resolves a reused recipe from each run without changing its request or response', async () => {
        const interactions = [{
            SET: {
                request: { output: 'label', value: '{label}', interactionExecutionNumber: 1 },
                response: {}
            },
            resolveLabel: {}
        }];
        const original = structuredClone(interactions);

        const first = await executeBlackBox(interactions, 0, {
            variables: { label: 'first' },
            runnerRunId: 'first-run'
        });
        const second = await executeBlackBox(interactions, 0, {
            variables: { label: 'second' },
            runnerRunId: 'second-run'
        });

        expect(first.outputs.label).toBe('first');
        expect(second.outputs.label).toBe('second');
        expect(first.resultsByName.resolveLabel[0].runnerRunId).toBe('first-run');
        expect(second.resultsByName.resolveLabel[0].runnerRunId).toBe('second-run');
        expect(interactions).toEqual(original);
    });

    it('computes payload correlation on frozen input and retains caller metadata', async () => {
        const message = Object.freeze({
            topic: 'identity',
            blackBoxRunner: Object.freeze({ applicationTag: 'retain' })
        });
        const interactions = [{
            RTC: Object.freeze({
                request: Object.freeze({
                    action: 'send',
                    provider: 'rallar-stub',
                    connection: 'alice',
                    interactionExecutionNumber: 1,
                    send: message
                }),
                response: Object.freeze({})
            }),
            sendIdentity: {}
        }];

        const report = await executeBlackBox(interactions, 0, {
            dryRun: true,
            correlation: { runnerRunId: 'frozen-run', injectPayloads: true }
        });

        expect(report.summary.failure).toBe(0);
        const result = report.resultsByName.sendIdentity[0];
        expect(result.actual.sent.blackBoxRunner).toEqual({
            applicationTag: 'retain',
            runnerRunId: 'frozen-run',
            runnerStepId: result.runnerStepId
        });
        expect(result.correlation.injected.payload).toBe(true);
        expect(message.blackBoxRunner).toEqual({ applicationTag: 'retain' });
    });

    it('applies a resolved duration limit while leaving the recipe limit unchanged', async () => {
        const interactions = [{
            SET: {
                request: { output: 'saved', value: 'complete', delayMs: 20, interactionExecutionNumber: 1 },
                response: { maxDurationMs: '{limit}' }
            },
            boundedStep: {}
        }];

        const report = await executeBlackBox(interactions, 0, { variables: { limit: 1 } });

        const result = report.resultsByName.boundedStep[0];
        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('Step duration exceeded expect.maxDurationMs');
        expect(result.maxDurationMs).toBe(1);
        expect(result.actual).toBe('complete');
        expect(interactions[0].SET.response.maxDurationMs).toBe('{limit}');
    });
});
