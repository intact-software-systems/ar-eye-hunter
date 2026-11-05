import { newALMulticastMessage } from '@shared/al-contracts/al-contract.ts';
import { planALMessageHandling } from '@shared/al-contracts/al-policy.ts';
import { validateALInboundAdmissionMutation } from '@shared/alm/inbound/admission/validate-al-inbound-admission-mutation.ts';
import {
    type ALInboundAdmissionMutation,
    type ALInboundAdmissionObservations,
    type ALInboundCommitBundle
} from '@shared/alm/inbound/al-inbound-admission-store.ts';
import type { AcksControlValue } from '@shared/alm/inbound/control/al-inbound-control-rows.ts';
import { describe, expect, it } from 'vitest';

const MSG_ID = 'msg-invalid-control-value';
const ROOM = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const SENDER_ID = 'sender-1';

function toBundle(): ALInboundCommitBundle {
    const observations: ALInboundAdmissionObservations = {
        msgId: MSG_ID,
        senderId: SENDER_ID,
        messageOwner: undefined,
        dedup: undefined,
        claim: undefined,
        ordering: undefined,
        buffered: undefined,
        deliveryProgress: undefined,
        supersedence: {},
        pendingAck: undefined,
        acks: [],
        controlOwners: undefined
    };
    return {
        admissionExpiresAtMs: null,
        senderId: SENDER_ID,
        observations,
        mutations: [],
        durableEffects: []
    };
}

/**
 * The narrowest shape the two corruption cases below need: a stored ACK entry with its `carrier`
 * loosened to an optional plain string, so a literal that omits it or carries an unrecognised value
 * still type-checks as a fixture, while a real `AcksControlValue` cannot hold either.
 */
interface StoredAckEntryFixture {
    readonly ackedMsgId: string;
    readonly fromPeerId: string;
    readonly toPeerId: string;
    readonly originPeerId: string;
    readonly logicalRecipientPeerId: string;
    readonly status: string;
    readonly observedAtEpochMs: number;
    readonly carrier?: string;
}

interface AcksControlValueFixture {
    readonly kind: 'acks';
    readonly values: readonly StoredAckEntryFixture[];
}

function toAcksMutation(value: AcksControlValueFixture): ALInboundAdmissionMutation {
    return {
        kind: 'set-control-acks',
        msgId: MSG_ID,
        senderId: SENDER_ID,
        value: value as AcksControlValue,
        expireAtTimestamp: 1_000
    };
}

describe('validateALInboundAdmissionMutation invalid control value', () => {
    it('reports the typed issue, not a throw, for an acks entry with no carrier', () => {
        const mutation = toAcksMutation({
            kind: 'acks',
            values: [
                {
                    ackedMsgId: MSG_ID,
                    originPeerId: SENDER_ID,
                    logicalRecipientPeerId: 'peer-a',
                    fromPeerId: 'peer-a',
                    toPeerId: 'peer-b',
                    status: 'accepted',
                    observedAtEpochMs: 1
                }
            ]
        });

        const issues = validateALInboundAdmissionMutation(mutation, toBundle());

        expect(issues).toEqual(['Inbound admission candidate has an invalid control value']);
    });

    it('reports the typed issue, not a throw, for an acks entry with an unknown carrier', () => {
        const mutation = toAcksMutation({
            kind: 'acks',
            values: [
                {
                    ackedMsgId: MSG_ID,
                    originPeerId: SENDER_ID,
                    logicalRecipientPeerId: 'peer-a',
                    fromPeerId: 'peer-a',
                    toPeerId: 'peer-b',
                    status: 'accepted',
                    observedAtEpochMs: 1,
                    carrier: 'carrier-pigeon'
                }
            ]
        });

        const issues = validateALInboundAdmissionMutation(mutation, toBundle());

        expect(issues).toEqual(['Inbound admission candidate has an invalid control value']);
    });
});

describe('validateALInboundAdmissionMutation claim', () => {
    it('refuses a claim on a key the admission did not observe', () => {
        const mutation: ALInboundAdmissionMutation = {
            kind: 'set-claim',
            claimKey: 'app/workspace/room-1/arena.intent/room/pickup-1',
            holderPeerId: SENDER_ID,
            expireAtTimestamp: 1_000
        };

        expect(validateALInboundAdmissionMutation(mutation, toBundle()))
            .toEqual(['Inbound admission candidate writes outside its original observations']);
    });

    it('accepts a claim on the key the admission observed', () => {
        const claimKey = 'app/workspace/room-1/arena.intent/room/pickup-1';
        const bundle = toBundle();
        const observed = {
            ...bundle,
            observations: { ...bundle.observations, claim: { key: claimKey, holderPeerId: undefined } }
        };

        expect(
            validateALInboundAdmissionMutation(
                { kind: 'set-claim', claimKey, holderPeerId: SENDER_ID, expireAtTimestamp: 1_000 },
                observed
            )
        ).toEqual([]);
    });
});

describe('validateALInboundAdmissionMutation delivery progress', () => {
    const trackKey = 'chat:sender:0';
    const moved: ALInboundAdmissionMutation = {
        kind: 'set-ordering',
        trackKey,
        snapshot: { lastContiguousSeq: 5, bufferedSeqs: [], updatedAtMs: 1 }
    };
    const progress: ALInboundAdmissionMutation = {
        kind: 'set-delivery-progress',
        trackKey,
        value: { completedThrough: 5, expireAtTimestamp: 1_000 }
    };

    /** An admission that read the track at 2 with every delivery through 2 complete, then moved it as `mutations`. */
    function toMovingBundle(mutations: readonly ALInboundAdmissionMutation[]): ALInboundCommitBundle {
        const bundle = toBundle();
        return {
            ...bundle,
            mutations,
            observations: {
                ...bundle.observations,
                ordering: { trackKey, snapshot: { lastContiguousSeq: 2, bufferedSeqs: [], updatedAtMs: 0 }, buffered: [] },
                deliveryProgress: { trackKey, value: { completedThrough: 2, expireAtTimestamp: 1_000 } }
            }
        };
    }

    it('moves the progress past a copy its admission witnessed', () => {
        expect(validateALInboundAdmissionMutation(progress, toMovingBundle([moved, progress]))).toEqual([]);
    });

    it('refuses that step beside a buffered slot: an admission that retains its copy witnessed nothing', () => {
        const msg = newALMulticastMessage('sender', { topicId: 'chat', contextId: 'room', resourceId: 'copy-9' }, ROOM, 'chat.v1', {}, {
            orderingKey: 'chat',
            seq: 9
        });
        const plan = planALMessageHandling(msg, { nowMs: msg.id.ts, selfPeerId: 'self', fromPeerId: 'sender' });
        const slot: ALInboundAdmissionMutation = {
            kind: 'set-buffered',
            snapshot: { trackKey, seq: 9, msg, plan, carrier: 'rtc' },
            expireAtTimestamp: 1_000
        };

        expect(validateALInboundAdmissionMutation(progress, toMovingBundle([moved, slot, progress])))
            .toEqual(['Inbound admission candidate writes outside its original observations']);
    });
});
