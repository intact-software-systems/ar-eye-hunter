import {
    readAnalyzeArtifactFiles,
    readAnalyzeArtifactTransferFiles,
    type AnalyzeFileLike,
    type AnalyzeTransferFileLike,
} from './analyze-file-boundary.ts';
import { createAnalyzeImportLabel } from './analyze-workspace-policy.ts';
import type { AnalyzeWorkerArtifactOffer } from './analyze-worker-contract.ts';

export type AnalyzeImportFile = AnalyzeFileLike & Partial<AnalyzeTransferFileLike>;

export async function createAnalyzeLocalOffer(
    files: readonly AnalyzeImportFile[],
    generatedAtEpochMs: number,
): Promise<AnalyzeWorkerArtifactOffer> {
    if (files.every(file => typeof file.arrayBuffer === 'function')) {
        const intake = await readAnalyzeArtifactTransferFiles(
            files as readonly AnalyzeTransferFileLike[],
        );
        return {
            source: 'local-files',
            label: createAnalyzeImportLabel(
                intake.acceptedFiles.map(file => file.basename),
            ),
            generatedAtEpochMs,
            files: intake.files,
            ignoredFiles: intake.ignoredFiles,
        };
    }

    // Deterministic non-DOM file doubles do not expose arrayBuffer(). Browser
    // File objects always use the transferable branch above.
    const intake = await readAnalyzeArtifactFiles(files);
    return {
        source: 'local-files',
        label: createAnalyzeImportLabel(
            intake.acceptedFiles.map(file => file.basename),
        ),
        generatedAtEpochMs,
        files: encodeTransferFiles(intake.files),
        ignoredFiles: intake.ignoredFiles,
    };
}

function encodeTransferFiles(
    files: Readonly<Record<string, string | undefined>>,
): AnalyzeWorkerArtifactOffer['files'] {
    return Object.entries(files)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => {
            const encoded = new TextEncoder().encode(value);
            return {
                name,
                bytes: encoded.buffer.slice(
                    encoded.byteOffset,
                    encoded.byteOffset + encoded.byteLength,
                ) as ArrayBuffer,
            };
        });
}
