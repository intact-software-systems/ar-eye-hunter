import { describe, expect, it } from 'vitest';

import { BrowserPageLifecycleFlush } from '@shared-web/browser/al-runtime/browser-page-lifecycle-flush.ts';
import { ALWAYS_OWNED_AL_DURABLE_WORK, type ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import { ObservableLatestValue } from '@shared/cache/ObservableLatestValue.ts';

import { FakePageLifecycle } from './fake-page-lifecycle.ts';

describe('the page lifecycle flush of a connect', () => {
    it('flushes the checkpoints when the page hides, is hidden away or freezes', () => {
        const page = new FakePageLifecycle();
        const flushes = openFlush(page, ALWAYS_OWNED_AL_DURABLE_WORK);

        page.hide();
        page.pagehide();
        page.freeze();

        expect(flushes()).toBe(3);
    });

    it('does not flush when the page becomes visible', () => {
        const page = new FakePageLifecycle();
        const flushes = openFlush(page, ALWAYS_OWNED_AL_DURABLE_WORK);

        page.show();

        expect(flushes()).toBe(0);
    });

    // A waiting tab's checkpoint lanes write nothing, so its page events have nothing to flush until it owns the work.
    it('listens only once the connect owns the session\'s work', async () => {
        const page = new FakePageLifecycle();
        const ownership = createWaitingOwnership();
        const flushes = openFlush(page, ownership);

        page.hide();
        await ownership.takeOver();
        page.pagehide();

        expect(flushes()).toBe(1);
    });

    it('removes its listeners at release, also from a takeover that comes after it', async () => {
        const page = new FakePageLifecycle();
        const owned = openFlushHandle(page, ALWAYS_OWNED_AL_DURABLE_WORK);
        const ownership = createWaitingOwnership();
        const waiting = openFlushHandle(page, ownership);

        owned.flush.release();
        waiting.flush.release();
        await ownership.takeOver();
        page.hide();
        page.pagehide();
        page.freeze();

        expect([owned.count(), waiting.count()]).toEqual([0, 0]);
    });

    it('registers nothing where there is no document or window', () => {
        const handle = openFlushHandle({ document: undefined, window: undefined }, ALWAYS_OWNED_AL_DURABLE_WORK);

        handle.flush.release();

        expect(handle.count()).toBe(0);
    });
});

interface FlushHandle {
    readonly flush: BrowserPageLifecycleFlush;
    count(): number;
}

function openFlushHandle(page: BrowserPageLifecycleFlush.Page, ownership: ALDurableWorkOwnership): FlushHandle {
    let count = 0;
    const flush = new BrowserPageLifecycleFlush({ page, ownership, checkpoints: [{ flush: () => count += 1 }] });
    return { flush, count: () => count };
}

function openFlush(page: BrowserPageLifecycleFlush.Page, ownership: ALDurableWorkOwnership): () => number {
    return openFlushHandle(page, ownership).count;
}

interface WaitingOwnership extends ALDurableWorkOwnership {
    /** Settles once every listener of the ownership heard it. */
    takeOver(): Promise<void>;
}

/** A connect whose owner-lock request another tab holds, until the test hands it the work. */
function createWaitingOwnership(): WaitingOwnership {
    const owned = new ObservableLatestValue<boolean>().set(false);
    return {
        owned,
        isOwned: () => owned.peek() === true,
        announceCommit: () => undefined,
        onForeignCommit: () => () => undefined,
        takeOver: async () => {
            owned.accept(true);
            await owned.whenIdle();
        }
    };
}
