import {describe, expect, it} from 'vitest';
import {executeBlackBox} from '../../shared-test/black-box-runner/execute-black-box.ts';

function assertStep(input: {
    actual: unknown;
    expectFields: Record<string, unknown>;
    name?: string;
}): Record<string, unknown> {
    return {
        ASSERT: {
            request: {
                actual: input.actual,
                scenarioExecutionNumber: 1,
                interactionExecutionNumber: 1,
            },
            response: input.expectFields,
        },
        [input.name ?? 'assertWithComparators']: {},
    };
}

describe('executeBlackBox ASSERT expect.comparators', () => {
    it('passes when every comparator on the resolved actual holds', async () => {
        const report = await executeBlackBox(
            [assertStep({
                actual: {
                    stats: { memberCount: 5, onlineMemberCount: 3 },
                    activeSessions: [{ sessionId: 'session-1' }],
                    sessionId: 'session-abc-123',
                },
                expectFields: {
                    comparators: [
                        { path: 'stats.memberCount', gt: 1, lte: 5 },
                        { path: 'stats.onlineMemberCount', between: [1, 5] },
                        { path: 'activeSessions', length: 1 },
                        { path: 'sessionId', contains: 'session-' },
                        { path: 'sessionId', matches: '^session-[a-z]+-[0-9]+$' },
                    ],
                },
            })],
            0,
            { failFast: true },
        );

        expect(report.summary.failure).toBe(0);
        const result = report.resultsByName.assertWithComparators[0];
        expect(result.status).toBe('SUCCESS');
    });

    it('collects every failing comparator instead of stopping at the first', async () => {
        const report = await executeBlackBox(
            [assertStep({
                actual: {
                    stats: { memberCount: 0 },
                    activeSessions: [{ sessionId: 'a' }, { sessionId: 'b' }],
                },
                expectFields: {
                    comparators: [
                        { path: 'stats.memberCount', gte: 1 },
                        { path: 'activeSessions', length: 1 },
                        { path: 'stats.missing', gt: 0 },
                    ],
                },
            })],
            0,
            { failFast: true },
        );

        expect(report.summary.failure).toBe(1);
        const result = report.resultsByName.assertWithComparators[0];
        expect(result.status).toBe('FAILURE');
        expect(result.result).toBe('Assert comparator failed');
        expect(result.details.failures).toHaveLength(3);
        const comparatorNames = result.details.failures.map(
            (failure: { comparator: string }) => failure.comparator,
        );
        expect(comparatorNames).toEqual(['gte', 'length', 'path']);
    });

    it('combines comparators with a body comparison and placeholder bounds', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'floorRevision',
                            value: 3,
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setFloorRevision: {},
                },
                {
                    ASSERT: {
                        request: {
                            actual: { revision: 7, kind: 'group-state' },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            body: { kind: 'group-state' },
                            comparators: [
                                { path: 'revision', gte: '{floorRevision}' },
                            ],
                        },
                    },
                    assertBodyAndComparators: {},
                },
            ],
            0,
            { failFast: true },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.assertBodyAndComparators[0].status).toBe('SUCCESS');
    });

    it('fails an entry without any known comparator key', async () => {
        const report = await executeBlackBox(
            [assertStep({
                actual: { value: 1 },
                expectFields: {
                    comparators: [{ path: 'value' }],
                },
            })],
            0,
            { failFast: true },
        );

        expect(report.summary.failure).toBe(1);
        const failure = report.resultsByName.assertWithComparators[0].details.failures[0];
        expect(failure.comparator).toBe('none');
    });

    it('supports compatible-complete comparison from ASSERT expects', async () => {
        const report = await executeBlackBox(
            [assertStep({
                actual: {
                    members: [
                        { principalId: 'client-1', status: 'active' },
                        { principalId: 'intruder', status: 'active' },
                    ],
                },
                expectFields: {
                    comparison: 'compatible-complete',
                    body: {
                        members: [
                            { principalId: 'client-1', status: 'active' },
                        ],
                    },
                },
            })],
            0,
            { failFast: true },
        );

        expect(report.summary.failure).toBe(1);
        const result = report.resultsByName.assertWithComparators[0];
        expect(result.details.message).toBe('Json array has unexpected elements');
    });
});
