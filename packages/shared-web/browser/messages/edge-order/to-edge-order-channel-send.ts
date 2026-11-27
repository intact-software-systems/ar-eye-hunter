import type { EdgeOrderSendStreams } from '@shared-web/browser/messages/edge-order/edge-order-send-streams.ts';
import { isEdgeOrderRetriedSend } from '@shared-web/browser/messages/edge-order/validate-edge-order-send.ts';
import type { RallarMessageSendBase } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import {
    toBrowserMessageSendDefaults,
    type BrowserTypedChannelPolicy
} from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

/** What a send says that decides its stream and how receivers treat it. */
export type EdgeOrderSendFacts =
    & Pick<RallarMessageSendBase<never>, 'topicId' | 'typeId' | 'ttlMs' | 'reliability' | 'ack' | 'qos'>
    & EdgeOrderSendStreams.Audience;

/** Only a lane send, which names no channel and so declares no order, reads the lane's lifetime. */
const NO_LANE_TTL_MS = 0;

/**
 * A send as its order sees it, in the application's own call. Whether anything retries the send is decided here,
 * from the options the send states and its channel's defaults, so a later send's stamp never asks a receiver to wait
 * for one nothing retries. A live channel's value is staged first, and takes its position when it leaves the stage.
 */
export function toEdgeOrderChannelSend(
    send: EdgeOrderSendFacts,
    channel: BrowserTypedChannelPolicy | undefined,
    roomRef: GroupRef | undefined
): EdgeOrderSendStreams.ChannelSend {
    const { supersedence } = send.qos ?? {};
    return {
        order: channel?.order,
        staged: channel?.publication !== undefined,
        topicId: send.topicId,
        typeId: send.typeId,
        roomRef,
        audience: send,
        retried: isEdgeOrderRetriedSend(
            toBrowserMessageSendDefaults({ send, channel, hasLogicalAudience: true, laneTtlMs: NO_LANE_TTL_MS })
        ),
        supersedenceKey: supersedence?.algo === 'latest-wins' ? supersedence.opts?.supersedenceKey : undefined
    };
}
