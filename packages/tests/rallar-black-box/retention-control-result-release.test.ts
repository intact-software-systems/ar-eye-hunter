import { request } from '@playwright/test';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';

import { RetentionLiveRtcControlClient } from '../../../tests/playwright/rallar-black-box/retention-live-rtc-control-client.ts';

it.each([false, true])(
    'retention caller releaseAfterCapture=%s preserves the original result and drains the last acknowledgement before finalization',
    async (releaseAfterCapture) => {
        const received: string[] = [];
        const drainEntered = Promise.withResolvers<void>();
        const drainFinished = Promise.withResolvers<void>();
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
            if (incoming.url?.endsWith('/events.jsonl')) {
                drainEntered.resolve();
                await drainFinished.promise;
                response.end('{}');
            }
            else if (incoming.url?.endsWith('/results/release')) {
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
            let finalized = false;
            const summary = Reflect.apply(control.attachRunSummary, control, [{ runId: 'run', testInfo: { attach: async () => {} } }])
                .then(() => {
                    finalized = true;
                });
            if (releaseAfterCapture) {
                await Promise.race([drainEntered.promise, summary]);
                expect(received.some((path) => path.endsWith('/events.jsonl'))).toBe(true);
                expect(finalized).toBe(false);
                drainFinished.resolve();
            }
            await summary;
            expect(received.some((path) => path.endsWith('/events.jsonl'))).toBe(releaseAfterCapture);
        }
        finally {
            drainFinished.resolve();
            await context.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    }
);

it.each(['success', 'failed', 'deferred', 'missing', 'mismatched'])(
    'holds the original result until the exact release acknowledgement: %s',
    async (variant) => {
        const entered = Promise.withResolvers<void>();
        const acknowledged = Promise.withResolvers<void>();
        const original = { agentId: 'agent', commandId: 'health', ok: variant !== 'failed', result: { value: { full: 'original' } } };
        const server = createServer(async (incoming, response) => {
            response.setHeader('content-type', 'application/json');
            if (incoming.url?.endsWith('/results/release')) {
                let body = '';
                for await (const chunk of incoming) {
                    body += chunk;
                }
                const selection = JSON.parse(body);
                entered.resolve();
                await acknowledged.promise;
                response.end(JSON.stringify(
                    variant === 'missing' ? {} : {
                        requestId: variant === 'mismatched' ? 'other' : selection.requestId,
                        status: variant === 'deferred' ? 'deferred' : 'released',
                        releasedResults: 1,
                        reason: 'captured'
                    }
                ));
            }
            else if (incoming.url?.endsWith('/commands')) {
                response.statusCode = 202;
                response.end('{}');
            }
            else {
                response.end(JSON.stringify({ agents: [{ agentId: 'agent' }], results: [original], events: [] }));
            }
        });
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Expected TCP address.');
        }
        const context = await request.newContext();
        try {
            const client = new RetentionLiveRtcControlClient({
                request: context,
                baseUrl: `http://127.0.0.1:${address.port}`,
                monotonicNow: performance.now.bind(performance),
                epochNow: Date.now
            }, true);
            let settled = false;
            const result = client.executeResult({ runId: 'run', agentId: 'agent', commandId: 'health', command: { kind: 'health' } });
            const observed = result.then((value) => {
                settled = true;
                return value;
            }, (error: Error) => {
                settled = true;
                throw error;
            });
            await entered.promise;
            expect(settled).toBe(false);
            acknowledged.resolve();
            if (variant === 'success' || variant === 'failed') {
                expect(await observed).toEqual(original);
            }
            else {
                await expect(observed).rejects.toThrow('not acknowledged');
            }
        }
        finally {
            acknowledged.resolve();
            await context.dispose();
            await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        }
    }
);
