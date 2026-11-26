import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import {
    readOrderedSendEnvironment,
    readOrderedSendLoadAverage,
    readOrderedSendSource
} from './artifact/read-ordered-send-environment.ts';
import {
    toOrderedSendArtifact,
    type OrderedSendArtifactEnvironment,
    type OrderedSendArtifactSource
} from './artifact/to-ordered-send-artifact.ts';
import { toOrderedSendSummary } from './artifact/to-ordered-send-summary.ts';
import { resolveOrderedSendArtifactPath, writeOrderedSendArtifact } from './artifact/write-ordered-send-artifact.ts';
import {
    decodeOrderedSendCellOptions,
    type OrderedSendCellOptionIssue,
    type OrderedSendCellOptions
} from './decode-ordered-send-cell-options.ts';
import { ORDERED_SEND_REFERENCE_OBSERVATION_TAIL_MS } from './ordered-send-cell-constants.ts';
import {
    createDefaultOrderedSendCellRunDependencies,
    runOrderedSendCell,
    type OrderedSendCellRunResult
} from './run-ordered-send-cell.ts';
import { toOrderedSendFailureLines } from './to-ordered-send-thrown-error.ts';

/** A run that completed: where its artifact is, and the lines to print of it. */
export interface AlmOrderedSendCellCompletion {
    readonly artifactPath: string;
    readonly summary: readonly string[];
}

/** Every issue of an invocation's options and nothing run, or the run it completed. */
export type AlmOrderedSendCellOutcome = Either<readonly OrderedSendCellOptionIssue[], AlmOrderedSendCellCompletion>;

/** What the entry read before the run opened its first connection. */
interface OrderedSendRunStart {
    readonly createdAt: string;
    readonly source: OrderedSendArtifactSource;
    readonly environment: OrderedSendArtifactEnvironment;
    readonly loadAverageAtStart: readonly number[];
    readonly startedAtMs: number;
}

/** Exit status 2: the invocation was refused for its options, and nothing ran. */
const REFUSED_EXIT_STATUS = 2;

/** Exit status 1: the run could not be carried out. */
const FAILED_EXIT_STATUS = 1;

/**
 * One invocation of the cell, from the arguments after the script's name: every issue of its options and nothing
 * run, or one reference run on the database the options name, its artifact written and its summary to print. A run
 * completes whatever its figures are; only a run that could not be carried out throws, and what it throws may carry
 * the database URL: print it through `toOrderedSendFailureLines` alone.
 */
export async function runAlmOrderedSendCell(argv: readonly string[]): Promise<AlmOrderedSendCellOutcome> {
    return await decodeOrderedSendCellOptions(argv).fold<Promise<AlmOrderedSendCellOutcome>>(
        async (issues) => Either.ofLeft(issues),
        runOrderedSendReference
    );
}

/** A reference run: on a run id of its own, observing for the same tail whatever its shape. */
async function runOrderedSendReference(options: OrderedSendCellOptions): Promise<AlmOrderedSendCellOutcome> {
    const start: OrderedSendRunStart = {
        createdAt: new Date().toISOString(),
        source: readOrderedSendSource(),
        environment: await readOrderedSendEnvironment(options.databaseUrl),
        loadAverageAtStart: readOrderedSendLoadAverage(),
        startedAtMs: performance.now()
    };
    const ran = await runOrderedSendCell(
        {
            shape: options.shape,
            databaseUrl: options.databaseUrl,
            runId: crypto.randomUUID(),
            observationTailMs: ORDERED_SEND_REFERENCE_OBSERVATION_TAIL_MS
        },
        createDefaultOrderedSendCellRunDependencies()
    );
    return await ran.fold<Promise<AlmOrderedSendCellOutcome>>(
        async (issues) => Either.ofLeft(issues),
        async (run) => Either.ofRight(await writeOrderedSendRun(options, start, run))
    );
}

/** Writes the artifact of a run that has ended, and returns where it is and the summary of it. */
async function writeOrderedSendRun(
    options: OrderedSendCellOptions,
    start: OrderedSendRunStart,
    run: OrderedSendCellRunResult
): Promise<AlmOrderedSendCellCompletion> {
    const artifact = toOrderedSendArtifact({
        createdAt: start.createdAt,
        source: start.source,
        environment: start.environment,
        loadAverage: { atStart: start.loadAverageAtStart, atEnd: readOrderedSendLoadAverage() },
        shape: options.shape,
        observationTailMs: ORDERED_SEND_REFERENCE_OBSERVATION_TAIL_MS,
        wallMs: performance.now() - start.startedAtMs,
        run
    });
    const artifactPath = resolveOrderedSendArtifactPath(options.artifactDestination, artifact);
    await writeOrderedSendArtifact(artifact, artifactPath);
    return { artifactPath, summary: toOrderedSendSummary(artifact) };
}

if (import.meta.main) {
    process.exit(
        await runAlmOrderedSendCell(process.argv.slice(2)).then(
            // The product logs to stdout while a run lasts, so the summary is printed after it and nothing is to parse it.
            (outcome) =>
                outcome.fold(
                    (issues) => {
                        issues.forEach((issue) => console.error(`${issue.code}: ${issue.message}`));
                        return REFUSED_EXIT_STATUS;
                    },
                    (completion) => {
                        completion.summary.forEach((line) => console.log(line));
                        console.log(`artifact: ${completion.artifactPath}`);
                        return 0;
                    }
                ),
            // An uncaught error is printed with every property it carries, and a driver's or a URL parser's may carry the
            // database URL: only its name and a bounded message with nothing URL-shaped in it are printed here.
            (thrown) => {
                toOrderedSendFailureLines(toError(thrown)).forEach((line) => console.error(line));
                return FAILED_EXIT_STATUS;
            }
        )
    );
}
