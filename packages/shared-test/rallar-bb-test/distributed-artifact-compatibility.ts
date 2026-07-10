import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';
import {
    distributedArtifactPipelineFile,
    distributedArtifactPipelineJsonRecord,
    parseDistributedArtifactPipeline,
    type ParsedDistributedArtifactPipeline,
} from './distributed-artifact-pipeline.ts';
import {
    DISTRIBUTED_ARTIFACT_CORE_FILE_NAMES,
    DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS,
    DISTRIBUTED_ARTIFACT_OPTIONAL_FILE_NAMES,
    type DistributedArtifactEnvelopeProjection,
    type DistributedArtifactFamily,
    type DistributedArtifactInventoryItem,
    type DistributedArtifactWorkspaceIssue,
    type DistributedArtifactWorkspaceSupport,
} from './distributed-artifact-workspace-contracts.ts';

const ADDITIONAL_RECOGNIZED_FILE_NAMES = new Set([
    'runner-summary.json',
    'fleet-report.json',
    'control-post-create-error.json',
    'control-post-stage-error.json',
    'control-post-start-error.json',
    'control-post-request-error.json',
    'control-post-error-metadata.json',
]);
const JSONL_FILE_NAMES = new Set(['results.jsonl', 'events.jsonl']);
const NULLABLE_JSON_FILE_NAMES = new Set([
    'control-run.json',
    'target-resolution.json',
]);

type FileValidation = Readonly<{
    status: 'loaded' | 'malformed' | 'incompatible';
    message?: string;
}>;

export function identifyDistributedArtifactFamily(
    files: DistributedRunArtifactFiles,
    envelopeDistributedRunId?: string,
): DistributedArtifactFamily {
    return identifyDistributedArtifactFamilyFromParsed(
        parseDistributedArtifactPipeline(files, {
            projection: 'literal-loose-files',
        }),
        envelopeDistributedRunId,
    );
}

export function identifyDistributedArtifactFamilyFromParsed(
    parsed: ParsedDistributedArtifactPipeline,
    envelopeDistributedRunId?: string,
): DistributedArtifactFamily {
    const files = parsed.projectedFiles;
    if (
        envelopeDistributedRunId ||
        DISTRIBUTED_ARTIFACT_CORE_FILE_NAMES.some(
            fileName => files[fileName] !== undefined,
        )
    ) return 'distributed-run';
    const report = distributedArtifactPipelineJsonRecord(parsed, 'report.json');
    const metadata = distributedArtifactPipelineJsonRecord(parsed, 'metadata.json');
    if (metadata.execution === 'distributed-run' || report.execution === 'distributed-run') {
        return 'distributed-run';
    }
    if (
        metadata.execution === 'run' ||
        Array.isArray(report.resultsList) ||
        stringValue(metadata.config)?.includes('black-box-runner') ||
        stringArray(metadata.command).some(value =>
            value.includes('scenario-black-box')
        )
    ) return 'black-box-runner';
    return 'unknown';
}

export function createDistributedArtifactInventory(
    family: DistributedArtifactFamily,
    files: DistributedRunArtifactFiles,
    projection: DistributedArtifactEnvelopeProjection,
    issues: DistributedArtifactWorkspaceIssue[],
): DistributedArtifactInventoryItem[] {
    return createDistributedArtifactInventoryFromParsed(
        family,
        parseDistributedArtifactPipeline(files, {
            projection: 'literal-loose-files',
        }),
        projection,
        issues,
    );
}

export function createDistributedArtifactInventoryFromParsed(
    family: DistributedArtifactFamily,
    parsed: ParsedDistributedArtifactPipeline,
    projection: DistributedArtifactEnvelopeProjection,
    issues: DistributedArtifactWorkspaceIssue[],
): DistributedArtifactInventoryItem[] {
    const files = parsed.projectedFiles;
    const inventory: DistributedArtifactInventoryItem[] = [];
    const visited = new Set<string>();
    if (family === 'distributed-run') {
        for (const fileName of DISTRIBUTED_ARTIFACT_CORE_FILE_NAMES) {
            visited.add(fileName);
            addExpected(inventory, issues, files, projection, fileName, 'core', parsed);
        }
        for (const fileName of DISTRIBUTED_ARTIFACT_OPTIONAL_FILE_NAMES) {
            visited.add(fileName);
            addExpected(inventory, issues, files, projection, fileName, 'optional', parsed);
        }
    }
    for (const fileName of Object.keys(files).sort()) {
        if (visited.has(fileName) || files[fileName] === undefined) continue;
        if (isRecognizedFile(fileName)) {
            const validation = validateParsedFile(parsed, fileName);
            inventory.push({
                fileName,
                status: validation.status,
                requirement: 'recognized',
                message: validation.message,
            });
            addValidationIssue(issues, fileName, validation);
        } else {
            addIgnored(inventory, issues, fileName);
        }
    }
    for (const [fileName, message] of Object.entries(projection.invalidFiles).sort()) {
        const existing = inventory.findIndex(item => item.fileName === fileName);
        const requirement = existing >= 0
            ? inventory[existing]?.requirement ?? 'recognized'
            : 'recognized';
        const item = { fileName, status: 'incompatible' as const, requirement, message };
        if (existing >= 0) inventory[existing] = item;
        else inventory.push(item);
        issues.push({ code: 'incompatible-file', severity: 'error', fileName, message });
    }
    for (const fileName of projection.outerIgnoredFiles) {
        addIgnored(inventory, issues, fileName);
    }
    return inventory;
}

export function distributedArtifactWorkspaceSupport(input: Readonly<{
    family: DistributedArtifactFamily;
    inventory: readonly DistributedArtifactInventoryItem[];
    hasSchemaConflict: boolean;
    hasInvalidEnvelopeSchema: boolean;
    hasFatalEnvelopeIssue: boolean;
    artifactSchemaVersion?: number;
}>): DistributedArtifactWorkspaceSupport {
    if (
        input.hasSchemaConflict || input.hasInvalidEnvelopeSchema ||
        input.hasFatalEnvelopeIssue || input.inventory.some(item =>
            item.requirement === 'core' &&
            (item.status === 'malformed' || item.status === 'incompatible')
        )
    ) return 'incompatible';
    if (
        input.family !== 'distributed-run' ||
        (input.artifactSchemaVersion !== undefined &&
            !DISTRIBUTED_ARTIFACT_KNOWN_SCHEMA_VERSIONS.has(input.artifactSchemaVersion))
    ) return 'unsupported';
    return input.inventory.some(item => item.status === 'missing-core')
        ? 'incomplete'
        : 'supported';
}

export function inferredDistributedArtifactSchemaVersion(
    files: DistributedRunArtifactFiles,
    family: DistributedArtifactFamily,
): number | undefined {
    if (family !== 'distributed-run') return undefined;
    return ['report.json', 'failures.json', 'metadata.json']
            .every(fileName => files[fileName] !== undefined)
        ? 2
        : 1;
}

export function inferredDistributedArtifactSchemaVersionFromParsed(
    parsed: ParsedDistributedArtifactPipeline,
    family: DistributedArtifactFamily,
): number | undefined {
    return inferredDistributedArtifactSchemaVersion(parsed.projectedFiles, family);
}

export function declaredDistributedArtifactSchemaVersion(
    files: DistributedRunArtifactFiles,
): number | undefined {
    return declaredDistributedArtifactSchemaVersionFromParsed(
        parseDistributedArtifactPipeline(files, {
            projection: 'literal-loose-files',
        }),
    );
}

export function declaredDistributedArtifactSchemaVersionFromParsed(
    parsed: ParsedDistributedArtifactPipeline,
): number | undefined {
    return finiteInteger(
        distributedArtifactPipelineJsonRecord(parsed, 'metadata.json').artifactSchemaVersion,
    ) ?? finiteInteger(
        distributedArtifactPipelineJsonRecord(parsed, 'report.json').artifactSchemaVersion,
    );
}

export function distributedArtifactGeneratedAt(
    files: DistributedRunArtifactFiles,
): number | undefined {
    return distributedArtifactGeneratedAtFromParsed(
        parseDistributedArtifactPipeline(files, {
            projection: 'literal-loose-files',
        }),
    );
}

export function distributedArtifactGeneratedAtFromParsed(
    parsed: ParsedDistributedArtifactPipeline,
): number | undefined {
    return finiteNumber(
        distributedArtifactPipelineJsonRecord(parsed, 'metadata.json').generatedAtEpochMs,
    );
}

export function distributedArtifactSchemaInventory(
    status: 'incompatible' | 'unknown-version',
    message: string,
): DistributedArtifactInventoryItem {
    return {
        fileName: '$artifactSchemaVersion',
        status,
        requirement: 'schema',
        message,
    };
}

function addExpected(
    inventory: DistributedArtifactInventoryItem[],
    issues: DistributedArtifactWorkspaceIssue[],
    files: DistributedRunArtifactFiles,
    projection: DistributedArtifactEnvelopeProjection,
    fileName: string,
    requirement: 'core' | 'optional',
    parsed: ParsedDistributedArtifactPipeline,
): void {
    const invalidMessage = projection.invalidFiles[fileName];
    if (invalidMessage) {
        inventory.push({ fileName, status: 'incompatible', requirement, message: invalidMessage });
        return;
    }
    const text = files[fileName];
    if (text === undefined) {
        const status = requirement === 'core' ? 'missing-core' : 'missing-optional';
        const message = requirement === 'core'
            ? `${fileName} is required for distributed-run analysis.`
            : `${fileName} was not included; available evidence remains usable.`;
        inventory.push({ fileName, status, requirement, message });
        issues.push({
            code: status,
            severity: requirement === 'core' ? 'error' : 'warning',
            fileName,
            message,
        });
        return;
    }
    const validation = validateParsedFile(parsed, fileName);
    inventory.push({ fileName, status: validation.status, requirement, message: validation.message });
    addValidationIssue(issues, fileName, validation);
}

function validateParsedFile(
    parsed: ParsedDistributedArtifactPipeline,
    fileName: string,
): FileValidation {
    const file = distributedArtifactPipelineFile(parsed, fileName);
    if (JSONL_FILE_NAMES.has(fileName)) {
        if (file.format !== 'jsonl') {
            return { status: 'malformed', message: `${fileName} is not valid JSON.` };
        }
        for (const row of file.rows) {
            if (row.status === 'malformed') {
                return {
                    status: 'malformed',
                    message: `${fileName}:${row.lineNumber} is not valid JSON.`,
                };
            }
            if (!isRecord(row.value)) {
                return {
                    status: 'incompatible',
                    message: `${fileName}:${row.lineNumber} must contain a JSON object.`,
                };
            }
        }
        return { status: 'loaded' };
    }
    if (file.status === 'malformed' || file.status === 'empty') {
        return { status: 'malformed', message: `${fileName} is not valid JSON.` };
    }
    const value = file.format === 'json' && file.status === 'parsed'
        ? file.value
        : undefined;
    if (value === null && NULLABLE_JSON_FILE_NAMES.has(fileName)) return { status: 'loaded' };
    return isRecord(value)
        ? { status: 'loaded' }
        : { status: 'incompatible', message: `${fileName} must contain a JSON object.` };
}

function addValidationIssue(
    issues: DistributedArtifactWorkspaceIssue[],
    fileName: string,
    validation: FileValidation,
): void {
    if (validation.status === 'loaded') return;
    issues.push({
        code: validation.status === 'malformed' ? 'malformed-file' : 'incompatible-file',
        severity: 'error', fileName,
        message: validation.message ?? `${fileName} cannot be used.`,
    });
}

function addIgnored(
    inventory: DistributedArtifactInventoryItem[],
    issues: DistributedArtifactWorkspaceIssue[],
    fileName: string,
): void {
    const message = `${fileName} is not part of the distributed-run artifact contract and was ignored.`;
    inventory.push({ fileName, status: 'ignored', requirement: 'unknown', message });
    issues.push({ code: 'ignored-file', severity: 'warning', fileName, message });
}

function isRecognizedFile(fileName: string): boolean {
    return DISTRIBUTED_ARTIFACT_CORE_FILE_NAMES.includes(fileName as never) ||
        DISTRIBUTED_ARTIFACT_OPTIONAL_FILE_NAMES.includes(fileName as never) ||
        ADDITIONAL_RECOGNIZED_FILE_NAMES.has(fileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function finiteInteger(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}
function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}
function stringArray(value: unknown): readonly string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
