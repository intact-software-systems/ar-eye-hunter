import { minimalAnalyzeAnalysis } from './analyze-analysis-projection.ts';
import { projectAnalyzeIdentity, projectWorkspaceIssue } from './analyze-artifact-display-projection.ts';
import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import {
    boundedText,
    finiteNumber,
    MAX_ANALYSIS_ROWS,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    projectAuthorityIdentifier
} from './analyze-projection-bounds.ts';
import { projectTuneRollup } from './analyze-tune-projection-rows.ts';
import type { AnalyzeTuneArtifactFacade, AnalyzeWorkerRequest } from './analyze-worker-contract.ts';

export function minimalTuneFacade(
    model: AnalyzeArtifactModel,
    selection: Pick<
        Extract<AnalyzeWorkerRequest, { type: 'tune'; }>,
        'focusRunId' | 'compareLeft' | 'compareRight' | 'timingMetric'
    >,
    role: AnalyzeTuneArtifactFacade['selection']['artifactRole'],
    totalKnobs: number,
    totalLimitations: number,
    receivedMessageAgentCount: number
): AnalyzeTuneArtifactFacade {
    const manifest = model.snapshots.distributedRun.manifest;
    const run = model.snapshots.distributedRun;
    return {
        identity: projectAnalyzeIdentity(model.identity),
        support: model.workspace.support,
        supportIssues: {
            entries: model.workspace.issues.slice(0, MAX_ANALYSIS_ROWS)
                .map(projectWorkspaceIssue),
            total: model.workspace.issues.length,
            omitted: Math.max(0, model.workspace.issues.length - MAX_ANALYSIS_ROWS)
        },
        generatedAtEpochMs: finiteNumber(model.workspace.generatedAtEpochMs),
        manifestSummary: {
            distributedRunId: projectAuthorityIdentifier(manifest.distributedRunId),
            ...(manifest.controlRunId
                ? { controlRunId: projectAuthorityIdentifier(manifest.controlRunId) }
                : {}),
            ...(manifest.displayName
                ? { displayName: boundedText(manifest.displayName, MAX_SUMMARY_BYTES) }
                : {}),
            group: {
                applicationId: boundedText(
                    manifest.group.applicationId,
                    MAX_METADATA_BYTES
                ),
                workspaceId: boundedText(
                    manifest.group.workspaceId,
                    MAX_METADATA_BYTES
                ),
                groupId: boundedText(manifest.group.groupId, MAX_METADATA_BYTES)
            },
            ...(manifest.startMode ? { startMode: manifest.startMode } : {}),
            recipeIds: {
                entries: [],
                total: manifest.recipes.length,
                omitted: manifest.recipes.length
            },
            targetPolicy: {
                mode: manifest.targetPolicy.mode,
                ...(manifest.targetPolicy.expectedParticipantCount !== undefined
                    ? {
                        expectedParticipantCount: finiteNumber(
                            manifest.targetPolicy.expectedParticipantCount
                        )
                    }
                    : {}),
                configuredAgentCount: manifest.targetPolicy.agentIds?.length ?? 0,
                configuredRoleCount: Object.keys(
                    manifest.targetPolicy.roles ?? {}
                ).length
            },
            roleAssignmentCount: manifest.roleAssignments?.length ?? 0
        },
        tuningInventory: {
            totalKnobs,
            knobs: [],
            omittedKnobs: totalKnobs,
            totalLimitations,
            limitations: [],
            omittedLimitations: totalLimitations
        },
        candidateManifestOmittedReason: 'manifest-too-large',
        selection: {
            ...(selection.focusRunId
                ? { focusRunId: projectAuthorityIdentifier(selection.focusRunId) }
                : {}),
            ...(selection.compareLeft
                ? { compareLeft: projectAuthorityIdentifier(selection.compareLeft) }
                : {}),
            ...(selection.compareRight
                ? { compareRight: projectAuthorityIdentifier(selection.compareRight) }
                : {}),
            ...(selection.timingMetric
                ? {
                    timingMetric: boundedText(
                        selection.timingMetric,
                        MAX_METADATA_BYTES
                    )
                }
                : {}),
            artifactRole: role
        },
        distributedRun: {
            distributedRunId: projectAuthorityIdentifier(run.distributedRunId),
            controlRunId: projectAuthorityIdentifier(run.controlRunId),
            state: run.state,
            startedAtEpochMs: run.startedAtEpochMs,
            completedAtEpochMs: run.completedAtEpochMs,
            updatedAtEpochMs: finiteNumber(run.updatedAtEpochMs),
            targetAgentIds: {
                entries: [],
                total: run.targetAgentIds.length,
                omitted: run.targetAgentIds.length
            },
            rollup: projectTuneRollup({
                ...run.rollup,
                failures: []
            }) as typeof run.rollup
        },
        analysis: minimalAnalyzeAnalysis(model.analysis),
        receivedMessageDeltas: {
            entries: [],
            total: receivedMessageAgentCount,
            omitted: receivedMessageAgentCount
        }
    };
}
