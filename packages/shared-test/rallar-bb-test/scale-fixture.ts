import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';

export const RECIPE_CONSOLE_SCALE_DEFAULT_EVENT_COUNT = 12_000;
export const RECIPE_CONSOLE_SCALE_DEFAULT_RESULT_COUNT = 3_000;
// The canonical 15k fixture measures 4,753,103 bytes. At this ceiling the
// result-heavy stream measures 14,679,261 bytes, retaining headroom
// below the browser's 16 MiB per-file intake limit.
export const RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT = 40_000;
export const RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
export const RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES = 48 * 1_024 * 1_024;

const ARTIFACT_SCHEMA_VERSION = 2;
const DISTRIBUTED_RUN_ID = 'recipe-console-scale-distributed-run';
const CONTROL_RUN_ID = 'recipe-console-scale-control-run';
const RECIPE_ID = 'recipe-console-scale-recipe';
const AGENT_ID = 'scale-agent-001';
const GENERATED_AT_EPOCH_MS = 1_735_732_800_000;
const STARTED_AT_EPOCH_MS = GENERATED_AT_EPOCH_MS - 60_000;

export type RecipeConsoleScaleFixtureOptions = Readonly<{
    /** Split 80/20 between events and results. Cannot be combined with explicit counts. */
    artifactRowCount?: number;
    eventCount?: number;
    resultCount?: number;
}>;

export type RecipeConsoleScaleFixture = Readonly<{
    files: DistributedRunArtifactFiles;
    generatedAtEpochMs: number;
    artifactSchemaVersion: number;
    counts: Readonly<{
        events: number;
        results: number;
        sourceRows: number;
    }>;
    bytes: Readonly<{
        byFile: Readonly<Record<string, number>>;
        total: number;
    }>;
    needles: Readonly<{
        events: Readonly<{ first: string; middle: string; last: string; }>;
        results: Readonly<{ first: string; middle: string; last: string; }>;
        actionableFailure: string;
        actionableDiagnostic: string;
    }>;
}>;

type ScaleCounts = Readonly<{ events: number; results: number; }>;
type Position = 'first' | 'middle' | 'last';

/**
 * Creates deterministic distributed-run evidence for scale and profiling tests.
 * The returned metadata describes the source JSONL rows and UTF-8 file bytes.
 */
export function createRecipeConsoleScaleFixture(
    options: RecipeConsoleScaleFixtureOptions = {}
): RecipeConsoleScaleFixture {
    const counts = resolveCounts(options);
    const eventPositions = positions(counts.events);
    const resultPositions = positions(counts.results);
    const eventNeedles = positionNeedles('event', eventPositions);
    const resultNeedles = positionNeedles('result', resultPositions);
    const actionableFailure = 'recipe-console-scale-actionable-failure';
    const actionableDiagnostic = 'recipe-console-scale-actionable-diagnostic';
    const manifest = distributedManifest();
    const summary = artifactSummary(counts);

    const results = Array.from({ length: counts.results }, (_, index) =>
        JSON.stringify(
            resultRow(index, resultPositions, resultNeedles, actionableFailure)
        )).join('\n');
    const events = Array.from({ length: counts.events }, (_, index) =>
        JSON.stringify(
            eventRow(index, counts.results, eventPositions, eventNeedles, actionableDiagnostic)
        )).join('\n');

    const files: DistributedRunArtifactFiles = {
        'distributed-run.json': JSON.stringify(distributedRun(manifest)),
        'manifest.json': JSON.stringify(manifest),
        'control-run.json': JSON.stringify(controlRun(counts)),
        'report.json': JSON.stringify({
            schemaVersion: ARTIFACT_SCHEMA_VERSION,
            artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
            execution: 'distributed-run',
            distributedRunId: DISTRIBUTED_RUN_ID,
            controlRunId: CONTROL_RUN_ID,
            state: 'failed',
            ok: false,
            summary,
            resultsList: [],
            outputs: {}
        }),
        'results.jsonl': results,
        'events.jsonl': events,
        'failures.json': JSON.stringify({
            summary,
            failures: [{
                source: 'results.jsonl',
                agentId: AGENT_ID,
                commandId: commandId(0),
                error: {
                    code: 'SCALE_UPSTREAM_UNAVAILABLE',
                    message: 'Scale fixture upstream returned 503.'
                }
            }],
            outputs: {}
        }),
        'metadata.json': JSON.stringify({
            schemaVersion: ARTIFACT_SCHEMA_VERSION,
            artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
            generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
            config: 'rallar-black-box-control-server',
            execution: 'distributed-run',
            distributedRunId: DISTRIBUTED_RUN_ID,
            controlRunId: CONTROL_RUN_ID,
            summary
        })
    };

    const bytesByFile = Object.fromEntries(
        Object.entries(files).flatMap(([fileName, text]) =>
            text === undefined ? [] : [[fileName, new TextEncoder().encode(text).byteLength]]
        )
    );
    const totalBytes = Object.values(bytesByFile).reduce(
        (total, bytes) => total + bytes,
        0
    );
    assertBrowserIntakeLimits(bytesByFile, totalBytes);

    return {
        files,
        generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        counts: {
            events: counts.events,
            results: counts.results,
            sourceRows: counts.events + counts.results
        },
        bytes: {
            byFile: bytesByFile,
            total: totalBytes
        },
        needles: {
            events: eventNeedles,
            results: resultNeedles,
            actionableFailure,
            actionableDiagnostic
        }
    };
}

function resolveCounts(options: RecipeConsoleScaleFixtureOptions): ScaleCounts {
    if (options.artifactRowCount !== undefined) {
        if (options.eventCount !== undefined || options.resultCount !== undefined) {
            throw new Error('artifactRowCount cannot be combined with eventCount or resultCount.');
        }
        const sourceRows = validCount(options.artifactRowCount, 'artifactRowCount', 6);
        if (sourceRows > RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT) {
            throw new Error(
                `artifactRowCount must not exceed ${RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT} source rows.`
            );
        }
        const results = Math.max(3, Math.round(sourceRows / 5));
        return { events: sourceRows - results, results };
    }
    const events = validCount(
        options.eventCount ?? RECIPE_CONSOLE_SCALE_DEFAULT_EVENT_COUNT,
        'eventCount',
        3
    );
    const results = validCount(
        options.resultCount ?? RECIPE_CONSOLE_SCALE_DEFAULT_RESULT_COUNT,
        'resultCount',
        3
    );
    if (events > RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT - results) {
        throw new Error(
            `eventCount and resultCount must not exceed ${RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT} source rows in total.`
        );
    }
    return { events, results };
}

function assertBrowserIntakeLimits(
    bytesByFile: Readonly<Record<string, number>>,
    totalBytes: number
): void {
    const oversizedFile = Object.entries(bytesByFile).find(
        ([, bytes]) => bytes > RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES
    );
    if (oversizedFile) {
        throw new Error(
            `${oversizedFile[0]} exceeds the ${RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES}-byte browser file limit.`
        );
    }
    if (totalBytes > RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES) {
        throw new Error(
            `Scale fixture exceeds the ${RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES}-byte browser intake limit.`
        );
    }
}

function validCount(value: number, label: string, minimum: number): number {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
    }
    return value;
}

function positions(count: number): Readonly<Record<Position, number>> {
    return { first: 0, middle: Math.floor(count / 2), last: count - 1 };
}

function positionNeedles(
    kind: 'event' | 'result',
    sourcePositions: Readonly<Record<Position, number>>
): Readonly<Record<Position, string>> {
    return {
        first: `recipe-console-scale-${kind}-first-${padded(sourcePositions.first)}`,
        middle: `recipe-console-scale-${kind}-middle-${padded(sourcePositions.middle)}`,
        last: `recipe-console-scale-${kind}-last-${padded(sourcePositions.last)}`
    };
}

function needleAt(
    index: number,
    sourcePositions: Readonly<Record<Position, number>>,
    needles: Readonly<Record<Position, string>>
): string | undefined {
    for (const position of ['first', 'middle', 'last'] as const) {
        if (sourcePositions[position] === index) {
            return needles[position];
        }
    }
    return undefined;
}

function distributedManifest(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        distributedRunId: DISTRIBUTED_RUN_ID,
        controlRunId: CONTROL_RUN_ID,
        displayName: 'Recipe Console deterministic scale fixture',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'scale-fixture',
            groupId: 'recipe-console-scale'
        },
        recipes: [{
            recipeId: RECIPE_ID,
            recipe: {
                recipeId: RECIPE_ID,
                commands: []
            }
        }],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: 1,
            agentIds: [AGENT_ID]
        },
        roleAssignments: [{ agentId: AGENT_ID, role: 'worker', required: true }],
        startMode: 'manual'
    };
}

function distributedRun(manifest: Record<string, unknown>): Record<string, unknown> {
    return {
        distributedRunId: DISTRIBUTED_RUN_ID,
        controlRunId: CONTROL_RUN_ID,
        state: 'failed',
        createdAtEpochMs: STARTED_AT_EPOCH_MS - 1_000,
        updatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        startedAtEpochMs: STARTED_AT_EPOCH_MS,
        completedAtEpochMs: GENERATED_AT_EPOCH_MS,
        targetAgentIds: [AGENT_ID],
        commandLinks: [],
        manifest,
        rollup: {
            state: 'failed',
            ok: false,
            failures: [{
                agentId: AGENT_ID,
                recipeId: RECIPE_ID,
                commandId: commandId(0),
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: 'Scale fixture upstream returned 503.'
            }],
            summary: {
                totalParticipants: 1,
                completedParticipants: 1,
                failedParticipants: 1,
                blockingFailures: 1
            }
        }
    };
}

function controlRun(counts: ScaleCounts): Record<string, unknown> {
    return {
        runId: CONTROL_RUN_ID,
        createdAtEpochMs: STARTED_AT_EPOCH_MS - 1_000,
        updatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        agents: [{
            runId: CONTROL_RUN_ID,
            agentId: AGENT_ID,
            connected: false,
            connectionSequence: 1,
            reconnectCount: 0,
            receivedResultCount: counts.results,
            receivedEventCount: counts.events,
            completedCommandIds: [],
            resumeCompletedCommandIds: []
        }],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function artifactSummary(counts: ScaleCounts): Record<string, number> {
    return {
        total: counts.results,
        success: counts.results - 1,
        failure: 1,
        commandCount: counts.results,
        eventCount: counts.events,
        agentCount: 1,
        reportCount: 0
    };
}

function resultRow(
    index: number,
    sourcePositions: Readonly<Record<Position, number>>,
    needles: Readonly<Record<Position, string>>,
    actionableFailure: string
): Record<string, unknown> {
    const failed = index === 0;
    const startedAtEpochMs = STARTED_AT_EPOCH_MS + index * 4;
    return {
        resultKey: `${AGENT_ID}:${commandId(index)}`,
        commandId: commandId(index),
        recipeId: RECIPE_ID,
        agentId: AGENT_ID,
        action: 'http.request',
        status: failed ? 'FAILURE' : 'SUCCESS',
        ok: !failed,
        startedAtEpochMs,
        endedAtEpochMs: startedAtEpochMs + 3,
        durationMs: 3,
        result: {
            kind: 'http.request',
            status: failed ? 'failed' : 'passed',
            value: {
                statusCode: failed ? 503 : 200,
                needle: needleAt(index, sourcePositions, needles)
            }
        },
        actual: failed
            ? {
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: `Expected HTTP 200 but received 503. ${actionableFailure}`,
                details: { retryable: true, minimalFixArea: 'scale fixture upstream' }
            }
            : undefined
    };
}

function eventRow(
    index: number,
    resultCount: number,
    sourcePositions: Readonly<Record<Position, number>>,
    needles: Readonly<Record<Position, string>>,
    actionableDiagnostic: string
): Record<string, unknown> {
    const diagnostic = index === sourcePositions.middle;
    const needle = needleAt(index, sourcePositions, needles);
    return {
        kind: diagnostic ? 'diagnostic' : 'event',
        eventId: `scale-event-${padded(index)}`,
        runId: CONTROL_RUN_ID,
        agentId: AGENT_ID,
        commandId: commandId(index % resultCount),
        atEpochMs: STARTED_AT_EPOCH_MS + index * 5,
        topic: diagnostic ? 'rallar.bb.scale.upstream_unavailable' : 'rallar.bb.scale.progress',
        transport: 'http',
        value: diagnostic
            ? {
                severity: 'error',
                diagnosticSchemaVersion: 1,
                diagnosticTypeId: 'rallar.bb.scale.upstream_unavailable',
                message: `Synthetic diagnostic for scale analysis. ${actionableDiagnostic}`,
                needle
            }
            : {
                severity: 'info',
                message: `Synthetic scale event ${padded(index)}.`,
                needle
            }
    };
}

function commandId(index: number): string {
    return `scale-command-${padded(index)}`;
}

function padded(index: number): string {
    return String(index).padStart(6, '0');
}
