import type {
    DistributedRunAnalysis,
    DistributedRunAnalysisGroup,
    DistributedRunFailureAnalysis,
    DistributedRunTargetResolutionAnalysis
} from '@shared-test/rallar-bb-test/mod.ts';
import { projectAnalyzePerformance } from './analyze-performance-projection.ts';
import {
    boundedText,
    finiteNumber,
    MAX_ANALYSIS_ROWS,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    projectAuthorityIdentifier,
    projectOpaqueIdentifier,
    projectOpaqueKey
} from './analyze-projection-bounds.ts';
import { projectAnalyzeVerdict } from './analyze-verdict-projection.ts';
import type {
    AnalyzeWorkerAnalysisProjection,
    AnalyzeWorkerAnalysisProjectionSections,
    AnalyzeWorkerBoundedAnalysisProjection,
    AnalyzeWorkerFullAnalysisProjection
} from './analyze-worker-projection-contract.ts';

/** The identity every projected analysis repeats, whatever its display detail. */
type AnalyzeAnalysisProjectionIdentity = Pick<
    AnalyzeWorkerAnalysisProjectionSections,
    'generatedAtEpochMs' | 'artifactSchemaVersion' | 'distributedRunId' | 'controlRunId' | 'status'
>;

export function projectAnalyzeAnalysis(
    analysis: DistributedRunAnalysis
): AnalyzeWorkerAnalysisProjection {
    const sections = projectAnalysisSections(analysis);
    return analysis.ok
        ? { ...sections, ok: true }
        : {
            ...sections,
            ok: false,
            failure: projectFailure(analysis.failure),
            fixProposalMarkdown: boundedText(analysis.fixProposalMarkdown)
        };
}

export function projectMinimalAnalyzeAnalysis(
    analysis: DistributedRunAnalysis
): AnalyzeWorkerAnalysisProjection {
    const sections = projectMinimalAnalysisSections(analysis);
    return analysis.ok
        ? { ...sections, ok: true }
        : {
            ...sections,
            ok: false,
            failure: projectFailure(analysis.failure),
            fixProposalMarkdown: boundedText(analysis.fixProposalMarkdown)
        };
}

function projectAnalysisSections(
    analysis: DistributedRunAnalysis
): AnalyzeWorkerFullAnalysisProjection {
    return {
        detail: 'full',
        ...projectAnalysisIdentity(analysis),
        ...(analysis.group ? { group: projectGroup(analysis.group) } : {}),
        summary: {
            ...(analysis.summary.agents === undefined ? {} : { agents: finiteNumber(analysis.summary.agents) }),
            passRate: finiteNumber(analysis.summary.passRate),
            failureGroups: finiteNumber(analysis.summary.failureGroups),
            blockingFailures: finiteNumber(analysis.summary.blockingFailures)
        },
        parseWarnings: analysis.parseWarnings.slice(0, MAX_ANALYSIS_ROWS).map(
            (warning) => ({
                fileName: boundedText(warning.fileName, MAX_METADATA_BYTES),
                message: boundedText(warning.message, MAX_SUMMARY_BYTES),
                ...(warning.lineNumber !== undefined
                    ? { lineNumber: finiteNumber(warning.lineNumber) }
                    : {})
            })
        ),
        ...(analysis.performance === undefined
            ? {}
            : { performance: projectAnalyzePerformance(analysis.performance) }),
        ...(analysis.targetResolution
            ? { targetResolution: projectTargetResolution(analysis.targetResolution) }
            : {}),
        ...(analysis.spa === undefined ? {} : { spa: { verdict: projectAnalyzeVerdict(analysis.spa.verdict) } }),
        summaryMarkdown: boundedText(analysis.summaryMarkdown),
        ...(analysis.performanceMarkdown === undefined
            ? {}
            : { performanceMarkdown: boundedText(analysis.performanceMarkdown) })
    };
}

function projectMinimalAnalysisSections(
    analysis: DistributedRunAnalysis
): AnalyzeWorkerBoundedAnalysisProjection {
    return {
        detail: 'bounded',
        ...projectAnalysisIdentity(analysis),
        summary: { ...analysis.summary },
        parseWarnings: [],
        ...(analysis.spa === undefined
            ? {}
            : {
                spa: {
                    verdict: {
                        ...projectAnalyzeVerdict(analysis.spa.verdict),
                        primaryEvidence: [],
                        successSignals: [],
                        warningSignals: [],
                        causalTrail: []
                    }
                }
            })
    };
}

function projectAnalysisIdentity(
    analysis: DistributedRunAnalysis
): AnalyzeAnalysisProjectionIdentity {
    return {
        generatedAtEpochMs: finiteNumber(analysis.generatedAtEpochMs),
        artifactSchemaVersion: finiteNumber(analysis.artifactSchemaVersion),
        distributedRunId: projectAuthorityIdentifier(analysis.distributedRunId),
        controlRunId: projectAuthorityIdentifier(analysis.controlRunId),
        status: boundedText(analysis.status, MAX_METADATA_BYTES)
    };
}

function projectGroup(group: DistributedRunAnalysisGroup) {
    return {
        ...(group.applicationId
            ? { applicationId: boundedText(group.applicationId, MAX_METADATA_BYTES) }
            : {}),
        ...(group.workspaceId
            ? { workspaceId: boundedText(group.workspaceId, MAX_METADATA_BYTES) }
            : {}),
        ...(group.groupId
            ? { groupId: boundedText(group.groupId, MAX_METADATA_BYTES) }
            : {})
    };
}

function projectFailure(failure: DistributedRunFailureAnalysis): DistributedRunFailureAnalysis {
    return {
        category: boundedText(failure.category, MAX_METADATA_BYTES),
        title: boundedText(failure.title, MAX_SUMMARY_BYTES),
        likelyCause: boundedText(failure.likelyCause),
        nextAction: boundedText(failure.nextAction),
        minimalFixArea: boundedText(failure.minimalFixArea, MAX_SUMMARY_BYTES),
        verificationCommand: boundedText(failure.verificationCommand),
        affectedAgents: failure.affectedAgents.slice(0, MAX_ANALYSIS_ROWS)
            .map((value) => projectOpaqueIdentifier(value)),
        affectedRegions: failure.affectedRegions.slice(0, MAX_ANALYSIS_ROWS)
            .map((value) => boundedText(value, MAX_METADATA_BYTES)),
        ...(failure.commandId
            ? { commandId: projectOpaqueIdentifier(failure.commandId) }
            : {}),
        ...(failure.recipeId
            ? { recipeId: projectOpaqueIdentifier(failure.recipeId) }
            : {}),
        evidenceFile: boundedText(failure.evidenceFile, MAX_METADATA_BYTES)
    };
}

function projectTargetResolution(
    target: DistributedRunTargetResolutionAnalysis
): DistributedRunTargetResolutionAnalysis {
    return {
        selected: finiteNumber(target.selected),
        ...(target.expectedParticipantCount !== undefined
            ? { expectedParticipantCount: finiteNumber(target.expectedParticipantCount) }
            : {}),
        missingExpectedParticipants: finiteNumber(target.missingExpectedParticipants),
        blockers: finiteNumber(target.blockers),
        staleAgents: finiteNumber(target.staleAgents),
        offlineAgents: finiteNumber(target.offlineAgents),
        wrongGroupAgents: finiteNumber(target.wrongGroupAgents),
        agentsWithoutIdentity: finiteNumber(target.agentsWithoutIdentity),
        roleCounts: projectNumberRecord(target.roleCounts),
        regions: projectNumberRecord(target.regions),
        providers: projectNumberRecord(target.providers),
        targetAgentIds: target.targetAgentIds.slice(0, MAX_ANALYSIS_ROWS)
            .map((value) => projectOpaqueIdentifier(value)),
        blockingAgentIds: target.blockingAgentIds.slice(0, MAX_ANALYSIS_ROWS)
            .map((value) => projectOpaqueIdentifier(value))
    };
}

function projectNumberRecord(value: Readonly<Record<string, number>>) {
    return Object.fromEntries(
        Object.entries(value).slice(0, MAX_ANALYSIS_ROWS).map(
            ([key, count]) => [projectOpaqueKey(key), finiteNumber(count)]
        )
    );
}
