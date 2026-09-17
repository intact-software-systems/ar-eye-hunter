import type {
    RallarBlackBoxTestCommandOutcome,
    RallarBlackBoxTestLoopChildResult,
    RallarBlackBoxTestLoopResultValue,
    RallarBlackBoxTestRecord
} from '../rallar-black-box-test-contracts.ts';
import { toLoopResultValue, type LoopResultMetrics } from './to-loop-result-value.ts';

export interface LoopOutcomeEvidence {
    readonly commandId: string;
    readonly results: readonly RallarBlackBoxTestLoopChildResult[];
    /** Absent before the loop starts, when no pacing has been measured. */
    readonly metrics?: LoopResultMetrics;
}

export interface LoopTimeoutEvidence extends LoopOutcomeEvidence {
    readonly timeoutMs: number | undefined;
    readonly deadlineEpochMs: number;
}

export function toLoopInvalidOutcome(
    commandId: string,
    message: string,
    details: RallarBlackBoxTestRecord | undefined
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toLoopResultValue({ commandId, results: [], cancelled: false, metrics: undefined }),
        error: { code: 'RALLAR_BLACK_BOX_LOOP_INVALID', message, details },
        nextStatus: 'failed'
    };
}

export function toLoopLimitExceededOutcome(
    evidence: LoopOutcomeEvidence,
    details: RallarBlackBoxTestRecord
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toLoopResultValue({ ...evidence, cancelled: false }),
        error: {
            code: 'RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED',
            message: 'Loop would exceed the configured maximum child command count.',
            details
        },
        nextStatus: 'failed'
    };
}

export function toLoopTimedOutOutcome(evidence: LoopTimeoutEvidence): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value: toLoopResultValue({ ...evidence, cancelled: false }),
        error: {
            code: 'RALLAR_BLACK_BOX_LOOP_TIMEOUT',
            message: 'Loop reached its timeout before all iterations completed.',
            details: {
                timeoutMs: evidence.timeoutMs,
                deadlineEpochMs: evidence.deadlineEpochMs,
                completedCommands: evidence.results.length
            }
        },
        nextStatus: 'failed'
    };
}

export function toLoopCancelledOutcome(value: RallarBlackBoxTestLoopResultValue): RallarBlackBoxTestCommandOutcome {
    return { status: 'cancelled', value, nextStatus: 'cancelled' };
}

export function toLoopChildFailedOutcome(
    value: RallarBlackBoxTestLoopResultValue,
    failedChild: RallarBlackBoxTestLoopChildResult
): RallarBlackBoxTestCommandOutcome {
    return {
        status: 'failed',
        value,
        nextStatus: 'failed',
        error: {
            code: 'RALLAR_BLACK_BOX_LOOP_CHILD_FAILED',
            message: 'Loop failed at child command ' + failedChild.result.commandId + '.',
            details: failedChild.result.error
        }
    };
}

export function toLoopCompletionOutcome(value: RallarBlackBoxTestLoopResultValue): RallarBlackBoxTestCommandOutcome {
    const thresholdFailures = value.thresholdFailures ?? [];
    return thresholdFailures.length === 0
        ? { status: 'ok', value, nextStatus: 'completed' }
        : {
            status: 'failed',
            value,
            error: {
                code: 'RALLAR_BLACK_BOX_LOOP_THRESHOLD_FAILED',
                message: 'Loop did not satisfy configured pacing or send thresholds.',
                details: { thresholdFailures }
            },
            nextStatus: 'failed'
        };
}
