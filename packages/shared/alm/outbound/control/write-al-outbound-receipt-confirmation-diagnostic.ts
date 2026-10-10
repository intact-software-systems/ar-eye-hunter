import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALOutboundPendingAckSnapshot } from '../../al-runtime-state-stores.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundCommitBundleOutcome,
    type ALOutboundRuntimeDiagnosticsSink,
    type ALOutboundSettlementFact
} from '../al-outbound-message-runtime.ts';
import type { ALOutboundReceiptAdmissionCandidate } from './compute-al-outbound-receipt-admission.ts';

export interface ALOutboundReceiptConfirmationDiagnostic {
    readonly kind: 'receipt-confirmation';
    readonly msgId: string;
    readonly typeId: string;
    readonly controlSenderId: string;
    readonly targetMsgId: string;
    readonly originPeerId: string;
    readonly expectedRecipientPeerIds: readonly string[];
    readonly confirmedRecipientPeerIds: readonly string[];
    /** The decoded server audience revision, not the sender's CAS version. */
    readonly snapshotVersion: number;
    readonly phase: ALReceiptPayload['phase'];
    readonly observedAtEpochMs: number;
    /** The local clock captured by this attempt's existing read/compute boundary. */
    readonly admissionAtMs: number;
    readonly attempt: number;
    readonly senderVersion: number | null;
    readonly pendingBefore: ALOutboundPendingAckSnapshot | null;
    /** The computed write candidate; no persisted-after read is performed. */
    readonly candidateAfter: ALOutboundPendingAckSnapshot | null;
    readonly candidateExpiresAtMs: number | null;
    readonly commitOutcome: ALOutboundCommitBundleOutcome;
    /** The logical fact passed to the emitter on commit, before carrier/lane/time stamping. */
    readonly settlement: Extract<ALOutboundSettlementFact, { kind: 'acknowledgement'; }> | null;
}

export interface ALOutboundReceiptConfirmationDiagnosticInput {
    readonly control: ALMessage;
    readonly candidate: ALOutboundReceiptAdmissionCandidate;
    readonly attempt: number;
    readonly commitOutcome: ALOutboundCommitBundleOutcome;
    readonly settlement: ALOutboundSettlementFact | undefined;
}

export function writeALOutboundReceiptConfirmationDiagnostic(
    diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined,
    input: ALOutboundReceiptConfirmationDiagnosticInput
): void {
    if (diagnostics === undefined) {
        return;
    }
    const { read, write } = input.candidate;
    const { receipt } = read;
    writeALOutboundRuntimeDiagnostic(
        diagnostics,
        Object.freeze({
            kind: 'receipt-confirmation',
            msgId: input.control.id.msgId,
            typeId: input.control.payload.typeId,
            controlSenderId: input.control.id.senderId,
            targetMsgId: receipt.msgId,
            originPeerId: receipt.originPeerId,
            expectedRecipientPeerIds: Object.freeze([...receipt.expectedRecipientPeerIds]),
            confirmedRecipientPeerIds: Object.freeze([...receipt.confirmedRecipientPeerIds]),
            snapshotVersion: receipt.snapshotVersion,
            phase: receipt.phase,
            observedAtEpochMs: receipt.observedAtEpochMs,
            admissionAtMs: read.nowMs,
            attempt: input.attempt,
            senderVersion: read.clientRecord?.version ?? null,
            pendingBefore: toReceiptSnapshot(read.pending),
            candidateAfter: toReceiptSnapshot(write?.value),
            candidateExpiresAtMs: write?.expireAtTimestamp ?? null,
            commitOutcome: input.commitOutcome,
            settlement: toReceiptSettlementSnapshot(input.settlement)
        })
    );
}

function toReceiptSnapshot(pending: ALOutboundPendingAckSnapshot | undefined): ALOutboundPendingAckSnapshot | null {
    return pending === undefined ? null : Object.freeze({
        msgId: pending.msgId,
        mode: pending.mode,
        expectedPeerIds: Object.freeze([...pending.expectedPeerIds]),
        ackedPeerIds: Object.freeze([...pending.ackedPeerIds]),
        timeoutMs: pending.timeoutMs,
        maxAttempts: pending.maxAttempts,
        attempts: pending.attempts,
        deadlineAtMs: pending.deadlineAtMs
    });
}

function toReceiptSettlementSnapshot(
    settlement: ALOutboundSettlementFact | undefined
): ALOutboundReceiptConfirmationDiagnostic['settlement'] {
    return settlement?.kind !== 'acknowledgement' ? null : Object.freeze({
        kind: settlement.kind,
        msgId: settlement.msgId,
        mode: settlement.mode,
        expectedRecipientPeerIds: Object.freeze([...settlement.expectedRecipientPeerIds]),
        confirmedRecipientPeerIds: Object.freeze([...settlement.confirmedRecipientPeerIds]),
        unconfirmedRecipientPeerIds: Object.freeze([...settlement.unconfirmedRecipientPeerIds]),
        confirmedHopPeerIds: Object.freeze([...settlement.confirmedHopPeerIds]),
        unconfirmedHopPeerIds: Object.freeze([...settlement.unconfirmedHopPeerIds]),
        complete: settlement.complete
    });
}
