import type { ALMessage } from '../../../al-contracts/al-contract.ts';
import { decodeALControlMessage, type ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import type {
    ALOutboundMessageRuntime,
    ALOutboundRuntimeDiagnosticsSink,
    ALOutboundSettlementEmitter
} from '../al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from './al-outbound-control-admission.ts';
import {
    computeALOutboundReceiptAdmission,
    toALOutboundReceiptMutation,
    toALOutboundReceiptSettlement,
    validateALOutboundReceiptAdmission
} from './compute-al-outbound-receipt-admission.ts';
import { writeALOutboundControlAdmissionDiagnostic } from './write-al-outbound-control-admission-diagnostic.ts';

export interface ALOutboundReceiptAdmissionDependencies<TPrepared> {
    readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    readonly clock: ALOutboundMessageRuntime.Clock;
    readonly settlements: ALOutboundSettlementEmitter;
    readonly diagnostics: ALOutboundRuntimeDiagnosticsSink | undefined;
}

/**
 * A server receipt moving a receipt row: at the origin, and at the WS server for its own pending row of
 * an outbox-fanned message. One conditional commit fenced on the origin's version; a conflict starts a
 * fresh read, and the few attempts bound a receipt racing the origin's own writes. Running out of them
 * is reported, since the row then keeps waiting on acknowledgements the receipt already counted.
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
        const admitted = await this.admitReceipt(decoded.payload);
        writeALOutboundControlAdmissionDiagnostic(this.dependencies.diagnostics, {
            control,
            targetMsgId: decoded.payload.msgId,
            admitted
        });
        return admitted;
    }

    private async admitReceipt(receipt: ALReceiptPayload): Promise<ALOutboundControlAdmissionResult> {
        for (let attempt = 0; attempt < ALOutboundReceiptAdmission.MAX_ATTEMPTS; attempt += 1) {
            const result = await this.admitOnce(receipt);
            if (result !== 'conflict') {
                return result;
            }
        }
        const reason = 'AL receipt kept conflicting with the origin version';
        console.warn(
            `AL ${receipt.phase} receipt for ${receipt.msgId} of origin ${receipt.originPeerId} left its receipt row unmoved: ${reason}`
        );
        return { kind: 'rejected', reason };
    }

    private async admitOnce(receipt: ALReceiptPayload): Promise<ALOutboundControlAdmissionResult | 'conflict'> {
        const { admissionStore, clock } = this.dependencies;
        const surface = await admissionStore.readReceiptAdmission({
            originPeerId: receipt.originPeerId,
            msgId: receipt.msgId
        });
        const candidate = computeALOutboundReceiptAdmission({ ...surface, receipt, nowMs: clock.nowMs() });
        const issues = validateALOutboundReceiptAdmission(candidate);
        if (issues.length > 0 || candidate.write === undefined) {
            return { kind: 'rejected', reason: issues.map((issue) => issue.message).join('; ') };
        }
        const status = await admissionStore.commitBundle({
            senderId: receipt.originPeerId,
            expectedVersion: surface.clientRecord?.version,
            mutations: [toALOutboundReceiptMutation(candidate.write, receipt)],
            durableEffects: []
        });
        if (status === 'committed') {
            this.dependencies.settlements(toALOutboundReceiptSettlement(candidate.read, candidate.write));
            return { kind: 'committed' };
        }
        return status === 'conflict' ? 'conflict' : { kind: 'rejected', reason: 'AL receipt commit expired' };
    }
}
