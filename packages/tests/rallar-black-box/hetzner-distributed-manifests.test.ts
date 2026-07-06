import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER,
    HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER,
    buildHetznerDistributedManifestCatalog,
} from '../../../apps/rallar-black-box/src/hetzner-distributed-manifests.ts';
import { distributedArtifactSnapshotsFromFiles } from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import { deriveDistributedRunMonitor } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import { deriveRtcDiagnostics, deriveRtcPerformanceView } from '../../../apps/rallar-black-box/src/rtc-diagnostics.ts';
import {
    RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA,
    validateJsonSchema,
} from '../../../packages/shared-test/rallar-bb-test/schema.ts';
import {
    validateDistributedRunManifestContract,
    type RallarBlackBoxDistributedRunManifest,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import type {
    RallarBlackBoxTestEvent,
    RallarBlackBoxTestState,
} from '../../../packages/shared-test/rallar-bb-test/types.ts';

const repoRoot = path.resolve(__dirname, '../../..');

function allValues(value: unknown): readonly string[] {
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap(allValues);
    }
    if (value && typeof value === 'object') {
        return Object.values(value).flatMap(allValues);
    }
    return [];
}

type ManifestCommand = Readonly<{
    kind?: string;
    commandId?: string;
    commands?: readonly ManifestCommand[];
    groups?: readonly Readonly<{
        commands?: readonly ManifestCommand[];
    }>[];
    readiness?: Readonly<{
        minReadyPeers?: number;
        timeoutMs?: number;
        intervalMs?: number;
    }>;
    count?: number;
    intervalMs?: number;
    maxInFlight?: number;
    continueOnSendFailure?: boolean;
    metadata?: Record<string, unknown>;
    thresholds?: Record<string, unknown>;
}>;

function manifestCommands(manifest: RallarBlackBoxDistributedRunManifest): readonly ManifestCommand[] {
    const walk = (commands: readonly ManifestCommand[]): readonly ManifestCommand[] =>
        commands.flatMap(command => [
            command,
            ...walk(command.commands ?? []),
            ...(command.groups ?? []).flatMap(group => walk(group.commands ?? [])),
        ]);

    return manifest.recipes.flatMap(selection => walk((selection.recipe?.commands ?? []) as readonly ManifestCommand[]));
}

describe('Hetzner distributed manifest catalog', () => {
    it('defines the mainline green, extended, and diagnostic manifest groups separately', () => {
        const catalog = buildHetznerDistributedManifestCatalog();
        const greenPaths = catalog.filter(entry => entry.mainline).map(entry => entry.filePath);
        const extendedPaths = catalog.filter(entry => !entry.mainline && !entry.diagnostic).map(entry => entry.filePath);
        const diagnosticPaths = catalog.filter(entry => entry.diagnostic).map(entry => entry.filePath);

        expect(greenPaths).toEqual(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER);
        expect(greenPaths).toEqual([
            'apps/rallar-black-box/manifests/hetzner/01-health-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/02-composite-evidence-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json',
        ]);
        expect(extendedPaths).toEqual(HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER);
        expect(extendedPaths).toEqual([
            'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json',
            'apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json',
            'apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json',
            'apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json',
            'apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json',
            'apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json',
        ]);
        expect(diagnosticPaths).toEqual([
            'apps/rallar-black-box/manifests/hetzner/diagnostic/barrier-health-2-agent.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/expected-failure-1-agent.json',
            'apps/rallar-black-box/manifests/hetzner/diagnostic/rtc-realtime-2-agent-20hz-stress.json',
        ]);
    });

    it('writes checked-in JSON that matches the generated catalog exactly', async () => {
        for (const entry of buildHetznerDistributedManifestCatalog()) {
            const expectedJson = `${JSON.stringify(entry.manifest, null, 2)}\n`;
            const actualJson = await readFile(path.join(repoRoot, entry.filePath), 'utf8');
            expect(actualJson).toBe(expectedJson);
        }
    });

    it('validates every checked-in manifest against schema and contract', async () => {
        for (const entry of buildHetznerDistributedManifestCatalog()) {
            const manifest = JSON.parse(
                await readFile(path.join(repoRoot, entry.filePath), 'utf8'),
            ) as RallarBlackBoxDistributedRunManifest;
            const schemaResult = validateJsonSchema(RALLAR_BLACK_BOX_DISTRIBUTED_RUN_MANIFEST_SCHEMA, manifest);
            const contractResult = validateDistributedRunManifestContract(manifest);

            expect(schemaResult, entry.filePath).toMatchObject({ ok: true });
            expect(contractResult, entry.filePath).toMatchObject({ ok: true });
            expect(manifest.group).toEqual({
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'hetzner-headless-room',
            });
            if (entry.filePath.endsWith('/05e-rtc-realtime-stability-2-agent-30s-20hz.json')) {
                expect(manifest.targetPolicy).toMatchObject({
                    mode: 'role-map',
                    expectedParticipantCount: entry.agentCount,
                    roles: {
                        sender: ['controller-01'],
                        receiver: ['controller-02'],
                    },
                });
                expect(manifest.roleAssignments).toEqual([
                    { role: 'sender', agentId: 'controller-01', required: true },
                    { role: 'receiver', agentId: 'controller-02', required: true },
                ]);
                expect(manifest.recipes.map(selection => selection.role)).toEqual(['sender', 'receiver']);
            } else {
                expect(manifest.targetPolicy).toMatchObject({
                    mode: 'all-online-group-members',
                    expectedParticipantCount: entry.agentCount,
                });
            }
            expect(manifest.artifactPolicy).toMatchObject({
                retainArtifacts: true,
                includeDistributedMetadata: true,
                includeEventJsonl: true,
                includeResultJsonl: true,
                includeFailureBundle: true,
            });
            expect(manifest.recipes.length).toBeGreaterThan(0);
            expect(manifest.recipes.every(selection => Boolean(selection.recipe))).toBe(true);
        }
    });

    it('keeps mainline green manifests secret-free and marks the expected-failure diagnostic only', () => {
        const catalog = buildHetznerDistributedManifestCatalog();
        const greenEntries = catalog.filter(entry => entry.mainline);
        const expectedFailure = catalog.find(entry => entry.filePath.endsWith('/expected-failure-1-agent.json'));

        expect(expectedFailure?.manifest.metadata).toMatchObject({
            diagnostic: true,
            expectedFailure: true,
        });
        expect(greenEntries.every(entry => entry.manifest.metadata?.expectedFailure !== true)).toBe(true);

        for (const entry of catalog) {
            const strings = allValues(entry.manifest);
            expect(strings.some(value => /bearer|password|secret|token/i.test(value)), entry.filePath).toBe(false);
        }
    });

    it('matches expected participant counts in filenames', () => {
        for (const entry of buildHetznerDistributedManifestCatalog()) {
            const match = entry.filePath.match(/-(\d+)-agent/);
            expect(match?.[1], entry.filePath).toBe(String(entry.agentCount));
            expect(entry.manifest.targetPolicy.expectedParticipantCount).toBe(entry.agentCount);
        }
    });

    it('requires explicit RTC readiness before non-diagnostic live manifests send RTC traffic', () => {
        const expectedReadyPeers = new Map([
            ['apps/rallar-black-box/manifests/hetzner/03-rtc-smoke-2-agent.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json', 1],
            ['apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json', 2],
        ]);

        for (const entry of buildHetznerDistributedManifestCatalog().filter(candidate => !candidate.diagnostic)) {
            const commands = manifestCommands(entry.manifest);
            const sendsRtc = commands.some(command => command.kind === 'rtc.send' || command.kind === 'rtc.stream');
            if (!sendsRtc) {
                expect(expectedReadyPeers.has(entry.filePath)).toBe(false);
                continue;
            }

            const connect = commands.find(command => command.kind === 'rtc.connect');
            expect(connect?.readiness, entry.filePath).toEqual({
                minReadyPeers: expectedReadyPeers.get(entry.filePath),
                timeoutMs: 10_000,
                intervalMs: 100,
            });
        }
    });

    it('uses lower-rate rtc.stream baselines for non-diagnostic realtime Hetzner manifests', () => {
        type ExpectedStream = Readonly<{
            rateHz: number;
            intervalMs: number;
            durationSeconds: number;
            frameCount: number;
            maxDroppedFrames: number;
            maxP95SendDurationMs?: number;
            maxP99SendDurationMs?: number;
            minSendSuccessRatio: number;
            maxInFlight: number;
        }>;
        const expectedStreams = new Map<string, ExpectedStream>([
            ['apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json', {
                rateHz: 5,
                intervalMs: 200,
                durationSeconds: 5,
                frameCount: 25,
                maxDroppedFrames: 2,
                minSendSuccessRatio: 0.95,
                maxInFlight: 8,
            }],
            ['apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json', {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 5,
                frameCount: 50,
                maxDroppedFrames: 5,
                minSendSuccessRatio: 0.99,
                maxInFlight: 64,
            }],
            ['apps/rallar-black-box/manifests/hetzner/05b-rtc-realtime-stability-2-agent-30s.json', {
                rateHz: 5,
                intervalMs: 200,
                durationSeconds: 30,
                frameCount: 150,
                maxDroppedFrames: 2,
                minSendSuccessRatio: 0.95,
                maxInFlight: 8,
            }],
            ['apps/rallar-black-box/manifests/hetzner/05c-rtc-realtime-stability-2-agent-30s-10hz.json', {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 30,
                frameCount: 300,
                maxDroppedFrames: 15,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000,
                minSendSuccessRatio: 0.95,
                maxInFlight: 64,
            }],
            ['apps/rallar-black-box/manifests/hetzner/05d-rtc-realtime-stability-2-agent-30s-15hz.json', {
                rateHz: 15,
                intervalMs: 67,
                durationSeconds: 30,
                frameCount: 450,
                maxDroppedFrames: 22,
                maxP95SendDurationMs: 200,
                maxP99SendDurationMs: 1000,
                minSendSuccessRatio: 0.95,
                maxInFlight: 64,
            }],
            ['apps/rallar-black-box/manifests/hetzner/05e-rtc-realtime-stability-2-agent-30s-20hz.json', {
                rateHz: 20,
                intervalMs: 50,
                durationSeconds: 30,
                frameCount: 600,
                maxDroppedFrames: 30,
                maxP95SendDurationMs: 2500,
                maxP99SendDurationMs: 4000,
                minSendSuccessRatio: 0.95,
                maxInFlight: 64,
            }],
            ['apps/rallar-black-box/manifests/hetzner/06-rtc-realtime-3-agent-15s.json', {
                rateHz: 10,
                intervalMs: 100,
                durationSeconds: 15,
                frameCount: 150,
                maxDroppedFrames: 15,
                minSendSuccessRatio: 0.99,
                maxInFlight: 64,
            }],
        ]);

        for (const entry of buildHetznerDistributedManifestCatalog().filter(candidate => !candidate.diagnostic)) {
            const commands = manifestCommands(entry.manifest);
            const stream = commands.find(command => command.kind === 'rtc.stream');
            const highRateLoop = commands.find(command =>
                command.kind === 'loop' &&
                typeof command.count === 'number' &&
                command.count >= 20 &&
                typeof command.intervalMs === 'number' &&
                command.intervalMs <= 100 &&
                (command.commands ?? []).some(child => child.kind === 'rtc.send')
            );

            if (!expectedStreams.has(entry.filePath)) {
                expect(stream, entry.filePath).toBeUndefined();
                continue;
            }

            const expectedStream = expectedStreams.get(entry.filePath)!;
            const expectedThresholds: Record<string, number> = {
                minSendSuccessRatio: expectedStream.minSendSuccessRatio,
                maxDroppedFrames: expectedStream.maxDroppedFrames,
            };
            if (expectedStream.maxP95SendDurationMs !== undefined) {
                expectedThresholds.maxP95SendDurationMs = expectedStream.maxP95SendDurationMs;
            }
            if (expectedStream.maxP99SendDurationMs !== undefined) {
                expectedThresholds.maxP99SendDurationMs = expectedStream.maxP99SendDurationMs;
            }

            expect(stream, entry.filePath).toMatchObject({
                kind: 'rtc.stream',
                commandId: 'rtc-realtime-position-stream',
                continueOnSendFailure: true,
                count: expectedStream.frameCount,
                intervalMs: expectedStream.intervalMs,
                maxInFlight: expectedStream.maxInFlight,
                thresholds: expectedThresholds,
                metadata: {
                    realtime: {
                        rateHz: expectedStream.rateHz,
                        durationSeconds: expectedStream.durationSeconds,
                        frameCount: expectedStream.frameCount,
                    },
                },
            });
            expect(highRateLoop, entry.filePath).toBeUndefined();
        }
    });

    it('keeps strict 20 Hz realtime stress coverage as a diagnostic manifest', () => {
        const entry = buildHetznerDistributedManifestCatalog()
            .find(candidate => candidate.filePath.endsWith('/diagnostic/rtc-realtime-2-agent-20hz-stress.json'));
        expect(entry).toBeDefined();
        expect(entry?.diagnostic).toBe(true);
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER).not.toContain(entry?.filePath);
        expect(entry?.manifest.metadata).toMatchObject({
            diagnostic: true,
            stress: true,
            expectedFailure: false,
        });

        const stream = manifestCommands(entry?.manifest as RallarBlackBoxDistributedRunManifest)
            .find(command => command.kind === 'rtc.stream');
        expect(stream).toMatchObject({
            count: 100,
            intervalMs: 50,
            continueOnSendFailure: true,
            thresholds: {
                minSendSuccessRatio: 0.99,
                maxDroppedFrames: 20,
            },
            metadata: {
                realtime: {
                    rateHz: 20,
                    frameCount: 100,
                },
            },
        });
    });

    it('keeps the lower-risk realtime stability manifest in mainline before heavier extended baselines', () => {
        const catalog = buildHetznerDistributedManifestCatalog();
        const stabilityPath = 'apps/rallar-black-box/manifests/hetzner/05a-rtc-realtime-stability-2-agent-5s.json';
        const baselinePath = 'apps/rallar-black-box/manifests/hetzner/05-rtc-realtime-2-agent-5s.json';
        const stability = catalog.find(entry =>
            entry.filePath === stabilityPath
        );

        expect(stability).toBeDefined();
        expect(stability?.mainline).toBe(true);
        expect(stability?.diagnostic).toBe(false);
        expect(stability?.agentCount).toBe(2);
        expect(HETZNER_DISTRIBUTED_MANIFEST_GREEN_ORDER.at(-1)).toBe(stabilityPath);
        expect(HETZNER_DISTRIBUTED_MANIFEST_EXTENDED_ORDER[0]).toBe(baselinePath);
        expect(stability?.manifest.metadata).toMatchObject({
            manifestSuite: 'hetzner-distributed',
            diagnostic: false,
            expectedFailure: false,
        });
        expect(stability?.manifest.recipes[0]).toMatchObject({
            recipeId: 'rtc-realtime-stability',
            profile: 'rtc',
        });
    });

    it('keeps provider parity manifests from replacing headless auth with restore-only demo auth', () => {
        const catalog = buildHetznerDistributedManifestCatalog();
        const parity = catalog.find(entry =>
            entry.filePath === 'apps/rallar-black-box/manifests/hetzner/04-provider-parity-2-agent.json'
        );
        const configure = parity?.manifest.recipes[0]?.recipe.commands[0];

        expect(parity).toBeDefined();
        expect(configure).toMatchObject({ kind: 'configure' });
        if (!configure || configure.kind !== 'configure') {
            throw new Error('Expected provider parity manifest to start with configure.');
        }

        const rallar = configure.config.rallar;
        expect(rallar).not.toMatchObject({ username: expect.any(String) });
        expect(rallar).not.toMatchObject({ password: expect.any(String) });
        expect(rallar).not.toMatchObject({ token: expect.any(String) });
        expect(rallar).not.toMatchObject({ restoreSession: true });
        expect(JSON.stringify(parity?.manifest)).toContain('{rtc.readyPeerIds[0]}');
        expect(JSON.stringify(parity?.manifest)).toContain('{rtc.readyPeerIds}');
        expect(JSON.stringify(parity?.manifest)).not.toContain('bob-session');
        expect(JSON.stringify(parity?.manifest)).not.toContain('charlie-session');
    });

    it('feeds Hetzner CI artifacts into SPA monitor and RTC performance views', () => {
        const entry = buildHetznerDistributedManifestCatalog()
            .find(candidate => candidate.filePath.endsWith('/05-rtc-realtime-2-agent-5s.json'));
        expect(entry).toBeDefined();
        const manifest = entry?.manifest as RallarBlackBoxDistributedRunManifest;
        const distributedRunId = 'dist-hetzner-ci-import';
        const controlRunId = 'gh-ci-import';
        const agentIds = ['controller-01', 'controller-02'];
        const distributedRun = {
            distributedRunId,
            controlRunId,
            state: 'passed',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 5_500,
            stagedAtEpochMs: 1_200,
            startedAtEpochMs: 2_000,
            completedAtEpochMs: 5_500,
            targetAgentIds: agentIds,
            manifest: {
                ...manifest,
                distributedRunId,
                controlRunId,
            },
            commandLinks: [
                { phase: 'stage', agentId: 'controller-01', commandId: 'stage-controller-01', recipeId: 'rtc-realtime', queuedAtEpochMs: 1_210 },
                { phase: 'stage', agentId: 'controller-02', commandId: 'stage-controller-02', recipeId: 'rtc-realtime', queuedAtEpochMs: 1_220 },
                { phase: 'start', agentId: 'controller-01', commandId: 'start-controller-01', recipeId: 'rtc-realtime', queuedAtEpochMs: 2_010 },
                { phase: 'start', agentId: 'controller-02', commandId: 'start-controller-02', recipeId: 'rtc-realtime', queuedAtEpochMs: 2_020 },
            ],
            rollup: {
                state: 'passed',
                ok: true,
                summary: {
                    participants: 2,
                    requiredParticipants: 2,
                    readyParticipants: 2,
                    passedParticipants: 2,
                    failedParticipants: 0,
                    recipes: 1,
                    requiredRecipes: 1,
                    passedRecipes: 2,
                    failedRecipes: 0,
                    blockingFailures: 0,
                },
                failures: [],
            },
        };
        const controlRun = {
            runId: controlRunId,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 5_500,
            agents: agentIds.map(agentId => ({
                agentId,
                connected: true,
                status: 'connected',
                lastSeenAtEpochMs: 5_500,
                lastHeartbeatAtEpochMs: 5_500,
                identity: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room',
                },
            })),
            commands: [
                controlCommand(controlRunId, 'controller-01', 'stage-controller-01', 1_210, 40),
                controlCommand(controlRunId, 'controller-02', 'stage-controller-02', 1_220, 60),
                controlCommand(controlRunId, 'controller-01', 'start-controller-01', 2_010, 180),
                controlCommand(controlRunId, 'controller-02', 'start-controller-02', 2_020, 420),
            ],
            results: [
                controlResult(controlRunId, 'controller-01', 'stage-controller-01', 1_250, 40),
                controlResult(controlRunId, 'controller-02', 'stage-controller-02', 1_280, 60),
                controlResult(controlRunId, 'controller-01', 'start-controller-01', 2_190, 180),
                controlResult(controlRunId, 'controller-02', 'start-controller-02', 2_440, 420),
            ],
            events: [
                controlEvent(controlRunId, 'controller-01', 'start-controller-01', 'rtc.started', 2_050),
                controlEvent(controlRunId, 'controller-02', 'start-controller-02', 'rtc.started', 2_060),
            ],
            stats: [],
            reports: [],
            heartbeats: [],
        };
        const files = {
            'distributed-run.json': JSON.stringify(distributedRun),
            'manifest.json': JSON.stringify(distributedRun.manifest),
            'control-run.json': JSON.stringify(controlRun),
            'results.jsonl': controlRun.results.map(result => JSON.stringify(result)).join('\n'),
            'events.jsonl': controlRun.events.map(event => JSON.stringify(event)).join('\n'),
        };

        const snapshots = distributedArtifactSnapshotsFromFiles(files, 6_000);
        const monitor = deriveDistributedRunMonitor({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
            artifactBundle: snapshots.artifactBundle,
        });
        const performance = deriveRtcPerformanceView({
            diagnostics: deriveRtcDiagnostics(emptySpaState()),
            state: emptySpaState(),
            distributedMonitor: monitor,
        });

        expect(monitor.state).toBe('passed');
        expect(monitor.artifact.status).toBe('valid');
        expect(monitor.agentProgress.map(row => [row.agentId, row.execution, row.averageLatencyMs])).toEqual([
            ['controller-01', 'passed', 110],
            ['controller-02', 'passed', 240],
        ]);
        expect(monitor.latency.p95Ms).toBe(420);
        expect(performance.summary.commandCount).toBe(2);
        expect(performance.summary.p99Ms).toBe(240);
        expect(performance.scatter.map(point => [point.source, point.agentId, point.durationMs])).toEqual([
            ['distributed-agent', 'controller-01', 110],
            ['distributed-agent', 'controller-02', 240],
        ]);
    });
});

function controlCommand(runId: string, agentId: string, commandId: string, queuedAtEpochMs: number, durationMs: number) {
    return {
        envelope: {
            kind: 'command',
            protocolVersion: 1,
            runId,
            agentId,
            commandId,
            command: {
                kind: 'recipe.run',
                commandId,
            },
        },
        queuedAtEpochMs,
        dispatchedAtEpochMs: queuedAtEpochMs + 10,
        completedAtEpochMs: queuedAtEpochMs + durationMs,
        dispatchCount: 1,
    };
}

function controlResult(runId: string, agentId: string, commandId: string, endedAtEpochMs: number, durationMs: number) {
    return {
        kind: 'result',
        protocolVersion: 1,
        runId,
        agentId,
        commandId,
        ok: true,
        result: {
            commandId,
            kind: 'recipe.run',
            ok: true,
            status: 'ok',
            startedAtEpochMs: endedAtEpochMs - durationMs,
            endedAtEpochMs,
            durationMs,
        },
        receivedAtEpochMs: endedAtEpochMs,
    };
}

function controlEvent(
    runId: string,
    agentId: string,
    commandId: string,
    topic: string,
    atEpochMs: number,
) {
    return {
        kind: 'event',
        protocolVersion: 1,
        runId,
        agentId,
        commandId,
        eventId: `${agentId}-${topic}`,
        atEpochMs,
        payload: {
            topic,
            severity: 'info',
        },
    };
}

function emptySpaState(): RallarBlackBoxTestState {
    const events: readonly RallarBlackBoxTestEvent[] = [];
    return {
        status: 'completed',
        currentConfig: {
            runId: 'local',
            agentId: 'visible-agent-local',
            actor: 'local',
            sessionId: 'local-session',
            roomId: 'hetzner-headless-room',
            transport: 'realtime',
            apiBaseUrl: 'https://api.rallar.intactss.com',
            control: {
                providerMode: 'browser-rallar',
            },
            defaults: {
                connection: 'rtc',
            },
        },
        commandHistory: [],
        events,
        failures: [],
        resultCache: {},
        latestStats: {
            atEpochMs: 1,
            status: 'completed',
            counters: {
                commands: 0,
                events: 0,
                failures: 0,
                messages: 0,
            },
        },
    };
}
