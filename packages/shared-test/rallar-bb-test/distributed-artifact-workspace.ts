import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactBundleFromFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunAnalysis,
    type DistributedRunArtifactSnapshots,
} from './distributed-artifact-analysis.ts';
import {
    createDistributedArtifactInventory,
    declaredDistributedArtifactSchemaVersion,
    distributedArtifactGeneratedAt,
    distributedArtifactSchemaInventory,
    distributedArtifactWorkspaceSupport,
    identifyDistributedArtifactFamily,
    inferredDistributedArtifactSchemaVersion,
} from './distributed-artifact-compatibility.ts';
import { projectDistributedArtifactEnvelope } from './distributed-artifact-envelope.ts';
import { distributedArtifactIdentityIssues } from './distributed-artifact-identity.ts';
import {
    DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS,
    type DistributedArtifactWorkspace,
    type DistributedArtifactWorkspaceInput,
    type DistributedArtifactWorkspaceIssue,
} from './distributed-artifact-workspace-contracts.ts';

export type {
    DistributedArtifactFamily,
    DistributedArtifactInventoryItem,
    DistributedArtifactInventoryStatus,
    DistributedArtifactWorkspace,
    DistributedArtifactWorkspaceInput,
    DistributedArtifactWorkspaceIssue,
    DistributedArtifactWorkspaceIssueCode,
    DistributedArtifactWorkspaceSource,
    DistributedArtifactWorkspaceSupport,
} from './distributed-artifact-workspace-contracts.ts';

export function createDistributedArtifactWorkspace(
    input: DistributedArtifactWorkspaceInput,
): DistributedArtifactWorkspace {
    const projection = projectDistributedArtifactEnvelope(input.files);
    const files = projection.files;
    const family = identifyDistributedArtifactFamily(
        files,
        projection.distributedRunId,
    );
    const issues: DistributedArtifactWorkspaceIssue[] = [];
    const inventory = createDistributedArtifactInventory(
        family,
        files,
        projection,
        issues,
    );
    const envelopeVersion = projection.artifactSchemaVersion;
    const hasSchemaConflict = input.artifactSchemaVersion !== undefined &&
        envelopeVersion !== undefined &&
        input.artifactSchemaVersion !== envelopeVersion;
    let artifactSchemaVersion = input.artifactSchemaVersion ?? envelopeVersion ??
        declaredDistributedArtifactSchemaVersion(files) ??
        inferredDistributedArtifactSchemaVersion(files, family);

    if (hasSchemaConflict) {
        const message = `Caller schema version ${input.artifactSchemaVersion} conflicts with envelope schema version ${envelopeVersion}.`;
        artifactSchemaVersion = undefined;
        inventory.push(distributedArtifactSchemaInventory('incompatible', message));
        issues.push({
            code: 'schema-version-conflict', severity: 'error', message,
            fileName: '$artifactSchemaVersion',
        });
    } else if (projection.invalidSchemaMessage) {
        inventory.push(distributedArtifactSchemaInventory(
            'incompatible',
            projection.invalidSchemaMessage,
        ));
        issues.push({
            code: 'incompatible-file', severity: 'error',
            message: projection.invalidSchemaMessage,
            fileName: projection.envelopeFileName,
        });
    } else if (
        artifactSchemaVersion !== undefined &&
        !DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS.has(artifactSchemaVersion)
    ) {
        const message = `Artifact schema version ${artifactSchemaVersion} is not supported.`;
        inventory.push(distributedArtifactSchemaInventory('unknown-version', message));
        issues.push({
            code: 'unknown-schema-version', severity: 'error', message,
            fileName: '$artifactSchemaVersion',
        });
    }
    if (projection.fatalMessage) {
        issues.push({
            code: projection.fatalCode ?? 'incompatible-file', severity: 'error',
            message: projection.fatalMessage,
            fileName: projection.envelopeFileName,
        });
    }
    if (family !== 'distributed-run') {
        issues.push({
            code: 'unsupported-family', severity: 'error',
            message: family === 'black-box-runner'
                ? 'Generic black-box-runner artifacts use a separate reader and are not distributed-run artifacts.'
                : 'The selected files do not identify a supported distributed-run artifact family.',
        });
    }
    const identityIssues = family === 'distributed-run'
        ? distributedArtifactIdentityIssues(files)
        : [];
    issues.push(...identityIssues);

    const generatedAtEpochMs = input.generatedAtEpochMs ??
        projection.generatedAtEpochMs ?? distributedArtifactGeneratedAt(files) ??
        Date.now();
    let support = distributedArtifactWorkspaceSupport({
        family,
        inventory,
        hasSchemaConflict,
        hasInvalidEnvelopeSchema: projection.invalidSchemaMessage !== undefined,
        hasFatalEnvelopeIssue: projection.fatalMessage !== undefined,
        artifactSchemaVersion,
    });
    if (identityIssues.length > 0) support = 'incompatible';
    let analysis: DistributedRunAnalysis | undefined;
    let snapshots: DistributedRunArtifactSnapshots | undefined;
    let bundle: DistributedArtifactWorkspace['bundle'];
    if (
        family === 'distributed-run' && !hasSchemaConflict &&
        !projection.invalidSchemaMessage && !projection.fatalMessage
    ) {
        try {
            analysis = analyzeDistributedRunArtifactFiles({
                files, generatedAtEpochMs, artifactSchemaVersion,
            });
            snapshots = distributedArtifactSnapshotsFromFiles(
                files,
                generatedAtEpochMs,
                artifactSchemaVersion,
            );
            bundle = distributedArtifactBundleFromFiles(
                files,
                generatedAtEpochMs,
                analysis.distributedRunId,
                artifactSchemaVersion,
            );
        } catch (error) {
            support = 'incompatible';
            issues.push({
                code: 'analysis-failed', severity: 'error',
                message: `Unable to analyze distributed-run artifacts: ${errorMessage(error)}`,
            });
        }
    }
    if (
        analysis && projection.distributedRunId &&
        projection.distributedRunId !== analysis.distributedRunId
    ) {
        support = 'incompatible';
        issues.push({
            code: 'identity-conflict', severity: 'error',
            fileName: projection.envelopeFileName,
            message: `${projection.envelopeFileName ?? 'Artifact envelope'} declares distributed run ${projection.distributedRunId}, but distributed-run.json contains ${analysis.distributedRunId}.`,
        });
    }
    return {
        family,
        source: projection.source,
        support,
        generatedAtEpochMs,
        artifactSchemaVersion,
        distributedRunId: analysis?.distributedRunId ?? projection.distributedRunId,
        files,
        inventory,
        issues,
        analysis,
        snapshots,
        bundle,
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
