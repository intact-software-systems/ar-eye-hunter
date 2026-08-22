import { describe, expect, it } from 'vitest';
import {
    createDistributedRunTuningCandidate,
    type DistributedRunTuningCandidateResult as CandidateResult,
    type DistributedRunTuningChange as CandidateChange,
    type DistributedRunTuningPatchOperation as PatchOperation
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning-candidate.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const STREAM = '/recipes/0/recipe/commands/1';

function manifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'dist-candidate',
        controlRunId: 'control-candidate',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-group'
        },
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
        ackTimeoutMs: 1_000,
        barrier: { enabled: true, timeoutMs: 2_000 },
        recipes: [{
            recipeId: 'candidate-recipe',
            recipe: {
                schemaVersion: 1,
                recipeId: 'candidate-recipe',
                commands: [{
                    kind: 'loop',
                    commandId: 'loop-health',
                    count: 2,
                    thresholds: { minAchievedRateHz: 1, failOnBackpressure: false },
                    commands: [{ kind: 'health', commandId: 'health' }]
                }, {
                    kind: 'rtc.stream',
                    commandId: 'stream-position',
                    send: {},
                    count: 10,
                    intervalMs: 50,
                    rateHz: 20
                }]
            }
        }]
    };
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        Object.values(value).forEach(deepFreeze);
    }
    return value;
}

function applyPatch(
    source: RallarBlackBoxDistributedRunManifest,
    patch: readonly PatchOperation[]
): RallarBlackBoxDistributedRunManifest {
    const clone = structuredClone(source) as unknown as Record<string, unknown>;
    for (const operation of patch) {
        const tokens = operation.path.split('/').slice(1).map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
        const key = tokens.pop();
        let parent: unknown = clone;
        for (const token of tokens) {
            parent = Array.isArray(parent)
                ? parent[Number(token)]
                : (parent as Record<string, unknown>)[token];
        }
        if (!key || !parent || typeof parent !== 'object') {
            throw new Error(`Invalid test patch path: ${operation.path}`);
        }
        if (operation.op === 'replace' && !(key in parent)) {
            throw new Error(`Test replace target is missing: ${operation.path}`);
        }
        (parent as Record<string, unknown>)[key] = structuredClone(operation.value);
    }
    return clone as unknown as RallarBlackBoxDistributedRunManifest;
}

function errorCodes(result: CandidateResult): readonly string[] {
    return result.ok ? [] : result.errors.map((error) => error.code);
}

describe('distributed tuning candidate changes', () => {
    it('emits deterministic valid patches and a readable diff without mutating source', () => {
        const source = deepFreeze(manifest());
        const before = JSON.stringify(source);
        const result = createDistributedRunTuningCandidate({
            manifest: source,
            changes: [
                { pointer: `${STREAM}/thresholds/maxDroppedFrames`, value: 2, expectedValue: null },
                { pointer: '/ackTimeoutMs', value: 1_500, expectedValue: 1_000 },
                { pointer: `${STREAM}/maxInFlight`, value: 16, expectedValue: null },
                { pointer: `${STREAM}/thresholds/minSendSuccessRatio`, value: 0.98, expectedValue: null }
            ]
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.patch).toEqual([
            { op: 'replace', path: '/ackTimeoutMs', value: 1_500 },
            { op: 'add', path: `${STREAM}/maxInFlight`, value: 16 },
            { op: 'add', path: `${STREAM}/thresholds`, value: {} },
            { op: 'add', path: `${STREAM}/thresholds/minSendSuccessRatio`, value: 0.98 },
            { op: 'add', path: `${STREAM}/thresholds/maxDroppedFrames`, value: 2 }
        ]);
        expect(applyPatch(source, result.patch)).toEqual(result.manifest);
        expect(JSON.parse(result.patchJson)).toEqual(result.patch);
        expect(result.diff.map((row) => row.pointer)).toEqual([
            '/ackTimeoutMs',
            `${STREAM}/maxInFlight`,
            `${STREAM}/thresholds/minSendSuccessRatio`,
            `${STREAM}/thresholds/maxDroppedFrames`
        ]);
        expect(result.diffText).toContain('/ackTimeoutMs: 1000 -> 1500');
        expect(result.diffText).toContain(`${STREAM}/maxInFlight: (unset) -> 16`);
        expect(JSON.stringify(source)).toBe(before);
    });

    it('rejects unknown, duplicate, stale, and shadowed pointers path-specifically', () => {
        const source = deepFreeze(manifest());
        const before = JSON.stringify(source);
        const cases: readonly Readonly<{
            changes: readonly CandidateChange[];
            code: string;
            path: string;
        }>[] = [{
            changes: [{ pointer: '/metadata/not-a-knob', value: 1 }],
            code: 'unknown-pointer',
            path: '/metadata/not-a-knob'
        }, {
            changes: [
                { pointer: '/ackTimeoutMs', value: 2_000 },
                { pointer: '/ackTimeoutMs', value: 3_000 }
            ],
            code: 'duplicate-pointer',
            path: '/ackTimeoutMs'
        }, {
            changes: [{ pointer: '/ackTimeoutMs', value: 2_000, expectedValue: 999 }],
            code: 'stale-value',
            path: '/ackTimeoutMs'
        }, {
            changes: [{ pointer: `${STREAM}/rateHz`, value: 10, expectedValue: 20 }],
            code: 'blocked-knob',
            path: `${STREAM}/rateHz`
        }];

        for (const entry of cases) {
            const result = createDistributedRunTuningCandidate({
                manifest: source,
                changes: entry.changes
            });
            expect(result).toMatchObject({
                ok: false,
                errors: expect.arrayContaining([
                    expect.objectContaining({ code: entry.code, path: entry.path })
                ])
            });
        }
        expect(JSON.stringify(source)).toBe(before);
    });

    it('rejects nonfinite, fractional, and out-of-range values', () => {
        const cases: readonly CandidateChange[] = [
            { pointer: '/ackTimeoutMs', value: Number.NaN },
            { pointer: `${STREAM}/maxInFlight`, value: 1.5 },
            { pointer: `${STREAM}/intervalMs`, value: 0 },
            { pointer: `${STREAM}/thresholds/minSendSuccessRatio`, value: 1.1 }
        ];

        for (const change of cases) {
            const result = createDistributedRunTuningCandidate({
                manifest: manifest(),
                changes: [change]
            });
            expect(result).toMatchObject({
                ok: false,
                errors: expect.arrayContaining([
                    expect.objectContaining({ code: 'invalid-value', path: change.pointer })
                ])
            });
        }
    });

    it('blocks missing and disabled barrier parents instead of enabling them', () => {
        for (const barrier of [undefined, { enabled: false, timeoutMs: 2_000 }]) {
            const source = { ...manifest(), barrier };
            const result = createDistributedRunTuningCandidate({
                manifest: source,
                changes: [{ pointer: '/barrier/timeoutMs', value: 3_000 }]
            });

            expect(result).toMatchObject({
                ok: false,
                errors: expect.arrayContaining([expect.objectContaining({
                    code: 'blocked-knob',
                    path: '/barrier/timeoutMs'
                })])
            });
        }
    });

    it('reports manifest, recipe, agent, and preflight validation failures', () => {
        const create = (source: RallarBlackBoxDistributedRunManifest) =>
            createDistributedRunTuningCandidate({
                manifest: source,
                changes: [{ pointer: '/ackTimeoutMs', value: 1_500 }]
            });
        const missingSend = structuredClone(manifest()) as unknown as Record<string, any>;
        delete missingSend.recipes[0].recipe.commands[1].send;
        const invalidRoute = structuredClone(manifest()) as unknown as Record<string, any>;
        invalidRoute.recipes[0].recipe.commands[1].roomId = '';
        const excessiveLoop = structuredClone(manifest()) as unknown as Record<string, any>;
        excessiveLoop.recipes[0].recipe.commands[0].count = 2_001;

        expect(errorCodes(create(missingSend as RallarBlackBoxDistributedRunManifest))).toEqual(
            expect.arrayContaining(['manifest-validation', 'recipe-validation', 'agent-validation'])
        );
        expect(errorCodes(create(invalidRoute as RallarBlackBoxDistributedRunManifest))).toContain(
            'agent-validation'
        );
        expect(errorCodes(create(excessiveLoop as RallarBlackBoxDistributedRunManifest))).toContain(
            'preflight-validation'
        );
    });
});
