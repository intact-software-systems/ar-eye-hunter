import { describe, expect, it } from 'vitest';
import type {
    ControlFleetFailureSignature,
    ControlFleetRunReport,
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';
import { filterDistributedRuns } from
    '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type { ControlDistributedRunSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    fleetAffectedAgentPatch,
    fleetRegionSelectionPatch,
    fleetReportAnalyzePatch,
    fleetReportMonitorPatch,
    fleetReportTuneHistoryPatch,
    fleetReturnPatch,
} from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-url-patches.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

const REPORT = {
    distributedRunId: 'distributed/Δ exact',
    controlRunId: 'control/Δ exact',
    group: { groupId: 'fleet/group exact' },
    recipeIds: ['rtc-smoke'],
    artifactRefs: {
        distributedRun: 'opaque:must-not-navigate:distributed',
        controlRun: 'opaque:must-not-navigate:control',
        fleetReport: 'opaque:must-not-navigate:fleet',
    },
} as ControlFleetRunReport;

const FAILURE = {
    signatureId: 'signature/Δ exact',
    category: 'runtime',
    recipeId: 'rtc-smoke',
} as ControlFleetFailureSignature;

const FLEET_STATE: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'fleet',
    controlRunId: 'old-control',
    distributedRunId: 'old-distributed',
    agentId: 'old-agent',
    recipeId: 'old-recipe',
    commandId: 'old-command',
    historyQuery: 'old-query',
    historyGroup: 'old-group',
    fleetRegion: 'eu-north',
    fleetMapLayers: ['live-agents', 'failures'],
};

describe('Recipe Console Fleet URL handoffs', () => {
    it('targets exact Monitor and Analyze run evidence without treating artifact refs as URLs', () => {
        expect(fleetReportMonitorPatch(REPORT, 'agent/Δ exact')).toEqual({
            view: 'monitor',
            controlRunId: 'control/Δ exact',
            distributedRunId: 'distributed/Δ exact',
            agentId: 'agent/Δ exact',
            recipeId: undefined,
            commandId: undefined,
        });
        expect(fleetReportAnalyzePatch(REPORT)).toEqual({
            view: 'analyze',
            controlRunId: 'control/Δ exact',
            distributedRunId: 'distributed/Δ exact',
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
        const serialized = JSON.stringify([
            fleetReportMonitorPatch(REPORT),
            fleetReportAnalyzePatch(REPORT),
        ]);
        expect(serialized).not.toContain('opaque:must-not-navigate');
    });

    it('filters Tune History by searchable exact run evidence and typed failure dimensions', () => {
        const patch = fleetReportTuneHistoryPatch(REPORT, FAILURE);
        expect(patch).toEqual({
            view: 'tune',
            controlRunId: 'control/Δ exact',
            distributedRunId: 'distributed/Δ exact',
            compareRight: 'distributed/Δ exact',
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
            historyQuery: 'distributed/Δ exact',
            historyGroup: 'fleet/group exact',
            historyRecipeId: 'rtc-smoke',
            failureCategory: undefined,
        });

        const affectedRun = {
            distributedRunId: REPORT.distributedRunId,
            controlRunId: REPORT.controlRunId,
            state: 'failed',
            createdAtEpochMs: 100,
            updatedAtEpochMs: 200,
            targetAgentIds: ['agent-a'],
            commandLinks: [],
            manifest: {
                schemaVersion: 1,
                distributedRunId: REPORT.distributedRunId,
                controlRunId: REPORT.controlRunId,
                group: {
                    applicationId: 'rallar-server',
                    workspaceId: 'default',
                    groupId: REPORT.group.groupId,
                },
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: ['agent-a'],
                },
                recipes: [{ recipeId: REPORT.recipeIds[0] }],
            },
            rollup: {
                state: 'failed',
                ok: false,
                failures: [{
                    kind: 'recipe',
                    key: REPORT.recipeIds[0]!,
                    state: 'failed',
                    required: true,
                    error: {
                        code: 'RAW_RUNTIME_FAILURE',
                        message: 'Raw runtime evidence, not the Fleet slug.',
                    },
                }],
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
            },
        } satisfies ControlDistributedRunSnapshot;
        expect(filterDistributedRuns([affectedRun], {
            query: patch.historyQuery,
            groupId: patch.historyGroup,
            recipeId: patch.historyRecipeId,
            failureCategory: patch.failureCategory,
        }).map(run => run.distributedRunId)).toEqual([
            REPORT.distributedRunId,
        ]);
    });

    it('commits region and affected-agent selections as minimal patches', () => {
        expect(fleetRegionSelectionPatch('us-east')).toEqual({
            fleetRegion: 'us-east',
        });
        expect(fleetRegionSelectionPatch(undefined)).toEqual({
            fleetRegion: undefined,
        });
        expect(fleetAffectedAgentPatch('agent-b')).toEqual({
            agentId: 'agent-b',
        });
    });

    it('preserves Fleet URL state across a handoff and explicit return trip', () => {
        const monitorState = {
            ...FLEET_STATE,
            ...fleetReportMonitorPatch(REPORT, 'agent-b'),
        };
        const returned = { ...monitorState, ...fleetReturnPatch() };

        expect(returned).toMatchObject({
            view: 'fleet',
            distributedRunId: 'distributed/Δ exact',
            controlRunId: 'control/Δ exact',
            agentId: 'agent-b',
            fleetRegion: 'eu-north',
            fleetMapLayers: ['live-agents', 'failures'],
            historyQuery: 'old-query',
            historyGroup: 'old-group',
        });
        expect(fleetReturnPatch()).toEqual({ view: 'fleet' });
    });
});
