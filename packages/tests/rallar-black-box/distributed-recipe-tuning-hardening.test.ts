import { describe, expect, it } from 'vitest';
import {
    analyzeDistributedRunArtifactFiles,
    deriveDistributedRunSnapshotPerformance,
    distributedArtifactSnapshotsFromFiles,
    inventoryDistributedRunTuningKnobs,
    type DistributedRunArtifactFiles,
    type RallarBlackBoxDistributedRunManifest,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';

function manifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'manifest-distributed',
        controlRunId: 'manifest-control',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-hardening',
        },
        recipes: [{
            recipeId: 'tune-inline',
            recipe: { recipeId: 'tune-inline', commands: [{ kind: 'health' }] },
        }],
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
    };
}

function files(
    distributedRun: Record<string, unknown>,
    results: readonly Record<string, unknown>[] = [],
    controlResults: readonly Record<string, unknown>[] = [],
): DistributedRunArtifactFiles {
    return {
        'distributed-run.json': JSON.stringify(distributedRun),
        'manifest.json': JSON.stringify(manifest()),
        'control-run.json': JSON.stringify({
            runId: 'manifest-control',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 2_000,
            agents: [{ agentId: 'agent-a', connected: true, reconnectCount: 0 }],
            commands: [], results: controlResults, events: [], stats: [], reports: [], heartbeats: [],
        }),
        'results.jsonl': results.map(result => JSON.stringify(result)).join('\n'),
        'events.jsonl': '',
    };
}

function distributedRun(overrides: Record<string, unknown> = {}) {
    return {
        state: 'passed', createdAtEpochMs: 1_000, updatedAtEpochMs: 2_000,
        startedAtEpochMs: 1_000, completedAtEpochMs: 2_000,
        targetAgentIds: ['agent-a'], commandLinks: [],
        manifest: manifest(),
        rollup: { state: 'passed', ok: true, failures: [], summary: { blockingFailures: 0 } },
        ...overrides,
    };
}

describe('distributed recipe tuning Task 2 hardening', () => {
    it('uses one normalized identity for outer and manifest snapshots', () => {
        for (const input of [
            distributedRun(),
            distributedRun({ distributedRunId: 42, controlRunId: null }),
        ]) {
            const snapshot = distributedArtifactSnapshotsFromFiles(files(input), 2_000)
                .distributedRun;
            expect(snapshot).toMatchObject({
                distributedRunId: 'manifest-distributed',
                controlRunId: 'manifest-control',
                manifest: {
                    distributedRunId: 'manifest-distributed',
                    controlRunId: 'manifest-control',
                },
            });
        }
        const outer = distributedArtifactSnapshotsFromFiles(files(distributedRun({
            distributedRunId: 'outer-distributed',
            controlRunId: 'outer-control',
        })), 2_000).distributedRun;
        expect(outer.distributedRunId).toBe('outer-distributed');
        expect(outer.controlRunId).toBe('outer-control');
        expect(outer.manifest.distributedRunId).toBe('outer-distributed');
        expect(outer.manifest.controlRunId).toBe('outer-control');
    });

    it('does not double count normalized fallback and explicit RTC results', () => {
        const result = {
            resultKey: 'stream-result-a', agentId: 'agent-a',
            commandId: 'stream-a', action: 'rtc.stream', ok: true,
            result: {
                commandId: 'stream-a', plannedFrames: 3, scheduledFrames: 3,
                attemptedFrames: 3, completedFrames: 2, failedFrames: 1,
                droppedFrames: 0, inFlightLimitDropCount: 0, backpressureCount: 1,
                requestedRateHz: 10, achievedScheduleHz: 9,
                achievedCompletionHz: 6,
                pacing: { maxStartDriftMs: 12, lateFrameCount: 1 },
                duration: { p50Ms: 20, p95Ms: 40, p99Ms: 40, maxMs: 40 },
                observations: [
                    { index: 0, durationMs: 20, ok: true },
                    { index: 1, durationMs: 40, ok: true },
                ],
                thresholdFailures: [],
            },
        };
        const artifactFiles = files(distributedRun({
            distributedRunId: 'manifest-distributed',
            controlRunId: 'manifest-control',
            commandLinks: [{
                phase: 'start', agentId: 'agent-a',
                commandId: 'stream-a', queuedAtEpochMs: 1_100,
            }],
        }), [result]);
        const snapshots = distributedArtifactSnapshotsFromFiles(artifactFiles, 2_000);
        const performance = deriveDistributedRunSnapshotPerformance({
            ...snapshots,
            artifactResults: [result],
        });

        expect(performance).toEqual(
            analyzeDistributedRunArtifactFiles({ files: artifactFiles }).performance,
        );
        expect(performance.streamTiming).toMatchObject({
            streamCount: 1, plannedFrames: 3, completedFrames: 2,
            duration: { count: 2, p95Ms: 40, p99Ms: 40 },
        });
    });

    it('does not double count a real control envelope and its exported RTC row', () => {
        const summary = {
            commandId: 'stream-a', plannedFrames: 3, scheduledFrames: 3,
            attemptedFrames: 3, completedFrames: 2, failedFrames: 1,
            droppedFrames: 0, inFlightLimitDropCount: 0, backpressureCount: 1,
            pacing: { lateFrameCount: 0 },
            observations: [
                { index: 0, durationMs: 20, ok: true },
                { index: 1, durationMs: 40, ok: true },
            ],
        };
        const exported = {
            resultKey: 'exported-stream-result', agentId: 'agent-a',
            commandId: 'stream-a', action: 'rtc.stream', ok: true, result: summary,
        };
        const envelope = {
            kind: 'result', protocolVersion: 1, runId: 'manifest-control',
            agentId: 'agent-a', commandId: 'stream-a', ok: true, result: summary,
        };
        const performance = analyzeDistributedRunArtifactFiles({
            files: files(distributedRun(), [exported], [envelope]),
        }).performance;

        expect(performance.streamTiming).toMatchObject({
            streamCount: 1, plannedFrames: 3, completedFrames: 2,
            duration: { count: 2, p95Ms: 40 },
        });
    });

    it('keeps summary-free RTC result rows unavailable instead of inventing zero frames', () => {
        const partial = {
            resultKey: 'partial-stream', agentId: 'agent-a',
            commandId: 'stream-a', action: 'rtc.stream', ok: true,
            result: { commandId: 'stream-a' },
        };

        const performance = analyzeDistributedRunArtifactFiles({
            files: files(distributedRun(), [partial]),
        }).performance;

        expect(performance.streamTiming).toBeUndefined();
    });

    it('keeps field-partial RTC summaries unavailable instead of filling missing counters', () => {
        const partial = {
            resultKey: 'field-partial-stream', agentId: 'agent-a',
            commandId: 'stream-a', action: 'rtc.stream', ok: true,
            result: { commandId: 'stream-a', plannedFrames: 10, completedFrames: 2 },
        };

        const performance = analyzeDistributedRunArtifactFiles({
            files: files(distributedRun(), [partial]),
        }).performance;

        expect(performance.streamTiming).toBeUndefined();
    });

    it('accepts canonical sampled observations while retaining exact exceptional counts', () => {
        const sampled = {
            resultKey: 'sampled-stream', agentId: 'agent-a',
            commandId: 'stream-a', action: 'rtc.stream', ok: true,
            result: {
                commandId: 'stream-a', plannedFrames: 100, scheduledFrames: 100,
                attemptedFrames: 99, completedFrames: 99, failedFrames: 1,
                droppedFrames: 1, backpressureCount: 0,
                pacing: { lateFrameCount: 4 },
                observations: [
                    { index: 0, iteration: 1, durationMs: 10, ok: true },
                    {
                        index: 50, iteration: 51, ok: false, dropped: true,
                        errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT',
                    },
                    { index: 99, iteration: 100, durationMs: 12, ok: true },
                ],
            },
        };

        const performance = analyzeDistributedRunArtifactFiles({
            files: files(distributedRun(), [sampled]),
        }).performance;

        expect(performance.streamTiming).toMatchObject({
            streamCount: 1, plannedFrames: 100, completedFrames: 99,
            inFlightLimitDropCount: 1, lateFrameCount: 4,
        });
    });

    it('contains malformed and over-depth command trees without throwing', () => {
        const malformed = {
            ...manifest(),
            recipes: [{
                recipeId: 'malformed',
                recipe: {
                    recipeId: 'malformed',
                    commands: [{ kind: 'loop' }],
                },
            }],
        } as unknown as RallarBlackBoxDistributedRunManifest;
        const nested = (depth: number): Record<string, unknown> => depth === 0
            ? { kind: 'health' }
            : { kind: 'loop', commands: [nested(depth - 1)] };
        const tooDeep = {
            ...manifest(),
            recipes: [{
                recipeId: 'too-deep',
                recipe: { recipeId: 'too-deep', commands: [nested(6)] },
            }],
        } as unknown as RallarBlackBoxDistributedRunManifest;

        expect(() => inventoryDistributedRunTuningKnobs(malformed)).not.toThrow();
        expect(inventoryDistributedRunTuningKnobs(malformed).limitations)
            .toContainEqual(expect.objectContaining({ code: 'malformed-command' }));
        expect(inventoryDistributedRunTuningKnobs(tooDeep).limitations)
            .toContainEqual(expect.objectContaining({ code: 'depth-limit-exceeded' }));
    });

    it('stops wide group and recipe traversal at the shared command bound', () => {
        const groups = Array.from({ length: 2_100 }, (_, index) => ({
            groupId: `group-${index}`,
            commands: [{ kind: 'health' as const }],
        }));
        Object.defineProperty(groups[1_999], 'commands', {
            get: () => { throw new Error('walked past group command bound'); },
        });
        const wide = {
            ...manifest(),
            recipes: [{
                recipeId: 'wide',
                recipe: {
                    recipeId: 'wide',
                    commands: [{ kind: 'parallel', groups }],
                },
            }],
        } as RallarBlackBoxDistributedRunManifest;

        expect(() => inventoryDistributedRunTuningKnobs(wide)).not.toThrow();
        expect(inventoryDistributedRunTuningKnobs(wide).limitations)
            .toContainEqual(expect.objectContaining({
                code: 'command-limit-exceeded',
                recipeId: 'wide',
            }));

        const firstCommands = Array.from({ length: 2_000 }, () => ({ kind: 'health' as const }));
        const later = { recipeId: 'later', recipe: { recipeId: 'later', commands: [] } };
        Object.defineProperty(later, 'recipe', {
            get: () => { throw new Error('walked past recipe command bound'); },
        });
        const wideRecipes = {
            ...manifest(),
            recipes: [{
                recipeId: 'first',
                recipe: { recipeId: 'first', commands: firstCommands },
            }, later],
        } as RallarBlackBoxDistributedRunManifest;
        expect(() => inventoryDistributedRunTuningKnobs(wideRecipes)).not.toThrow();

        const references = Array.from({ length: 2_100 }, (_, index) => ({
            recipeId: `reference-${index}`,
        }));
        Object.defineProperty(references, 2_000, {
            get: () => { throw new Error('walked past recipe structure bound'); },
        });
        const wideReferences = {
            ...manifest(), recipes: references,
        } as RallarBlackBoxDistributedRunManifest;
        const referenceInventory = inventoryDistributedRunTuningKnobs(wideReferences);
        expect(referenceInventory.limitations).toContainEqual(expect.objectContaining({
            code: 'command-limit-exceeded',
        }));
    });
});
