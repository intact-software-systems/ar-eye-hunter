import {
    isAllowedApiTimingString,
    isApiTimingRecord,
    isNonNegativeApiTimingNumber
} from './to-safe-api-ws-receipt-observation.ts';

export const API_TIMING_DEQUEUE_LANES: readonly string[] = ['NEW', 'RETRY', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'];

const PASS_BOUNDARY_QUEUE_TYPES = ['APP_INBOX', 'APP_OUTBOX'];
/** The closed numeric fields of each dequeue-pass operation; an operation outside it keeps none. */
const DEQUEUE_PASS_NUMBERS: Readonly<Record<string, readonly string[]>> = {
    'dequeue-pass': ['passWallMs', 'handlersMs', 'statements', 'executorWaitMs', 'claimedInPass'],
    'dequeue-pass-boundary': [
        'passWallMs',
        'probeMs',
        'probeToPassMs',
        'claimedInPass',
        'claimedNew',
        'claimedRetry',
        'claimedFairness',
        'claimedTimeout',
        'claimedFinalization'
    ]
};

/**
 * The closed fields of a dequeue-pass line: the lanes its probe advertised and its numeric cost, and on a
 * boundary line the queue type of the reader whose pass it closed. Anything else is dropped.
 */
export function decodeSafeApiDequeuePassDetails(
    operation: string,
    details: unknown
): Readonly<Record<string, string | number>> {
    const safe: Record<string, string | number> = {};
    const numbers = DEQUEUE_PASS_NUMBERS[operation];
    if (numbers === undefined || !isApiTimingRecord(details)) {
        return safe;
    }
    if (
        operation === 'dequeue-pass-boundary' && isAllowedApiTimingString(details.queueType, PASS_BOUNDARY_QUEUE_TYPES)
    ) {
        safe.queueType = details.queueType;
    }
    if (isProbedLaneList(details.lanesProbed)) {
        safe.lanesProbed = details.lanesProbed;
    }
    for (const field of numbers) {
        if (isNonNegativeApiTimingNumber(details[field])) {
            safe[field] = details[field];
        }
    }
    return safe;
}

function isProbedLaneList(value: unknown): value is string {
    return typeof value === 'string' &&
        (value === '' || value.split(',').every((lane) => API_TIMING_DEQUEUE_LANES.includes(lane)));
}
