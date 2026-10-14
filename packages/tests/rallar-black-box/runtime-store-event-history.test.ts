// @vitest-environment happy-dom
import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { resolveRallarBlackBoxBootstrapConfig } from '../../shared-test/rallar-bb-test/browser-control-agent-config.ts';
import { toRemoteControlConfig } from '../../shared-test/rallar-bb-test/browser-control-agent/to-remote-control-config.ts';
import { parseControlClientMessage } from '../../shared-test/rallar-bb-test/control-protocol.ts';
import { createBrowserTestStorage } from '../shared-test/browser-test-storage.ts';
import { SimulatedWebSocket } from '../shared/native-websocket-fixture.ts';

afterEach(() => vi.unstubAllGlobals());

it('applies changed SPA bootstrap history through explicit local Configure', async () => {
    vi.stubGlobal('localStorage', createBrowserTestStorage());
    vi.stubGlobal('sessionStorage', createBrowserTestStorage());
    window.history.replaceState({}, '', '/?provider=simulated&eventHistory=recent&eventHistoryMaxEvents=2');
    const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
    expect(store.getSnapshot().state.eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 2 });
    store.updateBootstrapConfig({ eventHistory: { mode: 'recent', maxEvents: 5 } });
    await store.configureLocalWorkbenchOnly();
    expect(store.getSnapshot().state.eventHistory.policy).toEqual({ mode: 'recent', maxEvents: 5 });
    expect(store.getSnapshot().state.currentConfig?.eventHistory).toEqual({ mode: 'recent', maxEvents: 5 });
});

it('carries remote bootstrap defaults into the actual Configure command', () => {
    const bootstrap = resolveRallarBlackBoxBootstrapConfig('?eventHistory=recent&eventHistoryMaxEvents=7', {}, '');
    expect(toRemoteControlConfig({ bootstrap, hasStoredAuthSession: false }).eventHistory).toEqual({ mode: 'recent', maxEvents: 7 });
});

it('refuses malformed programmatic bootstrap selection instead of publishing configured status', async () => {
    const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
    const generation = store.getSnapshot().state.eventHistory.generation;
    store.updateBootstrapConfig({ eventHistory: { mode: 'recent', maxEvents: 0 }, issues: [] });
    await store.configureLocalWorkbenchOnly();
    expect(store.getSnapshot().state.eventHistory.generation).toBe(generation);
    expect(store.getSnapshot().runState).toBe('failed');
});

it('restores the owned selection into the actual SPA control client without replacing its configured default', async () => {
    vi.stubGlobal('sessionStorage', createBrowserTestStorage());
    vi.stubGlobal('localStorage', createBrowserTestStorage());
    vi.stubGlobal('WebSocket', SimulatedWebSocket);
    const { rallarBlackBoxRuntimeStore: store } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');
    store.updateBootstrapConfig({
        eventHistory: { mode: 'full' },
        issues: [],
        providerMode: 'simulated',
        autoConnect: true,
        runId: 'spa-resume',
        agentId: 'spa-agent',
        controlUrl: 'ws://owned-spa.test/control'
    });
    sessionStorage.setItem(
        'rallar-bb-agent-resume',
        JSON.stringify({
            runId: 'spa-resume',
            agentId: 'spa-agent',
            completedCommandIds: ['prefix'],
            recipeExecutions: { 'spa-owned': { commandId: 'prefix', selection: { policy: { mode: 'recent', maxEvents: 2 }, runOverride: false } } }
        })
    );
    try {
        await store.bootstrapControlAgent();
        const socket = SimulatedWebSocket.instances.at(-1)!;
        await socket.open();
        await socket.receive(
            JSON.stringify({
                kind: 'command',
                protocolVersion: 1,
                runId: 'spa-resume',
                agentId: 'spa-agent',
                commandId: 'suffix',
                recipeExecution: { rootCommandId: 'spa-owned', first: false, last: true, segment: { start: 2, end: 3, first: false } },
                command: {
                    kind: 'recipe.run',
                    recipe: {
                        schemaVersion: 1,
                        recipeId: 'suffix',
                        commands: [{ kind: 'health', commandId: 'prefix-health' }, { kind: 'agent.reload', readyTimeoutMs: 30_000 }, {
                            kind: 'health',
                            commandId: 'suffix-health'
                        }]
                    }
                }
            })
        );
        const results = () =>
            socket.sent.flatMap((wire) => {
                const parsed = parseControlClientMessage(wire);
                return parsed.ok && parsed.envelope.kind === 'result' && parsed.envelope.commandId === 'suffix' ? [parsed.envelope] : [];
            });
        await vi.waitFor(() => expect(results()).toHaveLength(1));
        expect(results()[0].result?.value).toMatchObject({ invocation: { eventHistory: { mode: 'recent', maxEvents: 2 } } });
        expect(store.getSnapshot().state.currentConfig?.eventHistory).toEqual({ mode: 'full' });
        expect(
            socket.sent.map((wire) => parseControlClientMessage(wire)).some((parsed) =>
                parsed.ok && parsed.envelope.kind === 'result' && parsed.envelope.commandId === 'suffix'
            )
        ).toBe(true);
    }
    finally {
        store.disconnectControl();
    }
});
