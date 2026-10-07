import { describe, expect, it, vi } from 'vitest';

import { newALBroadcastMessage, newALRoute, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import {
    computeOutboundTestAdmission,
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    OUTBOUND_TEST_SEND_PLANNER,
    runOutboundWorkTask,
    waitForOutboundWorkDrained,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };

/** The WS server's own publication: one durable copy, and the track's next sequence for a key without one. */
const MINTING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
    mintsSequence: true
});

interface MintingRuntime {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly sent: ALMessage[];
}

describe('outbound sequence minting', () => {
    it('mints 1, 2, 3 on one track and starts another key or another epoch at 1', async () => {
        const { runtime } = createMintingRuntime(createDefaultOutboundTestStores());

        expect(await enqueueMintedSeq(runtime, createRoundEvent('a-1', { orderingKey: 'game-1', epoch: 1 }))).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('a-2', { orderingKey: 'game-1', epoch: 1 }))).toBe(2);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('a-3', { orderingKey: 'game-1', epoch: 1 }))).toBe(3);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('b-1', { orderingKey: 'game-2', epoch: 1 }))).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('c-1', { orderingKey: 'game-1', epoch: 2 }))).toBe(1);
    });

    it('keeps the sequence of an admitted message when the same message is admitted again', async () => {
        const { runtime } = createMintingRuntime(createDefaultOutboundTestStores());
        const message = createRoundEvent('again', { orderingKey: 'game-1', epoch: 1 });

        expect(await enqueueMintedSeq(runtime, message)).toBe(1);
        const repeated = await runtime.enqueueIfAbsent(message);

        expect(repeated.verdict.kind).toBe('duplicate');
        expect(repeated.message.ordering?.seq).toBe(1);
        expect(await enqueueMintedSeq(runtime, createRoundEvent('next', { orderingKey: 'game-1', epoch: 1 }))).toBe(2);
    });

    it('stores, indexes and sends the minted message', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent } = createMintingRuntime(stores);
        const message = createRoundEvent('stored', { orderingKey: 'game-1', epoch: 3 });

        await runtime.enqueueIfAbsent(message);
        await runOutboundWorkTask(runtime);
        const stored = await stores.admissionStore.readSentMessage(message.id.msgId);

        expect(stored?.msg.ordering).toEqual({ orderingKey: 'game-1', epoch: 3, seq: 1 });
        expect((await stores.admissionStore.readSentMessageByOrdering(toALOrderingTrackKey(stored!.msg)!, 1))?.msgId)
            .toBe(message.id.msgId);
        expect(sent.map((frame) => frame.ordering)).toEqual([{ orderingKey: 'game-1', epoch: 3, seq: 1 }]);
    });

    it('continues the track where the store stands when a new runtime opens it', async () => {
        const stores = createDefaultOutboundTestStores();
        const first = createMintingRuntime(stores).runtime;
        for (const name of ['before-1', 'before-2', 'before-3']) {
            await enqueueMintedSeq(first, createRoundEvent(name, { orderingKey: 'game-1', epoch: 1 }));
        }
        first.dispose();

        const restarted = createMintingRuntime(stores).runtime;

        expect(await enqueueMintedSeq(restarted, createRoundEvent('after', { orderingKey: 'game-1', epoch: 1 }))).toBe(4);
    });

    it('a conflicting mint never reuses a sequence: the replay of its pending admission mints the next one', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent } = createMintingRuntime(stores);
        const late = createRoundEvent('late', { orderingKey: 'game-1', epoch: 1 });
        const early = createRoundEvent('early', { orderingKey: 'game-1', epoch: 1 });
        interleaveAfterFirstDecisionRead(stores, async () => {
            const bundle = await computeOutboundTestAdmission(stores.admissionStore, early, MINTING_PLANNER);
            expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        });

        const result = await runtime.enqueueIfAbsent(late);

        expect(result.verdict.kind).toBe('pending');
        expect(result.message.ordering?.seq).toBeUndefined();
        expect(await stores.admissionStore.readSentMessage(late.id.msgId)).toBeUndefined();
        expect((await readCanonicalMessage(stores, late)).ordering).toEqual({ orderingKey: 'game-1', epoch: 1 });

        await runOutboundWorkTask(runtime);
        await waitForOutboundWorkDrained(stores);

        expect((await stores.admissionStore.readSentMessage(early.id.msgId))?.msg.ordering?.seq).toBe(1);
        expect((await stores.admissionStore.readSentMessage(late.id.msgId))?.msg.ordering?.seq).toBe(2);
        expect((await readCanonicalMessage(stores, late)).ordering?.seq).toBe(2);
        expect(sent.map((frame) => [frame.id.msgId, frame.ordering?.seq]))
            .toEqual(expect.arrayContaining([[early.id.msgId, 1], [late.id.msgId, 2]]));
        expect(sent).toHaveLength(2);
    });

    it('answers a second admission of a still-pending minting message with the request, not a sequence', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createMintingRuntime(stores);
        const late = createRoundEvent('late', { orderingKey: 'game-1', epoch: 1 });
        const early = createRoundEvent('early', { orderingKey: 'game-1', epoch: 1 });
        interleaveAfterFirstDecisionRead(stores, async () => {
            const bundle = await computeOutboundTestAdmission(stores.admissionStore, early, MINTING_PLANNER);
            expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        });
        expect((await runtime.enqueueIfAbsent(late)).verdict.kind).toBe('pending');

        const again = await runtime.enqueueIfAbsent(late);

        expect(again.verdict.kind).toBe('pending');
        expect(again.message.ordering?.seq).toBeUndefined();
        expect(again.entries).toHaveLength(1);
        expect(decodePersistedALMessage(again.entries[0]!.resource).ordering).toEqual({ orderingKey: 'game-1', epoch: 1 });
    });

    it('mints nothing for a plan that does not ask for a sequence', async () => {
        const stores = createDefaultOutboundTestStores();
        const runtime = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const message = createRoundEvent('keyed-unsequenced', { orderingKey: 'game-1', epoch: 1 });

        const result = await runtime.enqueueIfAbsent(message);

        expect(result.verdict.kind).toBe('admitted');
        expect(result.message.ordering?.seq).toBeUndefined();
        expect((await stores.admissionStore.readSentMessage(message.id.msgId))?.msg.ordering?.seq).toBeUndefined();
    });
});

function createRoundEvent(name: string, ordering: Readonly<{ orderingKey: string; epoch: number; }>): ALMessage {
    return newALBroadcastMessage(
        'server',
        newALRoute('room.app.event', ROOM.groupId, name),
        'room',
        'app.event.v1',
        { name },
        { groupRef: ROOM, ttlMs: 60_000, ordering }
    );
}

function createMintingRuntime(stores: OutboundTestStores): MintingRuntime {
    const sent: ALMessage[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: MINTING_PLANNER,
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { runtime, sent };
}

async function enqueueMintedSeq(
    runtime: ALOutboundMessageRuntime<OutboundTestPayload>,
    message: ALMessage
): Promise<number | undefined> {
    const result = await runtime.enqueueIfAbsent(message);
    expect(result.verdict.kind).toBe('admitted');
    return result.message.ordering?.seq;
}

/**
 * Lets `interleaved` commit right after the next decision read, so that read's commit finds the sender moved.
 * It commits through the store, as another instance would: a second runtime here would wait on the sender's lock.
 */
function interleaveAfterFirstDecisionRead(stores: OutboundTestStores, interleaved: () => Promise<void>): void {
    const store = stores.admissionStore;
    const readOutgoingDecision = store.readOutgoingDecision.bind(store);
    vi.spyOn(store, 'readOutgoingDecision').mockImplementationOnce(async (input, decide) => {
        const observed = await readOutgoingDecision(input, decide);
        await interleaved();
        return observed;
    });
}

/** The canonical row the outbound keeps for a message: a retained admission's before its replay, the admitted one after. */
async function readCanonicalMessage(stores: OutboundTestStores, message: ALMessage): Promise<ALMessage> {
    const entry = await stores.workQueue.getItem(toALOutboundCanonicalKey(stores.admissionStore.canonicalScope, message));
    if (entry === undefined) {
        throw new Error(`Expected a canonical row for ${message.id.msgId}`);
    }
    return decodePersistedALMessage(entry.resource);
}
