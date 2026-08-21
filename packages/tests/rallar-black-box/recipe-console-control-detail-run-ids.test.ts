import { describe, expect, it } from 'vitest';
import { mergeControlRunDetails, recipeConsoleDetailRunIds } from '../../../apps/rallar-black-box/src/recipe-console/control/control-detail-run-ids.ts';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';

function controlRun(runId: string, eventId?: string): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        agents: [],
        commands: [],
        results: [],
        events: eventId
            ? [{
                kind: 'event',
                protocolVersion: 1,
                runId,
                agentId: 'agent-a',
                eventId,
                atEpochMs: 2,
                payload: {}
            }]
            : [],
        stats: [],
        reports: [],
        heartbeats: []
    };
}

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    state: ControlDistributedRunSnapshot['state']
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'app-a',
                workspaceId: 'workspace-a',
                groupId: 'group-a'
            },
            recipes: [],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: []
            },
            startMode: 'manual',
            ackTimeoutMs: 15_000
        },
        state,
        createdAtEpochMs: 1,
        updatedAtEpochMs: 2,
        targetAgentIds: [],
        commandLinks: [],
        rollup: {
            state,
            ok: state === 'passed',
            summary: {
                participants: 0,
                requiredParticipants: 0,
                readyParticipants: 0,
                passedParticipants: 0,
                failedParticipants: 0,
                recipes: 0,
                requiredRecipes: 0,
                passedRecipes: 0,
                failedRecipes: 0,
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: 0
            },
            failures: []
        }
    };
}

describe('Recipe Console detailed control-run selection', () => {
    it('selects explicit, bootstrap, selected, compared, and active owners in stable order', () => {
        const runIds = [
            'explicit-run',
            'bootstrap-run',
            'selected-owner',
            'left-owner',
            'right-owner',
            'active-owner',
            'terminal-owner'
        ];
        const snapshot: ControlServerSnapshot = {
            runs: runIds.map((runId) => controlRun(runId)),
            distributedRuns: [
                distributedRun('selected-distributed', 'selected-owner', 'running'),
                distributedRun('left-distributed', 'left-owner', 'passed'),
                distributedRun('right-distributed', 'right-owner', 'failed'),
                distributedRun('active-distributed', 'active-owner', 'waiting-for-ack'),
                distributedRun('terminal-distributed', 'terminal-owner', 'cancelled')
            ]
        };

        expect(recipeConsoleDetailRunIds({
            snapshot,
            bootstrapRunId: 'bootstrap-run',
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'tune',
                controlRunId: 'explicit-run',
                distributedRunId: 'selected-distributed',
                compareLeft: 'left-distributed',
                compareRight: 'right-distributed'
            }
        })).toEqual([
            'explicit-run',
            'bootstrap-run',
            'selected-owner',
            'left-owner',
            'right-owner',
            'active-owner'
        ]);
    });

    it('omits unavailable IDs, de-duplicates owners, and ignores terminal-only runs', () => {
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('run-a'), controlRun('run-b')],
            distributedRuns: [
                distributedRun('selected', 'run-a', 'running'),
                distributedRun('same-owner-active', 'run-a', 'staging'),
                distributedRun('terminal', 'run-b', 'passed')
            ]
        };

        expect(recipeConsoleDetailRunIds({
            snapshot,
            bootstrapRunId: 'missing-bootstrap',
            urlState: {
                v: 1,
                experience: 'recipe-console',
                view: 'monitor',
                controlRunId: 'missing-explicit',
                distributedRunId: 'selected',
                compareLeft: 'missing-distributed'
            }
        })).toEqual(['run-a']);
    });

    it('replaces only matching index runs without changing index order', () => {
        const index: ControlServerSnapshot = {
            runs: [controlRun('run-a'), controlRun('run-b')],
            distributedRuns: []
        };
        const detailed = controlRun('run-b', 'event-b');

        const merged = mergeControlRunDetails(index, [detailed]);

        expect(merged.runs.map((run) => run.runId)).toEqual(['run-a', 'run-b']);
        expect(merged.runs[0]).toBe(index.runs[0]);
        expect(merged.runs[1]).toBe(detailed);
        expect(merged.distributedRuns).toBe(index.distributedRuns);
    });
});
