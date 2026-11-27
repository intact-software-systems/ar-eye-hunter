import type { RallarTypedMessageSendOptions } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { BrowserMessageSendDefaults } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The send options an edge-ordered channel decides itself or cannot order yet. */
export type EdgeOrderSendOptions = Pick<
    RallarTypedMessageSendOptions<never>,
    | 'strategy'
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
const EVERY_RECIPIENT =
    'An edge-ordered send asks every recipient a receipt, or none: a hop\'s or a leader\'s receipt does not say its recipients have it.';
const NO_HOP_ORDER =
    'An edge-ordered send carries no hop order: orderingKey and seq belong to a channel without order.';

/**
 * An edge-ordered send is a whole-room, volatile send over `ws`, `rtc` or `rtc-with-ws-fallback`, whose receipt, when
 * it asks one, is every recipient's. Every other shape is refused before the send takes a position, so it leaves no
 * hole.
 */
export function validateEdgeOrderSend(send: EdgeOrderSendOptions): readonly RallarValidationIssue[] {
    return toEdgeOrderSendRefusals(send)
        .filter((refusal) => refusal.refused)
        .map(({ path, message }) => ({ path, code: 'unsupported', message }));
}

/**
 * Whether a lost copy of the send comes back: it is at-least-once and asks a receipt, once the channel's defaults
 * filled what the send left out. Receivers wait for such a send while it can still arrive, and never for any other:
 * the newest message wins and a late one is dropped.
 */
export function isEdgeOrderRetriedSend(send: Pick<BrowserMessageSendDefaults, 'reliability' | 'ack' | 'qos'>): boolean {
    const delivery = send.qos?.delivery?.algo ?? send.reliability;
    const receipted = send.qos?.ack === undefined ? send.ack !== 'none' : send.qos.ack.algo !== 'none';
    return delivery === 'at-least-once' && receipted;
}

function toEdgeOrderSendRefusals(send: EdgeOrderSendOptions): readonly EdgeOrderSendRefusal[] {
    const { qos } = send;
    return [
        {
            path: '$.strategy',
            refused: send.strategy === 'ws-then-rtc',
            message: 'An edge-ordered send takes the ws, rtc or rtc-with-ws-fallback strategy.'
        },
        { path: '$.ack', refused: send.ack === 'group-leader', message: EVERY_RECIPIENT },
        {
            path: '$.qos.ack',
            refused: qos?.ack !== undefined && qos.ack.algo !== 'receiver' && qos.ack.algo !== 'none',
            message: EVERY_RECIPIENT
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
