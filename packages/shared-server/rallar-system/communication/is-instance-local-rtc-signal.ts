import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { normalizeALQosPolicy } from '@shared/al-contracts/al-policy.ts';
import { AppTopics } from '@shared/api/api-config.ts';

import { MAX_LIVE_WS_NOTICE_BYTES } from '../queue-pubsub/live-ws-notice.ts';

/** What a peer notice adds around its message: channel, publisher, deadline, scope and recipient. */
const LIVE_WS_PEER_NOTICE_RESERVE_BYTES = 1_024;

const INSTANCE_LOCAL_RTC_SIGNAL_MAX_BYTES = MAX_LIVE_WS_NOTICE_BYTES - LIVE_WS_PEER_NOTICE_RESERVE_BYTES;

/** UTF-8 spends one to three bytes on each UTF-16 code unit. */
const MAX_UTF8_BYTES_PER_CODE_UNIT = 3;

const UTF8 = new TextEncoder();

/**
 * A relay-only RTC signal: best-effort, acknowledged by no one, and small enough to reach another instance inline in
 * its live notice. No other instance reads it back from the shared inbound store (no relayed ACK is proved against
 * it and no inbound-key notice names it), so a server beside other instances keeps it in its memory lane.
 */
export function isInstanceLocalRtcSignal(message: ALMessage): boolean {
    if (message.route.topicId !== AppTopics.rtcSignaling || message.payload.typeId !== AppTopics.rtcSignaling) {
        return false;
    }
    const { effective } = normalizeALQosPolicy(message);
    return effective.delivery.algo === 'best-effort' && effective.ack.algo === 'none' &&
        fitsInstanceLocalRtcSignalBytes(JSON.stringify(message));
}

/** The code-unit count bounds the UTF-8 length from both sides, so only an envelope between the bounds is encoded. */
function fitsInstanceLocalRtcSignalBytes(serialized: string): boolean {
    if (serialized.length > INSTANCE_LOCAL_RTC_SIGNAL_MAX_BYTES) {
        return false;
    }
    return serialized.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= INSTANCE_LOCAL_RTC_SIGNAL_MAX_BYTES ||
        UTF8.encode(serialized).length <= INSTANCE_LOCAL_RTC_SIGNAL_MAX_BYTES;
}
