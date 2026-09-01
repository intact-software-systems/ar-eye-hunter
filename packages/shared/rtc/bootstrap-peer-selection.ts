import { DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS } from '../services/web-rtc-group-manager.ts';
import { rendezvousScore } from './rendezvous-score.ts';

export const DEFAULT_BOOTSTRAP_DEGREE = 5;

export type BootstrapDegreeInput = Readonly<{
    bootstrapDegree?: number;
    maxPeerConnections?: number;
}>;

export type BootstrapPeerSelectionInput = Readonly<{
    localSessionId: string;
    memberSessionIds: readonly string[];
    groupKey: string;
    bootstrapDegree: number;
}>;

export function resolveBootstrapDegree(input: BootstrapDegreeInput): number {
    const requestedDegree = toPositiveInteger(input.bootstrapDegree) ??
        DEFAULT_BOOTSTRAP_DEGREE;
    const maxPeerConnections = toPositiveInteger(input.maxPeerConnections) ??
        DEFAULT_WEBRTC_MAX_PEER_CONNECTIONS;
    return Math.min(requestedDegree, maxPeerConnections);
}

/**
 * Deterministic bounded bootstrap set: each session ranks the group's other
 * members by rendezvous score and keeps the first `bootstrapDegree`. The
 * per-session asymmetric rankings make the union graph connected with high
 * probability at small degree without any coordination; WS relay remains the
 * correctness baseline when a bootstrap component is isolated.
 */
export function selectBootstrapPeers(
    input: BootstrapPeerSelectionInput
): readonly string[] {
    const candidates = [...new Set(input.memberSessionIds)]
        .filter((sessionId) => sessionId !== input.localSessionId)
        .sort((left, right) =>
            rendezvousScore(input.localSessionId, left, input.groupKey)
                .localeCompare(
                    rendezvousScore(input.localSessionId, right, input.groupKey)
                )
        );

    return candidates.slice(0, Math.max(0, input.bootstrapDegree));
}

function toPositiveInteger(value: number | undefined): number | undefined {
    return value !== undefined && Number.isInteger(value) && value > 0
        ? value
        : undefined;
}
