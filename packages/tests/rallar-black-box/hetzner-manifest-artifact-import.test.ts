import {
    describe,
    expect,
    it
} from 'vitest';

import type { ControlEventEnvelope, ControlResultEnvelope } from '@shared-test/rallar-bb-test/control-protocol.ts';
import type { ControlQueuedCommandSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import { toDistributedArtifactSnapshots } from '@shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type { RallarBlackBoxTestResult, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { deriveDistributedRunMonitor } from '../../../apps/rallar-black-box/src/distributed-recipes.ts';
import {
    computeRtcDiagnostics,
    computeRtcPerformanceView,
    DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT
} from '../../../apps/rallar-black-box/src/rtc-diagnostics.ts';

import { createHetznerDistributedManifestCatalog } from '../../../apps/rallar-black-box/src/create-hetzner-distributed-manifest-catalog.ts';

interface RecordedControlResult extends ControlResultEnvelope {
    readonly ok: true;
    readonly result: RallarBlackBoxTestResult;
    readonly receivedAtEpochMs: number;
}

interface ControlCommandInput {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly queuedAtEpochMs: number;
    readonly durationMs: number;
}

interface ControlResultInput {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly endedAtEpochMs: number;
    readonly durationMs: number;
}

interface ControlEventInput {
    readonly runId: string;
    readonly agentId: string;
    readonly commandId: string;
    readonly topic: string;
    readonly atEpochMs: number;
}

const DIAGNOSTICS_NOW_EPOCH_MS = 100_000;

describe('Hetzner artifact import', () => {
    it('feeds Hetzner CI artifacts into SPA monitor and RTC performance views', () => {
        const entry = createHetznerDistributedManifestCatalog()
            .find((candidate) => candidate.filePath.endsWith('/05-rtc-realtime-2-agent-5s.json'));
        expect(entry).toBeDefined();
        const manifest = entry!.manifest;
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
                controlRunId
            },
            commandLinks: [
                { phase: 'stage', agentId: 'controller-01', commandId: 'stage-controller-01', recipeId: 'rtc-realtime', queuedAtEpochMs: 1_210 },
                { phase: 'stage', agentId: 'controller-02', commandId: 'stage-controller-02', recipeId: 'rtc-realtime', queuedAtEpochMs: 1_220 },
                { phase: 'start', agentId: 'controller-01', commandId: 'start-controller-01', recipeId: 'rtc-realtime', queuedAtEpochMs: 2_010 },
                { phase: 'start', agentId: 'controller-02', commandId: 'start-controller-02', recipeId: 'rtc-realtime', queuedAtEpochMs: 2_020 }
            ],
            rollup: {
                state: 'passed',
                ok: true,
                summary: {
                    participants: 2,
                    readyParticipants: 2,
                    passedParticipants: 2,
                    failedParticipants: 0,
                    recipes: 1,
                    passedRecipes: 2,
                    failedRecipes: 0,
                    groupAssertions: 0,
                    passedGroupAssertions: 0,
                    failedGroupAssertions: 0,
                    blockingFailures: 0
                },
                failures: []
            }
        };
        const controlRun = {
            runId: controlRunId,
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 5_500,
            agents: agentIds.map((agentId) => ({
                runId: controlRunId,
                agentId,
                connected: true,
                status: 'connected',
                lastSeenAtEpochMs: 5_500,
                lastHeartbeatAtEpochMs: 5_500,
                identity: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: 'hetzner-headless-room',
                    sessionLabel: agentId,
                    updatedAtEpochMs: 5_500
                },
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: 2,
                receivedEventCount: 1,
                completedCommandIds: [],
                resumeCompletedCommandIds: []
            })),
            commands: [
                toControlCommand({ runId: controlRunId, agentId: 'controller-01', commandId: 'stage-controller-01', queuedAtEpochMs: 1_210, durationMs: 40 }),
                toControlCommand({ runId: controlRunId, agentId: 'controller-02', commandId: 'stage-controller-02', queuedAtEpochMs: 1_220, durationMs: 60 }),
                toControlCommand({ runId: controlRunId, agentId: 'controller-01', commandId: 'start-controller-01', queuedAtEpochMs: 2_010, durationMs: 180 }),
                toControlCommand({ runId: controlRunId, agentId: 'controller-02', commandId: 'start-controller-02', queuedAtEpochMs: 2_020, durationMs: 420 })
            ],
            results: [
                toControlResult({ runId: controlRunId, agentId: 'controller-01', commandId: 'stage-controller-01', endedAtEpochMs: 1_250, durationMs: 40 }),
                toControlResult({ runId: controlRunId, agentId: 'controller-02', commandId: 'stage-controller-02', endedAtEpochMs: 1_280, durationMs: 60 }),
                toControlResult({ runId: controlRunId, agentId: 'controller-01', commandId: 'start-controller-01', endedAtEpochMs: 2_190, durationMs: 180 }),
                toControlResult({ runId: controlRunId, agentId: 'controller-02', commandId: 'start-controller-02', endedAtEpochMs: 2_440, durationMs: 420 })
            ],
            events: [
                toControlEvent({ runId: controlRunId, agentId: 'controller-01', commandId: 'start-controller-01', topic: 'rtc.started', atEpochMs: 2_050 }),
                toControlEvent({ runId: controlRunId, agentId: 'controller-02', commandId: 'start-controller-02', topic: 'rtc.started', atEpochMs: 2_060 })
            ],
            stats: [],
            reports: [],
            heartbeats: []
        };
        const files = {
            'distributed-run.json': JSON.stringify(distributedRun),
            'manifest.json': JSON.stringify(distributedRun.manifest),
            'control-run.json': JSON.stringify(controlRun),
            'results.jsonl': controlRun.results.map((result) => JSON.stringify(result)).join('\n'),
            'events.jsonl': controlRun.events.map((event) => JSON.stringify(event)).join('\n')
        };

        const snapshots = toDistributedArtifactSnapshots(files, 6_000);
        expect(snapshots.left).toBeUndefined();
        const monitor = snapshots.right && deriveDistributedRunMonitor({
            distributedRun: snapshots.right.distributedRun,
            controlRun: snapshots.right.controlRun,
            artifactBundle: snapshots.right.artifactBundle
        });
        const performance = computeRtcPerformanceView({
            diagnostics: computeRtcDiagnostics(toEmptySpaState(), DIAGNOSTICS_NOW_EPOCH_MS),
            state: toEmptySpaState(),
            distributedMonitor: monitor,
            histogramBucketCount: DEFAULT_RTC_PERFORMANCE_HISTOGRAM_BUCKET_COUNT
        });

        expect(monitor?.state).toBe('passed');
        expect(monitor?.artifact.status).toBe('valid');
        expect(monitor?.agentProgress.map((row) => [row.agentId, row.execution, row.averageLatencyMs])).toEqual([
            ['controller-01', 'passed', 110],
            ['controller-02', 'passed', 240]
        ]);
        expect(monitor?.latency.p95Ms).toBe(420);
        expect(performance.summary.commandCount).toBe(2);
        expect(performance.summary.p99Ms).toBe(240);
        expect(performance.scatter.map((point) => [point.source, point.agentId, point.durationMs])).toEqual([
            ['distributed-agent', 'controller-01', 110],
            ['distributed-agent', 'controller-02', 240]
        ]);
    });
});

function toControlCommand({ runId, agentId, commandId, queuedAtEpochMs, durationMs }: ControlCommandInput): ControlQueuedCommandSnapshot {
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
                recipe: { schemaVersion: 1, recipeId: 'rtc-realtime', commands: [{ kind: 'health' }] }
            }
        },
        queuedAtEpochMs,
        dispatchedAtEpochMs: queuedAtEpochMs + 10,
        completedAtEpochMs: queuedAtEpochMs + durationMs,
        dispatchCount: 1
    };
}

function toControlResult({ runId, agentId, commandId, endedAtEpochMs, durationMs }: ControlResultInput): RecordedControlResult {
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
            durationMs
        },
        receivedAtEpochMs: endedAtEpochMs
    };
}

function toControlEvent({ runId, agentId, commandId, topic, atEpochMs }: ControlEventInput): ControlEventEnvelope {
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
            severity: 'info'
        }
    };
}

function toEmptySpaState(): RallarBlackBoxTestState {
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
                providerMode: 'browser-rallar'
            },
            defaults: {
                connection: 'rtc'
            }
        },
        commandHistory: [],
        events: [],
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
                diagnostics: 0
            }
        }
    };
}
