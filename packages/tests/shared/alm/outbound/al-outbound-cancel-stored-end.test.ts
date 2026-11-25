import {
    beforeEach,
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import { createOutboundMessage, holdOutboundClaims, waitForOutboundWorkDrained } from '../outbound-runtime-test-fixture.ts';
import {
    createOutboundTestSession,
    createSessionOutboundTestRuntime,
    createTestDurableWorkOwnership
} from '../session-outbound-test-runtime.ts';
import {
    openPageOwner,
    readSendGuardKind,
    relayAnnouncedCommits
} from './message-end/outbound-page-owner-fixture.ts';

const NAMESPACE = 'cancel-stored-end';

beforeEach(() =>
    onTestFinished(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    })
);

describe('a cancel ends its message in the store that holds it', () => {
    it('is joined by dispose, so the stored message is ended once the page has gone', async () => {
        const page = openPageOwner(`cancel-dispose-${crypto.randomUUID()}`, NAMESPACE);
        const claims = holdOutboundClaims(page.stores);
        const message = createOutboundMessage('durable-cancel-dispose');
        await page.runtime.enqueueIfAbsent(message);

        expect(page.runtime.cancel(message.id.msgId, message.id.traceId)).toBe('cancelled');
        await claims.release(page.runtime);
        await page.runtime.dispose();

        const reopened = openPageOwner(page.dbName, NAMESPACE);
        expect(await readSendGuardKind(reopened.stores, message)).toBe('ended');
    });

    it('writes nothing to storage for a message the owner never admitted', async () => {
        const page = openPageOwner(`cancel-unknown-${crypto.randomUUID()}`, NAMESPACE);
        await page.runtime.ready();
        page.observer.reset();

        page.runtime.cancel('never-admitted', 'trace-never-admitted');
        await page.runtime.dispose();

        expect(page.observer.getCounts().byKind.write ?? 0).toBe(0);
        expect(page.observer.getCounts().byKind['work-write'] ?? 0).toBe(0);
    });

    it('ends a volatile message in its memory pair without an IndexedDB operation', async () => {
        const page = openPageOwner(`cancel-volatile-${crypto.randomUUID()}`, NAMESPACE);
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
