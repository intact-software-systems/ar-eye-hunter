import { expect, type BrowserContext } from '@playwright/test';

import { openTab } from './full-stack-helpers.ts';
import type { LiveRtcControlClient } from './live-rtc-control-client.ts';
import { installLiveRtcWireObservation } from './live-rtc-wire-observation.ts';

export interface LiveRtcBrowserAgentConfig {
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

        await page.goto(`${input.config.spaBaseUrl}/?${query.toString()}`);

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
            connection: input.connection
        };
    }
    catch (error) {
        await context.close().catch(() => undefined);
        throw error;
    }
}

export async function closeLiveRtcBrowserAgentContexts(
    agents: readonly LiveRtcControlClient.Agent[]
): Promise<void> {
    await Promise.all(
        agents.map((agent) => agent.context.close().catch(() => undefined))
    );
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
