import {
    deriveDistributedRunArtifactPipelineAnalysis,
    parseDistributedRunArtifactPipeline,
    type DistributedRunArtifactPipelineAnalysisResult
} from './distributed-artifact-analysis.ts';
import {
    createDistributedArtifactInventoryFromParsed,
    declaredDistributedArtifactSchemaVersionFromParsed,
    distributedArtifactGeneratedAtFromParsed,
    distributedArtifactSchemaInventory,
    distributedArtifactWorkspaceSupport,
    identifyDistributedArtifactFamilyFromParsed,
    inferredDistributedArtifactSchemaVersionFromParsed
} from './distributed-artifact-compatibility.ts';
import { distributedArtifactIdentityIssuesFromParsed } from './distributed-artifact-identity.ts';
import {
    parseDistributedArtifactPipeline,
    type ParsedDistributedArtifactPipeline
} from './distributed-artifact-pipeline.ts';
import {
    DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS,
    type DistributedArtifactWorkspace,
    type DistributedArtifactWorkspaceInput,
    type DistributedArtifactWorkspaceIssue
} from './distributed-artifact-workspace-contracts.ts';
import type { DistributedRunAnalysisReport } from './distributed-run-analysis/distributed-run-analysis-report.ts';
import type { DistributedRunMonitor } from './distributed-run-monitor.ts';

export type {
    DistributedArtifactFamily,
    DistributedArtifactInventoryItem,
    DistributedArtifactInventoryStatus,
    DistributedArtifactWorkspace,
    DistributedArtifactWorkspaceInput,
    DistributedArtifactWorkspaceIssue,
    DistributedArtifactWorkspaceIssueCode,
    DistributedArtifactWorkspaceSource,
    DistributedArtifactWorkspaceSupport
} from './distributed-artifact-workspace-contracts.ts';

export function createDistributedArtifactWorkspace(
    input: DistributedArtifactWorkspaceInput
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
    input: DistributedArtifactWorkspaceInput
): DerivedDistributedArtifactWorkspace {
    const parsed = parseDistributedArtifactPipeline(input.files);
    const telemetry = {
        parsedArtifactPassCount: 0,
        normalizedSnapshotCount: 0,
        bundleDerivationCount: 0,
        monitorDerivationCount: 0,
        reportDerivationCount: 0
    };
    const projection = parsed.projection;
    const files = projection.files;
    const family = identifyDistributedArtifactFamilyFromParsed(
        parsed,
        projection.distributedRunId
    );
    const issues: DistributedArtifactWorkspaceIssue[] = [];
    const inventory = createDistributedArtifactInventoryFromParsed(
        family,
        parsed,
        projection,
        issues
    );
    const envelopeVersion = projection.artifactSchemaVersion;
    const hasSchemaConflict = input.artifactSchemaVersion !== undefined &&
        envelopeVersion !== undefined &&
        input.artifactSchemaVersion !== envelopeVersion;
    let artifactSchemaVersion = input.artifactSchemaVersion ?? envelopeVersion ??
        declaredDistributedArtifactSchemaVersionFromParsed(parsed) ??
        inferredDistributedArtifactSchemaVersionFromParsed(parsed, family);

    if (hasSchemaConflict) {
        const message =
            `Caller schema version ${input.artifactSchemaVersion} conflicts with envelope schema version ${envelopeVersion}.`;
        artifactSchemaVersion = undefined;
        inventory.push(distributedArtifactSchemaInventory('incompatible', message));
        issues.push({
            code: 'schema-version-conflict',
            severity: 'error',
            message,
            fileName: '$artifactSchemaVersion'
        });
    }
    else if (projection.invalidSchemaMessage) {
        inventory.push(distributedArtifactSchemaInventory(
            'incompatible',
            projection.invalidSchemaMessage
        ));
        issues.push({
            code: 'incompatible-file',
            severity: 'error',
            message: projection.invalidSchemaMessage,
            fileName: projection.envelopeFileName
        });
    }
    else if (
        artifactSchemaVersion !== undefined &&
        !DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS.has(artifactSchemaVersion)
    ) {
        const message = `Artifact schema version ${artifactSchemaVersion} is not supported.`;
        inventory.push(distributedArtifactSchemaInventory('unknown-version', message));
        issues.push({
            code: 'unknown-schema-version',
            severity: 'error',
            message,
            fileName: '$artifactSchemaVersion'
        });
    }
    if (projection.fatalMessage) {
        issues.push({
            code: projection.fatalCode ?? 'incompatible-file',
            severity: 'error',
            message: projection.fatalMessage,
            fileName: projection.envelopeFileName
        });
    }
    if (family !== 'distributed-run') {
        issues.push({
            code: 'unsupported-family',
            severity: 'error',
            message: family === 'black-box-runner'
                ? 'Generic black-box-runner artifacts use a separate reader and are not distributed-run artifacts.'
                : 'The selected files do not identify a supported distributed-run artifact family.'
        });
    }
    const identityIssues = family === 'distributed-run'
        ? distributedArtifactIdentityIssuesFromParsed(parsed)
        : [];
    issues.push(...identityIssues);

    const generatedAtEpochMs = input.generatedAtEpochMs ??
        projection.generatedAtEpochMs ?? distributedArtifactGeneratedAtFromParsed(parsed);
    let support = distributedArtifactWorkspaceSupport({
        family,
        inventory,
        hasSchemaConflict,
        hasInvalidEnvelopeSchema: projection.invalidSchemaMessage !== undefined,
        hasFatalEnvelopeIssue: projection.fatalMessage !== undefined,
        artifactSchemaVersion
    });
    if (identityIssues.length > 0) {
        support = 'incompatible';
    }
    let derived: DistributedRunArtifactPipelineAnalysisResult | undefined;
    if (
        family === 'distributed-run' && !hasSchemaConflict &&
        !projection.invalidSchemaMessage && !projection.fatalMessage
    ) {
        if (generatedAtEpochMs === undefined) {
            support = 'incompatible';
            issues.push({
                code: 'missing-generation-time',
                severity: 'error',
                message:
                    'The artifacts record no generation time (neither an envelope nor metadata.json), and none was supplied.'
            });
        }
        else {
            const content = parseDistributedRunArtifactPipeline(parsed);
            telemetry.parsedArtifactPassCount += 1;
            if (content.left !== undefined) {
                support = support === 'incomplete' ? 'incomplete' : 'incompatible';
                issues.push({
                    code: 'analysis-failed',
                    severity: 'error',
                    fileName: content.left.fileName,
                    message: `Unable to analyze distributed-run artifacts: ${content.left.message}`
                });
            }
            else if (content.right?.variant === 'control-request-failure') {
                support = 'incompatible';
                issues.push({
                    code: 'control-request-failure',
                    severity: 'error',
                    fileName: 'control-post-error-metadata.json',
                    message:
                        `The artifacts record a failed control ${content.right.controlPostFailure.request.phase} request and contain no distributed run; analyze the folder with the distributed-run artifact CLI.`
                });
            }
            else if (content.right?.variant === 'distributed-run') {
                derived = deriveDistributedRunArtifactPipelineAnalysis({
                    parsed,
                    content: content.right,
                    generatedAtEpochMs,
                    artifactSchemaVersion
                });
                telemetry.normalizedSnapshotCount += 1;
                telemetry.bundleDerivationCount += 1;
                telemetry.monitorDerivationCount += derived.telemetry.monitorDerivationCount;
                telemetry.reportDerivationCount += derived.telemetry.reportDerivationCount;
            }
        }
    }
    const analysis = derived?.analysis;
    if (
        analysis && projection.distributedRunId &&
        projection.distributedRunId !== analysis.distributedRunId
    ) {
        support = 'incompatible';
        issues.push({
            code: 'identity-conflict',
            severity: 'error',
            fileName: projection.envelopeFileName,
            message: `${
                projection.envelopeFileName ?? 'Artifact envelope'
            } declares distributed run ${projection.distributedRunId}, but distributed-run.json contains ${analysis.distributedRunId}.`
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
        snapshots: derived?.snapshots,
        bundle: derived?.snapshots.artifactBundle
    };
    return { parsed, workspace, monitor: derived?.monitor, report: derived?.report, telemetry };
}
