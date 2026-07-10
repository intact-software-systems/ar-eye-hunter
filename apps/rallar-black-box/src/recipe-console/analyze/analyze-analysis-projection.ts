import type { DistributedRunAnalysis } from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeWorkerAnalysisProjection } from './analyze-worker-contract.ts';
import { projectAnalyzePerformance } from './analyze-performance-projection.ts';
import {
    boundedText,
    finiteNumber,
    MAX_ANALYSIS_ROWS,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    PROJECTION_OMISSION_MESSAGE,
    projectAuthorityIdentifier,
    projectOpaqueIdentifier,
    projectOpaqueKey,
} from './analyze-projection-bounds.ts';
import { projectAnalyzeVerdict } from './analyze-verdict-projection.ts';

export function projectAnalyzeAnalysis(
    analysis: DistributedRunAnalysis,
): AnalyzeWorkerAnalysisProjection {
    return {
        generatedAtEpochMs: finiteNumber(analysis.generatedAtEpochMs),
        ...(analysis.artifactSchemaVersion !== undefined
            ? { artifactSchemaVersion: finiteNumber(analysis.artifactSchemaVersion) }
            : {}),
        distributedRunId: projectAuthorityIdentifier(analysis.distributedRunId),
        ...(analysis.controlRunId
            ? { controlRunId: projectAuthorityIdentifier(analysis.controlRunId) }
            : {}),
        status: boundedText(analysis.status, MAX_METADATA_BYTES),
        ok: analysis.ok,
        ...(analysis.group ? { group: projectGroup(analysis.group) } : {}),
        summary: {
            agents: finiteNumber(analysis.summary.agents),
            passRate: finiteNumber(analysis.summary.passRate),
            failureGroups: finiteNumber(analysis.summary.failureGroups),
            blockingFailures: finiteNumber(analysis.summary.blockingFailures),
        },
        parseWarnings: analysis.parseWarnings.slice(0, MAX_ANALYSIS_ROWS).map(
            warning => ({
                fileName: boundedText(warning.fileName, MAX_METADATA_BYTES),
                message: boundedText(warning.message, MAX_SUMMARY_BYTES),
                ...(warning.lineNumber !== undefined
                    ? { lineNumber: finiteNumber(warning.lineNumber) }
                    : {}),
            }),
        ),
        ...(analysis.failure ? { failure: projectFailure(analysis.failure) } : {}),
        ...(analysis.performance
            ? { performance: projectAnalyzePerformance(analysis.performance) }
            : {}),
        ...(analysis.targetResolution
            ? { targetResolution: projectTargetResolution(analysis.targetResolution) }
            : {}),
        ...(analysis.spa
            ? { spa: { verdict: projectAnalyzeVerdict(analysis.spa.verdict) } }
            : {}),
        summaryMarkdown: boundedText(analysis.summaryMarkdown),
        ...(analysis.fixProposalMarkdown
            ? { fixProposalMarkdown: boundedText(analysis.fixProposalMarkdown) }
            : {}),
        ...(analysis.performanceMarkdown
            ? { performanceMarkdown: boundedText(analysis.performanceMarkdown) }
            : {}),
    };
}

export function minimalAnalyzeAnalysis(
    analysis: DistributedRunAnalysis,
): AnalyzeWorkerAnalysisProjection {
    return {
        generatedAtEpochMs: finiteNumber(analysis.generatedAtEpochMs),
        ...(analysis.artifactSchemaVersion !== undefined
            ? { artifactSchemaVersion: finiteNumber(analysis.artifactSchemaVersion) }
            : {}),
        distributedRunId: projectAuthorityIdentifier(analysis.distributedRunId),
        ...(analysis.controlRunId
            ? { controlRunId: projectAuthorityIdentifier(analysis.controlRunId) }
            : {}),
        status: boundedText(analysis.status, MAX_METADATA_BYTES),
        ok: analysis.ok,
        summary: { ...analysis.summary },
        parseWarnings: [],
        ...(analysis.spa
            ? {
                  spa: {
                      verdict: {
                          ...projectAnalyzeVerdict(analysis.spa.verdict),
                          primaryEvidence: [],
                          successSignals: [],
                          warningSignals: [],
                          causalTrail: [],
                      },
                  },
              }
            : {}),
        summaryMarkdown: PROJECTION_OMISSION_MESSAGE,
    };
}

function projectGroup(group: NonNullable<DistributedRunAnalysis['group']>) {
    return {
        ...(group.applicationId
            ? { applicationId: boundedText(group.applicationId, MAX_METADATA_BYTES) }
            : {}),
        ...(group.workspaceId
            ? { workspaceId: boundedText(group.workspaceId, MAX_METADATA_BYTES) }
            : {}),
        ...(group.groupId
            ? { groupId: boundedText(group.groupId, MAX_METADATA_BYTES) }
            : {}),
    };
}

function projectFailure(
    failure: NonNullable<DistributedRunAnalysis['failure']>,
): NonNullable<AnalyzeWorkerAnalysisProjection['failure']> {
    return {
        category: boundedText(failure.category, MAX_METADATA_BYTES),
        title: boundedText(failure.title, MAX_SUMMARY_BYTES),
        likelyCause: boundedText(failure.likelyCause),
        nextAction: boundedText(failure.nextAction),
        minimalFixArea: boundedText(failure.minimalFixArea, MAX_SUMMARY_BYTES),
        verificationCommand: boundedText(failure.verificationCommand),
        affectedAgents: failure.affectedAgents.slice(0, MAX_ANALYSIS_ROWS)
            .map(value => projectOpaqueIdentifier(value)),
        affectedRegions: failure.affectedRegions.slice(0, MAX_ANALYSIS_ROWS)
            .map(value => boundedText(value, MAX_METADATA_BYTES)),
        ...(failure.commandId
            ? { commandId: projectOpaqueIdentifier(failure.commandId) }
            : {}),
        ...(failure.recipeId
            ? { recipeId: projectOpaqueIdentifier(failure.recipeId) }
            : {}),
        evidenceFile: boundedText(failure.evidenceFile, MAX_METADATA_BYTES),
    };
}

function projectTargetResolution(
    target: NonNullable<DistributedRunAnalysis['targetResolution']>,
): NonNullable<AnalyzeWorkerAnalysisProjection['targetResolution']> {
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
            .map(value => projectOpaqueIdentifier(value)),
        blockingAgentIds: target.blockingAgentIds.slice(0, MAX_ANALYSIS_ROWS)
            .map(value => projectOpaqueIdentifier(value)),
    };
}

function projectNumberRecord(value: Readonly<Record<string, number>>) {
    return Object.fromEntries(Object.entries(value).slice(0, MAX_ANALYSIS_ROWS).map(
        ([key, count]) => [projectOpaqueKey(key), finiteNumber(count)],
    ));
}
