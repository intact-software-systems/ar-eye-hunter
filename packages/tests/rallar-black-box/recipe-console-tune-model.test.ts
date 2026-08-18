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
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { deriveTuneSourceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-source-model.ts';

const urlState = (patch: Partial<RecipeConsoleUrlState> = {}): RecipeConsoleUrlState => ({
    v: 1, experience: 'recipe-console', view: 'tune', ...patch,
});

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    options: Readonly<{ referenceOnly?: boolean; updatedAt?: number }> = {},
): ControlDistributedRunSnapshot {
    const commandId = `command-${distributedRunId}`;
    return {
        distributedRunId, controlRunId, state: 'passed',
        createdAtEpochMs: 100, updatedAtEpochMs: options.updatedAt ?? 200,
        startedAtEpochMs: 100, completedAtEpochMs: 300,
        targetAgentIds: ['agent-a'],
        commandLinks: [{
            phase: 'start', agentId: 'agent-a', commandId,
            recipeId: 'recipe-a', queuedAtEpochMs: 100,
        }],
        manifest: {
            schemaVersion: 1, distributedRunId, controlRunId,
            group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'group-a' },
            targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
            ackTimeoutMs: 1_000,
            recipes: options.referenceOnly
                ? [{ recipeId: 'recipe-a' }]
                : [{
                    recipeId: 'recipe-a', recipe: {
                        schemaVersion: 1, recipeId: 'recipe-a',
                        commands: [{ kind: 'health', commandId }],
                    },
                }],
        },
        rollup: {
            state: 'passed', ok: true, failures: [],
            summary: {
                participants: 1, requiredParticipants: 1, readyParticipants: 1,
                passedParticipants: 1, failedParticipants: 0, recipes: 1,
                requiredRecipes: 1, passedRecipes: 1, failedRecipes: 0,
                groupAssertions: 0, passedGroupAssertions: 0, failedGroupAssertions: 0,
                blockingFailures: 0,
            },
        },
    };
}

function controlRun(runId: string, distributedRunId: string): ControlRunSnapshot {
    const commandId = `command-${distributedRunId}`;
    return {
        runId, createdAtEpochMs: 50, updatedAtEpochMs: 310,
        agents: [], results: [], events: [], stats: [], reports: [], heartbeats: [],
        commands: [{
            envelope: {
                kind: 'command', protocolVersion: 1, runId, agentId: 'agent-a',
                commandId, command: { kind: 'health', commandId },
            },
            queuedAtEpochMs: 120, completedAtEpochMs: 220, dispatchCount: 1,
        }],
    };
}

function query(
    status: ControlQuerySnapshot<ControlServerSnapshot>['status'],
    distributedRuns: readonly ControlDistributedRunSnapshot[],
    runs: readonly ControlRunSnapshot[],
): ControlQuerySnapshot<ControlServerSnapshot> {
    return {
        status, reachability: status === 'offline' ? 'unreachable' : 'reachable',
        authorization: 'ready', snapshot: { distributedRuns, runs },
        receivedAtEpochMs: 500, isRefreshing: false,
    };
}

function artifact(
    run: ControlDistributedRunSnapshot,
    control: ControlRunSnapshot,
    support: 'supported' | 'unsupported' = 'supported',
    performance = true,
): AnalyzeArtifactModel {
    return {
        distributedRunId: run.distributedRunId,
        controlRunId: run.controlRunId,
        identity: {
            distributedRunId: run.distributedRunId,
            controlRunId: run.controlRunId,
        },
        snapshots: { distributedRun: run, controlRun: control },
        workspace: {
            support, issues: support === 'supported' ? [] : [{
                code: 'unknown-schema-version', severity: 'error',
                message: 'Artifact schema version 99 is not supported.',
            }],
            artifactSchemaVersion: support === 'supported' ? 2 : 99,
            generatedAtEpochMs: 450,
        },
        analysis: {
            generatedAtEpochMs: 450, distributedRunId: run.distributedRunId,
            controlRunId: run.controlRunId, status: 'passed', ok: true,
            summary: { agents: 1, passRate: 1, failureGroups: 0, blockingFailures: 0 },
            parseWarnings: [], summaryMarkdown: 'passed',
            ...(performance ? { performance: {
                commandTiming: { count: 1, p95Ms: 950, outlierCount: 0 },
                agentCount: 1, passRate: 1, reconnectCount: 0,
                diagnosticCount: 0, warningDiagnosticCount: 0,
                errorDiagnosticCount: 0, exportedEventCount: 0,
                agentReportedEventCount: 0, failedAgentCount: 0,
                missingAgentCount: 0, staleAgentCount: 0, flakyAgentCount: 0,
                slowestAgents: [],
            } } : {}),
        },
        provenance: { generatedAtEpochMs: 450, label: 'retained artifact' },
    } as unknown as AnalyzeArtifactModel;
}

describe('Recipe Console Tune source model', () => {
    it('uses a matching supported retained artifact as detailed focus authority', () => {
        const left = distributedRun('left', 'control-left');
        const right = distributedRun('right', 'control-right');
        const rightControl = controlRun('control-right', 'right');
        const model = deriveTuneSourceModel({
            urlState: urlState({ distributedRunId: 'left', compareRight: 'right' }),
            query: query('live', [left, right], [rightControl]),
            retained: { status: 'ready', model: artifact(right, rightControl) },
        });

        expect(model.focusRunId).toBe('right');
        expect(model.provenance).toMatchObject({ source: 'artifact', detail: 'detailed' });
        expect(model.performance?.commandTiming.p95Ms).toBe(950);
        expect(model.candidate).toEqual({ allowed: true, reasons: [] });
        expect(model.identity).toMatchObject({
            compareValue: 'right', reactKey: 'tune-run:right',
            candidateFilename: 'right-tuning-candidate.json',
        });
        expect(model.legacyRunsHref).toContain('distributedRunId=right');
    });

    it('keeps a mismatched or context-error artifact inspectable but uses bounded control truth', () => {
        const left = distributedRun('left', 'control-left');
        const right = distributedRun('right', 'control-right');
        const leftControl = controlRun('control-left', 'left');
        const rightControl = controlRun('control-right', 'right');

        for (const retained of [
            { status: 'ready' as const, model: artifact(left, leftControl) },
            { status: 'error' as const, model: artifact(right, rightControl), error: 'retained context changed' },
        ]) {
            const model = deriveTuneSourceModel({
                urlState: urlState({ compareRight: 'right' }),
                query: query('live', [right], [rightControl]), retained,
            });
            expect(model.provenance).toMatchObject({ source: 'control', detail: 'bounded' });
            expect(model.performance?.commandTiming.p95Ms).toBe(100);
            expect(model.retained.inspection?.performance?.commandTiming.p95Ms).toBe(950);
            expect(model.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([
                retained.status === 'error' ? 'retained-context-error' : 'retained-mismatch',
            ]));
        }
    });

    it('keeps future artifact metrics inspectable while blocking candidate output', () => {
        const run = distributedRun('future', 'control-future');
        const control = controlRun('control-future', 'future');
        const model = deriveTuneSourceModel({
            urlState: urlState({ distributedRunId: 'future' }),
            query: query('live', [run], [control]),
            retained: { status: 'ready', model: artifact(run, control, 'unsupported') },
        });

        expect(model.provenance).toMatchObject({ source: 'artifact', detail: 'inspectable' });
        expect(model.performance?.commandTiming.p95Ms).toBe(950);
        expect(model.candidate.allowed).toBe(false);
        expect(model.candidate.reasons.join(' ')).toMatch(/not supported/i);
        expect(model.issues.map(issue => issue.code)).toContain('unsupported-artifact');
    });

    it('requires the retained artifact control identity to match the resolved focus pair', () => {
        const selected = distributedRun('right', 'control-right');
        const selectedControl = controlRun('control-right', 'right');
        const wrongRun = distributedRun('right', 'control-other');
        const wrongControl = controlRun('control-other', 'right');
        const retained = artifact(wrongRun, wrongControl) as unknown as Record<string, unknown>;
        retained.controlRunId = undefined;
        retained.identity = { distributedRunId: 'right' };
        const model = deriveTuneSourceModel({
            urlState: urlState({ compareRight: 'right' }),
            query: query('live', [selected], [selectedControl]),
            retained: {
                status: 'ready',
                model: retained as unknown as AnalyzeArtifactModel,
            },
        });

        expect(model.retained.relation).toBe('mismatched');
        expect(model.provenance).toMatchObject({ source: 'control', detail: 'bounded' });
        expect(model.controlRun?.runId).toBe('control-right');
    });

    it.each(['live', 'partial', 'stale'] as const)(
        'labels %s control evidence as bounded without inventing artifact detail',
        status => {
            const run = distributedRun('control-only', 'control-a');
            const control = controlRun('control-a', 'control-only');
            const model = deriveTuneSourceModel({
                urlState: urlState({ distributedRunId: 'control-only' }),
                query: query(status, [run], [control]),
            });

            expect(model.provenance).toMatchObject({
                source: 'control', detail: 'bounded', controlStatus: status,
            });
            expect(model.performance?.commandTiming.p95Ms).toBe(100);
            expect(model.analysis).toBeUndefined();
            expect(model.candidate.allowed).toBe(status !== 'stale');
        },
    );

    it('surfaces reference-only and missing-performance limitations without inventing evidence', () => {
        const reference = distributedRun('reference', 'control-reference', { referenceOnly: true });
        const referenceControl = controlRun('control-reference', 'reference');
        const referenceModel = deriveTuneSourceModel({
            urlState: urlState({ distributedRunId: 'reference' }),
            query: query('partial', [reference], [referenceControl]),
        });
        expect(referenceModel.inventory?.limitations).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'reference-only-recipe' }),
        ]));
        expect(referenceModel.issues.map(issue => issue.code)).toContain('reference-only');

        const missing = deriveTuneSourceModel({
            urlState: urlState({ distributedRunId: 'reference' }),
            query: query('live', [reference], []),
        });
        expect(missing.performance).toBeUndefined();
        expect(missing.candidate.allowed).toBe(false);
        expect(missing.issues.map(issue => issue.code)).toContain('missing-performance');
    });

    it('returns an explicit no-evidence model for an unavailable focus', () => {
        const model = deriveTuneSourceModel({
            urlState: urlState({ compareRight: 'missing' }),
            query: query('offline', [], []),
        });
        expect(model.focusRunId).toBe('missing');
        expect(model.provenance).toMatchObject({ source: 'none', detail: 'unavailable' });
        expect(model.performance).toBeUndefined();
        expect(model.candidate.allowed).toBe(false);
        expect(model.issues.map(issue => issue.code)).toContain('focus-unavailable');
        expect(model.legacyRunsHref).toBeUndefined();
        expect(model.identity).not.toHaveProperty('candidateFilename');
        expect(model.identity).not.toHaveProperty('reactKey');
    });
});
