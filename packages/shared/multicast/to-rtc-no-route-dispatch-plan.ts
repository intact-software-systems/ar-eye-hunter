import type { ALMessage } from '../al-contracts/al-contract.ts';
import type { ALOutboundDispatchPlan } from '../alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundTransportMessage } from '../alm/outbound/al-outbound-transport-message.ts';

export function toRtcNoRouteDispatchPlan(
    msg: ALMessage,
    reason: string
): ALOutboundDispatchPlan<ALOutboundTransportMessage> {
    return {
        msg,
        dropReasonCode: 'no-route',
        lane: 'volatile',
        preparedMessages: [],
        dropReason: `Skipping RTC outbound message ${msg.id.msgId} ${reason}`
    };
}
