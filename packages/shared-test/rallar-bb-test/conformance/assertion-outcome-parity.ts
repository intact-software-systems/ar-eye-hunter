import type { BlackBoxExecutionDependencies } from '../../black-box-runner/execution/black-box-scenario-context.ts';
import { validateAssertValueComparators } from '../../black-box-runner/expectations/assert-value-comparators.ts';
import { runHttpInteraction } from '../../black-box-runner/http/run-http-interaction.ts';
import { waitForWsMessageAbsence } from '../../black-box-runner/ws/ws-wait-expectations.ts';
import { CompareJson } from '../../json-compare/json-compare.ts';

import { isAssertOperatorSatisfied } from '../assert/assert-value-operators.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRuntime
} from '../rallar-black-box-test-contracts.ts';
import { createRallarBlackBoxTestRuntime } from '../runtime/create-rallar-black-box-test-runtime.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodePayloadPathValue } from '../wait/wait-event-match.ts';
import {
    ABSENCE_FIXTURES,
    COMPARATOR_FIXTURES,
    COMPLETE_ARRAY_FIXTURES,
    POLLING_FIXTURES,
    type AbsenceParityFixture,
    type PollingParityFixture
} from './assertion-outcome-parity-fixtures.ts';

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

export interface RunPollingOutcomeParityInput {
    readonly fetch: (succeedOnAttempt: number | undefined) => typeof fetch;
    readonly now: () => number;
}

interface ToRowInput {
    readonly fixtureId: string;
    readonly family: AssertionOutcomeParityFamily;
    readonly expectedVerdict: AssertionOutcomeVerdict;
    readonly runnerVerdict: AssertionOutcomeVerdict;
    readonly runtimeVerdict: AssertionOutcomeVerdict;
}

const RUNNER_SUCCESS_STATUSES = ['success', 'ok', 'passed'];

export function computeComparatorOutcomeParityRows(): readonly AssertionOutcomeParityRow[] {
    return COMPARATOR_FIXTURES.map((fixture) => {
        const runnerIssues = validateAssertValueComparators(fixture.value, [fixture.runnerComparator]);
        const lookup = decodePayloadPathValue(fixture.value, fixture.runnerComparator.path);
        return toRow({
            fixtureId: fixture.fixtureId,
            family: 'comparators',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict: runnerIssues.length === 0 ? 'pass' : 'fail',
            runtimeVerdict: toVerdict(
                isAssertOperatorSatisfied(lookup, fixture.runtimeOperator, fixture.runtimeExpected)
            )
        });
    });
}

export function computeCompleteArrayOutcomeParityRows(): readonly AssertionOutcomeParityRow[] {
    return COMPLETE_ARRAY_FIXTURES.map((fixture) =>
        toRow({
            fixtureId: fixture.fixtureId,
            family: 'complete-array',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict: toVerdict(CompareJson.compatibleComplete(fixture.expected, fixture.actual).isEqual),
            runtimeVerdict: toVerdict(
                isAssertOperatorSatisfied(
                    { exists: true, value: fixture.actual },
                    'matchesShapeComplete',
                    fixture.expected
                )
            )
        })
    );
}

export async function runAbsenceOutcomeParityRows(
    dependencies: BlackBoxExecutionDependencies
): Promise<readonly AssertionOutcomeParityRow[]> {
    const rows: AssertionOutcomeParityRow[] = [];
    for (const fixture of ABSENCE_FIXTURES) {
        rows.push(toRow({
            fixtureId: fixture.fixtureId,
            family: 'absence',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict: await runAbsenceRunnerVerdict(fixture, dependencies),
            runtimeVerdict: await runAbsenceRuntimeVerdict(fixture)
        }));
    }
    return rows;
}

export async function runPollingOutcomeParityRows(
    input: RunPollingOutcomeParityInput
): Promise<readonly AssertionOutcomeParityRow[]> {
    const rows: AssertionOutcomeParityRow[] = [];
    for (const fixture of POLLING_FIXTURES) {
        const runnerVerdict = await runPollingRunnerVerdict(fixture, input.fetch(fixture.succeedOnAttempt), input.now);
        const runtimeResult = await createDeterministicRuntime().execute(toRuntimePollingCommand(fixture));
        rows.push(toRow({
            fixtureId: fixture.fixtureId,
            family: 'polling',
            expectedVerdict: fixture.expectedVerdict,
            runnerVerdict,
            runtimeVerdict: toVerdict(runtimeResult.ok)
        }));
    }
    return rows;
}

function toRuntimePollingCommand(fixture: PollingParityFixture): RallarBlackBoxTestCommand {
    return {
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
                    : fixture.succeedOnAttempt
            }
        ]
    };
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
            input.runtimeVerdict === input.expectedVerdict
    };
}

function toVerdict(passed: boolean): AssertionOutcomeVerdict {
    return passed ? 'pass' : 'fail';
}

function decodeRunnerVerdict(result: unknown): AssertionOutcomeVerdict {
    const status = isJsonRecordValue(result) && typeof result.status === 'string' ? result.status.toLowerCase() : '';
    return toVerdict(RUNNER_SUCCESS_STATUSES.includes(status));
}

function createDeterministicRuntime(): RallarBlackBoxTestRuntime {
    let now = 1_000;
    let sequence = 1;
    return createRallarBlackBoxTestRuntime({
        now: () => now++,
        idFactory: (prefix: string) => `${prefix}-${sequence++}`,
        sleep: async (ms: number) => {
            now += ms;
        }
    });
}

async function runAbsenceRunnerVerdict(
    fixture: AbsenceParityFixture,
    dependencies: BlackBoxExecutionDependencies
): Promise<AssertionOutcomeVerdict> {
    const result = await waitForWsMessageAbsence({
        interaction: {
            request: { timeoutMs: 5 },
            response: {
                connection: 'parityWs',
                absent: { topic: fixture.forbiddenTopic }
            }
        },
        config: { interaction: { request: {} } },
        context: {
            dependencies,
            wsMessages: {
                parityWs: fixture.bufferedTopics.map((topic) => ({ data: { topic } }))
            }
        }
    });
    return decodeRunnerVerdict(result);
}

async function runAbsenceRuntimeVerdict(fixture: AbsenceParityFixture): Promise<AssertionOutcomeVerdict> {
    const runtime = createDeterministicRuntime();
    for (const topic of fixture.bufferedTopics) {
        runtime.recordEvent({ kind: 'message', topic, payload: { data: { topic } } });
    }
    const result = await runtime.execute({
        kind: 'wait',
        commandId: `parity-${fixture.fixtureId}`,
        absent: true,
        timeoutMs: 5,
        match: { kind: 'message', topic: fixture.forbiddenTopic }
    });
    return toVerdict(result.ok);
}

async function runPollingRunnerVerdict(
    fixture: PollingParityFixture,
    fetch: typeof globalThis.fetch,
    now: () => number
): Promise<AssertionOutcomeVerdict> {
    const result = await runHttpInteraction({
        now,
        fetch,
        interaction: {
            name: fixture.fixtureId,
            connection: 'api',
            request: {
                url: 'http://parity.invalid/status',
                method: 'GET',
                action: 'poll-until',
                poll: { maxAttempts: fixture.maxAttempts, maxDurationMs: 5_000, backoffMs: 1, backoffMultiplier: 1 }
            },
            response: { status: 200 }
        },
        config: { interaction: { request: {} } }
    });
    return decodeRunnerVerdict(result);
}
