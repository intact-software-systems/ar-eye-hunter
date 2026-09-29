import { createTestALOutboundWorkPort } from '@shared-test/shared/create-test-al-outbound-work-port.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALOutboundPendingAckSnapshot } from '@shared/alm/al-runtime-state-stores.ts';
import type { ALOutboundSettlementFact } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundRepairAdmission } from '@shared/alm/outbound/al-outbound-repair-admission.ts';
import { RetryableConflictError } from '@shared/resilience/TryWith.ts';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestStores,
    createOutboundMessage,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

interface ExhaustionFixture {
    readonly stores: OutboundTestStores;
    readonly message: ALMessage;
    readonly repair: ALOutboundRepairAdmission<OutboundTestPayload>;
    readonly facts: ALOutboundSettlementFact[];
}

type ReceiptRow = Omit<ALOutboundPendingAckSnapshot, 'msgId'>;

/** A `hop` receipt on two next hops, one confirmed, whose current window already closed. */
const SPENT_RECEIPT: ReceiptRow = {
    mode: 'hop',
    expectedPeerIds: ['peer-1', 'peer-2'],
    ackedPeerIds: ['peer-1'],
    timeoutMs: 2_000,
    maxAttempts: 3,
    attempts: 3,
    deadlineAtMs: 900
};

async function createExhaustionFixture(receipt: ReceiptRow): Promise<ExhaustionFixture> {
    const stores = createDefaultOutboundTestStores();
    const message = createOutboundMessage('receipt-exhaustion');
    const bundle = await computeOutboundTestAdmission(stores.admissionStore, message);
    await stores.admissionStore.commitBundle({
        ...bundle,
        mutations: [...bundle.mutations, {
            kind: 'set-pending-ack',
            originPeerId: message.id.senderId,
            snapshot: { msgId: message.id.msgId, ...receipt },
            expireAtTimestamp: message.constraints!.expiresAtMs!
        }]
    });
    const facts: ALOutboundSettlementFact[] = [];
    const clock = { nowMs: Date.now };
    const repair = new ALOutboundRepairAdmission({
        admissionStore: stores.admissionStore,
        controlAdmission: stores.admissionStore.createControlAdmission({
            port: createTestALOutboundWorkPort({ ...stores, nowMs: Date.now }),
            clock,
            settlements: (fact) => facts.push(fact),
            carrier: 'rtc'
        }),
        clock,
        planOutgoingMessage: (msg) => ({
            msg,
            dropReasonCode: undefined,
            persist: true,
            preparedMessages: []
        }),
        planRepairMessage: undefined,
        diagnostics: undefined,
        settlements: (fact) => facts.push(fact)
    });
    return { stores, message, repair, facts };
}

async function readReceipt(
    fixture: ExhaustionFixture
): Promise<ALOutboundPendingAckSnapshot | undefined> {
    return await fixture.stores.admissionStore.readPendingAck({
        originPeerId: fixture.message.id.senderId,
        msgId: fixture.message.id.msgId
    });
}

describe('the receipt budget runs out (Q6)', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('states receipt-exhausted once and deletes the row in the commit that states it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture(SPENT_RECEIPT);

        await fixture.repair.retryPendingAck(fixture.message.id.msgId);
        await fixture.repair.retryPendingAck(fixture.message.id.msgId);

        expect(fixture.facts).toEqual([{
            kind: 'receipt-exhausted',
            msgId: fixture.message.id.msgId,
            mode: 'hop',
            confirmedPeerIds: ['peer-1'],
            unconfirmedPeerIds: ['peer-2'],
            cause: 'budget',
            detail: 'The receipt ran out of retries after 3 of 3.'
        }]);
        expect(await readReceipt(fixture)).toBeUndefined();
    });

    it('states nothing and keeps the row when the exhaustion commit conflicts, so the retried work settles it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture(SPENT_RECEIPT);
        vi.spyOn(fixture.stores.admissionStore, 'commitBundle').mockResolvedValueOnce('conflict');

        await expect(fixture.repair.retryPendingAck(fixture.message.id.msgId)).rejects
            .toBeInstanceOf(RetryableConflictError);

        expect(fixture.facts).toEqual([]);
        expect(await readReceipt(fixture)).toBeDefined();
    });

    it('ends a receipt without retries at its first closed window', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture({
            ...SPENT_RECEIPT,
            maxAttempts: 0,
            attempts: 0
        });

        await fixture.repair.retryPendingAck(fixture.message.id.msgId);

        expect(fixture.facts.map((fact) => fact.kind)).toEqual(['receipt-exhausted']);
    });

    it('keeps retrying inside the budget and states nothing', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(1_000);
        const fixture = await createExhaustionFixture({ ...SPENT_RECEIPT, attempts: 1 });

        await fixture.repair.retryPendingAck(fixture.message.id.msgId);

        expect(fixture.facts).toEqual([]);
        expect((await readReceipt(fixture))?.attempts).toBe(2);
    });
});
