import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import {
    ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES,
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_FILE_COUNT,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES,
    type AnalyzeAcceptedFile,
    type AnalyzeArtifactFileIntakePlan,
    type AnalyzeFileIntakeFailure,
    type AnalyzeIgnoredFile,
    type AnalyzeSelectedFileMetadata,
    type NormalizedSelectedFile
} from './analyze-file-contract.ts';

const AUTHORITATIVE_BASENAMES = new Set<string>(
    ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES
);
const JSON_OR_JSONL_BASENAME = /\.(?:json|jsonl)$/i;
const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_WINDOWS_CHARACTER = /[<>:"|?*]/u;
const ENCODED_PATH_CHARACTER = /%(?:2e|2f|5c)/iu;

type SafeSelectedPath = Readonly<{
    basename: string;
    sourcePath: string;
}>;

export function computeAnalyzeArtifactFileIntake<TFile extends AnalyzeSelectedFileMetadata>(
    selectedFiles: readonly TFile[]
): Either<AnalyzeFileIntakeFailure, AnalyzeArtifactFileIntakePlan<TFile>> {
    if (selectedFiles.length > ANALYZE_ARTIFACT_MAX_FILE_COUNT) {
        return Either.ofLeft({
            code: 'too-many-files',
            message: `Select at most ${ANALYZE_ARTIFACT_MAX_FILE_COUNT} files; received ${selectedFiles.length}.`
        });
    }

    const normalizedOutcomes = selectedFiles.map(normalizeSelectedFile);
    const unsafeSelection = normalizedOutcomes
        .find((outcome) => outcome.left !== undefined)?.left;
    if (unsafeSelection !== undefined) {
        return Either.ofLeft(unsafeSelection);
    }
    const normalizedFiles = normalizedOutcomes.flatMap((outcome) => outcome.right === undefined ? [] : [outcome.right]);

    let totalSelectedBytes = 0;
    for (const selected of normalizedFiles) {
        const { size } = selected.file;
        if (!Number.isSafeInteger(size) || size < 0) {
            return Either.ofLeft({
                code: 'invalid-file-size',
                message: `File "${selected.basename}" reports an invalid size.`
            });
        }
        if (size > ANALYZE_ARTIFACT_MAX_FILE_BYTES) {
            return Either.ofLeft(createFileTooLargeFailure(selected.basename, size));
        }
        totalSelectedBytes += size;
    }

    if (totalSelectedBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
        return Either.ofLeft(createTotalTooLargeFailure(totalSelectedBytes));
    }

    const accepted = normalizedFiles
        .filter((selected) => JSON_OR_JSONL_BASENAME.test(selected.basename))
        .sort(compareSelectedFiles);
    const ignoredFiles = normalizedFiles
        .filter((selected) => !JSON_OR_JSONL_BASENAME.test(selected.basename))
        .map<AnalyzeIgnoredFile>((selected) => ({
            basename: selected.basename,
            sourcePath: selected.sourcePath,
            reason: 'unsupported-extension'
        }))
        .sort(compareFileMetadata);

    const duplicates = validateDuplicateBasenames(accepted);
    if (duplicates.length > 0) {
        return Either.ofLeft(duplicates[0]);
    }

    if (accepted.length === 0) {
        const ignored = ignoredFiles.length === 0
            ? ''
            : ` Ignored: ${ignoredFiles.map((file) => file.basename).join(', ')}.`;
        return Either.ofLeft({
            code: 'no-json-files',
            message: `No JSON or JSONL artifact files were selected.${ignored}`
        });
    }

    return Either.ofRight({ accepted, ignoredFiles, totalSelectedBytes });
}

export function toAcceptedFileMetadata<TFile extends AnalyzeSelectedFileMetadata>(
    selected: NormalizedSelectedFile<TFile>
): AnalyzeAcceptedFile {
    return {
        basename: selected.basename,
        sourcePath: selected.sourcePath,
        sizeBytes: selected.file.size,
        ...(selected.file.type === undefined ? {} : { type: selected.file.type }),
        kind: AUTHORITATIVE_BASENAMES.has(selected.basename)
            ? 'authoritative'
            : 'envelope-candidate'
    };
}

export function createFileTooLargeFailure(
    basename: string,
    size: number
): AnalyzeFileIntakeFailure {
    return {
        code: 'file-too-large',
        message: `File "${basename}" exceeds the ${ANALYZE_ARTIFACT_MAX_FILE_BYTES}-byte limit (${size} bytes).`
    };
}

export function createTotalTooLargeFailure(totalBytes: number): AnalyzeFileIntakeFailure {
    return {
        code: 'total-too-large',
        message: `Selected files exceed the ${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES}-byte total limit (${totalBytes} bytes).`
    };
}

/**
 * A read that the file object itself refused. The caught value is the platform's, not a domain
 * outcome, so it is normalized here into the refusal sentence the operator reads.
 */
export function createFileReadFailure(
    basename: string,
    error: unknown
): AnalyzeFileIntakeFailure {
    return {
        code: 'read-failed',
        message: `Could not read "${basename}": ${toReadFailureReason(error)}. No files were imported.`
    };
}

export function createFileSizeMismatchFailure(
    basename: string,
    declaredBytes: number,
    actualBytes: number
): AnalyzeFileIntakeFailure {
    return {
        code: 'file-size-mismatch',
        message:
            `File "${basename}" reported ${declaredBytes} bytes but returned ${actualBytes} bytes. No files were imported.`
    };
}

function normalizeSelectedFile<TFile extends AnalyzeSelectedFileMetadata>(
    file: TFile
): Either<AnalyzeFileIntakeFailure, NormalizedSelectedFile<TFile>> {
    return normalizeSafePath(file.name).flatMap(
        (failure) => Either.ofLeft(failure),
        (namePath) => normalizeRelativeSelectedFile(file, namePath)
    );
}

function normalizeRelativeSelectedFile<TFile extends AnalyzeSelectedFileMetadata>(
    file: TFile,
    namePath: SafeSelectedPath
): Either<AnalyzeFileIntakeFailure, NormalizedSelectedFile<TFile>> {
    const relativePath = file.webkitRelativePath;
    if (relativePath === undefined || relativePath.length === 0) {
        return Either.ofRight({ file, ...namePath });
    }
    return normalizeSafePath(relativePath).flatMap(
        (failure) => Either.ofLeft(failure),
        (relative) =>
            namePath.basename.toLocaleLowerCase('en-US') ===
                    relative.basename.toLocaleLowerCase('en-US')
                ? Either.ofRight({ file, ...relative })
                : Either.ofLeft(unsafePath(
                    relativePath,
                    `its basename does not match File.name "${file.name}"`
                ))
    );
}

function normalizeSafePath(
    selectedPath: string
): Either<AnalyzeFileIntakeFailure, SafeSelectedPath> {
    if (selectedPath.length === 0) {
        return Either.ofLeft(unsafePath(selectedPath, 'the name is empty'));
    }
    if (
        selectedPath.startsWith('/') || selectedPath.startsWith('\\') ||
        /^[a-z]:[\\/]/iu.test(selectedPath)
    ) {
        return Either.ofLeft(unsafePath(selectedPath, 'absolute paths are not allowed'));
    }
    if (UNSAFE_PATH_CHARACTER.test(selectedPath)) {
        return Either.ofLeft(
            unsafePath(selectedPath, 'control or bidirectional characters are not allowed')
        );
    }
    if (ENCODED_PATH_CHARACTER.test(selectedPath)) {
        return Either.ofLeft(
            unsafePath(selectedPath, 'encoded traversal or separator characters are not allowed')
        );
    }

    const sourcePath = selectedPath.replaceAll('\\', '/');
    const segments = sourcePath.split('/');
    for (const segment of segments) {
        const segmentIssue = unsafeSegmentReason(segment);
        if (segmentIssue !== undefined) {
            return Either.ofLeft(unsafePath(selectedPath, segmentIssue));
        }
    }

    const basename = segments.at(-1) ?? '';
    if (basename.length > 255) {
        return Either.ofLeft(unsafePath(selectedPath, 'the basename exceeds 255 characters'));
    }
    return Either.ofRight({ basename, sourcePath });
}

function unsafeSegmentReason(segment: string): string | undefined {
    if (segment.length === 0) {
        return 'empty path segments are not allowed';
    }
    if (segment === '.' || segment === '..') {
        return 'traversal segments are not allowed';
    }
    if (segment.trim() !== segment) {
        return 'leading or trailing whitespace is not allowed';
    }
    if (UNSAFE_WINDOWS_CHARACTER.test(segment)) {
        return 'reserved filename characters are not allowed';
    }
    return undefined;
}

function validateDuplicateBasenames<TFile extends AnalyzeSelectedFileMetadata>(
    files: readonly NormalizedSelectedFile<TFile>[]
): readonly AnalyzeFileIntakeFailure[] {
    const firstByBasename = new Map<string, NormalizedSelectedFile<TFile>>();
    const failures: AnalyzeFileIntakeFailure[] = [];
    for (const selected of files) {
        const duplicateKey = selected.basename.toLocaleLowerCase('en-US');
        const first = firstByBasename.get(duplicateKey);
        if (first) {
            failures.push({
                code: 'duplicate-basename',
                message:
                    `Duplicate artifact basename "${duplicateKey}" was selected from "${first.sourcePath}" and "${selected.sourcePath}". Remove one; files are never overwritten.`
            });
            continue;
        }
        firstByBasename.set(duplicateKey, selected);
    }
    return failures;
}

function compareSelectedFiles<TFile extends AnalyzeSelectedFileMetadata>(
    left: NormalizedSelectedFile<TFile>,
    right: NormalizedSelectedFile<TFile>
): number {
    return compareText(left.basename, right.basename) ||
        compareText(left.sourcePath, right.sourcePath);
}

function compareFileMetadata(
    left: Pick<AnalyzeIgnoredFile, 'basename' | 'sourcePath'>,
    right: Pick<AnalyzeIgnoredFile, 'basename' | 'sourcePath'>
): number {
    return compareText(left.basename, right.basename) ||
        compareText(left.sourcePath, right.sourcePath);
}

function compareText(left: string, right: string): number {
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

function unsafePath(selectedPath: string, reason: string): AnalyzeFileIntakeFailure {
    return {
        code: 'unsafe-path',
        message: `File path "${selectedPath}" is unsafe: ${reason}.`
    };
}

function toReadFailureReason(error: unknown): string {
    const normalized = toError(error).message.trim();
    const message = normalized.length > 0 ? normalized : String(error).trim();
    return message.length > 0 ? message : 'unknown read failure';
}
