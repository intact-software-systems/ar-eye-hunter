import { describe, expect, it } from 'vitest';

import { submitBlackBoxRawControl } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/messaging/submit-black-box-raw-control.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodeALControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../shared-web/api-middleware-test-double.ts';

const ADMITTED = { kind: 'admitted', durable: true, queuedAttempts: 1 } as const;

const CONTROL = { carrier: 'rtc', typeId: 'al.control.ack.v1', ackedMsgId: 'room-message-1', toPeerId: 'origin' } as const;

function toAdmittingContext(submitted: ALMessage[], wake: () => void) {
    const enqueueOutboxIfAbsent = async (message: ALMessage): Promise<ALOutboundEnqueueResult> => {
        submitted.push(message);
        return { verdict: ADMITTED, message, entries: [] };
    };
    return createDefaultApiMiddlewareTestDouble({
        session: { sessionId: 'recipient-b' },
        middleware: {
            qboxEngine: { wake },
            rtcRxStreamer: { enqueueOutboxIfAbsent },
            webSocketQueueBox: { enqueueOutboxIfAbsent }
        }
    });
}

describe('submitBlackBoxRawControl', () => {
    it('admits, on the named carrier, the ACK of the named message under a control id its addressee refuses unsupported', async () => {
        const submitted: ALMessage[] = [];
        let woken = false;
        const wake = () => {
            woken = true;
        };

        const submission = await submitBlackBoxRawControl({
            control: CONTROL,
            sessionId: 'recipient-b',
            context: toAdmittingContext(submitted, wake),
            nowMs: 1_000,
            msgId: 'control-1'
        });

        expect(submission).toEqual({ msgId: 'control-1', verdict: ADMITTED });
        expect(woken).toBe(true);
        expect(submitted).toHaveLength(1);
        const [control] = submitted;
        expect(control).toMatchObject({
            id: { msgId: 'control-1', senderId: 'recipient-b', ts: 1_000 },
            targets: { mode: 'unicast', toPeerId: 'origin' },
            payload: { typeId: 'al.control.ack.v1' }
        });
        expect(JSON.parse(control!.payload.resource)).toMatchObject({
            ackedMsgId: 'room-message-1',
            fromPeerId: 'recipient-b',
            logicalRecipientPeerId: 'recipient-b',
            originPeerId: 'origin',
            toPeerId: 'origin',
            status: 'delivered'
        });
        expect(decodeALControlMessage(control!).left).toMatchObject({ code: 'unsupported' });
        expect(decodeALControlMessage({ ...control!, payload: { ...control!.payload, typeId: 'al.control.ack.v2' } }).right)
            .toMatchObject({ type: 'ack' });
    });

    it('refuses to submit from a page with no connected session', async () => {
        await expect(submitBlackBoxRawControl({
            control: CONTROL,
            sessionId: undefined,
            context: undefined,
            nowMs: 1_000,
            msgId: 'control-1'
        })).rejects.toThrow('Raw control submission unavailable: no connected session.');
    });
});
