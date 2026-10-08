import {
    mkdir,
    readFile,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
    ControlDistributedRunArtifactBundle,
    ControlDistributedRunSnapshot
} from '@shared-test/rallar-bb-test/control-snapshots.ts';
import {
    decodeControlDistributedRunSnapshot,
    decodeTargetResolution
} from '@shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import {
    decodeDistributedRunManifest,
    toDistributedRunManifestValidationText
} from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
    RallarBlackBoxDistributedTargetResolution
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { decodeControlDistributedRunArtifactBundle } from '@shared-test/rallar-bb-test/schema/control-artifact-envelope.ts';
import { Either } from '@shared/resilience/Either.ts';
import { toError } from '@shared/resilience/to-error.ts';
import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

export interface WorldFleetDistributedRecipeRunnerOptions {
    readonly controlBaseUrl: string;
    readonly manifestPath: string;
    /** Absent when preserving the manifest's authored control run identity. */
    readonly controlRunId?: string;
    /** Absent or blank when preserving authored RUN capture. */
    readonly rtcCaptureMode?: string;
    /** Absent when the existing endpoint does not require a bearer token. */
    readonly token?: string;
    /** Absent for artifacts/world-fleet/<distributedRunId>. */
    readonly artifactDir?: string;
    readonly pollMs: number;
    readonly timeoutMs: number;
}

export interface WorldFleetDistributedRecipeDependencies {
    readonly fetch: typeof fetch;
    readonly readManifestText: (filePath: string) => Promise<string>;
    readonly artifacts: WorldFleetArtifactDependencies;
    readonly clock: WorldFleetClock;
    readonly log: (message: string) => void;
    readonly warn: (message: string) => void;
}

export interface WorldFleetArtifactDependencies {
    readonly mkdir: (directory: string) => Promise<void>;
    readonly writeFile: (filePath: string, contents: string) => Promise<void>;
}

export interface WorldFleetClock {
    readonly now: () => number;
    readonly wait: (milliseconds: number) => Promise<void>;
}

export interface WorldFleetExpectedFailure {
    readonly kind: 'validation' | 'protocol' | 'policy' | 'terminal' | 'timeout';
    readonly message: string;
}

export interface WorldFleetRuntimeFailure {
    readonly kind: 'runtime';
    readonly operation: string;
    readonly cause: Error;
}

export type WorldFleetFailure = WorldFleetExpectedFailure | WorldFleetRuntimeFailure;

interface WorldFleetRequest {
    readonly pathname: string;
    readonly method: 'GET' | 'POST';
    /** Absent for GET requests. */
    readonly body?: string;
}

interface WorldFleetRun {
    readonly options: WorldFleetDistributedRecipeRunnerOptions;
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly dependencies: WorldFleetDistributedRecipeDependencies;
}

const TERMINAL_STATES = new Set(['passed', 'failed', 'cancelled', 'timed-out']);

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2), process.env);
    const dependencies: WorldFleetDistributedRecipeDependencies = {
        fetch,
        readManifestText: (filePath) => readFile(filePath, 'utf8'),
        artifacts: {
            mkdir: async (directory) => {
                await mkdir(directory, { recursive: true });
            },
            writeFile: async (filePath, contents) => {
                await writeFile(filePath, contents);
            }
        },
        clock: { now: Date.now, wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) },
        log: console.log,
        warn: console.warn
    };
    const outcome = await runWorldFleetDistributedRecipe(options, dependencies);
    outcome.fold((failure) => {
        throw new Error(toWorldFleetFailureText(failure));
    }, () => undefined);
}

export async function runWorldFleetDistributedRecipe(
    options: WorldFleetDistributedRecipeRunnerOptions,
    dependencies: WorldFleetDistributedRecipeDependencies
): Promise<Either<WorldFleetFailure, true>> {
    const capture = parseRtcCaptureMode(options.rtcCaptureMode?.trim() === '' ? undefined : options.rtcCaptureMode)
        .mapLeft((issues): WorldFleetFailure => ({
            kind: 'validation',
            message: issues.map((issue) => issue.message).join('\n')
        }));
    if (capture.right === undefined) {
        return capture.mapRight(() => true as const);
    }
    const source = await readWorldFleetManifest(options.manifestPath, dependencies.readManifestText);
    if (source.right === undefined) {
        return source.mapRight(() => true as const);
    }
    const scopedManifest = applyWorldFleetControlRunIdOverride(source.right, options.controlRunId);
    const manifest = capture.right.mode === undefined
        ? scopedManifest
        : { ...scopedManifest, rtcCaptureMode: capture.right.mode };
    dependencies.log(`world-fleet no-spawn runner: ${manifest.distributedRunId}`);
    dependencies.log(`control server: ${options.controlBaseUrl}`);
    dependencies.log(`manifest: ${options.manifestPath}`);
    if (options.controlRunId) {
        dependencies.log(`control run override: ${options.controlRunId}`);
    }
    const run = { options, manifest, dependencies };
    const resolution = await readWorldFleetTargetResolution(run);
    if (resolution.right === undefined) {
        return resolution.mapRight(() => true as const);
    }
    const expected = manifest.targetPolicy.expectedParticipantCount;
    dependencies.log(
        `target preflight: selected ${resolution.right.summary.selected}/${
            expected ?? 'unspecified'
        }; blockers ${resolution.right.blockers.length}`
    );
    dependencies.log(`role counts: ${JSON.stringify(resolution.right.summary.roleCounts)}`);
    dependencies.log(`regions: ${JSON.stringify(resolution.right.summary.regions)}`);
    dependencies.log(`providers: ${JSON.stringify(resolution.right.summary.providers)}`);
    if (expected !== undefined && resolution.right.summary.selected !== expected) {
        return Either.ofLeft({
            kind: 'policy',
            message: `Target preflight mismatch: selected ${resolution.right.summary.selected}, expected ${expected}.`
        });
    }
    return await createAndStageWorldFleetRun(run);
}

async function createAndStageWorldFleetRun(run: WorldFleetRun): Promise<Either<WorldFleetFailure, true>> {
    const created = await readWorldFleetSnapshotResponse(run, {
        pathname: '/distributed-runs',
        method: 'POST',
        body: JSON.stringify({ manifest: run.manifest })
    });
    if (created.right === undefined) {
        return created.mapRight(() => true as const);
    }
    run.dependencies.log(`created: ${created.right.state}`);
    const staged = await readWorldFleetSnapshotResponse(run, {
        pathname: `${toRunPath(run.manifest)}/stage`,
        method: 'POST',
        body: '{}'
    });
    if (staged.right === undefined) {
        return staged.mapRight(() => true as const);
    }
    run.dependencies.log(`staged: ${staged.right.state}`);
    return await startAndFinishWorldFleetRun(run);
}

async function startAndFinishWorldFleetRun(run: WorldFleetRun): Promise<Either<WorldFleetFailure, true>> {
    const ready = await readWorldFleetState(run, 'readiness');
    if (ready.right === undefined) {
        return ready.mapRight(() => true as const);
    }
    if (ready.right.state !== 'ready' && ready.right.state !== 'running') {
        const exported = await exportWorldFleetArtifacts(run);
        if (exported.left !== undefined) {
            return exported;
        }
        return Either.ofLeft({
            kind: 'terminal',
            message: `Distributed run reached ${ready.right.state} before start.`
        });
    }
    if (ready.right.state === 'ready') {
        const started = await readWorldFleetSnapshotResponse(run, {
            pathname: `${toRunPath(run.manifest)}/start`,
            method: 'POST',
            body: '{}'
        });
        if (started.right === undefined) {
            return started.mapRight(() => true as const);
        }
        run.dependencies.log(`started: ${started.right.state}`);
    }
    return await finishWorldFleetRun(run);
}

async function finishWorldFleetRun(run: WorldFleetRun): Promise<Either<WorldFleetFailure, true>> {
    const terminal = await readWorldFleetState(run, 'terminal');
    if (terminal.right === undefined) {
        return terminal.mapRight(() => true as const);
    }
    run.dependencies.log(`terminal: ${terminal.right.state}`);
    const exported = await exportWorldFleetArtifacts(run);
    if (exported.left !== undefined) {
        return exported;
    }
    return terminal.right.state === 'passed'
        ? Either.ofRight(true)
        : Either.ofLeft({ kind: 'terminal', message: `Distributed run did not pass: ${terminal.right.state}.` });
}

export function applyWorldFleetControlRunIdOverride(
    manifest: RallarBlackBoxDistributedRunManifest,
    controlRunId?: string
): RallarBlackBoxDistributedRunManifest {
    const cleanControlRunId = controlRunId?.trim();
    return cleanControlRunId ? { ...manifest, controlRunId: cleanControlRunId } : manifest;
}

async function readWorldFleetState(
    run: WorldFleetRun,
    phase: 'readiness' | 'terminal'
): Promise<Either<WorldFleetFailure, ControlDistributedRunSnapshot>> {
    const startedAt = run.dependencies.clock.now();
    while (run.dependencies.clock.now() - startedAt <= run.options.timeoutMs) {
        const snapshot = await readWorldFleetSnapshotResponse(run, {
            pathname: toRunPath(run.manifest),
            method: 'GET'
        });
        if (snapshot.left !== undefined) {
            return snapshot;
        }
        const reached = snapshot.fold(() => false, (snapshot) =>
            TERMINAL_STATES.has(snapshot.state) ||
            (phase === 'readiness' && (snapshot.state === 'ready' || snapshot.state === 'running')));
        if (reached) {
            return snapshot;
        }
        try {
            await run.dependencies.clock.wait(run.options.pollMs);
        }
        catch (cause) {
            return Either.ofLeft({ kind: 'runtime', operation: 'wait for distributed run', cause: toError(cause) });
        }
    }
    return Either.ofLeft({
        kind: 'timeout',
        message: `Timed out waiting for distributed run ${run.manifest.distributedRunId}.`
    });
}

async function readWorldFleetManifest(
    manifestPath: string,
    readManifestText: WorldFleetDistributedRecipeDependencies['readManifestText']
): Promise<Either<WorldFleetFailure, RallarBlackBoxDistributedRunManifest>> {
    let value: unknown;
    try {
        value = JSON.parse(await readManifestText(manifestPath));
    }
    catch (cause) {
        return Either.ofLeft({ kind: 'runtime', operation: `read manifest ${manifestPath}`, cause: toError(cause) });
    }
    return decodeDistributedRunManifest(value).mapLeft((issues) => ({
        kind: 'validation',
        message: toDistributedRunManifestValidationText(issues)
    }));
}

async function readWorldFleetTargetResolution(
    run: WorldFleetRun
): Promise<Either<WorldFleetFailure, RallarBlackBoxDistributedTargetResolution>> {
    const response = await readWorldFleetHttpJson(run, {
        pathname: '/distributed-runs/resolve-targets',
        method: 'POST',
        body: JSON.stringify({ manifest: run.manifest })
    });
    return response.flatMap(
        (failure) => Either.ofLeft<WorldFleetFailure, RallarBlackBoxDistributedTargetResolution>(failure),
        (value) => decodeTargetResolution(value).mapLeft((message) => ({ kind: 'protocol', message }))
    );
}

async function readWorldFleetSnapshotResponse(
    run: WorldFleetRun,
    request: WorldFleetRequest
): Promise<Either<WorldFleetFailure, ControlDistributedRunSnapshot>> {
    const response = await readWorldFleetHttpJson(run, request);
    return response.flatMap(
        (failure) => Either.ofLeft<WorldFleetFailure, ControlDistributedRunSnapshot>(failure),
        (value) => decodeControlDistributedRunSnapshot(value).mapLeft((message) => ({ kind: 'protocol', message }))
    );
}

async function exportWorldFleetArtifacts(run: WorldFleetRun): Promise<Either<WorldFleetFailure, true>> {
    const response = await readWorldFleetHttpJson(run, {
        pathname: `${toRunPath(run.manifest)}/artifacts`,
        method: 'GET'
    });
    const bundle = response.flatMap(
        (failure) => Either.ofLeft<WorldFleetFailure, ControlDistributedRunArtifactBundle>(failure),
        (value) =>
            decodeControlDistributedRunArtifactBundle(value).mapLeft((message) => ({ kind: 'protocol', message }))
    );
    return await bundle.fold(
        async (failure) => Either.ofLeft<WorldFleetFailure, true>(failure),
        (bundle) => writeWorldFleetArtifacts(run, bundle)
    );
}

async function writeWorldFleetArtifacts(
    run: WorldFleetRun,
    bundle: ControlDistributedRunArtifactBundle
): Promise<Either<WorldFleetFailure, true>> {
    const artifactDir = run.options.artifactDir ?? path.join('artifacts', 'world-fleet', run.manifest.distributedRunId);
    try {
        await run.dependencies.artifacts.mkdir(artifactDir);
        await run.dependencies.artifacts.writeFile(
            path.join(artifactDir, 'artifact-bundle.json'),
            `${JSON.stringify(bundle, null, 2)}\n`
        );
        for (const [fileName, contents] of Object.entries(bundle.files)) {
            const safeFileName = toSafeArtifactFileName(fileName);
            if (!safeFileName) {
                run.dependencies.warn(`Skipping unsafe artifact bundle file name: ${fileName}`);
                continue;
            }
            await run.dependencies.artifacts.writeFile(
                path.join(artifactDir, safeFileName),
                contents.endsWith('\n') ? contents : `${contents}\n`
            );
        }
    }
    catch (cause) {
        return Either.ofLeft({ kind: 'runtime', operation: `write artifacts ${artifactDir}`, cause: toError(cause) });
    }
    run.dependencies.log(`artifacts: ${artifactDir}`);
    return Either.ofRight(true);
}

async function readWorldFleetHttpJson(
    run: WorldFleetRun,
    request: WorldFleetRequest
): Promise<Either<WorldFleetFailure, unknown>> {
    const operation = `${request.method} ${request.pathname}`;
    try {
        const response = await run.dependencies.fetch(
            new URL(request.pathname, toControlBaseUrl(run.options.controlBaseUrl)),
            {
                method: request.method,
                ...(request.body === undefined ? {} : { body: request.body }),
                headers: {
                    'Content-Type': 'application/json',
                    ...(run.options.token ? { Authorization: `Bearer ${run.options.token}` } : {})
                }
            }
        );
        if (!response.ok) {
            return Either.ofLeft({
                kind: 'protocol',
                message: `${operation} failed with ${response.status}: ${await response.text()}`
            });
        }
        return Either.ofRight(await response.json());
    }
    catch (cause) {
        return Either.ofLeft({ kind: 'runtime', operation, cause: toError(cause) });
    }
}

function toRunPath(manifest: RallarBlackBoxDistributedRunManifest): string {
    return `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}`;
}

function toSafeArtifactFileName(fileName: string): string | undefined {
    return fileName.length === 0 || fileName.includes('\0') || fileName.includes('/') || fileName.includes('\\') ||
            path.isAbsolute(fileName) || fileName === '.' || fileName === '..'
        ? undefined
        : fileName;
}

function toControlBaseUrl(value: string): URL {
    const url = new URL(value);
    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`;
    }
    return url;
}

function toWorldFleetFailureText(failure: WorldFleetFailure): string {
    return failure.kind === 'runtime' ? failure.cause.message : failure.message;
}

function parseArgs(args: readonly string[], env: NodeJS.ProcessEnv): WorldFleetDistributedRecipeRunnerOptions {
    const values = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--help' || arg === '-h') {
            printUsage();
            process.exit(0);
        }
        if (!arg.startsWith('--')) {
            throw new Error(`Unexpected argument: ${arg}`);
        }
        const key = arg.slice(2);
        const value = args[index + 1];
        if (value === undefined || value.startsWith('--') || (value === '' && key !== 'rtc-capture-mode')) {
            throw new Error(`Missing value for --${key}`);
        }
        values.set(key, value);
        index += 1;
    }
    const controlBaseUrl = values.get('control') ?? env.RALLAR_CONTROL_BASE_URL;
    const manifestPath = values.get('manifest');
    if (!controlBaseUrl || !manifestPath) {
        printUsage();
        throw new Error('Missing --control and/or --manifest.');
    }
    return {
        controlBaseUrl,
        manifestPath,
        controlRunId: values.get('control-run-id') ?? env.RALLAR_CONTROL_RUN_ID,
        rtcCaptureMode: values.get('rtc-capture-mode'),
        token: values.get('token') ?? env.RALLAR_CONTROL_ADMIN_TOKEN,
        artifactDir: values.get('artifact-dir'),
        pollMs: positiveInteger(values.get('poll-ms'), 2_000),
        timeoutMs: positiveInteger(values.get('timeout-ms'), 30 * 60_000)
    };
}

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function printUsage(): void {
    console.log(`Usage:
  npx tsx apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts \\
    --control http://127.0.0.1:5180 \\
    --manifest apps/rallar-black-box/manifests/world-fleet/01-rtc-messages-principal-50-agent-30s-20hz-tree.json \\
    --rtc-capture-mode off \\
    --control-run-id live-world-fleet-control-run \\
    --token "$RALLAR_CONTROL_ADMIN_TOKEN" \\
    --artifact-dir artifacts/world-fleet/principal-30s-tree \\
    --timeout-ms 3900000

Optional --rtc-capture-mode sets RUN capture; blank preserves the authored manifest.
This runner never starts, stops, installs, or restarts headless agents. It only
preflights, creates, stages, starts, polls, and exports through an existing
control server.`);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(toError(error).message);
        process.exitCode = 1;
    });
}
