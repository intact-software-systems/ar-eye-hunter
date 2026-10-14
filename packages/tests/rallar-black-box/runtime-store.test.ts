// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserTestStorage } from '../shared-test/browser-test-storage.ts';

/** Only construction and disposal are exercised: this socket never opens or sends. */
class BootstrapControlSocket extends EventTarget {
    readonly url: string;
    readyState = 0;
    constructor(url: string) {
        super();
        this.url = url;
    }
    close(): void {
        this.readyState = 3;
    }
    send(): void {
        throw new Error('The bootstrap fixture never sends.');
    }
}

beforeEach(() => {
    vi.stubGlobal('localStorage', createBrowserTestStorage());
    vi.stubGlobal('sessionStorage', createBrowserTestStorage());
});
afterEach(() => vi.unstubAllGlobals());

describe('rallar-black-box runtime store', () => {
    it('refuses commands under a configuration whose provider mode names no provider instead of simulating them', async () => {
        // The store reads its launch once, when the module loads; the URL provider outranks a local Vite environment.
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        expect(rallarBlackBoxRuntimeStore.getSnapshot().bootstrap.providerMode).toBe('simulated');

        await rallarBlackBoxRuntimeStore.runManualCommands([
            {
                kind: 'configure',
                commandId: 'configure-typo',
                config: {
                    runId: 'run-typo',
                    agentId: 'agent-typo',
                    control: { providerMode: 'browser-rallr' }
                }
            },
            {
                kind: 'ws.open',
                commandId: 'open-typo',
                connection: 'aliceWs',
                url: 'wss://ws.example.test/socket',
                metadata: { localDelayMs: 0 }
            }
        ], 'Run a configuration with a mistyped provider mode');

        const { state } = rallarBlackBoxRuntimeStore.getSnapshot();
        const open = state.commandHistory.find((result) => result.commandId === 'open-typo');
        expect(open).toMatchObject({
            ok: false,
            error: {
                code: 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID',
                message: 'control.providerMode must be one of simulated, browser-rallar, not \'browser-rallr\'.'
            }
        });
        expect(state.events.map((event) => event.topic)).toContain('rallar.bb.provider.browser_rallar.config_invalid');
    });

    it('publishes bootstrap setup and accepted configuration before optional control connection', async () => {
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        const originalBootstrap = store.getSnapshot().bootstrap;
        const socketConstructor = vi.fn(function (url: string) {
            return new BootstrapControlSocket(url);
        });
        vi.stubGlobal('WebSocket', socketConstructor);
        const actions: (string | undefined)[] = [];
        const unsubscribe = store.subscribe(() => actions.push(store.getSnapshot().lastAction));
        try {
            for (const autoConnect of [false, true]) {
                store.updateBootstrapConfig({
                    providerMode: 'simulated',
                    issues: [],
                    autoConnect,
                    controlUrl: 'ws://bootstrap.test/control',
                    runId: 'run-bootstrap',
                    agentId: 'agent-bootstrap'
                });
                actions.length = 0;
                await store.bootstrapControlAgent();
                expect(store.getSnapshot()).toMatchObject({ bootstrapping: false, busy: false, runState: 'waiting', lastError: undefined });
                expect(store.getSnapshot().state.commandHistory.map((result) => result.kind)).toEqual(['reset', 'configure']);
                expect(store.getSnapshot().state.currentConfig).toMatchObject({
                    runId: 'run-bootstrap',
                    agentId: 'agent-bootstrap',
                    control: { providerMode: 'simulated', autoConnect }
                });
                expect(actions).toContain('Bootstrapping remote control agent');
                expect(actions).toContain(autoConnect ? 'Remote control agent configured; connecting' : 'Remote control agent configured');
                if (autoConnect) {
                    expect(socketConstructor).toHaveBeenCalledExactlyOnceWith('ws://bootstrap.test/control');
                    expect(store.getSnapshot().control).toMatchObject({ state: 'connecting', runId: 'run-bootstrap', agentId: 'agent-bootstrap' });
                }
                else {
                    expect(socketConstructor).not.toHaveBeenCalled();
                }
            }
        }
        finally {
            unsubscribe();
            store.disconnectControl();
            store.updateBootstrapConfig(originalBootstrap);
        }
    });

    it('contains launch and provider refusal before creating a control socket', async () => {
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
        const originalBootstrap = store.getSnapshot().bootstrap;
        const socketConstructor = vi.fn(function (url: string) {
            return new BootstrapControlSocket(url);
        });
        vi.stubGlobal('WebSocket', socketConstructor);
        try {
            store.updateBootstrapConfig({ issues: [{ launchKey: 'provider', message: 'Unknown launch provider.' }], autoConnect: true });
            const before = store.getSnapshot().state.commandHistory.length;
            await store.bootstrapControlAgent();
            expect(store.getSnapshot()).toMatchObject({
                bootstrapping: false,
                busy: false,
                runState: 'failed',
                lastAction: 'Remote control bootstrap failed',
                lastError: 'The agent launch cannot be read: Unknown launch provider.'
            });
            expect(store.getSnapshot().state.commandHistory).toHaveLength(before);
            store.updateBootstrapConfig({
                issues: [],
                providerMode: 'browser-rallar',
                apiBaseUrl: 'https://bootstrap.example.test',
                rallarUsername: undefined,
                rallarPassword: undefined,
                rallarRestoreSession: false
            });
            await store.bootstrapControlAgent();
            expect(store.getSnapshot()).toMatchObject({
                bootstrapping: false,
                busy: false,
                runState: 'failed',
                lastAction: 'Remote control bootstrap failed',
                lastError: 'browser-rallar provider requires rallar username/password or restoreSession=true.'
            });
            expect(store.getSnapshot().state.commandHistory.map((result) => result.kind)).toEqual(['reset', 'configure']);
            expect(store.getSnapshot().state.events.map((event) => event.topic)).toContain('rallar.bb.provider.browser_rallar.config_invalid');
            expect(socketConstructor).not.toHaveBeenCalled();
        }
        finally {
            store.disconnectControl();
            store.updateBootstrapConfig(originalBootstrap);
        }
    });
});
