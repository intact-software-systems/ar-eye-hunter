import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { toALOrderingTrackKey } from '@shared/al-contracts/al-runtime.ts';
import type { ALOutboundPlanner } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { toALOutboundSentPositionKey } from '@shared/alm/outbound/admission/al-outbound-ordering-track-keys.ts';
import { decodeALOutboundTrackPositionRow } from '@shared/alm/outbound/admission/decode-al-outbound-track-position-row.ts';
import { toALOutboundCanonicalKey } from '@shared/alm/outbound/al-outbound-canonical-message.ts';
import type { ALOutboundMessageRuntime } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { Either } from '@shared/resilience/Either.ts';

import {
    createDefaultOutboundTestRuntime,
    createDefaultOutboundTestStores,
    OUTBOUND_TEST_SEND_PLANNER,
    readOutboundTestAdmission,
    runOutboundWorkTask,
    waitForOutboundWorkDrained,
    type OutboundTestStores
} from '../outbound-runtime-test-fixture.ts';
import type { OutboundTestPayload } from '../outbound-test-payload.ts';

const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' };
const NAMESPACE = 'outbound-test';
const PROOF = { alg: 'ES256', keyId: 'k'.repeat(43), signature: 'Q'.repeat(86) } as const;

/** The admission of an origin that finalizes the audience: it records every recipient the frame is frozen to. */
const RECORDING_PLANNER: ALOutboundPlanner<OutboundTestPayload> = (msg, authority) => ({
    ...OUTBOUND_TEST_SEND_PLANNER(msg, authority),
    recordsSentPositions: msg.targets?.mode === 'multicast' ? msg.targets.recipientPeerIds : undefined
});

type SignAdmittedMessage = NonNullable<ALOutboundMessageRuntime.Dependencies<OutboundTestPayload>['signAdmittedMessage']>;

interface RecordingRuntime {
    readonly runtime: ALOutboundMessageRuntime<OutboundTestPayload>;
    readonly sent: ALMessage[];
    readonly signed: ALMessage[];
}

describe('the sent positions an admission records on its track', () => {
    it('stamps the first frame of a track with an empty record and moves each recipient to its sequence', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createRecordingRuntime(stores);

        const admitted = await runtime.enqueueIfAbsent(createFeedFrame('seq-1', 1, ['b', 'c']));

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(admitted.message.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 1, priorSeqByRecipient: {} });
        expect(await readSentPositions(stores, admitted.message, ['b', 'c'])).toEqual({ b: 1, c: 1 });
    });

    it('stamps the next frame to the same audience with an empty record', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createRecordingRuntime(stores);
        await runtime.enqueueIfAbsent(createFeedFrame('seq-1', 1, ['b', 'c']));

        const admitted = await runtime.enqueueIfAbsent(createFeedFrame('seq-2', 2, ['b', 'c']));

        expect(admitted.message.ordering?.priorSeqByRecipient).toEqual({});
        expect(await readSentPositions(stores, admitted.message, ['b', 'c'])).toEqual({ b: 2, c: 2 });
    });

    it('names in the record a recipient a frame of the track left out, with the last sequence it was sent', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createRecordingRuntime(stores);
        await runtime.enqueueIfAbsent(createFeedFrame('seq-1', 1, ['b', 'c']));
        await runtime.enqueueIfAbsent(createFeedFrame('seq-2', 2, ['b']));

        const admitted = await runtime.enqueueIfAbsent(createFeedFrame('seq-3', 3, ['b', 'c']));

        expect(admitted.message.ordering?.priorSeqByRecipient).toEqual({ c: 1 });
        expect(await readSentPositions(stores, admitted.message, ['b', 'c'])).toEqual({ b: 3, c: 3 });
    });

    it('records nothing for a plan that states no recipients, nor for a frame with no track', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createRecordingRuntime(stores);
        const unkeyed = createFeedFrame('unkeyed', 1, ['b']);

        const admitted = await runtime.enqueueIfAbsent({ ...unkeyed, ordering: undefined });

        expect(admitted.message.ordering).toBeUndefined();
        const unrecording = createDefaultOutboundTestRuntime({
            stores,
            planOutgoingMessage: OUTBOUND_TEST_SEND_PLANNER,
            sendPreparedMessage: async () => ({ status: 'sent', submissionAttempted: true })
        });
        const keyed = await unrecording.enqueueIfAbsent(createFeedFrame('keyed', 1, ['b']));
        expect(keyed.message.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 1 });
        expect(await readSentPositions(stores, keyed.message, ['b'])).toEqual({ b: 0 });
    });

    it('answers a re-admission of a sent frame with the stored signed envelope, though its recipients moved since', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime } = createRecordingRuntime(stores, signWithTestProof);
        const frame = createFeedFrame('seq-1', 1, ['b', 'c']);
        const admitted = await runtime.enqueueIfAbsent(frame);
        await runtime.enqueueIfAbsent(createFeedFrame('seq-2', 2, ['b']));

        const again = await runtime.enqueueIfAbsent(frame);

        expect(again.verdict.kind).toBe('duplicate');
        expect(again.message).toEqual(admitted.message);
        expect((await stores.admissionStore.readSentMessage(frame.id.msgId))?.msg).toEqual(admitted.message);
        expect(await readSentPositions(stores, admitted.message, ['b', 'c'])).toEqual({ b: 2, c: 1 });
    });

    it('records once when a lost fence retries the admission: the replay reads the positions the winner moved', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent } = createRecordingRuntime(stores);
        const early = createFeedFrame('early', 1, ['b', 'c']);
        const late = createFeedFrame('late', 2, ['b', 'c']);
        interleaveAfterFirstDecisionRead(stores, async () => {
            const bundle = await readOutboundTestAdmission({
                store: stores.admissionStore,
                message: early,
                creationNow: () => Temporal.Now.instant(),
                clock: { nowMs: () => Date.now() },
                planner: RECORDING_PLANNER
            });
            expect(await stores.admissionStore.commitBundle(bundle)).toBe('committed');
        });

        const pending = await runtime.enqueueIfAbsent(late);

        expect(pending.verdict.kind).toBe('pending');
        expect(pending.message.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 2 });
        expect((await readCanonicalMessage(stores, late)).ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 2 });

        await runOutboundWorkTask(runtime);
        await waitForOutboundWorkDrained(stores);

        const stored = await stores.admissionStore.readSentMessage(late.id.msgId);
        expect(stored?.msg.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 2, priorSeqByRecipient: {} });
        expect((await readCanonicalMessage(stores, late)).ordering).toEqual(stored?.msg.ordering);
        expect(sent.filter((frame) => frame.id.msgId === late.id.msgId).map((frame) => frame.ordering)).toEqual([
            stored?.msg.ordering
        ]);
        expect(await readSentPositions(stores, stored!.msg, ['b', 'c'])).toEqual({ b: 2, c: 2 });
    });
});

describe('the signing of an admitted frame', () => {
    it('signs a first admission once, after its read stamped the record, and stores and sends that envelope', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent, signed } = createRecordingRuntime(stores, signWithTestProof);

        const admitted = await runtime.enqueueIfAbsent(createFeedFrame('seq-1', 1, ['b', 'c']));
        await runOutboundWorkTask(runtime);

        expect(admitted.verdict.kind, admitted.reason).toBe('admitted');
        expect(signed).toHaveLength(1);
        expect(signed[0]!.ordering).toEqual({ orderingKey: 'feed', epoch: 1, seq: 1, priorSeqByRecipient: {} });
        expect(signed[0]!.proof).toBeUndefined();
        expect(admitted.message).toEqual({ ...signed[0], proof: PROOF });
        expect((await stores.admissionStore.readSentMessage(admitted.message.id.msgId))?.msg).toEqual(admitted.message);
        expect(sent).toEqual([admitted.message]);
    });

    it('drops a frame its signer refuses as unsupported, storing, recording and sending nothing', async () => {
        const stores = createDefaultOutboundTestStores();
        const { runtime, sent } = createRecordingRuntime(stores, async () => Either.ofLeft('sign-failed: the key is gone'));
        const frame = createFeedFrame('refused', 1, ['b', 'c']);

        const refused = await runtime.enqueueIfAbsent(frame);
        await runOutboundWorkTask(runtime);

        expect(refused.verdict).toEqual({ kind: 'refused', reason: 'unsupported', detail: 'sign-failed: the key is gone' });
        expect(refused.entries).toEqual([]);
        expect(await stores.admissionStore.readSentMessage(frame.id.msgId)).toBeUndefined();
        expect(await readSentPositions(stores, { ...frame, ordering: { ...frame.ordering, seq: 1 } }, ['b', 'c'])).toEqual({
            b: 0,
            c: 0
        });
        expect(sent).toEqual([]);
    });
});

function createRecordingRuntime(stores: OutboundTestStores, signAdmittedMessage?: SignAdmittedMessage): RecordingRuntime {
    const sent: ALMessage[] = [];
    const signed: ALMessage[] = [];
    const runtime = createDefaultOutboundTestRuntime({
        stores,
        planOutgoingMessage: RECORDING_PLANNER,
        signAdmittedMessage: signAdmittedMessage === undefined ? undefined : async (msg) => {
            signed.push(msg);
            return await signAdmittedMessage(msg);
        },
        sendPreparedMessage: async (_prepared, _phase, lifecycle) => {
            sent.push(lifecycle.canonicalMessage);
            return { status: 'sent', submissionAttempted: true };
        }
    });
    return { runtime, sent, signed };
}

async function signWithTestProof(msg: ALMessage): Promise<Either<string, ALMessage>> {
    return Either.ofRight({ ...msg, proof: PROOF });
}

/** A frame of the `feed` track, frozen to `recipientPeerIds` of the room. */
function createFeedFrame(msgId: string, seq: number, recipientPeerIds: readonly string[]): ALMessage {
    const message = newALMulticastMessage(
        'a',
        { topicId: 'room.feed', resourceId: msgId, contextId: ROOM.groupId },
        ROOM,
        'room.feed.v1',
        { msgId },
        { ttlMs: 60_000, traceId: `trace-${msgId}` }
    );
    return {
        ...message,
        id: { ...message.id, msgId },
        targets: { mode: 'multicast', groupRef: ROOM, recipientPeerIds, snapshotVersion: 1 },
        ordering: { orderingKey: 'feed', epoch: 1, seq }
    };
}

async function readSentPositions(
    stores: OutboundTestStores,
    frame: ALMessage,
    recipientPeerIds: readonly string[]
): Promise<Readonly<Record<string, number>>> {
    const trackKey = toALOrderingTrackKey(frame)!;
    const positions = await Promise.all(recipientPeerIds.map(async (recipientPeerId) => {
        const row = await stores.backend.read(
            toALOutboundSentPositionKey(NAMESPACE, trackKey, recipientPeerId),
            decodeALOutboundTrackPositionRow
        );
        return [recipientPeerId, row?.seq ?? 0] as const;
    }));
    return Object.fromEntries(positions);
}

/** Lets `interleaved` commit right after the next decision read, so that read's commit finds the sender moved. */
function interleaveAfterFirstDecisionRead(stores: OutboundTestStores, interleaved: () => Promise<void>): void {
    const store = stores.admissionStore;
    const readOutgoingDecision = store.readOutgoingDecision.bind(store);
    vi.spyOn(store, 'readOutgoingDecision').mockImplementationOnce(async (input, decide) => {
        const observed = await readOutgoingDecision(input, decide);
        await interleaved();
        return observed;
    });
}

async function readCanonicalMessage(stores: OutboundTestStores, message: ALMessage): Promise<ALMessage> {
    const entry = await stores.workQueue.getItem(toALOutboundCanonicalKey(stores.admissionStore.canonicalScope, message));
    if (entry === undefined) {
        throw new Error(`Expected a canonical row for ${message.id.msgId}`);
    }
    return decodePersistedALMessage(entry.resource);
}
