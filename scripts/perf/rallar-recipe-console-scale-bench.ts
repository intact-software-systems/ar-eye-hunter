import { constants as fsConstants } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { createAnalyzeArtifactModel } from '../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-model.ts';
import { searchDistributedArtifactEvidence } from '../../packages/shared-test/rallar-bb-test/distributed-artifact-evidence-search.ts';
import { createRecipeConsoleScaleFixture } from '../../packages/shared-test/rallar-bb-test/scale-fixture.ts';

const DEFAULT_SIZES = [500, 2_000, 15_000] as const;
const DEFAULT_WARMUP_COUNT = 1;
const DEFAULT_RUN_COUNT = 5;
const DEFAULT_OUTPUT = 'tmp/perf/results/rallar-recipe-console-scale.json';

type CliOptions = Readonly<{
    sizes: readonly number[];
    warmupCount: number;
    runCount: number;
    outputPath: string;
}>;

type PipelineCounters = Readonly<{
    pipelinePassCount: number;
    sourceCollectionEnumerationCalls: number;
    sourceFileReadsByFile: Readonly<Record<string, number>>;
    jsonlFilePassesByFile: Readonly<Record<string, number>>;
    jsonDocumentParseCalls: number;
    nonemptyJsonlRowParseCalls: number;
    otherJsonParseCalls: number;
    totalJsonParseCalls: number;
}>;

type SearchProbe = Readonly<{
    id: string;
    sourceKind: 'event' | 'result' | 'control';
    position: 'first' | 'middle' | 'last' | 'actionable';
    baselineRole: 'known-retained-control' | 'known-omitted' | 'coverage-probe';
    query: string;
}>;

type SearchObservation = SearchProbe & Readonly<{
    retainedByCurrentIndex: boolean;
    totalMatches: number;
    returnedCount: number;
    omittedMatchCount: number;
    upstreamOmittedEntryCount: number;
    totalMatchesIsComplete: boolean;
}>;

type RunSample = Readonly<{
    run: number;
    modelDurationMs: number;
    searchDurationMs: number;
    totalDurationMs: number;
    heapBeforeBytes: number;
    heapAfterModelBytes: number;
    heapAfterSearchBytes: number;
    modelHeapDeltaBytes: number;
    searchHeapDeltaBytes: number;
    totalHeapDeltaBytes: number;
    sourceFileCount: number;
    sourceRowCount: number;
    eventCount: number;
    resultCount: number;
    fixtureBytes: number;
    indexEntryCount: number;
    indexTotalEntries: number;
    indexOmittedEntryCount: number;
    searchObservations: readonly SearchObservation[];
    pipelineCounters: PipelineCounters;
}>;

type MetricSummary = Readonly<{
    median: number;
    approximateP95: number;
    max: number;
}>;

type ParseClassifier = Readonly<{
    jsonDocuments: ReadonlySet<string>;
    jsonlRows: ReadonlySet<string>;
    jsonlFilesByContents: ReadonlyMap<string, string>;
}>;

type ScaleFixture = ReturnType<typeof createRecipeConsoleScaleFixture>;

async function main(): Promise<void> {
    const options = parseCliOptions(process.argv.slice(2));
    requireExposedGarbageCollector();

    const outputPath = resolve(options.outputPath);
    await refuseExistingOutput(outputPath);
    await mkdir(dirname(outputPath), { recursive: true });

    const sizeResults = [];
    for (const requestedSourceRows of options.sizes) {
        const fixture = createRecipeConsoleScaleFixture({
            artifactRowCount: requestedSourceRows,
        });
        const fixtureMetadata = validateAndProjectFixture(
            fixture,
            requestedSourceRows,
        );
        for (let warmup = 0; warmup < options.warmupCount; warmup += 1) {
            measurePipeline(fixture, 0);
        }

        const timedSamples: RunSample[] = [];
        for (let run = 1; run <= options.runCount; run += 1) {
            timedSamples.push(measurePipeline(fixture, run));
        }
        const parseClassifier = createParseClassifier(fixture.files);
        const pipelineCounters = collectPipelineCounters(
            fixture,
            parseClassifier,
        );
        const samples = timedSamples.map(sample => ({
            ...sample,
            pipelineCounters,
        }));

        sizeResults.push({
            requestedSourceRows,
            fixture: fixtureMetadata,
            searchMatrix: createSearchProbes(fixture),
            samples,
            summary: {
                modelDurationMs: summarize(samples.map(sample => sample.modelDurationMs)),
                searchDurationMs: summarize(samples.map(sample => sample.searchDurationMs)),
                totalDurationMs: summarize(samples.map(sample => sample.totalDurationMs)),
                modelHeapDeltaBytes: summarize(
                    samples.map(sample => sample.modelHeapDeltaBytes),
                ),
                searchHeapDeltaBytes: summarize(
                    samples.map(sample => sample.searchHeapDeltaBytes),
                ),
                totalHeapDeltaBytes: summarize(
                    samples.map(sample => sample.totalHeapDeltaBytes),
                ),
            },
        });
    }

    const git = readGitMetadata();
    const report = {
        benchmark: 'rallar-recipe-console-scale',
        schemaVersion: 1,
        advisoryOnly: true,
        createdAt: new Date().toISOString(),
        ...(git.commit || git.branch || git.dirty !== undefined ? { git } : {}),
        environment: {
            runtime: process.release.name,
            runtimeVersion: process.version,
            platform: process.platform,
            architecture: process.arch,
            execArgv: process.execArgv,
            gc: {
                exposed: typeof exposedGarbageCollector() === 'function',
                exposeGcFlagPresent: process.execArgv.includes('--expose-gc'),
                forcedBeforeEachHeapReading: true,
                heapMetric: 'process.memoryUsage().heapUsed',
            },
        },
        flags: {
            sizes: options.sizes,
            warmup: options.warmupCount,
            runs: options.runCount,
            output: options.outputPath,
            heapMeasurement:
                'forced-gc retained-heap estimate; deltas may be negative',
            parseCounterMethod:
                'one separate post-timing instrumented pass per size, copied to each sample',
            pipelineCounterSemantics:
                'one model-pipeline invocation; source enumerations, file reads, JSONL whole-file split passes, JSON document parses, and nonempty JSONL row parses are distinct',
            p95Method: 'nearest-rank-approximation; five runs report the maximum',
        },
        sizes: sizeResults,
    };

    await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
    });
    console.log(`Wrote advisory Recipe Console scale benchmark to ${outputPath}`);
}

function measurePipeline(
    fixture: ScaleFixture,
    run: number,
): RunSample {
    const heapBeforeBytes = retainedHeapBytes();
    const modelStart = performance.now();
    const model = createScaleAnalyzeModel(fixture);
    const modelDurationMs = performance.now() - modelStart;
    const heapAfterModelBytes = retainedHeapBytes();

    const searchStart = performance.now();
    const searchObservations = createSearchProbes(fixture).map(probe => {
        const result = searchDistributedArtifactEvidence(model.evidenceIndex, {
            query: probe.query,
        });
        return {
            ...probe,
            retainedByCurrentIndex: result.totalMatches > 0,
            totalMatches: result.totalMatches,
            returnedCount: result.entries.length,
            omittedMatchCount: result.omittedMatchCount,
            upstreamOmittedEntryCount: result.upstreamOmittedEntryCount,
            totalMatchesIsComplete: result.totalMatchesIsComplete,
        };
    });
    const searchDurationMs = performance.now() - searchStart;
    const heapAfterSearchBytes = retainedHeapBytes();

    const sample: RunSample = {
        run,
        modelDurationMs,
        searchDurationMs,
        totalDurationMs: modelDurationMs + searchDurationMs,
        heapBeforeBytes,
        heapAfterModelBytes,
        heapAfterSearchBytes,
        modelHeapDeltaBytes: heapAfterModelBytes - heapBeforeBytes,
        searchHeapDeltaBytes: heapAfterSearchBytes - heapAfterModelBytes,
        totalHeapDeltaBytes: heapAfterSearchBytes - heapBeforeBytes,
        sourceFileCount: Object.keys(fixture.files).length,
        sourceRowCount: fixture.counts.sourceRows,
        eventCount: fixture.counts.events,
        resultCount: fixture.counts.results,
        fixtureBytes: fixture.bytes.total,
        indexEntryCount: model.evidenceIndex.entries.length,
        indexTotalEntries: model.evidenceIndex.totalEntries,
        indexOmittedEntryCount: model.evidenceIndex.omittedEntryCount,
        searchObservations,
        pipelineCounters: emptyPipelineCounters(),
    };
    assertFiniteSample(sample);
    return sample;
}

function createSearchProbes(fixture: ScaleFixture): readonly SearchProbe[] {
    return [
        searchProbe(
            'actionable-failure-control',
            'control',
            'actionable',
            'known-retained-control',
            fixture.needles.actionableFailure,
        ),
        searchProbe(
            'actionable-diagnostic-control',
            'control',
            'actionable',
            'known-retained-control',
            fixture.needles.actionableDiagnostic,
        ),
        searchProbe(
            'events-first',
            'event',
            'first',
            'known-omitted',
            fixture.needles.events.first,
        ),
        searchProbe(
            'events-middle',
            'event',
            'middle',
            'coverage-probe',
            fixture.needles.events.middle,
        ),
        searchProbe(
            'events-last',
            'event',
            'last',
            'coverage-probe',
            fixture.needles.events.last,
        ),
        searchProbe(
            'results-first',
            'result',
            'first',
            'known-omitted',
            fixture.needles.results.first,
        ),
        searchProbe(
            'results-middle',
            'result',
            'middle',
            'coverage-probe',
            fixture.needles.results.middle,
        ),
        searchProbe(
            'results-last',
            'result',
            'last',
            'known-retained-control',
            fixture.needles.results.last,
        ),
    ];
}

function searchProbe(
    id: string,
    sourceKind: SearchProbe['sourceKind'],
    position: SearchProbe['position'],
    baselineRole: SearchProbe['baselineRole'],
    query: string,
): SearchProbe {
    return { id, sourceKind, position, baselineRole, query };
}

function createScaleAnalyzeModel(fixture: ScaleFixture) {
    return createAnalyzeArtifactModel({
        files: fixture.files,
        source: 'local-files',
        label: `Synthetic ${fixture.counts.sourceRows}-row scale artifact`,
        generatedAtEpochMs: fixture.generatedAtEpochMs,
        artifactSchemaVersion: fixture.artifactSchemaVersion,
    });
}

function collectPipelineCounters(
    fixture: ScaleFixture,
    classifier: ParseClassifier,
): PipelineCounters {
    const originalParse = JSON.parse;
    const nativeSplit = String.prototype.split;
    const originalSplit = nativeSplit as (
        this: string,
        separator?: string | RegExp,
        limit?: number,
    ) => string[];
    let jsonDocumentCalls = 0;
    let jsonlRowCalls = 0;
    let otherCalls = 0;
    let sourceCollectionEnumerationCalls = 0;
    const sourceFileReadsByFile: Record<string, number> = {};
    const jsonlFilePassesByFile: Record<string, number> = Object.fromEntries(
        [...classifier.jsonlFilesByContents.values()].map(fileName => [fileName, 0]),
    );

    const files = new Proxy(fixture.files, {
        get(target, property, receiver) {
            if (typeof property === 'string' && Object.hasOwn(target, property)) {
                sourceFileReadsByFile[property] =
                    (sourceFileReadsByFile[property] ?? 0) + 1;
            }
            return Reflect.get(target, property, receiver);
        },
        ownKeys(target) {
            sourceCollectionEnumerationCalls += 1;
            return Reflect.ownKeys(target);
        },
    });
    const instrumentedFixture = { ...fixture, files };

    JSON.parse = ((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
        if (classifier.jsonDocuments.has(text)) {
            jsonDocumentCalls += 1;
        } else if (classifier.jsonlRows.has(text)) {
            jsonlRowCalls += 1;
        } else {
            otherCalls += 1;
        }
        return originalParse(text, reviver);
    }) as typeof JSON.parse;
    String.prototype.split = (function (
        this: string,
        separator?: string | RegExp,
        limit?: number,
    ): string[] {
        const fileName = classifier.jsonlFilesByContents.get(String(this));
        if (fileName) {
            jsonlFilePassesByFile[fileName] =
                (jsonlFilePassesByFile[fileName] ?? 0) + 1;
        }
        return originalSplit.call(this, separator, limit);
    }) as typeof String.prototype.split;

    try {
        createScaleAnalyzeModel(instrumentedFixture);
        return {
            pipelinePassCount: 1,
            sourceCollectionEnumerationCalls,
            sourceFileReadsByFile: sortedNumericRecord(sourceFileReadsByFile),
            jsonlFilePassesByFile: sortedNumericRecord(jsonlFilePassesByFile),
            jsonDocumentParseCalls: jsonDocumentCalls,
            nonemptyJsonlRowParseCalls: jsonlRowCalls,
            otherJsonParseCalls: otherCalls,
            totalJsonParseCalls: jsonDocumentCalls + jsonlRowCalls + otherCalls,
        };
    } finally {
        JSON.parse = originalParse;
        String.prototype.split = nativeSplit;
    }
}

function emptyPipelineCounters(): PipelineCounters {
    return {
        pipelinePassCount: 0,
        sourceCollectionEnumerationCalls: 0,
        sourceFileReadsByFile: {},
        jsonlFilePassesByFile: {},
        jsonDocumentParseCalls: 0,
        nonemptyJsonlRowParseCalls: 0,
        otherJsonParseCalls: 0,
        totalJsonParseCalls: 0,
    };
}

function sortedNumericRecord(
    values: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
    return Object.fromEntries(
        Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
    );
}

function createParseClassifier(
    files: Readonly<Record<string, unknown>>,
): ParseClassifier {
    const jsonDocuments = new Set<string>();
    const jsonlRows = new Set<string>();
    const jsonlFilesByContents = new Map<string, string>();
    for (const [fileName, contents] of Object.entries(files)) {
        if (typeof contents !== 'string') continue;
        if (/\.jsonl$/iu.test(fileName)) {
            jsonlFilesByContents.set(contents, fileName);
            for (const row of contents.split(/\r?\n/u)) {
                if (row.trim().length > 0) jsonlRows.add(row);
            }
        } else if (/\.json$/iu.test(fileName)) {
            jsonDocuments.add(contents);
        }
    }
    return { jsonDocuments, jsonlRows, jsonlFilesByContents };
}

function validateAndProjectFixture(
    fixture: ScaleFixture,
    requestedSourceRows: number,
): Readonly<{
    counts: ScaleFixture['counts'];
    bytes: ScaleFixture['bytes'];
    fileCount: number;
    jsonDocumentFileCount: number;
    jsonlFileCount: number;
    nonemptyJsonlRowCount: number;
}> {
    if (fixture.counts.sourceRows !== requestedSourceRows) {
        throw new Error(
            `Scale fixture requested ${requestedSourceRows} source rows but produced ${fixture.counts.sourceRows}.`,
        );
    }
    if (fixture.counts.events + fixture.counts.results !== fixture.counts.sourceRows) {
        throw new Error('Scale fixture row counts are internally inconsistent.');
    }

    const measuredByFile: Record<string, number> = {};
    let measuredTotal = 0;
    let jsonDocumentFileCount = 0;
    let jsonlFileCount = 0;
    let nonemptyJsonlRowCount = 0;
    for (const [fileName, contents] of Object.entries(fixture.files).sort(
        ([left], [right]) => left.localeCompare(right),
    )) {
        if (typeof contents !== 'string') continue;
        const byteCount = Buffer.byteLength(contents, 'utf8');
        measuredByFile[fileName] = byteCount;
        measuredTotal += byteCount;
        if (/\.jsonl$/iu.test(fileName)) {
            jsonlFileCount += 1;
            nonemptyJsonlRowCount += contents.split(/\r?\n/u).filter(
                row => row.trim().length > 0,
            ).length;
        } else if (/\.json$/iu.test(fileName)) {
            jsonDocumentFileCount += 1;
        }
    }
    if (
        !equalByteRecords(measuredByFile, fixture.bytes.byFile) ||
        measuredTotal !== fixture.bytes.total
    ) {
        throw new Error('Scale fixture byte metadata does not match its UTF-8 files.');
    }

    return {
        counts: fixture.counts,
        bytes: fixture.bytes,
        fileCount: Object.keys(fixture.files).length,
        jsonDocumentFileCount,
        jsonlFileCount,
        nonemptyJsonlRowCount,
    };
}

function equalByteRecords(
    left: Readonly<Record<string, number>>,
    right: Readonly<Record<string, number>>,
): boolean {
    const leftEntries = Object.entries(left);
    return leftEntries.length === Object.keys(right).length &&
        leftEntries.every(([fileName, byteCount]) => right[fileName] === byteCount);
}

function retainedHeapBytes(): number {
    const gc = exposedGarbageCollector();
    if (!gc) throw new Error('Garbage collector became unavailable during benchmark.');
    gc();
    return process.memoryUsage().heapUsed;
}

function requireExposedGarbageCollector(): void {
    if (typeof exposedGarbageCollector() !== 'function') {
        throw new Error(
            'This benchmark requires global.gc; invoke Node with --expose-gc --import tsx.',
        );
    }
}

function exposedGarbageCollector(): (() => void) | undefined {
    return (globalThis as typeof globalThis & { gc?: () => void }).gc;
}

function summarize(values: readonly number[]): MetricSummary {
    const sorted = [...values].sort((left, right) => left - right);
    if (sorted.length === 0) throw new Error('Cannot summarize an empty sample set.');
    const middle = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
        ? (sorted[middle - 1] + sorted[middle]) / 2
        : sorted[middle];
    const approximateP95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    return {
        median,
        approximateP95,
        max: sorted[sorted.length - 1],
    };
}

function assertFiniteSample(sample: RunSample): void {
    for (const [name, value] of Object.entries(sample)) {
        if (typeof value === 'number' && !Number.isFinite(value)) {
            throw new Error(`Benchmark produced non-finite metric ${name}.`);
        }
    }
}

function parseCliOptions(args: readonly string[]): CliOptions {
    const values = new Map<string, string>();
    const supported = new Set(['sizes', 'warmup', 'runs', 'out']);
    for (const argument of args) {
        const match = /^--([^=]+)=(.*)$/u.exec(argument);
        if (!match || !supported.has(match[1])) {
            throw new Error(
                `Unsupported argument "${argument}"; use --sizes=, --warmup=, --runs=, and --out=.`,
            );
        }
        if (values.has(match[1])) {
            throw new Error(`Argument --${match[1]} may be specified only once.`);
        }
        values.set(match[1], match[2]);
    }

    const sizes = values.has('sizes')
        ? parseSizes(values.get('sizes') ?? '')
        : [...DEFAULT_SIZES];
    const warmupCount = parseNonnegativeInteger(
        'warmup',
        values.get('warmup') ?? String(DEFAULT_WARMUP_COUNT),
    );
    const runCount = parsePositiveInteger(
        'runs',
        values.get('runs') ?? String(DEFAULT_RUN_COUNT),
    );
    const outputPath = values.get('out') ?? DEFAULT_OUTPUT;
    if (outputPath.trim().length === 0) throw new Error('--out must not be empty.');
    return { sizes, warmupCount, runCount, outputPath };
}

function parseSizes(value: string): readonly number[] {
    const sizes = value.split(',').map((part, index) =>
        parsePositiveInteger(`sizes[${index}]`, part)
    );
    if (sizes.length === 0 || new Set(sizes).size !== sizes.length) {
        throw new Error('--sizes must contain one or more unique positive integers.');
    }
    return sizes;
}

function parsePositiveInteger(name: string, value: string): number {
    const parsed = parseNonnegativeInteger(name, value);
    if (parsed === 0) throw new Error(`--${name} must be greater than zero.`);
    return parsed;
}

function parseNonnegativeInteger(name: string, value: string): number {
    if (!/^\d+$/u.test(value)) {
        throw new Error(`--${name} must be a nonnegative integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
        throw new Error(`--${name} must be a safe integer.`);
    }
    return parsed;
}

async function refuseExistingOutput(outputPath: string): Promise<void> {
    try {
        await access(outputPath, fsConstants.F_OK);
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') return;
        throw error;
    }
    throw new Error(`Refusing to overwrite existing benchmark output: ${outputPath}`);
}

function readGitMetadata(): Readonly<{
    commit?: string;
    branch?: string;
    dirty?: boolean;
}> {
    const commit = readGitValue(['rev-parse', '--verify', 'HEAD']);
    const branch = readGitValue(['branch', '--show-current']);
    const status = readGitValue(['status', '--porcelain', '--untracked-files=normal'], true);
    const dirty = status === undefined ? undefined : status.length > 0;
    return {
        ...(commit ? { commit } : {}),
        ...(branch ? { branch } : {}),
        ...(dirty === undefined ? {} : { dirty }),
    };
}

function readGitValue(
    args: readonly string[],
    preserveEmpty = false,
): string | undefined {
    const result = spawnSync('git', args, {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 2_000,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0 || typeof result.stdout !== 'string') return undefined;
    const value = result.stdout.trim();
    return value.length > 0 || preserveEmpty ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}

void main().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Recipe Console scale benchmark failed: ${message}`);
    process.exitCode = 1;
});
