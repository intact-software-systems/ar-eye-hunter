import type { FleetGeographyLiveAgentEvidence } from
    '@shared-test/rallar-bb-test/fleet-geography.ts';
import type { ControlAgentBoardRow } from '../../control-agent-board.ts';

export function fleetLiveGeographyEvidenceFromBoardRows(
    rows: readonly ControlAgentBoardRow[],
    observedAtEpochMs?: number,
): readonly FleetGeographyLiveAgentEvidence[] {
    return rows.map((row) => ({
        agentId: row.agentId,
        state: liveState(row),
        connected: row.connected,
        synthetic: row.synthetic,
        ...(observedAtEpochMs === undefined ? {} : { observedAtEpochMs }),
        ...(row.lastSeenAtEpochMs === undefined
            ? {}
            : { lastSeenAtEpochMs: row.lastSeenAtEpochMs }),
        ...(row.lastHeartbeatAtEpochMs === undefined
            ? {}
            : { lastHeartbeatAtEpochMs: row.lastHeartbeatAtEpochMs }),
        ...optionalText('region', row.region ?? row.identity?.region),
        ...optionalText('provider', row.provider ?? row.identity?.provider),
        ...optionalText('datacenter', row.datacenter ?? row.identity?.datacenter),
        ...(row.identity?.location === undefined
            ? {}
            : { location: row.identity.location }),
        activeRunIds: uniqueSortedRunIds(row.activeRuns),
    })).sort((left, right) => compareText(left.agentId, right.agentId));
}

function liveState(
    row: ControlAgentBoardRow,
): FleetGeographyLiveAgentEvidence['state'] {
    if (row.targetStatus === 'stale') return 'stale';
    if (row.connected) return 'connected';
    if (row.targetStatus === 'offline' || !row.connected) return 'offline';
    return 'unknown';
}

function uniqueSortedRunIds(
    runs: ControlAgentBoardRow['activeRuns'],
): readonly string[] {
    return [...new Set(runs.map((run) => run.distributedRunId))]
        .sort(compareText);
}

function optionalText<Key extends 'region' | 'provider' | 'datacenter'>(
    key: Key,
    value: string | undefined,
): Readonly<Partial<Record<Key, string>>> {
    return value === undefined
        ? {} as Readonly<Partial<Record<Key, string>>>
        : { [key]: value } as Record<Key, string>;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
