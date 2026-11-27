import {
    chromium,
    expect,
    test
} from '@playwright/test';
import { spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { StatsFs } from 'node:fs';
import {
    mkdir,
    readdir,
    readFile,
    statfs,
    writeFile
} from 'node:fs/promises';
import {
    availableParallelism,
    cpus,
    loadavg,
    platform,
    release,
    totalmem
} from 'node:os';
import path from 'node:path';

import type { ApiV1Configuration } from '../../../apps/api-v1/src/configuration/api-v1-configuration.ts';
import { readApiV1Configuration } from '../../../apps/api-v1/src/configuration/read-api-v1-configuration.ts';
import {
    createFullStackApiProfileEnvironment,
    readFullStackApiBaseUrl,
    readFullStackSpaBaseUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import { readFullStackControlBaseUrl } from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import { selectAllLocalAlmManifest } from '../../../apps/rallar-black-box/scripts/select-all-local-alm-manifest.mjs';
import {
    createAlmScaleDiagnosticEntries,
    createAlmScaleManifestEntries
} from '../../../apps/rallar-black-box/src/hetzner/create-alm-scale-manifest-entries.ts';
import { toControllerAgentIds } from '../../../apps/rallar-black-box/src/hetzner/hetzner-manifest-entry.ts';
import type { ControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    decodeDistributedRunEnvironment,
    readDistributedRunEnvironment,
    type DistributedRunEnvironment,
    type DistributedRunHostReading
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-performance/distributed-run-environment.ts';
import { decodeDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';
import { isJsonRecordValue } from '../../../packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { Either } from '../../../packages/shared/resilience/Either.ts';

import { computeAllLocalAlmObservationDeadlines } from './compute-all-local-alm-observation-deadlines.ts';
import { expectWorldFleetGroupAssertions, expectWorldFleetManifest } from './expect-world-fleet-manifest.ts';
import {
    readLocalControlRunSnapshot,
    startOwnedHeadlessWorker,
    stopOwnedHeadlessWorker,
    waitForOwnedWorkerAgents,
    type OwnedHeadlessWorkerLaunch
} from './owned-headless-worker.ts';
import {
    readNativeControlRun,
    readNativeDistributedRun,
    runOwnedWorkerManifest
} from './run-owned-worker-manifest.ts';

const REQUIRED_NATIVE_ASSERTION_COUNT = 231;

// The operator's terminal wait is the selected manifest's own terminal timeout, and the harness abort, the owned
// worker's idle exit and this test's limit are derived from it.
test('observes the selected authored ALM manifest with complete native evidence', async () => {
    test.skip(
        process.env.RALLAR_BLACK_BOX_FULL_STACK !== '1' || process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS !== '1',
        'Opt-in standalone headless full-stack observation required'
    );
    const selection = selectAllLocalAlmManifest({
        manifestPath: process.env.RALLAR_BLACK_BOX_MANIFEST_PATH,
        targetAgentCount: process.env.RALLAR_BLACK_BOX_EXPECTED_AGENT_COUNT,
        browserEngine: process.env.BROWSER_ENGINE,
        registerBeforeLogin: process.env.REGISTER_BEFORE_LOGIN
    });
    const agentIds = toControllerAgentIds(selection.participantCount);
    const storageDir = process.env.RALLAR_BLACK_BOX_STORAGE_DIR;
    expect(storageDir, 'Recorder storage must be selected before service startup').toBeTruthy();
    const artifactDir = path.join(storageDir!, 'observation');
    await mkdir(artifactDir, { recursive: true });
    const source = await readFile(path.join(storageDir!, 'source-manifest.json'));
    await writeFile(path.join(artifactDir, 'source-manifest.json'), source);
    const manifest = decodeDistributedRunManifest(JSON.parse(source.toString('utf8'))).fold(
        () => {
            throw new Error('Frozen manifest could not be decoded.');
        },
        (decoded) => decoded
    );
    const authored = [...createAlmScaleManifestEntries(), ...createAlmScaleDiagnosticEntries()]
        .find((entry) => entry.filePath === selection.path && entry.agentCount === selection.participantCount);
    expect(authored, 'Selected ALM source must be authored by the canonical producer').toBeDefined();
    expect(source.toString('utf8')).toBe(`${JSON.stringify(authored!.manifest, null, 2)}\n`);
    const deadlines = computeAllLocalAlmObservationDeadlines(manifest);
    test.setTimeout(deadlines.testTimeoutMs);
    expect(manifest.targetPolicy.expectedParticipantCount).toBe(selection.participantCount);
    expect(manifest.groupAssertions).toHaveLength(REQUIRED_NATIVE_ASSERTION_COUNT);
    const apiBaseUrl = readFullStackApiBaseUrl();
    const spaBaseUrl = readFullStackSpaBaseUrl();
    const controlBaseUrl = readFullStackControlBaseUrl();
    const launch: OwnedHeadlessWorkerLaunch = {
        services: { apiBaseUrl, spaBaseUrl, controlBaseUrl },
        manifest,
        agentCount: selection.participantCount,
        idleExitMs: deadlines.harnessTimeoutMs
    };
    let worker: ChildProcess | undefined;
    let stage = 'preflight';
    let accepted = false;
    let observationFailed = false;
    let producerCompletedBeforeExport = false;
    let cleanup = 'not-started';
    const harnessAbort = new AbortController();
    const harnessTimer = setTimeout(() => harnessAbort.abort(), deadlines.harnessTimeoutMs);

    try {
        await writeProvenance(artifactDir, source, selection.participantCount);
        expect(process.env.CI).toBe('1');
        expect(process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS).toBe('1');
        expect(process.env.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE).toBe(String(selection.meshMinSize));
        expect(process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS).toBe('unbounded');
        expect(process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS).toBe('unbounded');
        expect(process.env.RALLAR_BLACK_BOX_MANIFEST_PATH).toBe(selection.path);
        expect(process.env.RALLAR_BLACK_BOX_EXPECTED_AGENT_COUNT).toBe(String(selection.participantCount));
        for (const baseUrl of [apiBaseUrl, spaBaseUrl, controlBaseUrl]) {
            expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(baseUrl).hostname);
        }
        expect(await readdir(storageDir!)).not.toContain('runs');
        expect(await readLocalControlRunSnapshot(controlBaseUrl, manifest.controlRunId, harnessAbort.signal))
            .toBeUndefined();

        stage = 'registration';
        worker = startOwnedHeadlessWorker(launch);
        worker.on('error', () => harnessAbort.abort());
        await waitForOwnedWorkerAgents(worker, launch, harnessAbort.signal);

        stage = 'manifest-operation';
        const operation = await runOwnedWorkerManifest({
            controlBaseUrl,
            manifestPath: selection.path,
            manifestText: source.toString('utf8'),
            artifactDir,
            rtcCaptureMode: process.env.INPUT_RTC_CAPTURE_MODE,
            terminalTimeoutMs: deadlines.terminalTimeoutMs,
            signal: harnessAbort.signal,
            prepareEvidenceExport: async () => {
                cleanup = await stopOwnedHeadlessWorker(worker!);
                if (cleanup !== 'reaped') {
                    throw new Error('Owned worker completion failed.');
                }
                producerCompletedBeforeExport = true;
            }
        });
        operation.fold((message) => {
            throw new Error(message);
        }, () => undefined);
        stage = 'native-acceptance';
        const distributed = await readNativeDistributedRun(artifactDir);
        const control = await readNativeControlRun(artifactDir);
        await writeRecorderCompleteness(artifactDir, storageDir!, control);
        expectWorldFleetManifest(distributed.manifest, manifest, process.env.INPUT_RTC_CAPTURE_MODE);
        expect(distributed.state).toBe('passed');
        expect(distributed.targetAgentIds.slice().sort()).toEqual(agentIds);
        expect(distributed.targetResolution?.roleAssignments.map(({ agentId, role }) => ({ agentId, role }))).toEqual(
            agentIds.map((agentId) => ({ agentId, role: agentId === 'controller-01' ? 'sender' : 'receiver' }))
        );
        expect(distributed.rollup.ok).toBe(true);
        expect(distributed.rollup.summary).toEqual({
            participants: selection.participantCount,
            readyParticipants: selection.participantCount,
            passedParticipants: selection.participantCount,
            failedParticipants: 0,
            recipes: selection.participantCount,
            passedRecipes: selection.participantCount,
            failedRecipes: 0,
            groupAssertions: REQUIRED_NATIVE_ASSERTION_COUNT,
            passedGroupAssertions: REQUIRED_NATIVE_ASSERTION_COUNT,
            failedGroupAssertions: 0,
            blockingFailures: 0
        });
        expect(distributed.rollup.failures).toEqual([]);
        expectWorldFleetGroupAssertions(manifest, distributed.rollup.groupAssertions);
        expect(control.agents.map((agent) => agent.agentId).sort()).toEqual(agentIds);
        expect(control.agents.every((agent) => Boolean(agent.identity?.clientId && agent.identity?.principalId))).toBe(
            true
        );
        expect(new Set(control.agents.map((agent) => agent.identity?.clientId)).size).toBe(selection.participantCount);
        expect(new Set(control.agents.map((agent) => agent.identity?.principalId)).size).toBe(
            selection.participantCount
        );
        const starts = distributed.commandLinks.filter((link) => link.phase === 'start');
        expect(starts).toHaveLength(selection.participantCount);
        for (const link of starts) {
            expect(link.role).toBe(link.agentId === 'controller-01' ? 'sender' : 'receiver');
            const result = control.results.find((entry) =>
                entry.commandId === link.commandId && entry.agentId === link.agentId
            );
            expect(result?.ok).toBe(true);
            expect(result?.result).toMatchObject({ kind: 'recipe.run', ok: true, status: 'ok' });
        }
        accepted = true;
    }
    catch (error) {
        observationFailed = true;
        throw error;
    }
    finally {
        clearTimeout(harnessTimer);
        harnessAbort.abort();
        try {
            if (cleanup !== 'reaped') {
                cleanup = worker ? await stopOwnedHeadlessWorker(worker) : 'not-started';
            }
            await writeFile(
                path.join(artifactDir, 'observation-result.json'),
                JSON.stringify(
                    {
                        accepted,
                        stage,
                        cleanup,
                        producerCompletedBeforeExport,
                        failureCategory: accepted ? null : stage,
                        distributedEvidence: stage === 'registration' || stage === 'preflight'
                            ? 'not-created'
                            : 'canonical-operator',
                        workerExitCode: worker?.exitCode ?? null,
                        workerSignal: worker?.signalCode ?? null
                    },
                    null,
                    2
                )
            );
            // Before target resolution exists, the control snapshot and recorder are the available native evidence.
            if (stage === 'registration' || stage === 'preflight') {
                await retainAvailableControlSnapshot(controlBaseUrl, manifest.controlRunId, artifactDir);
            }
            else if (stage === 'manifest-operation') {
                try {
                    if (!producerCompletedBeforeExport) {
                        throw new Error('Native export lacked a completed producer boundary.');
                    }
                    await writeRecorderCompleteness(artifactDir, storageDir!, await readNativeControlRun(artifactDir));
                }
                catch {
                    await writeFile(
                        path.join(artifactDir, 'recorder-completeness.json'),
                        JSON.stringify(
                            {
                                verified: false,
                                reason: 'Native recorder completeness checks failed or evidence was unavailable'
                            },
                            null,
                            2
                        )
                    );
                }
            }
            expect(cleanup).not.toBe('unreaped');
        }
        catch {
            if (!observationFailed) {
                throw new Error('Observation completion failed; inspect available native evidence.');
            }
        }
    }
});

async function writeRecorderCompleteness(
    artifactDir: string,
    storageDir: string,
    control: ControlRunSnapshot
): Promise<void> {
    const recorderDir = path.join(storageDir, 'runs', control.runId);
    const results = await readFile(path.join(artifactDir, 'results.jsonl'));
    const events = await readFile(path.join(artifactDir, 'events.jsonl'));
    expect(results.equals(await readFile(path.join(recorderDir, 'results.jsonl')))).toBe(true);
    expect(events.equals(await readFile(path.join(recorderDir, 'events.jsonl')))).toBe(true);
    const resultRows = results.toString('utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row));
    const eventRows = events.toString('utf8').trim().split('\n').filter(Boolean).map((row) => JSON.parse(row));
    const receivedResults = control.agents.reduce((count, agent) => count + agent.receivedResultCount, 0);
    expect(control.events.length).toBe(control.agents.reduce((count, agent) => count + agent.receivedEventCount, 0));
    expect(resultRows).toHaveLength(receivedResults);
    expect(eventRows).toHaveLength(receivedResults + control.events.length);
    // The native snapshot keeps the latest result per command; the recorder keeps every received result.
    expect(new Set(resultRows.map((row) => isJsonRecordValue(row) ? row.commandId : undefined)).size).toBe(
        control.results.length
    );
    for (const result of control.results) {
        expect(
            resultRows.filter((row) =>
                isJsonRecordValue(row) && row.agentId === result.agentId && row.commandId === result.commandId
            )
        ).not.toHaveLength(0);
    }
    await writeFile(
        path.join(artifactDir, 'recorder-completeness.json'),
        JSON.stringify(
            {
                verified: true,
                exportedBytesMatchRecorder: true,
                runtimeCountsMatchReceivedCounts: true,
                results: resultRows.length,
                events: eventRows.length
            },
            null,
            2
        )
    );
}

async function retainAvailableControlSnapshot(
    controlBaseUrl: string,
    runId: string,
    artifactDir: string
): Promise<void> {
    try {
        const response = await fetch(`${controlBaseUrl}/runs/${encodeURIComponent(runId)}`, {
            signal: AbortSignal.timeout(5_000)
        });
        if (!response.ok) {
            throw new Error('Control snapshot unavailable.');
        }
        await writeFile(path.join(artifactDir, 'control-run.json'), new Uint8Array(await response.arrayBuffer()));
    }
    catch {
        await writeFile(path.join(artifactDir, 'control-snapshot-unavailable.json'), '{"available":false}');
    }
}

function readCommandOutput(command: string, args: readonly string[]): Either<string, string> {
    const result = spawnSync(command, [...args], { encoding: 'utf8' });
    if (result.error !== undefined) {
        return Either.ofLeft(`could not start: ${result.error.message}`);
    }
    if (result.status !== 0 || result.stdout === null) {
        return Either.ofLeft(
            `exited with status ${result.status} and ${result.stdout === null ? 'no output' : 'output'}`
        );
    }
    return Either.ofRight(result.stdout);
}

function readEffectiveApiMode(configuration: ApiV1Configuration): 'memory' | 'postgres' {
    const effective = configuration.database.mode === 'postgres'
        ? 'postgres'
        : configuration.database.mode === 'pglite-memory'
        ? 'memory'
        : undefined;
    if (effective === undefined || effective !== process.env.RALLAR_BLACK_BOX_API_MODE) {
        throw new Error(
            `The effective database mode ${configuration.database.mode} does not match RALLAR_BLACK_BOX_API_MODE ${process.env.RALLAR_BLACK_BOX_API_MODE}.`
        );
    }
    return effective;
}

function readHostReading(disk: StatsFs): DistributedRunHostReading {
    return {
        platform: platform(),
        release: release(),
        cpuCount: cpus().length,
        availableParallelism: availableParallelism(),
        memoryBytes: totalmem(),
        diskBytes: disk.blocks * disk.bsize,
        diskAvailableBytes: disk.bavail * disk.bsize,
        oneMinuteLoadAverage: loadavg()[0]
    };
}

interface ReadRunEnvironmentInput {
    readonly artifactDir: string;
    readonly source: Buffer;
    readonly participantCount: number;
    readonly configuration: ApiV1Configuration;
}

async function readRunEnvironment(
    { artifactDir, source, participantCount, configuration }: ReadRunEnvironmentInput
): Promise<DistributedRunEnvironment> {
    const disk = await statfs(artifactDir);
    const read = readDistributedRunEnvironment({
        apiMode: readEffectiveApiMode(configuration),
        profile: configuration.profile.name,
        pubSub: configuration.database.pubSub,
        ice: configuration.ice.mode,
        topology: configuration.topology.planning,
        retention: {
            events: process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS ?? '',
            results: process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS ?? ''
        },
        rtcCaptureMode: process.env.INPUT_RTC_CAPTURE_MODE ?? '',
        manifestSha256: createHash('sha256').update(source).digest('hex'),
        agentCount: participantCount,
        nodeVersion: process.version,
        chromiumExecutablePath: chromium.executablePath(),
        readCommandOutput,
        readHost: () => readHostReading(disk)
    });
    return read.flatMap((issues) => Either.ofLeft(issues), decodeDistributedRunEnvironment).fold(
        (issues) => {
            throw new Error(`The run environment could not be read: ${issues.join('; ')}`);
        },
        (value) => value
    );
}

function readMeasuredFiles(): Promise<readonly { file: string; sha256: string; }[]> {
    return Promise.all([
        '.github/workflows/github-free-distributed-recipe.yml',
        'apps/rallar-black-box/playwright.full-stack.config.ts',
        'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
        'tests/playwright/rallar-black-box/full-stack-distributed-manifest.spec.ts',
        'tests/playwright/rallar-black-box/owned-headless-worker.ts',
        'tests/playwright/rallar-black-box/run-owned-worker-manifest.ts'
    ].map(async (file) => ({
        file,
        sha256: createHash('sha256').update(await readFile(file)).digest('hex')
    })));
}

function toProvenanceLimits(environment: DistributedRunEnvironment): readonly string[] {
    return [
        environment.apiMode === 'postgres' ? 'Ephemeral Postgres service container' : 'Fresh ephemeral PGlite',
        environment.apiMode === 'postgres' ? 'Postgres pubsub' : 'Local pubsub and ICE',
        'Loopback transport',
        `${environment.agentCount} co-located browser contexts`,
        'Runtime versions differ from hosted runs; CPU-only causality is not established'
    ];
}

async function writeProvenance(artifactDir: string, source: Buffer, participantCount: number): Promise<void> {
    const configuration = await readLocalApiConfiguration();
    const environment = await readRunEnvironment({ artifactDir, source, participantCount, configuration });
    await writeFile(
        path.join(artifactDir, 'provenance.json'),
        JSON.stringify(
            {
                environment,
                measuredFiles: await readMeasuredFiles(),
                recorderDirectory: process.env.RALLAR_BLACK_BOX_STORAGE_DIR,
                limits: toProvenanceLimits(environment)
            },
            null,
            2
        )
    );
}

async function readLocalApiConfiguration(): Promise<ApiV1Configuration> {
    const profileEnvironment = createFullStackApiProfileEnvironment();
    const resourceUrl = (name: string) => new URL(`../../../apps/api-v1/resources/${name}`, import.meta.url);
    return readApiV1Configuration({
        environment: { ...process.env, ...profileEnvironment },
        hardwareConcurrency: availableParallelism(),
        readTextFile: (url) => readFile(url, 'utf8'),
        defaultsUrl: resourceUrl('configuration/defaults-config.json'),
        profileUrls: {
            dev: resourceUrl('configuration/dev-config.json'),
            prod: resourceUrl('configuration/prod-config.json'),
            'prod-in-memory': resourceUrl('configuration/prod-in-memory-config.json'),
            'prod-hardened': resourceUrl('configuration/prod-hardened-config.json')
        },
        staticClientsUrl: resourceUrl('authorised-clients.json')
    });
}
