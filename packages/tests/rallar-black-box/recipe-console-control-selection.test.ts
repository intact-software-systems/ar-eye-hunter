import { describe, expect, it } from 'vitest';
import { controlAgentBoardWorkForTest } from '../../../apps/rallar-black-box/src/control-agent-board.ts';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot
} from '../../../apps/rallar-black-box/src/control-run-manager.ts';
import { bindControlSelectionIndexToSnapshot } from '../../../apps/rallar-black-box/src/control-selection-index-binding.ts';
import { createControlSelectionIndexCache } from '../../../apps/rallar-black-box/src/recipe-console/control/control-selection-index-cache.ts';
import {
    deriveRecipeConsoleControlSelection,
    recipeConsoleControlRunSelectionPatch,
    recipeConsoleControlSelectionWorkForTest
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-selection.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { createControlSnapshotSelectionIndex } from '../../../packages/shared-test/rallar-bb-test/control-snapshot-selection-index.ts';
import type { RallarBlackBoxDistributedGroupRef, RallarBlackBoxDistributedRunState } from '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';

const bootstrapGroup: RallarBlackBoxDistributedGroupRef = {
    applicationId: 'bootstrap-app',
    workspaceId: 'bootstrap-workspace',
    groupId: 'bootstrap-group'
};

const baseUrlState: RecipeConsoleUrlState = {
    v: 1,
    experience: 'recipe-console',
    view: 'execute'
};

function controlAgent(
    runId: string,
    agentId: string,
    group: RallarBlackBoxDistributedGroupRef = bootstrapGroup
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
            ...group
        },
        connectionSequence: 1,
        reconnectCount: 0,
        receivedResultCount: 0,
        receivedEventCount: 0,
        completedCommandIds: [],
        resumeCompletedCommandIds: []
    };
}

function controlRun(
    runId: string,
    agents: readonly ControlAgentSnapshot[] = []
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
        heartbeats: []
    };
}

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    state: RallarBlackBoxDistributedRunState = 'running',
    group: RallarBlackBoxDistributedGroupRef = bootstrapGroup
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
                expectedParticipantCount: 1
            }
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
                groupAssertions: 0,
                passedGroupAssertions: 0,
                failedGroupAssertions: 0,
                blockingFailures: state === 'failed' ? 1 : 0
            },
            failures: []
        }
    };
}

function derive(
    input: Readonly<{
        urlState?: RecipeConsoleUrlState;
        snapshot?: ControlServerSnapshot;
        bootstrapRunId?: string;
        queryStatus?: 'connecting' | 'live' | 'partial' | 'stale' | 'offline';
    }>
) {
    return deriveRecipeConsoleControlSelection({
        urlState: input.urlState ?? baseUrlState,
        snapshot: input.snapshot,
        bootstrapRunId: input.bootstrapRunId,
        bootstrapGroup,
        queryStatus: input.queryStatus ?? 'live',
        nowEpochMs: 10_000
    });
}

function forbidGlobalTraversal<Value>(values: readonly Value[]): readonly Value[] {
    return new Proxy(values, {
        get(target, property, receiver) {
            if (
                property === Symbol.iterator || property === 'find' ||
                property === 'filter' || property === 'map' || property === 'some' ||
                property === 'forEach'
            ) {
                throw new Error('global collection traversal is forbidden');
            }
            return Reflect.get(target, property, receiver);
        }
    });
}

describe('Recipe Console control selection', () => {
    it('reuses indexed topology while rebinding every selected value to the current poll', () => {
        const first: ControlServerSnapshot = {
            runs: [
                controlRun('run-other'),
                controlRun('run-selected', [
                    controlAgent('run-selected', 'agent-selected')
                ])
            ],
            distributedRuns: [
                distributedRun('distributed-other', 'run-other'),
                distributedRun('distributed-selected', 'run-selected'),
                distributedRun('distributed-active', 'run-selected', 'ready')
            ]
        };
        const current = structuredClone(first);
        const selectionIndex = bindControlSelectionIndexToSnapshot(
            current,
            createControlSnapshotSelectionIndex(first)
        );
        const urlState = {
            ...baseUrlState,
            controlRunId: 'run-selected',
            distributedRunId: 'distributed-selected',
            agentId: 'agent-selected'
        };

        const legacy = derive({ urlState, snapshot: current });
        const indexed = deriveRecipeConsoleControlSelection({
            urlState,
            snapshot: current,
            selectionIndex,
            bootstrapGroup,
            queryStatus: 'live',
            nowEpochMs: 10_000
        });

        expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
        expect(indexed.controlRun).toBe(current.runs[1]);
        expect(indexed.distributedRun).toBe(current.distributedRuns![1]);
        expect(indexed.agent).toBe(current.runs[1]!.agents[0]);
        expect(indexed.activeRunContext.runs).toEqual([
            current.distributedRuns![2],
            current.distributedRuns![1]
        ]);
        expect(indexed.boardRows[0]!.identity)
            .toBe(current.runs[1]!.agents[0]!.identity);
        expect(recipeConsoleControlSelectionWorkForTest(indexed)).toEqual({
            indexed: true,
            fallback: false,
            controlRunLookupCount: 1,
            distributedRunLookupCount: 1,
            agentLookupCount: 1,
            activeRunProjectionCount: 2
        });
    });

    it('reaches the selected tail of 5,000 current-poll pairs without global traversal', () => {
        const scale = 5_000;
        const runs = Array.from({ length: scale }, (_, ordinal) => {
            const runId = `control-${ordinal}`;
            return controlRun(runId, [controlAgent(runId, `agent-${ordinal}`)]);
        });
        const distributedRuns = runs.map((run, ordinal) => distributedRun(`distributed-${ordinal}`, run.runId));
        const first: ControlServerSnapshot = { runs, distributedRuns };
        const clone = structuredClone(first);
        const current: ControlServerSnapshot = {
            ...clone,
            runs: forbidGlobalTraversal(clone.runs),
            distributedRuns: forbidGlobalTraversal(clone.distributedRuns!)
        };
        const tail = scale - 1;
        const indexed = deriveRecipeConsoleControlSelection({
            urlState: {
                ...baseUrlState,
                controlRunId: `control-${tail}`,
                distributedRunId: `distributed-${tail}`,
                agentId: `agent-${tail}`
            },
            snapshot: current,
            selectionIndex: bindControlSelectionIndexToSnapshot(
                current,
                createControlSnapshotSelectionIndex(first)
            ),
            bootstrapGroup,
            queryStatus: 'live',
            nowEpochMs: 10_000
        });

        expect(indexed.controlRun).toBe(current.runs[tail]);
        expect(indexed.distributedRun).toBe(current.distributedRuns![tail]);
        expect(indexed.agent).toBe(current.runs[tail]!.agents[0]);
        expect(recipeConsoleControlSelectionWorkForTest(indexed)).toEqual({
            indexed: true,
            fallback: false,
            controlRunLookupCount: 1,
            distributedRunLookupCount: 1,
            agentLookupCount: 1,
            activeRunProjectionCount: 1
        });
    });

    it('keeps a trusted absent ID O(1) without scanning either current collection', () => {
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('run-a')],
            distributedRuns: [distributedRun('distributed-a', 'run-a')]
        };
        const selectionIndex = createControlSelectionIndexCache().get(snapshot);
        Object.defineProperties(snapshot, {
            runs: { value: forbidGlobalTraversal(snapshot.runs) },
            distributedRuns: {
                value: forbidGlobalTraversal(snapshot.distributedRuns!)
            }
        });

        const selection = deriveRecipeConsoleControlSelection({
            urlState: { ...baseUrlState, controlRunId: 'missing-run' },
            snapshot,
            selectionIndex,
            bootstrapGroup,
            queryStatus: 'live',
            nowEpochMs: 10_000
        });

        expect(selection.controlRun).toBeUndefined();
        expect(recipeConsoleControlSelectionWorkForTest(selection)).toMatchObject({
            indexed: true,
            fallback: false,
            controlRunLookupCount: 1
        });
    });

    it('projects zero active or board runs for 5,000 terminal runs', () => {
        const control = controlRun('run-a', [controlAgent('run-a', 'agent-a')]);
        const terminalRuns = Array.from({ length: 5_000 }, (_, ordinal) => distributedRun(`terminal-${ordinal}`, 'run-a', 'passed'));
        const snapshot: ControlServerSnapshot = {
            runs: [control],
            distributedRuns: terminalRuns
        };
        const selectionIndex = createControlSelectionIndexCache().get(snapshot);

        const selection = deriveRecipeConsoleControlSelection({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot,
            selectionIndex,
            bootstrapGroup,
            queryStatus: 'live',
            nowEpochMs: 10_000
        });

        expect(selection.activeRunContext).toEqual({ kind: 'none', runs: [] });
        expect(recipeConsoleControlSelectionWorkForTest(selection)).toMatchObject({
            indexed: true,
            fallback: false,
            activeRunProjectionCount: 0
        });
        expect(controlAgentBoardWorkForTest(selection.boardRows)).toMatchObject({
            indexed: true,
            fallback: false,
            distributedRunProjectionCount: 0
        });
    });

    it('keeps the indexed control board when partial truth omits distributed runs', () => {
        const first: ControlServerSnapshot = {
            runs: [controlRun('run-a', [controlAgent('run-a', 'agent-a')])]
        };
        const current = structuredClone(first);

        const selected = deriveRecipeConsoleControlSelection({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: current,
            selectionIndex: bindControlSelectionIndexToSnapshot(
                current,
                createControlSnapshotSelectionIndex(first)
            ),
            bootstrapGroup,
            queryStatus: 'partial',
            nowEpochMs: 10_000
        });

        expect(controlAgentBoardWorkForTest(selected.boardRows)).toMatchObject({
            indexed: true,
            fallback: false
        });
        expect(selected.issues).toContainEqual(expect.objectContaining({
            field: 'distributedRuns',
            code: 'unavailable'
        }));
    });

    it.each([
        {
            label: 'empty topology',
            stale: { runs: [], distributedRuns: [] } satisfies ControlServerSnapshot
        },
        {
            label: 'same-length replacement topology',
            stale: {
                runs: [controlRun('old-run')],
                distributedRuns: [distributedRun('old-distributed', 'old-run')]
            } satisfies ControlServerSnapshot
        }
    ])('falls back from $label to current present truth', ({ stale }) => {
        const current: ControlServerSnapshot = {
            runs: [controlRun('run-a', [controlAgent('run-a', 'agent-a')])],
            distributedRuns: [distributedRun('distributed-a', 'run-a')]
        };
        const urlState = {
            ...baseUrlState,
            controlRunId: 'run-a',
            distributedRunId: 'distributed-a',
            agentId: 'agent-a'
        };
        const legacy = derive({ urlState, snapshot: current });

        const indexed = deriveRecipeConsoleControlSelection({
            urlState,
            snapshot: current,
            selectionIndex: createControlSnapshotSelectionIndex(stale),
            bootstrapGroup,
            queryStatus: 'live',
            nowEpochMs: 10_000
        });

        expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
        expect(indexed.controlRun).toBe(current.runs[0]);
        expect(indexed.distributedRun).toBe(current.distributedRuns![0]);
        expect(indexed.agent).toBe(current.runs[0]!.agents[0]);
        expect(recipeConsoleControlSelectionWorkForTest(indexed)).toEqual({
            indexed: false,
            fallback: true
        });
    });

    it('keeps a genuinely absent ID unavailable with a valid index', () => {
        const snapshot: ControlServerSnapshot = {
            runs: [controlRun('run-a')],
            distributedRuns: []
        };
        const urlState = { ...baseUrlState, controlRunId: 'missing-run' };
        const legacy = derive({ urlState, snapshot });

        const indexed = deriveRecipeConsoleControlSelection({
            urlState,
            snapshot,
            selectionIndex: bindControlSelectionIndexToSnapshot(
                snapshot,
                createControlSnapshotSelectionIndex(snapshot)
            ),
            bootstrapGroup,
            queryStatus: 'live',
            nowEpochMs: 10_000
        });

        expect(JSON.stringify(indexed)).toBe(JSON.stringify(legacy));
        expect(indexed.controlRun).toBeUndefined();
        expect(recipeConsoleControlSelectionWorkForTest(indexed)).toMatchObject({
            indexed: true,
            fallback: false
        });
    });

    it('gives an explicit URL control run precedence over bootstrap and collection order', () => {
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-url' },
            bootstrapRunId: 'run-bootstrap',
            snapshot: {
                runs: [controlRun('run-first'), controlRun('run-bootstrap'), controlRun('run-url')]
            }
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
                agentId: 'missing-agent'
            },
            bootstrapRunId: 'run-bootstrap',
            snapshot: { runs: [controlRun('run-bootstrap')] }
        });

        expect(selected).toMatchObject({
            controlRunId: 'missing-run',
            controlRun: undefined,
            distributedRunId: 'missing-distributed',
            distributedRun: undefined,
            agentId: 'missing-agent',
            agent: undefined
        });
        expect(selected.issues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'unavailable', value: 'missing-run' }),
            expect.objectContaining({ field: 'distributedRuns', code: 'unavailable' })
        ]);
    });

    it('qualifies every unavailable selection notice derived from stale evidence', () => {
        const missingParent = derive({
            urlState: { ...baseUrlState, controlRunId: 'missing-run' },
            queryStatus: 'stale',
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: []
            }
        });
        const missingChildren = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'missing-distributed',
                agentId: 'missing-agent'
            },
            queryStatus: 'stale',
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: []
            }
        });
        const incompatible = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'distributed-other'
            },
            queryStatus: 'stale',
            snapshot: {
                runs: [controlRun('run-a'), controlRun('run-b')],
                distributedRuns: [distributedRun('distributed-other', 'run-b')]
            }
        });
        const missingCollection = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            queryStatus: 'stale',
            snapshot: { runs: [controlRun('run-a')] }
        });
        const messages = [
            ...missingParent.issues,
            ...missingChildren.issues,
            ...incompatible.issues,
            ...missingCollection.issues
        ].map((issue) => issue.message);

        expect(messages).toHaveLength(5);
        expect(messages.every((message) => message.includes('last-known'))).toBe(true);
        expect(messages.every((message) => !message.includes('latest snapshot'))).toBe(true);
    });

    it('waits for authoritative collections and parent selection before diagnosing deep-link IDs', () => {
        const connecting = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'distributed-a',
                agentId: 'agent-a'
            },
            queryStatus: 'connecting'
        });
        const partial = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'distributed-a'
            },
            queryStatus: 'partial',
            snapshot: { runs: [controlRun('run-a')] }
        });
        const ambiguousParent = derive({
            urlState: {
                ...baseUrlState,
                distributedRunId: 'distributed-a',
                agentId: 'agent-a'
            },
            snapshot: { runs: [controlRun('run-a'), controlRun('run-b')], distributedRuns: [] }
        });

        expect(connecting.issues).toEqual([]);
        expect(partial.issues).toEqual([
            expect.objectContaining({ field: 'distributedRuns', code: 'unavailable' })
        ]);
        expect(ambiguousParent.issues).toEqual([
            expect.objectContaining({ field: 'controlRunId', code: 'ambiguous' })
        ]);
    });

    it('diagnoses missing child IDs once the selected parent collections are authoritative', () => {
        const selected = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-a',
                distributedRunId: 'missing-distributed',
                agentId: 'missing-agent'
            },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: []
            }
        });

        expect(selected).toMatchObject({
            distributedRunId: 'missing-distributed',
            distributedRun: undefined,
            agentId: 'missing-agent',
            agent: undefined
        });
        expect(selected.issues).toEqual([
            expect.objectContaining({
                field: 'distributedRunId',
                code: 'unavailable',
                value: 'missing-distributed'
            }),
            expect.objectContaining({
                field: 'agentId',
                code: 'unavailable',
                value: 'missing-agent'
            })
        ]);
    });

    it('prefers the bootstrap run only when that run is present', () => {
        const present = derive({
            bootstrapRunId: 'run-bootstrap',
            snapshot: { runs: [controlRun('run-other'), controlRun('run-bootstrap')] }
        });
        const absent = derive({
            bootstrapRunId: 'missing-bootstrap',
            snapshot: { runs: [controlRun('run-a'), controlRun('run-b')] }
        });

        expect(present).toMatchObject({
            controlRunId: 'run-bootstrap',
            controlRunSource: 'bootstrap',
            urlReplacePatch: { controlRunId: 'run-bootstrap' }
        });
        expect(absent.controlRun).toBeUndefined();
        expect(absent.controlRunId).toBeUndefined();
    });

    it('selects a sole server run and suggests a history replacement', () => {
        const selected = derive({ snapshot: { runs: [controlRun('run-only')] } });

        expect(selected).toMatchObject({
            controlRunId: 'run-only',
            controlRunSource: 'sole-run',
            urlReplacePatch: { controlRunId: 'run-only' }
        });
    });

    it('falls back to the sole server run when the bootstrap run is absent', () => {
        const selected = derive({
            bootstrapRunId: 'missing-bootstrap',
            snapshot: { runs: [controlRun('run-only')] }
        });

        expect(selected).toMatchObject({
            controlRunId: 'run-only',
            controlRunSource: 'sole-run',
            urlReplacePatch: { controlRunId: 'run-only' }
        });
    });

    it('reports multiple unselected runs as ambiguous instead of using runs[0]', () => {
        const selected = derive({
            snapshot: { runs: [controlRun('run-first'), controlRun('run-second')] }
        });

        expect(selected.controlRunId).toBeUndefined();
        expect(selected.controlRun).toBeUndefined();
        expect(selected.urlReplacePatch).toBeUndefined();
        expect(selected.issues).toContainEqual(expect.objectContaining({
            field: 'controlRunId',
            code: 'ambiguous'
        }));
    });

    it('resolves a distributed run only when it belongs to the selected control run', () => {
        const wrongRun = distributedRun('distributed-other', 'run-other');
        const selected = derive({
            urlState: {
                ...baseUrlState,
                controlRunId: 'run-selected',
                distributedRunId: wrongRun.distributedRunId
            },
            snapshot: {
                runs: [controlRun('run-selected'), controlRun('run-other')],
                distributedRuns: [wrongRun]
            }
        });

        expect(selected.distributedRunId).toBe('distributed-other');
        expect(selected.distributedRun).toBeUndefined();
        expect(selected.issues).toContainEqual(expect.objectContaining({
            field: 'distributedRunId',
            code: 'incompatible',
            value: 'distributed-other'
        }));
    });

    it.each([
        { states: [] as const, kind: 'none', count: 0 },
        { states: ['running'] as const, kind: 'sole', count: 1 },
        { states: ['draft', 'running'] as const, kind: 'ambiguous', count: 2 }
    ])('derives $kind active-run context without treating terminal runs as active', ({ states, kind, count }) => {
        const active = states.map((state, index) => distributedRun(`active-${index}`, 'run-a', state));
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [
                    ...active,
                    distributedRun('terminal-passed', 'run-a', 'passed'),
                    distributedRun('other-control-run', 'run-b', 'running')
                ]
            }
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
                    distributedRun('a-run', 'run-a', 'draft')
                ]
            }
        });

        expect(selected.activeRunContext.runs.map((run) => run.distributedRunId))
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
                    distributedRun('active', 'run-a', 'running', activeGroup)
                ]
            }
        });
        const soleActive = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: {
                runs: [controlRun('run-a')],
                distributedRuns: [distributedRun('active', 'run-a', 'running', activeGroup)]
            }
        });
        const fallback = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            snapshot: { runs: [controlRun('run-a')], distributedRuns: [] }
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
                    controlRun('run-b', [controlAgent('run-b', 'agent-b')])
                ]
            }
        });

        expect(selected.agentId).toBe('agent-a');
        expect(selected.agent?.agentId).toBe('agent-a');
    });

    it('retains last-known board evidence while stale data is never currently safe', () => {
        const selected = derive({
            urlState: { ...baseUrlState, controlRunId: 'run-a' },
            queryStatus: 'stale',
            snapshot: {
                runs: [controlRun('run-a', [controlAgent('run-a', 'agent-a')])]
            }
        });

        expect(selected.boardRows).toHaveLength(1);
        expect(selected.lastKnownTargetableCount).toBe(1);
        expect(selected.safeTargetableCount).toBe(0);
    });

    it('clears dependent agent and incompatible distributed IDs in a run-selection URL patch', () => {
        const distributedRuns = [
            distributedRun('distributed-a', 'run-a'),
            distributedRun('distributed-b', 'run-b')
        ];
        const state = {
            ...baseUrlState,
            controlRunId: 'run-a',
            distributedRunId: 'distributed-a',
            agentId: 'agent-a'
        };

        expect(recipeConsoleControlRunSelectionPatch({
            state,
            controlRunId: 'run-b',
            distributedRuns
        })).toEqual({
            controlRunId: 'run-b',
            distributedRunId: undefined,
            agentId: undefined
        });
        expect(recipeConsoleControlRunSelectionPatch({
            state: { ...state, distributedRunId: 'distributed-b' },
            controlRunId: 'run-b',
            distributedRuns
        })).toEqual({
            controlRunId: 'run-b',
            distributedRunId: 'distributed-b',
            agentId: undefined
        });
    });
});
