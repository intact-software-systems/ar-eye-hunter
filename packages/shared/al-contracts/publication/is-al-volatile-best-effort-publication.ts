import type { ALMessage } from '../al-contract.ts';

/**
 * The wire signature of a live publication (D482): best-effort, volatile and latest-wins. The signature is not
 * exclusive to a live channel, and no live flag exists on the wire, so a WS server reads only these three fields.
 */
export function isALVolatileBestEffortPublication(msg: ALMessage): boolean {
    return msg.delivery?.reliability === 'best-effort' &&
        msg.qos?.durability?.algo === 'volatile' &&
        msg.qos?.supersedence?.algo === 'latest-wins';
}
