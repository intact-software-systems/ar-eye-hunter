import { describe, expect, it } from 'vitest';
import type {
    ControlAgentSnapshot,
    ControlDistributedRunSnapshot,
    ControlRunSnapshot,
    ControlServerSnapshot,
} from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import type { ControlRetentionCandidate } from
    '../../../packages/shared-test/rallar-bb-test/control-retention.ts';
import type { RallarBlackBoxDistributedRunState } from
    '../../../packages/shared-test/rallar-bb-test/distributed-run.ts';
import {
    deriveRecipeConsoleControlSelection,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-selection.ts';
import type {
    RecipeConsoleControlQueryProvenance,
} from '../../../apps/rallar-black-box/src/recipe-console/control/control-api.ts';
import type { ControlQuerySnapshot } from
    '../../../apps/rallar-black-box/src/recipe-console/control/control-query.ts';
import {
    deriveRecipeConsoleHistoryModel,
    projectHistoryRetentionCandidateRows,
    RECIPE_CONSOLE_HISTORY_ROW_LIMIT,
} from '../../../apps/rallar-black-box/src/recipe-console/history/history-model.ts';
import {
    captureRetentionSelectionBeforeCleanup,
    retentionSelectionPatchAfterCleanup,
} from '../../../apps/rallar-black-box/src/recipe-console/history/retention-selection-patch.ts';
import {
    createRecipeConsoleUrlHistory,
    type RecipeConsoleHistoryPort,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-history.ts';
import {
    createRecipeConsoleShareHref,
    parseRecipeConsoleUrl,
} from '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-codec.ts';
import type { RecipeConsoleUrlState } from
    '../../../apps/rallar-black-box/src/recipe-console/routing/url-state-contract.ts';

const bootstrapGroup = {
    applicationId: 'bootstrap-app',
    workspaceId: 'bootstrap-workspace',
    groupId: 'bootstrap-group',
} as const;

function urlState(patch: Partial<RecipeConsoleUrlState> = {}): RecipeConsoleUrlState {
    return { v: 1, experience: 'recipe-console', view: 'tune', ...patch };
}

function agent(runId: string, agentId: string, connected: boolean): ControlAgentSnapshot {
    return {
        runId,
        agentId,
        connected,
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
    updatedAtEpochMs = 1_000,
): ControlRunSnapshot {
    return {
        runId,
        createdAtEpochMs: 100,
        updatedAtEpochMs,
        agents,
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function distributedRun(input: Readonly<{
    id: string;
    control: string;
    updated?: number;
    created?: number;
    state?: RallarBlackBoxDistributedRunState;
    group?: string;
    recipe?: string;
    profile?: string;
    failureCode?: string;
}>): ControlDistributedRunSnapshot {
    const createdAtEpochMs = input.created ?? 100;
    const updatedAtEpochMs = input.updated ?? 200;
    const state = input.state ?? (input.failureCode ? 'failed' : 'passed');
    const recipeId = input.recipe ?? 'recipe-a';
    const failure = input.failureCode
        ? [{
            kind: 'recipe' as const,
            key: recipeId,
            state: 'failed' as const,
            required: true,
            error: {
                code: input.failureCode,
                message: `${input.failureCode} happened`,
            },
        }]
        : [];
    return {
        distributedRunId: input.id,
        controlRunId: input.control,
        state,
        createdAtEpochMs,
        updatedAtEpochMs,
        targetAgentIds: ['agent-a'],
        commandLinks: [],
        manifest: {
            schemaVersion: 1,
            distributedRunId: input.id,
            controlRunId: input.control,
            displayName: `Run ${input.id}`,
            group: {
                applicationId: 'rallar-server',
                workspaceId: 'default',
                groupId: input.group ?? 'group-a',
            },
            targetPolicy: { mode: 'selected-agents', agentIds: ['agent-a'] },
            recipes: [{
                recipeId,
                profile: input.profile,
                recipe: {
                    schemaVersion: 1,
                    recipeId,
                    commands: [{ kind: 'health', commandId: `command-${input.id}` }],
                },
            }],
        },
        rollup: {
            state,
            ok: state === 'passed',
            failures: failure,
            summary: {
                participants: 1,
                requiredParticipants: 1,
                readyParticipants: 1,
                passedParticipants: state === 'passed' ? 1 : 0,
                failedParticipants: state === 'failed' ? 1 : 0,
                recipes: 1,
                requiredRecipes: 1,
                passedRecipes: state === 'passed' ? 1 : 0,
                failedRecipes: state === 'failed' ? 1 : 0,
                blockingFailures: failure.length,
            },
        },
    };
}

function query(input: Readonly<{
    status?: ControlQuerySnapshot<ControlServerSnapshot>['status'];
    runs?: readonly ControlRunSnapshot[];
    distributedRuns?: readonly ControlDistributedRunSnapshot[];
    source?: RecipeConsoleControlQueryProvenance['distributedRunsSource'];
    completeness?: 'complete' | 'partial';
    includeSnapshot?: boolean;
}>): ControlQuerySnapshot<ControlServerSnapshot, RecipeConsoleControlQueryProvenance> {
    const status = input.status ?? 'live';
    const includeSnapshot = input.includeSnapshot ?? true;
    return {
        status,
        reachability: status === 'offline' ? 'unreachable' : 'reachable',
        authorization: 'ready',
        ...(includeSnapshot ? {
            snapshot: {
                runs: input.runs ?? [],
                ...(input.distributedRuns === undefined
                    ? {}
                    : { distributedRuns: input.distributedRuns }),
            },
        } : {}),
        completeness: input.completeness,
        provenance: input.source
            ? { distributedRunsSource: input.source }
            : undefined,
        receivedAtEpochMs: includeSnapshot ? 5_000 : undefined,
        isRefreshing: false,
    };
}

function retentionCandidate(
    runId: string,
    distributedRunIds: readonly string[],
): ControlRetentionCandidate {
    return {
        runId,
        createdAtEpochMs: 100,
        updatedAtEpochMs: 200,
        connectedAgentCount: 1,
        issuedRunTokenCount: 2,
        distributedRuns: distributedRunIds.map(distributedRunId => ({
            distributedRunId,
            state: 'failed',
        })),
        fleetReportIds: distributedRunIds.slice(0, 1),
    };
}

describe('Recipe Console History model', () => {
    it('derives exact filtered rows, labels, control pairing, actions, and source truth', () => {
        const baseline = distributedRun({
            id: 'baseline', control: 'control-baseline', updated: 300,
            group: 'other', recipe: 'health', profile: 'baseline',
        });
        const candidate = distributedRun({
            id: 'candidate', control: 'control-candidate', updated: 500,
            created: 250, group: 'group-a', recipe: 'rtc-stream',
            profile: 'smoke', failureCode: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
        });
        const control = controlRun('control-candidate', [
            agent('control-candidate', 'agent-a', true),
            agent('control-candidate', 'agent-b', false),
        ]);

        const model = deriveRecipeConsoleHistoryModel({
            urlState: urlState({
                historyGroup: 'group-a', historyRecipeId: 'rtc',
                historyProfile: 'smoke', status: 'failed',
                failureCategory: 'readiness', from: 200, to: 300,
            }),
            query: query({
                runs: [controlRun('control-baseline'), control],
                distributedRuns: [baseline, candidate],
                source: 'root-snapshot', completeness: 'complete',
            }),
        });

        expect(model.provenance).toEqual({
            status: 'live',
            distributedRunsSource: 'root-snapshot',
            freshness: 'current',
            completeness: 'complete',
            receivedAtEpochMs: 5_000,
        });
        expect(model.counts).toEqual({
            available: 2, total: 1, rendered: 1, omitted: 0,
        });
        expect(model.rows).toHaveLength(1);
        expect(model.rows[0]).toMatchObject({
            key: 'history-row:1',
            distributedRunId: 'candidate',
            controlRunId: 'control-candidate',
            state: 'failed',
            createdAtEpochMs: 250,
            updatedAtEpochMs: 500,
            pairStatus: 'paired',
            controlStatus: 'paired-connected',
            agentCount: 2,
            connectedAgentCount: 1,
            quarantined: false,
            labels: {
                group: { label: 'rallar-server / default / group-a' },
                recipes: [{ recipeId: 'rtc-stream', profile: 'smoke' }],
                failures: [{ category: 'readiness' }],
            },
            actions: {
                eligible: true,
                identity: {
                    distributedRunId: 'candidate',
                    controlRunId: 'control-candidate',
                },
                baselinePatch: { compareLeft: 'candidate' },
                candidatePatch: {
                    compareRight: 'candidate',
                    distributedRunId: 'candidate',
                    controlRunId: 'control-candidate',
                    agentId: undefined,
                    recipeId: undefined,
                    commandId: undefined,
                },
            },
        });
    });

    it('uses shared filtering order, preserves stable ties, and renders the first 80 rows', () => {
        const runs = Array.from({ length: 105 }, (_, index) => distributedRun({
            id: `distributed-${index}`,
            control: `control-${index}`,
            updated: index < 3 ? 10_000 : 9_999 - index,
        }));
        const model = deriveRecipeConsoleHistoryModel({
            urlState: urlState(),
            query: query({
                distributedRuns: runs,
                source: 'canonical-fallback',
                completeness: 'complete',
            }),
        });

        expect(RECIPE_CONSOLE_HISTORY_ROW_LIMIT).toBe(80);
        expect(model.counts).toEqual({
            available: 105, total: 105, rendered: 80, omitted: 25,
        });
        expect(model.rows.slice(0, 3).map(row => row.distributedRunId)).toEqual([
            'distributed-0', 'distributed-1', 'distributed-2',
        ]);
        expect(model.rows.at(-1)?.distributedRunId).toBe('distributed-79');
        expect(new Set(model.rows.map(row => row.key)).size).toBe(80);
        expect(model.rows.every((row, index) => row.key === `history-row:${index}`)).toBe(true);
    });

    it('projects identity only for visible rows without deriving Tune performance', () => {
        const visible = distributedRun({
            id: 'visible', control: 'control-visible', updated: 500,
            group: 'visible-group',
        });
        const filteredOut = distributedRun({
            id: 'filtered-out', control: 'control-filtered-out', updated: 400,
            group: 'other-group',
        });
        const visibleControl = controlRun('control-visible');
        Object.defineProperty(visibleControl, 'results', {
            configurable: true,
            get: () => {
                throw new Error('History must not derive Tune performance');
            },
        });
        const filteredOutControl = controlRun('control-filtered-out');
        Object.defineProperty(filteredOutControl, 'agents', {
            configurable: true,
            get: () => {
                throw new Error('History must not project filtered-out controls');
            },
        });

        expect(() => deriveRecipeConsoleHistoryModel({
            urlState: urlState({ historyGroup: 'visible-group' }),
            query: query({
                runs: [visibleControl, filteredOutControl],
                distributedRuns: [visible, filteredOut],
                source: 'root-snapshot', completeness: 'complete',
            }),
        })).not.toThrow();
    });

    it.each([
        ['stale fallback', query({
            status: 'stale', distributedRuns: [], source: 'canonical-fallback',
            completeness: 'complete',
        }), {
            status: 'stale', distributedRunsSource: 'canonical-fallback',
            freshness: 'last-known', completeness: 'complete', receivedAtEpochMs: 5_000,
        }],
        ['partial unavailable collection', query({
            status: 'partial', source: 'unavailable', completeness: 'partial',
        }), {
            status: 'partial', distributedRunsSource: 'unavailable',
            freshness: 'unavailable', completeness: 'unavailable', receivedAtEpochMs: 5_000,
        }],
        ['offline', query({ status: 'offline', includeSnapshot: false }), {
            status: 'offline', distributedRunsSource: 'unavailable',
            freshness: 'unavailable', completeness: 'unavailable', receivedAtEpochMs: undefined,
        }],
    ] as const)('projects %s provenance without overstating evidence', (_label, controlQuery, expected) => {
        expect(deriveRecipeConsoleHistoryModel({
            urlState: urlState(),
            query: controlQuery,
        }).provenance).toEqual(expected);
    });

    it('renders but quarantines duplicate, unsafe, malformed, missing, and ambiguous identities', () => {
        const malformedUnicode = JSON.parse('"distributed-\\ud800"') as string;
        const duplicateA = distributedRun({ id: 'duplicate', control: 'control-duplicate', updated: 600 });
        const duplicateB = distributedRun({ id: 'duplicate', control: 'control-duplicate', updated: 500 });
        const unsafe = distributedRun({ id: malformedUnicode, control: 'control-unsafe', updated: 400 });
        const malformed = structuredClone(distributedRun({
            id: 'malformed', control: 'control-malformed', updated: 300,
        })) as unknown as Record<string, any>;
        malformed.manifest.recipes = [null];
        const missing = distributedRun({ id: 'missing', control: 'control-missing', updated: 200 });
        const ambiguous = distributedRun({ id: 'ambiguous', control: 'control-shared', updated: 100 });
        const model = deriveRecipeConsoleHistoryModel({
            urlState: urlState(),
            query: query({
                distributedRuns: [
                    duplicateA, duplicateB, unsafe,
                    malformed as ControlDistributedRunSnapshot,
                    missing, ambiguous,
                ],
                runs: [
                    controlRun('control-duplicate'),
                    controlRun('control-unsafe'),
                    controlRun('control-malformed'),
                    controlRun('control-shared'),
                    controlRun('control-shared'),
                ],
                source: 'root-snapshot', completeness: 'complete',
            }),
        });

        expect(model.rows).toHaveLength(6);
        expect(model.rows.map(row => row.key)).toEqual(
            Array.from({ length: 6 }, (_, index) => `history-row:${index}`),
        );
        expect(model.rows.find(row => row.distributedRunId === malformedUnicode)).toMatchObject({
            distributedRunId: malformedUnicode,
            quarantined: true,
            actions: { eligible: false, reason: 'quarantined' },
        });
        expect(model.rows.filter(row => row.distributedRunId === 'duplicate'))
            .toHaveLength(2);
        expect(model.rows.filter(row => row.distributedRunId === 'duplicate')
            .every(row => row.quarantined && !row.actions.identity)).toBe(true);
        expect(model.rows.find(row => row.distributedRunId === 'malformed')).toMatchObject({
            quarantined: true,
            labels: { recipes: [] },
        });
        expect(model.rows.find(row => row.distributedRunId === 'missing')).toMatchObject({
            quarantined: false,
            pairStatus: 'missing',
            controlStatus: 'missing',
            actions: { eligible: false, reason: 'missing-control' },
        });
        expect(model.rows.find(row => row.distributedRunId === 'ambiguous')).toMatchObject({
            quarantined: false,
            pairStatus: 'ambiguous',
            controlStatus: 'ambiguous',
            actions: { eligible: false, reason: 'ambiguous-control' },
        });
        expect(model.rows.every(row => !row.key.includes(row.distributedRunId))).toBe(true);
    });

    it('projects every retention candidate with generated keys and exact unfiltered consequences', () => {
        const unsafeControlId = 'control\u202eunsafe';
        const unsafeDistributedId = JSON.parse('"distributed-\\ud800"') as string;
        const rows = projectHistoryRetentionCandidateRows([
            retentionCandidate(unsafeControlId, [unsafeDistributedId]),
            retentionCandidate('control-safe', ['distributed-safe']),
        ]);

        expect(rows).toEqual([
            expect.objectContaining({
                key: 'retention-candidate:0',
                runId: unsafeControlId,
                distributedRuns: [{ distributedRunId: unsafeDistributedId, state: 'failed' }],
            }),
            expect.objectContaining({
                key: 'retention-candidate:1',
                runId: 'control-safe',
                distributedRuns: [{ distributedRunId: 'distributed-safe', state: 'failed' }],
            }),
        ]);
        expect(rows[0]?.key).not.toContain(unsafeControlId);
        expect(JSON.stringify(rows)).not.toContain('planToken');
    });
});

describe('Recipe Console retention selection reconciliation', () => {
    it('clears only exact deleted associations and preserves filters, timing, and unrelated state', () => {
        const before = urlState({
            controlRunId: 'control-delete',
            distributedRunId: 'distributed-focus-delete',
            agentId: 'agent-delete',
            recipeId: 'recipe-delete',
            commandId: 'command-delete',
            compareLeft: 'distributed-left-survive',
            compareRight: 'distributed-right-delete',
            historyQuery: 'ack failure',
            historyGroup: 'group-a',
            historyRecipeId: 'rtc-stream',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            from: 100,
            to: 900,
            timingMetric: 'stream-drift',
            fleetRegion: 'eu-west',
        });
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: before,
            candidates: [retentionCandidate('control-delete', [
                'distributed-focus-delete', 'distributed-right-delete',
            ])],
        });
        const patch = retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: before,
            deletedRunIds: ['control-delete'],
        });

        expect(patch).toEqual({
            controlRunId: undefined,
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
            compareRight: undefined,
        });
        expect({ ...before, ...patch }).toMatchObject({
            compareLeft: 'distributed-left-survive',
            historyQuery: 'ack failure',
            historyGroup: 'group-a',
            historyRecipeId: 'rtc-stream',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            from: 100,
            to: 900,
            timingMetric: 'stream-drift',
            fleetRegion: 'eu-west',
        });
    });

    it('clears deleted distributed focus while preserving an unrelated surviving control agent', () => {
        const current = urlState({
            controlRunId: 'control-survive',
            distributedRunId: 'distributed-delete',
            agentId: 'agent-survive',
            recipeId: 'recipe-delete',
            commandId: 'command-delete',
        });
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: current,
            candidates: [retentionCandidate('control-delete', ['distributed-delete'])],
        });

        expect(retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: current,
            deletedRunIds: ['control-delete'],
        })).toStrictEqual({
            distributedRunId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
    });

    it('clears an unscoped agent when deleted distributed focus has no surviving control', () => {
        const current = urlState({
            distributedRunId: 'distributed-delete',
            agentId: 'agent-delete',
            recipeId: 'recipe-delete',
            commandId: 'command-delete',
        });
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: current,
            candidates: [retentionCandidate('control-delete', ['distributed-delete'])],
        });

        expect(retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: current,
            deletedRunIds: ['control-delete'],
        })).toStrictEqual({
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
        });
    });

    it('uses exact equality to clear unsafe IDs but never copies them into a URL patch', () => {
        const unsafeControlId = 'control\u202eunsafe';
        const unsafeDistributedId = JSON.parse('"distributed-\\ud800"') as string;
        const current = urlState({
            controlRunId: unsafeControlId,
            distributedRunId: unsafeDistributedId,
            compareLeft: unsafeDistributedId,
        });
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: current,
            candidates: [retentionCandidate(unsafeControlId, [unsafeDistributedId])],
        });
        const patch = retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: current,
            deletedRunIds: [unsafeControlId],
        });

        expect(patch).toEqual({
            controlRunId: undefined,
            distributedRunId: undefined,
            agentId: undefined,
            recipeId: undefined,
            commandId: undefined,
            compareLeft: undefined,
        });
        expect(JSON.stringify(patch)).not.toContain(unsafeControlId);
        expect(JSON.stringify(patch)).not.toContain(unsafeDistributedId);
    });

    it('does not overwrite a newer URL selection made after confirmation was captured', () => {
        const before = urlState({
            controlRunId: 'control-delete',
            distributedRunId: 'distributed-delete',
        });
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: before,
            candidates: [retentionCandidate('control-delete', ['distributed-delete'])],
        });
        const current = urlState({
            controlRunId: 'control-survive',
            distributedRunId: 'distributed-survive',
            agentId: 'agent-survive',
        });

        expect(retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: current,
            deletedRunIds: ['control-delete'],
        })).toEqual({});
    });

    it('leaves sole-survivor bootstrap explicit after refresh and never revives the deleted run', () => {
        const before = urlState({
            controlRunId: 'control-delete',
            distributedRunId: 'distributed-delete',
        });
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: before,
            candidates: [retentionCandidate('control-delete', ['distributed-delete'])],
        });
        const patch = retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: before,
            deletedRunIds: ['control-delete'],
        });
        const afterCleanup = { ...before, ...patch };
        const survivor = controlRun('control-survivor');
        const selection = deriveRecipeConsoleControlSelection({
            urlState: afterCleanup,
            snapshot: { runs: [survivor], distributedRuns: [] },
            bootstrapGroup,
            queryStatus: 'live',
        });

        expect(afterCleanup.controlRunId).toBeUndefined();
        expect(afterCleanup.distributedRunId).toBeUndefined();
        expect(selection).toMatchObject({
            controlRunId: 'control-survivor',
            controlRunSource: 'sole-run',
            urlReplacePatch: { controlRunId: 'control-survivor' },
        });
        expect(selection.controlRunId).not.toBe('control-delete');
    });

    it('proves filter to Candidate to cleanup to copied URL and back-forward restoration', () => {
        const candidate = distributedRun({
            id: 'candidate-delete', control: 'control-delete', updated: 500,
            group: 'group-a', recipe: 'rtc-stream', profile: 'smoke',
            failureCode: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
        });
        const baseline = distributedRun({
            id: 'baseline-survive', control: 'control-survive', updated: 400,
            group: 'group-a', recipe: 'rtc-stream', profile: 'smoke',
            failureCode: 'RALLAR_BB_DISTRIBUTED_ACK_TIMEOUT',
        });
        const port = new MemoryHistoryPort(
            '?provider=simulated&future=keep&v=1&experience=recipe-console&view=tune' +
            '&historyGroup=group-a&historyRecipeId=rtc-stream&historyProfile=smoke' +
            '&failureCategory=readiness&status=failed&compareLeft=baseline-survive' +
            '&timingMetric=stream-drift',
        );
        const history = createRecipeConsoleUrlHistory(port);
        const model = deriveRecipeConsoleHistoryModel({
            urlState: history.read().state,
            query: query({
                runs: [controlRun('control-delete'), controlRun('control-survive')],
                distributedRuns: [candidate, baseline],
                source: 'root-snapshot', completeness: 'complete',
            }),
        });
        const candidateRow = model.rows.find(row =>
            row.distributedRunId === 'candidate-delete'
        )!;

        const selected = history.push(candidateRow.actions.candidatePatch);
        const candidateSearch = port.currentSearch;
        const capture = captureRetentionSelectionBeforeCleanup({
            urlState: selected.state,
            candidates: [retentionCandidate('control-delete', ['candidate-delete'])],
        });
        const cleanupPatch = retentionSelectionPatchAfterCleanup({
            capture,
            currentUrlState: selected.state,
            deletedRunIds: ['control-delete'],
        });
        const cleaned = history.replace(cleanupPatch);
        const cleanedSearch = port.currentSearch;
        const copied = createRecipeConsoleShareHref({
            origin: 'https://example.test',
            pathname: '/black-box',
            search: cleanedSearch,
            hash: '',
        }, cleaned.state);

        expect(cleaned.state).toMatchObject({
            historyGroup: 'group-a',
            historyRecipeId: 'rtc-stream',
            historyProfile: 'smoke',
            failureCategory: 'readiness',
            status: 'failed',
            compareLeft: 'baseline-survive',
            timingMetric: 'stream-drift',
        });
        expect(cleaned.state.compareRight).toBeUndefined();
        expect(cleaned.state.distributedRunId).toBeUndefined();
        expect(new URL(copied).searchParams.get('future')).toBe('keep');
        expect(parseRecipeConsoleUrl(new URL(copied).search).state).toEqual(cleaned.state);

        const restored: RecipeConsoleUrlState[] = [];
        history.subscribe(value => restored.push(value.state));
        port.emitPopState(candidateSearch);
        port.emitPopState(cleanedSearch);
        expect(restored[0]).toMatchObject({
            compareRight: 'candidate-delete',
            distributedRunId: 'candidate-delete',
            controlRunId: 'control-delete',
            historyGroup: 'group-a',
        });
        expect(restored[1]?.compareRight).toBeUndefined();
        expect(restored[1]?.historyGroup).toBe('group-a');
    });
});

class MemoryHistoryPort implements RecipeConsoleHistoryPort {
    currentSearch: string;
    private readonly listeners = new Set<() => void>();

    constructor(search: string) {
        this.currentSearch = search;
    }

    readSearch(): string {
        return this.currentSearch;
    }

    push(search: string): void {
        this.currentSearch = search;
    }

    replace(search: string): void {
        this.currentSearch = search;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emitPopState(search: string): void {
        this.currentSearch = search;
        this.listeners.forEach(listener => listener());
    }
}
