import type { ALReceiptPayload } from '../../../al-contracts/al-control.ts';
import type { ALOutboundAdmissionStore } from '../admission/al-outbound-admission-store.ts';
import type { ALOutboundMessageRuntime, ALOutboundSettlementEmitter } from '../al-outbound-message-runtime.ts';
import type { ALOutboundControlAdmissionResult } from './al-outbound-control-admission.ts';
import {
    computeALOutboundReceiptAdmission,
    toALOutboundReceiptMutation,
    toALOutboundReceiptSettlement,
    validateALOutboundReceiptAdmission
} from './compute-al-outbound-receipt-admission.ts';

export interface ALOutboundReceiptAdmissionDependencies<TPrepared> {
    readonly admissionStore: ALOutboundAdmissionStore<TPrepared>;
    readonly clock: ALOutboundMessageRuntime.Clock;
    readonly settlements: ALOutboundSettlementEmitter;
}

/**
 * The origin's side of a server receipt: one conditional commit fenced on the origin's version. A
 * conflict starts a fresh read; the few attempts bound a receipt racing the origin's own writes.
 */
export class ALOutboundReceiptAdmission<TPrepared> {
    private static readonly MAX_ATTEMPTS = 3;
    private readonly dependencies: ALOutboundReceiptAdmissionDependencies<TPrepared>;

    constructor(dependencies: ALOutboundReceiptAdmissionDependencies<TPrepared>) {
        this.dependencies = dependencies;
    }

    async admit(receipt: ALReceiptPayload): Promise<ALOutboundControlAdmissionResult> {
        for (let attempt = 0; attempt < ALOutboundReceiptAdmission.MAX_ATTEMPTS; attempt += 1) {
            const result = await this.admitOnce(receipt);
            if (result !== 'conflict') {
                return result;
            }
        }
        return { kind: 'rejected', reason: 'AL receipt kept conflicting with the origin version' };
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
            this.dependencies.settlements(toALOutboundReceiptSettlement(candidate.write, receipt));
            return { kind: 'committed' };
        }
        return status === 'conflict' ? 'conflict' : { kind: 'rejected', reason: 'AL receipt commit expired' };
    }
}
