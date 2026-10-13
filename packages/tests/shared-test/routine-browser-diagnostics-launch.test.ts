// @vitest-environment happy-dom
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { resolveRallarBlackBoxBootstrapConfig } from '@shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { createDefaultRallarBlackBoxBrowserControlAgent } from '@shared-test/rallar-bb-test/browser-control-agent.ts';
import * as controlClient from '@shared-test/rallar-bb-test/control-client.ts';
import type { RallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';

import { createBrowserTestStorage } from './browser-test-storage.ts';

beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('localStorage', createBrowserTestStorage());
    vi.stubGlobal('sessionStorage', createBrowserTestStorage());
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('fresh browser recording selection', () => {
    it.each([
        { query: '', mode: 'enabled' },
        { query: '&routineBrowserDiagnostics=enabled', mode: 'enabled' },
        { query: '&routineBrowserDiagnostics=disabled', mode: 'disabled' }
    ])('applies $mode to the actual shared default adapter', async ({ query, mode }) => {
        let runtime: RallarBlackBoxTestRuntime | undefined;
        const createControlClient = controlClient.createDefaultRallarBlackBoxControlClient;
        vi.spyOn(controlClient, 'createDefaultRallarBlackBoxControlClient').mockImplementation((input) => {
            runtime = input.runtime;
            return createControlClient(input);
        });
        const agent = createDefaultRallarBlackBoxBrowserControlAgent({
            search: `?provider=browser-rallar&autoConnect=0${query}`,
            env: {},
            hash: ''
        });
        try {
            if (!runtime) {
                throw new Error('The control client must receive the constructed runtime.');
            }
            const health = await runtime.execute({ kind: 'health', commandId: 'shared-health' });
            expect(health).toMatchObject({
                ok: true,
                value: {
                    browserDiagnostics: {
                        routineBrowserDiagnostics: mode,
                        omittedRoutineBrowserDiagnostics: 0,
                        forwardedBrowserDiagnostics: expect.any(Number)
                    }
                }
            });
        }
        finally {
            agent.dispose();
        }
    });

    it.each([
        { query: '', mode: 'enabled' },
        { query: '&routineBrowserDiagnostics=enabled', mode: 'enabled' },
        { query: '&routineBrowserDiagnostics=disabled', mode: 'disabled' }
    ])('applies $mode to the actual operator SPA adapter', async ({ query, mode }) => {
        window.history.replaceState({}, '', `/?provider=browser-rallar&autoConnect=0${query}`);
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        await store.runManualCommands([{ kind: 'health', commandId: 'operator-health' }], 'Read applied recording mode');
        expect(store.getSnapshot().state.commandHistory).toContainEqual(expect.objectContaining({
            commandId: 'operator-health',
            ok: true,
            value: expect.objectContaining({
                browserDiagnostics: { routineBrowserDiagnostics: mode, omittedRoutineBrowserDiagnostics: 0, forwardedBrowserDiagnostics: expect.any(Number) }
            })
        }));
        store.disconnectControl();
    });

    it.each([
        { query: '&routineBrowserDiagnostics=off', env: {} },
        { query: '', env: { VITE_RALLAR_ROUTINE_BROWSER_DIAGNOSTICS: 'DISABLED' } }
    ])('refuses malformed shared launch $query before configuration or connection', async ({ query, env }) => {
        const agent = createDefaultRallarBlackBoxBrowserControlAgent({ search: `?mode=control&provider=browser-rallar&autoConnect=1${query}`, env, hash: '' });
        try {
            expect((await agent.start()).left).toMatch(/must be one of enabled, disabled/);
            expect(agent.getSnapshot()).toMatchObject({ control: { state: 'idle' }, state: { commandHistory: [] } });
        }
        finally {
            agent.dispose();
        }
    });
    it('refuses malformed operator launch before configuration or control connection', async () => {
        window.history.replaceState({}, '', '/?mode=control&provider=browser-rallar&autoConnect=1&routineBrowserDiagnostics=off');
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        await store.bootstrapControlAgent();
        expect(store.getSnapshot()).toMatchObject({
            control: { state: 'idle' },
            state: { commandHistory: [] },
            runState: 'failed',
            lastError: expect.stringContaining('routineBrowserDiagnostics')
        });
        store.disconnectControl();
    });
    it('preserves launch recording selection across operator bootstrap updates', async () => {
        window.history.replaceState({}, '', '/?provider=browser-rallar&routineBrowserDiagnostics=disabled');
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        store.updateBootstrapConfig(resolveRallarBlackBoxBootstrapConfig('?provider=browser-rallar&routineBrowserDiagnostics=enabled', {}, ''));
        expect(store.getSnapshot().bootstrap).toHaveProperty('routineBrowserDiagnostics', 'disabled');
        await store.runManualCommands([{ kind: 'health', commandId: 'immutable-health' }], 'Read immutable selection');
        expect(store.getSnapshot().state.commandHistory).toContainEqual(expect.objectContaining({
            commandId: 'immutable-health',
            ok: true,
            value: expect.objectContaining({ browserDiagnostics: expect.objectContaining({ routineBrowserDiagnostics: 'disabled' }) })
        }));
        store.disconnectControl();
    });
    it('refuses malformed recording selection through normal local browser bootstrap before Configure', async () => {
        window.history.replaceState(
            {},
            '',
            '/?provider=browser-rallar&autoConnect=0&apiBaseUrl=https%3A%2F%2Ffixture.test&rallarUsername=fixture-user&rallarPassword=fixture-password&routineBrowserDiagnostics=off'
        );
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        expect(store.getSnapshot().bootstrap).toMatchObject({
            mode: 'local-workbench',
            issues: [{ launchKey: 'routineBrowserDiagnostics', message: expect.any(String) }]
        });
        store.startBootstrapOnce();
        await vi.waitFor(() => expect(store.getSnapshot().bootstrapping).toBe(false));
        expect(store.getSnapshot()).toMatchObject({
            control: { state: 'idle' },
            state: { commandHistory: [] },
            runState: 'failed',
            lastError: expect.stringContaining('routineBrowserDiagnostics')
        });
        store.disconnectControl();
    });

    it('refuses invalid launch defaults before the local reset/configure flow', async () => {
        window.history.replaceState(
            {},
            '',
            '/?provider=browser-rallar&autoConnect=0&apiBaseUrl=https%3A%2F%2Ffixture.test&rallarUsername=fixture-user&rallarPassword=fixture-password&routineBrowserDiagnostics=off'
        );
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        await store.resetWorkbench();
        expect(store.getSnapshot()).toMatchObject({
            control: { state: 'idle' },
            state: { commandHistory: [] },
            runState: 'failed',
            lastError: expect.stringContaining('routineBrowserDiagnostics')
        });
        store.disconnectControl();
    });

    it('still configures valid local browser launches through normal bootstrap', async () => {
        window.history.replaceState(
            {},
            '',
            '/?provider=browser-rallar&autoConnect=0&apiBaseUrl=https%3A%2F%2Ffixture.test&rallarUsername=fixture-user&rallarPassword=fixture-password&routineBrowserDiagnostics=disabled'
        );
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        store.startBootstrapOnce();
        await vi.waitFor(() => expect(store.getSnapshot().bootstrapping).toBe(false));
        expect(store.getSnapshot()).toMatchObject({
            control: { state: 'idle' },
            runState: 'waiting',
            lastAction: 'Local browser-rallar workbench configured',
            lastError: undefined
        });
        expect(store.getSnapshot().state.commandHistory.map((result) => ({ kind: result.kind, ok: result.ok }))).toEqual([{ kind: 'configure', ok: true }]);
        store.disconnectControl();
    });
});
