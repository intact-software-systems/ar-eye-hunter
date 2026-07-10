import { describe, expect, it } from 'vitest';
import {
    projectDistributedRunHistoryLabels,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { ControlDistributedRunSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

function distributedRun(): ControlDistributedRunSnapshot {
    return {
        distributedRunId: 'distributed-a',
        controlRunId: 'control-a',
        state: 'failed',
        createdAtEpochMs: 100,
        updatedAtEpochMs: 200,
        targetAgentIds: [],
        commandLinks: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId: 'distributed-a',
            controlRunId: 'control-a',
            displayName: 'Nightly RTC smoke',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-a',
            },
            targetPolicy: { mode: 'selected-agents', agentIds: [] },
            recipes: [{ recipeId: 'rtc-stream', profile: 'smoke', role: 'sender' }],
        },
        rollup: {
            state: 'failed',
            ok: false,
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: 1,
                passedParticipants: 0,
                failedParticipants: 1,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: 0,
                failedRecipes: 1,
                blockingFailures: 1,
            },
            failures: [{
                kind: 'recipe',
                key: 'rtc-stream',
                state: 'failed',
                required: true,
                error: {
                    code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                    message: 'RTC stream pacing exceeded its threshold.',
                },
            }],
        },
    };
}

describe('distributed-run History labels', () => {
    it('projects safe group, recipe, profile, and actual failure labels once', () => {
        expect(projectDistributedRunHistoryLabels(distributedRun())).toEqual({
            displayName: 'Nightly RTC smoke',
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-a',
                label: 'rallar-server / default / group-a',
            },
            recipes: [{
                recipeId: 'rtc-stream',
                profile: 'smoke',
                role: 'sender',
                label: 'rtc-stream · smoke',
            }],
            failures: [{
                category: 'rtc-stream-performance',
                code: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED',
                message: 'RTC stream pacing exceeded its threshold.',
                label: 'RALLAR_BLACK_BOX_RTC_STREAM_THRESHOLD_FAILED: RTC stream pacing exceeded its threshold.',
            }],
        });
    });

    it('treats malformed manifest fields as absent while preserving fallback indexes', () => {
        const malformed = structuredClone(distributedRun()) as unknown as Record<string, any>;
        malformed.manifest.displayName = { secret: 'not-a-label' };
        malformed.manifest.group = {
            applicationId: ['not-a-label'],
            workspaceId: 'default',
            groupId: null,
        };
        malformed.manifest.recipes = [null, { profile: 'smoke' }];

        expect(projectDistributedRunHistoryLabels(
            malformed as ControlDistributedRunSnapshot,
        )).toMatchObject({
            displayName: undefined,
            group: {
                applicationId: undefined,
                workspaceId: 'default',
                groupId: undefined,
                label: 'default',
            },
            recipes: [{
                recipeId: 'recipe-2',
                profile: 'smoke',
                label: 'recipe-2 · smoke',
            }],
        });
    });

    it('does not invent a readiness failure for a nonterminal run without recorded failures', () => {
        const running = structuredClone(distributedRun());
        (running as { state: string }).state = 'running';
        (running.rollup as { failures: unknown[] }).failures = [];
        (running.rollup as { state: string }).state = 'running';

        expect(projectDistributedRunHistoryLabels(running).failures).toEqual([]);
    });

    it('does not stringify malformed failure code or message values into labels', () => {
        const malformed = structuredClone(distributedRun()) as unknown as Record<string, any>;
        malformed.rollup.failures[0].error = {
            code: { secret: 'not-a-code' },
            message: ['not-a-message'],
        };

        expect(projectDistributedRunHistoryLabels(
            malformed as ControlDistributedRunSnapshot,
        ).failures).toEqual([{
            category: 'unknown',
            code: undefined,
            message: 'Recorded failure',
            label: 'Recorded failure',
        }]);
    });
});
