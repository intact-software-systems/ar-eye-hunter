import {
    CONTROL_RETENTION_PLAN_LIMITS,
    type ControlRetentionCandidate,
} from './control-retention.ts';
import {
    canonicalControlRetentionJson,
    controlRetentionLimitError,
} from './control-retention-canonical.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from './control-snapshots.ts';

export type ControlScaleRetentionOptions = Readonly<{
    candidateCount?: number;
    distributedRunsPerCandidate?: number;
    fleetReportsPerCandidate?: number;
}>;

export type ControlScaleRetentionFixture = Readonly<{
    candidates: readonly ControlRetentionCandidate[];
    wouldDeleteRunIds: readonly string[];
    wouldDeleteDistributedRunIds: readonly string[];
    wouldDeleteFleetReportIds: readonly string[];
}>;

export function createControlScaleRetention(
    options: ControlScaleRetentionOptions | undefined,
    runs: readonly ControlRunSnapshot[],
    distributedRuns: readonly ControlDistributedRunSnapshot[],
): ControlScaleRetentionFixture {
    const candidateCount = boundedInteger(
        options?.candidateCount ?? 0,
        'retention.candidateCount',
        0,
        Math.min(runs.length, CONTROL_RETENTION_PLAN_LIMITS.candidates),
    );
    const distributedCount = boundedInteger(
        options?.distributedRunsPerCandidate ?? 1,
        'retention.distributedRunsPerCandidate',
        0,
        CONTROL_RETENTION_PLAN_LIMITS.collectionItems,
    );
    const fleetCount = boundedInteger(
        options?.fleetReportsPerCandidate ?? Math.min(1, distributedCount),
        'retention.fleetReportsPerCandidate',
        0,
        distributedCount,
    );
    assertPreviewEnvelopeNodes(candidateCount, distributedCount, fleetCount);
    if (candidateCount * distributedCount > CONTROL_RETENTION_PLAN_LIMITS.collectionItems) {
        throw new Error('Retention distributed consequences exceed the shared collection bound.');
    }
    const candidates = Array.from({ length: candidateCount }, (_, ordinal) => {
        const linked = Array.from({ length: distributedCount }, (_, linkOrdinal) => ({
            distributedRunId: linkOrdinal === 0
                ? distributedRuns[ordinal]!.distributedRunId
                : `${distributedRuns[ordinal]!.distributedRunId}-linked-${padded(linkOrdinal)}`,
            state: 'passed' as const,
        }));
        return {
            runId: runs[ordinal]!.runId,
            createdAtEpochMs: runs[ordinal]!.createdAtEpochMs,
            updatedAtEpochMs: runs[ordinal]!.updatedAtEpochMs,
            connectedAgentCount: runs[ordinal]!.agents.length,
            issuedRunTokenCount: 0,
            distributedRuns: linked,
            fleetReportIds: linked.slice(0, fleetCount).map(row => row.distributedRunId),
        };
    });
    const fixture = {
        candidates,
        wouldDeleteRunIds: candidates.map(candidate => candidate.runId),
        wouldDeleteDistributedRunIds: candidates.flatMap(candidate =>
            candidate.distributedRuns.map(run => run.distributedRunId)
        ),
        wouldDeleteFleetReportIds: candidates.flatMap(candidate => candidate.fleetReportIds),
    };
    assertPreviewCanonicalBudget(fixture);
    return fixture;
}

export function boundedInteger(
    value: number,
    label: string,
    minimum: number,
    maximum: number,
): number {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${label} must be a safe integer from ${minimum} through ${maximum}.`);
    }
    return value;
}

function assertPreviewEnvelopeNodes(
    candidates: number,
    distributedPerCandidate: number,
    fleetPerCandidate: number,
): void {
    // Includes the wrapper, candidate records, and duplicated global ID arrays.
    const nodes = 27 + candidates * (
        16 + 6 * distributedPerCandidate + 2 * fleetPerCandidate
    );
    if (nodes > CONTROL_RETENTION_PLAN_LIMITS.canonicalNodes) {
        throw controlRetentionLimitError('canonicalNodes');
    }
}

function assertPreviewCanonicalBudget(fixture: ControlScaleRetentionFixture): void {
    canonicalControlRetentionJson({
        deletedRunIds: [],
        retainedRuns: fixture.candidates.length + 1,
        maxRuns: 1,
        dryRun: true,
        wouldDeleteRuns: fixture.candidates,
        wouldDeleteRunIds: fixture.wouldDeleteRunIds,
        wouldDeleteDistributedRunIds: fixture.wouldDeleteDistributedRunIds,
        wouldDeleteFleetReportIds: fixture.wouldDeleteFleetReportIds,
        projectedRetainedRuns: 1,
        preserves: { connectedAgentSockets: true, storedArtifactFiles: true },
        planToken: 'scale-fixture-plan-token',
    });
}

function padded(value: number): string {
    return String(value).padStart(6, '0');
}
