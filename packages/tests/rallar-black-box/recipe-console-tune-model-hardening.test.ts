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
import { buildTuneRunCatalog } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-run-catalog.ts';
import { deriveTuneSelectionModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-selection-model.ts';
import { deriveTuneSourceModel } from
    '../../../apps/rallar-black-box/src/recipe-console/tune/tune-source-model.ts';

function run(id: string, controlRunId: string, updated = 2_000): ControlDistributedRunSnapshot {
    return {
        distributedRunId: id, controlRunId, state: 'passed',
        createdAtEpochMs: 1_000, updatedAtEpochMs: updated,
        startedAtEpochMs: 1_000, completedAtEpochMs: 2_000,
        targetAgentIds: ['agent-a'], commandLinks: [],
        manifest: {
            schemaVersion: 1, distributedRunId: id, controlRunId,
            group: { applicationId: 'rallar-server', workspaceId: 'default', groupId: 'group-a' },
            targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
            recipes: [{ recipeId: 'recipe-a', recipe: {
                recipeId: 'recipe-a', commands: [{ kind: 'health', commandId: `health-${id}` }],
            } }],
        },
        rollup: {
            state: 'passed', ok: true, failures: [],
            summary: { blockingFailures: 0 },
        },
    };
}

function control(runId: string, events = 1, updated = 3_000): ControlRunSnapshot {
    return {
        runId, createdAtEpochMs: 900, updatedAtEpochMs: updated, agents: [],
        commands: [{
            envelope: {
                kind: 'command', protocolVersion: 1, runId, agentId: 'agent-a',
                commandId: `health-${runId}`, command: { kind: 'health' },
            },
            queuedAtEpochMs: 1_100, completedAtEpochMs: 1_200, dispatchCount: 1,
        }],
        results: [], stats: [], reports: [], heartbeats: [],
        events: Array.from({ length: events }, (_, index) => ({
            kind: 'event' as const, protocolVersion: 1 as const, runId,
            agentId: 'agent-a', eventId: `event-${runId}-${index}`,
            atEpochMs: 1_300 + index,
            payload: {
                distributedRunId: runId.replace(/^control-/, ''),
                topic: 'message.received', message: `received payload ${index}`,
            },
        })),
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
        receivedAtEpochMs: 4_000, isRefreshing: false,
    };
}

function artifact(
    distributedRun: ControlDistributedRunSnapshot,
    controlRun: ControlRunSnapshot,
    support: AnalyzeArtifactModel['workspace']['support'] = 'supported',
): AnalyzeArtifactModel {
    return {
        distributedRunId: distributedRun.distributedRunId,
        controlRunId: distributedRun.controlRunId,
        identity: {
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
        },
        snapshots: { distributedRun, controlRun },
        workspace: { support, issues: support === 'supported' ? [] : [{
            code: 'unsupported-test-artifact',
            message: 'Unsupported artifact fixture.',
        }] },
        analysis: {
            distributedRunId: distributedRun.distributedRunId,
            controlRunId: distributedRun.controlRunId,
            performance: {
                commandTiming: { count: 1, p95Ms: 100, outlierCount: 0 },
                agentCount: 1, passRate: 1, reconnectCount: 0, diagnosticCount: 0,
                warningDiagnosticCount: 0, errorDiagnosticCount: 0,
                exportedEventCount: controlRun.events.length, agentReportedEventCount: 0,
                failedAgentCount: 0, missingAgentCount: 0, staleAgentCount: 0,
                flakyAgentCount: 0, slowestAgents: [],
            },
        },
        provenance: { generatedAtEpochMs: 4_000 },
    } as unknown as AnalyzeArtifactModel;
}

const url = (patch: Record<string, unknown> = {}) => ({
    v: 1 as const, experience: 'recipe-console' as const, view: 'tune' as const, ...patch,
});

describe('Recipe Console Tune model hardening', () => {
    it('quarantines repeated distributed IDs and refuses duplicate control pairing', () => {
        const duplicated = [run('dup', 'control-dup', 3_000), run('dup', 'control-dup', 2_000), run('dup', 'control-dup', 1_000)];
        const duplicatedCatalog = buildTuneRunCatalog({
            distributedRuns: duplicated, controlRuns: [control('control-dup')],
        });
        expect(duplicatedCatalog.options).toEqual([]);
        expect(duplicatedCatalog.quarantined.length).toBeGreaterThan(0);

        const unique = run('unique', 'control-shared');
        const duplicateControls = [control('control-shared', 1, 5_000), control('control-shared', 2, 4_000)];
        const source = deriveTuneSourceModel({
            urlState: url({ distributedRunId: 'unique' }),
            query: query('live', [unique], duplicateControls),
        });
        expect(source.candidate.allowed).toBe(false);
        expect(source.issues.map(issue => issue.code)).toContain('ambiguous-control');
    });

    it('keeps delimiter-bearing unsafe identity tuples distinct in quarantine', () => {
        const catalog = buildTuneRunCatalog({
            distributedRuns: [
                run('a\u0000b', 'c'),
                run('a', 'b\u0000c'),
            ],
            controlRuns: [],
        });

        expect(catalog.options).toEqual([]);
        expect(catalog.quarantined).toHaveLength(2);
        expect(new Set(catalog.quarantined.map(row => row.key)).size).toBe(2);
        expect(catalog.quarantined.every(row =>
            /^tune-quarantined:\d+$/.test(row.key) && !row.key.includes('\u0000')
        )).toBe(true);
    });

    it('uses matching artifact snapshots consistently for structural and message comparison', () => {
        const left = run('left', 'control-left');
        const right = run('right', 'control-right');
        const leftControl = control('control-left', 1);
        const liveRight = control('control-right', 2);
        const artifactRight = control('control-right', 10);
        const model = deriveTuneSelectionModel({
            urlState: url({ compareLeft: 'left', compareRight: 'right' }),
            query: query('live', [left, right], [leftControl, liveRight]),
            retainedArtifact: artifact(right, artifactRight),
            retainedArtifactStatus: 'ready',
        });

        expect(model.right?.source).toBe('artifact+control');
        expect(model.right?.controlRun?.events).toHaveLength(10);
        expect(model.comparison.structural?.receivedMessageDelta).toMatchObject({
            leftCount: 1, rightCount: 10, delta: 9,
        });
    });

    it.each(['pending', 'error'] as const)(
        'keeps %s retained artifact evidence inspectable but out of comparison authority',
        retainedArtifactStatus => {
            const left = run('left', 'control-left');
            const right = run('right', 'control-right');
            const leftControl = control('control-left', 1);
            const liveRight = control('control-right', 2);
            const retainedRight = control('control-right', 10);
            const model = deriveTuneSelectionModel({
                urlState: url({ compareLeft: 'left', compareRight: 'right' }),
                query: query('live', [left, right], [leftControl, liveRight]),
                retainedArtifact: artifact(right, retainedRight),
                retainedArtifactStatus,
            });

            expect(model.right?.source).toBe('control');
            expect(model.right?.artifactEvidence?.controlRun?.events).toHaveLength(10);
            expect(model.right?.controlRun?.events).toHaveLength(2);
            expect(model.comparison.structural?.receivedMessageDelta).toMatchObject({
                leftCount: 1, rightCount: 2, delta: 1,
            });

            const withoutLivePair = deriveTuneSelectionModel({
                urlState: url({ compareLeft: 'left', compareRight: 'right' }),
                query: query('live', [left, right], [leftControl]),
                retainedArtifact: artifact(right, retainedRight),
                retainedArtifactStatus,
            });
            expect(withoutLivePair.comparison.state).toBe('invalid');
            expect(withoutLivePair.comparison.structural).toBeUndefined();
        },
    );

    it('promotes retained artifact truth only when it is ready supported and focused', () => {
        const left = run('left', 'control-left');
        const right = run('right', 'control-right');
        const liveLeft = control('control-left', 1);
        const liveRight = control('control-right', 2);
        const detailed = control('control-right', 10);
        const unsupported = deriveTuneSelectionModel({
            urlState: url({ compareLeft: 'left', compareRight: 'right' }),
            query: query('live', [left, right], [liveLeft, liveRight]),
            retainedArtifact: artifact(right, detailed, 'unsupported'),
            retainedArtifactStatus: 'ready',
        });
        expect(unsupported.right?.source).toBe('control');
        expect(unsupported.comparison.structural?.receivedMessageDelta).toMatchObject({
            leftCount: 1, rightCount: 2, delta: 1,
        });

        const retainedLeft = deriveTuneSelectionModel({
            urlState: url({ compareLeft: 'left', compareRight: 'right' }),
            query: query('live', [left, right], [liveLeft, liveRight]),
            retainedArtifact: artifact(left, control('control-left', 10)),
            retainedArtifactStatus: 'ready',
        });
        expect(retainedLeft.left?.source).toBe('control');
        expect(retainedLeft.left?.artifactEvidence?.controlRun?.events).toHaveLength(10);
        expect(retainedLeft.comparison.structural?.receivedMessageDelta).toMatchObject({
            leftCount: 1, rightCount: 2, delta: 1,
        });
    });

    it.each([
        ['top-level distributed identity', (model: AnalyzeArtifactModel) => {
            (model as unknown as { distributedRunId: string }).distributedRunId = 'other';
        }],
        ['projected distributed identity', (model: AnalyzeArtifactModel) => {
            (model.identity as { distributedRunId: string }).distributedRunId = 'other';
        }],
        ['top-level control identity', (model: AnalyzeArtifactModel) => {
            (model as unknown as { controlRunId: string }).controlRunId = 'control-other';
        }],
        ['projected control identity', (model: AnalyzeArtifactModel) => {
            (model.identity as { controlRunId: string }).controlRunId = 'control-other';
        }],
        ['analysis distributed identity', (model: AnalyzeArtifactModel) => {
            (model.analysis as { distributedRunId: string }).distributedRunId = 'other';
        }],
        ['analysis control identity', (model: AnalyzeArtifactModel) => {
            (model.analysis as { controlRunId: string }).controlRunId = 'control-other';
        }],
    ] as const)(
        'does not promote retained artifact truth with a conflicting %s',
        (_label, mutate) => {
            const left = run('left', 'control-left');
            const right = run('right', 'control-right');
            const liveLeft = control('control-left', 1);
            const liveRight = control('control-right', 2);
            const retained = artifact(right, control('control-right', 10));
            mutate(retained);

            const model = deriveTuneSelectionModel({
                urlState: url({ compareLeft: 'left', compareRight: 'right' }),
                query: query('live', [left, right], [liveLeft, liveRight]),
                retainedArtifact: retained,
                retainedArtifactStatus: 'ready',
            });

            expect(model.right?.source).toBe('control');
            expect(model.right?.controlRun?.events).toHaveLength(2);
            expect(model.comparison.structural?.receivedMessageDelta).toMatchObject({
                leftCount: 1, rightCount: 2, delta: 1,
            });

            const source = deriveTuneSourceModel({
                urlState: url({ distributedRunId: 'right' }),
                query: query('live', [right], [liveRight]),
                retained: { status: 'ready', model: retained },
            });
            expect(source.provenance).toMatchObject({ source: 'control', detail: 'bounded' });
            expect(source.controlRun?.events).toHaveLength(2);
        },
    );

    it('keeps comparison invalid when either selected run lacks a control pair', () => {
        const left = run('left', 'control-left');
        const right = run('right', 'control-right');
        const model = deriveTuneSelectionModel({
            urlState: url({ compareLeft: 'left', compareRight: 'right' }),
            query: query('live', [left, right], []),
        });

        expect(model.comparison.state).toBe('invalid');
        expect(model.comparison.issues.map(issue => issue.code)).toContain('missing-control');
        expect(model.comparison.structural).toBeUndefined();
    });

    it('does not inherit stale control limits for current artifact authority and preserves provider', () => {
        const selected = run('right', 'control-right');
        const selectedControl = control('control-right', 3);
        const model = deriveTuneSourceModel({
            urlState: url({ distributedRunId: 'right' }),
            query: query('stale', [selected], [selectedControl]),
            retained: { status: 'ready', model: artifact(selected, selectedControl) },
            sourceSearch: '?provider=browser-rallar&manualToken=secret',
        } as Parameters<typeof deriveTuneSourceModel>[0]);

        expect(model.provenance).toMatchObject({ source: 'artifact', detail: 'detailed' });
        expect(model.issues.map(issue => issue.code)).not.toContain('stale-control');
        expect(model.candidate.allowed).toBe(true);
        expect(model.legacyRunsHref).toContain('provider=browser-rallar');
        expect(model.legacyRunsHref).not.toContain('manualToken');
    });

    it('contains malformed recipe collections at the catalog boundary', () => {
        const left = run('left', 'control-left');
        const malformed = structuredClone(run('right', 'control-right')) as unknown as Record<string, any>;
        malformed.manifest.recipes = null;
        let model: ReturnType<typeof deriveTuneSelectionModel> | undefined;
        expect(() => {
            model = deriveTuneSelectionModel({
                urlState: url({ compareLeft: 'left', compareRight: 'right' }),
                query: query('live', [left, malformed as ControlDistributedRunSnapshot], [
                    control('control-left'), control('control-right'),
                ]),
            });
        }).not.toThrow();
        expect(model?.comparison.state).toBe('invalid');
        expect(model?.quarantined).toHaveLength(1);
    });

    it.each([
        ['a null recipe selection', (candidate: Record<string, any>) => {
            candidate.manifest.recipes = [null];
        }],
        ['outer/manifest distributed identity drift', (candidate: Record<string, any>) => {
            candidate.manifest.distributedRunId = 'different-distributed-run';
        }],
        ['outer/manifest control identity drift', (candidate: Record<string, any>) => {
            candidate.manifest.controlRunId = 'different-control-run';
        }],
    ] as const)('quarantines %s before comparison derivation', (_label, mutate) => {
        const left = run('left', 'control-left');
        const malformed = structuredClone(run('right', 'control-right')) as unknown as
            Record<string, any>;
        mutate(malformed);
        let model: ReturnType<typeof deriveTuneSelectionModel> | undefined;

        expect(() => {
            model = deriveTuneSelectionModel({
                urlState: url({ compareLeft: 'left', compareRight: 'right' }),
                query: query('live', [
                    left,
                    malformed as ControlDistributedRunSnapshot,
                ], [control('control-left'), control('control-right')]),
            });
        }).not.toThrow();
        expect(model?.comparison.state).toBe('invalid');
        expect(model?.comparison.structural).toBeUndefined();
        expect(model?.comparison.issues.map(issue => issue.code))
            .toContain('invalid-manifest');
        expect(model?.quarantined).toEqual([
            expect.objectContaining({
                distributedRunId: 'right',
                issues: expect.arrayContaining([
                    expect.stringMatching(/manifest|identity/i),
                ]),
            }),
        ]);

        const source = deriveTuneSourceModel({
            urlState: url({ distributedRunId: 'right' }),
            query: query('live', [
                malformed as ControlDistributedRunSnapshot,
            ], [control('control-right')]),
        });
        expect(source.issues.map(issue => issue.code)).toContain('invalid-manifest');
        expect(source.issues.map(issue => issue.code)).not.toContain('focus-unavailable');
    });
});
