import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';
import type { DistributedArtifactEnvelopeProjection } from './distributed-artifact-workspace-contracts.ts';

export type DistributedArtifactPipelineFileStatus =
    | 'missing'
    | 'empty'
    | 'parsed'
    | 'malformed';

export type ParsedDistributedArtifactJsonFile = Readonly<{
    fileName: string;
    format: 'json';
    status: DistributedArtifactPipelineFileStatus;
    text?: string;
    value?: unknown;
    message?: string;
}>;

export type ParsedDistributedArtifactJsonlRow = Readonly<{
    lineNumber: number;
    status: 'parsed' | 'malformed';
    value?: unknown;
    message?: string;
}>;

export type ParsedDistributedArtifactJsonlFile = Readonly<{
    fileName: string;
    format: 'jsonl';
    status: DistributedArtifactPipelineFileStatus;
    text?: string;
    rows: readonly ParsedDistributedArtifactJsonlRow[];
    message?: string;
}>;

export type ParsedDistributedArtifactTextFile = Readonly<{
    fileName: string;
    format: 'text';
    status: DistributedArtifactPipelineFileStatus;
    text?: string;
    value?: string;
    message?: string;
}>;

export type ParsedDistributedArtifactFile =
    | ParsedDistributedArtifactJsonFile
    | ParsedDistributedArtifactJsonlFile
    | ParsedDistributedArtifactTextFile;

export type DistributedArtifactPipelineTelemetry = Readonly<{
    pipelinePassCount: number;
    sourceCollectionPassCount: number;
    sourceFileVisitCount: number;
    jsonDocumentParseCount: number;
    jsonDocumentParseCountByFile: Readonly<Record<string, number>>;
    jsonlFilePassCount: number;
    jsonlFilePassCountByFile: Readonly<Record<string, number>>;
    jsonlRowParseCount: number;
    jsonlRowParseCountByFile: Readonly<Record<string, number>>;
}>;

export type ParsedDistributedArtifactPipeline = Readonly<{
    source: 'loose-files' | 'bundle-envelope';
    envelope?: ParsedDistributedArtifactJsonFile;
    projection: DistributedArtifactEnvelopeProjection;
    projectedFiles: DistributedRunArtifactFiles;
    files: Readonly<Record<string, ParsedDistributedArtifactFile>>;
    telemetry: DistributedArtifactPipelineTelemetry;
}>;

type MutablePipelineTelemetry = {
    pipelinePassCount: number;
    sourceCollectionPassCount: number;
    sourceFileVisitCount: number;
    jsonDocumentParseCount: number;
    jsonDocumentParseCountByFile: Record<string, number>;
    jsonlFilePassCount: number;
    jsonlFilePassCountByFile: Record<string, number>;
    jsonlRowParseCount: number;
    jsonlRowParseCountByFile: Record<string, number>;
};

type SourceEntry = readonly [fileName: string, value: unknown];

type CachedJsonParse = Readonly<{
    text: string;
    status: 'parsed' | 'malformed';
    value?: unknown;
    detail?: string;
}>;

type CachedJsonlParse = Readonly<{
    text: string;
    file: ParsedDistributedArtifactJsonlFile;
}>;

type EnvelopeCandidate = Readonly<{
    fileName: string;
    text: string;
    parsed: Record<string, unknown>;
}>;

export function parseDistributedArtifactPipeline(
    inputFiles: DistributedRunArtifactFiles,
): ParsedDistributedArtifactPipeline {
    const telemetry = createTelemetry();
    const jsonCache = nullRecord<CachedJsonParse>();
    const jsonlCache = nullRecord<CachedJsonlParse>();
    const inputEntries = ownEntries(inputFiles)
        .sort(([left], [right]) => left.localeCompare(right));
    const definedInputEntries = inputEntries.filter(
        (entry): entry is readonly [string, string] => typeof entry[1] === 'string',
    );
    const candidates: EnvelopeCandidate[] = [];

    for (const [fileName, text] of definedInputEntries) {
        if (text.trim().length === 0) {
            continue;
        }
        const parsed = fileFormat(fileName) === 'jsonl'
            ? singleParsedJsonlValue(
                parseJsonlFile(fileName, text, telemetry, jsonlCache),
            )
            : parseJsonValue(fileName, text, telemetry, jsonCache);
        if (
            parsed?.status === 'parsed' &&
            isRecord(parsed.value) &&
            hasOwn(parsed.value, 'files') &&
            (
                hasOwn(parsed.value, 'artifactSchemaVersion') ||
                hasOwn(parsed.value, 'distributedRunId') ||
                hasOwn(parsed.value, 'generatedAtEpochMs')
            )
        ) {
            candidates.push({ fileName, text, parsed: parsed.value });
        }
    }

    const resolved = resolveProjection(inputEntries, definedInputEntries, candidates);
    const projectedFiles = resolved.projection.files;
    const sourceEntries = resolved.sourceEntries;
    const projectedJsonCache = resolved.projection.source === 'loose-files'
        ? jsonCache
        : nullRecord<CachedJsonParse>();
    const projectedJsonlCache = resolved.projection.source === 'loose-files'
        ? jsonlCache
        : nullRecord<CachedJsonlParse>();
    telemetry.sourceCollectionPassCount = 1;
    telemetry.sourceFileVisitCount = sourceEntries.length;

    const controlResponseFile = selectedControlResponseFile(
        projectedFiles,
        telemetry,
        projectedJsonCache,
    );
    const files = nullRecord<ParsedDistributedArtifactFile>();
    for (const [fileName, value] of sourceEntries) {
        const file = resolved.invalidFiles.has(fileName)
            ? malformedEnvelopeFile(fileName, telemetry)
            : parseSourceFile(
                fileName,
                typeof value === 'string' ? value : undefined,
                controlResponseFile === fileName,
                telemetry,
                projectedJsonCache,
                projectedJsonlCache,
            );
        setRecordValue(files, fileName, file);
    }

    return {
        source: resolved.projection.source,
        ...(resolved.envelope ? { envelope: resolved.envelope } : {}),
        projection: resolved.projection,
        projectedFiles,
        files,
        telemetry,
    };
}

export function distributedArtifactPipelineFile(
    pipeline: ParsedDistributedArtifactPipeline,
    fileName: string,
): ParsedDistributedArtifactFile {
    return hasOwn(pipeline.files, fileName)
        ? pipeline.files[fileName] as ParsedDistributedArtifactFile
        : missingFile(fileName);
}

function resolveProjection(
    inputEntries: readonly SourceEntry[],
    definedInputEntries: readonly (readonly [string, string])[],
    candidates: readonly EnvelopeCandidate[],
): Readonly<{
    projection: DistributedArtifactEnvelopeProjection;
    envelope?: ParsedDistributedArtifactJsonFile;
    sourceEntries: readonly SourceEntry[];
    invalidFiles: ReadonlySet<string>;
}> {
    const candidate = candidates[0];
    if (!candidate) {
        const projectedFiles = nullRecord<string | undefined>();
        for (const [fileName, value] of inputEntries) {
            setRecordValue(
                projectedFiles,
                fileName,
                typeof value === 'string' ? value : undefined,
            );
        }
        return {
            projection: {
                source: 'loose-files',
                files: projectedFiles,
                invalidFiles: nullRecord<string>(),
                outerIgnoredFiles: [],
            },
            sourceEntries: inputEntries,
            invalidFiles: new Set(),
        };
    }

    const envelopeFiles = isRecord(candidate.parsed.files)
        ? candidate.parsed.files
        : nullRecord<unknown>();
    const sourceEntries = ownEntries(envelopeFiles);
    const projectedFiles = nullRecord<string>();
    const invalidFiles = nullRecord<string>();
    const invalidFileNames = new Set<string>();
    for (const [fileName, value] of sourceEntries) {
        if (typeof value === 'string') {
            setRecordValue(projectedFiles, fileName, value);
        } else {
            const message = `${fileName} must contain text in the artifact envelope.`;
            setRecordValue(invalidFiles, fileName, message);
            invalidFileNames.add(fileName);
        }
    }

    const validationFailures: string[] = [];
    if (!isRecord(candidate.parsed.files)) {
        validationFailures.push('files must be an object of artifact filename to text');
    }
    const artifactSchemaVersion = finiteInteger(candidate.parsed.artifactSchemaVersion);
    if (artifactSchemaVersion === undefined) {
        validationFailures.push('artifactSchemaVersion must be a finite integer');
    }
    const distributedRunId = typeof candidate.parsed.distributedRunId === 'string' &&
            candidate.parsed.distributedRunId.trim().length > 0
        ? candidate.parsed.distributedRunId
        : undefined;
    if (distributedRunId === undefined) {
        validationFailures.push('distributedRunId must be a non-empty string');
    }
    const generatedAtEpochMs = finiteNumber(candidate.parsed.generatedAtEpochMs);
    if (generatedAtEpochMs === undefined) {
        validationFailures.push('generatedAtEpochMs must be a finite number');
    }

    const ambiguous = candidates.length > 1 || definedInputEntries.length > 1;
    const fatalMessage = ambiguous
        ? candidates.length > 1
            ? `Select exactly one artifact envelope; found ${candidates.map(item => item.fileName).join(', ')}.`
            : `Artifact envelope ${candidate.fileName} cannot be combined with loose files in one import.`
        : validationFailures.length > 0
        ? `${candidate.fileName} is not a compatible artifact envelope: ${validationFailures.join('; ')}.`
        : undefined;
    const projection: DistributedArtifactEnvelopeProjection = {
        source: 'bundle-envelope',
        files: projectedFiles,
        envelopeFileName: candidate.fileName,
        artifactSchemaVersion,
        generatedAtEpochMs,
        distributedRunId,
        invalidFiles,
        outerIgnoredFiles: definedInputEntries
            .map(([fileName]) => fileName)
            .filter(fileName => fileName !== candidate.fileName),
        invalidSchemaMessage: artifactSchemaVersion === undefined
            ? `${candidate.fileName} has an invalid artifactSchemaVersion.`
            : undefined,
        fatalMessage,
        fatalCode: ambiguous ? 'ambiguous-envelope' : 'incompatible-file',
    };
    return {
        projection,
        envelope: {
            fileName: candidate.fileName,
            format: 'json',
            status: 'parsed',
            text: candidate.text,
            value: candidate.parsed,
        },
        sourceEntries,
        invalidFiles: invalidFileNames,
    };
}

function selectedControlResponseFile(
    files: DistributedRunArtifactFiles,
    telemetry: MutablePipelineTelemetry,
    jsonCache: Record<string, CachedJsonParse>,
): string | undefined {
    const fileName = 'control-post-error-metadata.json';
    if (!hasOwn(files, fileName)) {
        return undefined;
    }
    const text = files[fileName];
    if (typeof text !== 'string' || text.trim().length === 0) {
        return undefined;
    }
    const parsed = parseJsonValue(fileName, text, telemetry, jsonCache);
    return parsed.status === 'parsed' && isRecord(parsed.value) &&
            typeof parsed.value.responseFile === 'string'
        ? parsed.value.responseFile
        : undefined;
}

function parseSourceFile(
    fileName: string,
    text: string | undefined,
    forceJson: boolean,
    telemetry: MutablePipelineTelemetry,
    jsonCache: Record<string, CachedJsonParse>,
    jsonlCache: Record<string, CachedJsonlParse>,
): ParsedDistributedArtifactFile {
    const format = forceJson ? 'json' : fileFormat(fileName);
    if (format === 'jsonl') {
        return parseJsonlFile(fileName, text, telemetry, jsonlCache);
    }
    if (format === 'json') {
        return parseJsonDocument(fileName, text, telemetry, jsonCache);
    }
    if (text === undefined) {
        return { fileName, format: 'text', status: 'missing' };
    }
    if (text.trim().length === 0) {
        return { fileName, format: 'text', status: 'empty', text };
    }
    return { fileName, format: 'text', status: 'parsed', text, value: text };
}

function parseJsonDocument(
    fileName: string,
    text: string | undefined,
    telemetry: MutablePipelineTelemetry,
    jsonCache: Record<string, CachedJsonParse>,
): ParsedDistributedArtifactJsonFile {
    initializeCount(telemetry.jsonDocumentParseCountByFile, fileName);
    if (text === undefined) {
        return { fileName, format: 'json', status: 'missing' };
    }
    if (text.trim().length === 0) {
        return { fileName, format: 'json', status: 'empty', text };
    }
    const parsed = parseJsonValue(fileName, text, telemetry, jsonCache);
    return parsed.status === 'parsed'
        ? { fileName, format: 'json', status: 'parsed', text, value: parsed.value }
        : {
            fileName,
            format: 'json',
            status: 'malformed',
            text,
            message: `${fileName} is not valid JSON: ${parsed.detail}`,
        };
}

function parseJsonValue(
    fileName: string,
    text: string,
    telemetry: MutablePipelineTelemetry,
    jsonCache: Record<string, CachedJsonParse>,
): CachedJsonParse {
    initializeCount(telemetry.jsonDocumentParseCountByFile, fileName);
    const cached = hasOwn(jsonCache, fileName) ? jsonCache[fileName] : undefined;
    if (cached?.text === text) {
        return cached;
    }
    telemetry.jsonDocumentParseCount += 1;
    incrementCount(telemetry.jsonDocumentParseCountByFile, fileName);
    try {
        const parsed = { text, status: 'parsed' as const, value: JSON.parse(text) };
        setRecordValue(jsonCache, fileName, parsed);
        return parsed;
    } catch (error) {
        const parsed = {
            text,
            status: 'malformed' as const,
            detail: errorMessage(error),
        };
        setRecordValue(jsonCache, fileName, parsed);
        return parsed;
    }
}

function parseJsonlFile(
    fileName: string,
    text: string | undefined,
    telemetry: MutablePipelineTelemetry,
    jsonlCache: Record<string, CachedJsonlParse>,
): ParsedDistributedArtifactJsonlFile {
    initializeCount(telemetry.jsonlFilePassCountByFile, fileName);
    initializeCount(telemetry.jsonlRowParseCountByFile, fileName);
    if (text === undefined) {
        return { fileName, format: 'jsonl', status: 'missing', rows: [] };
    }
    const cached = hasOwn(jsonlCache, fileName) ? jsonlCache[fileName] : undefined;
    if (cached?.text === text) {
        return cached.file;
    }

    telemetry.jsonlFilePassCount += 1;
    incrementCount(telemetry.jsonlFilePassCountByFile, fileName);
    if (isSingleTopLevelObjectText(text)) {
        telemetry.jsonlRowParseCount += 1;
        incrementCount(telemetry.jsonlRowParseCountByFile, fileName);
        const lineNumber = firstNonWhitespaceLineNumber(text);
        let file: ParsedDistributedArtifactJsonlFile;
        try {
            file = {
                fileName,
                format: 'jsonl',
                status: 'parsed',
                text,
                rows: [{
                    lineNumber,
                    status: 'parsed',
                    value: JSON.parse(text),
                }],
            };
        } catch (error) {
            file = {
                fileName,
                format: 'jsonl',
                status: 'malformed',
                text,
                rows: [{
                    lineNumber,
                    status: 'malformed',
                    message: `${fileName}:${lineNumber} is not valid JSON: ${errorMessage(error)}`,
                }],
            };
        }
        setRecordValue(jsonlCache, fileName, { text, file });
        return file;
    }
    const rows: ParsedDistributedArtifactJsonlRow[] = [];
    let malformed = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        telemetry.jsonlRowParseCount += 1;
        incrementCount(telemetry.jsonlRowParseCountByFile, fileName);
        try {
            rows.push({
                lineNumber: index + 1,
                status: 'parsed',
                value: JSON.parse(trimmed),
            });
        } catch (error) {
            malformed = true;
            rows.push({
                lineNumber: index + 1,
                status: 'malformed',
                message: `${fileName}:${index + 1} is not valid JSON: ${errorMessage(error)}`,
            });
        }
    }
    const file: ParsedDistributedArtifactJsonlFile = {
        fileName,
        format: 'jsonl',
        status: malformed ? 'malformed' : rows.length > 0 ? 'parsed' : 'empty',
        text,
        rows,
    };
    setRecordValue(jsonlCache, fileName, { text, file });
    return file;
}

function malformedEnvelopeFile(
    fileName: string,
    telemetry: MutablePipelineTelemetry,
): ParsedDistributedArtifactFile {
    const format = fileFormat(fileName);
    if (format === 'json') {
        initializeCount(telemetry.jsonDocumentParseCountByFile, fileName);
        return {
            fileName,
            format,
            status: 'malformed',
            message: `${fileName} must contain text in the artifact envelope.`,
        };
    }
    if (format === 'jsonl') {
        initializeCount(telemetry.jsonlFilePassCountByFile, fileName);
        initializeCount(telemetry.jsonlRowParseCountByFile, fileName);
        return {
            fileName,
            format,
            status: 'malformed',
            rows: [],
            message: `${fileName} must contain text in the artifact envelope.`,
        };
    }
    return {
        fileName,
        format,
        status: 'malformed',
        message: `${fileName} must contain text in the artifact envelope.`,
    };
}

function missingFile(fileName: string): ParsedDistributedArtifactFile {
    const format = fileFormat(fileName);
    if (format === 'jsonl') {
        return { fileName, format, status: 'missing', rows: [] };
    }
    return { fileName, format, status: 'missing' };
}

function fileFormat(fileName: string): ParsedDistributedArtifactFile['format'] {
    if (fileName.endsWith('.jsonl')) {
        return 'jsonl';
    }
    if (fileName.endsWith('.json')) {
        return 'json';
    }
    return 'text';
}

function singleParsedJsonlValue(
    file: ParsedDistributedArtifactJsonlFile,
): ParsedDistributedArtifactJsonlRow | undefined {
    return file.rows.length === 1 && file.rows[0]?.status === 'parsed'
        ? file.rows[0]
        : undefined;
}

function isSingleTopLevelObjectText(text: string): boolean {
    let started = false;
    let completed = false;
    let objectDepth = 0;
    let inString = false;
    let escaped = false;

    for (const character of text) {
        if (!started) {
            if (isJsonWhitespace(character)) {
                continue;
            }
            if (character !== '{') {
                return false;
            }
            started = true;
            objectDepth = 1;
            continue;
        }
        if (completed) {
            if (!isJsonWhitespace(character)) {
                return false;
            }
            continue;
        }
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if (character === '{') {
            objectDepth += 1;
        } else if (character === '}') {
            objectDepth -= 1;
            if (objectDepth < 0) {
                return false;
            }
            if (objectDepth === 0) {
                completed = true;
            }
        }
    }
    return started && completed && objectDepth === 0 && !inString && !escaped;
}

function firstNonWhitespaceLineNumber(text: string): number {
    let lineNumber = 1;
    for (const character of text) {
        if (!isJsonWhitespace(character)) {
            return lineNumber;
        }
        if (character === '\n') {
            lineNumber += 1;
        }
    }
    return lineNumber;
}

function isJsonWhitespace(character: string): boolean {
    return character === ' ' || character === '\t' ||
        character === '\r' || character === '\n';
}

function createTelemetry(): MutablePipelineTelemetry {
    return {
        pipelinePassCount: 1,
        sourceCollectionPassCount: 0,
        sourceFileVisitCount: 0,
        jsonDocumentParseCount: 0,
        jsonDocumentParseCountByFile: nullRecord<number>(),
        jsonlFilePassCount: 0,
        jsonlFilePassCountByFile: nullRecord<number>(),
        jsonlRowParseCount: 0,
        jsonlRowParseCountByFile: nullRecord<number>(),
    };
}

function ownEntries(record: Readonly<Record<string, unknown>>): SourceEntry[] {
    const entries: SourceEntry[] = [];
    for (const fileName in record) {
        if (hasOwn(record, fileName)) {
            entries.push([fileName, record[fileName]]);
        }
    }
    return entries;
}

function initializeCount(counts: Record<string, number>, fileName: string): void {
    if (!hasOwn(counts, fileName)) {
        setRecordValue(counts, fileName, 0);
    }
}

function incrementCount(counts: Record<string, number>, fileName: string): void {
    setRecordValue(counts, fileName, (counts[fileName] ?? 0) + 1);
}

function nullRecord<T>(): Record<string, T> {
    return Object.create(null) as Record<string, T>;
}

function setRecordValue<T>(record: Record<string, T>, key: string, value: T): void {
    Object.defineProperty(record, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value,
    });
}

function hasOwn(record: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
        ? value
        : undefined;
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
