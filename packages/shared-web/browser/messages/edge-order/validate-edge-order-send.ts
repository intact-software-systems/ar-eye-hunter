import type { RallarTypedMessageSendOptions } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { BrowserMessageSendDefaults } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** The send options an edge-ordered channel decides itself or cannot order. */
export type EdgeOrderSendOptions = Pick<
    RallarTypedMessageSendOptions<never>,
    'strategy' | 'ack' | 'qos' | 'scope' | 'orderingKey' | 'seq'
>;

/** A peer-addressed send of a channel, and the server's peer id as its connect names it. */
export interface EdgeOrderPeer {
    readonly order: 'edge' | undefined;
    readonly peerId: string | undefined;
    readonly serverPeerId: string | undefined;
}

interface EdgeOrderSendRefusal {
    readonly path: string;
    readonly refused: boolean;
    readonly message: string;
}

const EVERY_RECIPIENT =
    'An edge-ordered send asks every recipient a receipt, or none: a hop\'s or a leader\'s receipt does not say its recipients have it.';
const NO_HOP_ORDER =
    'An edge-ordered send carries no hop order: orderingKey and seq belong to a channel without order.';

/**
 * An edge-ordered send is a volatile send to its room, or to an audience within it, over `ws`, `rtc` or
 * `rtc-with-ws-fallback`, whose receipt, when it asks one, is every recipient's. Every other shape is refused before
 * the send takes a position, so it leaves no hole.
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

/**
 * The server is not behind Rallar Web's sorter, so a send addressed to it takes no order. The connect names the
 * server's peer id, so this is judged after the send took its position, which the refusal then closes.
 */
export function validateEdgeOrderPeer(peer: EdgeOrderPeer): readonly RallarValidationIssue[] {
    return peer.order === 'edge' && peer.peerId !== undefined && peer.peerId === peer.serverPeerId
        ? [{
            path: '$.peerId',
            code: 'unsupported',
            message: 'An edge-ordered send addresses a browser session: the server sorts no stream.'
        }]
        : [];
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
        {
            path: '$.scope',
            refused: send.scope === 'world',
            message: 'An edge-ordered send names its room: one stream is one channel, room and audience.'
        },
        { path: '$.orderingKey', refused: send.orderingKey !== undefined, message: NO_HOP_ORDER },
        { path: '$.seq', refused: send.seq !== undefined, message: NO_HOP_ORDER },
        {
            path: '$.qos.durability',
            refused: qos?.durability !== undefined && qos.durability.algo !== 'volatile',
            message: 'An edge-ordered send is volatile: its order lives in memory only.'
        }
    ];
}
