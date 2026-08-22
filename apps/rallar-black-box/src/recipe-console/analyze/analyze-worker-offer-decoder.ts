import { validateControlExecutionArtifactBundle } from '../control/control-execution-validation.ts';
import {
    ANALYZE_ARTIFACT_MAX_FILE_BYTES,
    ANALYZE_ARTIFACT_MAX_FILE_COUNT,
    ANALYZE_ARTIFACT_MAX_TOTAL_BYTES
} from './analyze-file-boundary.ts';
import type { AnalyzeWorkerArtifactOffer } from './analyze-worker-contract.ts';

const ANALYZE_CONTROL_ENVELOPE_MAX_BYTES = 64 * 1_024 * 1_024;

export type AnalyzeDecodedArtifactOffer = Readonly<{
    files: Readonly<Record<string, string>>;
    sourceFileCount: number;
    sourceBytes: number;
    generatedAtEpochMs?: number;
    artifactSchemaVersion?: number;
    declaredDistributedRunId?: string;
}>;

export function decodeAnalyzeWorkerArtifactOffer(
    artifact: AnalyzeWorkerArtifactOffer
): AnalyzeDecodedArtifactOffer {
    if (artifact.controlEnvelope) {
        return decodeControlEnvelope(artifact.controlEnvelope);
    }
    if (artifact.files.length > ANALYZE_ARTIFACT_MAX_FILE_COUNT) {
        throw new Error('too-many-transfer-files');
    }
    const decoded: Record<string, string> = Object.create(null);
    let sourceBytes = 0;
    for (const file of artifact.files) {
        if (!file.name || Object.hasOwn(decoded, file.name)) {
            throw new Error('invalid-transfer-file');
        }
        if (file.bytes.byteLength > ANALYZE_ARTIFACT_MAX_FILE_BYTES) {
            throw new Error('transfer-file-too-large');
        }
        sourceBytes += file.bytes.byteLength;
        if (sourceBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
            throw new Error('transfer-total-too-large');
        }
        decoded[file.name] = new TextDecoder('utf-8', { fatal: true })
            .decode(file.bytes);
    }
    return {
        files: decoded,
        sourceFileCount: artifact.files.length,
        sourceBytes,
        generatedAtEpochMs: artifact.generatedAtEpochMs,
        artifactSchemaVersion: artifact.artifactSchemaVersion
    };
}

function decodeControlEnvelope(
    bytes: ArrayBuffer
): AnalyzeDecodedArtifactOffer {
    if (bytes.byteLength > ANALYZE_CONTROL_ENVELOPE_MAX_BYTES) {
        throw new Error('control-envelope-too-large');
    }
    const value: unknown = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    );
    validateControlExecutionArtifactBundle(value);
    const entries = Object.entries(value.files);
    const totalBytes = validateDecodedFileEntries(entries);
    return {
        files: Object.fromEntries(entries),
        sourceFileCount: entries.length,
        sourceBytes: totalBytes,
        generatedAtEpochMs: value.generatedAtEpochMs,
        artifactSchemaVersion: value.artifactSchemaVersion,
        declaredDistributedRunId: value.distributedRunId
    };
}

function validateDecodedFileEntries(
    entries: readonly [string, string][]
): number {
    if (entries.length > ANALYZE_ARTIFACT_MAX_FILE_COUNT) {
        throw new Error('too-many-control-files');
    }
    let totalBytes = 0;
    const encoder = new TextEncoder();
    for (const [name, text] of entries) {
        if (!name) {
            throw new Error('invalid-control-file');
        }
        const size = encoder.encode(text).byteLength;
        if (size > ANALYZE_ARTIFACT_MAX_FILE_BYTES) {
            throw new Error('control-file-too-large');
        }
        totalBytes += size;
        if (totalBytes > ANALYZE_ARTIFACT_MAX_TOTAL_BYTES) {
            throw new Error('control-total-too-large');
        }
    }
    return totalBytes;
}
