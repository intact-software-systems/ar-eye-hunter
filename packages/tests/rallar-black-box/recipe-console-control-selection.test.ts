import { describe, expect, it } from 'vitest';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import {
    deriveRecipeConsoleControlSelection,
    recipeConsoleControlRunSelectionPatch,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import type {
    RallarBlackBoxDistributedGroupRef,
    RallarBlackBoxDistributedRunState,
} from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const bootstrapGroup: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'bootstrap-app',
    workspaceId: 'bootstrap-workspace',
    groupId: 'bootstrap-group',
};

const baseUrlState: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'execute',
};

function controlAgent(
    runId: string,
    agentId: string,
    group: RallarBlackBoxDistributedGroupRef = bootstrapGroup,
): ControlAgentSnapshot {
    return {
        runId,
        agentId,
        connected: true,
        lastSeenAtEpochMs: 9_000,
        lastHeartbeatAtEpochMs: 9_000,
        identity: {
            principalId: `${agentId}-principal`,
            sessionId: `${agentId}-session`,
            ...group,
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: [],
    };
}

function controlRun(
    runId: string,
    agents: readonly ControlAgentSnapshot[] = [],
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 1_000,
        updatedAtEpochMs: 9_000,
        agents,
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    state: RallarBlackBoxDistributedRunState = 'running',
    group: RallarBlackBoxDistributedGroupRef = bootstrapGroup,
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        state,
        createdAtEpochMs: 2_000,
        updatedAtEpochMs: 9_000,
        targetAgentIds: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group,
            recipes: [{ recipeId: 'health-only', required: true }],
            targetPolicy: {
                mode: 'selected-agents',
                agentIds: [],
                expectedParticipantCount: 1,
            },
        },
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
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                blockingFailures: state === 'failed' ? 1 : 0,
            },
            failures: [],
        },
    };
}

function derive(input: Readonly<{
    urlState?: RecipeConsoleUrlState;
    snapshot?: ControlServerSnapshot;
    bootstrapRunId?: string;
    queryStatus?: 'connecting' | 'live' | 'partial' | 'stale' | 'offline';
}>) {
    return deriveRecipeConsoleControlSelection({
        urlState: input.urlState ?? baseUrlState,
        snapshot: input.snapshot,
        bootstrapRunId: input.bootstrapRunId,
        bootstrapGroup,
        queryStatus: input.queryStatus ?? 'live',
        nowEpochMs: 10_000,
    });
}

describe('Recipe Console control selection', () => {
    it('gives an explicit URL control run precedence over bootstrap and collection order', () => {
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-url' },
            bootstrapRunId: 'run-bootstrap',
            snapshot: {
                runs: [controlRun('run-first'), controlRun('run-bootstrap'), controlRun('run-url')],
            },
        });

        expect(selected.controlRunId).toBe('run-url');
        expect(selected.controlRun?.runId).toBe('run-url');
        expect(selected.controlRunSource).toBe('url');
    });

    it('preserves unavailable explicit IDs with visible issues and never falls back', () => {
        const selected = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'missing-run',
                distributedRunId: 'missing-distributed',
                agentId: 'missing-agent',
            },
            bootstrapRunId: 'run-bootstrap',
            snapshot: { runs: [controlRun('run-bootstrap')] },
        });

        expect(selected).toMatchObject({
            controlRunId: 'missing-run',
            controlRun: undefined,
            distributedRunId: 'missing-distributed',
            distributedRun: undefined,
            agentId: 'missing-agent',
            agent: undefined,
        });
        expect(selected.issues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'unavailable', value: 'missing-run' }),
            expect.objectContaining({ field: 'distributedRuns', code: 'unavailable' }),
        ]);
    });

    it('waits for authoritative collections and parent selection before diagnosing deep-link IDs', () => {
        const connecting = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'distributed-a',
                agentId: 'agent-a',
            },
            queryStatus: 'connecting',
        });
        const partial = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'distributed-a',
            },
            queryStatus: 'partial',
            snapshot: { runs: [controlRun('run-a')] },
        });
        const ambiguousParent = derive({
            urlState: {
                ...baseUrlState,
                distributedRunId: 'distributed-a',
                agentId: 'agent-a',
            },
            snapshot: { runs: [controlRun('run-a'), controlRun('run-b')], distributedRuns: [] },
        });

        expect(connecting.issues).toEqual([]);
        expect(partial.issues).toEqual([
            expect.objectContaining({ field: 'distributedRuns', code: 'unavailable' }),
        ]);
        expect(ambiguousParent.issues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'ambiguous' }),
        ]);
    });

    it('diagnoses missing child IDs once the selected parent collections are authoritative', () => {
        const selected = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'missing-distributed',
                agentId: 'missing-agent',
            },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [],
            },
        });

        expect(selected).toMatchObject({
            distributedRunId: 'missing-distributed',
            distributedRun: undefined,
            agentId: 'missing-agent',
            agent: undefined,
        });
        expect(selected.issues).toEqual([
            expect.objectContaining({
                field: 'distributedRunId',
                code: 'unavailable',
                value: 'missing-distributed',
            }),
            expect.objectContaining({
                field: 'agentId',
                code: 'unavailable',
                value: 'missing-agent',
            }),
        ]);
    });

    it('prefers the bootstrap run only when that run is present', () => {
        const present = derive({
            bootstrapRunId: 'run-bootstrap',
            snapshot: { runs: [controlRun('run-other'), controlRun('run-bootstrap')] },
        });
        const absent = derive({
            bootstrapRunId: 'missing-bootstrap',
            snapshot: { runs: [controlRun('run-a'), controlRun('run-b')] },
        });

        expect(present).toMatchObject({
            controlRunId: 'run-bootstrap',
            controlRunSource: 'bootstrap',
            urlReplacePatch: { controlRunId: 'run-bootstrap' },
        });
        expect(absent.controlRun).toBeUndefined();
        expect(absent.controlRunId).toBeUndefined();
    });

    it('selects a sole server run and suggests a history replacement', () => {
        const selected = derive({ snapshot: { runs: [controlRun('run-only')] } });

        expect(selected).toMatchObject({
            controlRunId: 'run-only',
            controlRunSource: 'sole-run',
            urlReplacePatch: { controlRunId: 'run-only' },
        });
    });

    it('falls back to the sole server run when the bootstrap run is absent', () => {
        const selected = derive({
            bootstrapRunId: 'missing-bootstrap',
            snapshot: { runs: [controlRun('run-only')] },
        });

        expect(selected).toMatchObject({
            controlRunId: 'run-only',
            controlRunSource: 'sole-run',
            urlReplacePatch: { controlRunId: 'run-only' },
        });
    });

    it('reports multiple unselected runs as ambiguous instead of using runs[0]', () => {
        const selected = derive({
            snapshot: { runs: [controlRun('run-first'), controlRun('run-second')] },
        });

        expect(selected.controlRunId).toBeUndefined();
        expect(selected.controlRun).toBeUndefined();
        expect(selected.urlReplacePatch).toBeUndefined();
        expect(selected.issues).toContainEqual(expect.objectContaining({
            field: 'controlRunId',
            code: 'ambiguous',
        }));
    });

    it('resolves a distributed run only when it belongs to the selected control run', () => {
        const wrongRun = distributedRun('distributed-other', 'run-other');
        const selected = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-selected',
                distributedRunId: wrongRun.distributedRunId,
            },
            snapshot: {
                runs: [controlRun('run-selected'), controlRun('run-other')],
                distributedRuns: [wrongRun],
            },
        });

        expect(selected.distributedRunId).toBe('distributed-other');
        expect(selected.distributedRun).toBeUndefined();
        expect(selected.issues).toContainEqual(expect.objectContaining({
            field: 'distributedRunId',
            code: 'incompatible',
            value: 'distributed-other',
        }));
    });

    it.each([
        { states: [] as const, kind: 'none', count: 0 },
        { states: ['running'] as const, kind: 'sole', count: 1 },
        { states: ['draft', 'running'] as const, kind: 'ambiguous', count: 2 },
    ])('derives $kind active-run context without treating terminal runs as active', ({ states, kind, count }) => {
        const active = states.map((state, index) =>
            distributedRun(`active-${index}`, 'run-a', state)
        );
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [
                    ...active,
                    distributedRun('terminal-passed', 'run-a', 'passed'),
                    distributedRun('other-control-run', 'run-b', 'running'),
                ],
            },
        });

        expect(selected.activeRunContext.kind).toBe(kind);
        expect(selected.activeRunContext.runs).toHaveLength(count);
    });

    it('orders equally recent active runs deterministically by distributed run ID', () => {
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [
                    distributedRun('z-run', 'run-a', 'running'),
                    distributedRun('a-run', 'run-a', 'draft'),
                ],
            },
        });

        expect(selected.activeRunContext.runs.map(run => run.distributedRunId))
            .toEqual(['a-run', 'z-run']);
    });

    it('uses the explicit distributed group, then sole-active group, then exact bootstrap group', () => {
        const selectedGroup = { applicationId: 'selected-app', workspaceId: 'selected-workspace', groupId: 'selected-group' };
        const activeGroup = { applicationId: 'active-app', workspaceId: 'active-workspace', groupId: 'active-group' };
        const explicit = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a', distributedRunId: 'selected' },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [
                    distributedRun('selected', 'run-a', 'passed', selectedGroup),
                    distributedRun('active', 'run-a', 'running', activeGroup),
                ],
            },
        });
        const soleActive = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [distributedRun('active', 'run-a', 'running', activeGroup)],
            },
        });
        const fallback = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: { runs: [controlRun('run-a')], distributedRuns: [] },
        });

        expect(explicit.groupContext).toEqual({ source: 'selected-distributed-run', group: selectedGroup });
        expect(soleActive.groupContext).toEqual({ source: 'sole-active-distributed-run', group: activeGroup });
        expect(fallback.groupContext).toEqual({ source: 'bootstrap', group: bootstrapGroup });
    });

    it('restores the selected agent only from the selected control run', () => {
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a', agentId: 'agent-a' },
            snapshot: {
                runs: [
                    controlRun('run-a', [controlAgent('run-a', 'agent-a')]),
                    controlRun('run-b', [controlAgent('run-b', 'agent-b')]),
                ],
            },
        });

        expect(selected.agentId).toBe('agent-a');
        expect(selected.agent?.agentId).toBe('agent-a');
    });

    it('retains last-known board evidence while stale data is never currently safe', () => {
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            queryStatus: 'stale',
            snapshot: {
                runs: [controlRun('run-a', [controlAgent('run-a', 'agent-a')])],
            },
        });

        expect(selected.boardRows).toHaveLength(1);
        expect(selected.lastKnownTargetableCount).toBe(1);
        expect(selected.safeTargetableCount).toBe(0);
    });

    it('clears dependent agent and incompatible distributed IDs in a run-selection URL patch', () => {
        const distributedRuns = [
            distributedRun('distributed-a', 'run-a'),
            distributedRun('distributed-b', 'run-b'),
        ];
        const state = {
            ...baseUrlState,
            controlRunId: 'run-a',
            distributedRunId: 'distributed-a',
            agentId: 'agent-a',
        };

        expect(recipeConsoleControlRunSelectionPatch({
            state,
            controlRunId: 'run-b',
            distributedRuns,
        })).toEqual({
            controlRunId: 'run-b',
            distributedRunId: undefined,
            agentId: undefined,
        });
        expect(recipeConsoleControlRunSelectionPatch({
            state: { ...state, distributedRunId: 'distributed-b' },
            controlRunId: 'run-b',
            distributedRuns,
        })).toEqual({
            controlRunId: 'run-b',
            distributedRunId: 'distributed-b',
            agentId: undefined,
        });
    });
});
