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
     * How long a send lives, as the `ttlMs` of its envelope: the server gives its receipt this long to complete
     * before it answers `timed-out`. It is the lifetime of the browser's default room send.
     */
    readonly sendLifetimeMs: number;
    /** A recipient offers its ACK of a copy at most this long after it first read the copy. */
    readonly ackSpreadMs: number;
}

export const ORDERED_SEND_CELL_CONSTANTS: OrderedSendCellConstants = {
    sessionCount: 15,
    instanceCount: 3,
    applicationPoolMaxConnections: 10,
    listenerPoolMaxConnections: 1,
    sendLifetimeMs: AL_CHANNEL_SEND_DEFAULTS.notification.ttlMs,
    ackSpreadMs: 100
};
