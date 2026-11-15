import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryAdmissionVerdict } from '../../delivery/al-delivery-lifecycle.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundRuntimeDiagnosticsSink
} from '../al-outbound-message-runtime.ts';
import { toALOutboundRelayForwardDiagnostic } from './to-al-outbound-relay-forward-diagnostic.ts';

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
