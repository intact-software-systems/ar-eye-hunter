import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALOutboundRuntimeDiagnosticsSink } from '../al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from './al-outbound-control-admission.ts';

export interface ALOutboundControlAdmissionDiagnosticInput {
    /** The control message itself: its id is the join key to the inbound `admission-outcome` that routed it. */
    readonly control: ALMessage;
    /** The outbound message the control answers. */
    readonly targetMsgId: string;
    /** The receipt's phase for a WS server receipt; `undefined` for every other control, which has none. */
    readonly receiptPhase: ALReceiptPayload['phase'] | undefined;
    readonly admitted: ALOutboundControlAdmissionResult;
}

/** Every carrier discards the verdict on a control, so the diagnostics sink is the only place it is kept. */
export function writeALOutboundControlAdmissionDiagnostic(
    diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined,
    input: ALOutboundControlAdmissionDiagnosticInput
): void {
    const { control, admitted } = input;
    try {
        diagnostics?.({
            kind: 'control-admission',
            msgId: control.id.msgId,
            typeId: control.payload.typeId,
            targetMsgId: input.targetMsgId,
            outcome: admitted.kind,
            reason: admitted.kind === 'rejected' ? admitted.reason : 'none',
            // Last, so a match on `typeId`, `targetMsgId` and `outcome` in their emitted order still finds a receipt.
            ...(input.receiptPhase === undefined ? {} : { phase: input.receiptPhase })
        });
    }
    catch (error) {
        console.error('AL outbound runtime diagnostics sink failed', error);
    }
}
