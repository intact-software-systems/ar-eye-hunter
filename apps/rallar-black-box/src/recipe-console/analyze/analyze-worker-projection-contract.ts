import type {
    ControlDistributedRunSnapshot,
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindowCounts,
    DistributedArtifactInventoryItem,
    DistributedArtifactWorkspaceIssue,
    DistributedArtifactWorkspaceSource,
    DistributedArtifactWorkspaceSupport,
    DistributedRunAnalysisGroup,
    DistributedRunAnalysisSummary,
    DistributedRunArtifactParseWarning,
    DistributedRunFailureAnalysis,
    DistributedRunPerformanceAnalysis,
    DistributedRunTargetResolutionAnalysis,
    DistributedRunTuningInventoryLimitation,
    DistributedRunTuningKnob,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedStartMode,
    RallarBlackBoxDistributedTargetPolicyMode,
    RunVerdictView
} from '@shared-test/rallar-bb-test/mod.ts';
import type {
    AnalyzeArtifactIgnoredFile,
    AnalyzeArtifactSource,
    AnalyzePrimaryResultFailure
} from './analyze-artifact-model.ts';

export type AnalyzeArtifactWorkspaceProjection = Readonly<{
    source: DistributedArtifactWorkspaceSource;
    support: DistributedArtifactWorkspaceSupport;
    generatedAtEpochMs: number;
    artifactSchemaVersion?: number;
    inventory: readonly DistributedArtifactInventoryItem[];
    issues: readonly DistributedArtifactWorkspaceIssue[];
}>;

/**
 * The distributed run analysis the Analyze worker hands the view, bounded for transfer. A minimal
 * projection keeps the run identity, verdict and summary only.
 */
export interface AnalyzeWorkerAnalysisProjection {
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly status: string;
    readonly ok: boolean;
    /** Absent when the analysis names no run group or the projection is minimal. */
    readonly group?: DistributedRunAnalysisGroup;
    readonly summary: DistributedRunAnalysisSummary;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    /** Absent when the run passed or the projection is minimal. */
    readonly failure?: DistributedRunFailureAnalysis;
    /** Absent when the analysis omits performance for an unavailable control run or the projection is minimal. */
    readonly performance?: DistributedRunPerformanceAnalysis;
    /** Absent when the analysis records no target resolution or the projection is minimal. */
    readonly targetResolution?: DistributedRunTargetResolutionAnalysis;
    /** Absent when the analysis omits the SPA report and verdict for an unavailable control run. */
    readonly spa?: Readonly<{ verdict: RunVerdictView; }>;
    readonly summaryMarkdown: string;
    /** Absent when the run passed or the projection is minimal. */
    readonly fixProposalMarkdown?: string;
    /** Absent with the performance section. */
    readonly performanceMarkdown?: string;
}

export type AnalyzeArtifactProjection = Readonly<{
    distributedRunId: string;
    controlRunId?: string;
    identity: Readonly<{
        distributedRunId: string;
        distributedRunIdExact?: boolean;
        controlRunId?: string;
        controlRunIdExact?: boolean;
    }>;
    workspace: AnalyzeArtifactWorkspaceProjection;
    analysis: AnalyzeWorkerAnalysisProjection;
    issueMarkdown: string;
    provenance: Readonly<{
        source: AnalyzeArtifactSource;
        label: string;
        workspaceSource: DistributedArtifactWorkspaceSource;
        generatedAtEpochMs: number;
        selectedFileCount: number;
        artifactFileCount: number;
        loadedFileCount: number;
        ignoredFileCount: number;
        workspaceIgnoredFileCount: number;
        ignoredFiles: readonly AnalyzeArtifactIgnoredFile[];
    }>;
    firstActionableEvidenceId?: string;
    primaryResultFailure?: AnalyzePrimaryResultFailure;
}>;

export type AnalyzeEvidenceWindowProjection = Readonly<{
    entries: readonly DistributedArtifactEvidenceEntry[];
    rangeStart: number;
    rangeEnd: number;
    previousCursor?: string;
    nextCursor?: string;
    counts: DistributedArtifactEvidenceWindowCounts;
    totalMatchesIsComplete: boolean;
    windowSize: number;
}>;

export type AnalyzeTuneArtifactFacade = Readonly<{
    identity: AnalyzeArtifactProjection['identity'];
    support: DistributedArtifactWorkspaceSupport;
    supportIssues?: Readonly<{
        entries: readonly DistributedArtifactWorkspaceIssue[];
        total: number;
        omitted: number;
    }>;
    generatedAtEpochMs: number;
    manifestSummary: Readonly<{
        distributedRunId: string;
        controlRunId?: string;
        displayName?: string;
        group: RallarBlackBoxDistributedGroupRef;
        startMode?: RallarBlackBoxDistributedStartMode;
        recipeIds: Readonly<{
            entries: readonly string[];
            total: number;
            omitted: number;
        }>;
        targetPolicy: Readonly<{
            mode: RallarBlackBoxDistributedTargetPolicyMode;
            expectedParticipantCount?: number;
            configuredAgentCount: number;
            configuredRoleCount: number;
        }>;
        roleAssignmentCount: number;
    }>;
    tuningInventory: Readonly<{
        totalKnobs: number;
        knobs: readonly DistributedRunTuningKnob[];
        omittedKnobs: number;
        totalLimitations: number;
        limitations: readonly DistributedRunTuningInventoryLimitation[];
        omittedLimitations: number;
    }>;
    candidateManifest?: RallarBlackBoxDistributedRunManifest;
    candidateManifestOmittedReason?: 'inventory-windowed' | 'manifest-too-large';
    selection: Readonly<{
        focusRunId?: string;
        compareLeft?: string;
        compareRight?: string;
        timingMetric?: string;
        artifactRole: 'focus' | 'compare-left' | 'compare-right' | 'unrelated';
    }>;
    distributedRun:
        & Pick<
            ControlDistributedRunSnapshot,
            | 'distributedRunId'
            | 'controlRunId'
            | 'state'
            | 'startedAtEpochMs'
            | 'completedAtEpochMs'
            | 'updatedAtEpochMs'
            | 'rollup'
        >
        & Readonly<{
            targetAgentIds: Readonly<{
                entries: readonly string[];
                total: number;
                omitted: number;
            }>;
        }>;
    analysis: AnalyzeWorkerAnalysisProjection;
    receivedMessageDeltas: Readonly<{
        entries: readonly Readonly<{
            agentId: string;
            receivedMessages: number;
            expectedMessages?: number;
            delta?: number;
        }>[];
        total: number;
        omitted: number;
    }>;
}>;
