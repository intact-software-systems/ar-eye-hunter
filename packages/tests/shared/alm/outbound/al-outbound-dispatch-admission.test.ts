import { Temporal } from '@js-temporal/polyfill';
import {
    afterEach,
    expect,
    it,
    vi
} from 'vitest';

import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestStores,
    createOutboundMessage,
    OUTBOUND_TEST_SEND_PLANNER
} from '../outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from '../outbound-test-payload.ts';

interface DispatchFixture {
    readonly admission: ALOutboundDispatchAdmission<OutboundTestPayload>;
    readonly store: ALOutboundAdmissionStore<OutboundTestPayload>;
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
}

afterEach(() => vi.restoreAllMocks());

function createDispatchFixture(): DispatchFixture {
    const stores = createDefaultOutboundTestStores();
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const admission = new ALOutboundDispatchAdmission({
        lane: 'durable',
        admissionStore: stores.admissionStore,
        workPort: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
        toOutboxEntry: (msg) => QueueBoxUtilities.toResourceEntryFromMsg(msg, 'outbox', Temporal.Now.instant()),
        decodePreparedMessage: decodeOutboundTestPayload,
        clock: { nowMs: Date.now },
        browserLocks: undefined,
        diagnostics: (event) => diagnostics.push(event),
        settlements: () => {}
    });
    return { admission, store: stores.admissionStore, diagnostics };
}

function toDispatch(msg: ALMessage): ALOutboundDispatchAdmission.Input<OutboundTestPayload> {
    return { msg, planner: OUTBOUND_TEST_SEND_PLANNER, intent: 'enqueue', phase: 'immediate', origin: 'send', options: {} };
}

it('makes bounded independent read progress through a burst before committing in input order and admitting a late send', async () => {
    const { admission, store } = createDispatchFixture();
    const messages = Array.from({ length: 5 }, (_, index) => ({
        ...createOutboundMessage(`burst-${index}`),
        targets: { mode: 'unicast' as const, toPeerId: `peer-${index}` }
    }));
    const gates = messages.map(() => Promise.withResolvers<void>());
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const readOutgoingMessage = store.readOutgoingMessage.bind(store);
    vi.spyOn(store, 'readOutgoingMessage').mockImplementation(async (input) => {
        const index = messages.findIndex((message) => message.id.msgId === input.msg.id.msgId);
        started.push(index);
        active += 1;
        peak = Math.max(peak, active);
        try {
            await gates[index]!.promise;
            return await readOutgoingMessage(input);
        }
        finally {
            active -= 1;
        }
    });
    const writes: number[] = [];
    const commitBundles = store.commitBundles.bind(store);
    vi.spyOn(store, 'commitBundles').mockImplementation(async (bundles) => {
        writes.push(active);
        return await commitBundles(bundles);
    });
    const group = admission.commitAllSettled(messages.map(toDispatch));
    const late = admission.commit(toDispatch(createOutboundMessage('late-promotion')));
    const lateRead = vi.spyOn(store, 'readOutgoingDecision');

    try {
        await expect.poll(() => started).toEqual([0, 1]);
        expect(writes).toEqual([]);
        expect(lateRead).not.toHaveBeenCalled();
        for (let index = 1; index < messages.length; index += 1) {
            gates[index]!.resolve();
            if (index + 1 < messages.length) {
                await expect.poll(() => started.length).toBe(index + 2);
            }
        }
        await expect.poll(() => active).toBe(1);
        expect(writes).toEqual([]);
        expect(lateRead).not.toHaveBeenCalled();
        gates[0]!.resolve();
        const results = await group;
        expect(peak).toBe(2);
        expect(writes).toEqual([0]);
        expect(results.map((result) => result.status === 'fulfilled' && result.value.committed)).toEqual([true, true, true, true, true]);
        expect(results.map((result) => result.status === 'fulfilled' && result.value.computed.msg)).toEqual(messages);
        expect((await late).committed).toBe(true);
        for (const message of messages) {
            const read = await readOutgoingMessage({ msg: message, planner: OUTBOUND_TEST_SEND_PLANNER, observedCanonicalEntry: undefined, intent: 'enqueue' });
            expect(read.storedMessage?.msgId).toBe(message.id.msgId);
            expect(read.msg).toEqual(message);
        }
    }
    finally {
        gates.forEach((gate) => gate.resolve());
        await Promise.allSettled([group, late]);
        admission.dispose();
    }
});

it.each(['rejected', 'settled'] as const)(
    'waits for every group read after a %s member before fresh ordered fallback, preserving individual results',
    async (mode) => {
        const { admission, store } = createDispatchFixture();
        const first = createOutboundMessage('first');
        const held = createOutboundMessage('held');
        const broken = createOutboundMessage('broken');
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const firstFinished = Promise.withResolvers<void>();
        const readOutgoingMessage = store.readOutgoingMessage.bind(store);
        const completed: string[] = [];
        vi.spyOn(store, 'readOutgoingMessage').mockImplementation(async (input) => {
            if (input.msg.id.msgId === first.id.msgId) {
                await entered.promise;
                firstFinished.resolve();
                if (mode === 'rejected') {
                    throw new Error('intermittent read failure');
                }
            }
            if (input.msg.id.msgId === held.id.msgId) {
                entered.resolve();
                await release.promise;
            }
            try {
                return await readOutgoingMessage(input);
            }
            finally {
                completed.push(input.msg.id.msgId);
            }
        });
        const fallback = vi.spyOn(store, 'readOutgoingDecision');
        const writes = vi.spyOn(store, 'commitBundles');
        const firstDispatch = mode === 'settled'
            ? {
                ...toDispatch(first),
                planner: (msg: ALMessage) => ({
                    msg,
                    dropReason: 'Skipping unauthorized test member',
                    dropReasonCode: 'unauthorized' as const,
                    lane: 'durable' as const,
                    preparedMessages: []
                })
            }
            : toDispatch(first);
        const brokenDispatch = {
            ...toDispatch(broken),
            planner: () => {
                throw new Error('broken member');
            }
        };
        const group = admission.commitAllSettled([firstDispatch, toDispatch(held), brokenDispatch]);

        try {
            await expect.poll(() => completed.includes(broken.id.msgId)).toBe(true);
            await firstFinished.promise;
            expect(fallback).not.toHaveBeenCalled();
            expect(writes).not.toHaveBeenCalled();
            release.resolve();
            const results = await group;
            expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
            expect(results[0]).toMatchObject({ value: { committed: mode === 'rejected' } });
            expect(results[1]).toMatchObject({ value: { committed: true, computed: { msg: held } } });
            expect(results[2]).toMatchObject({ reason: new Error('broken member') });
            expect(fallback.mock.calls.map(([input]) => input.msg.id.msgId)).toEqual([first.id.msgId, held.id.msgId, broken.id.msgId]);
            expect((await admission.commit(toDispatch(createOutboundMessage('subsequent')))).committed).toBe(true);
        }
        finally {
            entered.resolve();
            release.resolve();
            await group;
            admission.dispose();
        }
    }
);

it('serializes each sender in arrival order, releases failure, and forgets idle queues while other senders progress', async () => {
    const { admission, store, diagnostics } = createDispatchFixture();
    const first = createOutboundMessage('failing-first');
    const second = createOutboundMessage('second');
    const third = createOutboundMessage('third');
    const other = createOutboundMessage('other');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const readOutgoingDecision = store.readOutgoingDecision.bind(store);
    const reads: string[] = [];
    vi.spyOn(store, 'readOutgoingDecision').mockImplementation(async (input, decide) => {
        reads.push(input.msg.id.msgId);
        if (input.msg.id.msgId === first.id.msgId) {
            entered.resolve();
            await release.promise;
            throw new Error('first failed');
        }
        return await readOutgoingDecision(input, decide);
    });
    const firstResult = Promise.allSettled([admission.commit({ ...toDispatch(first), origin: 'drain' })]);
    await entered.promise;
    const next = [second, third].map((msg) => admission.commit(toDispatch(msg)));
    try {
        const independent = await admission.commit(toDispatch({ ...other, id: { ...other.id, senderId: 'other-sender' } }));
        expect(independent.committed).toBe(true);
        expect(reads).toEqual([first.id.msgId, other.id.msgId]);
        release.resolve();
        expect((await firstResult)[0]).toMatchObject({ status: 'rejected', reason: new Error('first failed') });
        expect((await Promise.all(next)).map((result) => result.committed)).toEqual([true, true]);
        expect(reads).toEqual([first.id.msgId, other.id.msgId, second.id.msgId, third.id.msgId]);
        expect((await admission.commit(toDispatch(createOutboundMessage('reuse')))).committed).toBe(true);
        expect(
            diagnostics.filter((event) => event.kind === 'sender-queue-wait').filter((event) => event.senderId === 'self').map((event) => ({
                origin: event.origin,
                queued: event.queued,
                queuedBehindOrigin: event.queuedBehindOrigin
            }))
        ).toEqual([
            { origin: 'drain', queued: false, queuedBehindOrigin: 'none' },
            { origin: 'send', queued: true, queuedBehindOrigin: 'drain' },
            { origin: 'send', queued: true, queuedBehindOrigin: 'send' },
            { origin: 'send', queued: false, queuedBehindOrigin: 'none' }
        ]);
    }
    finally {
        release.resolve();
        await Promise.allSettled([firstResult, ...next]);
        admission.dispose();
    }
});
