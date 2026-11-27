import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';

import { toRoomSendFailureLines } from './answer/to-room-send-thrown-error.ts';
import {
    readRoomSendEnvironment,
    readRoomSendLoadAverage,
    readRoomSendSource
} from './artifact/read-room-send-environment.ts';
import {
    toRoomSendArtifact,
    type RoomSendArtifactEnvironment,
    type RoomSendArtifactSource
} from './artifact/to-room-send-artifact.ts';
import { toRoomSendSummary } from './artifact/to-room-send-summary.ts';
import { resolveRoomSendArtifactPath, writeRoomSendArtifact } from './artifact/write-room-send-artifact.ts';
import {
    decodeRoomSendCellOptions,
    type RoomSendCellOptionIssue,
    type RoomSendCellOptions
} from './decode-room-send-cell-options.ts';
import { ROOM_SEND_REFERENCE_OBSERVATION_TAIL_MS } from './room-send-cell-constants.ts';
import {
    createDefaultRoomSendCellRunDependencies,
    runRoomSendCell,
    type RoomSendCellRunResult
} from './run-room-send-cell.ts';

/** A run that completed: where its artifact is, and the lines to print of it. */
export interface AlmRoomSendCellCompletion {
    readonly artifactPath: string;
    readonly summary: readonly string[];
}

/** Every issue of an invocation's options and nothing run, or the run it completed. */
export type AlmRoomSendCellOutcome = Either<readonly RoomSendCellOptionIssue[], AlmRoomSendCellCompletion>;

/** What the entry read before the run opened its first connection. */
interface RoomSendRunStart {
    readonly createdAt: string;
    readonly source: RoomSendArtifactSource;
    readonly environment: RoomSendArtifactEnvironment;
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
 * the database URL: print it through `toRoomSendFailureLines` alone.
 */
export async function runAlmRoomSendCell(argv: readonly string[]): Promise<AlmRoomSendCellOutcome> {
    return await decodeRoomSendCellOptions(argv).fold<Promise<AlmRoomSendCellOutcome>>(
        async (issues) => Either.ofLeft(issues),
        runRoomSendReference
    );
}

/** A reference run: on a run id of its own, observing for the same tail whatever its shape. */
async function runRoomSendReference(options: RoomSendCellOptions): Promise<AlmRoomSendCellOutcome> {
    const start: RoomSendRunStart = {
        createdAt: new Date().toISOString(),
        source: readRoomSendSource(),
        environment: await readRoomSendEnvironment(options.databaseUrl),
        loadAverageAtStart: readRoomSendLoadAverage(),
        startedAtMs: performance.now()
    };
    const ran = await runRoomSendCell(
        {
            shape: options.shape,
            databaseUrl: options.databaseUrl,
            runId: crypto.randomUUID(),
            observationTailMs: ROOM_SEND_REFERENCE_OBSERVATION_TAIL_MS
        },
        createDefaultRoomSendCellRunDependencies()
    );
    return await ran.fold<Promise<AlmRoomSendCellOutcome>>(
        async (issues) => Either.ofLeft(issues),
        async (run) => Either.ofRight(await writeRoomSendRun(options, start, run))
    );
}

/** Writes the artifact of a run that has ended, and returns where it is and the summary of it. */
async function writeRoomSendRun(
    options: RoomSendCellOptions,
    start: RoomSendRunStart,
    run: RoomSendCellRunResult
): Promise<AlmRoomSendCellCompletion> {
    const artifact = toRoomSendArtifact({
        createdAt: start.createdAt,
        source: start.source,
        environment: start.environment,
        loadAverage: { atStart: start.loadAverageAtStart, atEnd: readRoomSendLoadAverage() },
        shape: options.shape,
        givenOptions: options.givenOptions,
        observationTailMs: ROOM_SEND_REFERENCE_OBSERVATION_TAIL_MS,
        wallMs: performance.now() - start.startedAtMs,
        run
    });
    const artifactPath = resolveRoomSendArtifactPath(options.artifactDestination, artifact);
    await writeRoomSendArtifact(artifact, artifactPath);
    return { artifactPath, summary: toRoomSendSummary(artifact) };
}

if (import.meta.main) {
    process.exit(
        await runAlmRoomSendCell(process.argv.slice(2)).then(
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
                toRoomSendFailureLines(toError(thrown)).forEach((line) => console.error(line));
                return FAILED_EXIT_STATUS;
            }
        )
    );
}
