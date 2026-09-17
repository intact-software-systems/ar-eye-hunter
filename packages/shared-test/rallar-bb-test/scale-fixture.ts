import type { DistributedRunArtifactFiles } from './distributed-artifact-analysis.ts';
import type { RallarBlackBoxDistributedRunManifest } from './distributed-run.ts';

export const RECIPE_CONSOLE_SCALE_DEFAULT_EVENT_COUNT = 12_000;
export const RECIPE_CONSOLE_SCALE_DEFAULT_RESULT_COUNT = 3_000;
// The canonical 15k fixture measures 5,338,306 bytes. At this ceiling the
// result-heavy stream measures 16,319,143 bytes, retaining headroom
// below the browser's 16 MiB per-file intake limit.
export const RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT = 40_000;
export const RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
export const RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES = 48 * 1_024 * 1_024;

export interface RecipeConsoleScaleFixtureOptions {
    /** Split 80/20 between events and results. Cannot be combined with explicit counts. */
    readonly artifactRowCount?: number;
    readonly eventCount?: number;
    readonly resultCount?: number;
}

export interface RecipeConsoleScaleFixture {
    readonly files: DistributedRunArtifactFiles;
    readonly generatedAtEpochMs: number;
    readonly artifactSchemaVersion: number;
    readonly counts: RecipeConsoleScaleFixtureCounts;
    readonly bytes: RecipeConsoleScaleFixtureBytes;
    readonly needles: RecipeConsoleScaleFixtureNeedles;
}

export interface RecipeConsoleScaleFixtureCounts {
    readonly events: number;
    readonly results: number;
    readonly sourceRows: number;
}

export interface RecipeConsoleScaleFixtureBytes {
    readonly byFile: Readonly<Record<string, number>>;
    readonly total: number;
}

export interface RecipeConsoleScaleFixtureNeedles {
    readonly events: Readonly<Record<ScalePosition, string>>;
    readonly results: Readonly<Record<ScalePosition, string>>;
    readonly actionableFailure: string;
    readonly actionableDiagnostic: string;
}

type ScalePosition = 'first' | 'middle' | 'last';
type ScaleArtifactRow = Readonly<Record<string, unknown>>;

interface ScaleCounts {
    readonly events: number;
    readonly results: number;
}

interface ScaleSourceStream {
    readonly positions: Readonly<Record<ScalePosition, number>>;
    readonly needles: Readonly<Record<ScalePosition, string>>;
}

interface ScaleFixturePlan {
    readonly counts: ScaleCounts;
    readonly events: ScaleSourceStream;
    readonly results: ScaleSourceStream;
}

const ARTIFACT_SCHEMA_VERSION = 2;
const DISTRIBUTED_RUN_ID = 'recipe-console-scale-distributed-run';
const CONTROL_RUN_ID = 'recipe-console-scale-control-run';
const RECIPE_ID = 'recipe-console-scale-recipe';
const AGENT_ID = 'scale-agent-001';
const GENERATED_AT_EPOCH_MS = 1_735_732_800_000;
const STARTED_AT_EPOCH_MS = GENERATED_AT_EPOCH_MS - 60_000;
const ACTIONABLE_FAILURE = 'recipe-console-scale-actionable-failure';
const ACTIONABLE_DIAGNOSTIC = 'recipe-console-scale-actionable-diagnostic';
const SCALE_POSITIONS: readonly ScalePosition[] = ['first', 'middle', 'last'];

/**
 * Creates deterministic distributed-run evidence for scale and profiling tests.
 * The returned metadata describes the source JSONL rows and UTF-8 file bytes.
 */
export function createRecipeConsoleScaleFixture(
    options: RecipeConsoleScaleFixtureOptions = {}
): RecipeConsoleScaleFixture {
    const counts = resolveScaleCounts(options);
    const plan: ScaleFixturePlan = {
        counts,
        events: toScaleSourceStream('event', counts.events),
        results: toScaleSourceStream('result', counts.results)
    };
    const files = toScaleArtifactFiles(plan);
    const bytes = computeScaleArtifactBytes(files);
    assertBrowserIntakeLimits(bytes);

    return {
        files,
        generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        counts: {
            events: counts.events,
            results: counts.results,
            sourceRows: counts.events + counts.results
        },
        bytes,
        needles: {
            events: plan.events.needles,
            results: plan.results.needles,
            actionableFailure: ACTIONABLE_FAILURE,
            actionableDiagnostic: ACTIONABLE_DIAGNOSTIC
        }
    };
}

function resolveScaleCounts(options: RecipeConsoleScaleFixtureOptions): ScaleCounts {
    if (options.artifactRowCount !== undefined) {
        return resolveScaleCountsFromTotal(options);
    }
    const events = options.eventCount ?? RECIPE_CONSOLE_SCALE_DEFAULT_EVENT_COUNT;
    const results = options.resultCount ?? RECIPE_CONSOLE_SCALE_DEFAULT_RESULT_COUNT;
    assertValidCount(events, 'eventCount', 3);
    assertValidCount(results, 'resultCount', 3);
    if (events > RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT - results) {
        throw new Error(
            `eventCount and resultCount must not exceed ${RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT} source rows in total.`
        );
    }
    return { events, results };
}

function resolveScaleCountsFromTotal(options: RecipeConsoleScaleFixtureOptions): ScaleCounts {
    const sourceRows = options.artifactRowCount ?? 0;
    if (options.eventCount !== undefined || options.resultCount !== undefined) {
        throw new Error('artifactRowCount cannot be combined with eventCount or resultCount.');
    }
    assertValidCount(sourceRows, 'artifactRowCount', 6);
    if (sourceRows > RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT) {
        throw new Error(
            `artifactRowCount must not exceed ${RECIPE_CONSOLE_SCALE_MAX_ARTIFACT_ROW_COUNT} source rows.`
        );
    }
    const results = Math.max(3, Math.round(sourceRows / 5));
    return { events: sourceRows - results, results };
}

function toScaleArtifactFiles(plan: ScaleFixturePlan): DistributedRunArtifactFiles {
    const manifest = toScaleManifest();
    const summary = toScaleArtifactSummary(plan.counts);
    return {
        'distributed-run.json': JSON.stringify(toScaleDistributedRun(manifest, plan.counts)),
        'manifest.json': JSON.stringify(manifest),
        'control-run.json': JSON.stringify(toScaleControlRun(plan.counts)),
        'report.json': JSON.stringify(toScaleReport(summary)),
        'results.jsonl': toJsonLines(plan.counts.results, (index) => toScaleResultRow(index, plan.results)),
        'events.jsonl': toJsonLines(plan.counts.events, (index) => toScaleEventRow(index, plan)),
        'failures.json': JSON.stringify(toScaleFailures(summary)),
        'metadata.json': JSON.stringify(toScaleMetadata(summary))
    };
}

function toJsonLines(count: number, toRow: (index: number) => ScaleArtifactRow): string {
    return Array.from({ length: count }, (_, index) => JSON.stringify(toRow(index))).join('\n');
}

function computeScaleArtifactBytes(files: DistributedRunArtifactFiles): RecipeConsoleScaleFixtureBytes {
    const encoder = new TextEncoder();
    const byFile = Object.fromEntries(
        Object.entries(files).flatMap(([fileName, text]) =>
            text === undefined ? [] : [[fileName, encoder.encode(text).byteLength]]
        )
    );
    const total = Object.values(byFile).reduce((sum, bytes) => sum + bytes, 0);
    return { byFile, total };
}

function assertBrowserIntakeLimits(bytes: RecipeConsoleScaleFixtureBytes): void {
    const oversizedFile = Object.entries(bytes.byFile).find(
        ([, fileBytes]) => fileBytes > RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES
    );
    if (oversizedFile) {
        throw new Error(
            `${oversizedFile[0]} exceeds the ${RECIPE_CONSOLE_SCALE_MAX_FILE_BYTES}-byte browser file limit.`
        );
    }
    if (bytes.total > RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES) {
        throw new Error(
            `Scale fixture exceeds the ${RECIPE_CONSOLE_SCALE_MAX_TOTAL_BYTES}-byte browser intake limit.`
        );
    }
}

function assertValidCount(value: number, label: string, minimum: number): void {
    if (!Number.isSafeInteger(value) || value < minimum) {
        throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
    }
}

function toScaleSourceStream(kind: 'event' | 'result', count: number): ScaleSourceStream {
    const positions = { first: 0, middle: Math.floor(count / 2), last: count - 1 };
    return {
        positions,
        needles: {
            first: `recipe-console-scale-${kind}-first-${toPaddedIndex(positions.first)}`,
            middle: `recipe-console-scale-${kind}-middle-${toPaddedIndex(positions.middle)}`,
            last: `recipe-console-scale-${kind}-last-${toPaddedIndex(positions.last)}`
        }
    };
}

function resolveNeedle(index: number, stream: ScaleSourceStream): string | undefined {
    const position = SCALE_POSITIONS.find((candidate) => stream.positions[candidate] === index);
    return position === undefined ? undefined : stream.needles[position];
}

function toScaleManifest(): RallarBlackBoxDistributedRunManifest {
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
                schemaVersion: 1,
                recipeId: RECIPE_ID,
                commands: []
            },
            required: true,
            variables: {}
        }],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: 1,
            agentIds: [AGENT_ID]
        },
        variables: {},
        roleAssignments: [{ agentId: AGENT_ID, role: 'worker', required: true, recipeIds: [], variables: {} }],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: [],
        metadata: {}
    };
}

function toScaleDistributedRun(manifest: RallarBlackBoxDistributedRunManifest, counts: ScaleCounts): ScaleArtifactRow {
    return {
        distributedRunId: DISTRIBUTED_RUN_ID,
        controlRunId: CONTROL_RUN_ID,
        state: 'failed',
        createdAtEpochMs: STARTED_AT_EPOCH_MS - 1_000,
        updatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        startedAtEpochMs: STARTED_AT_EPOCH_MS,
        completedAtEpochMs: GENERATED_AT_EPOCH_MS,
        targetAgentIds: [AGENT_ID],
        commandLinks: Array.from({ length: counts.results }, (_, index) => ({
            phase: 'start',
            agentId: AGENT_ID,
            commandId: toScaleCommandId(index),
            recipeId: RECIPE_ID,
            queuedAtEpochMs: toScaleResultStartedAtEpochMs(index)
        })),
        manifest,
        rollup: {
            state: 'failed',
            ok: false,
            failures: [{
                kind: 'participant',
                key: AGENT_ID,
                state: 'failed',
                required: true,
                error: {
                    code: 'SCALE_UPSTREAM_UNAVAILABLE',
                    message: 'Scale fixture upstream returned 503.'
                }
            }],
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: 1,
                passedParticipants: 0,
                failedParticipants: 1,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 0,
                failedRecipes: 1,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 1
            }
        }
    };
}

function toScaleControlRun(counts: ScaleCounts): ScaleArtifactRow {
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

function toScaleArtifactSummary(counts: ScaleCounts): Readonly<Record<string, number>> {
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

function toScaleReport(summary: Readonly<Record<string, number>>): ScaleArtifactRow {
    return {
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
    };
}

function toScaleFailures(summary: Readonly<Record<string, number>>): ScaleArtifactRow {
    return {
        summary,
        failures: [{
            source: 'results.jsonl',
            agentId: AGENT_ID,
            commandId: toScaleCommandId(0),
            error: {
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: 'Scale fixture upstream returned 503.'
            }
        }],
        outputs: {}
    };
}

function toScaleMetadata(summary: Readonly<Record<string, number>>): ScaleArtifactRow {
    return {
        schemaVersion: ARTIFACT_SCHEMA_VERSION,
        artifactSchemaVersion: ARTIFACT_SCHEMA_VERSION,
        generatedAtEpochMs: GENERATED_AT_EPOCH_MS,
        config: 'rallar-black-box-control-server',
        execution: 'distributed-run',
        distributedRunId: DISTRIBUTED_RUN_ID,
        controlRunId: CONTROL_RUN_ID,
        summary
    };
}

function toScaleResultRow(index: number, results: ScaleSourceStream): ScaleArtifactRow {
    const failed = index === 0;
    const startedAtEpochMs = toScaleResultStartedAtEpochMs(index);
    return {
        resultKey: `${AGENT_ID}:${toScaleCommandId(index)}`,
        commandId: toScaleCommandId(index),
        recipeId: RECIPE_ID,
        agentId: AGENT_ID,
        action: 'http.request',
        status: failed ? 'FAILURE' : 'SUCCESS',
        ok: !failed,
        result: {
            commandId: toScaleCommandId(index),
            kind: 'http.request',
            status: failed ? 'failed' : 'ok',
            ok: !failed,
            startedAtEpochMs,
            endedAtEpochMs: startedAtEpochMs + 3,
            durationMs: 3,
            value: {
                statusCode: failed ? 503 : 200,
                needle: resolveNeedle(index, results)
            }
        },
        actual: failed
            ? {
                code: 'SCALE_UPSTREAM_UNAVAILABLE',
                message: `Expected HTTP 200 but received 503. ${ACTIONABLE_FAILURE}`,
                details: { retryable: true, minimalFixArea: 'scale fixture upstream' }
            }
            : undefined
    };
}

function toScaleEventRow(index: number, plan: ScaleFixturePlan): ScaleArtifactRow {
    const diagnostic = index === plan.events.positions.middle;
    const needle = resolveNeedle(index, plan.events);
    return {
        kind: diagnostic ? 'diagnostic' : 'event',
        eventId: `scale-event-${toPaddedIndex(index)}`,
        runId: CONTROL_RUN_ID,
        agentId: AGENT_ID,
        commandId: toScaleCommandId(index % plan.counts.results),
        atEpochMs: STARTED_AT_EPOCH_MS + index * 5,
        topic: diagnostic ? 'rallar.bb.scale.upstream_unavailable' : 'rallar.bb.scale.progress',
        transport: 'http',
        value: diagnostic
            ? {
                severity: 'error',
                diagnosticSchemaVersion: 1,
                diagnosticTypeId: 'rallar.bb.scale.upstream_unavailable',
                message: `Synthetic diagnostic for scale analysis. ${ACTIONABLE_DIAGNOSTIC}`,
                needle
            }
            : {
                severity: 'info',
                message: `Synthetic scale event ${toPaddedIndex(index)}.`,
                needle
            }
    };
}

function toScaleResultStartedAtEpochMs(index: number): number {
    return STARTED_AT_EPOCH_MS + index * 4;
}

function toScaleCommandId(index: number): string {
    return `scale-command-${toPaddedIndex(index)}`;
}

function toPaddedIndex(index: number): string {
    return String(index).padStart(6, '0');
}
