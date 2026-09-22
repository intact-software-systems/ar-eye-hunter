// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

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
});
