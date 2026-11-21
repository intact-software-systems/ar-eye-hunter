import { Temporal } from '@js-temporal/polyfill';
import {
    describe,
    expect,
    it,
    onTestFinished,
    vi
} from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { AL_MESSAGE_RESOURCE_LIMITS } from '@shared/al-contracts/al-message-resource-limits.ts';
import type {
    ALOutboundPendingAckSnapshot,
    ALOutboundRepairAttemptSnapshot
} from '@shared/alm/al-runtime-state-stores.ts';
import type {
    ALOutboundAdmissionStore,
    ALOutboundCommitBundle,
    ALOutboundMessageReadDto,
    ALOutboundPlanner
} from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeALOutboundRepairAttempt } from '@shared/alm/outbound/admission/al-outbound-admission-validation.ts';
import { ALOutboundDispatchAdmission } from '@shared/alm/outbound/al-outbound-dispatch-admission.ts';
import {
    computeALOutboundDispatch,
    toALOutboundCommitSettlements,
    type ALOutboundComputedDto,
    type ALOutboundComputeIntent
} from '@shared/alm/outbound/compute-al-outbound-dispatch.ts';
import {
    toALOutboundAckTimeoutEffectId,
    toALOutboundRepairRequesterKey
} from '@shared/alm/outbound/to-al-outbound-effect-id.ts';
import { validateALOutboundDispatch } from '@shared/alm/outbound/validate-al-outbound-dispatch.ts';
import { QueueBoxUtilities } from '@shared/services/queue-box-utilities.ts';

import {
    createDefaultOutboundTestStores,
    createOutboundCanonicalEntry,
    createOutboundMessage,
    peekOutboundWorkReadyAt,
    readOutboundTestAdmission
} from './outbound-runtime-test-fixture.ts';
import { decodeOutboundTestPayload, type OutboundTestPayload } from './outbound-test-payload.ts';

describe('outbound dispatch value ownership', () => {
    it('creates a canonical row at the millisecond of the explicitly captured instant', () => {
        const stores = createDefaultOutboundTestStores();
        const message = createOutboundMessage('explicit-creation-instant');
        const createdAt = Temporal.Instant.from('2026-01-01T23:59:59.123456789Z');

        const entry = createOutboundCanonicalEntry(stores.admissionStore, message, createdAt);

        expect(entry.audit.createdTs.toString()).toBe('2026-01-01T23:59:59.123');
        expect(entry.audit.date.toString()).toBe('23:59:59.123');
    });

    it.each([
        { dispatchAtMs: 1_999, expired: false },
        { dispatchAtMs: 2_000, expired: true }
    ])('captures separate creation and dispatch clocks after a paused read at $dispatchAtMs', async ({ dispatchAtMs, expired }) => {
        vi.useFakeTimers({ toFake: ['Date'], now: 1_000 });
        onTestFinished(() => {
            vi.useRealTimers();
        });
        const stores = createDefaultOutboundTestStores();
        const message = createOutboundMessage('deferred-clock', { ttlMs: 1_000 });
        const captured = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<void>();
        let createdAt = Temporal.Instant.from('2026-01-01T00:00:00.000000001Z');
        let nowMs = 1_000;
        const read = stores.admissionStore.readOutgoingMessage.bind(stores.admissionStore);
        const observedRead = vi.spyOn(stores.admissionStore, 'readOutgoingMessage').mockImplementation(async (input) => {
            const result = await read(input);
            captured.resolve();
            await resume.promise;
            return result;
        });
        onTestFinished(() => observedRead.mockRestore());
        const pending = readOutboundTestAdmission({
            store: stores.admissionStore,
            message,
            creationNow: () => createdAt,
            clock: { nowMs: () => nowMs }
        });
        onTestFinished(async () => {
            resume.resolve();
            await Promise.allSettled([pending]);
        });
        await captured.promise;
        createdAt = Temporal.Instant.from('2026-01-01T23:59:59.123456789Z');
        nowMs = dispatchAtMs;
        resume.resolve();

        if (expired) {
            await expect(pending).rejects.toThrow('Expected outbound admission, received expired');
        }
        else {
            const bundle = await pending;
            expect(bundle.canonicalEntry?.audit.createdTs.toString()).toBe('2026-01-01T23:59:59.123');
            expect(bundle.canonicalEntry?.audit.expiryTs.epochMilliseconds).toBe(2_000);
        }
        expect(Date.now()).toBe(1_000);
    });

    it('rejects a mismatched queue resource before admitting message ownership or work', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('intended-message');
        const wrongEntry = QueueBoxUtilities.toResourceEntryFromMsg(createOutboundMessage('other-message'), 'outbox', Temporal.Now.instant());
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            lane: 'durable',
            admissionStore: store,
            toOutboxEntry: () => wrongEntry,
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            signAdmittedMessage: undefined,
            diagnostics: undefined,
            settlements: () => {}
        });

        const result = await admission.commit({
            msg: message,
            batchPredecessorSeqs: [],
            planner: () => ({ msg: message, dropReasonCode: undefined, lane: 'durable', preparedMessages: [] }),
            intent: 'enqueue',
            phase: 'immediate',
            origin: 'send',
            options: {}
        });

        expect(result.computed.verdict.kind).toBe('failed');
        expect(result.computed.reason).toBe('Outbound queue candidate differs from its message');
        expect(result.committed).toBe(false);
        expect(await store.readSentMessage(message.id.msgId)).toBeUndefined();
        expect(await peekOutboundWorkReadyAt(stores.workQueue, store.namespace)).toBeUndefined();
        admission.dispose();
    });

    it('computes from captured values and preserves the candidate through a real successful and conflicting commit', async () => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('immutable-dispatch');
        const read = await store.readOutgoingMessage({
            msg: message,
            planner: () => ({
                msg: message,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [] as readonly OutboundTestPayload[],
                supersedenceTracking: { enabled: true, algo: 'latest-wins', key: 'shared-value' }
            }),
            observedCanonicalEntry: undefined,
            intent: 'enqueue'
        });
        const outboxEntry = QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox', Temporal.Now.instant());
        const input = freezeValues({
            read,
            outboxEntry,
            dispatchAtMs: 1_000,
            intent: 'enqueue' as const,
            phase: 'immediate' as const,
            options: {}
        });

        const computed = freezeValues(computeALOutboundDispatch(input));
        expect(computed).toEqual(computeALOutboundDispatch(input));
        expect(computed.verdict).toMatchObject({ kind: 'admitted', durable: true });
        expect(computed.bundle?.canonicalEntry).toEqual(outboxEntry);
        expect(computed.bundle?.durableEffects).toEqual([]);
        if (!computed.bundle) {
            throw new Error('Durable dispatch must produce a commit candidate');
        }
        const beforeCommit = JSON.stringify(computed);
        const tampered = {
            ...computed,
            bundle: {
                ...computed.bundle,
                mutations: computed.bundle.mutations.map((mutation) =>
                    mutation.kind === 'set-supersedence-latest'
                        ? { ...mutation, expected: { kind: 'latest' as const, latestMsgId: 'unread', latestTs: 0, updatedAtMs: 0 } }
                        : mutation
                )
            }
        };
        expect(validateALOutboundDispatch(read, tampered).left).toContainEqual(expect.objectContaining({ code: 'malformed' }));

        expect(await store.commitBundle(computed.bundle)).toBe('committed');
        expect(await store.commitBundle(computed.bundle)).toBe('conflict');
        expect(JSON.stringify(computed)).toBe(beforeCommit);
        const stored = await store.readSentMessage(message.id.msgId);
        expect(JSON.stringify(stored?.msg)).toBe(JSON.stringify(message));
        expect(stored?.outboxKey).toEqual(outboxEntry.key);
    });

    it.each(['enqueue', 'dequeue'] as const)('retains the observed outbox entry instead of rebuilding it during %s', async (intent) => {
        const stores = createDefaultOutboundTestStores();
        const store = stores.admissionStore;
        const message = createOutboundMessage('observed-outbox');
        const observedOutboxEntry = freezeValues(QueueBoxUtilities.toResourceEntryFromMsg(message, 'outbox', Temporal.Now.instant()));
        const admission = new ALOutboundDispatchAdmission<OutboundTestPayload>({
            lane: 'durable',
            admissionStore: store,
            toOutboxEntry: () => {
                throw new Error('Captured entries must not be rebuilt');
            },
            decodePreparedMessage: decodeOutboundTestPayload,
            clock: { nowMs: Date.now },
            browserLocks: undefined,
            signAdmittedMessage: undefined,
            diagnostics: undefined,
            settlements: () => {}
        });
        const result = await admission.commit({
            msg: message,
            batchPredecessorSeqs: [],
            planner: () => ({
                msg: message,
                dropReasonCode: undefined,
                lane: 'durable',
                preparedMessages: [{ resourceId: message.route.resourceId }]
            }),
            intent,
            phase: intent === 'enqueue' ? 'immediate' : 'dequeue',
            origin: intent === 'enqueue' ? 'send' : 'drain',
            options: { observedOutboxEntry }
        });
        expect(result.committed).toBe(true);
        expect(result.computed.verdict).toMatchObject({ kind: 'admitted', durable: true });
        if (intent === 'enqueue') {
            expect(result.computed.entries).toEqual([{ ...observedOutboxEntry, status: 'COMPLETED' }]);
            expect(result.computed.entries[0].resource).toBe(observedOutboxEntry.resource);
        }
        expect(result.computed.bundle?.durableEffects[0].expireAtTimestamp).toBe(observedOutboxEntry.audit.expiryTs.epochMilliseconds);
        admission.dispose();
    });

    it('uses the fresh repair count to stop an exhausted repair without creating work: its bundle ends the message', async () => {
        const message = createOutboundMessage('exhausted-repair');
        const { store, read: observed } = await readAdmittedMessage(message, toVolatilePlanner(message, 'exhausted-repair'));
        const read: ALOutboundMessageReadDto<OutboundTestPayload> = freezeValues({
            ...observed,
            repairAttempt: { msgId: message.id.msgId, attemptsByRequester: { 'peer-1': 3 } }
        });

        const computed = computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg, Temporal.Now.instant()),
            dispatchAtMs: 1_000,
            intent: 'repair',
            phase: 'immediate',
            options: { repairBudget: { requesterKey: 'peer-1', maxAttempts: 3 } }
        });

        expect(computed.verdict.kind).toBe('skipped');
        expect(computed.bundle?.mutations).toEqual([
            { kind: 'delete-repair-attempt', msgId: message.id.msgId },
            { kind: 'end-sent-message', stored: read.storedMessage }
        ]);
        expect(computed.bundle?.endedTimeoutEffectIds).toEqual([]);
        expect(computed.bundle?.durableEffects).toEqual([]);
        expect(computed.entries).toEqual([]);
    });
});

describe('the repair budget a dispatch charges', () => {
    const message = createOutboundMessage('per-requester-repair');
    const msgId = message.id.msgId;

    async function createRepairCharge(): Promise<
        (attemptsByRequester: Readonly<Record<string, number>>, requesterKey: string, maxAttempts?: number) => ALOutboundComputedDto<OutboundTestPayload>
    > {
        const { store, read: observed } = await readAdmittedMessage(message, toVolatilePlanner(message, 'per-requester-repair'));
        return (attemptsByRequester, requesterKey, maxAttempts = 4) =>
            computeALOutboundDispatch({
                read: freezeValues({ ...observed, repairAttempt: { msgId, attemptsByRequester } }),
                outboxEntry: createOutboundCanonicalEntry(store, observed.msg, Temporal.Now.instant()),
                dispatchAtMs: 1_000,
                intent: 'repair',
                phase: 'immediate',
                options: { repairBudget: { requesterKey, maxAttempts } }
            });
    }

    function toChargedRow(computed: ALOutboundComputedDto<OutboundTestPayload>): ALOutboundRepairAttemptSnapshot | undefined {
        const charge = computed.bundle?.mutations.find((mutation) => mutation.kind === 'set-repair-attempt');
        return charge?.kind === 'set-repair-attempt' ? charge.snapshot : undefined;
    }

    it('charges a new requester its first attempt beside the others', async () => {
        const charge = await createRepairCharge();

        expect(toChargedRow(charge({ 'peer-1': 4 }, 'peer-2'))).toEqual({ msgId, attemptsByRequester: { 'peer-1': 4, 'peer-2': 1 } });
    });

    it('refuses a new requester past the row\'s bound of requesters with a detail of its own', async () => {
        const charge = await createRepairCharge();
        const full = Object.fromEntries(
            Array.from({ length: AL_MESSAGE_RESOURCE_LIMITS.collectionEntries }, (_, index) => [`peer-${index + 3}`, 1])
        );

        expect(charge(full, 'peer-2').verdict).toEqual({
            kind: 'skipped',
            reason: 'repair-exhausted',
            detail: `The repair of ${msgId} is refused to a new requester: ${AL_MESSAGE_RESOURCE_LIMITS.collectionEntries} requesters already hold its budget.`
        });
        expect(charge(full, 'peer-3').verdict.kind).not.toBe('skipped');
    });

    it('gives a receiver one count whether its gap is reported directly or through a relay, and each receiver behind one relay its own', async () => {
        const charge = await createRepairCharge();
        const direct = toALOutboundRepairRequesterKey({ requestedByPeerId: 'member' });
        const throughRelay = toALOutboundRepairRequesterKey({ requestedByPeerId: 'relay', logicalRecipientPeerId: 'member' });
        const otherThroughRelay = toALOutboundRepairRequesterKey({ requestedByPeerId: 'relay', logicalRecipientPeerId: 'other' });
        const afterDirect = toChargedRow(charge({}, direct, 1))!;

        expect(charge(afterDirect.attemptsByRequester, throughRelay, 1).verdict).toEqual({
            kind: 'skipped',
            reason: 'repair-exhausted',
            detail: `The repair of ${msgId} ran out of retransmits after 1 of 1.`
        });
        expect(toChargedRow(charge(afterDirect.attemptsByRequester, otherThroughRelay, 1))?.attemptsByRequester)
            .toEqual({ [direct]: 1, [otherThroughRelay]: 1 });
    });

    it.each(['__proto__', 'constructor'])('charges and serves a requester named %s, an Object.prototype name, in a row that decodes', async (requester) => {
        const charge = await createRepairCharge();
        const requesterKey = toALOutboundRepairRequesterKey({ requestedByPeerId: requester });

        const first = charge({}, requesterKey);
        const row = toChargedRow(first)!;
        expect(first.bundle?.durableEffects.filter((effect) => effect.payload.kind === 'send-prepared')).toHaveLength(1);
        expect(Object.hasOwn(row.attemptsByRequester, requesterKey)).toBe(true);
        expect(Object.getPrototypeOf(row.attemptsByRequester)).toBe(Object.prototype);
        expect(Object.entries(row.attemptsByRequester)).toEqual([[requesterKey, 1]]);
        for (const stored of [JSON.parse(JSON.stringify(row)), structuredClone(row)]) {
            const decoded = decodeALOutboundRepairAttempt(stored, msgId);
            expect(Object.entries(decoded.attemptsByRequester)).toEqual([[requesterKey, 1]]);
            expect(Object.entries(toChargedRow(charge(decoded.attemptsByRequester, requesterKey))!.attemptsByRequester))
                .toEqual([[requesterKey, 2]]);
        }
    });
});

describe('a dispatch and the end of its message', () => {
    const message = createOutboundMessage('message-end-dispatch');
    const msgId = message.id.msgId;
    const RECEIPT = {
        enabled: true,
        timeoutMs: 2_000,
        maxAttempts: 3,
        expectedPeerIds: ['peer-1', 'peer-2'],
        nextHopPeerIds: ['peer-1', 'peer-2'],
        mode: 'receiver'
    } as const;
    const trackedPlanner: ALOutboundPlanner<OutboundTestPayload> = () => ({
        msg: message,
        dropReasonCode: undefined,
        lane: 'volatile',
        preparedMessages: [{ resourceId: 'message-end-dispatch' }],
        ackTracking: RECEIPT
    });
    const OPEN_RECEIPT = {
        msgId,
        mode: 'receiver',
        expectedPeerIds: ['peer-1', 'peer-2'],
        ackedPeerIds: ['peer-1'],
        outsideAudiencePeerIds: [],
        timeoutMs: 2_000,
        maxAttempts: 3,
        attempts: 0,
        deadlineAtMs: 3_000
    } as const;

    function dispatch(
        store: ALOutboundAdmissionStore<OutboundTestPayload>,
        read: ALOutboundMessageReadDto<OutboundTestPayload>,
        intent: ALOutboundComputeIntent,
        options: Parameters<typeof computeALOutboundDispatch<OutboundTestPayload>>[0]['options'] = {}
    ): ALOutboundComputedDto<OutboundTestPayload> {
        return computeALOutboundDispatch({
            read,
            outboxEntry: createOutboundCanonicalEntry(store, read.msg, Temporal.Now.instant()),
            dispatchAtMs: Date.now(),
            intent,
            phase: intent === 'dequeue' ? 'dequeue' : 'immediate',
            options
        });
    }

    /** The receipt row a dispatch's bundle writes, if it writes one. */
    function toTrackedRow(bundle: ALOutboundCommitBundle<OutboundTestPayload> | undefined): ALOutboundPendingAckSnapshot | undefined {
        const tracked = bundle?.mutations.find((mutation) => mutation.kind === 'set-pending-ack');
        return tracked?.kind === 'set-pending-ack' ? tracked.snapshot : undefined;
    }

    function toSentEnd(computed: ALOutboundComputedDto<OutboundTestPayload>): boolean | undefined {
        const sent = computed.bundle?.mutations.find((mutation) => mutation.kind === 'set-sent-message');
        return sent?.kind === 'set-sent-message' ? sent.ended : undefined;
    }

    it.each(['repair', 'dequeue'] as const)('answers a %s of an ended message skipped message-ended, with no bundle', async (intent) => {
        const { store, read } = await readAdmittedMessage(message, trackedPlanner, intent);
        const ended = freezeValues({ ...read, storedMessage: { ...read.storedMessage!, ended: true } });

        const computed = dispatch(store, ended, intent);

        expect(computed.verdict).toEqual({
            kind: 'skipped',
            reason: 'message-ended',
            detail: `Message ${msgId} has ended: nothing more is sent for it.`
        });
        expect(computed.bundle).toBeUndefined();
    });

    it('answers an enqueue of an ended message duplicate', async () => {
        const { store, read } = await readAdmittedMessage(message, trackedPlanner, 'enqueue');
        const ended = freezeValues({ ...read, storedMessage: { ...read.storedMessage!, ended: true } });

        expect(dispatch(store, ended, 'enqueue').verdict).toEqual({ kind: 'duplicate' });
    });

    it('answers a spent budget repair-exhausted with the end bundle of its read, which states nothing at its commit', async () => {
        const { store, read: observed } = await readAdmittedMessage(message, trackedPlanner);
        const read = freezeValues({
            ...observed,
            pendingAck: OPEN_RECEIPT,
            repairAttempt: { msgId, attemptsByRequester: { 'peer-1': 1 } }
        });

        const computed = dispatch(store, read, 'repair', { repairBudget: { requesterKey: 'peer-1', maxAttempts: 1 } });

        expect(computed.verdict).toMatchObject({ kind: 'skipped', reason: 'repair-exhausted' });
        expect(computed.bundle?.mutations).toEqual([
            { kind: 'delete-repair-attempt', msgId },
            { kind: 'end-sent-message', stored: read.storedMessage }
        ]);
        expect(computed.bundle?.endedTimeoutEffectIds).toEqual([toALOutboundAckTimeoutEffectId(OPEN_RECEIPT)]);
        expect(computed.bundle?.expectedVersion).toBe(read.clientRecord?.version);
        expect(toALOutboundCommitSettlements({ bundle: computed.bundle!, msg: message, read, intent: 'repair' })).toEqual([]);
    });

    it('names the first send on the receipt row an enqueue opens: `initial`, `immediate`', async () => {
        const admission = await readOutboundTestAdmission({
            store: createDefaultOutboundTestStores().admissionStore,
            message,
            creationNow: () => Temporal.Now.instant(),
            clock: { nowMs: Date.now },
            planner: trackedPlanner
        });

        expect(toTrackedRow(admission)?.firstAttempt).toEqual({ attemptIdentity: 'initial', phase: 'immediate' });
    });

    it('names its claim on the receipt row a dequeue dispatch opens', async () => {
        const { store, read: observed } = await readAdmittedMessage(message, trackedPlanner, 'dequeue');
        const read = freezeValues({ ...observed, pendingAck: undefined });

        expect(toTrackedRow(dispatch(store, read, 'dequeue', { attemptIdentity: 'claim-1' }).bundle)?.firstAttempt).toEqual({
            attemptIdentity: 'claim-1',
            phase: 'dequeue'
        });
    });

    it('writes the open row\'s own first attempt back on a repair, and none over a row that names none', async () => {
        const { store, read: observed } = await readAdmittedMessage(message, trackedPlanner);
        const firstAttempt = { attemptIdentity: 'initial', phase: 'immediate' } as const;
        const named = freezeValues({ ...observed, pendingAck: { ...OPEN_RECEIPT, firstAttempt } });
        const unnamed = freezeValues({ ...observed, pendingAck: OPEN_RECEIPT });

        expect(toTrackedRow(dispatch(store, named, 'repair', { attemptIdentity: 'repair-1' }).bundle)?.firstAttempt).toEqual(firstAttempt);
        expect(toTrackedRow(dispatch(store, unnamed, 'repair', { attemptIdentity: 'repair-1' }).bundle)).not.toHaveProperty('firstAttempt');
    });

    it('marks the sent row ended exactly on the dispatch whose tracking completes its receipt, which states that completion', async () => {
        const { store, read: observed } = await readAdmittedMessage(message, trackedPlanner);
        const read = freezeValues({
            ...observed,
            pendingAck: OPEN_RECEIPT,
            plan: { ...observed.plan, ackTracking: { ...RECEIPT, expectedPeerIds: ['peer-1'], expectedPeerIdsUpdate: 'replace' as const } }
        });

        const completing = dispatch(store, read, 'repair');

        expect(toSentEnd(completing)).toBe(true);
        expect(toALOutboundCommitSettlements({ bundle: completing.bundle!, msg: message, read, intent: 'repair' })).toEqual([
            expect.objectContaining({ kind: 'acknowledgement', msgId, complete: true })
        ]);
        const untracked = freezeValues({ ...observed, plan: { ...observed.plan, ackTracking: undefined } });
        expect(toSentEnd(dispatch(store, untracked, 'repair'))).toBe(false);
    });
});

/** One prepared copy on the volatile lane, as each repair-budget statement here plans its message. */
function toVolatilePlanner(message: ALMessage, resourceId: string): ALOutboundPlanner<OutboundTestPayload> {
    return () => ({ msg: message, dropReasonCode: undefined, lane: 'volatile', preparedMessages: [{ resourceId }] });
}

/** A message admitted and committed, then read again for a repair: the read holds its stored row, as a repair's does. */
async function readAdmittedMessage(
    message: ALMessage,
    planner: ALOutboundPlanner<OutboundTestPayload>,
    intent: ALOutboundComputeIntent = 'repair'
): Promise<{ store: ALOutboundAdmissionStore<OutboundTestPayload>; read: ALOutboundMessageReadDto<OutboundTestPayload>; }> {
    const store = createDefaultOutboundTestStores().admissionStore;
    const admission = await readOutboundTestAdmission({
        store,
        message,
        creationNow: () => Temporal.Now.instant(),
        clock: { nowMs: Date.now },
        planner
    });
    expect(await store.commitBundle(admission)).toBe('committed');
    return { store, read: await store.readOutgoingMessage({ msg: message, planner, observedCanonicalEntry: undefined, intent }) };
}

function freezeValues<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freezeValues(child);
        }
        Object.freeze(value);
    }
    return value;
}
