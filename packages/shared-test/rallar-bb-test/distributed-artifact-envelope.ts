import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';
import type { DistributedArtifactEnvelopeProjection } from './distributed-artifact-workspace-contracts.ts';

type EnvelopeCandidate = Readonly<{
    fileName: string;
    parsed: Record<string, unknown>;
}>;

export function projectDistributedArtifactEnvelope(
    files: DistributedRunArtifactFiles,
): DistributedArtifactEnvelopeProjection {
    const entries = Object.entries(files)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .sort(([left], [right]) => left.localeCompare(right));
    const candidates = entries
        .map(([fileName, text]) => ({ fileName, parsed: parseJson(text) }))
        .filter((candidate): candidate is EnvelopeCandidate =>
            isRecord(candidate.parsed) &&
            'files' in candidate.parsed &&
            ('artifactSchemaVersion' in candidate.parsed ||
                'distributedRunId' in candidate.parsed ||
                'generatedAtEpochMs' in candidate.parsed)
        );
    if (candidates.length === 0) {
        return {
            source: 'loose-files',
            files,
            invalidFiles: {},
            outerIgnoredFiles: [],
        };
    }

    const candidate = candidates[0];
    const fileName = candidate?.fileName ?? 'artifact-envelope.json';
    const parsed = candidate?.parsed ?? {};
    const envelopeFiles = isRecord(parsed.files) ? parsed.files : {};
    const validationFailures: string[] = [];
    if (!isRecord(parsed.files)) {
        validationFailures.push('files must be an object of artifact filename to text');
    }
    const artifactSchemaVersion = finiteInteger(parsed.artifactSchemaVersion);
    if (artifactSchemaVersion === undefined) {
        validationFailures.push('artifactSchemaVersion must be a finite integer');
    }
    const distributedRunId = typeof parsed.distributedRunId === 'string' &&
            parsed.distributedRunId.trim().length > 0
        ? parsed.distributedRunId
        : undefined;
    if (distributedRunId === undefined) {
        validationFailures.push('distributedRunId must be a non-empty string');
    }
    const generatedAtEpochMs = finiteNumber(parsed.generatedAtEpochMs);
    if (generatedAtEpochMs === undefined) {
        validationFailures.push('generatedAtEpochMs must be a finite number');
    }

    const normalizedFiles: Record<string, string> = {};
    const invalidFiles: Record<string, string> = {};
    for (const [innerFileName, innerText] of Object.entries(envelopeFiles)) {
        if (typeof innerText === 'string') {
            normalizedFiles[innerFileName] = innerText;
        } else {
            invalidFiles[innerFileName] =
                `${innerFileName} must contain text in the artifact envelope.`;
        }
    }
    const ambiguous = candidates.length > 1 || entries.length > 1;
    const fatalMessage = ambiguous
        ? candidates.length > 1
            ? `Select exactly one artifact envelope; found ${candidates.map(item => item.fileName).join(', ')}.`
            : `Artifact envelope ${fileName} cannot be combined with loose files in one import.`
        : validationFailures.length > 0
        ? `${fileName} is not a compatible artifact envelope: ${validationFailures.join('; ')}.`
        : undefined;
    return {
        source: 'bundle-envelope',
        files: normalizedFiles,
        envelopeFileName: fileName,
        artifactSchemaVersion,
        generatedAtEpochMs,
        distributedRunId,
        invalidFiles,
        outerIgnoredFiles: entries
            .map(([outerFileName]) => outerFileName)
            .filter(outerFileName => outerFileName !== fileName),
        invalidSchemaMessage: artifactSchemaVersion === undefined
            ? `${fileName} has an invalid artifactSchemaVersion.`
            : undefined,
        fatalMessage,
        fatalCode: ambiguous ? 'ambiguous-envelope' : 'incompatible-file',
    };
}

function parseJson(text: string): unknown | undefined {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) &&
            Number.isInteger(value)
        ? value
        : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}
