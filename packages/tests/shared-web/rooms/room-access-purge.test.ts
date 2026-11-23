import type { RoomAccessObservation } from '@shared-web/browser/rallar.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Either } from '@shared/resilience/Either.ts';
import { configureApiClient } from '@shared-web/browser/api-client-config.ts';
import { installFakeBroadcastChannelPerTest } from '../data/rallar-data-test-runtime.ts';
import { createRoomSnapshot, resetRoomWorkflowTestRuntime } from './room-workflow-test-runtime.ts';

installFakeBroadcastChannelPerTest();
beforeEach(() => {
    resetRoomWorkflowTestRuntime();
    configureApiClient({ apiBaseUrl: '' });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('watchAccess room purge', () => {
    it.each([0, 50])('confirms a far purge cutoff with storage lag of %i ms', async lagMs => {
        const { createRallarFacade } = await import('@shared-web/browser/rallar.ts');
        const facade = createRallarFacade();
        const context = await facade.connect();
        vi.spyOn(facade.ws, 'status').mockReturnValue({ ...facade.ws.status(), isOpen: true });
        vi.stubGlobal('window', new EventTarget());
        vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }));
        vi.stubGlobal('navigator', { onLine: true });
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2032-01-01T00:00:00Z'));
        const serverStart = Date.UTC(2027, 0, 1);
        const delay = 2_147_483_647 + 100;
        const monotonicStart = performance.now();
        vi.spyOn(context.serverTime, 'readWindow').mockImplementation(() => {
            const now = serverStart + performance.now() - monotonicStart;
            return Either.ofRight({ earliestEpochMs: now, latestEpochMs: now + 5 });
        });
        const room = createRoomSnapshot('temporary', ['session-1']);
        const snapshot = { ...room, group: { ...room.group, purgeAfterEpochMs: serverStart + delay } };
        const fetch = vi.fn(async () => performance.now() - monotonicStart >= delay + lagMs
            ? Response.json({ error: 'not_found' }, { status: 404 })
            : Response.json(snapshot, { headers: {
                'cache-control': 'no-store', 'rallar-state-source': 'durable',
                'rallar-group-revision': String(snapshot.causalRevision.groupRevision),
                'rallar-presence-revision': String(snapshot.causalRevision.presenceRevision)
            } }));
        vi.stubGlobal('fetch', fetch);
        let observed: RoomAccessObservation | undefined;
        const stop = facade.rooms.watchAccess(snapshot.group, value => { observed = value; });
        try {
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(observed).toEqual({ status: 'current' });
            expect(fetch).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(fetch).toHaveBeenCalledTimes(2);
            if (lagMs) {
                expect(observed).toEqual({ status: 'current' });
                await vi.advanceTimersByTimeAsync(2_000);
            }
            expect(observed).toEqual({ status: 'denied', reason: 'unavailable' });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(fetch).toHaveBeenCalledTimes(lagMs ? 3 : 2);
        } finally {
            stop();
            vi.useRealTimers();
            await facade.disconnect();
        }
    });
});
