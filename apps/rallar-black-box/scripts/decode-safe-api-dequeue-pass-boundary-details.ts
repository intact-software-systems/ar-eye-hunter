import {
    isAllowedApiTimingString,
    isApiTimingRecord,
    isNonNegativeApiTimingNumber
} from './to-safe-api-ws-receipt-observation.ts';

export const API_TIMING_DEQUEUE_LANES: readonly string[] = ['NEW', 'RETRY', 'FAIRNESS', 'TIMEOUT', 'FINALIZATION'];

const PASS_BOUNDARY_QUEUE_TYPES = ['APP_INBOX', 'APP_OUTBOX'];
const PASS_BOUNDARY_NUMBERS = [
    'passWallMs',
    'probeMs',
    'probeToPassMs',
    'claimedInPass',
    'claimedNew',
    'claimedRetry',
    'claimedFairness',
    'claimedTimeout',
    'claimedFinalization'
];

/**
 * The closed fields of a dequeue-pass boundary line: the queue type of the reader whose pass it closed,
 * the lanes its probe advertised, its probe timing and its claims per lane. Anything else is dropped.
 */
export function decodeSafeApiDequeuePassBoundaryDetails(details: unknown): Readonly<Record<string, string | number>> {
    const safe: Record<string, string | number> = {};
    if (!isApiTimingRecord(details)) {
        return safe;
    }
    if (isAllowedApiTimingString(details.queueType, PASS_BOUNDARY_QUEUE_TYPES)) {
        safe.queueType = details.queueType;
    }
    if (isProbedLaneList(details.lanesProbed)) {
        safe.lanesProbed = details.lanesProbed;
    }
    for (const field of PASS_BOUNDARY_NUMBERS) {
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
