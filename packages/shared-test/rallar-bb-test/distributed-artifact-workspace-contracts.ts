import type { ControlDistributedRunArtifactBundle } from './control-snapshots.ts';
import type {
    DistributedRunAnalysis,
    DistributedRunArtifactFiles,
    DistributedRunArtifactSnapshots
} from './distributed-artifact-analysis.ts';

export type DistributedArtifactFamily =
    | 'distributed-run'
    | 'black-box-runner'
    | 'unknown';

export type DistributedArtifactWorkspaceSource =
    | 'loose-files'
    | 'bundle-envelope';

export type DistributedArtifactWorkspaceSupport =
    | 'supported'
    | 'incomplete'
    | 'incompatible'
    | 'unsupported';

export type DistributedArtifactInventoryStatus =
    | 'loaded'
    | 'missing-core'
    | 'missing-optional'
    | 'malformed'
    | 'incompatible'
    | 'ignored'
    | 'unknown-version';

export interface DistributedArtifactInventoryItem {
    readonly fileName: string;
    readonly status: DistributedArtifactInventoryStatus;
    readonly requirement: 'core' | 'optional' | 'recognized' | 'schema' | 'unknown';
    /** Absent exactly when the file loaded as its contract. */
    readonly message?: string;
}

export type DistributedArtifactWorkspaceIssueCode =
    | 'missing-core'
    | 'missing-optional'
    | 'malformed-file'
    | 'incompatible-file'
    | 'ignored-file'
    | 'unknown-schema-version'
    | 'schema-version-conflict'
    | 'ambiguous-envelope'
    | 'identity-conflict'
    | 'unsupported-family'
    | 'missing-generation-time'
    | 'control-request-failure'
    | 'analysis-failed';

export interface DistributedArtifactWorkspaceIssue {
    readonly code: DistributedArtifactWorkspaceIssueCode;
    readonly severity: 'warning' | 'error';
    readonly message: string;
    /** Absent when the issue concerns the artifacts as a whole rather than one file. */
    readonly fileName?: string;
}

export interface DistributedArtifactWorkspaceInput {
    readonly files: DistributedRunArtifactFiles;
    /** Absent when the artifact envelope or metadata.json supplies the generation time. */
    readonly generatedAtEpochMs?: number;
    /** Absent when the artifact envelope, metadata.json or the files present supply the schema version. */
    readonly artifactSchemaVersion?: number;
}

export interface DistributedArtifactWorkspace {
    readonly family: DistributedArtifactFamily;
    readonly source: DistributedArtifactWorkspaceSource;
    readonly support: DistributedArtifactWorkspaceSupport;
    /** Absent when neither the caller, an artifact envelope nor metadata.json supplies a generation time. */
    readonly generatedAtEpochMs?: number;
    /** Absent when the caller and the envelope disagree or no version is declared or implied. */
    readonly artifactSchemaVersion?: number;
    /** Absent when neither the analysis nor an artifact envelope names a distributed run. */
    readonly distributedRunId?: string;
    readonly files: DistributedRunArtifactFiles;
    readonly inventory: readonly DistributedArtifactInventoryItem[];
    readonly issues: readonly DistributedArtifactWorkspaceIssue[];
    /** Absent when the files are not an analyzable distributed-run artifact; the issues say why. */
    readonly analysis?: DistributedRunAnalysis;
    /** Absent when the analysis has no control run snapshot to read. */
    readonly snapshots?: DistributedRunArtifactSnapshots;
    /** Absent when the analysis has no control run snapshot or the files include no manifest.json. */
    readonly bundle?: ControlDistributedRunArtifactBundle;
}

/** Why a selected artifact envelope cannot be used. */
export interface DistributedArtifactEnvelopeFatalIssue {
    readonly code: 'ambiguous-envelope' | 'incompatible-file';
    readonly message: string;
}

export interface DistributedArtifactEnvelopeProjection {
    readonly source: DistributedArtifactWorkspaceSource;
    readonly files: DistributedRunArtifactFiles;
    /** Absent for loose files. */
    readonly envelopeFileName?: string;
    /** Absent for loose files and for an envelope whose artifactSchemaVersion is not a finite integer. */
    readonly artifactSchemaVersion?: number;
    /** Absent for loose files and for an envelope whose generatedAtEpochMs is not a finite number. */
    readonly generatedAtEpochMs?: number;
    /** Absent for loose files and for an envelope that names no distributed run. */
    readonly distributedRunId?: string;
    readonly invalidFiles: Readonly<Record<string, string>>;
    readonly outerIgnoredFiles: readonly string[];
    /** Absent unless an envelope's artifactSchemaVersion is not a finite integer. */
    readonly invalidSchemaMessage?: string;
    /** Absent when the files hold no envelope or exactly one compatible envelope. */
    readonly fatal?: DistributedArtifactEnvelopeFatalIssue;
}

export const DISTRIBUTED_ARTIFACT_CORE_FILE_NAMES = [
    'distributed-run.json',
    'manifest.json',
    'control-run.json'
] as const;

export const DISTRIBUTED_ARTIFACT_OPTIONAL_FILE_NAMES = [
    'target-resolution.json',
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json'
] as const;

export const DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS = new Set([1, 2]);
