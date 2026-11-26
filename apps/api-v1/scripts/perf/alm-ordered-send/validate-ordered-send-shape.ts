import { ORDERED_SEND_CELL_CONSTANTS } from './ordered-send-cell-constants.ts';

/** What one run of the cell varies: how many sessions publish, how fast, for how long, and at what database latency. */
export interface OrderedSendShape {
    /** The sessions that publish, each on a track of its own. */
    readonly publishers: number;
    /** The sends each publisher offers every second, open-loop. */
    readonly sendsPerSecond: number;
    /** The length of the send window, in seconds. */
    readonly durationS: number;
    /** What each round trip to the database costs on top of its own time, in milliseconds. */
    readonly delayMs: number;
}

export interface OrderedSendShapeIssue {
    readonly code: 'invalid-publishers' | 'invalid-sends-per-second' | 'invalid-duration-s' | 'invalid-delay-ms';
    readonly message: string;
}

/**
 * Every issue of a shape; none means the cell can run it. Each field is a whole number, so every publisher offers a
 * whole number of sends, the rate times the duration, and nothing is rounded. All the sessions of the room may
 * publish: a send still has every other session as its audience.
 */
export function validateOrderedSendShape(shape: OrderedSendShape): readonly OrderedSendShapeIssue[] {
    const { sessionCount } = ORDERED_SEND_CELL_CONSTANTS;
    const issues: OrderedSendShapeIssue[] = [];
    if (!isWholeNumberOfAtLeast(shape.publishers, 1) || shape.publishers > sessionCount) {
        issues.push({
            code: 'invalid-publishers',
            message: `publishers must be a whole number from 1 to ${sessionCount}, the sessions of the room; ` +
                `received ${shape.publishers}`
        });
    }
    if (!isWholeNumberOfAtLeast(shape.sendsPerSecond, 1)) {
        issues.push({
            code: 'invalid-sends-per-second',
            message: `sendsPerSecond must be a whole number of at least 1; received ${shape.sendsPerSecond}`
        });
    }
    if (!isWholeNumberOfAtLeast(shape.durationS, 1)) {
        issues.push({
            code: 'invalid-duration-s',
            message: `durationS must be a whole number of at least 1; received ${shape.durationS}`
        });
    }
    if (!isWholeNumberOfAtLeast(shape.delayMs, 0)) {
        issues.push({
            code: 'invalid-delay-ms',
            message: `delayMs must be a whole number of at least 0; received ${shape.delayMs}`
        });
    }
    return issues;
}

function isWholeNumberOfAtLeast(value: number, minimum: number): boolean {
    return Number.isSafeInteger(value) && value >= minimum;
}
