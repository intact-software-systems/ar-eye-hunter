import { describe, expect, it } from 'vitest';

import type { ApiJsonObject, ApiJsonValue } from '@shared/api/api-json-value.ts';
import { executeBlackBox } from '../../shared-test/black-box-runner/execute-black-box.ts';

function assertGroup(name: string, actual: ApiJsonValue, expected: ApiJsonValue): ApiJsonObject {
    return {
        name,
        steps: [{
            ASSERT: {
                request: { actual, scenarioExecutionNumber: 1, interactionExecutionNumber: 1 },
                response: { body: expected }
            },
            [`${name}Step`]: {}
        }]
    };
}

function parallelStep(input: {
    groups: readonly ApiJsonObject[];
    expectFields?: ApiJsonObject;
}): ApiJsonObject {
    return {
        PARALLEL: {
            request: {
                groups: input.groups,
                maxConcurrency: 2,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 1
            },
            ...(input.expectFields === undefined ? {} : { response: input.expectFields })
        },
        raceOutcome: {}
    };
}

describe('executeBlackBox PARALLEL expect', () => {
    it('passes a parallel step whose aggregate matches the expectation', async () => {
        const report = await executeBlackBox(
            [parallelStep({
                groups: [assertGroup('alpha', 1, 1), assertGroup('beta', 2, 2)],
                expectFields: { body: { groupCount: 2, failure: 0, success: 2 } }
            })],
            0,
            { failFast: true }
        );

        expect(report.summary.failure).toBe(0);
    });

    // The defect this closes: the executor built a rich `actual` and never
    // compared it, so an expectation on a parallel step was a silent no-op and
    // a recipe could assert something plainly false and still pass.
    it('fails a parallel step whose aggregate contradicts the expectation', async () => {
        const report = await executeBlackBox(
            [parallelStep({
                groups: [assertGroup('alpha', 1, 1), assertGroup('beta', 2, 2)],
                expectFields: { body: { groupCount: 99 } }
            })],
            0,
            { failFast: false }
        );

        expect(report.summary.failure).toBe(1);
    });

    it('supports comparators over the aggregate, so a bounded outcome is expressible', async () => {
        const report = await executeBlackBox(
            [parallelStep({
                groups: [assertGroup('alpha', 1, 1), assertGroup('beta', 2, 2)],
                expectFields: { comparators: [{ path: 'success', lte: 2 }, { path: 'failure', equals: 0 }] }
            })],
            0,
            { failFast: true }
        );

        expect(report.summary.failure).toBe(0);
    });

    it('fails when a comparator over the aggregate does not hold', async () => {
        const report = await executeBlackBox(
            [parallelStep({
                groups: [assertGroup('alpha', 1, 1), assertGroup('beta', 2, 2)],
                expectFields: { comparators: [{ path: 'success', lt: 1 }] }
            })],
            0,
            { failFast: false }
        );

        expect(report.summary.failure).toBe(1);
    });

    it('leaves a parallel step without an expectation unchanged', async () => {
        const report = await executeBlackBox(
            [parallelStep({ groups: [assertGroup('alpha', 1, 1)] })],
            0,
            { failFast: true }
        );

        expect(report.summary.failure).toBe(0);
    });

    // A child failure must still fail the parent, and must not be masked by a
    // passing aggregate expectation.
    it('keeps a failing child failing even when the expectation holds', async () => {
        const report = await executeBlackBox(
            [parallelStep({
                groups: [assertGroup('alpha', 1, 2)],
                expectFields: { body: { groupCount: 1 } }
            })],
            0,
            { failFast: false }
        );

        expect(report.summary.failure).toBeGreaterThan(0);
    });
});

describe('executeBlackBox PARALLEL barrier', () => {
    // Without a barrier the pool starts workers as slots free, so the first
    // group can finish before the last one starts — a recipe claiming to test
    // contention would be asserting a timing coincidence.
    it('reports the barrier on the aggregate and runs every group', async () => {
        const report: any = await executeBlackBox(
            [{
                PARALLEL: {
                    request: {
                        groups: [assertGroup('alpha', 1, 1), assertGroup('beta', 2, 2), assertGroup('gamma', 3, 3)],
                        barrier: true,
                        maxConcurrency: 1,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: { body: { barrier: true, groupCount: 3, failure: 0 } }
                },
                racedGroups: {}
            }],
            0,
            { failFast: true }
        );

        expect(report.summary.failure).toBe(0);
    });

    it('overrides a narrower concurrency rather than deadlocking against it', async () => {
        const report: any = await executeBlackBox(
            [{
                PARALLEL: {
                    request: {
                        groups: [assertGroup('alpha', 1, 1), assertGroup('beta', 2, 2)],
                        barrier: true,
                        maxConcurrency: 1,
                        scenarioExecutionNumber: 1,
                        interactionExecutionNumber: 1
                    },
                    response: { comparators: [{ path: 'maxConcurrency', equals: 2 }] }
                },
                racedUnderNarrowConcurrency: {}
            }],
            0,
            { failFast: true }
        );

        expect(report.summary.failure).toBe(0);
    });
});
