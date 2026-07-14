import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import {
    analyzeArtifactIdentityIssues,
    analyzeFilterClearPatch,
    analyzeImportedIdentityPatch,
    type AnalyzeOptionDerivationWork,
    deriveAnalyzeControlRunOptions,
    deriveAnalyzeDistributedRunOptions,
    findAnalyzeDistributedRunOption,
    recipeConsoleAnalyzeControlRunSelectionPatch,
    recipeConsoleAnalyzeDistributedRunSelectionPatch,
} from '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-selection.ts';
import type { RecipeConsoleUrlState } from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

function controlRun(runId: string, updatedAtEpochMs: number): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 1,
        updatedAtEpochMs,
        agents: [],
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
    updatedAtEpochMs: number,
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        state: 'failed',
        createdAtEpochMs: 1,
        updatedAtEpochMs,
        targetAgentIds: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group: { groupId: 'ci-analyze' },
            recipes: [],
            targetPolicy: {},
        },
        commandLinks: [],
        rollup: {
            state: 'failed',
            ok: false,
            summary: { blockingFailures: 1 },
            failures: [],
        },
    };
}

function urlState(
    overrides: Partial<RecipeConsoleUrlState> = {},
): RecipeConsoleUrlState {
    return {
        v: 1,
        experience: 'recipe-console',
        view: 'analyze',
        ...overrides,
    };
}

describe('Recipe Console Analyze selection', () => {
    it('derives stable recency-sorted control and compatible distributed run options', () => {
        const controls = [
            controlRun('control-z', 20),
            controlRun('control-b', 30),
            controlRun('control-a', 30),
        ];
        const distributed = [
            distributedRun('distributed-z', 'control-b', 20),
            distributedRun('foreign-newest', 'control-a', 100),
            distributedRun('distributed-b', 'control-b', 30),
            distributedRun('distributed-a', 'control-b', 30),
        ];

        const controlOptions = deriveAnalyzeControlRunOptions(controls);
        const distributedOptions = deriveAnalyzeDistributedRunOptions({
            controlRunId: 'control-b',
            distributedRuns: distributed,
        });

        expect(controlOptions.map(run => run.runId))
            .toEqual(['control-a', 'control-b', 'control-z']);
        expect(distributedOptions.map(run => run.distributedRunId)).toEqual([
            'distributed-a',
            'distributed-b',
            'distributed-z',
        ]);
        expect(controlOptions).toEqual([
            controls[2],
            controls[1],
            controls[0],
        ]);
        expect(controlOptions[0]).toBe(controls[2]);
        expect(distributedOptions[0]).toBe(distributed[3]);
        expect(controls.map(run => run.runId))
            .toEqual(['control-z', 'control-b', 'control-a']);
    });

    it('returns one stable empty singleton with zero option work while Analyze is inactive at 5,000 run pairs', () => {
        const controls = Array.from({ length: 5_000 }, (_, index) =>
            controlRun(`control-${index}`, index));
        const distributed = Array.from({ length: 5_000 }, (_, index) =>
            distributedRun(`distributed-${index}`, `control-${index}`, index));
        const inactiveWork = optionWork();

        const controlOptions = deriveAnalyzeControlRunOptions(
            controls,
            false,
            inactiveWork,
        );
        const distributedOptions = deriveAnalyzeDistributedRunOptions({
            controlRunId: 'control-4999',
            distributedRuns: distributed,
        }, false, inactiveWork);

        expect(controlOptions).toBe(distributedOptions);
        expect(deriveAnalyzeControlRunOptions(controls, false))
            .toBe(controlOptions);
        expect(deriveAnalyzeDistributedRunOptions({
            controlRunId: 'control-0',
            distributedRuns: distributed,
        }, false)).toBe(controlOptions);
        expect(inactiveWork).toEqual(optionWork());

        const activeWork = optionWork();
        expect(deriveAnalyzeControlRunOptions(controls, true, activeWork))
            .toHaveLength(5_000);
        expect(deriveAnalyzeDistributedRunOptions({
            controlRunId: 'control-4999',
            distributedRuns: distributed,
        }, true, activeWork)).toEqual([distributed[4_999]]);
        expect(activeWork.controlRunVisitCount).toBe(5_000);
        expect(activeWork.distributedRunVisitCount).toBe(5_000);
        expect(activeWork.compatibleRunProjectionCount).toBe(1);
        expect(activeWork.sortComparisonCount).toBeGreaterThan(0);
    });

    it('projects exact control and distributed run patches with incompatible evidence cleared', () => {
        const state = urlState({
            controlRunId: 'control-a',
            distributedRunId: 'distributed-a',
            agentId: 'agent-a',
            recipeId: 'recipe-a',
            commandId: 'command-a',
        });
        const runs = [
            distributedRun('distributed-a', 'control-a', 10),
            distributedRun('distributed-b', 'control-b', 20),
        ];

        expect(recipeConsoleAnalyzeControlRunSelectionPatch({
            state,
            controlRunId: 'control-b',
            distributedRuns: runs,
        })).toEqual({
            controlRunId: 'control-b',
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
        expect(recipeConsoleAnalyzeDistributedRunSelectionPatch(runs[1]))
            .toEqual({
                controlRunId: 'control-b',
                distributedRunId: 'distributed-b',
                agentId: undefined,
                recipeId: undefined,
                commandId: undefined,
            });
    });

    it('projects imported artifact identity and clears only identity-bound evidence filters', () => {
        expect(analyzeImportedIdentityPatch({
            distributedRunId: 'distributed-imported',
            controlRunId: 'control-imported',
        })).toEqual({
            controlRunId: 'control-imported',
            distributedRunId: 'distributed-imported',
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
        expect(analyzeImportedIdentityPatch({
            distributedRunId: 'distributed-offline',
        })).toEqual({
            controlRunId: undefined,
            distributedRunId: 'distributed-offline',
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
    });

    it('never projects artifact-controlled over-limit or control-character identities', () => {
        const overLimit = `distributed-${'x'.repeat(10_000)}`;
        const unsafeControl = 'control-safe\u202Ehidden';
        const identity = {
            distributedRunId: overLimit,
            controlRunId: unsafeControl,
        };

        expect(analyzeImportedIdentityPatch(identity)).toEqual({
            controlRunId: undefined,
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
        expect(analyzeArtifactIdentityIssues(identity)).toEqual([
            expect.stringMatching(/distributed run ID.*256/),
            expect.stringMatching(/control run ID.*unsafe characters/),
        ]);
    });

    it('never treats bounded display handles as exact URL authority', () => {
        const identity = {
            distributedRunId: 'opaque-id:1800:0123456789abcdef0123456789abcdef',
            distributedRunIdExact: false,
            controlRunId: 'control-a',
        };

        expect(analyzeImportedIdentityPatch(identity)).toMatchObject({
            distributedRunId: undefined,
            controlRunId: undefined,
        });
        expect(analyzeArtifactIdentityIssues(identity)).toEqual([
            expect.stringMatching(/distributed run ID.*bounded display handle/i),
        ]);
    });

    it('rejects malformed Unicode identities while preserving valid paired Unicode', () => {
        const loneHigh = JSON.parse('"distributed-\\ud800"') as string;
        const loneLow = JSON.parse('"control-\\udfff"') as string;

        expect(analyzeImportedIdentityPatch({
            distributedRunId: loneHigh,
            controlRunId: loneLow,
        })).toMatchObject({
            controlRunId: undefined,
            distributedRunId: undefined,
        });
        expect(analyzeArtifactIdentityIssues({
            distributedRunId: loneHigh,
            controlRunId: loneLow,
        })).toEqual([
            expect.stringMatching(/distributed run ID.*unsafe characters/),
            expect.stringMatching(/control run ID.*unsafe characters/),
        ]);

        const valid = 'distributed-🛰️';
        expect(analyzeImportedIdentityPatch({ distributedRunId: valid }))
            .toMatchObject({ distributedRunId: valid });
        expect(analyzeArtifactIdentityIssues({ distributedRunId: valid }))
            .toEqual([]);
        expect(new URLSearchParams({ distributedRunId: valid })
            .get('distributedRunId')).toBe(valid);
    });

    it('clears every URL-backed Analyze evidence filter without clearing run identity', () => {
        expect(analyzeFilterClearPatch()).toEqual({
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
            diagnosticSeverity: undefined,
            transport: undefined,
            historyQuery: undefined,
            status: undefined,
            from: undefined,
            to: undefined,
        });
    });

    it('finds a distributed option only by identity and never falls back to collection index', () => {
        const options = [
            distributedRun('first', 'control-a', 20),
            distributedRun('second', 'control-a', 10),
        ];

        expect(findAnalyzeDistributedRunOption(options, 'second'))
            .toBe(options[1]);
        expect(findAnalyzeDistributedRunOption(options, 'missing'))
            .toBeUndefined();
        expect(findAnalyzeDistributedRunOption([], 'first')).toBeUndefined();
    });
});

function optionWork(): AnalyzeOptionDerivationWork {
    return {
        controlRunVisitCount: 0,
        distributedRunVisitCount: 0,
        compatibleRunProjectionCount: 0,
        sortComparisonCount: 0,
    };
}
