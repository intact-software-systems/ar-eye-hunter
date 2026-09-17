import { describe, expect, it } from 'vitest';
import {
    computeDistributedRunArtifactAnalysis,
    computeDistributedRunTuningInventory,
    decodeDistributedRunManifest,
    toDistributedArtifactSnapshots,
    type DistributedRunArtifactFiles,
    type DistributedRunPerformanceAnalysis,
    type RallarBlackBoxDistributedRunManifest
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';

function manifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'manifest-distributed',
        controlRunId: 'manifest-control',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-hardening'
        },
        recipes: [{
            recipeId: 'tune-inline',
            recipe: { schemaVersion: 1, recipeId: 'tune-inline', commands: [{ kind: 'health' }] },
            variables: {},
            required: true
        }],
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 30_000,
        barrier: { enabled: false },
        startMode: 'manual',
        groupAssertions: [],
        metadata: {}
    };
}

function files(
    distributedRun: object,
    results: readonly object[] = [],
    controlResults: readonly object[] = []
): DistributedRunArtifactFiles {
    return {
        'distributed-run.json': JSON.stringify(distributedRun),
        'manifest.json': JSON.stringify(manifest()),
        'control-run.json': JSON.stringify({
            runId: 'manifest-control',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 2_000,
            agents: [{
                runId: 'manifest-control',
                agentId: 'agent-a',
                connected: true,
                connectionSequence: 1,
                reconnectCount: 0,
                receivedResultCount: 0,
                receivedEventCount: 0,
                completedCommandIds: [],
                resumeCompletedCommandIds: []
            }],
            commands: [],
            results: controlResults,
            events: [],
            stats: [],
            reports: [],
            heartbeats: []
        }),
        'results.jsonl': results.map((result) => JSON.stringify(result)).join('\n'),
        'events.jsonl': ''
    };
}

function distributedRun(overrides: object = {}) {
    return {
        distributedRunId: 'outer-distributed',
        controlRunId: 'manifest-control',
        state: 'passed',
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 2_000,
        startedAtEpochMs: 1_000,
        completedAtEpochMs: 2_000,
        targetAgentIds: ['agent-a'],
        commandLinks: [],
        manifest: manifest(),
        rollup: {
            state: 'passed',
            ok: true,
            failures: [],
            summary: {
                participants: 1,
                readyParticipants: 1,
                passedParticipants: 1,
                failedParticipants: 0,
                recipes: 1,
                passedRecipes: 1,
                failedRecipes: 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 0
            }
        },
        ...overrides
    };
}

function analyzedPerformance(
    artifactFiles: DistributedRunArtifactFiles
): DistributedRunPerformanceAnalysis {
    const analyzed = computeDistributedRunArtifactAnalysis({
        files: artifactFiles,
        generatedAtEpochMs: 2_000
    }).right;
    const performance = analyzed?.variant === 'distributed-run' ? analyzed.analysis.performance : undefined;
    if (!performance) {
        throw new Error('artifact analysis returned no performance section');
    }
    return performance;
}

describe('distributed recipe tuning Task 2 hardening', () => {
    it('rejects snapshot identities that are not strings instead of borrowing the manifest identity', () => {
        for (
            const input of [
                distributedRun({ distributedRunId: undefined }),
                distributedRun({ distributedRunId: 42, controlRunId: null })
            ]
        ) {
            expect(toDistributedArtifactSnapshots(files(input), 2_000).left).toEqual({
                fileName: 'distributed-run.json',
                message: 'distributed-run.json is not a distributed run snapshot: distributedRunId must be a non-empty string.'
            });
        }
        const outer = toDistributedArtifactSnapshots(
            files(distributedRun({
                distributedRunId: 'outer-distributed',
                controlRunId: 'outer-control'
            })),
            2_000
        ).right?.distributedRun;
        expect(outer?.distributedRunId).toBe('outer-distributed');
        expect(outer?.controlRunId).toBe('outer-control');
        expect(outer?.manifest.distributedRunId).toBe('manifest-distributed');
        expect(outer?.manifest.controlRunId).toBe('manifest-control');
    });

    it('counts a results.jsonl stream row once when the same row stands in for a control result', () => {
        const result = {
            resultKey: 'stream-result-a',
            agentId: 'agent-a',
            commandId: 'stream-a',
            action: 'rtc.stream',
            ok: true,
            result: {
                commandId: 'stream-a',
                plannedFrames: 3,
                scheduledFrames: 3,
                attemptedFrames: 3,
                completedFrames: 2,
                failedFrames: 1,
                droppedFrames: 0,
                inFlightLimitDropCount: 0,
                backpressureCount: 1,
                requestedRateHz: 10,
                achievedScheduleHz: 9,
                achievedCompletionHz: 6,
                pacing: { maxStartDriftMs: 12, lateFrameCount: 1 },
                duration: { p50Ms: 20, p95Ms: 40, p99Ms: 40, maxMs: 40 },
                observations: [
                    { index: 0, durationMs: 20, ok: true },
                    { index: 1, durationMs: 40, ok: true }
                ],
                thresholdFailures: []
            }
        };
        const artifactFiles = files(
            distributedRun({
                distributedRunId: 'manifest-distributed',
                controlRunId: 'manifest-control',
                commandLinks: [{
                    phase: 'start',
                    agentId: 'agent-a',
                    commandId: 'stream-a',
                    queuedAtEpochMs: 1_100
                }]
            }),
            [result]
        );
        const snapshots = toDistributedArtifactSnapshots(artifactFiles, 2_000).right;

        expect(snapshots?.controlRun.results.map((envelope) => envelope.commandId)).toEqual(['stream-a']);
        expect(analyzedPerformance(artifactFiles).streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 3,
            completedFrames: 2,
            duration: { count: 2, p95Ms: 40, p99Ms: 40 }
        });
    });

    it('does not double count a real control envelope and its exported RTC row', () => {
        const summary = {
            commandId: 'stream-a',
            plannedFrames: 3,
            scheduledFrames: 3,
            attemptedFrames: 3,
            completedFrames: 2,
            failedFrames: 1,
            droppedFrames: 0,
            inFlightLimitDropCount: 0,
            backpressureCount: 1,
            pacing: { lateFrameCount: 0 },
            observations: [
                { index: 0, durationMs: 20, ok: true },
                { index: 1, durationMs: 40, ok: true }
            ]
        };
        const exported = {
            resultKey: 'exported-stream-result',
            agentId: 'agent-a',
            commandId: 'stream-a',
            action: 'rtc.stream',
            ok: true,
            result: summary
        };
        const envelope = {
            kind: 'result',
            protocolVersion: 1,
            runId: 'manifest-control',
            agentId: 'agent-a',
            commandId: 'stream-a',
            ok: true,
            result: summary
        };
        const performance = analyzedPerformance(
            files(distributedRun(), [exported], [envelope])
        );

        expect(performance.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 3,
            completedFrames: 2,
            duration: { count: 2, p95Ms: 40 }
        });
    });

    it('keeps summary-free RTC result rows unavailable instead of inventing zero frames', () => {
        const partial = {
            resultKey: 'partial-stream',
            agentId: 'agent-a',
            commandId: 'stream-a',
            action: 'rtc.stream',
            ok: true,
            result: { commandId: 'stream-a' }
        };

        const performance = analyzedPerformance(
            files(distributedRun(), [partial])
        );

        expect(performance.streamTiming).toBeUndefined();
    });

    it('keeps field-partial RTC summaries unavailable instead of filling missing counters', () => {
        const partial = {
            resultKey: 'field-partial-stream',
            agentId: 'agent-a',
            commandId: 'stream-a',
            action: 'rtc.stream',
            ok: true,
            result: { commandId: 'stream-a', plannedFrames: 10, completedFrames: 2 }
        };

        const performance = analyzedPerformance(
            files(distributedRun(), [partial])
        );

        expect(performance.streamTiming).toBeUndefined();
    });

    it('accepts canonical sampled observations while retaining exact exceptional counts', () => {
        const sampled = {
            resultKey: 'sampled-stream',
            agentId: 'agent-a',
            commandId: 'stream-a',
            action: 'rtc.stream',
            ok: true,
            result: {
                commandId: 'stream-a',
                plannedFrames: 100,
                scheduledFrames: 100,
                attemptedFrames: 99,
                completedFrames: 99,
                failedFrames: 1,
                droppedFrames: 1,
                backpressureCount: 0,
                pacing: { lateFrameCount: 4 },
                observations: [
                    { index: 0, iteration: 1, durationMs: 10, ok: true },
                    {
                        index: 50,
                        iteration: 51,
                        ok: false,
                        dropped: true,
                        errorCode: 'RALLAR_BLACK_BOX_RTC_STREAM_IN_FLIGHT_LIMIT'
                    },
                    { index: 99, iteration: 100, durationMs: 12, ok: true }
                ]
            }
        };

        const performance = analyzedPerformance(
            files(distributedRun(), [sampled])
        );

        expect(performance.streamTiming).toMatchObject({
            streamCount: 1,
            plannedFrames: 100,
            completedFrames: 99,
            inFlightLimitDropCount: 1,
            lateFrameCount: 4
        });
    });

    it('leaves malformed command trees to the manifest decoder and stops over-depth branches', () => {
        const malformed = manifest();
        Reflect.set(malformed, 'recipes', [{
            recipeId: 'malformed',
            recipe: {
                schemaVersion: 1,
                recipeId: 'malformed',
                commands: [{ kind: 'loop' }]
            },
            variables: {},
            required: true
        }]);
        const nested = (depth: number): Record<string, unknown> =>
            depth === 0
                ? { kind: 'health' }
                : { kind: 'loop', commands: [nested(depth - 1)] };
        const tooDeep = manifest();
        Reflect.set(tooDeep, 'recipes', [{
            recipeId: 'too-deep',
            recipe: { schemaVersion: 1, recipeId: 'too-deep', commands: [nested(6)] },
            variables: {},
            required: true
        }]);

        expect(decodeDistributedRunManifest(malformed).left).toContainEqual({
            source: 'schema',
            path: '$.recipes[0].recipe.commands[0]',
            message: 'Missing required property commands.'
        });
        const tooDeepLimitations = decodeDistributedRunManifest(tooDeep).fold<readonly unknown[]>(
            (issues) => issues,
            (decoded) => computeDistributedRunTuningInventory(decoded).limitations
        );
        expect(tooDeepLimitations)
            .toContainEqual(expect.objectContaining({ code: 'depth-limit-exceeded', recipeId: 'too-deep' }));
    });

    it('stops wide group and recipe traversal at the shared command bound', () => {
        const groups = Array.from({ length: 2_100 }, (_, index) => ({
            groupId: `group-${index}`,
            commands: [{ kind: 'health' as const }]
        }));
        Object.defineProperty(groups[1_999], 'commands', {
            get: () => {
                throw new Error('walked past group command bound');
            }
        });
        const wide: RallarBlackBoxDistributedRunManifest = {
            ...manifest(),
            recipes: [{
                recipeId: 'wide',
                recipe: {
                    schemaVersion: 1,
                    recipeId: 'wide',
                    commands: [{ kind: 'parallel', groups }]
                },
                variables: {},
                required: true
            }]
        };

        expect(() => computeDistributedRunTuningInventory(wide)).not.toThrow();
        expect(computeDistributedRunTuningInventory(wide).limitations)
            .toContainEqual(expect.objectContaining({
                code: 'command-limit-exceeded',
                recipeId: 'wide'
            }));

        const firstCommands = Array.from({ length: 2_000 }, () => ({ kind: 'health' as const }));
        const later: RallarBlackBoxDistributedRunManifest['recipes'][number] = {
            recipeId: 'later',
            recipe: { schemaVersion: 1, recipeId: 'later', commands: [] },
            variables: {},
            required: true
        };
        Object.defineProperty(later, 'recipe', {
            get: () => {
                throw new Error('walked past recipe command bound');
            }
        });
        const wideRecipes: RallarBlackBoxDistributedRunManifest = {
            ...manifest(),
            recipes: [{
                recipeId: 'first',
                recipe: { schemaVersion: 1, recipeId: 'first', commands: firstCommands },
                variables: {},
                required: true
            }, later]
        };
        expect(() => computeDistributedRunTuningInventory(wideRecipes)).not.toThrow();

        const references = Array.from({ length: 2_100 }, (_, index) => ({
            recipeId: `reference-${index}`,
            variables: {},
            required: true
        }));
        Object.defineProperty(references, 2_000, {
            get: () => {
                throw new Error('walked past recipe structure bound');
            }
        });
        const wideReferences: RallarBlackBoxDistributedRunManifest = {
            ...manifest(),
            recipes: references
        };
        const referenceInventory = computeDistributedRunTuningInventory(wideReferences);
        expect(referenceInventory.limitations).toContainEqual(expect.objectContaining({
            code: 'command-limit-exceeded'
        }));
    });
});
