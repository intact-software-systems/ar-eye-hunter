import type { RallarGameAuthorityDiagnostics, RallarGameAuthorityDiagnosticsInput } from './types.ts';

export function deriveRallarGameAuthorityDiagnostics(
    input: RallarGameAuthorityDiagnosticsInput
): RallarGameAuthorityDiagnostics {
    const generatedAtEpochMs = input.nowEpochMs ?? Date.now();
    const status = input.status;
    return {
        generatedAtEpochMs,
        phase: status.phase,
        roomId: status.roomId,
        localPeerId: status.localPeerId,
        authority: status.authority,
        pendingCommandCount: status.pendingCommandCount,
        peerAssist: status.peerAssist,
        snapshotAgeMs: status.lastSnapshotAtEpochMs === undefined
            ? undefined
            : Math.max(0, generatedAtEpochMs - status.lastSnapshotAtEpochMs),
        eventAgeMs: status.lastEventAtEpochMs === undefined
            ? undefined
            : Math.max(0, generatedAtEpochMs - status.lastEventAtEpochMs),
        issues: uniqueSorted([
            ...deriveIssues(status, generatedAtEpochMs),
            ...(input.issues ?? [])
        ])
    };
}

function deriveIssues(
    status: RallarGameAuthorityDiagnosticsInput['status'],
    nowEpochMs: number
): readonly string[] {
    const issues: string[] = [];

    if (!status.roomId) {
        issues.push('no-room');
    }

    if (!status.localPeerId) {
        issues.push('no-local-peer');
    }

    if (status.pendingCommandCount > 0) {
        issues.push('pending-commands');
    }

    if (status.authority.epoch < 0 || !Number.isSafeInteger(status.authority.epoch)) {
        issues.push('invalid-authority');
    }

    if (status.authorityTtlMs !== undefined && status.authorityTtlMs > 0) {
        const lastAuthoritySeenAtEpochMs = status.lastAuthoritySeenAtEpochMs ?? 0;
        if (nowEpochMs - lastAuthoritySeenAtEpochMs > status.authorityTtlMs) {
            issues.push('stale-authority');
        }
    }

    if (
        status.peerAssist.enabled &&
        status.peerAssist.snapshotRepairEnabled &&
        status.peerAssist.readyPeerIds.length === 0
    ) {
        issues.push('peer-assist-not-ready');
    }

    if (status.phase === 'degraded') {
        issues.push('degraded');
    }

    if (status.phase === 'error') {
        issues.push('error');
    }

    return issues;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
    return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
