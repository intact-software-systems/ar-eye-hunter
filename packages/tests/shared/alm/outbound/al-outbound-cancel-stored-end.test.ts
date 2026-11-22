import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundMessageRuntime, ALOutboundRuntimeStores } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import {
    createCountingIndexedDbOperationObserver,
    type CountingIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import '../../../setup-browser-indexeddb.ts';
import {
    createDefaultOutboundTestRuntime,
    createIndexedDbOutboundTestStores,
    createOutboundMessage,
    createVolatileOutboundTestStores,
    drainOutboundWorkDueNow,
    holdOutboundClaims,
    OUTBOUND_TEST_SEND_PLANNER,
    peekOutboundWorkReadyAt,
    waitForOutboundWorkDrained
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime,
    createTestDurableWorkOwnership,
    type SessionOutboundTestRuntime,
    type TestDurableWorkOwnership
} from '../session-outbound-test-runtime.ts';

const NAMESPACE = 'cancel-stored-end';

/** One page's outbound owner: its durable pair over IndexedDB, counted, beside a memory pair. */
interface PageOwner {
    readonly dbName: string;
    readonly observer: CountingIndexedDbOperationObserver;
    readonly stores: ALOutboundRuntimeStores<OutboundTestPayload>;
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    /** The msgId of every frame this owner's carrier was handed, in send order. */
    readonly sent: string[];
}

/** A message whose resource id starts with `volatile` goes to the memory pair; any other to IndexedDB. */
function openPageOwner(dbName: string): PageOwner {
    const observer = createCountingIndexedDbOperationObserver();
    const stores = createIndexedDbOutboundTestStores({ observer, namespace: NAMESPACE, dbName });
    const sent: string[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        volatileStores: createVolatileOutboundTestStores(),
        // A supplied engine is never started, so only this test's batches run the owner's work.
        queueEngine: new InboxOutboxEngine(),
        planOutgoingMessage: (msg, authority) => ({
            ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
            lane: msg.route.resourceId.startsWith('volatile') ? 'volatile' : 'durable'
        }),
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage.id.msgId);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { dbName, observer, stores, runtime, sent };
}

async function reloadPage(page: PageOwner): Promise<PageOwner> {
    await page.runtime.dispose();
    const reloaded = openPageOwner(page.dbName);
    await reloaded.runtime.ready();
    return reloaded;
}

async function readSendGuardKind(
    stores: ALOutboundRuntimeStores<OutboundTestPayload>,
    message: ALMessage
): Promise<string> {
    return (await stores.admissionStore.readSendGuards(message)).kind;
}

/** Hands every commit the tab announced to the owning tab, as the session channel does. */
function relayAnnouncedCommits(
    from: SessionOutboundTestRuntime<TestDurableWorkOwnership>,
    to: SessionOutboundTestRuntime<TestDurableWorkOwnership>
): void {
    from.ownership.announced.forEach((commit) => to.ownership.deliver(commit));
}

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('a cancel ends its message in the store that holds it', () => {
    it('is joined by dispose, so the stored message is ended once the page has gone', async () => {
        const page = openPageOwner(`cancel-dispose-${crypto.randomUUID()}`);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-cancel-dispose');
        await page.runtime.enqueueIfAbsent(message);

        expect(page.runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
        await claims.release(page.runtime);
        await page.runtime.dispose();

        const reopened = openPageOwner(page.dbName);
        expect(await readSendGuardKind(reopened.stores, message)).toBe('ended');
    });

    it('stores the end at the next claimed effect of the message when its own commit conflicted', async () => {
        const page = openPageOwner(`cancel-conflict-${crypto.randomUUID()}`);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-cancel-conflict');
        await page.runtime.enqueueIfAbsent(message);
        const commitBundle = vi.spyOn(page.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(() => expect(commitBundle).toHaveBeenCalledTimes(1));
        expect(await readSendGuardKind(page.stores, message)).toBe('current');
        await claims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(await readSendGuardKind(page.stores, message)).toBe('ended');
        const reloaded = await reloadPage(page);
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);
        expect([...page.sent, ...reloaded.sent]).toEqual([]);
    });

    it('redelivers the claimed effect whose end commit conflicts, and stores the end on that redelivery', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const page = openPageOwner(`cancel-claim-conflict-${crypto.randomUUID()}`);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-cancel-claim-conflict');
        await page.runtime.enqueueIfAbsent(message);
        const commitBundle = vi.spyOn(page.stores.admissionStore, 'commitBundle')
            .mockResolvedValueOnce('conflict')
            .mockResolvedValueOnce('conflict');

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(() => expect(commitBundle).toHaveBeenCalledTimes(1));
        await claims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(commitBundle).toHaveBeenCalledTimes(2);
        expect(await readSendGuardKind(page.stores, message)).toBe('current');
        expect(await peekOutboundWorkReadyAt(page.stores.workQueue, NAMESPACE)).toBeDefined();
        vi.setSystemTime(Date.now() + 10_000);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(await readSendGuardKind(page.stores, message)).toBe('ended');
        expect(page.sent).toEqual([]);
    });

    it('writes nothing to storage for a message the owner never admitted', async () => {
        const page = openPageOwner(`cancel-unknown-${crypto.randomUUID()}`);
        await page.runtime.ready();
        page.observer.reset();

        page.runtime.cancel('never-admitted', 'trace-never-admitted');
        await page.runtime.dispose();

        expect(page.observer.getCounts().byKind.write ?? 0).toBe(0);
        expect(page.observer.getCounts().byKind['work-write'] ?? 0).toBe(0);
    });

    it('ends a volatile message in its memory pair without an IndexedDB operation', async () => {
        const page = openPageOwner(`cancel-volatile-${crypto.randomUUID()}`);
        const message = createOutboundMessage('volatile-cancel');
        await page.runtime.ready();
        page.observer.reset();
        expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: false });

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await page.runtime.dispose();

        expect(page.observer.getCounts().total).toBe(0);
    });
});

describe('a cancel in a tab that does not own the session durable work', () => {
    it('keeps the owning tab from sending a durable message whose send was still pending', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        const message = createOutboundMessage('durable-cancel-other-tab');
        expect((await other.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });

        other.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readSendGuardKind(other.stores, message)).toBe('ended'));
        relayAnnouncedCommits(other, owner);
        await waitForOutboundWorkDrained(owner.stores);

        expect([...owner.sent, ...other.sent]).toEqual([]);
    });

    it('ends a message whose admission was still in flight when the cancel landed', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        const message = createOutboundMessage('durable-cancel-in-flight');

        const admitting = other.runtime.enqueueIfAbsent(message);
        other.runtime.cancel(message.id.msgId, message.id.traceId);
        expect((await admitting).verdict).toMatchObject({ kind: 'admitted', durable: true });

        expect(await readSendGuardKind(other.stores, message)).toBe('ended');
        relayAnnouncedCommits(other, owner);
        await waitForOutboundWorkDrained(owner.stores);
        expect([...owner.sent, ...other.sent]).toEqual([]);
    });
});
