import { ROOM_SEND_CELL_CONSTANTS } from './room-send-cell-constants.ts';
import { ROOM_SEND_ORDERINGS, type RoomSendOrdering } from './room-send-ordering.ts';

/**
 * What a publisher does beyond offering each send once at its due instant. `none`: nothing, so the run shows the
 * server alone: a send it has not answered for is never offered again, and a track it stalls stays stalled.
 * `client-stand-in`: it answers the server's gap NACKs and repair requests and re-offers a send its server has not
 * answered for, as `RoomSendClientStandIn` states.
 */
export type RoomSendSenderRecovery = 'none' | 'client-stand-in';

/**
 * What one run of the cell varies: whether its sends name an ordering key, how many sessions publish, how fast, for
 * how long, at what database latency, what a publisher does to recover a send, and how many connections each
 * instance's application pool may open.
 */
export interface RoomSendShape {
    /** Whether the sends of the run name the room's ordering key, every one alike. */
    readonly ordering: RoomSendOrdering;
    /** The sessions that publish. Under `ordering-key` each offers a track of its own. */
    readonly publishers: number;
    /** The sends each publisher offers every second, open-loop. */
    readonly sendsPerSecond: number;
    /** The length of the send window, in seconds. */
    readonly durationS: number;
    /**
     * What each of the delayed round trips to the database costs on top of its own time, in milliseconds
     * (`ROOM_SEND_DELAYED_ROUND_TRIPS`); the others cost nothing more.
     */
    readonly delayMs: number;
    readonly senderRecovery: RoomSendSenderRecovery;
    /** The most connections each instance's application pool opens: its statements and transactions share them. */
    readonly applicationPoolMaxConnections: number;
}

/**
 * An issue of a number repeats the number; an issue of the ordering or of the sender recovery never repeats the text
 * it was given.
 */
export interface RoomSendShapeIssue {
    readonly code:
        | 'invalid-ordering'
        | 'invalid-publishers'
        | 'invalid-sends-per-second'
        | 'invalid-duration-s'
        | 'invalid-delay-ms'
        | 'invalid-sender-recovery'
        | 'invalid-application-pool';
    readonly message: string;
}

export const ROOM_SEND_SENDER_RECOVERIES: readonly RoomSendSenderRecovery[] = ['none', 'client-stand-in'];

/**
 * Every issue of a shape, in the order of its fields; none means the cell can run it. The ordering and the sender
 * recovery are each one of the two the cell knows, which a shape decoded from JSON or from a command line may fail to
 * be.
 */
export function validateRoomSendShape(shape: RoomSendShape): readonly RoomSendShapeIssue[] {
    const orderingIssues: readonly RoomSendShapeIssue[] = ROOM_SEND_ORDERINGS.includes(shape.ordering)
        ? []
        : [{ code: 'invalid-ordering', message: 'ordering must be ordering-key or unordered' }];
    return [...orderingIssues, ...validateRoomSendShapeBesideOrdering(shape)];
}

/**
 * Every issue of what a shape holds beside its ordering. Each number is whole, so every publisher offers a whole
 * number of sends, the rate times the duration, and nothing is rounded. All the sessions of the room may publish: a
 * send still has every other session as its audience. An application pool opens at least one connection.
 */
function validateRoomSendShapeBesideOrdering(shape: Omit<RoomSendShape, 'ordering'>): readonly RoomSendShapeIssue[] {
    const { sessionCount } = ROOM_SEND_CELL_CONSTANTS;
    const issues: RoomSendShapeIssue[] = [];
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
    if (!ROOM_SEND_SENDER_RECOVERIES.includes(shape.senderRecovery)) {
        issues.push({ code: 'invalid-sender-recovery', message: 'senderRecovery must be none or client-stand-in' });
    }
    if (!isWholeNumberOfAtLeast(shape.applicationPoolMaxConnections, 1)) {
        issues.push({
            code: 'invalid-application-pool',
            message: 'applicationPoolMaxConnections must be a whole number of at least 1; ' +
                `received ${shape.applicationPoolMaxConnections}`
        });
    }
    return issues;
}

function isWholeNumberOfAtLeast(value: number, minimum: number): boolean {
    return Number.isSafeInteger(value) && value >= minimum;
}
