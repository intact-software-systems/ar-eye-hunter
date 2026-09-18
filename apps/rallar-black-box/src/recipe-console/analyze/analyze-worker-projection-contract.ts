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
    /**
     * Absent when the loaded files declare no schema version of their own. This is the artifact's
     * own declaration; the analysis section's `artifactSchemaVersion` is the analyzer's and is
     * always present.
     */
    artifactSchemaVersion?: number;
    inventory: readonly DistributedArtifactInventoryItem[];
    issues: readonly DistributedArtifactWorkspaceIssue[];
}>;

/**
 * The sections of a distributed run analysis the Analyze worker hands the view, bounded for
 * transfer. A bounded projection empties its rows and names the omission in its markdown; it never
 * drops a field the analysis always writes.
 */
export interface AnalyzeWorkerAnalysisProjectionSections {
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly status: string;
    /** Absent when the analysis names no run group, or the projection is bounded. */
    readonly group?: DistributedRunAnalysisGroup;
    readonly summary: DistributedRunAnalysisSummary;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    /** Absent when the analysis omits performance for an unavailable control run, or the projection is bounded. */
    readonly performance?: DistributedRunPerformanceAnalysis;
    /** Absent when the analysis records no target resolution, or the projection is bounded. */
    readonly targetResolution?: DistributedRunTargetResolutionAnalysis;
    /** Absent when the analysis omits the SPA report and verdict for an unavailable control run. */
    readonly spa?: Readonly<{ verdict: RunVerdictView; }>;
    readonly summaryMarkdown: string;
    /** Absent with the performance section. */
    readonly performanceMarkdown?: string;
}

export interface AnalyzeWorkerPassedAnalysisProjection extends AnalyzeWorkerAnalysisProjectionSections {
    readonly ok: true;
}

export interface AnalyzeWorkerFailedAnalysisProjection extends AnalyzeWorkerAnalysisProjectionSections {
    readonly ok: false;
    readonly failure: DistributedRunFailureAnalysis;
    readonly fixProposalMarkdown: string;
}

export type AnalyzeWorkerAnalysisProjection =
    | AnalyzeWorkerPassedAnalysisProjection
    | AnalyzeWorkerFailedAnalysisProjection;

export type AnalyzeArtifactProjection = Readonly<{
    distributedRunId: string;
    /** Absent when the analysed artifact names no control run. */
    controlRunId?: string;
    identity: Readonly<{
        distributedRunId: string;
        distributedRunIdExact: boolean;
        /** Absent when the analysed artifact names no control run. */
        controlRunId?: string;
        /** Absent with `controlRunId`; the projection always writes it beside one. */
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
    /** Absent when no evidence row is a failure the operator should open first. */
    firstActionableEvidenceId?: string;
    /** Absent when the analysis ties no primary recipe result to a failure. */
    primaryResultFailure?: AnalyzePrimaryResultFailure;
}>;

export type AnalyzeEvidenceWindowProjection = Readonly<{
    entries: readonly DistributedArtifactEvidenceEntry[];
    rangeStart: number;
    rangeEnd: number;
    /** Absent on the first window of a search, which has no earlier page. */
    previousCursor?: string;
    /** Absent on the last window of a search, which has no later page. */
    nextCursor?: string;
    counts: DistributedArtifactEvidenceWindowCounts;
    totalMatchesIsComplete: boolean;
    windowSize: number;
}>;

export type AnalyzeTuneArtifactFacade = Readonly<{
    identity: AnalyzeArtifactProjection['identity'];
    support: DistributedArtifactWorkspaceSupport;
    supportIssues: Readonly<{
        entries: readonly DistributedArtifactWorkspaceIssue[];
        total: number;
        omitted: number;
    }>;
    generatedAtEpochMs: number;
    manifestSummary: Readonly<{
        distributedRunId: string;
        controlRunId: string;
        /** Absent when the manifest author gives the run no display name. */
        displayName?: string;
        group: RallarBlackBoxDistributedGroupRef;
        startMode: RallarBlackBoxDistributedStartMode;
        recipeIds: Readonly<{
            entries: readonly string[];
            total: number;
            omitted: number;
        }>;
        targetPolicy: Readonly<{
            mode: RallarBlackBoxDistributedTargetPolicyMode;
            /** Absent when the target policy accepts however many agents it resolves. */
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
    /**
     * Absent when the manifest falls outside the facade's bounded transfer window, so the facade
     * carries only `manifestSummary` and the candidate preview stays reference-only.
     */
    candidateManifest?: RallarBlackBoxDistributedRunManifest;
    selection: Readonly<{
        /** Absent when the Tune URL names no focus run. */
        focusRunId?: string;
        /** Absent when the Tune URL names no left comparison run. */
        compareLeft?: string;
        /** Absent when the Tune URL names no right comparison run. */
        compareRight?: string;
        /** Absent when the Tune URL names no timing metric, so the view keeps its own default. */
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
            /** Absent when the analysis records no expected inbound count for the agent. */
            expectedMessages?: number;
            /** Absent with `expectedMessages`, and when their difference is not finite. */
            delta?: number;
        }>[];
        total: number;
        omitted: number;
    }>;
}>;
