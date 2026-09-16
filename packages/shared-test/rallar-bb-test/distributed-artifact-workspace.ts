import {
    computeDistributedRunArtifactPipelineAnalysis,
    type DistributedRunArtifactPipelineAnalysisResult
} from './distributed-artifact-analysis.ts';
import { toDistributedRunArtifactContent } from './distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
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
    type DistributedArtifactFamily,
    type DistributedArtifactInventoryItem,
    type DistributedArtifactWorkspace,
    type DistributedArtifactWorkspaceInput,
    type DistributedArtifactWorkspaceIssue,
    type DistributedArtifactWorkspaceSupport
} from './distributed-artifact-workspace-contracts.ts';
import type { DistributedRunAnalysisReport } from './distributed-run-analysis/distributed-run-analysis-report.ts';
import type { DistributedRunMonitor } from './distributed-run-monitor.ts';

export interface DistributedArtifactWorkspaceDerivationTelemetry {
    readonly parsedArtifactPassCount: number;
    readonly normalizedSnapshotCount: number;
    readonly bundleDerivationCount: number;
    readonly monitorDerivationCount: number;
    readonly reportDerivationCount: number;
}

export interface DerivedDistributedArtifactWorkspace {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly workspace: DistributedArtifactWorkspace;
    /** Absent when the workspace holds no analyzable distributed run. */
    readonly monitor?: DistributedRunMonitor;
    /** Absent when the workspace holds no analyzable distributed run. */
    readonly report?: DistributedRunAnalysisReport;
    readonly telemetry: DistributedArtifactWorkspaceDerivationTelemetry;
}

interface WorkspaceSchemaInput {
    readonly input: DistributedArtifactWorkspaceInput;
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly family: DistributedArtifactFamily;
}

interface WorkspaceSchema {
    /** Absent when the caller and the envelope disagree or no version is declared or implied. */
    readonly artifactSchemaVersion?: number;
    readonly hasSchemaConflict: boolean;
    readonly inventory: readonly DistributedArtifactInventoryItem[];
    readonly issues: readonly DistributedArtifactWorkspaceIssue[];
}

interface WorkspaceAnalysisInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    /** Absent when neither the caller, an artifact envelope nor metadata.json supplies a generation time. */
    readonly generatedAtEpochMs?: number;
    /** Absent when the caller and the envelope disagree or no version is declared or implied. */
    readonly artifactSchemaVersion?: number;
    readonly support: DistributedArtifactWorkspaceSupport;
}

interface WorkspaceAnalysis {
    readonly support: DistributedArtifactWorkspaceSupport;
    readonly issues: readonly DistributedArtifactWorkspaceIssue[];
    /** One when the artifact content was read, whether or not it held a distributed run. */
    readonly parsedArtifactPassCount: number;
    /** Absent when the artifacts hold no analyzable distributed run. */
    readonly derived?: DistributedRunArtifactPipelineAnalysisResult;
}

export function createDistributedArtifactWorkspace(
    input: DistributedArtifactWorkspaceInput
): DistributedArtifactWorkspace {
    return computeDistributedArtifactWorkspace(input).workspace;
}

export function computeDistributedArtifactWorkspace(
    input: DistributedArtifactWorkspaceInput
): DerivedDistributedArtifactWorkspace {
    const parsed = parseDistributedArtifactPipeline(input.files);
    const { projection } = parsed;
    const family = identifyDistributedArtifactFamilyFromParsed(parsed, projection.distributedRunId);
    const schema = toWorkspaceSchema({ input, parsed, family });
    const identityIssues = family === 'distributed-run' ? distributedArtifactIdentityIssuesFromParsed(parsed) : [];
    const generatedAtEpochMs = input.generatedAtEpochMs ?? projection.generatedAtEpochMs ??
        distributedArtifactGeneratedAtFromParsed(parsed);
    const assessedSupport = distributedArtifactWorkspaceSupport({
        family,
        inventory: schema.inventory,
        hasSchemaConflict: schema.hasSchemaConflict,
        hasInvalidEnvelopeSchema: projection.invalidSchemaMessage !== undefined,
        hasFatalEnvelopeIssue: projection.fatalMessage !== undefined,
        artifactSchemaVersion: schema.artifactSchemaVersion
    });
    const support = identityIssues.length > 0 ? 'incompatible' : assessedSupport;
    const analysis = family === 'distributed-run' && !schema.hasSchemaConflict &&
            !projection.invalidSchemaMessage && !projection.fatalMessage
        ? toWorkspaceAnalysis({
            parsed,
            generatedAtEpochMs,
            artifactSchemaVersion: schema.artifactSchemaVersion,
            support
        })
        : { support, issues: [], parsedArtifactPassCount: 0 };
    const { derived } = analysis;
    const identityConflict = toIdentityConflictIssue(parsed, derived);
    const workspace = {
        family,
        source: projection.source,
        support: identityConflict ? 'incompatible' : analysis.support,
        generatedAtEpochMs,
        artifactSchemaVersion: schema.artifactSchemaVersion,
        distributedRunId: derived?.analysis.distributedRunId ?? projection.distributedRunId,
        files: projection.files,
        inventory: schema.inventory,
        issues: [
            ...schema.issues,
            ...toEnvelopeIssues(parsed, family),
            ...identityIssues,
            ...analysis.issues,
            ...(identityConflict ? [identityConflict] : [])
        ],
        analysis: derived?.analysis,
        snapshots: derived?.snapshots,
        bundle: derived?.snapshots?.artifactBundle
    } satisfies DistributedArtifactWorkspace;
    return { parsed, workspace, monitor: derived?.monitor, report: derived?.report, telemetry: toTelemetry(analysis) };
}

/** A caller version that contradicts the envelope clears the version; otherwise an unsupported version is flagged. */
function toWorkspaceSchema(schemaInput: WorkspaceSchemaInput): WorkspaceSchema {
    const { input, parsed, family } = schemaInput;
    const { projection } = parsed;
    const issues: DistributedArtifactWorkspaceIssue[] = [];
    const inventory = createDistributedArtifactInventoryFromParsed(family, parsed, projection, issues);
    const envelopeVersion = projection.artifactSchemaVersion;
    const hasSchemaConflict = input.artifactSchemaVersion !== undefined && envelopeVersion !== undefined &&
        input.artifactSchemaVersion !== envelopeVersion;
    if (hasSchemaConflict) {
        const message =
            `Caller schema version ${input.artifactSchemaVersion} conflicts with envelope schema version ${envelopeVersion}.`;
        inventory.push(distributedArtifactSchemaInventory('incompatible', message));
        issues.push({
            code: 'schema-version-conflict',
            severity: 'error',
            message,
            fileName: '$artifactSchemaVersion'
        });
        return { hasSchemaConflict, inventory, issues };
    }
    const artifactSchemaVersion = input.artifactSchemaVersion ?? envelopeVersion ??
        declaredDistributedArtifactSchemaVersionFromParsed(parsed) ??
        inferredDistributedArtifactSchemaVersionFromParsed(parsed, family);
    if (projection.invalidSchemaMessage) {
        inventory.push(distributedArtifactSchemaInventory('incompatible', projection.invalidSchemaMessage));
        issues.push({
            code: 'incompatible-file',
            severity: 'error',
            message: projection.invalidSchemaMessage,
            fileName: projection.envelopeFileName
        });
    }
    else if (
        artifactSchemaVersion !== undefined && !DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS.has(artifactSchemaVersion)
    ) {
        const message = `Artifact schema version ${artifactSchemaVersion} is not supported.`;
        inventory.push(distributedArtifactSchemaInventory('unknown-version', message));
        issues.push({ code: 'unknown-schema-version', severity: 'error', message, fileName: '$artifactSchemaVersion' });
    }
    return { artifactSchemaVersion, hasSchemaConflict, inventory, issues };
}

function toEnvelopeIssues(
    parsed: ParsedDistributedArtifactPipeline,
    family: DistributedArtifactFamily
): readonly DistributedArtifactWorkspaceIssue[] {
    const { projection } = parsed;
    const fatalIssues: readonly DistributedArtifactWorkspaceIssue[] = projection.fatalMessage
        ? [{
            code: projection.fatalCode ?? 'incompatible-file',
            severity: 'error',
            message: projection.fatalMessage,
            fileName: projection.envelopeFileName
        }]
        : [];
    if (family === 'distributed-run') {
        return fatalIssues;
    }
    return [...fatalIssues, {
        code: 'unsupported-family',
        severity: 'error',
        message: family === 'black-box-runner'
            ? 'Generic black-box-runner artifacts use a separate reader and are not distributed-run artifacts.'
            : 'The selected files do not identify a supported distributed-run artifact family.'
    }];
}

/** Analysis needs a generation time and content that holds a distributed run rather than a failed request. */
function toWorkspaceAnalysis(analysisInput: WorkspaceAnalysisInput): WorkspaceAnalysis {
    const { parsed, generatedAtEpochMs, support } = analysisInput;
    if (generatedAtEpochMs === undefined) {
        return {
            support: 'incompatible',
            parsedArtifactPassCount: 0,
            issues: [{
                code: 'missing-generation-time',
                severity: 'error',
                message:
                    'The artifacts record no generation time (neither an envelope nor metadata.json), and none was supplied.'
            }]
        };
    }
    const content = toDistributedRunArtifactContent(parsed);
    if (content.left !== undefined) {
        return {
            support: support === 'incomplete' ? 'incomplete' : 'incompatible',
            parsedArtifactPassCount: 1,
            issues: [{
                code: 'analysis-failed',
                severity: 'error',
                fileName: content.left.fileName,
                message: `Unable to analyze distributed-run artifacts: ${content.left.message}`
            }]
        };
    }
    if (content.right?.variant !== 'distributed-run') {
        return {
            support: 'incompatible',
            parsedArtifactPassCount: 1,
            issues: [{
                code: 'control-request-failure',
                severity: 'error',
                fileName: 'control-post-error-metadata.json',
                message:
                    `The artifacts record a failed control ${content.right?.controlPostFailure.request.phase} request and contain no distributed run; analyze the folder with the distributed-run artifact CLI.`
            }]
        };
    }
    const derived = computeDistributedRunArtifactPipelineAnalysis({
        parsed,
        content: content.right,
        generatedAtEpochMs,
        artifactSchemaVersion: analysisInput.artifactSchemaVersion
    });
    return { support, issues: [], parsedArtifactPassCount: 1, derived };
}

function toIdentityConflictIssue(
    parsed: ParsedDistributedArtifactPipeline,
    derived: DistributedRunArtifactPipelineAnalysisResult | undefined
): DistributedArtifactWorkspaceIssue | undefined {
    const { projection } = parsed;
    const analysis = derived?.analysis;
    if (!analysis || !projection.distributedRunId || projection.distributedRunId === analysis.distributedRunId) {
        return undefined;
    }
    return {
        code: 'identity-conflict',
        severity: 'error',
        fileName: projection.envelopeFileName,
        message: `${
            projection.envelopeFileName ?? 'Artifact envelope'
        } declares distributed run ${projection.distributedRunId}, but distributed-run.json contains ${analysis.distributedRunId}.`
    };
}

function toTelemetry(analysis: WorkspaceAnalysis): DistributedArtifactWorkspaceDerivationTelemetry {
    const derivedCount = analysis.derived === undefined ? 0 : 1;
    return {
        parsedArtifactPassCount: analysis.parsedArtifactPassCount,
        normalizedSnapshotCount: derivedCount,
        bundleDerivationCount: derivedCount,
        monitorDerivationCount: analysis.derived?.telemetry.monitorDerivationCount ?? 0,
        reportDerivationCount: analysis.derived?.telemetry.reportDerivationCount ?? 0
    };
}
