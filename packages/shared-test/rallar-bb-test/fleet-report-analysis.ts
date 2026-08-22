import type {
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetRegionSummary,
    ControlFleetReportsResponse,
    ControlFleetRunReport,
    ControlFleetTimingDistribution
} from './fleet-report.ts';

export type FleetReportAnalysisWork = {
    reportVisits: number;
    outcomeVisits: number;
    indexInserts: number;
    cellLookups: number;
    failureSignatureVisits: number;
};

export type FleetReportDerivationPolicy = Readonly<{
    reportOrder: 'deterministic' | 'input';
    timedOutAsFailed: boolean;
    stableTieBreaks: boolean;
    textCollation: 'code-unit' | 'legacy-locale';
}>;

export const DEFAULT_FLEET_REPORT_DERIVATION_POLICY: FleetReportDerivationPolicy = Object.freeze({
    reportOrder: 'deterministic',
    timedOutAsFailed: true,
    stableTieBreaks: true,
    textCollation: 'code-unit'
});

export type FleetReportHeatmapRow = Readonly<{
    agent: ControlFleetAgentRunOutcome;
    region: string;
    provider: string;
    cells: readonly (ControlFleetAgentRunOutcome | undefined)[];
}>;

export type FleetReportTimingGroup = Readonly<{
    id: string;
    label: string;
    timing: ControlFleetTimingDistribution;
}>;

export type FleetReportDisplaySummary = Readonly<{
    runs: number;
    agents: number;
    regions: number;
    passRate: number;
    failureGroups: number;
    p95DurationMs?: number;
    stale: number;
}>;

export type FleetReportAgentDetail = Readonly<{
    agent: ControlFleetAgentRunOutcome;
    runs: readonly Readonly<{
        run: ControlFleetRunReport;
        outcome: ControlFleetAgentRunOutcome;
    }>[];
    totalRuns: number;
    omittedRuns: number;
    passed: number;
    failed: number;
    missing: number;
    reconnectCount: number;
    diagnosticCount: number;
}>;

export type FleetReportAnalysisLimits = Readonly<{
    heatmapAgentRows: number;
    heatmapRunColumns: number;
    regionRows: number;
    failureRows: number;
    timingGroups: number;
    missingLabelAgentIds: number;
    agentDetailRuns: number;
}>;

export const DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS: FleetReportAnalysisLimits = Object.freeze({
    heatmapAgentRows: 32,
    heatmapRunColumns: 8,
    regionRows: 24,
    failureRows: 24,
    timingGroups: 24,
    missingLabelAgentIds: 40,
    agentDetailRuns: 12
});

export type FleetReportWindow<T> = Readonly<{
    items: readonly T[];
    total: number;
    omitted: number;
}>;

export type FleetReportWindowRequest = Readonly<{
    startIndex?: number;
    limit?: number;
}>;

export type FleetReportBoundedWindow<T> =
    & FleetReportWindow<T>
    & Readonly<{
        startIndex: number;
        endIndexExclusive: number;
    }>;

export type FleetReportHeatmap = Readonly<{
    rows: readonly FleetReportHeatmapRow[];
    runs: readonly ControlFleetRunReport[];
    totalAgentRows: number;
    omittedAgentRows: number;
    totalRunColumns: number;
    omittedRunColumns: number;
}>;

export type FleetReportHeatmapWindowRequest = Readonly<{
    agentStartIndex?: number;
    runStartIndex?: number;
    agentLimit?: number;
    runLimit?: number;
}>;

export type FleetReportHeatmapWindow =
    & FleetReportHeatmap
    & Readonly<{
        agentStartIndex: number;
        agentEndIndexExclusive: number;
        runStartIndex: number;
        runEndIndexExclusive: number;
    }>;

export type FleetReportAgentDetailWindow =
    & FleetReportAgentDetail
    & Readonly<{
        startIndex: number;
        endIndexExclusive: number;
    }>;

export type FleetReportAnalysis = Readonly<{
    reports: readonly ControlFleetRunReport[];
    summary: FleetReportDisplaySummary;
    heatmap: FleetReportHeatmap;
    regions: FleetReportWindow<ControlFleetRegionSummary>;
    failures: FleetReportWindow<ControlFleetFailureSignature>;
    regionTiming: FleetReportWindow<FleetReportTimingGroup>;
    recipeTiming: FleetReportWindow<FleetReportTimingGroup>;
    missingLabelAgentIds: FleetReportWindow<string>;
    selectedAgent?: FleetReportAgentDetail;
    work: Readonly<FleetReportAnalysisWork>;
}>;

type MutableRegion = {
    region: string;
    provider?: string;
    agentIds: Set<string>;
    passed: number;
    failed: number;
    missing: number;
    flaky: number;
    stale: number;
    durations: number[];
    failureCounts: Map<string, number>;
};

type MutableFailure =
    & {
        -readonly [
            K in keyof Omit<ControlFleetFailureSignature, 'affectedAgents' | 'affectedRegions' | 'affectedRuns'>
        ]: ControlFleetFailureSignature[K];
    }
    & {
        affectedAgents: Set<string>;
        affectedRegions: Set<string>;
        affectedRuns: Set<string>;
    };

type AgentEntry = Readonly<{
    run: ControlFleetRunReport;
    outcome: ControlFleetAgentRunOutcome;
}>;

type MutableAgentAggregate = {
    agent: ControlFleetAgentRunOutcome;
    entries: AgentEntry[];
    passed: number;
    failed: number;
    missing: number;
    reconnectCount: number;
    diagnosticCount: number;
};

type AgentAggregate = Readonly<{
    agent: ControlFleetAgentRunOutcome;
    entries: readonly AgentEntry[];
    passed: number;
    failed: number;
    missing: number;
    reconnectCount: number;
    diagnosticCount: number;
}>;

type FleetReportSourceIndex = Readonly<{
    reports: readonly ControlFleetRunReport[];
    outcomesByRun: ReadonlyMap<string, ReadonlyMap<string, ControlFleetAgentRunOutcome>>;
    orderedAgents: readonly ControlFleetAgentRunOutcome[];
    agentAggregates: ReadonlyMap<string, AgentAggregate>;
    regions: ReadonlyMap<string, MutableRegion>;
    failures: ReadonlyMap<string, MutableFailure>;
    missingLabelAgentIds: ReadonlySet<string>;
    regionDurations: ReadonlyMap<string, readonly number[]>;
    regionDurationLabels: ReadonlyMap<string, string>;
    regionDurationIds: ReadonlyMap<string, string>;
    recipeDurations: ReadonlyMap<string, readonly number[]>;
    uniqueAgentIds: ReadonlySet<string>;
    uniqueRegionKeys: ReadonlySet<string>;
    staleAgentIds: ReadonlySet<string>;
    passedOutcomes: number;
    outcomeCount: number;
    work: FleetReportAnalysisWork;
    policy: FleetReportDerivationPolicy;
}>;

const FLEET_REPORT_COLLECTION_SOURCE = Symbol('fleet-report-collection-source');

export type FleetReportAnalysisCollection = Readonly<{
    reports: readonly ControlFleetRunReport[];
    summary: FleetReportDisplaySummary;
    regions: readonly ControlFleetRegionSummary[];
    failures: readonly ControlFleetFailureSignature[];
    regionTiming: readonly FleetReportTimingGroup[];
    recipeTiming: readonly FleetReportTimingGroup[];
    missingLabelAgentIds: readonly string[];
    work: Readonly<FleetReportAnalysisWork>;
    [FLEET_REPORT_COLLECTION_SOURCE]: FleetReportSourceIndex;
}>;

export function createFleetReportAnalysisWork(): FleetReportAnalysisWork {
    return {
        reportVisits: 0,
        outcomeVisits: 0,
        indexInserts: 0,
        cellLookups: 0,
        failureSignatureVisits: 0
    };
}

export function createFleetReportAnalysisCollection(
    input: Readonly<{
        reports: readonly ControlFleetRunReport[];
        response?: ControlFleetReportsResponse;
        policy?: Partial<FleetReportDerivationPolicy>;
    }>
): FleetReportAnalysisCollection {
    const work = createFleetReportAnalysisWork();
    const source = indexFleetReports(input.reports, work, input.policy ?? {});
    const regions = regionRowsFromIndex(source);
    const failures = failureRowsFromIndex(source);
    const regionTiming = timingGroupsFromDurations(
        source.regionDurations,
        source.policy,
        source.regionDurationLabels,
        source.regionDurationIds
    );
    const recipeTiming = timingGroupsFromDurations(
        source.recipeDurations,
        source.policy
    );
    const missingLabelAgentIds = [...source.missingLabelAgentIds]
        .sort(compareText);
    return {
        reports: source.reports,
        summary: source.reports.length === 0
            ? aggregateFallbackSummary(input.response)
            : displaySummaryFromIndex(source, failures.length),
        regions,
        failures,
        regionTiming,
        recipeTiming,
        missingLabelAgentIds,
        work,
        [FLEET_REPORT_COLLECTION_SOURCE]: source
    };
}

export function deriveFleetReportHeatmapWindow(
    collection: FleetReportAnalysisCollection,
    request: FleetReportHeatmapWindowRequest = {}
): FleetReportHeatmapWindow {
    return heatmapWindowFromIndex(
        collection[FLEET_REPORT_COLLECTION_SOURCE],
        collection.reports,
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.heatmapAgentRows,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.heatmapRunColumns
    );
}

export function deriveFleetReportRegionWindow(
    collection: FleetReportAnalysisCollection,
    request: FleetReportWindowRequest = {}
): FleetReportBoundedWindow<ControlFleetRegionSummary> {
    return boundedWindow(
        collection.regions,
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.regionRows
    );
}

export function deriveFleetReportFailureWindow(
    collection: FleetReportAnalysisCollection,
    request: FleetReportWindowRequest = {}
): FleetReportBoundedWindow<ControlFleetFailureSignature> {
    return boundedWindow(
        collection.failures,
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.failureRows
    );
}

export function deriveFleetReportRegionTimingWindow(
    collection: FleetReportAnalysisCollection,
    request: FleetReportWindowRequest = {}
): FleetReportBoundedWindow<FleetReportTimingGroup> {
    return boundedWindow(
        collection.regionTiming,
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.timingGroups
    );
}

export function deriveFleetReportRecipeTimingWindow(
    collection: FleetReportAnalysisCollection,
    request: FleetReportWindowRequest = {}
): FleetReportBoundedWindow<FleetReportTimingGroup> {
    return boundedWindow(
        collection.recipeTiming,
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.timingGroups
    );
}

export function deriveFleetReportMissingLabelAgentIdWindow(
    collection: FleetReportAnalysisCollection,
    request: FleetReportWindowRequest = {}
): FleetReportBoundedWindow<string> {
    return boundedWindow(
        collection.missingLabelAgentIds,
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.missingLabelAgentIds
    );
}

export function deriveFleetReportAgentDetailWindow(
    agentId: string,
    collection: FleetReportAnalysisCollection,
    request: FleetReportWindowRequest = {}
): FleetReportAgentDetailWindow | undefined {
    return agentDetailWindowFromIndex(
        agentId,
        collection[FLEET_REPORT_COLLECTION_SOURCE],
        request,
        DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.agentDetailRuns
    );
}

export function deriveFleetReportAnalysisFromCollection(
    collection: FleetReportAnalysisCollection,
    input: Readonly<{
        selectedAgentId?: string;
        limits?: Partial<FleetReportAnalysisLimits>;
    }> = {}
): FleetReportAnalysis {
    const limits = normalizeLimits(input.limits);
    const source = collection[FLEET_REPORT_COLLECTION_SOURCE];
    const cellLookupsBeforeProjection = collection.work.cellLookups;
    // This public compatibility projection has always accepted caller limits
    // above the Recipe Console's UI budgets. Keep those semantics independent
    // from the separately exported traversal helpers, which deliberately cap
    // each mounted window at the default UI maximum.
    const heatmap = compatibilityHeatmap(heatmapWindowFromIndex(
        source,
        collection.reports,
        {
            agentLimit: limits.heatmapAgentRows,
            runLimit: limits.heatmapRunColumns
        },
        limits.heatmapAgentRows,
        limits.heatmapRunColumns
    ));
    return {
        reports: collection.reports,
        summary: collection.summary,
        heatmap,
        regions: compatibilityWindow(boundedWindow(
            collection.regions,
            { limit: limits.regionRows },
            limits.regionRows
        )),
        failures: compatibilityWindow(boundedWindow(
            collection.failures,
            { limit: limits.failureRows },
            limits.failureRows
        )),
        regionTiming: compatibilityWindow(boundedWindow(
            collection.regionTiming,
            { limit: limits.timingGroups },
            limits.timingGroups
        )),
        recipeTiming: compatibilityWindow(boundedWindow(
            collection.recipeTiming,
            { limit: limits.timingGroups },
            limits.timingGroups
        )),
        missingLabelAgentIds: compatibilityWindow(
            boundedWindow(
                collection.missingLabelAgentIds,
                { limit: limits.missingLabelAgentIds },
                limits.missingLabelAgentIds
            )
        ),
        selectedAgent: input.selectedAgentId
            ? compatibilityAgentDetail(agentDetailWindowFromIndex(
                input.selectedAgentId,
                source,
                { limit: limits.agentDetailRuns },
                limits.agentDetailRuns
            ))
            : undefined,
        work: {
            ...collection.work,
            cellLookups: collection.work.cellLookups -
                cellLookupsBeforeProjection
        }
    };
}

export function sortFleetRunReports(
    reports: readonly ControlFleetRunReport[]
): readonly ControlFleetRunReport[] {
    return [...reports].sort((left, right) =>
        right.generatedAtEpochMs - left.generatedAtEpochMs ||
        compareText(left.distributedRunId, right.distributedRunId)
    );
}

export function deriveFleetReportHeatmapRows(
    reports: readonly ControlFleetRunReport[],
    runs: readonly ControlFleetRunReport[] = reports,
    options: Readonly<{
        agentLimit?: number;
        runLimit?: number;
        work?: FleetReportAnalysisWork;
        reportOrder?: FleetReportDerivationPolicy['reportOrder'];
        timedOutAsFailed?: boolean;
        stableTieBreaks?: boolean;
        textCollation?: FleetReportDerivationPolicy['textCollation'];
    }> = {}
): FleetReportHeatmap {
    const source = indexFleetReports(reports, options.work, options);
    return compatibilityHeatmap(heatmapWindowFromIndex(
        source,
        runs,
        {
            agentLimit: options.agentLimit ?? Number.POSITIVE_INFINITY,
            runLimit: options.runLimit ?? Number.POSITIVE_INFINITY
        },
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY
    ));
}

export function deriveFleetReportRegionRows(
    reports: readonly ControlFleetRunReport[],
    policy: Partial<FleetReportDerivationPolicy> = {}
): readonly ControlFleetRegionSummary[] {
    return regionRowsFromIndex(indexFleetReports(reports, undefined, policy));
}

export function deriveFleetReportMissingLabelAgentIds(
    reports: readonly ControlFleetRunReport[]
): readonly string[] {
    return [...indexFleetReports(reports).missingLabelAgentIds]
        .sort(compareText);
}

export function deriveFleetReportAgentDetail(
    agentId: string,
    reports: readonly ControlFleetRunReport[],
    options: Readonly<{
        runLimit?: number;
        reportOrder?: FleetReportDerivationPolicy['reportOrder'];
        timedOutAsFailed?: boolean;
        stableTieBreaks?: boolean;
        textCollation?: FleetReportDerivationPolicy['textCollation'];
    }> = {}
): FleetReportAgentDetail | undefined {
    return compatibilityAgentDetail(agentDetailWindowFromIndex(
        agentId,
        indexFleetReports(reports, undefined, options),
        {
            limit: options.runLimit ??
                DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.agentDetailRuns
        },
        Number.POSITIVE_INFINITY
    ));
}

export function deriveFleetReportDisplaySummary(
    reports: readonly ControlFleetRunReport[],
    response: ControlFleetReportsResponse | undefined
): FleetReportDisplaySummary {
    if (reports.length === 0) {
        return aggregateFallbackSummary(response);
    }
    return displaySummaryFromIndex(indexFleetReports(reports));
}

export function deriveFleetReportFailureRows(
    reports: readonly ControlFleetRunReport[],
    policy: Partial<FleetReportDerivationPolicy> = {}
): readonly ControlFleetFailureSignature[] {
    return failureRowsFromIndex(indexFleetReports(reports, undefined, policy));
}

export function deriveFleetReportTimingGroupsByRegion(
    reports: readonly ControlFleetRunReport[],
    policy: Partial<FleetReportDerivationPolicy> = {}
): readonly FleetReportTimingGroup[] {
    const source = indexFleetReports(reports, undefined, policy);
    return timingGroupsFromDurations(
        source.regionDurations,
        source.policy,
        source.regionDurationLabels,
        source.regionDurationIds
    );
}

export function deriveFleetReportTimingGroupsByRecipe(
    reports: readonly ControlFleetRunReport[],
    policy: Partial<FleetReportDerivationPolicy> = {}
): readonly FleetReportTimingGroup[] {
    const source = indexFleetReports(reports, undefined, policy);
    return timingGroupsFromDurations(source.recipeDurations, source.policy);
}

export function deriveFleetReportTimingDistribution(
    values: readonly number[]
): ControlFleetTimingDistribution {
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);
    if (sorted.length === 0) {
        return { count: 0 };
    }
    return {
        count: sorted.length,
        minMs: sorted[0],
        p50Ms: nearestRank(sorted, 0.5),
        p90Ms: nearestRank(sorted, 0.9),
        p95Ms: nearestRank(sorted, 0.95),
        maxMs: sorted[sorted.length - 1]
    };
}

export function deriveFleetReportAnalysis(
    input: Readonly<{
        reports: readonly ControlFleetRunReport[];
        response?: ControlFleetReportsResponse;
        selectedAgentId?: string;
        limits?: Partial<FleetReportAnalysisLimits>;
    }>
): FleetReportAnalysis {
    return deriveFleetReportAnalysisFromCollection(
        createFleetReportAnalysisCollection({
            reports: input.reports,
            response: input.response
        }),
        {
            selectedAgentId: input.selectedAgentId,
            limits: input.limits
        }
    );
}

function indexFleetReports(
    reports: readonly ControlFleetRunReport[],
    suppliedWork?: FleetReportAnalysisWork,
    suppliedPolicy: Partial<FleetReportDerivationPolicy> = {}
): FleetReportSourceIndex {
    const work = suppliedWork ?? createFleetReportAnalysisWork();
    const policy = resolveDerivationPolicy(suppliedPolicy);
    const sortedReports = policy.reportOrder === 'input'
        ? [...reports]
        : sortFleetRunReports(reports);
    const outcomesByRun = new Map<string, ReadonlyMap<string, ControlFleetAgentRunOutcome>>();
    const mutableAgentAggregates = new Map<string, MutableAgentAggregate>();
    const regions = new Map<string, MutableRegion>();
    const failures = new Map<string, MutableFailure>();
    const missingLabelAgentIds = new Set<string>();
    const regionDurations = new Map<string, number[]>();
    const regionDurationLabels = new Map<string, string>();
    const regionDurationIds = new Map<string, string>();
    const recipeDurations = new Map<string, number[]>();
    const uniqueAgentIds = new Set<string>();
    const uniqueRegionKeys = new Set<string>();
    const staleAgentIds = new Set<string>();
    let passedOutcomes = 0;
    let outcomeCount = 0;

    sortedReports.forEach((report) => {
        work.reportVisits += 1;
        const outcomes = new Map<string, ControlFleetAgentRunOutcome>();
        outcomesByRun.set(report.distributedRunId, outcomes);
        if (report.runDurationMs !== undefined) {
            report.recipeIds.forEach((recipeId) => {
                appendMapValue(recipeDurations, recipeId, report.runDurationMs as number);
            });
        }
        report.failureSignatures.forEach((signature) => {
            work.failureSignatureVisits += 1;
            aggregateFailure(failures, signature, report.distributedRunId);
        });
        report.agents.forEach((outcome) => {
            work.outcomeVisits += 1;
            outcomes.set(outcome.agentId, outcome);
            work.indexInserts += 1;
            const aggregate = mutableAgentAggregates.get(outcome.agentId) ?? {
                agent: outcome,
                entries: [],
                passed: 0,
                failed: 0,
                missing: 0,
                reconnectCount: 0,
                diagnosticCount: 0
            };
            aggregate.entries.push({ run: report, outcome });
            if (outcome.state === 'passed') {
                aggregate.passed += 1;
            }
            if (
                outcome.state === 'failed' ||
                policy.timedOutAsFailed && outcome.state === 'timed-out'
            ) {
                aggregate.failed += 1;
            }
            if (outcome.missing) {
                aggregate.missing += 1;
            }
            aggregate.reconnectCount = Math.max(
                aggregate.reconnectCount,
                outcome.reconnectCount
            );
            aggregate.diagnosticCount += outcome.diagnosticCount;
            mutableAgentAggregates.set(outcome.agentId, aggregate);

            uniqueAgentIds.add(outcome.agentId);
            const regionKey = fleetReportRegionKey(outcome);
            uniqueRegionKeys.add(regionKey);
            outcomeCount += 1;
            if (outcome.ok) {
                passedOutcomes += 1;
            }
            if (outcome.stale) {
                staleAgentIds.add(outcome.agentId);
            }
            if (!outcome.label.region || !outcome.label.provider) {
                missingLabelAgentIds.add(outcome.agentId);
            }
            aggregateRegion(regions, regionKey, outcome, policy);
            if (outcome.durationMs !== undefined) {
                regionDurationLabels.set(
                    regionKey,
                    fleetReportRegionLabel(outcome)
                );
                regionDurationIds.set(
                    regionKey,
                    fleetReportRegionPublicId(outcome)
                );
                appendMapValue(regionDurations, regionKey, outcome.durationMs);
            }
        });
    });

    const agentAggregates = new Map<string, AgentAggregate>(
        [...mutableAgentAggregates].map(([agentId, aggregate]) => [
            agentId,
            Object.freeze({
                ...aggregate,
                entries: Object.freeze([...aggregate.entries])
            })
        ])
    );
    const orderedAgents = [...agentAggregates.values()].map(
        (aggregate) => aggregate.agent
    ).sort((left, right) => compareHeatmapAgents(left, right, policy));

    return {
        reports: sortedReports,
        outcomesByRun,
        orderedAgents,
        agentAggregates,
        regions,
        failures,
        missingLabelAgentIds,
        regionDurations,
        regionDurationLabels,
        regionDurationIds,
        recipeDurations,
        uniqueAgentIds,
        uniqueRegionKeys,
        staleAgentIds,
        passedOutcomes,
        outcomeCount,
        work,
        policy
    };
}

function heatmapWindowFromIndex(
    source: FleetReportSourceIndex,
    requestedRuns: readonly ControlFleetRunReport[],
    request: FleetReportHeatmapWindowRequest,
    maximumAgentLimit: number,
    maximumRunLimit: number
): FleetReportHeatmapWindow {
    const runs = requestedRuns === source.reports
        ? source.reports
        : source.policy.reportOrder === 'input'
        ? [...requestedRuns]
        : sortFleetRunReports(requestedRuns);
    const runWindow = boundedWindowRange(
        runs.length,
        request.runStartIndex,
        request.runLimit,
        maximumRunLimit
    );
    const agentWindow = boundedWindowRange(
        source.orderedAgents.length,
        request.agentStartIndex,
        request.agentLimit,
        maximumAgentLimit
    );
    const visibleRuns = runs.slice(
        runWindow.startIndex,
        runWindow.endIndexExclusive
    );
    const rows = source.orderedAgents.slice(
        agentWindow.startIndex,
        agentWindow.endIndexExclusive
    ).map((agent) => ({
        agent,
        region: agent.label.region ?? 'unlabeled',
        provider: agent.label.provider ?? 'unknown',
        cells: visibleRuns.map((run) => {
            source.work.cellLookups += 1;
            return source.outcomesByRun.get(run.distributedRunId)?.get(agent.agentId);
        })
    }));
    return {
        rows,
        runs: visibleRuns,
        totalAgentRows: source.orderedAgents.length,
        omittedAgentRows: source.orderedAgents.length - rows.length,
        totalRunColumns: runs.length,
        omittedRunColumns: runs.length - visibleRuns.length,
        agentStartIndex: agentWindow.startIndex,
        agentEndIndexExclusive: agentWindow.endIndexExclusive,
        runStartIndex: runWindow.startIndex,
        runEndIndexExclusive: runWindow.endIndexExclusive
    };
}

function regionRowsFromIndex(
    source: FleetReportSourceIndex
): readonly ControlFleetRegionSummary[] {
    return [...source.regions.values()].map((row) => {
        const total = row.passed + row.failed + row.missing;
        return {
            region: row.region,
            provider: row.provider,
            agentCount: row.agentIds.size,
            passed: row.passed,
            failed: row.failed,
            missing: row.missing,
            flaky: row.flaky,
            stale: row.stale,
            passRate: total > 0 ? row.passed / total : 0,
            timing: deriveFleetReportTimingDistribution(row.durations),
            dominantFailureSignatureId: [...row.failureCounts.entries()]
                .sort((left, right) =>
                    right[1] - left[1] ||
                    (source.policy.stableTieBreaks
                        ? compareText(left[0], right[0])
                        : 0)
                )[0]?.[0]
        };
    }).sort((left, right) =>
        right.failed - left.failed ||
        comparePolicyText(left.region, right.region, source.policy) ||
        (source.policy.stableTieBreaks
            ? comparePolicyText(
                left.provider ?? '',
                right.provider ?? '',
                source.policy
            )
            : 0)
    );
}

function failureRowsFromIndex(
    source: FleetReportSourceIndex
): readonly ControlFleetFailureSignature[] {
    return [...source.failures.values()].map((signature) => ({
        ...signature,
        affectedAgents: [...signature.affectedAgents].sort(),
        affectedRegions: [...signature.affectedRegions].sort(),
        affectedRuns: [...signature.affectedRuns].sort()
    })).sort((left, right) =>
        right.count - left.count ||
        (right.lastSeenAtEpochMs ?? 0) - (left.lastSeenAtEpochMs ?? 0) ||
        (source.policy.stableTieBreaks
            ? compareText(left.signatureId, right.signatureId)
            : 0)
    );
}

function timingGroupsFromDurations(
    durations: ReadonlyMap<string, readonly number[]>,
    policy: FleetReportDerivationPolicy,
    displayLabels?: ReadonlyMap<string, string>,
    displayIds?: ReadonlyMap<string, string>
): readonly FleetReportTimingGroup[] {
    return [...durations.entries()].map(([identity, values]) => ({
        identity,
        id: displayIds?.get(identity) ?? identity,
        label: displayLabels?.get(identity) ?? identity,
        timing: deriveFleetReportTimingDistribution(values)
    })).sort((left, right) =>
        (right.timing.p95Ms ?? 0) - (left.timing.p95Ms ?? 0) ||
        (policy.stableTieBreaks ? compareText(left.identity, right.identity) : 0)
    ).map(({ identity: _identity, ...group }) => group);
}

function agentDetailWindowFromIndex(
    agentId: string,
    source: FleetReportSourceIndex,
    request: FleetReportWindowRequest,
    maximumRunLimit: number
): FleetReportAgentDetailWindow | undefined {
    const aggregate = source.agentAggregates.get(agentId);
    if (!aggregate) {
        return undefined;
    }
    const entries = aggregate.entries;
    const window = boundedWindowRange(
        entries.length,
        request.startIndex,
        request.limit,
        maximumRunLimit
    );
    return {
        agent: aggregate.agent,
        runs: entries.slice(window.startIndex, window.endIndexExclusive),
        totalRuns: entries.length,
        omittedRuns: entries.length -
            (window.endIndexExclusive - window.startIndex),
        passed: aggregate.passed,
        failed: aggregate.failed,
        missing: aggregate.missing,
        reconnectCount: aggregate.reconnectCount,
        diagnosticCount: aggregate.diagnosticCount,
        startIndex: window.startIndex,
        endIndexExclusive: window.endIndexExclusive
    };
}

function displaySummaryFromIndex(
    source: FleetReportSourceIndex,
    failureCount = failureRowsFromIndex(source).length
): FleetReportDisplaySummary {
    return {
        runs: source.reports.length,
        agents: source.uniqueAgentIds.size,
        regions: source.uniqueRegionKeys.size,
        passRate: source.outcomeCount > 0
            ? source.passedOutcomes / source.outcomeCount
            : 0,
        failureGroups: failureCount,
        p95DurationMs: deriveFleetReportTimingDistribution(
            source.reports.flatMap((report) => report.runDurationMs === undefined ? [] : [report.runDurationMs])
        ).p95Ms,
        stale: source.staleAgentIds.size
    };
}

function aggregateFallbackSummary(
    response: ControlFleetReportsResponse | undefined
): FleetReportDisplaySummary {
    return {
        runs: response?.aggregate.runCount ?? 0,
        agents: response?.aggregate.agentCount ?? 0,
        regions: response?.aggregate.regionCount ?? 0,
        passRate: response?.aggregate.passRate ?? 0,
        failureGroups: response?.aggregate.failureGroupCount ?? 0,
        p95DurationMs: response?.aggregate.timing.runs.p95Ms,
        stale: response?.aggregate.staleAgentCount ?? 0
    };
}

function aggregateRegion(
    regions: Map<string, MutableRegion>,
    key: string,
    outcome: ControlFleetAgentRunOutcome,
    policy: FleetReportDerivationPolicy
): void {
    const row = regions.get(key) ?? {
        region: outcome.label.region ?? 'unlabeled',
        provider: outcome.label.provider,
        agentIds: new Set<string>(),
        passed: 0,
        failed: 0,
        missing: 0,
        flaky: 0,
        stale: 0,
        durations: [],
        failureCounts: new Map<string, number>()
    };
    row.agentIds.add(outcome.agentId);
    if (outcome.state === 'passed') {
        row.passed += 1;
    }
    else if (
        outcome.state === 'failed' ||
        policy.timedOutAsFailed && outcome.state === 'timed-out'
    ) {
        row.failed += 1;
    }
    else if (outcome.missing) {
        row.missing += 1;
    }
    if (outcome.flaky) {
        row.flaky += 1;
    }
    if (outcome.stale) {
        row.stale += 1;
    }
    if (outcome.durationMs !== undefined) {
        row.durations.push(outcome.durationMs);
    }
    outcome.failureSignatureIds.forEach((signatureId) => {
        row.failureCounts.set(
            signatureId,
            (row.failureCounts.get(signatureId) ?? 0) + 1
        );
    });
    regions.set(key, row);
}

function aggregateFailure(
    failures: Map<string, MutableFailure>,
    signature: ControlFleetFailureSignature,
    distributedRunId: string
): void {
    const current = failures.get(signature.signatureId) ?? {
        ...signature,
        count: 0,
        firstSeenAtEpochMs: signature.firstSeenAtEpochMs,
        lastSeenAtEpochMs: signature.lastSeenAtEpochMs,
        affectedAgents: new Set<string>(),
        affectedRegions: new Set<string>(),
        affectedRuns: new Set<string>()
    };
    current.count += signature.count;
    current.firstSeenAtEpochMs = minDefined(
        current.firstSeenAtEpochMs,
        signature.firstSeenAtEpochMs
    );
    current.lastSeenAtEpochMs = maxDefined(
        current.lastSeenAtEpochMs,
        signature.lastSeenAtEpochMs
    );
    signature.affectedAgents.forEach((agentId) => current.affectedAgents.add(agentId));
    signature.affectedRegions.forEach((region) => current.affectedRegions.add(region));
    signature.affectedRuns.forEach((runId) => current.affectedRuns.add(runId));
    current.affectedRuns.add(distributedRunId);
    failures.set(signature.signatureId, current);
}

function fleetReportRegionKey(outcome: ControlFleetAgentRunOutcome): string {
    return exactTupleIdentity([
        outcome.label.region ?? null,
        outcome.label.provider ?? null
    ]);
}

function fleetReportRegionLabel(outcome: ControlFleetAgentRunOutcome): string {
    return `${outcome.label.region ?? 'unlabeled'} / ${outcome.label.provider ?? 'unknown'}`;
}

function fleetReportRegionPublicId(
    outcome: ControlFleetAgentRunOutcome
): string {
    return fleetRegionPublicId(
        outcome.label.region,
        outcome.label.provider
    );
}

function compareHeatmapAgents(
    left: ControlFleetAgentRunOutcome,
    right: ControlFleetAgentRunOutcome,
    policy: FleetReportDerivationPolicy
): number {
    return comparePolicyText(
        left.label.region ?? 'unlabeled',
        right.label.region ?? 'unlabeled',
        policy
    ) || comparePolicyText(
        left.label.provider ?? 'unknown',
        right.label.provider ?? 'unknown',
        policy
    ) || comparePolicyText(left.agentId, right.agentId, policy);
}

function appendMapValue(
    values: Map<string, number[]>,
    key: string,
    value: number
): void {
    const list = values.get(key) ?? [];
    list.push(value);
    values.set(key, list);
}

function boundedWindow<T>(
    items: readonly T[],
    request: FleetReportWindowRequest,
    maximumLimit: number
): FleetReportBoundedWindow<T> {
    const range = boundedWindowRange(
        items.length,
        request.startIndex,
        request.limit,
        maximumLimit
    );
    const visibleItems = items.slice(
        range.startIndex,
        range.endIndexExclusive
    );
    return {
        items: visibleItems,
        total: items.length,
        omitted: items.length - visibleItems.length,
        startIndex: range.startIndex,
        endIndexExclusive: range.endIndexExclusive
    };
}

function boundedWindowRange(
    total: number,
    requestedStartIndex: number | undefined,
    requestedLimit: number | undefined,
    maximumLimit: number
): Readonly<{ startIndex: number; endIndexExclusive: number; }> {
    const maximumWindowSize = boundedLimit(maximumLimit, total);
    const windowSize = requestedLimit === undefined
        ? maximumWindowSize
        : Math.min(
            boundedLimit(requestedLimit, total),
            maximumWindowSize
        );
    if (total === 0 || windowSize === 0) {
        return { startIndex: 0, endIndexExclusive: 0 };
    }
    const normalizedStart = requestedStartIndex !== undefined &&
            Number.isFinite(requestedStartIndex)
        ? Math.max(0, Math.floor(requestedStartIndex))
        : 0;
    const canonicalStart = Math.floor(normalizedStart / windowSize) * windowSize;
    const lastStartIndex = Math.floor((total - 1) / windowSize) * windowSize;
    const startIndex = Math.min(canonicalStart, lastStartIndex);
    return {
        startIndex,
        endIndexExclusive: Math.min(startIndex + windowSize, total)
    };
}

function compatibilityWindow<T>(
    window: FleetReportBoundedWindow<T>
): FleetReportWindow<T> {
    return {
        items: window.items,
        total: window.total,
        omitted: window.omitted
    };
}

function compatibilityHeatmap(
    window: FleetReportHeatmapWindow
): FleetReportHeatmap {
    return {
        rows: window.rows,
        runs: window.runs,
        totalAgentRows: window.totalAgentRows,
        omittedAgentRows: window.omittedAgentRows,
        totalRunColumns: window.totalRunColumns,
        omittedRunColumns: window.omittedRunColumns
    };
}

function compatibilityAgentDetail(
    window: FleetReportAgentDetailWindow | undefined
): FleetReportAgentDetail | undefined {
    if (!window) {
        return undefined;
    }
    return {
        agent: window.agent,
        runs: window.runs,
        totalRuns: window.totalRuns,
        omittedRuns: window.omittedRuns,
        passed: window.passed,
        failed: window.failed,
        missing: window.missing,
        reconnectCount: window.reconnectCount,
        diagnosticCount: window.diagnosticCount
    };
}

function normalizeLimits(
    limits: Partial<FleetReportAnalysisLimits> | undefined
): FleetReportAnalysisLimits {
    return {
        heatmapAgentRows: normalizeLimit(
            limits?.heatmapAgentRows,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.heatmapAgentRows
        ),
        heatmapRunColumns: normalizeLimit(
            limits?.heatmapRunColumns,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.heatmapRunColumns
        ),
        regionRows: normalizeLimit(
            limits?.regionRows,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.regionRows
        ),
        failureRows: normalizeLimit(
            limits?.failureRows,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.failureRows
        ),
        timingGroups: normalizeLimit(
            limits?.timingGroups,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.timingGroups
        ),
        missingLabelAgentIds: normalizeLimit(
            limits?.missingLabelAgentIds,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.missingLabelAgentIds
        ),
        agentDetailRuns: normalizeLimit(
            limits?.agentDetailRuns,
            DEFAULT_FLEET_REPORT_ANALYSIS_LIMITS.agentDetailRuns
        )
    };
}

function resolveDerivationPolicy(
    policy: Partial<FleetReportDerivationPolicy>
): FleetReportDerivationPolicy {
    return {
        reportOrder: policy.reportOrder ??
            DEFAULT_FLEET_REPORT_DERIVATION_POLICY.reportOrder,
        timedOutAsFailed: policy.timedOutAsFailed ??
            DEFAULT_FLEET_REPORT_DERIVATION_POLICY.timedOutAsFailed,
        stableTieBreaks: policy.stableTieBreaks ??
            DEFAULT_FLEET_REPORT_DERIVATION_POLICY.stableTieBreaks,
        textCollation: policy.textCollation ??
            DEFAULT_FLEET_REPORT_DERIVATION_POLICY.textCollation
    };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
    return value === undefined ? fallback : boundedLimit(value, Number.MAX_SAFE_INTEGER);
}

function boundedLimit(value: number, length: number): number {
    if (value === Number.POSITIVE_INFINITY) {
        return length;
    }
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(length, Math.floor(value));
}

function nearestRank(sortedValues: readonly number[], percentile: number): number {
    const index = Math.max(
        0,
        Math.min(
            sortedValues.length - 1,
            Math.ceil(sortedValues.length * percentile) - 1
        )
    );
    return sortedValues[index];
}

function minDefined(
    left: number | undefined,
    right: number | undefined
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.min(left, right);
}

function maxDefined(
    left: number | undefined,
    right: number | undefined
): number | undefined {
    if (left === undefined) {
        return right;
    }
    if (right === undefined) {
        return left;
    }
    return Math.max(left, right);
}

function compareText(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

function comparePolicyText(
    left: string,
    right: string,
    policy: FleetReportDerivationPolicy
): number {
    return policy.textCollation === 'legacy-locale'
        ? left.localeCompare(right)
        : compareText(left, right);
}

function exactTupleIdentity(parts: readonly unknown[]): string {
    return JSON.stringify(parts);
}

function fleetRegionPublicId(
    region: string | undefined,
    provider: string | undefined
): string {
    return `${publicIdentitySegment(region, 'unlabeled')} / ${publicIdentitySegment(provider, 'unknown')}`;
}

function publicIdentitySegment(
    value: string | undefined,
    missingLabel: string
): string {
    if (value === undefined) {
        return missingLabel;
    }
    const encoded = encodeOperatorText(value);
    return value === missingLabel ? `${encoded}:literal` : encoded;
}

function encodeOperatorText(value: string): string {
    let encoded = '';
    let start = 0;
    for (let index = 0; index < value.length; index += 1) {
        const codeUnit = value.charCodeAt(index);
        if (
            codeUnit >= 0xd800 && codeUnit <= 0xdbff &&
            index + 1 < value.length
        ) {
            const next = value.charCodeAt(index + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                index += 1;
                continue;
            }
        }
        else if (codeUnit < 0xd800 || codeUnit > 0xdfff) {
            continue;
        }
        encoded += encodeURIComponent(value.slice(start, index));
        encoded += `%u${codeUnit.toString(16).toUpperCase().padStart(4, '0')}`;
        start = index + 1;
    }
    return encoded + encodeURIComponent(value.slice(start));
}
