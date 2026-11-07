/**
 * The outbound admission state keys of one ordering track: its head, its messages by sequence, its recipients, and the
 * room-wide position its session's carriers share.
 */

/** The last sequence the outbound minted on one track; written beside the sender version that fences it. */
export function toALOutboundOrderingHeadKey(namespace: string, trackKey: string): string {
    return `${namespace}:ordering-head:${trackKey}`;
}

/** The last sequence the outbound sent one recipient on one track; written beside the head under the same fence. */
export function toALOutboundSentPositionKey(namespace: string, trackKey: string, recipientPeerId: string): string {
    return `${namespace}:sent-position:${JSON.stringify([trackKey, recipientPeerId])}`;
}

/**
 * The sequences carriers of the session sent one track to an audience they did not record (a WS leg hands its
 * audience to the server) and no receipt has named yet; written beside the shared head under its own guard.
 */
export function toALOutboundRoomSentFloorKey(namespace: string, trackKey: string): string {
    return `${namespace}:room-sent-floor:${trackKey}`;
}

/** The message the outbound admitted at one sequence of one track. */
export function toALOutboundOrderingMessageKey(namespace: string, trackKey: string, seq: number): string {
    return `${namespace}:ordering-message:${JSON.stringify([trackKey, seq])}`;
}

/** The start every `ordering-message` key of one track shares and no key of another track does. */
export function toALOutboundOrderingTrackPrefix(namespace: string, trackKey: string): string {
    return `${namespace}:ordering-message:${JSON.stringify([trackKey]).slice(0, -1)},`;
}

export interface ALOutboundOrderingPosition {
    readonly trackKey: string;
    readonly seq: number;
}

/** The track and sequence an `ordering-message` key names; undefined for a key of another family or namespace. */
export function decodeALOutboundOrderingMessageKey(
    namespace: string,
    key: string
): ALOutboundOrderingPosition | undefined {
    const family = `${namespace}:ordering-message:`;
    if (!key.startsWith(family)) {
        return undefined;
    }
    let tuple: unknown;
    try {
        tuple = JSON.parse(key.slice(family.length));
    }
    catch {
        return undefined;
    }
    if (!Array.isArray(tuple) || tuple.length !== 2) {
        return undefined;
    }
    const [trackKey, seq]: unknown[] = tuple;
    return typeof trackKey === 'string' && typeof seq === 'number' &&
            toALOutboundOrderingMessageKey(namespace, trackKey, seq) === key
        ? { trackKey, seq }
        : undefined;
}
