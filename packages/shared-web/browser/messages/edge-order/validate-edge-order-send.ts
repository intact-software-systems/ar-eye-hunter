import type { RallarTypedMessageSendOptions } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The send options an edge-ordered channel decides itself or cannot order yet. */
export type EdgeOrderSendOptions = Pick<
    RallarTypedMessageSendOptions<never>,
    | 'strategy'
    | 'reliability'
    | 'ack'
    | 'qos'
    | 'scope'
    | 'exceptPeerIds'
    | 'recipientPeerIds'
    | 'principalId'
    | 'peerId'
    | 'orderingKey'
    | 'seq'
>;

interface EdgeOrderSendRefusal {
    readonly path: string;
    readonly refused: boolean;
    readonly message: string;
}

const WHOLE_ROOM = 'An edge-ordered send reaches its whole room: one stream is one audience.';
const RETRIED = 'An edge-ordered send is at-least-once: a receiver waits only for a send that is retried.';
const RECEIPTED = 'An edge-ordered send asks its room a receipt: the receipt is what ends the wait for it.';
const NO_HOP_ORDER =
    'An edge-ordered send carries no hop order: orderingKey and seq belong to a channel without order.';

/**
 * An edge-ordered send is a whole-room, at-least-once, receipted, volatile send over `ws`, `rtc` or
 * `rtc-with-ws-fallback`. Every other shape is refused before the send takes a position, so it leaves no hole.
 */
export function validateEdgeOrderSend(send: EdgeOrderSendOptions): readonly RallarValidationIssue[] {
    return toEdgeOrderSendRefusals(send)
        .filter((refusal) => refusal.refused)
        .map(({ path, message }) => ({ path, code: 'unsupported', message }));
}

function toEdgeOrderSendRefusals(send: EdgeOrderSendOptions): readonly EdgeOrderSendRefusal[] {
    const { qos } = send;
    return [
        {
            path: '$.strategy',
            refused: send.strategy === 'ws-then-rtc',
            message: 'An edge-ordered send takes the ws, rtc or rtc-with-ws-fallback strategy.'
        },
        { path: '$.reliability', refused: send.reliability === 'best-effort', message: RETRIED },
        {
            path: '$.qos.delivery',
            refused: qos?.delivery !== undefined && qos.delivery.algo !== 'at-least-once',
            message: RETRIED
        },
        { path: '$.ack', refused: send.ack === 'none' || send.ack === 'group-leader', message: RECEIPTED },
        {
            path: '$.qos.ack',
            refused: qos?.ack !== undefined && qos.ack.algo !== 'receiver',
            message: RECEIPTED
        },
        { path: '$.scope', refused: send.scope !== undefined && send.scope !== 'room', message: WHOLE_ROOM },
        { path: '$.exceptPeerIds', refused: send.exceptPeerIds !== undefined, message: WHOLE_ROOM },
        { path: '$.recipientPeerIds', refused: send.recipientPeerIds !== undefined, message: WHOLE_ROOM },
        { path: '$.principalId', refused: send.principalId !== undefined, message: WHOLE_ROOM },
        { path: '$.peerId', refused: send.peerId !== undefined, message: WHOLE_ROOM },
        { path: '$.orderingKey', refused: send.orderingKey !== undefined, message: NO_HOP_ORDER },
        { path: '$.seq', refused: send.seq !== undefined, message: NO_HOP_ORDER },
        {
            path: '$.qos.supersedence',
            refused: qos?.supersedence !== undefined,
            message: 'An edge-ordered send is never superseded: a superseded send is a hole in its stream.'
        },
        {
            path: '$.qos.durability',
            refused: qos?.durability !== undefined && qos.durability.algo !== 'volatile',
            message: 'An edge-ordered send is volatile: its order lives in memory only.'
        }
    ];
}
