import { describe, expect, it } from 'vitest';
import {
    createDistributedArtifactWorkspace,
    deriveDistributedRunSnapshotPerformance,
    distributedRecipePreflight,
    distributedRunTuningJsonPointer,
    inventoryDistributedRunTuningKnobs,
    validateDistributedRunManifest,
    validateRallarBlackBoxRecipeCompatibility,
    validateRallarBlackBoxTestCommand,
} from '../../../packages/shared-test/rallar-bb-test/mod.ts';
import {
    analyzeDistributedRunArtifactFiles,
    distributedArtifactSnapshotsFromFiles,
    type DistributedRunArtifactFiles,
} from '../../../packages/shared-test/rallar-bb-test/distributed-artifact-analysis.ts';
import type {
    RallarBlackBoxDistributedRunManifest,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

function artifactFiles(manifest: RallarBlackBoxDistributedRunManifest): DistributedRunArtifactFiles {
    return {
        'distributed-run.json': JSON.stringify({
            distributedRunId: manifest.distributedRunId,
            controlRunId: 'control-tune',
            state: 'passed',
            startedAtEpochMs: 1_000,
            completedAtEpochMs: 4_000,
            targetAgentIds: ['agent-a'],
            commandLinks: [],
            manifest,
            rollup: {
                state: 'passed', ok: true, failures: [],
                summary: { participants: 1, failedParticipants: 0, blockingFailures: 0 },
            },
        }),
        'manifest.json': JSON.stringify(manifest),
        'control-run.json': JSON.stringify({
            runId: 'control-tune',
            createdAtEpochMs: 1_000,
            updatedAtEpochMs: 4_000,
            agents: [{
                agentId: 'agent-a', connected: true, reconnectCount: 0,
                receivedEventCount: 0,
            }],
            commands: [{
                envelope: {
                    agentId: 'agent-a', commandId: 'start-a',
                    command: { kind: 'recipe.run' },
                },
                dispatchedAtEpochMs: 1_200,
                completedAtEpochMs: 3_200,
            }],
            results: [], events: [], stats: [], reports: [], heartbeats: [],
        }),
        'events.jsonl': '',
        'results.jsonl': '',
    };
}

function tuningManifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'dist-tune',
        controlRunId: 'control-tune',
        description: 'Preserve recognized manifest fields.',
        group: {
            applicationId: 'rallar-server', workspaceId: 'default', groupId: 'tune-group',
        },
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
        ackTimeoutMs: 12_000,
        barrier: { enabled: true, timeoutMs: 18_000 },
        variables: { payloadSize: 128 },
        roleAssignmentPolicy: {
            mode: 'ordered-targets', pattern: 'sender-receiver', orderBy: 'agent-id',
        },
        recipes: [{
            recipeId: 'recipe~/inline',
            recipe: {
                schemaVersion: 1,
                recipeId: 'recipe~/inline',
                commands: [{
                    kind: 'loop', commandId: 'duplicate~/command', count: 2,
                    durationMs: 2_000, intervalMs: 25,
                    commands: [{
                        kind: 'rtc.stream', commandId: 'duplicate~/command', send: {},
                        count: 10, durationMs: 1_000, intervalMs: 50, rateHz: 20,
                        maxInFlight: 8,
                        thresholds: { minSendSuccessRatio: 0.95, maxDroppedFrames: 1 },
                    }, {
                        kind: 'parallel', commandId: 'parallel', groups: [{
                            groupId: 'group~/one',
                            commands: [{
                                kind: 'recipe.run', commandId: 'embedded', recipe: {
                                    recipeId: 'embedded~/recipe',
                                    commands: [{
                                        kind: 'rtc.stream', commandId: 'duplicate~/command',
                                        send: {}, durationMs: 500, rateHz: 5,
                                    }],
                                },
                            }],
                        }],
                    }],
                }],
            },
        }, {
            recipeId: 'reference-only~/recipe',
            profile: 'remote-catalog',
        }],
    };
}

describe('distributed recipe tuning Task 2 contracts', () => {
    it('exposes snapshot performance without inventing absent evidence', () => {
        const files = artifactFiles(tuningManifest());
        const snapshots = distributedArtifactSnapshotsFromFiles(files, 4_242);
        const expected = analyzeDistributedRunArtifactFiles({ files }).performance;

        const performance = deriveDistributedRunSnapshotPerformance({
            distributedRun: snapshots.distributedRun,
            controlRun: snapshots.controlRun,
        });

        expect(performance).toEqual(expected);
        expect(performance).toMatchObject({
            runDurationMs: 3_000,
            commandTiming: { count: 1, p95Ms: 2_000, p99Ms: 2_000 },
        });
        expect(performance?.streamTiming).toBeUndefined();
    });

    it('preserves manifest tuning truth during loose and envelope normalization', () => {
        const manifest = tuningManifest();
        const files = artifactFiles(manifest);
        const loose = createDistributedArtifactWorkspace({ files });
        const envelope = createDistributedArtifactWorkspace({
            files: {
                'dist-tune-artifact.json': JSON.stringify({
                    artifactSchemaVersion: 1,
                    distributedRunId: manifest.distributedRunId,
                    generatedAtEpochMs: 4_242,
                    files,
                }),
            },
        });

        for (const workspace of [loose, envelope]) {
            expect(workspace.snapshots?.distributedRun).toMatchObject({
                distributedRunId: 'dist-tune',
                controlRunId: 'control-tune',
                manifest: {
                    distributedRunId: 'dist-tune',
                    controlRunId: 'control-tune',
                    ackTimeoutMs: 12_000,
                    barrier: { enabled: true, timeoutMs: 18_000 },
                    variables: { payloadSize: 128 },
                    roleAssignmentPolicy: {
                        mode: 'ordered-targets', pattern: 'sender-receiver', orderBy: 'agent-id',
                    },
                },
            });
        }
    });

    it('keeps snapshot identities authoritative over stale nested manifest identities', () => {
        const manifest = tuningManifest();
        const files = artifactFiles(manifest);
        const distributedRun = JSON.parse(files['distributed-run.json'] ?? '{}');
        distributedRun.manifest.distributedRunId = 'stale-distributed-id';
        distributedRun.manifest.controlRunId = 'stale-control-id';

        const snapshots = distributedArtifactSnapshotsFromFiles({
            ...files,
            'distributed-run.json': JSON.stringify(distributedRun),
        });

        expect(snapshots.distributedRun.manifest).toMatchObject({
            distributedRunId: 'dist-tune',
            controlRunId: 'control-tune',
            group: manifest.group,
            recipes: manifest.recipes,
            targetPolicy: manifest.targetPolicy,
            ackTimeoutMs: 12_000,
        });
    });

    it('escapes dynamic RFC 6901 pointer tokens for later candidate composition', () => {
        expect(distributedRunTuningJsonPointer(['recipes', 0, 'recipe~/id'])).toBe(
            '/recipes/0/recipe~0~1id',
        );
    });

    it('inventories recursive tuning knobs by structural JSON Pointer in stable order', () => {
        const inventory = inventoryDistributedRunTuningKnobs(tuningManifest());
        const pointers = inventory.knobs.map(knob => knob.pointer);

        expect(pointers.slice(0, 8)).toEqual([
            '/ackTimeoutMs',
            '/barrier/timeoutMs',
            '/recipes/0/recipe/commands/0/durationMs',
            '/recipes/0/recipe/commands/0/intervalMs',
            '/recipes/0/recipe/commands/0/commands/0/durationMs',
            '/recipes/0/recipe/commands/0/commands/0/intervalMs',
            '/recipes/0/recipe/commands/0/commands/0/rateHz',
            '/recipes/0/recipe/commands/0/commands/0/maxInFlight',
        ]);
        expect(pointers).toContain(
            '/recipes/0/recipe/commands/0/commands/1/groups/0/commands/0/recipe/commands/0/rateHz',
        );
        expect(pointers.some(pointer => pointer.includes('recipe~/inline'))).toBe(false);

        const duplicateRows = inventory.knobs.filter(knob =>
            knob.commandId === 'duplicate~/command' && knob.name === 'durationMs'
        );
        expect(duplicateRows.map(row => row.pointer)).toEqual([
            '/recipes/0/recipe/commands/0/durationMs',
            '/recipes/0/recipe/commands/0/commands/0/durationMs',
            '/recipes/0/recipe/commands/0/commands/1/groups/0/commands/0/recipe/commands/0/durationMs',
        ]);
    });

    it('marks unset, shadowed, constrained, and reference-only inventory truth explicitly', () => {
        const inventory = inventoryDistributedRunTuningKnobs(tuningManifest());
        const nestedStream = '/recipes/0/recipe/commands/0/commands/0';
        const knob = (pointer: string) => inventory.knobs.find(row => row.pointer === pointer);

        expect(knob(`${nestedStream}/rateHz`)).toMatchObject({
            currentValue: 20,
            availability: 'blocked',
            effective: false,
            reason: expect.stringContaining('intervalMs'),
            constraint: { type: 'number', exclusiveMinimum: 0 },
        });
        expect(knob(`${nestedStream}/thresholds/maxP99SendDurationMs`)).toMatchObject({
            availability: 'unset', effective: true,
            constraint: { type: 'number', minimum: 0 },
        });
        expect(knob(`${nestedStream}/maxInFlight`)).toMatchObject({
            currentValue: 8,
            availability: 'configured', effective: true,
            constraint: { type: 'integer', minimum: 1 },
        });
        expect(inventory.limitations).toContainEqual(expect.objectContaining({
            code: 'reference-only-recipe',
            recipeId: 'reference-only~/recipe',
        }));
    });

    it('bounds command traversal at the shared expanded-command limit', () => {
        const manifest = tuningManifest();
        const commands = Array.from({ length: 2_001 }, (_, index) => ({
            kind: 'health' as const,
            commandId: `health-${index}`,
        }));
        const bounded: RallarBlackBoxDistributedRunManifest = {
            ...manifest,
            recipes: [{
                recipeId: 'bounded',
                recipe: { recipeId: 'bounded', commands },
            }],
        };

        const inventory = inventoryDistributedRunTuningKnobs(bounded);

        expect(inventory.limitations).toContainEqual(expect.objectContaining({
            code: 'command-limit-exceeded',
            message: expect.stringContaining('2000'),
        }));
    });

    it('keeps loop thresholds valid through every execution validator after an unrelated edit', () => {
        const candidate = { ...tuningManifest(), ackTimeoutMs: 13_000 };
        const recipe = candidate.recipes[0]?.recipe;
        expect(recipe).toBeDefined();
        if (!recipe) return;

        expect(validateDistributedRunManifest(candidate).errors).toEqual([]);
        expect(validateRallarBlackBoxRecipeCompatibility(recipe).errors).toEqual([]);
        expect(validateRallarBlackBoxTestCommand({ kind: 'recipe.load', recipe })).toEqual({ ok: true });
        expect(distributedRecipePreflight(recipe).errors).toEqual([]);
    });
});
