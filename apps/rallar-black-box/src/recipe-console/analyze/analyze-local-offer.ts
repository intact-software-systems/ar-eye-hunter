import { Either } from '@shared/resilience/Either.ts';
import {
    readAnalyzeArtifactFiles,
    readAnalyzeArtifactTransferFiles,
    type AnalyzeFileIntakeFailure,
    type AnalyzeFileLike,
    type AnalyzeTransferFileLike
} from './analyze-file-boundary.ts';
import type { AnalyzeWorkerLocalFilesOffer } from './analyze-worker-contract.ts';
import { createAnalyzeImportLabel } from './analyze-workspace-policy.ts';

export type AnalyzeImportFile = AnalyzeFileLike & Partial<AnalyzeTransferFileLike>;

export async function createAnalyzeLocalOffer(
    files: readonly AnalyzeImportFile[],
    generatedAtEpochMs: number
): Promise<Either<AnalyzeFileIntakeFailure, AnalyzeWorkerLocalFilesOffer>> {
    if (files.every((file) => typeof file.arrayBuffer === 'function')) {
        const intake = await readAnalyzeArtifactTransferFiles(
            files as readonly AnalyzeTransferFileLike[]
        );
        return intake.mapRight((accepted) => ({
            source: 'local-files',
            label: createAnalyzeImportLabel(
                accepted.acceptedFiles.map((file) => file.basename)
            ),
            generatedAtEpochMs,
            files: accepted.files,
            ignoredFiles: accepted.ignoredFiles
        }));
    }

    // Deterministic non-DOM file doubles do not expose arrayBuffer(). Browser
    // File objects always use the transferable branch above.
    const intake = await readAnalyzeArtifactFiles(files);
    return intake.mapRight((accepted) => ({
        source: 'local-files',
        label: createAnalyzeImportLabel(
            accepted.acceptedFiles.map((file) => file.basename)
        ),
        generatedAtEpochMs,
        files: encodeTransferFiles(accepted.files),
        ignoredFiles: accepted.ignoredFiles
    }));
}

function encodeTransferFiles(
    files: Readonly<Record<string, string | undefined>>
): AnalyzeWorkerLocalFilesOffer['files'] {
    return Object.entries(files)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            const encoded = new TextEncoder().encode(value);
            return {
                name,
                bytes: encoded.buffer.slice(
                    encoded.byteOffset,
                    encoded.byteOffset + encoded.byteLength
                ) as ArrayBuffer
            };
        });
}
