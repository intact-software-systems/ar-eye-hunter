export * from './analyze-file-contract.ts';

import { Either } from '@shared/resilience/Either.ts';
import {
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES,
    type AnalyzeAcceptedFile,
    type AnalyzeArtifactFileIntake,
    type AnalyzeArtifactFileIntakePlan,
    type AnalyzeArtifactTransferIntake,
    type AnalyzeFileIntakeFailure,
    type AnalyzeFileLike,
    type AnalyzeTransferFile,
    type AnalyzeTransferFileLike
} from './analyze-file-contract.ts';
import {
    computeAnalyzeArtifactFileIntake,
    createFileReadFailure,
    createFileSizeMismatchFailure,
    createFileTooLargeFailure,
    createTotalTooLargeFailure,
    toAcceptedFileMetadata
} from './analyze-file-intake-policy.ts';

export function readAnalyzeArtifactFiles(
    selectedFiles: readonly AnalyzeFileLike[]
): Promise<Either<AnalyzeFileIntakeFailure, AnalyzeArtifactFileIntake>> {
    return computeAnalyzeArtifactFileIntake(selectedFiles).fold(
        async (failure) => Either.ofLeft<AnalyzeFileIntakeFailure, AnalyzeArtifactFileIntake>(failure),
        (prepared) => readPreparedTexts(prepared)
    );
}

export function readAnalyzeArtifactTransferFiles(
    selectedFiles: readonly AnalyzeTransferFileLike[]
): Promise<Either<AnalyzeFileIntakeFailure, AnalyzeArtifactTransferIntake>> {
    return computeAnalyzeArtifactFileIntake(selectedFiles).fold(
        async (failure) => Either.ofLeft<AnalyzeFileIntakeFailure, AnalyzeArtifactTransferIntake>(failure),
        (prepared) => readPreparedBuffers(prepared)
    );
}

async function readPreparedTexts(
    prepared: AnalyzeArtifactFileIntakePlan<AnalyzeFileLike>
): Promise<Either<AnalyzeFileIntakeFailure, AnalyzeArtifactFileIntake>> {
    const texts: [string, string][] = [];
    const acceptedFiles: AnalyzeAcceptedFile[] = [];
    for (const selected of prepared.accepted) {
        let contents: string;
        try {
            contents = await selected.file.text();
            if (typeof contents !== 'string') {
                throw new TypeError('the selected file did not return text');
            }
        }
        catch (error) {
            return Either.ofLeft(createFileReadFailure(selected.basename, error));
        }

        texts.push([selected.basename, contents]);
        acceptedFiles.push(toAcceptedFileMetadata(selected));
    }

    return Either.ofRight({
        files: Object.fromEntries(texts),
        acceptedFiles,
        ignoredFiles: prepared.ignoredFiles,
        totalSelectedBytes: prepared.totalSelectedBytes
    });
}

async function readPreparedBuffers(
    prepared: AnalyzeArtifactFileIntakePlan<AnalyzeTransferFileLike>
): Promise<Either<AnalyzeFileIntakeFailure, AnalyzeArtifactTransferIntake>> {
    const files: AnalyzeTransferFile[] = [];
    const acceptedFiles: AnalyzeAcceptedFile[] = [];
    const transferList: ArrayBuffer[] = [];
    const seenBuffers = new Set<ArrayBuffer>();
    const ignoredDeclaredBytes = prepared.totalSelectedBytes - prepared.accepted.reduce(
        (sum, selected) => sum + selected.file.size,
        0
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
        }
        catch (error) {
            return Either.ofLeft(createFileReadFailure(selected.basename, error));
        }

        const actualSize = bytes.byteLength;
        if (actualSize > ANALYZE_ARTIFACT_MAX_FILE_BYTES) {
            return Either.ofLeft(createFileTooLargeFailure(selected.basename, actualSize));
        }
        totalActualBytes += actualSize;
        if (totalActualBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
            return Either.ofLeft(createTotalTooLargeFailure(totalActualBytes));
        }
        if (actualSize !== selected.file.size) {
            return Either.ofLeft(createFileSizeMismatchFailure(
                selected.basename,
                selected.file.size,
                actualSize
            ));
        }

        seenBuffers.add(bytes);
        files.push({ name: selected.basename, bytes });
        transferList.push(bytes);
        acceptedFiles.push(toAcceptedFileMetadata(selected));
    }

    return Either.ofRight({
        files,
        acceptedFiles,
        ignoredFiles: prepared.ignoredFiles,
        totalSelectedBytes: prepared.totalSelectedBytes,
        transferList
    });
}
