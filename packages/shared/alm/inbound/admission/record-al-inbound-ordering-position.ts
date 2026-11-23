import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALDeliveryCarrier } from '../../../al-contracts/al-control-value-codec.ts';
import type { ALMessageHandlingPlan } from '../../../al-contracts/al-policy.ts';
import { toALMessageTrace } from '../../../al-contracts/trace/to-al-message-trace.ts';
import { recordALInboundDiagnostic, type ALInboundRuntimeDiagnosticsSink } from '../al-inbound-runtime-diagnostics.ts';
import { toALInboundOrderingPosition } from './to-al-inbound-ordering-position.ts';

/** The committed copy an `ordering-position` event is stated about, and the lane that states it. */
export interface ALInboundOrderingPositionStatement {
    readonly workerId: string;
    /** The copy the committed plan judged. */
    readonly msg: ALMessage;
    /** The carrier that copy arrived on. */
    readonly carrier: ALDeliveryCarrier;
    readonly plan: ALMessageHandlingPlan;
}

/** States the `ordering-position` event of a plan the store has committed, so the position it names is the one held. */
export function recordALInboundOrderingPosition(
    sink: ALInboundRuntimeDiagnosticsSink | undefined,
    input: ALInboundOrderingPositionStatement
): void {
    const position = toALInboundOrderingPosition(input.plan);
    if (position !== null) {
        recordALInboundDiagnostic(sink, {
            kind: 'ordering-position',
            workerId: input.workerId,
            ...position,
            carrier: input.carrier,
            ...toALMessageTrace(input.msg)
        });
    }
}
