import { AL_RECEIPT_DEADLINE_GRACE_MS } from '@shared/al-contracts/al-control.ts';
import { AL_CHANNEL_SEND_DEFAULTS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';

/** What every run of the cell holds fixed, whatever its shape. The artifact records it beside the shape. */
export interface OrderedSendCellConstants {
    /** The sessions of the one room, placed evenly over the instances. Each reads every send that is not its own. */
    readonly sessionCount: number;
    /** The WS server instances on the one database, sharing one store namespace and the name `server`. */
    readonly instanceCount: number;
    /** The most connections each instance's application pool opens: its statements and transactions share them. */
    readonly applicationPoolMaxConnections: number;
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
     * How long past a send's lifetime a run still waits for its terminal receipt before it gives the send up: as
     * long as the server keeps a receipt's outbox row past the send's deadline, so no receipt can come later.
     */
    readonly receiptGraceMs: number;
    /** A recipient offers its ACK of a copy at most this long after it first read the copy. */
    readonly ackSpreadMs: number;
}

export const ORDERED_SEND_CELL_CONSTANTS: OrderedSendCellConstants = {
    sessionCount: 15,
    instanceCount: 3,
    applicationPoolMaxConnections: 10,
    listenerPoolMaxConnections: 1,
    poolIdleTimeoutSeconds: 0,
    sendLifetimeMs: AL_CHANNEL_SEND_DEFAULTS.notification.ttlMs,
    receiptGraceMs: AL_RECEIPT_DEADLINE_GRACE_MS,
    ackSpreadMs: 100
};
