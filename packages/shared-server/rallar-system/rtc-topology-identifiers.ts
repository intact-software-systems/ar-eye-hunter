/** Exact UTF-16 code-unit order for durable RTC topology identities. */
export function compareRtcTopologyIdentifiers(
    left: string,
    right: string,
): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

/** Collision-safe unordered pair identity using the durable identifier order. */
export function toCanonicalRtcTopologyPairIdentity(
    left: string,
    right: string,
): string {
    const [first, second] = compareRtcTopologyIdentifiers(left, right) <= 0
        ? [left, right]
        : [right, left];
    return JSON.stringify([first, second]);
}
