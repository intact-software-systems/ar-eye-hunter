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
    'metadata.json',
] as const;

export type AnalyzeFileLike = Readonly<{
    name: string;
    size: number;
    text(): Promise<string>;
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

export type AnalyzeFileIntakeErrorCode =
    | 'too-many-files'
    | 'invalid-file-size'
    | 'file-too-large'
    | 'total-too-large'
    | 'unsafe-path'
    | 'duplicate-basename'
    | 'no-json-files'
    | 'read-failed';

export class AnalyzeFileIntakeError extends Error {
    readonly code: AnalyzeFileIntakeErrorCode;

    constructor(code: AnalyzeFileIntakeErrorCode, message: string) {
        super(message);
        this.name = 'AnalyzeFileIntakeError';
        this.code = code;
    }
}

type NormalizedSelectedFile = Readonly<{
    file: AnalyzeFileLike;
    basename: string;
    sourcePath: string;
}>;

const AUTHORITATIVE_BASENAMES = new Set<string>(
    ANALYZE_ARTIFACT_AUTHORITATIVE_BASENAMES,
);
const JSON_OR_JSONL_BASENAME = /\.(?:json|jsonl)$/i;
const UNSAFE_PATH_CHARACTER = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_WINDOWS_CHARACTER = /[<>:"|?*]/u;
const ENCODED_PATH_CHARACTER = /%(?:2e|2f|5c)/iu;

export async function readAnalyzeArtifactFiles(
    selectedFiles: readonly AnalyzeFileLike[],
): Promise<AnalyzeArtifactFileIntake> {
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
            throw new AnalyzeFileIntakeError(
                'file-too-large',
                `File "${selected.basename}" exceeds the ${ANALYZE_ARTIFACT_MAX_FILE_BYTES}-byte limit (${size} bytes).`,
            );
        }
        totalSelectedBytes += size;
    }

    if (totalSelectedBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
        throw new AnalyzeFileIntakeError(
            'total-too-large',
            `Selected files exceed the ${ANALYZE_ARTIFACT_MAX_TOTAL_BYTES}-byte total limit (${totalSelectedBytes} bytes).`,
        );
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

    const texts: [string, string][] = [];
    const acceptedFiles: AnalyzeAcceptedFile[] = [];
    for (const selected of accepted) {
        let contents: string;
        try {
            contents = await selected.file.text();
            if (typeof contents !== 'string') {
                throw new TypeError('the selected file did not return text');
            }
        } catch (error) {
            throw new AnalyzeFileIntakeError(
                'read-failed',
                `Could not read "${selected.basename}": ${errorMessage(error)}. No files were imported.`,
            );
        }

        texts.push([selected.basename, contents]);
        acceptedFiles.push({
            basename: selected.basename,
            sourcePath: selected.sourcePath,
            sizeBytes: selected.file.size,
            ...(selected.file.type === undefined ? {} : { type: selected.file.type }),
            kind: AUTHORITATIVE_BASENAMES.has(selected.basename)
                ? 'authoritative'
                : 'envelope-candidate',
        });
    }

    return {
        files: Object.fromEntries(texts),
        acceptedFiles,
        ignoredFiles,
        totalSelectedBytes,
    };
}

function normalizeSelectedFile(file: AnalyzeFileLike): NormalizedSelectedFile {
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
    if (selectedPath.length === 0) {
        throw unsafePath(selectedPath, 'the name is empty');
    }
    if (
        selectedPath.startsWith('/') ||
        selectedPath.startsWith('\\') ||
        /^[a-z]:[\\/]/iu.test(selectedPath)
    ) {
        throw unsafePath(selectedPath, 'absolute paths are not allowed');
    }
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

function rejectDuplicateBasenames(files: readonly NormalizedSelectedFile[]) {
    const firstByBasename = new Map<string, NormalizedSelectedFile>();
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

function compareSelectedFiles(left: NormalizedSelectedFile, right: NormalizedSelectedFile) {
    return compareText(left.basename, right.basename) ||
        compareText(left.sourcePath, right.sourcePath);
}

function compareFileMetadata(
    left: Pick<AnalyzeIgnoredFile, 'basename' | 'sourcePath'>,
    right: Pick<AnalyzeIgnoredFile, 'basename' | 'sourcePath'>,
) {
    return compareText(left.basename, right.basename) ||
        compareText(left.sourcePath, right.sourcePath);
}

function compareText(left: string, right: string) {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function unsafePath(selectedPath: string, reason: string) {
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
