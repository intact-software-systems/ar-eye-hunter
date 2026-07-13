import {
    composeDistributedArtifactIssueMarkdown,
    deriveDistributedArtifactWorkspace,
    deriveDistributedArtifactEvidenceIndex,
    distributedArtifactPipelineJsonRecord,
    searchDistributedArtifactEvidence,
    type DistributedArtifactEvidenceIndex,
    type DistributedArtifactEvidenceSearchResult,
    type DistributedArtifactWorkspace,
    type DistributedRunAnalysis,
    type DistributedRunArtifactFiles,
    type DistributedRunArtifactSnapshots,
    type ParsedDistributedArtifactPipeline,
} from '@shared-test/rallar-bb-test/mod.ts';
import type { RecipeConsoleUrlState } from '../routing/url-state-contract.ts';

export type AnalyzeArtifactSource = 'local-files' | 'control';

export type AnalyzeArtifactIgnoredFile = Readonly<{
    basename: string;
    sourcePath: string;
    reason: string;
}>;

export type AnalyzeArtifactModelInput = Readonly<{
    files: DistributedRunArtifactFiles;
    source: AnalyzeArtifactSource;
    label: string;
    generatedAtEpochMs?: number;
    artifactSchemaVersion?: number;
    ignoredFiles?: readonly AnalyzeArtifactIgnoredFile[];
}>;

export type AnalyzePortableArtifactEnvelope = Readonly<{
    artifactSchemaVersion: number;
    distributedRunId: string;
    generatedAtEpochMs: number;
    files: Readonly<Record<string, string>>;
}>;

export type AnalyzeArtifactProvenance = Readonly<{
    source: AnalyzeArtifactSource;
    label: string;
    workspaceSource: DistributedArtifactWorkspace['source'];
    generatedAtEpochMs: number;
    selectedFileCount: number;
    artifactFileCount: number;
    loadedFileCount: number;
    ignoredFileCount: number;
    workspaceIgnoredFileCount: number;
    ignoredFiles: readonly AnalyzeArtifactIgnoredFile[];
}>;

export type AnalyzeArtifactModel = Readonly<{
    distributedRunId: string;
    controlRunId?: string;
    identity: Readonly<{
        distributedRunId: string;
        controlRunId?: string;
    }>;
    workspace: DistributedArtifactWorkspace;
    analysis: DistributedRunAnalysis;
    snapshots: DistributedRunArtifactSnapshots;
    evidenceIndex: DistributedArtifactEvidenceIndex;
    issueMarkdown: string;
    portableEnvelope: AnalyzePortableArtifactEnvelope;
    provenance: AnalyzeArtifactProvenance;
    firstActionableEvidenceId?: string;
}>;

export type AnalyzeArtifactModelErrorCode =
    | 'generic-artifact-unsupported'
    | 'unknown-artifact-family'
    | 'unusable-distributed-artifact';

export class AnalyzeArtifactModelError extends Error {
    readonly code: AnalyzeArtifactModelErrorCode;
    readonly workspace: DistributedArtifactWorkspace;

    constructor(
        code: AnalyzeArtifactModelErrorCode,
        message: string,
        workspace: DistributedArtifactWorkspace,
    ) {
        super(message);
        this.name = 'AnalyzeArtifactModelError';
        this.code = code;
        this.workspace = workspace;
    }
}

export function createAnalyzeArtifactModel(
    input: AnalyzeArtifactModelInput,
): AnalyzeArtifactModel {
    const derived = deriveDistributedArtifactWorkspace({
        files: input.files,
        generatedAtEpochMs: input.generatedAtEpochMs,
        artifactSchemaVersion: input.artifactSchemaVersion,
    });
    const workspace = derived.workspace;
    rejectUnsupportedFamily(workspace, input.label);

    const analysis = workspace.analysis;
    const snapshots = workspace.snapshots;
    if (!analysis || !snapshots) {
        throw new AnalyzeArtifactModelError(
            'unusable-distributed-artifact',
            `${input.label} does not contain usable distributed-run analysis and snapshots.`,
            workspace,
        );
    }

    const portableFiles = normalizedPortableFiles(derived.parsed.projectedFiles);
    const evidenceIndex = deriveDistributedArtifactEvidenceIndex({
        analysis,
        snapshots,
        monitor: derived.monitor,
        parsedControlRun: distributedArtifactPipelineJsonRecord(
            derived.parsed,
            'control-run.json',
        ),
        sourceFileNames: Object.keys(portableFiles),
        sourceFiles: derived.parsed.projectedFiles,
    });
    const ignoredFiles = normalizedIgnoredFiles(input.ignoredFiles ?? []);
    const selectedArtifactFileCount = selectedInputFileCount(derived.parsed);
    const firstActionableEvidenceId = evidenceIndex.entries.find(
        entry => entry.kind === 'failure',
    )?.id;

    return {
        distributedRunId: analysis.distributedRunId,
        ...(analysis.controlRunId
            ? { controlRunId: analysis.controlRunId }
            : {}),
        identity: {
            distributedRunId: analysis.distributedRunId,
            ...(analysis.controlRunId
                ? { controlRunId: analysis.controlRunId }
                : {}),
        },
        workspace,
        analysis,
        snapshots,
        evidenceIndex,
        issueMarkdown: composeDistributedArtifactIssueMarkdown({
            analysis,
            index: evidenceIndex,
        }),
        portableEnvelope: {
            artifactSchemaVersion: workspace.artifactSchemaVersion ??
                analysis.artifactSchemaVersion ?? 1,
            distributedRunId: analysis.distributedRunId,
            generatedAtEpochMs: workspace.generatedAtEpochMs,
            files: portableFiles,
        },
        provenance: {
            source: input.source,
            label: input.label,
            workspaceSource: workspace.source,
            generatedAtEpochMs: workspace.generatedAtEpochMs,
            selectedFileCount: selectedArtifactFileCount + ignoredFiles.length,
            artifactFileCount: Object.keys(portableFiles).length,
            loadedFileCount: workspace.inventory.filter(
                item => item.status === 'loaded',
            ).length,
            ignoredFileCount: ignoredFiles.length,
            workspaceIgnoredFileCount: workspace.inventory.filter(
                item => item.status === 'ignored',
            ).length,
            ignoredFiles,
        },
        ...(firstActionableEvidenceId
            ? { firstActionableEvidenceId }
            : {}),
    };
}

function selectedInputFileCount(
    parsed: ParsedDistributedArtifactPipeline,
): number {
    if (parsed.source === 'bundle-envelope') {
        return 1 + parsed.projection.outerIgnoredFiles.length;
    }
    return Object.values(parsed.projectedFiles).filter(
        value => typeof value === 'string',
    ).length;
}

export function deriveAnalyzeArtifactSearchResult(
    model: AnalyzeArtifactModel,
    urlState: RecipeConsoleUrlState,
): DistributedArtifactEvidenceSearchResult {
    return searchDistributedArtifactEvidence(model.evidenceIndex, {
        query: urlState.historyQuery,
        agentId: urlState.agentId,
        recipeId: urlState.recipeId,
        commandId: urlState.commandId,
        status: urlState.status,
        severity: urlState.diagnosticSeverity,
        transport: urlState.transport,
        fromEpochMs: urlState.from,
        toEpochMs: urlState.to,
    });
}

function rejectUnsupportedFamily(
    workspace: DistributedArtifactWorkspace,
    label: string,
): void {
    if (workspace.family === 'distributed-run') return;
    if (workspace.family === 'black-box-runner') {
        throw new AnalyzeArtifactModelError(
            'generic-artifact-unsupported',
            `${label} is a generic black-box-runner artifact; use the legacy Shared Test importer.`,
            workspace,
        );
    }
    throw new AnalyzeArtifactModelError(
        'unknown-artifact-family',
        `${label} does not identify a supported distributed-run artifact.`,
        workspace,
    );
}

function normalizedPortableFiles(
    files: DistributedRunArtifactFiles,
): Readonly<Record<string, string>> {
    return Object.fromEntries(
        Object.entries(files)
            .filter((entry): entry is [string, string] =>
                typeof entry[1] === 'string'
            )
            .sort(([left], [right]) => left.localeCompare(right)),
    );
}

function normalizedIgnoredFiles(
    files: readonly AnalyzeArtifactIgnoredFile[],
): readonly AnalyzeArtifactIgnoredFile[] {
    return [...files]
        .map(file => ({ ...file }))
        .sort((left, right) =>
            left.sourcePath.localeCompare(right.sourcePath) ||
            left.basename.localeCompare(right.basename)
        );
}
