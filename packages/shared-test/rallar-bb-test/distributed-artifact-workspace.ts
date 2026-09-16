import type { DistributedRunAnalysis, DistributedRunArtifactRejection } from './distributed-artifact-analysis.ts';
import {
    computeDistributedRunArtifactPipelineAnalysis,
    resolveArtifactSchemaVersion,
    type DistributedRunArtifactPipelineAnalysisResult
} from './distributed-artifact-analysis/compute-distributed-run-artifact-pipeline-analysis.ts';
import {
    toDistributedRunArtifactContent,
    type DistributedRunBundleContent,
    type DistributedRunControlRequestFailureContent
} from './distributed-artifact-analysis/to-distributed-run-artifact-content.ts';
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

export interface DistributedArtifactWorkspaceComputed {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly workspace: DistributedArtifactWorkspace;
    /** Absent when the workspace holds no analyzable distributed run. */
    readonly monitor?: DistributedRunMonitor;
    /** Absent when the workspace holds no analyzable distributed run. */
    readonly report?: DistributedRunAnalysisReport;
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

interface SchemaVersionFinding {
    readonly inventoryItem: DistributedArtifactInventoryItem;
    readonly issue: DistributedArtifactWorkspaceIssue;
}

interface WorkspaceAnalysisInput {
    readonly parsed: ParsedDistributedArtifactPipeline;
    readonly family: DistributedArtifactFamily;
    readonly schema: WorkspaceSchema;
    /** Undefined when neither the caller, an artifact envelope nor metadata.json supplies a generation time. */
    readonly generatedAtEpochMs: number | undefined;
    readonly support: DistributedArtifactWorkspaceSupport;
}

interface WorkspaceAnalysis {
    readonly support: DistributedArtifactWorkspaceSupport;
    readonly issues: readonly DistributedArtifactWorkspaceIssue[];
    /** Absent when the artifacts hold no analyzable distributed run. */
    readonly pipelineAnalysis?: DistributedRunArtifactPipelineAnalysisResult;
}

const MISSING_GENERATION_TIME_ISSUE: DistributedArtifactWorkspaceIssue = {
    code: 'missing-generation-time',
    severity: 'error',
    message: 'The artifacts record no generation time (neither an envelope nor metadata.json), and none was supplied.'
};

export function computeDistributedArtifactWorkspace(
    input: DistributedArtifactWorkspaceInput
): DistributedArtifactWorkspaceComputed {
    const parsed = parseDistributedArtifactPipeline(input.files);
    const { projection } = parsed;
    const family = identifyDistributedArtifactFamilyFromParsed(parsed, projection.distributedRunId);
    const schema = toWorkspaceSchema({ input, parsed, family });
    const identityIssues = family === 'distributed-run' ? distributedArtifactIdentityIssuesFromParsed(parsed) : [];
    const generatedAtEpochMs = input.generatedAtEpochMs ?? projection.generatedAtEpochMs ??
        distributedArtifactGeneratedAtFromParsed(parsed);
    const analysis = toWorkspaceAnalysis({
        parsed,
        family,
        schema,
        generatedAtEpochMs,
        support: identityIssues.length > 0 ? 'incompatible' : toAssessedWorkspaceSupport(parsed, family, schema)
    });
    const { pipelineAnalysis } = analysis;
    const workspace = {
        family,
        source: projection.source,
        support: analysis.support,
        generatedAtEpochMs,
        artifactSchemaVersion: schema.artifactSchemaVersion,
        distributedRunId: pipelineAnalysis?.analysis.distributedRunId ?? projection.distributedRunId,
        files: projection.files,
        inventory: schema.inventory,
        issues: [
            ...schema.issues,
            ...toEnvelopeIssues(parsed, family),
            ...identityIssues,
            ...analysis.issues
        ],
        analysis: pipelineAnalysis?.analysis,
        snapshots: pipelineAnalysis?.snapshots,
        bundle: pipelineAnalysis?.snapshots?.artifactBundle
    } satisfies DistributedArtifactWorkspace;
    return { parsed, workspace, monitor: pipelineAnalysis?.monitor, report: pipelineAnalysis?.report };
}

/** A caller version that contradicts the envelope clears the version; otherwise an unsupported version is flagged. */
function toWorkspaceSchema(schemaInput: WorkspaceSchemaInput): WorkspaceSchema {
    const { input, parsed, family } = schemaInput;
    const { projection } = parsed;
    const inventoryIssues: DistributedArtifactWorkspaceIssue[] = [];
    const inventory = createDistributedArtifactInventoryFromParsed(family, parsed, projection, inventoryIssues);
    const envelopeVersion = projection.artifactSchemaVersion;
    if (
        input.artifactSchemaVersion !== undefined && envelopeVersion !== undefined &&
        input.artifactSchemaVersion !== envelopeVersion
    ) {
        const message =
            `Caller schema version ${input.artifactSchemaVersion} conflicts with envelope schema version ${envelopeVersion}.`;
        return {
            hasSchemaConflict: true,
            inventory: [...inventory, distributedArtifactSchemaInventory('incompatible', message)],
            issues: [
                ...inventoryIssues,
                { code: 'schema-version-conflict', severity: 'error', message, fileName: '$artifactSchemaVersion' }
            ]
        };
    }
    const artifactSchemaVersion = input.artifactSchemaVersion ?? envelopeVersion ??
        declaredDistributedArtifactSchemaVersionFromParsed(parsed) ??
        inferredDistributedArtifactSchemaVersionFromParsed(parsed, family);
    const finding = toSchemaVersionFinding(parsed, artifactSchemaVersion);
    return {
        artifactSchemaVersion,
        hasSchemaConflict: false,
        inventory: finding === undefined ? inventory : [...inventory, finding.inventoryItem],
        issues: finding === undefined ? inventoryIssues : [...inventoryIssues, finding.issue]
    };
}

/** Absent when the envelope schema is valid and the version is supported or not known at all. */
function toSchemaVersionFinding(
    parsed: ParsedDistributedArtifactPipeline,
    artifactSchemaVersion: number | undefined
): SchemaVersionFinding | undefined {
    const { projection } = parsed;
    if (projection.invalidSchemaMessage) {
        return {
            inventoryItem: distributedArtifactSchemaInventory('incompatible', projection.invalidSchemaMessage),
            issue: {
                code: 'incompatible-file',
                severity: 'error',
                message: projection.invalidSchemaMessage,
                fileName: projection.envelopeFileName
            }
        };
    }
    if (artifactSchemaVersion === undefined || DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS.has(artifactSchemaVersion)) {
        return undefined;
    }
    const message = `Artifact schema version ${artifactSchemaVersion} is not supported.`;
    return {
        inventoryItem: distributedArtifactSchemaInventory('unknown-version', message),
        issue: { code: 'unknown-schema-version', severity: 'error', message, fileName: '$artifactSchemaVersion' }
    };
}

function toAssessedWorkspaceSupport(
    parsed: ParsedDistributedArtifactPipeline,
    family: DistributedArtifactFamily,
    schema: WorkspaceSchema
): DistributedArtifactWorkspaceSupport {
    const { projection } = parsed;
    return distributedArtifactWorkspaceSupport({
        family,
        inventory: schema.inventory,
        hasSchemaConflict: schema.hasSchemaConflict,
        hasInvalidEnvelopeSchema: projection.invalidSchemaMessage !== undefined,
        hasFatalEnvelopeIssue: projection.fatalMessage !== undefined,
        artifactSchemaVersion: schema.artifactSchemaVersion
    });
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

/**
 * Only a distributed-run family with a consistent schema and envelope is analyzed; analysis then needs a
 * generation time and content that holds a distributed run rather than a failed request.
 */
function toWorkspaceAnalysis(analysisInput: WorkspaceAnalysisInput): WorkspaceAnalysis {
    const { parsed, family, schema, generatedAtEpochMs, support } = analysisInput;
    const { projection } = parsed;
    if (
        family !== 'distributed-run' || schema.hasSchemaConflict || projection.invalidSchemaMessage ||
        projection.fatalMessage
    ) {
        return { support, issues: [] };
    }
    if (generatedAtEpochMs === undefined) {
        return { support: 'incompatible', issues: [MISSING_GENERATION_TIME_ISSUE] };
    }
    return toDistributedRunArtifactContent(parsed).fold(
        (rejection): WorkspaceAnalysis => ({
            support: support === 'incomplete' ? 'incomplete' : 'incompatible',
            issues: [toAnalysisFailedIssue(rejection)]
        }),
        (content) =>
            content.variant === 'distributed-run'
                ? toDistributedRunWorkspaceAnalysis(analysisInput, content, generatedAtEpochMs)
                : { support: 'incompatible', issues: [toControlRequestFailureIssue(content)] }
    );
}

/** An envelope that names a different run than distributed-run.json makes the analyzed workspace incompatible. */
function toDistributedRunWorkspaceAnalysis(
    analysisInput: WorkspaceAnalysisInput,
    content: DistributedRunBundleContent,
    generatedAtEpochMs: number
): WorkspaceAnalysis {
    const { parsed, schema, support } = analysisInput;
    const pipelineAnalysis = computeDistributedRunArtifactPipelineAnalysis({
        parsed,
        content,
        generatedAtEpochMs,
        artifactSchemaVersion: schema.artifactSchemaVersion ?? resolveArtifactSchemaVersion(parsed)
    });
    const identityConflict = toIdentityConflictIssue(parsed, pipelineAnalysis.analysis);
    return identityConflict === undefined
        ? { support, issues: [], pipelineAnalysis }
        : { support: 'incompatible', issues: [identityConflict], pipelineAnalysis };
}

function toAnalysisFailedIssue(rejection: DistributedRunArtifactRejection): DistributedArtifactWorkspaceIssue {
    return {
        code: 'analysis-failed',
        severity: 'error',
        fileName: rejection.fileName,
        message: `Unable to analyze distributed-run artifacts: ${rejection.message}`
    };
}

function toControlRequestFailureIssue(
    content: DistributedRunControlRequestFailureContent
): DistributedArtifactWorkspaceIssue {
    return {
        code: 'control-request-failure',
        severity: 'error',
        fileName: 'control-post-error-metadata.json',
        message:
            `The artifacts record a failed control ${content.controlPostFailure.request.phase} request and contain no distributed run; analyze the folder with the distributed-run artifact CLI.`
    };
}

function toIdentityConflictIssue(
    parsed: ParsedDistributedArtifactPipeline,
    analysis: DistributedRunAnalysis
): DistributedArtifactWorkspaceIssue | undefined {
    const { projection } = parsed;
    if (!projection.distributedRunId || projection.distributedRunId === analysis.distributedRunId) {
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
