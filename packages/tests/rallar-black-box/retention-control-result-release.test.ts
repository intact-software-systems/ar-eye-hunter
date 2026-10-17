import { request } from '@playwright/test';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';

import { RetentionLiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/retention-live-rtc-control-client.ts';

it.each([false, true])('retention caller releaseAfterCapture=%s returns the original result and waits for explicit release', async (releaseAfterCapture) => {
    const received: string[] = [];
    const result = {
        agentId: 'agent',
        commandId: 'health',
        ok: false,
        result: { value: { full: 'retained in server evidence' } },
        error: { code: 'EXPECTED' }
    };
    const server = createServer(async (incoming, response) => {
        received.push(incoming.url ?? '');
        response.setHeader('content-type', 'application/json');
        if (incoming.url?.endsWith('/results/release')) {
            let body = '';
            for await (const chunk of incoming) {
                body += chunk;
            }
            const selected = JSON.parse(body);
            expect(selected.commandIds).toEqual(['health']);
            response.end(JSON.stringify({ requestId: selected.requestId, status: 'released', releasedResults: 1, reason: 'durable capture verified' }));
        }
        else if (incoming.url?.endsWith('/commands')) {
            response.statusCode = 202;
            response.end('{}');
        }
        else {
            response.end(JSON.stringify({ agents: [{ agentId: 'agent' }], results: [result], events: [] }));
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected TCP test server address.');
    }
    const context = await request.newContext();
    try {
        const control = new RetentionLiveRtcControlClient({
            request: context,
            baseUrl: `http://127.0.0.1:${address.port}`,
            monotonicNow: performance.now.bind(performance),
            epochNow: Date.now
        }, releaseAfterCapture);
        expect(await control.executeResult({ runId: 'run', agentId: 'agent', commandId: 'health', command: { kind: 'health' } })).toEqual(result);
        expect(received.some((path) => path.endsWith('/results/release'))).toBe(releaseAfterCapture);
    }
    finally {
        await context.dispose();
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
