import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';

import {
    createOutboundMessage,
    drainOutboundWorkDueNow,
    holdOutboundClaims,
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
});
