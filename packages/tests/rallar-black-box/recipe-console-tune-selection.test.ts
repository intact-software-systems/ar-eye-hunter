import { describe, expect, it } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { AnalyzeArtifactModel } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-artifact-model.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import { createRecipeConsoleUrlHistory } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-history.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { projectTuneIdentitySurfaces } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-identity.ts';
import { deriveTuneSelectionModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-selection-model.ts';
import {
    tuneLeftSelectionPatch,
    tuneRightSelectionPatch,
    tuneTimingMetricPatch,
} from '../../../apps/rallar-black-box/src/recipe-console/tune/tune-url-patches.ts';

const state = (patch: Partial<RecipeConsoleUrlState> = {}): RecipeConsoleUrlState => ({
    v: 1, experience: 'recipe-console', view: 'tune', ...patch,
});

function run(input: Readonly<{
    id: string; control: string; updated: number; group?: string;
    recipes: readonly Readonly<{ id: string; profile?: string }>[];
    agents: readonly string[]; failure: string; start: number; end: number;
}>): ControlDistributedRunSnapshot {
    return {
        distributedRunId: input.id, controlRunId: input.control, state: 'failed',
        createdAtEpochMs: input.start - 100, updatedAtEpochMs: input.updated,
        startedAtEpochMs: input.start, completedAtEpochMs: input.end,
        targetAgentIds: input.agents, commandLinks: [],
        manifest: {
            schemaVersion: 1, distributedRunId: input.id, controlRunId: input.control,
            group: {
                applicationId: 'rallar-server', workspaceId: 'default',
                groupId: input.group ?? 'group-a',
            },
            targetPolicy: { mode: 'selected-agents', agentIds: input.agents },
            recipes: input.recipes.map(recipe => ({
                recipeId: recipe.id, profile: recipe.profile,
                recipe: { schemaVersion: 1, recipeId: recipe.id, commands: [{ kind: 'health' }] },
            })),
        },
        rollup: {
            state: 'failed', ok: false,
            failures: [{
                kind: 'recipe', key: input.failure, state: 'failed', required: true,
                error: { code: input.failure, message: `${input.failure} failed` },
            }],
            summary: {
                participants: input.agents.length, requiredParticipants: input.agents.length,
                readyParticipants: input.agents.length, passedParticipants: 0,
                failedParticipants: 0, recipes: input.recipes.length,
                requiredRecipes: input.recipes.length, passedRecipes: 0,
                failedRecipes: 1, blockingFailures: 1,
            },
        },
    };
}

function control(runId: string, distributedRunId: string, messageCount: number): ControlRunSnapshot {
    return {
        runId, createdAtEpochMs: 0, updatedAtEpochMs: 5_000,
        agents: [], commands: [], results: [], stats: [], reports: [], heartbeats: [],
        events: Array.from({ length: messageCount }, (_, index) => ({
            kind: 'event' as const, protocolVersion: 1 as const, runId,
            agentId: `agent-${index}`, eventId: `message-${index}`,
            atEpochMs: 2_000 + index,
            payload: { distributedRunId, topic: 'message.received', message: `payload ${index}` },
        })),
    };
}

function query(
    distributedRuns: readonly ControlDistributedRunSnapshot[],
    runs: readonly ControlRunSnapshot[],
): ControlQuerySnapshot<ControlServerSnapshot> {
    return {
        status: 'live', reachability: 'reachable', authorization: 'ready',
        snapshot: { distributedRuns, runs }, receivedAtEpochMs: 5_000, isRefreshing: false,
    };
}

function artifact(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
): AnalyzeArtifactModel {
    return {
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        identity: {
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
        },
        snapshots: { distributedRun, controlRun },
        workspace: { support: 'supported', issues: [] },
        analysis: {
            performance: { commandTiming: { count: 1, p95Ms: 900, outlierCount: 0 } },
        },
    } as unknown as AnalyzeArtifactModel;
}

const left = run({
    id: 'left', control: 'control-left', updated: 4_000,
    recipes: [{ id: 'left-only' }, { id: 'shared', profile: 'baseline' }],
    agents: ['agent-left', 'agent-shared'], failure: 'LEFT_FAILURE', start: 1_000, end: 3_000,
});
const right = run({
    id: 'right', control: 'control-right', updated: 6_000,
    recipes: [{ id: 'shared', profile: 'candidate' }, { id: 'right-only' }],
    agents: ['agent-shared', 'agent-right'], failure: 'RIGHT_FAILURE', start: 2_000, end: 3_200,
});
const leftControl = control('control-left', 'left', 1);
const rightControl = control('control-right', 'right', 2);

describe('Recipe Console Tune selection and comparison', () => {
    it('deduplicates artifact/control options deterministically and preserves explicit focus', () => {
        const model = deriveTuneSelectionModel({
            urlState: state({ distributedRunId: 'left', compareRight: 'right' }),
            query: query([left, right], [leftControl, rightControl]),
            retainedArtifact: artifact(left, leftControl),
            retainedArtifactStatus: 'ready',
        });

        expect(model.options.map(option => [option.distributedRunId, option.source])).toEqual([
            ['right', 'control'], ['left', 'control'],
        ]);
        expect(model.options[1]?.artifactEvidence).toBeDefined();
        expect(model.focusRunId).toBe('right');
        expect(model.focus?.controlRunId).toBe('control-right');
        expect(new Set(model.options.map(option => option.key)).size).toBe(2);
    });

    it('keeps comparison explicit and reports invalid and same-run selections without rewriting', () => {
        const missing = deriveTuneSelectionModel({
            urlState: state({ distributedRunId: 'left' }), query: query([left, right], []),
        });
        expect(missing.comparison.state).toBe('incomplete');
        expect(missing.comparison.issues.map(issue => issue.field)).toEqual(['compareLeft', 'compareRight']);

        const invalid = deriveTuneSelectionModel({
            urlState: state({ compareLeft: 'missing-left', compareRight: 'missing-right' }),
            query: query([left, right], []),
        });
        expect(invalid.focusRunId).toBe('missing-right');
        expect(invalid.comparison.state).toBe('invalid');
        expect(invalid.comparison.issues.map(issue => issue.value)).toEqual([
            'missing-left', 'missing-right',
        ]);

        const same = deriveTuneSelectionModel({
            urlState: state({ compareLeft: 'left', compareRight: 'left' }),
            query: query([left], [leftControl]),
        });
        expect(same.comparison.state).toBe('same-run');
        expect(same.comparison.structural).toBeUndefined();
    });

    it('composes every structural category and performance beside cross-control pairing', () => {
        const model = deriveTuneSelectionModel({
            urlState: state({
                compareLeft: 'left', compareRight: 'right', timingMetric: 'command-duration',
            }),
            query: query([right, left], [rightControl, leftControl]),
        });
        const comparison = model.comparison;

        expect(comparison.state).toBe('ready');
        expect(comparison.structural?.recipeDelta).toMatchObject({
            leftOnly: ['left-only'], rightOnly: ['right-only'],
            changedProfiles: ['shared: baseline -> candidate'],
        });
        expect(comparison.structural?.participantDelta).toEqual({
            leftOnly: ['agent-left'], rightOnly: ['agent-right'], shared: ['agent-shared'],
        });
        expect(comparison.structural?.failureDelta).toMatchObject({ leftCount: 1, rightCount: 1 });
        expect(comparison.structural?.timingDelta.durationDeltaMs).toBe(-800);
        expect(comparison.structural?.receivedMessageDelta).toMatchObject({
            leftCount: 1, rightCount: 2, delta: 1,
        });
        expect(comparison.performance?.timingMetric).toBe('command-duration');
    });

    it('keeps group and shared-recipe incompatibility advisory', () => {
        const incompatible = run({
            id: 'other', control: 'control-right', updated: 7_000, group: 'other-group',
            recipes: [{ id: 'other-recipe' }], agents: ['agent-other'],
            failure: 'OTHER_FAILURE', start: 2_000, end: 3_000,
        });
        const model = deriveTuneSelectionModel({
            urlState: state({ compareLeft: 'left', compareRight: 'other' }),
            query: query([left, incompatible], [leftControl, rightControl]),
        });

        expect(model.comparison.state).toBe('ready');
        expect(model.comparison.structural).toBeDefined();
        expect(model.comparison.compatibilityWarnings.map(row => row.code)).toEqual([
            'group-mismatch', 'no-shared-recipe',
        ]);
    });

    it('emits atomic right, left-only, and metric push patches through the v1 history contract', () => {
        const model = deriveTuneSelectionModel({
            urlState: state(), query: query([left, right], [leftControl, rightControl]),
        });
        const rightOption = model.options.find(option => option.distributedRunId === 'right')!;
        const leftOption = model.options.find(option => option.distributedRunId === 'left')!;
        expect(tuneRightSelectionPatch(rightOption)).toEqual({
            compareRight: 'right', distributedRunId: 'right', controlRunId: 'control-right',
            agentId: undefined, recipeId: undefined, commandId: undefined,
        });
        expect(tuneLeftSelectionPatch(leftOption)).toEqual({ compareLeft: 'left' });
        expect(tuneTimingMetricPatch('stream-drift')).toEqual({ timingMetric: 'stream-drift' });

        let search = '?v=1&experience=recipe-console&view=tune&status=failed&timingMetric=stream-drift';
        const pushes: string[] = [];
        const history = createRecipeConsoleUrlHistory({
            readSearch: () => search,
            push: next => { search = next; pushes.push(next); },
            replace: next => { search = next; }, subscribe: () => () => undefined,
        });
        const next = history.push(tuneRightSelectionPatch(rightOption));
        expect(pushes).toHaveLength(1);
        expect(next.state).toMatchObject({
            compareRight: 'right', distributedRunId: 'right', controlRunId: 'control-right',
            status: 'failed', timingMetric: 'stream-drift',
        });
    });

    it('quarantines unsafe identities from every navigable or reusable surface', () => {
        const malformed = JSON.parse('"dist-\\ud800"') as string;
        for (const identity of [
            { distributedRunId: 'x'.repeat(257), controlRunId: 'control' },
            { distributedRunId: 'dist\u0000hidden', controlRunId: 'control' },
            { distributedRunId: malformed, controlRunId: 'control' },
            { distributedRunId: 'safe', controlRunId: 'control\u202Ehidden' },
        ]) {
            const surfaces = projectTuneIdentitySurfaces(identity);
            expect(surfaces.quarantined).toBe(true);
            expect(surfaces).not.toHaveProperty('compareValue');
            expect(surfaces).not.toHaveProperty('legacyRunsHref');
            expect(surfaces).not.toHaveProperty('candidateFilename');
            expect(surfaces).not.toHaveProperty('reactKey');
        }

        const unsafeRun = { ...left, distributedRunId: malformed };
        const model = deriveTuneSelectionModel({
            urlState: state({ compareLeft: malformed, compareRight: 'right' }),
            query: query([unsafeRun, right], [leftControl, rightControl]),
            retainedArtifact: artifact(unsafeRun, leftControl),
        });
        expect(model.options.map(option => option.distributedRunId)).toEqual(['right']);
        expect(model.quarantined).toHaveLength(1);
        expect(model.quarantined[0]?.key).not.toContain(malformed);
        expect(model.comparison.state).toBe('invalid');

        const callerConstructedUnsafe = {
            ...model.options[0]!,
            distributedRunId: malformed,
        };
        expect(tuneRightSelectionPatch(callerConstructedUnsafe)).toEqual({});
        expect(tuneLeftSelectionPatch(callerConstructedUnsafe)).toEqual({});
    });
});
