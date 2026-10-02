import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { BrowserALDurableWorkClaim } from '@shared-web/browser/al-runtime/browser-al-durable-work-claim.ts';
import type { ALBrowserLockOptions, ALBrowserLocks } from '@shared/alm/storage/al-browser-locks.ts';
import type { ALDurableWorkCommit, ALDurableWorkOwnership } from '@shared/alm/work/al-durable-work-ownership.ts';
import type { ALWorkCommittedRows } from '@shared/alm/work/al-work-readiness-memory.ts';
import type { StateScope } from '@shared/api/state-types.ts';

import { createOutboundMessage } from '../../shared/alm/outbound-runtime-test-fixture.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime
} from '../../shared/alm/session-outbound-test-runtime.ts';

const SCOPE: StateScope = { applicationId: 'app:one', workspaceId: 'work space' };
const SESSION_ID = 'session-1';
const OWNER_LOCK_NAME = 'rallar:al-durable-owner:app%3Aone:work%20space:session-1';
const ROWS: ALWorkCommittedRows = { dueByMs: 1_000, writtenKeys: ['row-1'] };

describe('BrowserALDurableWorkClaim', () => {
    it('owns the session\'s durable work from its lock\'s grant, and hands it to the next connect when released', async () => {
        const browser = createSharedWebLocks();
        const first = openClaim(browser.locks);
        const second = openClaim(browser.locks);

        await vi.waitFor(() => expect(first.isOwned()).toBe(true));
        expect(second.isOwned()).toBe(false);
        expect(browser.requests).toEqual([OWNER_LOCK_NAME, OWNER_LOCK_NAME]);

        first.release();

        await vi.waitFor(() => expect(second.isOwned()).toBe(true));
    });

    it('abandons a request still waiting when its connect ends', async () => {
        const browser = createSharedWebLocks();
        const first = openClaim(browser.locks);
        const second = openClaim(browser.locks);
        const third = openClaim(browser.locks);
        await vi.waitFor(() => expect(first.isOwned()).toBe(true));

        second.release();
        first.release();

        await vi.waitFor(() => expect(third.isOwned()).toBe(true));
        expect(second.isOwned()).toBe(false);
    });

    it('keeps the work, once owned, until its connect ends and never hands ownership back', async () => {
        const browser = createSharedWebLocks();
        const owner = openClaim(browser.locks);
        const accepted: (boolean | undefined)[] = [];
        owner.owned.onChangeDo((event) => {
            accepted.push(event.value);
        });
        await vi.waitFor(() => expect(owner.isOwned()).toBe(true));

        const waiting = openClaim(browser.locks);
        const next = openClaim(browser.locks);
        waiting.release();
        await Promise.resolve();
        expect(owner.isOwned()).toBe(true);

        owner.release();
        await vi.waitFor(() => expect(next.isOwned()).toBe(true));
        await drainObservers();

        expect(owner.isOwned()).toBe(true);
        expect(accepted).not.toContain(false);
    });

    it('hands another connect\'s commit to the listener of its work type only while it owns the work', async () => {
        const browser = createSharedWebLocks();
        const first = openClaim(browser.locks);
        const second = openClaim(browser.locks);
        const heard: string[] = [];
        second.onForeignCommit('work-a', () => heard.push('work-a'));
        const removeWorkB = second.onForeignCommit('work-b', () => heard.push('work-b'));
        await vi.waitFor(() => expect(first.isOwned()).toBe(true));

        second.applyForeignCommit({ workType: 'work-a', rows: ROWS });
        expect(heard).toEqual([]);

        first.release();
        await vi.waitFor(() => expect(second.isOwned()).toBe(true));
        removeWorkB();
        second.applyForeignCommit({ workType: 'work-a', rows: ROWS });
        second.applyForeignCommit({ workType: 'work-b', rows: ROWS });
        expect(heard).toEqual(['work-a']);

        second.release();
        second.applyForeignCommit({ workType: 'work-a', rows: ROWS });
        expect(heard).toEqual(['work-a']);
    });

    it('owns the work in every connect where the Locks API is missing', () => {
        const claim = openClaim(undefined);

        expect(claim.isOwned()).toBe(true);
    });

    // A tab that could not take part in the claim drains as every tab did before it.
    it('owns the work when its lock request fails for another reason than its own release', async () => {
        const claim = openClaim({ request: async () => await Promise.reject(new DOMException('opaque', 'SecurityError')) });

        await vi.waitFor(() => expect(claim.isOwned()).toBe(true));
    });
});

describe('two connects of one session over one durable store', () => {
    it('drains in the owner, and the next connect takes over on its release and sends each row once', async () => {
        const browser = createSharedWebLocks();
        const session = createOutboundTestSession();
        const first = createSessionOutboundTestRuntime(session, openClaim(browser.locks));
        const second = createSessionOutboundTestRuntime(session, openClaim(browser.locks));
        await vi.waitFor(() => expect(first.ownership.isOwned()).toBe(true));

        await first.runtime.enqueueIfAbsent(createOutboundMessage('durable-first'));
        await second.runtime.enqueueIfAbsent(createOutboundMessage('durable-second'));
        await vi.waitFor(() => expect(first.sent).toEqual(['durable-first']));
        expect(second.sent).toEqual([]);

        // The first tab closes: its runtimes end before its connect releases the claim.
        first.runtime.dispose();
        first.ownership.release();

        await vi.waitFor(() => expect(second.sent).toEqual(['durable-second']));
        expect(first.sent).toEqual(['durable-first']);
        expect(session.storage.filter((event) => event.kind === 'recovery')).toEqual([
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'storage-created' } },
            { kind: 'recovery', storeId: session.namespace, outcome: { kind: 'restored', claimed: 1, expired: 0 } }
        ]);
    });

    it('runs a waiting connect\'s commit in the owner only, and the waiting connect never announces it again', async () => {
        const browser = createSharedWebLocks();
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, openClaim(browser.locks));
        const waiting = createSessionOutboundTestRuntime(session, openClaim(browser.locks));
        await vi.waitFor(() => expect(owner.ownership.isOwned()).toBe(true));
        const announced: ALDurableWorkCommit[] = [];
        const waitingOwnership: ALDurableWorkOwnership = waiting.ownership;
        vi.spyOn(waitingOwnership, 'announceCommit').mockImplementation((commit) => {
            announced.push(commit);
        });
        await waiting.runtime.enqueueIfAbsent(createOutboundMessage('durable-waiting'));
        await vi.waitFor(() => expect(announced).toHaveLength(1));

        announced.slice().forEach((commit) => waiting.ownership.applyForeignCommit(commit));
        expect(announced).toHaveLength(1);

        announced.forEach((commit) => owner.ownership.applyForeignCommit(commit));
        await vi.waitFor(() => expect(owner.sent).toEqual(['durable-waiting']));
        expect(waiting.sent).toEqual([]);
    });

    it('drains in every connect without the Locks API, each row once', async () => {
        const session = createOutboundTestSession();
        const first = createSessionOutboundTestRuntime(session, openClaim(undefined));
        const second = createSessionOutboundTestRuntime(session, openClaim(undefined));

        await first.runtime.enqueueIfAbsent(createOutboundMessage('durable-first'));
        await second.runtime.enqueueIfAbsent(createOutboundMessage('durable-second'));

        expect(first.ownership.isOwned() && second.ownership.isOwned()).toBe(true);
        await vi.waitFor(() => expect([...first.sent, ...second.sent].toSorted()).toEqual(['durable-first', 'durable-second']));
    });
});

/** An observable value's observers run on a promise queue, which a macrotask outlasts. */
async function drainObservers(): Promise<void> {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

function openClaim(locks: ALBrowserLocks | undefined): BrowserALDurableWorkClaim {
    const claim = new BrowserALDurableWorkClaim({ scope: SCOPE, sessionId: SESSION_ID, locks });
    claim.request();
    onTestFinished(() => claim.release());
    return claim;
}

/**
 * One exclusive lock per name, shared by every tab of the browser, as the Web Locks API is: a request
 * waits its turn, and one its signal aborts while it waits is never granted.
 */
function createSharedWebLocks(): { readonly locks: ALBrowserLocks; readonly requests: readonly string[]; } {
    const tails = new Map<string, Promise<void>>();
    const requests: string[] = [];
    const request = async <T>(name: string, options: ALBrowserLockOptions, callback: () => Promise<T>): Promise<T> => {
        requests.push(name);
        const previous = tails.get(name) ?? Promise.resolve();
        const released = Promise.withResolvers<void>();
        tails.set(name, previous.then(() => released.promise));
        try {
            await waitUnlessAborted(previous, options.signal);
            return await callback();
        }
        finally {
            released.resolve();
        }
    };
    return { locks: { request }, requests };
}

async function waitUnlessAborted(previous: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
    const aborted = Promise.withResolvers<void>();
    signal?.addEventListener('abort', () => aborted.reject(new DOMException('aborted', 'AbortError')), { once: true });
    await Promise.race([previous, aborted.promise]);
}
