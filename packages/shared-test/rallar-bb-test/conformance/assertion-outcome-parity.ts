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
import {
    ABSENCE_FIXTURES,
    COMPARATOR_FIXTURES,
    COMPLETE_ARRAY_FIXTURES,
    POLLING_FIXTURES,
} from './assertion-outcome-parity-fixtures.ts';
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
