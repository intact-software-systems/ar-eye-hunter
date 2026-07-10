import { inventoryDistributedRunTuningKnobs } from
    '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import {
    projectAnalyzeIdentity,
    projectWorkspaceIssue,
} from './analyze-artifact-display-projection.ts';
import { projectAnalyzeAnalysis } from './analyze-analysis-projection.ts';
import type {
    AnalyzeTuneArtifactFacade,
    AnalyzeWorkerRequest,
} from './analyze-worker-contract.ts';
import {
    boundedText,
    finiteNumber,
    isExactCandidateManifestSafe,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    MAX_TUNE_ROWS,
    projectAuthorityIdentifier,
    projectOpaqueIdentifier,
    withinSerializedLimit,
} from './analyze-projection-bounds.ts';
import { minimalTuneFacade } from './analyze-tune-fallback.ts';
import {
    projectTuneRollup,
    projectTuningKnob,
    projectTuningLimitation,
    receivedMessageDeltas,
    tuneArtifactRole,
} from './analyze-tune-projection-rows.ts';

export function projectAnalyzeTuneArtifactFacade(
    model: AnalyzeArtifactModel,
    selection: Pick<
        Extract<AnalyzeWorkerRequest, { type: 'tune' }>,
        'focusRunId' | 'compareLeft' | 'compareRight' | 'timingMetric'
    > = {},
): AnalyzeTuneArtifactFacade {
    const run = model.snapshots.distributedRun;
    const manifest = run.manifest;
    const recipeIds = manifest.recipes.slice(0, MAX_TUNE_ROWS).map(row =>
        row.recipe?.recipeId ?? row.recipeId
    ).filter((recipeId): recipeId is string => recipeId !== undefined);
    const inventory = inventoryDistributedRunTuningKnobs(manifest);
    const candidateManifest = inventory.knobs.length <= MAX_TUNE_ROWS &&
        isExactCandidateManifestSafe(manifest)
        ? manifest
        : undefined;
    const targetAgentIds = run.targetAgentIds.slice(0, MAX_TUNE_ROWS);
    const artifactRole = tuneArtifactRole(model.distributedRunId, selection);
    const messageDeltas = receivedMessageDeltas(model);
    const candidate: AnalyzeTuneArtifactFacade = {
        identity: projectAnalyzeIdentity(model.identity),
        support: model.workspace.support,
        supportIssues: {
            entries: model.workspace.issues.slice(0, MAX_TUNE_ROWS)
                .map(projectWorkspaceIssue),
            total: model.workspace.issues.length,
            omitted: Math.max(0, model.workspace.issues.length - MAX_TUNE_ROWS),
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
                    MAX_METADATA_BYTES,
                ),
                workspaceId: boundedText(
                    manifest.group.workspaceId,
                    MAX_METADATA_BYTES,
                ),
                groupId: boundedText(manifest.group.groupId, MAX_METADATA_BYTES),
            },
            ...(manifest.startMode ? { startMode: manifest.startMode } : {}),
            recipeIds: {
                entries: recipeIds.map(value => projectOpaqueIdentifier(value)),
                total: manifest.recipes.length,
                omitted: Math.max(0, manifest.recipes.length - recipeIds.length),
            },
            targetPolicy: {
                mode: manifest.targetPolicy.mode,
                ...(manifest.targetPolicy.expectedParticipantCount !== undefined
                    ? {
                          expectedParticipantCount: finiteNumber(
                              manifest.targetPolicy.expectedParticipantCount,
                          ),
                      }
                    : {}),
                configuredAgentCount: manifest.targetPolicy.agentIds?.length ?? 0,
                configuredRoleCount: Object.keys(
                    manifest.targetPolicy.roles ?? {},
                ).length,
            },
            roleAssignmentCount: manifest.roleAssignments?.length ?? 0,
        },
        tuningInventory: {
            totalKnobs: inventory.knobs.length,
            knobs: inventory.knobs.slice(0, MAX_TUNE_ROWS).map(projectTuningKnob),
            omittedKnobs: Math.max(0, inventory.knobs.length - MAX_TUNE_ROWS),
            totalLimitations: inventory.limitations.length,
            limitations: inventory.limitations.slice(0, MAX_TUNE_ROWS)
                .map(projectTuningLimitation),
            omittedLimitations: Math.max(
                0,
                inventory.limitations.length - MAX_TUNE_ROWS,
            ),
        },
        ...(candidateManifest
            ? { candidateManifest }
            : {
                  candidateManifestOmittedReason:
                      inventory.knobs.length > MAX_TUNE_ROWS
                          ? 'inventory-windowed' as const
                          : 'manifest-too-large' as const,
              }),
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
                          MAX_METADATA_BYTES,
                      ),
                  }
                : {}),
            artifactRole,
        },
        distributedRun: {
            distributedRunId: projectAuthorityIdentifier(run.distributedRunId),
            controlRunId: projectAuthorityIdentifier(run.controlRunId),
            state: run.state,
            startedAtEpochMs: run.startedAtEpochMs,
            completedAtEpochMs: run.completedAtEpochMs,
            updatedAtEpochMs: finiteNumber(run.updatedAtEpochMs),
            targetAgentIds: {
                entries: targetAgentIds.map(value => projectOpaqueIdentifier(value)),
                total: run.targetAgentIds.length,
                omitted: Math.max(0, run.targetAgentIds.length - targetAgentIds.length),
            },
            rollup: projectTuneRollup(run.rollup) as typeof run.rollup,
        },
        analysis: projectAnalyzeAnalysis(model.analysis),
        receivedMessageDeltas: messageDeltas,
    };
    return withinSerializedLimit(candidate, () => minimalTuneFacade(
        model,
        selection,
        artifactRole,
        inventory.knobs.length,
        inventory.limitations.length,
        messageDeltas.total,
    ));
}
