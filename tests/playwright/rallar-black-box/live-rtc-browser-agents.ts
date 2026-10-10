import { expect, type BrowserContext, type Response } from '@playwright/test';
import { toError } from '@shared/resilience/to-error.ts';
import type { BlackBoxRallarRoomRefreshOptions } from '../../../packages/shared-test/black-box-runner/browser/rallar-browser-runtime/black-box-rallar-runtime-contract.ts';

import {
    toFullStackRtcBrowserEntry,
    writeFullStackRtcBrowserEntries
} from '../../../apps/rallar-black-box/rtc-production-serving-proof.ts';
import type {
    FullStackRtcBrowserEntry,
    FullStackRtcServedBuild
} from '../../../packages/shared-test/black-box-runner/fixtures/rtc-production/full-stack-rtc-production-proof.ts';

import { openTab } from './full-stack-helpers.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { installLiveRtcWireObservation } from './live-rtc-wire-observation.ts';

export interface LiveRtcBrowserAgentConfig {
    readonly productionBuild?: FullStackRtcServedBuild;
    readonly spaBaseUrl: string;
    readonly controlWsUrl: string;
    readonly apiBaseUrl: string;
    readonly register: boolean;
}

export interface LiveRtcRestoredSession {
    readonly clientId: string;
    readonly accessToken: string;
    readonly username: string;
    readonly sessionId: string;
    readonly expiresAtEpochMs: number;
}

export type LiveRtcBrowserAgentAuth =
    | Readonly<{
        kind: 'login';
        username: string;
        password: string;
    }>
    | Readonly<{
        kind: 'restore';
        session: LiveRtcRestoredSession;
    }>;

export interface OpenLiveRtcBrowserAgentInput {
    readonly config: LiveRtcBrowserAgentConfig;
    readonly prefix: LiveRtcControlClient.Agent['prefix'];
    readonly auth: LiveRtcBrowserAgentAuth;
    readonly runId: string;
    readonly agentId: string;
    readonly actor: string;
    readonly connection: string;
    readonly groupId: string;
}

export interface LiveRtcBrowserContextFactory {
    newContext(): Promise<Pick<BrowserContext, 'newPage' | 'close'>>;
}

export interface LiveRtcBrowserEntryPage {
    goto(url: string): Promise<unknown>;
    on(event: 'response', listener: (response: Pick<Response, 'url' | 'status' | 'body'>) => void): void;
    off(event: 'response', listener: (response: Pick<Response, 'url' | 'status' | 'body'>) => void): void;
}

export async function openLiveRtcBrowserAgent(
    browser: LiveRtcBrowserContextFactory,
    input: OpenLiveRtcBrowserAgentInput
): Promise<LiveRtcControlClient.Agent> {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.addInitScript(installLiveRtcWireObservation);

        if (input.auth.kind === 'restore') {
            await page.addInitScript((session) => {
                window.localStorage.setItem('auth.session', JSON.stringify(session));
            }, input.auth.session);
        }

        const query = toLiveRtcBrowserAgentQuery(input);

        await openLiveRtcBrowserEntry(page, input, query);

        if (input.auth.kind === 'login') {
            await expect(page.getByRole('heading', { name: 'Rallar Server Login' }))
                .toBeVisible();
            await page.getByRole('button', { name: 'Sign in' }).click();
        }

        await openTab(page, 'local-workbench', 'black-box-runner');
        await expect(page.locator('#panel-local-workbench .control-panel'))
            .toContainText('registered', { timeout: 30_000 });

        return {
            context,
            page,
            prefix: input.prefix,
            agentId: input.agentId,
            actor: input.actor,
            connection: input.connection,
            refreshRoom: async (options) =>
                await page.evaluate(refreshLiveRtcBrowserRoom, { timeoutMs: options.timeoutMs })
        };
    }
    catch (error) {
        try {
            await context.close();
        }
        catch (cleanupCause) {
            console.error('Failed to close browser context after startup failure', toError(cleanupCause));
        }
        throw toError(error);
    }
}

export async function openLiveRtcBrowserEntry(
    page: LiveRtcBrowserEntryPage,
    input: OpenLiveRtcBrowserAgentInput,
    query: URLSearchParams
): Promise<void> {
    const build = input.config.productionBuild;
    if (!build) {
        await page.goto(`${input.config.spaBaseUrl}/?${query.toString()}`);
        return;
    }
    const responses: Promise<FullStackRtcBrowserEntry>[] = [];
    const readResponse = (response: Pick<Response, 'url' | 'status' | 'body'>) => {
        const url = new URL(response.url());
        const path = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (url.origin === build.seal.spaOrigin && ['index.html', ...build.seal.entryFiles].includes(path)) {
            const entry = readLiveRtcBrowserEntry(build, input.prefix, response);
            void entry.catch(() => undefined);
            responses.push(entry);
        }
    };
    page.on('response', readResponse);
    try {
        await page.goto(`${input.config.spaBaseUrl}/?${query.toString()}`);
        const entries = await Promise.all(responses);
        if (!['index.html', ...build.seal.entryFiles].every((path) => entries.some((entry) => entry.path === path))) {
            throw new Error('Original browser entry response proof is incomplete.');
        }
        await writeFullStackRtcBrowserEntries(build, entries);
    }
    catch {
        throw new Error('Original production browser entry could not be verified.');
    }
    finally {
        page.off('response', readResponse);
        await Promise.allSettled(responses);
    }
}

async function readLiveRtcBrowserEntry(
    build: FullStackRtcServedBuild,
    prefix: LiveRtcControlClient.Agent['prefix'],
    response: Pick<Response, 'url' | 'status' | 'body'>
): Promise<FullStackRtcBrowserEntry> {
    const entry = toFullStackRtcBrowserEntry(build, {
        prefix,
        url: response.url(),
        status: response.status(),
        bytes: await response.body()
    });
    if (!entry.right) {
        throw new Error('Original browser response bytes did not match the production build.');
    }
    return entry.right;
}

/** Serialized in the owned browser page; imports are type-only at this boundary. */
export async function refreshLiveRtcBrowserRoom(options: BlackBoxRallarRoomRefreshOptions): Promise<void> {
    if (!('__blackBoxRallar' in window)) {
        throw new Error('RTC room refresh requires the browser Rallar runtime.');
    }
    const runtime = window.__blackBoxRallar;
    if (
        !runtime || typeof runtime !== 'object' || !('refreshRoom' in runtime) ||
        typeof runtime.refreshRoom !== 'function'
    ) {
        throw new Error('RTC room refresh requires the browser Rallar runtime.');
    }
    await runtime.refreshRoom(options);
}

export async function closeLiveRtcBrowserAgentContexts(
    agents: readonly Pick<LiveRtcControlClient.Agent, 'context'>[]
): Promise<readonly Error[]> {
    const results = await Promise.allSettled(agents.map(async (agent) => await agent.context.close()));
    const errors = results.flatMap((result) => result.status === 'rejected' ? [toError(result.reason)] : []);
    for (const error of errors) {
        console.error('Failed to close live RTC browser context', error);
    }
    return errors;
}

function toLiveRtcBrowserAgentQuery(input: OpenLiveRtcBrowserAgentInput): URLSearchParams {
    return new URLSearchParams({
        mode: 'control',
        provider: 'browser-rallar',
        autoConnect: '1',
        tab: 'local-workbench',
        controlUrl: input.config.controlWsUrl,
        runId: input.runId,
        agentId: input.agentId,
        apiBaseUrl: input.config.apiBaseUrl,
        roomId: input.groupId,
        actor: input.actor,
        sessionId: input.agentId,
        transport: 'realtime',
        statsIntervalMs: '2000',
        rallarLeaveRoomOnClose: '0',
        ...(input.config.register ? { rallarRegister: '1' } : {}),
        ...(input.auth.kind === 'restore' ? { rallarRestoreSession: '1' } : {}),
        ...(input.auth.kind === 'login'
            ? {
                rallarUsername: input.auth.username,
                rallarPassword: input.auth.password
            }
            : {})
    });
}
