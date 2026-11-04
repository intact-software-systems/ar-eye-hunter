import { ApiHttpError } from '@shared-web/browser/api/http-error.ts';
import { readApiView } from '@shared-web/browser/api/read-api-view.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

const session: AuthSession = { clientId: 'alice', username: 'alice', sessionId: 'session', accessToken: 'test', expiresAtEpochMs: 9999999999999 };
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

interface ReadViewFixture {
    readonly fetch: Mock<typeof globalThis.fetch>;
    readonly controller: AbortController;
    read(): Promise<ApiJsonValue>;
}

function fixture(): ReadViewFixture {
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    return { fetch, controller, read: () => readApiView({ timeoutMs: 10000, baseUrl: 'https://api.test', path: '/view', session, signal: controller.signal }) };
}

describe('canonical view transport recovery', () => {
    it('recovers a transient failure of the only push-triggered read', async () => {
        const test = fixture();
        test.fetch.mockResolvedValueOnce(new Response('Unavailable', { status: 503 }));
        test.fetch.mockResolvedValueOnce(Response.json({ name: 'current' }));
        const result = test.read();
        await vi.advanceTimersByTimeAsync(2000);
        expect(await result).toEqual({ name: 'current' });
        expect(test.fetch).toHaveBeenCalledTimes(2);
    });

    it.each([401, 403, 404])('does not retry definitive HTTP refusal %s', async (status) => {
        const test = fixture();
        test.fetch.mockResolvedValue(new Response('Refused', { status }));
        await expect(test.read()).rejects.toMatchObject({ status });
        expect(test.fetch).toHaveBeenCalledTimes(1);
    });

    it('bounds a failed recovery and preserves the final HTTP error', async () => {
        const test = fixture();
        test.fetch.mockImplementation(async () => new Response('Unavailable', { status: 503 }));
        const assertion = expect(test.read()).rejects.toBeInstanceOf(ApiHttpError);
        await vi.advanceTimersByTimeAsync(10000);
        await assertion;
        expect(test.fetch).toHaveBeenCalledTimes(3);
    });

    it('never retries with obsolete credentials after cancellation during backoff', async () => {
        const test = fixture();
        test.fetch.mockRejectedValue(new TypeError('Network disconnected'));
        const assertion = expect(test.read()).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(0);
        test.controller.abort();
        await vi.advanceTimersByTimeAsync(10000);
        await assertion;
        expect(test.fetch).toHaveBeenCalledTimes(1);
    });
});
