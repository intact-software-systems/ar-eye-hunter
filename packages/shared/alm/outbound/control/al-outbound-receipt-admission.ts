import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALWorkOutcome } from '../../work/al-work-queue-port.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import {
    writeALOutboundRuntimeDiagnostic,
    type ALOutboundMessageRuntime,
    type ALOutboundRuntimeDiagnosticsSink,
    type ALOutboundSettlementEmitter
} from '../al-outbound-message-runtime.ts';
import type {
    ALOutboundControlAdmission,
    ALOutboundControlAdmissionResult,
    ALOutboundPendingControl
} from './al-outbound-control-admission.ts';
import {
    computeALOutboundReceiptAdmission,
    toALOutboundReceiptMutation,
    toALOutboundReceiptSettlement,
    validateALOutboundReceiptAdmission
} from './compute-al-outbound-receipt-admission.ts';
import { toALOutboundReceiptConfirmationDiagnostic } from './to-al-outbound-receipt-confirmation-diagnostic.ts';
import { writeALOutboundControlAdmissionDiagnostic } from './write-al-outbound-control-admission-diagnostic.ts';

export interface ALOutboundReceiptAdmissionDependencies<TPrepared> {
    readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    readonly clock: ALOutboundMessageRuntime.Clock;
    readonly settlements: ALOutboundSettlementEmitter;
    readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
    /** Where a receipt that kept conflicting waits as work, beside the peer controls that lost their commit. */
    readonly pendingControls: Pick<ALOutboundControlAdmission<TPrepared>, 'retainPendingControl'>;
}

/**
 * A server receipt moving a receipt row: at the origin, and at the WS server for its own pending row of
 * an outbox-fanned message. One conditional commit fenced on the origin's version; a conflict starts a
 * fresh read, and the few attempts bound a receipt racing the origin's own writes. A receipt that runs out
 * of them is retained as work and replayed until its deadline, since the row would otherwise keep waiting
 * on acknowledgements the receipt already counted.
 */
export class ALOutboundReceiptAdmission<TPrepared> {
    private static readonly MAX_ATTEMPTS = 3;
    private readonly dependencies: ALOutboundReceiptAdmissionDependencies<TPrepared>;

    constructor(dependencies: ALOutboundReceiptAdmissionDependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    /** The receipt control message itself, so its verdict is stated under the id of that control. */
    async admit(control: ALMessage): Promise<ALOutboundControlAdmissionResult> {
        const decoded = decodeALControlMessage(control).right;
        if (decoded?.type !== 'receipt') {
            return { kind: 'not-handled' };
        }
        const admitted = await this.admitReceipt(control, decoded.payload);
        writeALOutboundControlAdmissionDiagnostic(this.dependencies.diagnostics, {
            control,
            targetMsgId: decoded.payload.msgId,
            receiptPhase: decoded.payload.phase,
            admitted
        });
        return admitted;
    }

    private async admitReceipt(
        control: ALMessage,
        receipt: ALReceiptPayload
    ): Promise<ALOutboundControlAdmissionResult> {
        for (let attempt = 0; attempt < ALOutboundReceiptAdmission.MAX_ATTEMPTS; attempt += 1) {
            const result = await this.admitOnce(control, receipt, attempt + 1);
            if (result !== 'conflict') {
                return result;
            }
        }
        await this.dependencies.pendingControls.retainPendingControl(
            control,
            'trusted-server',
            this.dependencies.clock.nowMs()
        );
        return { kind: 'pending-control' };
    }

    /** A retained receipt is replayed until it commits or its deadline passes. */
    async replay(payload: ALOutboundPendingControl): Promise<ALWorkOutcome> {
        if (payload.expiresAtMs <= this.dependencies.clock.nowMs()) {
            return { status: 'completed' };
        }
        const admitted = await this.admit(payload.msg);
        return { status: admitted.kind === 'pending-control' ? 'retry' : 'completed' };
    }

    private async admitOnce(
        control: ALMessage,
        receipt: ALReceiptPayload,
        attempt: number
    ): Promise<ALOutboundControlAdmissionResult | 'conflict'> {
        const { admissionStore, clock, diagnostics, settlements } = this.dependencies;
        const surface = await admissionStore.readReceiptAdmission({
            originPeerId: receipt.originPeerId,
            msgId: receipt.msgId
        });
        const candidate = computeALOutboundReceiptAdmission({ ...surface, receipt, nowMs: clock.nowMs() });
        const issues = validateALOutboundReceiptAdmission(candidate);
        if (issues.length > 0 || candidate.write === undefined) {
            if (diagnostics !== undefined) {
                writeALOutboundRuntimeDiagnostic(
                    diagnostics,
                    toALOutboundReceiptConfirmationDiagnostic({
                        control,
                        candidate,
                        attempt,
                        commitOutcome: 'not-attempted',
                        settlement: undefined
                    })
                );
            }
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        const status = await admissionStore.commitBundle({
            senderId: receipt.originPeerId,
            expectedVersion: surface.clientRecord?.version,
            mutations: [toALOutboundReceiptMutation(candidate.write, receipt)],
            durableEffects: []
        });
        const settlement = status === 'committed'
            ? toALOutboundReceiptSettlement(candidate.read, candidate.write)
            : undefined;
        // Snapshot the exact fact before an external settlement sink can mutate its retained arrays.
        const confirmation = diagnostics === undefined ? undefined : toALOutboundReceiptConfirmationDiagnostic({
            control,
            candidate,
            attempt,
            commitOutcome: status,
            settlement
        });
        if (settlement !== undefined) {
            settlements(settlement);
        }
        if (confirmation !== undefined) {
            writeALOutboundRuntimeDiagnostic(diagnostics, confirmation);
        }
        if (settlement !== undefined) {
            return { kind: 'committed' };
        }
        return status === 'conflict' ? 'conflict' : { kind: 'rejected', reason: 'AL receipt commit expired' };
    }
}
