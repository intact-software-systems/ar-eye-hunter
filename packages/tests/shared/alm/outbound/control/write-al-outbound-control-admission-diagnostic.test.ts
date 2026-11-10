import { describe, expect, it } from 'vitest';

import { newALRoute, newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    parseALControlMessage
} from '@shared/al-contracts/al-control.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from '@shared/alm/outbound/control/al-outbound-control-admission.ts';
import { writeALOutboundControlAdmissionDiagnostic } from '@shared/alm/outbound/control/write-al-outbound-control-admission-diagnostic.ts';

import { toTestALAckPayload, toTestALNackPayload } from '../../../../al-control-test-payloads.ts';

const CONTROL_ID = newALUnicastMessage('b', newALRoute('control', 'room-1', 'nack'), 'a', 'chat.v1', {}).id;

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
    it('names the NACK\'s reason and the track it asks about, after the verdict and before the trace', () => {
        const nack = newALNackControlMessage(
            CONTROL_ID,
            toTestALNackPayload({
                msgId: 'sent-3',
                fromPeerId: 'b',
                toPeerId: 'a',
                logicalRecipientPeerId: 'b',
                reason: 'gap',
                observedAtEpochMs: 1,
                orderingKey: 'chat:a:0',
                expectedSeq: 2,
                missingRanges: [{ from: 2, to: 2 }]
            })
        );

        expect(JSON.stringify(writeAdmitted(nack))).toContain(
            '"typeId":"al.control.nack.v3","targetMsgId":"sent-3","outcome":"committed","reason":"none",' +
                '"nackReason":"gap","nackOrderingKey":"chat:a:0","traceId":'
        );
    });

    it('names the reason alone for a NACK about no track', () => {
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

        expect(writeAdmitted(nack)).toMatchObject({ nackReason: 'not-subscribed' });
        expect(writeAdmitted(nack)).not.toHaveProperty('nackOrderingKey');
    });

    it('states neither field for a control that is no NACK', () => {
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

        expect(Object.keys(writeAdmitted(ack))).not.toContain('nackReason');
    });
});

describe('the control-admission event of a refused proof', () => {
    it('names the refusal, the recipient it claimed and its channel peer exactly on a proof refusal, after the NACK\'s track and before the trace', () => {
        const refused = writeAdmitted(FORGED_NACK, {
            kind: 'rejected',
            reason: 'AL control proof is refused: key-mismatch',
            proofRefusal: { kind: 'key-mismatch', claimedRecipientPeerId: 'c', channelPeerId: 'b' }
        });
        const rejected = writeAdmitted(FORGED_NACK, { kind: 'rejected', reason: 'AL control was already admitted' });

        expect(JSON.stringify(refused)).toContain(
            '"outcome":"rejected","reason":"AL control proof is refused: key-mismatch","nackReason":"gap",' +
                '"nackOrderingKey":"chat:a:0","proofRefusal":"key-mismatch","claimedRecipientPeerId":"c","channelPeerId":"b",' +
                '"traceId":'
        );
        for (const event of [rejected, writeAdmitted(FORGED_NACK)]) {
            expect(Object.keys(event)).not.toContain('proofRefusal');
            expect(Object.keys(event)).not.toContain('claimedRecipientPeerId');
            expect(Object.keys(event)).not.toContain('channelPeerId');
        }
    });
});
