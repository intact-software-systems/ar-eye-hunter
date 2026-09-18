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
 * The identity and outcome of a distributed run analysis, carried by every projection the Analyze
 * worker hands the view whether or not the display sections fit the transfer budget.
 */
export interface AnalyzeWorkerAnalysisProjectionSections {
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly distributedRunId: string;
    readonly controlRunId: string;
    readonly status: string;
    readonly summary: DistributedRunAnalysisSummary;
    readonly parseWarnings: readonly DistributedRunArtifactParseWarning[];
    /** Absent when the analysis omits the SPA report and verdict for an unavailable control run. */
    readonly spa?: Readonly<{ verdict: RunVerdictView; }>;
}

/** Every display section the analysis wrote, each bounded for transfer. */
export interface AnalyzeWorkerFullAnalysisProjection extends AnalyzeWorkerAnalysisProjectionSections {
    readonly detail: 'full';
    /** Absent when the analysis names no run group. */
    readonly group?: DistributedRunAnalysisGroup;
    /** Absent when the analysis omits performance for an unavailable control run. */
    readonly performance?: DistributedRunPerformanceAnalysis;
    /** Absent when the analysis records no target resolution. */
    readonly targetResolution?: DistributedRunTargetResolutionAnalysis;
    readonly summaryMarkdown: string;
    /** Absent with the performance section. */
    readonly performanceMarkdown?: string;
}

/**
 * What the worker sends instead when the full projection exceeds the transfer budget: identity,
 * outcome and the run's own summary counts, with no display section at all. A reader tells the two
 * apart by `detail` rather than by a placeholder sentence in a section that is not there.
 */
export interface AnalyzeWorkerBoundedAnalysisProjection extends AnalyzeWorkerAnalysisProjectionSections {
    readonly detail: 'bounded';
}

type AnalyzeWorkerAnalysisProjectionDetail =
    | AnalyzeWorkerFullAnalysisProjection
    | AnalyzeWorkerBoundedAnalysisProjection;

/**
 * Display detail and run outcome are independent facts about one projected analysis: either detail
 * can describe either outcome, so a reader narrows on `detail` and on `ok` separately.
 */
export type AnalyzeWorkerAnalysisProjection =
    | (AnalyzeWorkerAnalysisProjectionDetail & Readonly<{ ok: true; }>)
    | (
        & AnalyzeWorkerAnalysisProjectionDetail
        & Readonly<{
            ok: false;
            failure: DistributedRunFailureAnalysis;
            fixProposalMarkdown: string;
        }>
    );

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
