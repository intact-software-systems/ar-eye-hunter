/** Exact UTF-16 code-unit order for durable RTC topology identities. */
export function compareRtcTopologyIdentifiers(
    left: string,
    right: string,
): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
