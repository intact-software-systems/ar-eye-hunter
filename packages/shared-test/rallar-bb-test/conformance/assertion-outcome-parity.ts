// deno-lint-ignore-file no-explicit-any
import { CompareJson } from '../../json-compare/json-compare.ts';
import type { JsonValue } from '../../json-compare/CompareJson.ts';
import {
    validateAssertValueComparators,
} from '../../black-box-runner/expectations/assert-value-comparators.ts';
import {
    waitForWsMessageAbsence,
} from '../../black-box-runner/ws/ws-wait-expectations.ts';
import {
    executeHttpInteraction,
} from '../../black-box-runner/http/execute-http-interaction.ts';

import { assertValueMatches } from '../assert/assert-value-operators.ts';
import { createRallarBlackBoxTestRuntime } from '../runtime.ts';
import type {
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestCommand,
} from '../types.ts';

export type AssertionOutcomeParityFamily =
    | 'comparators'
    | 'complete-array'
    | 'absence'
    | 'polling';

export type AssertionOutcomeVerdict = 'pass' | 'fail';

export interface AssertionOutcomeParityRow {
    readonly fixtureId: string;
    readonly family: AssertionOutcomeParityFamily;
    readonly expectedVerdict: AssertionOutcomeVerdict;
    readonly runnerVerdict: AssertionOutcomeVerdict;
    readonly runtimeVerdict: AssertionOutcomeVerdict;
    readonly agree: boolean;
    readonly matchesExpected: boolean;
}

interface ComparatorParityFixture {
    readonly fixtureId: string;
    readonly value: any;
    readonly runnerComparator: Readonly<Record<string, any>> & Readonly<{ path: string }>;
    readonly runtimeOperator: RallarBlackBoxTestAssertOperator;
    readonly runtimeExpected: any;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

const COMPARATOR_FIXTURES: readonly ComparatorParityFixture[] = [
    {
        fixtureId: 'gt-string-number-passes',
        value: { score: '17' },
        runnerComparator: { path: 'score', gt: 16 },
        runtimeOperator: 'gt',
        runtimeExpected: 16,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'gt-equal-fails',
        value: { score: 17 },
        runnerComparator: { path: 'score', gt: 17 },
        runtimeOperator: 'gt',
        runtimeExpected: 17,
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'lt-passes',
        value: { score: 3 },
        runnerComparator: { path: 'score', lt: 4 },
        runtimeOperator: 'lt',
        runtimeExpected: 4,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'between-inclusive-bound-passes',
        value: { score: 20 },
        runnerComparator: { path: 'score', between: [17, 20] },
        runtimeOperator: 'between',
        runtimeExpected: [17, 20],
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'between-outside-fails',
        value: { score: 21 },
        runnerComparator: { path: 'score', between: [17, 20] },
        runtimeOperator: 'between',
        runtimeExpected: [17, 20],
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'between-malformed-pair-fails',
        value: { score: 18 },
        runnerComparator: { path: 'score', between: [17] },
        runtimeOperator: 'between',
        runtimeExpected: [17],
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'length-array-passes',
        value: { items: ['a', 'b', 'c'] },
        runnerComparator: { path: 'items', length: 3 },
        runtimeOperator: 'length',
        runtimeExpected: 3,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'length-non-collection-fails',
        value: { items: 42 },
        runnerComparator: { path: 'items', length: 2 },
        runtimeOperator: 'length',
        runtimeExpected: 2,
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'matches-pattern-passes',
        value: { marker: 'assert-operators' },
        runnerComparator: { path: 'marker', matches: '^assert-' },
        runtimeOperator: 'matches',
        runtimeExpected: '^assert-',
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'matches-non-string-fails',
        value: { marker: 42 },
        runnerComparator: { path: 'marker', matches: '^assert-' },
        runtimeOperator: 'matches',
        runtimeExpected: '^assert-',
        expectedVerdict: 'fail',
    },
];

// Each dialect evaluates the same evidence value: the runner through its
// expect.comparators validator, the runtime through the extended assert
// operators. Divergent verdicts fail the parity suite by contract.
export function evaluateComparatorOutcomeParityRows(): readonly AssertionOutcomeParityRow[] {
    return COMPARATOR_FIXTURES.map(fixture => {
        const runnerIssues = validateAssertValueComparators(fixture.value, [
            fixture.runnerComparator,
        ]);
        const runnerVerdict: AssertionOutcomeVerdict = runnerIssues.length === 0 ? 'pass' : 'fail';
        const path = fixture.runnerComparator.path;
        const record = fixture.value as Record<string, any>;
        const lookup = {
            exists: Object.prototype.hasOwnProperty.call(record, path),
            value: record[path],
        };
        const runtimeVerdict: AssertionOutcomeVerdict = assertValueMatches(
            lookup,
            fixture.runtimeOperator,
            fixture.runtimeExpected,
        )
            ? 'pass'
            : 'fail';
        return toRow({
            fixtureId: fixture.fixtureId,
            family: 'comparators',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict,
            runtimeVerdict,
        });
    });
}

interface CompleteArrayParityFixture {
    readonly fixtureId: string;
    readonly expected: JsonValue;
    readonly actual: JsonValue;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

const COMPLETE_ARRAY_FIXTURES: readonly CompleteArrayParityFixture[] = [
    {
        fixtureId: 'complete-exact-array-passes',
        expected: { items: ['expected-item'] },
        actual: { items: ['expected-item'] },
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'complete-unexpected-element-fails',
        expected: { items: ['expected-item'] },
        actual: { items: ['expected-item', 'unexpected-item'] },
        expectedVerdict: 'fail',
    },
    {
        fixtureId: 'complete-extra-object-key-passes',
        expected: { items: ['expected-item'] },
        actual: { items: ['expected-item'], extra: 'allowed' },
        expectedVerdict: 'pass',
    },
];

export function evaluateCompleteArrayOutcomeParityRows(): readonly AssertionOutcomeParityRow[] {
    return COMPLETE_ARRAY_FIXTURES.map(fixture => {
        const runnerVerdict: AssertionOutcomeVerdict =
            CompareJson.compatibleComplete(fixture.expected, fixture.actual).isEqual
                ? 'pass'
                : 'fail';
        const runtimeVerdict: AssertionOutcomeVerdict = assertValueMatches(
            { exists: true, value: fixture.actual },
            'matchesShapeComplete',
            fixture.expected,
        )
            ? 'pass'
            : 'fail';
        return toRow({
            fixtureId: fixture.fixtureId,
            family: 'complete-array',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict,
            runtimeVerdict,
        });
    });
}

interface AbsenceParityFixture {
    readonly fixtureId: string;
    readonly bufferedTopics: readonly string[];
    readonly forbiddenTopic: string;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

const ABSENCE_FIXTURES: readonly AbsenceParityFixture[] = [
    {
        fixtureId: 'absence-holds-on-clean-buffer',
        bufferedTopics: ['room.allowed.control'],
        forbiddenTopic: 'room.forbidden.leak',
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'absence-violated-by-buffered-event',
        bufferedTopics: ['room.allowed.control', 'room.forbidden.leak'],
        forbiddenTopic: 'room.forbidden.leak',
        expectedVerdict: 'fail',
    },
];

// Both dialects hold the full window, then scan the whole buffer once, so a
// frame buffered before the wait started violates the claim in both engines.
export async function evaluateAbsenceOutcomeParityRows(): Promise<
    readonly AssertionOutcomeParityRow[]
> {
    const rows: AssertionOutcomeParityRow[] = [];
    for (const fixture of ABSENCE_FIXTURES) {
        const runnerStatus = await waitForWsMessageAbsence({
            interaction: {
                request: { timeoutMs: 5 },
                response: {
                    connection: 'parityWs',
                    absent: { topic: fixture.forbiddenTopic },
                },
            },
            config: { interaction: { request: {} } },
            context: {
                wsMessages: {
                    parityWs: fixture.bufferedTopics.map(topic => ({ data: { topic } })),
                },
            },
        });
        const runnerVerdict: AssertionOutcomeVerdict = isRunnerSuccess(runnerStatus)
            ? 'pass'
            : 'fail';

        const runtime = createDeterministicRuntime();
        for (const topic of fixture.bufferedTopics) {
            runtime.recordEvent({
                kind: 'message',
                topic,
                payload: { data: { topic } },
            });
        }
        const runtimeResult = await runtime.execute({
            kind: 'wait',
            commandId: `parity-${fixture.fixtureId}`,
            absent: true,
            timeoutMs: 5,
            match: {
                kind: 'message',
                topic: fixture.forbiddenTopic,
            },
        });
        const runtimeVerdict: AssertionOutcomeVerdict = runtimeResult.ok ? 'pass' : 'fail';
        rows.push(toRow({
            fixtureId: fixture.fixtureId,
            family: 'absence',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict,
            runtimeVerdict,
        }));
    }
    return rows;
}

interface PollingParityFixture {
    readonly fixtureId: string;
    readonly succeedOnAttempt: number | undefined;
    readonly maxAttempts: number;
    readonly expectedVerdict: AssertionOutcomeVerdict;
}

const POLLING_FIXTURES: readonly PollingParityFixture[] = [
    {
        fixtureId: 'polling-converges-before-bounds',
        succeedOnAttempt: 3,
        maxAttempts: 5,
        expectedVerdict: 'pass',
    },
    {
        fixtureId: 'polling-exhausts-bounds',
        succeedOnAttempt: undefined,
        maxAttempts: 3,
        expectedVerdict: 'fail',
    },
];

export interface EvaluatePollingOutcomeParityInput {
    readonly fetch: (succeedOnAttempt: number | undefined) => typeof fetch;
}

// The runner polls a real fetch signature (injected here so no network is
// needed); the runtime polls its own recorded evidence through an until loop.
// Success is the attempt expectation passing; exhaustion is a failure.
export async function evaluatePollingOutcomeParityRows(
    input: EvaluatePollingOutcomeParityInput,
): Promise<readonly AssertionOutcomeParityRow[]> {
    const rows: AssertionOutcomeParityRow[] = [];
    for (const fixture of POLLING_FIXTURES) {
        const previousFetch = globalThis.fetch;
        globalThis.fetch = input.fetch(fixture.succeedOnAttempt);
        let runnerStatus: any;
        try {
            runnerStatus = await executeHttpInteraction({
                name: fixture.fixtureId,
                connection: 'api',
                request: {
                    url: 'http://parity.invalid/status',
                    method: 'GET',
                    action: 'poll-until',
                    poll: {
                        maxAttempts: fixture.maxAttempts,
                        maxDurationMs: 5_000,
                        backoffMs: 1,
                        backoffMultiplier: 1,
                    },
                },
                response: {
                    status: 200,
                },
            }, { interaction: { request: {} } });
        } finally {
            globalThis.fetch = previousFetch;
        }
        const runnerVerdict: AssertionOutcomeVerdict = isRunnerSuccess(runnerStatus)
            ? 'pass'
            : 'fail';

        const runtime = createDeterministicRuntime();
        const runtimeResult = await runtime.execute({
            kind: 'loop',
            commandId: `parity-${fixture.fixtureId}`,
            until: 'first-success',
            count: fixture.maxAttempts,
            intervalMs: 1,
            commands: [
                {
                    kind: 'assert',
                    commandId: `parity-${fixture.fixtureId}-converged`,
                    source: 'state.commandHistory.length',
                    operator: 'gte',
                    expected: fixture.succeedOnAttempt === undefined
                        ? Number.MAX_SAFE_INTEGER
                        : fixture.succeedOnAttempt,
                },
            ] satisfies readonly RallarBlackBoxTestCommand[],
        });
        const runtimeVerdict: AssertionOutcomeVerdict = runtimeResult.ok ? 'pass' : 'fail';
        rows.push(toRow({
            fixtureId: fixture.fixtureId,
            family: 'polling',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict,
            runtimeVerdict,
        }));
    }
    return rows;
}

interface ToRowInput {
    readonly fixtureId: string;
    readonly family: AssertionOutcomeParityFamily;
    readonly expectedVerdict: AssertionOutcomeVerdict;
    readonly runnerVerdict: AssertionOutcomeVerdict;
    readonly runtimeVerdict: AssertionOutcomeVerdict;
}

function toRow(input: ToRowInput): AssertionOutcomeParityRow {
    return {
        fixtureId: input.fixtureId,
        family: input.family,
        expectedVerdict: input.expectedVerdict,
        runnerVerdict: input.runnerVerdict,
        runtimeVerdict: input.runtimeVerdict,
        agree: input.runnerVerdict === input.runtimeVerdict,
        matchesExpected: input.runnerVerdict === input.expectedVerdict &&
            input.runtimeVerdict === input.expectedVerdict,
    };
}

function isRunnerSuccess(status: any): boolean {
    const text = String(status?.status ?? '').toLowerCase();
    return text === 'success' || text === 'ok' || text === 'passed';
}

function createDeterministicRuntime() {
    let now = 1_000;
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix: string) => `${prefix}-${sequence++}`,
        sleep: async (ms: number) => {
            now += ms;
        },
    });
}
