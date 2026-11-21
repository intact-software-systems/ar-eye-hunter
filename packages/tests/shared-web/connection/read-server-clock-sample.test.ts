import { describe, expect, it } from 'vitest';

import { readServerClockSample } from '@shared-web/browser/connection/server-clock/read-server-clock-sample.ts';

const input = { baseUrl: 'https://api.example.test', expectedServerPeerId: 'server-a', signal: undefined };

describe('server clock HTTP observation', () => {
    it('measures the complete request with a monotonic clock and disables caching', async () => {
        let monotonicMs = 50;
        let requestUrl = '';
        let cache: RequestCache | undefined;
        const bodyReady = Promise.withResolvers<void>();
        const resultPromise = readServerClockSample(input, {
            nowMonotonicMs: () => monotonicMs,
            fetch: async (url, options) => {
                requestUrl = String(url);
                cache = options?.cache;
                monotonicMs = 80;
                return new Response(
                    new ReadableStream({
                        async start(controller) {
                            await bodyReady.promise;
                            monotonicMs = 95;
                            controller.enqueue(new TextEncoder().encode(JSON.stringify({
                                serverPeerId: 'server-a',
                                serverNowEpochMs: 1_800_000_000_000
                            })));
                            controller.close();
                        }
                    })
                );
            }
        });
        await Promise.resolve();
        bodyReady.resolve();
        const result = await resultPromise;
        expect(requestUrl).toBe('https://api.example.test/api/time');
        expect(cache).toBe('no-store');
        expect(result.right).toEqual({
            remoteEpochMs: 1_800_000_000_000,
            requestStartedAtMonotonicMs: 50,
            responseReceivedAtMonotonicMs: 95
        });
    });

    it.each([
        null,
        { serverPeerId: 'server-b', serverNowEpochMs: 1_800_000_000_000 },
        { serverPeerId: 'server-a', serverNowEpochMs: '1800000000000' },
        { serverPeerId: 'server-a', serverNowEpochMs: -1 },
        { serverPeerId: 'server-a', serverNowEpochMs: 12.5 }
    ])('refuses an untrusted clock response %j', async (body) => {
        const result = await readServerClockSample(input, {
            nowMonotonicMs: () => 50,
            fetch: async () => Response.json(body)
        });
        expect(result.left?.code).toBe('invalid-response');
    });

    it('does not turn an unavailable endpoint into a local-clock estimate', async () => {
        const result = await readServerClockSample(input, {
            nowMonotonicMs: () => 50,
            fetch: async () => new Response('unavailable', { status: 503 })
        });
        expect(result.left?.code).toBe('http');
        expect(result.right).toBeUndefined();
    });

    it('propagates cancellation to the request and returns an explicit failure', async () => {
        const controller = new AbortController();
        const resultPromise = readServerClockSample({ ...input, signal: controller.signal }, {
            nowMonotonicMs: () => 50,
            fetch: async (_url, options) =>
                new Promise((_resolve, reject) => {
                    options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                })
        });
        controller.abort();
        expect((await resultPromise).left?.code).toBe('aborted');
    });

    it('refuses a response arriving after its attempt was cancelled', async () => {
        const controller = new AbortController();
        const result = await readServerClockSample({ ...input, signal: controller.signal }, {
            nowMonotonicMs: () => 50,
            fetch: async () => {
                controller.abort();
                return Response.json({ serverPeerId: 'server-a', serverNowEpochMs: 1_800_000_000_000 });
            }
        });
        expect(result.left?.code).toBe('aborted');
    });

    it('classifies malformed JSON as an invalid clock response', async () => {
        const result = await readServerClockSample(input, {
            nowMonotonicMs: () => 50,
            fetch: async () => new Response('{broken')
        });
        expect(result.left?.code).toBe('invalid-response');
    });
});
