import { describe, expect, it, vi } from 'vitest';
import type {
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { AnalyzeTuneArtifactFacade } from
    '../../../apps/rallar-black-box/src/recipe-console/analyze/analyze-worker-contract.ts';
import * as manifestValidation from
    '../../../packages/shared-test/rallar-bb-test/distributed-run-validation.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';
import { deriveTuneSelectionModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-selection-model.ts';
import { deriveTuneSourceModelFromFacade } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-facade-source-model.ts';
import { projectTuneFacadeManifestValidation } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-facade-manifest-validation.ts';
import { buildTuneRunCatalog } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-run-catalog.ts';
import { deriveTuneWorkspaceSourceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-workspace-source-model.ts';
import { tuneRightSelectionPatch } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-url-patches.ts';
import { tuneSourceIssueKey } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-source-issue.ts';

const urlState = (
    patch: Partial<RecipeConsoleUrlState> = {},
): RecipeConsoleUrlState => ({
    v: 1,
    experience: 'recipe-console',
    view: 'tune',
    ...patch,
});

function distributedRun(
    distributedRunId: string,
    controlRunId: string,
    updatedAtEpochMs = 2_000,
): ControlDistributedRunSnapshot {
    return {
        distributedRunId,
        controlRunId,
        state: 'passed',
        createdAtEpochMs: 1_000,
        startedAtEpochMs: 1_100,
        completedAtEpochMs: 1_500,
        updatedAtEpochMs,
        targetAgentIds: ['agent-a'],
        commandLinks: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId,
            controlRunId,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: 'group-a',
            },
            targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
            recipes: [{ recipeId: 'recipe-a' }],
        },
        rollup: {
            state: 'passed',
            ok: true,
            failures: [],
            summary: { blockingFailures: 0 },
        },
    };
}

function controlRun(runId: string): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 900,
        updatedAtEpochMs: 2_000,
        agents: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
        commands: [{
            envelope: {
                kind: 'command',
                protocolVersion: 1,
                runId,
                agentId: 'agent-a',
                commandId: `command-${runId}`,
                command: { kind: 'health' },
            },
            queuedAtEpochMs: 1_100,
            completedAtEpochMs: 1_200,
            dispatchCount: 1,
        }],
    };
}

function query(
    distributedRuns: readonly ControlDistributedRunSnapshot[],
    runs: readonly ControlRunSnapshot[],
): ControlQuerySnapshot<ControlServerSnapshot> {
    return {
        status: 'live',
        reachability: 'reachable',
        authorization: 'ready',
        snapshot: { distributedRuns, runs },
        receivedAtEpochMs: 3_000,
        isRefreshing: false,
    };
}

function facade(input: Readonly<{
    distributedRunId: string;
    controlRunId: string;
    role: AnalyzeTuneArtifactFacade['selection']['artifactRole'];
    focusRunId?: string;
    compareLeft?: string;
    compareRight?: string;
    candidateManifest?: boolean;
}>): AnalyzeTuneArtifactFacade {
    const run = distributedRun(input.distributedRunId, input.controlRunId, 2_500);
    return {
        identity: {
            distributedRunId: input.distributedRunId,
            controlRunId: input.controlRunId,
        },
        support: 'supported',
        generatedAtEpochMs: 2_600,
        manifestSummary: {
            distributedRunId: input.distributedRunId,
            controlRunId: input.controlRunId,
            group: run.manifest.group,
            recipeIds: { entries: ['recipe-a'], total: 1, omitted: 0 },
            targetPolicy: {
                mode: 'selected-agents',
                configuredAgentCount: 1,
                configuredRoleCount: 0,
            },
            roleAssignmentCount: 0,
        },
        tuningInventory: {
            totalKnobs: 0,
            knobs: [],
            omittedKnobs: 0,
            totalLimitations: 0,
            limitations: [],
            omittedLimitations: 0,
        },
        ...(input.candidateManifest === false
            ? { candidateManifestOmittedReason: 'manifest-too-large' as const }
            : { candidateManifest: run.manifest }),
        selection: {
            focusRunId: input.focusRunId,
            compareLeft: input.compareLeft,
            compareRight: input.compareRight,
            artifactRole: input.role,
        },
        distributedRun: {
            distributedRunId: run.distributedRunId,
            controlRunId: run.controlRunId,
            state: run.state,
            startedAtEpochMs: run.startedAtEpochMs,
            completedAtEpochMs: run.completedAtEpochMs,
            updatedAtEpochMs: run.updatedAtEpochMs,
            rollup: run.rollup,
            targetAgentIds: { entries: run.targetAgentIds, total: 1, omitted: 0 },
        },
        analysis: {
            generatedAtEpochMs: 2_600,
            distributedRunId: input.distributedRunId,
            controlRunId: input.controlRunId,
            status: 'passed',
            ok: true,
            summary: { agents: 1, passRate: 1, failureGroups: 0, blockingFailures: 0 },
            parseWarnings: [],
            summaryMarkdown: 'passed',
            performance: {
                commandTiming: { count: 1, p95Ms: 900, outlierCount: 0 },
                slowestAgents: [],
            },
        },
        receivedMessageDeltas: { entries: [], total: 0, omitted: 0 },
    } as unknown as AnalyzeTuneArtifactFacade;
}

describe('Recipe Console Tune facade authority', () => {
    it('rejects a facade validation projection bound to different truth', () => {
        const original = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
        });
        const validation = projectTuneFacadeManifestValidation(original);
        const changed = {
            ...original,
            candidateManifest: {
                ...original.candidateManifest!,
                recipes: [],
            },
        } satisfies AnalyzeTuneArtifactFacade;

        const source = deriveTuneSourceModelFromFacade({
            facade: changed,
            focusRunId: 'artifact',
            manifestValidation: validation,
        });
        expect(source.manifest).toBeUndefined();
        expect(source.candidate.allowed).toBe(false);
        expect(source.issues.map(issue => issue.code))
            .toContain('invalid-manifest');
    });

    it('validates two selected control manifests and one retained facade exactly once',
        () => {
            const validate = vi.spyOn(
                manifestValidation,
                'validateDistributedRunManifest',
            );
            const baseline = distributedRun('baseline', 'control-baseline');
            const candidate = distributedRun('candidate', 'control-candidate');
            const retained = facade({
                distributedRunId: 'candidate',
                controlRunId: 'control-candidate',
                role: 'focus',
                focusRunId: 'candidate',
                compareLeft: 'baseline',
                compareRight: 'candidate',
            });
            const controlQuery = query(
                [baseline, candidate],
                [controlRun('control-baseline'), controlRun('control-candidate')],
            );
            const state = urlState({
                compareLeft: 'baseline',
                compareRight: 'candidate',
            });
            const catalog = buildTuneRunCatalog({
                distributedRuns: controlQuery.snapshot?.distributedRuns ?? [],
                controlRuns: controlQuery.snapshot?.runs ?? [],
                retainedFacade: retained,
                performanceRunIds: ['baseline', 'candidate'],
            });

            expect(validate).toHaveBeenCalledTimes(3);
            expect(catalog.work).toMatchObject({
                manifestValidations: 2,
                retainedFacadeManifestValidations: 1,
            });
            const source = deriveTuneWorkspaceSourceModel({
                catalog,
                query: controlQuery,
                retained: { status: 'ready', model: retained },
                urlState: state,
            });
            expect(source.provenance.source).toBe('artifact');
            expect(validate).toHaveBeenCalledTimes(3);
            validate.mockRestore();
        });

    it('keeps an artifact-only retained run selectable without pretending it is comparable', () => {
        const retained = facade({
            distributedRunId: 'artifact-only',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact-only',
            candidateManifest: false,
        });
        const baseline = distributedRun('baseline', 'control-baseline');
        const selection = deriveTuneSelectionModel({
            query: query([baseline], [controlRun('control-baseline')]),
            retainedFacade: retained,
            urlState: urlState({
                compareLeft: 'baseline',
                compareRight: 'artifact-only',
            }),
        });
        const option = selection.options.find(row =>
            row.distributedRunId === 'artifact-only'
        );

        expect(option).toMatchObject({ source: 'artifact', pairStatus: 'missing' });
        expect(tuneRightSelectionPatch(option!)).toMatchObject({
            compareRight: 'artifact-only',
            distributedRunId: 'artifact-only',
            controlRunId: 'control-artifact',
        });

        expect(selection.focus?.distributedRunId).toBe('artifact-only');
        expect(selection.comparison.state).toBe('invalid');
        expect(selection.comparison.issues).toContainEqual(expect.objectContaining({
            field: 'compareRight',
            code: 'missing-control',
        }));

        const source = deriveTuneWorkspaceSourceModel({
            query: query([baseline], [controlRun('control-baseline')]),
            retained: { status: 'ready', model: retained },
            urlState: urlState({ distributedRunId: 'artifact-only' }),
        });
        expect(source.provenance.source).toBe('artifact');
        expect(source.manifest).toBeUndefined();
        expect(source.candidate.allowed).toBe(false);
        expect(source.issues.map(issue => issue.code)).toContain('reference-only');
    });

    it.each(['ready', 'pending'] as const)(
        'uses the accepted facade while it is the current focus during %s state',
        status => {
            const retained = facade({
                distributedRunId: 'artifact',
                controlRunId: 'control-artifact',
                role: 'focus',
                focusRunId: 'artifact',
            });
            const model = deriveTuneWorkspaceSourceModel({
                query: query([], []),
                retained: { status, model: retained },
                urlState: urlState({ distributedRunId: 'artifact' }),
            });

            expect(model.provenance).toMatchObject({
                source: 'artifact',
                detail: 'detailed',
            });
            expect(model.performance?.commandTiming.p95Ms).toBe(900);
            expect(model.retained.relation).toBe('matching');
        },
    );

    it('does not infer recipe incompatibility from a windowed facade summary', () => {
        const baseline = distributedRun('baseline', 'control-baseline');
        const baseFacade = facade({
            distributedRunId: 'artifact-only',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact-only',
            candidateManifest: false,
        });
        const retained = {
            ...baseFacade,
            manifestSummary: {
                ...baseFacade.manifestSummary,
                recipeIds: { entries: ['visible-only'], total: 2, omitted: 1 },
            },
        } satisfies AnalyzeTuneArtifactFacade;
        const selection = deriveTuneSelectionModel({
            query: query([baseline], [controlRun('control-baseline')]),
            retainedFacade: retained,
            urlState: urlState({
                compareLeft: 'baseline',
                compareRight: 'artifact-only',
            }),
        });

        expect(selection.comparison.state).toBe('invalid');
        expect(selection.comparison.compatibilityWarnings.map(row => row.code))
            .not.toContain('no-shared-recipe');
    });

    it('keeps a role-map artifact selectable when only its bounded summary is retained', () => {
        const baseFacade = facade({
            distributedRunId: 'role-map-artifact',
            controlRunId: 'control-role-map',
            role: 'focus',
            focusRunId: 'role-map-artifact',
            candidateManifest: false,
        });
        const retained = {
            ...baseFacade,
            manifestSummary: {
                ...baseFacade.manifestSummary,
                targetPolicy: {
                    mode: 'role-map' as const,
                    configuredAgentCount: 0,
                    configuredRoleCount: 2,
                },
            },
        } satisfies AnalyzeTuneArtifactFacade;
        const selection = deriveTuneSelectionModel({
            query: query([], []),
            retainedFacade: retained,
            urlState: urlState({ distributedRunId: 'role-map-artifact' }),
        });

        expect(selection.focus).toMatchObject({
            distributedRunId: 'role-map-artifact',
            source: 'artifact',
            pairStatus: 'missing',
            manifestAuthority: 'summary-projection',
        });
        expect(selection.quarantined).toEqual([]);
    });

    it('keeps malformed candidate manifests inspectable but blocks reusable output', () => {
        const baseFacade = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
        });
        const retained = {
            ...baseFacade,
            candidateManifest: {
                ...baseFacade.candidateManifest!,
                recipes: [],
            },
        } satisfies AnalyzeTuneArtifactFacade;
        const source = deriveTuneWorkspaceSourceModel({
            query: query([], []),
            retained: { status: 'ready', model: retained },
            urlState: urlState({ distributedRunId: 'artifact' }),
        });

        expect(source.provenance.source).toBe('artifact');
        expect(source.manifest).toBeUndefined();
        expect(source.candidate.allowed).toBe(false);
        expect(source.issues.map(issue => issue.code)).toContain('invalid-manifest');
    });

    it('preserves the bounded unsupported-artifact reason in source and candidate disclosure', () => {
        const baseFacade = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
        });
        const retained = {
            ...baseFacade,
            support: 'unsupported' as const,
            supportIssues: {
                entries: [{
                    code: 'unknown-schema-version' as const,
                    severity: 'error' as const,
                    message: 'Artifact schema version 99 is not supported.',
                }],
                total: 1,
                omitted: 0,
            },
        } as AnalyzeTuneArtifactFacade;
        const source = deriveTuneWorkspaceSourceModel({
            query: query([], []),
            retained: { status: 'ready', model: retained },
            urlState: urlState({ distributedRunId: 'artifact' }),
        });

        expect(source.issues).toContainEqual({
            code: 'unsupported-artifact',
            message: 'Artifact schema version 99 is not supported.',
        });
        expect(source.candidate.reasons).toContain(
            'Artifact schema version 99 is not supported.',
        );
    });

    it('keeps a partial bounded tuning inventory inspectable but blocks candidate output', () => {
        const baseFacade = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
        });
        const retained = {
            ...baseFacade,
            tuningInventory: {
                ...baseFacade.tuningInventory,
                totalLimitations: 1,
                omittedLimitations: 1,
            },
        } satisfies AnalyzeTuneArtifactFacade;
        const source = deriveTuneWorkspaceSourceModel({
            query: query([], []),
            retained: { status: 'ready', model: retained },
            urlState: urlState({ distributedRunId: 'artifact' }),
        });

        expect(source.provenance.source).toBe('artifact');
        expect(source.inventory).toBeDefined();
        expect(source.candidate.allowed).toBe(false);
        expect(source.candidate.reasons).toContain(
            'The bounded tuning inventory is incomplete.',
        );
    });

    it.each(['compare-left', 'unrelated'] as const)(
        'does not use a %s facade as candidate detail',
        role => {
            const candidate = distributedRun('candidate', 'control-candidate');
            const retained = facade({
                distributedRunId: 'baseline',
                controlRunId: 'control-baseline',
                role,
                focusRunId: 'candidate',
                compareLeft: 'baseline',
                compareRight: 'candidate',
            });
            const model = deriveTuneWorkspaceSourceModel({
                query: query([candidate], [controlRun('control-candidate')]),
                retained: { status: 'ready', model: retained },
                urlState: urlState({
                    compareLeft: 'baseline',
                    compareRight: 'candidate',
                }),
            });

            expect(model.provenance).toMatchObject({ source: 'control', detail: 'bounded' });
            expect(model.performance?.commandTiming.p95Ms).toBe(100);
            expect(model.retained.relation).toBe('mismatched');
            expect(model.issues.map(issue => issue.code)).toContain('retained-mismatch');
        },
    );

    it('keeps comparison on paired control evidence while the focused detail uses the facade', () => {
        const baseline = distributedRun('baseline', 'control-baseline');
        const candidate = distributedRun('candidate', 'control-candidate');
        const retained = facade({
            distributedRunId: 'candidate',
            controlRunId: 'control-candidate',
            role: 'focus',
            focusRunId: 'candidate',
            compareLeft: 'baseline',
            compareRight: 'candidate',
        });
        const controlQuery = query(
            [baseline, candidate],
            [controlRun('control-baseline'), controlRun('control-candidate')],
        );
        const selection = deriveTuneSelectionModel({
            query: controlQuery,
            retainedFacade: retained,
            urlState: urlState({
                compareLeft: 'baseline',
                compareRight: 'candidate',
            }),
        });
        const source = deriveTuneWorkspaceSourceModel({
            query: controlQuery,
            retained: { status: 'ready', model: retained },
            urlState: urlState({
                compareLeft: 'baseline',
                compareRight: 'candidate',
            }),
        });

        expect(selection.right).toMatchObject({ source: 'control', pairStatus: 'paired' });
        expect(selection.right?.performance?.commandTiming.p95Ms).toBe(100);
        expect(selection.comparison.state).toBe('ready');
        expect(source.provenance.source).toBe('artifact');
        expect(source.performance?.commandTiming.p95Ms).toBe(900);
        expect(source.candidate.allowed).toBe(true);
    });

    it('does not show a stale facade after a copied compare URL changes focus', () => {
        const candidate = distributedRun('candidate', 'control-candidate');
        const retained = facade({
            distributedRunId: 'old-focus',
            controlRunId: 'control-old',
            role: 'focus',
            focusRunId: 'old-focus',
        });
        const model = deriveTuneWorkspaceSourceModel({
            query: query([candidate], [controlRun('control-candidate')]),
            retained: { status: 'ready', model: retained },
            urlState: urlState({ compareRight: 'candidate' }),
        });

        expect(model.focusRunId).toBe('candidate');
        expect(model.provenance.source).toBe('control');
        expect(model.performance?.commandTiming.p95Ms).toBe(100);
        expect(model.retained.inspection?.performance?.commandTiming.p95Ms).toBe(900);
    });

    it('preserves the exact retained error while keeping live control authoritative', () => {
        const candidate = distributedRun('candidate', 'control-candidate');
        const retained = facade({
            distributedRunId: 'old-focus',
            controlRunId: 'control-old',
            role: 'focus',
            focusRunId: 'old-focus',
        });
        const model = deriveTuneWorkspaceSourceModel({
            query: query([candidate], [controlRun('control-candidate')]),
            retained: {
                status: 'error',
                model: retained,
                error: 'retained context changed exactly',
            },
            urlState: urlState({ compareRight: 'candidate' }),
        });

        expect(model.provenance.source).toBe('control');
        expect(model.retained.relation).toBe('context-error');
        expect(model.issues).toContainEqual({
            code: 'retained-context-error',
            message: 'retained context changed exactly',
        });
    });

    it('does not let a stale facade control identity override current control truth', () => {
        const current = distributedRun('same-run', 'current-control');
        const retained = facade({
            distributedRunId: 'same-run',
            controlRunId: 'old-control',
            role: 'focus',
            focusRunId: 'same-run',
        });
        const model = deriveTuneWorkspaceSourceModel({
            query: query([current], [controlRun('current-control')]),
            retained: { status: 'ready', model: retained },
            urlState: urlState({
                distributedRunId: 'same-run',
                controlRunId: 'current-control',
            }),
        });

        expect(model.provenance.source).toBe('control');
        expect(model.manifest?.controlRunId).toBe('current-control');
        expect(model.performance?.commandTiming.p95Ms).toBe(100);
        expect(model.retained).toMatchObject({
            relation: 'mismatched',
            inspection: { controlRunId: 'old-control' },
        });
    });

    it('keeps a same-focus error facade inspectable without candidate authority', () => {
        const retained = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
        });
        const model = deriveTuneWorkspaceSourceModel({
            query: query([], []),
            retained: {
                status: 'error',
                model: retained,
                error: 'replacement candidate failed exactly',
            },
            urlState: urlState({ distributedRunId: 'artifact' }),
        });

        expect(model.provenance.source).toBe('artifact');
        expect(model.retained).toMatchObject({
            relation: 'context-error',
            inspection: { distributedRunId: 'artifact' },
        });
        expect(model.candidate.allowed).toBe(false);
        expect(model.candidate.reasons).toContain(
            'replacement candidate failed exactly',
        );
    });

    it('uses same-identity bounded control truth while an error facade stays inspectable', () => {
        const current = distributedRun('artifact', 'control-artifact');
        const retained = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
        });
        const model = deriveTuneWorkspaceSourceModel({
            query: query([current], [controlRun('control-artifact')]),
            retained: {
                status: 'error',
                model: retained,
                error: 'retained context changed exactly',
            },
            urlState: urlState({ distributedRunId: 'artifact' }),
        });

        expect(model.provenance.source).toBe('control');
        expect(model.performance?.commandTiming.p95Ms).toBe(100);
        expect(model.retained).toMatchObject({
            relation: 'context-error',
            inspection: { performance: { commandTiming: { p95Ms: 900 } } },
        });
    });

    it('discloses every omitted tuning class and gives repeated issue codes stable keys', () => {
        const baseFacade = facade({
            distributedRunId: 'artifact',
            controlRunId: 'control-artifact',
            role: 'focus',
            focusRunId: 'artifact',
            candidateManifest: false,
        });
        const retained = {
            ...baseFacade,
            tuningInventory: {
                totalKnobs: 2,
                knobs: [],
                omittedKnobs: 2,
                totalLimitations: 3,
                limitations: [],
                omittedLimitations: 3,
            },
        } satisfies AnalyzeTuneArtifactFacade;
        const model = deriveTuneWorkspaceSourceModel({
            query: query([], []),
            retained: { status: 'ready', model: retained },
            urlState: urlState({ distributedRunId: 'artifact' }),
        });
        const referenceIssues = model.issues.filter(issue =>
            issue.code === 'reference-only'
        );

        expect(referenceIssues.map(issue => issue.message)).toContain(
            '2 tuning knobs and 3 tuning limitations remain worker-windowed.',
        );
        expect(referenceIssues.length).toBeGreaterThan(1);
        expect(new Set(referenceIssues.map(tuneSourceIssueKey)).size)
            .toBe(referenceIssues.length);
    });
});
