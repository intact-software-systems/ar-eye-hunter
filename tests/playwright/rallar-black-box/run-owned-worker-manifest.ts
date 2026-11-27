import { expect } from '@playwright/test';
import {
    mkdir,
    readFile,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';

import { runWorldFleetDistributedRecipe } from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import type { Either } from '../../../packages/shared/resilience/Either.ts';

import { ALL_LOCAL_ALM_READINESS_TIMEOUT_MS } from './compute-all-local-alm-observation-deadlines.ts';

/** One manifest a spec gives the world-fleet operator while its own worker holds the agents. */
export interface OwnedWorkerManifestRun {
    readonly controlBaseUrl: string;
    /** The path the operator is given; it reads `manifestText` there and nothing else. */
    readonly manifestPath: string;
    readonly manifestText: string;
    /** The operator writes the run's native evidence here. */
    readonly artifactDir: string;
    /** Absent or blank keeps the capture the manifest authored. */
    readonly rtcCaptureMode: string | undefined;
    readonly terminalTimeoutMs: number;
    /** The harness's abort: it ends every request of the operator. */
    readonly signal: AbortSignal;
    /** Runs once the run is terminal and before its evidence is exported: the spec stops its worker here. */
    readonly prepareEvidenceExport: () => Promise<void>;
}

/** How often the operator reads the run's state. */
const RUN_STATE_POLL_MS = 2_000;

/** The left is the operator's failure as one message: a run that did not pass, or evidence that could not be exported. */
export async function runOwnedWorkerManifest(run: OwnedWorkerManifestRun): Promise<Either<string, true>> {
    const operation = await runWorldFleetDistributedRecipe({
        controlBaseUrl: run.controlBaseUrl,
        manifestPath: run.manifestPath,
        artifactDir: run.artifactDir,
        rtcCaptureMode: run.rtcCaptureMode,
        pollMs: RUN_STATE_POLL_MS,
        readinessTimeoutMs: ALL_LOCAL_ALM_READINESS_TIMEOUT_MS,
        terminalTimeoutMs: run.terminalTimeoutMs
    }, {
        fetch: (url, init) => fetch(url, { ...init, signal: run.signal }),
        readManifestText: async (filePath) => {
            expect(filePath).toBe(run.manifestPath);
            return run.manifestText;
        },
        artifacts: {
            mkdir: async (directory) => {
                await mkdir(directory, { recursive: true });
            },
            writeFile: async (filePath, contents) => {
                await writeFile(filePath, contents);
            }
        },
        clock: {
            now: Date.now,
            wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
        },
        log: console.log,
        warn: console.warn,
        prepareEvidenceExport: run.prepareEvidenceExport
    });
    return operation.mapLeft((failure) => failure.kind === 'runtime' ? failure.cause.message : failure.message);
}

/** The distributed run as the control server last held it, from the evidence the operator exported. */
export async function readNativeDistributedRun(artifactDir: string): Promise<ControlDistributedRunSnapshot> {
    return decodeControlDistributedRunSnapshot(
        JSON.parse(await readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8'))
    ).fold(() => {
        throw new Error('Native distributed snapshot could not be decoded.');
    }, (decoded) => decoded);
}

/** The control run of that distributed run, from the same evidence: its agents and their results as the server kept them. */
export async function readNativeControlRun(artifactDir: string): Promise<ControlRunSnapshot> {
    return decodeControlRunSnapshot(
        JSON.parse(await readFile(path.join(artifactDir, 'control-run.json'), 'utf8'))
    ).fold(() => {
        throw new Error('Native control snapshot could not be decoded.');
    }, (decoded) => decoded);
}
