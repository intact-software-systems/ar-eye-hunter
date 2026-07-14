import type { BrowserContext, Route } from '@playwright/test';
import type { ControlDistributedRunSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { createTuneArtifactEnvelope } from './recipe-console-tune-artifacts.ts';
import {
    TUNE_BASE_EPOCH_MS,
    TUNE_LEFT_CONTROL_RUN_ID,
    TUNE_LEFT_RUN_ID,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    createTuneControlRun,
    createTuneDistributedRun,
} from './recipe-console-tune-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;

export const RETENTION_LONG_BIDI_CONTROL_ID =
    `history-control-\u202egnol-界-\u2066exact\u2069-${'control'.repeat(20)}`;
const RETENTION_LONG_BIDI_DISTRIBUTED_ID =
    `history-distributed-\u202egnol-界-\u2066exact\u2069-${'distributed'.repeat(14)}`;

export type RecipeConsoleTuneFixture = Readonly<{
    artifactRequestCount(): number;
    mutationRequestCount(): number;
    requestOrder(): readonly string[];
    retentionRequests(): readonly RetentionRequestObservation[];
    setReachability(value: 'live' | 'offline'): void;
    snapshotIds(): Readonly<{
        controlRunIds: readonly string[];
        distributedRunIds: readonly string[];
    }>;
}>;

export type RetentionMode = 'ready' | 'drift-once' | 'authorization-required';

export type RetentionRequestObservation = Readonly<{
    kind: 'preview' | 'confirm' | 'legacy';
    method: string;
    dryRun: boolean;
    hasPlanToken: boolean;
    body: string | null;
    authorization: string | null;
}>;

export type RecipeConsoleTuneFixtureOptions = Readonly<{
    compatibility?: 'aligned' | 'advisory';
    initialControlState?: 'live' | 'partial';
    initialReachability?: 'live' | 'offline';
    retention?: RetentionMode;
    retentionCandidateCount?: number;
    retentionLinkedCount?: number;
    retentionLongBidiId?: boolean;
    rightRecipe?: 'inline' | 'reference-only';
    shadowedRateHz?: boolean;
}>;

export async function installRecipeConsoleTuneFixture(
    context: BrowserContext,
    options: RecipeConsoleTuneFixtureOptions = {},
): Promise<RecipeConsoleTuneFixture> {
    let controlRuns = [
        createTuneControlRun('left'),
        createTuneControlRun('right'),
    ];
    let rightDistributedRun = createTuneDistributedRun('right');
    if (options.shadowedRateHz) {
        rightDistributedRun = shadowTuneRateHz(rightDistributedRun);
    }
    if (options.rightRecipe === 'reference-only') {
        rightDistributedRun = referenceOnlyTuneRun(rightDistributedRun);
    }
    if (options.compatibility === 'advisory') {
        rightDistributedRun = incompatibleTuneRun(rightDistributedRun);
    }
    let distributedRuns = [
        createTuneDistributedRun('left'),
        rightDistributedRun,
    ];
    for (
        let index = 1;
        index < (options.retentionCandidateCount ?? 1);
        index += 1
    ) {
        const { runId, distributedRunId } = retentionIds(
            index,
            options.retentionCandidateCount ?? 1,
            options.retentionLongBidiId === true,
        );
        controlRuns.push(historyOverflowControlRun(runId, index));
        distributedRuns.push(historyOverflowDistributedRun(
            distributedRunId,
            runId,
            index,
        ));
    }
    let artifactReads = 0;
    let mutationRequests = 0;
    let reachability = options.initialReachability ?? 'live';
    const retentionMode = options.retention ?? 'ready';
    let retentionSequence = 0;
    let currentPlan: ReturnType<typeof retentionPreview> | undefined;
    let driftConsumed = false;
    const retentionObservations: RetentionRequestObservation[] = [];
    const order: string[] = [];

    await context.route(CONTROL_ROUTE, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await fulfillJson(route, undefined, 204);
            return;
        }
        if (reachability === 'offline') {
            await route.abort('connectionfailed');
            return;
        }
        if (
            options.initialControlState === 'partial' &&
            url.pathname === '/distributed-runs'
        ) {
            await route.abort('connectionfailed');
            return;
        }
        if (request.method() !== 'GET') mutationRequests += 1;
        if (request.method() === 'GET' && isArtifactRead(url.pathname)) {
            artifactReads += 1;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            order.push('runs');
            await fulfillJson(route, { runs: controlRuns });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            order.push('distributed-runs');
            await fulfillJson(route, { distributedRuns });
            return;
        }
        if (request.method() === 'POST' && url.pathname === '/retention/cleanup') {
            const dryRun = url.searchParams.get('dryRun');
            const planToken = url.searchParams.get('planToken');
            const kind = dryRun === 'true'
                ? 'preview'
                : planToken !== null ? 'confirm' : 'legacy';
            retentionObservations.push({
                kind,
                method: request.method(),
                dryRun: dryRun === 'true',
                hasPlanToken: planToken !== null,
                body: request.postData(),
                authorization: request.headers().authorization ?? null,
            });
            order.push(kind);
            if (!options.retention) {
                await fulfillJson(route, { error: 'Retention fixture disabled.' }, 404);
                return;
            }
            if (kind === 'legacy') {
                await fulfillJson(route, { error: 'Bare cleanup is forbidden.' }, 400);
                return;
            }
            if (kind === 'preview') {
                if (retentionMode === 'authorization-required') {
                    await fulfillJson(route, { error: 'Operator authorization required.' }, 403);
                    return;
                }
                currentPlan = retentionPreview(
                    ++retentionSequence,
                    options.retentionCandidateCount ?? 1,
                    options.retentionLinkedCount ?? 1,
                    options.retentionLongBidiId === true,
                );
                await fulfillJson(route, currentPlan);
                return;
            }
            if (!currentPlan || planToken !== currentPlan.planToken) {
                await fulfillJson(route, { error: 'Retention preview is stale.' }, 409);
                return;
            }
            if (retentionMode === 'drift-once' && !driftConsumed) {
                driftConsumed = true;
                currentPlan = undefined;
                await fulfillJson(route, { error: 'Retention preview drifted.' }, 409);
                return;
            }
            const deletedRunIds = [...currentPlan.wouldDeleteRunIds];
            const deletedDistributedRunIds = new Set(
                currentPlan.wouldDeleteDistributedRunIds,
            );
            controlRuns = controlRuns.filter(run => !deletedRunIds.includes(run.runId));
            distributedRuns = distributedRuns.filter(run =>
                !deletedDistributedRunIds.has(run.distributedRunId)
            );
            const confirmation = {
                deletedRunIds,
                retainedRuns: currentPlan.projectedRetainedRuns,
                maxRuns: currentPlan.maxRuns,
            };
            currentPlan = undefined;
            await fulfillJson(route, confirmation);
            return;
        }
        const runId = detailId(url.pathname, '/runs/');
        if (request.method() === 'GET' && runId) {
            const run = controlRuns.find(candidate => candidate.runId === runId);
            await fulfillJson(route, run ?? { error: 'run not found' }, run ? 200 : 404);
            return;
        }
        const distributedRunId = detailId(url.pathname, '/distributed-runs/');
        if (request.method() === 'GET' && distributedRunId) {
            const run = distributedRuns.find(candidate =>
                candidate.distributedRunId === distributedRunId
            );
            await fulfillJson(route, run ?? { error: 'distributed run not found' }, run ? 200 : 404);
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/distributed-runs/${TUNE_RIGHT_RUN_ID}/artifacts`
        ) {
            await fulfillJson(route, createTuneArtifactEnvelope());
            return;
        }
        await fulfillJson(route, {
            error: `Unhandled ${request.method()} ${url.pathname}`,
            known: [
                TUNE_LEFT_CONTROL_RUN_ID,
                TUNE_RIGHT_CONTROL_RUN_ID,
                TUNE_LEFT_RUN_ID,
                TUNE_RIGHT_RUN_ID,
            ],
        }, 404);
    });

    return {
        artifactRequestCount: () => artifactReads,
        mutationRequestCount: () => mutationRequests,
        requestOrder: () => [...order],
        retentionRequests: () => retentionObservations.map(value => ({ ...value })),
        setReachability: value => {
            reachability = value;
        },
        snapshotIds: () => ({
            controlRunIds: controlRuns.map(run => run.runId),
            distributedRunIds: distributedRuns.map(run => run.distributedRunId),
        }),
    };
}

function retentionPreview(
    sequence: number,
    candidateCount: number,
    linkedCount: number,
    longBidiId: boolean,
) {
    const candidates = Array.from({ length: candidateCount }, (_, index) => {
        const primary = index === 0;
        const ids = primary
            ? {
                runId: TUNE_RIGHT_CONTROL_RUN_ID,
                distributedRunId: TUNE_RIGHT_RUN_ID,
            }
            : retentionIds(index, candidateCount, longBidiId);
        const linked = Array.from({ length: linkedCount }, (_, linkIndex) => ({
            distributedRunId: linkIndex === 0
                ? ids.distributedRunId
                : `${ids.distributedRunId}-linked-${String(linkIndex).padStart(6, '0')}`,
            state: primary ? 'failed' : 'passed',
        }));
        return {
            runId: ids.runId,
            createdAtEpochMs: TUNE_BASE_EPOCH_MS + index,
            updatedAtEpochMs: TUNE_BASE_EPOCH_MS + 4_800 + index,
            connectedAgentCount: primary ? 2 : 0,
            issuedRunTokenCount: primary ? 1 : 0,
            distributedRuns: linked,
            fleetReportIds: linked.map(run => run.distributedRunId),
        };
    });
    return {
        deletedRunIds: [],
        retainedRuns: candidateCount + 1,
        maxRuns: 1,
        dryRun: true,
        wouldDeleteRuns: candidates,
        wouldDeleteRunIds: candidates.map(candidate => candidate.runId),
        wouldDeleteDistributedRunIds: candidates.flatMap(candidate =>
            candidate.distributedRuns.map(run => run.distributedRunId)
        ),
        wouldDeleteFleetReportIds: candidates.flatMap(candidate =>
            candidate.fleetReportIds
        ),
        projectedRetainedRuns: 1,
        preserves: {
            connectedAgentSockets: true,
            storedArtifactFiles: true,
        },
        planToken: `history-plan-${sequence}`,
    } as const;
}

function retentionIds(
    index: number,
    candidateCount: number,
    longBidiId: boolean,
): Readonly<{ runId: string; distributedRunId: string }> {
    const longBidiIndex = Math.floor(candidateCount * 3 / 4);
    return longBidiId && index === longBidiIndex
        ? {
            runId: RETENTION_LONG_BIDI_CONTROL_ID,
            distributedRunId: RETENTION_LONG_BIDI_DISTRIBUTED_ID,
        }
        : {
            runId: `history-overflow-control-${index}`,
            distributedRunId: `history-overflow-distributed-${index}`,
        };
}

function historyOverflowControlRun(runId: string, index: number) {
    const source = createTuneControlRun('right');
    return {
        ...source,
        runId,
        createdAtEpochMs: TUNE_BASE_EPOCH_MS + index,
        updatedAtEpochMs: TUNE_BASE_EPOCH_MS + 4_800 + index,
        agents: [],
        commands: [],
        results: [],
        events: [],
        stats: [],
        reports: [],
        heartbeats: [],
    };
}

function historyOverflowDistributedRun(
    distributedRunId: string,
    controlRunId: string,
    index: number,
): ControlDistributedRunSnapshot {
    const source = createTuneDistributedRun('left');
    return {
        ...source,
        distributedRunId,
        controlRunId,
        createdAtEpochMs: TUNE_BASE_EPOCH_MS + index,
        updatedAtEpochMs: TUNE_BASE_EPOCH_MS + 4_800 + index,
        manifest: {
            ...source.manifest,
            distributedRunId,
            controlRunId,
            displayName: `History overflow run ${index}`,
        },
    };
}

function referenceOnlyTuneRun(
    run: ControlDistributedRunSnapshot,
): ControlDistributedRunSnapshot {
    return {
        ...run,
        manifest: {
            ...run.manifest,
            recipes: run.manifest.recipes.map(selection => ({
                ...selection,
                recipe: undefined,
            })),
        },
    };
}

function shadowTuneRateHz(
    run: ControlDistributedRunSnapshot,
): ControlDistributedRunSnapshot {
    return {
        ...run,
        manifest: {
            ...run.manifest,
            recipes: run.manifest.recipes.map(selection => ({
                ...selection,
                recipe: selection.recipe
                    ? {
                        ...selection.recipe,
                        commands: selection.recipe.commands.map(command =>
                            command.kind === 'rtc.stream'
                                ? { ...command, intervalMs: 33 }
                                : command
                        ),
                    }
                    : undefined,
            })),
        },
    };
}

function incompatibleTuneRun(
    run: ControlDistributedRunSnapshot,
): ControlDistributedRunSnapshot {
    return {
        ...run,
        manifest: {
            ...run.manifest,
            group: {
                ...run.manifest.group,
                groupId: 'tune-advisory-other-group',
            },
            recipes: run.manifest.recipes.map((selection, index) => index === 0
                ? {
                    ...selection,
                    recipeId: 'tune-advisory-other-recipe',
                    recipe: selection.recipe
                        ? {
                            ...selection.recipe,
                            recipeId: 'tune-advisory-other-recipe',
                        }
                        : undefined,
                }
                : selection),
        },
    };
}

function isArtifactRead(pathname: string): boolean {
    return pathname.includes('/artifacts') ||
        pathname.endsWith('/failure-bundle') ||
        /\/(?:results|events)\.jsonl$/.test(pathname);
}

function detailId(pathname: string, prefix: string): string | undefined {
    if (!pathname.startsWith(prefix)) return undefined;
    const suffix = pathname.slice(prefix.length);
    return suffix && !suffix.includes('/') ? decodeURIComponent(suffix) : undefined;
}

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
            'access-control-allow-origin': '*',
            'access-control-allow-headers': '*',
            'access-control-allow-methods': 'GET,POST,OPTIONS',
        },
        body: body === undefined ? '' : JSON.stringify(body),
    });
}
