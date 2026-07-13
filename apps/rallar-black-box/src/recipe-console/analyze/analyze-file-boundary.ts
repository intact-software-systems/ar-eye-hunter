export * from './analyze-file-contract.ts';

import {
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES,
    AnalyzeFileIntakeError,
    type AnalyzeAcceptedFile,
    type AnalyzeArtifactFileIntake,
    type AnalyzeArtifactTransferIntake,
    type AnalyzeFileLike,
    type AnalyzeTransferFile,
    type AnalyzeTransferFileLike,
} from './analyze-file-contract.ts';
import {
    acceptedFileMetadata,
    fileTooLarge,
    prepareAnalyzeArtifactFileIntake,
    readFailure,
    totalTooLarge,
} from './analyze-file-intake-policy.ts';

export async function readAnalyzeArtifactFiles(
    selectedFiles: readonly AnalyzeFileLike[],
): Promise<AnalyzeArtifactFileIntake> {
    const prepared = prepareAnalyzeArtifactFileIntake(selectedFiles);
    const texts: [string, string][] = [];
    const acceptedFiles: AnalyzeAcceptedFile[] = [];
    for (const selected of prepared.accepted) {
        let contents: string;
        try {
            contents = await selected.file.text();
            if (typeof contents !== 'string') {
                throw new TypeError('the selected file did not return text');
            }
        } catch (error) {
            throw readFailure(selected.basename, error);
        }

        texts.push([selected.basename, contents]);
        acceptedFiles.push(acceptedFileMetadata(selected));
    }

    return {
        files: Object.fromEntries(texts),
        acceptedFiles,
        ignoredFiles: prepared.ignoredFiles,
        totalSelectedBytes: prepared.totalSelectedBytes,
    };
}

export async function readAnalyzeArtifactTransferFiles(
    selectedFiles: readonly AnalyzeTransferFileLike[],
): Promise<AnalyzeArtifactTransferIntake> {
    const prepared = prepareAnalyzeArtifactFileIntake(selectedFiles);
    const files: AnalyzeTransferFile[] = [];
    const acceptedFiles: AnalyzeAcceptedFile[] = [];
    const transferList: ArrayBuffer[] = [];
    const seenBuffers = new Set<ArrayBuffer>();
    const ignoredDeclaredBytes = prepared.totalSelectedBytes - prepared.accepted.reduce(
        (sum, selected) => sum + selected.file.size,
        0,
    );
    let totalActualBytes = ignoredDeclaredBytes;

    for (const selected of prepared.accepted) {
        let bytes: ArrayBuffer;
        try {
            bytes = await selected.file.arrayBuffer();
            if (!(bytes instanceof ArrayBuffer)) {
                throw new TypeError('the selected file did not return an ArrayBuffer');
            }
            if (seenBuffers.has(bytes)) {
                throw new TypeError('multiple selected files returned the same ArrayBuffer');
            }
        } catch (error) {
            throw readFailure(selected.basename, error);
        }

        const actualSize = bytes.byteLength;
        if (actualSize > ANALYZE_ARTIFACT_MAX_FILE_BYTES) {
            throw fileTooLarge(selected.basename, actualSize);
        }
        totalActualBytes += actualSize;
        if (totalActualBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
            throw totalTooLarge(totalActualBytes);
        }
        if (actualSize !== selected.file.size) {
            throw new AnalyzeFileIntakeError(
                'file-size-mismatch',
                `File "${selected.basename}" reported ${selected.file.size} bytes but returned ${actualSize} bytes. No files were imported.`,
            );
        }

        seenBuffers.add(bytes);
        files.push({ name: selected.basename, bytes });
        transferList.push(bytes);
        acceptedFiles.push(acceptedFileMetadata(selected));
    }

    return {
        files,
        acceptedFiles,
        ignoredFiles: prepared.ignoredFiles,
        totalSelectedBytes: prepared.totalSelectedBytes,
        transferList,
    };
}
