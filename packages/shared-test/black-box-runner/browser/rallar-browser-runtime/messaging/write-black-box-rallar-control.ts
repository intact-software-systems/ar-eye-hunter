import type {
    BlackBoxRallarControlSubmitDiagnostics,
    BlackBoxRallarControlSubmitInput
} from '../black-box-rallar-operation-contracts.ts';
import type { BlackBoxBrowserDeliveriesDependency } from '../browser-rallar-runtime-composition.ts';
import type { BlackBoxRallarTypedChannels } from './black-box-rallar-typed-channels.ts';

export namespace WriteBlackBoxRallarControl {
    export interface Input {
        readonly control: BlackBoxRallarControlSubmitInput;
        readonly typedChannels: Pick<BlackBoxRallarTypedChannels, 'getReceivedTraceId'>;
        readonly deliveries: Pick<BlackBoxBrowserDeliveriesDependency, 'getHandle' | 'submitRawControl'>;
    }
}

/**
 * Admits a raw control under the trace of the message it acknowledges, read from a message the page received or, failing
 * that, one it sent. A message the page knows by neither leaves no trace to inherit, so the control is refused before
 * any admission; that reason is the harness's own and not in the product's delivery refusal vocabulary.
 */
export async function writeBlackBoxRallarControl(
    input: WriteBlackBoxRallarControl.Input
): Promise<BlackBoxRallarControlSubmitDiagnostics> {
    const { control, typedChannels, deliveries } = input;
    const traceId = typedChannels.getReceivedTraceId(control.ackedMsgId) ??
        deliveries.getHandle(control.ackedMsgId)?.traceId;
    if (traceId === undefined) {
        return {
            msgId: control.msgId,
            typeId: control.typeId,
            carrier: control.carrier,
            verdict: 'refused',
            reason: 'acked-message-unknown',
            traceId: undefined
        };
    }
    const { msgId, verdict } = await deliveries.submitRawControl(control, traceId);
    return {
        msgId,
        typeId: control.typeId,
        carrier: control.carrier,
        verdict: verdict.kind,
        reason: 'detail' in verdict ? verdict.detail : undefined,
        traceId
    };
}
