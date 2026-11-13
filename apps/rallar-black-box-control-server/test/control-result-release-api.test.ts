import { expect, test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';

import { createDefaultRallarBlackBoxControlClient } from '@shared-test/rallar-bb-test/control-client.ts';
import { releaseControlResults } from '@shared-test/rallar-bb-test/result-release/release-control-results.ts';
import { createDefaultRallarBlackBoxTestRuntime } from '@shared-test/rallar-bb-test/runtime/create-rallar-black-box-test-runtime.ts';
import { ADMIN_TOKEN, adminHeaders, startControlServer } from './support/control-api-test-server.ts';

// This end-to-end test spawns the shared black-box runner (`scenario-black-box.ts`) under Bun.
test('explicit authenticated release waits for browser acknowledgement and preserves artifacts', async () => {
    const server = await startControlServer({ RALLAR_BLACK_BOX_ADMIN_TOKEN: ADMIN_TOKEN, RALLAR_BLACK_BOX_REQUIRE_RUN_TOKEN: '1' });
    const identity = { runId: 'release-api', agentId: 'agent' };
    const runtime = createDefaultRallarBlackBoxTestRuntime();
    const client = createDefaultRallarBlackBoxControlClient({
        runtime,
        heartbeatIntervalMs: 60_000,
        statsIntervalMs: 0,
        browserCensusIntervalMs: 0
    });
    try {
        const tokenResponse = await fetch(`${server.baseUrl}/runs/${identity.runId}/agents/${identity.agentId}/tokens`, {
            method: 'POST',
            headers: adminHeaders(),
            body: JSON.stringify({ ttlMs: 60_000 })
        });
        const { token } = await tokenResponse.json();
        const request = { ...identity, controlBaseUrl: server.baseUrl, commandIds: ['health'], requestId: 'release', token };
        const unauthorized = await releaseControlResults({ ...request, token: undefined }, fetch);
        assert(unauthorized.left?.includes('401'));
        client.connect({ ...identity, url: server.baseUrl.replace('http', 'ws') + '/control', token, completedCommandIds: [] });
        const enqueued = await fetch(`${server.baseUrl}/runs/${identity.runId}/agents/${identity.agentId}/commands`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-rallar-run-token': token },
            body: JSON.stringify({ commandId: 'health', command: { kind: 'health' } })
        });
        expect(enqueued.status).toBe(202);
        await enqueued.body?.cancel();
        await waitForStoredResult(server.storageDir, identity.runId);
        expect(runtime.state().commandHistory.length).toBe(1);
        const released = await releaseControlResults(request, fetch);
        expect(released.left).toBeUndefined();
        expect(released.right?.status).toBe('released');
        expect(runtime.state().commandHistory.length).toBe(0);
        const duplicate = await releaseControlResults({ ...request, requestId: 'duplicate' }, fetch);
        expect(duplicate.right?.status).toBe('released');
        const recipeProcess = Bun.spawn({
            cmd: [
                process.execPath,
                'run',
                '../../packages/shared-test/black-box-runner/scenario-black-box.ts',
                '--workingDirectory',
                '../..',
                '--config',
                'packages/shared-test/black-box-runner/examples/control-result-release.json'
            ],
            env: {
                RALLAR_BLACK_BOX_CONTROL_URL: server.baseUrl,
                RALLAR_BLACK_BOX_RUN_ID: identity.runId,
                RALLAR_BLACK_BOX_AGENT_ID: identity.agentId,
                RALLAR_BLACK_BOX_RUN_TOKEN: token,
                RALLAR_BLACK_BOX_RELEASE_COMMAND_ID: 'health'
            },
            stdout: 'pipe',
            stderr: 'pipe'
        });
        const recipeCode = await recipeProcess.exited;
        const recipeStdout = await new Response(recipeProcess.stdout).arrayBuffer();
        const recipeStderr = await new Response(recipeProcess.stderr).arrayBuffer();
        expect(recipeCode).toBe(0);
        const recipeReport = JSON.parse(new TextDecoder().decode(recipeStdout));
        expect(recipeReport.summary.failure).toBe(0);
        expect(recipeReport.summary.success).toBe(1);
        const artifact = await readFile(`${server.storageDir}/runs/${identity.runId}/results.jsonl`, 'utf8');
        assert(artifact.includes('fullResult'));
        assert(artifact.includes('commandCount'));
        const events = await readFile(`${server.storageDir}/runs/${identity.runId}/events.jsonl`, 'utf8');
        assert(events.includes('rallar.bb.command.result'));
        assert(events.includes('commandCount'));
    }
    finally {
        client.dispose();
        await server.stop();
        await rm(server.storageDir, { recursive: true, force: true });
    }
});

async function waitForStoredResult(storageDir: string, runId: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        try {
            const text = await readFile(`${storageDir}/runs/${runId}/results.jsonl`, 'utf8');
            if (text.includes('fullResult')) {
                return;
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('The control server did not persist a complete result.');
}
