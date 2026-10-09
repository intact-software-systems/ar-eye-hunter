import { chromium, expect, test } from '@playwright/test';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, statfs, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, platform, release, totalmem, version } from 'node:os';
import path from 'node:path';

import type { ApiV1Configuration } from '../../../apps/api-v1/src/configuration/api-v1-configuration.ts';
import { readApiV1Configuration } from '../../../apps/api-v1/src/configuration/read-api-v1-configuration.ts';
import {
    createFullStackApiProfileEnvBlock,
    readFullStackApiBaseUrl,
    readFullStackSpaBaseUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-api-server.ts';
import {
    readFullStackControlBaseUrl,
    toFullStackControlWebSocketUrl
} from '../../../apps/rallar-black-box/playwright-full-stack-control-server.ts';
import { runWorldFleetDistributedRecipe } from '../../../apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts';
import type { ControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { decodeControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-distributed-run-snapshot.ts';
import { decodeControlRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis/decode-control-run-snapshot.ts';
import { decodeDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';
import { isJsonRecordValue } from '../../../packages/shared-test/rallar-bb-test/schema/json-schema-validation.ts';

const MANIFEST_PATH = 'apps/rallar-black-box/manifests/hetzner/19-alm-conformance-15-agent-30s.json';
const MANIFEST_SHA256 = '26c8983f3377c841b7ec88d2e6fb1d34b3558e556031087462e962b409715459';
const AGENT_IDS = Array.from({ length: 15 }, (_, index) => `controller-${String(index + 1).padStart(2, '0')}`);

// The lifecycle ceiling contains registration, both existing operator waits, export and owned cleanup.
// It does not change any request, socket, RTC, barrier, recipe or ACK deadline.
test('observes the unchanged 15-agent ALM manifest with complete native evidence', async () => {
    test.skip(
        process.env.RALLAR_BLACK_BOX_FULL_STACK !== '1' || process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS !== '1',
        'Opt-in standalone headless full-stack observation required'
    );
    test.setTimeout(900_000);
    const storageDir = process.env.RALLAR_BLACK_BOX_STORAGE_DIR;
    expect(storageDir, 'Recorder storage must be selected before service startup').toBeTruthy();
    const artifactDir = path.join(storageDir!, 'observation');
    await mkdir(artifactDir, { recursive: true });
    const source = await readFile(MANIFEST_PATH);
    await writeFile(path.join(artifactDir, 'source-manifest.json'), source);
    const manifest = decodeDistributedRunManifest(JSON.parse(source.toString('utf8'))).fold(
        () => {
            throw new Error('Frozen manifest could not be decoded.');
        },
        (decoded) => decoded
    );
    const apiBaseUrl = readFullStackApiBaseUrl();
    const spaBaseUrl = readFullStackSpaBaseUrl();
    const controlBaseUrl = readFullStackControlBaseUrl();
    let worker: ChildProcess | undefined;
    let stage = 'preflight';
    let accepted = false;
    let observationFailed = false;
    let producerCompletedBeforeExport = false;
    let cleanup = 'not-started';
    const harnessAbort = new AbortController();
    const harnessTimer = setTimeout(() => harnessAbort.abort(), 780_000);

    try {
        await writeProvenance(artifactDir, source);
        expect(process.env.CI).toBe('1');
        expect(process.env.RALLAR_BLACK_BOX_FULL_STACK_HEADLESS).toBe('1');
        expect(process.env.RALLAR_BLACK_BOX_API_MODE).toBe('memory');
        expect(process.env.RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE).toBe('16');
        expect(process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_EVENTS).toBe('unbounded');
        expect(process.env.RALLAR_BLACK_BOX_RUNTIME_RETAIN_RESULTS).toBe('unbounded');
        expect(process.env.RALLAR_BLACK_BOX_MANIFEST_PATH ?? MANIFEST_PATH).toBe(MANIFEST_PATH);
        expect(process.env.RALLAR_BLACK_BOX_EXPECTED_AGENT_COUNT ?? '15').toBe('15');
        expect(createHash('sha256').update(source).digest('hex')).toBe(MANIFEST_SHA256);
        for (const baseUrl of [apiBaseUrl, spaBaseUrl, controlBaseUrl]) {
            expect(['localhost', '127.0.0.1', '[::1]']).toContain(new URL(baseUrl).hostname);
        }
        expect(await readdir(storageDir!)).not.toContain('runs');
        expect(await readControlSnapshot(controlBaseUrl, manifest.controlRunId, harnessAbort.signal)).toBeUndefined();

        const credentials: NodeJS.ProcessEnv = {};
        for (let ordinal = 1; ordinal <= 15; ordinal += 1) {
            credentials[`RALLAR_BLACK_BOX_AGENT_${ordinal}_USERNAME`] = AGENT_IDS[ordinal - 1];
            credentials[`RALLAR_BLACK_BOX_AGENT_${ordinal}_PASSWORD`] = randomBytes(24).toString('hex');
        }
        stage = 'registration';
        worker = spawn(process.execPath, ['--import', 'tsx', 'apps/rallar-black-box/scripts/headless-worker.ts'], {
            detached: true,
            stdio: 'ignore',
            env: {
                ...process.env,
                ...credentials,
                RALLAR_BLACK_BOX_SPA_URL: spaBaseUrl,
                RALLAR_BLACK_BOX_CONTROL_URL: toFullStackControlWebSocketUrl(controlBaseUrl),
                RALLAR_CONTROL_HTTP_URL: controlBaseUrl,
                RALLAR_API_BASE_URL: apiBaseUrl,
                RALLAR_BLACK_BOX_RUN_ID: manifest.controlRunId,
                RALLAR_BLACK_BOX_TARGET_DISTRIBUTED_RUN_ID: manifest.distributedRunId,
                RALLAR_BLACK_BOX_AGENT_COUNT: '15',
                RALLAR_BLACK_BOX_AGENT_START_INDEX: '1',
                RALLAR_BLACK_BOX_AGENT_PREFIX: 'controller',
                RALLAR_BLACK_BOX_APPLICATION_ID: manifest.group.applicationId,
                RALLAR_BLACK_BOX_WORKSPACE_ID: manifest.group.workspaceId,
                RALLAR_BLACK_BOX_ROOM_ID: manifest.group.groupId,
                RALLAR_BLACK_BOX_HEADLESS_ENTRY: 'headless',
                RALLAR_BLACK_BOX_REGISTER: 'true',
                RALLAR_BLACK_BOX_EXIT_MODE: 'after-target-distributed-run-terminal',
                RALLAR_BLACK_BOX_IDLE_EXIT_MS: '780000'
            }
        });
        worker.on('error', () => harnessAbort.abort());
        await expect.poll(async () => {
            if (worker!.exitCode !== null || harnessAbort.signal.aborted) {
                throw new Error('Owned worker exited before registration.');
            }
            const snapshot = await readControlSnapshot(controlBaseUrl, manifest.controlRunId, harnessAbort.signal);
            return (snapshot?.agents ?? []).filter((agent) =>
                agent.connected && agent.registeredAtEpochMs !== undefined
            )
                .map((agent) => agent.agentId).sort();
        }, { timeout: 90_000, intervals: [1_000] }).toEqual(AGENT_IDS);

        stage = 'manifest-operation';
        await runWorldFleetDistributedRecipe({
            controlBaseUrl,
            manifestPath: MANIFEST_PATH,
            artifactDir,
            pollMs: 2_000,
            timeoutMs: 330_000,
            prepareEvidenceExport: async () => {
                cleanup = await stopOwnedWorker(worker!);
                if (cleanup !== 'reaped') {
                    throw new Error('Owned worker completion failed.');
                }
                producerCompletedBeforeExport = true;
            },
            fetchFn: (url, init) => fetch(url, { ...init, signal: harnessAbort.signal })
        });
        stage = 'native-acceptance';
        const distributed = decodeControlDistributedRunSnapshot(
            JSON.parse(await readFile(path.join(artifactDir, 'distributed-run.json'), 'utf8'))
        ).fold(() => {
            throw new Error('Native distributed snapshot could not be decoded.');
        }, (decoded) => decoded);
        const control = decodeControlRunSnapshot(
            JSON.parse(await readFile(path.join(artifactDir, 'control-run.json'), 'utf8'))
        ).fold(() => {
            throw new Error('Native control snapshot could not be decoded.');
        }, (decoded) => decoded);
        await requireCompleteRecorder(artifactDir, storageDir!, control);
        expect(distributed.manifest).toEqual(manifest);
        expect(distributed.state).toBe('passed');
        expect(distributed.targetAgentIds.slice().sort()).toEqual(AGENT_IDS);
        expect(distributed.targetResolution?.roleAssignments.map(({ agentId, role }) => ({ agentId, role }))).toEqual(
            AGENT_IDS.map((agentId) => ({ agentId, role: agentId === 'controller-01' ? 'sender' : 'receiver' }))
        );
        expect(distributed.rollup.ok).toBe(true);
        expect(distributed.rollup.summary).toEqual({
            participants: 15,
            readyParticipants: 15,
            passedParticipants: 15,
            failedParticipants: 0,
            recipes: 15,
            passedRecipes: 15,
            failedRecipes: 0,
            groupAssertions: 73,
            passedGroupAssertions: 73,
            failedGroupAssertions: 0,
            blockingFailures: 0
        });
        expect(distributed.rollup.failures).toEqual([]);
        expect(distributed.rollup.groupAssertions).toHaveLength(73);
        for (const assertion of distributed.rollup.groupAssertions!) {
            expect(assertion.ok).toBe(true);
            expect(assertion.missingAgentIds).toEqual([]);
            expect(assertion.violatingAgentIds).toEqual([]);
            expect(assertion.perAgent.every((row) => row.evidence === 'resolved')).toBe(true);
        }
        expect(control.agents.map((agent) => agent.agentId).sort()).toEqual(AGENT_IDS);
        expect(control.agents.every((agent) => Boolean(agent.identity?.clientId && agent.identity?.principalId))).toBe(
            true
        );
        expect(new Set(control.agents.map((agent) => agent.identity?.clientId)).size).toBe(15);
        expect(new Set(control.agents.map((agent) => agent.identity?.principalId)).size).toBe(15);
        const starts = distributed.commandLinks.filter((link) => link.phase === 'start');
        expect(starts).toHaveLength(15);
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
                cleanup = worker ? await stopOwnedWorker(worker) : 'not-started';
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
                    const control = decodeControlRunSnapshot(
                        JSON.parse(await readFile(path.join(artifactDir, 'control-run.json'), 'utf8'))
                    ).fold(() => {
                        throw new Error('Native control snapshot unavailable.');
                    }, (decoded) => decoded);
                    await requireCompleteRecorder(artifactDir, storageDir!, control);
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

async function readControlSnapshot(
    controlBaseUrl: string,
    runId: string,
    signal: AbortSignal
): Promise<ControlRunSnapshot | undefined> {
    const response = await fetch(`${controlBaseUrl}/runs/${encodeURIComponent(runId)}`, { signal });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error('Local control snapshot request failed.');
    }
    return decodeControlRunSnapshot(await response.json()).fold(
        () => {
            throw new Error('Local control snapshot could not be decoded.');
        },
        (decoded) => decoded
    );
}

async function requireCompleteRecorder(
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

async function stopOwnedWorker(worker: ChildProcess): Promise<string> {
    if (!worker.pid) {
        return 'not-started';
    }
    const closed = new Promise<void>((resolve) => worker.once('close', () => resolve()));
    if (worker.exitCode === null && worker.signalCode === null) {
        let naturalExitCeiling: NodeJS.Timeout | undefined;
        await Promise.race([
            closed,
            new Promise<void>((resolve) => {
                naturalExitCeiling = setTimeout(resolve, 20_000);
            })
        ]);
        clearTimeout(naturalExitCeiling);
    }
    const alreadyClosed = worker.exitCode !== null || worker.signalCode !== null;
    try {
        process.kill(-worker.pid, 'SIGTERM');
    }
    catch {
        if (alreadyClosed) {
            return 'reaped';
        }
    }
    if (!alreadyClosed) {
        const forced = setTimeout(() => {
            try {
                process.kill(-worker.pid!, 'SIGKILL');
            }
            catch {}
        }, 10_000);
        let ceiling: NodeJS.Timeout | undefined;
        await Promise.race([
            closed,
            new Promise<void>((resolve) => {
                ceiling = setTimeout(resolve, 20_000);
            })
        ]);
        clearTimeout(forced);
        clearTimeout(ceiling);
    }
    return worker.exitCode !== null || worker.signalCode !== null ? 'reaped' : 'unreaped';
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

async function writeProvenance(artifactDir: string, source: Buffer): Promise<void> {
    const configuration = await readLocalApiConfiguration();
    const disk = await statfs(artifactDir);
    await writeFile(
        path.join(artifactDir, 'provenance.json'),
        JSON.stringify(
            {
                sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
                worktreeDirty: spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.length > 0,
                measuredFiles: await Promise.all([
                    '.github/workflows/github-free-distributed-recipe.yml',
                    'apps/rallar-black-box/playwright.full-stack.config.ts',
                    'apps/rallar-black-box/scripts/run-world-fleet-distributed-recipe.ts',
                    'tests/playwright/rallar-black-box/full-stack-distributed-manifest.spec.ts'
                ].map(async (file) => ({
                    file,
                    sha256: createHash('sha256').update(await readFile(file)).digest('hex')
                }))),
                recorderDirectory: process.env.RALLAR_BLACK_BOX_STORAGE_DIR,
                manifestSha256: createHash('sha256').update(source).digest('hex'),
                cpuCount: cpus().length,
                availableParallelism: availableParallelism(),
                memoryBytes: totalmem(),
                diskBytes: disk.blocks * disk.bsize,
                diskAvailableBytes: disk.bavail * disk.bsize,
                os: { platform: platform(), release: release(), version: version() },
                node: process.version,
                deno: spawnSync('deno', ['--version'], { encoding: 'utf8' }).stdout.trim(),
                chromium: spawnSync(chromium.executablePath(), ['--version'], { encoding: 'utf8' }).stdout.trim(),
                effectiveProfile: configuration.profile.name,
                databaseMode: configuration.database.mode,
                pubSub: configuration.database.pubSub,
                ice: configuration.ice.mode,
                topology: configuration.topology.planning,
                runtimeRetention: { events: 'unbounded', results: 'unbounded' },
                limits: [
                    'Fresh ephemeral PGlite',
                    'Local pubsub and ICE',
                    'Loopback transport',
                    '15 co-located browser contexts',
                    'Runtime versions differ from hosted runs; CPU-only causality is not established'
                ]
            },
            null,
            2
        )
    );
}

async function readLocalApiConfiguration(): Promise<ApiV1Configuration> {
    const profileEnvironment = Object.fromEntries(
        createFullStackApiProfileEnvBlock().split(' ').map((entry) => entry.split('='))
    );
    const resourceUrl = (name: string) => new URL(`../../../apps/api-v1/resources/${name}`, import.meta.url);
    const configuration = await readApiV1Configuration({
        environment: { get: (key) => profileEnvironment[key] ?? process.env[key] },
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
    return configuration;
}
