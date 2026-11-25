import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import { CONTROL_REQUEST_TIMEOUT_MS } from '@shared-test/rallar-bb-test/browser-test-budgets/control-request-timeout-ms.ts';

import { toControlTimedFetch } from '../../../tests/playwright/rallar-black-box/to-control-timed-fetch.ts';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('toControlTimedFetch', () => {
    // The world-fleet operator sent its control requests through an injected fetch with no signal, so none was bounded.
    it('sends every request under the control request timeout, keeping the rest of its options', async () => {
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        const sent: RequestInit[] = [];
        const timedFetch = toControlTimedFetch(async (_url, init) => {
            sent.push(init ?? {});
            return new Response('{}');
        });

        await timedFetch('http://localhost:18081/runs', { method: 'POST', body: '{}' });

        expect(timeout).toHaveBeenCalledWith(CONTROL_REQUEST_TIMEOUT_MS);
        expect(sent).toEqual([{ method: 'POST', body: '{}', signal: expect.any(AbortSignal) }]);
    });

    it('still ends a request when the caller\'s own signal aborts', async () => {
        const caller = new AbortController();
        const sent: RequestInit[] = [];
        const timedFetch = toControlTimedFetch(async (_url, init) => {
            sent.push(init ?? {});
            return new Response('{}');
        });

        await timedFetch('http://localhost:18081/runs', { signal: caller.signal });
        caller.abort();

        expect(sent[0]?.signal?.aborted).toBe(true);
    });
});
