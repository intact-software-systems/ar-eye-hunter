import type {
    RallarBlackBoxDistributedRunState,
    RallarBlackBoxGeoLocation,
} from './distributed-run.ts';

export const RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION = 1;

export type ControlFleetAgentState =
    | 'passed'
    | 'failed'
    | 'missing'
    | 'running'
    | 'cancelled'
    | 'timed-out'
    | 'unknown';

export type ControlFleetAgentLabel = Readonly<{
    agentId: string;
    region?: string;
    provider?: string;
    datacenter?: string;
    hostId?: string;
    agentPoolId?: string;
    deploymentId?: string;
    browserName?: string;
    browserVersion?: string;
    os?: string;
    tags?: readonly string[];
    location?: RallarBlackBoxGeoLocation;
}>;

export type ControlFleetTimingDistribution = Readonly<{
    count: number;
    minMs?: number;
    p50Ms?: number;
    p90Ms?: number;
    p95Ms?: number;
    maxMs?: number;
}>;

export type ControlFleetFailureSignature = Readonly<{
    signatureId: string;
    category: 'targeting' | 'readiness' | 'barrier' | 'command' | 'diagnostic' | 'runtime' | 'unknown';
    title: string;
    normalizedMessage: string;
    code?: string;
    recipeId?: string;
    commandKind?: string;
    diagnosticTypeId?: string;
    transport?: string;
    count: number;
    firstSeenAtEpochMs?: number;
    lastSeenAtEpochMs?: number;
    affectedAgents: readonly string[];
    affectedRegions: readonly string[];
    affectedRuns: readonly string[];
    likelyCause: string;
    nextAction: string;
}>;

export type ControlFleetAgentRunOutcome = Readonly<{
    agentId: string;
    label: ControlFleetAgentLabel;
    state: ControlFleetAgentState;
    ok: boolean;
    missing: boolean;
    flaky: boolean;
    stale: boolean;
    commandCount: number;
    failedCommandCount: number;
    resultCount: number;
    eventCount: number;
    diagnosticCount: number;
    reconnectCount: number;
    durationMs?: number;
    lastHeartbeatAtEpochMs?: number;
    failureSignatureIds: readonly string[];
}>;

export type ControlFleetRegionSummary = Readonly<{
    region: string;
    provider?: string;
    agentCount: number;
    passed: number;
    failed: number;
    missing: number;
    flaky: number;
    stale: number;
    passRate: number;
    timing: ControlFleetTimingDistribution;
    dominantFailureSignatureId?: string;
}>;

export type ControlFleetRunReport = Readonly<{
    fleetReportSchemaVersion: typeof RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION;
    distributedRunId: string;
    controlRunId: string;
    generatedAtEpochMs: number;
    state: RallarBlackBoxDistributedRunState;
    ok: boolean;
    group: Readonly<{
        applicationId: string;
        workspaceId: string;
        groupId: string;
    }>;
    recipeIds: readonly string[];
    runDurationMs?: number;
    summary: Readonly<{
        agents: number;
        regions: number;
        passed: number;
        failed: number;
        missing: number;
        flaky: number;
        stale: number;
        passRate: number;
        failureGroups: number;
    }>;
    timing: Readonly<{
        run: ControlFleetTimingDistribution;
        commands: ControlFleetTimingDistribution;
    }>;
    agents: readonly ControlFleetAgentRunOutcome[];
    regions: readonly ControlFleetRegionSummary[];
    failureSignatures: readonly ControlFleetFailureSignature[];
    artifactRefs: Readonly<{
        distributedRun: string;
        controlRun: string;
        fleetReport: string;
    }>;
}>;

export type ControlFleetAggregateReport = Readonly<{
    generatedAtEpochMs: number;
    reportCount: number;
    runCount: number;
    agentCount: number;
    regionCount: number;
    passRate: number;
    staleAgentCount: number;
    flakyAgentCount: number;
    failureGroupCount: number;
    timing: Readonly<{
        runs: ControlFleetTimingDistribution;
        commands: ControlFleetTimingDistribution;
    }>;
    regions: readonly ControlFleetRegionSummary[];
    failureSignatures: readonly ControlFleetFailureSignature[];
}>;

export type ControlFleetReportFiles = Readonly<Record<
    'fleet-report.json' | 'summary.md' | 'agent-results.csv' | 'failure-signatures.csv',
    string
>>;

export type ControlFleetReportBundle = Readonly<{
    fleetReportSchemaVersion: typeof RALLAR_BLACK_BOX_FLEET_REPORT_SCHEMA_VERSION;
    distributedRunId: string;
    generatedAtEpochMs: number;
    files: ControlFleetReportFiles;
}>;

export type ControlFleetReportsResponse = Readonly<{
    reports: readonly ControlFleetRunReport[];
    aggregate: ControlFleetAggregateReport;
}>;
