export const ANALYZE_ARTIFACT_MAX_FILE_COUNT = 24;
export const ANALYZE_ARTIFACT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const ANALYZE_ARTIFACT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

export const ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES = [
    'distributed-run.json',
    'manifest.json',
    'target-resolution.json',
    'runner-summary.json',
    'control-post-create-error.json',
    'control-post-stage-error.json',
    'control-post-start-error.json',
    'control-post-request-error.json',
    'control-post-error-metadata.json',
    'control-run.json',
    'fleet-report.json',
    'report.json',
    'results.jsonl',
    'events.jsonl',
    'failures.json',
    'metadata.json'
] as const;

export type AnalyzeFileLike = Readonly<{
    name: string;
    size: number;
    text(): Promise<string>;
    type?: string;
    webkitRelativePath?: string;
}>;

export type AnalyzeTransferFileLike = Readonly<{
    name: string;
    size: number;
    arrayBuffer(): Promise<ArrayBuffer>;
    type?: string;
    webkitRelativePath?: string;
}>;

export type AnalyzeAcceptedFileKind = 'authoritative' | 'envelope-candidate';

export type AnalyzeAcceptedFile = Readonly<{
    basename: string;
    sourcePath: string;
    sizeBytes: number;
    type?: string;
    kind: AnalyzeAcceptedFileKind;
}>;

export type AnalyzeIgnoredFile = Readonly<{
    basename: string;
    sourcePath: string;
    reason: 'unsupported-extension';
}>;

export type AnalyzeArtifactFileIntake = Readonly<{
    files: Readonly<Record<string, string>>;
    acceptedFiles: readonly AnalyzeAcceptedFile[];
    ignoredFiles: readonly AnalyzeIgnoredFile[];
    totalSelectedBytes: number;
}>;

export type AnalyzeTransferFile = Readonly<{
    name: string;
    bytes: ArrayBuffer;
}>;

export type AnalyzeArtifactTransferIntake = Readonly<{
    files: readonly AnalyzeTransferFile[];
    acceptedFiles: readonly AnalyzeAcceptedFile[];
    ignoredFiles: readonly AnalyzeIgnoredFile[];
    totalSelectedBytes: number;
    transferList: readonly ArrayBuffer[];
}>;

export type AnalyzeFileIntakeFailureCode =
    | 'too-many-files'
    | 'invalid-file-size'
    | 'file-too-large'
    | 'total-too-large'
    | 'unsafe-path'
    | 'duplicate-basename'
    | 'no-json-files'
    | 'file-size-mismatch'
    | 'read-failed';

/**
 * Why a file selection was refused. Every variant carries the exact sentence the operator sees, so
 * a caller folds one value instead of matching an error class.
 */
export type AnalyzeFileIntakeFailure = Readonly<{
    code: AnalyzeFileIntakeFailureCode;
    message: string;
}>;

/**
 * The operator-visible sentence a refused intake carries. A caller reads the intake through
 * `outcome.right` and reaches this with `outcome.left`, which the `Either` invariant guarantees is
 * present there; the second arm names the refusal rather than inventing a cause.
 */
export function toAnalyzeFileIntakeMessage(
    failure: AnalyzeFileIntakeFailure | undefined
): string {
    return failure?.message ?? 'The selected files were refused.';
}

export type AnalyzeSelectedFileMetadata = Readonly<{
    name: string;
    size: number;
    type?: string;
    webkitRelativePath?: string;
}>;

export type NormalizedSelectedFile<TFile extends AnalyzeSelectedFileMetadata> = Readonly<{
    file: TFile;
    basename: string;
    sourcePath: string;
}>;

export type AnalyzeArtifactFileIntakePlan<TFile extends AnalyzeSelectedFileMetadata> = Readonly<{
    accepted: readonly NormalizedSelectedFile<TFile>[];
    ignoredFiles: readonly AnalyzeIgnoredFile[];
    totalSelectedBytes: number;
}>;
