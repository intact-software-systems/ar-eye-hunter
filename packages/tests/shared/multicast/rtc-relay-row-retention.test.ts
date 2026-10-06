import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Temporal } from '@js-temporal/polyfill';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    AL_RECEIPT_DEADLINE_GRACE_MS,
    newALAckControlMessage
} from '@shared/al-contracts/al-control.ts';
import {
    createInMemoryALAdmissionState,
    InMemoryAdmissionBackend,
    type ALAdmissionMemoryState
} from '@shared/alm/al-admission-backend.ts';
import { normalizeALRuntimeStoreRetention } from '@shared/alm/ALStoreRetention.ts';
import { createVolatileALInboundAdmissionStore } from '@shared/alm/inbound/al-inbound-admission-store.ts';
import { toALInboundMessageKey } from '@shared/alm/inbound/al-inbound-canonical-message.ts';
import type { ALVolatileInboundRuntimeStores } from '@shared/alm/inbound/al-inbound-message-runtime.ts';
import { toALInboundMessageOwnerKey } from '@shared/alm/inbound/al-inbound-source-validation.ts';
import {
    toALInboundControlAcksKey,
    toALInboundControlOwnersKey,
    toALInboundControlPendingKey
} from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { InMemoryQueueBox } from '@shared/queuebox/in-memory-queue-box.ts';

import {
    createOriginReceiverMulticast,
    createOriginSnapshot,
    createRtcOriginOverlayFixture,
    enqueueAndDrain
} from './rtc-origin-overlay-fixture.ts';
import {
    createRtcRelayOverlayFixture,
    type RtcRelayOverlayFixture
} from './rtc-relay-overlay-fixture.ts';

const RELAY_NAMESPACE = 'relay-rows';
/** The dedup window of every default policy (`normalize-al-qos-policy.ts:171`). */
const DEDUP_WINDOW_MS = 60_000;

interface RelayedMessage {
    readonly relay: RtcRelayOverlayFixture;
    readonly state: ALAdmissionMemoryState;
    readonly copy: ALMessage;
    readonly admittedAtMs: number;
}

interface ObservedVolatileInboundPair {
    readonly state: ALAdmissionMemoryState;
    readonly stores: ALVolatileInboundRuntimeStores;
}

describe('the rows an RTC relay keeps for one relayed volatile message (C14)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it('keeps its relay row, owner index and envelope to the deadline and its owner row through the grace', async () => {
        const relayed = await relayOneMessage();
        const deadlineAtMs = readDeadlineMs(relayed.copy);

        expect(readRowKinds(relayed.state)).toEqual([
            'control:owners',
            'control:pending',
            'dedup',
            'message',
            'msg-owner'
        ]);
        expect(readRelayRowExpiries(relayed.state, relayed.copy)).toEqual({
            pendingAck: deadlineAtMs,
            controlOwners: deadlineAtMs,
            canonicalMessage: deadlineAtMs,
            messageOwner: deadlineAtMs + AL_RECEIPT_DEADLINE_GRACE_MS,
            dedup: relayed.admittedAtMs + DEDUP_WINDOW_MS
        });
    });

    it('keeps the acknowledgement-history row its child ACK adds through the grace, like its owner row', async () => {
        const relayed = await relayOneMessage();

        await relayed.relay.receive(toChildAck(relayed.copy), 'b');

        const { msgId, senderId } = relayed.copy.id;
        expect(
            relayed.state.data.get(toALInboundControlAcksKey(RELAY_NAMESPACE, msgId, senderId))
                ?.expireAtTimestamp
        )
            .toBe(readDeadlineMs(relayed.copy) + AL_RECEIPT_DEADLINE_GRACE_MS);
    });
});

async function relayOneMessage(): Promise<RelayedMessage> {
    const snapshot = createOriginSnapshot(['a', 'r', 'b', 'c'], 4);
    const origin = createRtcOriginOverlayFixture({ snapshot, nextHopPeerIds: ['r', 'c'] });
    const pair = createObservedVolatileInboundPair();
    const relay = createRtcRelayOverlayFixture({
        selfPeerId: 'r',
        snapshot,
        neighbourPeerIds: ['a', 'b'],
        inboundVolatileStores: pair.stores
    });
    await enqueueAndDrain(origin.manager, createOriginReceiverMulticast('relay-rows'));
    const copy = origin.channels.r!.sent[0]!;
    const admittedAtMs = Date.now();
    await relay.receive(copy, 'a');
    return { relay, state: pair.state, copy, admittedAtMs };
}

/** The relay session's memory pair, whose admission map the test reads back. */
function createObservedVolatileInboundPair(): ObservedVolatileInboundPair {
    const state = createInMemoryALAdmissionState(
        new InMemoryQueueBox(undefined, () => Temporal.Instant.fromEpochMilliseconds(Date.now()))
    );
    const backend = new InMemoryAdmissionBackend(state, Date.now);
    return {
        state,
        stores: {
            admissionStore: createVolatileALInboundAdmissionStore({
                nowMs: Date.now,
                namespace: RELAY_NAMESPACE,
                backend,
                orderingTrackTtlMs: 5 * 60_000,
                supersedenceTrackTtlMs: 5 * 60_000,
                retention: normalizeALRuntimeStoreRetention()
            }),
            workQueue: backend.workQueue,
            evictExpired: () => backend.evictExpired(),
            budget: undefined
        }
    };
}

/** Each row's kind: the key segment after the namespace, with the second segment under `control`. */
function readRowKinds(state: ALAdmissionMemoryState): readonly string[] {
    return [...state.data.keys()].map((key) => {
        const [kind = '', detail = ''] = key.slice(RELAY_NAMESPACE.length + 1).split(':');
        return kind === 'control' ? `${kind}:${detail}` : kind;
    }).sort();
}

function readRelayRowExpiries(
    state: ALAdmissionMemoryState,
    copy: ALMessage
): Readonly<Record<'pendingAck' | 'controlOwners' | 'canonicalMessage' | 'messageOwner' | 'dedup', number | undefined>> {
    const { msgId, senderId } = copy.id;
    const expiryOf = (key: string) => state.data.get(key)?.expireAtTimestamp;
    return {
        pendingAck: expiryOf(toALInboundControlPendingKey(RELAY_NAMESPACE, msgId, senderId)),
        controlOwners: expiryOf(toALInboundControlOwnersKey(RELAY_NAMESPACE, msgId)),
        canonicalMessage: expiryOf(toALInboundMessageKey(RELAY_NAMESPACE, { msgId, senderId })),
        messageOwner: expiryOf(toALInboundMessageOwnerKey(RELAY_NAMESPACE, msgId, senderId)),
        dedup: [...state.data.values()].find((row) => row.key.startsWith(`${RELAY_NAMESPACE}:dedup:`))?.expireAtTimestamp
    };
}

function readDeadlineMs(message: ALMessage): number {
    const deadlineAtMs = message.constraints?.expiresAtMs;
    if (deadlineAtMs === undefined) {
        throw new Error('The origin copy names its deadline');
    }
    return deadlineAtMs;
}

/** The leaf `b`'s terminal ACK to its relay `r` for the origin's message. */
function toChildAck(copy: ALMessage): ALMessage {
    return newALAckControlMessage(
        { v: 3, msgId: 'ack-b', senderId: 'b', ts: Date.now() },
        {
            ackedMsgId: copy.id.msgId,
            fromPeerId: 'b',
            toPeerId: 'r',
            originPeerId: copy.id.senderId,
            logicalRecipientPeerId: 'b',
            carrier: 'rtc',
            status: 'delivered',
            observedAtEpochMs: Date.now()
        }
    );
}
