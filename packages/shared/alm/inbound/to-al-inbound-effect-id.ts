/** The work identity of an inbound effect: its parts, each URI-encoded, joined by `:`. */
export function toALInboundEffectId(parts: readonly (number | string)[]): string {
    return parts.map((part) => encodeURIComponent(String(part))).join(':');
}
