import type {
    ControlDistributedRunCommandLink,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from './control-snapshots.ts';
import { payloadReferencesDistributedRun } from './distributed-artifact-evidence-utils.ts';
import {
    createDistributedRunMonitorMembershipIndex,
    type DistributedRunMonitorMembershipIndex
} from './distributed-run-monitor-membership-index.ts';
import type { DistributedRunFailureRow, DistributedRunRuntimeDiagnosticRow } from './distributed-run-monitor.ts';

type ControlCommandSnapshot = ControlRunSnapshot['commands'][number];
type ControlResultSnapshot = ControlRunSnapshot['results'][number];
type ControlEventSnapshot = ControlRunSnapshot['events'][number];
type DistributedRunCommandPhase = ControlDistributedRunCommandLink['phase'];

export type DistributedRunMonitorAgentLinks = Readonly<{
    all: readonly ControlDistributedRunCommandLink[];
    stage: readonly ControlDistributedRunCommandLink[];
    barrier: readonly ControlDistributedRunCommandLink[];
    start: readonly ControlDistributedRunCommandLink[];
    cancel: readonly ControlDistributedRunCommandLink[];
}>;

export type DistributedRunMonitorIndex = Readonly<{
    agentIds: readonly string[];
    commandLinks: readonly ControlDistributedRunCommandLink[];
    commandsById: ReadonlyMap<string, ControlCommandSnapshot>;
    linkedResults: readonly ControlResultSnapshot[];
    resultsByCommandId: ReadonlyMap<string, ControlResultSnapshot>;
    linkedControlEvents: readonly ControlEventSnapshot[];
    linksByCommandId: ReadonlyMap<string, ControlDistributedRunCommandLink>;
    firstCommandPhasesById: ReadonlyMap<string, DistributedRunCommandPhase>;
    linksByAgentId: ReadonlyMap<string, DistributedRunMonitorAgentLinks>;
    linksByRecipeId: ReadonlyMap<string, readonly ControlDistributedRunCommandLink[]>;
    progressLinksByRecipeId: ReadonlyMap<
        string,
        Readonly<{
            start: readonly ControlDistributedRunCommandLink[];
            stage: readonly ControlDistributedRunCommandLink[];
        }>
    >;
    membership: DistributedRunMonitorMembershipIndex;
    commandCounts: Readonly<{
        total: number;
        stage: number;
        barrier: number;
        start: number;
        cancel: number;
        completed: number;
        failed: number;
        pending: number;
    }>;
    resultCounts: Readonly<{
        total: number;
        ok: number;
        failed: number;
    }>;
    latencies: readonly number[];
    work: MutableDistributedRunMonitorDerivationWork;
}>;

export type DistributedRunMonitorDerivationWork = Readonly<{
    monitorDerivationCount: number;
    reportDerivationCount: number;
    commandLinkIndexPassCount: number;
    commandLinkVisitCount: number;
    controlCommandIndexPassCount: number;
    controlCommandVisitCount: number;
    controlResultIndexPassCount: number;
    controlResultVisitCount: number;
    controlEventIndexPassCount: number;
    controlEventVisitCount: number;
    linkedEventAgentIndexVisitCount: number;
    failureIndexVisitCount: number;
    targetAgentIndexPassCount: number;
    targetAgentVisitCount: number;
    recipeSelectionIndexPassCount: number;
    recipeSelectionVisitCount: number;
    roleAssignmentIndexPassCount: number;
    roleAssignmentVisitCount: number;
    targetPolicyRoleMembershipVisitCount: number;
    membershipDescriptorBuildCount: number;
    membershipInvertedIndexWriteCount: number;
    membershipIntersectionCandidateVisitCount: number;
    recipeTargetCountProjectionVisitCount: number;
    retainedMembershipDescriptorCount: number;
    retainedRecipeTargetCountCount: number;
    commandLinkCompletionProbeCount: number;
    agentLinkBucketLookupCount: number;
    agentEventBucketLookupCount: number;
    agentRoleLookupCount: number;
    agentLinkProjectionVisitCount: number;
    agentEventProjectionVisitCount: number;
    recipeLinkBucketLookupCount: number;
    recipeLinkProjectionVisitCount: number;
    recipeTargetCountLookupCount: number;
    linkedAgentExpectedMembershipProbeCount: number;
    readinessLinkBucketLookupCount: number;
    readinessStageLinkProjectionVisitCount: number;
    timelineCommandLinkProjectionVisitCount: number;
    diagnosticFailureCandidateVisitCount: number;
    reportCommandLinkLookupCount: number;
    reportFallbackCommandLinkIndexPassCount: number;
    reportFallbackCommandLinkVisitCount: number;
    reportFallbackCommandPhaseLookupCount: number;
}>;

export type DistributedRunAnalysisReportWork = Readonly<{
    reportCommandLinkLookupCount: number;
    reportFallbackCommandLinkIndexPassCount: number;
    reportFallbackCommandLinkVisitCount: number;
    reportFallbackCommandPhaseLookupCount: number;
}>;

type MutableDistributedRunMonitorDerivationWork = {
    -readonly [Key in keyof DistributedRunMonitorDerivationWork]: DistributedRunMonitorDerivationWork[Key];
};

type MutableAgentLinks = {
    -readonly [Key in keyof DistributedRunMonitorAgentLinks]: ControlDistributedRunCommandLink[];
};

type MutableRecipeProgressLinks = {
    start: ControlDistributedRunCommandLink[];
    stage: ControlDistributedRunCommandLink[];
};

type TimedFailurePosition = Readonly<{
    atEpochMs: number;
    position: number;
}>;

export type DistributedRunMonitorFailureIndex = Readonly<{
    failures: readonly DistributedRunFailureRow[];
    positionsByCommandKey: ReadonlyMap<string, readonly number[]>;
    timedPositionsByAgentId: ReadonlyMap<string, readonly TimedFailurePosition[]>;
    work: MutableDistributedRunMonitorDerivationWork;
}>;

export type DistributedRunMonitorAnalysisReuse = Readonly<{
    work: MutableDistributedRunMonitorDerivationWork;
    firstCommandPhasesById: ReadonlyMap<string, DistributedRunCommandPhase>;
    distributedRunAuthority: WeakSet<object>;
    commandLinksAuthority: WeakSet<object>;
}>;

const derivationWorkByObservable = new WeakMap<object, DistributedRunMonitorDerivationWork>();
const analysisReuseByObservable = new WeakMap<object, DistributedRunMonitorAnalysisReuse>();

export function createDistributedRunMonitorIndex(
    input: Readonly<{
        distributedRun: ControlDistributedRunSnapshot;
        controlRun?: ControlRunSnapshot;
    }>
): DistributedRunMonitorIndex {
    const work = emptyDerivationWork();
    const membership = createDistributedRunMonitorMembershipIndex(
        input.distributedRun,
        work
    );
    work.commandLinkIndexPassCount = 1;
    const linkedCommandIds = new Set<string>();
    const commandLinks: ControlDistributedRunCommandLink[] = [];
    const linksByCommandId = new Map<string, ControlDistributedRunCommandLink>();
    const firstCommandPhasesById = new Map<string, DistributedRunCommandPhase>();
    const linkCountByCommandId = new Map<string, number>();
    const mutableLinksByAgentId = new Map<string, MutableAgentLinks>();
    const mutableLinksByRecipeId = new Map<string, ControlDistributedRunCommandLink[]>();
    const mutableProgressLinksByRecipeId = new Map<string, MutableRecipeProgressLinks>();
    const agentIds = new Set<string>();
    for (const agentId of membership.targetAgentIds) {
        agentIds.add(agentId);
        mutableLinksByAgentId.set(agentId, emptyAgentLinks());
    }
    const recipeIds = membership.recipeIds;
    recipeIds.forEach((recipeId) => {
        mutableLinksByRecipeId.set(recipeId, []);
        mutableProgressLinksByRecipeId.set(recipeId, { start: [], stage: [] });
    });
    let stage = 0;
    let barrier = 0;
    let start = 0;
    let cancel = 0;

    for (const link of input.distributedRun.commandLinks) {
        work.commandLinkVisitCount += 1;
        commandLinks.push(link);
        linkedCommandIds.add(link.commandId);
        linksByCommandId.set(link.commandId, link);
        if (!firstCommandPhasesById.has(link.commandId)) {
            firstCommandPhasesById.set(link.commandId, link.phase);
        }
        linkCountByCommandId.set(
            link.commandId,
            (linkCountByCommandId.get(link.commandId) ?? 0) + 1
        );
        agentIds.add(link.agentId);
        const agentLinks = mutableLinksByAgentId.get(link.agentId) ?? emptyAgentLinks();
        if (!mutableLinksByAgentId.has(link.agentId)) {
            mutableLinksByAgentId.set(link.agentId, agentLinks);
        }
        agentLinks.all.push(link);
        agentLinks[link.phase].push(link);
        if (link.phase === 'stage') {
            stage += 1;
        }
        if (link.phase === 'barrier') {
            barrier += 1;
        }
        if (link.phase === 'start') {
            start += 1;
        }
        if (link.phase === 'cancel') {
            cancel += 1;
        }

        const recipeId = link.recipeId ??
            (recipeIds.length === 1 ? recipeIds[0] : undefined);
        if (recipeId !== undefined) {
            mutableLinksByRecipeId.get(recipeId)?.push(link);
            if (link.phase === 'start' || link.phase === 'stage') {
                mutableProgressLinksByRecipeId.get(recipeId)?.[link.phase].push(link);
            }
        }
    }
    const commandsById = new Map<string, ControlCommandSnapshot>();
    if (input.controlRun) {
        work.controlCommandIndexPassCount = 1;
        for (const command of input.controlRun.commands) {
            work.controlCommandVisitCount += 1;
            commandsById.set(command.envelope.commandId, command);
        }
    }

    const linkedResults: ControlResultSnapshot[] = [];
    const resultsByCommandId = new Map<string, ControlResultSnapshot>();
    const latencies: number[] = [];
    let okResults = 0;
    let failedResults = 0;
    if (input.controlRun) {
        work.controlResultIndexPassCount = 1;
        for (const result of input.controlRun.results) {
            work.controlResultVisitCount += 1;
            if (!linkedCommandIds.has(result.commandId)) {
                continue;
            }
            linkedResults.push(result);
            resultsByCommandId.set(result.commandId, result);
            if (result.ok) {
                okResults += 1;
            }
            else {
                failedResults += 1;
            }
            const durationMs = result.result?.durationMs;
            if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
                latencies.push(durationMs);
            }
        }
    }

    let completed = 0;
    let failed = 0;
    linkCountByCommandId.forEach((linkCount, commandId) => {
        work.commandLinkCompletionProbeCount += 1;
        const result = resultsByCommandId.get(commandId);
        const command = commandsById.get(commandId);
        if (result !== undefined || command?.completedAtEpochMs !== undefined) {
            completed += linkCount;
        }
        if (result?.ok === false) {
            failed += linkCount;
        }
    });

    const linkedControlEvents: ControlEventSnapshot[] = [];
    if (input.controlRun) {
        work.controlEventIndexPassCount = 1;
        for (const event of input.controlRun.events) {
            work.controlEventVisitCount += 1;
            if (
                (event.commandId !== undefined && linkedCommandIds.has(event.commandId)) ||
                monitorPayloadReferencesDistributedRun(
                    event.payload,
                    input.distributedRun.distributedRunId
                )
            ) {
                linkedControlEvents.push(event);
            }
        }
    }

    return {
        agentIds: [...agentIds].sort(),
        commandLinks,
        commandsById,
        linkedResults,
        resultsByCommandId,
        linkedControlEvents,
        linksByCommandId,
        firstCommandPhasesById,
        linksByAgentId: mutableLinksByAgentId,
        linksByRecipeId: mutableLinksByRecipeId,
        progressLinksByRecipeId: mutableProgressLinksByRecipeId,
        membership,
        commandCounts: {
            total: input.distributedRun.commandLinks.length,
            stage,
            barrier,
            start,
            cancel,
            completed,
            failed,
            pending: Math.max(0, input.distributedRun.commandLinks.length - completed)
        },
        resultCounts: {
            total: linkedResults.length,
            ok: okResults,
            failed: failedResults
        },
        latencies,
        work
    };
}

export function createDistributedRunMonitorFailureIndex(
    failures: readonly DistributedRunFailureRow[],
    monitorIndex: DistributedRunMonitorIndex
): DistributedRunMonitorFailureIndex {
    const mutablePositionsByCommandKey = new Map<string, number[]>();
    const mutableTimedPositionsByAgentId = new Map<string, TimedFailurePosition[]>();
    failures.forEach((failure, position) => {
        monitorIndex.work.failureIndexVisitCount += 1;
        const commandKeys = new Set([failure.commandId, failure.key]);
        commandKeys.forEach((commandKey) => {
            if (commandKey === undefined) {
                return;
            }
            const positions = mutablePositionsByCommandKey.get(commandKey) ?? [];
            if (!mutablePositionsByCommandKey.has(commandKey)) {
                mutablePositionsByCommandKey.set(commandKey, positions);
            }
            positions.push(position);
        });
        if (
            failure.agentId !== undefined &&
            failure.atEpochMs !== undefined &&
            Number.isFinite(failure.atEpochMs)
        ) {
            const positions = mutableTimedPositionsByAgentId.get(failure.agentId) ?? [];
            if (!mutableTimedPositionsByAgentId.has(failure.agentId)) {
                mutableTimedPositionsByAgentId.set(failure.agentId, positions);
            }
            positions.push({ atEpochMs: failure.atEpochMs, position });
        }
    });
    mutableTimedPositionsByAgentId.forEach((positions) => {
        positions.sort((left, right) => left.atEpochMs - right.atEpochMs || left.position - right.position);
    });
    return {
        failures,
        positionsByCommandKey: mutablePositionsByCommandKey,
        timedPositionsByAgentId: mutableTimedPositionsByAgentId,
        work: monitorIndex.work
    };
}

export function distributedRunCorrelatedFailureKeys(
    diagnostic: Omit<DistributedRunRuntimeDiagnosticRow, 'correlatedFailureKeys'>,
    index: DistributedRunMonitorFailureIndex
): readonly string[] {
    const positions = new Set<number>();
    if (diagnostic.commandId) {
        index.positionsByCommandKey.get(diagnostic.commandId)?.forEach((position) => {
            index.work.diagnosticFailureCandidateVisitCount += 1;
            positions.add(position);
        });
    }
    if (diagnostic.agentId && Number.isFinite(diagnostic.atEpochMs)) {
        const timedPositions = index.timedPositionsByAgentId.get(diagnostic.agentId) ?? [];
        const minimum = diagnostic.atEpochMs - 15_000;
        const maximum = diagnostic.atEpochMs + 15_000;
        const start = lowerBoundTimedFailure(timedPositions, minimum);
        for (let cursor = start; cursor < timedPositions.length; cursor += 1) {
            const candidate = timedPositions[cursor]!;
            if (candidate.atEpochMs > maximum) {
                break;
            }
            index.work.diagnosticFailureCandidateVisitCount += 1;
            positions.add(candidate.position);
        }
    }
    return [...positions]
        .sort((left, right) => left - right)
        .map((position) => index.failures[position]!.key);
}

export function recordDistributedRunMonitorDerivation(
    monitor: object,
    index: DistributedRunMonitorIndex,
    distributedRun: ControlDistributedRunSnapshot
): void {
    analysisReuseByObservable.set(monitor, {
        work: index.work,
        firstCommandPhasesById: index.firstCommandPhasesById,
        distributedRunAuthority: new WeakSet([distributedRun]),
        commandLinksAuthority: new WeakSet([distributedRun.commandLinks])
    });
    derivationWorkByObservable.set(monitor, Object.freeze({ ...index.work }));
}

export function recordDistributedRunAnalysisReportDerivation(
    report: object,
    monitor: object,
    reportWork: DistributedRunAnalysisReportWork
): void {
    const monitorWork = analysisReuseByObservable.get(monitor)?.work ??
        derivationWorkByObservable.get(monitor) ??
        emptyDerivationWork(0);
    derivationWorkByObservable.set(
        report,
        Object.freeze({
            ...monitorWork,
            reportDerivationCount: monitorWork.reportDerivationCount + 1,
            reportCommandLinkLookupCount: reportWork.reportCommandLinkLookupCount,
            reportFallbackCommandLinkIndexPassCount: reportWork.reportFallbackCommandLinkIndexPassCount,
            reportFallbackCommandLinkVisitCount: reportWork.reportFallbackCommandLinkVisitCount,
            reportFallbackCommandPhaseLookupCount: reportWork.reportFallbackCommandPhaseLookupCount
        })
    );
}

export function distributedRunMonitorAnalysisReuseFor(
    monitor: object,
    distributedRun: ControlDistributedRunSnapshot
): DistributedRunMonitorAnalysisReuse | undefined {
    const reuse = analysisReuseByObservable.get(monitor);
    return reuse?.distributedRunAuthority.has(distributedRun) === true &&
            reuse.commandLinksAuthority.has(distributedRun.commandLinks)
        ? reuse
        : undefined;
}

export function distributedRunMonitorFirstPhaseForCommand(
    reuse: DistributedRunMonitorAnalysisReuse,
    commandId: string | undefined
): DistributedRunCommandPhase | undefined {
    return commandId === undefined
        ? undefined
        : reuse.firstCommandPhasesById.get(commandId);
}

export function distributedRunMonitorAgentLinksForProgress(
    index: DistributedRunMonitorIndex,
    agentId: string
): DistributedRunMonitorAgentLinks {
    index.work.agentLinkBucketLookupCount += 1;
    return index.linksByAgentId.get(agentId) ?? emptyAgentLinks();
}

export function distributedRunMonitorAgentEventsForProgress<Value>(
    index: DistributedRunMonitorIndex,
    eventsByAgentId: ReadonlyMap<string, readonly Value[]>,
    agentId: string
): readonly Value[] {
    index.work.agentEventBucketLookupCount += 1;
    return eventsByAgentId.get(agentId) ?? [];
}

export function distributedRunMonitorRecipeLinks(
    index: DistributedRunMonitorIndex,
    recipeId: string
): readonly ControlDistributedRunCommandLink[] {
    index.work.recipeLinkBucketLookupCount += 1;
    const links = index.progressLinksByRecipeId.get(recipeId);
    return links === undefined
        ? []
        : links.start.length > 0
        ? links.start
        : links.stage;
}

export function distributedRunMonitorReadinessStageLinks(
    index: DistributedRunMonitorIndex,
    agentId: string
): readonly ControlDistributedRunCommandLink[] {
    index.work.readinessLinkBucketLookupCount += 1;
    return index.linksByAgentId.get(agentId)?.stage ?? [];
}

/** Test-only structural work snapshot; deliberately excluded from the public barrel. */
export function distributedRunMonitorDerivationWorkForTest(
    observable: object
): DistributedRunMonitorDerivationWork {
    const work = derivationWorkByObservable.get(observable);
    if (!work) {
        throw new Error('The distributed run derivation has no work snapshot.');
    }
    return { ...work };
}

function emptyAgentLinks(): MutableAgentLinks {
    return { all: [], stage: [], barrier: [], start: [], cancel: [] };
}

function emptyDerivationWork(
    monitorDerivationCount = 1
): MutableDistributedRunMonitorDerivationWork {
    return {
        monitorDerivationCount,
        reportDerivationCount: 0,
        commandLinkIndexPassCount: 0,
        commandLinkVisitCount: 0,
        controlCommandIndexPassCount: 0,
        controlCommandVisitCount: 0,
        controlResultIndexPassCount: 0,
        controlResultVisitCount: 0,
        controlEventIndexPassCount: 0,
        controlEventVisitCount: 0,
        linkedEventAgentIndexVisitCount: 0,
        failureIndexVisitCount: 0,
        targetAgentIndexPassCount: 0,
        targetAgentVisitCount: 0,
        recipeSelectionIndexPassCount: 0,
        recipeSelectionVisitCount: 0,
        roleAssignmentIndexPassCount: 0,
        roleAssignmentVisitCount: 0,
        targetPolicyRoleMembershipVisitCount: 0,
        membershipDescriptorBuildCount: 0,
        membershipInvertedIndexWriteCount: 0,
        membershipIntersectionCandidateVisitCount: 0,
        recipeTargetCountProjectionVisitCount: 0,
        retainedMembershipDescriptorCount: 0,
        retainedRecipeTargetCountCount: 0,
        commandLinkCompletionProbeCount: 0,
        agentLinkBucketLookupCount: 0,
        agentEventBucketLookupCount: 0,
        agentRoleLookupCount: 0,
        agentLinkProjectionVisitCount: 0,
        agentEventProjectionVisitCount: 0,
        recipeLinkBucketLookupCount: 0,
        recipeLinkProjectionVisitCount: 0,
        recipeTargetCountLookupCount: 0,
        linkedAgentExpectedMembershipProbeCount: 0,
        readinessLinkBucketLookupCount: 0,
        readinessStageLinkProjectionVisitCount: 0,
        timelineCommandLinkProjectionVisitCount: 0,
        diagnosticFailureCandidateVisitCount: 0,
        reportCommandLinkLookupCount: 0,
        reportFallbackCommandLinkIndexPassCount: 0,
        reportFallbackCommandLinkVisitCount: 0,
        reportFallbackCommandPhaseLookupCount: 0
    };
}

function lowerBoundTimedFailure(
    values: readonly TimedFailurePosition[],
    minimum: number
): number {
    let low = 0;
    let high = values.length;
    while (low < high) {
        const middle = low + Math.floor((high - low) / 2);
        if (values[middle]!.atEpochMs < minimum) {
            low = middle + 1;
        }
        else {
            high = middle;
        }
    }
    return low;
}

function monitorPayloadReferencesDistributedRun(
    payload: unknown,
    distributedRunId: string
): boolean {
    return Boolean(payload) &&
        payloadReferencesDistributedRun(payload, distributedRunId);
}
