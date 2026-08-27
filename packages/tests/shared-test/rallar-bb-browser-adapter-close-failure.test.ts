// @vitest-environment happy-dom

import { expect, it } from 'vitest';
import { createRallarBlackBoxBrowserTestRuntime } from '../../shared-test/rallar-bb-test/browser-adapter.ts';

const REPOSITORY_ERROR_MESSAGE = 'Repository not found: shared.repository.group-state-snapshots';

function createRuntimeWithFailingClose(): ReturnType<typeof createRallarBlackBoxBrowserTestRuntime> {
    return createRallarBlackBoxBrowserTestRuntime({
        rallarRuntime: {
            authenticate: async () => ({ status: 'authenticated' }),
            connect: async () => ({ status: 'connected' }),
            send: async () => ({ sent: true }),
            refreshRoom: async () => undefined,
            close: async () => {
                throw new Error(REPOSITORY_ERROR_MESSAGE);
            },
            health: async () => ({ connected: true })
        }
    });
}

it('names the failing resource and keeps its cause when a reset cannot close', async () => {
    // The agent runs in a browser, so this throw is the only record of the
    // failure that reaches the fleet artifact.
    const runtime = createRuntimeWithFailingClose();

    const result = await runtime.execute({
        kind: 'reset',
        commandId: 'reset-control-1'
    });

    expect(result.status).toBe('failed');
    expect(result.error?.message).toContain('rallar');
    expect(result.error?.message).toContain(REPOSITORY_ERROR_MESSAGE);
});
