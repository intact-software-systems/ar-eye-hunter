import type { ControlDistributedRunArtifactBundle } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlResultEnvelope } from '../../../packages/shared-test/rallar-bb-test/control-protocol.ts';
import type { RallarBlackBoxTestRtcStreamResultValue } from '../../../packages/shared-test/rallar-bb-test/types.ts';
import type { AnalyzeUploadFile } from './recipe-console-analyze-artifacts.ts';
import {
    TUNE_BASE_EPOCH_MS,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    TUNE_SLOW_AGENT_ID,
    TUNE_STREAM_COMMAND_ID,
    createTuneControlRun,
    createTuneDistributedRun,
    createTuneManifest,
} from './recipe-console-tune-run-data.ts';

export function createTuneArtifactEnvelope(): ControlDistributedRunArtifactBundle {
    const distributedRun = createTuneDistributedRun('right');
    const streamResult = createTuneStreamResult();
    const controlRun = createTuneControlRun('right', streamResult);
    const manifest = createTuneManifest('right');
    return {
        artifactSchemaVersion: 2,
        distributedRunId: TUNE_RIGHT_RUN_ID,
        generatedAtEpochMs: distributedRun.updatedAtEpochMs + 100,
        files: {
            'distributed-run.json': JSON.stringify(distributedRun, null, 2),
            'manifest.json': JSON.stringify(manifest, null, 2),
            'target-resolution.json': JSON.stringify(distributedRun.targetResolution, null, 2),
            'control-run.json': JSON.stringify(controlRun, null, 2),
            'results.jsonl': `${JSON.stringify(createTuneStreamResult())}\n`,
            'events.jsonl': controlRun.events.map(event => JSON.stringify(event)).join('\n'),
            'report.json': JSON.stringify({
                distributedRunId: TUNE_RIGHT_RUN_ID,
                state: 'failed',
                summary: { agents: 2, passRate: 0.5 },
            }),
            'failures.json': JSON.stringify({
                failures: distributedRun.rollup.failures,
            }, null, 2),
            'metadata.json': JSON.stringify({ source: 'recipe-console-tune-fixture' }),
        },
    };
}

export function createTuneArtifactUpload(
    artifactSchemaVersion = 2,
): AnalyzeUploadFile {
    const envelope = createTuneArtifactEnvelope();
    return {
        name: `${TUNE_RIGHT_RUN_ID}-artifact.json`,
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({
            ...envelope,
            artifactSchemaVersion,
        }, null, 2)),
    };
}

function createTuneStreamResult(): ControlResultEnvelope {
    const value = createTuneStreamSummary();
    return {
        kind: 'result', protocolVersion: 1,
        runId: TUNE_RIGHT_CONTROL_RUN_ID,
        agentId: TUNE_SLOW_AGENT_ID,
        commandId: `${TUNE_STREAM_COMMAND_ID}-2`,
        ok: false,
        error: {
            code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
            message: 'RTC stream did not satisfy configured thresholds.',
            details: { thresholdFailures: value.thresholdFailures, value },
        },
    };
}

function createTuneStreamSummary(): RallarBlackBoxTestRtcStreamResultValue {
    const startedAtEpochMs = TUNE_BASE_EPOCH_MS + 700;
    const endedAtEpochMs = startedAtEpochMs + 1_000;
    const observations: RallarBlackBoxTestRtcStreamResultValue['observations'] =
        Array.from({ length: 28 }, (_, index) => {
            const dropped = index >= 23;
            const startDriftMs = index < 6 ? 28 : 4;
            const durationMs = dropped
                ? undefined
                : index === 22 ? 92 : index === 21 ? 68 : 12 + index;
            return {
                index,
                iteration: index + 1,
                commandId: TUNE_STREAM_COMMAND_ID,
                scheduledAtEpochMs: startedAtEpochMs + index * 33,
                startedAtEpochMs: dropped
                    ? undefined
                    : startedAtEpochMs + index * 33 + startDriftMs,
                completedAtEpochMs: dropped || durationMs === undefined
                    ? undefined
                    : startedAtEpochMs + index * 33 + startDriftMs + durationMs,
                startDriftMs,
                durationMs,
                ok: !dropped && index !== 22,
                dropped,
                backpressured: index >= 18 && index <= 21,
                status: dropped ? 'dropped' : index === 22 ? 'failed' : 'ok',
                errorCode: index >= 23 && index <= 24
                    ? 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT'
                    : undefined,
            };
        });
    return {
        commandId: TUNE_STREAM_COMMAND_ID,
        transport: 'messages.rtc',
        plannedFrames: 30, scheduledFrames: 28, attemptedFrames: 23,
        completedFrames: 22, failedFrames: 1, droppedFrames: 5,
        backpressureCount: 4,
        startedAtEpochMs, endedAtEpochMs, elapsedMs: 1_000,
        requestedRateHz: 30, achievedScheduleHz: 28,
        achievedCompletionHz: 22,
        pacing: {
            intervalMs: 33, averageStartDriftMs: 9.14,
            maxStartDriftMs: 28, maxJitterMs: 24, lateFrameCount: 6,
        },
        duration: {
            minMs: 12, p50Ms: 23, p95Ms: 68,
            p99Ms: 92, maxMs: 92, averageMs: 27.04,
        },
        observations,
        thresholdFailures: [{
            name: 'maxDroppedFrames', category: 'delivery',
            threshold: 0, actual: 5,
            message: 'Dropped frames were 5, above the configured 0 maximum.',
        }],
    };
}
