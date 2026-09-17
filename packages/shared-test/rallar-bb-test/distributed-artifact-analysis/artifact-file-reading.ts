import { Either } from '@shared/resilience/Either.ts';

import type {
    DistributedRunArtifactParseWarning,
    DistributedRunArtifactRejection
} from '../distributed-artifact-analysis.ts';
import {
    distributedArtifactPipelineFile,
    distributedArtifactPipelineJsonlRows,
    type ParsedDistributedArtifactPipeline
} from '../distributed-artifact-pipeline.ts';

/** A value read from the artifact files together with the warnings reading it raised. */
export interface ArtifactFileReading<Value> {
    readonly value: Value;
    readonly warnings: readonly DistributedRunArtifactParseWarning[];
}

/** A JSON artifact file and the contract its content must decode to. */
export interface ContractJsonFile {
    readonly fileName: string;
    readonly contractName: string;
}

export function toRequiredJsonFileValue<Decoded>(
    parsed: ParsedDistributedArtifactPipeline,
    contractFile: ContractJsonFile,
    decodeFile: (value: unknown) => Either<string, Decoded>
): Either<DistributedRunArtifactRejection, Decoded> {
    const { fileName, contractName } = contractFile;
    const file = distributedArtifactPipelineFile(parsed, fileName);
    if (file.status === 'missing' || file.status === 'empty') {
        return Either.ofLeft({ fileName, message: `${fileName} is required and must not be empty.` });
    }
    if (file.format !== 'json' || file.status !== 'parsed') {
        return Either.ofLeft({
            fileName,
            message: `${fileName} is not valid JSON: ${toJsonErrorDetail(fileName, file.message)}`
        });
    }
    return decodeFile(file.value).mapLeft((issue) => ({
        fileName,
        message: `${fileName} is not ${contractName}: ${issue.endsWith('.') ? issue : `${issue}.`}`
    }));
}

/** A missing or empty optional file is absent; one that is not valid JSON or not the contract is absent with a warning. */
export function toOptionalJsonFileValue<Decoded>(
    parsed: ParsedDistributedArtifactPipeline,
    contractFile: ContractJsonFile,
    decodeFile: (value: unknown) => Either<string, Decoded>
): ArtifactFileReading<Decoded | undefined> {
    const file = distributedArtifactPipelineFile(parsed, contractFile.fileName);
    if (file.status === 'missing' || file.status === 'empty') {
        return { value: undefined, warnings: [] };
    }
    return toRequiredJsonFileValue(parsed, contractFile, decodeFile).fold(
        (rejection): ArtifactFileReading<Decoded | undefined> => ({ value: undefined, warnings: [rejection] }),
        (value) => ({ value, warnings: [] })
    );
}

/** Rows that are not valid JSON or not JSON objects are skipped with a warning each. */
export function toJsonlEvidence<Evidence>(
    parsed: ParsedDistributedArtifactPipeline,
    fileName: string,
    decodeRow: (value: unknown) => Evidence | undefined
): ArtifactFileReading<readonly Evidence[]> {
    const readings = distributedArtifactPipelineJsonlRows(parsed, fileName).map(
        (row): ArtifactFileReading<readonly Evidence[]> => {
            if (row.status !== 'parsed') {
                return toJsonlRowWarning(
                    fileName,
                    row.lineNumber,
                    row.message ?? `${fileName}:${row.lineNumber} is not valid JSON.`
                );
            }
            const evidence = decodeRow(row.value);
            return evidence === undefined
                ? toJsonlRowWarning(fileName, row.lineNumber, `${fileName}:${row.lineNumber} is not a JSON object.`)
                : { value: [evidence], warnings: [] };
        }
    );
    return {
        value: readings.flatMap((reading) => reading.value),
        warnings: readings.flatMap((reading) => reading.warnings)
    };
}

function toJsonlRowWarning(
    fileName: string,
    lineNumber: number,
    message: string
): ArtifactFileReading<readonly never[]> {
    return { value: [], warnings: [{ fileName, lineNumber, message }] };
}

function toJsonErrorDetail(fileName: string, message: string | undefined): string {
    const prefix = `${fileName} is not valid JSON: `;
    return message?.startsWith(prefix)
        ? message.slice(prefix.length)
        : message ?? 'Unknown JSON parse error';
}
