import '../../setup-browser-indexeddb.ts';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { newALMulticastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toALFrozenMulticastMessage } from '@shared/al-contracts/al-frozen-multicast-audience.ts';
import * as auth from '@shared/api/auth.ts';
import {
    configureGroupStateSnapshotRepository,
    setGroupStateSnapshot
} from '@shared/repository/group-state-snapshots-repository.ts';

import { createAcceptedGroupSnapshotFixture } from '../authoritative-group-fixtures.ts';
import {
    ACK_UNDER_HOLD_MESSAGE_TTL_MS,
    openWsHoldSender,
    type HoldSender,
    type WsHoldSender
} from './acknowledgement-under-hold-fixture.ts';

const ROOM_REF = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' };

/** The two receivers the `repair-exhausted` cell's RTC admission froze into the send's audience. */
const FROZEN_RECIPIENT_PEER_IDS = ['receiver-a', 'receiver-b'];

/** Outlives the message deadline and the 30 s after it, so the sender's presence never gates a submission. */
const SENDER_PRESENCE_MS = 600_000;

describe('a handed-over send whose WS copy is held too', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('sends nothing, keeps no receipt row and states no terminal fact; it reads submitted until its deadline and expired after it, and nothing leaves once the hold lifts', async () => {
        const sender = await openPresentWsHoldSender();
        sender.faults.inject(sender.hold);
        const message = toHandedOverMessage(sender.selfPeerId);
        const msgId = message.id.msgId;
        const handle = await sender.sendHandedOver(message);
        await sender.drain();
        const expiresAtMs = handle.lifecycle().expiresAtMs!;

        await advanceAndRun(sender, expiresAtMs - 1 - Date.now());
        expect(sender.readSentFrames(msgId)).toEqual([]);
        expect(await sender.readPendingAck(msgId)).toBeUndefined();
        expect(sender.readFaultedTypeIds()).toContain('held.message');
        expect(handle.lifecycle()).toMatchObject({
            state: 'submitted',
            evidence: { attempts: [{ carrier: 'ws', outcome: 'not-ready', submissionAttempted: false }] }
        });

        await advanceAndRun(sender, 2);
        expect(handle.lifecycle()).toMatchObject({
            state: 'expired',
            evidence: {
                attempts: [{ carrier: 'ws', outcome: 'not-ready', submissionAttempted: false }],
                failure: { kind: 'expired' },
                reason: 'The deadline elapsed before a terminal settlement.'
            },
            lateSettlementCount: 0
        });
        expect(await sender.readPendingAck(msgId)).toBeUndefined();

        await advanceAndRun(sender, ACK_UNDER_HOLD_MESSAGE_TTL_MS);
        sender.faults.inject({ ...sender.hold, remaining: 0 });
        await advanceAndRun(sender, 100);
        expect(sender.readSentFrames(msgId)).toEqual([]);
        expect(await sender.readPendingAck(msgId)).toBeUndefined();
        expect(handle.lifecycle()).toMatchObject({ state: 'expired', lateSettlementCount: 0 });
    });

    it('lets exactly one frame out when the hold lifts before the deadline', async () => {
        const sender = await openPresentWsHoldSender();
        sender.faults.inject(sender.hold);
        const message = toHandedOverMessage(sender.selfPeerId);
        const handle = await sender.sendHandedOver(message);
        await sender.drain();
        await advanceAndRun(sender, 10_000);
        expect(sender.readSentFrames(message.id.msgId)).toEqual([]);

        sender.faults.inject({ ...sender.hold, remaining: 0 });
        await advanceAndRun(sender, 100);
        expect(sender.readSentFrames(message.id.msgId)).toEqual([
            expect.objectContaining({ targets: message.targets, ordering: message.ordering })
        ]);
        expect(handle.lifecycle().state).toBe('transport-accepted');
    });
});

/** The WS hold sender with its own live presence in the send's room, so only the scripted hold keeps a copy back. */
async function openPresentWsHoldSender(): Promise<WsHoldSender> {
    const sender = await openWsHoldSender();
    const sessionId = sender.selfPeerId;
    const presentUntilMs = Date.now() + SENDER_PRESENCE_MS;
    vi.spyOn(auth, 'readSession').mockReturnValue({
        clientId: sessionId,
        sessionId,
        username: 'sender',
        accessToken: 'test-only',
        expiresAtEpochMs: presentUntilMs
    });
    configureGroupStateSnapshotRepository({ ttlMs: SENDER_PRESENCE_MS });
    const snapshot = createAcceptedGroupSnapshotFixture([sessionId, ...FROZEN_RECIPIENT_PEER_IDS]);
    setGroupStateSnapshot({
        ...snapshot,
        activeSessions: snapshot.activeSessions.map((session) => ({ ...session, expiresAtEpochMs: presentUntilMs }))
    });
    return sender;
}

/**
 * The copy the cell's RTC admission hands to WS: an ordered at-least-once `receiver` room send of the held typeId
 * whose audience that admission froze and whose sequence it fixed. It opts into `local-outbox`, since the case reads
 * its receipt row back from the carrier's durable store.
 */
function toHandedOverMessage(sessionId: string): ALMessage {
    const message = newALMulticastMessage(
        sessionId,
        { topicId: 'held', contextId: 'group-1', resourceId: 'handed-over' },
        ROOM_REF,
        'held.message',
        { seq: 2 },
        {
            ack: 'receiver',
            reliability: 'at-least-once',
            seq: 2,
            orderingKey: 'held-track',
            ttlMs: ACK_UNDER_HOLD_MESSAGE_TTL_MS,
            qos: { durability: { algo: 'local-outbox' } }
        }
    );
    const frozen = toALFrozenMulticastMessage(message, { recipientPeerIds: FROZEN_RECIPIENT_PEER_IDS, snapshotVersion: 1 });
    return { ...frozen, ordering: { orderingKey: 'held-track', seq: 2, priorSeqByRecipient: {} } };
}

/** Moves the sender's clock and runs the work then due, as a page's engine would. */
async function advanceAndRun(sender: HoldSender, ms: number): Promise<void> {
    await sender.advance(ms);
    await sender.drain();
    await sender.drain();
    await sender.settle();
}
