import type { BrowserContext, Route } from '@playwright/test';
import type { ControlDistributedRunSnapshot } from
    '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { createTuneArtifactEnvelope } from './recipe-console-tune-artifacts.ts';
import {
    TUNE_LEFT_CONTROL_RUN_ID,
    TUNE_LEFT_RUN_ID,
    TUNE_RIGHT_CONTROL_RUN_ID,
    TUNE_RIGHT_RUN_ID,
    createTuneControlRun,
    createTuneDistributedRun,
} from './recipe-console-tune-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;

export type RecipeConsoleTuneFixture = Readonly<{
    artifactRequestCount(): number;
    mutationRequestCount(): number;
    setReachability(value: 'live' | 'offline'): void;
}>;

export type RecipeConsoleTuneFixtureOptions = Readonly<{
    compatibility?: 'aligned' | 'advisory';
    initialControlState?: 'live' | 'partial';
    initialReachability?: 'live' | 'offline';
    rightRecipe?: 'inline' | 'reference-only';
    shadowedRateHz?: boolean;
}>;

export async function installRecipeConsoleTuneFixture(
    context: BrowserContext,
    options: RecipeConsoleTuneFixtureOptions = {},
): Promise<RecipeConsoleTuneFixture> {
    const controlRuns = [
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
    const distributedRuns = [
        createTuneDistributedRun('left'),
        rightDistributedRun,
    ];
    let artifactReads = 0;
    let mutationRequests = 0;
    let reachability = options.initialReachability ?? 'live';

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
            await fulfillJson(route, { runs: controlRuns });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            await fulfillJson(route, { distributedRuns });
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
        setReachability: value => {
            reachability = value;
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
