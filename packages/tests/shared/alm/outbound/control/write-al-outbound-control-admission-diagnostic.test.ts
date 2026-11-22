import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    parseALControlMessage
} from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/read-al-outbound-recipient-proof.ts';
import { writeALOutboundControlAdmissionDiagnostic } from '@shared/alm/outbound/control/write-al-outbound-control-admission-diagnostic.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

const CONTROL_ID = newALUnicastMessage({
    createdAtEpochMs: Date.now(),
    senderId: 'b',
    route: newALRoute('control', 'room-1', 'nack'),
    toPeerId: 'a',
    typeId: 'chat.v1',
    resource: {}
}).id;

/** The event the origin states for one control, as its diagnostics sink receives it; absent a verdict, committed. */
function writeAdmitted(
    control: ALMessage,
    admitted: ALOutboundControlAdmissionResult = { kind: 'committed' }
): ALOutboundRuntimeDiagnosticsEvent {
    const events: ALOutboundRuntimeDiagnosticsEvent[] = [];
    writeALOutboundControlAdmissionDiagnostic((event) => events.push(event), {
        control,
        parsed: parseALControlMessage(control)!,
        admitted
    });
    return events[0]!;
}

const FORGED_NACK = newALNackControlMessage(
    CONTROL_ID,
    toTestALNackPayload({
        msgId: 'sent-3',
        fromPeerId: 'b',
        toPeerId: 'a',
        logicalRecipientPeerId: 'c',
        reason: 'gap',
        observedAtEpochMs: 1,
        orderingKey: 'chat:a:0',
        expectedSeq: 2,
        missingRanges: [{ from: 2, to: 2 }]
    })
);

describe('the control-admission event of a NACK', () => {
    it('names the NACK\'s reason, its track, its request number, its recipient and its sender, after the verdict and before the trace', () => {
        const nack = newALNackControlMessage(
            CONTROL_ID,
            toTestALNackPayload({
                msgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                logicalRecipientPeerId: 'c',
                reason: 'gap',
                observedAtEpochMs: 1,
                orderingKey: 'chat:a:0',
                expectedSeq: 2,
                missingRanges: [{ from: 2, to: 2 }],
                gapRequestNumber: 3
            })
        );

        expect(JSON.stringify(writeAdmitted(nack))).toContain(
            '"typeId":"al.control.nack.v5","targetMsgId":"sent-3","outcome":"committed","reason":"none",' +
                '"nackReason":"gap","nackOrderingKey":"chat:a:0","nackGapRequestNumber":3,' +
                '"nackLogicalRecipientPeerId":"c","nackFromPeerId":"b","traceId":'
        );
    });

    it('names the reason and the peers, and no track or request number, for a NACK about no track', () => {
        const nack = newALNackControlMessage(
            CONTROL_ID,
            toTestALNackPayload({
                msgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                logicalRecipientPeerId: 'b',
                reason: 'not-subscribed',
                observedAtEpochMs: 1
            })
        );

        expect(writeAdmitted(nack)).toMatchObject({
            nackReason: 'not-subscribed',
            nackLogicalRecipientPeerId: 'b',
            nackFromPeerId: 'b'
        });
        expect(writeAdmitted(nack)).not.toHaveProperty('nackOrderingKey');
        expect(writeAdmitted(nack)).not.toHaveProperty('nackGapRequestNumber');
    });

    it('states none of the NACK\'s fields for a control that is no NACK', () => {
        const ack = newALAckControlMessage(
            CONTROL_ID,
            toTestALAckPayload({
                ackedMsgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                originPeerId: 'a',
                logicalRecipientPeerId: 'b',
                carrier: 'rtc',
                status: 'delivered',
                observedAtEpochMs: 1
            })
        );

        for (const field of ['nackReason', 'nackGapRequestNumber', 'nackLogicalRecipientPeerId', 'nackFromPeerId']) {
            expect(Object.keys(writeAdmitted(ack))).not.toContain(field);
        }
    });
});

describe('the control-admission event of a refused proof', () => {
    it('names the refusal, the recipient it claimed and its channel peer exactly on a proof refusal, after the NACK\'s sender and before the trace', () => {
        const refused = writeAdmitted(FORGED_NACK, {
            kind: 'rejected',
            reason: 'AL control proof is refused: key-mismatch',
            proofRefusal: { kind: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'b' }
        });
        const rejected = writeAdmitted(FORGED_NACK, { kind: 'rejected', reason: 'AL control was already admitted' });

        expect(JSON.stringify(refused)).toContain(
            '"outcome":"rejected","reason":"AL control proof is refused: key-mismatch","nackReason":"gap",' +
                '"nackOrderingKey":"chat:a:0","nackGapRequestNumber":1,"nackLogicalRecipientPeerId":"c",' +
                '"nackFromPeerId":"b","proofRefusal":"key-mismatch","claimedRecipientPeerId":"c","channelPeerId":"b",' +
                '"traceId":'
        );
        for (const event of [rejected, writeAdmitted(FORGED_NACK)]) {
            expect(Object.keys(event)).not.toContain('proofRefusal');
            expect(Object.keys(event)).not.toContain('claimedRecipientPeerId');
            expect(Object.keys(event)).not.toContain('channelPeerId');
        }
    });
});

describe('the control-admission event of a duplicate', () => {
    it('reads `duplicate` with every issue it repeats, where a committed control reads no reason', () => {
        const repeat = 'AL control was already admitted; AL acknowledgement confirms a peer the receipt already counted';

        expect(JSON.stringify(writeAdmitted(FORGED_NACK, { kind: 'duplicate', reason: repeat }))).toContain(
            `"outcome":"duplicate","reason":"${repeat}","nackReason":"gap"`
        );
        expect(writeAdmitted(FORGED_NACK)).toMatchObject({ outcome: 'committed', reason: 'none' });
    });
});
