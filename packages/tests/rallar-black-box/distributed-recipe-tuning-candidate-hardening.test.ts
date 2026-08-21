import { describe, expect, it } from 'vitest';
import { createDistributedRunTuningCandidate } from '../../../packages/shared-test/rallar-bb-test/distributed-run-tuning-candidate.ts';
import type { RallarBlackBoxDistributedRunManifest } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const STREAM = '/recipes/0/recipe/commands/1';

function manifest(): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'candidate-hardening',
        controlRunId: 'control-hardening',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'tune-group'
        },
        targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
        ackTimeoutMs: 1_000,
        recipes: [{
            recipeId: 'candidate-recipe',
            recipe: {
                recipeId: 'candidate-recipe',
                commands: [{
                    kind: 'loop',
                    commandId: 'loop-health',
                    count: 2,
                    commands: [{ kind: 'health', commandId: 'health' }]
                }, {
                    kind: 'rtc.stream',
                    commandId: 'stream-position',
                    send: {},
                    count: 10,
                    rateHz: 20
                }]
            }
        }]
    };
}

describe('distributed tuning candidate hardening', () => {
    it('materializes an explicitly undefined threshold parent once', () => {
        const source = structuredClone(manifest()) as unknown as Record<string, any>;
        source.recipes[0].recipe.commands[1].thresholds = undefined;

        const result = createDistributedRunTuningCandidate({
            manifest: source as RallarBlackBoxDistributedRunManifest,
            changes: [
                { pointer: `${STREAM}/thresholds/minSendSuccessRatio`, value: 0.98 },
                { pointer: `${STREAM}/thresholds/maxDroppedFrames`, value: 2 }
            ]
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.patch).toEqual([
            { op: 'add', path: `${STREAM}/thresholds`, value: {} },
            { op: 'add', path: `${STREAM}/thresholds/minSendSuccessRatio`, value: 0.98 },
            { op: 'add', path: `${STREAM}/thresholds/maxDroppedFrames`, value: 2 }
        ]);
    });

    it.each([
        null,
        [null]
    ])('contains malformed recipe collections as typed validation errors %#', (recipes) => {
        const source = { ...manifest(), recipes } as unknown as RallarBlackBoxDistributedRunManifest;
        let result: ReturnType<typeof createDistributedRunTuningCandidate> | undefined;

        expect(() => {
            result = createDistributedRunTuningCandidate({
                manifest: source,
                changes: [{ pointer: '/ackTimeoutMs', value: 1_500 }]
            });
        }).not.toThrow();
        expect(result).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([
                expect.objectContaining({ code: 'manifest-validation' })
            ])
        });
    });

    it('returns RFC 6901 schema paths and command-specific agent/preflight paths', () => {
        const dynamicRole = structuredClone(manifest()) as unknown as Record<string, any>;
        dynamicRole.targetPolicy = {
            mode: 'role-map',
            roles: { 'bad/key~x': 'agent-a' }
        };
        const schemaResult = createDistributedRunTuningCandidate({
            manifest: dynamicRole as RallarBlackBoxDistributedRunManifest,
            changes: [{ pointer: '/ackTimeoutMs', value: 1_500 }]
        });
        expect(schemaResult).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([expect.objectContaining({
                code: 'manifest-validation',
                path: '/targetPolicy/roles/bad~1key~0x'
            })])
        });

        const invalidRoute = structuredClone(manifest()) as unknown as Record<string, any>;
        invalidRoute.recipes[0].recipe.commands[1].roomId = '';
        const agentResult = createDistributedRunTuningCandidate({
            manifest: invalidRoute as RallarBlackBoxDistributedRunManifest,
            changes: [{ pointer: '/ackTimeoutMs', value: 1_500 }]
        });
        expect(agentResult).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([expect.objectContaining({
                code: 'agent-validation',
                path: `${STREAM}/roomId`
            })])
        });

        const embedded = structuredClone(manifest()) as unknown as Record<string, any>;
        embedded.recipes[0].recipe.commands = [{
            kind: 'recipe.run',
            recipe: {
                recipeId: 'embedded',
                commands: [{
                    kind: 'rtc.stream',
                    commandId: 'embedded-stream',
                    roomId: '',
                    send: {},
                    count: 2
                }]
            }
        }];
        const embeddedResult = createDistributedRunTuningCandidate({
            manifest: embedded as RallarBlackBoxDistributedRunManifest,
            changes: [{ pointer: '/ackTimeoutMs', value: 1_500 }]
        });
        expect(embeddedResult).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([expect.objectContaining({
                code: 'agent-validation',
                path: '/recipes/0/recipe/commands/0/recipe/commands/0/roomId'
            })])
        });

        const excessiveLoop = structuredClone(manifest()) as unknown as Record<string, any>;
        excessiveLoop.recipes[0].recipe.commands[0].count = 20_001;
        const preflightResult = createDistributedRunTuningCandidate({
            manifest: excessiveLoop as RallarBlackBoxDistributedRunManifest,
            changes: [{ pointer: '/ackTimeoutMs', value: 1_500 }]
        });
        expect(preflightResult).toMatchObject({
            ok: false,
            errors: expect.arrayContaining([expect.objectContaining({
                code: 'preflight-validation',
                path: '/recipes/0/recipe/commands/0'
            })])
        });
    });
});
