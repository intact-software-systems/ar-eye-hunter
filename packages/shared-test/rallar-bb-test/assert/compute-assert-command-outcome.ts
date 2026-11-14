import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestAssertOperator,
    RallarBlackBoxTestAssertResultValue,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStatsSnapshot
} from '../rallar-black-box-test-contracts.ts';
import { toEventHistoryUnavailableOutcome } from '../runtime/event-history.ts';
import { decodePayloadPathValue, isSameJsonValue, type PayloadPathLookup } from '../wait/wait-event-match.ts';
import { areSameUniqueStringSet } from './are-same-unique-string-set.ts';
import {
    isAssertOperatorSatisfied,
    isRallarBlackBoxAssertOperator,
    RALLAR_BLACK_BOX_COMMAND_ASSERT_OPERATORS
} from './assert-value-operators.ts';
import { isAssertComparison } from './is-assert-comparison.ts';

export interface AssertCommandEvidence {
    readonly command: RallarBlackBoxTestAssertCommand & Readonly<{ commandId: string; }>;
    readonly state: RallarBlackBoxTestState;
    readonly config: RallarBlackBoxTestConfig | undefined;
}

interface AssertSourceRoots {
    readonly state: RallarBlackBoxTestState & AssertEventViews;
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly currentConfig: RallarBlackBoxTestConfig | undefined;
    readonly lastResult: RallarBlackBoxTestResult | undefined;
    readonly events: readonly RallarBlackBoxTestEvent[];
    readonly messages: readonly RallarBlackBoxTestEvent[];
    readonly diagnostics: readonly RallarBlackBoxTestEvent[];
    readonly reports: readonly RallarBlackBoxTestEvent[];
    readonly recentEvents: readonly RallarBlackBoxTestEvent[];
    readonly recentMessages: readonly RallarBlackBoxTestEvent[];
    readonly recentDiagnostics: readonly RallarBlackBoxTestEvent[];
    readonly latestStats: RallarBlackBoxTestStatsSnapshot | undefined;
    readonly stats: RallarBlackBoxTestStatsSnapshot | undefined;
    readonly failures: readonly RallarBlackBoxTestResult[];
    readonly resultCache: RallarBlackBoxTestState['resultCache'];
}

interface AssertEventViews {
    readonly results: readonly RallarBlackBoxTestResult[];
    readonly messages: readonly RallarBlackBoxTestEvent[];
    readonly diagnostics: readonly RallarBlackBoxTestEvent[];
    readonly reports: readonly RallarBlackBoxTestEvent[];
}

interface ToAssertResultValueInput {
    readonly command: AssertCommandEvidence['command'];
    readonly source: PayloadPathLookup;
    readonly comparison: PayloadPathLookup | undefined;
    readonly passed: boolean;
}

const RECENT_ASSERT_SOURCE_LIMIT = 20;

export function computeAssertCommandOutcome(evidence: AssertCommandEvidence): RallarBlackBoxTestCommandOutcome {
    const { command, state } = evidence;
    if (typeof command.source !== 'string' || command.source.trim().length === 0) {
        return toInvalidAssertOutcome(command, 'Assert requires a non-empty source.', undefined);
    }
    if (!isRallarBlackBoxAssertOperator(command.operator)) {
        return toInvalidAssertOutcome(command, 'Assert operator is not supported.', {
            operator: command.operator,
            supportedOperators: RALLAR_BLACK_BOX_COMMAND_ASSERT_OPERATORS
        });
    }

    const comparisonSource = toComparisonSource(command);
    if (comparisonSource.kind === 'invalid') {
        return toInvalidAssertOutcome(command, comparisonSource.message, undefined);
    }
    if (
        !isAssertHistoryCovered(command.source, state) ||
        (comparisonSource.kind === 'present' && !isAssertHistoryCovered(comparisonSource.path, state))
    ) {
        return toEventHistoryUnavailableOutcome(state.eventHistory);
    }
    const roots = toAssertSourceRoots(evidence);
    const source = resolveAssertSource(command.source, roots);
    const comparison = comparisonSource.kind === 'present'
        ? resolveAssertSource(comparisonSource.path, roots)
        : undefined;
    const passed = comparison === undefined
        ? isAssertOperatorSatisfied(source, command.operator, command.expected)
        : source.exists && comparison.exists && isComparisonSatisfied(command.operator, source.value, comparison.value);
    const value = toAssertResultValue({ command, source, comparison, passed });
    return passed
        ? { status: 'ok', value, nextStatus: state.status }
        : {
            status: 'failed',
            value,
            error: {
                code: 'RALLAR_BLACK_BOX_ASSERT_FAILED',
                message: `Assert failed for ${command.source}.`,
                details: value
            },
            nextStatus: 'failed'
        };
}

type ComparisonSource =
    | Readonly<{ kind: 'absent'; }>
    | Readonly<{ kind: 'invalid'; message: string; }>
    | Readonly<{ kind: 'present'; path: string; }>;

function toComparisonSource(command: AssertCommandEvidence['command']): ComparisonSource {
    if (!isAssertComparison(command)) {
        return command.comparisonSource === undefined
            ? { kind: 'absent' }
            : { kind: 'invalid', message: 'A comparisonSource is unsupported for this operator.' };
    }
    if (typeof command.comparisonSource !== 'string' || command.comparisonSource.trim().length === 0) {
        return { kind: 'invalid', message: 'A comparison requires a non-empty comparisonSource.' };
    }
    return command.expected === undefined
        ? { kind: 'present', path: command.comparisonSource }
        : { kind: 'invalid', message: 'A comparison does not take an expected value.' };
}

function isComparisonSatisfied(
    operator: RallarBlackBoxTestAssertOperator,
    actual: ApiJsonValue,
    comparisonActual: ApiJsonValue
): boolean {
    return operator === 'sameUniqueStringSet'
        ? areSameUniqueStringSet(actual, comparisonActual)
        : isSameJsonValue(actual, comparisonActual);
}

function resolveAssertSource(source: string, roots: AssertSourceRoots): PayloadPathLookup {
    const [rootName, ...pathParts] = source.trim().split('.').filter((part) => part.length > 0);
    if (!rootName || !Object.hasOwn(roots, rootName)) {
        return { exists: false };
    }
    const root = roots[rootName as keyof AssertSourceRoots];
    return decodePayloadPathValue(root, pathParts.join('.'));
}

export function toAssertSourceRoots(evidence: Pick<AssertCommandEvidence, 'state' | 'config'>): AssertSourceRoots {
    const { state, config } = evidence;
    const events = state.events;
    const messages = events.filter((event) => event.kind === 'message');
    const diagnostics = events.filter((event) => event.kind === 'diagnostic');
    const reports = events.filter((event) => event.kind === 'report');
    const results = state.commandHistory;
    return {
        state: { ...state, results, messages, diagnostics, reports },
        config,
        currentConfig: config,
        lastResult: results.at(-1),
        events,
        messages,
        diagnostics,
        reports,
        recentEvents: events.slice(-RECENT_ASSERT_SOURCE_LIMIT),
        recentMessages: messages.slice(-RECENT_ASSERT_SOURCE_LIMIT),
        recentDiagnostics: diagnostics.slice(-RECENT_ASSERT_SOURCE_LIMIT),
        latestStats: state.latestStats,
        stats: state.latestStats,
        failures: state.failures,
        resultCache: state.resultCache
    };
}

function toAssertResultValue(input: ToAssertResultValueInput): RallarBlackBoxTestAssertResultValue {
    const { command, source, comparison, passed } = input;
    if (isAssertComparison(command)) {
        return {
            operator: command.operator,
            actual: source.exists ? source.value : undefined,
            comparisonActual: comparison?.exists ? comparison.value : undefined,
            exists: source.exists,
            comparisonExists: comparison?.exists ?? false,
            passed
        };
    }
    return {
        operator: command.operator,
        expected: command.expected,
        actual: source.exists ? source.value : undefined,
        exists: source.exists,
        passed
    };
}

function toInvalidAssertOutcome(
    command: AssertCommandEvidence['command'],
    message: string,
    details: Readonly<{ operator: string; supportedOperators: readonly string[]; }> | undefined
): RallarBlackBoxTestCommandOutcome {
    const value: RallarBlackBoxTestAssertResultValue = isAssertComparison(command)
        ? {
            operator: command.operator,
            exists: false,
            comparisonExists: false,
            passed: false
        }
        : {
            operator: command.operator,
            expected: command.expected,
            exists: false,
            passed: false
        };
    return {
        status: 'failed',
        value,
        error: { code: 'RALLAR_BLACK_BOX_ASSERT_INVALID', message, details },
        nextStatus: 'failed'
    };
}

function isAssertHistoryCovered(source: string, state: RallarBlackBoxTestState): boolean {
    if (state.eventHistory.evictedEvents === 0) {
        return true;
    }
    const parts = source.trim().split('.').filter((part) => part.length > 0);
    const root = parts[0] === 'state' ? parts[1] : parts[0];
    if (root === undefined || ['events', 'messages', 'diagnostics', 'reports'].includes(root)) {
        return false;
    }
    if (root === 'recentEvents') {
        return state.events.length >= Math.min(RECENT_ASSERT_SOURCE_LIMIT, state.eventHistory.totalEvents);
    }
    const kind = root === 'recentMessages' ? 'message' : root === 'recentDiagnostics' ? 'diagnostic' : undefined;
    return kind === undefined || state.events.filter((event) => event.kind === kind).length >=
            Math.min(RECENT_ASSERT_SOURCE_LIMIT, state.eventHistory.countsByKind[kind]);
}
