export const DEFAULT_RTT_REPORTING_DEGREE_LIMIT = 5;

export type RttReportingPeerSelectionInput = Readonly<{
    localSessionId: string;
    degreeLimit?: number;
    fallbackDegreeLimit?: number;
    overlayNextHopSessionIds?: readonly string[];
    activePeerSessionIds?: readonly string[];
    groupKey?: string;
}>;

export type RttReportingPeerSelection = Readonly<{
    degreeLimit: number;
    selectedPeerIds: readonly string[];
}>;

export function normalizeRttReportingDegreeLimit(
    value: number | undefined,
    fallback = DEFAULT_RTT_REPORTING_DEGREE_LIMIT,
): number {
    const candidate = value ?? fallback;
    return Number.isInteger(candidate) && candidate > 0
        ? candidate
        : DEFAULT_RTT_REPORTING_DEGREE_LIMIT;
}

export function selectRttReportingPeers(
    input: RttReportingPeerSelectionInput,
): RttReportingPeerSelection {
    const degreeLimit = normalizeRttReportingDegreeLimit(
        input.degreeLimit,
        input.fallbackDegreeLimit,
    );
    const selected: string[] = [];
    const seen = new Set<string>([input.localSessionId]);

    const add = (peerId: string): void => {
        if (selected.length >= degreeLimit || seen.has(peerId)) return;
        seen.add(peerId);
        selected.push(peerId);
    };

    for (const peerId of stableUnique(input.overlayNextHopSessionIds ?? []).sort()) {
        add(peerId);
    }

    const bootstrapCandidates = stableUnique(input.activePeerSessionIds ?? [])
        .filter((peerId) => !seen.has(peerId))
        .sort((a, b) =>
            rendezvousScore(input.localSessionId, a, input.groupKey)
                .localeCompare(rendezvousScore(input.localSessionId, b, input.groupKey))
        );

    for (const peerId of bootstrapCandidates) {
        add(peerId);
    }

    return { degreeLimit, selectedPeerIds: selected };
}

function stableUnique(values: readonly string[]): string[] {
    return [...new Set(values)];
}

function rendezvousScore(
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
