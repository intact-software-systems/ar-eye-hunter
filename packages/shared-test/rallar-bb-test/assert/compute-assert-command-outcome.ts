import type {
    RallarBlackBoxTestAssertCommand,
    RallarBlackBoxTestAssertResultValue,
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestConfig,
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestState,
    RallarBlackBoxTestStatsSnapshot
} from '../rallar-black-box-test-contracts.ts';
import { lookupPayloadPath, type PayloadPathLookup } from '../wait/wait-event-match.ts';
import {
    assertValueMatches,
    isRallarBlackBoxAssertOperator,
    RALLAR_BLACK_BOX_ASSERT_OPERATORS
} from './assert-value-operators.ts';

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

const RECENT_ASSERT_SOURCE_LIMIT = 20;

export function computeAssertCommandOutcome(evidence: AssertCommandEvidence): RallarBlackBoxTestCommandOutcome {
    const { command, state } = evidence;
    if (typeof command.source !== 'string' || command.source.trim().length === 0) {
        return toInvalidAssertOutcome(command, 'Assert requires a non-empty source.', undefined);
    }
    if (!isRallarBlackBoxAssertOperator(command.operator)) {
        return toInvalidAssertOutcome(command, 'Assert operator is not supported.', {
            operator: command.operator,
            supportedOperators: RALLAR_BLACK_BOX_ASSERT_OPERATORS
        });
    }

    const source = resolveAssertSource(command.source, toAssertSourceRoots(evidence));
    const passed = assertValueMatches(source, command.operator, command.expected);
    const value = toAssertResultValue(command, source, passed);
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

function resolveAssertSource(source: string, roots: AssertSourceRoots): PayloadPathLookup {
    const [rootName, ...pathParts] = source.trim().split('.').filter((part) => part.length > 0);
    if (!rootName || !Object.hasOwn(roots, rootName)) {
        return { exists: false };
    }
    const root = roots[rootName as keyof AssertSourceRoots];
    return pathParts.length === 0
        ? { exists: root !== undefined, value: root }
        : lookupPayloadPath(root, pathParts.join('.'));
}

function toAssertSourceRoots(evidence: AssertCommandEvidence): AssertSourceRoots {
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

function toAssertResultValue(
    command: AssertCommandEvidence['command'],
    source: PayloadPathLookup,
    passed: boolean
): RallarBlackBoxTestAssertResultValue {
    return {
        commandId: command.commandId,
        source: command.source,
        operator: command.operator,
        expected: command.expected,
        actual: source.value,
        exists: source.exists,
        passed
    };
}

function toInvalidAssertOutcome(
    command: AssertCommandEvidence['command'],
    message: string,
    details: Readonly<{ operator: string; supportedOperators: readonly string[]; }> | undefined
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: {
            commandId: command.commandId,
            source: command.source,
            operator: command.operator,
            expected: command.expected,
            exists: false,
            passed: false
        } satisfies RallarBlackBoxTestAssertResultValue,
        error: { code: 'RALLAR_BLACK_BOX_ASSERT_INVALID', message, details },
        nextStatus: 'failed'
    };
}
