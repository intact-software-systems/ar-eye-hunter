import type { DistributedRunEventEvidence } from '../distributed-artifact-analysis/decode-distributed-run-event-evidence.ts';
import type { DistributedRunResultEvidence } from '../distributed-artifact-analysis/decode-distributed-run-result-evidence.ts';
import type { DistributedRunStreamSummary } from '../distributed-artifact-analysis/decode-distributed-run-stream-summary.ts';

/** One rtc.stream execution as a result or an event reports it. */
export interface StreamTimingSample {
    /** Absent when neither the row nor the enclosing result names the agent. */
    readonly agentId?: string;
    /** Absent when neither the summary nor the row names the command. */
    readonly commandId?: string;
    /** Absent for events and for results that name no execution; nested results inherit their parent's path. */
    readonly identityKey?: string;
    readonly completeness: 'terminal' | 'partial';
    readonly failed: boolean;
    /** True when a recipe.run result nested this execution. */
    readonly nested: boolean;
    readonly summary: DistributedRunStreamSummary;
}

export const STREAM_STARTED_TOPIC = 'rallar.bb.rtc.stream_started';
export const STREAM_PROGRESS_TOPIC = 'rallar.bb.rtc.stream_progress';
export const STREAM_FAILED_TOPIC = 'rallar.bb.rtc.stream_failed';

const STREAM_TOPIC_PREFIX = 'rallar.bb.rtc.stream_';
const STREAM_COMPLETED_TOPIC = 'rallar.bb.rtc.stream_completed';
const IN_FLIGHT_LIMIT_ERROR_CODE = 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT';
const RESULT_FAILURE_STATUSES: ReadonlySet<string> = new Set(['failure', 'failed', 'error']);

/** Lower-case markers of a failed stream in codes, messages and topics. */
const STREAM_FAILURE_FRAGMENTS = [
    'rallar_black_box_rtc_stream_threshold_failed',
    IN_FLIGHT_LIMIT_ERROR_CODE.toLowerCase(),
    STREAM_FAILED_TOPIC,
    'maxdroppedframes'
] as const;

export function toResultStreamTimingSamples(result: DistributedRunResultEvidence): readonly StreamTimingSample[] {
    return toNestedResultStreamTimingSamples(result, {});
}

/** Absent when the event is not an rtc.stream lifecycle event carrying a stream summary. */
export function toEventStreamTimingSample(event: DistributedRunEventEvidence): StreamTimingSample | undefined {
    if (!event.topic?.startsWith(STREAM_TOPIC_PREFIX) || event.streamSummary === undefined) {
        return undefined;
    }
    return {
        agentId: event.agentId,
        commandId: event.streamSummary.commandId ?? event.commandId,
        completeness: event.topic === STREAM_COMPLETED_TOPIC || event.topic === STREAM_FAILED_TOPIC
            ? 'terminal'
            : 'partial',
        failed: event.topic === STREAM_FAILED_TOPIC || event.severity === 'error',
        nested: false,
        summary: event.streamSummary
    };
}

/** Terminal lifecycle events outrank progress, which outranks start and any other event. */
export function toStreamEventPriority(event: DistributedRunEventEvidence): number {
    if (event.topic === STREAM_COMPLETED_TOPIC || event.topic === STREAM_FAILED_TOPIC) {
        return 3;
    }
    if (event.topic === STREAM_PROGRESS_TOPIC) {
        return 2;
    }
    return event.topic === STREAM_STARTED_TOPIC ? 1 : 0;
}

export function isStreamFailureText(text: string): boolean {
    const normalized = text.toLowerCase();
    return STREAM_FAILURE_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

export function hasStreamFailureEvidence(sample: StreamTimingSample): boolean {
    return sample.failed || sample.summary.thresholdFailureCount > 0;
}

export function computeStreamInFlightLimitDropCount(sample: StreamTimingSample): number {
    return sample.summary.inFlightLimitDropCount ??
        sample.summary.observations.filter((observation) => observation.errorCode === IN_FLIGHT_LIMIT_ERROR_CODE)
            .length;
}

interface InheritedStreamContext {
    /** Absent for a top-level result. */
    readonly agentId?: string;
    /** Absent for a top-level result. */
    readonly identityKey?: string;
}

function toNestedResultStreamTimingSamples(
    result: DistributedRunResultEvidence,
    inherited: InheritedStreamContext
): readonly StreamTimingSample[] {
    const agentId = result.agentId ?? inherited.agentId;
    const own: StreamTimingSample[] = result.streamSummary === undefined ? [] : [{
        agentId,
        commandId: result.streamSummary.commandId ?? result.commandId,
        identityKey: inherited.identityKey ?? result.executionIdentity,
        completeness: 'terminal',
        failed: hasResultStreamFailureSignal(result),
        nested: inherited.identityKey !== undefined,
        summary: result.streamSummary
    }];
    const parentIdentity = result.executionIdentity ?? inherited.identityKey ?? result.commandId;
    return [
        ...own,
        ...result.nestedResults.flatMap((nestedResult, nestedIndex) =>
            toNestedResultStreamTimingSamples(nestedResult, {
                agentId,
                identityKey: [parentIdentity, `nested-${nestedIndex}`, nestedResult.executionIdentity]
                    .filter((part): part is string => part !== undefined)
                    .join('/')
            })
        )
    ];
}

function hasResultStreamFailureSignal(result: DistributedRunResultEvidence): boolean {
    const status = result.status?.toLowerCase();
    return (status !== undefined && RESULT_FAILURE_STATUSES.has(status)) ||
        result.ok === false ||
        isStreamFailureText(result.streamFailureTexts.join(' '));
}
