import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALMessageTrace } from '../../../al-contracts/trace/to-al-message-trace.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundRelayForwardDiagnostic,
    type ALOutboundRuntimeDiagnosticsSink
} from '../al-outbound-message-runtime.ts';

/** What a relay's enqueue verdict says about its forward; a forward that was enqueued or is already held says nothing. */
export function toALOutboundRelayForwardDiagnostic(
    message: ALMessage,
    verdict: ALDeliveryAdmissionVerdict
): ALOutboundRelayForwardDiagnostic | undefined {
    if (verdict.kind === 'admitted' || verdict.kind === 'duplicate' || verdict.kind === 'pending') {
        return undefined;
    }
    return {
        kind: 'relay-forward-not-enqueued',
        msgId: message.id.msgId,
        typeId: message.payload.typeId,
        outcome: verdict.kind,
        reason: 'reason' in verdict ? verdict.reason : verdict.kind === 'storage-unavailable' ? verdict.cause : 'none',
        ...(verdict.kind === 'refused' && verdict.limit !== undefined ? { limit: verdict.limit } : {}),
        ...toALMessageTrace(message)
    };
}

/** The enqueue verdict of a relayed copy is otherwise discarded, so the diagnostics sink is the only place it is kept. */
export function writeALOutboundRelayForwardDiagnostic(
    diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined,
    message: ALMessage,
    verdict: ALDeliveryAdmissionVerdict
): void {
    const event = toALOutboundRelayForwardDiagnostic(message, verdict);
    if (event !== undefined) {
        writeALOutboundRuntimeDiagnostic(diagnostics, event);
    }
}
