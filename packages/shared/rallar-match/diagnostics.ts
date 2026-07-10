import type {
    RallarMatchDiagnostics,
    RallarMatchDiagnosticsInput,
} from './types.ts';

export function deriveRallarMatchDiagnostics(
    input: RallarMatchDiagnosticsInput,
): RallarMatchDiagnostics {
    const participants = input.participants ?? [];
    const standings = input.standings ?? [];
    const pendingCommandCount = input.pendingCommandCount ?? 0;
    const issues: string[] = [];

    if (participants.length === 0) {
        issues.push('no-participants');
    }
    if (standings.length === 0) {
        issues.push('no-standings');
    }
    if (!input.result) {
        issues.push('no-result');
    }
    if (input.authorityFresh === false) {
        issues.push('stale-authority');
    }
    if (pendingCommandCount > 0) {
        issues.push('pending-commands');
    }
    if (
        input.snapshotAgeMs !== undefined &&
        input.maxSnapshotAgeMs !== undefined &&
        input.snapshotAgeMs > input.maxSnapshotAgeMs
    ) {
        issues.push('stale-snapshot');
    }

    return {
        participantCount: participants.length,
        standingCount: standings.length,
        hasResult: input.result !== undefined,
        pendingCommandCount,
        snapshotAgeMs: input.snapshotAgeMs,
        issues,
    };
}
