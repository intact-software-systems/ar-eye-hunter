import {
    assertControlRetentionString as assertString,
    boundedControlRetentionArray as boundedArray,
    canonicalControlRetentionJson as canonicalJson,
    CONTROL_RETENTION_PLAN_LIMITS,
    controlRetentionLimitError as limitError
} from './control-retention-canonical.ts';
import type { ControlDistributedRunSnapshot, ControlRunSnapshot } from './control-snapshots.ts';
import type { ControlFleetRunReport } from './fleet-report.ts';
export {
    CONTROL_RETENTION_PLAN_LIMITS,
    type ControlRetentionPlanLimit,
    ControlRetentionPlanLimitError
} from './control-retention-canonical.ts';

export type ControlRetentionIssuedRunTokenMetadata = Readonly<{
    agentId: string;
    issuedAtEpochMs: number;
    expiresAtEpochMs: number;
}>;

export type ControlRetentionRunSafety = Readonly<{
    runId: string;
    connectedAgentIds: readonly string[];
    issuedRunTokens: readonly ControlRetentionIssuedRunTokenMetadata[];
    runStateFingerprint: string;
    issuedRunTokenStateFingerprint: string;
}>;

export type ControlRetentionPlanInput = Readonly<{
    maxRuns?: number;
    runs: readonly ControlRunSnapshot[];
    distributedRuns?: readonly ControlDistributedRunSnapshot[];
    fleetReports?: readonly ControlFleetRunReport[];
    runSafety: readonly ControlRetentionRunSafety[];
}>;

export type ControlRetentionCandidate = Readonly<{
    runId: string;
    createdAtEpochMs: number;
    updatedAtEpochMs: number;
    connectedAgentCount: number;
    issuedRunTokenCount: number;
    distributedRuns: readonly Readonly<{
        distributedRunId: string;
        state: ControlDistributedRunSnapshot['state'];
    }>[];
    fleetReportIds: readonly string[];
}>;

export type ControlRetentionPlan = Readonly<{
    maxRuns: number | undefined;
    currentRuns: number;
    projectedRetainedRuns: number;
    candidates: readonly ControlRetentionCandidate[];
    deletedRunIds: readonly string[];
    distributedRunIds: readonly string[];
    fleetReportIds: readonly string[];
    canonicalConsequence: string;
}>;

type CandidateConsequence = Readonly<{
    run: ControlRunSnapshot;
    safety: ControlRetentionRunSafety;
    distributedRuns: readonly ControlDistributedRunSnapshot[];
    fleetReports: readonly ControlFleetRunReport[];
}>;

export function planControlRunRetention(
    input: ControlRetentionPlanInput
): ControlRetentionPlan {
    assertMaxRuns(input.maxRuns);
    const runs = boundedArray(input.runs, 'runs');
    const distributedRuns = boundedArray(input.distributedRuns ?? [], 'distributedRuns');
    const fleetReports = boundedArray(input.fleetReports ?? [], 'fleetReports');
    const runSafety = boundedArray(input.runSafety, 'runSafety');
    assertUniqueRecords(runs, 'runId', 'control run');
    assertUniqueRecords(distributedRuns, 'distributedRunId', 'distributed run');
    assertUniqueRecords(fleetReports, 'distributedRunId', 'fleet report');
    assertUniqueRecords(runSafety, 'runId', 'run safety');
    const safetyByRunId = validateRunSafety(runs, runSafety);
    validateRunTimes(runs);

    const keepIds = retainedRunIds(runs, input.maxRuns);
    const deletedRuns = keepIds === undefined
        ? []
        : runs.filter((run) => !keepIds.has(run.runId));
    if (deletedRuns.length > CONTROL_RETENTION_PLAN_LIMITS.candidates) {
        throw limitError('candidates');
    }

    const deletedIds = new Set(deletedRuns.map((run) => run.runId));
    const linkedDistributedRuns = distributedRuns.filter((run) => deletedIds.has(run.controlRunId));
    const distributedByControlId = new Map<string, ControlDistributedRunSnapshot[]>();
    for (const run of linkedDistributedRuns) {
        const linked = distributedByControlId.get(run.controlRunId) ?? [];
        linked.push(run);
        distributedByControlId.set(run.controlRunId, linked);
    }
    const fleetByDistributedId = new Map(
        fleetReports.map((report) => [report.distributedRunId, report])
    );
    const consequences = deletedRuns.map((run): CandidateConsequence => {
        const linked = distributedByControlId.get(run.runId) ?? [];
        return {
            run,
            safety: safetyByRunId.get(run.runId)!,
            distributedRuns: linked,
            fleetReports: linked.flatMap((item) => {
                const report = fleetByDistributedId.get(item.distributedRunId);
                return report ? [report] : [];
            })
        };
    });
    const candidates = consequences.map(toCandidate);
    const distributedRunIds = linkedDistributedRuns.map((run) => run.distributedRunId);
    const fleetReportIds = distributedRunIds.filter((id) => fleetByDistributedId.has(id));
    const currentRuns = runs.length;
    const projectedRetainedRuns = currentRuns - deletedRuns.length;
    const canonicalConsequence = canonicalJson({
        schemaVersion: 1,
        maxRuns: input.maxRuns ?? null,
        currentRuns,
        projectedRetainedRuns,
        deletedRunIds: deletedRuns.map((run) => run.runId),
        distributedRunIds,
        fleetReportIds,
        candidates: consequences.map(toCanonicalConsequence)
    });

    return {
        maxRuns: input.maxRuns,
        currentRuns,
        projectedRetainedRuns,
        candidates,
        deletedRunIds: deletedRuns.map((run) => run.runId),
        distributedRunIds,
        fleetReportIds,
        canonicalConsequence
    };
}

function retainedRunIds(
    runs: readonly ControlRunSnapshot[],
    maxRuns: number | undefined
): Set<string> | undefined {
    if (maxRuns === undefined || maxRuns <= 0 || runs.length <= maxRuns) {
        return undefined;
    }
    return new Set(
        runs.map((run, insertionIndex) => ({ run, insertionIndex }))
            .sort((left, right) =>
                right.run.updatedAtEpochMs - left.run.updatedAtEpochMs ||
                left.insertionIndex - right.insertionIndex
            )
            .slice(0, maxRuns)
            .map(({ run }) => run.runId)
    );
}

function toCandidate(consequence: CandidateConsequence): ControlRetentionCandidate {
    return {
        runId: consequence.run.runId,
        createdAtEpochMs: consequence.run.createdAtEpochMs,
        updatedAtEpochMs: consequence.run.updatedAtEpochMs,
        connectedAgentCount: consequence.safety.connectedAgentIds.length,
        issuedRunTokenCount: consequence.safety.issuedRunTokens.length,
        distributedRuns: consequence.distributedRuns.map((run) => ({
            distributedRunId: run.distributedRunId,
            state: run.state
        })),
        fleetReportIds: consequence.fleetReports.map((report) => report.distributedRunId)
    };
}

function toCanonicalConsequence(consequence: CandidateConsequence): unknown {
    return {
        run: consequence.run,
        connectedAgentIds: [...consequence.safety.connectedAgentIds].sort(compareText),
        connectedAgentCount: consequence.safety.connectedAgentIds.length,
        issuedRunTokens: consequence.safety.issuedRunTokens
            .map(({ agentId, issuedAtEpochMs, expiresAtEpochMs }) => ({
                agentId,
                issuedAtEpochMs,
                expiresAtEpochMs
            }))
            .sort(compareTokenMetadata),
        issuedRunTokenCount: consequence.safety.issuedRunTokens.length,
        runStateFingerprint: consequence.safety.runStateFingerprint,
        issuedRunTokenStateFingerprint: consequence.safety.issuedRunTokenStateFingerprint,
        distributedRuns: [...consequence.distributedRuns]
            .sort((left, right) => compareText(left.distributedRunId, right.distributedRunId)),
        fleetReports: [...consequence.fleetReports]
            .sort((left, right) => compareText(left.distributedRunId, right.distributedRunId))
    };
}

function validateRunSafety(
    runs: readonly ControlRunSnapshot[],
    safety: readonly ControlRetentionRunSafety[]
): Map<string, ControlRetentionRunSafety> {
    const runIds = new Set(runs.map((run) => run.runId));
    const byRunId = new Map<string, ControlRetentionRunSafety>();
    for (const entry of safety) {
        if (!runIds.has(entry.runId)) {
            throw new TypeError(`Unknown run safety ${entry.runId}.`);
        }
        const connectedAgentIds = boundedArray(entry.connectedAgentIds, 'connectedAgentIds');
        assertUniqueStrings(connectedAgentIds, 'connected agent');
        const tokens = boundedArray(entry.issuedRunTokens, 'issuedRunTokens');
        assertString(entry.runStateFingerprint, 'run state fingerprint');
        assertString(entry.issuedRunTokenStateFingerprint, 'issued token fingerprint');
        for (const token of tokens) {
            const keys = Object.keys(token).sort(compareText);
            if (keys.join(',') !== 'agentId,expiresAtEpochMs,issuedAtEpochMs') {
                throw new TypeError('Issued token metadata must contain only secret-free fields.');
            }
            assertString(token.agentId, 'issued token agentId');
            assertSafeInteger(token.issuedAtEpochMs, 'issuedAtEpochMs');
            assertSafeInteger(token.expiresAtEpochMs, 'expiresAtEpochMs');
        }
        byRunId.set(entry.runId, entry);
    }
    for (const run of runs) {
        if (!byRunId.has(run.runId)) {
            throw new TypeError(`Missing run safety ${run.runId}.`);
        }
    }
    return byRunId;
}

function validateRunTimes(runs: readonly ControlRunSnapshot[]): void {
    for (const run of runs) {
        assertSafeInteger(run.createdAtEpochMs, 'createdAtEpochMs');
        assertSafeInteger(run.updatedAtEpochMs, 'updatedAtEpochMs');
    }
}

function assertMaxRuns(value: number | undefined): void {
    if (value !== undefined) {
        assertSafeInteger(value, 'maxRuns');
    }
}

function assertSafeInteger(value: unknown, label: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new TypeError(`${label} must be a safe integer.`);
    }
}

function assertUniqueRecords<T>(
    values: readonly T[],
    key: keyof T,
    label: string
): void {
    const identities = values.map((value) => {
        if (!value || typeof value !== 'object') {
            throw new TypeError(`${label} must be an object.`);
        }
        const identity = value[key];
        assertString(identity, `${label} identity`);
        return identity;
    });
    assertUniqueStrings(identities, label);
}

function assertUniqueStrings(values: readonly string[], label: string): void {
    const seen = new Set<string>();
    for (const value of values) {
        assertString(value, label);
        if (seen.has(value)) {
            throw new TypeError(`Duplicate ${label} ${value}.`);
        }
        seen.add(value);
    }
}

function compareTokenMetadata(
    left: ControlRetentionIssuedRunTokenMetadata,
    right: ControlRetentionIssuedRunTokenMetadata
): number {
    return compareText(left.agentId, right.agentId) ||
        left.issuedAtEpochMs - right.issuedAtEpochMs ||
        left.expiresAtEpochMs - right.expiresAtEpochMs;
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
