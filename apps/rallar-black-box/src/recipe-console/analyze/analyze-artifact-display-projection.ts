import type {
    DistributedArtifactInventoryItem,
    DistributedArtifactWorkspaceIssue,
} from '@shared-test/rallar-bb-test/mod.ts';
import type { AnalyzeArtifactModel } from './analyze-artifact-model.ts';
import { minimalAnalyzeAnalysis, projectAnalyzeAnalysis } from
    './analyze-analysis-projection.ts';
import type { AnalyzeArtifactProjection } from './analyze-worker-contract.ts';
import {
    boundedText,
    finiteNumber,
    MAX_ANALYSIS_ROWS,
    MAX_METADATA_BYTES,
    MAX_SUMMARY_BYTES,
    PROJECTION_OMISSION_MESSAGE,
    projectAuthorityIdentifier,
    projectOpaqueIdentifier,
    withinSerializedLimit,
} from './analyze-projection-bounds.ts';

export function projectAnalyzeArtifactModel(
    model: AnalyzeArtifactModel,
): AnalyzeArtifactProjection {
    const candidate: AnalyzeArtifactProjection = {
        distributedRunId: projectAuthorityIdentifier(model.distributedRunId),
        ...(model.controlRunId
            ? {
                  controlRunId: projectAuthorityIdentifier(model.controlRunId),
              }
            : {}),
        identity: projectAnalyzeIdentity(model.identity),
        workspace: {
            source: model.workspace.source,
            support: model.workspace.support,
            generatedAtEpochMs: finiteNumber(model.workspace.generatedAtEpochMs),
            ...(model.workspace.artifactSchemaVersion !== undefined
                ? { artifactSchemaVersion: finiteNumber(model.workspace.artifactSchemaVersion) }
                : {}),
            inventory: model.workspace.inventory
                .slice(0, MAX_ANALYSIS_ROWS)
                .map(projectInventoryItem),
            issues: model.workspace.issues
                .slice(0, MAX_ANALYSIS_ROWS)
                .map(projectWorkspaceIssue),
        },
        analysis: projectAnalyzeAnalysis(model.analysis),
        issueMarkdown: boundedText(model.issueMarkdown),
        provenance: projectProvenance(model, true),
        ...(model.firstActionableEvidenceId
            ? {
                  firstActionableEvidenceId: projectOpaqueIdentifier(
                      model.firstActionableEvidenceId,
                  ),
              }
            : {}),
    };
    return withinSerializedLimit(candidate, () => minimalArtifactProjection(model));
}

export function projectAnalyzeIdentity(
    identity: AnalyzeArtifactModel['identity'],
): AnalyzeArtifactProjection['identity'] {
    const distributedRunId = projectAuthorityIdentifier(identity.distributedRunId);
    const controlRunId = identity.controlRunId
        ? projectAuthorityIdentifier(identity.controlRunId)
        : undefined;
    return {
        distributedRunId,
        ...(distributedRunId === identity.distributedRunId
            ? {}
            : { distributedRunIdExact: false }),
        ...(controlRunId
            ? {
                  controlRunId,
                  ...(controlRunId === identity.controlRunId
                      ? {}
                      : { controlRunIdExact: false }),
              }
            : {}),
    };
}

function projectProvenance(
    model: AnalyzeArtifactModel,
    includeIgnoredFiles: boolean,
): AnalyzeArtifactProjection['provenance'] {
    return {
        source: model.provenance.source,
        label: boundedText(model.provenance.label, MAX_METADATA_BYTES),
        workspaceSource: model.provenance.workspaceSource,
        generatedAtEpochMs: finiteNumber(model.provenance.generatedAtEpochMs),
        selectedFileCount: finiteNumber(model.provenance.selectedFileCount),
        artifactFileCount: finiteNumber(model.provenance.artifactFileCount),
        loadedFileCount: finiteNumber(model.provenance.loadedFileCount),
        ignoredFileCount: finiteNumber(model.provenance.ignoredFileCount),
        workspaceIgnoredFileCount: finiteNumber(
            model.provenance.workspaceIgnoredFileCount,
        ),
        ignoredFiles: includeIgnoredFiles
            ? model.provenance.ignoredFiles.slice(0, MAX_ANALYSIS_ROWS).map(file => ({
                  basename: boundedText(file.basename, MAX_METADATA_BYTES),
                  sourcePath: boundedText(file.sourcePath, MAX_METADATA_BYTES),
                  reason: boundedText(file.reason, MAX_SUMMARY_BYTES),
              }))
            : [],
    };
}

function projectInventoryItem(
    item: DistributedArtifactInventoryItem,
): DistributedArtifactInventoryItem {
    return {
        fileName: boundedText(item.fileName, MAX_METADATA_BYTES),
        status: item.status,
        requirement: item.requirement,
        ...(item.message ? { message: boundedText(item.message, MAX_SUMMARY_BYTES) } : {}),
    };
}

export function projectWorkspaceIssue(
    issue: DistributedArtifactWorkspaceIssue,
): DistributedArtifactWorkspaceIssue {
    return {
        code: issue.code,
        severity: issue.severity,
        message: boundedText(issue.message, MAX_SUMMARY_BYTES),
        ...(issue.fileName
            ? { fileName: boundedText(issue.fileName, MAX_METADATA_BYTES) }
            : {}),
    };
}

function minimalArtifactProjection(model: AnalyzeArtifactModel): AnalyzeArtifactProjection {
    return {
        distributedRunId: projectAuthorityIdentifier(model.distributedRunId),
        ...(model.controlRunId
            ? {
                  controlRunId: projectAuthorityIdentifier(model.controlRunId),
              }
            : {}),
        identity: projectAnalyzeIdentity(model.identity),
        workspace: {
            source: model.workspace.source,
            support: model.workspace.support,
            generatedAtEpochMs: finiteNumber(model.workspace.generatedAtEpochMs),
            ...(model.workspace.artifactSchemaVersion !== undefined
                ? { artifactSchemaVersion: finiteNumber(model.workspace.artifactSchemaVersion) }
                : {}),
            inventory: [],
            issues: [{
                code: 'ignored-file',
                severity: 'warning',
                message: PROJECTION_OMISSION_MESSAGE,
            }],
        },
        analysis: minimalAnalyzeAnalysis(model.analysis),
        issueMarkdown: PROJECTION_OMISSION_MESSAGE,
        provenance: projectProvenance(model, false),
        ...(model.firstActionableEvidenceId
            ? {
                  firstActionableEvidenceId: projectOpaqueIdentifier(
                      model.firstActionableEvidenceId,
                  ),
              }
            : {}),
    };
}
