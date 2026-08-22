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

export type DistributedArtifactInventoryItem = Readonly<{
    fileName: string;
    status: DistributedArtifactInventoryStatus;
    requirement: 'core' | 'optional' | 'recognized' | 'schema' | 'unknown';
    message?: string;
}>;

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
    | 'analysis-failed';

export type DistributedArtifactWorkspaceIssue = Readonly<{
    code: DistributedArtifactWorkspaceIssueCode;
    severity: 'warning' | 'error';
    message: string;
    fileName?: string;
}>;

export type DistributedArtifactWorkspaceInput = Readonly<{
    files: DistributedRunArtifactFiles;
    generatedAtEpochMs?: number;
    artifactSchemaVersion?: number;
}>;

export type DistributedArtifactWorkspace = Readonly<{
    family: DistributedArtifactFamily;
    source: DistributedArtifactWorkspaceSource;
    support: DistributedArtifactWorkspaceSupport;
    generatedAtEpochMs: number;
    artifactSchemaVersion?: number;
    distributedRunId?: string;
    files: DistributedRunArtifactFiles;
    inventory: readonly DistributedArtifactInventoryItem[];
    issues: readonly DistributedArtifactWorkspaceIssue[];
    analysis?: DistributedRunAnalysis;
    snapshots?: DistributedRunArtifactSnapshots;
    bundle?: ControlDistributedRunArtifactBundle;
}>;

export type DistributedArtifactEnvelopeProjection = Readonly<{
    source: DistributedArtifactWorkspaceSource;
    files: DistributedRunArtifactFiles;
    envelopeFileName?: string;
    artifactSchemaVersion?: number;
    generatedAtEpochMs?: number;
    distributedRunId?: string;
    invalidFiles: Readonly<Record<string, string>>;
    outerIgnoredFiles: readonly string[];
    invalidSchemaMessage?: string;
    fatalMessage?: string;
    fatalCode?: 'ambiguous-envelope' | 'incompatible-file';
}>;

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
