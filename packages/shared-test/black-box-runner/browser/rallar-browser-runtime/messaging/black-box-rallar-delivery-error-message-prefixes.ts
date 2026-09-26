/**
 * The page runtime's ALM failures cross `page.evaluate` as plain serialized errors, so the browser
 * adapter can only classify them by message. These prefixes are that contract: every throw site
 * below builds its message from one of them, and the adapter matches on the same constant.
 */
export const BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES = {
    deliveryStateTimeout: 'Delivery handle',
    scriptedPortsUnavailable: 'Scripted transport and storage ports are not installed',
    /** The page cannot replay now: no connected session, or the capturing carrier no longer retains the envelope. */
    replayUnavailable: 'Message replay unavailable',
    /** The page has no connected session to submit a raw control from. */
    rawControlUnavailable: 'Raw control submission unavailable'
} as const;
