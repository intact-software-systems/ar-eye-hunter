import type {
    RallarGameDiagnostics,
    RallarGameDiagnosticsInput,
} from './types.ts';

export function deriveRallarGameDiagnostics(
    input: RallarGameDiagnosticsInput,
): RallarGameDiagnostics {
    const generatedAtEpochMs = input.nowEpochMs ?? Date.now();
    const readyPeerIds = uniqueSorted([
        ...(input.peerReadiness?.readyPeerIds ?? []),
        ...(input.rtcStatus?.readyPeerIds ?? []),
    ]);
    const notReadyPeerIds = uniqueSorted(input.peerReadiness?.notReadyPeerIds ?? []);
    const knownPeerIds = uniqueSorted([
        ...(input.rtcStatus?.knownPeerIds ?? []),
        ...readyPeerIds,
        ...notReadyPeerIds,
    ]);
    const issues = deriveIssues(input);

    return {
        generatedAtEpochMs,
        phase: input.status.phase,
        roomId: input.status.roomId,
        localPeerId: input.status.localPeerId,
        directorPeerId: input.status.directorPeerId,
        directorEpoch: input.status.directorEpoch,
        directorIsFresh: input.status.directorIsFresh,
        recovery: input.status.recovery,
        hostPeerId: input.election?.host?.peerId,
        backupPeerId: input.election?.backup?.peerId,
        knownPeerIds,
        readyPeerIds,
        notReadyPeerIds,
        capabilityCount: input.capabilities?.length ?? 0,
        rtcPeerCount: input.rtcDiagnostics?.peerCount ??
            input.rtcStatus?.knownPeerIds.length ??
            0,
        rtcRelayPeerCount: input.rtcDiagnostics?.relayPeerCount,
        realtimeHealth: input.realtimeHealth ?? [],
        issues,
    };
}

function deriveIssues(input: RallarGameDiagnosticsInput): readonly string[] {
    const issues: string[] = [];

    if (!input.status.roomId) {
        issues.push('no-room');
    }

    if (!input.status.localPeerId) {
        issues.push('no-local-peer');
    }

    if (!input.status.directorPeerId) {
        issues.push('no-director');
    } else if (!input.status.directorIsFresh) {
        issues.push('stale-director');
    }

    if (input.status.recovery.status === 'recovering') {
        issues.push('recovering');
    }

    if (input.peerReadiness?.status === 'partial') {
        issues.push('partial-lane-readiness');
    }

    if (
        input.peerReadiness &&
        !['open', 'partial', 'empty'].includes(input.peerReadiness.status)
    ) {
        issues.push(`lane-${input.peerReadiness.status}`);
    }

    if (input.election && !input.election.host) {
        issues.push('no-electable-host');
    }

    return uniqueSorted(issues);
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
