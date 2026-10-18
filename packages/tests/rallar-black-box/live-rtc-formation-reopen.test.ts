import { afterEach, expect, it, vi } from 'vitest';

import { openLiveRtcBrowserAgent, type OpenLiveRtcBrowserAgentInput } from '../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts';
import { createLiveRtcFormationOperations } from '../../../tests/playwright/rallar-black-box/live-rtc-formation-operations.ts';

const acquisition = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts', async (importOriginal) => ({
    ...await importOriginal<typeof import('../../../tests/playwright/rallar-black-box/live-rtc-browser-agents.ts')>(),
    openLiveRtcBrowserAgent: acquisition.open
}));

afterEach(() => vi.resetAllMocks());

it.each([false, true])('preserves session restoration failure when cleanup fails=%s', async (cleanupFails) => {
    const primary = new Error('restored session unavailable');
    const cleanup = new Error('reopened context close failed');
    const effects: string[] = [];
    const session = {
        clientId: 'client',
        accessToken: 'unit-fixture-token',
        username: 'alice',
        sessionId: 'original-session',
        expiresAtEpochMs: 10_000
    };
    const agentFields = {
        prefix: 'A',
        agentId: 'A',
        actor: 'alice',
        connection: 'connection-A',
        eventHistory: { mode: 'full' },
        refreshRoom: async () => {}
    };
    acquisition.open.mockResolvedValueOnce({
        ...agentFields,
        context: {
            close: async () => {
                effects.push('original context closed');
            }
        },
        page: { evaluate: async () => JSON.stringify(session) }
    }).mockResolvedValueOnce({
        ...agentFields,
        context: {
            close: async () => {
                effects.push('reopened context close attempted');
                if (cleanupFails) {
                    throw cleanup;
                }
            }
        },
        page: {
            evaluate: async () => {
                throw primary;
            }
        }
    });
    const browser = {
        newContext: async () => {
            throw new Error('Live browser allocation is forbidden');
        }
    };
    const browserInput: OpenLiveRtcBrowserAgentInput = {
        config: { spaBaseUrl: 'http://fixture', apiBaseUrl: 'http://fixture', controlWsUrl: 'ws://fixture', register: false },
        prefix: 'A',
        auth: { kind: 'restore', session },
        runId: 'run',
        agentId: 'A',
        actor: 'alice',
        connection: 'connection-A',
        groupId: 'room'
    };
    const original = await openLiveRtcBrowserAgent(browser, browserInput);
    const failure = await createLiveRtcFormationOperations().reopen({
        runId: 'run',
        agent: original,
        roomRef: { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' },
        suffix: 'reopen',
        browser,
        config: browserInput.config,
        transport: 'realtime'
    }).catch((reason: Error) => reason);

    expect(effects).toEqual(['original context closed', 'reopened context close attempted']);
    if (cleanupFails) {
        expect(failure).toBeInstanceOf(AggregateError);
        if (failure instanceof AggregateError) {
            expect(failure.cause).toBe(primary);
            expect(failure.errors).toEqual([primary, cleanup]);
        }
    }
    else {
        expect(failure).toBe(primary);
    }
});
