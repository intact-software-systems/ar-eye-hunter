import { describe, expect, it } from 'vitest';
import { resolveFleetFailureRunEvidence } from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-failure-evidence.ts';
import {
    fleetAffectedAgentPatch,
    fleetMapLayerTogglePatch,
    fleetRegionSelectionPatch,
    fleetReportAnalyzePatch,
    fleetReportMonitorPatch,
    fleetReportSelectionPatch,
    fleetReportTuneHistoryPatch,
    fleetReturnPatch
} from '../../../apps/rallar-black-box/src/recipe-console/fleet/fleet-url-patches.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import type { ControlDistributedRunSnapshot } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { filterDistributedRuns } from '../../../packages/shared-test/rallar-bb-test/distributed-run-monitor.ts';
import type {
    ControlFleetAgentRunOutcome,
    ControlFleetFailureSignature,
    ControlFleetRunReport
} from '../../../packages/shared-test/rallar-bb-test/fleet-report.ts';

function agentOutcome(
    agentId: string,
    failureSignatureIds: readonly string[]
): ControlFleetAgentRunOutcome {
    const failed = failureSignatureIds.length > 0;
    return {
        agentId,
        label: { agentId, region: 'eu-north', provider: 'provider-a' },
        state: failed ? 'failed' : 'passed',
        ok: !failed,
        missing: false,
        flaky: false,
        stale: false,
        commandCount: 1,
        failedCommandCount: failed ? 1 : 0,
        resultCount: 1,
        eventCount: 1,
        diagnosticCount: failed ? 1 : 0,
        reconnectCount: 0,
        durationMs: 100,
        failureSignatureIds
    };
}

function failureSignature(signatureId: string): ControlFleetFailureSignature {
    return {
        signatureId,
        category: 'runtime',
        title: 'Recipe step threw at runtime',
        normalizedMessage: 'runtime failure in <recipe>',
        recipeId: 'rtc-smoke',
        count: 1,
        affectedAgents: [],
        affectedRegions: ['eu-north'],
        affectedRuns: [],
        likelyCause: 'The recipe under test raised a runtime error.',
        nextAction: 'Open the proving run evidence for this signature.'
    };
}

const REPORT: ControlFleetRunReport = {
    fleetReportSchemaVersion: 1,
    distributedRunId: 'distributed/Δ exact',
    controlRunId: 'control/Δ exact',
    generatedAtEpochMs: 1_700_000_000_000,
    state: 'passed',
    ok: true,
    group: {
        applicationId: 'rallar-server',
        workspaceId: 'default',
        groupId: 'fleet/group exact'
    },
    recipeIds: ['rtc-smoke'],
    runDurationMs: 500,
    summary: {
        agents: 1,
        regions: 1,
        passed: 1,
        failed: 0,
        missing: 0,
        flaky: 0,
        stale: 0,
        passRate: 1,
        failureGroups: 0
    },
    timing: {
        run: { count: 1, p95Ms: 500 },
        commands: { count: 1, p95Ms: 100 }
    },
    agents: [agentOutcome('agent/Δ exact', [])],
    regions: [{
        region: 'eu-north',
        provider: 'provider-a',
        agentCount: 1,
        passed: 1,
        failed: 0,
        missing: 0,
        flaky: 0,
        stale: 0,
        passRate: 1,
        timing: { count: 1, p95Ms: 100 }
    }],
    failureSignatures: [],
    artifactRefs: {
        distributedRun: 'opaque:must-not-navigate:distributed',
        controlRun: 'opaque:must-not-navigate:control',
        fleetReport: 'opaque:must-not-navigate:fleet'
    }
};

const FAILURE: ControlFleetFailureSignature = failureSignature(
    'signature/Δ exact'
);

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
    fleetMapLayers: ['live-agents', 'failures']
};

describe('Recipe Console Fleet URL handoffs', () => {
    it('resolves a proving run and affected agent from the same exact report', () => {
        const failure: ControlFleetFailureSignature = {
            ...FAILURE,
            affectedRuns: ['run/non-proving', 'run/proving'],
            affectedAgents: ['agent/non-proving', 'agent/proving']
        };
        const nonProving: ControlFleetRunReport = {
            ...REPORT,
            distributedRunId: 'run/non-proving',
            agents: [agentOutcome('agent/non-proving', ['another-signature'])],
            failureSignatures: []
        };
        const proving: ControlFleetRunReport = {
            ...REPORT,
            distributedRunId: 'run/proving',
            agents: [agentOutcome('agent/proving', [FAILURE.signatureId])],
            failureSignatures: []
        };
        const unrelated: ControlFleetRunReport = {
            ...REPORT,
            distributedRunId: 'run/unrelated',
            agents: [agentOutcome('agent/non-proving', [FAILURE.signatureId])],
            failureSignatures: [failureSignature(FAILURE.signatureId)]
        };

        expect(resolveFleetFailureRunEvidence({
            failure,
            preferredRunId: nonProving.distributedRunId,
            reports: [unrelated, nonProving, proving]
        })).toEqual({
            report: proving,
            agentId: 'agent/proving'
        });
    });

    it('does not infer an agent that the exact proving report cannot support', () => {
        const failure: ControlFleetFailureSignature = {
            ...FAILURE,
            affectedRuns: ['run/report-level-proof'],
            affectedAgents: ['agent/aggregate-only']
        };
        const proving: ControlFleetRunReport = {
            ...REPORT,
            distributedRunId: 'run/report-level-proof',
            agents: [agentOutcome('agent/aggregate-only', [])],
            failureSignatures: [failureSignature(FAILURE.signatureId)]
        };

        expect(resolveFleetFailureRunEvidence({
            failure,
            reports: [proving]
        })).toEqual({ report: proving });
    });

    it('targets exact Monitor and Analyze run evidence without treating artifact refs as URLs', () => {
        expect(fleetReportMonitorPatch(REPORT, 'agent/Δ exact')).toEqual({
            view: 'monitor',
            controlRunId: 'control/Δ exact',
            distributedRunId: 'distributed/Δ exact',
            agentId: 'agent/Δ exact',
            recipeId: undefined,
            commandId: undefined
        });
        expect(fleetReportAnalyzePatch(REPORT)).toEqual({
            view: 'analyze',
            controlRunId: 'control/Δ exact',
            distributedRunId: 'distributed/Δ exact',
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined
        });
        const serialized = JSON.stringify([
            fleetReportMonitorPatch(REPORT),
            fleetReportAnalyzePatch(REPORT)
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
            failureCategory: undefined
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
                    groupId: REPORT.group.groupId
                },
                targetPolicy: {
                    mode: 'selected-agents',
                    agentIds: ['agent-a']
                },
                recipes: [{ recipeId: REPORT.recipeIds[0] }]
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
                        message: 'Raw runtime evidence, not the Fleet slug.'
                    }
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
                    groupAssertions: 0,
                    passedGroupAssertions: 0,
                    failedGroupAssertions: 0,
                    blockingFailures: 1
                }
            }
        } satisfies ControlDistributedRunSnapshot;
        expect(
            filterDistributedRuns([affectedRun], {
                query: patch.historyQuery,
                groupId: patch.historyGroup,
                recipeId: patch.historyRecipeId,
                failureCategory: patch.failureCategory
            }).map((run) => run.distributedRunId)
        ).toEqual([
            REPORT.distributedRunId
        ]);
    });

    it('commits region and affected-agent selections as minimal patches', () => {
        expect(fleetRegionSelectionPatch('us-east')).toEqual({
            fleetRegion: 'us-east'
        });
        expect(fleetRegionSelectionPatch(undefined)).toEqual({
            fleetRegion: undefined
        });
        expect(fleetAffectedAgentPatch('agent-b')).toEqual({
            agentId: 'agent-b'
        });
        expect(fleetReportSelectionPatch(REPORT)).toEqual({
            controlRunId: 'control/Δ exact',
            distributedRunId: 'distributed/Δ exact'
        });
    });

    it('toggles map layers in canonical URL order with exact all and none states', () => {
        const withoutFailures = fleetMapLayerTogglePatch(
            undefined,
            'failures',
            false
        );
        expect(withoutFailures).toEqual({
            fleetMapLayers: [
                'live-agents',
                'historical-regions',
                'observed-routes'
            ]
        });
        expect(fleetMapLayerTogglePatch(
            withoutFailures.fleetMapLayers,
            'failures',
            true
        )).toEqual({ fleetMapLayers: undefined });
        expect(fleetMapLayerTogglePatch([], 'observed-routes', true)).toEqual({
            fleetMapLayers: ['observed-routes']
        });
        expect(fleetMapLayerTogglePatch(
            ['observed-routes'],
            'observed-routes',
            false
        )).toEqual({ fleetMapLayers: [] });
        expect(fleetMapLayerTogglePatch(
            ['failures', 'live-agents', 'failures'],
            'historical-regions',
            true
        )).toEqual({
            fleetMapLayers: [
                'live-agents',
                'historical-regions',
                'failures'
            ]
        });
    });

    it('preserves Fleet URL state across a handoff and explicit return trip', () => {
        const monitorState = {
            ...FLEET_STATE,
            ...fleetReportMonitorPatch(REPORT, 'agent-b')
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
            historyGroup: 'old-group'
        });
        expect(fleetReturnPatch()).toEqual({ view: 'fleet' });
    });
});
