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
import { parseRtcCaptureMode, type ParsedRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';

import { readManifestRunnerOptions } from './read-manifest-runner-options.ts';
import { writeManifestArtifactFiles } from './write-manifest-artifact-files.ts';

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
    /** Await producer completion after operation settlement and before final native exports. */
    readonly prepareEvidenceExport: () => Promise<void>;
}

export interface WorldFleetArtifactDependencies {
    readonly mkdir: (directory: string) => Promise<void>;
    readonly writeFile: (filePath: string, contents: string | Uint8Array) => Promise<void>;
}

export interface WorldFleetClock {
    readonly now: () => number;
    readonly wait: (milliseconds: number) => Promise<void>;
}

export interface WorldFleetExpectedFailure {
    readonly kind: 'validation' | 'protocol' | 'policy' | 'terminal' | 'timeout' | 'lifecycle' | 'export';
    readonly message: string;
    readonly requestFailure?: WorldFleetSafeFailureMetadata;
}

export interface WorldFleetRuntimeFailure {
    readonly kind: 'runtime';
    readonly operation: string;
    readonly cause: Error;
    readonly requestFailure?: WorldFleetSafeFailureMetadata;
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
    readonly artifactDir: string;
}

interface WorldFleetManifestSource {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly sourceText: string;
}

interface WorldFleetSafeFailureMetadata {
    readonly code: string;
    readonly method: string | null;
    readonly pathname: string | null;
    readonly httpStatus: number | null;
}

interface WorldFleetEvidenceExport {
    readonly fileName: string;
    readonly status: 'written' | 'unavailable';
    readonly failure: WorldFleetFailure | undefined;
}

interface WorldFleetCompletion {
    readonly operationFailure: WorldFleetFailure | undefined;
    readonly lifecycleFailure: WorldFleetFailure | undefined;
    readonly exports: readonly WorldFleetEvidenceExport[];
}

interface WorldFleetNativeArtifact {
    readonly fileName: string;
    readonly pathname: string;
}

const TERMINAL_STATES = new Set(['passed', 'failed', 'cancelled', 'timed-out']);

async function main(): Promise<void> {
    const options = readManifestRunnerOptions(process.argv.slice(2), process.env);
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
        prepareEvidenceExport: async () => undefined,
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
    const source = await readWorldFleetManifest(options, dependencies.readManifestText);
    if (source.right === undefined) {
        return source.mapRight(() => true as const);
    }
    const manifest = applyWorldFleetCaptureMode(source.right.manifest, capture.right);
    const artifactDir = options.artifactDir ?? path.join('artifacts', 'world-fleet', manifest.distributedRunId);
    const run: WorldFleetRun = { options, manifest, dependencies, artifactDir };
    try {
        await dependencies.artifacts.mkdir(artifactDir);
        await dependencies.artifacts.writeFile(path.join(artifactDir, 'source-manifest.json'), source.right.sourceText);
    }
    catch (cause) {
        return Either.ofLeft({ kind: 'runtime', operation: 'write source manifest', cause: toError(cause) });
    }
    const operation = await startWorldFleetRun(run);
    return await completeWorldFleetEvidence(run, operation);
}

/** Apply an admitted RUN selection while preserving every unrelated authored field. */
export function applyWorldFleetCaptureMode(
    manifest: RallarBlackBoxDistributedRunManifest,
    capture: ParsedRtcCaptureMode
): RallarBlackBoxDistributedRunManifest {
    return capture.mode === undefined ? manifest : { ...manifest, rtcCaptureMode: capture.mode };
}

async function startWorldFleetRun(run: WorldFleetRun): Promise<Either<WorldFleetFailure, true>> {
    const { manifest, dependencies } = run;
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
    return terminal.right.state === 'passed'
        ? Either.ofRight(true)
        : Either.ofLeft({ kind: 'terminal', message: `Distributed run did not pass: ${terminal.right.state}.` });
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
    options: WorldFleetDistributedRecipeRunnerOptions,
    readManifestText: WorldFleetDistributedRecipeDependencies['readManifestText']
): Promise<Either<WorldFleetFailure, WorldFleetManifestSource>> {
    let value: unknown;
    let sourceText: string;
    try {
        sourceText = await readManifestText(options.manifestPath);
        value = JSON.parse(sourceText);
    }
    catch (cause) {
        return Either.ofLeft({ kind: 'runtime', operation: 'read manifest', cause: toError(cause) });
    }
    const controlRunId = options.controlRunId?.trim();
    const overridden = controlRunId && value !== null && typeof value === 'object' && !Array.isArray(value)
        ? { ...value, controlRunId }
        : value;
    return decodeDistributedRunManifest(overridden).mapLeft((issues): WorldFleetFailure => ({
        kind: 'validation',
        message: toDistributedRunManifestValidationText(issues)
    })).mapRight((manifest) => ({ manifest, sourceText }));
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
    const status = await writeManifestArtifactFiles(
        { artifactDir: run.artifactDir, bundle },
        run.dependencies.artifacts
    );
    return status === 'written'
        ? Either.ofRight(true)
        : Either.ofLeft({ kind: 'export', message: 'Required evidence export failed: artifact-bundle.json.' });
}

async function completeWorldFleetEvidence(
    run: WorldFleetRun,
    operation: Either<WorldFleetFailure, true>
): Promise<Either<WorldFleetFailure, true>> {
    let lifecycleFailure: WorldFleetFailure | undefined;
    try {
        await run.dependencies.prepareEvidenceExport();
    }
    catch {
        lifecycleFailure = { kind: 'lifecycle', message: 'Completion lifecycle preparation failed.' };
    }
    const bundle = await exportWorldFleetArtifacts(run);
    const exports: WorldFleetEvidenceExport[] = [{
        fileName: 'artifact-bundle.json',
        status: bundle.left ? 'unavailable' : 'written',
        failure: bundle.left
    }];
    const controlPath = `/runs/${encodeURIComponent(run.manifest.controlRunId)}`;
    for (
        const [fileName, pathname] of [
            ['distributed-run.json', toRunPath(run.manifest)],
            ['control-run.json', controlPath],
            ['events.jsonl', `${controlPath}/events.jsonl`],
            ['results.jsonl', `${controlPath}/results.jsonl`]
        ]
    ) {
        exports.push(await writeWorldFleetNativeArtifact(run, { fileName, pathname }));
    }
    const metadata = await writeWorldFleetCompletionMetadata(run, {
        operationFailure: operation.left,
        lifecycleFailure,
        exports
    });
    const failure = operation.left ?? lifecycleFailure ?? metadata.left ??
        exports.find((entry) => entry.failure)?.failure;
    return failure === undefined ? Either.ofRight(true) : Either.ofLeft(failure);
}

async function writeWorldFleetCompletionMetadata(
    run: WorldFleetRun,
    completion: WorldFleetCompletion
): Promise<Either<WorldFleetFailure, true>> {
    const metadata = {
        operationFailure: toWorldFleetSafeFailureMetadata(completion.operationFailure),
        completionLifecycleFailure: toWorldFleetSafeFailureMetadata(completion.lifecycleFailure),
        exports: completion.exports.map((entry) => ({
            ...entry,
            failure: toWorldFleetSafeFailureMetadata(entry.failure)
        })),
        streamCompleteness: 'unverified',
        completenessLimitation:
            'Caller must configure recorder storage. JSONL routes can return bounded fallback; HTTP success does not prove complete storage. Bundle files are previews; runtime snapshots depend on retention.'
    };
    try {
        await run.dependencies.artifacts.writeFile(
            path.join(run.artifactDir, 'evidence-export.json'),
            JSON.stringify(metadata, null, 2) + '\n'
        );
        return Either.ofRight(true);
    }
    catch {
        return Either.ofLeft({ kind: 'export', message: 'Required evidence export failed: evidence-export.json.' });
    }
}

async function writeWorldFleetNativeArtifact(
    run: WorldFleetRun,
    artifact: WorldFleetNativeArtifact
): Promise<WorldFleetEvidenceExport> {
    const response = await readWorldFleetHttpResponse(run, { method: 'GET', pathname: artifact.pathname });
    if (response.left) {
        return {
            fileName: artifact.fileName,
            status: 'unavailable',
            failure: {
                kind: 'export',
                message: `Required evidence export failed: ${artifact.fileName}.`,
                requestFailure: response.left.requestFailure
            }
        };
    }
    try {
        const bytes = new Uint8Array(await response.right!.arrayBuffer());
        await run.dependencies.artifacts.writeFile(path.join(run.artifactDir, artifact.fileName), bytes);
        return { fileName: artifact.fileName, status: 'written', failure: undefined };
    }
    catch {
        return {
            fileName: artifact.fileName,
            status: 'unavailable',
            failure: { kind: 'export', message: 'Required evidence export failed.' }
        };
    }
}

function toWorldFleetSafeFailureMetadata(failure: WorldFleetFailure | undefined): WorldFleetSafeFailureMetadata | null {
    if (failure === undefined) {
        return null;
    }
    return 'requestFailure' in failure && failure.requestFailure !== undefined
        ? failure.requestFailure
        : { code: 'operation-or-write-failed', method: null, pathname: null, httpStatus: null };
}

async function readWorldFleetHttpJson(
    run: WorldFleetRun,
    request: WorldFleetRequest
): Promise<Either<WorldFleetFailure, unknown>> {
    const response = await readWorldFleetHttpResponse(run, request);
    if (response.left) {
        return Either.ofLeft(response.left);
    }
    try {
        return Either.ofRight(await response.right!.json());
    }
    catch {
        return Either.ofLeft({
            kind: 'runtime',
            operation: `${request.method} ${request.pathname}`,
            cause: new Error('Invalid JSON response.')
        });
    }
}

async function readWorldFleetHttpResponse(
    run: WorldFleetRun,
    request: WorldFleetRequest
): Promise<Either<WorldFleetFailure, Response>> {
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
                message: `${operation} failed with ${response.status}.`,
                requestFailure: {
                    code: 'control-http-failed',
                    method: request.method,
                    pathname: request.pathname,
                    httpStatus: response.status
                }
            });
        }
        return Either.ofRight(response);
    }
    catch {
        return Either.ofLeft({
            kind: 'runtime',
            operation,
            cause: new Error('Control request failed.'),
            requestFailure: {
                code: 'control-request-failed',
                method: request.method,
                pathname: request.pathname,
                httpStatus: null
            }
        });
    }
}

function toRunPath(manifest: RallarBlackBoxDistributedRunManifest): string {
    return `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}`;
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

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    main().catch((error: unknown) => {
        console.error(toError(error).message);
        process.exitCode = 1;
    });
}
