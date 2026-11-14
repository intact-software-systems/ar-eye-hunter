import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { toALMessageTrace } from '../../../al-contracts/trace/to-al-message-trace.ts';
import type { ResourceEntry } from '../../../queuebox/ResourceEntry.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundEnqueueResult,
    type ALOutboundRuntimeDiagnosticsSink
} from '../al-outbound-message-runtime.ts';

/** A forward its store could not persist throws into the inbound claim, which retries it. */
export function settleALOutboundRelayForward(
    diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined,
    message: ALMessage,
    result: ALOutboundEnqueueResult
): readonly ResourceEntry[] {
    writeALOutboundRelayForwardDiagnostic(diagnostics, message, result.verdict);
    if (result.verdict.kind === 'storage-unavailable') {
        throw new Error(result.reason ?? 'RTC forward admission returned storage-unavailable');
    }
    return result.entries;
}

/** The enqueue verdict of a relayed copy is otherwise discarded, so the diagnostics sink is the only place it is kept. */
function writeALOutboundRelayForwardDiagnostic(
    diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined,
    message: ALMessage,
    verdict: ALDeliveryAdmissionVerdict
): void {
    if (verdict.kind === 'admitted' || verdict.kind === 'duplicate' || verdict.kind === 'pending') {
        return;
    }
    writeALOutboundRuntimeDiagnostic(diagnostics, {
        kind: 'relay-forward-not-enqueued',
        msgId: message.id.msgId,
        typeId: message.payload.typeId,
        outcome: verdict.kind,
        reason: 'reason' in verdict ? verdict.reason : verdict.kind === 'storage-unavailable' ? verdict.cause : 'none',
        ...toALMessageTrace(message)
    });
}
