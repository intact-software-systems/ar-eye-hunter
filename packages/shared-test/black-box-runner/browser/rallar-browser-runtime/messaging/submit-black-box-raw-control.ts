import {
    wakeQueueBoxEngineIfQueued,
    writeCarrierOutboxAdmission
} from '@shared-web/browser/messages/browser-rallar-message-dispatch.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { newALAckControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALDeliveryAdmissionVerdict } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { BlackBoxRallarControlSubmitInput } from '../black-box-rallar-operation-contracts.ts';
import { BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES } from './black-box-rallar-delivery-error-message-prefixes.ts';

export namespace SubmitBlackBoxRawControl {
    export interface Input {
        readonly control: BlackBoxRallarControlSubmitInput;
        readonly sessionId: string | undefined;
        readonly context: ApiMiddleware | undefined;
        readonly nowMs: number;
        readonly msgId: string;
    }

    export interface Submission {
        readonly msgId: string;
        readonly verdict: ALDeliveryAdmissionVerdict;
    }
}

/**
 * A harness capability the product never exercises: no product path sends a control with a version its peers do not
 * support. It shapes the ACK this session would send for the named message, swaps in the requested `typeId`, and
 * admits the envelope through the carrier admission a product control takes, so the addressee judges it as it would
 * judge any control that arrives.
 */
export async function submitBlackBoxRawControl(
    input: SubmitBlackBoxRawControl.Input
): Promise<SubmitBlackBoxRawControl.Submission> {
    const { sessionId, context, control } = input;
    if (sessionId === undefined || context === undefined) {
        throw new Error(
            `${BLACK_BOX_RALLAR_DELIVERY_ERROR_MESSAGE_PREFIXES.rawControlUnavailable}: no connected session.`
        );
    }
    const result = await writeCarrierOutboxAdmission(context, control.carrier, toRawControlMessage(input, sessionId));
    wakeQueueBoxEngineIfQueued(context.middleware.qboxEngine, result);
    return { msgId: input.msgId, verdict: result.verdict };
}

function toRawControlMessage(input: SubmitBlackBoxRawControl.Input, sessionId: string): ALMessage {
    const { control, nowMs } = input;
    const ack = newALAckControlMessage({ v: 2, msgId: input.msgId, senderId: sessionId, ts: nowMs }, {
        ackedMsgId: control.ackedMsgId,
        fromPeerId: sessionId,
        toPeerId: control.toPeerId,
        originPeerId: control.toPeerId,
        logicalRecipientPeerId: sessionId,
        carrier: control.carrier,
        status: 'delivered',
        observedAtEpochMs: nowMs
    });
    return { ...ack, payload: { ...ack.payload, typeId: control.typeId } };
}
