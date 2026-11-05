/** The outbound admission state keys of one ordering track: its head, its messages by sequence, its recipients. */

/** The last sequence the outbound minted on one track; written beside the sender version that fences it. */
export function toALOutboundOrderingHeadKey(namespace: string, trackKey: string): string {
    return `${namespace}:ordering-head:${trackKey}`;
}

/** The last sequence the outbound sent one recipient on one track; written beside the head under the same fence. */
export function toALOutboundSentPositionKey(namespace: string, trackKey: string, recipientPeerId: string): string {
    return `${namespace}:sent-position:${JSON.stringify([trackKey, recipientPeerId])}`;
}

/** The message the outbound admitted at one sequence of one track. */
export function toALOutboundOrderingMessageKey(namespace: string, trackKey: string, seq: number): string {
    return `${namespace}:ordering-message:${JSON.stringify([trackKey, seq])}`;
}
