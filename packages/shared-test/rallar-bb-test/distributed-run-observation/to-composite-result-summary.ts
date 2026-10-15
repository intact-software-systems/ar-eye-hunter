import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestResult,
    RallarBlackBoxTestWaitMatch
} from '../rallar-black-box-test-contracts.ts';
import {
    decodeAssertResultValue,
    decodeLoopResultValue,
    decodeParallelResultValue,
    decodeWaitResultValue
} from './decode-composite-result-values.ts';
import { decodeFirstNonBlankText, toDistributedRunPayloadSummary } from './distributed-run-payload-summary.ts';
import { toCompositeValueSummary } from './to-composite-result-detail.ts';

/** A wait or assert names what it checked only when the authored command it ran is known. */
export function toCompositeResultSummary(
    result: RallarBlackBoxTestResult,
    displayValue: ApiJsonValue | undefined,
    authored: RallarBlackBoxTestCommand | undefined
): string {
    return toKindResultSummary(result, authored) ?? toCompositeValueSummary(displayValue) ?? result.kind;
}

function toKindResultSummary(
    result: RallarBlackBoxTestResult,
    authored: RallarBlackBoxTestCommand | undefined
): string | undefined {
    if (result.kind === 'loop') {
        return toLoopResultSummary(result);
    }
    if (result.kind === 'parallel') {
        return toParallelResultSummary(result);
    }
    if (result.kind === 'wait') {
        return toWaitResultSummary(result, authored?.kind === 'wait' ? authored.match : undefined);
    }
    if (result.kind === 'assert') {
        return toAssertResultSummary(result, authored?.kind === 'assert' ? authored.source : undefined);
    }
    return undefined;
}

function toLoopResultSummary(result: RallarBlackBoxTestResult): string | undefined {
    const value = decodeLoopResultValue(result.value);
    if (!value) {
        return undefined;
    }
    const averageCadenceMs = value.childResultCount > 0
        ? Math.round(result.durationMs / value.childResultCount)
        : undefined;
    return [
        `${value.iterations} iterations`,
        `${value.childResultCount} children`,
        `${value.passed} passed`,
        `${value.failed} failed`,
        value.cancelled ? 'cancelled' : undefined,
        averageCadenceMs !== undefined ? `avg ${averageCadenceMs}ms/result` : undefined
    ].filter(Boolean).join(' - ');
}

function toParallelResultSummary(result: RallarBlackBoxTestResult): string | undefined {
    const value = decodeParallelResultValue(result.value);
    if (!value) {
        return undefined;
    }
    const failedGroups = value.groups
        .filter((group) => group.failed > 0)
        .map((group) => group.groupId);
    return [
        `${value.groupCount} groups`,
        `max ${value.maxConcurrency}`,
        `${value.passed} passed`,
        `${value.failed} failed`,
        value.cancelled ? 'cancelled' : undefined,
        failedGroups.length > 0 ? `failed groups ${failedGroups.join(', ')}` : undefined
    ].filter(Boolean).join(' - ');
}

function toWaitResultSummary(
    result: RallarBlackBoxTestResult,
    match: RallarBlackBoxTestWaitMatch | undefined
): string | undefined {
    const value = decodeWaitResultValue(result.value);
    if (!value) {
        return undefined;
    }
    return [
        value.matched ? 'matched' : value.timedOut ? 'timed out' : value.cancelled ? 'cancelled' : 'pending',
        match === undefined ? undefined : toWaitMatchSummary(match)
    ].filter(Boolean).join(' - ');
}

function toAssertResultSummary(result: RallarBlackBoxTestResult, source: string | undefined): string | undefined {
    const value = decodeAssertResultValue(result.value);
    if (!value) {
        return undefined;
    }
    return [
        value.passed ? 'passed' : 'failed',
        source === undefined ? value.operator : `${source} ${value.operator}`,
        value.expected !== undefined ? `expected ${toDistributedRunPayloadSummary(value.expected)}` : undefined
    ].filter(Boolean).join(' - ');
}

function toWaitMatchSummary(match: RallarBlackBoxTestWaitMatch): string | undefined {
    return [
        decodeFirstNonBlankText(match.topic),
        decodeFirstNonBlankText(match.commandId),
        decodeFirstNonBlankText(match.connection),
        decodeFirstNonBlankText(match.transport),
        decodeFirstNonBlankText(match.severity),
        decodeFirstNonBlankText(match.payloadPath),
        match.equals !== undefined ? `equals ${toDistributedRunPayloadSummary(match.equals)}` : undefined,
        decodeFirstNonBlankText(match.contains) ? `contains ${decodeFirstNonBlankText(match.contains)}` : undefined,
        typeof match.exists === 'boolean' ? `exists ${match.exists}` : undefined
    ].filter(Boolean).join(', ') || undefined;
}
