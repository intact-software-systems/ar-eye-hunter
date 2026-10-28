import { describe, expect, it } from 'vitest';

import { timeRallarAsync, type RallarTimingEvent } from '@shared-server/rallar-system/observability/timing.ts';

describe('timeRallarAsync', () => {
    it('records the trace it is given and a thrown value normalized to an error name and message', async () => {
        const events: RallarTimingEvent[] = [];
        const timed = { component: 'test', operation: 'action', requestId: 'request-1', traceId: 'trace-timed-action' };

        await expect(timeRallarAsync((event) => events.push(event), timed, async () => {
            throw new TypeError('typed failure');
        })).rejects.toThrow('typed failure');
        await expect(timeRallarAsync((event) => events.push(event), timed, async () => {
            throw 'thrown string';
        })).rejects.toBe('thrown string');

        expect(events.map(({ traceId, status, error }) => ({ traceId, status, error }))).toEqual([
            { traceId: 'trace-timed-action', status: 'error', error: { name: 'TypeError', message: 'typed failure' } },
            { traceId: 'trace-timed-action', status: 'error', error: { name: 'Error', message: 'thrown string' } }
        ]);
    });
});
