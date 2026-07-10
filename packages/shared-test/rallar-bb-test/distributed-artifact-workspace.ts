import {
    deriveDistributedRunArtifactPipelineAnalysis,
    distributedArtifactSnapshotsFromPipeline,
    parseDistributedRunArtifactPipeline,
    type DistributedRunAnalysis,
    type DistributedRunArtifactSnapshots,
} from './distributed-artifact-analysis.ts';
import {
    createDistributedArtifactInventoryFromParsed,
    declaredDistributedArtifactSchemaVersionFromParsed,
    distributedArtifactGeneratedAtFromParsed,
    distributedArtifactSchemaInventory,
    distributedArtifactWorkspaceSupport,
    identifyDistributedArtifactFamilyFromParsed,
    inferredDistributedArtifactSchemaVersionFromParsed,
} from './distributed-artifact-compatibility.ts';
import { distributedArtifactIdentityIssuesFromParsed } from './distributed-artifact-identity.ts';
import {
    parseDistributedArtifactPipeline,
    type ParsedDistributedArtifactPipeline,
} from './distributed-artifact-pipeline.ts';
import type {
    DistributedRunAnalysisReport,
    DistributedRunMonitor,
} from './distributed-run-monitor.ts';
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
    return deriveDistributedArtifactWorkspace(input).workspace;
}

export type DistributedArtifactWorkspaceDerivationTelemetry = Readonly<{
    parsedArtifactPassCount: number;
    normalizedSnapshotCount: number;
    bundleDerivationCount: number;
    monitorDerivationCount: number;
    reportDerivationCount: number;
}>;

export type DerivedDistributedArtifactWorkspace = Readonly<{
    parsed: ParsedDistributedArtifactPipeline;
    workspace: DistributedArtifactWorkspace;
    monitor?: DistributedRunMonitor;
    report?: DistributedRunAnalysisReport;
    telemetry: DistributedArtifactWorkspaceDerivationTelemetry;
}>;

export function deriveDistributedArtifactWorkspace(
    input: DistributedArtifactWorkspaceInput,
): DerivedDistributedArtifactWorkspace {
    const parsed = parseDistributedArtifactPipeline(input.files);
    const telemetry = {
        parsedArtifactPassCount: 0,
        normalizedSnapshotCount: 0,
        bundleDerivationCount: 0,
        monitorDerivationCount: 0,
        reportDerivationCount: 0,
    };
    const projection = parsed.projection;
    const files = projection.files;
    const family = identifyDistributedArtifactFamilyFromParsed(
        parsed,
        projection.distributedRunId,
    );
    const issues: DistributedArtifactWorkspaceIssue[] = [];
    const inventory = createDistributedArtifactInventoryFromParsed(
        family,
        parsed,
        projection,
        issues,
    );
    const envelopeVersion = projection.artifactSchemaVersion;
    const hasSchemaConflict = input.artifactSchemaVersion !== undefined &&
        envelopeVersion !== undefined &&
        input.artifactSchemaVersion !== envelopeVersion;
    let artifactSchemaVersion = input.artifactSchemaVersion ?? envelopeVersion ??
        declaredDistributedArtifactSchemaVersionFromParsed(parsed) ??
        inferredDistributedArtifactSchemaVersionFromParsed(parsed, family);

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
        ? distributedArtifactIdentityIssuesFromParsed(parsed)
        : [];
    issues.push(...identityIssues);

    const generatedAtEpochMs = input.generatedAtEpochMs ??
        projection.generatedAtEpochMs ?? distributedArtifactGeneratedAtFromParsed(parsed) ??
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
    let monitor: DistributedRunMonitor | undefined;
    let report: DistributedRunAnalysisReport | undefined;
    if (
        family === 'distributed-run' && !hasSchemaConflict &&
        !projection.invalidSchemaMessage && !projection.fatalMessage
    ) {
        try {
            const parsedFiles = parseDistributedRunArtifactPipeline(parsed);
            telemetry.parsedArtifactPassCount += 1;
            snapshots = distributedArtifactSnapshotsFromPipeline(
                parsed,
                generatedAtEpochMs,
                artifactSchemaVersion,
                parsedFiles,
            );
            telemetry.normalizedSnapshotCount += 1;
            telemetry.bundleDerivationCount += 1;
            bundle = snapshots.artifactBundle;
            const analysisResult = deriveDistributedRunArtifactPipelineAnalysis({
                parsed,
                generatedAtEpochMs,
                artifactSchemaVersion,
                parsedFiles,
                snapshots,
                artifactBundle: bundle,
            });
            analysis = analysisResult.analysis;
            monitor = analysisResult.monitor;
            report = analysisResult.report;
            telemetry.monitorDerivationCount +=
                analysisResult.telemetry.monitorDerivationCount;
            telemetry.reportDerivationCount +=
                analysisResult.telemetry.reportDerivationCount;
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
    const workspace = {
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
    return { parsed, workspace, monitor, report, telemetry };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
