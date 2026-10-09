// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createSpaBrowserRallarRuntime } from '../../shared-test/rallar-bb-test/browser-rallar-runtime-bridge.ts';
import type { RallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import { createAlmScaleSetupCommands } from '../../shared-test/rallar-bb-test/conformance/alm/scale/create-alm-scale-setup-commands.ts';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { facade, loadRuntime, resetFacade } from './rallar-browser-runtime/browser-rallar-runtime-test-harness.ts';

const GROUP = { applicationId: 'scale-app', workspaceId: 'scale-workspace', groupId: 'scale-room' };

beforeEach(() => {
    resetFacade();
    const values = new Map<string, string>();
    vi.stubGlobal(
        'localStorage',
        {
            get length() {
                return values.size;
            },
            clear: () => values.clear(),
            getItem: (key) => values.get(key) ?? null,
            key: (index) => [...values.keys()][index] ?? null,
            removeItem: (key) => {
                values.delete(key);
            },
            setItem: (key, value) => {
                values.set(key, value);
            }
        } satisfies Storage
    );
});

afterEach(() => {
    localStorage.clear();
    Reflect.deleteProperty(window, '__blackBoxRallar');
    vi.unstubAllGlobals();
});

async function createAuthenticatedWorkerBrowser(): Promise<RallarBlackBoxBrowserTestRuntime> {
    const pageRuntime = await loadRuntime();
    Object.assign(window, { __blackBoxRallar: pageRuntime });
    facade.behavior.login.mockImplementation(async () => {
        localStorage.setItem('auth.session', JSON.stringify(facade.session));
        return facade.session;
    });
    facade.behavior.rtcWaitForRoom.mockImplementation(async () => {
        const status = facade.behavior.rtcRoomStatus(GROUP);
        return {
            ...status,
            rtc: {
                ...status.rtc,
                state: 'open',
                readyPeerIds: ['other-session'],
                acceptedLayoutIdentity: { groupRevision: 1, presenceRevision: 1, version: 1, state: 'active' }
            }
        };
    });
    return createRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: createSpaBrowserRallarRuntime(),
        fetch: async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    });
}

it.each(['director', 'player'] as const)('restores the authenticated %s worker identity through the browser connect boundary', async (role) => {
    const browser = await createAuthenticatedWorkerBrowser();
    await browser.execute({
        kind: 'configure',
        config: {
            apiBaseUrl: 'https://api.example.test',
            sessionId: facade.session.sessionId,
            rallar: { username: facade.session.username, password: 'fixture-password' }
        }
    });
    // The first group API command authenticates the worker before the recipe connects RTC.
    const bootstrapped = await browser.execute({
        kind: 'http.request',
        request: { method: 'GET', path: '/api/state/apps/scale-app/workspaces/scale-workspace/groups/scale-room' },
        response: { body: 'json', acceptedStatusCodes: [200] }
    });
    expect(bootstrapped.ok).toBe(true);
    expect(facade.records.loginAttempts).toHaveLength(1);
    facade.behavior.restore.mockReturnValue(facade.session);

    const commands = createAlmScaleSetupCommands({ participantCount: 15, group: GROUP, readyTimeoutMs: 45_000 }, role);
    const connect = commands.find((command) => command.kind === 'rtc.connect');
    if (connect?.kind !== 'rtc.connect') {
        throw new Error('The scale setup has no connect command.');
    }
    const connected = await browser.execute(connect);

    expect(connected.error).toBeUndefined();
    expect(connected).toMatchObject({
        ok: true,
        value: { sessionId: facade.session.sessionId, username: facade.session.username, actor: facade.session.clientId }
    });
    expect(facade.records.loginAttempts).toHaveLength(1);
    expect(facade.records.registrationAttempts).toHaveLength(0);
    expect(facade.records.restoreCount).toBeGreaterThan(0);
    expect(facade.records.connectionAttempts).toHaveLength(1);
    expect(facade.records.configurationWrites.every((config) => config.apiBaseUrl === 'https://api.example.test')).toBe(true);
    expect(facade.records.roomJoins).toEqual([
        [GROUP.groupId, { timeoutMs: undefined, scope: { applicationId: GROUP.applicationId, workspaceId: GROUP.workspaceId } }]
    ]);
    await browser.execute({ kind: 'close' });
});
