import type { BrowserContext, Route } from '@playwright/test';
import type { ControlDistributedRunArtifactBundle } from '../../../packages/shared-test/rallar-bb-test/control-snapshots.ts';
import { createAnalyzeArtifactEnvelope } from './recipe-console-analyze-artifacts.ts';
import {
    createAnalyzeControlRun,
    createAnalyzeDistributedRun,
} from './recipe-console-analyze-run-data.ts';

const CONTROL_ROUTE = /https?:\/\/(?:localhost|127\.0\.0\.1):5180\/.*/;

export type RecipeConsoleAnalyzeFixture = Readonly<{
    artifact: ControlDistributedRunArtifactBundle;
    artifactRequestCount(): number;
    runRequestCount(): number;
    distributedRunRequestCount(): number;
    setArtifactResponse(artifact: ControlDistributedRunArtifactBundle): void;
    failNextArtifactResponse(status: number, body: unknown): void;
    deferNextArtifactResponse(): void;
    waitForDeferredArtifactRequest(): Promise<void>;
    releaseDeferredArtifactResponse(): void;
}>;

export async function installRecipeConsoleAnalyzeFixture(
    context: BrowserContext,
): Promise<RecipeConsoleAnalyzeFixture> {
    const controlRun = createAnalyzeControlRun();
    const distributedRun = createAnalyzeDistributedRun();
    const artifact = createAnalyzeArtifactEnvelope();
    let artifactResponse = artifact;
    let artifactReads = 0;
    let runReads = 0;
    let distributedRunReads = 0;
    let nextArtifactFailure: Readonly<{
        status: number;
        body: unknown;
    }> | undefined;
    let deferArtifactResponse = false;
    let markDeferredArtifactStarted = (): void => {};
    let releaseDeferredArtifact = (): void => {};
    const deferredArtifactStarted = new Promise<void>((resolve) => {
        markDeferredArtifactStarted = resolve;
    });
    const deferredArtifactGate = new Promise<void>((resolve) => {
        releaseDeferredArtifact = resolve;
    });

    await context.route(CONTROL_ROUTE, async route => {
        const request = route.request();
        const url = new URL(request.url());
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: corsHeaders() });
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/runs') {
            runReads += 1;
            await fulfillJson(route, { runs: [controlRun] });
            return;
        }
        if (
            request.method() === 'GET' &&
            url.pathname === `/runs/${controlRun.runId}`
        ) {
            await fulfillJson(route, controlRun);
            return;
        }
        if (request.method() === 'GET' && url.pathname === '/distributed-runs') {
            distributedRunReads += 1;
            await fulfillJson(route, { distributedRuns: [distributedRun] });
            return;
        }
        if (
            request.method() === 'GET' &&
            /^\/distributed-runs\/[^/]+\/artifacts$/.test(url.pathname)
        ) {
            artifactReads += 1;
            const failure = nextArtifactFailure;
            nextArtifactFailure = undefined;
            if (deferArtifactResponse) {
                deferArtifactResponse = false;
                markDeferredArtifactStarted();
                await deferredArtifactGate;
            }
            if (failure) {
                await fulfillJson(route, failure.body, failure.status);
                return;
            }
            await fulfillJson(route, artifactResponse);
            return;
        }
        await fulfillJson(route, {
            error: `Unhandled ${request.method()} ${url.pathname}`,
        }, 404);
    });

    return {
        artifact,
        artifactRequestCount: () => artifactReads,
        runRequestCount: () => runReads,
        distributedRunRequestCount: () => distributedRunReads,
        setArtifactResponse: next => { artifactResponse = next; },
        failNextArtifactResponse: (status, body) => {
            nextArtifactFailure = { status, body };
        },
        deferNextArtifactResponse: () => { deferArtifactResponse = true; },
        waitForDeferredArtifactRequest: () => deferredArtifactStarted,
        releaseDeferredArtifactResponse: releaseDeferredArtifact,
    };
}

async function fulfillJson(
    route: Route,
    body: unknown,
    status = 200,
): Promise<void> {
    await route.fulfill({
        status,
        contentType: 'application/json',
        headers: corsHeaders(),
        body: JSON.stringify(body),
    });
}

function corsHeaders(): Record<string, string> {
    return {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
}
