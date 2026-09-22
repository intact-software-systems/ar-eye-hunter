// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

describe('rallar-black-box runtime store manual command metadata', () => {
    it('reads the operator expected clients a command carries and falls back to its session when none are listed', async () => {
        // The store reads its launch once, when the module loads; the URL provider outranks a local Vite environment.
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');

        await rallarBlackBoxRuntimeStore.runManualCommands([
            {
                kind: 'configure',
                commandId: 'configure-manual',
                config: {
                    runId: 'run-manual',
                    agentId: 'agent-manual',
                    control: { providerMode: 'simulated' }
                }
            },
            {
                kind: 'rtc.connect',
                commandId: 'connect-manual',
                roomId: 'room-manual',
                metadata: {
                    localDelayMs: 0,
                    manual: { expectedClients: ['peer-a', 'peer-b'] }
                }
            },
            {
                kind: 'rtc.connect',
                commandId: 'connect-listless',
                roomId: 'room-manual',
                rallar: { sessionId: 'session-manual' },
                metadata: {
                    localDelayMs: 0,
                    manual: ['peer-a']
                }
            }
        ], 'Run two simulated connects with manual metadata');

        const { state } = rallarBlackBoxRuntimeStore.getSnapshot();
        const listed = state.commandHistory.find((result) => result.commandId === 'connect-manual');
        const listless = state.commandHistory.find((result) => result.commandId === 'connect-listless');

        expect(listed).toMatchObject({
            ok: true,
            value: { expectedClients: ['peer-a', 'peer-b'], observedClients: ['peer-a', 'peer-b'] }
        });
        expect(listless).toMatchObject({
            ok: true,
            value: { sessionId: 'session-manual', expectedClients: ['session-manual'] }
        });
    });
});
