import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import {
    decodeAssertResultValue,
    decodeLoopResultValue,
    decodeParallelResultValue,
    decodeWaitResultValue
} from './decode-composite-result-values.ts';
import { decodeFirstNonBlankText, summarizeDistributedRunPayload } from './distributed-run-payload-summary.ts';
import { toCompositeValueSummary } from './to-composite-result-detail.ts';

export function toCompositeResultSummary(
    result: RallarBlackBoxTestResult,
    displayValue: unknown
): string {
    return toKindResultSummary(result) ?? toCompositeValueSummary(displayValue) ?? result.kind;
}

function toKindResultSummary(result: RallarBlackBoxTestResult): string | undefined {
    if (result.kind === 'loop') {
        return toLoopResultSummary(result);
    }
    if (result.kind === 'parallel') {
        return toParallelResultSummary(result);
    }
    if (result.kind === 'wait') {
        return toWaitResultSummary(result);
    }
    if (result.kind === 'assert') {
        return toAssertResultSummary(result);
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

function toWaitResultSummary(result: RallarBlackBoxTestResult): string | undefined {
    const value = decodeWaitResultValue(result.value);
    if (!value) {
        return undefined;
    }
    return [
        value.matched ? 'matched' : value.timedOut ? 'timed out' : value.cancelled ? 'cancelled' : 'pending',
        toWaitMatchSummary(value.match)
    ].filter(Boolean).join(' - ');
}

function toAssertResultSummary(result: RallarBlackBoxTestResult): string | undefined {
    const value = decodeAssertResultValue(result.value);
    if (!value) {
        return undefined;
    }
    return [
        value.passed ? 'passed' : 'failed',
        `${value.source} ${value.operator}`,
        value.expected !== undefined ? `expected ${summarizeDistributedRunPayload(value.expected)}` : undefined
    ].filter(Boolean).join(' - ');
}

function toWaitMatchSummary(value: unknown): string | undefined {
    const match = decodeRecord(value);
    return [
        decodeFirstNonBlankText(match.topic),
        decodeFirstNonBlankText(match.commandId),
        decodeFirstNonBlankText(match.connection),
        decodeFirstNonBlankText(match.transport),
        decodeFirstNonBlankText(match.severity),
        decodeFirstNonBlankText(match.payloadPath),
        match.equals !== undefined ? `equals ${summarizeDistributedRunPayload(match.equals)}` : undefined,
        decodeFirstNonBlankText(match.contains) ? `contains ${decodeFirstNonBlankText(match.contains)}` : undefined,
        typeof match.exists === 'boolean' ? `exists ${match.exists}` : undefined
    ].filter(Boolean).join(', ') || undefined;
}
