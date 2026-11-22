import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

import {
    createOutboundMessage,
    drainOutboundWorkDueNow,
    holdOutboundClaims,
    OUTBOUND_LEASE_RECOVERY_BOUND_MS,
    runOutboundWorkTask,
    waitForOutboundWorkDrained
} from '../../outbound-runtime-test-fixture.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime,
    createTestDurableWorkOwnership
} from '../../session-outbound-test-runtime.ts';
import {
    openPageOwner,
    readEndMessageRow,
    readSendGuardKind,
    relayAnnouncedCommits,
    reloadPage,
    type PageOwner
} from './outbound-page-owner-fixture.ts';

const NAMESPACE = 'cancel-retained-admission';

/**
 * A page whose first admission commit conflicted: only the `admit-message` row holds the message (D751). The page's
 * own batches claimed nothing while it admitted, so the row is still waiting for its replay.
 */
async function openPageWithRetainedAdmission(name: string): Promise<{ page: PageOwner; message: ALMessage; }> {
    const page = openPageOwner(`${name}-${crypto.randomUUID()}`, NAMESPACE);
    const claims = holdOutboundClaims(page.stores);
    const message = createOutboundMessage(`durable-${name}`);
    vi.spyOn(page.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
    expect((await page.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');
    expect(await page.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
    await claims.release(page.runtime);
    return { page, message };
}

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('a cancel or hand-over of a message whose admission was retained (D751)', () => {
    it('completes the retained admission on a hand-over, so nothing is admitted or sent after a reload', async () => {
        const { page, message } = await openPageWithRetainedAdmission('hand-over-retained');

        await page.runtime.handOver(message.id.msgId);
        const reloaded = await reloadPage(page);
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);

        expect(await reloaded.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        expect([...page.sent, ...reloaded.sent]).toEqual([]);
    });

    it('ends the stored row a replay committed first, and nothing is sent', async () => {
        const { page, message } = await openPageWithRetainedAdmission('replay-first');
        const replayer = openPageOwner(page.dbName, NAMESPACE);
        const { workQueue } = replayer.stores;
        // The replayer's first batch claims the retained admission alone: its replay commits, every later claim is held.
        const reserveEntries = workQueue.reserveEntries.bind(workQueue);
        vi.spyOn(workQueue, 'reserveEntries').mockImplementationOnce(reserveEntries).mockResolvedValue(new Map());
        await replayer.runtime.ready();
        await runOutboundWorkTask(replayer.runtime);
        expect(await page.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(true);

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await page.runtime.dispose();
        expect(await readSendGuardKind(replayer.stores, message)).toBe('ended');
        vi.mocked(workQueue.reserveEntries).mockRestore();
        await drainOutboundWorkDueNow(replayer.runtime, replayer.stores);

        expect([...page.sent, ...replayer.sent]).toEqual([]);
    });

    it('keeps the owning tab from admitting what a tab that does not own the work retained and cancelled', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        const message = createOutboundMessage('durable-other-tab-retained');
        vi.spyOn(other.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        expect((await other.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');

        other.runtime.cancel(message.id.msgId, message.id.traceId);
        await other.runtime.dispose();
        relayAnnouncedCommits(other, owner);
        await waitForOutboundWorkDrained(owner.stores);

        expect(await owner.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        expect([...owner.sent, ...other.sent]).toEqual([]);
    });

    it('ends a retained admission its end read as held while claims were held, so nothing resumes after a reload', async () => {
        const page = openPageOwner(`held-end-${crypto.randomUUID()}`, NAMESPACE);
        holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-held-end');
        vi.spyOn(page.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        expect((await page.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        // The end cannot reserve the held admission row, so it retains its end naming that row.
        await vi.waitFor(async () => expect(await readEndMessageRow(page.stores, message.id.msgId)).toMatchObject({ status: EntityStatus.NEW }));
        const reloaded = await reloadPage(page);
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);

        expect(await reloaded.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        expect([...page.sent, ...reloaded.sent]).toEqual([]);
    });

    it('is ended by an owner that never saw the cancel, after the owner\'s replay conflicted once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const dbName = `replay-conflicted-${crypto.randomUUID()}`;
        const tab = openPageOwner(dbName, NAMESPACE);
        // The cancelling tab runs none of the session's work: its claims stay held.
        holdOutboundClaims(tab.stores);
        const message = createOutboundMessage('durable-replay-conflicted');
        vi.spyOn(tab.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        expect((await tab.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');
        const owner = openPageOwner(dbName, NAMESPACE);
        vi.spyOn(owner.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        await owner.runtime.ready();
        await runOutboundWorkTask(owner.runtime);
        expect(await owner.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);

        tab.runtime.cancel(message.id.msgId, message.id.traceId);
        await tab.runtime.dispose();
        await drainOutboundWorkDueNow(owner.runtime, owner.stores);
        // Past the replay's retry: the owner claims the admission row and the end together. The replay finds the end
        // retained and admits nothing; an end that found the admission reserved by that batch waits out its lease.
        vi.setSystemTime(Date.now() + 2_000);
        await drainOutboundWorkDueNow(owner.runtime, owner.stores);
        expect(await owner.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        vi.setSystemTime(Date.now() + OUTBOUND_LEASE_RECOVERY_BOUND_MS);
        await drainOutboundWorkDueNow(owner.runtime, owner.stores);

        expect(await owner.stores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        expect((await readEndMessageRow(owner.stores, message.id.msgId))?.status).toBe(EntityStatus.COMPLETED);
        expect([...tab.sent, ...owner.sent]).toEqual([]);
    });
});

describe('a retained admission in a memory lane is ended in that lane', () => {
    it('completes a checkpoint-lane admission in the checkpoint pair, with no IndexedDB operation on the durable pair', async () => {
        const session = createOutboundTestSession();
        const tab = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        const checkpointClaims = holdOutboundClaims(tab.checkpointStores);
        const message = createOutboundMessage('checkpoint-retained');
        vi.spyOn(tab.checkpointStores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        expect((await tab.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');
        session.durableObserver.reset();

        tab.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readEndMessageRow(tab.checkpointStores, message.id.msgId)).toBeDefined());
        expect(session.durableObserver.getCounts().total).toBe(0);
        await checkpointClaims.release(tab.runtime);
        await drainOutboundWorkDueNow(tab.runtime, tab.checkpointStores);

        expect(await tab.checkpointStores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        expect(tab.sent).toEqual([]);
        expect(session.durableObserver.getCounts().total).toBe(0);
    });

    it('completes a volatile-lane admission in the memory pair, with no IndexedDB operation on the durable pair', async () => {
        const page = openPageOwner(`volatile-retained-${crypto.randomUUID()}`, NAMESPACE);
        await page.runtime.ready();
        const volatileClaims = holdOutboundClaims(page.volatileStores);
        const message = createOutboundMessage('volatile-retained');
        vi.spyOn(page.volatileStores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        expect((await page.runtime.enqueueIfAbsent(message)).verdict.kind).toBe('pending');
        page.observer.reset();

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readEndMessageRow(page.volatileStores, message.id.msgId)).toBeDefined());
        expect(page.observer.getCounts().total).toBe(0);
        await volatileClaims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.volatileStores);

        expect(await page.volatileStores.admissionStore.hasSentMessageAdmission(message.id.msgId)).toBe(false);
        expect(page.sent).toEqual([]);
    });
});
