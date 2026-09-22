// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

describe('rallar-black-box runtime store expected failures', () => {
    it('reports a local HTTP command with no url or path as a failed result instead of throwing', async () => {
        // The store reads its launch once, when the module loads; the URL provider outranks a local Vite environment.
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');

        await rallarBlackBoxRuntimeStore.runManualCommands([
            {
                kind: 'configure',
                commandId: 'configure-http-addressless',
                config: {
                    runId: 'run-http-addressless',
                    agentId: 'agent-http-addressless',
                    control: { providerMode: 'simulated' }
                }
            },
            {
                kind: 'http.request',
                commandId: 'http-addressless',
                request: { method: 'GET' },
                metadata: { localDelayMs: 0 }
            }
        ], 'Run a local HTTP command that addresses nothing');

        const { state } = rallarBlackBoxRuntimeStore.getSnapshot();
        const request = state.commandHistory.find((result) => result.commandId === 'http-addressless');

        expect(request).toMatchObject({
            ok: false,
            error: {
                code: 'RALLAR_BLACK_BOX_COMMAND_FAILED',
                message: 'Local HTTP command requires request.url or request.path.'
            }
        });
    });

    it('reports invalid recipe and command JSON as a value that names the decode failure', async () => {
        window.history.replaceState({}, '', '/?provider=simulated');
        const { rallarBlackBoxRuntimeStore } = await import('../../../apps/rallar-black-box/src/runtime-store.ts');

        const loaded = await rallarBlackBoxRuntimeStore.loadRecipeFromJson('{ not json', 'fixture-invalid');

        expect(loaded.right).toBeUndefined();
        expect(loaded.left).toBeTypeOf('string');
        expect(rallarBlackBoxRuntimeStore.getSnapshot()).toMatchObject({
            runState: 'failed',
            lastAction: 'Recipe JSON is invalid',
            lastError: loaded.left
        });
        // The failed load must not leave a fixture selected as if it had been applied.
        expect(rallarBlackBoxRuntimeStore.getSnapshot().loadedFixtureId).not.toBe('fixture-invalid');

        const ran = await rallarBlackBoxRuntimeStore.runCommandFromJsonText('{ not json');

        expect(ran.right).toBeUndefined();
        expect(ran.left).toBeTypeOf('string');
        expect(rallarBlackBoxRuntimeStore.getSnapshot()).toMatchObject({
            runState: 'failed',
            lastAction: 'Command JSON is invalid',
            lastError: ran.left
        });
    });
});
