import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

/** What every run of the cell holds fixed, whatever its shape. The artifact records it beside the shape. */
export interface OrderedSendCellConstants {
    /** The sessions of the one room, placed evenly over the instances. Each reads every send that is not its own. */
    readonly sessionCount: number;
    /** The WS server instances on the one database, sharing one store namespace and the name `server`. */
    readonly instanceCount: number;
    /** The most connections each instance's listener pool opens: its LISTEN subscriptions hold them. */
    readonly listenerPoolMaxConnections: number;
    /**
     * How long a connection of either pool may idle before its pool closes it, in seconds. 0 closes none: a
     * connection reopened inside a run would cost a handshake that no delay is added to.
     */
    readonly poolIdleTimeoutSeconds: number;
    /**
     * How long a send lives, as the `ttlMs` of its envelope: the server gives its receipt this long to complete
     * before it answers `timed-out`. It is the lifetime of the browser's default room send.
     */
    readonly sendLifetimeMs: number;
    /**
     * How long past a send's lifetime a reference run still observes. The server writes a `timed-out` receipt only
     * after the send's deadline and keeps its outbox row 30 s past it (`AL_RECEIPT_DEADLINE_GRACE_MS`), announcing it
     * again meanwhile; one was read 64.8 s after its send's offer, so the grace is 45 s. A receipt may still come
     * later than this: the report counts a send without a terminal receipt as such.
     */
    readonly receiptGraceMs: number;
    /** A recipient offers its ACK of a copy at most this long after it first read the copy. */
    readonly ackSpreadMs: number;
}

export const ORDERED_SEND_CELL_CONSTANTS: OrderedSendCellConstants = {
    sessionCount: 15,
    instanceCount: 3,
    listenerPoolMaxConnections: 1,
    poolIdleTimeoutSeconds: 0,
    sendLifetimeMs: AL_CHANNEL_SEND_DEFAULTS.notification.ttlMs,
    receiptGraceMs: 45_000,
    ackSpreadMs: 100
};

/**
 * How long a reference run observes after its last offer, whatever it has read by then: every reference run has the
 * same tail, so the receipts read again and the receipts read late are counted over the same time at every delay.
 */
export const ORDERED_SEND_REFERENCE_OBSERVATION_TAIL_MS = ORDERED_SEND_CELL_CONSTANTS.sendLifetimeMs +
    ORDERED_SEND_CELL_CONSTANTS.receiptGraceMs;
