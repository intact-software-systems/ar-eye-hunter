import { describe, expect, it } from 'vitest';

import { executeRallarRemoteBrowserCommand } from '../../shared-test/black-box-runner/rallar-remote-browser-provider.ts';

describe('remote-browser command results', () => {
    it('matches the run and agent as well as the command identity', async () => {
        const expected = {
            kind: 'result',
            runId: 'this-run',
            agentId: 'this-agent',
            commandId: 'same-command',
            ok: true
        };
        const result = await executeRallarRemoteBrowserCommand({
            remote: {
                controlBaseUrl: 'http://control.invalid',
                runId: 'this-run',
                agentId: 'this-agent',
                timeoutMs: 100,
                pollIntervalMs: 1
            },
            command: { kind: 'health', commandId: 'same-command' },
            context: {},
            fetchFn: async (_input, init) =>
                init?.method === 'POST'
                    ? Response.json({ accepted: true }, { status: 202 })
                    : Response.json({
                        runId: 'this-run',
                        results: [
                            { ...expected, runId: 'another-run', ok: false },
                            { ...expected, agentId: 'another-agent', ok: false },
                            expected
                        ],
                        events: []
                    })
        });

        expect(result).toEqual(expected);
    });
});
