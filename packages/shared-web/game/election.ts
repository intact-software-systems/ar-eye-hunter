import type {
    RallarGameHostCandidate,
    RallarGameHostCandidateReason,
    RallarGameHostCapability,
    RallarGameHostElectionInput,
    RallarGameHostElectionResult
} from './types.ts';

export const DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS = 15_000;
export const RALLAR_GAME_MISSING_CAPABILITY_SCORE = -1_000_000;
export const RALLAR_GAME_CANNOT_HOST_SCORE = -10_000_000;

export function scoreRallarGameHostCapability(
    capability: RallarGameHostCapability
): number {
    if (capability.canHost === false) {
        return RALLAR_GAME_CANNOT_HOST_SCORE;
    }

    const fps = clamp(capability.fps ?? 30, 0, 144);
    const hardwareConcurrency = clamp(capability.hardwareConcurrency ?? 2, 1, 64);
    const deviceMemoryGb = clamp(capability.deviceMemoryGb ?? 2, 0.5, 128);
    const rttMs = clamp(capability.rttMs ?? 150, 0, 2_000);
    const previousDisconnects = clamp(capability.previousDisconnects ?? 0, 0, 100);

    return Math.round(
        fps * 2 +
            hardwareConcurrency * 10 +
            deviceMemoryGb * 5 +
            Math.max(0, 250 - rttMs) -
            (capability.isMobile ? 120 : 0) -
            (capability.isBatterySaving ? 120 : 0) -
            previousDisconnects * 60 +
            (capability.scoreBias ?? 0)
    );
}

export function electRallarGameHost(
    input: RallarGameHostElectionInput
): RallarGameHostElectionResult {
    const nowEpochMs = input.nowEpochMs ?? Date.now();
    const capabilityTtlMs = input.capabilityTtlMs ??
        DEFAULT_RALLAR_GAME_CAPABILITY_TTL_MS;
    const capabilities = latestCapabilitiesByPeer(input.capabilities ?? []);
    const scoreHost = input.scoreHost ?? scoreRallarGameHostCapability;
    const peerIds = [...new Set(input.peerIds)].sort(comparePeerIds);
    const candidates = peerIds
        .map((peerId): RallarGameHostCandidate => {
            const capability = capabilities.get(peerId);
            const fresh = capability
                ? nowEpochMs - capability.reportedAtEpochMs <= capabilityTtlMs
                : false;

            if (!capability) {
                return fallbackCandidate(peerId, 'missing-capability');
            }

            if (!fresh) {
                return fallbackCandidate(peerId, 'stale-capability');
            }

            if (capability.canHost === false) {
                return {
                    peerId,
                    capability,
                    score: RALLAR_GAME_CANNOT_HOST_SCORE,
                    eligible: false,
                    reason: 'cannot-host'
                };
            }

            return {
                peerId,
                capability,
                score: scoreHost(capability),
                eligible: true,
                reason: 'fresh-capability'
            };
        })
        .sort(compareCandidates);
    const eligible = candidates.filter((candidate) => candidate.eligible);

    return {
        host: eligible[0],
        backup: eligible[1],
        candidates,
        nowEpochMs,
        capabilityTtlMs
    };
}

function fallbackCandidate(
    peerId: string,
    reason: Extract<RallarGameHostCandidateReason, 'missing-capability' | 'stale-capability'>
): RallarGameHostCandidate {
    return {
        peerId,
        score: RALLAR_GAME_MISSING_CAPABILITY_SCORE,
        eligible: true,
        reason
    };
}

function latestCapabilitiesByPeer(
    capabilities: readonly RallarGameHostCapability[]
): ReadonlyMap<string, RallarGameHostCapability> {
    const byPeer = new Map<string, RallarGameHostCapability>();
    for (const capability of capabilities) {
        const previous = byPeer.get(capability.peerId);
        if (
            !previous ||
            capability.reportedAtEpochMs > previous.reportedAtEpochMs
        ) {
            byPeer.set(capability.peerId, capability);
        }
    }
    return byPeer;
}

function compareCandidates(
    left: RallarGameHostCandidate,
    right: RallarGameHostCandidate
): number {
    if (left.eligible !== right.eligible) {
        return left.eligible ? -1 : 1;
    }

    if (left.score !== right.score) {
        return right.score - left.score;
    }

    return comparePeerIds(left.peerId, right.peerId);
}

function comparePeerIds(left: string, right: string): number {
    return left.localeCompare(right);
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
        return min;
    }

    return Math.min(max, Math.max(min, value));
}
