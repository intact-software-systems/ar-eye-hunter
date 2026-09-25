import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import {
    newALAckControlMessage,
    newALNackControlMessage,
    newALRepairControlMessage
} from '@shared/al-contracts/al-control.ts';
import {
    createPassThroughTransportFaultPort,
    createScriptedTransportFaultPort
} from '@shared/transport-faults/transport-fault-port.ts';
import { describe, expect, it } from 'vitest';

/** Both carriers put `JSON.stringify(ALMessage)` on the wire, so the frames here are built, not hand-written. */
const ackFrame = JSON.stringify(newALAckControlMessage(
    { v: 2, msgId: 'ctl-1', senderId: 'b', ts: 1 },
    {
        ackedMsgId: 'msg-1',
        originPeerId: 'a',
        logicalRecipientPeerId: 'b',
        fromPeerId: 'b',
        toPeerId: 'a',
        status: 'delivered',
        observedAtEpochMs: 1,
        carrier: 'ws'
    }
));
const nackFrame = JSON.stringify(newALNackControlMessage(
    { v: 2, msgId: 'ctl-2', senderId: 'b', ts: 1 },
    {
        msgId: 'msg-2',
        fromPeerId: 'b',
        toPeerId: 'a',
        reason: 'gap',
        observedAtEpochMs: 1
    }
));
const repairFrame = JSON.stringify(newALRepairControlMessage(
    { v: 2, msgId: 'ctl-3', senderId: 'b', ts: 1 },
    {
        msgId: 'msg-3',
        fromPeerId: 'b',
        toPeerId: 'a',
        reason: 'retransmit',
        observedAtEpochMs: 1
    }
));
const dataFrame = JSON.stringify(newALUntargetedMessage(
    'a',
    newALRoute('room.chat', 'room-1', 'resource-1'),
    'chat',
    { text: 'hello' }
));

describe('transport fault port', () => {
    it.each(['ws', 'rtc'] as const)('holds matching %s traffic until explicit replacement or clear', (carrier) => {
        const port = createScriptedTransportFaultPort();
        const fault = {
            faultId: 'held',
            carrier,
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: carrier === 'ws' ? 'not-ready' as const : 'drop' as const,
            remaining: 'until-cleared' as const
        };
        port.inject(fault);
        for (let attempt = 0; attempt < 150; attempt += 1) {
            if (carrier === 'ws') {
                expect(port.decideSubmissionReadiness(dataFrame)).toBe('not-ready');
                expect(port.decideSubmissionReadiness(ackFrame)).toBe('ready');
            }
            else {
                expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'drop', faultId: 'held' });
                expect(port.decideSend('rtc', ackFrame)).toEqual({ kind: 'pass' });
                expect(port.decideSend('ws', dataFrame)).toEqual({ kind: 'pass' });
            }
        }
        port.inject({ ...fault, remaining: 0 });
        expect(port.decideSubmissionReadiness(dataFrame)).toBe('ready');
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'pass' });
        port.inject(fault);
        port.clear();
        expect(port.decideSubmissionReadiness(dataFrame)).toBe('ready');
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'pass' });
    });

    it('passes everything through by default', () => {
        const port = createPassThroughTransportFaultPort();
        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'pass' });
    });

    it.each(
        [
            { action: 'drop', decision: { kind: 'drop', faultId: 'frame' }, observed: 'drop' },
            { action: { delayMs: 25 }, decision: { kind: 'delay', faultId: 'frame', delayMs: 25 }, observed: 'delay' }
        ] as const
    )('consumes readiness independently of a $observed frame fault', ({ action, decision, observed }) => {
        const port = createScriptedTransportFaultPort();
        const match = { controlType: undefined, typeId: 'chat', msgId: undefined };
        port.inject({ faultId: 'frame', carrier: 'ws', match, action, remaining: 1 });
        port.inject({ faultId: 'hold', carrier: 'ws', match, action: 'not-ready', remaining: 2 });
        expect(port.decideSubmissionReadiness(dataFrame)).toBe('not-ready');
        expect(port.decideSend('ws', dataFrame)).toEqual(decision);
        expect(port.decideSend('ws', dataFrame)).toEqual({ kind: 'pass' });
        expect(port.decideSubmissionReadiness(dataFrame)).toBe('not-ready');
        expect(port.decideSubmissionReadiness(dataFrame)).toBe('ready');
        expect(port.getObservations().map((event) => event.decision)).toEqual(['not-ready', observed, 'not-ready']);
    });

    it('drops a matching ACK the configured number of times and records it', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-ack',
            carrier: 'ws',
            match: { controlType: 'ack', typeId: undefined, msgId: 'msg-1' },
            action: 'drop',
            remaining: 1
        });

        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'drop', faultId: 'drop-ack' });
        expect(port.decideSend('ws', ackFrame)).toEqual({ kind: 'pass' });
        expect(port.decideSend('rtc', ackFrame)).toEqual({ kind: 'pass' });
        expect(port.getObservations()).toEqual([{
            faultId: 'drop-ack',
            carrier: 'ws',
            decision: 'drop'
        }]);
    });

    it('drops a matching NACK by the msgId it references', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-nack',
            carrier: 'ws',
            match: { controlType: 'nack', typeId: undefined, msgId: 'msg-2' },
            action: 'drop',
            remaining: 1
        });

        expect(port.decideSend('ws', nackFrame)).toEqual({ kind: 'drop', faultId: 'drop-nack' });
        expect(port.decideSend('ws', nackFrame)).toEqual({ kind: 'pass' });
    });

    it('drops a matching REPAIR by the msgId it references', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-repair',
            carrier: 'ws',
            match: { controlType: 'repair', typeId: undefined, msgId: 'msg-3' },
            action: 'drop',
            remaining: 1
        });

        expect(port.decideSend('ws', repairFrame)).toEqual({ kind: 'drop', faultId: 'drop-repair' });
        expect(port.decideSend('ws', repairFrame)).toEqual({ kind: 'pass' });
    });

    it('delays a matching data message and ignores non-JSON frames', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'slow-chat',
            carrier: 'rtc',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: { delayMs: 250 },
            remaining: 2
        });

        expect(port.decideSend('rtc', dataFrame)).toEqual({
            kind: 'delay',
            faultId: 'slow-chat',
            delayMs: 250
        });
        expect(port.decideSend('rtc', 'not json')).toEqual({ kind: 'pass' });
        port.clear();
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'pass' });
    });

    it('matches an envelope typeId that a frame carries under its payload', () => {
        const port = createScriptedTransportFaultPort();
        port.inject({
            faultId: 'drop-chat',
            carrier: 'rtc',
            match: { controlType: undefined, typeId: 'chat', msgId: undefined },
            action: 'drop',
            remaining: 1
        });

        // A top-level typeId is not the AL wire shape and must never match.
        expect(port.decideSend('rtc', JSON.stringify({ id: { msgId: 'm' }, typeId: 'chat' })))
            .toEqual({ kind: 'pass' });
        expect(port.decideSend('rtc', dataFrame)).toEqual({ kind: 'drop', faultId: 'drop-chat' });
    });
});
