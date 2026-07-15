import type {
    ControlDistributedRunSnapshot,
    DistributedArtifactEvidenceEntry,
    DistributedArtifactEvidenceWindowCounts,
    DistributedArtifactInventoryItem,
    DistributedArtifactWorkspaceIssue,
    DistributedArtifactWorkspaceSource,
    DistributedArtifactWorkspaceSupport,
    DistributedRunAnalysis,
    DistributedRunTuningInventoryLimitation,
    DistributedRunTuningKnob,
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedStartMode,
    RallarBlackBoxDistributedTargetPolicyMode,
    RallarBlackBoxDistributedRunManifest,
    RunVerdictView,
} from '@shared-test/rallar-bb-test/mod.ts';
import type {
    AnalyzeArtifactIgnoredFile,
    AnalyzePrimaryResultFailure,
    AnalyzeArtifactSource,
} from './analyze-artifact-model.ts';

export type AnalyzeArtifactWorkspaceProjection = Readonly<{
    source: DistributedArtifactWorkspaceSource;
    support: DistributedArtifactWorkspaceSupport;
    generatedAtEpochMs: number;
    artifactSchemaVersion?: number;
    inventory: readonly DistributedArtifactInventoryItem[];
    issues: readonly DistributedArtifactWorkspaceIssue[];
}>;

export type AnalyzeWorkerAnalysisProjection = Readonly<
    Omit<DistributedRunAnalysis, 'spa'> & {
        spa?: Readonly<{ verdict: RunVerdictView }>;
    }
>;

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
    distributedRun: Pick<
        ControlDistributedRunSnapshot,
        | 'distributedRunId'
        | 'controlRunId'
        | 'state'
        | 'startedAtEpochMs'
        | 'completedAtEpochMs'
        | 'updatedAtEpochMs'
        | 'rollup'
    > & Readonly<{
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
