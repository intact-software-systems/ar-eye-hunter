import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALParsedControlMessage } from '../../../al-contracts/al-control.ts';
import { toALMessageTrace } from '../../../al-contracts/trace/to-al-message-trace.ts';
import type { ALWorkClaimRun } from '../../work/al-work-handler.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundRuntimeDiagnosticsSink
} from '../al-outbound-message-runtime.ts';
import { controlTargetMsgId } from '../compute-al-outbound-control-admission.ts';
import type { ALOutboundControlAdmissionResult } from './read-al-outbound-recipient-proof.ts';

export interface ALOutboundControlAdmissionDiagnosticInput {
    /** The control message itself: its id is the join key to the inbound `admission-outcome` that routed it. */
    readonly control: ALMessage;
    /** The control as its admission decoded it: it names the outbound message it answers. */
    readonly parsed: ALParsedControlMessage;
    readonly admitted: ALOutboundControlAdmissionResult;
    /** The work claim whose run replayed a control that parked, or undefined for an admission on the control's arrival. */
    readonly claimRun: ALWorkClaimRun | undefined;
}

/** Every carrier discards the verdict on a control, so the diagnostics sink is the only place it is kept. */
export function writeALOutboundControlAdmissionDiagnostic(
    diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined,
    input: ALOutboundControlAdmissionDiagnosticInput
): void {
    const { control, parsed, admitted, claimRun } = input;
    writeALOutboundRuntimeDiagnostic(diagnostics, {
        kind: 'control-admission',
        msgId: control.id.msgId,
        typeId: control.payload.typeId,
        targetMsgId: controlTargetMsgId(parsed),
        outcome: admitted.kind,
        reason: admitted.kind === 'rejected' || admitted.kind === 'duplicate' ? admitted.reason : 'none',
        // Straight after the reason, so a match on `typeId`, `targetMsgId`, `outcome`, `reason` and then a receipt's
        // `phase`, a NACK's reason, track, request number, recipient and sender, or a repair's request number and
        // requester in their emitted order finds it; how the admission ran and the trace append after them all.
        ...(parsed.type === 'receipt' ? { phase: parsed.payload.phase } : {}),
        ...(parsed.type === 'nack' ? { nackReason: parsed.payload.reason } : {}),
        ...(parsed.type === 'nack' && parsed.payload.orderingKey !== undefined
            ? { nackOrderingKey: parsed.payload.orderingKey }
            : {}),
        ...(parsed.type === 'nack' && parsed.payload.gapRequestNumber !== undefined
            ? { nackGapRequestNumber: parsed.payload.gapRequestNumber }
            : {}),
        ...(parsed.type === 'nack'
            ? {
                nackLogicalRecipientPeerId: parsed.payload.logicalRecipientPeerId,
                nackFromPeerId: parsed.payload.fromPeerId
            }
            : {}),
        ...(parsed.type === 'repair' && parsed.payload.gapRequestNumber !== undefined
            ? { repairGapRequestNumber: parsed.payload.gapRequestNumber }
            : {}),
        // A repair names no recipient it speaks for: the peer that asked is its requester.
        ...(parsed.type === 'repair' ? { repairFromPeerId: parsed.payload.fromPeerId } : {}),
        ...(admitted.kind === 'rejected' && admitted.proofRefusal !== undefined
            ? {
                proofRefusal: admitted.proofRefusal.kind,
                claimedRecipientPeerId: admitted.proofRefusal.claimedRecipientPeerId,
                channelPeerId: admitted.proofRefusal.channelPeerId
            }
            : {}),
        ...toALOutboundControlAdmissionRun(claimRun),
        ...toALMessageTrace(control)
    });
}

interface ALOutboundDirectControlAdmissionRun {
    readonly admission: 'direct';
}

interface ALOutboundReplayedControlAdmissionRun {
    readonly admission: 'expedited' | 'replay';
    readonly run: number;
}

type ALOutboundControlAdmissionRun = ALOutboundDirectControlAdmissionRun | ALOutboundReplayedControlAdmissionRun;

/** Direct on the control's arrival; a replay's run states whether `expedite()` claimed its row, and which run it is. */
function toALOutboundControlAdmissionRun(claimRun: ALWorkClaimRun | undefined): ALOutboundControlAdmissionRun {
    if (claimRun === undefined) {
        return { admission: 'direct' };
    }
    return { admission: claimRun.expedited ? 'expedited' : 'replay', run: claimRun.run };
}
