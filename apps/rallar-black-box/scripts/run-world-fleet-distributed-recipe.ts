import {
    mkdir,
    readFile,
    writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { JsonComparisonObject, JsonValue } from '@shared-test/json-compare/compare-json-values.ts';
import { decodeDistributedRunManifest } from '@shared-test/rallar-bb-test/distributed-run-validation.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES,
    type RallarBlackBoxDistributedRunManifest,
    type RallarBlackBoxDistributedRunState
} from '@shared-test/rallar-bb-test/distributed-run.ts';
import { Either } from '@shared/resilience/Either.ts';

import { readManifestRunnerOptions } from './read-manifest-runner-options.ts';
import { writeManifestArtifactFiles } from './write-manifest-artifact-files.ts';

export interface WorldFleetDistributedRecipeRunnerOptions {
    readonly controlBaseUrl: string;
    readonly manifestPath: string;
    readonly controlRunId?: string;
    readonly token?: string;
    readonly artifactDir?: string;
    readonly pollMs: number;
    readonly timeoutMs: number;
    readonly fetchFn?: typeof fetch;
}

interface DistributedRunObservation {
    readonly state: RallarBlackBoxDistributedRunState;
}

interface EvidenceExportResult {
    readonly fileName: string;
    readonly status: 'written' | 'unavailable';
    readonly failure: SafeFailureMetadata | null;
}

interface NativeArtifactRequestDto {
    readonly artifactDir: string;
    readonly fileName: string;
    readonly pathname: string;
}

interface ManifestCompletionDto {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly artifactDir: string;
    readonly operationFailure: Error | undefined;
}

interface SafeFailureMetadata {
    readonly code: string;
    readonly method: string | null;
    readonly pathname: string | null;
    readonly httpStatus: number | null;
}

class ControlRequestFailure extends Error {
    readonly metadata: SafeFailureMetadata;

    constructor(metadata: SafeFailureMetadata) {
        super(
            metadata.httpStatus === null
                ? `${metadata.method} ${metadata.pathname} request failed.`
                : `${metadata.method} ${metadata.pathname} failed with ${metadata.httpStatus}.`
        );
        this.metadata = metadata;
    }
}

const TERMINAL_STATES = new Set(['passed', 'failed', 'cancelled', 'timed-out']);

async function main(): Promise<void> {
    await runWorldFleetDistributedRecipe(readManifestRunnerOptions(process.argv.slice(2), process.env));
}

export async function runWorldFleetDistributedRecipe(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions
): Promise<void> {
    const sourceManifest = await readFile(runnerOptions.manifestPath, 'utf8');
    const manifestValue: JsonValue = JSON.parse(sourceManifest);
    if (!isRecord(manifestValue)) {
        throw new Error('Invalid distributed manifest.');
    }
    const manifest = decodeDistributedRunManifest(
        applyWorldFleetControlRunIdOverride(manifestValue, runnerOptions.controlRunId)
    ).fold(
        () => {
            throw new Error('Invalid distributed manifest.');
        },
        (decoded) => decoded
    );
    const artifactDir = runnerOptions.artifactDir ?? path.join('artifacts', 'world-fleet', manifest.distributedRunId);
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, 'source-manifest.json'), sourceManifest);

    let operationFailure: Error | undefined;
    try {
        await startManifestDistributedRun(runnerOptions, manifest);
        const terminal = await waitForState(runnerOptions, manifest.distributedRunId, 'terminal');
        if (terminal.state !== 'passed') {
            throw new Error(`Distributed run did not pass: ${terminal.state}.`);
        }
    }
    catch (error) {
        operationFailure = error instanceof Error ? error : new Error('Manifest operation failed.');
    }

    await writeManifestCompletionEvidence(runnerOptions, { manifest, artifactDir, operationFailure });
}

async function writeManifestCompletionEvidence(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    completion: ManifestCompletionDto
): Promise<void> {
    const evidenceExport = await writeDistributedRunEvidence(
        runnerOptions,
        completion.manifest,
        completion.artifactDir
    );
    await writeFile(
        path.join(completion.artifactDir, 'evidence-export.json'),
        JSON.stringify(
            {
                operationFailure: completion.operationFailure
                    ? toSafeFailureMetadata(completion.operationFailure)
                    : null,
                exports: evidenceExport,
                streamCompleteness: 'unverified',
                completenessLimitation:
                    'Caller must configure recorder storage. JSONL routes can return bounded fallback; HTTP success does not prove complete storage. Bundle files are previews; runtime snapshots depend on retention.'
            },
            null,
            2
        ) + '\n'
    ).catch(() => {
        if (!completion.operationFailure) {
            throw new Error('Required evidence export failed: evidence-export.json.');
        }
    });
    if (completion.operationFailure) {
        throw completion.operationFailure;
    }
    if (evidenceExport.some((result) => result.status === 'unavailable')) {
        throw new Error('Required evidence export failed.');
    }
}

export function applyWorldFleetControlRunIdOverride(
    manifest: RallarBlackBoxDistributedRunManifest,
    controlRunId?: string
): RallarBlackBoxDistributedRunManifest;
export function applyWorldFleetControlRunIdOverride(
    manifest: JsonComparisonObject,
    controlRunId?: string
): JsonComparisonObject;
export function applyWorldFleetControlRunIdOverride(
    manifest: RallarBlackBoxDistributedRunManifest | JsonComparisonObject,
    controlRunId?: string
): RallarBlackBoxDistributedRunManifest | JsonComparisonObject {
    const cleanControlRunId = controlRunId?.trim();
    return cleanControlRunId ? { ...manifest, controlRunId: cleanControlRunId } : manifest;
}

async function startManifestDistributedRun(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    manifest: RallarBlackBoxDistributedRunManifest
): Promise<void> {
    const resolution = await readControlJson(runnerOptions, '/distributed-runs/resolve-targets', {
        method: 'POST',
        body: JSON.stringify({ manifest })
    });
    if (!isRecord(resolution) || !isRecord(resolution.summary) || typeof resolution.summary.selected !== 'number') {
        throw new Error('Invalid target preflight response.');
    }
    const expected = manifest.targetPolicy.expectedParticipantCount;
    if (expected !== undefined && resolution.summary.selected !== expected) {
        throw new Error(`Target preflight mismatch: selected ${resolution.summary.selected}, expected ${expected}.`);
    }
    await readControlJson(runnerOptions, '/distributed-runs', { method: 'POST', body: JSON.stringify({ manifest }) });
    const runPath = `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}`;
    await readControlJson(runnerOptions, `${runPath}/stage`, { method: 'POST', body: '{}' });
    const ready = await waitForState(runnerOptions, manifest.distributedRunId, 'ready');
    if (ready.state !== 'ready' && ready.state !== 'running') {
        throw new Error(`Distributed run reached ${ready.state} before start.`);
    }
    if (ready.state === 'ready') {
        await readControlJson(runnerOptions, `${runPath}/start`, { method: 'POST', body: '{}' });
    }
}

async function waitForState(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    distributedRunId: string,
    phase: 'ready' | 'terminal'
): Promise<DistributedRunObservation> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= runnerOptions.timeoutMs) {
        const snapshot = await readControlJson(
            runnerOptions,
            `/distributed-runs/${encodeURIComponent(distributedRunId)}`,
            { method: 'GET' }
        );
        const state = RALLAR_BLACK_BOX_DISTRIBUTED_RUN_STATES.find((candidate) => candidate === snapshot.state);
        if (state === undefined) {
            throw new Error('Invalid distributed run snapshot.');
        }
        if (
            TERMINAL_STATES.has(state) ||
            (phase === 'ready' && (state === 'ready' || state === 'running'))
        ) {
            return { state };
        }
        await delay(runnerOptions.pollMs);
    }
    throw new Error(`Timed out waiting for distributed run ${distributedRunId}.`);
}

async function writeDistributedRunEvidence(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    manifest: RallarBlackBoxDistributedRunManifest,
    artifactDir: string
): Promise<readonly EvidenceExportResult[]> {
    const distributedPath = `/distributed-runs/${encodeURIComponent(manifest.distributedRunId)}`;
    const controlPath = `/runs/${encodeURIComponent(manifest.controlRunId)}`;
    const bundleExport = await writeArtifactBundle(runnerOptions, `${distributedPath}/artifacts`, artifactDir);
    const exports = [bundleExport];
    for (
        const [fileName, pathname] of [
            ['distributed-run.json', distributedPath],
            ['control-run.json', controlPath],
            ['events.jsonl', `${controlPath}/events.jsonl`],
            ['results.jsonl', `${controlPath}/results.jsonl`]
        ]
    ) {
        exports.push(await writeNativeArtifact(runnerOptions, { artifactDir, fileName, pathname }));
    }
    return exports;
}

async function writeArtifactBundle(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    pathname: string,
    artifactDir: string
): Promise<EvidenceExportResult> {
    try {
        const bundle = await readControlJson(runnerOptions, pathname, { method: 'GET' });
        const status = await writeManifestArtifactFiles(artifactDir, bundle);
        return {
            fileName: 'artifact-bundle.json',
            status,
            failure: status === 'unavailable' ? toSafeFailureMetadata(new Error()) : null
        };
    }
    catch (error) {
        return {
            fileName: 'artifact-bundle.json',
            status: 'unavailable',
            failure: toSafeFailureMetadata(error instanceof Error ? error : new Error('Evidence export failed.'))
        };
    }
}

async function writeNativeArtifact(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    artifact: NativeArtifactRequestDto
): Promise<EvidenceExportResult> {
    const response = await readControlResponse(runnerOptions, artifact.pathname, { method: 'GET' });
    if (response.left) {
        return { fileName: artifact.fileName, status: 'unavailable', failure: toSafeFailureMetadata(response.left) };
    }
    try {
        const nativeContents = await response.fold(
            (error) => {
                throw error;
            },
            (nativeResponse) => nativeResponse.arrayBuffer()
        );
        await writeFile(path.join(artifact.artifactDir, artifact.fileName), new Uint8Array(nativeContents));
        return { fileName: artifact.fileName, status: 'written', failure: null };
    }
    catch {
        return { fileName: artifact.fileName, status: 'unavailable', failure: toSafeFailureMetadata(new Error()) };
    }
}

async function readControlJson(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    pathname: string,
    request: RequestInit
): Promise<JsonComparisonObject> {
    const response = (await readControlResponse(runnerOptions, pathname, request)).fold(
        (error) => {
            throw error;
        },
        (nativeResponse) => nativeResponse
    );
    try {
        const parsed: JsonValue = JSON.parse(await response.text());
        if (!isRecord(parsed)) {
            throw new Error('Expected a JSON object.');
        }
        return parsed;
    }
    catch {
        throw new Error(`Invalid JSON response from ${request.method} ${pathname}.`);
    }
}

async function readControlResponse(
    runnerOptions: WorldFleetDistributedRecipeRunnerOptions,
    pathname: string,
    request: RequestInit
): Promise<Either<Error, Response>> {
    try {
        const response = await (runnerOptions.fetchFn ?? fetch)(
            new URL(pathname, normalizedBaseUrl(runnerOptions.controlBaseUrl)),
            {
                ...request,
                headers: {
                    'Content-Type': 'application/json',
                    ...(runnerOptions.token ? { Authorization: `Bearer ${runnerOptions.token}` } : {})
                }
            }
        );
        if (!response.ok) {
            return Either.ofLeft(
                new ControlRequestFailure({
                    code: 'control-http-failed',
                    method: request.method ?? 'GET',
                    pathname,
                    httpStatus: response.status
                })
            );
        }
        return Either.ofRight(response);
    }
    catch {
        return Either.ofLeft(
            new ControlRequestFailure({
                code: 'control-request-failed',
                method: request.method ?? 'GET',
                pathname,
                httpStatus: null
            })
        );
    }
}

function isRecord(value: JsonValue | undefined): value is JsonComparisonObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toSafeFailureMetadata(error: Error): SafeFailureMetadata {
    return error instanceof ControlRequestFailure
        ? error.metadata
        : { code: 'operation-or-write-failed', method: null, pathname: null, httpStatus: null };
}

function normalizedBaseUrl(value: string): URL {
    const url = new URL(value);
    if (!url.pathname.endsWith('/')) {
        url.pathname = `${url.pathname}/`;
    }
    return url;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        console.error(
            'Manifest operation failed; inspect the retained evidence-export.json for safe failure metadata.'
        );
        process.exitCode = 1;
    });
}
