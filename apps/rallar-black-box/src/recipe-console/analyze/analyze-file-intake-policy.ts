import {
    ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES,
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_FILE_COUNT,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES,
    AnalyzeFileIntakeError,
    type AnalyzeAcceptedFile,
    type AnalyzeIgnoredFile,
    type AnalyzeSelectedFileMetadata,
    type NormalizedSelectedFile,
    type PreparedAnalyzeArtifactFileIntake,
} from './analyze-file-contract.ts';

const AUTHORITATIVE_BASENAMES = new Set<string>(
    ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES,
);
const JSON_OR_JSONL_BASENAME = /\.(?:json|jsonl)$/i;
const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_WINDOWS_CHARACTER = /[<>:"|?*]/u;
const ENCODED_PATH_CHARACTER = /%(?:2e|2f|5c)/iu;

export function prepareAnalyzeArtifactFileIntake<
    TFile extends AnalyzeSelectedFileMetadata,
>(
    selectedFiles: readonly TFile[],
): PreparedAnalyzeArtifactFileIntake<TFile> {
    if (selectedFiles.length > ANALYZE_ARTIFACT_MAX_FILE_COUNT) {
        throw new AnalyzeFileIntakeError(
            'too-many-files',
            `Select at most ${ANALYZE_ARTIFACT_MAX_FILE_COUNT} files; received ${selectedFiles.length}.`,
        );
    }

    const normalizedFiles = selectedFiles.map(normalizeSelectedFile);
    let totalSelectedBytes = 0;

    for (const selected of normalizedFiles) {
        const { size } = selected.file;
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new AnalyzeFileIntakeError(
                'invalid-file-size',
                `File "${selected.basename}" reports an invalid size.`,
            );
        }
        if (size > ANALYZE_ARTIFACT_MAX_FILE_BYTES) {
            throw fileTooLarge(selected.basename, size);
        }
        totalSelectedBytes += size;
    }

    if (totalSelectedBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
        throw totalTooLarge(totalSelectedBytes);
    }

    const accepted = normalizedFiles
        .filter(selected => JSON_OR_JSONL_BASENAME.test(selected.basename))
        .sort(compareSelectedFiles);
    const ignoredFiles = normalizedFiles
        .filter(selected => !JSON_OR_JSONL_BASENAME.test(selected.basename))
        .map<AnalyzeIgnoredFile>(selected => ({
            basename: selected.basename,
            sourcePath: selected.sourcePath,
            reason: 'unsupported-extension',
        }))
        .sort(compareFileMetadata);

    rejectDuplicateBasenames(accepted);

    if (accepted.length === 0) {
        const ignored = ignoredFiles.length === 0
            ? ''
            : ` Ignored: ${ignoredFiles.map(file => file.basename).join(', ')}.`;
        throw new AnalyzeFileIntakeError(
            'no-json-files',
            `No JSON or JSONL artifact files were selected.${ignored}`,
        );
    }

    return { accepted, ignoredFiles, totalSelectedBytes };
}

export function acceptedFileMetadata<
    TFile extends AnalyzeSelectedFileMetadata,
>(selected: NormalizedSelectedFile<TFile>): AnalyzeAcceptedFile {
    return {
        basename: selected.basename,
        sourcePath: selected.sourcePath,
        sizeBytes: selected.file.size,
        ...(selected.file.type === undefined ? {} : { type: selected.file.type }),
        kind: AUTHORITATIVE_BASENAMES.has(selected.basename)
            ? 'authoritative'
            : 'envelope-candidate',
    };
}

export function fileTooLarge(basename: string, size: number): AnalyzeFileIntakeError {
    return new AnalyzeFileIntakeError(
        'file-too-large',
        `File "${basename}" exceeds the ${ANALYZE_ARTIFACT_MAX_FILE_BYTES}-byte limit (${size} bytes).`,
    );
}

export function totalTooLarge(totalBytes: number): AnalyzeFileIntakeError {
    return new AnalyzeFileIntakeError(
        'total-too-large',
        `Selected files exceed the ${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES}-byte total limit (${totalBytes} bytes).`,
    );
}

export function readFailure(basename: string, error: unknown): AnalyzeFileIntakeError {
    return new AnalyzeFileIntakeError(
        'read-failed',
        `Could not read "${basename}": ${errorMessage(error)}. No files were imported.`,
    );
}

function normalizeSelectedFile<TFile extends AnalyzeSelectedFileMetadata>(
    file: TFile,
): NormalizedSelectedFile<TFile> {
    const namePath = normalizeSafePath(file.name);
    const relativePath = file.webkitRelativePath;
    if (relativePath === undefined || relativePath.length === 0) {
        return { file, ...namePath };
    }

    const normalizedRelativePath = normalizeSafePath(relativePath);
    if (namePath.basename.toLocaleLowerCase('en-US') !==
        normalizedRelativePath.basename.toLocaleLowerCase('en-US')) {
        throw unsafePath(
            relativePath,
            `its basename does not match File.name "${file.name}"`,
        );
    }
    return { file, ...normalizedRelativePath };
}

function normalizeSafePath(selectedPath: string): Readonly<{
    basename: string;
    sourcePath: string;
}> {
    if (selectedPath.length === 0) throw unsafePath(selectedPath, 'the name is empty');
    if (
        selectedPath.startsWith('/') || selectedPath.startsWith('\\') ||
        /^[a-z]:[\\/]/iu.test(selectedPath)
    ) throw unsafePath(selectedPath, 'absolute paths are not allowed');
    if (UNSAFE_PATH_CHARACTER.test(selectedPath)) {
        throw unsafePath(selectedPath, 'control or bidirectional characters are not allowed');
    }
    if (ENCODED_PATH_CHARACTER.test(selectedPath)) {
        throw unsafePath(selectedPath, 'encoded traversal or separator characters are not allowed');
    }

    const sourcePath = selectedPath.replaceAll('\\', '/');
    const segments = sourcePath.split('/');
    for (const segment of segments) {
        if (segment.length === 0) {
            throw unsafePath(selectedPath, 'empty path segments are not allowed');
        }
        if (segment === '.' || segment === '..') {
            throw unsafePath(selectedPath, 'traversal segments are not allowed');
        }
        if (segment.trim() !== segment) {
            throw unsafePath(selectedPath, 'leading or trailing whitespace is not allowed');
        }
        if (UNSAFE_WINDOWS_CHARACTER.test(segment)) {
            throw unsafePath(selectedPath, 'reserved filename characters are not allowed');
        }
    }

    const basename = segments.at(-1) ?? '';
    if (basename.length > 255) {
        throw unsafePath(selectedPath, 'the basename exceeds 255 characters');
    }
    return { basename, sourcePath };
}

function rejectDuplicateBasenames<TFile extends AnalyzeSelectedFileMetadata>(
    files: readonly NormalizedSelectedFile<TFile>[],
): void {
    const firstByBasename = new Map<string, NormalizedSelectedFile<TFile>>();
    for (const selected of files) {
        const duplicateKey = selected.basename.toLocaleLowerCase('en-US');
        const first = firstByBasename.get(duplicateKey);
        if (first) {
            throw new AnalyzeFileIntakeError(
                'duplicate-basename',
                `Duplicate artifact basename "${duplicateKey}" was selected from "${first.sourcePath}" and "${selected.sourcePath}". Remove one; files are never overwritten.`,
            );
        }
        firstByBasename.set(duplicateKey, selected);
    }
}

function compareSelectedFiles<TFile extends AnalyzeSelectedFileMetadata>(
    left: NormalizedSelectedFile<TFile>,
    right: NormalizedSelectedFile<TFile>,
): number {
    return compareText(left.basename, right.basename) ||
        compareText(left.sourcePath, right.sourcePath);
}

function compareFileMetadata(
    left: Pick<AnalyzeIgnoredFile, 'basename' | 'sourcePath'>,
    right: Pick<AnalyzeIgnoredFile, 'basename' | 'sourcePath'>,
): number {
    return compareText(left.basename, right.basename) ||
        compareText(left.sourcePath, right.sourcePath);
}

function compareText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function unsafePath(selectedPath: string, reason: string): AnalyzeFileIntakeError {
    return new AnalyzeFileIntakeError(
        'unsafe-path',
        `File path "${selectedPath}" is unsafe: ${reason}.`,
    );
}

function errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
        return error.message.trim();
    }
    const message = String(error).trim();
    return message.length > 0 ? message : 'unknown read failure';
}
