import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { computeALOutboundWorkEntry } from '@shared/alm/outbound/al-outbound-work-entry.ts';
import { toALOutboundEndMessageEffectId } from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';

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
    readEndMessageRow,
    readSendGuardKind,
    relayAnnouncedCommits,
    reloadPage,
    type PageOwner
} from './outbound-page-owner-fixture.ts';

const NAMESPACE = 'retained-message-end';

/** A page whose durable message is admitted and whose send is held, with the next `conflicts` commits refused. */
async function openPageWithHeldSend(name: string, conflicts: number) {
    const page = openPageOwner(`${name}-${crypto.randomUUID()}`, NAMESPACE);
    const claims = holdOutboundClaims(page.stores);
    const message = createOutboundMessage(`durable-${name}`);
    expect((await page.runtime.enqueueIfAbsent(message)).verdict).toMatchObject({ kind: 'admitted', durable: true });
    const commitBundle = vi.spyOn(page.stores.admissionStore, 'commitBundle');
    for (let conflict = 0; conflict < conflicts; conflict += 1) {
        commitBundle.mockResolvedValueOnce('conflict');
    }
    return { page, claims, message, commitBundle };
}

async function readEndMessageStatus(page: PageOwner, msgId: string): Promise<string | undefined> {
    return (await readEndMessageRow(page.stores, msgId))?.status;
}

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('an end whose commit conflicts is retained as work (D750)', () => {
    it('leaves an end-message row, whose run stores the end, and nothing is sent after a reload', async () => {
        const { page, claims, message } = await openPageWithHeldSend('cancel-conflict', 1);

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.NEW));
        expect(await readSendGuardKind(page.stores, message)).toBe('current');
        await claims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(await readSendGuardKind(page.stores, message)).toBe('ended');
        expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.COMPLETED);
        const reloaded = await reloadPage(page);
        await drainOutboundWorkDueNow(reloaded.runtime, reloaded.stores);
        expect([...page.sent, ...reloaded.sent]).toEqual([]);
    });

    it('redelivers an end-message run whose commit conflicts, and stores the end on that redelivery', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { page, claims, message, commitBundle } = await openPageWithHeldSend('run-conflict', 2);

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.NEW));
        await claims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(commitBundle).toHaveBeenCalledTimes(2);
        expect(await readSendGuardKind(page.stores, message)).toBe('current');
        expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.RETRY);
        vi.setSystemTime(Date.now() + 10_000);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(await readSendGuardKind(page.stores, message)).toBe('ended');
        expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.COMPLETED);
        expect(page.sent).toEqual([]);
    });

    it('retains one row, unchanged, for a second conflicting end of the same message', async () => {
        const { page, message } = await openPageWithHeldSend('second-conflict', 2);
        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.NEW));
        const first = await readEndMessageRow(page.stores, message.id.msgId);

        // A second admission of a message the page ended ends it again before it returns.
        await page.runtime.enqueueIfAbsent(message);

        expect(await readEndMessageRow(page.stores, message.id.msgId)).toEqual(first);
    });

    it('performs exactly one IndexedDB write to retain the end', async () => {
        const { page, message } = await openPageWithHeldSend('retain-count', 1);
        page.observer.reset();

        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await page.runtime.dispose();

        const counts = page.observer.getCounts();
        expect((counts.byKind.write ?? 0) + (counts.byKind['work-write'] ?? 0)).toBe(1);
        expect(await readEndMessageStatus(openPageOwner(page.dbName, NAMESPACE), message.id.msgId))
            .toBe(EntityStatus.NEW);
    });

    it('runs the end before a queued copy of its message in the same batch of a reloaded page', async () => {
        const { page, claims, message } = await openPageWithHeldSend('batch-order', 1);
        page.runtime.cancel(message.id.msgId, message.id.traceId);
        await vi.waitFor(async () => expect(await readEndMessageStatus(page, message.id.msgId)).toBe(EntityStatus.NEW));
        await claims.release(page.runtime);

        const reloaded = await reloadPage(page);
        await runOutboundWorkTask(reloaded.runtime);

        expect(await readSendGuardKind(reloaded.stores, message)).toBe('ended');
        expect([...page.sent, ...reloaded.sent]).toEqual([]);
    });
});

describe('an end-message row that cannot run harms nothing', () => {
    it('completes an expired row without ending a message that still sends', async () => {
        const page = openPageOwner(`end-expired-${crypto.randomUUID()}`, NAMESPACE);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-end-expired');
        await page.runtime.enqueueIfAbsent(message);
        await page.stores.workQueue.enqueueIfAbsent(computeALOutboundWorkEntry({
            namespace: NAMESPACE,
            effectId: toALOutboundEndMessageEffectId(message.id.msgId),
            payload: { kind: 'end-message', msgId: message.id.msgId, admissionEffectId: null },
            observedAtMs: Date.now() - 2,
            retryAtMs: 0,
            expireAtTimestamp: Date.now() - 1
        }));

        await claims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(await readSendGuardKind(page.stores, message)).toBe('current');
        expect(page.sent).toEqual([message.id.msgId]);
    });

    it('rejects a row whose identity names another message, and the message still sends', async () => {
        const page = openPageOwner(`end-undecodable-${crypto.randomUUID()}`, NAMESPACE);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-end-undecodable');
        await page.runtime.enqueueIfAbsent(message);
        const effectId = toALOutboundEndMessageEffectId('another-message');
        await page.stores.workQueue.enqueueIfAbsent(computeALOutboundWorkEntry({
            namespace: NAMESPACE,
            effectId,
            payload: { kind: 'end-message', msgId: message.id.msgId, admissionEffectId: null },
            observedAtMs: Date.now(),
            retryAtMs: 0,
            expireAtTimestamp: Date.now() + 30_000
        }));

        await claims.release(page.runtime);
        await drainOutboundWorkDueNow(page.runtime, page.stores);

        expect(await readSendGuardKind(page.stores, message)).toBe('current');
        expect((await readEndMessageRow(page.stores, 'another-message'))?.status).toBe(EntityStatus.NON_RETRYABLE);
        expect(page.sent).toEqual([message.id.msgId]);
    });
});

describe('a conflicting end in a tab that does not own the session durable work', () => {
    it('leaves the row, and the owning tab ends the message and sends nothing for it', async () => {
        const session = createOutboundTestSession();
        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        const message = createOutboundMessage('durable-other-tab-conflict');
        await other.runtime.enqueueIfAbsent(message);
        vi.spyOn(other.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        other.runtime.cancel(message.id.msgId, message.id.traceId);
        await other.runtime.dispose();
        expect((await readEndMessageRow(other.stores, message.id.msgId))?.status).toBe(EntityStatus.NEW);
        relayAnnouncedCommits(other, owner);
        await waitForOutboundWorkDrained(owner.stores);

        expect(await readSendGuardKind(owner.stores, message)).toBe('ended');
        expect([...owner.sent, ...other.sent]).toEqual([]);
    });

    it('leaves the row for an owner that reloads, which ends the message and sends nothing for it', async () => {
        const session = createOutboundTestSession();
        const previous = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        await previous.runtime.ready();
        await previous.runtime.dispose();
        const other = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(false));
        const message = createOutboundMessage('durable-owner-reload-conflict');
        await other.runtime.enqueueIfAbsent(message);
        vi.spyOn(other.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');
        other.runtime.cancel(message.id.msgId, message.id.traceId);
        await other.runtime.dispose();

        const owner = createSessionOutboundTestRuntime(session, createTestDurableWorkOwnership(true));
        await owner.runtime.ready();
        await waitForOutboundWorkDrained(owner.stores);

        expect(await readSendGuardKind(owner.stores, message)).toBe('ended');
        expect([...previous.sent, ...owner.sent, ...other.sent]).toEqual([]);
    });
});
