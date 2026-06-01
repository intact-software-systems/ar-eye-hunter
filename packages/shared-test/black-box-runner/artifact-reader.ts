import {
    BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT,
    type BlackBoxRunnerArtifactFileName,
    type BlackBoxRunnerExpectedResult,
    type BlackBoxRunnerExecutionMode,
    type BlackBoxRunnerLiveSupport,
    type BlackBoxRunnerProviderMode,
    type BlackBoxRunnerRecipeCatalog,
    type BlackBoxRunnerRecipeCatalogEntry,
} from './handoff-contract.ts';

export const BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION = 1;
export const BLACK_BOX_RUNNER_RECIPE_CATALOG_SCHEMA_VERSION = 1;
export const BLACK_BOX_RUNNER_SUPPORTED_ARTIFACT_SCHEMA_VERSIONS = [0, 1] as const;
export const BLACK_BOX_RUNNER_SUPPORTED_RECIPE_CATALOG_SCHEMA_VERSIONS = [0, 1] as const;

export type BlackBoxRunnerArtifactSchemaVersion =
    typeof BLACK_BOX_RUNNER_SUPPORTED_ARTIFACT_SCHEMA_VERSIONS[number];

export type BlackBoxRunnerRecipeCatalogSchemaVersion =
    typeof BLACK_BOX_RUNNER_SUPPORTED_RECIPE_CATALOG_SCHEMA_VERSIONS[number];

export type BlackBoxRunnerArtifactValidationSeverity = 'error' | 'warning';

export type BlackBoxRunnerArtifactValidationIssue = Readonly<{
    severity: BlackBoxRunnerArtifactValidationSeverity;
    file?: BlackBoxRunnerArtifactFileName | 'recipe-catalog';
    path: string;
    message: string;
}>;

export type BlackBoxRunnerArtifactValidationResult<T> = Readonly<{
    ok: boolean;
    value?: T;
    issues: readonly BlackBoxRunnerArtifactValidationIssue[];
    errors: readonly BlackBoxRunnerArtifactValidationIssue[];
    warnings: readonly BlackBoxRunnerArtifactValidationIssue[];
}>;

export type BlackBoxRunnerArtifactSummary = Readonly<{
    total: number;
    success: number;
    failure: number;
    [key: string]: unknown;
}>;

export type BlackBoxRunnerReport = Readonly<{
    schemaVersion?: number;
    artifactSchemaVersion?: number;
    summary: BlackBoxRunnerArtifactSummary;
    results?: Record<string, unknown>;
    resultsList: readonly Record<string, unknown>[];
    resultsByName?: Record<string, unknown>;
    outputs: Record<string, unknown>;
    wsMessages?: Record<string, unknown>;
    wsCloseEvents?: Record<string, unknown>;
    rtcMessages?: Record<string, unknown>;
    rtcDiagnostics?: Record<string, unknown>;
    rtcCloseEvents?: Record<string, unknown>;
    trafficPlan?: Record<string, unknown>;
    metrics?: Record<string, unknown>;
    artifactLimits?: Record<string, unknown>;
}>;

export type BlackBoxRunnerArtifactEventKind =
    typeof BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.eventStream.eventKinds[number];

export type BlackBoxRunnerArtifactEvent = Readonly<{
    kind: BlackBoxRunnerArtifactEventKind;
    [key: string]: unknown;
}>;

export type BlackBoxRunnerFailureBundle = Readonly<{
    summary: BlackBoxRunnerArtifactSummary;
    failures: readonly Record<string, unknown>[];
    postRunAssertionFailures?: readonly Record<string, unknown>[];
    postRunAssertions?: Record<string, unknown>;
    outputs: Record<string, unknown>;
}>;

export type BlackBoxRunnerArtifactMetadata = Readonly<{
    schemaVersion?: number;
    artifactSchemaVersion?: number;
    generatedAtEpochMs: number;
    config?: string;
    workingDirectory?: string;
    dryRun?: boolean;
    execution?: string;
    summary: BlackBoxRunnerArtifactSummary;
    command?: readonly string[];
    [key: string]: unknown;
}>;

export type BlackBoxRunnerLivePreflightReport = Readonly<{
    schemaVersion?: number;
    generatedAtEpochMs: number;
    mode: 'live-environment';
    ok: boolean;
    summary: Record<string, unknown>;
    checks: readonly Record<string, unknown>[];
    issues: readonly Record<string, unknown>[];
    skipReasons: readonly string[];
    [key: string]: unknown;
}>;

export type BlackBoxRunnerArtifactIndex = Readonly<{
    schemaVersion?: number;
    kind?: 'black-box-runner.artifact-index';
    generatedAtEpochMs: number;
    summary: BlackBoxRunnerArtifactSummary;
    counts: Record<string, unknown>;
    stepResults: readonly Record<string, unknown>[];
    perRun: readonly Record<string, unknown>[];
    perConnection: readonly Record<string, unknown>[];
    compaction?: Record<string, unknown>;
    truncation: Record<string, unknown>;
    firstFailure?: Record<string, unknown>;
    [key: string]: unknown;
}>;

export type BlackBoxRunnerExpandedRecipe = Readonly<{
    schemaVersion?: number;
    kind?: 'black-box-runner.expanded-recipe';
    generatedAtEpochMs: number;
    sourceConfig?: string;
    includeMetadata?: Record<string, unknown>;
    recipe: Record<string, unknown>;
    [key: string]: unknown;
}>;

export type BlackBoxRunnerExpandedPlan = Readonly<{
    version?: number;
    schemaVersion?: number;
    seed: number;
    replay: boolean;
    generator?: Record<string, unknown>;
    decisions: readonly Record<string, unknown>[];
    steps: readonly Record<string, unknown>[];
    replayRecipe: Readonly<{
        steps: readonly Record<string, unknown>[];
        execution?: Record<string, unknown>;
        [key: string]: unknown;
    }>;
}>;

export type BlackBoxRunnerReducedPlan = BlackBoxRunnerExpandedPlan & Readonly<{
    kind?: 'black-box-runner.reduced-plan';
    reduction?: Record<string, unknown>;
}>;

export type BlackBoxRunnerMatrixRun = Readonly<{
    id: string;
    recipe: string;
    status: 'PASSED' | 'FAILED' | 'SKIPPED';
    reasons?: readonly string[];
    expectedExitCode?: number;
    code?: number;
    durationMs?: number;
    artifactDir?: string;
    summary?: Record<string, unknown>;
}>;

export type BlackBoxRunnerMatrixSummary = Readonly<{
    schemaVersion?: number;
    generatedAtEpochMs: number;
    profile: string;
    requireGates: boolean;
    runs: readonly BlackBoxRunnerMatrixRun[];
    summary: Readonly<{
        PASSED: number;
        FAILED: number;
        SKIPPED: number;
        [key: string]: unknown;
    }>;
}>;

export type BlackBoxRunnerArtifactViews = Readonly<{
    eventStream: readonly BlackBoxRunnerArtifactEvent[];
    postRunAssertions: readonly BlackBoxRunnerArtifactEvent[];
    rtcDiagnostics: readonly BlackBoxRunnerArtifactEvent[];
    rtcMessages: readonly BlackBoxRunnerArtifactEvent[];
    wsMessages: readonly BlackBoxRunnerArtifactEvent[];
    failures: readonly Record<string, unknown>[];
    artifactIndex?: BlackBoxRunnerArtifactIndex;
    expandedRecipe?: BlackBoxRunnerExpandedRecipe;
    replayRecipe?: BlackBoxRunnerExpandedPlan['replayRecipe'];
    reducedPlan?: BlackBoxRunnerReducedPlan;
    reducedReplayRecipe?: BlackBoxRunnerReducedPlan['replayRecipe'];
}>;

export type BlackBoxRunnerParsedArtifactBundle = Readonly<{
    schemaVersion: BlackBoxRunnerArtifactSchemaVersion;
    report: BlackBoxRunnerReport;
    events: readonly BlackBoxRunnerArtifactEvent[];
    failures: BlackBoxRunnerFailureBundle;
    metadata: BlackBoxRunnerArtifactMetadata;
    artifactIndex?: BlackBoxRunnerArtifactIndex;
    expandedRecipe?: BlackBoxRunnerExpandedRecipe;
    preflightReport?: BlackBoxRunnerLivePreflightReport;
    expandedPlan?: BlackBoxRunnerExpandedPlan;
    reducedPlan?: BlackBoxRunnerReducedPlan;
    matrixSummary?: BlackBoxRunnerMatrixSummary;
    views: BlackBoxRunnerArtifactViews;
    compatibility: Readonly<{
        sourceSchemaVersion: BlackBoxRunnerArtifactSchemaVersion;
        currentSchemaVersion: typeof BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION;
        legacy: boolean;
    }>;
}>;

export type BlackBoxRunnerArtifactBundleFiles = Partial<Record<BlackBoxRunnerArtifactFileName, string>>;

export type BlackBoxRunnerRecipeCatalogEntryFixture = Readonly<{
    schemaVersion: BlackBoxRunnerRecipeCatalogSchemaVersion;
    kind: 'black-box-runner.recipe-catalog-entry';
    entry: BlackBoxRunnerRecipeCatalogEntry;
}>;

type JsonRecord = Record<string, unknown>;

const ALLOWED_EVENT_KINDS = new Set<string>(
    BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.eventStream.eventKinds,
);

const REDACTION_PLACEHOLDER_PATTERN = /^<redacted:[A-Za-z0-9_.-]+>$/;

function isRecord(value: unknown): value is JsonRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
    return isRecord(value) ? value : {};
}

function asArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
}

function issue(
    severity: BlackBoxRunnerArtifactValidationSeverity,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    message: string,
): BlackBoxRunnerArtifactValidationIssue {
    return {
        severity,
        file,
        path,
        message,
    };
}

function addError(
    issues: BlackBoxRunnerArtifactValidationIssue[],
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    message: string,
): void {
    issues.push(issue('error', file, path, message));
}

function addWarning(
    issues: BlackBoxRunnerArtifactValidationIssue[],
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    message: string,
): void {
    issues.push(issue('warning', file, path, message));
}

function toResult<T>(
    value: T | undefined,
    issues: readonly BlackBoxRunnerArtifactValidationIssue[],
): BlackBoxRunnerArtifactValidationResult<T> {
    const errors = issues.filter(item => item.severity === 'error');
    const warnings = issues.filter(item => item.severity === 'warning');

    return {
        ok: errors.length === 0,
        ...(errors.length === 0 && value !== undefined ? { value } : {}),
        issues,
        errors,
        warnings,
    };
}

function requireRecord(
    value: unknown,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    issues: BlackBoxRunnerArtifactValidationIssue[],
): JsonRecord | undefined {
    if (!isRecord(value)) {
        addError(issues, file, path, 'Expected an object.');
        return undefined;
    }

    return value;
}

function requireNumber(
    record: JsonRecord,
    key: string,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    issues: BlackBoxRunnerArtifactValidationIssue[],
): number | undefined {
    const value = record[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        addError(issues, file, `${path}.${key}`, `Expected numeric field ${key}.`);
        return undefined;
    }

    return value;
}

function requireString(
    record: JsonRecord,
    key: string,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    issues: BlackBoxRunnerArtifactValidationIssue[],
): string | undefined {
    const value = record[key];
    if (typeof value !== 'string' || value.length <= 0) {
        addError(issues, file, `${path}.${key}`, `Expected non-empty string field ${key}.`);
        return undefined;
    }

    return value;
}

function requireArray(
    record: JsonRecord,
    key: string,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    issues: BlackBoxRunnerArtifactValidationIssue[],
): unknown[] | undefined {
    const value = record[key];
    if (!Array.isArray(value)) {
        addError(issues, file, `${path}.${key}`, `Expected array field ${key}.`);
        return undefined;
    }

    return value;
}

function requireSummary(
    value: unknown,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    path: string,
    issues: BlackBoxRunnerArtifactValidationIssue[],
): BlackBoxRunnerArtifactSummary | undefined {
    const summary = requireRecord(value, file, path, issues);
    if (!summary) {
        return undefined;
    }

    const total = requireNumber(summary, 'total', file, path, issues);
    const success = requireNumber(summary, 'success', file, path, issues);
    const failure = requireNumber(summary, 'failure', file, path, issues);

    if (total === undefined || success === undefined || failure === undefined) {
        return undefined;
    }

    return {
        ...summary,
        total,
        success,
        failure,
    };
}

function visitStrings(value: unknown, callback: (text: string, path: string) => void, path = '$'): void {
    if (typeof value === 'string') {
        callback(value, path);
        return;
    }

    if (Array.isArray(value)) {
        value.forEach((item, index) => visitStrings(item, callback, `${path}[${index}]`));
        return;
    }

    if (isRecord(value)) {
        Object.entries(value).forEach(([key, nested]) => {
            visitStrings(nested, callback, `${path}.${key}`);
        });
    }
}

function validateRedactionPlaceholders(
    value: unknown,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    issues: BlackBoxRunnerArtifactValidationIssue[],
): void {
    visitStrings(value, (text, path) => {
        const placeholders = text.match(/<redacted[^>]*>/g) || [];
        placeholders.forEach(placeholder => {
            if (!REDACTION_PLACEHOLDER_PATTERN.test(placeholder)) {
                addError(
                    issues,
                    file,
                    path,
                    `Invalid redaction placeholder ${placeholder}; expected <redacted:name>.`,
                );
            }
        });
    });
}

function parseJson(text: string, file: BlackBoxRunnerArtifactValidationIssue['file']): {
    value?: unknown;
    issues: BlackBoxRunnerArtifactValidationIssue[];
} {
    try {
        return {
            value: JSON.parse(text),
            issues: [],
        };
    } catch (error) {
        return {
            issues: [
                issue(
                    'error',
                    file,
                    '$',
                    'Invalid JSON: ' + (error instanceof Error ? error.message : String(error)),
                ),
            ],
        };
    }
}

function validateSchemaVersion(
    version: unknown,
    supportedVersions: readonly number[],
    currentVersion: number,
    file: BlackBoxRunnerArtifactValidationIssue['file'],
    issues: BlackBoxRunnerArtifactValidationIssue[],
): number {
    const normalized = version === undefined ? 0 : numberValue(version);
    if (normalized === undefined || !supportedVersions.includes(normalized)) {
        addError(
            issues,
            file,
            '$.schemaVersion',
            `Unsupported schema version ${String(version)}; supported versions are ${supportedVersions.join(', ')}.`,
        );
        return currentVersion;
    }

    if (normalized === 0) {
        addWarning(
            issues,
            file,
            '$.schemaVersion',
            'No explicit schemaVersion was found; treating this as legacy compatible v0.',
        );
    }

    return normalized;
}

function reportSchemaVersion(report: BlackBoxRunnerReport, metadata?: BlackBoxRunnerArtifactMetadata): number | undefined {
    return metadata?.artifactSchemaVersion ??
        metadata?.schemaVersion ??
        report.artifactSchemaVersion ??
        report.schemaVersion;
}

export function parseBlackBoxRunnerReport(text: string): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerReport> {
    const parsed = parseJson(text, 'report.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'report.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const summary = requireSummary(record.summary, 'report.json', '$.summary', issues);
    const resultsList = requireArray(record, 'resultsList', 'report.json', '$', issues);
    const outputs = isRecord(record.outputs) ? record.outputs : {};
    if (!isRecord(record.outputs)) {
        addError(issues, 'report.json', '$.outputs', 'Expected object field outputs.');
    }
    validateRedactionPlaceholders(record, 'report.json', issues);

    const value = summary && resultsList
        ? {
            ...record,
            summary,
            resultsList: resultsList.filter(isRecord),
            outputs,
        } satisfies BlackBoxRunnerReport
        : undefined;

    return toResult(value, issues);
}

export function parseBlackBoxRunnerEventsJsonl(
    text: string,
): BlackBoxRunnerArtifactValidationResult<readonly BlackBoxRunnerArtifactEvent[]> {
    const issues: BlackBoxRunnerArtifactValidationIssue[] = [];
    const events = text
        .split(/\r?\n/g)
        .map(line => line.trim())
        .filter(line => line.length > 0)
        .flatMap((line, index) => {
            const linePath = `$[${index + 1}]`;
            const parsed = parseJson(line, 'events.jsonl');
            issues.push(...parsed.issues.map(item => ({ ...item, path: linePath })));
            const record = requireRecord(parsed.value, 'events.jsonl', linePath, issues);
            if (!record) {
                return [];
            }

            const kind = stringValue(record.kind);
            if (!kind || !ALLOWED_EVENT_KINDS.has(kind)) {
                addError(
                    issues,
                    'events.jsonl',
                    `${linePath}.kind`,
                    `Unsupported event kind ${String(record.kind)}.`,
                );
                return [];
            }

            validateArtifactEvent(record, index + 1, issues);
            validateRedactionPlaceholders(record, 'events.jsonl', issues);

            return [{ ...record, kind } satisfies BlackBoxRunnerArtifactEvent];
        });

    return toResult(events, issues);
}

function validateArtifactEvent(
    event: JsonRecord,
    line: number,
    issues: BlackBoxRunnerArtifactValidationIssue[],
): void {
    const path = `$[${line}]`;
    if (event.kind === 'step-result') {
        requireString(event, 'name', 'events.jsonl', path, issues);
        requireString(event, 'status', 'events.jsonl', path, issues);
        requireString(event, 'transport', 'events.jsonl', path, issues);
        return;
    }

    if (event.kind === 'post-run-assertion') {
        requireString(event, 'name', 'events.jsonl', path, issues);
        requireString(event, 'status', 'events.jsonl', path, issues);
        requireString(event, 'operator', 'events.jsonl', path, issues);
        if (!('actual' in event)) {
            addError(issues, 'events.jsonl', `${path}.actual`, 'Expected post-run assertion actual value.');
        }
        return;
    }

    if (event.kind === 'artifact-truncated') {
        requireNumber(event, 'totalEvents', 'events.jsonl', path, issues);
        requireNumber(event, 'emittedEvents', 'events.jsonl', path, issues);
        requireNumber(event, 'omittedEvents', 'events.jsonl', path, issues);
        return;
    }

    requireString(event, 'connection', 'events.jsonl', path, issues);
    if (!('value' in event)) {
        addError(issues, 'events.jsonl', `${path}.value`, 'Expected event payload field value.');
    }
}

export function parseBlackBoxRunnerFailures(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerFailureBundle> {
    const parsed = parseJson(text, 'failures.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'failures.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const summary = requireSummary(record.summary, 'failures.json', '$.summary', issues);
    const failures = requireArray(record, 'failures', 'failures.json', '$', issues);
    const postRunAssertionFailures = Array.isArray(record.postRunAssertionFailures)
        ? record.postRunAssertionFailures.filter(isRecord)
        : undefined;
    const postRunAssertions = isRecord(record.postRunAssertions)
        ? record.postRunAssertions
        : undefined;
    const outputs = isRecord(record.outputs) ? record.outputs : {};
    if (!isRecord(record.outputs)) {
        addError(issues, 'failures.json', '$.outputs', 'Expected object field outputs.');
    }
    validateRedactionPlaceholders(record, 'failures.json', issues);

    const value = summary && failures
        ? {
            summary,
            failures: failures.filter(isRecord),
            ...(postRunAssertionFailures ? { postRunAssertionFailures } : {}),
            ...(postRunAssertions ? { postRunAssertions } : {}),
            outputs,
        }
        : undefined;

    return toResult(value, issues);
}

export function parseBlackBoxRunnerMetadata(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerArtifactMetadata> {
    const parsed = parseJson(text, 'metadata.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'metadata.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const generatedAtEpochMs = requireNumber(record, 'generatedAtEpochMs', 'metadata.json', '$', issues);
    const summary = requireSummary(record.summary, 'metadata.json', '$.summary', issues);
    if (record.command !== undefined && !Array.isArray(record.command)) {
        addError(issues, 'metadata.json', '$.command', 'Expected command to be an array when present.');
    }
    validateRedactionPlaceholders(record, 'metadata.json', issues);

    const value = generatedAtEpochMs !== undefined && summary
        ? {
            ...record,
            generatedAtEpochMs,
            summary,
            command: stringList(record.command),
        } satisfies BlackBoxRunnerArtifactMetadata
        : undefined;

    return toResult(value, issues);
}

export function parseBlackBoxRunnerArtifactIndex(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerArtifactIndex> {
    const parsed = parseJson(text, 'artifact-index.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'artifact-index.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const generatedAtEpochMs = requireNumber(record, 'generatedAtEpochMs', 'artifact-index.json', '$', issues);
    const summary = requireSummary(record.summary, 'artifact-index.json', '$.summary', issues);
    const counts = requireRecord(record.counts, 'artifact-index.json', '$.counts', issues);
    const stepResults = requireArray(record, 'stepResults', 'artifact-index.json', '$', issues);
    const perRun = requireArray(record, 'perRun', 'artifact-index.json', '$', issues);
    const perConnection = requireArray(record, 'perConnection', 'artifact-index.json', '$', issues);
    const truncation = requireRecord(record.truncation, 'artifact-index.json', '$.truncation', issues);
    if (truncation) {
        requireNumber(truncation, 'totalEvents', 'artifact-index.json', '$.truncation', issues);
        requireNumber(truncation, 'emittedEvents', 'artifact-index.json', '$.truncation', issues);
        requireNumber(truncation, 'omittedEvents', 'artifact-index.json', '$.truncation', issues);
        if (typeof truncation.truncated !== 'boolean') {
            addError(issues, 'artifact-index.json', '$.truncation.truncated', 'Expected boolean field truncated.');
        }
    }
    validateRedactionPlaceholders(record, 'artifact-index.json', issues);

    const value = generatedAtEpochMs !== undefined &&
            summary &&
            counts &&
            stepResults &&
            perRun &&
            perConnection &&
            truncation
        ? {
            ...record,
            generatedAtEpochMs,
            summary,
            counts,
            stepResults: stepResults.filter(isRecord),
            perRun: perRun.filter(isRecord),
            perConnection: perConnection.filter(isRecord),
            compaction: isRecord(record.compaction) ? record.compaction : undefined,
            truncation,
            firstFailure: isRecord(record.firstFailure) ? record.firstFailure : undefined,
        } satisfies BlackBoxRunnerArtifactIndex
        : undefined;

    return toResult(value, issues);
}

export function parseBlackBoxRunnerExpandedRecipe(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerExpandedRecipe> {
    const parsed = parseJson(text, 'expanded-recipe.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'expanded-recipe.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const generatedAtEpochMs = requireNumber(record, 'generatedAtEpochMs', 'expanded-recipe.json', '$', issues);
    const recipe = requireRecord(record.recipe, 'expanded-recipe.json', '$.recipe', issues);
    if (recipe && recipe.steps !== undefined) {
        requireArray(recipe, 'steps', 'expanded-recipe.json', '$.recipe', issues);
    }
    validateRedactionPlaceholders(record, 'expanded-recipe.json', issues);

    const value = generatedAtEpochMs !== undefined && recipe
        ? {
            ...record,
            generatedAtEpochMs,
            sourceConfig: stringValue(record.sourceConfig),
            includeMetadata: isRecord(record.includeMetadata) ? record.includeMetadata : undefined,
            recipe,
        } satisfies BlackBoxRunnerExpandedRecipe
        : undefined;

    return toResult(value, issues);
}

export function parseBlackBoxRunnerLivePreflightReport(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerLivePreflightReport> {
    const parsed = parseJson(text, 'preflight-report.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'preflight-report.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const generatedAtEpochMs = requireNumber(record, 'generatedAtEpochMs', 'preflight-report.json', '$', issues);
    const mode = requireString(record, 'mode', 'preflight-report.json', '$', issues);
    if (mode !== 'live-environment') {
        addError(issues, 'preflight-report.json', '$.mode', 'Expected mode live-environment.');
    }
    if (typeof record.ok !== 'boolean') {
        addError(issues, 'preflight-report.json', '$.ok', 'Expected boolean field ok.');
    }
    const summary = requireRecord(record.summary, 'preflight-report.json', '$.summary', issues);
    const checks = requireArray(record, 'checks', 'preflight-report.json', '$', issues);
    const issuesList = requireArray(record, 'issues', 'preflight-report.json', '$', issues);
    const skipReasonsValue = requireArray(record, 'skipReasons', 'preflight-report.json', '$', issues);
    const skipReasons = stringList(skipReasonsValue);
    validateRedactionPlaceholders(record, 'preflight-report.json', issues);

    const value = generatedAtEpochMs !== undefined &&
            mode === 'live-environment' &&
            typeof record.ok === 'boolean' &&
            summary &&
            checks &&
            issuesList &&
            skipReasonsValue
        ? {
            ...record,
            generatedAtEpochMs,
            mode,
            ok: record.ok,
            summary,
            checks: checks.filter(isRecord),
            issues: issuesList.filter(isRecord),
            skipReasons,
        } satisfies BlackBoxRunnerLivePreflightReport
        : undefined;

    return toResult(value, issues);
}

function parseBlackBoxRunnerTrafficPlanArtifact(
    text: string,
    file: BlackBoxRunnerArtifactFileName,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerExpandedPlan> {
    const parsed = parseJson(text, file);
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, file, '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const seed = requireNumber(record, 'seed', file, '$', issues);
    if (typeof record.replay !== 'boolean') {
        addError(issues, file, '$.replay', 'Expected boolean field replay.');
    }
    const decisions = requireArray(record, 'decisions', file, '$', issues);
    const steps = requireArray(record, 'steps', file, '$', issues);
    const replayRecipe = requireRecord(record.replayRecipe, file, '$.replayRecipe', issues);
    if (replayRecipe) {
        requireArray(replayRecipe, 'steps', file, '$.replayRecipe', issues);
        const execution = asRecord(replayRecipe.execution);
        const trafficPlan = asRecord(execution.trafficPlan);
        const expandedPlan = asRecord(trafficPlan.expandedPlan);
        if (!trafficPlan.replayFrom && Object.keys(expandedPlan).length <= 0) {
            addError(
                issues,
                file,
                '$.replayRecipe.execution.trafficPlan',
                'Expected replayFrom or expandedPlan replay data.',
            );
        }
    }
    validateRedactionPlaceholders(record, file, issues);

    const replaySteps = replayRecipe ? asArray(replayRecipe.steps).filter(isRecord) : undefined;
    const value = seed !== undefined && typeof record.replay === 'boolean' && decisions && steps && replayRecipe && replaySteps
        ? {
            ...record,
            seed,
            replay: record.replay,
            decisions: decisions.filter(isRecord),
            steps: steps.filter(isRecord),
            replayRecipe: {
                ...replayRecipe,
                steps: replaySteps,
            },
        } satisfies BlackBoxRunnerExpandedPlan
        : undefined;

    return toResult(value, issues);
}

export function parseBlackBoxRunnerExpandedPlan(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerExpandedPlan> {
    return parseBlackBoxRunnerTrafficPlanArtifact(text, 'expanded-plan.json');
}

export function parseBlackBoxRunnerReducedPlan(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerReducedPlan> {
    const parsed = parseBlackBoxRunnerTrafficPlanArtifact(text, 'reduced-plan.json');
    if (!parsed.value) {
        return parsed as BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerReducedPlan>;
    }

    const rawPlan = parsed.value as BlackBoxRunnerExpandedPlan & JsonRecord;

    return toResult({
        ...parsed.value,
        kind: rawPlan.kind === 'black-box-runner.reduced-plan'
            ? rawPlan.kind
            : undefined,
        reduction: isRecord(rawPlan.reduction) ? rawPlan.reduction : undefined,
    } satisfies BlackBoxRunnerReducedPlan, parsed.issues);
}

export function parseBlackBoxRunnerMatrixSummary(
    text: string,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerMatrixSummary> {
    const parsed = parseJson(text, 'matrix-summary.json');
    const issues = [...parsed.issues];
    const record = requireRecord(parsed.value, 'matrix-summary.json', '$', issues);
    if (!record) {
        return toResult(undefined, issues);
    }

    const generatedAtEpochMs = requireNumber(record, 'generatedAtEpochMs', 'matrix-summary.json', '$', issues);
    const profile = requireString(record, 'profile', 'matrix-summary.json', '$', issues);
    const runs = requireArray(record, 'runs', 'matrix-summary.json', '$', issues);
    const summary = requireRecord(record.summary, 'matrix-summary.json', '$.summary', issues);
    if (summary) {
        requireNumber(summary, 'PASSED', 'matrix-summary.json', '$.summary', issues);
        requireNumber(summary, 'FAILED', 'matrix-summary.json', '$.summary', issues);
        requireNumber(summary, 'SKIPPED', 'matrix-summary.json', '$.summary', issues);
    }
    validateRedactionPlaceholders(record, 'matrix-summary.json', issues);

    const value = generatedAtEpochMs !== undefined && profile && runs && summary
        ? {
            ...record,
            generatedAtEpochMs,
            profile,
            requireGates: record.requireGates === true,
            runs: runs.filter(isMatrixRun),
            summary: {
                ...summary,
                PASSED: Number(summary.PASSED),
                FAILED: Number(summary.FAILED),
                SKIPPED: Number(summary.SKIPPED),
            },
        } satisfies BlackBoxRunnerMatrixSummary
        : undefined;

    return toResult(value, issues);
}

function isMatrixRun(value: unknown): value is BlackBoxRunnerMatrixRun {
    const record = asRecord(value);
    return typeof record.id === 'string' &&
        typeof record.recipe === 'string' &&
        ['PASSED', 'FAILED', 'SKIPPED'].includes(String(record.status));
}

export function parseBlackBoxRunnerArtifactBundle(
    files: BlackBoxRunnerArtifactBundleFiles,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerParsedArtifactBundle> {
    const issues: BlackBoxRunnerArtifactValidationIssue[] = [];

    BLACK_BOX_RUNNER_ARTIFACT_BUNDLE_CONTRACT.requiredFiles.forEach(file => {
        if (typeof files[file] !== 'string') {
            addError(issues, file, '$', `Missing required artifact file ${file}.`);
        }
    });

    const report = files['report.json'] !== undefined
        ? parseBlackBoxRunnerReport(files['report.json'])
        : undefined;
    const events = files['events.jsonl'] !== undefined
        ? parseBlackBoxRunnerEventsJsonl(files['events.jsonl'])
        : undefined;
    const failures = files['failures.json'] !== undefined
        ? parseBlackBoxRunnerFailures(files['failures.json'])
        : undefined;
    const metadata = files['metadata.json'] !== undefined
        ? parseBlackBoxRunnerMetadata(files['metadata.json'])
        : undefined;
    const artifactIndex = files['artifact-index.json'] !== undefined
        ? parseBlackBoxRunnerArtifactIndex(files['artifact-index.json'])
        : undefined;
    const expandedRecipe = files['expanded-recipe.json'] !== undefined
        ? parseBlackBoxRunnerExpandedRecipe(files['expanded-recipe.json'])
        : undefined;
    const preflightReport = files['preflight-report.json'] !== undefined
        ? parseBlackBoxRunnerLivePreflightReport(files['preflight-report.json'])
        : undefined;
    const expandedPlan = files['expanded-plan.json'] !== undefined
        ? parseBlackBoxRunnerExpandedPlan(files['expanded-plan.json'])
        : undefined;
    const reducedPlan = files['reduced-plan.json'] !== undefined
        ? parseBlackBoxRunnerReducedPlan(files['reduced-plan.json'])
        : undefined;
    const matrixSummary = files['matrix-summary.json'] !== undefined
        ? parseBlackBoxRunnerMatrixSummary(files['matrix-summary.json'])
        : undefined;

    [
        report,
        events,
        failures,
        metadata,
        artifactIndex,
        expandedRecipe,
        preflightReport,
        expandedPlan,
        reducedPlan,
        matrixSummary,
    ].forEach(result => {
        if (result) {
            issues.push(...result.issues);
        }
    });

    if (!report?.value || !events?.value || !failures?.value || !metadata?.value) {
        return toResult(undefined, issues);
    }

    const schemaVersion = validateSchemaVersion(
        reportSchemaVersion(report.value, metadata.value),
        BLACK_BOX_RUNNER_SUPPORTED_ARTIFACT_SCHEMA_VERSIONS,
        BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION,
        'metadata.json',
        issues,
    ) as BlackBoxRunnerArtifactSchemaVersion;

    const views: BlackBoxRunnerArtifactViews = {
        eventStream: events.value,
        postRunAssertions: events.value.filter(event => event.kind === 'post-run-assertion'),
        rtcDiagnostics: events.value.filter(event => event.kind === 'rtc-diagnostic'),
        rtcMessages: events.value.filter(event => event.kind === 'rtc-message'),
        wsMessages: events.value.filter(event => event.kind === 'ws-message'),
        failures: failures.value.failures,
        ...(artifactIndex?.value ? { artifactIndex: artifactIndex.value } : {}),
        ...(expandedRecipe?.value ? { expandedRecipe: expandedRecipe.value } : {}),
        ...(expandedPlan?.value?.replayRecipe ? { replayRecipe: expandedPlan.value.replayRecipe } : {}),
        ...(reducedPlan?.value ? { reducedPlan: reducedPlan.value } : {}),
        ...(reducedPlan?.value?.replayRecipe ? { reducedReplayRecipe: reducedPlan.value.replayRecipe } : {}),
    };

    const value: BlackBoxRunnerParsedArtifactBundle = {
        schemaVersion,
        report: report.value,
        events: events.value,
        failures: failures.value,
        metadata: metadata.value,
        ...(artifactIndex?.value ? { artifactIndex: artifactIndex.value } : {}),
        ...(expandedRecipe?.value ? { expandedRecipe: expandedRecipe.value } : {}),
        ...(preflightReport?.value ? { preflightReport: preflightReport.value } : {}),
        ...(expandedPlan?.value ? { expandedPlan: expandedPlan.value } : {}),
        ...(reducedPlan?.value ? { reducedPlan: reducedPlan.value } : {}),
        ...(matrixSummary?.value ? { matrixSummary: matrixSummary.value } : {}),
        views,
        compatibility: {
            sourceSchemaVersion: schemaVersion,
            currentSchemaVersion: BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION,
            legacy: schemaVersion < BLACK_BOX_RUNNER_ARTIFACT_SCHEMA_VERSION,
        },
    };

    return toResult(value, issues);
}

function titleFromId(id: string): string {
    return id
        .split(/[-_]/g)
        .filter(Boolean)
        .map(part => part.slice(0, 1).toUpperCase() + part.slice(1))
        .join(' ');
}

function providerMode(value: unknown): BlackBoxRunnerProviderMode {
    const allowed: readonly BlackBoxRunnerProviderMode[] = [
        'rallar-memory',
        'rallar-server',
        'rallar-browser',
        'rallar-remote-browser',
        'rallar-signaling',
        'dry-run',
        'mixed',
        'unknown',
    ];

    return allowed.includes(value as BlackBoxRunnerProviderMode)
        ? value as BlackBoxRunnerProviderMode
        : 'unknown';
}

function executionMode(value: unknown): BlackBoxRunnerExecutionMode {
    return value === 'dry-run' ? 'dry-run' : 'run';
}

function expectedResult(value: unknown): BlackBoxRunnerExpectedResult {
    return value === 'expected-failure' ? 'expected-failure' : 'pass';
}

function liveSupport(value: unknown, profiles: readonly string[], mode: BlackBoxRunnerExecutionMode): BlackBoxRunnerLiveSupport {
    if (value === 'offline' || value === 'dry-run-only' || value === 'gated-live') {
        return value;
    }

    if (profiles.includes('live') || profiles.some(profile => profile.endsWith('-live'))) {
        return 'gated-live';
    }

    return mode === 'dry-run' ? 'dry-run-only' : 'offline';
}

function defaultCommands(recipePath: string, mode: BlackBoxRunnerExecutionMode): BlackBoxRunnerRecipeCatalogEntry['commands'] {
    return [
        {
            label: 'Direct scenario',
            command: [
                'deno run -A packages/shared-test/black-box-runner/scenario-black-box.ts',
                `-c packages/shared-test/black-box-runner/${recipePath}`,
                mode === 'dry-run' ? '--dry-run' : '',
            ].filter(Boolean).join(' '),
            description: 'Runs this recipe with the scenario CLI.',
        },
    ];
}

export function validateBlackBoxRunnerRecipeCatalogEntryFixture(
    value: unknown,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerRecipeCatalogEntryFixture> {
    const issues: BlackBoxRunnerArtifactValidationIssue[] = [];
    const root = requireRecord(value, 'recipe-catalog', '$', issues);
    if (!root) {
        return toResult(undefined, issues);
    }

    const explicitVersion = root.schemaVersion;
    const schemaVersion = validateSchemaVersion(
        explicitVersion,
        BLACK_BOX_RUNNER_SUPPORTED_RECIPE_CATALOG_SCHEMA_VERSIONS,
        BLACK_BOX_RUNNER_RECIPE_CATALOG_SCHEMA_VERSION,
        'recipe-catalog',
        issues,
    ) as BlackBoxRunnerRecipeCatalogSchemaVersion;
    const entryRecord = isRecord(root.entry) ? root.entry : root;

    const id = requireString(entryRecord, 'id', 'recipe-catalog', '$.entry', issues);
    const recipePath = stringValue(entryRecord.recipePath) ?? stringValue(entryRecord.recipe);
    if (!recipePath) {
        addError(issues, 'recipe-catalog', '$.entry.recipePath', 'Expected recipePath or legacy recipe.');
    }

    const mode = executionMode(entryRecord.executionMode ?? entryRecord.mode);
    const profiles = stringList(entryRecord.profiles);
    if (profiles.length <= 0) {
        addError(issues, 'recipe-catalog', '$.entry.profiles', 'Expected at least one profile.');
    }

    const live = liveSupport(entryRecord.liveSupport, profiles, mode);
    const support = asRecord(entryRecord.support);
    const prerequisites = asRecord(entryRecord.prerequisites);
    const uiHints = asRecord(entryRecord.uiHints);
    const normalizedEntry = id && recipePath && profiles.length > 0
        ? {
            id,
            title: stringValue(entryRecord.title) ?? titleFromId(id),
            description: stringValue(entryRecord.description) ?? titleFromId(id),
            recipePath,
            category: stringValue(entryRecord.category) ?? 'unknown',
            providerMode: providerMode(entryRecord.providerMode),
            executionMode: mode,
            expectedResult: expectedResult(entryRecord.expectedResult),
            liveSupport: live,
            profiles,
            artifactName: stringValue(entryRecord.artifactName) ?? id,
            prerequisites: {
                requiredEnvVars: stringList(prerequisites.requiredEnvVars),
                httpServices: Array.isArray(prerequisites.httpServices)
                    ? prerequisites.httpServices.filter(isRecord).map(service => ({
                        name: stringValue(service.name) ?? 'HTTP service',
                        env: stringValue(service.env) ?? '',
                        ...(stringValue(service.default) ? { default: stringValue(service.default) } : {}),
                    })).filter(service => service.env.length > 0)
                    : [],
                requiresPlaywright: prerequisites.requiresPlaywright === true,
                injectedEnv: asRecord(prerequisites.injectedEnv) as Record<string, string>,
            },
            support: {
                deterministic: support.deterministic === true || profiles.includes('deterministic'),
                dryRun: support.dryRun === true || mode === 'dry-run' || profiles.includes('dry'),
                live: support.live === true || live === 'gated-live',
                remoteBrowser: support.remoteBrowser === true ||
                    entryRecord.providerMode === 'rallar-remote-browser',
                artifacts: support.artifacts !== false,
                replayArtifacts: support.replayArtifacts === true ||
                    profiles.includes('traffic') ||
                    id.includes('traffic'),
            },
            commands: Array.isArray(entryRecord.commands)
                ? entryRecord.commands.filter(isRecord).map(command => ({
                    label: stringValue(command.label) ?? 'Command',
                    command: stringValue(command.command) ?? '',
                    description: stringValue(command.description) ?? '',
                })).filter(command => command.command.length > 0)
                : defaultCommands(recipePath, mode),
            uiHints: {
                badges: stringList(uiHints.badges).length > 0
                    ? stringList(uiHints.badges)
                    : [mode, ...profiles],
                recommendedSurface: uiHints.recommendedSurface === 'artifact-browser' ||
                    uiHints.recommendedSurface === 'live-runbook'
                    ? uiHints.recommendedSurface
                    : live === 'gated-live'
                    ? 'live-runbook'
                    : 'recipe-catalog',
            },
        } satisfies BlackBoxRunnerRecipeCatalogEntry
        : undefined;

    if (schemaVersion === 0) {
        addWarning(
            issues,
            'recipe-catalog',
            '$.schemaVersion',
            'Legacy catalog entry was normalized to the current command-center entry shape.',
        );
    }

    const fixture = normalizedEntry
        ? {
            schemaVersion,
            kind: 'black-box-runner.recipe-catalog-entry',
            entry: normalizedEntry,
        } satisfies BlackBoxRunnerRecipeCatalogEntryFixture
        : undefined;

    return toResult(fixture, issues);
}

export function validateBlackBoxRunnerRecipeCatalog(
    value: unknown,
): BlackBoxRunnerArtifactValidationResult<BlackBoxRunnerRecipeCatalog> {
    const issues: BlackBoxRunnerArtifactValidationIssue[] = [];
    const root = requireRecord(value, 'recipe-catalog', '$', issues);
    if (!root) {
        return toResult(undefined, issues);
    }

    const version = requireNumber(root, 'version', 'recipe-catalog', '$', issues);
    const entries = requireArray(root, 'entries', 'recipe-catalog', '$', issues);
    if (!entries || version === undefined) {
        return toResult(undefined, issues);
    }

    const normalizedEntries = entries.flatMap((entry, index) => {
        const result = validateBlackBoxRunnerRecipeCatalogEntryFixture({
            schemaVersion: version,
            kind: 'black-box-runner.recipe-catalog-entry',
            entry,
        });
        issues.push(...result.issues.map(item => ({
            ...item,
            path: item.path.replace('$.entry', `$.entries[${index}]`),
        })));
        return result.value ? [result.value.entry] : [];
    });

    const catalog = {
        version,
        generatedFrom: root.generatedFrom === 'recipe-matrix' ? 'recipe-matrix' : 'static-fixture',
        entries: normalizedEntries,
    } satisfies BlackBoxRunnerRecipeCatalog;

    return toResult(catalog, issues);
}
