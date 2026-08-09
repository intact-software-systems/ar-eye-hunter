/**
 * Deterministic rendezvous scoring shared by RTT-reporting peer selection and
 * bootstrap peer selection. Scores depend only on (groupKey, localSessionId,
 * peerSessionId), so every session computes the same ranking for itself
 * without coordination, and different sessions get de-correlated rankings.
 */
export function rendezvousScore(
    localSessionId: string,
    peerSessionId: string,
    groupKey = '',
): string {
    return `${hashString(`${groupKey}:${localSessionId}:${peerSessionId}`)}`.padStart(10, '0');
}

function hashString(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}
