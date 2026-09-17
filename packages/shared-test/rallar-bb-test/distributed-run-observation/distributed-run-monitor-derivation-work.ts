import type { ControlDistributedRunCommandPhase, ControlDistributedRunSnapshot } from '../control-snapshots.ts';
import type { DistributedRunMonitorIndex } from '../distributed-run-monitor-index.ts';

export interface DistributedRunMonitorDerivationWork {
    readonly monitorDerivationCount: number;
    readonly reportDerivationCount: number;
    readonly commandLinkIndexPassCount: number;
    readonly commandLinkVisitCount: number;
    readonly controlCommandIndexPassCount: number;
    readonly controlCommandVisitCount: number;
    readonly controlResultIndexPassCount: number;
    readonly controlResultVisitCount: number;
    readonly controlEventIndexPassCount: number;
    readonly controlEventVisitCount: number;
    readonly linkedEventAgentIndexVisitCount: number;
    readonly failureIndexVisitCount: number;
    readonly targetAgentIndexPassCount: number;
    readonly targetAgentVisitCount: number;
    readonly recipeSelectionIndexPassCount: number;
    readonly recipeSelectionVisitCount: number;
    readonly roleAssignmentIndexPassCount: number;
    readonly roleAssignmentVisitCount: number;
    readonly targetPolicyRoleMembershipVisitCount: number;
    readonly membershipDescriptorBuildCount: number;
    readonly membershipInvertedIndexWriteCount: number;
    readonly membershipIntersectionCandidateVisitCount: number;
    readonly recipeTargetCountProjectionVisitCount: number;
    readonly retainedMembershipDescriptorCount: number;
    readonly retainedRecipeTargetCountCount: number;
    readonly commandLinkCompletionProbeCount: number;
    readonly agentLinkBucketLookupCount: number;
    readonly agentEventBucketLookupCount: number;
    readonly agentRoleLookupCount: number;
    readonly agentLinkProjectionVisitCount: number;
    readonly agentEventProjectionVisitCount: number;
    readonly recipeLinkBucketLookupCount: number;
    readonly recipeLinkProjectionVisitCount: number;
    readonly recipeTargetCountLookupCount: number;
    readonly linkedAgentExpectedMembershipProbeCount: number;
    readonly readinessLinkBucketLookupCount: number;
    readonly readinessStageLinkProjectionVisitCount: number;
    readonly timelineCommandLinkProjectionVisitCount: number;
    readonly diagnosticFailureCandidateVisitCount: number;
    readonly reportCommandLinkLookupCount: number;
    readonly reportFallbackCommandLinkIndexPassCount: number;
    readonly reportFallbackCommandLinkVisitCount: number;
    readonly reportFallbackCommandPhaseLookupCount: number;
}

export interface DistributedRunAnalysisReportWork {
    readonly reportCommandLinkLookupCount: number;
    readonly reportFallbackCommandLinkIndexPassCount: number;
    readonly reportFallbackCommandLinkVisitCount: number;
    readonly reportFallbackCommandPhaseLookupCount: number;
}

export type MutableDistributedRunMonitorDerivationWork = {
    -readonly [Key in keyof DistributedRunMonitorDerivationWork]: DistributedRunMonitorDerivationWork[Key];
};

export interface DistributedRunMonitorAnalysisReuse {
    readonly work: MutableDistributedRunMonitorDerivationWork;
    readonly firstCommandPhasesById: ReadonlyMap<string, ControlDistributedRunCommandPhase>;
    readonly distributedRunAuthority: WeakSet<object>;
    readonly commandLinksAuthority: WeakSet<object>;
}

const derivationWorkByObservable = new WeakMap<object, DistributedRunMonitorDerivationWork>();
const analysisReuseByObservable = new WeakMap<object, DistributedRunMonitorAnalysisReuse>();

export function createEmptyDistributedRunMonitorDerivationWork(
    monitorDerivationCount: number
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

/** Records a monitor derivation's work and the index a report derived from that monitor may reuse. */
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

/** Records one more report derivation on top of the work its monitor recorded. */
export function recordDistributedRunAnalysisReportDerivation(
    report: object,
    monitor: object,
    reportWork: DistributedRunAnalysisReportWork
): void {
    const monitorWork = analysisReuseByObservable.get(monitor)?.work ??
        derivationWorkByObservable.get(monitor) ??
        createEmptyDistributedRunMonitorDerivationWork(0);
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

export function getDistributedRunMonitorAnalysisReuse(
    monitor: object,
    distributedRun: ControlDistributedRunSnapshot
): DistributedRunMonitorAnalysisReuse | undefined {
    const reuse = analysisReuseByObservable.get(monitor);
    return reuse?.distributedRunAuthority.has(distributedRun) === true &&
            reuse.commandLinksAuthority.has(distributedRun.commandLinks)
        ? reuse
        : undefined;
}

export function getDistributedRunMonitorFirstPhase(
    reuse: DistributedRunMonitorAnalysisReuse,
    commandId: string | undefined
): ControlDistributedRunCommandPhase | undefined {
    return commandId === undefined
        ? undefined
        : reuse.firstCommandPhasesById.get(commandId);
}

/** A copy of the work recorded for a derived monitor or report; absent for a value no derivation recorded. */
export function getDistributedRunMonitorDerivationWork(
    observable: object
): DistributedRunMonitorDerivationWork | undefined {
    const work = derivationWorkByObservable.get(observable);
    return work === undefined ? undefined : { ...work };
}
